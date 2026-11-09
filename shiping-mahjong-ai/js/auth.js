/* 石屏麻将（AI 版）· 认证层 | GPL-3.0-or-later
 *
 * 界面只跟这一层打交道，不直接碰 localStorage 和账号哈希。
 * 所有方法都是 **async**，现在返回的是立刻 resolve 的 Promise；将来换成
 * 真实服务端（验证码、微信、token 续期）时，只要实现同样的一组方法并
 * Auth.useProvider(cloudProvider)，界面代码一行不用改。
 *
 * Provider 接口：
 *   signUp({ account, password, nick }) -> { ok, account } | { ok:false, error, field, code }
 *   signIn({ account, password })       -> { ok, account } | { ok:false, error, field, code }
 *   signOut()                           -> { ok }
 *   current()                           -> account | null
 *   list()                              -> [{ id, account, nick, avatar, coins }]
 *
 * code 约定（界面据此决定提示与是否自动建号）：
 *   bad-account | bad-password | no-account | duplicate
 */
(function (root, factory) {
  const A = (root && root.HongheAccount) ||
    (typeof require === 'function' ? require('./account.js') : null);
  const api = factory(A);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HongheAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (A) {
  'use strict';

  const KEY_REMEMBER = 'shiping-remember-v1';
  const KEY_LAST = 'shiping-last-account-v1';
  const KEY_HISTORY = 'shiping-login-history-v1';
  const MAX_HISTORY = 8;
  const LOCAL_PREFIXES = ['honghe-', 'shiping-'];

  function ok(extra) { return Object.assign({ ok: true }, extra || {}); }
  function fail(error, extra) { return Object.assign({ ok: false, error }, extra || {}); }

  function read(store, key) {
    try { return store.getItem(key); } catch (_) { return null; }
  }
  function write(store, key, value) {
    try { store.setItem(key, value); } catch (_) { /* 隐私模式写不进去，忽略 */ }
  }
  function drop(store, key) {
    try { store.removeItem(key); } catch (_) { /* ignore */ }
  }

  /* ---------------- 本机 Provider ---------------- */
  function localProvider(store) {
    const s = store || (A && A.makeStore ? A.makeStore() : null);
    if (!s) throw new Error('HongheAuth 需要 account.js 提供存储');

    return {
      id: 'local',
      label: '本机账号',
      /** 注册：账号/密码规则统一走 account.js 的 checkAccount / checkPassword */
      async signUp(input) {
        const o = input || {};
        const res = A.register(s, { account: o.account, password: o.password, nick: o.nick });
        if (!res.ok) return fail(res.error, { field: res.field, code: res.code });
        A.setSession(s, res.account.id);
        return ok({ account: res.account, created: true });
      },
      async signIn(input) {
        const o = input || {};
        const res = A.login(s, { account: o.account, password: o.password });
        if (!res.ok) return fail(res.error, { field: res.field, code: res.code });
        A.setSession(s, res.account.id);
        return ok({ account: res.account, created: false });
      },
      async signOut() {
        A.setSession(s, '');
        return ok();
      },
      async current() {
        return A.currentAccount(s);
      },
      async list() {
        return A.loadAccounts(s).map((a) => ({
          id: a.id, account: a.account, nick: a.nick, avatar: a.avatar, coins: a.coins
        }));
      }
    };
  }

  /* ---------------- 门面 ---------------- */
  let provider = localProvider();
  let store = null;

  /** 换存储（测试用内存 store），顺带重建本机 provider */
  function useStore(next) {
    store = next || null;
    provider = localProvider(store);
    return provider;
  }
  /** 换认证后端（将来接服务端）：实现同一组 async 方法即可 */
  function useProvider(next) {
    if (!next) return provider;
    provider = next;
    return provider;
  }
  function currentProvider() { return provider; }

  /** 账号不存在时自动建号，这是「输一次就进去」的主路径 */
  async function signInOrSignUp(input) {
    const o = input || {};
    const signInRes = await provider.signIn(o);
    if (signInRes.ok) return signInRes;
    if (signInRes.code !== 'no-account' || o.autoCreate === false) return signInRes;
    const up = await provider.signUp({ account: o.account, password: o.password, nick: o.nick });
    if (!up.ok) return up;
    return ok({ account: up.account, created: true, autoCreated: true });
  }

  /* ---------------- 记住账号 / 历史账号 ---------------- */
  function storeOf() { return store || (A && A.makeStore ? A.makeStore() : null); }

  function rememberEnabled() {
    const v = read(storeOf(), KEY_REMEMBER);
    return v === null ? true : v !== '0';            // 默认记住
  }
  function setRemember(on) {
    write(storeOf(), KEY_REMEMBER, on ? '1' : '0');
    if (!on) drop(storeOf(), KEY_LAST);
    return rememberEnabled();
  }
  function lastAccount() {
    if (!rememberEnabled()) return '';
    return read(storeOf(), KEY_LAST) || '';
  }
  function history() {
    const raw = read(storeOf(), KEY_HISTORY);
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, MAX_HISTORY) : [];
    } catch (_) { return []; }
  }
  function rememberAccount(name) {
    const v = String(name || '').trim();
    if (!v) return history();
    if (rememberEnabled()) write(storeOf(), KEY_LAST, v);
    const list = [v].concat(history().filter((x) => x !== v)).slice(0, MAX_HISTORY);
    write(storeOf(), KEY_HISTORY, JSON.stringify(list));
    return list;
  }
  function forgetAccount(name) {
    const list = history().filter((x) => x !== name);
    write(storeOf(), KEY_HISTORY, JSON.stringify(list));
    if (read(storeOf(), KEY_LAST) === name) drop(storeOf(), KEY_LAST);
    return list;
  }

  /* ---------------- 账号相关的门面方法 ---------------- */
  async function signUp(input) {
    const res = await provider.signUp(input || {});
    if (res.ok) rememberAccount(res.account.account);
    return res;
  }
  async function signIn(input) {
    const res = await provider.signIn(input || {});
    if (res.ok) rememberAccount(res.account.account);
    return res;
  }
  async function signInOrSignUpRemember(input) {
    const res = await signInOrSignUp(input || {});
    if (res.ok) rememberAccount(res.account.account);
    return res;
  }
  async function signOut() {
    const res = await provider.signOut();
    return res;
  }
  function current() {
    return provider.current();
  }
  function list() {
    return provider.list ? provider.list() : Promise.resolve([]);
  }

  /** 清空本机所有存档（账号、会话、赛季进度、牌桌余额、玩法选择…），危险操作，界面必须二次确认 */
  function clearLocal() {
    const s = storeOf();
    const removed = [];
    try {
      const keys = [];
      for (let i = 0; i < s.length; i++) keys.push(s.key(i));
      keys.forEach((k) => {
        if (LOCAL_PREFIXES.some((p) => String(k).indexOf(p) === 0)) {
          s.removeItem(k);
          removed.push(k);
        }
      });
    } catch (_) { /* ignore */ }
    return removed;
  }

  /** 校验工具的直通，界面不必再引 account.js */
  const checkAccount = (v) => A.checkAccount(v);
  const checkPassword = (v) => A.checkPassword(v);

  return {
    useStore, useProvider, currentProvider,
    signUp, signIn, signInOrSignUp: signInOrSignUpRemember, signOut, current, list,
    rememberEnabled, setRemember, lastAccount, history, rememberAccount, forgetAccount,
    clearLocal, checkAccount, checkPassword,
    KEY_REMEMBER, KEY_LAST, KEY_HISTORY
  };
});
