/* 大厅 / 本地档案 / 积分账本的浏览器端测试
 * 运行：node --test tests/lobby.browser.test.cjs （需先 npm i playwright-core）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, launch, newPage, waitHumanTurn } = require('./browser-lib.cjs');

let srv, browser;
test.before(async () => { srv = await startServer(); browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const lobby = (page) => page.evaluate(() => window.__shipingMahjongLobby());
const snap = (page) => page.evaluate(() => window.__shipingMahjongDebug());

/** 打开一张干净页面（清掉 localStorage），等首局发牌完成 */
async function freshPage(viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(srv.origin + '/?debug=1', { waitUntil: 'load' });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (_) { /* ignore */ }
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__shipingMahjongLobby === 'function');
  await page.evaluate(() => window.__shipingMahjongSetSpeed(0.1));
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  page.__errors = errors;
  page.__ctx = ctx;
  return page;
}
async function closePage(page) {
  if (page.__ctx) await page.__ctx.close(); else await page.close();
}

test('大厅：默认存在一个本地档案，点品牌可开合并可关闭', async () => {
  const page = await freshPage();
  const first = await lobby(page);
  assert.equal(first.open, false, '开局不应挡住牌桌');
  assert.ok(first.profiles.length >= 1, '至少应有一个默认本地档案');
  assert.equal(first.variantId, 'shiping', '默认玩法应为石屏');

  await page.click('#brand');
  await page.waitForTimeout(260);
  assert.equal(await page.evaluate(() => document.querySelector('#lobby').classList.contains('hidden')), false, '点品牌应打开大厅');

  await page.click('#lobby-close');
  await page.waitForTimeout(220);
  assert.equal(await page.evaluate(() => document.querySelector('#lobby').classList.contains('hidden')), true, '关闭按钮应关掉大厅');
  assert.deepEqual(page.__errors, [], '大厅开关过程不得有脚本错误');
  await closePage(page);
});

test('档案：新建玩家后成为当前玩家，重名被拒绝，刷新后仍在', async () => {
  const page = await freshPage();
  await page.evaluate(() => window.__shipingMahjongOpenLobby());
  await page.waitForTimeout(220);

  await page.fill('#profile-input', '阿秀');
  await page.click('#profile-add');
  await page.waitForTimeout(240);

  let info = await lobby(page);
  const created = info.profiles.find((p) => p.name === '阿秀');
  assert.ok(created, '新建的玩家应出现在档案列表');
  assert.equal(info.activeProfileId, created.id, '新建后应自动切换为该玩家');
  assert.equal(created.points.shiping, 0, '新玩家石屏积分从 0 起算');

  await page.fill('#profile-input', '阿秀');
  await page.click('#profile-add');
  await page.waitForTimeout(200);
  info = await lobby(page);
  assert.equal(info.profiles.filter((p) => p.name === '阿秀').length, 1, '重名不得创建第二个档案');

  await page.fill('#profile-input', '   ');
  await page.click('#profile-add');
  await page.waitForTimeout(180);
  assert.equal((await lobby(page)).profiles.length, info.profiles.length, '空白名字不得创建档案');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__shipingMahjongLobby === 'function');
  await page.evaluate(() => window.__shipingMahjongSetSpeed(0.1));
  await page.waitForTimeout(600);
  const reloaded = await lobby(page);
  assert.ok(reloaded.profiles.some((p) => p.name === '阿秀'), '刷新后档案应保留');
  assert.deepEqual(page.__errors, [], '档案操作不得有脚本错误');
  await closePage(page);
});

test('玩法：个旧与宝秀是锁定占位，点不动；石屏始终可用', async () => {
  const page = await freshPage();
  await page.evaluate(() => window.__shipingMahjongOpenLobby());
  await page.waitForTimeout(240);

  const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.variant-card')).map((el) => ({
    id: el.dataset.variant,
    locked: el.classList.contains('is-locked'),
    text: el.textContent.trim()
  })));
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.ok(byId.shiping && !byId.shiping.locked, '石屏应可用');
  assert.ok(byId.gejiu && byId.gejiu.locked, '个旧应先占位锁定');
  assert.ok(byId.baoxiu && byId.baoxiu.locked, '宝秀应先占位锁定');

  const lockedClick = await page.evaluate(() => {
    document.querySelector('.variant-card.is-locked').click();
    return window.__shipingMahjongLobby().variantId;
  });
  assert.equal(lockedClick, 'shiping', '点锁定玩法不得切换当前玩法');

  await page.evaluate(() => { const i = document.querySelector('#profile-input'); if (i) i.value = ''; });
  const entered = await page.evaluate(() => {
    document.querySelector('#lobby-enter').click();
    return true;
  });
  assert.equal(entered, true);
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => document.querySelector('#lobby').classList.contains('hidden'));
  assert.equal(state, true, '点进入牌桌应关闭大厅');
  await closePage(page);
});

test('积分：一局结束后当前玩家积分等于本局得分，并持久化到刷新之后', async () => {
  const page = await freshPage();
  await page.evaluate(() => window.__shipingMahjongOpenLobby());
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__shipingMahjongAddProfile('账本测试'));
  await page.waitForTimeout(200);
  await page.click('#lobby-enter');
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__shipingMahjongSetSpeed(0.1));

  const before = await lobby(page);
  const pid = before.activeProfileId;
  const pointBefore = before.profiles.find((p) => p.id === pid).points.shiping;

  for (let i = 0; i < 900; i++) {
    const s = await snap(page);
    if (s.phase === 'over') break;
    if (s.awaiting && s.awaiting.seat === 0) {
      if (s.awaiting.kind === 'claim') {
        await page.evaluate(() => { const b = document.querySelector('#action-bar .action-pass'); if (b) b.click(); });
      } else {
        await page.evaluate(() => {
          const el = document.querySelectorAll('#hand-tiles .tile-face.playable');
          if (el.length) el[el.length - 1].click();
        });
      }
    }
    await page.waitForTimeout(35);
  }
  await page.waitForTimeout(500);

  const after = await snap(page);
  assert.equal(after.phase, 'over', '本局应正常结束（不得卡死）');
  assert.ok(after.scores.reduce((a, b) => a + b, 0) === 0, '四家得分必须零和');

  const mid = await lobby(page);
  const pointAfter = mid.profiles.find((p) => p.id === pid).points.shiping;
  assert.equal(pointAfter, pointBefore + after.scores[0], `积分应等于 ${pointBefore} + ${after.scores[0]}，实际 ${pointAfter}`);

  void waitHumanTurn;
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__shipingMahjongLobby === 'function');
  await page.waitForTimeout(700);
  const persisted = await lobby(page);
  const p2 = persisted.profiles.find((p) => p.id === pid);
  assert.ok(p2, '刷新后档案仍应存在');
  assert.equal(p2.points.shiping, pointAfter, '刷新后积分不得丢失');
  assert.deepEqual(page.__errors, [], '本局积分流程不得有脚本错误');
  await closePage(page);
});

test('大厅在手机端完整可见：无横向溢出，进入按钮在视口内', async () => {
  const page = await freshPage({ width: 390, height: 844 });
  await page.evaluate(() => window.__shipingMahjongOpenLobby());
  await page.waitForTimeout(300);
  const geo = await page.evaluate(() => {
    const b = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    const panel = document.querySelector('.lobby-panel');
    return {
      panel: b('.lobby-panel'),
      enter: b('#lobby-enter'),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollable: panel.scrollHeight > panel.clientHeight + 2,
      vw: window.innerWidth,
      vh: window.innerHeight
    };
  });
  assert.equal(geo.overflowX, false, '手机端大厅不得出现横向滚动');
  assert.ok(geo.panel[2] <= geo.vw, '面板宽度不得超过视口');
  assert.ok(geo.enter && geo.enter[1] + geo.enter[3] <= geo.vh + geo.panel[3], '进入按钮必须可达（面板内滚动即可）');
  assert.ok(geo.enter && geo.enter[2] > 100, '进入按钮应有足够点击面积');
  assert.deepEqual(page.__errors, []);
  await closePage(page);
});
