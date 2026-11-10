/* 浏览器测试公共设施：本地静态服务器 + Chromium 启动（复用本机安装的 Chrome/Edge） */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('未找到本机 Chrome / Edge');
}

async function launch() {
  return chromium.launch({
    headless: true,
    executablePath: chromePath(),
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
}

/**
 * 本地测试跑在 127.0.0.1，而云端数据面只接受应用的发布域名（Origin 精确匹配），
 * 所以本地跑时 /\.cloud\/ 请求注定被拒。这属于环境边界，不是脚本错误：
 * 单独收进 __cloudNoise，正文断言只看真正的脚本/资源错误。
 * 真实的云端连通性由 tests/cloud-live.cjs 在发布域名上验证。
 *
 * 同理，云 SDK 本身是从公共 CDN（jsdelivr）拉的；CDN 抽风时页面会回落到纯本地模式，
 * 游戏照常能玩。这类 `ERR_CONNECTION_*` 也是环境问题，不该让无关的用例变红。
 */
const CLOUD_NOISE = /workbuddy\.host\/\.cloud\/|\.cloud\/(auth|database|storage|llm)\/|@tencent-ai\/workbuddy-cloud-sdk|cdn\.jsdelivr\.net|Failed to load resource: net::ERR_CONNECTION/;

function pushError(errors, text, noise) {
  if (CLOUD_NOISE.test(text)) { noise.push(text); return; }
  errors.push(text);
}

async function newPage(browser, origin, viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  const noise = [];
  page.on('pageerror', (e) => pushError(errors, 'pageerror: ' + e.message, noise));
  page.on('console', (m) => { if (m.type() === 'error') pushError(errors, 'console: ' + m.text(), noise); });
  page.on('requestfailed', (r) => {
    const t = r.failure() && r.failure().errorText;
    if (t !== 'net::ERR_ABORTED') pushError(errors, 'request: ' + r.url() + ' ' + t, noise);
  });
  await page.goto(origin + '/?debug=1', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__shipingMahjongDebug === 'function');
  page.__errors = errors;
  page.__cloudNoise = noise;
  return page;
}

/** 清空本地进度 → 建一个游客账号 → 跳过赛季动画 → 直接进桌。
 *  外壳（启动页/登录/赛季/主界面/场次）在这些几何与规则用例里只是前置步骤，
 *  用调试接口走最短路径，避免每个用例都重复点一遍界面。 */
async function enterTable(page, opts) {
  const o = opts || {};
  await page.evaluate(() => { window.__shipingMahjongResetProgress(); });
  const name = o.account || ('t' + Date.now().toString(36) + Math.floor(Math.random() * 1000));
  const info = await page.evaluate(async (p) => {
    const res = await window.__shipingMahjongRegister(p.name, 'abcd', p.nick || p.name, true);
    window.__shipingMahjongSkipSeason();
    const table = window.__shipingMahjongStartTable(p.hall || 'novice');
    return {
      registered: !!(res && res.ok),
      screen: table && table.screen,
      hall: table && table.hall,
      baseBet: table && table.baseBet
    };
  }, { name, nick: o.nick, hall: o.hall });
  if (!info.registered || info.screen !== 'table') {
    throw new Error('进入牌桌失败：' + JSON.stringify(info));
  }
  return info;
}

/** 等待轮到真人出牌；遇到接牌提示自动「过」，遇到结算返回 'over' */
async function waitHumanTurn(page, timeout = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const s = await page.evaluate(() => window.__shipingMahjongDebug());
    if (!s) { await page.waitForTimeout(50); continue; }
    if (s.phase === 'over') return 'over';
    if (s.awaiting && s.awaiting.seat === 0) {
      const clicked = await page.evaluate(() => {
        const b = document.querySelector('#action-bar .action-pass');
        if (b) { b.click(); return 'pass'; }
        return null;
      });
      if (clicked) { await page.waitForTimeout(60); continue; }
      if (s.awaiting.kind === 'discard') return 'discard';
    }
    await page.waitForTimeout(60);
  }
  throw new Error('等待玩家操作超时：' + JSON.stringify(await page.evaluate(() => window.__shipingMahjongDebug())));
}

module.exports = { startServer, launch, newPage, enterTable, waitHumanTurn, ROOT };
