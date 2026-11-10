/* 石屏麻将 · 声音层（音效 + 中文牌名播报）| GPL-3.0-or-later
 *
 * 两条原则：
 *   1. 不带任何音频文件。牌桌上一局要响几十次，几十个 mp3 既拖慢首屏，
 *      也不方便换牌面/换语音。全部用 Web Audio 实时合成 + 系统中文 TTS。
 *      这套做法在开源浏览器麻将 kongxg888/mahjong 里被验证过（"零音频文件"）。
 *   2. iOS 只允许在用户手势里创建 AudioContext，在回调里 new 出来会一直是
 *      suspended（没声音）。所以这里统一走 unlock()：第一次点击/触摸时解锁，
 *      之后页面切回前台自动 resume。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HongheAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SUIT = ['万', '筒', '条'];
  const HONOR_WORD = { 东: '东风', 南: '南风', 西: '西风', 北: '北风', 中: '红中', 发: '发财', 白: '白板' };

  let ctx = null;
  let master = null;
  let enabled = true;
  let unlocked = false;
  let voiceOn = true;
  let noiseBuf = null;
  let speakToken = 0;

  function AudioCtor() {
    return (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  }

  /** 必须在用户手势里调用一次（点击、触摸、按键都算） */
  function unlock() {
    if (!enabled) return false;
    const Ctor = AudioCtor();
    if (!Ctor) return false;
    try {
      if (!ctx) {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      unlocked = ctx.state === 'running' || ctx.state === 'suspended';
      primeVoice();
      return true;
    } catch (_) {
      return false;
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch (_) { /* ignore */ }
    }
    return enabled;
  }
  function setVoice(on) { voiceOn = !!on; if (!voiceOn) { try { speechSynthesis.cancel(); } catch (_) {} } return voiceOn; }
  function isEnabled() { return enabled; }
  function isVoiceOn() { return voiceOn; }
  function status() { return { enabled, voiceOn, unlocked, hasCtx: !!ctx, hasTts: hasTts() }; }

  /* ---------------- 合成基础 ---------------- */
  function noise() {
    if (!ctx) return null;
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.35);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    noiseBuf = buf;
    return buf;
  }

  /** 牌磕在桌面上：噪声短促一击 + 低频闷响，比单纯的正弦更像木头/竹牌 */
  function clack(strength) {
    if (!enabled || !ctx) return;
    const s = Math.max(0.2, Math.min(1.6, strength || 1));
    const t = ctx.currentTime;
    try {
      const src = ctx.createBufferSource();
      src.buffer = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500 + Math.random() * 500;
      bp.Q.value = 1.1;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22 * s, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.085);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(t); src.stop(t + 0.12);

      const osc = ctx.createOscillator(), og = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(190, t);
      osc.frequency.exponentialRampToValueAtTime(120, t + 0.07);
      og.gain.setValueAtTime(0.16 * s, t);
      og.gain.exponentialRampToValueAtTime(0.0008, t + 0.1);
      osc.connect(og); og.connect(master);
      osc.start(t); osc.stop(t + 0.12);
    } catch (_) { /* ignore */ }
  }

  function tone(freq, at, dur, vol, wave) {
    if (!ctx) return;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    const t = ctx.currentTime + at;
    osc.type = wave || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0005, vol), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  function gong() {
    if (!enabled || !ctx) return;
    [[523, 0, 0.5, 0.05], [659, 0.06, 0.55, 0.045], [784, 0.12, 0.6, 0.04], [1046, 0.18, 0.9, 0.05]]
      .forEach((v) => tone(v[0], v[1], v[2], v[3], 'sine'));
  }

  /* ---------------- 中文语音 ---------------- */
  function hasTts() {
    return (typeof window !== 'undefined') && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function';
  }
  function zhVoice() {
    if (!hasTts()) return null;
    try {
      const list = speechSynthesis.getVoices() || [];
      return list.find((v) => /zh[-_]CN/i.test(v.lang)) || list.find((v) => /^zh/i.test(v.lang)) || null;
    } catch (_) { return null; }
  }
  let primed = false;
  function primeVoice() {
    if (primed || !hasTts()) return;
    primed = true;
    try {
      // 有些浏览器第一次 getVoices() 是空数组，读一次并把语速调好即可
      speechSynthesis.getVoices();
      if (typeof speechSynthesis.onvoiceschanged !== 'undefined') {
        speechSynthesis.onvoiceschanged = function () { /* 触发一次加载即可 */ };
      }
    } catch (_) { /* ignore */ }
  }

  /** 说一句话。interrupt=true 时打断上一句（牌名播报必须这样，不然会排队排到下一手） */
  function say(text, opts) {
    if (!enabled || !voiceOn || !hasTts() || !text) return false;
    const o = opts || {};
    try {
      if (o.interrupt !== false) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      const v = zhVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'zh-CN'; }
      u.rate = o.rate || 1.12;
      u.pitch = o.pitch || 1.02;
      u.volume = typeof o.volume === 'number' ? o.volume : 1;
      const token = ++speakToken;
      u.onend = function () { if (token === speakToken) { /* 空闲 */ } };
      speechSynthesis.speak(u);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 牌面读法：4万 → 四万；1筒 → 一筒；字牌 → 东风/红中/发财/白板 */
  function tileWord(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 0 || n >= 34) return '牌';
    if (n < 27) {
      const suit = Math.floor(n / 9);
      const rank = n % 9 + 1;
      return NUM[rank] + SUIT[suit];
    }
    const honors = ['东', '南', '西', '北', '中', '发', '白'];
    const h = honors[n - 27] || '';
    return HONOR_WORD[h] || h;
  }

  /** 打出一张牌：木头声 + 报牌名（这是用户点名要的「四万」） */
  function discardTile(id, opts) {
    if (!enabled) return;
    const o = opts || {};
    clack(o.strength || 1);
    if (o.voice === false) return;
    // 让牌名在音效之后 60ms 出来，听起来像先落桌再报牌
    setTimeout(() => say(tileWord(id)), 60);
  }

  /** 吃碰杠胡的喊声 */
  function claim(kind) {
    if (!enabled) return;
    if (kind === 'chi') { clack(0.8); say('吃'); return; }
    if (kind === 'peng') { clack(1.1); say('碰'); return; }
    if (kind === 'gang') { clack(1.3); tone(300, 0, 0.18, 0.04, 'triangle'); say('杠'); return; }
    if (kind === 'hu') { gong(); setTimeout(() => say('胡了'), 120); return; }
    clack(1);
  }

  function draw() {
    if (!enabled || !ctx) return;
    tone(720, 0, 0.05, 0.02, 'triangle');
    tone(1040, 0.03, 0.04, 0.012, 'sine');
  }

  function buzzer() {
    if (!enabled || !ctx) return;
    tone(220, 0, 0.16, 0.035, 'square');
    tone(180, 0.14, 0.18, 0.03, 'square');
  }

  return {
    unlock, setEnabled, setVoice, isEnabled, isVoiceOn, status,
    clack, gong, draw, buzzer, claim, discardTile,
    say, tileWord, hasTts
  };
});
