/* 玩法变体：注册表、配置合并、计分表接线 | GPL-3.0-or-later
 *
 * 目的：把「个旧 / 宝秀接入时只需补配置」这件事固定在测试里。
 * 一旦有人把计分或规则默认值写死回内核，这些用例会立刻失败。
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/core.js');

test('变体注册表：石屏可用，个旧与宝秀占位不可用', () => {
  const list = C.availableVariants();
  assert.equal(list.length, 3, '应注册三种玩法');
  const byId = Object.fromEntries(list.map((v) => [v.id, v]));
  assert.equal(byId.shiping.available, true, '石屏应可用');
  assert.equal(byId.gejiu.available, false, '个旧未确认规则前不可选');
  assert.equal(byId.baoxiu.available, false, '宝秀未确认规则前不可选');
  for (const v of list) {
    assert.ok(v.name && v.region && v.summary, '每个玩法都要有名称、地区、简介');
  }
});

test('getVariant：未知 id 回落到石屏', () => {
  assert.equal(C.getVariant('shiping').id, 'shiping');
  assert.equal(C.getVariant('not-exist').id, 'shiping');
  assert.equal(C.getVariant(undefined).id, 'shiping');
});

test('createGame：不传 variant 时默认石屏，且把变体写进局面', () => {
  const s = C.createGame({}, Math.random);
  assert.equal(s.variant, 'shiping');
  assert.equal(s.variantName, '石屏麻将');
  assert.ok(s.scoring, '局面必须带计分表');
  assert.equal(C.tileTally(s), 136);
});

test('createGame：显式指定变体，规则默认值随之生效', () => {
  const s = C.createGame({}, Math.random, { variant: 'gejiu' });
  assert.equal(s.variant, 'gejiu');
  assert.equal(s.variantName, '个旧麻将');
  assert.equal(s.settings.chi, true, '应继承该玩法的默认开关');
  assert.equal(C.tileTally(s), 136);
});

test('createGame：显式设置覆盖玩法默认值', () => {
  const s = C.createGame({ chi: false, badHu: false }, Math.random, { variant: 'shiping' });
  assert.equal(s.settings.chi, false);
  assert.equal(s.settings.badHu, false);
  assert.equal(s.settings.peng, true, '未指定的开关仍取默认值');
});

test('计分：杠分来自局面计分表，而不是写死 3/-1', () => {
  const s = C.createGame({}, Math.random);
  C.scoreKong(s, 0, '明杠');
  assert.deepEqual(s.scores, [3, -1, -1, -1], '杠家 +3，其余各 -1');
  assert.equal(C.scoreIsZeroSum(s.scores), true);
});

test('计分：自摸与点炮分值同样读计分表', () => {
  // 自摸：胡家 +9，其余各 -3
  const s1 = C.createGame({}, Math.random);
  s1.hands[0] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27, 27];
  s1.lastDraw = { seat: 0, tile: 27 };
  C.applyHu(s1, 0, 'self');
  assert.deepEqual(s1.scores, [9, -3, -3, -3], '自摸 +9 / 各 -3');

  // 点炮：胡家 +4，点炮 -2，其余各 -1
  const s2 = C.createGame({}, Math.random);
  s2.hands[0] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27];
  s2.lastDiscard = { tile: 27, from: 2 };
  s2.discards[2] = [27];
  C.applyHu(s2, 0, 'discard');
  assert.deepEqual(s2.scores, [4, -1, -2, -1], '点炮 +4 / 点炮 -2 / 其余 -1');
});

test('计分表可替换：改配置后分值立即跟着变（模拟个旧 / 宝秀的差异）', () => {
  const s = C.createGame({}, Math.random);
  // 临时换成另一种计分方案，验证内核没有把数字写死
  s.scoring = {
    kong: { self: 6, other: -2 },
    selfDraw: { self: 12, other: -4 },
    discard: { winner: 6, loser: -3, other: -1 }
  };
  C.scoreKong(s, 1, '暗杠');
  assert.deepEqual(s.scores, [-2, 6, -2, -2], '杠分应使用新表');
  assert.equal(C.scoreIsZeroSum(s.scores), true);
});

test('玩法切换不影响牌张守恒与零和', () => {
  for (const id of ['shiping', 'gejiu', 'baoxiu']) {
    const s = C.createGame({}, Math.random, { variant: id });
    assert.equal(C.tileTally(s), 136, id + ' 必须是 136 张');
    assert.equal(C.scoreIsZeroSum(s.scores), true, id + ' 初始积分必须零和');
  }
});
