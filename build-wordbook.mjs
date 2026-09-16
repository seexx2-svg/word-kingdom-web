#!/usr/bin/env node
/**
 * 单词小王国 WordBook Builder
 *
 * 一键构建流程：
 *   1) 下载 deanliao/vocab_tutor 的 2074 条词表 + 中文释义/音标/例句
 *   2) 清洗、标准化、去重，并尽可能保持既有 ID 稳定
 *   3) 从 Etymonline 中文站下载每个词条词源，断点续跑、自动重试、本地缓存
 *   4) 将词源清洗为适合学习卡片的简洁中文
 *   5) 生成唯一、压缩后的 wordbook.js
 *
 * 用法（建议 Node.js 20+）：
 *   node build-wordbook.mjs
 *   node build-wordbook.mjs --workers 2 --delay 800
 *   node build-wordbook.mjs --refresh-ety
 *
 * 说明：Etymonline 是外部网站。请合理控制请求速率，并遵守其网站条款。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, '.wordbook-cache');
const ETY_CACHE_DIR = path.join(CACHE_DIR, 'etymonline');
const SOURCE_WORDS = [
  'https://cdn.jsdelivr.net/gh/deanliao/vocab_tutor@main/data/words2000.json',
  'https://fastly.jsdelivr.net/gh/deanliao/vocab_tutor@main/data/words2000.json',
  'https://github.com/deanliao/vocab_tutor/raw/refs/heads/main/data/words2000.json',
  'https://raw.githubusercontent.com/deanliao/vocab_tutor/main/data/words2000.json'
];
const SOURCE_MEANINGS = [
  'https://cdn.jsdelivr.net/gh/deanliao/vocab_tutor@main/data/meanings.json',
  'https://fastly.jsdelivr.net/gh/deanliao/vocab_tutor@main/data/meanings.json',
  'https://github.com/deanliao/vocab_tutor/raw/refs/heads/main/data/meanings.json',
  'https://raw.githubusercontent.com/deanliao/vocab_tutor/main/data/meanings.json'
];
const ETY_BASE = 'https://www.etymonline.com/cn/word/';
const OUT_FILE = path.join(ROOT, 'wordbook.js');
const REPORT_FILE = path.join(CACHE_DIR, 'build-report.json');
const OLD_WORD_BOOK = path.join(ROOT, 'wordbook.js');
const SIMPLIFIED_MAP_FILE = path.join(ROOT, 'simplified-map.json');

const args = new Set(process.argv.slice(2));
const argValue = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const WORKERS = Math.max(1, Math.min(6, Number(argValue('--workers', '2')) || 2));
const DELAY_MS = Math.max(0, Number(argValue('--delay', '800')) || 0);
const RETRIES = Math.max(1, Math.min(6, Number(argValue('--retries', '3')) || 3));
const REFRESH_ETY = args.has('--refresh-ety');
const TIMEOUT_MS = 20000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanText = s => String(s ?? '')
  .replace(/\u00a0/g, ' ')
  .replace(/\u202f/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/ *\n+ */g, '\n')
  .replace(/\s+([，。；：！？])/g, '$1')
  .trim();

let SIMPLIFIED_MAP = {};
try { SIMPLIFIED_MAP = JSON.parse(await fs.readFile(SIMPLIFIED_MAP_FILE, 'utf8')); } catch {}
function toSimplified(text) {
  const s = String(text ?? '');
  if (!s || !Object.keys(SIMPLIFIED_MAP).length) return s;
  return Array.from(s).map(ch => SIMPLIFIED_MAP[ch] || ch).join('');
}

const normalizeWord = raw => cleanText(raw)
  .normalize('NFKC')
  .replace(/\s*\([^)]*\)/g, '')
  .replace(/[‐‑–—]/g, '-')
  .trim();

const lookupWord = word => String(word || '')
  .toLowerCase()
  .replace(/[’']/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const keyForCache = word => encodeURIComponent(lookupWord(word));

function stableHash(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function idForWord(word) {
  // 大于 1e9，避免与旧版顺序 ID 冲突；同一单词跨版本保持稳定。
  return 1000000000 + stableHash(lookupWord(word));
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '\"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtmlPreserveParagraphs(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '\n')
    .replace(/<br\s*\/?>(?=\s*)/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<(?:p|div|section|article|li|h[1-6]|blockquote)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanEtymologyText(text) {
  let t = toSimplified(String(text || ''))
    .replace(/^[\s:：\-]+/, '')
    .replace(/\[\s*来源\s*[:：][\s\S]*?\]\s*$/i, '')
    .replace(/\s*来源\s*[:：]\s*Etymonline(?:\s+中文站)?[\s\S]*$/i, '')
    .replace(/\s*Etymonline\s+中文站\s*$/i, '')
    .trim();

  // 清除少量残余的页面导航/登录提示，但不碰词源正文。
  t = t
    .replace(/(?:^|\n)\s*(?:搜索|登录|专栏|论坛|应用|会员|广告|移除广告)\s*(?=\n|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}

function extractEtymology(html, word) {
  const raw = String(html || '');
  const w = String(word || '').trim();
  if (!w) return '';
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Etymonline 中文页结构：
  //   ## word 的词源
  //   ### word(part of speech)
  //   正文……
  //   ## 相关词汇
  //   …
  // 这里只提取“word 的词源”章节，绝不把“相关词汇”中的其它单词词源带进去。
  const text = stripHtmlPreserveParagraphs(raw)
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const headingRe = new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?${esc.replace(/ /g, '\\s+')}\\s*的词源\\s*(?:\\n|$)`, 'i');
  const hm = headingRe.exec(text);
  if (!hm) return '';

  let section = text.slice(hm.index + hm[0].length);

  // 章节结束边界：优先使用 Etymonline 页面后续主栏目标题。
  const endMarkers = [
    /^\s*(?:#+\s*)?相关词汇\s*$/im,
    /^\s*(?:#+\s*)?分享[ \t]*['“”]?[\s\S]*$/im,
    /^\s*(?:#+\s*)?页面URL[：:]?.*$/im,
    /^\s*中文翻译由AI生成[。.]?.*$/im,
    /^\s*(?:#+\s*)?热搜词汇\s*$/im,
    /^\s*(?:#+\s*)?在 .* 附近的词典条目\s*$/im
  ];
  let cut = section.length;
  for (const re of endMarkers) {
    const m = re.exec(section);
    if (m && m.index < cut) cut = m.index;
  }
  section = section.slice(0, cut).trim();

  // 删除章节标题分隔线、网页噪声，但保留“about(adv., prep.)”及完整正文。
  section = section
    .replace(/^[ \t]*(?:[*—–-][ \t]*){2,}$/gm, '')
    .replace(/^(?:搜索|登录|专栏|论坛|应用|会员|广告|移除广告)\s*$/gm, '')
    .replace(/来源\s*[:：]\s*Etymonline(?:\s+中文站)?[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleanEtymologyText(section);
}

async function fetchText(url, retries = RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'WordGame-WordbookBuilder/1.0',
          'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow'
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await sleep(Math.min(5000, 700 * attempt));
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function loadJsonSource(urls, cacheFile) {
  const list = Array.isArray(urls) ? urls : [urls];
  const errors = [];
  for (const url of list) {
    try {
      console.log(`   -> ${url}`);
      const txt = await fetchText(url);
      const parsed = JSON.parse(txt);
      await fs.writeFile(cacheFile, txt, 'utf8');
      return parsed;
    } catch (e) {
      errors.push(`${url} :: ${e?.message || e}`);
    }
  }
  try {
    console.log(`   -> use local cache: ${cacheFile}`);
    return JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch {
    const detail = errors.join('\n');
    throw new Error(`无法获取数据源。已尝试多个镜像，且本地没有可用缓存。\n${detail}`);
  }
}

async function readOldBook() {
  try {
    const s = await fs.readFile(OLD_WORD_BOOK, 'utf8');
    const m = s.match(/window\.WORD_BOOK\s*=\s*(\[[\s\S]*?\]);?\s*$/);
    if (!m) return [];
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

function parseWordsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload.content === 'string') return JSON.parse(payload.content);
  throw new Error('words2000.json 格式无法识别');
}

function normalizeMeaningMap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.content && typeof payload.content === 'string') {
    return JSON.parse(payload.content);
  }
  return payload || {};
}

function pickMeaning(map, word) {
  const candidates = [word, word.toLowerCase(), word.replace(/-/g, ' '), word.toLowerCase().replace(/-/g, ' ')];
  for (const k of candidates) if (map[k]) return map[k];
  return {};
}

async function ensureDirs() {
  await fs.mkdir(ETY_CACHE_DIR, { recursive: true });
}

async function readEtyCache(word) {
  const f = path.join(ETY_CACHE_DIR, `${keyForCache(word)}.json`);
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return null; }
}

async function writeEtyCache(word, rec) {
  const f = path.join(ETY_CACHE_DIR, `${keyForCache(word)}.json`);
  await fs.writeFile(f, JSON.stringify(rec), 'utf8');
}

async function getEty(word, index, total) {
  const cached = REFRESH_ETY ? null : await readEtyCache(word);
  if (cached) return { ...cached, cached: true };

  const url = `${ETY_BASE}${encodeURIComponent(lookupWord(word))}`;
  try {
    const html = await fetchText(url);
    const etymology = extractEtymology(html, word);
    const rec = { word, url, etymology, ok: true, fetchedAt: new Date().toISOString() };
    await writeEtyCache(word, rec);
    return rec;
  } catch (e) {
    const rec = { word, url, etymology: '', ok: false, error: String(e.message || e), fetchedAt: new Date().toISOString() };
    await writeEtyCache(word, rec);
    return rec;
  }
}

async function mapWorkers(items, workerCount, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker(workerId) {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i, workerId);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  return out;
}

await ensureDirs();
console.log('① 正在读取 2074 词表……');
console.log('   将依次尝试 jsDelivr / Fastly / GitHub / raw GitHub 镜像；任何一个可用即可。');
const wordsRaw = await loadJsonSource(
  SOURCE_WORDS,
  path.join(CACHE_DIR, 'words2000.json')
);
const meaningsRaw = await loadJsonSource(
  SOURCE_MEANINGS,
  path.join(CACHE_DIR, 'meanings.json')
);
const wordRows = parseWordsPayload(wordsRaw);
const meanings = normalizeMeaningMap(meaningsRaw);

const oldBook = await readOldBook();
const oldByWord = new Map(oldBook.map(w => [lookupWord(w.word), w]));

const seen = new Set();
const rows = [];
for (const item of wordRows) {
  const word = normalizeWord(item?.w);
  if (!word) continue;
  const key = lookupWord(word);
  if (seen.has(key)) continue;
  seen.add(key);
  const m = pickMeaning(meanings, word);
  const old = oldByWord.get(key) || {};
  const lv = Number(item?.lv) || 3;
  const meaning = toSimplified(cleanText(String(m?.zh || old.meaning || '').replace(/^[a-zA-Z.\/]+\s*/, '')));
  const phonetic = cleanText(m?.ph || old.phonetic || '');
  const example = cleanText(m?.sent || old.example || '');
  const playable = /^[A-Za-z]+$/.test(word) && !!meaning;
  rows.push({
    id: Number(old.id) || idForWord(word),
    word,
    meaning,
    phonetic,
    partOfSpeech: cleanText(old.partOfSpeech || ''),
    category: cleanText(old.category || '国中2000'),
    difficulty: Math.min(4, Math.max(1, lv)),
    stage: lv <= 2 ? '小学' : lv <= 4 ? '初中' : '进阶',
    playable,
    etymology: cleanEtymologyText(old.etymology || ''),
    etymologyUrl: `${ETY_BASE}${encodeURIComponent(key)}`,
    example
  });
}

// 优先保留明确有词典释义的词条，短语仍保留在词库，但不可进入字母类游戏。
console.log(`② 清洗后唯一词条：${rows.length}`);

const needEty = rows.filter(r => !r.etymology || REFRESH_ETY);
console.log(`③ 开始获取 Etymonline 中文词源：${needEty.length} 条（并发 ${WORKERS}，间隔 ${DELAY_MS}ms）`);
let done = 0;
const etyResults = await mapWorkers(needEty, WORKERS, async row => {
  const rec = await getEty(row.word, done + 1, needEty.length);
  if (DELAY_MS) await sleep(DELAY_MS);
  done++;
  if (done % 25 === 0 || done === needEty.length) {
    console.log(`   已处理 ${done}/${needEty.length}`);
  }
  return rec;
});
const etyByWord = new Map(etyResults.map(r => [lookupWord(r.word), r]));
for (const row of rows) {
  const rec = etyByWord.get(lookupWord(row.word));
  if (rec) row.etymology = cleanEtymologyText(rec.etymology || '');
  if (!row.etymology) delete row.etymology;
  delete row.etymologyUrl;
}

// 数据去冗余：统一字段顺序；只输出运行时真正需要的数据。
const finalRows = rows.map(r => {
  const x = {
    id: r.id,
    word: r.word,
    meaning: r.meaning,
    phonetic: r.phonetic,
    partOfSpeech: r.partOfSpeech,
    category: r.category,
    difficulty: r.difficulty,
    stage: r.stage,
    playable: r.playable
  };
  if (r.etymology) x.etymology = r.etymology;
  if (r.example) x.example = r.example;
  return x;
});

const etySuccess = finalRows.filter(r => r.etymology).length;
const etyFailed = finalRows.length - etySuccess;
const js = `/* 单词小王国 WordBook · 自动构建 · ${new Date().toISOString()} */\nwindow.WORD_BOOK_VERSION=${JSON.stringify('1.0-2074-local')} ;\nwindow.WORD_BOOK=${JSON.stringify(finalRows)};\n`;
await fs.writeFile(OUT_FILE, js, 'utf8');

const report = {
  generatedAt: new Date().toISOString(),
  sourceWordCount: wordRows.length,
  finalUniqueCount: finalRows.length,
  playableCount: finalRows.filter(r => r.playable).length,
  etymologyCount: etySuccess,
  etymologyMissingCount: etyFailed,
  workers: WORKERS,
  delayMs: DELAY_MS,
  refreshEtymology: REFRESH_ETY,
  output: 'wordbook.js'
};
await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');

console.log('④ 已生成唯一压缩词库：wordbook.js');
console.log(`   词条：${finalRows.length}；可玩：${report.playableCount}；有中文词源：${etySuccess}；无词源/失败：${etyFailed}`);
console.log(`   构建报告：${path.relative(ROOT, REPORT_FILE)}`);
if (finalRows.length !== 2074) {
  console.warn(`⚠ 注意：源文件实际读取到 ${finalRows.length} 个唯一词条，不是 2074。请检查清洗规则或上游词表。`);
}
if (etyFailed > 0) {
  console.warn(`⚠ 有 ${etyFailed} 个词条没有词源；失败详情保存在 ${path.relative(ROOT, ETY_CACHE_DIR)}/。再次运行会自动重试。`);
}
