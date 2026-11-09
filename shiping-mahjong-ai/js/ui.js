/* 石屏麻将 · 牌桌驱动层 | GPL-3.0-or-later
 *
 * 核心约束：
 * 1. 唯一的推进入口是 pump()，它从 core 的 awaiting() 读取「现在必须谁行动、做什么」，
 *    然后要么交给人类界面，要么安排一次性 AI 任务。
 * 2. 每个 AI 任务都带代际号 epoch。任何状态变化都会让 epoch 自增并清掉旧任务，
 *    因此不存在「旧定时器覆盖新回合」或「同一回合重复排程」。
 * 3. 心跳只做一致性检查与重新排程，绝不代替玩家/AI 自动出牌来掩盖错误。
 */
(() => {
  'use strict';
  const C = window.ShipingMahjongCore;
  const $ = (id) => document.getElementById(id);
  const NAMES = ['你', '老李', '阿梅', '小赵'];
  const SEATS = ['南家', '北家', '西家', '东家'];
  const KEY_SETTINGS = 'shiping-mahjong-settings-v1';
  const KEY_SOUND = 'shiping-mahjong-sound-v1';
  const KEY_BANK = 'shiping-mahjong-bankroll-v1';
  const KEY_ROUND = 'shiping-mahjong-round-v1';
  const KEY_VARIANT = 'shiping-mahjong-variant-v1';
  const KEY_HALL = 'honghe-hall-v1';
  const A = window.HongheAccount;

  const SPEED = { claim: 700, discard: 780, kong: 620 };
  const HEARTBEAT_MS = 900;
  const STALL_MS = 2600;
  const MAX_RETRY = 8;

  /* ---------------- 运行时状态 ---------------- */
  let state = null;
  let settings = loadSettings();
  let balances = loadBankroll();
  let roundNo = loadRoundNo();
  let variantId = loadVariantId();
  let account = null;          // 当前登录账号（js/account.js 的对象）
  let hallId = (() => { try { return localStorage.getItem(KEY_HALL) || 'novice'; } catch (_) { return 'novice'; } })();
  let settlement = null;       // 本局银币结算
  let rankDelta = null;        // 本局段位分变化
  let screenId = 'splash';
  let epoch = 0;
  let aiTask = null;
  let decision = null;          // 当前人类决策 {seat, kind, actions, signature}
  let settledState = null;
  let speedScale = 1;           // 压力测试时可降到 0
  let autoPlay = false;
  let heartbeat = null;
  let turnClock = null, turnLeft = 15;
  let decisionAt = 0;
  let retryCount = 0;
  let renderSig = '';
  let barSig = '';
  let handRects = [];
  let beforeCapture = null;
  let busy = false;
  const LOGS = [];
  let lastDice = null;
  let audioCtx = null, soundEnabled = loadSoundSetting(), audioReady = false;

  /* ---------------- 存储 ---------------- */
  function loadSettings() {
    try {
      return Object.assign({ chi: true, peng: true, gang: true, badHu: true },
        JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}'));
    } catch (_) { return { chi: true, peng: true, gang: true, badHu: true }; }
  }
  function loadSoundSetting() { try { return localStorage.getItem(KEY_SOUND) !== 'off'; } catch (_) { return true; } }
  function loadBankroll() {
    try {
      const a = JSON.parse(localStorage.getItem(KEY_BANK) || 'null');
      if (Array.isArray(a) && a.length === 4 && a.every((x) => Number.isFinite(x))) return a.map((x) => Math.floor(x));
    } catch (_) { /* ignore */ }
    return [100, 100, 100, 100];
  }
  function saveBankroll() { try { localStorage.setItem(KEY_BANK, JSON.stringify(balances)); } catch (_) { /* ignore */ } }
  function loadRoundNo() { try { return Math.max(1, Number(localStorage.getItem(KEY_ROUND)) || 1); } catch (_) { return 1; } }
  function saveRoundNo() { try { localStorage.setItem(KEY_ROUND, String(roundNo)); } catch (_) { /* ignore */ } }

  /* ---------------- 账号 / 场次 / 界面切换 ----------------
   * 账号、赛季与银币规则都在 js/account.js；这里只负责把结果画到界面上。
   * 接真实服务端时，把 A.currentAccount / A.login 换成请求即可，界面不用改。
   */
  function store() { return A.makeStore(); }
  function loadAccount() { account = A.currentAccount(store()); return account; }
  function refreshAccount() { account = A.currentAccount(store()); return account; }
  function rankInfo(points) {
    return A.rankOf(points === undefined ? (account ? account.rankPoints : 0) : points);
  }
  function loadVariantId() {
    try {
      const id = localStorage.getItem(KEY_VARIANT);
      const v = C.getVariant(id);
      return v && v.available ? v.id : C.DEFAULT_VARIANT;
    } catch (_) { return C.DEFAULT_VARIANT; }
  }
  function saveVariantId() { try { localStorage.setItem(KEY_VARIANT, variantId); } catch (_) { /* ignore */ } }
  function saveHall() { try { localStorage.setItem(KEY_HALL, hallId); } catch (_) { /* ignore */ } }

  const SCREENS = ['splash', 'season', 'inherit', 'home', 'hall', 'table'];
  function showScreen(name) {
    screenId = name;
    SCREENS.forEach((s) => {
      const el = $('screen-' + s);
      if (el) el.classList.toggle('hidden', s !== name);
    });
  }
  function hideAllLayers() {
    document.querySelectorAll('.game-layer, .login-layer').forEach((el) => el.classList.add('hidden'));
  }

  /* ---------------- 调试日志 ---------------- */
  function stamp() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
      `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }
  function logLine(kind, text) {
    const entry = { at: stamp(), kind, text };
    LOGS.push(entry);
    if (LOGS.length > 400) LOGS.shift();
    const list = $('log-list');
    if (!list) return;
    const li = document.createElement('li');
    li.className = 'log-item log-' + kind;
    const time = document.createElement('span'); time.className = 'log-time'; time.textContent = entry.at;
    const body = document.createElement('span'); body.className = 'log-text'; body.textContent = text;
    li.append(time, body);
    list.appendChild(li);
    while (list.children.length > 120) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }
  function stateDigest() {
    if (!state) return 'state=null';
    const a = C.awaiting(state);
    const pending = state.pendingClaims.map((c) => `${c.seat}:${c.preferred}`).join(',') || '-';
    return `phase=${state.phase} cur=${state.current} wall=${state.wall.length} ` +
      `hands=${state.hands.map((h) => h.length).join('/')} ` +
      `discards=${state.discards.map((d) => d.length).join('/')} melds=${state.melds.map((m) => m.length).join('/')} ` +
      `pending=[${pending}] cursor=${state.claimCursor} await=${a ? a.seat + ':' + a.kind : 'none'} ` +
      `aiTask=${aiTask ? aiTask.seat + ':' + aiTask.kind + '@' + aiTask.epoch : 'off'} epoch=${epoch}`;
  }
  function logAction(type, source, detail) {
    const seat = state ? state.current : '-';
    logLine(type === 'error' ? 'error' : 'action',
      `${type} src=${source} seat=${seat} ${detail || ''} | ${stateDigest()}`);
  }

  /* ---------------- 音效 ---------------- */
  function syncSoundButton() {
    const b = $('sound-toggle');
    if (!b) return;
    b.textContent = soundEnabled ? '声音 开' : '声音 关';
    b.setAttribute('aria-pressed', String(soundEnabled));
  }
  function tone(freq, start, duration, volume, wave = 'sine') {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    const at = audioCtx.currentTime + start;
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(at); osc.stop(at + duration + 0.015);
  }
  function playSound(kind = 'ui') {
    if (!soundEnabled || !audioReady) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    try {
      if (!audioCtx) audioCtx = new Audio();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const bank = {
        ui: [[880, 0, 0.045, 0.018, 'sine']],
        zhuang: [[420, 0, 0.06, 0.02, 'triangle'], [620, 0.065, 0.07, 0.022, 'triangle'], [820, 0.14, 0.08, 0.024, 'triangle']],
        draw: [[690, 0, 0.055, 0.026, 'triangle'], [980, 0.035, 0.035, 0.012, 'sine']],
        discard: [[245, 0, 0.075, 0.045, 'triangle'], [720, 0.012, 0.025, 0.012, 'sine']],
        chi: [[420, 0, 0.08, 0.028, 'sine'], [560, 0.07, 0.09, 0.03, 'sine']],
        peng: [[520, 0, 0.07, 0.032, 'triangle'], [760, 0.065, 0.1, 0.032, 'triangle']],
        gang: [[360, 0, 0.1, 0.035, 'triangle'], [520, 0.09, 0.11, 0.035, 'triangle'], [760, 0.18, 0.13, 0.035, 'triangle']],
        hu: [[523, 0, 0.12, 0.035, 'sine'], [659, 0.12, 0.12, 0.038, 'sine'], [784, 0.24, 0.15, 0.04, 'sine'], [1046, 0.39, 0.24, 0.045, 'sine']]
      };
      (bank[kind] || bank.ui).forEach((v) => tone(...v));
    } catch (_) { /* ignore */ }
  }
  function toggleSound() {
    soundEnabled = !soundEnabled;
    try { localStorage.setItem(KEY_SOUND, soundEnabled ? 'on' : 'off'); } catch (_) { /* ignore */ }
    syncSoundButton();
    if (soundEnabled) { audioReady = true; playSound('ui'); }
  }

  /* ---------------- 牌元素 ---------------- */
  function tileEl(id, cls) {
    const e = document.createElement('div');
    e.className = 'tile-face tile-' + C.tileCode(id) + (cls ? ' ' + cls : '');
    e.title = C.tileLabel(id);
    e.setAttribute('aria-label', C.tileLabel(id));
    e.dataset.tile = String(id);
    return e;
  }
  function backEl() {
    const e = document.createElement('div');
    e.className = 'tile-back';
    return e;
  }
  function rectOf(el) { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }
  function seatSourceRect(seat) {
    if (seat === 0) {
      const tiles = $('hand-tiles');
      return tiles ? rectOf(tiles) : rectOf($('seat-0'));
    }
    const backs = $('back-' + seat);
    return backs ? rectOf(backs) : rectOf($('seat-' + seat));
  }
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ---------------- 出牌飞行动画 ---------------- */
  function flyDiscard(seat, tile, fromRect) {
    const target = $('discards-' + seat) && $('discards-' + seat).lastElementChild;
    if (!target) return;
    target.style.opacity = '0';
    const to = rectOf(target);
    const from = fromRect || seatSourceRect(seat);
    const w = to.width || 26, h = to.height || 36;
    const sx = from.left + from.width / 2 - w / 2;
    const sy = from.top + from.height / 2 - h / 2;
    const flying = tileEl(tile, 'discard-flight');
    Object.assign(flying.style, { left: sx + 'px', top: sy + 'px', width: w + 'px', height: h + 'px' });
    document.body.appendChild(flying);
    window.__shipingMahjongLastDiscardFlight = { seat, tile, from: { x: sx, y: sy }, to: { x: to.left, y: to.top } };
    const finish = () => { flying.remove(); target.style.opacity = ''; };
    if (reducedMotion() || typeof flying.animate !== 'function') { finish(); return; }
    const dx = to.left - sx, dy = to.top - sy;
    const anim = flying.animate([
      { transform: 'translate(0,0) scale(1.16) rotate(-6deg)', opacity: 0.96, offset: 0 },
      { transform: `translate(${dx * 0.55}px,${dy * 0.5 - 22}px) scale(1.06) rotate(3deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px,${dy}px) scale(1) rotate(0deg)`, opacity: 1, offset: 1 }
    ], { duration: 430, easing: 'cubic-bezier(.22,.72,.25,1)', fill: 'forwards' });
    anim.onfinish = finish;
    anim.oncancel = finish;
  }

  /* ---------------- 渲染 ---------------- */
  function computeSig() {
    return [
      state.phase, state.current, state.wall.length, state.dealer,
      state.hands.map((h) => h.length).join(','),
      state.discards.map((d) => d.length).join(','),
      state.melds.map((m) => m.map((x) => x.type + x.tiles.join('.')).join('|')).join(','),
      state.pendingClaims.length, state.claimCursor,
      state.lastDraw ? state.lastDraw.seat + ':' + state.lastDraw.tile : '-',
      state.scores.join(',')
    ].join('#');
  }
  function render(force) {
    if (!state) return;
    const sig = computeSig();
    if (!force && sig === renderSig) { renderSeatStatus(); return; }
    renderSig = sig;
    $('wall-count').textContent = '牌墙 ' + state.wall.length;
    $('hand-count').textContent = state.hands[0].length + ' 张';
    $('dealer-label').textContent = `${NAMES[state.dealer]} 坐庄 · ${state.wallBreak.side}墙第${state.wallBreak.stack}墩`;
    $('round-label').textContent = '第 ' + roundNo + ' 局';
    markDealer(state.dealer);
    markWallBreak(state.wallBreak.side);
    for (let s = 0; s < 4; s++) {
      renderBacks(s);
      renderMelds(s);
      renderDiscards(s);
    }
    renderHand();
    renderSeatStatus();
    loadSeatBalances();
  }
  function renderSeatStatus() {
    const activeSeat = state.phase === C.PHASES.OVER ? -1 : state.current;
    for (let s = 0; s < 4; s++) {
      const seatEl = $('seat-' + s);
      if (seatEl) seatEl.classList.toggle('active', state.phase === C.PHASES.DISCARD && activeSeat === s);
      const turnEl = $('turn-' + s);
      if (turnEl) turnEl.textContent = '';
    }
    if (state.phase === C.PHASES.OVER) {
      $('turn-label').textContent = '本局结束';
    } else if (state.phase === C.PHASES.CLAIM) {
      const cand = state.pendingClaims[state.claimCursor];
      $('turn-label').textContent = cand ? (cand.seat === 0 ? '轮到你决定：接牌或过' : NAMES[cand.seat] + ' 正在考虑接牌') : '结算中…';
    } else {
      $('turn-label').textContent = state.current === 0 ? '轮到你出牌' : '轮到' + NAMES[state.current] + '行动';
    }
    const tip = $('hand-tip');
    if (tip) {
      tip.textContent = state.phase === C.PHASES.OVER ? '本局已结束'
        : state.phase === C.PHASES.DISCARD && state.current === 0 ? '点击任意手牌出牌'
          : '等待其他玩家操作';
    }
    refreshTurnClock();
  }
  function renderBacks(s) {
    if (s === 0) return;
    const box = $('back-' + s);
    if (!box) return;
    const n = Math.min(state.hands[s].length, 14);
    if (box.children.length === n) return;
    box.innerHTML = '';
    for (let i = 0; i < n; i++) box.appendChild(backEl());
  }
  function meldLabelText(m) {
    const called = m.calledTile === undefined || m.calledTile === null ? m.tiles[0] : m.calledTile;
    if (m.type === 'chi') return '吃 ' + m.tiles.map(C.tileLabel).join('');
    if (m.type === 'peng') return '碰 ' + C.tileLabel(called);
    if (m.type === 'gang') return (m.concealed ? '暗杠 ' : m.added ? '补杠 ' : '明杠 ') + C.tileLabel(called);
    return m.type;
  }
  function renderMelds(s) {
    const box = $('meld-' + s);
    if (!box) return;
    box.innerHTML = '';
    state.melds[s].forEach((m) => {
      const group = document.createElement('div');
      group.className = 'meld-group meld-' + m.type + (m.concealed ? ' is-concealed' : '');
      const label = document.createElement('span');
      label.className = 'meld-label';
      label.textContent = meldLabelText(m);
      const fromText = m.calledFrom === undefined ? '本家' : SEATS[m.calledFrom] + ' ' + NAMES[m.calledFrom];
      label.title = m.calledTile === undefined ? label.textContent
        : `${label.textContent}（${fromText} 打出 ${C.tileLabel(m.calledTile)}）`;
      group.appendChild(label);
      const tiles = document.createElement('span');
      tiles.className = 'meld-tiles';
      m.tiles.forEach((id, index) => {
        const isCalled = Number.isInteger(m.calledTileIndex) && index === m.calledTileIndex && !m.concealed;
        const el = tileEl(id, isCalled ? 'meld-called-tile' : '');
        if (isCalled) {
          el.dataset.called = '1';
          el.dataset.calledFrom = String(m.calledFrom);
          el.title = '接 ' + SEATS[m.calledFrom] + ' ' + C.tileLabel(id);
          const pin = document.createElement('i');
          pin.className = 'called-pin';
          pin.textContent = '←';
          el.appendChild(pin);
        }
        tiles.appendChild(el);
      });
      group.appendChild(tiles);
      box.appendChild(group);
    });
  }
  function renderDiscards(s) {
    const box = $('discards-' + s);
    if (!box) return;
    const pile = state.discards[s];
    box.classList.toggle('is-dense', pile.length > 18);
    if (box.children.length === pile.length) {
      // 只更新最新一张的高亮，避免重排造成闪烁
      Array.from(box.children).forEach((el, i) => el.classList.toggle('latest-discard', i === pile.length - 1));
      return;
    }
    box.innerHTML = '';
    pile.forEach((id, index) => {
      const el = tileEl(id, index === pile.length - 1 ? 'latest-discard' : '');
      if (index === pile.length - 1) el.title = SEATS[s] + ' ' + NAMES[s] + ' 打出 ' + C.tileLabel(id);
      box.appendChild(el);
    });
  }
  function renderHand() {
    const box = $('hand-tiles');
    if (!box) return;
    const canPlay = state.phase === C.PHASES.DISCARD && state.current === 0;
    box.innerHTML = '';
    state.hands[0].forEach((id, i) => {
      const isDrawn = state.lastDraw && state.lastDraw.seat === 0 && i === state.hands[0].length - 1 && state.lastDraw.tile === id;
      const el = tileEl(id, (canPlay ? 'playable' : 'disabled') + (isDrawn ? ' drawn-tile' : ''));
      if (canPlay) el.addEventListener('click', () => humanDiscard(i));
      box.appendChild(el);
    });
    handRects = Array.from(box.children).map(rectOf);
  }
  function loadSeatBalances() {
    if (account) balances[0] = account.coins;
    for (let i = 0; i < 4; i++) {
      const coin = $('coin-' + i);
      if (coin) coin.textContent = A.fmtNum(balances[i]);
      const side = $('side-score-' + i);
      if (side) side.textContent = String(balances[i]);
    }
    refreshHeader();
  }
  /** 顶栏 + 自家座位牌：账号名、段位、场次、银币 */
  function refreshHeader() {
    if (!account) return;
    const r = rankInfo();
    const hall = A.hallOf(hallId);
    const title = $('brand-title');
    if (title) title.textContent = account.nick;
    const sub = $('brand-sub');
    if (sub) sub.textContent = r.name + ' · ' + hall.name;
    const mark = $('brand-mark');
    if (mark) mark.textContent = (account.nick || '牌').slice(0, 1);
    const top = $('bankroll-display');
    if (top) top.textContent = '银币 ' + A.fmtNum(account.coins);
    const name0 = $('seat-name-0');
    if (name0) name0.textContent = account.nick;
    const face0 = $('face-0');
    if (face0) face0.textContent = (account.nick || '牌').slice(0, 1);
    const rank0 = $('rank-0');
    if (rank0) rank0.textContent = r.name;
    const coin0 = $('coin-0');
    if (coin0) coin0.textContent = A.fmtNum(balances[0]);
    const bet = $('table-bet');
    if (bet) bet.textContent = '底注:' + A.fmtNum(hall.baseBet);
    const hudBet = $('hud-bet');
    if (hudBet) hudBet.textContent = '底注:' + A.fmtNum(hall.baseBet);
  }
  const AI_RANKS = ['中将', '中士', '少尉'];
  function paintSeatRanks() {
    for (let i = 1; i < 4; i++) {
      const el = $('rank-' + i);
      if (el) el.textContent = AI_RANKS[i - 1];
    }
  }

  function markDealer(dealer) {
    for (let i = 0; i < 4; i++) {
      const seat = $('seat-' + i);
      if (!seat) continue;
      seat.classList.toggle('dealer-seat', i === dealer);
      const top = seat.querySelector('.seat-top');
      if (!top) continue;
      let mark = top.querySelector('.dealer-mark');
      if (i === dealer && !mark) {
        mark = document.createElement('span');
        mark.className = 'dealer-mark';
        mark.textContent = '庄';
        top.appendChild(mark);
      } else if (i !== dealer && mark) mark.remove();
    }
  }
  function markWallBreak(side) {
    document.querySelectorAll('.wall-strip').forEach((x) => x.classList.remove('cut-wall'));
    const map = { '南': '.wall-south', '北': '.wall-north', '西': '.wall-east', '东': '.wall-west' };
    const el = document.querySelector(map[side] || '.wall-south');
    if (el) el.classList.add('cut-wall');
  }
  function refreshTurnClock() {
    const box = $('turn-clock');
    if (!box) return;
    const mine = state && state.phase === C.PHASES.DISCARD && state.current === 0;
    if (!mine) {
      if (turnClock) { clearInterval(turnClock); turnClock = null; }
      box.textContent = '–';
      box.classList.remove('urgent');
      return;
    }
    if (turnClock) return;
    turnLeft = 15;
    box.textContent = '15';
    box.classList.remove('urgent');
    turnClock = setInterval(() => {
      if (!state || state.phase !== C.PHASES.DISCARD || state.current !== 0) {
        clearInterval(turnClock); turnClock = null; return;
      }
      turnLeft = Math.max(0, turnLeft - 1);
      box.textContent = String(turnLeft).padStart(2, '0');
      box.classList.toggle('urgent', turnLeft <= 5);
      if (turnLeft === 0) { clearInterval(turnClock); turnClock = null; }
    }, 1000);
  }

  /* ---------------- 行动栏 ---------------- */
  function setActionBar(signature, build) {
    if (signature === barSig) return;
    barSig = signature;
    const bar = $('action-bar');
    bar.innerHTML = '';
    build(bar);
  }
  function addButton(bar, label, cls, handler) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-button action-' + cls;
    b.textContent = label;
    b.addEventListener('click', () => {
      audioReady = true;
      playSound('ui');
      handler();
    });
    bar.appendChild(b);
  }
  function addInfo(bar, text) {
    const n = document.createElement('div');
    n.className = 'action-info';
    n.textContent = text;
    bar.appendChild(n);
  }

  /* ---------------- 人类决策 ---------------- */
  function showHumanDecision(a) {
    decision = { seat: a.seat, kind: a.kind, at: Date.now() };
    if (a.kind === 'claim') {
      const cand = a.candidate;
      const types = cand.actions.map((x) => x.type).join(',');
      setActionBar('claim:' + state.lastDiscard.tile + ':' + types, (bar) => {
        addInfo(bar, SEATS[cand.seat] + ' 请选择：有人打出 ' + C.tileLabel(state.lastDiscard.tile));
        if (types.includes('hu')) addButton(bar, '胡牌', 'hu', () => humanClaim('hu'));
        if (types.includes('gang')) addButton(bar, '明杠', 'gang', () => humanClaim('gang'));
        if (types.includes('peng')) addButton(bar, '碰', 'peng', () => humanClaim('peng'));
        const chi = cand.actions.find((x) => x.type === 'chi');
        if (chi) {
          chi.options.forEach((opt, i) => {
            addButton(bar, '吃 ' + opt.meld.map(C.tileLabel).join(''), 'chi', () => humanClaim('chi', i));
          });
        }
        addButton(bar, '过', 'pass', humanPass);
      });
    } else {
      const own = C.selfActions(state, 0);
      const sig = 'discard:' + own.hu + ':' + own.concealedKongs.join('.') + ':' + own.addedKongs.join('.');
      setActionBar(sig, (bar) => {
        if (own.hu) addButton(bar, '自摸胡', 'hu', humanWin);
        own.concealedKongs.forEach((id) => addButton(bar, '暗杠 ' + C.tileLabel(id), 'gang', () => humanSelfKong('concealed', id)));
        own.addedKongs.forEach((id) => addButton(bar, '补杠 ' + C.tileLabel(id), 'gang', () => humanSelfKong('added', id)));
        if (!own.hu && !own.concealedKongs.length && !own.addedKongs.length) addInfo(bar, '选择一张手牌出牌');
        else addInfo(bar, '或点击手牌出牌');
      });
    }
  }

  /* ---------------- 命令包装 ---------------- */
  function command(source, fn) {
    if (!state) return;
    busy = true;
    try {
      fn();
    } catch (err) {
      logLine('error', `命令失败 src=${source}: ${err.message} | ${stateDigest()}`);
      console.error('[mahjong] command failed', err);
      toast(err.message || '操作失败');
    } finally {
      busy = false;
    }
    bumpEpoch();
    retryCount = 0;
    flushEvents(source);
    pump('after:' + source);
  }
  function bumpEpoch() {
    epoch += 1;
    if (aiTask) { clearTimeout(aiTask.id); aiTask = null; }
  }
  function flushEvents(source) {
    if (!state) return;
    const events = state.events;
    const consumed = state.__consumed || 0;
    const fresh = events.slice(consumed);
    state.__consumed = events.length;
    let discardFx = null;
    for (const ev of fresh) {
      switch (ev.type) {
        case 'draw':
          logLine('action', `摸牌 seat=${NAMES[ev.seat]} tile=${C.tileLabel(ev.tile)} wall=${ev.wall}`);
          if (ev.seat !== 0) playSound('draw');
          break;
        case 'discard':
          logLine('action', `出牌 src=${source} seat=${NAMES[ev.seat]} tile=${C.tileLabel(ev.tile)} pending=${ev.pending.join(',') || '无'}`);
          playSound('discard');
          if (ev.seat === 0 && beforeCapture) discardFx = { seat: 0, tile: ev.tile, rect: beforeCapture };
          else discardFx = { seat: ev.seat, tile: ev.tile, rect: null };
          updateCallout(ev.seat, ev.tile);
          break;
        case 'chi': case 'peng':
          logLine('action', `${ev.type === 'chi' ? '吃牌' : '碰牌'} seat=${NAMES[ev.seat]} tile=${C.tileLabel(ev.tile)} from=${NAMES[ev.from]}`);
          playSound(ev.type);
          break;
        case 'gang':
          logLine('action', `杠牌(${ev.kind}) seat=${NAMES[ev.seat]} tile=${C.tileLabel(ev.tile)}`);
          playSound('gang');
          break;
        case 'hu':
          logLine('action', `胡牌 seat=${NAMES[ev.seat]} ${ev.source} tile=${C.tileLabel(ev.tile)}`);
          playSound('hu');
          break;
        case 'pass':
          logLine('action', `过牌 seat=${NAMES[ev.seat]}`);
          break;
        case 'draw-end':
          logLine('action', '荒牌，牌墙已摸完');
          break;
        default:
          break;
      }
    }
    beforeCapture = null;
    if (discardFx) {
      const fx = discardFx;
      render(true);
      flyDiscard(fx.seat, fx.tile, fx.rect);
    }
  }
  function updateCallout(seat, tile) {
    const callout = $('discard-callout');
    if (!callout) return;
    callout.textContent = SEATS[seat] + ' · ' + NAMES[seat] + ' 打出 ' + C.tileLabel(tile);
    callout.classList.remove('hidden');
    callout.dataset.seat = String(seat);
    clearTimeout(callout.__t);
    callout.__t = setTimeout(() => callout.classList.add('hidden'), 2600);
  }

  /* ---------------- 人类操作 ---------------- */
  function humanDiscard(index) {
    if (busy || !state || state.phase !== C.PHASES.DISCARD || state.current !== 0) return;
    beforeCapture = handRects[index] || null;
    command('human', () => C.discardTile(state, 0, index));
  }
  function humanClaim(type, optionIndex) {
    if (busy || !state || state.phase !== C.PHASES.CLAIM) return;
    command('human', () => C.claimDiscard(state, 0, type, optionIndex || 0));
  }
  function humanPass() {
    if (busy || !state || state.phase !== C.PHASES.CLAIM) return;
    command('human', () => C.passClaim(state, 0));
  }
  function humanSelfKong(type, tile) {
    if (busy || !state) return;
    command('human', () => C.claimSelfKong(state, 0, type, tile));
  }
  function humanWin() {
    if (busy || !state) return;
    command('human', () => C.winSelf(state, 0));
  }

  /* ---------------- AI 调度 ---------------- */
  function scheduleAi(a) {
    if (aiTask && aiTask.epoch === epoch && aiTask.seat === a.seat && aiTask.kind === a.kind) return;
    if (aiTask) { clearTimeout(aiTask.id); aiTask = null; }
    const base = a.kind === 'claim' ? SPEED.claim : SPEED.discard;
    const delay = Math.max(0, Math.round(base * speedScale));
    const myEpoch = epoch;
    const seat = a.seat, kind = a.kind;
    const id = setTimeout(() => runAi(seat, kind, myEpoch), delay);
    aiTask = { id, seat, kind, epoch: myEpoch, due: Date.now() + delay };
    decisionAt = Date.now();
    setActionBar('waiting:' + seat + kind, (bar) => addInfo(bar, NAMES[seat] + (kind === 'claim' ? ' 正在决定是否接牌…' : ' 正在出牌…')));
  }
  function runAi(seat, kind, myEpoch) {
    aiTask = null;
    if (myEpoch !== epoch) { logLine('action', '跳过过期 AI 任务'); return; }
    if (!state || state.phase === C.PHASES.OVER) return;
    const a = C.awaiting(state);
    if (!a || a.seat !== seat || a.kind !== kind) {
      logLine('action', `AI 任务与局面不符（task=${seat}:${kind}），重新同步`);
      pump('stale-ai');
      return;
    }
    const d = C.aiDecide(state, seat);
    if (!d) { logLine('error', 'AI 没有可用决策'); pump('ai-null'); return; }
    command('ai', () => C.applyDecision(state, d));
  }

  /* ---------------- 主循环 ---------------- */
  function pump(reason) {
    if (!state) return;
    if (state.phase === C.PHASES.OVER) {
      if (aiTask) { clearTimeout(aiTask.id); aiTask = null; }
      decision = null;
      barSig = 'over';
      render(true);
      settleRound();
      showResult();
      return;
    }
    const a = C.awaiting(state);
    if (!a) {
      logLine('error', `awaiting 为空但局面未结束 reason=${reason} | ${stateDigest()}`);
      return;
    }
    render();
    if (a.seat === 0 && !autoPlay) {
      if (!decision || decision.kind !== a.kind) decisionAt = Date.now();
      showHumanDecision(a);
      return;
    }
    scheduleAi(a);
  }
  function heartbeatTick() {
    if (!state || state.phase === C.PHASES.OVER) return;
    const a = C.awaiting(state);
    if (!a) return;
    if (a.seat === 0 && !autoPlay) return;
    const healthy = aiTask && aiTask.epoch === epoch;
    const age = Date.now() - decisionAt;
    if (healthy && age < 12000) return;
    if (!healthy && age > STALL_MS) {
      retryCount += 1;
      logLine('recover', `检测到回合任务缺失，重新排程（第 ${retryCount} 次）| ${stateDigest()}`);
      if (retryCount > MAX_RETRY) {
        logLine('error', `连续 ${MAX_RETRY} 次无法推进回合，本局标记为异常 | ${stateDigest()}`);
        abortRound('回合调度异常，已中止本局');
        return;
      }
      if (aiTask) { clearTimeout(aiTask.id); aiTask = null; }
      pump('heartbeat');
    }
  }
  function abortRound(message) {
    if (!state) return;
    stopAi();
    state.phase = C.PHASES.OVER;
    state.result = { type: 'abort', title: '本局异常中止', detail: message };
    render(true);
    settleRound();
    showResult();
    toast(message);
  }
  function stopAi() {
    if (aiTask) { clearTimeout(aiTask.id); aiTask = null; }
    epoch += 1;
  }

  /* ---------------- 结算 ---------------- */
  function settleRound() {
    if (!state || state.phase !== C.PHASES.OVER || settledState === state) return;
    settledState = state;
    const r = state.result || {};
    const hall = A.hallOf(hallId);
    const winner = Number.isInteger(r.seat) ? r.seat : -1;
    settlement = A.computeRound({
      type: r.type === 'self' ? 'self' : (r.type === 'discard' ? 'discard' : 'draw'),
      baseBet: hall.baseBet,
      winnerSeat: winner,
      discarderSeat: r.type === 'discard' ? r.from : -1,
      dealerWin: winner >= 0 && winner === state.dealer,
      balances: balances.slice()
    });
    for (let i = 0; i < 4; i++) balances[i] = Math.max(0, balances[i] + settlement.deltas[i]);
    rankDelta = A.computeRankDelta(settlement);
    if (account) {
      account = A.applyRound(store(), account, settlement, {
        rankDelta,
        kongs: state.kongLog ? state.kongLog.length : 0
      });
      balances[0] = account.coins;
    }
    saveBankroll();
    loadSeatBalances();
    logLine('action', `本局结算 银币=${settlement.deltas.join('/')} 倍数=${settlement.multiplier} 段位分=${rankDelta.join('/')} 余额=${balances.join('/')}`);
  }
  function resultTitle(r) {
    if (!r) return '本局结束';
    if (r.type === 'draw') return '荒牌';
    if (r.type === 'abort') return '本局中止';
    return r.winningType || (r.type === 'self' ? '自摸' : '平胡');
  }
  function resultCard(seat, winner, r) {
    const isSelf = seat === 0;
    const isWinner = seat === winner;
    const card = document.createElement('div');
    card.className = isWinner ? 'result-self' : 'result-other';
    card.dataset.seat = String(seat);

    const name = isSelf && account ? account.nick : NAMES[seat] + ' · ' + SEATS[seat];
    const rankName = isSelf ? rankInfo().name : AI_RANKS[seat - 1];
    const head = document.createElement('div');
    head.className = 'rs-head';
    const face = document.createElement('span');
    face.className = 'rs-face';
    face.textContent = (name || '牌').slice(0, 1);
    const nameEl = document.createElement('span');
    nameEl.className = 'rs-name';
    nameEl.textContent = name;
    const tag = document.createElement('span');
    tag.className = 'rs-tag';
    tag.textContent = rankName;
    head.append(face, nameEl, tag);
    if (isSelf) {
      const me = document.createElement('span');
      me.className = 'rs-tag';
      me.textContent = '自己';
      head.appendChild(me);
    }
    card.appendChild(head);

    if (settlement && settlement.busted[seat]) {
      const bust = document.createElement('span');
      bust.className = 'rs-status';
      bust.textContent = '破产';
      card.appendChild(bust);
    }

    const lines = document.createElement('div');
    lines.className = 'rs-lines';
    const addLine = (label, value) => {
      const row = document.createElement('div');
      row.className = 'rs-line';
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('span');
      v.textContent = value;
      row.append(l, v);
      lines.appendChild(row);
    };
    if (settlement && settlement.multiplier) {
      if (isWinner) {
        addLine(resultTitle(r), '1 倍');
        if (winner === state.dealer) addLine('庄家', '2 倍');
        addLine('合计', settlement.multiplier + ' 倍');
      } else {
        addLine(settlement.reasons[seat] || '输', settlement.multiplier + ' 倍');
      }
    }
    card.appendChild(lines);

    const total = document.createElement('div');
    total.className = 'rs-total';
    total.textContent = A.fmtSigned(settlement ? settlement.deltas[seat] : 0);
    card.appendChild(total);
    return card;
  }

  function showResult() {
    if (!state || !state.result) return;
    const r = state.result;
    $('result-title').textContent = resultTitle(r);
    const winner = Number.isInteger(r.seat) ? r.seat : -1;

    const handRow = $('result-hand');
    handRow.innerHTML = '';
    const hand = r.winningHand || (winner >= 0 ? state.hands[winner] : []);
    hand.forEach((id, i) => {
      const isWin = winner >= 0 && i === hand.length - 1 && id === r.winningTile;
      handRow.appendChild(tileEl(id, isWin ? 'winning-tile' : ''));
    });
    handRow.classList.toggle('hidden', !hand.length);

    const selfBox = $('result-self');
    selfBox.innerHTML = '';
    const others = $('result-others');
    others.innerHTML = '';

    if (winner >= 0) {
      selfBox.appendChild(resultCard(winner, winner, r));
      [0, 1, 2, 3].filter((s) => s !== winner).forEach((s) => others.appendChild(resultCard(s, winner, r)));
    } else {
      const msg = document.createElement('div');
      msg.className = 'rs-total';
      msg.textContent = r.type === 'abort' ? '本局已中止，不计入战绩' : '本局荒牌，银币不变';
      selfBox.appendChild(msg);
      for (let s = 0; s < 4; s++) others.appendChild(resultCard(s, -1, r));
    }

    const bar = $('result-rankbar');
    bar.innerHTML = '';
    if (account) {
      const info = rankInfo();
      const delta = rankDelta ? rankDelta[0] : 0;
      const label = document.createElement('b');
      label.textContent = info.name;
      const text = document.createElement('span');
      text.textContent = info.text;
      const mini = document.createElement('span');
      mini.className = 'result-rank-mini';
      const fill = document.createElement('i');
      fill.style.width = Math.round(info.ratio * 100) + '%';
      mini.appendChild(fill);
      const d = document.createElement('span');
      d.textContent = A.fmtSigned(delta) + ' 段位分';
      d.style.color = delta >= 0 ? '#ffd76a' : '#8fd4ff';
      bar.append(label, text, mini, d);
    }

    $('result-modal').classList.remove('hidden');
    document.querySelector('.table-frame').classList.add('round-over');
  }
  function hideResult() {
    $('result-modal').classList.add('hidden');
    const frame = document.querySelector('.table-frame');
    if (frame) frame.classList.remove('round-over');
  }
  function fmt(n) { return A.fmtSigned(n); }

  /* ---------------- 掷骰子 ---------------- */
  const DIE_FACES = [
    { name: 'front', value: 1, transform: 'translateZ(33px)' },
    { name: 'back', value: 6, transform: 'rotateY(180deg) translateZ(33px)' },
    { name: 'right', value: 3, transform: 'rotateY(90deg) translateZ(33px)' },
    { name: 'left', value: 4, transform: 'rotateY(-90deg) translateZ(33px)' },
    { name: 'top', value: 2, transform: 'rotateX(90deg) translateZ(33px)' },
    { name: 'bottom', value: 5, transform: 'rotateX(-90deg) translateZ(33px)' }
  ];
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const SETTLED = {
    1: 'rotateX(0deg) rotateY(0deg)',
    2: 'rotateX(-90deg) rotateY(0deg)',
    3: 'rotateX(0deg) rotateY(-90deg)',
    4: 'rotateX(0deg) rotateY(90deg)',
    5: 'rotateX(90deg) rotateY(0deg)',
    6: 'rotateX(0deg) rotateY(180deg)'
  };
  function buildCube(id) {
    const host = $(id);
    if (!host) return null;
    let cube = host.querySelector('.die-cube3d');
    if (cube) return cube;
    cube = document.createElement('div');
    cube.className = 'die-cube3d';
    DIE_FACES.forEach((face) => {
      const panel = document.createElement('div');
      panel.className = 'die-face die-' + face.name;
      panel.dataset.face = String(face.value);
      panel.style.transform = face.transform;
      for (let i = 0; i < 9; i++) {
        const dot = document.createElement('i');
        if (PIPS[face.value].includes(i)) dot.className = 'on';
        panel.appendChild(dot);
      }
      cube.appendChild(panel);
    });
    host.appendChild(cube);
    return cube;
  }
  function setFace(id, value) {
    const host = $(id);
    const cube = buildCube(id);
    if (!host || !cube) return;
    host.dataset.value = String(value);
    if (!host.classList.contains('rolling')) cube.style.transform = SETTLED[value] || SETTLED[1];
  }
  function rollDice(dice) {
    return new Promise((resolve) => {
      const overlay = $('dice-overlay');
      overlay.classList.remove('hidden');
      $('dice-outcome').textContent = '掷骰中…';
      $('dice-subtitle').textContent = '点数决定庄家与开牌位置';
      buildCube('dice-one'); buildCube('dice-two');
      ['dice-one', 'dice-two'].forEach((id) => {
        const host = $(id);
        host.classList.add('rolling');
        host.classList.remove('landed');
      });
      const spin = setInterval(() => {
        ['dice-one', 'dice-two'].forEach((id) => {
          const host = $(id);
          const cube = host.querySelector('.die-cube3d');
          if (cube) cube.style.transform = `rotateX(${Math.floor(Math.random() * 360)}deg) rotateY(${Math.floor(Math.random() * 360)}deg)`;
        });
      }, 90);
      const rollMs = 1150 * speedScale;
      setTimeout(() => {
        clearInterval(spin);
        ['dice-one', 'dice-two'].forEach((id, i) => {
          const host = $(id);
          host.classList.remove('rolling');
          host.classList.add('landed');
          // 记录真实点数：dataset 供视觉回归使用，同时保证正面就是掷出的点数
          host.dataset.value = String(dice[i]);
          const cube = buildCube(id);
          // 先落到略过一点的角度，再回弹到真实点数，形成落桌感
          cube.style.transition = 'transform .34s cubic-bezier(.3,.9,.4,1)';
          cube.style.transform = SETTLED[dice[i]] ? SETTLED[dice[i]].replace(/(-?\d+)deg/g, (m, n) => (Number(n) + (n.startsWith('-') ? -12 : 12)) + 'deg') : SETTLED[1];
          setTimeout(() => {
            cube.style.transition = 'transform .26s cubic-bezier(.2,.8,.3,1)';
            cube.style.transform = SETTLED[dice[i]];
          }, 200);
        });
        const setup = C.diceSetup(dice);
        $('dice-outcome').textContent = `点数 ${dice[0]} + ${dice[1]} = ${setup.sum} · ${NAMES[setup.dealer]} 坐庄`;
        $('dice-subtitle').textContent = `从${setup.wallSide}墙第 ${setup.wallStack} 墩开牌`;
        playSound('zhuang');
        lastDice = { dice: dice.slice(), sum: setup.sum, dealer: setup.dealer, wallSide: setup.wallSide, wallStack: setup.wallStack };
        setTimeout(() => {
          overlay.classList.add('hidden');
          resolve(setup);
        }, 780 * speedScale);
      }, rollMs);
    });
  }

  /* ---------------- 本地大厅：玩家档案 + 玩法选择 ---------------- */
  /* ---------------- 登录 / 注册 ---------------- */
  function openLogin(focusPassword) {
    $('login-modal').classList.remove('hidden');
    loginTip('');
    const acc = $('login-account');
    if (acc && !acc.value) {
      try { acc.value = localStorage.getItem('honghe-last-account') || ''; } catch (_) { /* ignore */ }
    }
    const pw = $('login-password');
    if (pw) pw.value = '';
    renderHistory();
    setTimeout(() => {
      const el = focusPassword || (acc && acc.value) ? $('login-password') : acc;
      if (el) el.focus();
    }, 60);
  }
  function renderHistory() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('honghe-accounts-v1') || '[]').map((a) => a.account); } catch (_) { list = []; }
    const box = $('login-history');
    box.innerHTML = '';
    list.slice(-6).reverse().forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a;
      b.addEventListener('click', () => {
        $('login-account').value = a;
        box.classList.add('hidden');
        $('login-password').focus();
      });
      box.appendChild(b);
    });
    box.classList.toggle('hidden', !list.length);
  }
  function loginTip(msg, ok) {
    const t = $('login-tip');
    if (!t) return;
    t.textContent = msg || '';
    t.className = 'login-tip' + (ok ? ' ok' : '');
  }
  function doLogin() {
    const acc = $('login-account').value.trim();
    const pw = $('login-password').value;
    if (!acc) return loginTip('请输入账号');
    if (!pw) return loginTip('请输入密码');
    const res = A.login(store(), { account: acc, password: pw });
    if (!res.ok) return loginTip(res.error);
    A.setSession(store(), res.account.id);
    try { localStorage.setItem('honghe-last-account', acc); } catch (_) { /* ignore */ }
    account = res.account;
    hideAllLayers();
    playSound('ui');
    afterLogin(false);
  }
  function doRegister() {
    const acc = $('login-account').value.trim();
    const pw = $('login-password').value;
    if (!acc) return loginTip('请输入要注册的账号');
    if (!pw) return loginTip('请设置密码');
    const res = A.register(store(), { account: acc, password: pw, nick: acc });
    if (!res.ok) return loginTip(res.error);
    A.setSession(store(), res.account.id);
    try { localStorage.setItem('honghe-last-account', acc); } catch (_) { /* ignore */ }
    account = res.account;
    hideAllLayers();
    playSound('ui');
    toast('注册成功，欢迎 ' + res.account.nick);
    afterLogin(true);
  }
  /** 新号先发一份见面礼（截图里的「恭喜获得 银币 ×4000」），再进赛季流程 */
  function afterLogin(isNew) {
    refreshAccount();
    if (isNew) {
      account.coins += 4000;
      account = A.update(store(), account);
      showReward(4000, '银币');
    }
    maybeSeasonFlow();
  }

  /* ---------------- 赛季流程 ---------------- */
  function seasonSeenKey() { return 'honghe-season-seen-' + A.SEASON.id; }
  function maybeSeasonFlow() {
    let seen = false;
    try { seen = !!localStorage.getItem(seasonSeenKey()); } catch (_) { seen = false; }
    if (seen) { enterHome(); return; }
    showScreen('season');
  }
  function gotoInherit() {
    const st = A.inheritState(account);
    $('inherit-prev-badge').textContent = st.prevRank;
    $('inherit-prev-pts').textContent = st.prevPoints;
    $('inherit-now-badge').textContent = st.nowRank;
    $('inherit-now-pts').textContent = st.nowPoints;
    showScreen('inherit');
  }
  function finishSeason() {
    try { localStorage.setItem(seasonSeenKey(), '1'); } catch (_) { /* ignore */ }
    enterHome();
    toast('S25 赛季开始，祝你旗开得胜');
  }

  /* ---------------- 主界面 ---------------- */
  const HOME_GRID = [
    { label: '存钱罐', ico: '罐', tone: 'red' },
    { label: '破产回馈', ico: '馈', tone: 'red' },
    { label: '回归好礼', ico: '礼', tone: 'purple', act: 'back' },
    { label: '超值连买', ico: '买', tone: 'blue' },
    { label: '幸运宝箱', ico: '箱', tone: 'orange' },
    { label: '每日签到', ico: '签', tone: 'blue', act: 'signin' },
    { label: '首充', ico: '充', tone: 'red' },
    { label: '摇钱树', ico: '树', tone: 'green' },
    { label: '定时登录', ico: '登', tone: 'pink', act: 'signin' },
    { label: '金秋好礼', ico: '秋', tone: 'orange', act: 'back' },
    { label: '周月卡', ico: '卡', tone: 'purple' },
    { label: '折扣礼包', ico: '包', tone: 'pink' }
  ];
  const OTHER_GAMES = [
    { name: '玩斗地主', bg: 'linear-gradient(150deg,#f0b352,#b9722a)' },
    { name: '填大坑', bg: 'linear-gradient(150deg,#e88fa8,#a8416b)' },
    { name: '掼蛋', bg: 'linear-gradient(150deg,#7fc4e8,#2f6fa8)' },
    { name: '红中流成河', bg: 'linear-gradient(150deg,#c99ae8,#6a3fa8)' }
  ];
  function renderHomeGrid() {
    const box = $('home-grid');
    box.innerHTML = '';
    HOME_GRID.forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'grid-tile';
      b.dataset.tone = g.tone;
      if (g.act) b.dataset.act = g.act;
      if (g.dot) {
        const dot = document.createElement('i');
        dot.className = 'gt-dot';
        b.appendChild(dot);
      }
      const ico = document.createElement('span');
      ico.className = 'gt-ico';
      ico.textContent = g.ico;
      const label = document.createElement('span');
      label.textContent = g.label;
      b.append(ico, label);
      box.appendChild(b);
    });
  }
  function renderLadder() {
    const list = $('ladder-list');
    if (!list) return;
    list.innerHTML = '';
    const seeds = ['长', '双', '州', '梅'];
    seeds.forEach((ch, i) => {
      const row = document.createElement('div');
      row.className = 'ladder-row';
      const face = document.createElement('i');
      face.textContent = ch;
      const name = document.createElement('span');
      name.textContent = i === 0 && account ? account.nick : ['小双州黯', '一路发', '梅子', '老李'][i];
      row.append(face, name);
      list.appendChild(row);
    });
  }
  function renderOtherGames() {
    const box = $('other-list');
    if (!box) return;
    box.innerHTML = '';
    OTHER_GAMES.forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'other-card';
      b.style.background = g.bg;
      const label = document.createElement('b');
      label.textContent = g.name;
      b.appendChild(label);
      b.addEventListener('click', () => toast(g.name + ' 还没有上线'));
      box.appendChild(b);
    });
  }
  function renderHome() {
    if (!account) return;
    const info = rankInfo();
    $('home-nick').textContent = account.nick;
    $('home-rank').textContent = info.name;
    $('home-coins').textContent = A.fmtNum(account.coins);
    $('home-gold').textContent = A.fmtNum(account.gold);
    $('home-avatar').textContent = (account.nick || '牌').slice(0, 1);
    const hall = A.hallOf(hallId);
    const q = $('quick-hall');
    if (q) q.textContent = hall.name + ' · 个旧麻将';
    const clock = $('act-clock');
    if (clock) clock.textContent = '23:20';
    renderLadder();
    renderOtherGames();
    if (!$('home-grid').children.length) renderHomeGrid();
  }
  function enterHome() {
    if (!account) { showScreen('splash'); return; }
    refreshAccount();
    renderHome();
    showScreen('home');
  }

  /* ---------------- 场次 ---------------- */
  function openHall() {
    if (!account) { openLogin(); return; }
    refreshAccount();
    const info = rankInfo();
    $('hall-nick').textContent = account.nick;
    $('hall-coins').textContent = A.fmtNum(account.coins);
    $('hall-avatar').textContent = (account.nick || '牌').slice(0, 1);
    $('hall-rank-name').textContent = info.name;
    $('hall-emblem-text').textContent = info.name.slice(0, 2);
    $('hall-rank-bar').style.width = Math.round(info.ratio * 100) + '%';
    $('hall-rank-text').textContent = info.text;
    const q = $('hall-quick-hall');
    if (q) q.textContent = A.hallOf(hallId).name;
    renderHallTables();
    showScreen('hall');
  }
  function renderHallTables() {
    const box = $('hall-tables');
    box.innerHTML = '';
    A.HALLS.forEach((h) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'hall-card';
      card.dataset.hall = h.id;

      const packs = document.createElement('span');
      packs.className = 'hall-packs';
      packs.dataset.tier = h.tier;

      const main = document.createElement('span');
      main.className = 'hall-card-main';
      const top = document.createElement('span');
      top.className = 'hall-card-top';
      const nm = document.createElement('b');
      nm.textContent = h.name;
      const bet = document.createElement('i');
      bet.textContent = A.fmtNum(h.baseBet) + '底分';
      top.append(nm, bet);

      const meta = document.createElement('span');
      meta.className = 'hall-card-meta';
      const range = document.createElement('span');
      range.innerHTML = '<svg class="ico"><use href="#i-coin"/></svg>' + A.coinsRangeText(h);
      const online = document.createElement('span');
      online.textContent = '在线 ' + A.fmtNum(h.online) + ' 人';
      meta.append(range, online);
      main.append(top, meta);
      card.append(packs, main);

      if (account.coins < h.minCoins) {
        const lock = document.createElement('span');
        lock.className = 'hall-lock';
        lock.textContent = '银币不足 ' + A.fmtNum(h.minCoins);
        card.appendChild(lock);
      }
      card.addEventListener('click', () => {
        if (account.coins < h.minCoins) {
          toast('银币不足，' + h.name + ' 至少需要 ' + A.fmtNum(h.minCoins));
          return;
        }
        startTable(h.id);
      });
      box.appendChild(card);
    });
  }
  function tableStacks(myCoins, hall) {
    const base = Math.max(hall.baseBet * 4, 20000);
    const rnd = () => base + Math.round(Math.random() * base);
    return [myCoins, rnd(), rnd(), rnd()];
  }
  function startTable(id) {
    if (!account) { openLogin(); return; }
    if (id) hallId = id;
    saveHall();
    hideAllLayers();
    hideResult();
    balances = tableStacks(account.coins, A.hallOf(hallId));
    saveBankroll();
    settlement = null;
    rankDelta = null;
    showScreen('table');
    paintSeatRanks();
    loadSeatBalances();
    roundNo += 1;
    saveRoundNo();
    newGame();
  }

  /* ---------------- 签到 / 回归 / 奖励 ---------------- */
  function openSignin() {
    if (!account) return;
    renderSignin();
    $('signin-modal').classList.remove('hidden');
  }
  function renderSignin() {
    const st = A.signinState(account, new Date());
    const grid = $('signin-grid');
    grid.innerHTML = '';
    for (let d = 1; d <= st.days; d++) {
      const cell = document.createElement('div');
      cell.className = 'signin-cell';
      if (st.claimed.includes(d)) cell.classList.add('claimed');
      else if (d === st.nextDay) cell.classList.add('today');
      else cell.classList.add('locked');
      const day = document.createElement('span');
      day.className = 'cell-day';
      day.textContent = '第' + d + '天';
      const coin = document.createElement('span');
      coin.className = 'cell-coin';
      coin.textContent = A.fmtNum(st.dayCoins);
      cell.append(day, coin);
      grid.appendChild(cell);
    }
    $('signin-cards').textContent = '0';
    const streak = $('streak-claim');
    if (streak) streak.classList.toggle('ready', st.canClaimStreak);
    const doBtn = $('signin-do');
    if (doBtn) {
      doBtn.disabled = !st.canClaimToday;
      doBtn.textContent = st.canClaimToday ? '签 到' : '今日已签到';
    }
  }
  function doSignin() {
    const res = A.claimSignin(store(), account, new Date());
    if (!res.ok) { toast(res.error); return; }
    refreshAccount();
    renderSignin();
    renderHome();
    showReward(res.coins, '银币');
    playSound('coin');
  }
  function claimStreak() {
    const st = A.signinState(account, new Date());
    if (!st.canClaimStreak) { toast('连续登录 3 天后可领取'); return; }
    account.gold += st.streakReward;
    account.signin.streakClaimed = (account.signin.streakClaimed || 0) + 1;
    account = A.update(store(), account);
    renderSignin();
    renderHome();
    showReward(st.streakReward, '金条');
  }
  function openBack() {
    if (!account) return;
    renderBack();
    $('back-modal').classList.remove('hidden');
  }
  function renderBack() {
    const st = A.backState(account);
    const grid = $('back-grid');
    grid.innerHTML = '';
    for (let d = 1; d <= st.days; d++) {
      const cell = document.createElement('div');
      cell.className = 'back-cell';
      const claimed = st.claimed.includes(d);
      const canClaim = !claimed && d === st.nextDay;
      if (claimed) cell.classList.add('locked');
      if (canClaim) cell.classList.add('claimable');
      const day = document.createElement('span');
      day.className = 'cell-day';
      day.textContent = '第' + ['一', '二', '三', '四', '五', '六', '七'][d - 1] + '天';
      const coin = document.createElement('span');
      coin.className = 'cell-coin';
      coin.textContent = A.fmtNum(st.dayCoins);
      cell.append(day, coin);
      if (claimed) {
        const mark = document.createElement('span');
        mark.className = 'cell-btn';
        mark.textContent = '已领取';
        cell.appendChild(mark);
      } else if (canClaim) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cell-btn';
        btn.textContent = '领取';
        btn.addEventListener('click', () => {
          const res = A.claimBack(store(), account, d);
          if (!res.ok) { toast(res.error); return; }
          refreshAccount();
          renderBack();
          renderHome();
          showReward(res.coins, '银币');
        });
        cell.appendChild(btn);
      }
      grid.appendChild(cell);
    }
    const left = $('back-left');
    if (left) left.textContent = '03 天 00:39';
  }
  function showReward(amount, name) {
    $('reward-amount').textContent = '×' + A.fmtNum(amount);
    $('reward-name').textContent = name;
    $('reward-modal').classList.remove('hidden');
  }

  /* ---------------- 结算后的去向 ---------------- */
  function resultContinue() {
    hideResult();
    enterHome();
  }
  function resultSwitch() {
    hideResult();
    enterHome();
    openHall();
  }
  function resultShare() {
    toast('分享链接已复制：' + location.href.split('?')[0]);
  }

  /* ---------------- 外壳事件 ---------------- */
  function on(id, type, fn) {
    const el = $(id);
    if (el) el.addEventListener(type, fn);
  }
  function bindShell() {
    on('btn-wechat', 'click', () => {
      toast('微信登录需要接入开放平台，当前用账号登录');
      openLogin();
    });
    on('btn-phone', 'click', () => openLogin());
    on('splash-cs', 'click', () => toast('客服：honghe@example.com'));
    on('login-cs', 'click', () => toast('客服：honghe@example.com'));
    on('login-close', 'click', () => $('login-modal').classList.add('hidden'));
    on('do-login', 'click', doLogin);
    on('do-register', 'click', doRegister);
    on('login-clear', 'click', () => { $('login-account').value = ''; $('login-account').focus(); });
    on('login-caret', 'click', () => $('login-history').classList.toggle('hidden'));
    on('forgot-pw', 'click', () => loginTip('本机账号请重新注册，密码不提供找回', false));
    on('login-password', 'keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    on('login-account', 'keydown', (e) => { if (e.key === 'Enter') $('login-password').focus(); });

    on('screen-season', 'click', gotoInherit);
    on('screen-inherit', 'click', finishSeason);

    on('quick-start', 'click', openHall);
    on('hall-quick', 'click', () => {
      const hall = A.hallOf(hallId);
      if (account && account.coins < hall.minCoins) { toast('银币不足，至少需要 ' + A.fmtNum(hall.minCoins)); return; }
      startTable(hall.id);
    });
    on('hall-back', 'click', enterHome);
    on('hall-help', 'click', () => toast('底分越高，输赢越大；段位分只与胜负有关'));
    on('home-ladder', 'click', () => toast('天梯榜需要联机数据'));
    on('ladder-more', 'click', () => toast('天梯榜需要联机数据'));
    on('game-gejiu', 'click', openHall);
    on('game-shuangkou', 'click', () => toast('双扣还没上线'));
    on('game-poker', 'click', () => toast('扑克合集还没上线'));
    on('game-mahjong', 'click', openHall);
    on('game-match', 'click', () => toast('比赛场需要联机'));
    on('game-invite', 'click', () => toast('约牌需要联机'));

    document.querySelectorAll('.home-nav').forEach((nav) => {
      nav.addEventListener('click', (e) => {
        const btn = e.target.closest('.nav-item');
        if (!btn) return;
        const act = btn.dataset.nav;
        if (act === 'signin') return openSignin();
        if (act === 'deals') return openBack();
        if (act === 'rank') return toast('当前段位：' + rankInfo().name + ' ' + rankInfo().text);
        const names = { shop: '商城', bag: '背包', mail: '邮件', task: '任务', dress: '装扮', more: '更多' };
        toast((names[act] || '该功能') + '还在开发中');
      });
    });
    on('home-grid', 'click', (e) => {
      const tile = e.target.closest('.grid-tile');
      if (!tile) return;
      if (tile.dataset.act === 'signin') return openSignin();
      if (tile.dataset.act === 'back') return openBack();
      toast('活动还没上线');
    });
    document.querySelectorAll('.hall-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.hall-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        if (tab.dataset.tab === 'gold') toast('金条场还没开放，先用标准场');
      });
    });
    document.querySelectorAll('.rank-act').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'reward') return toast('赛季奖励在第 3 天登录后可领');
        toast('天梯榜需要联机数据');
      });
    });

    on('signin-do', 'click', doSignin);
    on('streak-claim', 'click', claimStreak);
    on('reward-ok', 'click', () => $('reward-modal').classList.add('hidden'));

    on('result-continue', 'click', resultContinue);
    on('result-switch', 'click', resultSwitch);
    on('result-share', 'click', resultShare);
    on('result-close', 'click', () => { hideResult(); enterHome(); });

    const brand = $('brand');
    if (brand) {
      brand.addEventListener('click', () => { audioReady = true; playSound('ui'); enterHome(); });
      brand.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterHome(); } });
    }
  }

  /* ---------------- 开局 ---------------- */
  function newGame(options) {
    const opts = options || {};
    hideResult();
    stopAi();
    decision = null;
    barSig = '';
    renderSig = '';
    settledState = null;
    state = null;
    const dice = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
    const play = () => {
      const setup = C.createGame(settings, Math.random, Object.assign({ variant: variantId }, C.diceSetup(dice)));
      state = setup;
      state.__consumed = 0;
      state.lastDiscard = null;
      state.dice = dice.slice();
      roundNo = Math.max(roundNo, 1);
      saveRoundNo();
      logLine('action', `开局 第${roundNo}局 dice=${dice.join('+')} dealer=${NAMES[state.dealer]} wallBreak=${state.wallBreak.side}${state.wallBreak.stack} 手牌=${state.hands.map((h) => h.length).join('/')} | ${stateDigest()}`);
      $('last-action').textContent = '洗牌完成';
      render(true);
      pump('new-game');
    };
    if (opts.instant || autoPlay) {
      $('dice-overlay').classList.add('hidden');
      play();
      return Promise.resolve();
    }
    return rollDice(dice).then(play);
  }

  /* ---------------- 规则设置 ---------------- */
  function openRules() {
    $('setting-chi').checked = !!settings.chi;
    $('setting-peng').checked = !!settings.peng;
    $('setting-gang').checked = !!settings.gang;
    $('setting-badHu').checked = !!settings.badHu;
    $('rules-modal').classList.remove('hidden');
  }
  function closeRules() { $('rules-modal').classList.add('hidden'); }
  function saveSettings() {
    settings = {
      chi: $('setting-chi').checked,
      peng: $('setting-peng').checked,
      gang: $('setting-gang').checked,
      badHu: $('setting-badHu').checked
    };
    try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); } catch (_) { /* ignore */ }
    closeRules();
    toast('规则已保存，新开一局后生效');
    logLine('action', `设置更新 chi=${settings.chi} peng=${settings.peng} gang=${settings.gang} badHu=${settings.badHu}`);
  }
  let toastTimer = null;
  function toast(msg) {
    const e = $('toast');
    if (!e) return;
    e.textContent = msg;
    e.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => e.classList.remove('show'), 2100);
  }
  function resetBankroll() {
    if (!account) return;
    balances = tableStacks(account.coins, A.hallOf(hallId));
    saveBankroll();
    loadSeatBalances();
    toast('桌上银币已按当前余额重置');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('sound-toggle').addEventListener('click', toggleSound);
    document.addEventListener('pointerdown', () => {
      audioReady = true;
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }, { once: true });
    $('rules-open').addEventListener('click', () => { audioReady = true; playSound('ui'); openRules(); });
    $('rules-open-2').addEventListener('click', () => { audioReady = true; playSound('ui'); openRules(); });
    $('rules-close').addEventListener('click', closeRules);
    $('rules-cancel').addEventListener('click', closeRules);
    $('rules-save').addEventListener('click', saveSettings);
    $('rules-modal').addEventListener('click', (e) => { if (e.target === $('rules-modal')) closeRules(); });
    $('new-game').addEventListener('click', () => { audioReady = true; roundNo += 1; saveRoundNo(); newGame(); });
    $('result-new').addEventListener('click', () => { roundNo += 1; saveRoundNo(); newGame(); });
    $('reset-bankroll').addEventListener('click', resetBankroll);
    const logToggle = $('log-toggle');
    if (logToggle) {
      logToggle.addEventListener('click', () => {
        const panel = $('log-panel');
        panel.classList.toggle('hidden');
        logToggle.setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
      });
    }
    const logClear = $('log-clear');
    if (logClear) logClear.addEventListener('click', () => { LOGS.length = 0; const l = $('log-list'); if (l) l.innerHTML = ''; });

  }

  /* ---------------- 调试 / 测试接口 ---------------- */
  function snapshot() {
    if (!state) return null;
    const a = C.awaiting(state);
    return {
      phase: state.phase, current: state.current, dealer: state.dealer, wall: state.wall.length,
      hands: state.hands.map((h) => h.length), discards: state.discards.map((d) => d.length),
      melds: state.melds.map((m) => m.length),
      meldDetails: state.melds.map((ms) => ms.map((m) => ({
        type: m.type, tiles: m.tiles.slice(), calledTile: m.calledTile,
        calledTileIndex: m.calledTileIndex, calledFrom: m.calledFrom, concealed: !!m.concealed, added: !!m.added
      }))),
      scores: state.scores.slice(), balances: balances.slice(),
      pending: state.pendingClaims.map((c) => ({ seat: c.seat, preferred: c.preferred, actions: c.actions.map((x) => x.type) })),
      claimCursor: state.claimCursor, lastDiscard: state.lastDiscard, lastDraw: state.lastDraw,
      awaiting: a ? { seat: a.seat, kind: a.kind } : null,
      aiTask: aiTask ? { seat: aiTask.seat, kind: aiTask.kind, epoch: aiTask.epoch } : null,
      epoch, result: state.result, settings, roundNo, lastDice,
      variant: state.variant, variantName: state.variantName,
      profile: account ? { id: account.id, name: account.nick, coins: account.coins, gold: account.gold, rankPoints: account.rankPoints, rank: rankInfo().name, stats: Object.assign({}, account.stats) } : null,
      account: account ? { id: account.id, nick: account.nick, coins: account.coins, gold: account.gold, rankPoints: account.rankPoints, rank: rankInfo().name, season: A.SEASON.id, hall: hallId } : null,
      screen: screenId,
      settlement: settlement ? { deltas: settlement.deltas.slice(), multiplier: settlement.multiplier, unit: settlement.unit, busted: settlement.busted.slice(), reasons: settlement.reasons.slice() } : null,
      rankDelta: rankDelta ? rankDelta.slice() : null,
      logs: LOGS.slice(-40)
    };
  }
  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (predicate()) return resolve(true);
        if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout: ' + stateDigest()));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
  async function autoPlayGames(count, opts) {
    const options = opts || {};
    const prevScale = speedScale;
    speedScale = options.speed === undefined ? 0 : options.speed;
    autoPlay = true;
    const games = [];
    try {
      for (let g = 0; g < count; g++) {
        roundNo += 1;
        saveRoundNo();
        await newGame({ instant: true });
        const started = Date.now();
        await waitFor(() => state && state.phase === C.PHASES.OVER, options.timeout || 60000);
        games.push({
          round: roundNo, ms: Date.now() - started,
          result: state.result && state.result.type,
          winner: state.winner ? state.winner.seat : null,
          scores: state.scores.slice(), wall: state.wall.length, turns: state.turnCount
        });
      }
    } catch (err) {
      games.push({ error: err.message, snapshot: snapshot() });
    } finally {
      autoPlay = false;
      speedScale = prevScale;
    }
    return games;
  }
  function installDebugApi() {
    const debug = (location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.search.includes('debug'));
    if (!debug) return;
    window.__shipingMahjongDebug = snapshot;
    window.__shipingMahjongLogs = () => LOGS.slice();
    window.__shipingMahjongAutoPlay = autoPlayGames;
    window.__shipingMahjongSetSpeed = (v) => { speedScale = Number(v); return speedScale; };
    /* 外壳调试接口：账号 / 赛季 / 场次。全部绕过 DOM 输入框，供自动化测试驱动 */
    window.__shipingMahjongShell = () => ({
      screen: screenId,
      account: account ? {
        id: account.id, nick: account.nick, coins: account.coins, gold: account.gold,
        rankPoints: account.rankPoints, rank: rankInfo().name, rankText: rankInfo().text,
        activated: !!account.activated, stats: Object.assign({}, account.stats)
      } : null,
      hall: A.hallOf(hallId).id,
      hallName: A.hallOf(hallId).name,
      baseBet: A.hallOf(hallId).baseBet,
      variantId,
      variants: C.availableVariants(),
      season: A.SEASON.id,
      settlement: settlement ? { type: settlement.type, unit: settlement.unit, multiplier: settlement.multiplier, deltas: settlement.deltas.slice(), busted: settlement.busted.slice() } : null,
      rankDelta: rankDelta ? rankDelta.slice() : null,
      layers: ['login-modal', 'signin-modal', 'back-modal', 'reward-modal', 'rules-modal', 'result-modal']
        .filter((id) => { const el = $(id); return el && !el.classList.contains('hidden'); })
    });
    function debugAuth(kind, accName, password, nick, skipReward) {
      const acc = String(accName || '').trim();
      const pw = String(password || '');
      const res = kind === 'register'
        ? A.register(store(), { account: acc, password: pw, nick: nick || acc })
        : A.login(store(), { account: acc, password: pw });
      if (!res.ok) return res;
      A.setSession(store(), res.account.id);
      try { localStorage.setItem('honghe-last-account', acc); } catch (_) { /* ignore */ }
      account = res.account;
      hideAllLayers();
      if (skipReward) { refreshAccount(); maybeSeasonFlow(); }
      else afterLogin(kind === 'register');
      return { ok: true, id: account.id, nick: account.nick, coins: account.coins, screen: screenId, isNew: kind === 'register' };
    }
    window.__shipingMahjongRegister = (accName, password, nick, skipReward) => debugAuth('register', accName, password, nick, skipReward);
    window.__shipingMahjongLogin = (accName, password, skipReward) => debugAuth('login', accName, password, '', skipReward);
    window.__shipingMahjongLogout = () => {
      A.setSession(store(), '');
      account = null;
      hideAllLayers();
      hideResult();
      showScreen('splash');
      return true;
    };
    window.__shipingMahjongEnterHome = () => { if (!account) return false; enterHome(); return screenId; };
    window.__shipingMahjongSkipSeason = () => {
      if (!account) return false;
      try { localStorage.setItem(seasonSeenKey(), '1'); } catch (_) { /* ignore */ }
      enterHome();
      return screenId;
    };
    window.__shipingMahjongOpenHall = () => { if (!account) return false; openHall(); return screenId; };
    window.__shipingMahjongStartTable = (id) => {
      if (!account) return false;
      startTable(id || hallId);
      return { screen: screenId, hall: hallId, baseBet: A.hallOf(hallId).baseBet, phase: state ? state.phase : null };
    };
    window.__shipingMahjongOpenSignin = () => { if (!account) return false; openSignin(); return true; };
    window.__shipingMahjongOpenBack = () => { if (!account) return false; openBack(); return true; };
    window.__shipingMahjongResetProgress = () => {
      try {
        ['honghe-accounts-v1', 'honghe-session-v1', 'honghe-last-account'].forEach((k) => localStorage.removeItem(k));
        Object.keys(localStorage).filter((k) => k.indexOf('honghe-season-seen-') === 0).forEach((k) => localStorage.removeItem(k));
      } catch (_) { /* ignore */ }
      account = null;
      hideAllLayers();
      showScreen('splash');
      return true;
    };
    /** 模拟「AI 定时任务丢失」：清掉任务但不推进状态，用于验证心跳自愈 */
    window.__shipingMahjongDropAiTask = () => {
      if (!state || state.phase === C.PHASES.OVER) return false;
      const a = C.awaiting(state);
      if (!a || a.seat === 0) return false;
      if (aiTask) { clearTimeout(aiTask.id); aiTask = null; }
      logLine('recover', '调试：人为丢弃 AI 任务');
      return true;
    };
    /** 构造一次「吃牌」现场，返回期望的顺子信息，用于视觉回归 */
    window.__shipingMahjongForceChi = () => {
      if (!state) return null;
      stopAi();
      const from = 0, seat = C.nextSeat(0);
      state.hands[seat] = [0, 1, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16];
      state.melds[seat] = [];
      // 其他两家移除同名牌，保证「吃」是唯一的接牌方式，便于稳定复现
      [1, 3].forEach((other) => {
        const keep = state.hands[other].filter((x) => x !== 2);
        const pool = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
        let i = 0;
        while (keep.length < 13) keep.push(pool[(i++) % pool.length]);
        state.hands[other] = keep.sort((a, b) => a - b);
        state.melds[other] = [];
      });
      state.discards[from].push(2);
      state.lastDiscard = { tile: 2, from };
      state.phase = C.PHASES.CLAIM;
      state.current = from;
      state.pendingClaims = C.collectClaimCandidates(state);
      state.claimCursor = 0;
      state.__consumed = state.events.length;
      epoch += 1;
      pump('force-chi');
      const cand = state.pendingClaims[0];
      return { seat, tile: 2, claimSeat: cand ? cand.seat : null, actions: cand ? cand.actions.map((x) => x.type) : [] };
    };
    /** 构造四家副露现场（吃/碰/杠），用于副露视觉回归 */
    window.__shipingMahjongForceMelds = () => {
      if (!state) return null;
      stopAi();
      state.melds[0] = [
        { type: 'peng', tiles: [5, 5, 5], from: 1, calledFrom: 1, calledTile: 5, calledTileIndex: 1 },
        { type: 'chi', tiles: [20, 21, 22], from: 2, calledFrom: 2, calledTile: 21, calledTileIndex: 1 }
      ];
      state.melds[1] = [{ type: 'gang', tiles: [30, 30, 30, 30], from: 0, calledFrom: 0, calledTile: 30, calledTileIndex: 0 }];
      state.melds[3] = [
        { type: 'chi', tiles: [0, 1, 2], from: 0, calledFrom: 0, calledTile: 1, calledTileIndex: 1 },
        { type: 'peng', tiles: [27, 27, 27], from: 1, calledFrom: 1, calledTile: 27, calledTileIndex: 1 }
      ];
      state.melds[2] = [
        { type: 'chi', tiles: [9, 10, 11], from: 0, calledFrom: 0, calledTile: 10, calledTileIndex: 1 },
        { type: 'gang', tiles: [18, 18, 18, 18], from: 1, calledFrom: 1, calledTile: 18, calledTileIndex: 0, concealed: true }
      ];
      render(true);
      return state.melds.map((ms) => ms.length);
    };
    /** 构造一次胡牌结算展示，用于视觉回归 */
    window.__shipingMahjongForceWin = () => {
      if (!state) return null;
      stopAi();
      state.melds[0] = [
        { type: 'chi', tiles: [4, 5, 6], from: 1, calledFrom: 1, calledTile: 5, calledTileIndex: 1 },
        { type: 'peng', tiles: [18, 18, 18], from: 2, calledFrom: 2, calledTile: 18, calledTileIndex: 1 }
      ];
      const hand = [0, 1, 2, 9, 10, 11, 27, 27];
      state.hands[0] = hand.slice();
      state.phase = C.PHASES.OVER;
      state.winner = { seat: 0, type: 'self', from: null };
      state.scores = [9, -3, -3, -3];
      state.result = {
        type: 'self', seat: 0, title: '自摸胡', detail: '自摸胡牌，四家结算',
        winType: '自摸', winningTile: 27, winningHand: hand.concat([27]).sort((a, b) => a - b),
        winningType: '标准胡牌', melds: state.melds[0], roundScores: state.scores.slice()
      };
      settledState = null;
      render(true);
      settleRound();
      showResult();
      return state.result;
    };
    window.__shipingMahjongDiceFaces = () => {
      const read = (id) => {
        const host = $(id);
        if (!host) return null;
        const val = Number(host.dataset.value) || 0;
        const face = host.querySelector('.die-face[data-face="' + val + '"]');
        return { id, value: val, hasFace: !!face };
      };
      return { one: read('dice-one'), two: read('dice-two'), last: lastDice };
    };
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    syncSoundButton();
    bind();
    bindShell();
    loadAccount();
    loadSeatBalances();
    installDebugApi();
    heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
    if (account) {
      maybeSeasonFlow();
    } else {
      showScreen('splash');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__shipingMahjong = {
    get state() { return state; },
    get logs() { return LOGS; },
    get decisions() { return { epoch, retryCount }; },
    snapshot
  };
})();
