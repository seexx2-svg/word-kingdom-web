'use strict';
/* 测试公共工具：可复现随机数、局面构造、整局模拟 */
const C = require('../js/core.js');

function seeded(seed) {
  let x = (seed >>> 0) || 1;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

/** 构造一个干净、可控的局面（牌墙自动补足未使用的牌） */
function scenario(opts) {
  const o = Object.assign({ seed: 1, dealer: 0, phase: 'discard', settings: {} }, opts || {});
  const s = C.createGame(o.settings, seeded(o.seed));
  s.hands = o.hands ? o.hands.map((h) => h.slice()) : [[], [], [], []];
  s.melds = o.melds ? o.melds.map((m) => m.map((x) => Object.assign({}, x, { tiles: x.tiles.slice() }))) : [[], [], [], []];
  s.discards = o.discards ? o.discards.map((d) => d.slice()) : [[], [], [], []];
  s.scores = o.scores ? o.scores.slice() : [0, 0, 0, 0];
  s.dealer = o.dealer;
  s.current = o.current === undefined ? o.dealer : o.current;
  s.phase = o.phase;
  s.lastDraw = o.lastDraw === undefined ? null : o.lastDraw;
  s.lastDiscard = o.lastDiscard === undefined ? null : o.lastDiscard;
  s.kongLog = [];
  s.events = [];
  s.turnCount = 0;
  s.result = null;
  s.winner = null;
  s.pendingClaims = [];
  s.claimCursor = 0;

  if (o.lastDiscard) {
    const pile = s.discards[o.lastDiscard.from];
    if (pile[pile.length - 1] !== o.lastDiscard.tile) pile.push(o.lastDiscard.tile);
  }

  // 牌墙 = 整副牌 − 已出现的牌，保证牌数守恒
  if (o.wall) {
    s.wall = o.wall.slice();
  } else {
    const used = new Array(34).fill(0);
    const count = (id) => { used[id] += 1; };
    s.hands.forEach((h) => h.forEach(count));
    s.discards.forEach((d) => d.forEach(count));
    s.melds.forEach((ms) => ms.forEach((m) => m.tiles.forEach(count)));
    const wall = [];
    for (let id = 0; id < 34; id++) {
      for (let k = used[id]; k < 4; k++) wall.push(id);
    }
    s.wall = wall;
  }
  if (o.lastDiscard) {
    s.pendingClaims = C.collectClaimCandidates(s);
    s.claimCursor = 0;
  }
  return s;
}

/** 用 AI 策略把一局打完，返回统计信息 */
function playGame(seed, settings, options) {
  const o = options || {};
  const s = C.createGame(settings || {}, seeded(seed));
  const discardSeats = new Set();
  const claimSeats = new Set();
  let steps = 0;
  let maxHand = 0;
  while (s.phase !== 'over') {
    if (++steps > 4000) throw new Error('局面无法推进（seed=' + seed + '）');
    const a = C.awaiting(s);
    if (!a) throw new Error('awaiting 为空但局面未结束（seed=' + seed + ' phase=' + s.phase + '）');
    if (a.kind === 'discard') discardSeats.add(a.seat);
    else claimSeats.add(a.seat);
    const d = C.aiDecide(s, a.seat);
    if (!d) throw new Error('AI 无决策（seed=' + seed + '）');
    C.applyDecision(s, d);
    s.hands.forEach((h) => { if (h.length > maxHand) maxHand = h.length; });
    if (o.onStep) o.onStep(s, steps);
  }
  return {
    seed, steps, state: s,
    result: s.result, scores: s.scores.slice(),
    discardSeats: [...discardSeats], claimSeats: [...claimSeats],
    maxHand, wall: s.wall.length, turns: s.turnCount
  };
}

/** 断言牌数守恒且分数零和 */
function invariants(assert, s, tag) {
  assert.equal(C.tileTally(s), 136, '牌数守恒失败：' + tag);
  assert.ok(C.scoreIsZeroSum(s.scores), '积分非零和：' + tag + ' ' + s.scores.join(','));
  s.hands.forEach((h, i) => {
    assert.ok(h.length >= 0, '手牌数量异常 seat=' + i);
    assert.ok(h.length <= 14, '手牌超过 14 张 seat=' + i + ' ' + h.length);
  });
  for (let i = 0; i < 4; i++) {
    s.melds[i].forEach((m) => {
      const expect = m.type === 'gang' ? 4 : 3;
      assert.equal(m.tiles.length, expect, '副露张数错误 ' + m.type + ' ' + tag);
    });
  }
}

module.exports = { C, seeded, scenario, playGame, invariants };
