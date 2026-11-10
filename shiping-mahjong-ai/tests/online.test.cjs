'use strict';
/* 联机层单测：座位旋转是否等价、动作日志换算是否互逆、牌名读法是否正确
 *
 * 这一组测试的真正目的只有一个：证明「每台设备把自己当成 0 号位」这件事
 * 不会把规则算歪。只要旋转等价成立，联机就能直接复用单机的牌桌与规则。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { C, seeded } = require('./helpers.cjs');
const Online = require('../js/online.js');
const Audio = require('../js/audio.js');
const Net = require('../js/net.js');

const g2l = (seat, me) => Online.localOf(seat, me);
const l2g = (seat, me) => Online.globalOf(seat, me);

test('座位环与内核一致：NEXT_SEAT 必须就是 0→2→1→3→0', () => {
  const cycle = [0];
  let s = 0;
  for (let i = 0; i < 3; i++) { s = C.nextSeat(s); cycle.push(s); }
  assert.deepEqual(cycle, Online.CYCLE, '内核座位顺序变了，online.js 的 CYCLE 要跟着改');
});

/** 把一局状态写成"全局座位视角"的指纹，用来比较两局是否等价 */
function fingerprintGlobal(s) {
  return JSON.stringify({
    hands: s.hands.map((h) => h.join(',')),
    discards: s.discards.map((d) => d.join(',')),
    melds: s.melds.map((m) => m.map((x) => x.tiles.join('.') + (x.kind || '')).join('|')),
    scores: s.scores.slice(),
    dealer: s.dealer,
    current: s.current,
    wall: s.wall.length,
    phase: s.phase,
    turn: s.turnCount,
    last: s.lastDiscard ? [s.lastDiscard.from, s.lastDiscard.tile] : null
  });
}

/** 旋转过的局要按"本地 → 全局"读一遍才能和原局比 */
function fingerprintRotated(s, shift) {
  const at = (g) => g2l(g, shift);
  const out = { hands: [], discards: [], melds: [], scores: [] };
  for (let g = 0; g < 4; g++) {
    const l = at(g);
    out.hands.push(s.hands[l].join(','));
    out.discards.push(s.discards[l].join(','));
    out.melds.push(s.melds[l].map((x) => x.tiles.join('.') + (x.kind || '')).join('|'));
    out.scores.push(s.scores[l]);
  }
  return JSON.stringify({
    hands: out.hands,
    discards: out.discards,
    melds: out.melds,
    scores: out.scores,
    dealer: l2g(s.dealer, shift),
    current: l2g(s.current, shift),
    wall: s.wall.length,
    phase: s.phase,
    turn: s.turnCount,
    last: s.lastDiscard ? [l2g(s.lastDiscard.from, shift), s.lastDiscard.tile] : null
  });
}

test('座位旋转等价：同一个种子转 k 位后，AI 全部走完仍与原局一致', () => {
  for (const seed of [1, 7, 2026]) {
    for (const shift of [0, 1, 2, 3]) {
      const base = C.createGame({}, seeded(seed));
      const moved = C.createGame({}, seeded(seed));
      Online.rotate(moved, shift);

      let steps = 0;
      while (steps < 500) {
        const a = C.awaiting(base);
        const b = C.awaiting(moved);
        assert.ok(a && b, 'seed=' + seed + ' shift=' + shift + ' 两局都应处于可行动状态');
        assert.equal(b.seat, g2l(a.seat, shift), '种子 ' + seed + ' 旋转 ' + shift + ' 位后当前座位对不上');

        const dBase = C.aiDecide(base, a.seat);
        const dMoved = C.aiDecide(moved, b.seat);
        assert.equal(dMoved.kind, dBase.kind, '决策类型应一致');
        if (dBase.kind === 'discard') {
          assert.equal(dMoved.index, dBase.index, 'AI 该打同一张牌');
        }

        C.applyDecision(base, dBase);
        C.applyDecision(moved, dMoved);
        steps += 1;

        assert.equal(fingerprintRotated(moved, shift), fingerprintGlobal(base),
          'seed=' + seed + ' shift=' + shift + ' 第 ' + steps + ' 步后局面分叉');

        if (base.phase === C.PHASES.OVER) break;
      }
      assert.ok(steps > 5, '至少要真的走了几步，seed=' + seed);
    }
  }
});

test('旋转后 0 号位就是自己：手牌张数对得上，庄家标记跟着走', () => {
  const s = C.createGame({}, seeded(42));
  const dealerGlobal = s.dealer;
  const mySeat = 2;
  Online.rotate(s, mySeat);
  assert.equal(s.dealer, g2l(dealerGlobal, mySeat), '庄家要转到本地视角');
  if (dealerGlobal === mySeat) {
    assert.equal(s.hands[0].length, 14, '我坐庄就该有 14 张');
  } else {
    assert.equal(s.hands[0].length, 13, '我是闲家就该有 13 张');
  }
});

test('座位换算互逆：本地↔全局来回换算不变', () => {
  const N4 = ['甲', '乙', '丙', '丁'];
  for (const mySeat of [0, 1, 2, 3]) {
    Online.begin({ roomId: 'r', seed: 1, mySeat, humanCount: 4, names: N4 });
    for (let g = 0; g < 4; g++) {
      assert.equal(Online.toGlobal(Online.toLocal(g)), g, 'mySeat=' + mySeat + ' 全局 ' + g);
    }
    assert.equal(Online.toLocal(mySeat), 0, '自己永远是本地 0 号位');
    // 本地视角下 0 号位必须是自己，而不是"坐在全局 0 号位的那个人"
    assert.equal(Online.nameOf(0), N4[mySeat], 'mySeat=' + mySeat + ' 的 0 号位应该是自己');
    for (let s = 0; s < 4; s++) assert.equal(Online.isHumanSeat(s), true, '四人局四个位子都是真人');
    Online.end();
  }

  // 两人局：我只和另一个真人坐，剩下两个位子由电脑补
  Online.begin({ roomId: 'r', seed: 1, mySeat: 1, humanCount: 2, names: ['甲', '乙'] });
  assert.equal(Online.isHumanSeat(0), true);
  assert.equal(Online.isHumanSeat(1), true);
  assert.equal(Online.isHumanSeat(2), false, '第三席开始是电脑');
  assert.equal(Online.nameOf(0), '乙', '我坐全局 1 号位，本地 0 号位就是乙');
  assert.equal(Online.nameOf(1), '甲', '坐在我下家的全局 0 号位是甲');
  assert.equal(Online.nameOf(2), Online.AI_NAMES[2], '第三席是电脑，名字取电脑名册');
  Online.end();
});

test('昵称：系统分配的名字是 2-4 个汉字，改过的名字会被记住', () => {
  for (let i = 0; i < 40; i++) {
    const n = Net.randomNick();
    assert.ok(n.length >= 2 && n.length <= 5, '随机昵称长度异常：' + n);
    assert.ok(/^[\u4e00-\u9fa5]+[0-9]*$/.test(n), '随机昵称应只含汉字与可选数字：' + n);
  }
  assert.equal(Net.setNick('石屏老张'), '石屏老张');
  assert.equal(Net.nick(), '石屏老张');
  assert.equal(Net.setNick('一二三四五六七八九十十一'), '一二三四五六七八九十十一'.slice(0, 12), '昵称要截断到 12 字');
});

test('牌名读法：万 / 筒 / 条 / 字牌都要读得出来', () => {
  assert.equal(Audio.tileWord(3), '四万');
  assert.equal(Audio.tileWord(0), '一万');
  assert.equal(Audio.tileWord(8), '九万');
  assert.equal(Audio.tileWord(9), '一筒');
  assert.equal(Audio.tileWord(12), '四筒');
  assert.equal(Audio.tileWord(17), '九筒');
  assert.equal(Audio.tileWord(18), '一条');
  assert.equal(Audio.tileWord(26), '九条');
  assert.equal(Audio.tileWord(27), '东风');
  assert.equal(Audio.tileWord(31), '红中');
  assert.equal(Audio.tileWord(33), '白板');
  assert.equal(Audio.tileWord(99), '牌');
});

test('声音层：没有 AudioContext 的环境下所有调用都不抛错', () => {
  assert.doesNotThrow(() => {
    Audio.unlock();
    Audio.setEnabled(true);
    Audio.clack();
    Audio.claim('peng');
    Audio.claim('hu');
    Audio.draw();
    Audio.discardTile(3, { voice: false });
    Audio.say('四万');
    Audio.setEnabled(false);
    Audio.setEnabled(true);
  });
  assert.equal(Audio.status().hasCtx, false, 'Node 里不该有 AudioContext');
});
