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

/** 用界面真实点击以「游客」进入（不依赖短信与云端），停在赛季页。
 *  账号密码那条路已经在 login.browser.test.cjs 里单独测，这里只需要一个能进游戏的账号。 */
async function registerByClick(page) {
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  await page.waitForFunction(() => {
    const b = document.getElementById('do-guest');
    return b && !b.disabled;
  }, null, { timeout: 8000 });
  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 8000 });
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

test('登录弹窗：手机号校验在本地完成，游客入口永远可用', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');

  assert.equal(await exists(page, '#login-phone'), true, '手机号输入框');
  assert.equal(await exists(page, '#login-code'), true, '验证码输入框');
  assert.equal(await exists(page, '#do-send-code'), true, '获取验证码按钮');
  assert.equal(await exists(page, '#do-verify'), true, '登录按钮');
  assert.equal(await exists(page, '#do-workbuddy'), true, 'WorkBuddy 登录入口');
  assert.equal(await exists(page, '#do-guest'), true, '游客入口');

  await page.click('#do-verify');
  assert.match(await text(page, '#login-tip'), /请输入手机号/, '空手机号应提示');

  await page.fill('#login-phone', '1380000111');        // 故意少一位
  await page.click('#do-send-code');
  assert.match(await text(page, '#login-tip'), /11 位/, '号码位数不对应就地拦下');

  await page.fill('#login-phone', '13800001111');
  await page.click('#do-verify');
  assert.match(await text(page, '#login-tip'), /请输入验证码/, '没填码应提示');
  assert.equal((await shell(page)).screen, 'splash', '校验失败不能跳转');

  await page.click('#login-close');
  assert.equal(await page.evaluate(() => document.querySelector('#login-modal').classList.contains('hidden')), true);
  assert.deepEqual(page.__errors, [], '登录弹窗交互不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('注册：新号自动发 4,000 银币见面礼，随后进入 S25 赛季页', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page);
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
  await registerByClick(page);
  await page.click('#reward-ok');

  await page.click('#screen-season');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'inherit', null, { timeout: 5000 });
  assert.match(await text(page, '#inherit-prev-badge'), /佃户/, '显示上赛季称号');
  assert.match(await text(page, '#inherit-prev-pts'), /112/, '显示上赛季段位分');
  assert.match(await text(page, '#inherit-now-badge'), /未激活/, '本赛季未定级');
  assert.match(await text(page, '#inherit-now-pts'), /0/);

  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 5000 });
  assert.equal((await shell(page)).account.seasonSeen, true, '赛季开屏的状态记在账号上，只放一次');
  await page.close();
});

test('大厅：只留两个入口（快速匹配 / 快速人机），其余玩法全部下线', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page);
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  assert.equal(await count(page, '#screen-home .lobby-btn'), 2, '大厅只留两个入口');
  assert.equal(await exists(page, '#lobby-match'), true, '要有快速匹配');
  assert.equal(await exists(page, '#lobby-ai'), true, '要有快速人机');
  assert.equal(await count(page, '#screen-home .home-nav .nav-item'), 0, '底部导航下线');
  assert.equal(await count(page, '#home-grid .grid-tile'), 0, '功能格下线');
  assert.equal(await count(page, '#screen-home .game-card'), 0, '个旧 / 双扣 / 扑克等占位卡下线');
  assert.equal(await text(page, '#home-coins'), '9,000', '银币含见面礼');
  assert.equal(await text(page, '#home-gold'), '91');
  assert.equal(await text(page, '#home-rank'), '穷人');
  assert.match(await text(page, '#lobby-hint'), /登录|手机号|人机/, '不能连真人时要说明原因');

  assert.equal(await exists(page, '#lobby-nick'), false, '大厅不再放昵称输入框（改昵称在左上角头像）');
  assert.equal(await exists(page, '#screen-home .lobby-nickrow'), false, '昵称行整块拿掉');

  assert.equal(await page.isDisabled('#lobby-match'), false, '未登录也不灰按钮：点一下弹登录并说明原因');
  await page.click('#lobby-match');
  await page.waitForSelector('#login-modal:not(.hidden)', { timeout: 5000 });
  assert.match(await text(page, '#login-tip'), /登录/, '点匹配要提示先登录');
  await page.click('#login-close');
  await page.waitForTimeout(150);
  assert.equal(await page.isDisabled('#lobby-ai'), false, '人机入口永远可用');
  assert.deepEqual(page.__errors, [], '大厅不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('快速人机：大厅一键进初级场，底注与场次写进桌面', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page);
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  await page.click('#lobby-ai');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'table', null, { timeout: 8000 });
  const s = await shell(page);
  assert.equal(s.hall, 'novice', '人机默认进初级场');
  assert.equal(s.baseBet, 2000);
  assert.match(await text(page, '#table-bet'), /2,?000/);
  assert.match(await text(page, '#lobby-status'), /人机/);
  assert.deepEqual(page.__errors, [], '进桌不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('对局：进桌后四家都有银币与段位，底注写进桌面', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_tbl_1', 'abcd1234', '牌桌测试', true);
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
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_win_1', 'abcd1234', '胡牌测试', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0.1);
  });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  const before = (await shell(page)).account.coins;

  await page.evaluate(() => window.__shipingMahjongForceWin());
  await page.waitForFunction(() => !document.querySelector('#result-modal').classList.contains('hidden'), null, { timeout: 8000 });

  const s = await shell(page);
  // 石屏麻将没有庄家：不管谁起手，单位恒为底分，没有翻倍
  const m = 1;
  const unit = 2000 * m;
  assert.equal(s.settlement.type, 'self');
  assert.equal(s.settlement.multiplier, m, '没有庄家，倍率恒为 1');
  assert.equal(s.settlement.unit, unit, '初级场底分 2,000 × 1 倍');
  assert.deepEqual(s.settlement.deltas, [unit * 9, -unit * 3, -unit * 3, -unit * 3], '自摸三家各付 3 倍');
  assert.deepEqual(s.settlement.multiples, [0, 3, 3, 3], '逐家倍数也要是 3');
  assert.deepEqual(s.rankDelta, [7 * m, -2 * m, -2 * m, -2 * m], '赢家 +7，其余 -2');
  assert.equal(s.account.coins, before + unit * 9, '银币必须写回账号');
  assert.equal(s.account.rankPoints, 7 * m);
  assert.equal(s.account.stats.wins, 1);

  // 结算面板结构：赢家一张、其他三家各一张、段位条一根
  assert.equal(await count(page, '#result-self .result-self'), 1);
  assert.equal(await count(page, '#result-others .result-other'), 3);
  assert.match(await text(page, '#result-self .rs-total'), new RegExp('\\+' + (unit * 9).toLocaleString('en-US')));
  const others = await page.evaluate(() => Array.from(document.querySelectorAll('#result-others .rs-total')).map((e) => e.textContent.trim()));
  assert.deepEqual(others, [-unit * 3, -unit * 3, -unit * 3].map((v) => v.toLocaleString('en-US')));
  assert.match(await text(page, '#result-rankbar'), new RegExp('\\+' + 7 * m + ' 段位分'));
  assert.ok(await count(page, '#result-hand .tile-face') >= 2, '应展示胡牌手牌');
  await page.close();
});

test('结算后回大厅，银币与段位分同步刷新；再开一局仍是新余额', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_cont_1', 'abcd1234', '续局测试');
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
  assert.ok(coins > 9000, '赢一局后余额应高于 9,000，实际 ' + coins);

  await page.click('#result-continue');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 5000 });
  assert.equal(await text(page, '#home-coins'), coins.toLocaleString('en-US'), '大厅余额应与账本一致');
  assert.equal(await text(page, '#home-rank'), '穷人');

  await page.click('#lobby-ai');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'table', null, { timeout: 8000 });
  const again = await shell(page);
  assert.equal(again.account.coins, coins, '再开一局时余额不应被重置');
  assert.equal(again.baseBet, 2000);
  await page.close();
});

test('每日签到：7 格，领取后当天不可重复领，银币增加 1,000', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_sign_1', 'abcd1234', '签到测试', true);
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
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_back_1', 'abcd1234', '回归测试', true);
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

test('大厅免费领银币：点一次 +4,000，计数 1/10，同一天不会超发', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_free_1', 'abcd1234', '领钱测试', true);
    const ok = document.getElementById('reward-ok');
    if (ok) ok.click();
    window.__shipingMahjongSkipSeason();
  });
  await page.waitForTimeout(300);

  assert.equal(await exists(page, '#lobby-free'), true, '大厅要有免费领银币入口');
  assert.match(await text(page, '#lobby-free-count'), /0\/10/, '初始 10 次一次没领');
  const before = (await shell(page)).account.coins;

  await page.click('#lobby-free');
  await page.waitForTimeout(150);
  const after = await shell(page);
  assert.equal(after.account.coins, before + 4000, '领一次 +4,000');
  assert.match(await text(page, '#home-coins'), new RegExp((before + 4000).toLocaleString('en-US')), '顶栏银币要刷新');
  assert.match(await text(page, '#lobby-free-count'), /1\/10/);

  await page.click('#lobby-free');
  await page.waitForTimeout(150);
  assert.equal((await shell(page)).account.coins, before + 8000, '第二次再 +4,000');
  assert.match(await text(page, '#lobby-free-count'), /2\/10/);
  assert.deepEqual(page.__errors, [], '领钱不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('结算：显示赢家完整牌型（含副露），且面板不出滚动条', async () => {
  for (const vp of [{ width: 1440, height: 900 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
    const page = await freshPage(vp);
    await page.evaluate(async () => {
      await window.__shipingMahjongRegister('shell_res_' + Date.now().toString(36), 'abcd1234', '结算测试', true);
      window.__shipingMahjongSkipSeason();
      window.__shipingMahjongStartTable('novice');
      window.__shipingMahjongSetSpeed(0);
    });
    await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
    await page.evaluate(() => window.__shipingMahjongForceWin());
    await page.waitForFunction(() => !document.querySelector('#result-modal').classList.contains('hidden'));
    await page.waitForTimeout(320);

    const fit = await page.evaluate(() => {
      const sheet = document.querySelector('#result-modal .result-sheet');
      const row = document.querySelector('#result-hand');
      const actions = document.querySelector('.result-actions').getBoundingClientRect();
      return {
        meldGroups: row.querySelectorAll('.result-meld-group').length,
        tiles: row.querySelectorAll('.tile-face').length,
        overflowY: sheet.scrollHeight - sheet.clientHeight,
        scrollCls: sheet.classList.contains('is-scroll'),
        actionsBottom: Math.round(actions.bottom),
        vh: window.innerHeight,
        rowHeight: Math.round(row.getBoundingClientRect().height)
      };
    });
    const tag = vp.width + 'x' + vp.height;
    assert.ok(fit.meldGroups >= 1, tag + '：副露也要画进完整牌型');
    assert.ok(fit.tiles >= 10, tag + '：手牌 + 副露应完整，实际 ' + fit.tiles);
    assert.ok(fit.overflowY <= 2, tag + '：面板不该有可滚动内容，超出 ' + fit.overflowY);
    assert.equal(fit.scrollCls, false, tag + '：正常情况下不该启用滚动兜底');
    assert.ok(fit.actionsBottom <= fit.vh, tag + '：底部按钮必须在视口内');
    assert.deepEqual(page.__errors, [], tag + ' 不应报错：' + page.__errors.join(' | '));
    await page.close();
  }
});

test('牌河：被吃/碰/杠取走的牌留在原位、盖遮罩、按出牌顺序排列；副露只有吃牌标接进来的那张', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_pile_1', 'abcd1234', '牌河测试', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongStartTable('novice');
    window.__shipingMahjongSetSpeed(0);
  });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  await page.evaluate(() => window.__shipingMahjongForceChi());
  await page.waitForTimeout(320);

  const info = await page.evaluate(() => {
    const s = window.__shipingMahjongState();
    const piles = Array.from(document.querySelectorAll('.discard-stack')).map((b) => {
      const seat = Number(b.id.slice(-1));
      const els = Array.from(b.querySelectorAll('.tile-face'));
      const tl = window.__shipingMahjongDiscardTimeline(seat);
      return {
        id: b.id, seat,
        dom: els.map((e) => String(e.dataset.tile)),
        ghostIdx: els.map((e, i) => e.classList.contains('claimed-ghost') ? i : -1).filter((i) => i >= 0),
        ghostVisible: els.filter((e) => e.classList.contains('claimed-ghost'))
          .every((e) => getComputedStyle(e).display !== 'none'),
        // 应用侧重建的完整出牌顺序 + 被取走的下标
        full: tl.full.map(String),
        expectedGhostIdx: tl.claimed,
        core: (s.discards[seat] || []).map(String)
      };
    });
    return {
      ghosts: document.querySelectorAll('.claimed-ghost').length,
      called: document.querySelectorAll('.meld-called-tile').length,
      piles
    };
  });
  assert.ok(info.ghosts >= 1, '被吃/碰/杠取走的牌仍要留在牌面上');
  info.piles.forEach((p) => {
    assert.deepEqual(p.dom, p.full, p.id + ' 要按完整出牌顺序排列（遮罩牌插回原位）');
    assert.deepEqual(p.ghostIdx, p.expectedGhostIdx, p.id + ' 遮罩位置要和被取走的那一张对上');
    assert.equal(p.ghostIdx.length, p.full.length - p.core.length, p.id + ' 遮罩牌数量要和被取走的张数一致');
    const live = p.dom.filter((_, i) => !p.ghostIdx.includes(i));
    assert.deepEqual(live, p.core, p.id + ' 去掉遮罩牌后就是牌河里真正剩下的牌');
    assert.equal(p.ghostVisible, true, p.id + ' 遮罩牌不能被 display:none 藏掉');
  });
  assert.ok(info.called >= 1, '吃牌仍要标出接进来的那张');

  const groups = await page.evaluate(() => window.__shipingMahjongMeldPreview());
  assert.ok(Array.isArray(groups) && groups.length === 3, '要能画出吃 / 碰 / 杠三组副露');
  assert.ok(groups[0].called >= 1, '吃牌要标出接进来的那张');
  assert.equal(groups[1].called, 0, '碰牌三张一样，不用标是哪张');
  assert.equal(groups[1].pins, 0, '碰牌不要接牌箭头');
  assert.equal(groups[2].called, 0, '杠牌不用标是哪张');
  assert.equal(groups[2].pins, 0, '杠牌不要接牌箭头');
  assert.deepEqual(page.__errors, [], '不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('手机竖屏：大厅两个按钮都在屏内，不横向溢出', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_mob_1', 'abcd1234', '手机测试', true);
    window.__shipingMahjongSkipSeason();
  });
  await page.waitForTimeout(300);

  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const btns = Array.from(document.querySelectorAll('.lobby-btn')).map((el) => el.getBoundingClientRect());
    const sel = document.querySelector('#lobby-variant-select');
    const sr = sel ? sel.getBoundingClientRect() : null;
    return {
      scrollW: doc.scrollWidth, inner: innerWidth,
      count: btns.length,
      inView: btns.filter((r) => r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1).length,
      modeCount: sel ? 1 : 0,
      modesIn: sr && sr.left >= -1 && sr.right <= innerWidth + 1 ? 1 : 0,
      gap: btns.length === 2 ? Math.round(btns[1].top - btns[0].bottom) : -1
    };
  });
  assert.equal(layout.count, 2, '手机端也是两个入口');
  assert.equal(layout.inView, 2, '两个按钮都要完整在屏内');
  assert.ok(layout.scrollW <= layout.inner + 2, '不应出现横向滚动，实际 ' + layout.scrollW + ' vs ' + layout.inner);
  assert.equal(layout.modeCount, 1, '三种玩法收成一个下拉');
  assert.equal(layout.modesIn, 1, '下拉要在屏内');
  assert.ok(layout.gap >= 0, '两个按钮要分开，别叠在一起');
  assert.deepEqual(page.__errors, [], '手机端不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('手机竖屏：牌桌手牌 14 张完整可见，操作区不遮挡手牌', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_mob_2', 'abcd1234', '手机牌桌', true);
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

test('手机横屏：大厅装得下，牌桌 14 张手牌完整可见', async () => {
  const page = await freshPage({ width: 844, height: 390 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_ls_1', 'abcd1234', '横屏测试', true);
    window.__shipingMahjongSkipSeason();
  });
  await page.waitForTimeout(300);

  const lobby = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.lobby-btn')).map((el) => el.getBoundingClientRect());
    return {
      count: btns.length,
      inView: btns.filter((r) => r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1).length,
      scrollH: document.documentElement.scrollHeight,
      h: innerHeight
    };
  });
  assert.equal(lobby.count, 2, '横屏也是两个入口');
  assert.equal(lobby.inView, 2, '横屏两个按钮都要在屏内');
  assert.ok(lobby.scrollH <= lobby.h + 2, '横屏不应纵向滚动，实际 ' + lobby.scrollH + ' vs ' + lobby.h);

  await page.evaluate(() => window.__shipingMahjongSetSpeed(0));
  await page.click('#lobby-ai');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'table', null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 20000 });
  // 骰子收起 ≠ 摸牌渲染完成：等真正「轮到玩家且 DOM 有 14 张」再量几何，
  // 否则快速 AI 下会随机抓到 13 张的瞬间。
  await page.waitForFunction(() => {
    const s = window.__shipingMahjongState();
    return s && s.phase === 'discard' && s.current === 0 &&
      document.querySelectorAll('#hand-tiles .tile-face').length === 14;
  }, null, { timeout: 15000 });

  const table = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('#hand-tiles .tile-face')).map((el) => el.getBoundingClientRect());
    const bar = document.querySelector('#action-bar').getBoundingClientRect();
    const hand = document.querySelector('#hand-tiles').getBoundingClientRect();
    return {
      count: tiles.length,
      clipped: tiles.filter((r) => r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1).length,
      scrollW: document.documentElement.scrollWidth,
      w: innerWidth,
      barOverHand: bar.height > 0 && bar.bottom > hand.top && bar.top < hand.bottom
    };
  });
  assert.equal(table.count, 14, '手牌应有 14 张（含摸牌），实际 ' + table.count);
  assert.equal(table.clipped, 0, '横屏手牌不应超出屏幕');
  assert.ok(table.scrollW <= table.w + 2, '横屏不应横向滚动，实际 ' + table.scrollW + ' vs ' + table.w);
  assert.equal(table.barOverHand, false, '操作条不能压在手牌上');
  assert.deepEqual(page.__errors, [], '横屏不应报错：' + page.__errors.join(' | '));
  await page.close();
});

/* ---------------- v0.9.0：品牌标 / 三种玩法 / 银币声 / 结算浮层回归 ---------------- */

test('首页：左上角是统一品牌标（红河麻将 + logo），昵称改到头像里', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page);
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  const brand = await page.evaluate(() => {
    const box = document.querySelector('.home-brand');
    if (!box) return null;
    const mark = box.querySelector('.hb-mark');
    const r = box.getBoundingClientRect();
    return {
      name: (box.querySelector('.hb-text b') || {}).textContent || '',
      hasSvg: !!mark && mark.tagName.toLowerCase() === 'svg',
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), top: Math.round(r.top)
    };
  });
  assert.ok(brand, '首页要有品牌标');
  assert.equal(brand.name, '红河麻将', '统一叫红河麻将（石屏 / 宝秀 / 个旧都在红河）');
  assert.equal(brand.hasSvg, true, '品牌标要用 SVG 图标，不是文字方块');
  assert.ok(brand.left < 80, '品牌标要贴在左上角，实际 left=' + brand.left);
  assert.ok(brand.top < 40, '品牌标要在顶栏内，实际 top=' + brand.top);
  assert.ok(brand.w >= 70 && brand.h >= 26, '品牌标不该被压没了');

  assert.match(await page.title(), /红河麻将/, '网页标题跟着改');
  assert.equal((await shell(page)).screen, 'home');

  // 改昵称只留在头像浮层里
  await page.click('#home-player');
  await page.waitForTimeout(200);
  assert.equal(await exists(page, '#account-menu:not(.hidden)'), true, '点头像要开账号浮层');
  assert.match(await text(page, '#am-rename'), /改昵称/, '浮层里要能改昵称');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.deepEqual(page.__errors, [], '首页不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('首页：三种玩法做成下拉，放在快速匹配上方，三个都能真的选中', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page);
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  const sel = '#lobby-variant-select';
  assert.equal(await count(page, sel + ' option'), 3, '石屏 / 宝秀 / 个旧都在下拉里');
  assert.equal(await page.inputValue(sel), 'shiping', '默认石屏');
  const pos = await page.evaluate(() => {
    const s = document.querySelector('#lobby-variant-select').getBoundingClientRect();
    const b = document.querySelector('#lobby-match').getBoundingClientRect();
    return { above: s.bottom <= b.top + 2, inView: s.left >= -1 && s.right <= innerWidth + 1 };
  });
  assert.equal(pos.above, true, '下拉必须在「快速匹配」上方');
  assert.equal(pos.inView, true, '下拉要完整在屏内');

  await page.selectOption(sel, 'gejiu');
  await page.waitForTimeout(200);
  assert.equal(await page.inputValue(sel), 'gejiu', '个旧要真的选中，不是灰死的占位');
  assert.match(await text(page, '#lobby-variant-note'), /规则还在整理/, '未开放要说清暂按石屏规则');
  assert.match(await text(page, '#lobby-variant-title'), /个旧/, '大厅标题跟着玩法走');
  await page.selectOption(sel, 'shiping');
  await page.waitForTimeout(150);
  assert.match(await text(page, '#lobby-variant-title'), /石屏/, '切回石屏');
  assert.ok(!/规则还在整理/.test(await text(page, '#lobby-variant-note')), '石屏不需要提示');
  assert.deepEqual(page.__errors, [], '玩法下拉不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('免费领银币：点一下就进账，并且真的响了一声银币到账', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page);
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  // 数一数到底有没有振荡器被创建（音效就是靠它发声的）
  await page.evaluate(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    window.__osc = 0;
    const raw = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () { window.__osc += 1; return raw.call(this); };
  });

  const before = (await shell(page)).account.coins;
  await page.click('#lobby-free');
  await page.waitForTimeout(260);
  const pop = await page.evaluate(() => {
    const el = document.querySelector('.coin-pop');
    return el ? el.textContent : null;
  });
  assert.match(pop || '', /\+4,000/, '要飘一个"到账"的提示，实际：' + pop);
  await page.waitForTimeout(300);
  const after = await shell(page);
  assert.equal(after.account.coins - before, 4000, '点一次 +4,000');
  assert.match(await text(page, '#lobby-free-count'), /1\/10/, '计数要跟着走');
  const osc = await page.evaluate(() => window.__osc);
  assert.ok(osc >= 3, '银币到账要有一声（三个音叠出来的"叮—叮"），实际振荡器 ' + osc);
  /* 真正的坑是「第一次点击时 AudioContext 还没解锁」——只飘字不响。
     这里额外确认共用音频层也在这次手势里建好了 ctx。 */
  const audio = await page.evaluate(() => window.HongheAudio && window.HongheAudio.status());
  assert.equal(audio.hasCtx, true, '第一次点领银币就要建出 AudioContext');
  assert.equal(audio.unlocked, true, '第一次点击要解锁音频');
  assert.deepEqual(page.__errors, [], '领银币不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('牌桌回归：开局后中间不该挂着"换桌 / 分享好友"（结算浮层必须关着）', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await registerByClick(page);
  await page.click('#reward-ok');
  await page.click('#screen-season');
  await page.click('#screen-inherit');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home');

  await page.evaluate(() => window.__shipingMahjongSetSpeed(0));
  await page.click('#lobby-ai');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'table', null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 20000 });

  const vis = await page.evaluate(() => {
    const modal = document.querySelector('#result-modal');
    const cs = getComputedStyle(modal);
    const btn = document.querySelector('#result-share').getBoundingClientRect();
    return {
      display: cs.display,
      hiddenCls: modal.classList.contains('hidden'),
      // 元素在视口正中且尺寸可观 = 玩家真的看得见
      shareVisible: btn.width > 0 && btn.height > 0
    };
  });
  assert.equal(vis.hiddenCls, true, '结算层应带 hidden');
  assert.equal(vis.display, 'none', 'hidden 必须真的把浮层藏掉（这条曾经被 !important 盖掉）');
  assert.equal(vis.shareVisible, false, '「分享好友」按钮不该出现在牌桌上');

  // 手牌要能点（浮层在的话会整屏拦截点击）
  const clickable = await page.evaluate(() => {
    const t = document.querySelector('#hand-tiles .tile-face');
    if (!t) return 'no-tile';
    const r = t.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: !!top && (top === t || t.contains(top)), tag: top ? top.className : null };
  });
  assert.equal(clickable.hit, true, '手牌要能点得到（不被浮层挡住），实际命中：' + clickable.tag);
  assert.deepEqual(page.__errors, [], '牌桌不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('电脑宽屏与手机横屏用同一套左右两栏大厅', async () => {
  const wide = await freshPage({ width: 1440, height: 900 });
  await wide.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_wide_1', 'abcd1234', '宽屏', true);
    window.__shipingMahjongSkipSeason();
  });
  await wide.waitForTimeout(300);
  const a = await wide.evaluate(() => ({
    dir: getComputedStyle(document.querySelector('.lobby')).flexDirection,
    brandAlign: getComputedStyle(document.querySelector('.lobby-brand')).textAlign
  }));
  await wide.close();

  const phone = await freshPage({ width: 844, height: 390 });
  await phone.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_wide_2', 'abcd1234', '横屏', true);
    window.__shipingMahjongSkipSeason();
  });
  await phone.waitForTimeout(300);
  const b = await phone.evaluate(() => ({
    dir: getComputedStyle(document.querySelector('.lobby')).flexDirection,
    brandAlign: getComputedStyle(document.querySelector('.lobby-brand')).textAlign
  }));
  await phone.close();

  assert.equal(a.dir, 'row', '电脑宽屏应该是左右两栏，实际 ' + a.dir);
  assert.equal(b.dir, 'row', '手机横屏也是左右两栏，实际 ' + b.dir);
  assert.equal(a.brandAlign, 'left', '宽屏品牌名靠左');
  assert.equal(b.brandAlign, 'left', '横屏品牌名靠左');
});

/* ---------------- v0.11.0 截图对照改造的回归 ---------------- */
test('读秒：15 秒到点自动打出刚摸的那张牌', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_clock_1', 'abcd1234', '读秒测试', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongSetSpeed(0);
    window.__shipingMahjongSetTurnSeconds(2);   // 把 15 秒压到 2 秒，免得测试空等
    window.__shipingMahjongStartTable('novice');
  });
  /* 一边轮询记下「轮到玩家时刚摸的是哪张」，一边监听 toast 里那句
     「读秒结束，自动打出刚摸的 X」，最后比对两者是不是同一张牌。 */
  await page.evaluate(() => {
    window.__autoToasts = [];
    window.__clockSample = null;
    const t = document.querySelector('#toast');
    new MutationObserver(() => {
      if (/读秒结束/.test(t.textContent)) window.__autoToasts.push(t.textContent);
    }).observe(t, { childList: true, characterData: true, subtree: true });
    const tick = () => {
      const s = window.__shipingMahjongState();
      if (!window.__clockSample && s && s.phase === 'discard' && s.current === 0 &&
          s.lastDraw && s.lastDraw.seat === 0) {
        window.__clockSample = { tile: s.lastDraw.tile, handLen: s.hands[0].length };
      }
      // 双保险：observer 万一在 toast 节点重建时漏掉，轮询也能抓到这句提示
      if (!window.__autoToasts.length && /读秒结束/.test(t.textContent)) {
        window.__autoToasts.push(t.textContent);
      }
      if (!window.__autoToasts.length) setTimeout(tick, 20);
    };
    tick();
  });
  try {
    await page.waitForFunction(() => window.__autoToasts.some((x) => /读秒结束，自动打出刚摸的/.test(x)), null, { timeout: 35000 });
  } catch (err) {
    const clock = await page.evaluate(() => window.__shipingMahjongClock());
    throw new Error('读秒自动出牌没触发，时钟状态：' + JSON.stringify(clock));
  }
  const info = await page.evaluate(() => ({
    toasts: window.__autoToasts.slice(),
    sample: window.__clockSample,
    label: window.__clockSample ? window.ShipingMahjongCore.tileLabel(window.__clockSample.tile) : null
  }));
  assert.ok(info.sample, '要抓到一次「轮到你 + 手里有刚摸的牌」的瞬间');
  assert.equal(info.sample.handLen, 14, '轮到玩家出牌时手上应是 14 张');
  assert.match(info.toasts.join(' | '), /读秒结束，自动打出刚摸的/, '超时要有明确提示');
  assert.ok(info.toasts.some((t) => t.includes(info.label)),
    '自动打出的必须就是刚摸的 ' + info.label + '，实际提示：' + info.toasts.join(' | '));
  assert.deepEqual(page.__errors, [], '读秒自动出牌不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('读秒：轮到你吃碰杠时不点，超时自动过，牌局不能卡死', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_clock_2', 'abcd1234', '接牌读秒', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongSetSpeed(0);
    window.__shipingMahjongSetTurnSeconds(1);
    window.__shipingMahjongStartTable('novice');
  });
  /* 直接构造「轮到我吃 6 条」的局面，不靠随机等牌：
     以前读秒只倒计时出牌阶段，人不点就永远停在 claim，牌墙不再动 —— 整局卡死。 */
  await page.waitForFunction(() => !!window.__shipingMahjongState(), null, { timeout: 8000 });
  const forced = await page.evaluate(() => window.__shipingMahjongForceHumanClaim());
  assert.ok(forced, '要能构造出接牌局面');
  assert.equal(forced.awaiting, 'claim', '构造后必须轮到我决定接牌，实际 ' + JSON.stringify(forced));
  const wallBefore = await page.evaluate(() => window.__shipingMahjongState().wall.length);

  /* 什么都不点：读秒到 0 必须自动「过」，phase 离开 claim */
  await page.waitForFunction(() => window.__shipingMahjongState().phase !== 'claim', null, { timeout: 15000 });
  const after = await page.evaluate(() => {
    const s = window.__shipingMahjongState();
    return {
      phase: s.phase, wall: s.wall.length,
      myMelds: document.querySelectorAll('#meld-0 .meld-group').length,
      clock: window.__shipingMahjongClock()
    };
  });
  assert.equal(after.myMelds, 0, '超时只能是「过」，不能替我吃碰杠');
  assert.ok(after.wall <= wallBefore, '接牌超时后牌局要继续走：wall ' + wallBefore + ' → ' + after.wall);
  assert.ok(!(after.clock.running && after.clock.phase === 'claim' && after.clock.left === 1),
    '不能停在一个永远读 1 秒的接牌倒计时上');
  assert.deepEqual(page.__errors, [], '接牌超时兜底不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('右侧书法操作按钮 + 吃牌多选项小牌组 + 刚摸牌留小间距', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_actions_1', 'abcd1234', '按钮测试', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongSetSpeed(0);
    window.__shipingMahjongStartTable('novice');
  });
  /* 一次同步 evaluate 里做完注入、渲染、测量：AI 的 render() 会重建行动栏，
     分开两次调用中间的异步间隙会把预览冲掉，测出来就是随机的。 */
  const layout = await page.evaluate(() => {
    // 摸牌间距直接验证 CSS 规则：临时插一张 .drawn-tile，读完 margin 立刻摘掉
    const handBox = document.querySelector('#hand-tiles');
    const probe = document.createElement('div');
    probe.className = 'tile-face drawn-tile';
    handBox.appendChild(probe);
    const gap = parseFloat(getComputedStyle(probe).marginLeft);
    probe.remove();

    const preview = window.__shipingMahjongChiPreview();
    const bar = document.querySelector('#action-bar');
    const felt = document.querySelector('.felt').getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const hand = handBox.getBoundingClientRect();
    const opts = Array.from(bar.querySelectorAll('.chi-option'));
    const pass = bar.querySelector('.action-pass');
    return {
      gap, preview,
      rightSide: br.left > felt.left + felt.width * 0.5,
      aboveHand: br.bottom <= hand.top + 2,
      nums: opts.map((o) => o.querySelector('.chi-option-no').textContent),
      tiles: opts.map((o) => o.querySelectorAll('.mini-tile').length),
      tileW: opts[0] ? opts[0].querySelector('.mini-tile').getBoundingClientRect().width : 0,
      clip: pass ? getComputedStyle(pass).backgroundClip : '',
      passText: pass ? pass.textContent : '',
      fontFamily: pass ? getComputedStyle(pass).fontFamily : '',
      menu: document.querySelectorAll('.table-menu').length
    };
  });
  assert.ok(layout.gap >= 6 && layout.gap <= 18, '刚摸的牌只留一小段距离（6~18px），实际 ' + layout.gap);
  assert.equal(layout.preview, 3, '三种吃法要各有一组小牌');
  assert.equal(layout.rightSide, true, '操作按钮要排在牌桌右侧');
  assert.equal(layout.aboveHand, true, '操作条不能压住手牌');
  assert.deepEqual(layout.nums, ['1', '2', '3'], '吃法要标出选择顺序');
  assert.deepEqual(layout.tiles, [3, 3, 3], '每组吃法画三张小牌');
  assert.ok(layout.tileW > 0 && layout.tileW <= 24, '小牌要真的缩小，实际宽 ' + layout.tileW);
  assert.match(layout.clip, /text/, '书法大字要用渐变裁进字形');
  assert.equal(layout.passText, '过', '按钮文字压缩成单字');
  assert.match(layout.fontFamily, /KaiTi|Kaiti|楷体|Xingkai|行楷|serif/i, '要用书法/衬线字体');
  assert.equal(layout.menu, 0, '玩家右手边那颗圆形功能按钮已删掉');
  assert.deepEqual(page.__errors, [], '操作区不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('局前等待层：四家头像 + 新头衔，换桌回大厅、准备立刻开局', async () => {
  const page = await freshPage({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await window.__shipingMahjongRegister('shell_ready_1', 'abcd1234', '准备测试', true);
    window.__shipingMahjongSkipSeason();
    window.__shipingMahjongSetSpeed(0);
  });
  // 走大厅真实按钮（不是调试的 instant 入口）才会弹「换桌 / 准备」
  await page.click('#lobby-ai');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'table', null, { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('#table-ready').classList.contains('hidden'), null, { timeout: 4000 });

  const ready = await page.evaluate(() => window.__shipingMahjongReady());
  assert.equal(ready.hidden, false, '进桌先看到等待层');
  assert.equal(ready.seats.length, 4, '四家都要有头像 / 名字 / 头衔 / 银币');
  assert.deepEqual(ready.buttons, ['ready-switch', 'ready-go'], '要有「换桌」「准备」两颗按钮');
  assert.match(ready.bet, /底注/, '要写清底注');
  assert.ok(ready.seats.every((s) => s.name && s.rank), '四家的名字与头衔都要填好');
  assert.ok(ready.seats.some((s) => /进士|举人|秀才/.test(s.rank)), '电脑头衔要用科举体系');

  // 等待层不能挡手牌：整层 pointer-events:none，只有按钮可点
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(innerWidth / 2, innerHeight - 40);
    return { inReady: !!el && !!el.closest('#table-ready') };
  });
  assert.equal(hit.inReady, false, '等待层不该拦住底部手牌区');

  await page.evaluate(() => document.getElementById('ready-go').click());
  await page.waitForFunction(() => document.querySelector('#table-ready').classList.contains('hidden'), null, { timeout: 3000 });
  assert.equal((await shell(page)).screen, 'table', '点「准备」留在桌内继续开局');

  await page.evaluate(() => window.__shipingMahjongShowReady());
  assert.equal((await page.evaluate(() => window.__shipingMahjongReady())).hidden, false, '能再次唤出等待层');
  await page.evaluate(() => document.getElementById('ready-switch').click());
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 5000 });
  assert.equal((await page.evaluate(() => window.__shipingMahjongReady())).hidden, true, '换桌后等待层要收起');
  assert.deepEqual(page.__errors, [], '准备层不应报错：' + page.__errors.join(' | '));
  await page.close();
});
