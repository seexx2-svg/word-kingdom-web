/* 账号 / 赛季 / 经济内核测试 | GPL-3.0-or-later
 *
 * 这一层不碰 DOM，只算数：一局输赢多少、段位涨跌、签到与赛季继承。
 * 核心用例的期望值直接取自「博雅·红河棋牌」界面截图里的数字，
 * 用来钉死「界面显示和账本算的是同一套东西」。
 */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../js/account.js');

/** 独立的内存存储，避免用例之间互相污染 */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
}

/* ---------------- 结算 ---------------- */

test('computeRound：底注 2000 点炮 1 倍 —— 点炮者付两份，其余各一份', () => {
  const r = A.computeRound({
    type: 'discard', baseBet: 2000, winnerSeat: 0, discarderSeat: 3,
    balances: [13500, 16500, 15090, 7672]
  });
  assert.equal(r.multiplier, 1, '石屏麻将没有庄家，也就没有翻倍');
  assert.equal(r.unit, 2000);
  assert.deepEqual(r.deltas, [8000, -2000, -2000, -4000], '点炮者 2 份，其余各 1 份');
  assert.equal(r.total, 8000, '赢家实收 = 三家实际扣款之和');
  assert.equal(r.deltas.reduce((a, b) => a + b, 0), 0, '四家总和恒为 0');
  assert.deepEqual(r.busted, [false, false, false, false], '余额都够付');
  assert.deepEqual(r.reasons, ['胡', '输', '输', '点炮']);
});

test('computeRound：谁起手都不影响分数（没有庄家）', () => {
  const base = { type: 'discard', baseBet: 2000, winnerSeat: 0, discarderSeat: 3, balances: [50000, 50000, 50000, 50000] };
  const asDealer = A.computeRound(Object.assign({}, base, { dealerWin: true }));
  const asOther = A.computeRound(Object.assign({}, base, { dealerWin: false }));
  assert.deepEqual(asDealer.deltas, asOther.deltas, '有庄无庄必须一模一样');
  assert.equal(asDealer.multiplier, 1);
  assert.equal(asOther.multiplier, 1);
});

test('computeRound：点炮者余额不足时只扣到 0，赢家拿不到不存在的钱', () => {
  const r = A.computeRound({
    type: 'discard', baseBet: 2000, winnerSeat: 0, discarderSeat: 3,
    balances: [13500, 16500, 15090, 1000]
  });
  // 点炮者该付 4000，只有 1000 → 扣 1000 并标记破产
  assert.deepEqual(r.deltas, [5000, -2000, -2000, -1000]);
  assert.deepEqual(r.busted, [false, false, false, true]);
  assert.equal(r.deltas.reduce((a, b) => a + b, 0), 0);
});

test('computeRound：自摸三家各付 unit×2，赢家收总和', () => {
  const r = A.computeRound({
    type: 'self', baseBet: 8000, winnerSeat: 1,
    balances: [100000, 100000, 100000, 100000]
  });
  assert.equal(r.unit, 8000);
  assert.deepEqual(r.deltas, [-16000, 48000, -16000, -16000]);
  assert.equal(r.deltas.reduce((a, b) => a + b, 0), 0);
});

test('computeRound：流局所有人不动', () => {
  const r = A.computeRound({ type: 'draw', baseBet: 28000, balances: [1, 2, 3, 4] });
  assert.equal(r.multiplier, 0);
  assert.deepEqual(r.deltas, [0, 0, 0, 0]);
  assert.equal(r.total, 0);
});

test('computeRound：自摸时余额不足的人只扣到 0', () => {
  const r = A.computeRound({
    type: 'self', baseBet: 8000, winnerSeat: 0,
    balances: [50000, 5000, 99999, 16000]
  });
  // 每家应付 16000；1 号位只有 5000
  assert.deepEqual(r.deltas, [37000, -5000, -16000, -16000]);
  assert.deepEqual(r.busted, [false, true, false, false]);
  assert.equal(r.deltas.reduce((a, b) => a + b, 0), 0);
});

test('computeRankDelta：赢家 +7，点炮 -3，其余 -2', () => {
  const sd = A.computeRound({
    type: 'discard', baseBet: 2000, winnerSeat: 0, discarderSeat: 3,
    balances: [13500, 16500, 15090, 7672]
  });
  assert.deepEqual(A.computeRankDelta(sd), [7, -2, -2, -3]);
});

test('computeRankDelta：自摸时三家都 -2', () => {
  const sd = A.computeRound({ type: 'self', baseBet: 8000, winnerSeat: 2, balances: [1e6, 1e6, 1e6, 1e6] });
  assert.deepEqual(A.computeRankDelta(sd), [-2, -2, 7, -2]);
});

test('computeRankDelta：流局不加不减', () => {
  const sd = A.computeRound({ type: 'draw', baseBet: 2000, balances: [1, 1, 1, 1] });
  assert.deepEqual(A.computeRankDelta(sd), [0, 0, 0, 0]);
});

/* ---------------- 段位 ---------------- */

test('rankOf：阈值命中与越界都落在正确段位', () => {
  assert.equal(A.rankOf(0).name, '新秀一阶');
  assert.equal(A.rankOf(419).name, '新秀一阶');
  assert.equal(A.rankOf(420).name, '新秀二阶');
  assert.equal(A.rankOf(860).name, '下士');
  assert.equal(A.rankOf(999999).name, '中将');
  assert.equal(A.rankOf(-5).name, '新秀一阶', '负数按 0 处理');
  assert.equal(A.rankOf(undefined).name, '新秀一阶');
});

test('rankOf：进度文本与比例（截图里的 385/420）', () => {
  const r = A.rankOf(385);
  assert.equal(r.name, '新秀一阶');
  assert.equal(r.text, '385/420');
  assert.ok(Math.abs(r.ratio - 385 / 420) < 1e-9);
  assert.equal(r.next, '新秀二阶');
});

test('rankOf：顶段没有下一档时标记已封顶', () => {
  const r = A.rankOf(999999);
  assert.equal(r.next, '已封顶');
  assert.equal(r.text, '已封顶');
  assert.equal(r.ratio, 1);
});

/* ---------------- 场次 ---------------- */

test('场次表：三档底分与门槛递增，最高档无上限', () => {
  assert.deepEqual(A.HALLS.map((h) => h.id), ['novice', 'mid', 'high']);
  assert.deepEqual(A.HALLS.map((h) => h.baseBet), [2000, 8000, 28000]);
  assert.ok(A.HALLS[2].maxCoins === Infinity);
  for (let i = 1; i < A.HALLS.length; i++) {
    assert.ok(A.HALLS[i].minCoins > A.HALLS[i - 1].minCoins);
  }
});

test('hallOf：未知 id 回落到初级场', () => {
  assert.equal(A.hallOf('mid').name, '中级场');
  assert.equal(A.hallOf('nope').id, 'novice');
  assert.equal(A.hallOf(undefined).id, 'novice');
});

test('coinsRangeText：带万单位且封顶不显示 Infinity', () => {
  assert.equal(A.coinsRangeText(A.HALLS[0]), '3000-2.5万');
  assert.equal(A.coinsRangeText(A.HALLS[1]), '2万-12万');
  assert.equal(A.coinsRangeText(A.HALLS[2]), '6万-∞', '封顶档不能出现 Infinity');
});

/* ---------------- 账号 ---------------- */

test('注册：账号格式与密码长度校验', () => {
  const st = memStore();
  assert.equal(A.register(st, { account: 'a', password: '1234' }).ok, false, '账号太短');
  assert.equal(A.register(st, { account: '坏 名字', password: '1234' }).ok, false, '不允许空格');
  assert.equal(A.register(st, { account: 'okname', password: '12' }).ok, false, '密码太短');
  assert.equal(A.register(st, { account: '坏名字', password: '1234' }).ok, true, '中文账号现在允许');
  assert.equal(A.register(st, { account: 'okname', password: '1234' }).ok, true);
});

test('注册：新号带 5000 银币 / 91 金条 / 未激活段位', () => {
  const st = memStore();
  const res = A.register(st, { account: 'hero', password: 'abcd', nick: '阿虎' });
  assert.equal(res.account.coins, A.START_COINS);
  assert.equal(res.account.coins, 5000);
  assert.equal(res.account.gold, 91);
  assert.equal(res.account.activated, false);
  assert.equal(res.account.nick, '阿虎');
  assert.equal(res.account.rankPoints, 0);
});

test('注册：同名账号不可重复注册', () => {
  const st = memStore();
  A.register(st, { account: 'hero', password: 'abcd' });
  const again = A.register(st, { account: 'hero', password: 'zzzz' });
  assert.equal(again.ok, false);
  assert.match(again.error, /已被注册/);
});

test('登录：密码正确通过，错误与不存在分别报错', () => {
  const st = memStore();
  A.register(st, { account: 'hero', password: 'abcd' });
  assert.equal(A.login(st, { account: 'hero', password: 'abcd' }).ok, true);
  const bad = A.login(st, { account: 'hero', password: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /密码/);
  const missing = A.login(st, { account: 'ghost', password: 'abcd' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'no-account');
  assert.match(missing.error, /没有找到|不存在/);
});

test('密码不落明文：存储里只有哈希', () => {
  const st = memStore();
  A.register(st, { account: 'hero', password: 'plaintext-pw' });
  const raw = st.getItem('honghe-accounts-v1');
  assert.ok(raw.indexOf('plaintext-pw') < 0, '不得把明文密码写进存储');
  assert.equal(A.hashPassword('plaintext-pw'), A.hashPassword('plaintext-pw'), '同一密码哈希稳定');
  assert.notEqual(A.hashPassword('a'), A.hashPassword('b'));
});

test('session：登录态可写入、可读取、可清空', () => {
  const st = memStore();
  const acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  assert.equal(A.currentAccount(st), null);
  A.setSession(st, acc.id);
  assert.equal(A.currentAccount(st).account, 'hero');
  A.setSession(st, '');
  assert.equal(A.currentAccount(st), null);
});

/* ---------------- 一局结算写账 ---------------- */

test('applyRound：赢家加银币加段位分，并累加战绩', () => {
  const st = memStore();
  const acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  const sd = A.computeRound({
    type: 'discard', baseBet: 2000, winnerSeat: 0, discarderSeat: 3, dealerWin: true,
    balances: [acc.coins, 20000, 20000, 20000]
  });
  const after = A.applyRound(st, acc, sd);
  assert.equal(after.coins, 5000 + sd.deltas[0]);
  assert.equal(after.rankPoints, A.computeRankDelta(sd)[0]);
  assert.equal(after.activated, true, '打过一局后段位激活');
  assert.equal(after.stats.rounds, 1);
  assert.equal(after.stats.wins, 1);
  assert.equal(after.stats.discardWin, 1);
  assert.equal(A.currentAccount(st), null, '未设 session 不应影响读取');
  const persisted = A.loadAccounts(st)[0];
  assert.equal(persisted.coins, after.coins, '必须落盘');
});

test('applyRound：银币和段位分都不会变成负数', () => {
  const st = memStore();
  const acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  acc.coins = 100;
  acc.rankPoints = 1;
  const sd = A.computeRound({
    type: 'self', baseBet: 28000, winnerSeat: 1, dealerWin: true,
    balances: [100, 1e6, 1e6, 1e6]
  });
  const after = A.applyRound(st, acc, sd);
  assert.equal(after.coins, 0);
  assert.equal(after.rankPoints, 0);
});

test('applyRound：流局只计局数', () => {
  const st = memStore();
  const acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  const before = acc.coins;
  const after = A.applyRound(st, acc, A.computeRound({ type: 'draw', baseBet: 2000, balances: [1, 1, 1, 1] }));
  assert.equal(after.coins, before);
  assert.equal(after.rankPoints, 0);
  assert.equal(after.stats.draws, 1);
  assert.equal(after.stats.wins, 0);
});

/* ---------------- 每日福利：登录礼 + 免费领银币 ---------------- */

test('每日登录礼：首日不发（见面礼就是首日那笔），之后每天进大厅发 4,000', () => {
  const st = memStore();
  let acc = A.register(st, { account: 'daily1', password: 'abcd' }).account;
  const d1 = new Date('2026-11-06T09:00:00');
  const d2 = new Date('2026-11-07T09:00:00');

  assert.equal(A.dailyState(acc, d1).firstEver, true, '第一次进大厅');
  const first = A.claimDailyLogin(st, acc, d1);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'first-day');
  assert.equal(first.account.coins, 5000, '首日不加钱，只把日子记下来');
  acc = first.account;

  const again = A.claimDailyLogin(st, acc, d1);
  assert.equal(again.code, 'taken', '同一天不会再发一次');

  const second = A.claimDailyLogin(st, acc, d2);
  assert.equal(second.ok, true);
  assert.equal(second.coins, 4000);
  assert.equal(second.account.coins, 9000);

  const third = A.claimDailyLogin(st, second.account, d2);
  assert.equal(third.code, 'taken');
});

test('免费领银币：每天 10 次、每次 4,000，第 11 次拒绝；跨天自动重置', () => {
  const st = memStore();
  let acc = A.register(st, { account: 'daily2', password: 'abcd' }).account;
  const today = new Date('2026-11-06T12:00:00');
  A.claimDailyLogin(st, acc, today);            // 首日盖章
  acc = A.loadAccounts(st)[0];

  for (let i = 1; i <= A.FREE_CLAIM_TIMES; i++) {
    const r = A.claimFreeCoins(st, acc, today);
    assert.equal(r.ok, true, '第 ' + i + ' 次应该能领');
    assert.equal(r.coins, 4000);
    assert.equal(r.state.freeUsed, i);
    acc = r.account;
  }
  assert.equal(acc.coins, 5000 + 4000 * 10, '10 次共 40,000');

  const over = A.claimFreeCoins(st, acc, today);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'empty');
  assert.equal(over.state.freeLeft, 0);

  const tomorrow = new Date('2026-11-07T00:10:00');
  const fresh = A.claimFreeCoins(st, acc, tomorrow);
  assert.equal(fresh.ok, true, '跨天次数清零');
  assert.equal(fresh.state.freeUsed, 1);
  assert.equal(fresh.state.freeLeft, 9);
});

/* ---------------- 每日签到 ---------------- */

test('签到：按顺序领，每天只能领一次，第 3 天送金条', () => {
  const st = memStore();
  let acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  const d1 = new Date('2026-11-06T10:00:00');
  const d2 = new Date('2026-11-07T10:00:00');
  const d3 = new Date('2026-11-08T10:00:00');

  assert.equal(A.signinState(acc, d1).nextDay, 1);
  assert.equal(A.signinState(acc, d1).canClaimToday, true);

  const r1 = A.claimSignin(st, acc, d1);
  assert.equal(r1.ok, true);
  assert.equal(r1.coins, 1000);
  assert.equal(r1.gold, 0);
  acc = r1.account;
  assert.equal(acc.coins, 6000);

  const dup = A.claimSignin(st, acc, d1);
  assert.equal(dup.ok, false, '同一天不能领两次');

  const r2 = A.claimSignin(st, acc, d2);
  assert.equal(r2.ok, true);
  acc = r2.account;

  const r3 = A.claimSignin(st, acc, d3);
  assert.equal(r3.ok, true);
  assert.equal(r3.gold, 30, '连续 3 天额外送 30 金条');
  acc = r3.account;
  assert.equal(acc.gold, A.START_GOLD + 30);
  assert.equal(acc.coins, 5000 + 3000);
  assert.deepEqual(A.signinState(acc, d3).claimed, [1, 2, 3]);
});

test('签到：不能跳天领，7 天领满后停止', () => {
  const st = memStore();
  let acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  const jump = A.claimSignin(st, acc, new Date('2026-11-06T10:00:00'), 3);
  assert.equal(jump.ok, false, '必须按顺序');

  let day = 0;
  while (day < 7) {
    day += 1;
    const d = new Date('2026-11-06T10:00:00');
    d.setDate(d.getDate() + day - 1);
    const r = A.claimSignin(st, acc, d);
    assert.equal(r.ok, true, '第 ' + day + ' 天应能领取');
    acc = r.account;
  }
  const d8 = new Date('2026-11-13T10:00:00');
  assert.equal(A.claimSignin(st, acc, d8).ok, false, '7 天已满');
  assert.equal(A.signinState(acc, d8).canClaimToday, false);
});

/* ---------------- 回归好礼 ---------------- */

test('回归好礼：7 天按顺序领，领完截止', () => {
  const st = memStore();
  let acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  assert.equal(A.backState(acc).days, 7);
  for (let d = 1; d <= 7; d++) {
    const r = A.claimBack(st, acc);
    assert.equal(r.ok, true, '第 ' + d + ' 天');
    assert.equal(r.coins, 1000);
    acc = r.account;
  }
  assert.equal(acc.coins, 5000 + 7000);
  assert.equal(A.claimBack(st, acc).ok, false);
  assert.equal(A.backState(acc).canClaim, false);
});

/* ---------------- 赛季继承 ---------------- */

test('赛季继承：新号未激活，继承后从 0 分重新开始', () => {
  const st = memStore();
  let acc = A.register(st, { account: 'hero', password: 'abcd' }).account;
  acc.rankPoints = 385;
  acc = A.update(st, acc);

  const st1 = A.inheritState(acc);
  assert.equal(st1.seasonId, 'S25');
  assert.equal(st1.prevSeasonId, 'S20');
  assert.equal(st1.needInherit, true);
  assert.equal(st1.nowRank, A.INACTIVE_RANK, '未激活显示「未激活」');
  assert.equal(st1.prevRank, '长工');
  assert.equal(st1.prevPoints, 112);

  const after = A.confirmInherit(st, acc);
  assert.equal(after.rankPoints, 0);
  assert.equal(after.activated, false);
  assert.equal(after.seasonId, 'S25');
  assert.equal(A.inheritState(after).needInherit, true);
});

test('赛季常量：S25 的起止日期与展示文案', () => {
  assert.equal(A.SEASON.id, 'S25');
  assert.equal(A.SEASON.rangeText, '2026.11.06~2027.01.05');
});

/* ---------------- 格式化 ---------------- */

test('数字格式：千分位与带符号', () => {
  assert.equal(A.fmtNum(1234567), '1,234,567');
  assert.equal(A.fmtNum(0), '0');
  assert.equal(A.fmtNum(undefined), '0');
  assert.equal(A.fmtSigned(9), '+9');
  assert.equal(A.fmtSigned(-3), '-3');
  assert.equal(A.fmtSigned(0), '0');
});
