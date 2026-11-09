/* 界面截图脚本：一次跑完 启动页 → 登录 → 见面礼 → 赛季 → 继承 → 主界面 → 场次 → 对局 → 结算 → 签到 → 回归
 * 用法：node tests/screenshots.cjs
 * 输出：docs/screenshots/shell-*.jpg
 */
const path = require('node:path');
const { startServer, launch, newPage } = require('./browser-lib.cjs');

const OUT = path.resolve(__dirname, '..', 'docs', 'screenshots');
const DESK = { width: 1440, height: 900 };
const MOB = { width: 390, height: 844 };

(async () => {
  const srv = await startServer();
  const browser = await launch();
  const desk = await newPage(browser, srv.origin, DESK);
  const shot = async (name, page) => {
    await (page || desk).screenshot({ path: path.join(OUT, name) });
    console.log('shot', name);
  };
  const hold = (ms) => desk.waitForTimeout(ms || 320);

  await desk.evaluate(() => window.__shipingMahjongResetProgress());
  await hold(400);
  await shot('shell-01-splash.jpg');

  await desk.evaluate(() => document.getElementById('btn-phone').click());
  await hold(360);
  await shot('shell-02-login.jpg');

  await desk.evaluate(async () => {
    document.getElementById('login-modal').classList.add('hidden');
    await window.__shipingMahjongRegister('honghe888', 'abcd', '小双州黯');
  });
  await hold(500);
  await shot('shell-03-reward.jpg');

  await desk.evaluate(() => document.getElementById('reward-ok').click());
  await hold(320);
  await shot('shell-04-season.jpg');

  await desk.evaluate(() => document.getElementById('screen-season').click());
  await hold(400);
  await shot('shell-05-inherit.jpg');

  await desk.evaluate(() => document.getElementById('screen-inherit').click());
  await hold(480);
  await shot('shell-06-home.jpg');

  await desk.evaluate(() => window.__shipingMahjongOpenHall());
  await hold(400);
  await shot('shell-07-hall.jpg');

  await desk.evaluate(() => {
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0.12);
  });
  await desk.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 30000 });
  await hold(400);
  await shot('shell-08-table.jpg');

  await desk.evaluate(() => window.__shipingMahjongForceWin());
  await desk.waitForFunction(() => !document.getElementById('result-modal').classList.contains('hidden'), null, { timeout: 8000 });
  await hold(420);
  await shot('shell-09-result.jpg');

  await desk.evaluate(() => {
    document.getElementById('result-modal').classList.add('hidden');
    window.__shipingMahjongEnterHome();
    window.__shipingMahjongOpenSignin();
  });
  await hold(400);
  await shot('shell-10-signin.jpg');

  await desk.evaluate(() => {
    document.getElementById('signin-modal').classList.add('hidden');
    window.__shipingMahjongOpenBack();
  });
  await hold(340);
  await shot('shell-11-back.jpg');

  /* ---- 登录细节：校验提示 + 账号浮层 ---- */
  await desk.evaluate(() => {
    document.getElementById('back-modal').classList.add('hidden');
    window.__shipingMahjongResetProgress();
  });
  await hold(320);
  await desk.evaluate(() => {
    document.getElementById('btn-phone').click();
    document.getElementById('login-phone').value = '1380000';
    document.getElementById('do-send-code').click();
  });
  await hold(480);
  await shot('shell-16-login-error.jpg');

  await desk.evaluate(async () => {
    document.getElementById('login-modal').classList.add('hidden');
    await window.__shipingMahjongRegister('honghe888', 'abcd', '小双州黯', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongAccountMenu(true);
  });
  await hold(420);
  await shot('shell-17-account-menu.jpg');

  /* ---- 手机竖屏 ---- */
  const mob = await browser.newPage({ viewport: MOB, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await mob.goto(srv.origin + '/?debug=1', { waitUntil: 'load' });
  await mob.waitForFunction(() => typeof window.__shipingMahjongDebug === 'function');
  await mob.evaluate(async () => {
    window.__shipingMahjongResetProgress();
    await window.__shipingMahjongRegister('honghe888', 'abcd', '小双州黯', true);
    window.__shipingMahjongSkipSeason();
  });
  await mob.waitForTimeout(420);
  await shot('shell-12-home-mobile.jpg', mob);

  await mob.evaluate(() => window.__shipingMahjongOpenHall());
  await mob.waitForTimeout(340);
  await shot('shell-13-hall-mobile.jpg', mob);

  await mob.evaluate(() => {
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0.12);
  });
  await mob.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 30000 });
  await mob.waitForTimeout(400);
  await shot('shell-14-table-mobile.jpg', mob);

  await mob.evaluate(() => window.__shipingMahjongForceWin());
  await mob.waitForFunction(() => !document.getElementById('result-modal').classList.contains('hidden'), null, { timeout: 8000 });
  await mob.waitForTimeout(420);
  await shot('shell-15-result-mobile.jpg', mob);

  await mob.evaluate(() => {
    document.getElementById('result-modal').classList.add('hidden');
    window.__shipingMahjongResetProgress();
  });
  await mob.waitForTimeout(260);
  await mob.evaluate(() => document.getElementById('btn-phone').click());
  await mob.waitForTimeout(320);
  await shot('shell-18-login-mobile.jpg', mob);

  const errs = [].concat(desk.__errors || [], mob.__errors || []);
  console.log('页面错误：', errs.length ? errs : '无');
  await browser.close();
  await srv.close();
})();
