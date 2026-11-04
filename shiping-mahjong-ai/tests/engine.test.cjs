'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { C, scenario, seeded, invariants } = require('./helpers.cjs');

/* 牌 id 速查：0-8 = 1~9万，9-17 = 1~9筒，18-26 = 1~9条，27-33 = 东南西北中发白 */

test('牌库：136 张，34 种，每种 4 张', () => {
  const deck = C.buildDeck();
  assert.equal(deck.length, 136);
  const counts = new Array(34).fill(0);
  deck.forEach((id) => { counts[id] += 1; });
  counts.forEach((n, id) => assert.equal(n, 4, '第 ' + id + ' 种牌张数错误'));
});

test('发牌：庄家 14 张，其余各 13 张，总数守恒', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const s = C.createGame({}, seeded(seed));
    const dealer = s.dealer;
    s.hands.forEach((h, seat) => assert.equal(h.length, seat === dealer ? 14 : 13, 'seed ' + seed + ' seat ' + seat));
    assert.equal(C.tileTally(s), 136, 'seed ' + seed);
    assert.equal(s.phase, 'discard');
    assert.equal(s.current, dealer, '庄家先出牌');
    assert.ok(s.lastDraw && s.lastDraw.seat === dealer, '庄家摸到第一张牌');
  }
});

test('骰子：庄家与开牌墙位计算一致', () => {
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      const setup = C.diceSetup([a, b]);
      assert.equal(setup.sum, a + b);
      assert.equal(setup.dealer, (a + b - 2) % 4);
      assert.ok(['南', '北', '西', '东'].includes(setup.wallSide));
      assert.ok(setup.wallStack >= 1 && setup.wallStack <= 17, '墩位越界');
      assert.ok(setup.wallOffset >= 0 && setup.wallOffset < 136);
    }
  }
  const setup = C.diceSetup([3, 4]);
  const s = C.createGame({}, seeded(7), setup);
  assert.equal(s.dealer, setup.dealer);
  assert.equal(s.wallBreak.side, setup.wallSide);
  assert.equal(s.wallBreak.stack, setup.wallStack);
});

test('座次轮转：南 → 西 → 北 → 东', () => {
  assert.equal(C.nextSeat(0), 2);
  assert.equal(C.nextSeat(2), 1);
  assert.equal(C.nextSeat(1), 3);
  assert.equal(C.nextSeat(3), 0);
  assert.equal(C.prevSeat(0), 3, '南家的上家是东家');
  assert.equal(C.seatDistance(0, 2), 1);
  assert.equal(C.seatDistance(0, 1), 2);
  assert.equal(C.seatDistance(0, 3), 3);
});

test('出牌后无人接牌：自动进入下一家摸牌出牌', () => {
  const base = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18];
  const hands = [
    [27, 27, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    base.slice(), base.slice(), base.slice()
  ];
  const s = scenario({ hands, current: 0, dealer: 0 });
  const wallBefore = s.wall.length;
  C.discardTile(s, 0, 0);                       // 打出东
  assert.equal(s.phase, 'discard', '无人接牌应直接进入出牌阶段');
  assert.equal(s.current, 2, '下一家应为西家');
  assert.equal(s.wall.length, wallBefore - 1, '应摸走一张牌');
  assert.equal(s.hands[2].length, 14, '西家摸牌后 14 张');
  const a = C.awaiting(s);
  assert.equal(a.seat, 2);
  assert.equal(a.kind, 'discard');
  invariants(assert, s, '出牌轮转');
});

test('四家都会实际出牌（完整一局）', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const s = C.createGame({}, seeded(seed));
    const seats = new Set();
    let guard = 0;
    while (s.phase !== 'over' && guard++ < 3000) {
      const a = C.awaiting(s);
      if (a.kind === 'discard') seats.add(a.seat);
      C.applyDecision(s, C.aiDecide(s, a.seat));
    }
    assert.deepEqual([...seats].sort(), [0, 1, 2, 3], 'seed ' + seed + ' 四家均应出过牌');
  }
});

test('吃牌：只有下家可以吃，且副露记录被吃的那张牌', () => {
  const lastDiscard = { tile: 2, from: 0 };      // 南家打出 3万
  const hands = [
    [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18],
    [20, 21, 23, 24, 25, 26, 30, 31, 32, 33, 27, 28, 29], // 北家：无关
    [0, 1, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16],       // 西家：有 1万2万4万5万
    [0, 1, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16]        // 东家：同样有，但不是下家
  ];
  const s = scenario({ hands, lastDiscard, current: 0, phase: 'claim' });
  assert.equal(C.nextSeat(0), 2, '南家的下家是西家');

  const west = C.claimOptions(s, 2).find((x) => x.type === 'chi');
  const east = C.claimOptions(s, 3).find((x) => x.type === 'chi');
  assert.ok(west, '西家应能吃');
  assert.equal(east, undefined, '东家不是下家，不能吃');

  const target = west.options.find((o) => o.meld.join(',') === '0,1,2');
  assert.ok(target, '应存在 1万2万3万 的吃法');

  C.claimDiscard(s, 2, 'chi', west.options.indexOf(target));
  const meld = s.melds[2][0];
  assert.deepEqual(meld.tiles, [0, 1, 2], '副露应为 1万2万3万');
  assert.equal(meld.tiles[meld.calledTileIndex], 2, '被吃的 3万 必须被标出来');
  assert.equal(meld.calledFrom, 0);
  assert.equal(s.phase, 'discard');
  assert.equal(s.current, 2, '吃牌后由西家出牌');
  assert.equal(s.hands[2].length, 11, '吃牌后手牌应为 11 张');
  invariants(assert, s, '吃牌');
});

test('碰牌：任意一家可碰，碰后由碰家出牌', () => {
  const lastDiscard = { tile: 5, from: 0 };
  const hands = [
    [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13],
    [5, 5, 20, 21, 22, 23, 24, 25, 26, 30, 31, 32, 33],
    [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14]
  ];
  const s = scenario({ hands, lastDiscard, current: 0, phase: 'claim' });
  assert.ok(C.claimOptions(s, 1).some((x) => x.type === 'peng'), '北家应能碰');
  C.claimDiscard(s, 1, 'peng');
  assert.equal(s.melds[1].length, 1);
  assert.deepEqual(s.melds[1][0].tiles, [5, 5, 5]);
  assert.equal(s.phase, 'discard');
  assert.equal(s.current, 1);
  assert.equal(s.hands[1].length, 11);
  assert.equal(s.discards[0].length, 0, '被碰走的牌要离开牌河');
  invariants(assert, s, '碰牌');
});

test('明杠：+3/-1 计分，杠后补一张牌并继续出牌', () => {
  const lastDiscard = { tile: 6, from: 0 };
  const hands = [
    [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13],
    [6, 6, 6, 20, 21, 22, 23, 24, 25, 26, 30, 31, 32],
    [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14],
    [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14]
  ];
  const s = scenario({ hands, lastDiscard, current: 0, phase: 'claim' });
  const wallBefore = s.wall.length;
  C.claimDiscard(s, 1, 'gang');
  assert.equal(s.melds[1][0].type, 'gang');
  assert.equal(s.melds[1][0].tiles.length, 4);
  assert.deepEqual(s.scores, [-1, 3, -1, -1]);
  assert.equal(s.wall.length, wallBefore - 1, '杠后应补一张牌');
  assert.equal(s.hands[1].length, 11, '13 - 3 + 1 = 11');
  assert.equal(s.phase, 'discard');
  assert.equal(s.current, 1);
  invariants(assert, s, '明杠');
});

test('暗杠与补杠：杠后补牌，副露标记正确', () => {
  const hand = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s = scenario({ hands: [hand, [], [], []], current: 0 });
  const wallBefore = s.wall.length;
  C.claimSelfKong(s, 0, 'concealed', 0);
  assert.equal(s.melds[0][0].type, 'gang');
  assert.equal(s.melds[0][0].concealed, true);
  assert.equal(s.hands[0].length, 11, '14 - 4 + 1 = 11');
  assert.equal(s.wall.length, wallBefore - 1);
  assert.equal(s.phase, 'discard');
  assert.equal(s.current, 0);
  assert.deepEqual(s.scores, [3, -1, -1, -1]);
  invariants(assert, s, '暗杠');

  const s2 = scenario({
    hands: [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], [], [], []],
    melds: [[{ type: 'peng', tiles: [5, 5, 5], from: 2, calledFrom: 2, calledTile: 5, calledTileIndex: 1 }], [], [], []],
    current: 0
  });
  C.claimSelfKong(s2, 0, 'added', 5);
  assert.equal(s2.melds[0][0].type, 'gang');
  assert.equal(s2.melds[0][0].tiles.length, 4);
  assert.equal(s2.melds[0][0].added, true);
  assert.deepEqual(s2.scores, [3, -1, -1, -1]);
  assert.equal(s2.hands[0].length, 14, '14 - 1 + 1 = 14');
  invariants(assert, s2, '补杠');
});

test('自摸胡：+9/-3/-3/-3', () => {
  const hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27, 27];
  const s = scenario({ hands: [hand, [], [], []], current: 0, lastDraw: { seat: 0, tile: 27 } });
  assert.ok(C.selfActions(s, 0).hu, '应为自摸胡');
  C.winSelf(s, 0);
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.scores, [9, -3, -3, -3]);
  assert.equal(s.result.type, 'self');
  assert.equal(s.result.winningTile, 27);
  assert.equal(s.result.winningHand.length, 14);
  assert.ok(C.scoreIsZeroSum(s.scores));
});

test('点炮胡：+4/-2/-1/-1', () => {
  const waiting = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27];  // 四副面子 + 单张东
  const filler = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const hands = [waiting, filler, filler.slice(), filler.slice()];
  const s = scenario({ hands, current: 1, phase: 'claim', lastDiscard: { tile: 27, from: 1 } });
  const cand = s.pendingClaims.find((c) => c.seat === 0);
  assert.ok(cand && cand.actions.some((a) => a.type === 'hu'), '南家应能胡东');
  C.claimDiscard(s, 0, 'hu');
  assert.deepEqual(s.scores, [4, -2, -1, -1]);
  assert.equal(s.result.winType, '点炮');
  assert.equal(s.result.from, 1);
  assert.ok(C.scoreIsZeroSum(s.scores));
  invariants(assert, s, '点炮胡');
});

test('多家同时接牌：按胡 > 杠 > 碰 > 吃、再由座次距离决定', () => {
  const waiting = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27]; // 四副面子 + 单张东
  const filler = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const hands = [waiting.slice(), filler, filler.slice(), waiting.slice()];
  const s = scenario({ hands, current: 2, phase: 'claim', lastDiscard: { tile: 27, from: 2 } });
  const order = s.pendingClaims.map((c) => c.seat);
  assert.deepEqual(order, [3, 0], '东家（距离 1）应排在北家（距离 2）之前');
  C.claimDiscard(s, 3, 'hu');
  assert.equal(s.winner.seat, 3);
  assert.deepEqual(s.scores, [-1, -1, -2, 4]);
});

test('优先级：碰/杠 高于 吃', () => {
  const lastDiscard = { tile: 4, from: 2 };      // 西家打出 5万
  const hands = [
    [4, 4, 4, 10, 11, 12, 20, 21, 22, 30, 31, 32, 33],   // 南家：三张5万 → 明杠
    [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    [0, 1, 7, 8, 12, 13, 18, 19, 23, 24, 28, 29, 33],
    [5, 6, 8, 9, 12, 13, 14, 18, 19, 22, 23, 24, 25]      // 东家：6万7万在手，可吃 5万
  ];
  const s = scenario({ hands, current: 2, phase: 'claim', lastDiscard });
  const top = s.pendingClaims[0];
  assert.equal(top.seat, 0, '杠的优先级最高');
  assert.equal(top.priority, C.ACTION_PRIORITY.gang);
  assert.equal(top.preferred, 'gang');
});

test('烂牌胡：14 张不重复且数牌落在 147/258/369 的一组内', () => {
  assert.equal(C.isBadHu([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 28, 29, 30, 31], 0), true, '1/4/7 + 字牌');
  assert.equal(C.isBadHu([1, 4, 7, 10, 13, 16, 19, 22, 25, 27, 28, 29, 30, 32], 0), true, '2/5/8');
  assert.equal(C.isBadHu([0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19], 0), false, '147 中混入 2');
  assert.equal(C.isBadHu([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 0), false, '点数跨组');
  assert.equal(C.isBadHu([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 28, 29, 30, 27], 0), false, '有重复牌');
  assert.equal(C.isBadHu([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 28, 29, 30, 31], 1), false, '有副露不能烂牌胡');
});

test('标准胡判定：4 副面子 + 1 对将，七对不算', () => {
  assert.equal(C.isStandardHu([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27, 27], 0), true);
  assert.equal(C.isStandardHu([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4], 0), true, '四刻子 + 对子');
  assert.equal(C.isStandardHu([0, 0, 9, 9, 18, 18, 27, 27, 28, 28, 29, 29, 30, 30], 0), false, '七对不算胡');
  assert.equal(C.isStandardHu([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27, 28], 0), false, '无将');
  assert.equal(C.isStandardHu([0, 1, 2, 9, 10, 11, 27, 27], 2), true, '2 副副露 + 2 面子 + 将');
});

test('规则开关：关闭吃/碰/杠/烂牌胡后不再提供对应操作', () => {
  const lastDiscard = { tile: 2, from: 0 };
  const hands = [
    [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18],
    [1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19],
    [0, 1, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    [0, 1, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16]
  ];
  const noChi = scenario({ hands, lastDiscard, phase: 'claim', current: 0, settings: { chi: false } });
  assert.equal(C.claimOptions(noChi, 2).some((x) => x.type === 'chi'), false);

  const noPeng = scenario({ hands, lastDiscard, phase: 'claim', current: 0, settings: { peng: false } });
  assert.equal(C.claimOptions(noPeng, 2).some((x) => x.type === 'peng'), false);

  const kongHand = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const noGang = scenario({ hands: [kongHand, [], [], []], current: 0, settings: { gang: false } });
  assert.equal(C.selfActions(noGang, 0).concealedKongs.length, 0);

  const badHand = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 28, 29, 30, 31];
  const noBad = scenario({ hands: [badHand, [], [], []], current: 0, settings: { badHu: false } });
  assert.equal(C.selfActions(noBad, 0).hu, false, '关闭后不能烂牌胡');
});

test('荒牌：牌墙摸完时本局结束', () => {
  const s = scenario({ hands: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27, 28], [], [], []], current: 0, wall: [] });
  C.discardTile(s, 0, 13);
  assert.equal(s.phase, 'over');
  assert.equal(s.result.type, 'draw');
  assert.ok(C.scoreIsZeroSum(s.scores));
});

test('awaiting：状态机永远给出唯一行动方', () => {
  const s = C.createGame({}, seeded(99));
  for (let i = 0; i < 200 && s.phase !== 'over'; i++) {
    const a = C.awaiting(s);
    assert.ok(a, '局面未结束却没有行动方（第 ' + i + ' 步）');
    assert.ok(a.seat >= 0 && a.seat <= 3);
    assert.ok(a.kind === 'discard' || a.kind === 'claim');
    if (a.kind === 'claim') {
      assert.equal(a.candidate.seat, a.seat);
      assert.ok(a.candidate.actions.length > 0);
    }
    C.applyDecision(s, C.aiDecide(s, a.seat));
  }
});
