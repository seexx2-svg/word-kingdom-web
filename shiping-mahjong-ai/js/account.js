/* 博雅 · 红河棋牌（石屏麻将 AI 版）· 账号 / 赛季 / 经济内核 | GPL-3.0-or-later
 *
 * 纯逻辑，不碰 DOM，不依赖计时器，随机与时间都由外部注入，因此可以在 Node 里直接单测。
 * 界面层只调用这里的函数，不自己算银币、段位与赛季。
 *
 * 注意：这是本地账号体系，密码用一次性哈希存在 localStorage，只用于区分本机上的几个号，
 * 不是安全凭证。接入真实服务端时，把 register / login 换成请求即可，其余逻辑不用动。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HongheAccount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 赛季 ---------------- */
  const SEASON = {
    id: 'S25',
    prevId: 'S20',
    label: '全新赛季开启',
    start: '2026-11-06',
    end: '2027-01-05',
    rangeText: '2026.11.06~2027.01.05',
    inheritNote: 'S20 赛季段位称号'
  };

  /* ---------------- 段位阶梯（累计段位分阈值） ----------------
   * 首个段位 0 分起步，新秀一阶满 420 分升二阶 —— 与截图里的「新秀一阶 385/420」一致。
   */
  const RANKS = [
    { name: '新秀一阶', at: 0 },
    { name: '新秀二阶', at: 420 },
    { name: '新秀三阶', at: 620 },
    { name: '下士', at: 860 },
    { name: '中士', at: 1140 },
    { name: '上士', at: 1460 },
    { name: '少尉', at: 1820 },
    { name: '中尉', at: 2220 },
    { name: '上尉', at: 2660 },
    { name: '少校', at: 3140 },
    { name: '中校', at: 3660 },
    { name: '上校', at: 4220 },
    { name: '中将', at: 4820 }
  ];
  const INACTIVE_RANK = '未激活';

  function rankOf(points) {
    const p = Math.max(0, Number(points) || 0);
    let i = 0;
    for (let k = 0; k < RANKS.length; k++) if (p >= RANKS[k].at) i = k;
    const cur = RANKS[i];
    const next = RANKS[i + 1] || null;
    const into = p - cur.at;
    const need = next ? next.at - cur.at : into;
    return {
      name: cur.name,
      level: i,
      points: p,
      into,
      need,
      next: next ? next.name : '已封顶',
      text: next ? into + '/' + need : '已封顶',
      ratio: next ? Math.min(1, into / need) : 1
    };
  }

  /* ---------------- 场次 ---------------- */
  const HALLS = [
    { id: 'novice', name: '初级场', baseBet: 2000, minCoins: 3000, maxCoins: 25000, online: 6841, tier: 'bronze' },
    { id: 'mid', name: '中级场', baseBet: 8000, minCoins: 20000, maxCoins: 120000, online: 1245, tier: 'jade' },
    { id: 'high', name: '高级场', baseBet: 28000, minCoins: 60000, maxCoins: Infinity, online: 1716, tier: 'ruby' }
  ];
  function hallOf(id) { return HALLS.find((h) => h.id === id) || HALLS[0]; }
  function coinsRangeText(h) {
    const fmt = (n) => (n >= 10000 ? n / 10000 + '万' : String(n));
    return fmt(h.minCoins) + '-' + (h.maxCoins === Infinity ? '∞' : fmt(h.maxCoins));
  }

  /* ---------------- 结算：银币与段位分 ----------------
   * 与截图对齐：
   *   底注 2000、平胡 1 倍、赢家坐庄 2 倍 → 合计 2 倍 → 每张牌桌单位 = 4000
   *   普通输家 -4000；点炮者 -8000；赢家收实际扣到的总和
   *   点炮者余额不足时只扣到 0（截图中 7672 余额 → 只扣 7672，并标记「破产」）
   */
  function computeRound(opts) {
    const o = opts || {};
    const type = o.type || 'draw';
    const baseBet = Number(o.baseBet) || HALLS[0].baseBet;
    const dealerWin = !!o.dealerWin;
    const multiplier = type === 'draw' ? 0 : (dealerWin ? 2 : 1);
    const unit = baseBet * multiplier;
    const deltas = [0, 0, 0, 0];
    const reasons = ['', '', '', ''];
    if (type === 'draw' || !Number.isInteger(o.winnerSeat)) {
      return { type, baseBet, multiplier, unit, deltas, reasons, total: 0, busted: [false, false, false, false] };
    }
    const winner = o.winnerSeat;
    const discarder = Number.isInteger(o.discarderSeat) ? o.discarderSeat : -1;
    const due = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) {
      if (s === winner) continue;
      if (type === 'discard') due[s] = s === discarder ? unit * 2 : unit;
      else due[s] = unit * 2;                       // 自摸：三家各付双倍
    }
    const busted = [false, false, false, false];
    let total = 0;
    for (let s = 0; s < 4; s++) {
      if (s === winner || !due[s]) continue;
      const have = Math.max(0, Number((o.balances || [])[s]));
      const pay = Number.isFinite(have) && (o.balances || []).length ? Math.min(due[s], have) : due[s];
      if (pay < due[s]) busted[s] = true;
      deltas[s] = -pay;
      reasons[s] = s === discarder ? '点炮' : '输';
      total += pay;
    }
    deltas[winner] = total;
    reasons[winner] = type === 'self' ? '自摸' : '胡';
    return { type, baseBet, multiplier, unit, deltas, reasons, total, busted };
  }

  /** 段位分变化：赢家 +7×倍数，点炮 -3×倍数，其余 -2×倍数（截图 2 倍时 +14 / -6 / -4） */
  function computeRankDelta(settlement) {
    const out = [0, 0, 0, 0];
    if (!settlement || settlement.type === 'draw' || !settlement.multiplier) return out;
    const m = settlement.multiplier;
    for (let s = 0; s < 4; s++) {
      if (settlement.deltas[s] > 0) out[s] = 7 * m;
      else if (settlement.reasons[s] === '点炮') out[s] = -3 * m;
      else if (settlement.deltas[s] < 0) out[s] = -2 * m;
    }
    return out;
  }

  /* ---------------- 签到 / 回归好礼 ---------------- */
  const SIGNIN_DAYS = 7;
  const SIGNIN_COINS = 1000;
  const SIGNIN_STREAK_GOLD = 30;
  const BACK_DAYS = 7;

  function dayKey(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function shiftDay(key, delta) {
    const d = new Date(key + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    return dayKey(d);
  }

  /* ---------------- 账号 ---------------- */
  const KEY_ACCOUNTS = 'honghe-accounts-v1';
  const KEY_SESSION = 'honghe-session-v1';
  const START_COINS = 5000;
  const START_GOLD = 91;

  function makeStore(backend) {
    if (backend) return backend;
    if (typeof localStorage !== 'undefined') return localStorage;
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); }
    };
  }

  /** 一次性字符串哈希（djb2 变体）。只用于本机区分账号，不作为安全凭据。 */
  function hashPassword(pw) {
    const s = 'honghe$' + String(pw);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    let g = 52711;
    for (let i = s.length - 1; i >= 0; i--) g = ((g << 5) - g + s.charCodeAt(i)) >>> 0;
    return h.toString(36) + '.' + g.toString(36);
  }

  function blankAccount(account, nick) {
    return {
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      account: String(account),
      pass: '',
      nick: String(nick || account),
      avatar: 'default',
      createdAt: Date.now(),
      coins: START_COINS,
      gold: START_GOLD,
      seasonId: SEASON.id,
      rankPoints: 0,
      prevSeason: { id: SEASON.prevId, rank: '长工', points: 112, activated: true },
      activated: false,
      stats: { rounds: 0, wins: 0, selfDraw: 0, discardWin: 0, draws: 0, kongs: 0 },
      signin: { claimed: [], lastDay: '', streak: 0, streakClaimed: 0 },
      back: { claimed: [] },
      pendingReward: null
    };
  }

  function normalizeAccount(a) {
    const base = blankAccount(a && a.account || '', a && a.nick);
    if (!a || typeof a !== 'object') return base;
    return Object.assign(base, a, {
      coins: Number(a.coins) || 0,
      gold: Number(a.gold) || 0,
      rankPoints: Math.max(0, Number(a.rankPoints) || 0),
      stats: Object.assign(base.stats, a.stats || {}),
      signin: Object.assign(base.signin, a.signin || {}),
      back: Object.assign(base.back, a.back || {}),
      prevSeason: Object.assign(base.prevSeason, a.prevSeason || {})
    });
  }

  function loadAccounts(store) {
    const s = makeStore(store);
    try {
      const raw = JSON.parse(s.getItem(KEY_ACCOUNTS) || '[]');
      return Array.isArray(raw) ? raw.map(normalizeAccount) : [];
    } catch (_) { return []; }
  }
  function saveAccounts(store, list) {
    makeStore(store).setItem(KEY_ACCOUNTS, JSON.stringify(list));
  }
  function findByAccount(store, account) {
    const key = String(account || '').trim();
    return loadAccounts(store).find((a) => a.account === key) || null;
  }

  function register(store, opts) {
    const o = opts || {};
    const account = String(o.account || '').trim();
    const password = String(o.password || '');
    if (!/^[A-Za-z0-9_@.-]{3,20}$/.test(account)) return { ok: false, error: '账号需 3-20 位字母、数字或 _ @ . -' };
    if (password.length < 4) return { ok: false, error: '密码至少 4 位' };
    if (findByAccount(store, account)) return { ok: false, error: '该账号已被注册' };
    const list = loadAccounts(store);
    const acc = blankAccount(account, o.nick || account);
    acc.pass = hashPassword(password);
    list.push(acc);
    saveAccounts(store, list);
    return { ok: true, account: acc, isNew: true };
  }

  function login(store, opts) {
    const o = opts || {};
    const acc = findByAccount(store, o.account);
    if (!acc) return { ok: false, error: '账号不存在，请先注册' };
    if (acc.pass !== hashPassword(o.password || '')) return { ok: false, error: '密码不正确' };
    return { ok: true, account: acc };
  }

  function update(store, account) {
    const list = loadAccounts(store);
    const i = list.findIndex((a) => a.id === account.id);
    if (i < 0) list.push(account); else list[i] = account;
    saveAccounts(store, list);
    return account;
  }

  function session(store) {
    try { return makeStore(store).getItem(KEY_SESSION) || ''; } catch (_) { return ''; }
  }
  function setSession(store, id) { makeStore(store).setItem(KEY_SESSION, id || ''); }
  function currentAccount(store) {
    const id = session(store);
    if (!id) return null;
    return loadAccounts(store).find((a) => a.id === id) || null;
  }

  /* ---------------- 一局结束的账户结算 ---------------- */
  function applyRound(store, account, settlement, extra) {
    const acc = normalizeAccount(account);
    const e = extra || {};
    const rankDelta = e.rankDelta || computeRankDelta(settlement);
    acc.coins = Math.max(0, acc.coins + settlement.deltas[0]);
    acc.rankPoints = Math.max(0, acc.rankPoints + (rankDelta[0] || 0));
    if (settlement.type !== 'draw') acc.activated = true;
    acc.stats.rounds += 1;
    if (settlement.type === 'self') { acc.stats.wins += 1; acc.stats.selfDraw += 1; }
    else if (settlement.type === 'discard') { acc.stats.wins += 1; acc.stats.discardWin += 1; }
    else acc.stats.draws += 1;
    acc.stats.kongs += Number(e.kongs) || 0;
    acc.coins = Math.round(acc.coins);
    update(store, acc);
    return acc;
  }

  /* ---------------- 签到 ---------------- */
  function signinState(account, today) {
    const acc = normalizeAccount(account);
    const todayKey = dayKey(today);
    const claimed = acc.signin.claimed || [];
    const last = acc.signin.lastDay || '';
    const nextDay = claimed.length >= SIGNIN_DAYS ? SIGNIN_DAYS : claimed.length + 1;
    const canClaimToday = last !== todayKey && claimed.length < SIGNIN_DAYS;
    return {
      days: SIGNIN_DAYS,
      claimed: claimed.slice(),
      nextDay,
      todayKey,
      canClaimToday,
      streak: acc.signin.streak || 0,
      streakReward: SIGNIN_STREAK_GOLD,
      streakClaimed: acc.signin.streakClaimed || 0,
      canClaimStreak: (acc.signin.streak || 0) >= 3 && (acc.signin.streakClaimed || 0) < Math.floor((acc.signin.streak || 0) / 3),
      dayCoins: SIGNIN_COINS
    };
  }

  /** 领取第 day 天（不传则领下一天）。返回 {ok, coins, gold, state} */
  function claimSignin(store, account, today, day) {
    const acc = normalizeAccount(account);
    const st = signinState(acc, today);
    if (!st.canClaimToday) return { ok: false, error: '今天已经签到过了' };
    const target = day || st.nextDay;
    if (target !== st.nextDay) return { ok: false, error: '请按顺序签到' };
    acc.signin.claimed = st.claimed.concat(target);
    acc.signin.lastDay = st.todayKey;
    acc.signin.streak = (acc.signin.streak || 0) + 1;
    acc.coins += SIGNIN_COINS;
    let gold = 0;
    if (acc.signin.streak % 3 === 0) {
      gold = SIGNIN_STREAK_GOLD;
      acc.gold += gold;
      acc.signin.streakClaimed = (acc.signin.streakClaimed || 0) + 1;
    }
    update(store, acc);
    return { ok: true, coins: SIGNIN_COINS, gold, state: signinState(acc, today), account: acc };
  }

  /* ---------------- 回归好礼 ---------------- */
  function backState(account) {
    const acc = normalizeAccount(account);
    const claimed = acc.back.claimed || [];
    return {
      days: BACK_DAYS,
      claimed: claimed.slice(),
      nextDay: claimed.length >= BACK_DAYS ? BACK_DAYS : claimed.length + 1,
      canClaim: claimed.length < BACK_DAYS,
      dayCoins: SIGNIN_COINS
    };
  }
  function claimBack(store, account, day) {
    const acc = normalizeAccount(account);
    const st = backState(acc);
    const target = day || st.nextDay;
    if (!st.canClaim) return { ok: false, error: '全部奖励已领取' };
    if (target !== st.nextDay) return { ok: false, error: '请按顺序领取' };
    acc.back.claimed = st.claimed.concat(target);
    acc.coins += SIGNIN_COINS;
    update(store, acc);
    return { ok: true, coins: SIGNIN_COINS, state: backState(acc), account: acc };
  }

  /* ---------------- 赛季继承 ---------------- */
  function inheritState(account) {
    const acc = normalizeAccount(account);
    const prev = acc.prevSeason || { id: SEASON.prevId, rank: '长工', points: 112 };
    return {
      seasonId: SEASON.id,
      prevSeasonId: prev.id,
      prevRank: prev.rank,
      prevPoints: prev.points,
      nowRank: acc.activated ? rankOf(acc.rankPoints).name : INACTIVE_RANK,
      nowPoints: acc.rankPoints,
      needInherit: !acc.activated
    };
  }
  /** 点击「赛季继承」页继续时调用：把上赛季的段位称号记下来，本季从 0 开始 */
  function confirmInherit(store, account) {
    const acc = normalizeAccount(account);
    acc.rankPoints = 0;
    acc.activated = false;
    acc.seasonId = SEASON.id;
    update(store, acc);
    return acc;
  }

  /* ---------------- 数字格式 ---------------- */
  function fmtNum(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-US');
  }
  function fmtSigned(n) {
    const v = Number(n) || 0;
    return (v > 0 ? '+' : '') + fmtNum(v);
  }

  return {
    SEASON, RANKS, INACTIVE_RANK, HALLS, SIGNIN_DAYS, SIGNIN_COINS, SIGNIN_STREAK_GOLD,
    START_COINS, START_GOLD,
    rankOf, hallOf, coinsRangeText,
    computeRound, computeRankDelta,
    makeStore, hashPassword, blankAccount, normalizeAccount,
    loadAccounts, saveAccounts, findByAccount, register, login, update,
    session, setSession, currentAccount, applyRound,
    dayKey, shiftDay, signinState, claimSignin, backState, claimBack,
    inheritState, confirmInherit, fmtNum, fmtSigned
  };
});
