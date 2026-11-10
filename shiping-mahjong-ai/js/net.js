/* 石屏麻将 · 联机层（大厅匹配 + 动作同步）| GPL-3.0-or-later
 *
 * 现实前提：这个应用是纯静态站点，没有自己的服务端，也没有长连接。
 * 所以"联机"是这么实现的：
 *   - 匹配：云库里找 status='waiting' 的房间，谁先到谁建房（房主），
 *           后来的人往房里插一行自己的成员记录——**每人只写自己的行**，
 *           这是 RLS 唯一允许的写法，也正好避免了抢锁。
 *   - 同步：房主定稿 human_count 与种子，所有人拿同一个种子各自本地建局，
 *           对局中只有「真人打出的那一手」写进 mahjong_moves，其余靠轮询拉取。
 *           电脑玩家的决策不落库——它是确定性的，每台设备自己算，
 *           这样既省流量，也不会把别人的手牌写进数据库（那是作弊口子）。
 *   - 断线：轮询超时就在牌桌上明说"对手掉线"，不假装对手还在。
 *
 * 参考实现思路来自开源浏览器麻将 kongxg888/mahjong（WebSocket 版）的
 * 「动作日志 + 确定性重放」分层，这里换成了没有服务端也能跑的轮询版。
 */
(function (root, factory) {
  let Cloud = null;
  if (root && root.HongheCloud) Cloud = root.HongheCloud;
  else if (typeof require === 'function') {
    try { Cloud = require('./cloud.js'); } catch (_) { Cloud = null; }
  }
  const api = factory(Cloud);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HongheNet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Cloud) {
  'use strict';

  const ROOMS = 'mahjong_rooms';
  const MEMBERS = 'mahjong_room_members';
  const MOVES = 'mahjong_moves';

  const WAIT_MS = 9000;        // 等人上限，到点就用电脑补齐（不能让人对着空桌干等）
  const POLL_MS = 800;         // 匹配与对局轮询间隔：再快就是白烧流量，再慢手感就木了
  const ROOM_TTL_MS = 90000;   // 超过这个时间的等待房视为废弃
  const MAX_SEATS = 4;
  const KEY_NICK = 'shiping-online-nick';

  /* 浏览器里有 localStorage；Node 单测里没有，就退化成内存字典，
   * 否则 nick() 每调一次都换名字，匹配与显示会各说各话。 */
  const memStore = new Map();

  /* ---------------- 昵称 ---------------- */
  const NICK_POOL = [
    '青竹', '红中', '白板', '幺鸡', '三条', '四万', '七筒', '九万', '东风', '南风',
    '西风', '北风', '发财', '小满', '阿七', '老顺', '石屏客', '临安客', '龙井', '坝心',
    '异龙湖', '秀山', '阿竹', '小和', '慢打', '摸牌手', '看牌的', '糊一把'
  ];

  function randomNick() {
    const a = NICK_POOL[Math.floor(Math.random() * NICK_POOL.length)];
    if (Math.random() < 0.45) return a;
    return a + (10 + Math.floor(Math.random() * 89));
  }

  function readStore(key) {
    try {
      if (globalThis.localStorage) return localStorage.getItem(key);
    } catch (_) { /* ignore */ }
    return memStore.has(key) ? memStore.get(key) : null;
  }
  function writeStore(key, val) {
    try {
      if (globalThis.localStorage) { localStorage.setItem(key, val); return; }
    } catch (_) { /* ignore */ }
    memStore.set(key, val);
  }

  /** 当前昵称：用户改过就用用户的，没改过就按设备记住的那个随机昵称 */
  function nick() {
    const saved = readStore(KEY_NICK);
    if (saved) return saved;
    const n = randomNick();
    writeStore(KEY_NICK, n);
    return n;
  }
  function setNick(name) {
    const v = String(name || '').trim().slice(0, 12);
    if (!v) return nick();
    writeStore(KEY_NICK, v);
    return v;
  }

  /* ---------------- 基础 ---------------- */
  function ready() {
    return !!(Cloud && Cloud.database && Cloud.database() && Cloud.auth && Cloud.auth());
  }
  function db() { return Cloud && Cloud.database ? Cloud.database() : null; }
  function err(res, fallback) {
    if (!res || !res.error) return null;
    return Cloud && Cloud.errorText ? Cloud.errorText(res.error) : (fallback || '网络错误');
  }
  function ms(t) { const n = Date.parse(t); return Number.isFinite(n) ? n : 0; }

  async function uid() {
    if (!Cloud) return null;
    const s = await Cloud.getSession();
    if (!s || !s.ok || !s.session) return null;
    return Cloud.uidOf(s.session) || null;
  }

  /* ---------------- 房间 ---------------- */
  async function recentWaiting() {
    const since = new Date(Date.now() - ROOM_TTL_MS).toISOString();
    const res = await db().from(ROOMS)
      .select('id, owner_id, seed, hall_id, base_bet, status, human_count, target_seats, created_at')
      .eq('status', 'waiting')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(8);
    if (res.error) return { ok: false, error: err(res), rooms: [] };
    return { ok: true, rooms: Array.isArray(res.data) ? res.data : [] };
  }

  async function readRoom(roomId) {
    const res = await db().from(ROOMS)
      .select('id, owner_id, seed, hall_id, base_bet, status, human_count, target_seats, created_at')
      .eq('id', roomId).limit(1);
    if (res.error) return { ok: false, error: err(res) };
    const row = (res.data || [])[0];
    return row ? { ok: true, room: row } : { ok: false, error: '房间不存在或已解散' };
  }

  async function createRoom(opts) {
    const o = opts || {};
    const row = {
      seed: Number.isFinite(o.seed) ? Math.floor(o.seed) : Math.floor(Math.random() * 2147483647),
      hall_id: o.hallId || 'novice',
      base_bet: Number(o.baseBet) || 2000
    };
    const res = await db().from(ROOMS).insert(row).select('id, owner_id, seed, hall_id, base_bet, status, human_count, created_at');
    if (res.error) return { ok: false, error: err(res) };
    const inserted = (res.data || [])[0];
    if (!inserted) return { ok: false, error: '建房失败：云端没有返回房间信息' };
    return { ok: true, room: inserted };
  }

  async function joinRoom(roomId, name) {
    const res = await db().from(MEMBERS)
      .insert({ room_id: roomId, name: String(name || '牌友').slice(0, 12) })
      .select('id, room_id, owner_id, name, joined_at');
    if (res.error) {
      const code = res.error.code || '';
      if (String(code) === '23505') return { ok: true, member: null, already: true };
      return { ok: false, error: err(res) };
    }
    return { ok: true, member: (res.data || [])[0] || null };
  }

  /** 房内成员，按进房时间排序——座位号就是这里的下标，所有人算出来都一样 */
  async function members(roomId) {
    const res = await db().from(MEMBERS)
      .select('owner_id, name, joined_at')
      .eq('room_id', roomId)
      .order('joined_at', { ascending: true })
      .order('owner_id', { ascending: true })
      .limit(8);
    if (res.error) return { ok: false, error: err(res), members: [] };
    return { ok: true, members: Array.isArray(res.data) ? res.data : [] };
  }

  /** 房主定稿：人数、开局。只有房主能改自己那一行，所以不存在抢写 */
  async function freezeRoom(roomId, humanCount) {
    const res = await db().from(ROOMS)
      .update({ status: 'playing', human_count: Math.max(1, Math.min(MAX_SEATS, humanCount)), updated_at: new Date().toISOString() })
      .eq('id', roomId)
      .select('id, status, human_count');
    if (res.error) return { ok: false, error: err(res) };
    const row = (res.data || [])[0];
    if (!row) return { ok: false, error: '开局定稿被拒绝（可能你不是房主）' };
    return { ok: true, room: row };
  }

  async function closeRoom(roomId) {
    if (!ready()) return { ok: false };
    const res = await db().from(ROOMS)
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('id', roomId).select('id');
    return { ok: !res.error };
  }

  /* ---------------- 动作日志 ---------------- */
  async function pushMove(roomId, seq, seat, action) {
    const row = { room_id: roomId, seq, seat, action };
    const res = await db().from(MOVES).insert(row).select('id, seq');
    if (!res.error) return { ok: true, seq };
    const code = String((res.error && res.error.code) || '');
    if (code === '23505') return { ok: false, code: 'dup', error: '这一手已经被别人占了序号' };
    return { ok: false, error: err(res) };
  }

  async function movesSince(roomId, afterSeq) {
    const res = await db().from(MOVES)
      .select('seq, seat, action, created_at')
      .eq('room_id', roomId)
      .gt('seq', Number(afterSeq) || 0)
      .order('seq', { ascending: true })
      .limit(50);
    if (res.error) return { ok: false, error: err(res), moves: [] };
    return { ok: true, moves: Array.isArray(res.data) ? res.data : [] };
  }

  /* ---------------- 匹配主流程 ---------------- */
  /**
   * 快速匹配：先找别人的等待房，找不到就自己开一间；到点没凑齐就用电脑补位。
   * onStep(text) 用来给大厅实时显示"正在找… / 已连上 2 人…"。
   */
  async function match(opts) {
    const o = opts || {};
    const onStep = typeof o.onStep === 'function' ? o.onStep : function () {};
    const myName = setNick(o.nick || nick());
    if (!ready()) return { ok: false, error: '云端未连接，先检查网络或改用「快速人机」' };

    const me = await uid();
    if (!me) return { ok: false, error: '需要先登录才能连真人（游客只能打人机）', code: 'no-session' };

    onStep('正在找空闲的桌子…');
    let room = null;
    let isHost = false;

    const list = await recentWaiting();
    if (!list.ok && list.error) return { ok: false, error: list.error };

    for (const cand of (list.rooms || [])) {
      if (cand.owner_id === me) continue;          // 自己的房留给下面"等待"分支
      if (Number(cand.human_count) >= MAX_SEATS) continue;
      const m = await members(cand.id);
      if (!m.ok) continue;
      if (m.members.some((x) => x.owner_id === me)) { room = cand; break; }   // 上一轮已经坐下
      if (m.members.length >= Number(cand.target_seats || MAX_SEATS)) continue;
      const joined = await joinRoom(cand.id, myName);
      if (joined.ok) { room = cand; break; }
    }

    if (!room) {
      onStep('没找到空桌，我来开一桌…');
      const made = await createRoom({ hallId: o.hallId, baseBet: o.baseBet });
      if (!made.ok) return { ok: false, error: made.error };
      room = made.room;
      isHost = true;
      const joined = await joinRoom(room.id, myName);
      if (!joined.ok) return { ok: false, error: joined.error };
    } else {
      isHost = room.owner_id === me;
    }

    const startedAt = Date.now();
    let lastCount = 0;
    while (true) {
      const info = await readRoom(room.id);
      if (!info.ok) return { ok: false, error: info.error };
      const r = info.room;

      if (r.status === 'playing') {
        const m = await members(room.id);
        if (!m.ok) return { ok: false, error: m.error };
        const idx = m.members.findIndex((x) => x.owner_id === me);
        const humanCount = Number(r.human_count) || 0;
        if (idx < 0 || idx >= humanCount) {
          // 来晚了一步：这一桌已经定稿，重新排一次
          return { ok: false, error: '这一桌刚好坐满了，再给你找一桌', code: 'retry' };
        }
        return {
          ok: true, roomId: r.id, seed: Number(r.seed), hallId: r.hall_id,
          baseBet: Number(r.base_bet) || 0, humanCount,
          mySeat: idx, isHost,
          names: m.members.slice(0, humanCount).map((x) => x.name)
        };
      }

      const m = await members(room.id);
      if (m.ok) {
        const count = Math.min(m.members.length, MAX_SEATS);
        if (count !== lastCount) {
          lastCount = count;
          onStep(count > 1 ? `已连上 ${count} 位真人，等其他人…` : '已经坐下，等其他人进来…');
        }
        const waited = Date.now() - startedAt;
        const full = count >= MAX_SEATS;
        if (isHost && (full || waited >= WAIT_MS)) {
          onStep(full ? '四人到齐，开局！' : `够 ${count} 人，剩下的位置由电脑补上`);
          const frozen = await freezeRoom(room.id, count);
          if (!frozen.ok) return { ok: false, error: frozen.error };
          const idx = m.members.findIndex((x) => x.owner_id === me);
          return {
            ok: true, roomId: room.id, seed: Number(r.seed), hallId: r.hall_id,
            baseBet: Number(r.base_bet) || 0, humanCount: count,
            mySeat: idx < 0 ? 0 : idx, isHost: true,
            names: m.members.slice(0, count).map((x) => x.name)
          };
        }
        if (isHost === false && waited > WAIT_MS + 8000) {
          // 房主掉线/不动作：不要把人生耗在 waiting 上
          return { ok: false, error: '房主没有开局，重新匹配一次', code: 'retry' };
        }
      }
      onStep(lastCount > 1 ? `已连上 ${lastCount} 位真人，等其他人…` : '正在等其他人进来…');
      await new Promise((r2) => setTimeout(r2, POLL_MS));
    }
  }

  return {
    WAIT_MS, POLL_MS, MAX_SEATS, NICK_POOL,
    ready, nick, setNick, randomNick, uid,
    recentWaiting, readRoom, createRoom, joinRoom, members, freezeRoom, closeRoom,
    pushMove, movesSince, match
  };
});
