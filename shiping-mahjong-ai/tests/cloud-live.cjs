/* 云端连通性验证（需要外网）：npm run test:cloud
 *
 * 这个脚本真的打云端，所以不在 npm test 里跑。它回答四个问题：
 *   1. 发布域名上的 SDK 能不能初始化
 *   2. 数据面通不通（匿名读写分别是什么结果）
 *   3. RLS 有没有真的挡住未登录的写入
 *   4. 手机号 / WorkBuddy 两条登录通道是否开启（只取响应，不发短信、不跳转）
 *
 * 不做的事：不发送真实短信、不完成授权跳转、不伪造会话。
 * 「登录后能读回自己那一行」必须由真人收一条验证码来验证 —— 见 README 的验证清单。
 */
const assert = require('node:assert/strict');
const { startServer, launch, newPage } = require('./browser-lib.cjs');

const PROBE_PHONE = '13800000001';    // 一个不存在的号，只用来探通道是否开启；登录失败不会发短信

(async () => {
  const srv = await startServer();
  const browser = await launch();
  const page = await newPage(browser, srv.origin);
  const lines = [];

  const r = await page.evaluate(async (probePhone) => {
    const C = window.HongheCloud;
    const out = { steps: [] };
    const step = (name, ok, detail) => out.steps.push({ name, ok, detail });

    // 1) 初始化
    const ready = await C.init();
    step('SDK 初始化', ready.ok, ready.ok ? C.PUBLIC_CONFIG.endpoint : ready.error);
    if (!ready.ok) return out;

    const auth = C.auth();
    const db = C.database();

    // 2) 未登录会话
    const s = await auth.getSession();
    step('未登录时拿不到会话', !s.error && !s.data, s.error ? (s.error.code || s.error.message) : 'session=null');

    // 3) 匿名读：RLS 让它是空集，而不是报错
    const read = await db.from('mahjong_players').select('id').limit(5);
    step('匿名读被 RLS 限制为空', !read.error && (read.data || []).length === 0,
      read.error ? (read.error.code || read.error.message) : ('rows=' + (read.data || []).length));

    // 4) 匿名写：必须被挡（线上这张表就是靠这条守住别人的档案）
    const ins = await db.from('mahjong_players').insert({ owner_name: '__probe__' }).select('id');
    const blocked = !!ins.error || (ins.data || []).length === 0;
    step('匿名写被拒绝', blocked, ins.error ? (ins.error.code || ins.error.message) : 'no-error-but-empty');

    // 5) 手机号登录通道：密码错说明通道是开的（通道关了会直接报未开启）
    const pw = await auth.signInWithPassword({ phone: probePhone, password: 'probe-not-real-password' });
    const code = pw.error ? String(pw.error.code || pw.error.message) : '';
    step('手机号登录通道已开启', /invalid_username_or_password|invalid_grant|user_not_found/i.test(code), code || 'no-error');

    // 6) 手机验证码方法是否存在
    step('验证码方法可用', typeof auth.sendOtp === 'function' && typeof auth.verifyOtp === 'function',
      (typeof auth.sendOtp) + '/' + (typeof auth.verifyOtp));

    // 7) WorkBuddy 授权：只取 URL，不跳转
    const oauth = await auth.signInWithOAuth({ provider: 'workbuddy', redirectTo: location.origin + '/' });
    step('WorkBuddy 授权可发起',
      !oauth.error && !!(oauth.data && oauth.data.url),
      oauth.error ? (oauth.error.code || oauth.error.message) : new URL(oauth.data.url).host);

    // 8) 微信授权：同样只取 URL
    const wx = await auth.signInWithOAuth({ provider: 'wechat', redirectTo: location.origin + '/' });
    step('微信授权可发起（是否真能扫码取决于平台侧配置）',
      !wx.error && !!(wx.data && wx.data.url),
      wx.error ? (wx.error.code || wx.error.message) : 'url=ok');

    out.endpoint = C.PUBLIC_CONFIG.endpoint;
    return out;
  }, PROBE_PHONE);

  lines.push('云端地址：' + (r.endpoint || '(未初始化)'));
  r.steps.forEach((s) => lines.push((s.ok ? '  ✓ ' : '  ✗ ') + s.name + ' —— ' + s.detail));
  console.log(lines.join('\n'));

  await browser.close();
  await srv.close();

  const failed = r.steps.filter((s) => !s.ok);
  if (failed.length) {
    console.error('\n有 ' + failed.length + ' 项没过：' + failed.map((s) => s.name).join('、'));
    process.exit(1);
  }
  console.log('\n全部通过。注意：这一轮没有做真实登录，登录后的读写请按 README 用真机走一遍。');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
