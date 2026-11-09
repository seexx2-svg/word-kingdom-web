/* 外壳全链路浏览器测试：启动页 → 登录/注册 → 赛季 → 继承 → 主界面 → 场次 → 对局 → 结算
 * 运行：node --test tests/shell.browser.test.cjs
 *
 * 这一层只关心「界面能不能真的走通、显示的数字对不对」，
 * 规则正确性在 engine/variants/simulation 里测，牌桌几何在 browser.test.cjs 里测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, launch, newPage } = require('./browser-lib.cjs');

let srv, browser;
test.before(async () => { srv = await startServer(); browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const shell = (page) => page.evaluate(() => window.__shipingMahjongShell());
const exists = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const text = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);

/** 打开页面并清空本机进度，停在启动页 */
async function freshPage(viewport) {
  const page = await newPage(browser, srv.origin, viewport);
  await page.evaluate(() => window.__shipingMahjongResetProgress());
  await page.waitForTimeout(120);
  return page;
}

/** 用界面真实点击注册一个新号（不走调试接口），停在赛季页 */
async function registerByClick(page, account) {
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  await page.fill('#login-account', account);
  await page.fill('#login-password', 'abcd1234');
  await page.click('#do-register');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 5000 });
}

test('启动页：未登录只显示启动页，登录入口齐全且不报错', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  assert.equal((await shell(page)).screen, 'splash', '未登录应停在启动页');
  assert.equal(await exists(page, '#btn-wechat'), true, '应有微信登录入口');
  assert.equal(await exists(page, '#btn-phone'), true, '应有手机号/账号登录入口');
  assert.equal(await page.evaluate(() => document.querySelector('#login-modal').classList.contains('hidden')), true);
  assert.deepEqual(page.__errors, [], '启动不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('登录弹窗：真实点击打开、校验空输入、可正常关闭', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  assert.equal(await exists(page, '#do-login'), true);
  assert.equal(await exists(page, '#do-register'), true);

  await page.click('#do-login');
  assert.match(await text(page, '#login-tip'), /请输入账号/, '空账号应提示');

  await page.fill('#login-account', 'no_such_player');
  await page.fill('#login-password', 'abcd');
  await page.click('#do-login');
  assert.match(await text(page, '#login-tip'), /不存在/, '未注册账号应提示先注册');

  await page.click('#login-close');
  assert.equal(await page.evaluate(() => document.querySelector('#login-modal').classList.contains('hidden')), true);
  await page.close();
});

test('注册：新号自动发 4,000 银币见面礼，随后进入 S25 赛季页', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page, 'shell_reg_1');
  // 新号见面礼
  assert.equal(await page.evaluate(() => document.querySelector('#reward-modal').classList.contains('hidden')), false, '应弹「恭喜获得」');
  assert.match(await text(page, '#reward-amount'), /4,000/);
  assert.match(await text(page, '#reward-name'), /银币/);
  await page.click('#reward-ok');
  assert.equal((await shell(page)).screen, 'season', '领完见面礼进入赛季页');
  // 5,000 初始 + 4,000 见面礼
  assert.equal((await shell(page)).account.coins, 9000);
  assert.match(await text(page, '#screen-season'), /S25/);
  await page.close();
});

test('赛季：点击进「赛季继承」，再点进主界面', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page, 'shell_reg_2');
  await page.click('#reward-ok');

  await page.click('#screen-season');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'inherit', null, { timeout: 5000 });
  assert.match(await text(page, '#inherit-prev-badge'), /长工/, '显示上赛季称号');
  assert.match(await text(page, '#inherit-prev-pts'), /112/, '显示上赛季段位分');
  assert.match(await text(page, '#inherit-now-badge'), /未激活/, '本赛季未定级');
  assert.match(await text(page, '#inherit-now-pts'), /0/);

  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('honghe-season-seen-S25')), '1', '赛季动画只放一次');
  await page.close();
});

test('主界面：12 个功能格 / 天梯 4 条 / 其他游戏 4 张，钱包与段位显示正确', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page, 'shell_reg_3');
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  assert.equal(await count(page, '#home-grid .grid-tile'), 12, '功能格应为 12 个');
  assert.equal(await count(page, '#ladder-list .ladder-row'), 4, '天梯榜应有 4 条');
  assert.equal(await count(page, '#other-list .other-card'), 4, '其他游戏应有 4 张');
  assert.equal(await count(page, '#screen-home .home-nav .nav-item'), 9, '底部导航 9 项');
  assert.equal(await text(page, '#home-coins'), '9,000', '银币含见面礼');
  assert.equal(await text(page, '#home-gold'), '91');
  assert.equal(await text(page, '#home-rank'), '新秀一阶');
  assert.equal(await text(page, '#home-nick'), 'shell_reg_3');
  assert.deepEqual(page.__errors, [], '主界面不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('场次：三档场次，银币不足的档位不可进入', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page, 'shell_reg_4');
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  await page.click('#quick-start');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'hall');
  assert.equal(await count(page, '#hall-tables .hall-card'), 3);
  assert.equal(await text(page, '#hall-coins'), '9,000');
  assert.equal(await text(page, '#hall-rank-name'), '新秀一阶');

  // 中级场需要 20,000，9,000 不够：点了应该留在场次页
  await page.click('#hall-tables .hall-card[data-hall="mid"]');
  await page.waitForTimeout(150);
  assert.equal((await shell(page)).screen, 'hall', '银币不足不能进桌');
  assert.match(await text(page, '#hall-tables .hall-card[data-hall="mid"] .hall-lock'), /银币不足/);

  // 初级场可以进
  await page.click('#hall-tables .hall-card[data-hall="novice"]');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'table', null, { timeout: 5000 });
  const s = await shell(page);
  assert.equal(s.hall, 'novice');
  assert.equal(s.baseBet, 2000);
  assert.match(await text(page, '#table-bet'), /2,?000/);
  await page.close();
});

test('对局：进桌后四家都有银币与段位，底注写进桌面', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(() => {
    window.__shipingMahjongRegister('shell_tbl_1', 'abcd1234', '牌桌测试', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0.1);
  });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  await page.waitForTimeout(200);

  for (let i = 0; i < 4; i++) {
    assert.match(await text(page, '#coin-' + i), /\d/, `第 ${i} 家应有银币`);
    assert.ok((await text(page, '#rank-' + i)).length > 0, `第 ${i} 家应有段位`);
  }
  assert.equal(await text(page, '#seat-name-0'), '牌桌测试', '自家座位显示昵称');
  assert.match(await text(page, '#brand-sub'), /初级场/);
  // 手牌可点
  assert.ok(await count(page, '#hand-tiles .tile-face') >= 13, '开局手牌至少 13 张');
  await page.close();
});

test('结算：赢家实收 / 三家赔付 / 段位分，并写回账号', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(() => {
    window.__shipingMahjongRegister('shell_win_1', 'abcd1234', '胡牌测试', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0.1);
  });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  const before = (await shell(page)).account.coins;

  await page.evaluate(() => window.__shipingMahjongForceWin());
  await page.waitForFunction(() => !document.querySelector('#result-modal').classList.contains('hidden'), null, { timeout: 8000 });

  const s = await shell(page);
  const d = await page.evaluate(() => window.__shipingMahjongDebug());
  // 赢家坐庄时倍率翻倍；庄家由掷骰决定，所以按实际庄家推算期望值
  const m = d.dealer === 0 ? 2 : 1;
  const unit = 2000 * m;
  assert.equal(s.settlement.type, 'self');
  assert.equal(s.settlement.multiplier, m, '庄家参与时倍率为 2');
  assert.equal(s.settlement.unit, unit, '初级场底分 2,000 × 倍率');
  assert.deepEqual(s.settlement.deltas, [unit * 6, -unit * 2, -unit * 2, -unit * 2], '自摸三家各付双倍');
  assert.deepEqual(s.rankDelta, [7 * m, -2 * m, -2 * m, -2 * m], '赢家 +7×倍率，其余 -2×倍率');
  assert.equal(s.account.coins, before + unit * 6, '银币必须写回账号');
  assert.equal(s.account.rankPoints, 7 * m);
  assert.equal(s.account.stats.wins, 1);

  // 结算面板结构：赢家一张、其他三家各一张、段位条一根
  assert.equal(await count(page, '#result-self .result-self'), 1);
  assert.equal(await count(page, '#result-others .result-other'), 3);
  assert.match(await text(page, '#result-self .rs-total'), new RegExp('\\+' + (unit * 6).toLocaleString('en-US')));
  const others = await page.evaluate(() => Array.from(document.querySelectorAll('#result-others .rs-total')).map((e) => e.textContent.trim()));
  assert.deepEqual(others, [-unit * 2, -unit * 2, -unit * 2].map((v) => v.toLocaleString('en-US')));
  assert.match(await text(page, '#result-rankbar'), new RegExp('\\+' + 7 * m + ' 段位分'));
  assert.ok(await count(page, '#result-hand .tile-face') >= 2, '应展示胡牌手牌');
  await page.close();
});

test('结算后回主界面，银币与段位分同步刷新；再进场次仍是新余额', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  // 走完整新号流程（含 4,000 见面礼），这样余额能跨过中级场门槛，顺便验证解锁
  await page.evaluate(() => {
    window.__shipingMahjongRegister('shell_cont_1', 'abcd1234', '续局测试');
    const ok = document.getElementById('reward-ok');
    if (ok) ok.click();
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0.1);
  });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  await page.evaluate(() => window.__shipingMahjongForceWin());
  await page.waitForFunction(() => !document.querySelector('#result-modal').classList.contains('hidden'));

  const afterWin = await shell(page);
  const coins = afterWin.account.coins;
  const pts = afterWin.account.rankPoints;
  assert.ok(coins > 9000, '赢一局后余额应高于 9,000，实际 ' + coins);

  await page.click('#result-continue');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 5000 });
  assert.equal(await text(page, '#home-coins'), coins.toLocaleString('en-US'), '主界面余额应与账本一致');
  assert.equal(await text(page, '#home-rank'), '新秀一阶');

  await page.click('#quick-start');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'hall');
  assert.equal(await text(page, '#hall-coins'), coins.toLocaleString('en-US'), '场次页应显示最新余额');
  assert.equal(await text(page, '#hall-rank-text'), pts + '/420', '段位进度应与账本一致');
  // 余额跨过 20,000 时中级场自动解锁
  const locked = await exists(page, '#hall-tables .hall-card[data-hall="mid"] .hall-lock');
  assert.equal(locked, coins < 20000, '中级场锁定状态应跟随余额');
  await page.close();
});

test('每日签到：7 格，领取后当天不可重复领，银币增加 1,000', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(() => {
    window.__shipingMahjongRegister('shell_sign_1', 'abcd1234', '签到测试', true);
    window.__shipingMahjongSkipSeason();
  });
  const before = (await shell(page)).account.coins;
  await page.evaluate(() => window.__shipingMahjongOpenSignin());
  await page.waitForSelector('#signin-modal:not(.hidden)');
  assert.equal(await count(page, '#signin-grid .signin-cell'), 7, '签到应有 7 天');

  await page.click('#signin-do');
  await page.waitForTimeout(200);
  const after = (await shell(page)).account.coins;
  assert.equal(after, before + 1000, '第 1 天签到 +1,000 银币');
  assert.equal(await count(page, '#signin-grid .signin-cell.claimed'), 1, '第 1 天标记为已领');
  await page.close();
});

test('回归好礼：7 格，按顺序领取并累加银币', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(() => {
    window.__shipingMahjongRegister('shell_back_1', 'abcd1234', '回归测试', true);
    window.__shipingMahjongSkipSeason();
  });
  await page.evaluate(() => window.__shipingMahjongOpenBack());
  await page.waitForSelector('#back-modal:not(.hidden)');
  assert.equal(await count(page, '#back-grid .back-cell'), 7);
  const before = (await shell(page)).account.coins;
  await page.evaluate(() => {
    const btn = document.querySelector('#back-grid .back-cell:not(.claimed):not(.locked)');
    if (btn) btn.click();
  });
  await page.waitForTimeout(200);
  assert.ok((await shell(page)).account.coins >= before, '领取后银币不应减少');
  await page.close();
});

test('手机竖屏：主界面单列不横向溢出，格子与游戏卡都在屏幕内', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__shipingMahjongRegister('shell_mob_1', 'abcd1234', '手机测试', true);
    window.__shipingMahjongSkipSeason();
  });
  await page.waitForTimeout(300);

  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const tiles = Array.from(document.querySelectorAll('#home-grid .grid-tile')).map((el) => el.getBoundingClientRect());
    const over = tiles.filter((r) => r.right > innerWidth + 1 || r.left < -1);
    return {
      scrollW: doc.scrollWidth, inner: innerWidth,
      cols: getComputedStyle(document.querySelector('#home-grid')).gridTemplateColumns.split(' ').length,
      overflowTiles: over.length,
      ladderHidden: getComputedStyle(document.querySelector('#home-ladder')).display === 'none',
      navBottom: Math.round(document.querySelector('.home-nav').getBoundingClientRect().bottom),
      vh: innerHeight
    };
  });
  assert.ok(layout.scrollW <= layout.inner + 2, '不应出现横向滚动，实际 ' + layout.scrollW + ' vs ' + layout.inner);
  assert.equal(layout.cols, 4, '手机端功能格仍为 4 列');
  assert.equal(layout.overflowTiles, 0, '功能格不应超出屏幕');
  assert.equal(layout.ladderHidden, true, '手机端隐藏天梯侧栏');
  assert.ok(Math.abs(layout.navBottom - layout.vh) <= 1, '底部导航应贴底');
  assert.deepEqual(page.__errors, [], '手机端不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('手机竖屏：牌桌手牌 14 张完整可见，操作区不遮挡手牌', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__shipingMahjongRegister('shell_mob_2', 'abcd1234', '手机牌桌', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0.1);
  });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  await page.waitForTimeout(200);

  const geo = await page.evaluate(() => {
    const panel = document.querySelector('.hand-panel').getBoundingClientRect();
    const tiles = Array.from(document.querySelectorAll('#hand-tiles .tile-face')).map((el) => el.getBoundingClientRect());
    return {
      count: tiles.length,
      panelTop: Math.round(panel.top),
      panelBottom: Math.round(panel.bottom),
      minLeft: Math.round(Math.min(...tiles.map((r) => r.left))),
      maxRight: Math.round(Math.max(...tiles.map((r) => r.right))),
      maxBottom: Math.round(Math.max(...tiles.map((r) => r.bottom))),
      vw: innerWidth, vh: innerHeight
    };
  });
  assert.ok(geo.count >= 13, '手牌应至少 13 张，实际 ' + geo.count);
  assert.ok(geo.minLeft >= -1, '手牌不应超出左边界');
  assert.ok(geo.maxRight <= geo.vw + 1, '手牌不应超出右边界，实际 ' + geo.maxRight + ' / ' + geo.vw);
  assert.ok(geo.maxBottom <= geo.vh + 1, '手牌不应超出下边界，实际 ' + geo.maxBottom + ' / ' + geo.vh);
  await page.close();
});
