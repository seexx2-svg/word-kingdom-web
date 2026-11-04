'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { C, seeded, playGame, invariants } = require('./helpers.cjs');

/** 每个决策点都检查牌数守恒与零和，任何一局卡死都会在这里暴露 */
function runBatch(count, settings, tag) {
  const summary = { games: 0, wins: 0, draws: 0, aborts: 0, steps: 0, maxSteps: 0, maxHand: 0, seats: new Set() };
  for (let seed = 1; seed <= count; seed++) {
    const r = playGame(seed * 7919 + 13, settings, {
      onStep: (s) => {
        assert.equal(C.tileTally(s), 136, `${tag} seed=${seed} 牌数不守恒`);
        assert.ok(C.scoreIsZeroSum(s.scores), `${tag} seed=${seed} 积分非零和`);
        const a = C.awaiting(s);
        if (s.phase !== 'over') assert.ok(a, `${tag} seed=${seed} 出现无行动方的死局`);
      }
    });
    summary.games += 1;
    summary.steps += r.steps;
    summary.maxSteps = Math.max(summary.maxSteps, r.steps);
    summary.maxHand = Math.max(summary.maxHand, r.maxHand);
    r.discardSeats.forEach((s) => summary.seats.add(s));
    if (r.result.type === 'draw') summary.draws += 1;
    else if (r.result.type === 'abort') summary.aborts += 1;
    else summary.wins += 1;
    invariants(assert, r.state, `${tag} seed=${seed} 终局`);
    assert.ok(r.steps < 1000, `${tag} seed=${seed} 步数异常 ${r.steps}`);
  }
  return summary;
}

test('100+ 随机种子完整人机对局（默认规则）', () => {
  const summary = runBatch(120, {}, '默认规则');
  assert.equal(summary.games, 120);
  assert.equal(summary.aborts, 0, '不应出现异常中止的牌局');
  assert.deepEqual([...summary.seats].sort(), [0, 1, 2, 3], '四家都应实际参与出牌');
  console.log(`  · ${summary.games} 局：胡 ${summary.wins} 局，荒牌 ${summary.draws} 局，` +
    `平均 ${(summary.steps / summary.games).toFixed(1)} 步，最长 ${summary.maxSteps} 步`);
});

test('规则开关组合下仍能完整跑完（每种组合 10 局）', () => {
  const combos = [
    { chi: false }, { peng: false }, { gang: false }, { badHu: false },
    { chi: false, peng: false }, { gang: false, badHu: false },
    { chi: false, peng: false, gang: false, badHu: false },
    { chi: true, peng: true, gang: true, badHu: true }
  ];
  combos.forEach((settings, i) => {
    const summary = runBatch(10, settings, '组合' + i);
    assert.equal(summary.aborts, 0, '组合 ' + JSON.stringify(settings) + ' 出现异常中止');
  });
  console.log('  · 8 组开关组合 × 10 局全部完成');
});

test('连续 500 局压测：无卡死、无牌数泄漏', () => {
  const summary = runBatch(500, {}, '压测');
  assert.equal(summary.aborts, 0);
  console.log(`  · 500 局压测通过：胡 ${summary.wins}，荒 ${summary.draws}，平均 ${(summary.steps / 500).toFixed(1)} 步`);
});

test('吃碰杠之后局面仍由接牌方继续出牌', () => {
  // 逐局统计：每次吃/碰/杠后，紧接着的 discard 必须来自接牌的那一家
  for (let seed = 1; seed <= 60; seed++) {
    const s = C.createGame({}, seeded(seed));
    let pendingClaimSeat = null;
    let guard = 0;
    while (s.phase !== 'over' && guard++ < 3000) {
      const before = s.events.length;
      const a = C.awaiting(s);
      const d = C.aiDecide(s, a.seat);
      if (d.kind === 'claim' && (d.type === 'chi' || d.type === 'peng' || d.type === 'gang')) {
        pendingClaimSeat = d.seat;
      }
      C.applyDecision(s, d);
      for (let i = before; i < s.events.length; i++) {
        const ev = s.events[i];
        if (ev.type === 'discard' && pendingClaimSeat !== null) {
          assert.equal(ev.seat, pendingClaimSeat, 'seed ' + seed + ' 吃碰杠后应由接牌方出牌');
          pendingClaimSeat = null;
        }
      }
    }
  }
});

test('杠后补牌：每次杠之后手牌张数正确', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = C.createGame({}, seeded(seed));
    let guard = 0;
    while (s.phase !== 'over' && guard++ < 3000) {
      const before = s.events.length;
      const handsBefore = s.hands.map((h) => h.length);
      const a = C.awaiting(s);
      const d = C.aiDecide(s, a.seat);
      C.applyDecision(s, d);
      for (let i = before; i < s.events.length; i++) {
        const ev = s.events[i];
        if (ev.type === 'gang') {
          const seat = ev.seat;
          const expected = handsBefore[seat] - (ev.kind === 'concealed' ? 4 : ev.kind === 'added' ? 1 : 3) + 1;
          assert.equal(s.hands[seat].length, expected, 'seed ' + seed + ' 杠后补牌张数错误');
          assert.equal(s.current, seat, '杠家应继续出牌');
          assert.equal(s.phase, 'discard');
        }
      }
    }
  }
});
