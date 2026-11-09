/* 认证层单元测试：账号规则、登录/注册、记住账号、清档
 * 运行：node --test tests/auth.test.cjs
 *
 * 这一层不碰 DOM，所以可以用内存 store 直接把每条分支都跑到；
 * 真实点击的链路在 login.browser.test.cjs 里测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../js/account.js');
const Auth = require('../js/auth.js');

/** 内存 store：带 length / key()，行为对齐 localStorage */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
    dump: () => Object.fromEntries(m)
  };
}

let mem;
test.beforeEach(() => {
  mem = memStore();
  Auth.useStore(mem);
});

/* ---------------- 账号规则 ---------------- */
test('账号规则：支持中文昵称', () => {
  const r = A.checkAccount('张三');
  assert.equal(r.ok, true);
  assert.equal(r.value, '张三');
  assert.equal(r.kind, 'name');
});

test('账号规则：支持 11 位手机号并标记为 phone', () => {
  const r = A.checkAccount('13800138000');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'phone');
});

test('账号规则：字母数字与 _ @ . - 都合法', () => {
  ['ab', 'player_1', 'a@b.c', 'x-y.z', 'A1'].forEach((v) => {
    assert.equal(A.checkAccount(v).ok, true, v + ' 应合法');
  });
});

test('账号规则：空 / 太短 / 太长 / 非法字符都要拒绝并给出原因', () => {
  assert.equal(A.checkAccount('').error, '请输入账号');
  assert.equal(A.checkAccount('  ').error, '请输入账号');
  assert.equal(A.checkAccount('a').error, '账号至少 2 位');
  assert.equal(A.checkAccount('a'.repeat(21)).error, '账号最多 20 位');
  assert.equal(A.checkAccount('bad name').ok, false);
  assert.equal(A.checkAccount('emoji😀').ok, false);
});

test('账号规则：前后空格会被裁掉', () => {
  assert.equal(A.checkAccount('  张三  ').value, '张三');
});

test('密码规则：4-32 位，允许空格与符号', () => {
  assert.equal(A.checkPassword('').error, '请输入密码');
  assert.equal(A.checkPassword('123').error, '密码至少 4 位');
  assert.equal(A.checkPassword('a'.repeat(33)).error, '密码最多 32 位');
  assert.equal(A.checkPassword('12 34').ok, true);
  assert.equal(A.checkPassword('!@#$%^&*').ok, true);
});

/* ---------------- 注册 / 登录 ---------------- */
test('注册：中文账号能建号并直接登陆', async () => {
  const res = await Auth.signUp({ account: '张三', password: '1234' });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.account.nick, '张三');
  assert.equal(res.account.coins, A.START_COINS);
  assert.equal(res.account.gold, A.START_GOLD);
  assert.equal((await Auth.current()).account, '张三', '注册后应已建立会话');
});

test('注册：手机号能建号', async () => {
  const res = await Auth.signUp({ account: '13800138000', password: 'abcd' });
  assert.equal(res.ok, true);
  assert.equal(res.account.account, '13800138000');
});

test('注册：账号已存在时返回 duplicate，不覆盖原密码', async () => {
  await Auth.signUp({ account: '张三', password: '1234' });
  const again = await Auth.signUp({ account: '张三', password: '9999' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'duplicate');
  assert.match(again.error, /已被注册/);
  const login = await Auth.signIn({ account: '张三', password: '1234' });
  assert.equal(login.ok, true, '原密码必须仍然有效');
});

test('注册：密码太短被拦下，且不会留下半成品账号', async () => {
  const res = await Auth.signUp({ account: '李四', password: '12' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-password');
  assert.equal(await Auth.current(), null);
  const list = await Auth.list();
  assert.equal(list.length, 0);
});

test('登录：密码错误返回 bad-password 并指向密码框', async () => {
  await Auth.signUp({ account: '张三', password: '1234' });
  await Auth.signOut();
  const res = await Auth.signIn({ account: '张三', password: '9999' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-password');
  assert.equal(res.field, 'password');
});

test('登录：账号不存在返回 no-account 并指向账号框', async () => {
  const res = await Auth.signIn({ account: 'nobody', password: '1234' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-account');
  assert.equal(res.field, 'account');
});

test('登录：大小写与空格不影响匹配（账号先 trim）', async () => {
  await Auth.signUp({ account: 'PlayerOne', password: '1234' });
  await Auth.signOut();
  assert.equal((await Auth.signIn({ account: ' PlayerOne ', password: '1234' })).ok, true);
  assert.equal((await Auth.signIn({ account: 'playerone', password: '1234' })).code, 'no-account', '账号区分大小写');
});

test('登录：密码不落明文，只存哈希', async () => {
  await Auth.signUp({ account: '张三', password: 'my-secret-pw' });
  const raw = JSON.stringify(mem.dump());
  assert.equal(raw.includes('my-secret-pw'), false, 'localStorage 里不能出现明文密码');
  assert.match(JSON.parse(mem.getItem('honghe-accounts-v1'))[0].pass, /^[0-9a-z]+\.[0-9a-z]+$/);
});

test('会话：退出后 current 为 null，重新登录能恢复同一个号', async () => {
  const up = await Auth.signUp({ account: '张三', password: '1234' });
  await Auth.signOut();
  assert.equal(await Auth.current(), null);
  const res = await Auth.signIn({ account: '张三', password: '1234' });
  assert.equal(res.ok, true);
  assert.equal(res.account.id, up.account.id, '重新登录应是同一个账号');
});

/* ---------------- 一步登录（自动建号） ---------------- */
test('一步登录：没有的账号直接建号并登陆', async () => {
  const res = await Auth.signInOrSignUp({ account: '新玩家', password: 'abcd' });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.autoCreated, true);
  assert.equal((await Auth.current()).account, '新玩家');
});

test('一步登录：已有的账号走登录，不会重复建号', async () => {
  await Auth.signUp({ account: '老玩家', password: 'abcd' });
  await Auth.signOut();
  const res = await Auth.signInOrSignUp({ account: '老玩家', password: 'abcd' });
  assert.equal(res.ok, true);
  assert.equal(res.created, false);
  assert.equal((await Auth.list()).length, 1, '不能凭空多出一个账号');
});

test('一步登录：密码错了就报错，绝不偷偷新建一个同名号', async () => {
  await Auth.signUp({ account: '老玩家', password: 'abcd' });
  await Auth.signOut();
  const res = await Auth.signInOrSignUp({ account: '老玩家', password: 'wrong' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-password');
  assert.equal((await Auth.list()).length, 1);
});

test('一步登录：autoCreate=false 时只登录不建号', async () => {
  const res = await Auth.signInOrSignUp({ account: '不存在的人', password: 'abcd', autoCreate: false });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no-account');
  assert.equal((await Auth.list()).length, 0);
});

/* ---------------- 记住账号 ---------------- */
test('记住账号：默认开启，登录后能回填', async () => {
  assert.equal(Auth.rememberEnabled(), true);
  await Auth.signUp({ account: '张三', password: '1234' });
  assert.equal(Auth.lastAccount(), '张三');
});

test('记住账号：关闭后不再回填，历史列表仍然保留', async () => {
  await Auth.signUp({ account: '张三', password: '1234' });
  Auth.setRemember(false);
  assert.equal(Auth.rememberEnabled(), false);
  assert.equal(Auth.lastAccount(), '', '关闭记住后不应回填');
  assert.deepEqual(Auth.history(), ['张三'], '历史列表不受影响');
});

test('历史账号：最近的排最前、重复不重复占位、最多 8 条', async () => {
  ['a1', 'b2', 'c3', 'a1', 'd4'].forEach((n) => Auth.rememberAccount(n));
  assert.deepEqual(Auth.history().slice(0, 3), ['d4', 'a1', 'c3']);
  for (let i = 0; i < 12; i++) Auth.rememberAccount('u' + i);
  assert.equal(Auth.history().length, 8);
  assert.equal(Auth.history()[0], 'u11');
});

test('历史账号：可以单条删除', async () => {
  ['a1', 'b2'].forEach((n) => Auth.rememberAccount(n));
  Auth.forgetAccount('a1');
  assert.deepEqual(Auth.history(), ['b2']);
  assert.equal(Auth.lastAccount(), 'b2');
});

/* ---------------- 清档 / 换后端 ---------------- */
test('清空本机存档：账号、会话、赛季、牌桌进度全部清掉', async () => {
  await Auth.signUp({ account: '张三', password: '1234' });
  mem.setItem('honghe-season-seen-S25', '1');
  mem.setItem('shiping-mahjong-bankroll-v1', '[1,2,3,4]');
  mem.setItem('unrelated-key', 'keep');
  const removed = Auth.clearLocal();
  assert.ok(removed.length >= 4);
  assert.equal(mem.getItem('honghe-accounts-v1'), null);
  assert.equal(mem.getItem('honghe-session-v1'), null);
  assert.equal(mem.getItem('shiping-mahjong-bankroll-v1'), null);
  assert.equal(mem.getItem('unrelated-key'), 'keep', '别的应用的键不能被误删');
});

test('账号列表：只暴露界面需要的字段，不含密码哈希', async () => {
  await Auth.signUp({ account: '张三', password: '1234' });
  const list = await Auth.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].account, '张三');
  assert.equal(list[0].pass, undefined);
});

test('可以替换成别的认证后端（为接服务端留的口子）', async () => {
  let called = 0;
  Auth.useProvider({
    id: 'fake-cloud',
    async signIn() { called += 1; return { ok: true, account: { id: 'x', account: '云端号', nick: '云端号', coins: 1 } }; },
    async signUp() { return { ok: false, error: 'nope' }; },
    async signOut() { return { ok: true }; },
    async current() { return null; },
    async list() { return []; }
  });
  assert.equal(Auth.currentProvider().id, 'fake-cloud');
  const res = await Auth.signIn({ account: '云端号', password: 'x' });
  assert.equal(res.ok, true);
  assert.equal(called, 1);
  Auth.useStore(mem);           // 复原，避免影响后续用例
  assert.equal(Auth.currentProvider().id, 'guest');
});
