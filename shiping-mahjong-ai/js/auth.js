/* 石屏麻将（AI 版）· 认证层 | GPL-3.0-or-later
 *
 * 界面只跟这一层打交道，不直接碰 localStorage、账号哈希，也不直接调 SDK。
 * 所有方法都是 **async**。
 *
 * 两种模式：
 *   cloud —— 真账号（手机号验证码 / WorkBuddy 授权），身份由云端签发，进度存云端数据库
 *   guest —— 游客练习：本机账号，进度只存这个浏览器，界面上明确标注
 *
 * 模式只能由用户显式选择，任何失败都不会自动从 cloud 掉到 guest。
 *
 * Provider 接口（两种模式同一组方法，云端多三个）：
 *   signUp/signIn({ account, password, nick }) -> { ok, account } | { ok:false, error, field, code }
 *   signOut()                                  -> { ok }
 *   current()                                  -> account | null
 *   list()                                     -> [{ id, account, nick }]
 *   sendCode({ phone })                        -> { ok, ... } | { ok:false, error, code }   [cloud]
 *   verifyCode({ phone, token })               -> { ok, account, created }                   [cloud]
 *   startOAuth()                               -> 跳转到授权页（成功时不返回）              [cloud]
 *   handleCallback()                           -> { handled, account, created }             [cloud]
 *
 * code 约定：bad-account | bad-password | no-account | duplicate | no-challenge |
 *            bad-phone | bad-code | no-session | sdk-missing | not-ready | cancelled
 */
(function (root, factory) {
  const A = (root && root.HongheAccount) ||
    (typeof require === 'function' ? require('./account.js') : null);
  const Cloud = (root && root.HongheCloud) ||
    (typeof require === 'function' ? null : null);
  const api = factory(A, Cloud);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HongheAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (A, CloudRef) {
  'use strict';

  const KEY_REMEMBER = 'shiping-remember-v1';
  const KEY_LAST = 'shiping-last-account-v1';
  const KEY_HISTORY = 'shiping-login-history-v1';
  const KEY_MODE = 'shiping-auth-mode-v1';
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

  /* ---------------- 游客 Provider（本机账号） ---------------- */
  function localProvider(store) {
    const s = store || (A && A.makeStore ? A.makeStore() : null);
    if (!s) throw new Error('HongheAuth 需要 account.js 提供存储');

    return {
      id: 'guest',
      label: '游客练习',
      async signUp(input) {
        const o = input || {};
        const res = A.register(s, { account: o.account, password: o.password, nick: o.nick });
        if (!res.ok) return fail(res.error, { field: res.field, code: res.code });
        A.setSession(s, res.account.id);
        return ok({ account: Object.assign({}, res.account, { source: 'guest' }), created: true });
      },
      async signIn(input) {
        const o = input || {};
        const res = A.login(s, { account: o.account, password: o.password });
        if (!res.ok) return fail(res.error, { field: res.field, code: res.code });
        A.setSession(s, res.account.id);
        return ok({ account: Object.assign({}, res.account, { source: 'guest' }), created: false });
      },
      async signOut() {
        A.setSession(s, '');
        return ok();
      },
      async current() {
        const acc = A.currentAccount(s);
        return acc ? Object.assign({}, acc, { source: 'guest' }) : null;
      },
      async list() {
        return A.loadAccounts(s).map((a) => ({
          id: a.id, account: a.account, nick: a.nick, avatar: a.avatar, coins: a.coins
        }));
      }
    };
  }

  /* ---------------- 云端 Provider（真账号） ---------------- */
  let pendingCode = null;   // { phone, verificationId, isExistingUser } —— 发码与校验分开拿

  function cloudOf() { return CloudRef || (typeof globalThis !== 'undefined' ? globalThis.HongheCloud : null); }

  function checkPhone(raw) {
    const v = String(raw == null ? '' : raw).replace(/[\s-]/g, '');
    if (!v) return { ok: false, error: '请输入手机号' };
    if (!/^1\d{10}$/.test(v)) return { ok: false, error: '请输入正确的 11 位手机号' };
    return { ok: true, value: v };
  }

  function cloudProvider() {
    const C = cloudOf();
    if (!C) throw new Error('HongheAuth 云端模式需要 cloud.js');

    async function withProfile(session, created) {
      const res = await C.loadOrCreateProfile(session);
      if (!res.ok) return fail(res.error, { code: res.code });
      return ok({ account: res.profile, created: !!(created || res.created) });
    }

    return {
      id: 'cloud',
      label: '云端账号',

      async sendCode(input) {
        const o = input || {};
        const cp = checkPhone(o.phone);
        if (!cp.ok) return fail(cp.error, { field: 'phone', code: 'bad-phone' });
        const ready = await C.init();
        if (!ready.ok) return fail(ready.error, { code: ready.code });
        const res = await C.auth().sendOtp({ phone: cp.value });
        if (res.error) return fail(C.errorText(res.error), { code: res.error.code || 'send-failed' });
        const data = res.data || {};
        pendingCode = {
          phone: cp.value,
          verificationId: data.verificationId,
          isExistingUser: !!data.isExistingUser
        };
        return ok({ phone: cp.value, isExistingUser: pendingCode.isExistingUser });
      },

      /** 校验：只提交已发出去的码，绝不在这里重新发码（重试也不发） */
      async verifyCode(input) {
        const o = input || {};
        const cp = checkPhone(o.phone);
        if (!cp.ok) return fail(cp.error, { field: 'phone', code: 'bad-phone' });
        const token = String(o.token || '').replace(/\s/g, '');
        if (!token) return fail('请输入验证码', { field: 'code', code: 'bad-code' });
        if (!pendingCode || pendingCode.phone !== cp.value) {
          return fail('请先获取验证码', { field: 'code', code: 'no-challenge' });
        }
        const ready = await C.init();
        if (!ready.ok) return fail(ready.error, { code: ready.code });
        const res = await C.auth().verifyOtp({
          phone: pendingCode.phone,
          verificationId: pendingCode.verificationId,
          isExistingUser: pendingCode.isExistingUser,
          token
        });
        if (res.error) return fail(C.errorText(res.error), { code: res.error.code || 'bad-code', field: 'code' });
        pendingCode = null;
        const session = (res.data && (res.data.session || res.data)) || null;
        if (!session || !session.user) return fail('登录未完成，请重新获取验证码', { code: 'no-session' });
        rememberAccount(cp.value);
        return withProfile(session, false);
      },

      async startOAuth(provider) {
        const C = cloudOf();
        const ready = await C.init();
        if (!ready.ok) return fail(ready.error, { code: ready.code });
        if (typeof location === 'undefined') return fail('当前环境不支持跳转登录', { code: 'no-location' });
        const which = provider === 'wechat' ? 'wechat' : 'workbuddy';
        const back = new URL(location.href);
        back.pathname = '/';
        ['code', 'state', 'provider'].forEach((k) => back.searchParams.delete(k));
        const res = await C.auth().signInWithOAuth({ provider: which, redirectTo: back.toString() });
        if (res.error) return fail(C.errorText(res.error), { code: res.error.code || 'oauth-failed' });
        if (!res.data || !res.data.url) return fail('授权地址获取失败，请稍后重试', { code: 'oauth-failed' });
        location.assign(res.data.url);      // 同标签页跳转，PKCE 保存在本标签的 sessionStorage
        return ok({ redirecting: true, provider: which });
      },

      /** 授权回跳：只处理自己这一种 provider，清 URL 时保留 sharecode 等业务参数 */
      async handleCallback() {
        const C = cloudOf();
        if (typeof location === 'undefined') return { handled: false };
        const url = new URL(location.href);
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) return { handled: false };

        const ready = await C.init();
        if (!ready.ok) return Object.assign(fail(ready.error, { code: ready.code }), { handled: true });
        const auth = C.auth();
        const provider = url.searchParams.get('provider');
        if (provider !== 'workbuddy' && provider !== 'wechat') {
          return Object.assign(fail('授权回调缺少有效的登录方式，请重新登录', { code: 'bad-callback' }), { handled: true });
        }
        const handler = provider === 'workbuddy' ? auth.handleWorkBuddyCallback : auth.handleWechatWebCallback;
        if (typeof handler !== 'function') {
          return Object.assign(fail('当前云端 SDK 不支持这种登录方式，请改用手机号登录', { code: 'sdk-missing' }), { handled: true });
        }
        const res = await handler.call(auth);
        if (res.error) {
          return Object.assign(fail(C.errorText(res.error), { code: res.error.code || 'callback-failed' }), { handled: true });
        }
        const session = res.data || null;
        if (!session) return { handled: false };

        ['code', 'state', 'provider'].forEach((k) => url.searchParams.delete(k));
        try {
          history.replaceState(null, '', url.pathname + url.search + url.hash);
        } catch (_) { /* ignore */ }
        const profiled = await withProfile(session, false);
        return Object.assign({ handled: true }, profiled);
      },

      async signOut() {
        const C = cloudOf();
        pendingCode = null;
        if (!C) return ok();
        const res = await C.signOut();
        return res.ok ? ok() : fail(res.error, { code: res.code });
      },

      async current() {
        const C = cloudOf();
        if (!C) return null;
        const ready = await C.init();
        if (!ready.ok) return null;
        const res = await C.getSession();
        if (!res.ok || !res.session) return null;
        const prof = await C.loadOrCreateProfile(res.session);
        if (!prof.ok) return null;
        return prof.profile;
      },

      async list() {
        return [];
      }
    };
  }

  /* ---------------- 门面 ---------------- */
  let provider = localProvider();
  let store = null;
  let mode = 'guest';
  let cloudBound = false;

  function useStore(next) {
    store = next || null;
    if (mode === 'guest') provider = localProvider(store);
    return provider;
  }
  function useProvider(next) {
    if (!next) return provider;
    provider = next;
    return provider;
  }
  function currentProvider() { return provider; }

  /** 切到云端模式（真账号）。传 false 回到游客模式。 */
  function useCloud(on) {
    if (on) {
      if (!cloudBound) { provider = cloudProvider(); cloudBound = true; }
      mode = 'cloud';
    } else {
      provider = localProvider(store);
      mode = 'guest';
    }
    write(storeOf(), KEY_MODE, mode);
    return mode;
  }
  function currentMode() { return mode; }

  /** 游客模式：账号不存在时自动建号（一次输完就进去） */
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
    return v === null ? true : v !== '0';
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

  /* ---------------- 门面方法 ---------------- */
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
  async function signOut() { return provider.signOut(); }
  function current() { return provider.current(); }
  function list() { return provider.list ? provider.list() : Promise.resolve([]); }

  async function sendCode(input) {
    if (mode !== 'cloud') return fail('当前是游客模式，不需要验证码', { code: 'guest-mode' });
    return provider.sendCode(input || {});
  }
  async function verifyCode(input) {
    if (mode !== 'cloud') return fail('当前是游客模式', { code: 'guest-mode' });
    const res = await provider.verifyCode(input || {});
    if (res.ok) rememberAccount(res.account.account);
    return res;
  }
  async function startOAuth(provider) {
    if (mode !== 'cloud') return fail('当前是游客模式', { code: 'guest-mode' });
    return provider.startOAuth(provider);
  }
  async function handleCallback() {
    if (mode !== 'cloud') {
      const C = cloudOf();
      return C ? cloudProvider().handleCallback() : { handled: false };
    }
    return provider.handleCallback();
  }
  function pending() { return pendingCode ? Object.assign({}, pendingCode) : null; }
  function clearPending() { pendingCode = null; }

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

  const checkAccount = (v) => A.checkAccount(v);
  const checkPassword = (v) => A.checkPassword(v);

  return {
    useStore, useProvider, currentProvider, useCloud, currentMode,
    signUp, signIn, signInOrSignUp: signInOrSignUpRemember, signOut, current, list,
    sendCode, verifyCode, startOAuth, handleCallback, pending, clearPending,
    checkAccount, checkPassword, checkPhone,
    rememberEnabled, setRemember, lastAccount, history, rememberAccount, forgetAccount,
    clearLocal,
    KEY_REMEMBER, KEY_LAST, KEY_HISTORY, KEY_MODE
  };
});
