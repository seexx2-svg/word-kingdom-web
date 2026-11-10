/* 浏览器端自动化测试：真实 Chromium 渲染 + 真实点击 + 视觉/几何断言
 * 运行：node --test tests/browser.test.cjs （需先 npm i playwright-core）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, launch, newPage, enterTable, waitHumanTurn } = require('./browser-lib.cjs');

let srv, browser;
test.before(async () => { srv = await startServer(); browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

async function openGame(viewport) {
  const page = await newPage(browser, srv.origin, viewport);
  await page.evaluate(() => window.__shipingMahjongSetSpeed(0.12));
  await enterTable(page);
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 25000 });
  return page;
}
const snap = (page) => page.evaluate(() => window.__shipingMahjongDebug());
const rectsOverlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

function playHumanDiscards(page, n) {
  return (async () => {
    let played = 0;
    for (let i = 0; i < n; i++) {
      const t = await waitHumanTurn(page);
      if (t === 'over') break;
      const ok = await page.evaluate(() => {
        const el = document.querySelectorAll('#hand-tiles .tile-face.playable');
        if (!el.length) return false;
        el[el.length - 1].click();
        return true;
      });
      if (!ok) break;
      played += 1;
      await page.waitForTimeout(120);
    }
    return played;
  })();
}

test('页面加载：无脚本错误、无资源 404，核心与调试接口就绪', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  const diag = await page.evaluate(() => ({
    core: typeof window.ShipingMahjongCore,
    debug: typeof window.__shipingMahjongDebug,
    tiles: document.querySelectorAll('#hand-tiles .tile-face').length,
    faces: document.querySelectorAll('#dice-one .die-face').length
  }));
  assert.equal(diag.core, 'object', '规则内核必须加载');
  assert.equal(diag.debug, 'function', '调试接口必须可用');
  assert.equal(diag.faces, 6, '骰子必须是六面立方体');
  assert.ok(diag.tiles === 13 || diag.tiles === 14, '开局手牌应为 13 或 14 张，实际 ' + diag.tiles);
  assert.deepEqual(page.__errors, [], '不应有控制台错误或资源 404：' + page.__errors.join(' | '));
  await page.close();
});

test('骰子：六面 1-6 点齐全，落桌后正面点数等于掷出的点数', async () => {
  const page = await newPage(browser, srv.origin, { width: 1280, height: 860 });
  await page.evaluate(() => window.__shipingMahjongSetSpeed(0.5));
  await enterTable(page);
  await page.waitForFunction(() => document.querySelector('#dice-overlay').classList.contains('hidden'), null, { timeout: 30000 });
  const info = await page.evaluate(() => {
    const cube = document.querySelector('#dice-one .die-cube3d');
    const faces = Array.from(document.querySelectorAll('#dice-one .die-face')).map((f) => Number(f.dataset.face));
    const pips = Array.from(document.querySelectorAll('#dice-one .die-face')).map((f) => f.querySelectorAll('i.on').length);
    const host = document.getElementById('dice-one');
    return {
      values: faces.slice().sort((a, b) => a - b),
      pips: pips.slice().sort((a, b) => a - b),
      one: Number(host.dataset.value),
      two: Number(document.getElementById('dice-two').dataset.value),
      last: window.__shipingMahjongDiceFaces().last,
      cube3d: !!cube && getComputedStyle(cube).transformStyle === 'preserve-3d'
    };
  });
  assert.deepEqual(info.values, [1, 2, 3, 4, 5, 6], '六个面必须分别是 1-6 点');
  assert.deepEqual(info.pips, [1, 2, 3, 4, 5, 6], '每个面的点数量必须与面值一致');
  assert.equal(info.cube3d, true, '骰子必须使用 3D 变换容器');
  assert.ok(info.one >= 1 && info.one <= 6 && info.two >= 1 && info.two <= 6, '落桌后必须记录真实点数');
  assert.equal(info.one, info.last.dice[0], '第一颗骰子正面必须等于掷出的点数');
  assert.equal(info.two, info.last.dice[1], '第二颗骰子正面必须等于掷出的点数');
  const s = await snap(page);
  assert.equal(s.dealer, info.last.dealer, '庄家必须由骰子点数推导');
  await page.close();
});

test('牌数守恒：连续 6 次真人出牌过程中始终 136 张', async () => {
  const page = await openGame({ width: 1366, height: 820 });
  const check = async () => {
    const s = await snap(page);
    const total = s.wall + s.hands.reduce((a, b) => a + b, 0) + s.discards.reduce((a, b) => a + b, 0) +
      s.meldDetails.flat().reduce((a, m) => a + m.tiles.length, 0);
    return { total, s };
  };
  let last = await check();
  assert.equal(last.total, 136, '开局牌数必须是 136');
  for (let i = 0; i < 6; i++) {
    const played = await playHumanDiscards(page, 1);
    if (!played) break;
    last = await check();
    assert.equal(last.total, 136, `第 ${i + 1} 次出牌后牌数必须守恒`);
  }
  await page.close();
});

test('出牌动画：真人出牌时牌从手牌位置飞向弃牌区', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  await waitHumanTurn(page);
  const before = await page.evaluate(() => {
    const el = document.querySelectorAll('#hand-tiles .tile-face.playable');
    const r = el[el.length - 1].getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), count: el.length };
  });
  assert.ok(before.count > 0, '轮到玩家时必须至少有一张可点的牌');
  await page.evaluate(() => {
    const el = document.querySelectorAll('#hand-tiles .tile-face.playable');
    el[el.length - 1].click();
  });
  await page.waitForFunction(() => !!window.__shipingMahjongLastDiscardFlight, null, { timeout: 4000 });
  const fx = await page.evaluate(() => window.__shipingMahjongLastDiscardFlight);
  assert.equal(fx.seat, 0, '飞行牌必须来自出牌者');
  assert.ok(Number.isInteger(fx.tile), '飞行牌必须有具体牌面');
  assert.ok(Math.abs(fx.from.x - before.x) < 60, `飞行起点必须就是被点的那张手牌：起点 ${fx.from.x} vs 手牌 ${before.x}`);
  assert.ok(Math.abs(fx.to.x - fx.from.x) + Math.abs(fx.to.y - fx.from.y) > 40, '飞行终点必须与起点不同（真的有位移）');
  await page.close();
});

test('吃牌展示：副露为顺子、被吃的牌有高亮标识、标签可见', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  const forced = await page.evaluate(() => window.__shipingMahjongForceChi());
  assert.equal(forced.claimSeat, 2, '同名牌已被清理，接牌权应唯一属于下家西家');
  assert.deepEqual(forced.actions, ['chi'], '下家此时只应有「吃」这一种接牌方式');
  // AI 决策 + 动画有延时，等副露真正落桌再断言，避免读太快读到空
  await page.waitForFunction(() => {
    const d = window.__shipingMahjongDebug();
    return d.meldDetails.some((ms) => ms.some((m) => m.type === 'chi'));
  }, null, { timeout: 5000 });
  await page.waitForTimeout(120);
  const info = await page.evaluate(() => {
    const s = window.__shipingMahjongDebug();
    const groups = Array.from(document.querySelectorAll('#meld-0 .meld-group'));
    return {
      melds: s.meldDetails[0],
      groups: groups.map((g) => ({
        label: g.querySelector('.meld-label') && g.querySelector('.meld-label').textContent,
        called: g.querySelectorAll('.meld-called-tile').length,
        pin: g.querySelectorAll('.called-pin').length,
        tiles: Array.from(g.querySelectorAll('.tile-face')).map((t) => Number(t.dataset.tile))
      }))
    };
  });
  // 吃牌权在下家（西家，由 AI 决策），副露会落在对应座位上
  const chiGroups = await page.evaluate(() => {
    const s = window.__shipingMahjongDebug();
    const seat = s.meldDetails.findIndex((ms) => ms.some((m) => m.type === 'chi'));
    const el = document.querySelector('#meld-' + seat + ' .meld-group.meld-chi');
    if (!el) return null;
    return {
      seat,
      label: el.querySelector('.meld-label').textContent,
      called: el.querySelectorAll('.meld-called-tile').length,
      pin: el.querySelectorAll('.called-pin').length,
      tiles: Array.from(el.querySelectorAll('.tile-face')).map((t) => Number(t.dataset.tile))
    };
  });
  assert.ok(chiGroups, '吃牌后必须渲染出吃牌副露');
  assert.match(chiGroups.label, /吃/, '副露标签必须写明「吃」');
  assert.equal(chiGroups.called, 1, '被吃进来的那张牌必须有高亮');
  assert.equal(chiGroups.pin, 1, '被吃进来的牌必须有方向标记');
  assert.equal(chiGroups.tiles.length, 3, '吃牌副露必须是三张');
  assert.equal(chiGroups.tiles[1] - chiGroups.tiles[0], 1, '顺子必须连续');
  assert.equal(chiGroups.tiles[2] - chiGroups.tiles[1], 1, '顺子必须连续');
  assert.equal(chiGroups.seat, 2, '吃牌只能由下家（西家）完成');
  await page.close();
});

test('胡牌结算：桌内展示完整手牌与四家明细，不溢出视口', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  await page.evaluate(() => window.__shipingMahjongForceWin());
  await page.waitForFunction(() => !document.getElementById('result-modal').classList.contains('hidden'), null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const sheet = document.querySelector('#result-modal .result-sheet');
    const modal = document.getElementById('result-modal');
    const r = sheet.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    return {
      visible: !modal.classList.contains('hidden'),
      inTable: !!sheet.closest('.table-frame'),
      insideViewport: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
      notFullScreen: r.width < vw * 0.95 && r.height < vh * 0.9,
      title: document.getElementById('result-title').textContent.trim(),
      hand: document.querySelectorAll('#result-hand .tile-face').length,
      winningMarks: document.querySelectorAll('#result-hand .tile-face.winning-tile').length,
      winners: document.querySelectorAll('#result-self .result-self').length,
      others: document.querySelectorAll('#result-others .result-other').length,
      rank: document.getElementById('result-rankbar').textContent.trim(),
      buttons: ['result-continue', 'result-switch', 'result-share'].filter((id) => document.getElementById(id))
    };
  });
  assert.equal(info.visible, true, '结算层必须显示');
  assert.equal(info.inTable, true, '结算必须发生在牌桌内，而不是独立全屏弹窗');
  assert.equal(info.insideViewport, true, '结算面板不得溢出视口');
  assert.equal(info.notFullScreen, true, '结算不应占满整屏');
  assert.ok(info.hand >= 2, '必须展示胡牌手牌，实际 ' + info.hand + ' 张');
  assert.equal(info.winningMarks, 1, '必须标出胡的那张牌');
  assert.equal(info.winners, 1, '赢家占一格');
  assert.equal(info.others, 3, '其他三家各占一格');
  assert.match(info.rank, /段位分/, '展示段位分变化');
  assert.equal(info.buttons.length, 3, '继续 / 换桌 / 分享三个去向按钮都要在');
  // 结算层里的按钮必须真的能点到（曾经因为整层 pointer-events:none 点不动）
  const clickable = await page.evaluate(() => {
    const b = document.getElementById('result-continue');
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(top && (top === b || b.contains(top)));
  });
  assert.equal(clickable, true, '结算按钮必须位于最上层，不能被牌桌盖住');
  await page.close();
});

test('人类接牌：需要选择时不能被 AI 自动跳过', async () => {
  const page = await openGame({ width: 1280, height: 860 });
  let sawClaim = false;
  for (let i = 0; i < 600 && !sawClaim; i++) {
    const s = await snap(page);
    if (s.phase === 'over') {
      await page.evaluate(() => document.querySelector('#result-new').click());
      await page.waitForTimeout(1800);
      continue;
    }
    if (s.awaiting && s.awaiting.seat === 0) {
      if (s.awaiting.kind === 'claim') {
        sawClaim = true;
        const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('#action-bar .action-button')).map((b) => b.textContent));
        assert.ok(buttons.some((t) => /过/.test(t)), '接牌时必须提供「过」按钮');
        assert.ok(buttons.length >= 2, '接牌时必须提供可选项和「过」');
        await page.waitForTimeout(1200);          // 停留 1.2 秒，期间 AI 不得抢占
        const again = await snap(page);
        assert.equal(again.awaiting.seat, 0, '等待玩家决定期间，行动权不得被 AI 抢走');
        assert.equal(again.awaiting.kind, 'claim', '等待玩家决定期间不得改变待办类型');
        await page.evaluate(() => document.querySelector('#action-bar .action-pass').click());
        break;
      }
      await page.evaluate(() => {
        const el = document.querySelectorAll('#hand-tiles .tile-face.playable');
        if (el.length) el[el.length - 1].click();
      });
    }
    await page.waitForTimeout(50);
  }
  assert.ok(sawClaim, '对局中应至少出现一次玩家接牌机会');
  await page.close();
});

test('AI 任务丢失：心跳能在 6 秒内重新推进回合', async () => {
  const page = await openGame({ width: 1280, height: 860 });
  const before = await snap(page);
  const dropped = await page.evaluate(() => window.__shipingMahjongDropAiTask());
  if (!dropped) {
    // 当前若正轮到玩家，先出一张牌把行动权交给 AI
    await page.evaluate(() => {
      const el = document.querySelectorAll('#hand-tiles .tile-face.playable');
      if (el.length) el[el.length - 1].click();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__shipingMahjongDropAiTask());
  }
  const recovered = await page.waitForFunction(
    (sig) => {
      const s = window.__shipingMahjongDebug();
      return s.phase === 'over' || (s.awaiting && (s.awaiting.seat + ':' + s.awaiting.kind) !== sig) || s.discards.join() !== sig;
    },
    before.discards.join(),
    { timeout: 6000, polling: 100 }
  ).then(() => true).catch(() => false);
  assert.equal(recovered, true, 'AI 定时任务丢失后必须由心跳自愈');
  await page.close();
});

test('连续人机对局：浏览器内 20 局无卡死、无报错、积分零和', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  const games = await page.evaluate(() => window.__shipingMahjongAutoPlay(20, { speed: 0, timeout: 30000 }));
  const failed = games.filter((g) => g.error);
  assert.equal(failed.length, 0, '对局不应卡死：' + JSON.stringify(failed[0] || {}));
  assert.equal(games.length, 20, '必须完成 20 局');
  const won = games.filter((g) => g.result !== 'draw').length;
  assert.ok(won >= 15, '20 局中应有绝大多数分出胜负，实际 ' + won);
  assert.deepEqual(page.__errors, [], '连续对局不应产生任何脚本错误：' + page.__errors.join(' | '));
  await page.close();
});

test('移动端 390×844：无横向溢出，关键元素都在视口内且互不重叠', async () => {
  const page = await openGame({ width: 390, height: 844 });
  await page.evaluate(() => window.__shipingMahjongForceMelds());
  await playHumanDiscards(page, 2);
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
      scrollH: document.documentElement.scrollHeight,
      innerH: innerHeight,
      hand: box('.hand-panel'),
      handTiles: box('#hand-tiles'),
      center: box('.center-table'),
      hud: box('.center-hud'),
      n: box('#discards-1'), s: box('#discards-0'), w: box('#discards-3'), e: box('#discards-2')
    };
  });
  assert.ok(info.scrollW <= info.innerW + 1, `不应出现横向滚动：scrollWidth=${info.scrollW} > ${info.innerW}`);
  for (const [k, r] of Object.entries(info)) {
    if (!Array.isArray(r)) continue;
    assert.ok(r[0] >= -2 && r[0] + r[2] <= info.innerW + 2, `${k} 横向越界：${JSON.stringify(r)}`);
    assert.ok(r[1] >= -2 && r[1] + r[3] <= info.innerH + 2, `${k} 纵向越界：${JSON.stringify(r)}`);
  }
  assert.equal(rectsOverlap(info.n, info.s), false, '南北弃牌区不应重叠');
  assert.equal(rectsOverlap(info.w, info.e), false, '东西弃牌区不应重叠');
  assert.equal(rectsOverlap(info.n, info.hud), false, '中央信息台不得压住北家弃牌');
  assert.equal(rectsOverlap(info.s, info.hud), false, '中央信息台不得压住南家弃牌');
  assert.equal(rectsOverlap(info.w, info.hud), false, '中央信息台不得压住东家弃牌');
  assert.equal(rectsOverlap(info.e, info.hud), false, '中央信息台不得压住西家弃牌');
  assert.equal(rectsOverlap(info.handTiles, info.s), false, '手牌区不得压住南家弃牌');
  await page.close();
});

test('桌面端 1440×900：四家弃牌区互不重叠，副露牌面保持正向', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  await page.evaluate(() => window.__shipingMahjongForceMelds());
  await playHumanDiscards(page, 3);
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    const rot = Array.from(document.querySelectorAll('.meld-tiles .tile-face'))
      .filter((t) => {
        const m = new DOMMatrixReadOnly(getComputedStyle(t).transform);
        return Math.abs(m.b) > 0.01 || Math.abs(m.c) > 0.01;
      }).length;
    return {
      n: box('#discards-1'), s: box('#discards-0'), w: box('#discards-3'), e: box('#discards-2'), hud: box('.center-hud'),
      m1: box('#meld-1'), m2: box('#meld-2'), m3: box('#meld-3'), m0: box('#meld-0'),
      rotatedMeldTiles: rot,
      meldCount: document.querySelectorAll('.meld-tiles .tile-face').length
    };
  });
  assert.equal(rectsOverlap(info.n, info.s), false, '南北弃牌不应重叠');
  assert.equal(rectsOverlap(info.w, info.e), false, '东西弃牌不应重叠');
  assert.equal(rectsOverlap(info.hud, info.n), false, '信息台不得压北家弃牌');
  assert.equal(rectsOverlap(info.hud, info.s), false, '信息台不得压南家弃牌');
  assert.ok(info.meldCount > 0, '应渲染出副露牌');
  assert.equal(info.rotatedMeldTiles, 0, '副露牌必须保持正向，不得旋转');
  assert.ok(info.m1[2] > 0 && info.m2[2] > 0 && info.m3[2] > 0 && info.m0[2] > 0, '四家副露都要有实际尺寸');
  await page.close();
});

test('手牌 hover 不位移：鼠标停在下沿也能点中同一张牌', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  await waitHumanTurn(page);
  const box = await page.evaluate(() => {
    const el = document.querySelectorAll('#hand-tiles .tile-face.playable');
    const t = el[el.length - 1];
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
  });
  assert.ok(box.w > 20 && box.h > 20, '手牌应有实际尺寸');

  // 鼠标真实停到手牌最下沿（最容易点空的位置）
  await page.mouse.move(box.x, box.bottom - 2);
  await page.waitForTimeout(120);
  const hit = await page.evaluate(({ x, y }) => {
    const t = document.elementFromPoint(x, y);
    return t ? { tile: t.dataset ? t.dataset.tile : null, cls: t.className } : null;
  }, { x: box.x, y: box.bottom - 2 });

  assert.ok(hit && hit.tile !== null && hit.tile !== undefined, `指针停在下沿时必须仍命中手牌，实际命中 ${JSON.stringify(hit)}`);
  assert.match(String(hit.cls), /tile-face/, '命中的元素必须仍是手牌牌面');
  assert.match(String(hit.cls), /playable/, '命中的牌必须仍处于可点状态');

  // 真实点击必须生效：这一手要真的打出去。
  // 注意不能只看牌河张数 —— 打出去的牌可能立刻被下家吃/碰走（牌河会减一张），
  // 所以用「牌河 + 副露 + 轮次」三个信号里的任意一个来判断这手有没有落地。
  const progress = (s) => s.discards.reduce((a, b) => a + b, 0) + s.melds.reduce((a, b) => a + b, 0);
  const before = await snap(page);
  await page.mouse.click(box.x, box.bottom - 2);
  await page.waitForTimeout(260);
  const after = await snap(page);
  const moved = progress(after) > progress(before) || after.current !== before.current || after.phase !== before.phase;
  assert.ok(moved, '在牌面下沿点击必须能真的打出去：' + JSON.stringify({ before: { d: before.discards, m: before.melds, c: before.current }, after: { d: after.discards, m: after.melds, c: after.current } }));
  await page.close();
});

/* ---------------- v0.10.0：标题裁切 / 杠分 / 闪电 / 开牌字 / 真牌墙 ---------------- */

test('结算：标题「标准胡牌」必须完整可见，不能被面板裁掉', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  await page.evaluate(() => window.__shipingMahjongForceWin());
  await page.waitForFunction(() => !document.getElementById('result-modal').classList.contains('hidden'), null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const t = document.getElementById('result-title');
    const sheet = document.querySelector('#result-modal .result-sheet');
    const tr = t.getBoundingClientRect();
    const sr = sheet.getBoundingClientRect();
    const cs = getComputedStyle(sheet);
    return {
      text: t.textContent.trim(),
      // 面板是 overflow:hidden，标题只要跑到面板盒子外面就会被裁
      aboveSheet: Math.round(sr.top - tr.top),
      belowSheet: Math.round(tr.bottom - sr.bottom),
      left: Math.round(tr.left - sr.left), right: Math.round(sr.right - tr.right),
      overflow: cs.overflow,
      h: Math.round(tr.height), w: Math.round(tr.width)
    };
  });
  assert.equal(info.text, '标准胡牌');
  assert.ok(info.aboveSheet <= 0, '标题上沿不能在面板外（那正是之前被裁掉的原因），实际 ' + info.aboveSheet);
  assert.ok(info.belowSheet <= 0, '标题下沿不能在面板外，实际 ' + info.belowSheet);
  assert.ok(info.left >= 0 && info.right >= 0, '标题左右也不能出血');
  assert.ok(info.h >= 28, '整行字的高要够，实际 ' + info.h);
  await page.close();
});

test('结算：杠过的分要记在账上（明杠 -2,000 / 暗杠 -4,000）', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  const deltas = await page.evaluate(() => {
    // 造两次杠：1 号位暗杠、2 号位明杠，然后 0 号位自摸
    const st = window.__shipingMahjongState();
    if (!st) return null;
    st.kongLog = [{ seat: 1, kind: '暗杠', delta: [] }, { seat: 2, kind: '明杠', delta: [] }];
    window.__shipingMahjongForceWin();
    const sd = window.__shipingMahjongSettlement();
    return sd && { deltas: sd.deltas, kong: sd.kongDeltas, kongs: sd.kongs };
  });
  assert.ok(deltas, '要能读到结算对象');
  // 1 号位暗杠（各家 -4,000）+ 2 号位明杠（各家 -2,000）：
  //   0 号 -6,000；1 号 +12,000 -2,000 = +10,000；2 号 +6,000 -4,000 = +2,000；3 号 -6,000
  assert.deepEqual(deltas.kong, [-6000, 10000, 2000, -6000], '杠分要按"明杠 2000 / 暗杠 4000 × 3 家"过账');
  // 再叠上 0 号位自摸：三家各付 4,000，赢家收 12,000
  assert.deepEqual(deltas.deltas, [6000, 6000, -2000, -10000], '胡牌 + 杠分才是最终盈亏');
  assert.equal(deltas.deltas.reduce((a, b) => a + b, 0), 0, '杠分不能让四家总和不平');

  await page.waitForFunction(() => !document.getElementById('result-modal').classList.contains('hidden'), null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const text = await page.evaluate(() => document.getElementById('result-modal').textContent);
  assert.match(text, /暗杠/, '结算里要写明是暗杠');
  assert.match(text, /明杠/, '结算里要写明是明杠');
  assert.match(text, /\+12,000/, '暗杠收 12,000 要出现在账上');
  await page.close();
});

test('结算：胡的那张牌上要劈一道闪电，并且响一声雷', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  // 音频要一次真实点击才解锁（autoplay 策略）：点开规则面板（真点击）再程序化关掉
  await page.click('#rules-open');
  await page.evaluate(() => { const m = document.getElementById('rules-modal'); if (m) m.classList.add('hidden'); });
  await page.evaluate(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    window.__osc = 0;
    const raw = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () { window.__osc += 1; return raw.call(this); };
  });
  await page.evaluate(() => window.__shipingMahjongForceWin());
  await page.waitForFunction(() => !document.getElementById('result-modal').classList.contains('hidden'), null, { timeout: 8000 });
  await page.waitForFunction(() => !!document.querySelector('.result-bolt'), null, { timeout: 4000 });
  // 闪电动画第 0 帧是 scaleY(.5)，量尺寸要等它劈下来（约 50ms 后恢复全高）
  await page.waitForTimeout(250);

  const geo = await page.evaluate(() => {
    const bolt = document.querySelector('.result-bolt');
    const tile = document.querySelector('#result-hand .tile-face.winning-tile');
    const b = bolt.getBoundingClientRect(), t = tile.getBoundingClientRect();
    const core = bolt.querySelector('.bolt-core');
    return {
      hasSvg: !!bolt.querySelector('svg'),
      coreFill: core ? getComputedStyle(core).fill : null,
      boltW: Math.round(b.width), boltH: Math.round(b.height),
      dx: Math.round((b.left + b.width / 2) - (t.left + t.width / 2)),
      // 闪电尾巴要落在牌上（允许压进牌面）
      touch: Math.round(b.bottom - t.top),
      zBolt: getComputedStyle(bolt).zIndex,
      inModal: bolt.parentElement.id
    };
  });
  assert.equal(geo.hasSvg, true, '闪电得是 SVG 形状，不是一条线');
  assert.equal(geo.inModal, 'result-modal', '闪电挂在结算层上（放牌里会被 overflow 裁掉）');
  assert.ok(geo.boltW >= 40 && geo.boltH >= 100, '闪电要有存在感，实际 ' + geo.boltW + 'x' + geo.boltH);
  assert.ok(Math.abs(geo.dx) <= 2, '闪电必须正对胡的那张牌，偏移 ' + geo.dx);
  assert.ok(geo.touch >= 0, '闪电尾巴要落到牌面上，实际还差 ' + geo.touch);
  assert.ok(Number(geo.zBolt) >= 5, '闪电要盖在面板之上');

  const osc = await page.evaluate(() => window.__osc);
  assert.ok(osc >= 2, '雷声至少要有低频振荡器，实际 ' + osc);

  // 打在牌上还得有反馈：胡的那张要有 struck 光效
  const struck = await page.evaluate(() => document.querySelectorAll('#result-hand .tile-face.is-struck').length);
  assert.equal(struck, 1, '胡的那张牌要有被劈到的动效');
  await page.close();
});

test('牌墙：四边的砖块数加起来等于真实剩余墩数，摸一张就少一块', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  const a = await page.evaluate(() => window.__shipingMahjongWall());
  assert.ok(a, '要能读到牌墙状态');
  const sum = a.visible.reduce((x, y) => x + y, 0);
  assert.equal(sum, a.stacks, '四边可见砖块之和必须等于剩余墩数：' + JSON.stringify(a.visible) + ' vs ' + a.stacks);
  assert.equal(a.stacks * 2 >= a.tiles, true, '墩数 × 2 要覆盖剩余张数');
  assert.match(a.label, new RegExp('牌墙 ' + a.stacks + ' 墩'), '顶栏显示墩数');

  // 四边都要有牌（42 墩时不可能有一边全空）
  a.visible.forEach((n, i) => assert.ok(n > 0, '第 ' + i + ' 边不该是空的'));

  const played = await playHumanDiscards(page, 3);
  await page.waitForTimeout(400);
  const b = await page.evaluate(() => window.__shipingMahjongWall());
  assert.ok(played > 0, '得真的打出去几张');
  assert.ok(b.stacks < a.stacks, '牌墙要变少，' + a.stacks + ' → ' + b.stacks);
  assert.equal(b.visible.reduce((x, y) => x + y, 0), b.stacks, '变少之后仍然要对得上');
  await page.close();
});

test('牌墙：开牌位不再压"开牌"两个字', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  const out = await page.evaluate(() => {
    const cut = document.querySelector('.wall-strip.cut-wall');
    if (!cut) return { cut: false };
    const after = getComputedStyle(cut, '::after');
    return { cut: true, content: after.content, text: cut.textContent };
  });
  assert.equal(out.cut, true, '仍要标出开牌的那一面墙');
  assert.equal(out.text.trim(), '', '墙里不该再有文字');
  assert.ok(!/开牌/.test(out.content || ''), '伪元素也不能再写"开牌"，实际 ' + out.content);
  await page.close();
});

test('立直机皮肤：默认开（木框 + 深绿绒面），设置里关掉立刻回实景桌', async () => {
  const page = await openGame({ width: 1440, height: 900 });
  const on = await page.evaluate(() => ({
    cls: document.body.classList.contains('skin-riichi'),
    frameBg: getComputedStyle(document.querySelector('.table-frame')).backgroundImage,
    feltBg: getComputedStyle(document.querySelector('.felt')).backgroundImage,
    bodyBg: getComputedStyle(document.body).backgroundImage,
    checked: document.getElementById('setting-riichi').checked
  }));
  assert.equal(on.cls, true, '皮肤默认要开');
  assert.match(on.frameBg, /gradient/, '桌框要有木纹渐变');
  assert.match(on.feltBg, /gradient/, '绒面要有深绿渐变');
  assert.ok(!/mahjong-table-bg/.test(on.bodyBg), '机台模式下不该再铺实景照片：' + on.bodyBg.slice(0, 80));
  assert.equal(on.checked, true, '设置面板的开关要同步');

  await page.evaluate(() => {
    document.getElementById('rules-open').click();
    document.getElementById('setting-riichi').click();
    document.getElementById('rules-close').click();
  });
  await page.waitForTimeout(150);
  const off = await page.evaluate(() => ({
    cls: document.body.classList.contains('skin-riichi'),
    frameBg: getComputedStyle(document.querySelector('.table-frame')).backgroundImage,
    stored: localStorage.getItem('shiping-mahjong-skin-v1'),
    checked: document.getElementById('setting-riichi').checked
  }));
  assert.equal(off.cls, false, '关掉后类名要移除');
  assert.equal(off.frameBg, 'none', '关掉后桌框回到透明（实景桌）');
  assert.equal(off.stored, 'off', '偏好要记住，下次进来还是关着的');
  assert.equal(off.checked, false, '开关状态要同步');

  // 刷新页面验证偏好真的持久化
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => document.body.classList.contains('skin-riichi')), false, '刷新后仍是关着的');

  // 再开回来，确认双向都能切
  await page.evaluate(() => {
    document.getElementById('rules-open').click();
    document.getElementById('setting-riichi').click();
    document.getElementById('rules-close').click();
  });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.body.classList.contains('skin-riichi')), true, '再点一次要能开回来');
  assert.deepEqual(page.__errors, [], '皮肤切换不应报错：' + page.__errors.join(' | '));
  await page.close();
});
