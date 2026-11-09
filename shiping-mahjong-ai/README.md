# 石屏麻将（浏览器单机版）

原生 HTML/CSS/JavaScript 网页麻将，无框架、无构建步骤。

> **本目录是 `ai-mahjong-next` 分支的开发副本**，由 `shiping-mahjong/` 原样复制后继续开发。
> 原目录 `shiping-mahjong/` 与线上 `gh-pages` 均未被改动。
>
> 本版改动概要：
> 1. 回合状态机重构（修「电脑玩家不出牌导致卡死」）；
> 2. 出牌飞行动画、吃碰杠副露高亮、3D 六面骰子落桌、桌内胡牌结算；
> 3. **按界面截图重做外壳**：启动页 → 登录/注册 → S25 赛季 → 赛季继承 → 主界面 → 场次选择 → 对局 → 结算；
> 4. **经济体系**：银币 / 金条 / 段位分 / 战绩 / 每日签到 / 回归好礼 / 赛季继承；
> 5. **登录单独抽成一层**（`js/auth.js`）并接上**真实云服务**（`js/cloud.js`）：手机验证码 / WorkBuddy 授权 / 微信授权，档案与战绩存云端数据库；游客模式作为显式备选保留；
> 6. 牌桌布局 v4 与手机竖屏适配。
>
> 详细说明见 [`docs/DEVELOPMENT-REPORT.md`](docs/DEVELOPMENT-REPORT.md)，截图见 `docs/screenshots/`。

## 运行

直接双击 `index.html` 也能玩到牌桌，但**调试接口与自动化测试需要 http 环境**：

```bash
python3 -m http.server 8080     # 或 npm run serve
# 打开 http://127.0.0.1:8080/          正常游玩
# 打开 http://127.0.0.1:8080/?debug=1  额外挂载调试接口
```

**在线试玩（独立部署，不影响 gh-pages）**：<https://shiping-mahjong-ai.app.workbuddy.host/?sharecode=2MS3R37OYC>

## 玩法流程

| 界面 | 说明 |
| --- | --- |
| 启动页 | 微信登录 / 账号登录（手机验证码），底部说明写清进度存哪 |
| 登录弹窗 | 手机号 → 获取验证码 → 登录/注册；首次登录自动建号；另有「使用 WorkBuddy 登录」与底部游客入口 |
| 账号浮层 | 主界面左上角点头像打开：看账号身份（云端/游客）、同步状态、改昵称、切换账号、退出登录、清空本机存档 |
| 恭喜获得 | 新号注册送 4,000 银币（初始 5,000，合计 9,000） |
| S25 赛季 | 赛季开启动画，点击继续 |
| 赛季继承 | 上赛季称号「长工 112 分」→ 本赛季「未激活 0 分」 |
| 主界面 | 天梯榜 / 12 个功能格 / 个旧麻将 · 双扣卡片 / 其他游戏下载 / 底部 9 项导航 |
| 场次选择 | 初级场 2,000 底分、中级场 8,000、高级场 28,000；银币不够时卡片置灰并提示门槛 |
| 对局 | 四家座位、牌墙环、四片牌河、中央计时卡、手牌 14 张单行、碰/杠/吃/胡/过圆钮 |
| 结算 | 桌内半透明层：赢家卡 + 三家明细 + 胡牌手牌 + 段位进度 + 换桌/分享/继续 |
| 每日签到 | 7 天，每天 +1,000 银币，连续 3 天额外 +30 金条 |
| 回归好礼 | 7 天，每天 +1,000 银币 |

## 经济与段位（`js/account.js`）

- **结算**：`单位 = 底分 × 倍率`（赢家坐庄或庄家点炮时倍率 2）。点炮者付 2 个单位，其余两家各付 1 个；自摸三家各付 2 个。任何一家最多扣到 0（余额不足标记「破产」），赢家只收实际扣到的总和，四家总和恒为 0。
- **段位分**：赢家 `+7 × 倍率`，点炮者 `-3 × 倍率`，其余 `-2 × 倍率`；流局不加不减。
- **段位阶梯**：新秀一阶 0 / 新秀二阶 420 / 新秀三阶 620 / 下士 860 / 中士 1140 / 上士 1460 / 少尉 1820 / 中尉 2220 / 上尉 2660 / 少校 3140 / 中校 3660 / 上校 4220 / 中将 4820。
- 这一层是纯逻辑，不碰 DOM，浏览器与 Node 共用同一份实现，因此账本数字与测试断言完全同源。

## 登录与云端（`js/auth.js` + `js/cloud.js`）

登录分两种模式，**由用户显式选择，任何失败都不会自动降级**：

| 模式 | 身份从哪来 | 进度存在哪 | 入口 |
| --- | --- | --- | --- |
| 云端账号 | 云服务签发（手机验证码 / WorkBuddy 授权 / 微信授权） | 云端数据库，换设备能找回 | 登录弹窗主路径 |
| 游客练习 | 本机生成的设备账号 | 本机 localStorage，界面明确写「只存本机」 | 登录弹窗底部文字链接 |

云端路径：

```js
await Auth.sendCode({ phone })              // 发码，按钮进入 60 秒冷却
await Auth.verifyCode({ phone, token })     // 校验；码错保留挑战，重输不再发码
await Auth.startOAuth('workbuddy')          // 同标签页跳授权（微信传 'wechat'）
await Auth.handleCallback()                 // 启动时先处理 code/state/provider，再谈其他
await Auth.current()                        // 恢复会话，没有则 null
```

- **发码与校验严格分开**：`sendCode` 只发一次，`verifyCode` 绝不重新发；换了手机号旧挑战立刻作废。
- **手机号不在前端拼 +86**，原样交给 SDK，避免和后端归一化打架。
- **云端账号的进度不写 localStorage**（云端模式下用惰性 store 隔离），既不会污染游客存档，也不会造成「看起来存上了」的错觉。
- **保存失败会说话**：`persist()` 返回失败时顶部弹一次提示、账号浮层显示「离线 · 进度待同步」，并按 4s/8s/…/30s 退避重试（最多 10 次），不会静默丢掉一局的结果。
- 账号规则只剩一处：`account.js` 的 `checkAccount` / `checkPassword`（游客模式在用）。

## 云服务（WorkBuddy Cloud Service）

| 项 | 值 |
| --- | --- |
| 应用 | 石屏麻将 · AI 版牌桌（`wbapp_haQz1J98YfXjAnL6AYkA0b`） |
| 环境 | `billingStatus: normal` / `provisionStatus: assigned` |
| SDK | `@tencent-ai/workbuddy-cloud-sdk@dev`，CDN 全局 `WorkBuddyCloud`（本项目无构建步骤，走 CDN 形态） |
| 模块 | Auth（手机验证码 / WorkBuddy / 微信授权）、Database（PostgREST） |

两张表，全部开启 RLS，并且只授权给 `authenticated`（`anon` 连 GRANT 都没有）：

| 表 | 用途 | 关键列 |
| --- | --- | --- |
| `mahjong_players` | 一人一行的档案 | `owner_id text default auth.uid()`（唯一）、`owner_name`、`coins`、`gold`、`rank_points`、`season_seen`、`signin jsonb`、`back_gift jsonb`、`stats jsonb`、`welcome_granted` |
| `mahjong_rounds` | 每局流水（战绩） | `owner_id`、`hall_id`、`base_bet`、`win_type`、`delta`、`rank_delta`、`balance_after`、`created_at` |

策略：`players` 读/写/改都要求 `owner_id = auth.uid()`（UPDATE 同时带 USING 与 WITH CHECK，防止把行改给别人）；`rounds` 只允许读自己的和插入自己的。

**前端永远不发送 `owner_id`**：归属由 `DEFAULT auth.uid()` 决定，RLS 的 `WITH CHECK` 会把伪造的归属顶回去。代码里 `Cloud.toRow()` 有一处显式断言（`tests/cloud.test.cjs`）。

### 验证清单

```bash
npm run test:cloud     # 真的打云端，8 项连通性检查
```

覆盖：SDK 初始化 / 未登录无会话 / 匿名读被限制为空 / **匿名写被拒绝（`DATABASE_42501`）** / 手机号通道已开启 / 验证码方法存在 / WorkBuddy 与微信授权可发起。

登录后的读写需要一条真实验证码，自动化无法代劳，请按下面四步自己走一遍（约 1 分钟）：

1. 打开线上地址 → 账号登录 → 输入手机号 → 获取验证码 → 填入 → 进入赛季页；
2. 打一局到结算，回主界面看银币有没有变；
3. 刷新页面，确认仍是同一账号、银币和段位没丢（会话持久化）；
4. 控制台执行 `__shipingMahjongCloud()`，应看到 `session.uid` 有值、`account.source === 'cloud'`、`sync.state === 'ok'`。

## 测试

```bash
npm test              # 规则 + 变体 + 经济 + 认证 + 云端接入 + 人机模拟（108 条，纯 Node）
npm run test:browser  # 真实 Chromium：对局 / 登录 / 外壳（36 条，需要本机 Chrome/Edge 与 npm i）
npm run test:all      # 两者都跑，共 144 条
npm run test:cloud    # 打真实云端做 8 项连通性检查（需要外网，不在 test:all 里）
node tests/screenshots.cjs   # 重新生成 docs/screenshots/shell-*.jpg
```

覆盖范围：

- **规则**：136 张守恒、吃只能吃下家、碰任意家、明/暗/补杠、杠后补牌、4 面子 + 1 将、自摸/点炮、烂牌胡 147/258/369、计分表。
- **经济**：倍率、破产截断、段位分、段位阶梯、注册登录、密码哈希、每日签到、连续奖励、回归好礼、赛季继承。核心用例的期望值直接取自界面截图里的数字。
- **云端接入**：行 ↔ 账号映射、缺字段兜底、`toRow` 不含 `owner_id`、RLS 空数组视为失败、错误翻译、发码只发一次、码错重试不重发、换号作废旧挑战、云端不可用时禁用验证码但保留游客入口。
- **登录界面**：手机号本地校验（空 / 少一位 / 非数字都不发请求）、没发码就提交被拦下、游客一次进入且见面礼不重复、退出清空、账号浮层标明身份、改昵称生效、手机端按钮可点中。
- **对局**：出牌飞行动画、副露顺子与被吃牌高亮、骰子六面与落点、桌内结算不溢出、AI 任务丢失 6 秒自愈、浏览器内连续 20 局无卡死且积分零和。
- **几何**：桌面 1440×900 与手机 390×844 下，四家弃牌区互不重叠、中央信息台不压牌河、手牌完整在视口内、hover 不位移且能点中。

## 调试接口（`?debug=1`）

| 接口 | 用途 |
| --- | --- |
| `__shipingMahjongDebug()` | 局面快照：阶段、手牌、副露、牌河、银币、段位、等待行动者 |
| `__shipingMahjongShell()` | 外壳快照：当前界面、账号、场次、结算、打开的弹层 |
| `__shipingMahjongRegister / Login / Logout` | 走游客通道直接建号 / 登录 / 登出（自动化用，不碰短信） |
| `__shipingMahjongAuth()` | 认证状态：模式（cloud/guest）、记住的账号、历史、当前 provider、云端可用性 |
| `__shipingMahjongCloud()` | **云端体检**：SDK 状态、会话 uid、一次真实数据面读取结果、同步状态 |
| `__shipingMahjongLoginForm()` | 登录弹窗状态：手机号、验证码、提示、倒计时、各按钮是否禁用 |
| `__shipingMahjongSendCode(phone)` / `__shipingMahjongVerifyCode(code)` | 用代码触发发码 / 校验（会真的调云端） |
| `__shipingMahjongAccountMenu(force)` | 打开 / 关闭主界面账号浮层，返回是否可见 |
| `__shipingMahjongEnterHome / SkipSeason / OpenHall / StartTable` | 跳转到指定界面 |
| `__shipingMahjongOpenSignin / OpenBack` | 打开签到 / 回归好礼 |
| `__shipingMahjongResetProgress()` | 清空本机账号与赛季标记，回到启动页 |
| `__shipingMahjongForceChi / ForceMelds / ForceWin` | 构造吃牌 / 四家副露 / 胡牌结算现场（视觉回归用） |
| `__shipingMahjongDropAiTask()` | 人为丢弃 AI 定时任务，验证心跳自愈 |
| `__shipingMahjongAutoPlay(n)` | 无人值守连打 n 局，返回每局结果 |

## 规则

- 136 张：万、筒、条、东南西北中发白；每张 4 张，无花牌、无混儿。
- 庄家 14 张，其他玩家 13 张；三名电脑玩家。
- 吃上家、碰任意家；明杠、暗杠、补杠；杠后补牌。
- 标准胡：4 副顺子/刻子 + 一对将；支持自摸、点炮。
- 烂牌胡：14 张不重复；字牌不限；每门数牌只允许落在 147、258、369 的一组点数。
- 基础计分：杠 +3/-1/-1/-1；自摸 +9/-3/-3/-3；点炮 +4/-2/-1/-1（可在规则设置里调）。
- 吃、碰、杠、烂牌胡可以分别开关，保存至浏览器 localStorage。

## 文件

- `index.html`：7 个界面（启动/赛季/继承/主界面/场次/牌桌）+ 5 个弹层
- `styles.css`：外壳、牌桌、结算、弹窗样式与响应式（含第 10 节「牌桌布局 v4」、第 11 节「窄屏」）
- `js/core.js`：牌库、玩法变体注册表、胡牌判定、操作与计分
- `js/account.js`：经济与规则（银币 / 段位 / 签到 / 赛季继承，纯逻辑，Node 与浏览器共用）
- `js/auth.js`：认证层（async provider 抽象：云端 / 游客两套实现），界面只调这一层
- `js/cloud.js`：云服务接入层（SDK 初始化、行 ↔ 账号映射、档案读写、错误翻译）
- `js/ui.js`：界面渲染、回合驱动、动画与调试接口

## 已知限制

- **云端账号已接通**，但「登录后读写」这条链路需要一条真实验证码才能验证，自动化只覆盖到「发请求前」和「未登录被拒」；请按上面的四步清单自己走一遍。
- 微信授权能发起（平台开关是开的），但是否真能扫码取决于平台侧微信凭证与回调域名，本项目只做到发起与回跳处理。
- 进度由客户端写入（RLS 保证只能写自己那一行）。这是单机向的游戏，没有对抗性，所以没做服务端校验；将来要做联机对局时，结算必须挪到服务端。
- 「个旧麻将」「宝秀麻将」只是入口占位，规则未确认前不实现，避免凭猜写错规则。
- 天梯榜、比赛场、约牌等需要服务端数据的功能一律给出提示，不伪造数据。

## 牌面素材与许可

牌面 SVG 在 `assets/mahjong/`，PNG 在 `assets/tiles/`（共 35 张）。素材来自 [tiansh/tjmj](https://github.com/tiansh/tjmj)，其原页面注明牌面由 Jerry Crimson Mann 绘制、来源 Wikipedia。各图片的具体许可及再分发条件以对应原始文件页为准，见 `THIRD-PARTY-NOTICES.md`。

## 开源

代码按 GPL-3.0-or-later 发布。
