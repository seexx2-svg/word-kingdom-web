/* 石屏麻将 · 联机会话（座位旋转 + 动作重放 + 轮询）| GPL-3.0-or-later
 *
 * 关键设计：**每台设备都把自己当成 0 号位**。
 *
 * 牌桌界面（js/ui.js）从一开始就是「0 号位 = 我」写死的，这是单机版的合理假设。
 * 联机时如果让每个人都看全局座位号，界面要改几十处；所以这里在开局后把整局状态
 * 做一次座位旋转：新座位 = (旧座位 - 我的座位 + 4) % 4。手牌、弃牌、副露、庄家、
 * 事件里的座位全部跟着转，转完以后我的手牌就是 hands[0]。
 *
 * 旋转之所以安全，是因为麻将的所有规则都是"相对座位"的：下家仍是下家、
 * 庄家连庄仍是连庄、接牌优先级仍按距离。动作日志里存的是**全局座位**，
 * 各端按自己的偏移量换算，这样"我出的牌"在别人屏幕上落在正确的位置。
 *
 * 电脑玩家不落库：AI 决策是确定性的（见 js/core.js 的 chooseAiDiscard/aiDecide），
 * 同一个种子 + 同一串真人动作，每台设备算出来完全一样。这样既省流量，
 * 也不会把别人的手牌写进数据库。
 */
(function (root, factory) {
  let Net = null;
  if (root && root.HongheNet) Net = root.HongheNet;
  else if (typeof require === 'function') {
    try { Net = require('./net.js'); } catch (_) { Net = null; }
  }
  const api = factory(Net);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HongheOnline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Net) {
  'use strict';

  const AI_NAMES = ['阿七', '小满', '老顺', '坝心'];
  let session = null;

  /* ---------------- 座位旋转 ---------------- */
  /* 内核的座位循环是 NEXT_SEAT = [2,3,1,0]，也就是 0→2→1→3→0，
   * **不是** 0→1→2→3。所以"转到自己家"必须沿这个环走，
   * 直接写 (seat - k + 4) % 4 会让下家关系全乱（这个坑已被单测钉住）。
   * 万一以后内核改了座位顺序，tests/online.test.cjs 里的环校验会先炸。 */
  const CYCLE = [0, 2, 1, 3];
  const POS = { 0: 0, 1: 2, 2: 1, 3: 3 };
  const idx = (n) => ((Number(n) % 4) + 4) % 4;

  /** 全局座位 → 以 mySeat 为 0 号位的本地座位 */
  function localOf(globalSeat, mySeat) {
    return CYCLE[(((POS[idx(globalSeat)] - POS[idx(mySeat)]) % 4) + 4) % 4];
  }
  /** 本地座位 → 全局座位 */
  function globalOf(localSeat, mySeat) {
    return CYCLE[(((POS[idx(localSeat)] + POS[idx(mySeat)]) % 4) + 4) % 4];
  }

  function rotate(state, mySeat) {
    const shift = idx(mySeat);
    if (!state || !shift) { if (state) state.__rotated = 0; return state; }
    const to = (i) => localOf(i, shift);
    const back = (i) => globalOf(i, shift);   // 反向：本地 → 全局

    const pick = (arr) => {
      const out = new Array(4);
      for (let i = 0; i < 4; i++) out[to(i)] = arr[i];
      return out;
    };
    state.hands = pick(state.hands);
    state.melds = pick(state.melds);
    state.discards = pick(state.discards);
    state.scores = pick(state.scores);

    if (Number.isInteger(state.dealer)) state.dealer = to(state.dealer);
    if (Number.isInteger(state.current)) state.current = to(state.current);
    if (state.lastDraw && Number.isInteger(state.lastDraw.seat)) state.lastDraw.seat = to(state.lastDraw.seat);
    if (state.lastDiscard && Number.isInteger(state.lastDiscard.from)) state.lastDiscard.from = to(state.lastDiscard.from);

    if (Array.isArray(state.pendingClaims)) {
      state.pendingClaims.forEach((c) => { if (c && Number.isInteger(c.seat)) c.seat = to(c.seat); });
    }
    if (Array.isArray(state.events)) {
      state.events.forEach((ev) => {
        if (!ev) return;
        if (Number.isInteger(ev.seat)) ev.seat = to(ev.seat);
        if (Number.isInteger(ev.from)) ev.from = to(ev.from);
      });
    }
    if (Array.isArray(state.kongLog)) {
      state.kongLog.forEach((ev) => { if (ev && Number.isInteger(ev.seat)) ev.seat = to(ev.seat); });
    }
    if (Number.isInteger(state.winner)) state.winner = to(state.winner);
    if (state.result && Number.isInteger(state.result.seat)) state.result.seat = to(state.result.seat);
    if (state.result && Number.isInteger(state.result.from)) state.result.from = to(state.result.from);

    state.__rotated = shift;
    state.__toGlobal = back;
    return state;
  }

  /* ---------------- 会话 ---------------- */
  /**
   * @param {object} o
   *   roomId, seed, mySeat（全局）, humanCount, names（真人昵称，按座位序）, hallId, baseBet
   */
  function begin(o) {
    const humanCount = Math.max(1, Math.min(4, Number(o.humanCount) || 1));
    const mySeat = idx(o.mySeat);
    /* names 进来时是**全局座位序**（房间成员按进房时间排），
     * 这里必须换成**本地座位序**：本地 0 号一定是我。
     * 而且"哪几个本地座位是真人"不能假设是 0..n-1——旋转会把它打散，
     * 所以单独记 humanSeats，别再拿 seat < humanCount 判断。 */
    const names = [0, 1, 2, 3].map((i) => AI_NAMES[i % 4]);
    const humanSeats = [];
    for (let g = 0; g < humanCount; g++) {
      const local = localOf(g, mySeat);
      names[local] = (o.names && o.names[g]) ? String(o.names[g]).slice(0, 12) : ('牌友' + (g + 1));
      humanSeats.push(local);
    }
    session = {
      roomId: o.roomId,
      seed: Number(o.seed) || 1,
      mySeat,
      humanCount,
      names,
      humanSeats,
      hallId: o.hallId || 'novice',
      baseBet: Number(o.baseBet) || 2000,
      seq: 0,
      lastPull: 0,
      timer: null,
      onRemote: null,
      onStatus: null,
      online: true
    };
    return session;
  }

  function current() { return session; }
  function isOnline() { return !!(session && session.online); }
  function toLocal(seat) { return session ? localOf(seat, session.mySeat) : idx(seat); }
  function toGlobal(seat) { return session ? globalOf(seat, session.mySeat) : idx(seat); }
  function isHumanSeat(localSeat) {
    return !!session && session.humanSeats.indexOf(idx(localSeat)) >= 0;
  }
  function nameOf(localSeat) { return (session && session.names[localSeat]) || '牌友'; }

  function end() {
    if (session && session.timer) { clearTimeout(session.timer); session.timer = null; }
    if (session && Net && Net.closeRoom) Net.closeRoom(session.roomId).catch(() => {});
    session = null;
  }

  function stopPolling() {
    if (session && session.timer) { clearTimeout(session.timer); session.timer = null; }
  }

  /* ---------------- 动作收发 ---------------- */
  /**
   * 把本地座位的一手写成全局座位的一手。seq 用本地计数器，
   * 撞号（23505）就重新读一次最大 seq 再补写一次。
   */
  async function push(localSeat, action) {
    if (!session || !session.online || !Net) return { ok: false, error: '不在联机对局中' };
    const seat = toGlobal(localSeat);
    for (let attempt = 0; attempt < 2; attempt++) {
      const seq = session.seq + 1;
      const res = await Net.pushMove(session.roomId, seq, seat, action);
      if (res.ok) {
        session.seq = seq;
        return res;
      }
      if (res.code !== 'dup') return res;
      const latest = await Net.movesSince(session.roomId, 0);
      if (latest.ok && latest.moves.length) {
        session.seq = Math.max(session.seq, ...latest.moves.map((m) => Number(m.seq) || 0));
        session.lastPull = Math.max(session.lastPull, session.seq);
      } else {
        return res;
      }
    }
    return { ok: false, error: '动作没能写进云端，请检查网络' };
  }

  /** 拉一次新动作（不含自己写的），按 seq 升序交给回调 */
  async function pull() {
    if (!session || !session.online || !Net) return { ok: false, moves: [] };
    const res = await Net.movesSince(session.roomId, session.lastPull);
    if (!res.ok) {
      if (typeof session.onStatus === 'function') session.onStatus({ kind: 'error', error: res.error });
      return { ok: false, moves: [], error: res.error };
    }
    const fresh = res.moves.filter((m) => Number(m.seq) > session.lastPull);
    if (!fresh.length) return { ok: true, moves: [] };
    session.lastPull = Math.max(...fresh.map((m) => Number(m.seq) || 0));
    session.seq = Math.max(session.seq, session.lastPull);
    const out = [];
    for (const m of fresh) {
      if (Number(m.seat) === session.mySeat) continue;    // 自己写的跳过（本地已经执行过）
      out.push({ seq: Number(m.seq), seat: toLocal(m.seat), action: m.action });
    }
    if (out.length && typeof session.onRemote === 'function') {
      for (const mv of out) session.onRemote(mv.seat, mv.action);
    }
    return { ok: true, moves: out };
  }

  /** 轮询循环：默认 800ms 一次；连续失败会放慢，但不会静默停 */
  function startPolling(opts) {
    if (!session) return;
    const o = opts || {};
    const base = Math.max(400, Number(o.interval) || 800);
    if (session.timer) clearTimeout(session.timer);
    let fails = 0;
    const tick = async () => {
      if (!session) return;
      const res = await pull();
      if (res.ok) { fails = 0; }
      else {
        fails += 1;
        if (fails === 3 && typeof session.onStatus === 'function') {
          session.onStatus({ kind: 'offline', error: res.error });
        }
      }
      if (!session) return;
      const wait = fails ? Math.min(6000, base * Math.pow(1.6, Math.min(fails, 6))) : base;
      session.timer = setTimeout(tick, wait);
    };
    session.timer = setTimeout(tick, base);
  }

  return {
    CYCLE, POS, localOf, globalOf,
    rotate, begin, current, end, isOnline,
    toLocal, toGlobal, isHumanSeat, nameOf,
    push, pull, startPolling, stopPolling, AI_NAMES
  };
});
