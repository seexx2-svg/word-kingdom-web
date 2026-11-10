/* 联机牌桌的浏览器集成测试（不需要第二个真实账号）
 *
 * 思路：真实的两人对局要两台设备 + 两个云端账号，自动化里做不到；
 * 但"座位旋转 + 等真人 + 远端动作落地"这三件事完全可以在一个页面里验：
 * 用 __shipingMahjongOnlineStart 按指定房间参数开局，再用 __shipingMahjongRemote
 * 手动注入"对手的那一手"，看局面是否正确推进。
 *
 * 真机互通的验证仍要人来点（两台设备 / 两部手机），见 README。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, launch, newPage } = require('./browser-lib.cjs');

let srv, browser;
test.before(async () => { srv = await startServer(); browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const debug = (page) => page.evaluate(() => window.__shipingMahjongDebug());
const online = (page) => page.evaluate(() => window.__shipingMahjongOnline());
const dealt = (d) => d.discards.reduce((a, b) => a + b, 0);   // 弃牌总数 = 已经打出几手

async function enterGuest(page) {
  await page.evaluate(() => window.__shipingMahjongResetProgress());
  await page.waitForTimeout(120);
  await page.click('#btn-phone');
  await page.waitForSelector('#login-modal:not(.hidden)');
  await page.waitForFunction(() => {
    const b = document.getElementById('do-guest');
    return b && !b.disabled;
  }, null, { timeout: 8000 });
  await page.click('#do-guest');
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'season', null, { timeout: 8000 });
  await page.evaluate(() => window.__shipingMahjongSkipSeason());
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'home', null, { timeout: 8000 });
}

async function startOnline(page, opts) {
  const o = opts || {};
  await page.evaluate((p) => {
    window.__shipingMahjongSetSpeed(0);
    window.__shipingMahjongOnlineStart(p);
  }, {
    seed: o.seed || 20261110,
    mySeat: o.mySeat || 0,
    humanCount: o.humanCount || 2,
    names: o.names || ['我', '对手']
  });
  await page.waitForFunction(() => window.__shipingMahjongShell().screen === 'table', null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 20000 });
}

test('联机开局：我的座位被转到 0 号位，名字跟桌上的人对得上', async () => {
  const page = await newPage(browser, srv.origin, { width: 1440, height: 900 });
  await enterGuest(page);
  await startOnline(page, { mySeat: 1, humanCount: 2, names: ['甲', '乙'] });

  const s = await online(page);
  assert.equal(s.online, true, '应该处于联机对局');
  assert.equal(s.mySeat, 1, '我在全局 1 号位');
  assert.equal(s.names[0], '乙', '本地 0 号位就是我（全局 1 号位）');
  assert.equal(s.names[1], '甲', '本地 1 号位是另一位真人');
  assert.match(s.names[2] + s.names[3], /阿七|小满|老顺|坝心/, '后两位是电脑');

  const names = await page.evaluate(() => [0, 1, 2, 3].map((i) => document.getElementById('seat-name-' + i).textContent));
  assert.equal(names[0], '乙', '0 号位（我自己）应显示我的昵称');
  assert.match(names[1], /甲$/, '1 号位是另一位真人，实际：' + names[1]);
  assert.match(names[2], /阿七|小满|老顺|坝心/, '2 号位是电脑');

  const d = await debug(page);
  const myHand = await page.evaluate(() => document.querySelectorAll('#hand-tiles .tile-face').length);
  assert.ok(myHand === 13 || myHand === 14, '我的手牌应该是 13 或 14 张，实际 ' + myHand);
  assert.equal(d.hands[0], myHand, '界面手牌应与内核 hands[0] 一致（说明旋转生效）');
  assert.deepEqual(page.__errors, [], '联机开局不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('轮到真人对手时不会替他出牌，会一直等着', async () => {
  const page = await newPage(browser, srv.origin, { width: 1440, height: 900 });
  await enterGuest(page);
  await startOnline(page, { mySeat: 0, humanCount: 2 });

  // 把我这一手打出去，轮到对手
  await page.waitForFunction(() => {
    const d = window.__shipingMahjongDebug();
    return d && d.phase === 'discard' && d.current === 0;
  }, null, { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#hand-tiles .tile-face').click());
  await page.waitForFunction(() => {
    const o = window.__shipingMahjongOnline();
    return o && o.remoteTurn === true;
  }, null, { timeout: 15000 });

  const before = await debug(page);
  await page.waitForTimeout(2500);       // 速度已设为 0，若是电脑早就走了
  const after = await debug(page);
  assert.equal(after.current, before.current, '对手没出牌，回合不该自己往前走');
  assert.equal(dealt(after), dealt(before), '不该凭空多出一手');
  const bar = await page.evaluate(() => document.getElementById('action-bar').textContent);
  assert.match(bar, /对手|正在/, '操作条要写明在等谁，实际：' + bar);
  await page.close();
});

test('对手出牌后局面照常推进，轮到谁就是谁', async () => {
  const page = await newPage(browser, srv.origin, { width: 1440, height: 900 });
  await enterGuest(page);
  await startOnline(page, { mySeat: 0, humanCount: 2 });

  await page.waitForFunction(() => {
    const d = window.__shipingMahjongDebug();
    return d && d.phase === 'discard' && d.current === 0;
  }, null, { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#hand-tiles .tile-face').click());
  await page.waitForFunction(() => window.__shipingMahjongOnline().remoteTurn === true, null, { timeout: 15000 });

  const before = await debug(page);
  // 对手那一手可能是「接牌决定」也可能是「出牌」：按当前等待的类型回，
  // 一直推到他真的打出一张牌为止（只过一次不算推进）
  const deadline = Date.now() + 15000;
  let applied = 0;
  while (Date.now() < deadline) {
    const d = await debug(page);
    if (dealt(d) > dealt(before)) break;
    const o = await online(page);
    if (o.remoteTurn) {
      const kind = o.awaiting.kind;
      const res = await page.evaluate((act) => window.__shipingMahjongRemote(1, act), kind === 'claim' ? { kind: 'pass' } : { kind: 'discard', index: 0 });
      assert.equal(res.ok, true, '远端动作应被接受：' + (res.error || ''));
      applied += 1;
    }
    await page.waitForTimeout(220);
  }
  assert.ok(applied >= 1, '至少应该替对手处理一手');
  const after = await debug(page);
  assert.ok(dealt(after) > dealt(before), '对手出牌后弃牌区应多一张');


  // 接着应该轮到某个座位继续，不能停在"没人能动"的状态
  const s = await online(page);
  assert.ok(s.awaiting && Number.isInteger(s.awaiting.seat), '推进后仍应有待决策的人');
  assert.deepEqual(page.__errors, [], '对手动作落地不应报错：' + page.__errors.join(' | '));
  await page.close();
});

test('出牌会播报牌名并播音效（Audio 真的被调到）', async () => {
  const page = await newPage(browser, srv.origin, { width: 1440, height: 900 });
  await enterGuest(page);
  await page.evaluate(() => {
    window.__audioCalls = [];
    const A = window.HongheAudio;
    const rawDiscard = A.discardTile;
    A.discardTile = (id, o) => { window.__audioCalls.push({ kind: 'discard', word: A.tileWord(id) }); return rawDiscard(id, Object.assign({}, o, { voice: false })); };
    const rawClaim = A.claim;
    A.claim = (k) => { window.__audioCalls.push({ kind: 'claim', claim: k }); return rawClaim(k); };
  });
  await startOnline(page, { mySeat: 0, humanCount: 2 });

  await page.waitForFunction(() => {
    const d = window.__shipingMahjongDebug();
    return d && d.phase === 'discard' && d.current === 0;
  }, null, { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#hand-tiles .tile-face').click());
  await page.waitForFunction(() => (window.__audioCalls || []).length > 0, null, { timeout: 8000 });

  const calls = await page.evaluate(() => window.__audioCalls);
  assert.ok(calls.length >= 1, '出牌应该触发声音层');
  const first = calls.find((c) => c.kind === 'discard');
  assert.ok(first, '至少有一次出牌音效');
  assert.match(first.word, /^[一二三四五六七八九][万筒条]$|^[东南西北中发白]风?$|红中|发财|白板$/,
    '牌名要读得出来，实际：' + first.word);
  await page.close();
});
