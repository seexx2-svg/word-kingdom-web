/* 登录专项浏览器测试：真实点击、真实 localStorage、真实刷新
 * 运行：node --test tests/login.browser.test.cjs
 *
 * 目标只有一个：**用户输一次就能进去**。
 * 所以这里不调调试接口建号，全部走界面上的输入框和按钮，
 * 并且覆盖「中文账号」「手机号」「密码错」「退出」「刷新后还在」这些真实路径。
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

/** 新页面 + 清空本机存档，停在启动页 */
async function freshPage(viewport) {
  const page = await newPage(browser, srv.origin, viewport);
  await page.evaluate(() => window.__shipingMahjongResetProgress());
  await page.waitForTimeout(100);
  return page;
}

/** 打开登录弹窗 */
async function openLogin(page) {
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
}

/** 在弹窗里填账号密码并点「登录」（主路径：没有账号就自动建） */
async function loginByClick(page, account, password) {
  await page.fill('#login-account', account);
  await page.fill('#login-password', password);
  await page.click('#do-login');
}

/** 关掉见面礼弹窗 → 跳过赛季页 → 到主界面 */
async function passSeason(page) {
  if (await page.evaluate(() => !document.getElementById('reward-modal').classList.contains('hidden'))) {
    await page.click('#reward-ok');
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });
  await page.click('#screen-season');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'inherit', null, { timeout: 5000 });
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 5000 });
}

test('登录弹窗：默认勾选记住账号，账号框为空，密码是隐藏的', async () => {
  const page = await freshPage();
  await openLogin(page);
  const f = await form(page);
  assert.equal(f.open, true);
  assert.equal(f.remember, true, '记住账号默认打开');
  assert.equal(f.account, '');
  assert.equal(f.passwordType, 'password');
  assert.equal(f.historyCount, 0, '第一次来没有历史账号');
  assert.deepEqual(page.__errors, []);

  // 两个输入框都能聚焦（有些样式问题会让输入框点不动）
  await page.click('#login-account');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'login-account');
  await page.click('#login-password');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'login-password');
  await page.close();
});

test('登录弹窗：空账号、空密码、密码过短都有明确提示且不跳转', async () => {
  const page = await freshPage();
  await openLogin(page);

  await page.click('#do-login');
  assert.equal(await text(page, '#login-tip'), '请输入账号');

  await page.fill('#login-account', '张三');
  await page.click('#do-login');
  assert.equal(await text(page, '#login-tip'), '请输入密码');

  await page.fill('#login-password', '12');
  await page.click('#do-login');
  assert.equal(await text(page, '#login-tip'), '密码至少 4 位');

  assert.equal((await shell(page)).screen, 'splash', '校验失败时不能离开启动页');
  assert.equal((await shell(page)).account, null);
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test('中文账号：输一个昵称加密码，点一次登录就进游戏', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '张三', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });

  const s = await shell(page);
  assert.equal(s.account.account, '张三', '中文账号必须能用');
  assert.equal(s.account.coins, 5000 + 4000, '新号含 4000 见面礼');
  assert.equal((await form(page)).open, false, '登录成功要关掉弹窗');
  await page.close();
});

test('手机号账号：11 位手机号同样一次进入', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '13800138000', 'abcd');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });
  assert.equal((await shell(page)).account.account, '13800138000');
  await page.close();
});

test('密码显隐：点「显示」变明文，再点变回密文', async () => {
  const page = await freshPage();
  await openLogin(page);
  await page.fill('#login-password', 'abcd1234');
  assert.equal((await form(page)).passwordType, 'password');
  await page.click('#login-eye');
  assert.equal((await form(page)).passwordType, 'text');
  assert.equal(await text(page, '#login-eye'), '隐藏');
  await page.click('#login-eye');
  assert.equal((await form(page)).passwordType, 'password');
  await page.close();
});

test('密码错误：老账号输错密码只提示，不会被偷偷改成新号', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '张三', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });

  // 退出后故意输错
  await page.evaluate(() => window.__shipingMahjongLogout());
  await openLogin(page);
  await loginByClick(page, '张三', 'wrong-pw');
  await page.waitForTimeout(200);
  assert.equal(await text(page, '#login-tip'), '密码不正确');
  assert.equal((await shell(page)).screen, 'splash');
  assert.equal((await authInfo(page)).history.includes('张三'), true, '失败也要留在历史里方便重试');
  await page.close();
});

test('记住账号：退出后重开弹窗自动回填，历史列表可点选', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '张三', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });

  await page.evaluate(() => window.__shipingMahjongLogout());
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  assert.equal((await form(page)).account, '张三', '记住账号要把账号回填');
  assert.equal((await form(page)).historyCount, 1);

  // 点历史列表里的账号 → 填进输入框
  await page.click('#login-history button');
  assert.equal((await form(page)).account, '张三');
  await page.close();
});

test('关掉记住账号：退出后不再回填', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '张三', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });

  await page.evaluate(() => window.__shipingMahjongLogout());
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  await page.uncheck('#login-remember');
  await page.evaluate(() => window.__shipingMahjongLogout());
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  assert.equal((await form(page)).account, '', '关掉记住后不应回填');
  assert.equal((await form(page)).remember, false, '勾选状态要记住');
  await page.close();
});

test('会话保持：刷新页面直接进游戏，不用再登录', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '张三', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });
  await passSeason(page);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__shipingMahjongShell === 'function');
  await page.waitForTimeout(200);
  const s = await shell(page);
  assert.equal(s.account.account, '张三', '刷新后仍是同一个号');
  assert.equal(s.screen, 'home', '看过赛季后刷新应直接到主界面');
  await page.close();
});

test('账号浮层：点头像打开，退出登录回到启动页', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '张三', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });
  await passSeason(page);

  assert.equal(await page.evaluate(() => window.__shipingMahjongAccountMenu()), true, '头像可点开账号浮层');
  assert.equal(await text(page, '#am-nick'), '张三');
  assert.equal(await text(page, '#am-account'), '账号 张三');

  await page.click('#am-logout');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'splash', null, { timeout: 5000 });
  assert.equal((await shell(page)).account, null);
  assert.equal(await page.evaluate(() => document.getElementById('account-menu').classList.contains('hidden')), true, '退出后浮层要收起');
  await page.close();
});

test('切换账号：退出后立刻弹登录框，账号框是空的', async () => {
  const page = await freshPage();
  await openLogin(page);
  await loginByClick(page, '张三', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });
  await passSeason(page);

  await page.evaluate(() => window.__shipingMahjongAccountMenu(true));
  await page.click('#am-switch');
  await page.waitForSelector('#login-modal:not(.hidden)');
  const f = await form(page);
  assert.equal(f.account, '', '切换账号应清空输入框');
  assert.equal(f.open, true);

  await loginByClick(page, '李四', '5678');
  await page.waitForFunction(() => {
    const s = window.__shipingMahjongShell();
    return s.account && s.account.account === '李四';
  }, null, { timeout: 5000 });
  const s = await shell(page);
  assert.equal(s.account.account, '李四');
  assert.equal(s.screen, 'home', '看过赛季动画的浏览器换号后直接进主界面');
  assert.equal((await authInfo(page)).history.slice(0, 2).join(','), '李四,张三', '两个号都在历史里');
  await page.close();
});

test('关闭弹窗：× 和 Esc 都能退出登录框，不会卡在半透明遮罩上', async () => {
  const page = await freshPage();
  await openLogin(page);
  await page.click('#login-close');
  assert.equal((await form(page)).open, false);

  await openLogin(page);
  await page.keyboard.press('Escape');
  assert.equal((await form(page)).open, false);

  // 遮罩关掉后启动页按钮还能点（没有被透明层挡住）
  await openLogin(page);
  await page.click('#login-close');
  await page.click('#btn-phone');
  assert.equal((await form(page)).open, true);
  await page.close();
});

test('企业微信按钮走不通时给出明确提示，并仍然打开账号登录', async () => {
  const page = await freshPage();
  await page.click('#btn-wechat');
  assert.equal(await page.evaluate(() => !document.getElementById('login-modal').classList.contains('hidden')), true);
  assert.match(await page.evaluate(() => {
    const t = document.querySelector('.toast');
    return t ? t.textContent : '';
  }), /微信登录还没接入/);
  await page.close();
});

test('手机端：登录弹窗不溢出、按钮可点', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await openLogin(page);
  const box = await page.evaluate(() => {
    const card = document.querySelector('#login-modal .login-card').getBoundingClientRect();
    return { w: card.width, left: card.left, right: card.right, vw: window.innerWidth, vh: window.innerHeight, bottom: card.bottom };
  });
  assert.ok(box.right <= box.vw + 1, '弹窗右边界不能超出视口：' + JSON.stringify(box));
  assert.ok(box.left >= -1, '弹窗左边界不能超出视口');
  assert.ok(box.bottom <= box.vh + 1, '弹窗底部不能超出视口：' + JSON.stringify(box));

  await loginByClick(page, '手机玩家', '1234');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });
  assert.equal((await shell(page)).account.account, '手机玩家');
  assert.deepEqual(page.__errors, []);
  await page.close();
});
