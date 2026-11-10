/* 石屏麻将 · 规则内核 + 显式回合状态机 | GPL-3.0-or-later
 *
 * 设计原则
 * 1. 只有一个回合推进入口：settle()。所有命令（出牌/吃/碰/杠/胡/过）执行完都会立即 settle，
 *    状态永远不会停留在「半途」的中间态。
 * 2. 只有一个「行动权」判定：awaiting()。UI 与 AI 都只能从这里读取下一步该谁动、要做什么。
 * 3. 引擎不依赖计时器、DOM 或随机数（洗牌随机数由外部注入），因此可以被完整模拟测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShipingMahjongCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 基础常量 ---------------- */
  const SUITS = ['w', 'b', 't'];                       // 万 / 筒 / 条
  const HONORS = ['东', '南', '西', '北', '中', '发', '白'];
  const BAD_GROUPS = [[1, 4, 7], [2, 5, 8], [3, 6, 9]]; // 烂牌胡允许的点数组合
  const ACTION_PRIORITY = { hu: 4, gang: 3, peng: 2, chi: 1 };
  const NEXT_SEAT = [2, 3, 1, 0];                       // 南 → 西 → 北 → 东
  const WALL_SIDES = ['南', '北', '西', '东'];
  const SEAT_NAMES = ['南家', '北家', '西家', '东家'];
  const PHASES = { DISCARD: 'discard', CLAIM: 'claim', OVER: 'over' };
  const DEFAULT_SETTINGS = { chi: true, peng: true, gang: true, badHu: true };
  const TILE_KINDS = 34;
  const DECK_SIZE = 136;

  /* ---------------- 玩法变体 ----------------
   * 每种地方麻将是一份「配置 + 规则开关默认值 + 计分表」。
   * 目前只有石屏可用；个旧 / 宝秀先占位：拿到真实规则后只需补 defaults / scoring / 牌张配置，
   * 不需要改动回合状态机与界面。
   */
  const VARIANTS = [
    {
      id: 'shiping',
      name: '石屏麻将',
      region: '云南红河 · 石屏',
      available: true,
      summary: '136 张 · 吃碰杠全开 · 烂牌胡',
      deck: { suits: 3, honors: 7, flowers: 0, wildcards: 0, size: DECK_SIZE },
      defaults: { chi: true, peng: true, gang: true, badHu: true },
      scoring: {
        kong: { self: 3, other: -1 },
        selfDraw: { self: 9, other: -3 },
        discard: { winner: 4, loser: -2, other: -1 }
      },
      initialScore: 100,
      notes: '标准胡 4 副面子 + 1 对将；支持自摸、点炮、烂牌胡（14 张不重复，数牌按 147 / 258 / 369 取组）'
    },
    {
      id: 'gejiu',
      name: '个旧麻将',
      region: '云南红河 · 个旧',
      available: false,
      summary: '规则整理中',
      deck: { suits: 3, honors: 7, flowers: 0, wildcards: 0, size: DECK_SIZE },
      defaults: { chi: true, peng: true, gang: true, badHu: true },
      scoring: null,
      initialScore: 100,
      notes: '等待确认：牌张构成、特殊牌型、烂牌胡判定、吃牌限制、杠分与胡分'
    },
    {
      id: 'baoxiu',
      name: '宝秀麻将',
      region: '云南红河 · 宝秀',
      available: false,
      summary: '规则整理中',
      deck: { suits: 3, honors: 7, flowers: 0, wildcards: 0, size: DECK_SIZE },
      defaults: { chi: true, peng: true, gang: true, badHu: true },
      scoring: null,
      initialScore: 100,
      notes: '等待确认：是否保留吃牌、有无宝牌或翻宝、胡牌番型、结算分值'
    }
  ];
  const DEFAULT_VARIANT = 'shiping';
  function getVariant(id) {
    return VARIANTS.find((v) => v.id === id) || VARIANTS.find((v) => v.id === DEFAULT_VARIANT);
  }
  function availableVariants() {
    return VARIANTS.map((v) => ({ id: v.id, name: v.name, region: v.region, summary: v.summary, available: v.available, initialScore: v.initialScore }));
  }

  /* ---------------- 牌面工具 ---------------- */
  function tileMeta(id) {
    if (!Number.isInteger(id) || id < 0 || id >= TILE_KINDS) return null;
    if (id < 27) return { suit: Math.floor(id / 9), rank: id % 9 + 1, honor: false };
    return { suit: 3, rank: id - 26, honor: true };
  }
  function tileCode(id) {
    if (id < 27) return `${SUITS[Math.floor(id / 9)]}${id % 9 + 1}`;
    return `z${id - 26}`;
  }
  function tileLabel(id) {
    if (!Number.isInteger(id) || id < 0 || id >= TILE_KINDS) return '未知牌';
    if (id < 27) return `${id % 9 + 1}${['万', '筒', '条'][Math.floor(id / 9)]}`;
    return HONORS[id - 27];
  }
  function tileName(id) {
    if (!Number.isInteger(id) || id < 0 || id >= TILE_KINDS) return '未知牌';
    if (id < 27) return `${Math.floor(id / 9) + 1}花色${id % 9 + 1}`;
    return HONORS[id - 27];
  }

  /* ---------------- 座位工具 ---------------- */
  const seatIndex = (n) => ((n % 4) + 4) % 4;
  function nextSeat(seat) { return NEXT_SEAT[seatIndex(seat)]; }
  function prevSeat(seat) {
    const target = seatIndex(seat);
    for (let p = 0; p < 4; p++) if (nextSeat(p) === target) return p;
    return target;
  }
  function seatDistance(from, to) {
    let s = seatIndex(from);
    for (let d = 1; d <= 4; d++) { s = nextSeat(s); if (s === seatIndex(to)) return d; }
    return 4;
  }

  /* ---------------- 骰子 / 起手家（原称庄家，只决定谁先摸牌） / 开牌墙 ---------------- */
  function diceSetup(dice) {
    const a = Math.max(1, Math.min(6, Number(dice && dice[0]) || 1));
    const b = Math.max(1, Math.min(6, Number(dice && dice[1]) || 1));
    const sum = a + b;
    const dealer = (sum - 2) % 4;
    const sideIndex = (a + dealer - 1) % 4;
    const stack = ((sum - 2) * 2 + a - 1) % 17 + 1;
    return {
      dice: [a, b], sum, dealer,
      wallSide: WALL_SIDES[sideIndex], wallStack: stack,
      wallOffset: (sideIndex * 34 + (stack - 1) * 2) % DECK_SIZE
    };
  }

  /* ---------------- 牌墙 ---------------- */
  function buildDeck() {
    const d = [];
    for (let i = 0; i < TILE_KINDS; i++) for (let j = 0; j < 4; j++) d.push(i);
    return d;
  }
  function shuffle(d, random) {
    const rng = random || Math.random;
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }
  function sortHand(h) { h.sort((a, b) => a - b); return h; }
  function countTiles(h) {
    const c = Array(TILE_KINDS).fill(0);
    for (const id of h) {
      if (!Number.isInteger(id) || id < 0 || id >= TILE_KINDS) return null;
      if (++c[id] > 4) return null;
    }
    return c;
  }

  /* ---------------- 胡牌判定 ---------------- */
  function canMakeMelds(c, n, memo) {
    if (n === 0) return c.every((v) => v === 0);
    const key = n + '|' + c.join(',');
    if (memo.has(key)) return memo.get(key);
    let f = -1;
    for (let i = 0; i < TILE_KINDS; i++) if (c[i]) { f = i; break; }
    if (f < 0) { memo.set(key, false); return false; }
    if (c[f] >= 3) {
      c[f] -= 3;
      if (canMakeMelds(c, n - 1, memo)) { c[f] += 3; memo.set(key, true); return true; }
      c[f] += 3;
    }
    if (f < 27 && f % 9 <= 6 && c[f + 1] && c[f + 2]) {
      c[f]--; c[f + 1]--; c[f + 2]--;
      if (canMakeMelds(c, n - 1, memo)) { c[f]++; c[f + 1]++; c[f + 2]++; memo.set(key, true); return true; }
      c[f]++; c[f + 1]++; c[f + 2]++;
    }
    memo.set(key, false);
    return false;
  }
  function isStandardHu(hand, openMeldCount) {
    const m = Number.isInteger(openMeldCount) ? openMeldCount : 0;
    if (m < 0 || m > 4 || hand.length !== 14 - 3 * m) return false;
    const c = countTiles(hand);
    if (!c) return false;
    const memo = new Map();
    for (let i = 0; i < TILE_KINDS; i++) {
      if (c[i] >= 2) {
        c[i] -= 2;
        const ok = canMakeMelds(c, 4 - m, memo);
        c[i] += 2;
        if (ok) return true;
      }
    }
    return false;
  }
  function isBadHu(hand, openMeldCount) {
    if ((openMeldCount || 0) !== 0 || hand.length !== 14) return false;
    const s = new Set(hand);
    if (s.size !== 14) return false;
    if (hand.some((x) => !Number.isInteger(x) || x < 0 || x >= TILE_KINDS)) return false;
    for (let suit = 0; suit < 3; suit++) {
      const ranks = [];
      for (let r = 1; r <= 9; r++) if (s.has(suit * 9 + r - 1)) ranks.push(r);
      if (ranks.length && !BAD_GROUPS.some((g) => ranks.every((r) => g.includes(r)))) return false;
    }
    return true;
  }
  function isHu(hand, openMeldCount) { return isStandardHu(hand, openMeldCount) || isBadHu(hand, openMeldCount); }

  /* ---------------- 吃 / 接牌可选动作 ---------------- */
  function chiOptions(hand, tile) {
    if (tile >= 27) return [];
    const base = Math.floor(tile / 9) * 9;
    const r = tile % 9 + 1;
    const pairs = [
      r >= 3 ? [r - 2, r - 1] : null,
      r >= 2 && r <= 8 ? [r - 1, r + 1] : null,
      r <= 7 ? [r + 1, r + 2] : null
    ].filter(Boolean);
    const out = [];
    for (const pair of pairs) {
      const ids = pair.map((x) => base + x - 1);
      const copy = hand.slice();
      let ok = true;
      for (const id of ids) {
        const ix = copy.indexOf(id);
        if (ix < 0) { ok = false; break; }
        copy.splice(ix, 1);
      }
      if (ok) out.push({ consume: ids, meld: [...ids, tile].sort((a, b) => a - b) });
    }
    return out;
  }

  /** 某家对当前弃牌可以执行的动作（不依赖 phase，方便被局面推导复用） */
  function claimOptions(s, seat) {
    const last = s.lastDiscard;
    if (!last || last.from === seat) return [];
    if (s.phase === PHASES.OVER) return [];
    const hand = s.hands[seat];
    if (!Array.isArray(hand)) return [];
    const withTile = hand.concat(last.tile);
    const meldCount = s.melds[seat].length;
    const actions = [];
    if (isStandardHu(withTile, meldCount) || (s.settings.badHu && isBadHu(withTile, meldCount))) {
      actions.push({ type: 'hu' });
    }
    const same = hand.filter((x) => x === last.tile).length;
    if (s.settings.gang && same >= 3) actions.push({ type: 'gang' });
    if (s.settings.peng && same >= 2) actions.push({ type: 'peng' });
    if (s.settings.chi && seat === nextSeat(last.from)) {
      const opts = chiOptions(hand, last.tile);
      if (opts.length) actions.push({ type: 'chi', options: opts });
    }
    return actions;
  }

  function collectClaimCandidates(s) {
    const out = [];
    for (let seat = 0; seat < 4; seat++) {
      if (seat === s.lastDiscard.from) continue;
      const actions = claimOptions(s, seat);
      if (!actions.length) continue;
      const top = actions.reduce((b, x) => (ACTION_PRIORITY[x.type] > ACTION_PRIORITY[b.type] ? x : b), actions[0]);
      out.push({
        seat, actions, priority: ACTION_PRIORITY[top.type], preferred: top.type,
        distance: seatDistance(s.lastDiscard.from, seat)
      });
    }
    // 优先级：胡 > 杠 > 碰 > 吃；同级按离出牌家的座次距离，近者优先
    out.sort((a, b) => b.priority - a.priority || a.distance - b.distance);
    return out;
  }

  function selfActions(s, seat) {
    const hand = s.hands[seat], melds = s.melds[seat];
    const out = { hu: false, concealedKongs: [], addedKongs: [] };
    if (s.phase !== PHASES.DISCARD || s.current !== seat) return out;
    out.hu = isStandardHu(hand, melds.length) || (s.settings.badHu && isBadHu(hand, melds.length));
    if (!s.settings.gang) return out;
    const c = countTiles(hand);
    if (!c) return out;
    for (let i = 0; i < TILE_KINDS; i++) {
      if (c[i] === 4) out.concealedKongs.push(i);
      if (c[i] && melds.some((m) => m.type === 'peng' && m.tiles[0] === i)) out.addedKongs.push(i);
    }
    return out;
  }

  /* ---------------- 计分 ---------------- */
  function scoreKong(s, seat, kind) {
    const tb = (s.scoring && s.scoring.kong) || { self: 3, other: -1 };
    s.scores[seat] += tb.self;
    for (let p = 0; p < 4; p++) if (p !== seat) s.scores[p] += tb.other;
    s.kongLog.push({ seat, kind, delta: [0, 1, 2, 3].map((p) => (p === seat ? tb.self : tb.other)) });
  }
  function scoreIsZeroSum(a) { return a.reduce((x, y) => x + y, 0) === 0; }

  /* ---------------- 事件日志（供 UI / 调试面板使用） ---------------- */
  let eventSeq = 0;
  function pushEvent(s, ev) {
    eventSeq += 1;
    const record = Object.assign({ seq: eventSeq }, ev, {
      phaseAfter: s.phase, currentAfter: s.current,
      pending: s.pendingClaims.map((c) => c.seat), cursor: s.claimCursor,
      wall: s.wall.length
    });
    s.events.push(record);
    if (s.events.length > 600) s.events.splice(0, s.events.length - 600);
    return record;
  }

  /* ---------------- 关键：统一回合推进 ---------------- */
  /** 由当前状态推导唯一的行动权。没有行动权返回 null。 */
  function awaiting(s) {
    if (!s || s.phase === PHASES.OVER) return null;
    if (s.phase === PHASES.CLAIM) {
      const candidate = s.pendingClaims[s.claimCursor];
      if (!candidate) return null;
      return { seat: candidate.seat, kind: 'claim', candidate };
    }
    if (s.phase === PHASES.DISCARD) return { seat: s.current, kind: 'discard' };
    return null;
  }

  function endAsDraw(s) {
    s.phase = PHASES.OVER;
    s.winner = null;
    s.result = { type: 'draw', title: '荒牌', detail: '牌墙已摸完，本局荒牌' };
    pushEvent(s, { type: 'draw-end' });
    return s;
  }

  function drawFor(s, seat) {
    if (s.phase === PHASES.OVER) return null;
    if (!s.wall.length) { endAsDraw(s); return null; }
    const tile = s.wall.pop();
    s.hands[seat].push(tile);
    s.lastDraw = { seat, tile };
    s.lastDiscard = null;
    pushEvent(s, { type: 'draw', seat, tile });
    return tile;
  }

  /**
   * 唯一的推进函数：把状态推进到下一个「必须有人做决定」的位置，或直到本局结束。
   * 只处理不需要决策的过渡：无人接牌 → 下一家摸牌。
   */
  function settle(s) {
    for (let guard = 0; guard < 200; guard++) {
      if (s.phase === PHASES.OVER) return s;
      if (s.phase === PHASES.DISCARD) return s;   // 等某家出牌
      if (s.phase === PHASES.CLAIM) {
        if (s.claimCursor < s.pendingClaims.length) return s; // 等某家决定接牌
        const from = s.lastDiscard ? s.lastDiscard.from : s.current;
        const next = nextSeat(from);
        s.pendingClaims = [];
        s.claimCursor = 0;
        s.lastDiscard = null;
        s.current = next;
        s.phase = PHASES.DISCARD;
        drawFor(s, next);                          // 可能触发荒牌
        continue;
      }
      return s;                                    // 未知阶段，直接停下（不静默跳过）
    }
    throw new Error('settle 超过最大推进次数，状态机可能陷入死循环');
  }

  /* ---------------- 对局创建 ---------------- */
  function createGame(settings, random, startInfo) {
    const start = startInfo || {};
    const variant = getVariant(start.variant);
    const cfg = Object.assign({}, variant.defaults, DEFAULT_SETTINGS, settings || {});
    const dice = diceSetup(start.dice || [1, 1]);
    const dealer = Number.isInteger(start.dealer) ? seatIndex(start.dealer) : dice.dealer;
    const wallOffset = Number.isInteger(start.wallOffset) ? ((start.wallOffset % DECK_SIZE) + DECK_SIZE) % DECK_SIZE : dice.wallOffset;
    const shuffled = shuffle(buildDeck(), random);
    const cut = (wallOffset + 1) % DECK_SIZE;
    const wall = shuffled.slice(cut).concat(shuffled.slice(0, cut));
    const hands = [[], [], [], []];
    const dealOrder = [dealer];
    for (let i = 1; i < 4; i++) dealOrder.push(nextSeat(dealOrder[i - 1]));
    for (let n = 0; n < 13; n++) for (const seat of dealOrder) hands[seat].push(wall.pop());
    hands.forEach(sortHand);
    const first = wall.pop();
    hands[dealer].push(first);

    const s = {
      hands, melds: [[], [], [], []], discards: [[], [], [], []], wall,
      scores: [0, 0, 0, 0], dealer,
      current: dealer, phase: PHASES.DISCARD,
      lastDraw: { seat: dealer, tile: first }, lastDiscard: null,
      pendingClaims: [], claimCursor: 0,
      winner: null, result: null, settings: cfg,
      variant: variant.id, variantName: variant.name, scoring: variant.scoring,
      kongLog: [], events: [], turnCount: 0,
      dice: dice.dice.slice(),
      wallBreak: {
        side: start.wallSide || dice.wallSide,
        stack: Number.isInteger(start.wallStack) ? start.wallStack : dice.wallStack,
        offset: wallOffset
      }
    };
    pushEvent(s, { type: 'deal', dealer, dice: s.dice.slice(), wallBreak: Object.assign({}, s.wallBreak) });
    return s;
  }

  /* ---------------- 玩家命令 ---------------- */
  function discardTile(s, seat, index) {
    if (s.phase !== PHASES.DISCARD || s.current !== seat) throw new Error('当前不是该玩家的出牌阶段');
    const h = s.hands[seat];
    if (!Number.isInteger(index) || index < 0 || index >= h.length) throw new Error('无效的手牌位置');
    const tile = h.splice(index, 1)[0];
    sortHand(h);
    s.discards[seat].push(tile);
    s.lastDiscard = { tile, from: seat };
    s.lastDraw = null;
    s.turnCount += 1;
    s.phase = PHASES.CLAIM;
    s.pendingClaims = collectClaimCandidates(s);
    s.claimCursor = 0;
    pushEvent(s, { type: 'discard', seat, tile });
    return settle(s), tile;
  }

  function applyHu(s, seat, source) {
    const from = source === 'discard' ? s.lastDiscard.from : null;
    const winningTile = source === 'self'
      ? (s.lastDraw && s.lastDraw.seat === seat ? s.lastDraw.tile : s.hands[seat][s.hands[seat].length - 1])
      : s.lastDiscard.tile;
    const winningHand = source === 'self' ? s.hands[seat].slice() : s.hands[seat].concat(winningTile);
    const winningType = isStandardHu(winningHand, s.melds[seat].length) ? '标准胡牌' : '烂牌胡';
    const meldSnapshot = s.melds[seat].map((m) => Object.assign({}, m, { tiles: m.tiles.slice() }));
    if (source === 'self') {
      const tb = (s.scoring && s.scoring.selfDraw) || { self: 9, other: -3 };
      s.scores[seat] += tb.self;
      for (let p = 0; p < 4; p++) if (p !== seat) s.scores[p] += tb.other;
      s.result = {
        type: 'self', seat, title: '自摸胡',
        detail: `${SEAT_NAMES[seat]}自摸，胡家 +${tb.self}，其余三家各 ${tb.other}`,
        winType: '自摸', winningTile, winningHand, winningType
      };
    } else {
      const tb = (s.scoring && s.scoring.discard) || { winner: 4, loser: -2, other: -1 };
      s.scores[seat] += tb.winner;
      s.scores[from] += tb.loser;
      for (let p = 0; p < 4; p++) if (p !== seat && p !== from) s.scores[p] += tb.other;
      s.result = {
        type: 'discard', seat, from, title: '点炮胡',
        detail: `${SEAT_NAMES[from]}点炮，${SEAT_NAMES[seat]}胡牌：胡家 +${tb.winner}，点炮 ${tb.loser}，其余各 ${tb.other}`,
        winType: '点炮', winningTile, winningHand, winningType
      };
    }
    s.phase = PHASES.OVER;
    s.result.roundScores = s.scores.slice();
    s.result.melds = meldSnapshot;
    s.winner = { seat, type: source, from };
    s.lastDiscard = null;
    s.pendingClaims = [];
    s.claimCursor = 0;
    pushEvent(s, { type: 'hu', seat, source, tile: winningTile, from });
    return s;
  }

  function claimDiscard(s, seat, type, optionIndex) {
    if (s.phase !== PHASES.CLAIM || !s.lastDiscard) throw new Error('当前没有可接的弃牌');
    const lane = s.pendingClaims[s.claimCursor];
    if (!lane || lane.seat !== seat) throw new Error('当前不是该玩家接牌');
    const legal = claimOptions(s, seat);
    const action = legal.find((a) => a.type === type);
    if (!action) throw new Error(`当前不能执行${type}`);
    const tile = s.lastDiscard.tile;
    const from = s.lastDiscard.from;
    const hand = s.hands[seat];
    if (type === 'hu') return applyHu(s, seat, 'discard');   // 点炮胡：弃牌留在牌河

    const pile = s.discards[from];
    const di = pile.lastIndexOf(tile);
    if (di >= 0) pile.splice(di, 1);

    if (type === 'gang') {
      for (let i = 0; i < 3; i++) hand.splice(hand.indexOf(tile), 1);
      s.melds[seat].push({
        type: 'gang', tiles: [tile, tile, tile, tile], from,
        calledFrom: from, calledTile: tile, calledTileIndex: 0, concealed: false, added: false
      });
      scoreKong(s, seat, '明杠');
      s.lastDiscard = null; s.pendingClaims = []; s.claimCursor = 0;
      s.current = seat; s.phase = PHASES.DISCARD;
      pushEvent(s, { type: 'gang', kind: 'exposed', seat, tile, from });
      drawFor(s, seat);                        // 杠后补牌
      return settle(s), s;
    }

    if (type === 'peng') {
      for (let i = 0; i < 2; i++) hand.splice(hand.indexOf(tile), 1);
      s.melds[seat].push({
        type: 'peng', tiles: [tile, tile, tile], from,
        calledFrom: from, calledTile: tile, calledTileIndex: 1
      });
    } else if (type === 'chi') {
      const opt = action.options[optionIndex || 0];
      if (!opt) throw new Error('吃牌组合不存在');
      for (const id of opt.consume) hand.splice(hand.indexOf(id), 1);
      s.melds[seat].push({
        type: 'chi', tiles: opt.meld, from,
        calledFrom: from, calledTile: tile, calledTileIndex: opt.meld.indexOf(tile)
      });
    }
    s.lastDiscard = null;
    s.pendingClaims = [];
    s.claimCursor = 0;
    s.current = seat;
    s.phase = PHASES.DISCARD;
    s.lastDraw = null;
    pushEvent(s, { type, seat, tile, from });
    return settle(s), s;
  }

  function passClaim(s, seat) {
    if (s.phase !== PHASES.CLAIM) throw new Error('当前没有待处理的接牌');
    const lane = s.pendingClaims[s.claimCursor];
    if (!lane || lane.seat !== seat) throw new Error('当前玩家没有待处理的接牌选择');
    pushEvent(s, { type: 'pass', seat, tile: s.lastDiscard && s.lastDiscard.tile });
    s.claimCursor += 1;
    return settle(s), s;
  }

  function claimSelfKong(s, seat, type, tile) {
    if (s.phase !== PHASES.DISCARD || s.current !== seat) throw new Error('当前不是该玩家的回合');
    if (!s.settings.gang) throw new Error('杠牌功能已关闭');
    const hand = s.hands[seat];
    if (type === 'concealed') {
      if (hand.filter((x) => x === tile).length !== 4) throw new Error('不能暗杠这张牌');
      for (let i = 0; i < 4; i++) hand.splice(hand.indexOf(tile), 1);
      s.melds[seat].push({ type: 'gang', tiles: [tile, tile, tile, tile], concealed: true, from: seat, added: false });
      scoreKong(s, seat, '暗杠');
    } else if (type === 'added') {
      const meld = s.melds[seat].find((m) => m.type === 'peng' && m.tiles[0] === tile);
      if (!meld || !hand.includes(tile)) throw new Error('不能补杠这张牌');
      hand.splice(hand.indexOf(tile), 1);
      meld.type = 'gang';
      meld.tiles = [tile, tile, tile, tile];
      meld.added = true;
      meld.calledTileIndex = 0;
      scoreKong(s, seat, '补杠');
    } else throw new Error('未知杠牌类型');
    pushEvent(s, { type: 'gang', kind: type, seat, tile });
    s.lastDraw = null;
    drawFor(s, seat);                          // 杠后补牌
    return settle(s), s;
  }

  function winSelf(s, seat) {
    if (s.phase !== PHASES.DISCARD || s.current !== seat) throw new Error('当前不是该玩家的回合');
    if (!(isStandardHu(s.hands[seat], s.melds[seat].length) || (s.settings.badHu && isBadHu(s.hands[seat], s.melds[seat].length)))) {
      throw new Error('当前手牌不能自摸胡');
    }
    return applyHu(s, seat, 'self');
  }

  /* ---------------- AI 策略 ---------------- */
  function chooseAiDiscard(h) {
    if (!Array.isArray(h) || !h.length) return -1;
    const c = countTiles(h);
    if (!c) return h.length - 1;
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < h.length; i++) {
      const id = h[i], m = tileMeta(id), same = c[id];
      let keep = same > 1 ? 12 + same * 5 : 0;
      if (!m.honor) {
        const base = m.suit * 9, r = m.rank;
        const nb = [r > 1 ? c[base + r - 2] : 0, r < 9 ? c[base + r] : 0];
        const gap = [r > 2 ? c[base + r - 3] : 0, r < 8 ? c[base + r + 1] : 0];
        keep += nb[0] * 3 + nb[1] * 3 + gap[0] * 1.5 + gap[1] * 1.5;
        if (r >= 3 && r <= 7) keep += 0.4;
      } else if (same === 1) {
        keep += 0.2;
      }
      if (keep < bestScore) { bestScore = keep; best = i; }
    }
    return best;
  }

  function bestAiClaim(candidate) {
    const has = (t) => candidate.actions.some((x) => x.type === t);
    if (has('hu')) return { type: 'hu' };
    if (has('gang')) return { type: 'gang' };
    if (has('peng')) return { type: 'peng' };
    if (has('chi')) return { type: 'chi', optionIndex: 0 };
    return null;
  }

  /** AI 回合决策：返回一个可直接执行的命令描述 */
  function aiDecide(s, seat) {
    const a = awaiting(s);
    if (!a || a.seat !== seat) return null;
    if (a.kind === 'claim') {
      const best = bestAiClaim(a.candidate);
      return best ? Object.assign({ kind: 'claim', seat }, best) : { kind: 'pass', seat };
    }
    const own = selfActions(s, seat);
    if (own.hu) return { kind: 'hu', seat };
    if (own.concealedKongs.length) return { kind: 'selfKong', seat, kongType: 'concealed', tile: own.concealedKongs[0] };
    if (own.addedKongs.length && s.wall.length > 4) return { kind: 'selfKong', seat, kongType: 'added', tile: own.addedKongs[0] };
    return { kind: 'discard', seat, index: chooseAiDiscard(s.hands[seat]) };
  }

  function applyDecision(s, decision) {
    if (!decision) throw new Error('没有可执行的决策');
    switch (decision.kind) {
      case 'discard': return discardTile(s, decision.seat, decision.index);
      case 'claim': return claimDiscard(s, decision.seat, decision.type, decision.optionIndex || 0);
      case 'pass': return passClaim(s, decision.seat);
      case 'selfKong': return claimSelfKong(s, decision.seat, decision.kongType, decision.tile);
      case 'hu': return winSelf(s, decision.seat);
      default: throw new Error('未知决策类型：' + decision.kind);
    }
  }

  /* ---------------- 统计（测试用） ---------------- */
  function tileTally(s) {
    let total = s.wall.length;
    for (let i = 0; i < 4; i++) {
      total += s.hands[i].length;
      total += s.discards[i].length;
      for (const m of s.melds[i]) total += m.tiles.length;
    }
    return total;
  }
  function meldTileTally(s, seat) {
    return s.melds[seat].reduce((n, m) => n + m.tiles.length, 0);
  }

  return {
    SUITS, HONORS, BAD_GROUPS, ACTION_PRIORITY, NEXT_SEAT, WALL_SIDES, SEAT_NAMES, PHASES,
    DEFAULT_SETTINGS, DECK_SIZE, TILE_KINDS,
    VARIANTS, DEFAULT_VARIANT, getVariant, availableVariants,
    seatIndex, nextSeat, prevSeat, seatDistance,
    tileName, tileCode, tileLabel, tileMeta,
    diceSetup, buildDeck, shuffle, sortHand, countTiles,
    isStandardHu, isBadHu, isHu, canMakeMelds,
    chiOptions, claimOptions, collectClaimCandidates, selfActions,
    createGame, settle, awaiting, drawFor, endAsDraw,
    discardTile, claimDiscard, passClaim, claimSelfKong, winSelf,
    applyHu, scoreKong, scoreIsZeroSum,
    chooseAiDiscard, bestAiClaim, aiDecide, applyDecision,
    tileTally, meldTileTally
  };
});
