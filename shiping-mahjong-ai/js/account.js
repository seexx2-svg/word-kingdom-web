/* 石屏麻将（AI 版）· 账号 / 赛季 / 经济内核 | GPL-3.0-or-later
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
   * 乡土 → 科举 → 官阶，13 档，沿用原来的分数阈值（0 / 420 / 620 … 4820），
   * 只换头衔名，不改段位分算法与升降速度。玩家从「穷人」一路做到「一品官」。
   */
  const RANKS = [
    { name: '穷人', at: 0 },
    { name: '佃户', at: 420 },
    { name: '贫农', at: 620 },
    { name: '中农', at: 860 },
    { name: '富农', at: 1140 },
    { name: '地主', at: 1460 },
    { name: '秀才', at: 1820 },
    { name: '举人', at: 2220 },
    { name: '进士', at: 2660 },
    { name: '七品官', at: 3140 },
    { name: '五品官', at: 3660 },
    { name: '三品官', at: 4220 },
    { name: '一品官', at: 4820 }
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
   * 石屏麻将没有庄家，也就没有庄家翻倍：一局只有「底分 × 1 倍」这一个单位。
   *   底注 2000 → 单位 2000
   *   普通输家 -2000；点炮者 -4000；自摸三家各 -4000；赢家收实际扣到的总和
   *   点炮者余额不足时只扣到 0，并标记「破产」
   * 胡牌的那一家由谁起手（骰子点数决定）不影响分数，只影响谁先摸牌。
   *
   * 杠分（2026-11 补）：明杠 / 补杠 三家各出 1 个底注（2000），暗杠 三家各出 2 个
   * 底注（4000）。杠是当场就"过了钱"的，所以它和胡牌分开记，最后一起进结算——
   * 荒牌也照算，不会因为没人胡就把杠分吞掉。
   */
  const KONG_KINDS = { '明杠': 1, '补杠': 1, '暗杠': 2 };
  function computeRound(opts) {
    const o = opts || {};
    const type = o.type || 'draw';
    const baseBet = Number(o.baseBet) || HALLS[0].baseBet;
    const multiplier = type === 'draw' ? 0 : 1;
    const unit = baseBet * multiplier;
    const deltas = [0, 0, 0, 0];
    const reasons = ['', '', '', ''];
    const kongDeltas = [0, 0, 0, 0];
    // 每家实际付几倍：点炮时放炮方 2 倍、其余两家各 1 倍；自摸三家一律 3 倍。
    // 结算面板逐家读它，避免所有人都写死「1 倍」。
    const multiples = [0, 0, 0, 0];
    const kongs = [];
    (Array.isArray(o.kongs) ? o.kongs : []).forEach((k) => {
      const seat = Number(k && k.seat);
      if (!Number.isInteger(seat) || seat < 0 || seat > 3) return;
      const kind = KONG_KINDS[k.kind] ? k.kind : '明杠';
      const per = baseBet * KONG_KINDS[kind];
      for (let p = 0; p < 4; p++) {
        if (p === seat) continue;
        kongDeltas[p] -= per;
        kongDeltas[seat] += per;
      }
      kongs.push({ seat, kind, per, total: per * 3 });
    });

    if (type === 'draw' || !Number.isInteger(o.winnerSeat)) {
      for (let s = 0; s < 4; s++) {
        deltas[s] = kongDeltas[s];
        if (kongDeltas[s]) reasons[s] = kongDeltas[s] > 0 ? '杠' : '杠分';
      }
      return {
        type, baseBet, multiplier, unit, deltas, reasons, kongs, kongDeltas,
        multiples, total: 0, busted: [false, false, false, false]
      };
    }
    const winner = o.winnerSeat;
    const discarder = Number.isInteger(o.discarderSeat) ? o.discarderSeat : -1;
    const due = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) {
      if (s === winner) continue;
      if (type === 'discard') {
        multiples[s] = s === discarder ? 2 : 1;
        due[s] = unit * multiples[s];
      } else {
        multiples[s] = 3;                          // 自摸：三家各付 3 倍
        due[s] = unit * 3;
      }
    }
    const busted = [false, false, false, false];
    let total = 0;
    for (let s = 0; s < 4; s++) {
      if (s === winner) continue;
      const kong = kongDeltas[s];
      if (!due[s] && !kong) continue;
      // 杠分先过账，剩下的余额才用来付胡牌；余额不够就付到 0
      const have = Math.max(0, Number((o.balances || [])[s]) + kong);
      const pay = Number.isFinite(have) && (o.balances || []).length ? Math.min(due[s], have) : due[s];
      if (due[s] && pay < due[s]) busted[s] = true;
      deltas[s] = -pay + kong;
      if (due[s]) { reasons[s] = s === discarder ? '点炮' : '输'; total += pay; }
      else reasons[s] = '杠分';
    }
    deltas[winner] = total + kongDeltas[winner];
    reasons[winner] = type === 'self' ? '自摸' : '胡';
    return { type, baseBet, multiplier, unit, deltas, reasons, kongs, kongDeltas, multiples, total, busted };
  }

  /** 段位分变化：赢家 +7，点炮 -3，其余 -2（无庄家，所以没有倍率） */
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

  /* ---------------- 每日福利：登录礼 + 免费银币 ----------------
   * 用户要的是：每天登录先给 4,000，另外每天还能点 10 次「免费领银币」，每次 4,000。
   * 首日不发登录礼 —— 那天的 4,000 见面礼就是这个位置的钱，不能重复发。
   * 所有计数都按「自然日」存，跨天自动清零（不靠定时器，靠 dayKey 比对）。
   */
  const DAILY_LOGIN_COINS = 4000;
  const FREE_CLAIM_TIMES = 10;
  const FREE_CLAIM_COINS = 4000;

  function dailyState(account, today) {
    const acc = normalizeAccount(account);
    const day = dayKey(today);
    const seen = !!acc.daily;                       // 以前进过大厅（有存档日期）
    const sameDay = seen && acc.daily.day === day;
    const used = sameDay ? Math.max(0, Number(acc.daily.free) || 0) : 0;
    return {
      day,
      firstEver: !seen,                             // 首次进大厅：只盖章，不发钱
      sameDay,
      loginTaken: sameDay ? !!acc.daily.login : false,
      freeUsed: Math.min(used, FREE_CLAIM_TIMES),
      freeLeft: Math.max(0, FREE_CLAIM_TIMES - used),
      times: FREE_CLAIM_TIMES,
      loginCoins: DAILY_LOGIN_COINS,
      freeCoins: FREE_CLAIM_COINS
    };
  }

  /** 每日登录礼。首日只记日子（见面礼已经发过），之后每天第一次进大厅发一次 */
  function claimDailyLogin(store, account, today) {
    const acc = normalizeAccount(account);
    const st = dailyState(acc, today);
    if (st.loginTaken) return { ok: false, code: 'taken', error: '今天已经领过登录礼了', state: st };
    if (st.firstEver) {
      acc.daily = { day: st.day, login: true, free: 0 };
      update(store, acc);
      return { ok: false, code: 'first-day', error: '首日见面礼已含登录礼', state: dailyState(acc, today), account: acc };
    }
    acc.daily = { day: st.day, login: true, free: st.sameDay ? st.freeUsed : 0 };
    acc.coins += DAILY_LOGIN_COINS;
    update(store, acc);
    return { ok: true, coins: DAILY_LOGIN_COINS, state: dailyState(acc, today), account: acc };
  }

  /** 免费领银币：每天 10 次，每次 4,000 */
  function claimFreeCoins(store, account, today) {
    const acc = normalizeAccount(account);
    const st = dailyState(acc, today);
    if (st.freeLeft <= 0) return { ok: false, code: 'empty', error: '今天的免费银币领完了，明天再来', state: st };
    acc.daily = { day: st.day, login: st.loginTaken, free: st.freeUsed + 1 };
    acc.coins += FREE_CLAIM_COINS;
    update(store, acc);
    return { ok: true, coins: FREE_CLAIM_COINS, state: dailyState(acc, today), account: acc };
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

  /** 账号规则（全站唯一）：2-20 位，中文 / 字母 / 数字 / _ @ . - ，手机号按 11 位数字走 */
  const ACCOUNT_MIN = 2;
  const ACCOUNT_MAX = 20;
  const PASSWORD_MIN = 4;
  const PASSWORD_MAX = 32;
  const ACCOUNT_RE = /^[\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9_@.-]+$/;
  const PHONE_RE = /^1[3-9]\d{9}$/;

  /** 校验账号，返回 { ok, value, kind, error }；kind 为 phone / name，界面据此换提示语 */
  function checkAccount(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) return { ok: false, error: '请输入账号' };
    if (v.length < ACCOUNT_MIN) return { ok: false, error: `账号至少 ${ACCOUNT_MIN} 位` };
    if (v.length > ACCOUNT_MAX) return { ok: false, error: `账号最多 ${ACCOUNT_MAX} 位` };
    if (PHONE_RE.test(v)) return { ok: true, value: v, kind: 'phone' };
    if (!ACCOUNT_RE.test(v)) return { ok: false, error: '账号只能包含中文、字母、数字或 _ @ . -' };
    return { ok: true, value: v, kind: 'name' };
  }

  /** 校验密码，返回 { ok, value, error } */
  function checkPassword(raw) {
    const v = String(raw == null ? '' : raw);
    if (!v) return { ok: false, error: '请输入密码' };
    if (v.length < PASSWORD_MIN) return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` };
    if (v.length > PASSWORD_MAX) return { ok: false, error: `密码最多 ${PASSWORD_MAX} 位` };
    return { ok: true, value: v };
  }

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
      prevSeason: { id: SEASON.prevId, rank: '佃户', points: 112, activated: true },
      activated: false,
      stats: { rounds: 0, wins: 0, selfDraw: 0, discardWin: 0, draws: 0, kongs: 0 },
      signin: { claimed: [], lastDay: '', streak: 0, streakClaimed: 0 },
      back: { claimed: [] },
      daily: null,
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
      daily: (a.daily && typeof a.daily === 'object')
        ? { day: String(a.daily.day || ''), login: !!a.daily.login, free: Math.max(0, Number(a.daily.free) || 0) }
        : null,
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
    const ca = checkAccount(o.account);
    if (!ca.ok) return { ok: false, error: ca.error, field: 'account', code: 'bad-account' };
    const cp = checkPassword(o.password);
    if (!cp.ok) return { ok: false, error: cp.error, field: 'password', code: 'bad-password' };
    const account = ca.value;
    if (findByAccount(store, account)) {
      return { ok: false, error: '该账号已被注册，直接登录即可', field: 'account', code: 'duplicate' };
    }
    const list = loadAccounts(store);
    const acc = blankAccount(account, o.nick || account);
    acc.pass = hashPassword(cp.value);
    list.push(acc);
    saveAccounts(store, list);
    return { ok: true, account: acc, isNew: true };
  }

  function login(store, opts) {
    const o = opts || {};
    const ca = checkAccount(o.account);
    if (!ca.ok) return { ok: false, error: ca.error, field: 'account', code: 'bad-account' };
    const acc = findByAccount(store, ca.value);
    if (!acc) return { ok: false, error: '没有找到这个账号', field: 'account', code: 'no-account' };
    if (acc.pass !== hashPassword(o.password || '')) {
      return { ok: false, error: '密码不正确', field: 'password', code: 'bad-password' };
    }
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
    const prev = acc.prevSeason || { id: SEASON.prevId, rank: '佃户', points: 112 };
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
    DAILY_LOGIN_COINS, FREE_CLAIM_TIMES, FREE_CLAIM_COINS,
    START_COINS, START_GOLD,
    ACCOUNT_MIN, ACCOUNT_MAX, PASSWORD_MIN, PASSWORD_MAX, PHONE_RE,
    checkAccount, checkPassword,
    rankOf, hallOf, coinsRangeText,
    computeRound, computeRankDelta,
    makeStore, hashPassword, blankAccount, normalizeAccount,
    loadAccounts, saveAccounts, findByAccount, register, login, update,
    session, setSession, currentAccount, applyRound,
    dayKey, shiftDay, signinState, claimSignin, backState, claimBack,
    dailyState, claimDailyLogin, claimFreeCoins,
    inheritState, confirmInherit, fmtNum, fmtSigned
  };
});
