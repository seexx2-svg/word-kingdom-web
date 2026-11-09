/* 云服务接入层单测：映射、错误翻译、RLS 空数组、验证码时序
 *
 * 这里全部用假 client，跑在 Node 里，不碰真实网络。
 * 真实云端连通性由 tests/cloud-live.cjs 在发布域名上验证；
 * 真机登录（收短信/扫码）由使用者自己走一遍。
 */
const test = require('node:test');
const assert = require('node:assert');

const Cloud = require('../js/cloud.js');
global.HongheCloud = Cloud;                 // auth.js 在 Node 里靠这个拿到云端模块
const Auth = require('../js/auth.js');

/* ---------------- 假 client ---------------- */
function makeDb(plan) {
  const calls = [];
  const run = (q) => {
    calls.push({ table: q.table, op: q.op, filters: q.filters.slice(), payload: q.payload });
    const h = (plan && plan[q.table]) || {};
    if (q.op === 'insert') return typeof h.insert === 'function' ? h.insert(q.payload) : { data: [], error: null };
    if (q.op === 'update') return typeof h.update === 'function' ? h.update(q.payload, q.filters) : { data: [], error: null };
    return typeof h.select === 'function' ? h.select(q.filters) : { data: null, error: null };
  };
  return {
    calls,
    from(table) {
      const q = { table, op: 'select', filters: [], payload: null };
      const api = {
        select() { return api; },
        eq(col, val) { q.filters.push([col, val]); return api; },
        limit() { return api; },
        order() { return api; },
        insert(row) { q.op = 'insert'; q.payload = row; return api; },
        update(row) { q.op = 'update'; q.payload = row; return api; },
        maybeSingle() { return Promise.resolve(run(q)); },
        single() { return Promise.resolve(run(q)); },
        then(a, b) { return Promise.resolve(run(q)).then(a, b); }
      };
      return api;
    }
  };
}

function makeAuth(over) {
  const calls = [];
  const base = {
    calls,
    async sendOtp(args) { calls.push({ fn: 'sendOtp', args }); return { data: { verificationId: 'vid-1', isExistingUser: false } }; },
    async verifyOtp(args) { calls.push({ fn: 'verifyOtp', args }); return { data: { user: { id: 'uid-a', phone: args.phone } } }; },
    async getSession() { calls.push({ fn: 'getSession' }); return { data: over && over.session !== undefined ? over.session : null }; },
    async signOut() { calls.push({ fn: 'signOut' }); return { error: null }; },
    async signInWithOAuth(args) { calls.push({ fn: 'signInWithOAuth', args }); return { data: { url: 'https://www.workbuddy.cn/auth?x=1' } }; }
  };
  return Object.assign(base, (over && over.auth) || {});
}

function useFake(plan, authOver) {
  const db = makeDb(plan);
  const auth = makeAuth(authOver);
  Cloud.useTestClient({ database: db, auth });
  return { db, auth };
}

const ROW = {
  id: 7,
  owner_id: 'uid-a',
  owner_name: '小双州黯',
  coins: 13500,
  gold: 93,
  rank_points: 385,
  season_id: 'S25',
  season_activated: true,
  season_seen: true,
  prev_season: { id: 'S20', rank: '长工', points: 112, activated: true },
  signin: { claimed: [1, 2], lastDay: '2026-11-09', streak: 2, streakClaimed: 0 },
  back_gift: { claimed: [1] },
  stats: { rounds: 9, wins: 4 },
  welcome_granted: true,
  created_at: '2026-11-01T10:00:00.000Z'
};
const SESSION = { user: { id: 'uid-a', phone: '13800001111', name: '小双州黯' } };

/* ---------------- 字段映射 ---------------- */

test('fromRow：云端一行按界面需要的形状摊平', () => {
  const p = Cloud.fromRow(ROW, SESSION);
  assert.equal(p.id, 'uid-a');
  assert.equal(p.rowId, 7);
  assert.equal(p.source, 'cloud');
  assert.equal(p.nick, '小双州黯');
  assert.equal(p.coins, 13500);
  assert.equal(p.gold, 93);
  assert.equal(p.rankPoints, 385);
  assert.equal(p.activated, true);
  assert.equal(p.seasonSeen, true);
  assert.equal(p.welcomeGranted, true);
  assert.deepEqual(p.signin.claimed, [1, 2]);
  assert.equal(p.stats.rounds, 9);
  assert.equal(p.createdAt, Date.parse(ROW.created_at));
  assert.equal(p.account, Cloud.maskPhone('13800001111'));
});

test('fromRow：缺字段时用与本地版一致的初始值兜底', () => {
  const p = Cloud.fromRow({ id: 1, owner_id: 'uid-b', coins: null, gold: null, rank_points: null }, { user: { id: 'uid-b' } });
  assert.equal(p.coins, 5000);
  assert.equal(p.gold, 91);
  assert.equal(p.rankPoints, 0);
  assert.equal(p.activated, false);
  assert.equal(p.seasonSeen, false);
  assert.equal(p.welcomeGranted, false);
  assert.equal(p.nick, '牌友');   // 云端没给昵称时的兜底，不等于手机号
  assert.equal(Cloud.nickOf(SESSION), '小双州黯');
});

test('toRow：永远不带 owner_id —— 归属由 DEFAULT auth.uid() 与 RLS 决定', () => {
  const row = Cloud.toRow(Cloud.fromRow(ROW, SESSION));
  assert.equal('owner_id' in row, false, 'toRow 不能包含 owner_id');
  assert.equal(row.coins, 13500);
  assert.equal(row.season_seen, true);
  assert.equal(row.welcome_granted, true);
  assert.equal(row.owner_name, '小双州黯');
  assert.ok(row.updated_at, '应带上 updated_at');
});

test('toRow：银币/段位分不会写出负数，昵称截断到 20 字', () => {
  const row = Cloud.toRow({ coins: -50, gold: -1, rankPoints: -9, nick: 'x'.repeat(40) });
  assert.equal(row.coins, 0);
  assert.equal(row.gold, 0);
  assert.equal(row.rank_points, 0);
  assert.equal(row.owner_name.length, 20);
});

/* ---------------- 错误翻译 ---------------- */

test('errorText：把云端错误翻成人话，并且区分「请重新登录」和「网络问题」', () => {
  assert.match(Cloud.errorText({ code: '42501' }), /没有权限/);
  assert.match(Cloud.errorText({ kind: 'unauthenticated' }), /重新登录/);
  assert.match(Cloud.errorText({ kind: 'network' }), /网络连接失败/);
  assert.match(Cloud.errorText({ code: '42P01' }), /数据表尚未就绪/);
  assert.match(Cloud.errorText({ message: 'Origin not allowed' }), /未授权访问云端/);
  assert.match(Cloud.errorText({ code: '23505' }), /已存在/);
  assert.match(Cloud.errorText({ message: '随便什么错' }), /随便什么错/);
});

/* ---------------- 档案读取 / 建档 ---------------- */

test('loadOrCreateProfile：已有档案直接取回，不重复建档', async () => {
  const { db } = useFake({ mahjong_players: { select: () => ({ data: ROW, error: null }) } });
  const res = await Cloud.loadOrCreateProfile(SESSION);
  assert.equal(res.ok, true);
  assert.equal(res.created, false);
  assert.equal(res.profile.rowId, 7);
  assert.equal(db.calls.filter((c) => c.op === 'insert').length, 0);
});

test('loadOrCreateProfile：没有档案就建一条，初始值交给数据库默认', async () => {
  let inserted = null;
  const { db } = useFake({
    mahjong_players: {
      select: () => ({ data: null, error: null }),
      insert: (row) => { inserted = row; return { data: [Object.assign({ id: 21 }, row)], error: null }; }
    }
  });
  const res = await Cloud.loadOrCreateProfile(SESSION);
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.profile.rowId, 21);
  assert.equal(inserted.owner_name, '小双州黯');
  assert.equal('owner_id' in inserted, false, '建档也不能自己塞 owner_id');
  assert.equal(db.calls.filter((c) => c.op === 'insert').length, 1);
});

test('loadOrCreateProfile：并发首登撞唯一键时，重读一次而不是报错', async () => {
  let reads = 0;
  useFake({
    mahjong_players: {
      select: () => { reads += 1; return { data: reads === 1 ? null : ROW, error: null }; },
      insert: () => ({ data: null, error: { code: '23505', message: 'duplicate key' } })
    }
  });
  const res = await Cloud.loadOrCreateProfile(SESSION);
  assert.equal(res.ok, true);
  assert.equal(res.created, false);
  assert.equal(res.profile.rowId, 7);
});

test('loadOrCreateProfile：没有会话就不碰数据库', async () => {
  const { db } = useFake({});
  const res = await Cloud.loadOrCreateProfile(null);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-session');
  assert.equal(db.calls.length, 0);
});

/* ---------------- 保存 ---------------- */

test('saveProfile：更新返回空数组等于被 RLS 挡了，必须报错而不是当成功', async () => {
  useFake({ mahjong_players: { update: () => ({ data: [], error: null }) } });
  const res = await Cloud.saveProfile(Cloud.fromRow(ROW, SESSION));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'blocked');
  assert.match(res.error, /不属于当前账号/);
});

test('saveProfile：正常写回只改自己那一行，且不覆盖 owner_id', async () => {
  let patch = null, filters = null;
  useFake({
    mahjong_players: {
      update: (row, f) => { patch = row; filters = f; return { data: [{ id: 7, coins: row.coins }], error: null }; }
    }
  });
  const res = await Cloud.saveProfile(Cloud.fromRow(ROW, SESSION));
  assert.equal(res.ok, true);
  assert.deepEqual(filters, [['id', 7]]);
  assert.equal('owner_id' in patch, false);
  assert.equal(patch.coins, 13500);
});

test('saveProfile：没有 rowId 时不发请求', async () => {
  const { db } = useFake({});
  const res = await Cloud.saveProfile({ coins: 1, source: 'cloud' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-row');
  assert.equal(db.calls.length, 0);
});

/* ---------------- 战绩 ---------------- */

test('recordRound：只写本局流水，不带 owner_id', async () => {
  let inserted = null;
  useFake({
    mahjong_rounds: { insert: (row) => { inserted = row; return { data: [{ id: 3, created_at: '2026-11-10T00:00:00Z' }], error: null }; } }
  });
  const res = await Cloud.recordRound({
    nick: '小双州黯', hallId: 'novice', baseBet: 2000, winType: 'discard',
    seat: 0, delta: 15672, rankDelta: 14, balanceAfter: 13500, seatScores: [15672, -4000, -4000, -7672]
  });
  assert.equal(res.ok, true);
  assert.equal(res.round.id, 3);
  assert.equal(inserted.base_bet, 2000);
  assert.equal(inserted.win_type, 'discard');
  assert.equal(inserted.delta, 15672);
  assert.equal(inserted.balance_after, 13500);
  assert.deepEqual(inserted.seat_scores, [15672, -4000, -4000, -7672]);
  assert.equal('owner_id' in inserted, false);
});

/* ---------------- 验证码时序（云端 Provider） ---------------- */

test('发码：手机号原样传给 sendOtp，不在前端加 +86；只发一次', async () => {
  const { auth } = useFake({}, {});
  Auth.useCloud(true);
  const res = await Auth.sendCode({ phone: '13800001111' });
  assert.equal(res.ok, true);
  const sends = auth.calls.filter((c) => c.fn === 'sendOtp');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].args, { phone: '13800001111' });
});

test('发码：10 位手机号在本地就被拦住，不发请求', async () => {
  const { auth } = useFake({}, {});
  Auth.useCloud(true);
  const res = await Auth.sendCode({ phone: '1380000111' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-phone');
  assert.match(res.error, /11 位/);
  assert.equal(auth.calls.filter((c) => c.fn === 'sendOtp').length, 0);
});

test('校验：没先发码就提交，提示先获取验证码且不发请求', async () => {
  const { auth } = useFake({}, {});
  Auth.useCloud(true);
  Auth.clearPending();
  const res = await Auth.verifyCode({ phone: '13800001111', token: '123456' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-challenge');
  assert.equal(auth.calls.filter((c) => c.fn === 'verifyOtp').length, 0);
});

test('校验：码错了保留挑战，重试不再重新发码', async () => {
  let n = 0;
  const { auth } = useFake({ mahjong_players: { select: () => ({ data: ROW, error: null }) } }, {
    auth: {
      async verifyOtp(args) {
        auth.calls.push({ fn: 'verifyOtp', args });
        n += 1;
        if (n === 1) return { error: { code: 'invalid_otp', message: '验证码不正确' } };
        return { data: { user: { id: 'uid-a', phone: args.phone } } };
      }
    }
  });
  Auth.useCloud(true);
  await Auth.sendCode({ phone: '13800001111' });
  const bad = await Auth.verifyCode({ phone: '13800001111', token: '000000' });
  assert.equal(bad.ok, false);
  const good = await Auth.verifyCode({ phone: '13800001111', token: '123456' });
  assert.equal(good.ok, true);
  const sends = auth.calls.filter((c) => c.fn === 'sendOtp');
  const verifies = auth.calls.filter((c) => c.fn === 'verifyOtp');
  assert.equal(sends.length, 1, '整个过程只发一次码');
  assert.equal(verifies.length, 2);
  assert.equal(verifies[1].args.verificationId, verifies[0].args.verificationId, '两次校验用同一个 verificationId');
  assert.equal(verifies[1].args.isExistingUser, verifies[0].args.isExistingUser);
});

test('校验：换手机号后旧挑战失效，要求重新发码', async () => {
  const { auth } = useFake({}, {});
  Auth.useCloud(true);
  await Auth.sendCode({ phone: '13800001111' });
  const res = await Auth.verifyCode({ phone: '13900002222', token: '123456' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-challenge');
  assert.equal(auth.calls.filter((c) => c.fn === 'verifyOtp').length, 0);
});

test('校验通过：立刻建档并带回云端账号', async () => {
  useFake({
    mahjong_players: {
      select: () => ({ data: null, error: null }),
      insert: (row) => ({ data: [Object.assign({ id: 31 }, row)], error: null })
    }
  });
  Auth.useCloud(true);
  await Auth.sendCode({ phone: '13800001111' });
  const res = await Auth.verifyCode({ phone: '13800001111', token: '123456' });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.account.source, 'cloud');
  assert.equal(res.account.rowId, 31);
});

test('云端模式与游客模式互相独立：切回游客不会污染云端账号', async () => {
  useFake({ mahjong_players: { select: () => ({ data: ROW, error: null }) } });
  Auth.useCloud(true);
  assert.equal(Auth.currentMode(), 'cloud');
  assert.equal(Auth.currentProvider().id, 'cloud');
  Auth.useCloud(false);
  assert.equal(Auth.currentMode(), 'guest');
  assert.equal(Auth.currentProvider().id, 'guest');
  Auth.useCloud(true);
});
