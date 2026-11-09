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
  const KEY_PROFILES = 'shiping-mahjong-profiles-v1';
  const KEY_ACTIVE_PROFILE = 'shiping-mahjong-active-profile-v1';
  const KEY_VARIANT = 'shiping-mahjong-variant-v1';

  const SPEED = { claim: 700, discard: 780, kong: 620 };
  const HEARTBEAT_MS = 900;
  const STALL_MS = 2600;
  const MAX_RETRY = 8;

  /* ---------------- 运行时状态 ---------------- */
  let state = null;
  let settings = loadSettings();
  let balances = loadBankroll();
  let roundNo = loadRoundNo();
  let profiles = loadProfiles();
  let activeProfileId = (() => { try { return localStorage.getItem(KEY_ACTIVE_PROFILE) || ''; } catch (_) { return ''; } })();
  let variantId = loadVariantId();
  let lobbyOpen = false;
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

  /* ---------------- 本地玩家档案 ----------------
   * 存储层刻意收口在这几个函数里：以后接云端账号 / 联机大厅时，
   * 只需把 loadProfiles / saveProfiles 换成远程实现，界面层不用改。
   */
  function blankProfile(name) {
    return {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || '你',
      createdAt: Date.now(),
      lastPlayed: 0,
      stats: { games: 0, wins: 0, selfDraw: 0, discardWin: 0, draw: 0, kong: 0 },
      points: blankPoints()   // 按玩法累计：{ shiping: 0, gejiu: 0, baoxiu: 0 }
    };
  }
  /** 每种玩法都先落一个 0，避免新档案出现 undefined 键 */
  function blankPoints() {
    const out = {};
    for (const v of C.VARIANTS) out[v.id] = 0;
    return out;
  }
  function normalizeProfile(p) {
    const base = blankProfile(p && p.name);
    if (!p || typeof p !== 'object') return base;
    const stats = Object.assign({}, base.stats, p.stats || {});
    const points = {};
    for (const v of C.VARIANTS) points[v.id] = Number((p.points || {})[v.id]) || 0;
    return {
      id: typeof p.id === 'string' && p.id ? p.id : base.id,
      name: String(p.name || base.name).slice(0, 12),
      createdAt: Number(p.createdAt) || base.createdAt,
      lastPlayed: Number(p.lastPlayed) || 0,
      stats, points
    };
  }
  function loadProfiles() {
    let list = [];
    try {
      const raw = JSON.parse(localStorage.getItem(KEY_PROFILES) || '[]');
      if (Array.isArray(raw)) list = raw.map(normalizeProfile);
    } catch (_) { list = []; }
    if (!list.length) list = [blankProfile('你')];
    return list;
  }
  function saveProfiles() {
    try { localStorage.setItem(KEY_PROFILES, JSON.stringify(profiles)); } catch (_) { /* ignore */ }
  }
  function activeProfile() {
    let p = profiles.find((x) => x.id === activeProfileId);
    if (!p) { p = profiles[0]; activeProfileId = p.id; saveActiveProfile(); }
    return p;
  }
  function saveActiveProfile() { try { localStorage.setItem(KEY_ACTIVE_PROFILE, activeProfileId); } catch (_) { /* ignore */ } }
  function profilePoints(p, vid) { return Number((p.points || {})[vid || variantId]) || 0; }
  function loadVariantId() {
    try {
      const id = localStorage.getItem(KEY_VARIANT);
      const v = C.getVariant(id);
      return v && v.available ? v.id : C.DEFAULT_VARIANT;
    } catch (_) { return C.DEFAULT_VARIANT; }
  }
  function saveVariantId() { try { localStorage.setItem(KEY_VARIANT, variantId); } catch (_) { /* ignore */ } }

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
    for (let i = 0; i < 4; i++) {
      const e = $('score-' + i);
      if (e) e.textContent = '余额 ' + projectedBalance(i) + ' 分';
      const side = $('side-score-' + i);
      if (side) side.textContent = String(projectedBalance(i));
    }
    applyProfileToHeader();
  }
  /** 顶栏：当前玩家、玩法、累计积分与余额 */
  function applyProfileToHeader() {
    const p = activeProfile();
    const v = C.getVariant(state && state.variant ? state.variant : variantId);
    const title = $('brand-title');
    if (title) title.textContent = p.name + ' 的牌桌';
    const sub = $('brand-sub');
    if (sub) sub.textContent = v.name + ' · 本地档案';
    const mark = $('brand-mark');
    if (mark) mark.textContent = (p.name || '你').slice(0, 1);
    const top = $('bankroll-display');
    if (top) {
      top.innerHTML = '';
      const pts = document.createElement('span');
      pts.className = 'top-points';
      pts.innerHTML = '积分 <b>' + profilePoints(p, v.id) + '</b>';
      const dot = document.createElement('i');
      dot.className = 'top-dot';
      const bal = document.createElement('span');
      bal.className = 'top-balance';
      bal.textContent = '余额 ' + projectedBalance(0);
      top.appendChild(pts);
      top.appendChild(dot);
      top.appendChild(bal);
    }
    const score0 = $('score-0');
    const seatName = $('seat-name-0');
    if (seatName) seatName.textContent = p.name + ' · 南家';
    const avatar0 = $('avatar-0');
    if (avatar0) avatar0.textContent = (p.name || '你').slice(0, 1);
    if (score0) score0.textContent = '余额 ' + projectedBalance(0) + ' 分';
  }
  function projectedBalance(seat) {
    return balances[seat] + (state && state.phase !== C.PHASES.OVER ? state.scores[seat] : 0);
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
    for (let i = 0; i < 4; i++) balances[i] += state.scores[i];
    settledState = state;
    saveBankroll();
    recordProfileResult();
    loadSeatBalances();
    logLine('action', `本局结算 scores=${state.scores.join('/')} balances=${balances.join('/')} 玩家积分=${profilePoints(activeProfile())}`);
  }
  /** 把本局结果写进当前玩家档案：累计积分 + 战绩。异常中止的局不计入。 */
  function recordProfileResult() {
    const r = state.result || {};
    if (r.type === 'abort') return;
    const p = activeProfile();
    const vid = state.variant || variantId;
    p.points[vid] = (Number(p.points[vid]) || 0) + (state.scores[0] || 0);
    p.stats.games += 1;
    p.stats.kong += (state.kongLog ? state.kongLog.length : 0);
    if (r.type === 'draw') p.stats.draw += 1;
    else if (Number.isInteger(r.seat)) {
      if (r.seat === 0) {
        p.stats.wins += 1;
        if (r.type === 'self') p.stats.selfDraw += 1;
        if (r.type === 'discard') p.stats.discardWin += 1;
      }
    }
    p.lastPlayed = Date.now();
    saveProfiles();
    applyProfileToHeader();
  }
  function fmt(n) { return (n > 0 ? '+' : '') + n; }

  function showResult() {
    if (!state || !state.result) return;
    const r = state.result;
    $('result-icon').textContent = r.type === 'draw' ? '荒' : r.type === 'abort' ? '停' : '胡';
    $('result-title').textContent = r.title;
    const winner = Number.isInteger(r.seat) ? r.seat : -1;
    $('result-detail').textContent = r.detail;
    const box = $('result-winning');
    box.innerHTML = '';
    const layer = $('result-modal');
    layer.classList.toggle('is-draw', r.type !== 'over' && !Number.isInteger(r.seat));

    if (winner >= 0) {
      const head = document.createElement('div');
      head.className = 'result-win-head';
      const badge = document.createElement('span');
      badge.className = 'result-win-badge';
      badge.textContent = r.winType || '胡牌';
      const strong = document.createElement('b');
      strong.textContent = NAMES[winner] + ' · ' + (r.winType || '胡牌') + ' · ' + (r.winningType || '');
      const t = document.createElement('span');
      t.className = 'result-win-tile';
      t.textContent = '胡 ' + (r.winningTile === null || r.winningTile === undefined ? '—' : C.tileLabel(r.winningTile));
      head.append(badge, strong, t);
      box.appendChild(head);

      const melds = r.melds || state.melds[winner] || [];
      if (melds.length) {
        const wrap = document.createElement('div');
        wrap.className = 'result-block';
        const lab = document.createElement('div');
        lab.className = 'result-label';
        lab.textContent = '副露（' + melds.length + ' 组）';
        const list = document.createElement('div');
        list.className = 'result-meld-list';
        melds.forEach((m) => {
          const g = document.createElement('div');
          g.className = 'result-meld-group meld-' + m.type;
          const kind = document.createElement('span');
          kind.className = 'meld-label';
          kind.textContent = meldLabelText(m);
          g.appendChild(kind);
          m.tiles.forEach((id, i) => {
            const called = Number.isInteger(m.calledTileIndex) && i === m.calledTileIndex && !m.concealed;
            g.appendChild(tileEl(id, called ? 'meld-called-tile' : ''));
          });
          list.appendChild(g);
        });
        wrap.append(lab, list);
        box.appendChild(wrap);
      }

      const handWrap = document.createElement('div');
      handWrap.className = 'result-block';
      const handLab = document.createElement('div');
      handLab.className = 'result-label';
      handLab.textContent = '胡牌手牌（' + (r.winningHand || []).length + ' 张）';
      const hand = document.createElement('div');
      hand.className = 'result-hand';
      const winTile = r.winningTile;
      (r.winningHand || []).forEach((id, i) => {
        const isWin = i === r.winningHand.length - 1 && id === winTile;
        const el = tileEl(id, isWin ? 'winning-tile' : '');
        hand.appendChild(el);
      });
      handWrap.append(handLab, hand);
      box.appendChild(handWrap);
    } else {
      const head = document.createElement('div');
      head.className = 'result-win-head';
      const strong = document.createElement('b');
      strong.textContent = r.type === 'abort' ? '本局已中止' : '本局荒牌';
      head.appendChild(strong);
      box.appendChild(head);
    }

    const rows = $('result-scores');
    rows.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'result-score' + (i === winner ? ' is-winner' : '');
      const name = document.createElement('span');
      name.className = 'result-score-name';
      name.textContent = NAMES[i] + ' · ' + SEATS[i];
      const delta = document.createElement('b');
      delta.className = 'result-score-delta ' + (state.scores[i] > 0 ? 'plus' : state.scores[i] < 0 ? 'minus' : 'zero');
      delta.textContent = fmt(state.scores[i]) + ' 分';
      const bal = document.createElement('span');
      bal.className = 'result-score-balance';
      bal.textContent = '余额 ' + balances[i];
      row.append(name, delta, bal);
      rows.appendChild(row);
    }
    layer.classList.remove('hidden');
    document.querySelector('.table-frame').classList.add('round-over');
  }
  function hideResult() {
    $('result-modal').classList.add('hidden');
    document.querySelector('.table-frame').classList.remove('round-over');
  }

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
  function profileLine(p) {
    const s = p.stats || {};
    const pts = profilePoints(p);
    if (!s.games) return `新玩家 · ${C.getVariant(variantId).name} 积分 ${pts}`;
    const rate = s.games ? Math.round((s.wins / s.games) * 100) : 0;
    return `${s.games} 局 · 胡 ${s.wins}（${rate}%） · ${C.getVariant(variantId).name} 积分 ${pts}`;
  }
  function renderLobby() {
    const list = $('profile-list');
    if (!list) return;
    list.innerHTML = '';
    profiles.forEach((p) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'profile-card' + (p.id === activeProfileId ? ' is-active' : '');
      card.dataset.profile = p.id;
      const av = document.createElement('span');
      av.className = 'profile-avatar';
      av.textContent = (p.name || '你').slice(0, 1);
      const box = document.createElement('span');
      box.className = 'profile-text';
      const nm = document.createElement('b');
      nm.textContent = p.name;
      const meta = document.createElement('small');
      meta.textContent = profileLine(p);
      box.appendChild(nm);
      box.appendChild(meta);
      card.appendChild(av);
      card.appendChild(box);
      if (profiles.length > 1) {
        const del = document.createElement('span');
        del.className = 'profile-del';
        del.dataset.del = p.id;
        del.title = '删除该档案';
        del.textContent = '×';
        card.appendChild(del);
      }
      list.appendChild(card);
    });

    const vlist = $('variant-list');
    if (vlist) {
      vlist.innerHTML = '';
      C.VARIANTS.forEach((v) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'variant-card' + (v.id === variantId ? ' is-active' : '') + (v.available ? '' : ' is-locked');
        card.dataset.variant = v.id;
        card.disabled = !v.available;
        const nm = document.createElement('b');
        nm.textContent = v.name;
        const rg = document.createElement('span');
        rg.className = 'variant-region';
        rg.textContent = v.region + (v.available ? '' : ' · 即将开放');
        const sm = document.createElement('small');
        sm.textContent = v.summary;
        card.appendChild(nm);
        card.appendChild(rg);
        card.appendChild(sm);
        vlist.appendChild(card);
      });
    }

    const sum = $('lobby-summary');
    if (sum) {
      const p = activeProfile();
      const s = p.stats || {};
      sum.innerHTML = '';
      const a = document.createElement('b');
      a.textContent = p.name;
      const b = document.createElement('span');
      b.textContent = `${C.getVariant(variantId).name} · 累计 ${s.games || 0} 局 / 胡 ${s.wins || 0} 次 / 积分 ${profilePoints(p)}`;
      sum.appendChild(a);
      sum.appendChild(b);
    }
  }
  function openLobby() {
    lobbyOpen = true;
    renderLobby();
    $('lobby').classList.remove('hidden');
  }
  function closeLobby() {
    lobbyOpen = false;
    $('lobby').classList.add('hidden');
  }
  function selectProfile(id) {
    if (!profiles.some((p) => p.id === id)) return;
    activeProfileId = id;
    saveActiveProfile();
    renderLobby();
    applyProfileToHeader();
    logLine('action', `切换玩家档案 → ${activeProfile().name}`);
    playSound('ui');
  }
  function addProfile() {
    const input = $('profile-input');
    const name = (input.value || '').trim().slice(0, 12);
    if (!name) { toast('请先输入名字'); input.focus(); return; }
    if (profiles.some((p) => p.name === name)) { toast('已有同名档案'); return; }
    const p = blankProfile(name);
    profiles.push(p);
    activeProfileId = p.id;
    saveProfiles();
    saveActiveProfile();
    input.value = '';
    renderLobby();
    applyProfileToHeader();
    toast('已添加玩家 ' + name);
    playSound('ui');
  }
  function removeProfile(id) {
    if (profiles.length <= 1) { toast('至少保留一个档案'); return; }
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    profiles = profiles.filter((x) => x.id !== id);
    if (activeProfileId === id) { activeProfileId = profiles[0].id; saveActiveProfile(); }
    saveProfiles();
    renderLobby();
    applyProfileToHeader();
    toast('已删除 ' + p.name);
  }
  function selectVariant(id) {
    const v = C.getVariant(id);
    if (!v || !v.available) { toast(v ? v.name + ' 规则整理中，暂未开放' : '未知玩法'); return; }
    if (variantId === id) return;
    variantId = id;
    saveVariantId();
    settings = Object.assign({}, v.defaults, settings);
    renderLobby();
    applyProfileToHeader();
    toast('已切换到 ' + v.name + '，进入牌桌后生效');
    playSound('ui');
  }
  function enterTable() {
    closeLobby();
    roundNo += 1;
    saveRoundNo();
    newGame();
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
    balances = [100, 100, 100, 100];
    saveBankroll();
    loadSeatBalances();
    showResult();
    toast('四家积分已重置为 100');
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

    /* 大厅 */
    const brand = $('brand');
    if (brand) {
      brand.addEventListener('click', () => { audioReady = true; playSound('ui'); openLobby(); });
      brand.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLobby(); } });
    }
    const lobbyClose = $('lobby-close');
    if (lobbyClose) lobbyClose.addEventListener('click', closeLobby);
    const lobbyEnter = $('lobby-enter');
    if (lobbyEnter) lobbyEnter.addEventListener('click', enterTable);
    const lobbyEl = $('lobby');
    if (lobbyEl) {
      lobbyEl.addEventListener('click', (e) => {
        if (e.target === lobbyEl) closeLobby();
        const del = e.target.closest && e.target.closest('[data-del]');
        if (del) { e.stopPropagation(); removeProfile(del.dataset.del); return; }
        const card = e.target.closest && e.target.closest('[data-profile]');
        if (card) { selectProfile(card.dataset.profile); return; }
        const vcard = e.target.closest && e.target.closest('[data-variant]');
        if (vcard) selectVariant(vcard.dataset.variant);
      });
    }
    const profileAdd = $('profile-add');
    if (profileAdd) profileAdd.addEventListener('click', addProfile);
    const profileInput = $('profile-input');
    if (profileInput) {
      profileInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addProfile(); }
      });
    }
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
      profile: { id: activeProfile().id, name: activeProfile().name, points: profilePoints(activeProfile()), stats: Object.assign({}, activeProfile().stats) },
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
    /* 大厅与档案调试接口 */
    window.__shipingMahjongLobby = () => ({
      open: lobbyOpen,
      variantId,
      activeProfileId,
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, points: Object.assign({}, p.points), stats: Object.assign({}, p.stats) })),
      variants: C.availableVariants()
    });
    window.__shipingMahjongOpenLobby = () => { openLobby(); return true; };
    window.__shipingMahjongAddProfile = (name) => { const i = $('profile-input'); if (i) i.value = name; addProfile(); return activeProfile().name; };
    window.__shipingMahjongSelectVariant = (id) => { selectVariant(id); return variantId; };
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
    if (!profiles.some((p) => p.id === activeProfileId)) {
      activeProfileId = profiles[0].id;
      saveActiveProfile();
    }
    loadSeatBalances();
    installDebugApi();
    heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
    newGame();
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
