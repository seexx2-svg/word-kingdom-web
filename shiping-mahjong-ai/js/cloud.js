/* 石屏麻将（AI 版）· 云服务接入层 | GPL-3.0-or-later
 *
 * 这一层只做三件事：
 *   1. 用 publicConfig 初始化 @tencent-ai/workbuddy-cloud-sdk（CDN 全局 WorkBuddyCloud）
 *   2. 把云端 mahjong_players / mahjong_rounds 两张表映射成界面认识的 account 结构
 *   3. 把 { data, error } 信封翻译成中文提示，界面上不再出现英文错误
 *
 * 安全边界：owner_id 一律不传。建表时它就是 DEFAULT auth.uid()，RLS 的
 * WITH CHECK (owner_id = auth.uid()) 会把伪造的 owner 顶回去。
 *
 * 界面不直接引用这个模块里的 client，只走下面导出的几个函数，
 * 这样 Node 里可以用假 client 单测映射与错误处理（见 tests/cloud.test.cjs）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HongheCloud = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------
   * publicConfig：由 workbuddy_cloud_service 的 activate 返回，只含可公开的值。
   * endpoint 是应用的发布域名——换域名重新发布后必须同步更新这里，
   * 因为服务端会按 Origin 精确校验 publishableKey。
   * ------------------------------------------------------------------ */
  const PUBLIC_CONFIG = {
    endpoint: 'https://shiping-mahjong-ai.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_haQz1J98YfXjAnL6AYkA0b_jktVqXGsRBRW1MOhed9ncdU75bZ10kqN'
  };

  const PLAYERS = 'mahjong_players';
  const ROUNDS = 'mahjong_rounds';
  const DEFAULT_NICK = '牌友';
  const START_COINS = 5000;
  const START_GOLD = 91;

  let client = null;
  let initError = '';
  let initPromise = null;
  let injectedFactory = null;   // 测试用：注入一个假的 createWorkBuddyCloud

  /* ---------------- 初始化 ---------------- */

  function sdkFactory() {
    if (injectedFactory) return injectedFactory;
    const w = (typeof window !== 'undefined') ? window : null;
    const ns = w && w.WorkBuddyCloud;
    if (ns && typeof ns.createWorkBuddyCloud === 'function') return ns.createWorkBuddyCloud;
    return null;
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = new Promise((resolve) => {
      const make = sdkFactory();
      if (!make) {
        initError = '云端 SDK 加载失败，请检查网络后刷新页面';
        resolve({ ok: false, error: initError, code: 'sdk-missing' });
        return;
      }
      try {
        client = make({
          endpoint: PUBLIC_CONFIG.endpoint,
          oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
          publishableKey: PUBLIC_CONFIG.publishableKey
        });
      } catch (err) {
        initError = '云端初始化失败：' + ((err && err.message) || err);
        resolve({ ok: false, error: initError, code: 'init-failed' });
        return;
      }
      if (!client || !client.auth || !client.database) {
        initError = '云端 SDK 版本不匹配，缺少 auth / database 模块';
        resolve({ ok: false, error: initError, code: 'sdk-shape' });
        return;
      }
      initError = '';
      resolve({ ok: true, client });
    });
    return initPromise;
  }

  function status() {
    return {
      ready: !!client && !initError,
      error: initError,
      endpoint: PUBLIC_CONFIG.endpoint,
      hasSdk: !!sdkFactory()
    };
  }

  /** 测试专用：换掉 client / 工厂，不碰真实网络 */
  function useTestClient(fake, factory) {
    client = fake || null;
    injectedFactory = factory || null;
    initError = '';
    initPromise = fake ? Promise.resolve({ ok: true, client: fake }) : null;
    return client;
  }

  /* ---------------- 错误翻译 ---------------- */

  function errorText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    const code = String(err.code || '');
    const kind = String(err.kind || '');
    const msg = String(err.message || '');
    if (code === 'unauthenticated' || kind === 'unauthenticated' || code === 'invalid_grant') {
      return '登录状态已失效，请重新登录';
    }
    if (kind === 'network' || /network|fetch|Failed to fetch|timeout/i.test(msg)) {
      return '网络连接失败，请检查网络后重试';
    }
    if (kind === 'backend-unavailable' || /backend.?unavailable|503|502/i.test(msg)) {
      return '云端服务暂时不可用，请稍后再试';
    }
    if (code === '42501') return '没有权限访问这条数据，请确认已登录';
    if (code === '42P01') return '云端数据表尚未就绪，请联系管理员';
    if (code === '23505') return '数据已存在，无需重复创建';
    if (/Origin|origin/i.test(msg)) return '当前域名未授权访问云端，请从正式地址打开游戏';
    return msg || ('云端返回错误' + (code ? '（' + code + '）' : ''));
  }

  function fail(err, extra) {
    return Object.assign({ ok: false, error: errorText(err), code: (err && err.code) || '' }, extra || {});
  }

  /* ---------------- 会话 → 账号 ---------------- */

  function uidOf(session) {
    const u = session && session.user;
    if (!u) return '';
    return u.id || u.uid || u.sub || '';
  }

  function maskPhone(p) {
    const v = String(p || '').replace(/\s+/g, '');
    if (v.length < 7) return v ? '尾号 ' + v.slice(-4) : '';
    return v.slice(0, 3) + '****' + v.slice(-4);
  }

  function maskEmail(e) {
    const v = String(e || '');
    const at = v.indexOf('@');
    if (at < 1) return v;
    const head = v.slice(0, Math.min(2, at));
    return head + '***' + v.slice(at);
  }

  /** 账号列显示用：手机号/邮箱打码，WorkBuddy 昵称照用，都拿不到就写云端账号 */
  function labelOf(user) {
    if (!user) return '云端账号';
    if (user.phone) return maskPhone(user.phone);
    if (user.phoneNumber) return maskPhone(user.phoneNumber);
    if (user.email) return maskEmail(user.email);
    if (user.name) return String(user.name);
    return '云端账号';
  }

  function nickOf(session) {
    const u = session && session.user;
    if (u && u.name) return String(u.name).slice(0, 20);
    if (u && u.phone) return '牌友' + String(u.phone).slice(-4);
    if (u && u.phoneNumber) return '牌友' + String(u.phoneNumber).slice(-4);
    return DEFAULT_NICK;
  }

  const DEFAULT_PREV_SEASON = { id: 'S20', rank: '长工', points: 112, activated: true };
  const DEFAULT_SIGNIN = { claimed: [], lastDay: '', streak: 0, streakClaimed: 0 };
  const DEFAULT_STATS = { rounds: 0, wins: 0, selfDraw: 0, discardWin: 0, draws: 0, kongs: 0 };

  /** null / 空串都要走默认值：Number(null) 是 0，会让「缺字段」被当成「余额为零」 */
  function num(v, d) {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  /** 云端一行 → 界面用的 account 对象 */
  function fromRow(row, session) {
    const uid = uidOf(session);
    return {
      id: uid || String(row.owner_id || ''),
      rowId: row.id,
      source: 'cloud',
      account: labelOf(session && session.user),
      nick: row.owner_name || nickOf(session),
      avatar: 'default',
      createdAt: row.created_at ? (Date.parse(row.created_at) || Date.now()) : Date.now(),
      coins: Math.max(0, num(row.coins, START_COINS)),
      gold: Math.max(0, num(row.gold, START_GOLD)),
      rankPoints: Math.max(0, num(row.rank_points, 0)),
      activated: !!row.season_activated,
      seasonId: row.season_id || 'S25',
      seasonSeen: !!row.season_seen,
      prevSeason: Object.assign({}, DEFAULT_PREV_SEASON, row.prev_season || {}),
      stats: Object.assign({}, DEFAULT_STATS, row.stats || {}),
      signin: Object.assign({}, DEFAULT_SIGNIN, row.signin || {}),
      back: Object.assign({ claimed: [] }, row.back_gift || {}),
      welcomeGranted: !!row.welcome_granted
    };
  }

  /** 界面 account → 要写回云端的列（永远不含 owner_id） */
  function toRow(profile) {
    const p = profile || {};
    return {
      owner_name: p.nick ? String(p.nick).slice(0, 20) : null,
      coins: Math.max(0, Math.round(num(p.coins, 0))),
      gold: Math.max(0, Math.round(num(p.gold, 0))),
      rank_points: Math.max(0, Math.round(num(p.rankPoints, 0))),
      season_id: p.seasonId || 'S25',
      season_activated: !!p.activated,
      season_seen: !!p.seasonSeen,
      prev_season: p.prevSeason || DEFAULT_PREV_SEASON,
      signin: p.signin || DEFAULT_SIGNIN,
      back_gift: p.back || { claimed: [] },
      stats: p.stats || DEFAULT_STATS,
      welcome_granted: !!p.welcomeGranted,
      updated_at: new Date().toISOString()
    };
  }

  /* ---------------- 档案读写 ---------------- */

  /** 有就取回，没有就建一条（新号初始 5000 银币 / 91 金条，与本地版一致） */
  async function loadOrCreateProfile(session) {
    if (!client) return { ok: false, error: initError || '云端尚未初始化', code: 'not-ready' };
    const uid = uidOf(session);
    if (!uid) return { ok: false, error: '登录状态已失效，请重新登录', code: 'no-session' };

    const found = await client.database.from(PLAYERS).select('*').eq('owner_id', uid).limit(1).maybeSingle();
    if (found.error) return fail(found.error);
    if (found.data) return { ok: true, profile: fromRow(found.data, session), created: false };

    const created = await client.database.from(PLAYERS)
      .insert({ owner_name: nickOf(session) })
      .select();
    if (created.error) {
      // 两个人同时首次登录会撞 owner_id 唯一键，撞了就再读一次
      if (String(created.error.code) === '23505') {
        const again = await client.database.from(PLAYERS).select('*').eq('owner_id', uid).limit(1).maybeSingle();
        if (!again.error && again.data) return { ok: true, profile: fromRow(again.data, session), created: false };
      }
      return fail(created.error);
    }
    const row = created.data && created.data[0];
    if (!row) return { ok: false, error: '建档失败：云端没有返回记录', code: 'no-row' };
    return { ok: true, profile: fromRow(row, session), created: true };
  }

  /** 写回进度。用 .select() 判断到底改到没有 —— 空数组等于被 RLS 挡了 */
  async function saveProfile(profile) {
    if (!client) return { ok: false, error: initError || '云端尚未初始化', code: 'not-ready' };
    if (!profile || !profile.rowId) return { ok: false, error: '档案尚未建立，无法保存', code: 'no-row' };
    const res = await client.database.from(PLAYERS)
      .update(toRow(profile))
      .eq('id', profile.rowId)
      .select('id, coins, gold, rank_points, updated_at');
    if (res.error) return fail(res.error);
    const rows = Array.isArray(res.data) ? res.data : [];
    if (!rows.length) return { ok: false, error: '保存被拒绝：这条档案不属于当前账号，或登录已过期', code: 'blocked' };
    return { ok: true, row: rows[0] };
  }

  /** 一局流水 */
  async function recordRound(entry) {
    if (!client) return { ok: false, error: initError || '云端尚未初始化', code: 'not-ready' };
    const e = entry || {};
    const row = {
      owner_name: e.nick ? String(e.nick).slice(0, 20) : null,
      hall_id: e.hallId || 'novice',
      base_bet: Math.round(num(e.baseBet, 2000)),
      win_type: e.winType || 'draw',
      seat: Math.round(num(e.seat, 0)),
      delta: Math.round(num(e.delta, 0)),
      rank_delta: Math.round(num(e.rankDelta, 0)),
      balance_after: Math.max(0, Math.round(num(e.balanceAfter, 0))),
      seat_scores: e.seatScores || null
    };
    const res = await client.database.from(ROUNDS).insert(row).select('id, created_at');
    if (res.error) return fail(res.error);
    const inserted = (res.data && res.data[0]) || null;
    return { ok: true, round: inserted };
  }

  /** 最近战绩 */
  async function recentRounds(limit) {
    if (!client) return { ok: false, error: initError || '云端尚未初始化', code: 'not-ready' };
    const res = await client.database.from(ROUNDS)
      .select('id, hall_id, base_bet, win_type, delta, rank_delta, balance_after, created_at')
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(50, Number(limit) || 10)));
    if (res.error) return fail(res.error);
    return { ok: true, rounds: Array.isArray(res.data) ? res.data : [] };
  }

  /* ---------------- 会话 ---------------- */

  async function getSession() {
    if (!client) return { ok: false, error: initError || '云端尚未初始化', code: 'not-ready' };
    const res = await client.auth.getSession();
    if (res.error) return fail(res.error);
    return { ok: true, session: res.data || null };
  }

  async function signOut() {
    if (!client) return { ok: true };
    try {
      const res = await client.auth.signOut();
      if (res && res.error) return fail(res.error);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  }

  return {
    PUBLIC_CONFIG, PLAYERS, ROUNDS,
    init, status, useTestClient,
    errorText, uidOf, labelOf, maskPhone, maskEmail, nickOf,
    fromRow, toRow,
    loadOrCreateProfile, saveProfile, recordRound, recentRounds,
    getSession, signOut,
    auth: () => client && client.auth,
    database: () => client && client.database,
    client: () => client
  };
});
