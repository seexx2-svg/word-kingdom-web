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
  const DEFAULT_NAMES = NAMES.slice();
  const SEATS = ['南家', '北家', '西家', '东家'];
  const KEY_SETTINGS = 'shiping-mahjong-settings-v1';
  const KEY_SOUND = 'shiping-mahjong-sound-v1';
  const KEY_SKIN = 'shiping-mahjong-skin-v1';
  const KEY_BANK = 'shiping-mahjong-bankroll-v1';
  const KEY_ROUND = 'shiping-mahjong-round-v1';
  const KEY_VARIANT = 'shiping-mahjong-variant-v1';
  const KEY_HALL = 'honghe-hall-v1';
  const KEY_3D = 'shiping-mahjong-3d-v1';
  const A = window.HongheAccount;
  const Auth = window.HongheAuth;

  /* 品牌名只在这里改：index.html 里的 [data-brand] 占位由 applyBrand() 统一填充。
     石屏 / 宝秀 / 个旧都在红河州，所以平台叫「红河麻将」，桌上那一局仍叫「石屏麻将」。 */
  const BRAND = { title: '红河麻将 · 四人牌桌', html: '红河<span>·</span>麻将' };

  /* 电脑的节奏。之前 700~780ms 一手，四家连着走像快进，看不清谁打了什么；
   * 现在放慢到 1.3~1.8 秒，并带 ±12% 的抖动，避免整齐得像机器。
   * 上限必须低于 STALL_MS（2600），否则心跳会把「正在思考」误判成任务丢了。 */
  const SPEED = { claim: 1200, discard: 1600, kong: 950 };
  const SPEED_JITTER = 0.12;
  const TURN_SECONDS = 15;          // 读秒：到 0 自动打出刚摸的那张
  const HEARTBEAT_MS = 900;
  const STALL_MS = 2600;
  const MAX_RETRY = 8;

  /** 确定性随机数：同一个种子在任何设备上都洗出同一副牌（联机的地基） */
  function mulberry32(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

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
  let turnClock = null, turnLeft = 15, turnSeconds = TURN_SECONDS;
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
  let readyTimer = null;           // 局前「准备 / 换桌」层的自动收起定时器

  /* ---------------- 存储 ---------------- */
  function loadSettings() {
    try {
      return Object.assign({ chi: true, peng: true, gang: true, badHu: true },
        JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}'));
    } catch (_) { return { chi: true, peng: true, gang: true, badHu: true }; }
  }
  function loadSoundSetting() { try { return localStorage.getItem(KEY_SOUND) !== 'off'; } catch (_) { return true; } }
  /* 立直牌面皮肤：默认开（用户点名要 90 年代立直麻将机的感觉），
     关掉立刻回滚到 assets/tiles/ 的原版牌面，不用刷新。 */
  function loadSkinSetting() { try { return localStorage.getItem(KEY_SKIN) !== 'off'; } catch (_) { return true; } }
  function applySkin(on) {
    const body = document.body;
    body.classList.toggle('skin-riichi', !!on);
    const box = $('setting-riichi');
    if (box) box.checked = !!on;
  }
  /* 假 3D 梯形桌：默认开，规则设置里关掉立刻回滚到平面机台，不用刷新。
     只在 body 上挂一个 class，所有几何都走第 20 节的伪元素，不改任何布局盒。 */
  function load3dSetting() { try { return localStorage.getItem(KEY_3D) !== 'off'; } catch (_) { return true; } }
  function apply3d(on) {
    document.body.classList.toggle('table-3d', !!on);
    const box = $('setting-3d');
    if (box) box.checked = !!on;
  }
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
   * 账号、赛季与银币规则在 js/account.js；云端读写与字段映射在 js/cloud.js。
   * 这里只负责：拿当前账号 → 把改动写回它该去的地方 → 画到界面上。
   * 云端账号的进度绝不落 localStorage，游客账号也绝不冒充云端数据。
   */
  const Cloud = window.HongheCloud || null;
  const Net = window.HongheNet || null;       // 大厅匹配（云库轮询）
  const Online = window.HongheOnline || null; // 联机会话：座位旋转 + 动作重放
  const Sfx = window.HongheAudio || null;     // 音效 + 中文牌名播报
  /** 云端账号不能写本机：否则会污染游客存档，也会让人误以为云端没生效 */
  const INERT_STORE = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
    key: () => null, length: 0
  };
  function store() { return (account && account.source === 'cloud') ? INERT_STORE : A.makeStore(); }
  /** 账号对象就是唯一真相，重画时不需要再回去读存储 */
  function refreshAccount() { return account; }

  let syncState = 'idle';       // idle | ok | error | guest
  let syncAt = 0;
  let savePending = false;
  let saveRetry = 0;
  let retryTimer = null;

  /** 把当前账号写回它该去的地方：游客写本机，云端写数据库 */
  async function persist(opts) {
    const o = opts || {};
    if (!account) return { ok: true };
    if (account.source !== 'cloud' || !Cloud) {
      account = A.update(A.makeStore(), account);
      syncState = 'guest';
      paintSync();
      return { ok: true };
    }
    const res = await Cloud.saveProfile(account);
    if (res.ok) {
      syncState = 'ok';
      syncAt = Date.now();
      savePending = false;
      saveRetry = 0;
      paintSync();
      return res;
    }
    syncState = 'error';
    savePending = true;
    paintSync();
    if (!o.silent) toast('云端保存失败：' + res.error + '，会自动重试');
    scheduleRetry();
    return res;
  }
  function scheduleRetry() {
    if (retryTimer || !savePending) return;
    if (saveRetry >= 10) { savePending = false; return; }
    saveRetry += 1;
    const wait = Math.min(30000, 4000 * saveRetry);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (savePending) persist({ silent: true });
    }, wait);
  }
  function paintSync() {
    const el = $('am-cloud');
    if (!el) return;
    if (!account) { el.textContent = ''; el.className = 'am-cloud'; return; }
    if (account.source !== 'cloud') {
      el.className = 'am-cloud guest';
      el.textContent = '游客模式 · 进度只存本机';
      return;
    }
    if (syncState === 'error') { el.className = 'am-cloud offline'; el.textContent = '离线 · 进度待同步'; return; }
    el.className = 'am-cloud';
    if (!syncAt) { el.textContent = '云端账号 · 已登录'; return; }
    const d = new Date(syncAt);
    const p = (n) => String(n).padStart(2, '0');
    el.textContent = '云端已同步 · ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function rankInfo(points) {
    return A.rankOf(points === undefined ? (account ? account.rankPoints : 0) : points);
  }
  /* 三个玩法都要能在下拉里选中。宝秀 / 个旧的规则还没定，内核里它们的
     defaults 与石屏一致、scoring 为 null（内核只看 defaults），所以可以先按
     石屏规则试玩，界面上会明确写「规则整理中，暂按石屏规则」。 */
  function loadVariantId() {
    try {
      const id = localStorage.getItem(KEY_VARIANT);
      const v = C.VARIANTS.find((x) => x.id === id);
      return v ? v.id : C.DEFAULT_VARIANT;
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
    const text = soundEnabled ? '声音 开' : '声音 关';
    ['sound-toggle', 'lobby-sound'].forEach((id) => {
      const b = $(id);
      if (!b) return;
      b.textContent = text;
      b.setAttribute('aria-pressed', String(soundEnabled));
    });
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
  /** 音频解锁必须在真实点击里做一次。第一次点「免费领银币」时 AudioContext
   *  刚被 new 出来常常还挂在 suspended，直接排音符会被浏览器吞掉 —— 所以
   *  playSound 里还要等 resume() 落地再发声。 */
  function unlockAudio() {
    audioReady = true;
    if (Sfx) Sfx.unlock();
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return null;
    try {
      if (!audioCtx) audioCtx = new Audio();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (_) { return null; }
  }
  function playSound(kind = 'ui') {
    if (!audioReady) return;
    /* 到账反馈是必须听见的：即使「声音」开关关了，领银币也要响一声 */
    if (!soundEnabled && kind !== 'coin') return;
    const ctx = unlockAudio();
    if (!ctx) return;
    try {
      if (kind === 'thunder') { thunder(); return; }
      const bank = {
        ui: [[880, 0, 0.045, 0.018, 'sine']],
        zhuang: [[420, 0, 0.06, 0.02, 'triangle'], [620, 0.065, 0.07, 0.022, 'triangle'], [820, 0.14, 0.08, 0.024, 'triangle']],
        draw: [[690, 0, 0.055, 0.026, 'triangle'], [980, 0.035, 0.035, 0.012, 'sine']],
        discard: [[245, 0, 0.075, 0.045, 'triangle'], [720, 0.012, 0.025, 0.012, 'sine']],
        chi: [[420, 0, 0.08, 0.028, 'sine'], [560, 0.07, 0.09, 0.03, 'sine']],
        peng: [[520, 0, 0.07, 0.032, 'triangle'], [760, 0.065, 0.1, 0.032, 'triangle']],
        gang: [[360, 0, 0.1, 0.035, 'triangle'], [520, 0.09, 0.11, 0.035, 'triangle'], [760, 0.18, 0.13, 0.035, 'triangle']],
        hu: [[523, 0, 0.12, 0.035, 'sine'], [659, 0.12, 0.12, 0.038, 'sine'], [784, 0.24, 0.15, 0.04, 'sine'], [1046, 0.39, 0.24, 0.045, 'sine']],
        /* 银币到账：两下金属感的"叮—叮"，再补一层高频泛音当作余韵。
           频率取 B5 → E6（164.8 音分的上行五度），听起来就是"钱进来了"而不是普通点击。 */
        coin: [[988, 0, 0.07, 0.085, 'triangle'], [1319, 0.055, 0.13, 0.075, 'sine'], [1976, 0.06, 0.26, 0.032, 'sine']]
      };
      const fire = () => (bank[kind] || bank.ui).forEach((v) => tone(...v));
      if (ctx.state === 'suspended') {
        const r = ctx.resume && ctx.resume();
        if (r && typeof r.then === 'function') r.then(fire).catch(fire);
        else fire();
      } else fire();
    } catch (_) { /* ignore */ }
  }
  /* 雷声。振荡器发不出"噼啪"，得先造一段白噪声再滤波：
     前 30ms 是炸响，后面拖一条低通滚雷，最后垫一个 55Hz 的低频让它有重量。 */
  function noiseBurst(start, duration, volume, cutoff) {
    if (!audioCtx) return;
    const rate = audioCtx.sampleRate;
    const len = Math.max(1, Math.floor(rate * duration));
    const buf = audioCtx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2);
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    const at = audioCtx.currentTime + start;
    lp.frequency.setValueAtTime(cutoff, at);
    lp.frequency.exponentialRampToValueAtTime(180, at + duration);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0002, volume), at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(lp); lp.connect(gain); gain.connect(audioCtx.destination);
    src.start(at); src.stop(at + duration + 0.02);
  }
  function thunder() {
    noiseBurst(0, 0.42, 0.19, 7000);          // 炸响
    noiseBurst(0.16, 0.95, 0.075, 900);       // 滚雷尾巴
    tone(1500, 0, 0.05, 0.028, 'square');     // 高频裂口
    tone(58, 0.03, 0.85, 0.085, 'sine');      // 低频重量
    tone(38, 0.08, 1.1, 0.06, 'triangle');
  }
  function toggleSound() {
    soundEnabled = !soundEnabled;
    try { localStorage.setItem(KEY_SOUND, soundEnabled ? 'on' : 'off'); } catch (_) { /* ignore */ }
    syncSoundButton();
    if (Sfx) Sfx.setEnabled(soundEnabled);
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
  /* ---------------- 牌墙：真实墩数 ----------------
   * 一副 136 张 = 68 墩，四边各码 17 墩。以前四条墙是画死在 CSS 里的渐变条，
   * 摸多少张它都一个样子，只能靠顶栏的数字猜还剩多少。现在每条墙由 17 个
   * .ws 组成，按 state.wall.length 反算还剩几墩，从开牌那一侧起一块块消失。
   */
  const WALL_STACKS = 17;
  const WALL_SIDES = ['south', 'east', 'north', 'west'];
  const SIDE_OF_MARK = { '南': 'south', '北': 'north', '西': 'east', '东': 'west' };
  function wallKeep() {
    const remain = Math.max(0, Math.floor((state.wall.length + 1) / 2));
    // 按四面平摊：真打的时候牌墙是从开牌点一路绕过去的，但那样会出现
    // "一边全空、三边不动"的怪画面。这里把总墩数平摊到四面，四面一起变短，
    // 总数仍然精确等于 state.wall.length。
    const q = Math.floor(remain / 4);
    const r = remain % 4;
    const keep = {};
    WALL_SIDES.forEach((k, i) => { keep[k] = q + (i < r ? 1 : 0); });
    return keep;
  }
  function paintWall() {
    const keep = wallKeep();
    WALL_SIDES.forEach((side) => {
      const box = document.querySelector('.wall-' + side);
      if (!box) return;
      if (box.children.length !== WALL_STACKS) {
        box.innerHTML = '';
        for (let i = 0; i < WALL_STACKS; i++) {
          const st = document.createElement('i');
          st.className = 'ws';
          box.appendChild(st);
        }
      }
      const n = keep[side];
      Array.from(box.children).forEach((el, i) => el.classList.toggle('is-gone', i >= n));
    });
  }

  function render(force) {
    if (!state) return;
    const sig = computeSig();
    if (!force && sig === renderSig) { renderSeatStatus(); return; }
    renderSig = sig;
    $('wall-count').textContent = '牌墙 ' + Math.floor((state.wall.length + 1) / 2) + ' 墩';
    $('wall-count').title = '剩 ' + state.wall.length + ' 张未摸';
    $('hand-count').textContent = state.hands[0].length + ' 张';
    // 石屏麻将没有庄家：骰子只决定从谁那里起手，不翻倍、不连庄
    $('dealer-label').textContent = `${NAMES[state.dealer]} 起手 · ${state.wallBreak.side}墙第${state.wallBreak.stack}墩`;
    $('round-label').textContent = '第 ' + roundNo + ' 局';
    markDealer(state.dealer);
    markWallBreak(state.wallBreak.side);
    paintWall();
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
        /* 碰 / 杠的三四张牌一模一样，标「哪张是接来的」没有意义；
           只有吃牌才需要指出接进来的是哪一张（顺序不同，看得清组合）。 */
        const isCalled = m.type === 'chi' && Number.isInteger(m.calledTileIndex)
          && index === m.calledTileIndex && !m.concealed;
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
  /** 牌河只画「还留在河里的牌」。
   *  被吃 / 碰 / 明杠取走的那张，内核 claimDiscard 已经 splice 掉了；
   *  旧版会把它们补回来挂成带遮罩的固定幽灵牌，看着像钉在那儿不动。
   *  现在不做补回：剩下的牌按原本的打出顺序自然往前排，不留空位。 */
  function renderDiscards(s) {
    const box = $('discards-' + s);
    if (!box) return;
    const pile = state.discards[s];
    const sig = pile.join(',');
    box.classList.toggle('is-dense', pile.length > 18);
    if (box.dataset.sig === sig) {
      // 只在牌没变的情况下更新最新一张的高亮，避免重排造成闪烁
      Array.from(box.children).forEach((el, i) => el.classList.toggle('latest-discard', i === pile.length - 1));
      return;
    }
    box.dataset.sig = sig;
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
    // 联机时 0 号位显示的是「房间里登记的那个昵称」，不是账号昵称
    if (name0 && !(Online && Online.isOnline())) name0.textContent = account.nick;
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
  const AI_RANKS = ['进士', '举人', '秀才'];
  function paintSeatRanks() {
    for (let i = 1; i < 4; i++) {
      const el = $('rank-' + i);
      if (el) el.textContent = AI_RANKS[i - 1];
    }
  }

  /** 标出「起手家」：石屏麻将没有庄家，这个标记只说明谁先摸牌，不参与计分 */
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
        mark.textContent = '起';
        mark.title = '起手家（骰子点数决定，不影响算分）';
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
  /** 读秒到 0：自动打出「刚摸进来的那张」。
   *  drawFor() 把摸的牌 push 到手牌末尾并记 lastDraw；用 lastIndexOf 找它，
   *  免得手牌里有同名牌时挑错下标。恰好赶上动画 busy 就短暂重试，不让这一手卡死。 */
  function autoDiscardDrawn(tries) {
    if (!state || state.phase !== C.PHASES.DISCARD || state.current !== 0) return;
    if (busy) {
      if (tries > 0) setTimeout(() => autoDiscardDrawn(tries - 1), 180);
      return;
    }
    const hand = state.hands[0] || [];
    const drawn = state.lastDraw && state.lastDraw.seat === 0 ? state.lastDraw.tile : null;
    let idx = drawn === null ? -1 : hand.lastIndexOf(drawn);
    if (idx < 0) idx = hand.length - 1;
    if (idx < 0) return;
    toast('读秒结束，自动打出刚摸的 ' + C.tileLabel(hand[idx]));
    humanDiscard(idx);
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
    turnLeft = turnSeconds;
    box.textContent = String(turnSeconds).padStart(2, '0');
    box.classList.remove('urgent');
    turnClock = setInterval(() => {
      if (!state || state.phase !== C.PHASES.DISCARD || state.current !== 0) {
        clearInterval(turnClock); turnClock = null; return;
      }
      turnLeft = Math.max(0, turnLeft - 1);
      box.textContent = String(turnLeft).padStart(2, '0');
      box.classList.toggle('urgent', turnLeft <= 5);
      if (turnLeft === 0) {
        clearInterval(turnClock); turnClock = null;
        autoDiscardDrawn(10);
      }
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
  function addButton(bar, label, cls, handler, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-button action-' + cls;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', () => {
      unlockAudio();
      playSound('ui');
      handler();
    });
    bar.appendChild(b);
  }
  /** 吃牌有多种组合时，右侧按 1/2/3 的顺序列出小牌组，点哪组吃哪组。
   *  小牌用同一个 tileEl()，牌面与桌面保持同一套图。 */
  function addChiOption(bar, opt, index, handler) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-button action-chi chi-option';
    b.dataset.option = String(index);
    b.setAttribute('aria-label', '吃法 ' + (index + 1) + '：' + opt.meld.map(C.tileLabel).join(''));
    const no = document.createElement('i');
    no.className = 'chi-option-no';
    no.textContent = String(index + 1);
    b.appendChild(no);
    const row = document.createElement('span');
    row.className = 'chi-option-tiles';
    opt.meld.forEach((id) => row.appendChild(tileEl(id, 'mini-tile')));
    b.appendChild(row);
    b.addEventListener('click', () => {
      unlockAudio();
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
        if (types.includes('hu')) addButton(bar, '胡', 'hu', () => humanClaim('hu'), '胡牌');
        if (types.includes('gang')) addButton(bar, '杠', 'gang', () => humanClaim('gang'), '明杠');
        if (types.includes('peng')) addButton(bar, '碰', 'peng', () => humanClaim('peng'));
        const chi = cand.actions.find((x) => x.type === 'chi');
        if (chi) {
          if (chi.options.length > 1) {
            chi.options.forEach((opt, i) => addChiOption(bar, opt, i, () => humanClaim('chi', i)));
          } else if (chi.options.length) {
            addButton(bar, '吃', 'chi', () => humanClaim('chi', 0), '吃 ' + chi.options[0].meld.map(C.tileLabel).join(''));
          }
        }
        addButton(bar, '过', 'pass', humanPass);
      });
    } else {
      const own = C.selfActions(state, 0);
      const sig = 'discard:' + own.hu + ':' + own.concealedKongs.join('.') + ':' + own.addedKongs.join('.');
      setActionBar(sig, (bar) => {
        if (own.hu) addButton(bar, '胡', 'hu', humanWin, '自摸胡');
        own.concealedKongs.forEach((id) => addButton(bar, '杠', 'gang', () => humanSelfKong('concealed', id), '暗杠 ' + C.tileLabel(id)));
        own.addedKongs.forEach((id) => addButton(bar, '杠', 'gang', () => humanSelfKong('added', id), '补杠 ' + C.tileLabel(id)));
        if (!own.hu && !own.concealedKongs.length && !own.addedKongs.length) addInfo(bar, '选择一张手牌出牌');
        else addInfo(bar, '或点击手牌出牌');
      });
    }
  }

  /* ---------------- 命令包装 ---------------- */
  function command(source, fn, decision) {
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
    // 联机：只有"我这手牌"要写进动作日志；电脑的动作各端自己算，不落库
    if (decision && Online && Online.isOnline()) {
      Online.push(0, decision).then((res) => {
        if (res && res.ok === false) {
          logLine('error', '联机同步失败：' + (res.error || ''));
          toast('这一手没能同步给对手：' + (res.error || ''));
        }
      }).catch((err) => {
        logLine('error', '联机同步异常：' + ((err && err.message) || err));
      });
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
          if (ev.seat !== 0) { if (Sfx) Sfx.draw(); else playSound('draw'); }
          break;
        case 'discard':
          logLine('action', `出牌 src=${source} seat=${NAMES[ev.seat]} tile=${C.tileLabel(ev.tile)} pending=${ev.pending.join(',') || '无'}`);
          if (Sfx) Sfx.discardTile(ev.tile); else playSound('discard');   // 落桌声 + 报牌名「四万」
          if (ev.seat === 0 && beforeCapture) discardFx = { seat: 0, tile: ev.tile, rect: beforeCapture };
          else discardFx = { seat: ev.seat, tile: ev.tile, rect: null };
          updateCallout(ev.seat, ev.tile);
          break;
        case 'chi': case 'peng':
          logLine('action', `${ev.type === 'chi' ? '吃牌' : '碰牌'} seat=${NAMES[ev.seat]} tile=${C.tileLabel(ev.tile)} from=${NAMES[ev.from]}`);
          if (Sfx) Sfx.claim(ev.type); else playSound(ev.type);
          break;
        case 'gang':
          logLine('action', `杠牌(${ev.kind}) seat=${NAMES[ev.seat]} tile=${C.tileLabel(ev.tile)}`);
          if (Sfx) Sfx.claim('gang'); else playSound('gang');
          break;
        case 'hu':
          logLine('action', `胡牌 seat=${NAMES[ev.seat]} ${ev.source} tile=${C.tileLabel(ev.tile)}`);
          if (Sfx) Sfx.claim('hu'); else playSound('hu');
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
    command('human', () => C.discardTile(state, 0, index), { kind: 'discard', index });
  }
  function humanClaim(type, optionIndex) {
    if (busy || !state || state.phase !== C.PHASES.CLAIM) return;
    command('human', () => C.claimDiscard(state, 0, type, optionIndex || 0), { kind: 'claim', type, optionIndex: optionIndex || 0 });
  }
  function humanPass() {
    if (busy || !state || state.phase !== C.PHASES.CLAIM) return;
    command('human', () => C.passClaim(state, 0), { kind: 'pass' });
  }
  function humanSelfKong(type, tile) {
    if (busy || !state) return;
    command('human', () => C.claimSelfKong(state, 0, type, tile), { kind: 'selfKong', kongType: type, tile });
  }
  function humanWin() {
    if (busy || !state) return;
    command('human', () => C.winSelf(state, 0), { kind: 'hu' });
  }

  /* ---------------- AI 调度 ---------------- */
  function scheduleAi(a) {
    if (aiTask && aiTask.epoch === epoch && aiTask.seat === a.seat && aiTask.kind === a.kind) return;
    if (aiTask) { clearTimeout(aiTask.id); aiTask = null; }
    const base = a.kind === 'claim' ? SPEED.claim : SPEED.discard;
    const jitter = 1 + (Math.random() * 2 - 1) * SPEED_JITTER;
    const delay = Math.max(0, Math.round(base * jitter * speedScale));
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
  function isRemoteHuman(seat) {
    return !!(Online && Online.isOnline() && seat !== 0 && Online.isHumanSeat(seat));
  }
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
    // 联机：轮到的是真人对手（不是电脑），只能等，不能替他打
    if (isRemoteHuman(a.seat)) {
      barSig = 'remote:' + a.seat + a.kind;
      setActionBar(barSig, (bar) => addInfo(bar, NAMES[a.seat] + (a.kind === 'claim' ? ' 正在想是否接牌…' : ' 正在出牌…')));
      return;
    }
    scheduleAi(a);
  }
  function heartbeatTick() {
    if (!state || state.phase === C.PHASES.OVER) return;
    const a = C.awaiting(state);
    if (!a) return;
    if (a.seat === 0 && !autoPlay) return;
    if (isRemoteHuman(a.seat)) return;   // 等真人，不算"任务缺失"
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
      kongs: (state.kongLog || []).map((k) => ({ seat: k.seat, kind: k.kind })),
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
      if (account.source === 'cloud') {
        persist({ silent: true });
        recordRoundCloud(settlement, rankDelta);
      }
    }
    saveBankroll();
    loadSeatBalances();
    logLine('action', `本局结算 银币=${settlement.deltas.join('/')} 倍数=${settlement.multiplier} 段位分=${rankDelta.join('/')} 余额=${balances.join('/')}`);
  }

  /** 战绩流水进 mahjong_rounds；失败只记日志，不影响牌局 */
  function recordRoundCloud(sd, rd) {
    if (!Cloud || !account || account.source !== 'cloud') return;
    Cloud.recordRound({
      nick: account.nick,
      hallId,
      baseBet: sd.baseBet,
      winType: sd.type,
      seat: 0,
      delta: sd.deltas[0],
      rankDelta: (rd && rd[0]) || 0,
      balanceAfter: account.coins,
      seatScores: sd.deltas
    }).then((res) => {
      if (!res.ok) logLine('action', '战绩上传失败：' + res.error);
      else logLine('action', '战绩已上传 第' + res.round.id + '条');
    }).catch((err) => logLine('action', '战绩上传异常：' + ((err && err.message) || err)));
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
    const kongNet = settlement ? (settlement.kongDeltas ? settlement.kongDeltas[seat] : 0) : 0;
    const mine = settlement && settlement.kongs ? settlement.kongs.filter((k) => k.seat === seat) : [];
    if (settlement && settlement.multiplier) {
      if (isWinner) {
        addLine(resultTitle(r), '1 倍');
        addLine('底注', A.fmtNum(settlement.unit));
      } else {
        addLine(settlement.reasons[seat] || '输', settlement.multiplier + ' 倍');
      }
    }
    // 杠分单独列出来：谁开的杠、开的哪种、收了多少，一眼对得上
    if (mine.length) {
      const byKind = {};
      mine.forEach((k) => { byKind[k.kind] = (byKind[k.kind] || 0) + k.total; });
      Object.keys(byKind).forEach((kind) => addLine(kind, '+' + A.fmtNum(byKind[kind])));
    } else if (kongNet) {
      addLine('杠分', A.fmtSigned(kongNet));
    }
    card.appendChild(lines);

    const total = document.createElement('div');
    total.className = 'rs-total';
    total.textContent = A.fmtSigned(settlement ? settlement.deltas[seat] : 0);
    card.appendChild(total);
    return card;
  }

  /** 赢家的完整牌型：副露（成组）+ 手里的牌，一行排开。
   *  以前只画手里的牌，碰过杠过的都看不见，等于"不完整"。 */
  function paintResultHand(handRow, r, winner) {
    handRow.innerHTML = '';
    const melds = (winner >= 0 && r.melds) ? r.melds : [];
    melds.forEach((m) => {
      const group = document.createElement('span');
      group.className = 'result-meld-group';
      m.tiles.forEach((id) => group.appendChild(tileEl(id, 'result-meld-tile')));
      handRow.appendChild(group);
    });
    const hand = r.winningHand || (winner >= 0 ? state.hands[winner] : []);
    hand.forEach((id, i) => {
      const isWin = winner >= 0 && i === hand.length - 1 && id === r.winningTile;
      handRow.appendChild(tileEl(id, isWin ? 'winning-tile' : ''));
    });
    handRow.classList.toggle('hidden', !hand.length && !melds.length);
  }

  /** 结算层自适应：牌多就按可用宽度缩，还高就收边距，最后等比缩小——绝不出现滚动条 */
  function fitResult() {
    const modal = $('result-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    const sheet = modal.querySelector('.result-sheet');
    const row = $('result-hand');
    if (!sheet || !row) return;
    sheet.classList.remove('is-tight');
    sheet.classList.remove('is-scroll');
    sheet.style.transform = '';
    // 1) 一行放得下：按"牌数 × 间距"倒算每张牌的宽度（副露分组另占间隔）
    const tiles = row.querySelectorAll('.tile-face').length;
    const groups = row.querySelectorAll('.result-meld-group').length;
    const box = row.clientWidth - 8;
    if (tiles && box > 0) {
      const gap = 3;
      const gaps = Math.max(0, tiles - 1) * gap + groups * 12;
      const w = Math.floor((box - gaps) / tiles);
      row.style.setProperty('--rw', Math.max(12, Math.min(34, w)) + 'px');
    }
    // 2) 高度还超，收边距与字号
    if (sheet.scrollHeight > sheet.clientHeight + 2) sheet.classList.add('is-tight');
    // 3) 极端情况（又窄又矮，比如 320×480）才允许滚动，但滚动条本身藏起来：
    //    内容不能被裁掉，也不该出现那根"拉条"
    sheet.classList.toggle('is-scroll', sheet.scrollHeight > sheet.clientHeight + 2);
  }

  /** 闪电画在结算层里（按坐标定位），不放在牌里面——.result-hand-row 是 overflow:hidden，
   *  贴在牌上的闪电会被裁掉半截，那还不如不做。 */
  function strikeWinningTile() {
    const modal = $('result-modal');
    const row = $('result-hand');
    if (!modal || !row || modal.classList.contains('hidden')) return false;
    const tile = row.querySelector('.tile-face.winning-tile');
    if (!tile) return false;
    const tr = tile.getBoundingClientRect();
    const mr = modal.getBoundingClientRect();
    if (!tr.width) return false;
    const bolt = document.createElement('span');
    bolt.className = 'result-bolt' + (reducedMotion() ? ' is-still' : '');
    // 闪电用"描边当光晕"，不用 blur 滤镜——SVG 里的 blur 在非等比拉伸时会露出一块方框
    bolt.innerHTML = '<svg viewBox="0 0 80 200" preserveAspectRatio="none" aria-hidden="true">'
      + '<path class="bolt-halo" d="M50 4 L14 96 L36 96 L24 196 L68 76 L46 76 L60 4 Z"/>'
      + '<path class="bolt-glow" d="M50 4 L14 96 L36 96 L24 196 L68 76 L46 76 L60 4 Z"/>'
      + '<path class="bolt-core" d="M50 4 L14 96 L36 96 L24 196 L68 76 L46 76 L60 4 Z"/>'
      + '<path class="bolt-fork" d="M30 74 L10 104"/><path class="bolt-fork" d="M47 122 L64 152"/>'
      + '</svg>';
    bolt.style.left = Math.round(tr.left - mr.left + tr.width / 2) + 'px';
    bolt.style.top = Math.round(tr.top - mr.top + Math.round(tr.height * 0.35)) + 'px';
    const flash = document.createElement('span');
    flash.className = 'result-flash' + (reducedMotion() ? ' is-still' : '');
    modal.appendChild(flash);
    modal.appendChild(bolt);
    modal.classList.add('is-striking');
    tile.classList.add('is-struck');
    playSound('thunder');
    window.setTimeout(() => {
      bolt.remove(); flash.remove();
      modal.classList.remove('is-striking');
      tile.classList.remove('is-struck');
    }, 1500);
    return true;
  }

  function showResult() {
    if (!state || !state.result) return;
    const r = state.result;
    $('result-title').textContent = resultTitle(r);
    const winner = Number.isInteger(r.seat) ? r.seat : -1;

    const handRow = $('result-hand');
    handRow.classList.remove('is-wrap');
    handRow.style.removeProperty('--rw');
    paintResultHand(handRow, r, winner);

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
      const hasKong = !!(settlement && settlement.kongDeltas && settlement.kongDeltas.some((v) => v));
      msg.textContent = r.type === 'abort' ? '本局已中止，不计入战绩'
        : (hasKong ? '本局荒牌，只算杠分' : '本局荒牌，银币不变');
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
    requestAnimationFrame(() => {
      fitResult();
      // 等面板落位、牌宽算好再劈，否则闪电会打在旧坐标上
      window.setTimeout(() => strikeWinningTile(), reducedMotion() ? 0 : 220);
    });
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
      $('dice-subtitle').textContent = '点数决定谁先摸牌与开牌位置';
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
        $('dice-outcome').textContent = `点数 ${dice[0]} + ${dice[1]} = ${setup.sum} · ${NAMES[setup.dealer]} 起手`;
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

  /* ---------------- 登录 / 注册（全部走 Auth 层，异步） ---------------- */
  let loginBusy = false;

  function openLogin(opts) {
    const o = opts || {};
    $('login-modal').classList.remove('hidden');
    // 带原因进来的（比如"连真人要先登录"）就别一声不响地清空
    loginTip(o.tip || '');
    setLoginBusy(false);
    const phone = $('login-phone');
    if (phone) phone.value = o.noFill ? '' : (Auth.lastAccount() || '');
    const code = $('login-code');
    if (code) code.value = '';
    const rem = $('login-remember');
    if (rem) rem.checked = Auth.rememberEnabled();
    paintCloudNote();
    // 万一是在 init 落定前点开的（启动页比 SDK 先露面），落定后补一次重画
    if (Cloud) Cloud.init().then(() => {
      if (!$('login-modal').classList.contains('hidden')) paintCloudNote();
    }).catch(() => {});
    setTimeout(() => {
      const el = phone && phone.value ? $('login-code') : phone;
      if (el) el.focus();
    }, 60);
  }

  /** 登录框底部的说明：云端到底能不能用，在这里说实话 */
  function paintCloudNote() {
    const note = $('login-cloud-note');
    const st = Cloud ? Cloud.status() : { ready: false, error: '云端模块未加载' };
    if (note) {
      if (st.ready) {
        note.textContent = '首次登录自动建号。银币、段位与战绩存在云端，换手机也一样。';
        note.className = 'login-note';
      } else {
        note.textContent = '云端暂不可用：' + (st.error || '未知原因') + '。可以先以游客身份试玩。';
        note.className = 'login-note warn';
      }
    }
    paintSendCode();
    ['do-verify', 'do-workbuddy'].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = !st.ready || loginBusy;
    });
    const guestBtn = $('do-guest');
    if (guestBtn) guestBtn.disabled = loginBusy;   // 游客不依赖云端，云端挂了也能进
  }

  let codeCooldown = 0;
  let codeTimer = null;
  function paintSendCode() {
    const b = $('do-send-code');
    if (!b) return;
    if (codeCooldown > 0) {
      b.disabled = true;
      b.textContent = codeCooldown + 's 后重发';
      return;
    }
    const st = Cloud ? Cloud.status() : { ready: false };
    b.disabled = !st.ready || loginBusy;
    b.textContent = '获取验证码';
  }
  function startCooldown(sec) {
    codeCooldown = sec || 60;
    paintSendCode();
    if (codeTimer) clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      codeCooldown -= 1;
      if (codeCooldown <= 0) { codeCooldown = 0; clearInterval(codeTimer); codeTimer = null; }
      paintSendCode();
    }, 1000);
  }
  function loginTip(msg, ok) {
    const t = $('login-tip');
    if (!t) return;
    t.textContent = msg || '';
    t.className = 'login-tip' + (ok ? ' ok' : '');
  }
  function setLoginBusy(busy) {
    loginBusy = !!busy;
    paintCloudNote();
    if (loginBusy) loginTip('正在登录…', true);
  }
  function focusField(field) {
    const el = field === 'code' ? $('login-code') : $('login-phone');
    if (el) { el.focus(); el.select && el.select(); }
  }

  /** 第一步：发验证码。只发一次码，校验阶段绝不重新发 */
  async function doSendCode() {
    if (loginBusy || codeCooldown > 0) return;
    const cp = Auth.checkPhone($('login-phone').value);
    if (!cp.ok) { loginTip(cp.error); focusField('phone'); return; }
    const btn = $('do-send-code');
    if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.textContent = '发送中…'; }
    loginTip('正在发送验证码…', true);
    let res;
    try { res = await Auth.sendCode({ phone: cp.value }); }
    catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (btn) btn.classList.remove('busy');
    if (!res.ok) {
      loginTip(res.error);
      paintSendCode();
      focusField(res.field || 'phone');
      return;
    }
    startCooldown(60);
    loginTip('验证码已发送到 ' + cp.value.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') + '，请查收', true);
    focusField('code');
  }

  /** 第二步：提交已拿到的码。失败时保留本次挑战，可以直接重输 */
  async function doVerify() {
    if (loginBusy) return;
    const cp = Auth.checkPhone($('login-phone').value);
    if (!cp.ok) { loginTip(cp.error); focusField('phone'); return; }
    const token = String($('login-code').value || '').trim();
    if (!token) { loginTip('请输入验证码'); focusField('code'); return; }
    setLoginBusy(true);
    let res;
    try { res = await Auth.verifyCode({ phone: cp.value, token }); }
    catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    setLoginBusy(false);
    if (!res.ok) { loginTip(res.error); focusField(res.field || 'code'); return; }
    if ($('login-remember') && $('login-remember').checked) Auth.rememberAccount(cp.value);
    finishLogin(res);
  }

  /** 跳转式登录（WorkBuddy / 微信）：同标签页授权，回调由 startSession() 统一处理 */
  async function doOAuth(provider) {
    if (loginBusy) return;
    setLoginBusy(true);
    let res;
    try { res = await Auth.startOAuth(provider); }
    catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    if (res.ok && res.redirecting) return;       // 正在跳转，按钮保持禁用
    setLoginBusy(false);
    if (!res.ok) loginTip(res.error);
  }
  function doWorkBuddy() { return doOAuth('workbuddy'); }

  /** 游客：明确标注进度只存本机，绝不冒充云端账号 */
  async function doGuest() {
    if (loginBusy) return;
    Auth.useCloud(false);
    setLoginBusy(true);
    const id = guestDeviceId();
    let res;
    try {
      res = await Auth.signInOrSignUp({
        account: '游客' + id.slice(-6),
        password: 'guest-' + id,
        nick: '游客' + id.slice(-4)
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
    setLoginBusy(false);
    if (!res.ok) { loginTip('游客模式进入失败：' + res.error); return; }
    finishLogin(res);
  }
  function guestDeviceId() {
    let id = '';
    try { id = localStorage.getItem('shiping-guest-id-v1') || ''; } catch (_) { id = ''; }
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('shiping-guest-id-v1', id); } catch (_) { /* ignore */ }
    }
    return id;
  }

  /** 登录成功后统一收口：落账号 → 关弹层 → 见面礼 → 赛季流程 */
  async function finishLogin(res) {
    account = (res && res.account) || null;
    if (!account) { loginTip('登录没有返回账号信息，请重试'); return; }
    if (codeTimer) { clearInterval(codeTimer); codeTimer = null; codeCooldown = 0; }
    hideAllLayers();
    toggleAccountMenu(false);
    playSound('ui');
    loadSeatBalances();
    paintSync();
    if (res.created) toast('账号已创建，欢迎 ' + account.nick);
    else toast('欢迎回来，' + account.nick);
    await maybeWelcome();
    maybeSeasonFlow();
  }

  /** 见面礼只发一次：以账号自己的 welcomeGranted 为准，换设备也不会重复领 */
  async function maybeWelcome() {
    if (!account || account.welcomeGranted) return;
    account.coins += 4000;
    account.welcomeGranted = true;
    loadSeatBalances();
    showReward(4000, '银币');
    await persist({ silent: true });
  }

  /* ---------------- 账号浮层：改昵称 / 切换 / 退出 / 清档 ---------------- */
  function renderAccountMenu() {
    if (!account) return;
    const r = rankInfo();
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('am-face', (account.nick || '牌').slice(0, 1));
    set('am-nick', account.nick);
    set('am-account', (account.source === 'cloud' ? '云端 · ' : '游客 · ') + account.account);
    set('am-rank', r.name + ' · 段位分 ' + r.text);
    const box = $('am-rename-box');
    if (box) box.classList.add('hidden');
    paintSync();
  }
  function toggleAccountMenu(force) {
    const menu = $('account-menu');
    if (!menu) return;
    const show = force === undefined ? menu.classList.contains('hidden') : !!force;
    if (show) renderAccountMenu();
    else if (!show) {
      const box = $('am-rename-box');
      if (box) box.classList.add('hidden');
    }
    menu.classList.toggle('hidden', !show);
  }
  function toggleRename(force) {
    const box = $('am-rename-box');
    if (!box) return;
    const show = force === undefined ? box.classList.contains('hidden') : !!force;
    if (show) {
      const input = $('am-nick-input');
      if (input) { input.value = account ? account.nick : ''; input.focus(); input.select && input.select(); }
    }
    box.classList.toggle('hidden', !show);
  }
  async function saveNick() {
    if (!account) return;
    const input = $('am-nick-input');
    const v = String((input && input.value) || '').trim();
    if (v.length < 2) { toast('昵称至少 2 个字'); return; }
    if (v.length > 12) { toast('昵称最多 12 个字'); return; }
    account.nick = v;
    toggleRename(false);
    renderAccountMenu();
    renderHome();
    const res = await persist();
    if (res.ok) toast('昵称已保存' + (account.source === 'cloud' ? '到云端' : '到本机'));
  }
  /** 退出登录；switchMode 为真时退出后立刻弹登录框，方便换号 */
  async function logoutAccount(switchMode) {
    try { await Auth.signOut(); } catch (_) { /* ignore */ }
    stopAi();
    epoch += 1;
    state = null;
    account = null;
    balances = [0, 0, 0, 0];
    settlement = null;
    rankDelta = null;
    syncState = 'idle';
    syncAt = 0;
    savePending = false;
    retryTimer && clearTimeout(retryTimer);
    retryTimer = null;
    hideAllLayers();
    hideResult();
    toggleAccountMenu(false);
    showScreen('splash');
    if (switchMode) {
      openLogin({ noFill: true });
    } else {
      toast('已退出登录');
    }
  }
  async function clearLocalSave() {
    const isCloud = !!(account && account.source === 'cloud');
    const msg = isCloud
      ? '这会清掉这台设备上的登录状态与本地缓存。云端档案（银币、段位、战绩）不会被删除，重新登录还能找回。确定继续吗？'
      : '清空本机存档会删除这台设备上的游客账号、银币与段位，无法恢复。确定继续吗？';
    if (!window.confirm(msg)) return;
    if (isCloud) { try { await Auth.signOut(); } catch (_) { /* ignore */ } }
    const removed = Auth.clearLocal();
    account = null;
    balances = [0, 0, 0, 0];
    stopAi();
    epoch += 1;
    state = null;
    syncState = 'idle';
    syncAt = 0;
    hideAllLayers();
    hideResult();
    toggleAccountMenu(false);
    showScreen('splash');
    toast('已清空 ' + removed.length + ' 项本机数据' + (isCloud ? '，云端档案仍在' : ''));
  }

  /* ---------------- 赛季流程 ---------------- */
  /** 赛季开屏只放一次：这个状态跟着账号走（云端存 season_seen，游客也存在自己的账号对象里） */
  function maybeSeasonFlow() {
    if (!account) { showScreen('splash'); return; }
    if (account.seasonSeen) { enterHome(); return; }
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
    if (account) {
      account.seasonSeen = true;
      persist({ silent: true });
    }
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
    paintLobbyMode();
    paintFreeButton();
  }

  /* ---------------- 玩法选择：三个都在下拉里，压在「快速匹配」上方 ----------------
   * 宝秀 / 个旧规则还没定，内核里它们的 defaults 与石屏一致、scoring 为 null，
   * 所以选中后依然能开局试玩，但大厅与桌面都明写「规则整理中，暂按石屏规则」，
   * 不冒充已经实现。拿到真实规则时只要补 core.js 里那两份 defaults / scoring。 */
  const VARIANT_TIPS = {
    baoxiu: '宝秀麻将规则还在整理，暂按石屏规则试玩',
    gejiu: '个旧麻将规则还在整理，暂按石屏规则试玩'
  };
  function paintVariantSelect() {
    const v = C.getVariant(variantId);
    const sel = $('lobby-variant-select');
    if (sel) sel.value = v.id;
    const title = $('lobby-variant-title');
    if (title) title.textContent = v.name;
    const sub = $('lobby-variant-sub');
    if (sub) sub.textContent = v.region + ' · ' + (v.available ? '136 张 · 吃碰杠全开 · 四人一桌' : '规则整理中 · 暂按石屏规则');
    const note = $('lobby-variant-note');
    if (note) note.textContent = v.available ? '' : (VARIANT_TIPS[v.id] || '');
    const mark = $('table-variant-name');
    if (mark) mark.textContent = v.name;
    const hallTitle = $('hall-title');
    if (hallTitle) hallTitle.textContent = v.name;
  }
  function setVariant(id) {
    const v = C.VARIANTS.find((x) => x.id === id);
    if (!v) return;
    variantId = v.id;
    saveVariantId();
    paintVariantSelect();
    if (!v.available) {
      const tip = VARIANT_TIPS[v.id] || '这个玩法还在整理';
      toast(tip);
      lobbyStatus(tip, 'warn');
    } else lobbyStatus('');
  }
  function bindVariantSelect() {
    const sel = $('lobby-variant-select');
    if (!sel) return;
    sel.addEventListener('change', () => { playSound('ui'); setVariant(sel.value); });
  }

  /* ---------------- 大厅：只留「快速匹配」和「快速人机」 ---------------- */
  function lobbyStatus(text, kind) {
    const el = $('lobby-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'lobby-status' + (kind ? ' ' + kind : '');
  }

  /** 真人匹配要「云端可用 + 云端账号」。没登录时不把按钮灰掉——
   *  灰按钮只会让人以为功能坏了，点了直接弹登录并说清原因更好懂。 */
  function paintLobbyMode() {
    paintVariantSelect();
    const cloudOk = !!(Cloud && Cloud.status && Cloud.status().ready);
    const onlineOk = cloudOk && !!account && account.source === 'cloud';
    const btn = $('lobby-match');
    if (btn) btn.classList.toggle('needs-login', !onlineOk);
    const hint = $('lobby-hint');
    if (hint) {
      hint.textContent = onlineOk
        ? '和真人坐一桌；人不够的位置由电脑补上，不会让你干等'
        : (cloudOk ? '连真人需要用手机号登录（游客只能打人机）' : '云端暂时连不上，先打人机吧');
    }
    return onlineOk;
  }

  /** 联机要用的昵称：大厅不再放输入框（改昵称在左上角头像里），
   *  所以直接取当前档案昵称，没登录时退回 Net 记着的名字。 */
  function lobbyNickValue() {
    if (!Net) return (account && account.nick) || '牌友';
    const mine = (account && account.nick) || '';
    return Net.setNick(mine || Net.nick());
  }

  /* ---------------- 每日福利：登录礼 + 免费领银币 ---------------- */
  function paintFreeButton() {
    const btn = $('lobby-free');
    const count = $('lobby-free-count');
    if (!btn) return;
    if (!account) {
      if (count) count.textContent = '登录后可领';
      btn.classList.remove('is-empty');
      return;
    }
    const st = A.dailyState(account, new Date());
    if (count) count.textContent = '今日 ' + st.freeUsed + '/' + st.times;
    btn.classList.toggle('is-empty', st.freeLeft <= 0);
    btn.title = st.freeLeft > 0
      ? `今天还能领 ${st.freeLeft} 次，每次 ${A.fmtNum(A.FREE_CLAIM_COINS)} 银币`
      : '今天的免费银币领完了，明天 0 点重置';
  }
  /** 到账反馈：在按钮下方飘一个「+4,000」，钱包数字跟着弹一下。
   *  只靠 toast 会有一瞬间看不出钱进没进账。 */
  function coinPop(amount) {
    const btn = $('lobby-free');
    if (btn) {
      const r = btn.getBoundingClientRect();
      const el = document.createElement('span');
      el.className = 'coin-pop';
      el.textContent = '+' + A.fmtNum(amount);
      el.style.left = Math.round(r.left + r.width / 2) + 'px';
      el.style.top = Math.round(r.top + r.height) + 'px';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 950);
    }
    const coins = $('home-coins');
    if (coins) {
      coins.classList.remove('is-bump');
      void coins.offsetWidth;
      coins.classList.add('is-bump');
    }
  }
  function doFreeCoins() {
    if (!account) { openLogin({ tip: '领银币要先登录；游客进度只存本机。' }); return; }
    const res = A.claimFreeCoins(store(), account, new Date());
    if (!res.ok) {
      lobbyStatus(res.error, 'warn');
      toast(res.error);
      paintFreeButton();
      return;
    }
    account = res.account || account;
    renderHome();
    persist({ silent: true });
    /* 很多人第一次进游戏点的就是这颗按钮：先在这一个手势里解锁两层音频，
       再发「叮叮 + 哗啦」，避免只飘字不响。 */
    unlockAudio();
    playSound('coin');
    if (Sfx && Sfx.coin) Sfx.coin();
    coinPop(res.coins);
    toast('+' + A.fmtNum(res.coins) + ' 银币（今日还剩 ' + res.state.freeLeft + ' 次）');
    lobbyStatus('领到 ' + A.fmtNum(res.coins) + ' 银币，今日还剩 ' + res.state.freeLeft + ' 次');
  }
  /** 每日登录礼：进大厅时自动发一次，首日不发（见面礼就是首日那笔） */
  function grantDailyLogin() {
    if (!account) return;
    const res = A.claimDailyLogin(store(), account, new Date());
    if (res.account) account = res.account;
    if (!res.ok) { paintFreeButton(); return; }
    renderHome();
    persist({ silent: true });
    playSound('coin');
    coinPop(res.coins);
    toast('每日登录礼 +' + A.fmtNum(res.coins) + ' 银币');
    lobbyStatus('每日登录礼 +' + A.fmtNum(res.coins) + ' 银币');
    paintFreeButton();
  }

  function resetSeatNames() {
    for (let i = 0; i < 4; i++) NAMES[i] = DEFAULT_NAMES[i];
    for (let i = 0; i < 4; i++) paintSeatName(i);
  }
  function applySeatNames(names, humanCount) {
    void humanCount;
    for (let i = 0; i < 4; i++) {
      NAMES[i] = (names && names[i]) ? names[i] : (Online ? Online.AI_NAMES[i] : DEFAULT_NAMES[i]);
      paintSeatName(i, Online && Online.isOnline() ? Online.isHumanSeat(i) : i === 0);
    }
  }
  function paintSeatName(seat, isHuman) {
    const el = $('seat-name-' + seat);
    if (!el) return;
    el.textContent = seat === 0 ? NAMES[0] : (SEATS[seat] + ' · ' + NAMES[seat]);
    el.classList.toggle('is-human', !!isHuman);
    el.classList.toggle('is-ai', isHuman === false);
  }

  function doQuickAi() {
    if (!account) { openLogin(); return; }
    if (Online) Online.end();
    resetSeatNames();
    lobbyStatus('人机对战 · 三个电脑陪你打');
    startTable('novice');
  }

  async function doQuickMatch() {
    if (!account) {
      lobbyStatus('连真人要先登录云端账号，登录完再点一次「快速匹配」', 'warn');
      openLogin({ tip: '连真人玩家需要先登录云端账号；游客只能打人机。' });
      return;
    }
    if (!Net || !Online) { lobbyStatus('联机模块没加载成功，先打人机吧', 'warn'); return; }
    if (!paintLobbyMode()) {
      lobbyStatus('连真人要先登录云端账号，登录完再点一次「快速匹配」', 'warn');
      openLogin({ tip: '连真人玩家需要先登录云端账号；游客只能打人机。' });
      return;
    }

    const btn = $('lobby-match');
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
    let result = null;
    try {
      for (let attempt = 0; attempt < 2 && !(result && result.ok); attempt++) {
        result = await Net.match({
          nick: lobbyNickValue(),
          hallId: 'novice',
          baseBet: A.hallOf('novice').baseBet,
          onStep: (t) => lobbyStatus(t)
        });
        if (result && result.code === 'retry') {
          lobbyStatus(result.error + '，正在重试…');
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    } catch (err) {
      result = { ok: false, error: (err && err.message) || '匹配失败' };
    }
    if (btn) { delete btn.dataset.busy; btn.disabled = false; }

    if (!result || !result.ok) {
      lobbyStatus((result && result.error) || '没匹配上，再试一次', 'warn');
      return;
    }
    lobbyStatus(result.humanCount > 1
      ? `连上 ${result.humanCount - 1} 位真人，开局！`
      : '暂时没有别人在线，先和电脑打一局（下一局会自动排人）');
    startOnlineTable(result);
  }

  function startOnlineTable(m) {
    const sess = Online.begin({
      roomId: m.roomId, seed: m.seed, mySeat: m.mySeat, humanCount: m.humanCount,
      names: m.names, hallId: m.hallId, baseBet: m.baseBet
    });
    sess.onRemote = (seat, action) => applyRemoteAction(seat, action);
    sess.onStatus = (st) => {
      if (st.kind === 'offline') {
        logLine('error', '联机轮询失败：' + (st.error || ''));
        toast('和云端断了联系，正在重连…');
      }
    };
    applySeatNames(sess.names, sess.humanCount);
    startTable(m.hallId || 'novice', { online: true });
    Online.startPolling({ interval: 800 });
    toast(sess.humanCount > 1 ? '已连上真人，开始对局' : '没有真人空位，电脑补位');
  }

  function applyRemoteAction(seat, action) {
    if (!state || state.phase === C.PHASES.OVER) return { ok: false, error: '局面已结束' };
    if (!action || action.kind === undefined) return { ok: false, error: '动作无效' };
    let err = null;
    command('remote', () => {
      try {
        C.applyDecision(state, Object.assign({}, action, { seat }));
      } catch (e) {
        err = e;
        throw e;
      }
    });
    return err ? { ok: false, error: err.message } : { ok: true };
  }
  function enterHome() {
    if (!account) { showScreen('splash'); return; }
    if (Online && Online.isOnline()) { Online.end(); resetSeatNames(); }   // 离开牌桌就退出联机房
    refreshAccount();
    renderHome();
    showScreen('home');
    grantDailyLogin();      // 每天第一次回到大厅发登录礼（首日由见面礼覆盖）
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
  /* ---------------- 局前等待层：换桌 / 准备 ----------------
   * 截图里那张「四家头像 + 两个胶囊按钮」的等待桌。开局仍在后台照常跑，
   * 点「准备」立刻收起、2.8 秒后自动收起，所以既不挡自动开局也不挡测试。 */
  function paintReadySeats() {
    for (let seat = 0; seat < 4; seat++) {
      const face = $('ready-face-' + seat);
      if (face) face.textContent = (NAMES[seat] || '牌').slice(0, 1);
      const name = $('ready-name-' + seat);
      if (name) name.textContent = NAMES[seat];
      const rank = $('ready-rank-' + seat);
      if (rank) rank.textContent = seat === 0 ? rankInfo().name : AI_RANKS[seat - 1];
      const coin = $('ready-coin-' + seat);
      if (coin) coin.textContent = A.fmtNum(balances[seat] || 0);
    }
    const bet = $('ready-bet');
    if (bet) bet.textContent = '底注 ' + A.fmtNum(A.hallOf(hallId).baseBet);
    const tip = $('ready-tip');
    if (tip) tip.textContent = '当前玩法：' + C.getVariant(variantId).name + ' · 点「准备」立刻开局';
  }
  function hideTableReady() {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    const el = $('table-ready');
    if (el) el.classList.add('hidden');
  }
  function showTableReady() {
    const el = $('table-ready');
    if (!el) return;
    paintReadySeats();
    el.classList.remove('hidden');
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = setTimeout(hideTableReady, 2800);
  }

  function startTable(id, startOpts) {
    if (!account) { openLogin(); return; }
    const opts = startOpts || {};
    if (!opts.online) {
      if (Online && Online.isOnline()) Online.end();
      resetSeatNames();
    }
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
    /* 真人从大厅进桌先看一眼同伴与「换桌 / 准备」；联机与调试入口直接开局 */
    if (!opts.online && !opts.instant) showTableReady();
    else hideTableReady();
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
    account = res.account || account;
    renderSignin();
    renderHome();
    persist({ silent: true });
    showReward(res.coins, '银币');
    playSound('coin');
  }
  function claimStreak() {
    const st = A.signinState(account, new Date());
    if (!st.canClaimStreak) { toast('连续登录 3 天后可领取'); return; }
    account.gold += st.streakReward;
    account.signin.streakClaimed = (account.signin.streakClaimed || 0) + 1;
    renderSignin();
    renderHome();
    persist({ silent: true });
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
          account = res.account || account;
          renderBack();
          renderHome();
          persist({ silent: true });
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
      if (!Cloud || !Cloud.status().ready) {
        openLogin();
        loginTip('云端暂不可用：' + ((Cloud && Cloud.status().error) || '模块未加载'));
        return;
      }
      Auth.useCloud(true);
      doOAuth('wechat').catch(() => {});
    });
    on('btn-phone', 'click', () => openLogin());
    on('splash-cs', 'click', () => toast('客服：honghe@example.com'));
    on('login-cs', 'click', () => toast('客服：honghe@example.com'));
    on('login-close', 'click', () => { $('login-modal').classList.add('hidden'); setLoginBusy(false); });
    on('do-send-code', 'click', () => { doSendCode().catch((e) => loginTip('发送失败：' + ((e && e.message) || e))); });
    on('do-verify', 'click', () => { doVerify().catch((e) => loginTip('登录失败：' + ((e && e.message) || e))); });
    on('do-workbuddy', 'click', () => { doWorkBuddy().catch((e) => loginTip('登录失败：' + ((e && e.message) || e))); });
    on('do-guest', 'click', () => { doGuest().catch((e) => loginTip('进入失败：' + ((e && e.message) || e))); });
    on('login-clear', 'click', () => { const p = $('login-phone'); if (p) { p.value = ''; p.focus(); } });
    on('login-remember', 'change', (e) => {
      Auth.setRemember(e.target.checked);
      const p = $('login-phone');
      if (e.target.checked && p && p.value.trim()) Auth.rememberAccount(p.value.trim());
    });
    on('forgot-pw', 'click', () => loginTip('收不到验证码：先确认手机号无误、留意拦截短信，稍后再点「获取验证码」'));
    on('login-code', 'keydown', (e) => { if (e.key === 'Enter') doVerify().catch(() => {}); });
    on('login-phone', 'keydown', (e) => { if (e.key === 'Enter') { const c = $('login-code'); if (c) c.focus(); } });
    on('login-phone', 'input', () => { if (loginTip) loginTip(''); });

    on('home-player', 'click', (e) => { e.stopPropagation(); toggleAccountMenu(); });
    on('home-player', 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAccountMenu(); }
    });
    on('am-rename', 'click', () => toggleRename());
    on('am-nick-save', 'click', () => { saveNick().catch(() => {}); });
    on('am-nick-input', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveNick().catch(() => {}); }
      if (e.key === 'Escape') toggleRename(false);
    });
    on('am-switch', 'click', () => { logoutAccount(true).catch(() => {}); });
    on('am-logout', 'click', () => { logoutAccount(false).catch(() => {}); });
    on('am-clear', 'click', () => { clearLocalSave().catch(() => {}); });
    document.addEventListener('click', (e) => {
      const menu = $('account-menu');
      if (!menu || menu.classList.contains('hidden')) return;
      if (menu.contains(e.target) || (e.target.closest && e.target.closest('#home-player'))) return;
      toggleAccountMenu(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      toggleAccountMenu(false);
      const modal = $('login-modal');
      if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden');
    });

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

    /* 新大厅：只有两个入口（玩法在首页的 #lobby-variant-select 下拉里选） */
    on('lobby-ai', 'click', () => { audioReady = true; if (Sfx) Sfx.unlock(); doQuickAi(); });
    on('lobby-match', 'click', () => {
      audioReady = true;
      if (Sfx) Sfx.unlock();
      doQuickMatch().catch((err) => lobbyStatus((err && err.message) || '匹配失败', 'warn'));
    });
    on('lobby-free', 'click', () => { unlockAudio(); doFreeCoins(); });
    bindVariantSelect();
    on('ready-go', 'click', () => { unlockAudio(); playSound('ui'); hideTableReady(); toast('已准备，开局！'); });
    on('ready-switch', 'click', () => {
      hideTableReady();
      stopAi();
      enterHome();
      toast('已换桌，回大厅重新选一场');
    });

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
    const sess = (Online && Online.isOnline()) ? Online.current() : null;
    // 联机时所有设备必须洗出同一副牌：用同一个种子的确定性随机数，
    // 骰子也从这条流里取，否则各家看到的庄家都不一样。
    const rng = sess ? mulberry32(sess.seed) : Math.random;
    const dice = sess
      ? [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)]
      : [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
    const play = () => {
      const setup = C.createGame(settings, rng, Object.assign({ variant: variantId }, C.diceSetup(dice)));
      if (sess && Online) Online.rotate(setup, sess.mySeat);
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
    $('setting-riichi').checked = document.body.classList.contains('skin-riichi');
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
    const lobbySound = $('lobby-sound');
    if (lobbySound) lobbySound.addEventListener('click', toggleSound);
    document.addEventListener('pointerdown', () => { unlockAudio(); }, { once: true });
    $('rules-open').addEventListener('click', () => { unlockAudio(); playSound('ui'); openRules(); });
    /* 右侧那颗圆形「☰」已删掉，规则设置统一走顶栏，别再给不存在的 id 绑事件 */
    $('rules-close').addEventListener('click', closeRules);
    $('rules-cancel').addEventListener('click', closeRules);
    $('rules-save').addEventListener('click', saveSettings);
    /* 立直牌面开关即时生效，不跟着「保存设置」走——换皮看一眼就能决定要不要 */
    $('setting-riichi').addEventListener('change', () => {
      const on = $('setting-riichi').checked;
      applySkin(on);
      try { localStorage.setItem(KEY_SKIN, on ? 'on' : 'off'); } catch (_) { /* ignore */ }
      toast(on ? '已切换到立直麻将机牌面' : '已换回传统牌面');
    });
    /* 假 3D 牌桌也是即时开关，关掉就是一键回滚到平面机台 */
    $('setting-3d').addEventListener('change', () => {
      const on = $('setting-3d').checked;
      apply3d(on);
      try { localStorage.setItem(KEY_3D, on ? 'on' : 'off'); } catch (_) { /* ignore */ }
      toast(on ? '已切换到假 3D 牌桌' : '已换回平面机台');
    });
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
    /* v0.11.0 调试钩子：把 15 秒读秒压到 1 秒，方便回归「超时自动出刚摸的牌」 */
    window.__shipingMahjongSetTurnSeconds = (s) => {
      turnSeconds = Math.max(1, Math.round(Number(s) || TURN_SECONDS));
      return turnSeconds;
    };
    window.__shipingMahjongReady = () => {
      const el = $('table-ready');
      return {
        hidden: !el || el.classList.contains('hidden'),
        seats: [0, 1, 2, 3].map((i) => ({
          name: ($('ready-name-' + i) || {}).textContent,
          rank: ($('ready-rank-' + i) || {}).textContent
        })),
        bet: ($('ready-bet') || {}).textContent,
        buttons: ['ready-switch', 'ready-go'].filter((id) => $(id))
      };
    };
    window.__shipingMahjongShowReady = () => { showTableReady(); return true; };
    window.__shipingMahjongSetVariant = (id) => { setVariant(id); return variantId; };
    /** 只画一次「三种吃法」的右侧小牌组，用来回归多选项的展示，不改动局面 */
    window.__shipingMahjongChiPreview = () => {
      const bar = $('action-bar');
      if (!bar) return 0;
      barSig = 'debug-chi-preview';
      bar.innerHTML = '';
      [{ meld: [0, 1, 2] }, { meld: [1, 2, 3] }, { meld: [2, 3, 4] }]
        .forEach((opt, i) => addChiOption(bar, opt, i, () => {}));
      addButton(bar, '过', 'pass', () => {});
      return bar.querySelectorAll('.chi-option').length;
    };
    /** 注入一组「吃 / 碰 / 杠」副露，用来回归「只有吃牌标接进来的那张」 */
    window.__shipingMahjongMeldPreview = () => {
      if (!state) return null;
      state.melds[0] = [
        { type: 'chi', tiles: [0, 1, 2], from: 1, calledFrom: 1, calledTile: 2, calledTileIndex: 2 },
        { type: 'peng', tiles: [5, 5, 5], from: 2, calledFrom: 2, calledTile: 5, calledTileIndex: 1 },
        { type: 'gang', tiles: [9, 9, 9, 9], from: 3, calledFrom: 3, calledTile: 9, calledTileIndex: 0, concealed: false, added: false }
      ];
      render(true);
      return Array.from(document.querySelectorAll('#meld-0 .meld-group')).map((g) => ({
        cls: g.className,
        called: g.querySelectorAll('.meld-called-tile').length,
        pins: g.querySelectorAll('.called-pin').length
      }));
    };
    /* 外壳调试接口：账号 / 赛季 / 场次。全部绕过 DOM 输入框，供自动化测试驱动 */
    window.__shipingMahjongShell = () => ({
      screen: screenId,
      account: account ? {
        id: account.id, account: account.account, nick: account.nick, coins: account.coins, gold: account.gold,
        rankPoints: account.rankPoints, rank: rankInfo().name, rankText: rankInfo().text,
        activated: !!account.activated, stats: Object.assign({}, account.stats),
        seasonSeen: !!account.seasonSeen, welcomeGranted: !!account.welcomeGranted,
        source: account.source || 'guest', rowId: account.rowId || null
      } : null,
      auth: { lastAccount: Auth.lastAccount(), history: Auth.history(), remember: Auth.rememberEnabled(), mode: Auth.currentMode() },
      cloud: Cloud ? Cloud.status() : { ready: false, error: '云端模块未加载' },
      sync: { state: syncState, at: syncAt, pending: savePending },
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
    /** 测试入口：走游客模式直接拿到一个账号，不依赖短信与云端 */
    async function debugAuth(kind, accName, password, nick, skipReward) {
      const acc = String(accName || '').trim();
      const pw = String(password || '');
      Auth.useCloud(false);
      const res = kind === 'register'
        ? await Auth.signUp({ account: acc, password: pw, nick: nick || acc })
        : await Auth.signIn({ account: acc, password: pw });
      if (!res.ok) return res;
      account = res.account;
      if (skipReward) {
        account.seasonSeen = true;
        hideAllLayers();
        loadSeatBalances();
        paintSync();
        await persist({ silent: true });
        enterHome();
      } else {
        await finishLogin(res);
      }
      return { ok: true, id: account.id, nick: account.nick, coins: account.coins, screen: screenId, isNew: kind === 'register' };
    }
    window.__shipingMahjongRegister = (accName, password, nick, skipReward) => debugAuth('register', accName, password, nick, skipReward);
    window.__shipingMahjongLogin = (accName, password, skipReward) => debugAuth('login', accName, password, '', skipReward);
    window.__shipingMahjongLogout = async () => {
      await logoutAccount(false);
      return true;
    };
    window.__shipingMahjongAuth = () => ({
      lastAccount: Auth.lastAccount(), history: Auth.history(), remember: Auth.rememberEnabled(),
      provider: Auth.currentProvider().id, mode: Auth.currentMode(),
      cloud: Cloud ? Cloud.status() : { ready: false, error: '云端模块未加载' }
    });
    /** 云端体检：状态 + 会话 + 一次真实数据面读取（未登录应被 RLS 挡回） */
    /* 联机调试：不走真实匹配，直接按给定房间参数开一局；再用手动注入模拟对手动作。
     * 这样浏览器测试能在没有第二个账号的情况下验证「座位旋转 + 远端动作落地」。 */
    window.__shipingMahjongOnlineStart = (opts) => {
      const o = opts || {};
      startOnlineTable({
        roomId: o.roomId || 'debug-room', seed: o.seed || 20261110, mySeat: o.mySeat || 0,
        humanCount: o.humanCount || 2, names: o.names || ['我', '对手'],
        hallId: o.hallId || 'novice', baseBet: 2000
      });
      return window.__shipingMahjongOnline();
    };
    window.__shipingMahjongOnline = () => {
      const s = Online && Online.current();
      if (!s) return { online: false };
      const a = state ? C.awaiting(state) : null;
      return {
        online: true, roomId: s.roomId, mySeat: s.mySeat, humanCount: s.humanCount,
        names: s.names.slice(), seq: s.seq, lastPull: s.lastPull,
        awaiting: a ? { seat: a.seat, kind: a.kind } : null,
        remoteTurn: a ? isRemoteHuman(a.seat) : false
      };
    };
    window.__shipingMahjongRemote = (seat, action) => {
      if (!Online || !Online.isOnline()) return { ok: false, error: '不在联机对局中' };
      applyRemoteAction(Number(seat) || 0, action || {});
      const a = state ? C.awaiting(state) : null;
      return { ok: true, awaiting: a ? { seat: a.seat, kind: a.kind } : null };
    };

    window.__shipingMahjongCloud = async () => {
      const st = Cloud ? Cloud.status() : { ready: false, error: '云端模块未加载' };
      const out = { status: st, mode: Auth.currentMode(), session: null, probe: null, account: null,
        sync: { state: syncState, at: syncAt, pending: savePending } };
      if (account) {
        out.account = { source: account.source || 'guest', rowId: account.rowId || null, coins: account.coins,
          gold: account.gold, rankPoints: account.rankPoints, welcomeGranted: !!account.welcomeGranted,
          seasonSeen: !!account.seasonSeen };
      }
      if (Cloud && st.ready) {
        const s = await Cloud.getSession();
        if (s.ok && s.session) out.session = { uid: Cloud.uidOf(s.session), label: Cloud.labelOf(s.session.user) };
        const q = await Cloud.database().from(Cloud.PLAYERS).select('id, coins').limit(1);
        out.probe = {
          ok: !q.error,
          rows: Array.isArray(q.data) ? q.data.length : 0,
          error: q.error ? (q.error.code || q.error.message || 'unknown') : null
        };
      }
      return out;
    };
    window.__shipingMahjongAccountMenu = (force) => {
      toggleAccountMenu(force);
      const menu = $('account-menu');
      return !!(menu && !menu.classList.contains('hidden'));
    };
    window.__shipingMahjongLoginForm = () => ({
      open: !$('login-modal').classList.contains('hidden'),
      phone: $('login-phone') ? $('login-phone').value : '',
      code: $('login-code') ? $('login-code').value : '',
      remember: $('login-remember') ? $('login-remember').checked : null,
      tip: $('login-tip') ? $('login-tip').textContent : '',
      note: $('login-cloud-note') ? $('login-cloud-note').textContent : '',
      busy: loginBusy,
      cooldown: codeCooldown,
      sendText: $('do-send-code') ? $('do-send-code').textContent : '',
      verifyDisabled: $('do-verify') ? $('do-verify').disabled : null,
      workbuddyDisabled: $('do-workbuddy') ? $('do-workbuddy').disabled : null,
      guestDisabled: $('do-guest') ? $('do-guest').disabled : null
    });
    window.__shipingMahjongSendCode = (phone) => {
      const el = $('login-phone');
      if (el) el.value = String(phone || '');
      return doSendCode().then(() => window.__shipingMahjongLoginForm());
    };
    window.__shipingMahjongVerifyCode = (code) => {
      const el = $('login-code');
      if (el) el.value = String(code || '');
      return doVerify().then(() => window.__shipingMahjongLoginForm());
    };
    window.__shipingMahjongEnterHome = () => { if (!account) return false; enterHome(); return screenId; };
    window.__shipingMahjongSkipSeason = () => {
      if (!account) return false;
      account.seasonSeen = true;
      persist({ silent: true });
      enterHome();
      return screenId;
    };
    window.__shipingMahjongOpenHall = () => { if (!account) return false; openHall(); return screenId; };
    window.__shipingMahjongStartTable = (id) => {
      if (!account) return false;
      /* 测试入口跳过「准备」层，避免等待层挡住几何测量与自动流程 */
      startTable(id || hallId, { instant: true });
      return { screen: screenId, hall: hallId, baseBet: A.hallOf(hallId).baseBet, phase: state ? state.phase : null };
    };
    window.__shipingMahjongOpenSignin = () => { if (!account) return false; openSignin(); return true; };
    window.__shipingMahjongOpenBack = () => { if (!account) return false; openBack(); return true; };
    window.__shipingMahjongResetProgress = () => {
      Auth.clearLocal();
      Auth.useCloud(true);
      account = null;
      balances = loadBankroll();
      syncState = 'idle';
      syncAt = 0;
      savePending = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      hideAllLayers();
      hideResult();
      toggleAccountMenu(false);
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
    /** 手动触发一次闪电，供视觉回归与用例使用 */
    window.__shipingMahjongStrike = () => strikeWinningTile();
    window.__shipingMahjongState = () => state;
    window.__shipingMahjongSettlement = () => settlement;
    window.__shipingMahjongWall = () => {
      if (!state) return null;
      const keep = wallKeep();
      return {
        tiles: state.wall.length,
        stacks: Math.floor((state.wall.length + 1) / 2),
        keep,
        visible: ['south', 'east', 'north', 'west'].map((k) => {
          const box = document.querySelector('.wall-' + k);
          return box ? Array.from(box.children).filter((el) => !el.classList.contains('is-gone')).length : -1;
        }),
        label: ($('wall-count') || {}).textContent || ''
      };
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
  function applyBrand() {
    document.title = BRAND.title;
    document.querySelectorAll('[data-brand]').forEach((el) => { el.innerHTML = BRAND.html; });
  }
  /** 隐私模式 / 禁用存储时，登录状态存不住，必须当场说清楚，不能让人以为登录成功了 */
  function storageAvailable() {
    try {
      localStorage.setItem('__shiping_probe', '1');
      localStorage.removeItem('__shiping_probe');
      return true;
    } catch (_) { return false; }
  }

  /** 启动：先弄清云端能不能用，再处理授权回跳，最后恢复会话。
   *  任何一步失败都停在启动页并说明原因，绝不偷偷降级成游客。 */
  async function startSession() {
    let mode = 'cloud';
    try { mode = localStorage.getItem(Auth.KEY_MODE) || 'cloud'; } catch (_) { mode = 'cloud'; }
    Auth.useCloud(mode !== 'guest');

    if (Cloud) await Cloud.init();
    // SDK 是 CDN 异步拉的：启动页先露出来，手快的人可能在 init 落定前就点开了登录框，
    // 那时画的是"云端暂不可用"。init 一落定就重画一次，别让人对着一个点不动的按钮。
    paintCloudNote();

    // 授权回跳必须在任何人脸把关之前处理：code 是一次性的，被拦一次就作废
    if (Cloud && Cloud.status().ready) {
      let cb = null;
      try { cb = await Auth.handleCallback(); } catch (_) { cb = null; }
      if (cb && cb.handled) {
        if (cb.ok && cb.account) { await finishLogin(cb); return; }
        openLogin();
        loginTip(cb.error || '授权登录失败，请重试');
        return;
      }
    }

    let acc = null;
    try { acc = await Auth.current(); } catch (_) { acc = null; }
    if (acc) {
      account = acc;
      loadSeatBalances();
      paintSync();
      await maybeWelcome();
      maybeSeasonFlow();
      return;
    }
    showScreen('splash');
  }

  function boot() {
    applyBrand();
    if (!storageAvailable()) toast('浏览器禁用了本地存储，登录状态与游客进度都无法保存');
    syncSoundButton();
    applySkin(loadSkinSetting());
    apply3d(load3dSetting());
    if (Sfx) Sfx.setEnabled(soundEnabled);
    bind();
    bindShell();
    loadSeatBalances();
    installDebugApi();
    /* iOS 只允许在用户手势里启动 AudioContext：第一次点哪里都顺手解锁一次，
     * 否则牌桌里第一次出牌是没声音的（这是移动端最容易踩的坑） */
    const unlockOnGesture = () => { unlockAudio(); };
    document.addEventListener('pointerdown', unlockOnGesture, { once: true });
    document.addEventListener('keydown', unlockOnGesture, { once: true });
    // 横竖屏切换时牌面尺寸会变，结算层的自适应要跟着重算
    window.addEventListener('resize', () => fitResult());
    window.addEventListener('orientationchange', () => setTimeout(fitResult, 220));
    heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
    startSession().catch((err) => {
      showScreen('splash');
      toast('启动失败：' + ((err && err.message) || err));
    });
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
