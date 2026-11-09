/* 登录专项浏览器测试：云端手机验证码 / WorkBuddy 授权 / 游客模式
 *
 * 运行：node --test tests/login.browser.test.cjs
 *
 * 这里刻意不发出任何真实短信，也不做真实授权跳转：
 * - 号码不合法的分支必须在本地就被拦住（断言「没有请求」）
 * - 没发码就提交，必须在本地被拦住（断言「没有请求」）
 * - 真机登录（收短信 / 扫码）属于使用者验证，见 tests/cloud-live.cjs 与 README
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, launch, newPage } = require('./browser-lib.cjs');

let srv, browser;
test.before(async () => { srv = await startServer(); browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const shell = (page) => page.evaluate(() => window.__shipingMahjongShell());
const form = (page) => page.evaluate(() => window.__shipingMahjongLoginForm());
const authInfo = (page) => page.evaluate(() => window.__shipingMahjongAuth());
const text = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);
const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!el && !el.classList.contains('hidden');
}, sel);

/** 记录打过 /\.cloud\/ 的请求，用来证明「本地就该拦住的分支确实没有发请求」 */
function watchCloud(page) {
  const hits = [];
  page.on('request', (r) => { if (/\/\.cloud\//.test(r.url())) hits.push(r.url()); });
  return hits;
}

async function freshPage(viewport, opts) {
  const o = opts || {};
  const page = await newPage(browser, srv.origin, viewport);
  if (o.blockCdn) {
    await page.route((u) => u.href.includes('workbuddy-cloud-sdk'), (route) => route.abort());
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__shipingMahjongDebug === 'function');
  }
  await page.evaluate(() => window.__shipingMahjongResetProgress());
  await page.waitForTimeout(120);
  return page;
}

async function openLogin(page) {
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  /* SDK 是从 CDN 拉的，快慢看运气：等云端状态落定再操作，
   * 否则按钮还停在 disabled（或说明还没写成"不可用"）就点，会白等 30 秒。
   * 两种落定都算：可用 → 按钮解锁；不可用 → 说明框带上 warn。 */
  await page.waitForFunction(() => {
    const b = document.querySelector('#do-verify');
    const note = document.querySelector('#login-cloud-note');
    return (b && !b.disabled) || (note && note.classList.contains('warn'));
  }, null, { timeout: 15000 });
}

test('启动页：微信 / 手机号登录 / 游客 三个入口都在，且不报错', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  assert.equal((await shell(page)).screen, 'splash');
  assert.equal(await page.evaluate(() => !!document.querySelector('#btn-wechat')), true);
  assert.equal(await page.evaluate(() => !!document.querySelector('#btn-phone')), true);
  assert.deepEqual(page.__errors, [], '启动不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('登录弹窗：手机号 + 验证码 + 两个备选入口，说明文案讲清进度存哪', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await openLogin(page);
  const f = await form(page);
  assert.equal(f.open, true);
  assert.match(f.note, /云端/, '说明里要写清楚进度存在云端');
  assert.equal(f.sendText, '获取验证码');
  assert.equal(f.verifyDisabled, false);
  assert.equal(f.guestDisabled, false, '游客入口不受云端状态影响');
  await page.close();
});

test('手机号校验：空 / 少一位 / 非数字，全部在本地拦下且不发请求', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  const hits = watchCloud(page);
  await openLogin(page);

  await page.click('#do-send-code');
  assert.match(await text(page, '#login-tip'), /请输入手机号/);

  await page.fill('#login-phone', '1380000111');
  await page.click('#do-send-code');
  assert.match(await text(page, '#login-tip'), /11 位/);

  await page.fill('#login-phone', 'abcdefghijk');
  await page.click('#do-send-code');
  assert.match(await text(page, '#login-tip'), /11 位/);

  assert.equal(hits.filter((u) => /verification/.test(u)).length, 0, '号码不合法时一个验证码请求都不该发出');
  assert.equal((await form(page)).cooldown, 0, '没发成功就不该开始倒计时');
  await page.close();
});

test('没发码就提交：提示先获取验证码，且不调用校验接口', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  const hits = watchCloud(page);
  await openLogin(page);
  await page.fill('#login-phone', '13800001111');
  await page.fill('#login-code', '123456');
  await page.click('#do-verify');
  await page.waitForTimeout(200);
  assert.match(await text(page, '#login-tip'), /请先获取验证码/);
  assert.equal(hits.filter((u) => /verify|signin|signup/.test(u)).length, 0, '不该绕过发码直接校验');
  assert.equal((await shell(page)).screen, 'splash', '没登进去就不能跳走');
  await page.close();
});

test('验证码为空：提示请输入验证码', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await openLogin(page);
  await page.fill('#login-phone', '13800001111');
  await page.click('#do-verify');
  assert.match(await text(page, '#login-tip'), /请输入验证码/);
  await page.close();
});

test('游客进入：一次点击进赛季页，5,000 起始 + 4,000 见面礼', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await openLogin(page);
  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('#reward-modal').classList.contains('hidden'), null, { timeout: 5000 });
  assert.match(await text(page, '#reward-amount'), /4,000/);
  await page.click('#reward-ok');
  const s = await shell(page);
  assert.equal(s.account.source, 'guest', '游客账号要标明来源');
  assert.equal(s.account.coins, 9000);
  assert.equal(s.auth.mode, 'guest');
  await page.close();
});

test('游客二次进入：同一个设备还是原来那个号，见面礼不重复发', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await openLogin(page);
  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 8000 });
  const first = (await shell(page)).account;
  await page.click('#reward-ok');
  await page.evaluate(() => window.__shipingMahjongLogout());
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'splash', null, { timeout: 5000 });

  await openLogin(page);
  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen !== 'splash', null, { timeout: 8000 });
  const second = (await shell(page)).account;
  assert.equal(second.account, first.account, '还是原来那个游客号');
  assert.equal(second.coins, 9000, '见面礼只发一次');
  assert.equal(await visible(page, '#reward-modal'), false, '不该再弹一次见面礼');
  await page.close();
});

test('退出登录：账号清空、回到启动页、赛季状态跟着账号走', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await openLogin(page);
  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 8000 });
  await page.click('#reward-ok');
  await page.evaluate(() => window.__shipingMahjongLogout());
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'splash', null, { timeout: 5000 });
  const s = await shell(page);
  assert.equal(s.account, null);
  await page.close();
});

test('账号浮层：写明云端/游客身份，改昵称能存下来', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await openLogin(page);
  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 8000 });
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 5000 });

  await page.click('#home-player');
  await page.waitForSelector('#account-menu:not(.hidden)');
  assert.match(await text(page, '#am-account'), /游客/, '游客要标出来，不能让人以为是云端号');
  assert.match(await text(page, '#am-cloud'), /只存本机/);

  await page.click('#am-rename');
  await page.fill('#am-nick-input', '石屏老乡');
  await page.click('#am-nick-save');
  await page.waitForTimeout(200);
  assert.equal((await shell(page)).account.nick, '石屏老乡');
  assert.equal(await text(page, '#home-nick'), '石屏老乡');
  await page.close();
});

test('云端不可用：说明里给出原因、验证码按钮禁用，但游客照样能进', async () => {
  const page = await freshPage({ width: 1440, height: 900 }, { blockCdn: true });
  const st = await page.evaluate(() => window.__shipingMahjongCloud());
  assert.equal(st.status.ready, false, 'SDK 没加载成功就不能报告为可用');
  assert.match(st.status.error, /SDK/, '要说明是 SDK 没加载');
  assert.equal(st.probe, null, '云端不可用时不该有数据面探针结果');

  await openLogin(page);
  const f = await form(page);
  assert.match(f.note, /云端暂不可用/);
  assert.equal(f.verifyDisabled, true, '手机号登录按钮应禁用');
  assert.equal(f.guestDisabled, false, '游客入口必须仍然可用');

  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 8000 });
  assert.equal((await shell(page)).account.source, 'guest');
  await page.close();
});

test('手机 390×844：登录弹窗完整在屏幕内，按钮都点得到', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await openLogin(page);
  const box = await page.evaluate(() => {
    const card = document.querySelector('#login-modal .login-card');
    const r = card.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
  });
  assert.ok(box.left >= -1 && box.right <= box.vw + 1, '登录卡不能超出左右边界：' + JSON.stringify(box));
  assert.ok(box.top >= -1 && box.bottom <= box.vh + 1, '登录卡不能超出上下边界：' + JSON.stringify(box));

  const clickable = await page.evaluate(() => {
    const ids = ['do-send-code', 'do-verify', 'do-workbuddy', 'do-guest'];
    return ids.map((id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { id, hit: !!top && (top === el || el.contains(top)) };
    });
  });
  clickable.forEach((c) => assert.equal(c.hit, true, c.id + ' 应能被点中'));
  assert.deepEqual(page.__errors, [], '手机端不应报错：' + page.__errors.join(' | '));
  await page.close();
});
