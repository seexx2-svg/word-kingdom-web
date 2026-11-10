# 红河麻将（原「石屏麻将」）· ai-mahjong-next 开发报告

> 分支：`ai-mahjong-next`　目录：`shiping-mahjong-ai/`
> 基线：`shiping-mahjong` 分支（提交 `845dd27`）的完整源码
> 版本：`0.9.0`（`package.json`）
>
> 品牌说明：v0.9.0 起平台统一叫「**红河麻将**」（石屏 / 宝秀 / 个旧都在红河州），
> 「石屏麻将」降级为其中一种玩法名。下面早于 v0.9.0 的章节仍按当时的叫法记录，未回改。

---

## 一、继承关系与隔离

| 项目 | 路径 / 分支 | 状态 |
| --- | --- | --- |
| 原始开发分支 | `shiping-mahjong` / `shiping-mahjong/` | **完全未改动** |
| 原线上分支 | `gh-pages` | **完全未改动** |
| 新开发分支 | `ai-mahjong-next` | 本次全部改动只在这里 |
| 新项目目录 | `ai-mahjong-next : shiping-mahjong-ai/` | 由 `shiping-mahjong/` **逐文件原样复制**而来 |

复制基线的可验证证据（建立目录时的检查）：

- 文件清单完全一致：`diff` 两份 `git ls-tree -r --name-only` 输出，无差异。
- 目录树哈希完全一致：`git rev-parse origin/shiping-mahjong:shiping-mahjong` 与
  `git rev-parse HEAD:shiping-mahjong-ai` 指向同一 tree。
- 唯一例外需要说明：仓库根 `.gitignore` 中写有 `package.json`，第一次 `git add` 时被忽略，
  因此 `package.json` 是用 `git add -f` 单独补提交的；补提交后文件清单与树哈希再次校验一致。

原始 `shiping-mahjong/` 目录内的任何文件都没有被修改，`gh-pages` 也没有被触碰，线上试玩版本不受影响。

## 二、修改过的文件

| 文件 | 改动性质 | 说明 |
| --- | --- | --- |
| `js/core.js` | 重写 | 规则内核 + 显式回合状态机：唯一推进入口 `settle()`、唯一行动权判定 `awaiting()`、接牌队列 `pendingClaims/claimCursor`、事件流 `events`、AI 决策与执行分离 |
| `js/ui.js` | 重写 | 唯一的驱动入口 `pump()`；带代际号 `epoch` 的一次性 AI 任务；心跳自愈；出牌飞行动画；骰子三维滚动；桌内结算；调试日志与调试 API |
| `index.html` | 修改 | 中央信息台合并（读秒 / 最近弃牌 / 局数轮次 / 庄家开牌）；牌墙改为环绕牌区；自家副露移入手牌面板；日志面板；favicon（消除 404） |
| `styles.css` | 追加/重排 | 新增「牌桌布局 v3」系列样式：四家弃牌区、副露、中央信息台、牌墙环、骰子与结算层、移动端断点 |
| `package.json` | 修改 | 增加 `test` / `test:browser` / `test:all` / `serve` 脚本，`playwright-core` 作为开发依赖 |
| `tests/engine.test.cjs` | 重写 | 24 条规则与状态机测试 |
| `tests/helpers.cjs` | 新增 | 可复现局面构造器（牌墙 = 整副牌 − 已出现的牌） |
| `tests/simulation.test.cjs` | 新增 | 随机种子人机模拟、规则开关组合、吃碰杠后续推进、杠后补牌 |
| `tests/browser-lib.cjs` | 新增 | 本地静态服务器 + 复用本机 Chrome/Edge 的 Playwright 启动器 |
| `tests/browser.test.cjs` | 新增 | 12 条真实浏览器测试（渲染、点击、动画、几何、多局压测、hover 命中） |
| `tests/variants.test.cjs` | 新增 | 5 条玩法变体测试（注册表、默认值覆盖、计分表可替换、换玩法仍守恒） |
| `tests/lobby.browser.test.cjs` | 新增 | 5 条大厅测试（档案增删切、重名拒绝、锁定玩法点不动、积分累加与持久化、手机端不溢出） |
| `js/account.js` | 新增 | 账号 / 银币 / 段位 / 签到 / 回归 / 赛季继承（纯逻辑，`window.HongheAccount` + `module.exports`，Node 与浏览器共用） |
| `tests/account.test.cjs` | 新增 | 29 条经济与账号测试（倍率、破产截断、段位分、注册登录、签到、回归、赛季继承） |
| `tests/shell.browser.test.cjs` | 新增 | 13 条外壳全链路测试（启动页 → 注册 → 赛季 → 继承 → 主界面 → 场次 → 对局 → 结算 → 签到 → 回归 + 手机端） |
| `tests/screenshots.cjs` | 新增 | 一键重出 15 张界面截图 |
| `tests/lobby.browser.test.cjs` | 删除 | 旧「玩家档案大厅」已被账号 + 场次取代，用例迁到 `shell.browser.test.cjs` |
| `docs/screenshots/shell-*.jpg` | 新增 | 15 张外壳截图（桌面 11 张 + 手机 4 张） |
| `docs/screenshots/*.jpg` | 新增 | 桌面端 / 手机端牌桌截图 |
| `README.md` | 追加 | 新增本分支的运行、测试与预览说明 |
| `js/auth.js` | 新增（v0.5.0）/ 重写（v0.6.0） | 认证层双 Provider：`guest`（本机账号）与 `cloud`（云端验证码 / OAuth），门面 `useCloud` / `checkPhone` / `handleCallback` |
| `tests/login.browser.test.cjs` | 新增 | 登录弹窗交互测试（v0.6.0 改为 11 条：手机号校验、发码时序、游客通道、云端不可用降级、手机端） |
| `js/cloud.js` | 新增（v0.6.0） | 云服务接入层：SDK 初始化、列↔界面字段映射、档案读写、战绩写入、错误码翻中文 |
| `tests/cloud.test.cjs` | 新增（v0.6.0） | 20 条假 client 用例：字段映射、`toRow` 不带 `owner_id`、`blocked` 判定、唯一键回落、发码只发一次 |
| `tests/cloud-live.cjs` | 新增（v0.6.0） | `npm run test:cloud`：真打云端 8 项（SDK / RLS / 登录通道 / 授权入口） |
| `docs/DEVELOPMENT-REPORT.md` | 追加 | 本文件 |

## 三、真正修复的问题

### 1. 卡死的根因（不是「定时器不够多」）

旧版把「谁该行动」分散在多个函数里各自修改 `phase / current / lastDiscard`，
一旦某条分支（吃、碰、杠、补花、荒牌）忘了把自己推进到下一家，
就会出现 **状态已经变化、但没有任何一方拥有行动权** 的局面。
此时旧的看门狗只看到「定时器不在了」，又重新排一次 AI 任务；
而 AI 任务算出来的决策与当前局面不匹配，被静默丢弃 —— 于是整局停在那里。

本次的处理：

- 所有命令（出牌 / 吃 / 碰 / 明杠 / 暗杠 / 补杠 / 胡 / 过）执行完都必须经过 **唯一入口 `settle(s)`**，
  由它把状态推进到「必须有人做决定」的位置，或者直接结束本局。
- 「现在谁行动」只有 **一个判定函数 `awaiting(s)`**。UI 与 AI 都只能从它读，
  不再各自猜测 `current`。
- 接牌权用 `pendingClaims` 队列 + `claimCursor` 游标表达；优先级
  胡 > 杠 > 碰 > 吃，同级按离出牌家的座次距离近者优先。多家可接时逐个询问，
  不会有人被跳过，也不会重复询问。
- UI 侧所有状态变更收敛到 `command()`：执行命令 → 代际号 `epoch+1` → 清掉旧 AI 任务
  → 消费事件（动画 / 音效 / 日志）→ `pump()`。
- 每个 AI 任务都带 `epoch`。过期任务一律作废，不可能出现「旧定时器覆盖新回合」。
- 心跳（900ms）只做一致性检查：发现「有人该行动但没有任务」时重新排程，
  连续 8 次仍无法推进则记录完整状态并**明确中止本局**，而不是无限自动出牌掩盖错误。

### 2. 一个真实的规则型 bug

`claimDiscard` 在吃 / 碰 / 杠时没有把被接走的那张牌从牌河移除，
导致牌数变成 137 张（牌数不守恒）。已在 `claimDiscard` 中修正，
并有 `tests/engine.test.cjs` 的守恒断言与 `tileTally()` 兜底检查。

### 3. 手牌 hover 位移导致「点空」（本轮修复）

`.tile-face.playable:hover{transform:translateY(-5px)}` 会让被 hover 的牌整体上移 5px。鼠标停在一张牌最下沿时，牌会在指针下移走，命中判定落到下方空隙，表现为「点了没反应」。

改为只向外扩张的反馈：`scale(1.05)` + 发光描边 + 亮度提升，任何时候都不会把牌从指针下移开。新增浏览器测试用真实鼠标停在下沿 2px 处，断言命中的仍是同一张牌且点击确实打出。

### 4. 新档案积分键缺失（本轮修复）

`blankProfile()` 返回 `points: {}`，而 `normalizeProfile()` 会把每个玩法的积分补成 0 —— 于是新建的档案在本次会话里 `points.shiping` 是 `undefined`（界面靠 `|| 0` 兜住，数据形状不一致）。改为新档案创建时即按 `VARIANTS` 落 0。

### 5. 顺带修正

- `applyHu` 取「胡的那张牌」在自摸时不可靠（依赖手牌顺序）→ 改为读 `lastDraw`。
- 胡牌结算文案使用座位号（「玩家2点炮」）→ 改为「南家/北家/西家/东家」+ 明细分。
- 结算面板 `庄家 / 开牌墙` 信息被挤到牌区中间 → 并入中央信息台。
- 骰子落桌后 `data-value` 未写入 → 补写，视觉回归可断言最终点数与掷出点数一致。

## 四、桌面表现

| 需求 | 实现 |
| --- | --- |
| 出牌动画 | 牌从被点击的那张手牌位置，沿抛物线飞向对应弃牌格，落位后新牌有金色描边；飞行位移与起终点可在 `window.__shipingMahjongLastDiscardFlight` 中读回验证 |
| 吃牌可读性 | 副露分组显示，标签写明「吃 1万2万3万」；被吃进来的那张牌独立描边 + `←` 方向标；三张牌始终按顺子顺序排列 |
| 碰 / 杠 | 同样有分组与标签（碰 / 明杠 / 暗杠 / 补杠），补杠与暗杠有独立样式 |
| 四家弃牌区 | 重新布局为「北 6×3、南 6×3、东 3×6、西 3×6」四片独立区域，环绕中央信息台，互不重叠；超过 18 张自动缩小以免溢出 |
| 骰子 | 真正的 3D 立方体（`transform-style: preserve-3d`），六面 1–6 点完整；掷骰时翻滚 + 上下弹跳 + 落桌阴影；停稳后正面就是掷出的点数 |
| 胡牌展示 | 牌桌中央的半透明层（不是全屏弹窗），完整显示胡牌手牌、已吃碰杠的副露（含被叫牌高亮）、胡牌方式、胡的那张牌、四家输赢与余额 |
| 四家座位 | 东家（左）/ 西家（右）手牌列与副露**牌面全部正向**，不再旋转；北家副露在其手牌下方，自家副露在手牌面板上方 |
| 牌墙 | 改为环绕牌区的一圈，开牌位置用「开牌」标记标出，与骰子点数推导出的墙位一致 |

## 五、测试结果

> 本节记录的是外壳那一轮的快照（62 / 25）；**登录重做后的最新条数与用例见 5.13（合计 127 条）**。

### 5.1 规则 / 变体 / 经济（`npm test`，62/62 通过）

覆盖：136 张牌数与守恒、发牌与庄家、四家完整轮转、北/东/西家实际出牌、
吃只能由下家、吃碰杠后继续出牌、明杠/暗杠/补杠与杠后补牌、自摸与点炮、
多家接牌优先级、荒牌、积分零和、规则开关组合、杠后手牌张数。

### 5.2 随机种子人机模拟

| 规模 | 结果 |
| --- | --- |
| 测试内 100 种子 + 规则组合 | 全部跑完，无卡死 |
| 测试内 500 局连续压测 | 胡 499、荒 1，平均 55.0 步，无卡死、无泄漏 |
| 独立 1000 局统计 | 胡 998（自摸 185 / 点炮 813）、荒 2、**中止 0**；吃 4891 次、碰 3865 次、杠 521 次；平均 44.2 手；每局结束均满足 136 张守恒与积分零和 |

### 5.3 真实浏览器测试（`npm run test:browser`，25/25 通过）

1. 页面加载无脚本错误、无 404，核心与调试接口就绪
2. 骰子六面 1–6 点齐全，落桌后正面点数 = 掷出点数，庄家由点数推导
3. 连续 6 次真人出牌过程中始终 136 张
4. 出牌动画起点就是被点的那张手牌，终点在弃牌区（真实位移）
5. 吃牌副露为连续顺子、被吃的牌有高亮与方向标、标签含「吃」、且只由下家完成
6. 胡牌结算在牌桌内、不溢出视口、手牌/副露/胡牌标记/四家积分与余额齐全
7. 真人接牌时不会被 AI 跳过（停留 1.2 秒后行动权仍在玩家手上）
8. AI 定时任务被强行丢弃后，心跳在 6 秒内恢复推进
9. 浏览器内连续 20 局自动对局：0 卡死、0 脚本错误
10. 移动端 390×844：无横向溢出，四个弃牌区、信息台、手牌区互不重叠且在视口内
11. 桌面端 1440×900：四家弃牌互不重叠，副露牌**旋转数量为 0**（全部正向）
12. 鼠标真实停到手牌最下沿 2px 处，命中的仍是同一张牌，且点击确实打出（hover 不位移）

外壳全链路（`tests/shell.browser.test.cjs`，13/13）：

13. 未登录时停在启动页，微信 / 账号两个入口都在，启动无脚本错误
14. 登录弹窗真实点击可开，空账号与不存在账号分别给出正确提示，可关闭
15. 注册后弹出「恭喜获得 ×4,000 银币」，余额 5,000 + 4,000 = 9,000，随后进入 S25 赛季页
16. 赛季页点进「赛季继承」，显示上季「长工 112」与本赛季「未激活 0」，再点进主界面；赛季动画只放一次
17. 主界面 12 个功能格 / 天梯 4 条 / 其他游戏 4 张 / 底部导航 9 项，银币、金条、段位、昵称都对
18. 场次页三档卡片；银币 9,000 时中级场显示「银币不足 20,000」且点不进桌，初级场可以进且底注 2,000
19. 进桌后四家都有银币与段位，自家座位显示昵称，品牌副标题写明场次
20. 结算：自摸三家各付 2 个单位，赢家收总额，段位分 +7×倍率 / -2×倍率，银币写回账号
21. 结算面板结构：赢家 1 张 + 其他 3 张 + 段位条 + 三个去向按钮，且按钮位于最上层可点
22. 继续回主界面后余额与段位进度同步刷新，场次页中级场按余额自动解锁
23. 签到 7 格，领取后当天不可重复领，银币 +1,000
24. 回归好礼 7 格，按顺序领取并累加银币
25. 手机 390×844：主界面单列、无横向滚动、格子不越界、导航贴底；牌桌手牌 14 张完整在视口内

### 5.4 截图

外壳（`node tests/screenshots.cjs` 一键重出）：

- `shell-01-splash.jpg` 启动页
- `shell-02-login.jpg` 账号密码登录弹窗
- `shell-03-reward.jpg` 恭喜获得银币 ×4,000
- `shell-04-season.jpg` S25 全新赛季开启
- `shell-05-inherit.jpg` S25 赛季继承（长工 112 → 未激活 0）
- `shell-06-home.jpg` 主界面（天梯 / 12 格 / 游戏卡 / 下载栏 / 底部导航）
- `shell-07-hall.jpg` 场次选择（段位卡 + 三档场次）
- `shell-08-table.jpg` 对局桌面
- `shell-09-result.jpg` 平胡结算
- `shell-10-signin.jpg` 7 天签到
- `shell-11-back.jpg` 回归好礼
- `shell-12-home-mobile.jpg` / `shell-13-hall-mobile.jpg` / `shell-14-table-mobile.jpg` / `shell-15-result-mobile.jpg` 手机竖屏四屏

牌桌细节：

- `docs/screenshots/desktop-header.jpg`：牌桌顶栏（昵称 / 段位 / 场次 / 银币）
- `docs/screenshots/desktop-dice.jpg`：掷骰（3D 立方体 + 桌面居中）
- `docs/screenshots/desktop-table.jpg`：桌面端四家弃牌 / 副露 / 牌墙 / 信息台
- `docs/screenshots/desktop-win.jpg`：桌面端胡牌结算
- `docs/screenshots/mobile-table.jpg`：手机端牌桌
- `docs/screenshots/mobile-win.jpg`：手机端胡牌结算

## 五之后：对照截图重做外壳（本轮新增）

需求：按「博雅·红河棋牌」的界面截图把外壳做出来 —— 登录、赛季、主界面、场次选择、对局、结算，
并且要能登录、能记积分。

### 5.5 先算准，再画面

先写 `js/account.js`（纯逻辑，不碰 DOM），把银币、段位分、倍率、签到、赛季继承全部算准，
用截图里的真实数字当断言：

```
底注 2000 · 庄家点炮 · 四家余额 13500 / 16500 / 15090 / 7672
→ deltas  [15672, -4000, -4000, -7672]
→ 段位分  [14, -4, -4, -6]
```

这与截图里「赢家 +15672、三家 -4000、点炮者只扣到 7672（破产）」逐位一致。
之所以先做这一层，是因为界面上的每一个数字都来自它 —— 只要这层测试过了，界面显示对不对就只剩接线问题。

### 5.6 外壳结构

`index.html` 从「一个牌桌页面」变成 **7 个界面 + 5 个弹层**：

| 界面 | 关键内容 |
| --- | --- |
| `#screen-splash` | 山水背景、微信登录（占位）、手机号登录、16+ 与客服角标 |
| `#login-modal` | 金框弹窗：账号 / 密码 / 注册 / 登录 / 记住的账号历史 / 忘记密码提示 |
| `#screen-season` | S25 巨型金色字 + 赛季起止日期 + 点击继续 |
| `#screen-inherit` | 两个球体：上赛季称号与分数 → 本赛季「未激活」 |
| `#screen-home` | 顶栏（头像/昵称/段位/银币/金条/活动）、天梯榜、12 功能格、个旧麻将与双扣主推卡、四张小卡、其他游戏下载栏、9 项底部导航 |
| `#screen-hall` | 标准场/金条场页签、赛季段位卡（徽章/进度条/天梯/奖励）、三档场次卡（底分、银币区间、在线人数、余额不足遮罩）、快速开始 |
| `#screen-table` | 四家座位、牌墙环、四片牌河、中央计时卡、自家副露、手牌、动作圆钮、桌内结算层 |

弹层：`#signin-modal`（7 天签到 + 连续 3 天金条）、`#back-modal`（7 天回归好礼）、
`#reward-modal`（恭喜获得）、`#rules-modal`（规则设置）、`#result-modal`（平胡结算）。

### 5.7 三个真正踩到的坑

1. **结算层点不动按钮**。结算层是「桌内半透明层」，整层 `pointer-events:none` 才不会挡住牌桌，
   但新面板的类名从 `.result-card` 变成 `.result-sheet`，没有补上 `pointer-events:auto`，
   结果是按钮可见、`elementFromPoint` 却返回 `.felt`，真实点击全部落空。
   现在测试里专门有一条：把按钮中心的 `elementFromPoint` 取出来，必须命中按钮本身。

2. **手牌 hover 位移导致点空**（上一轮已修，这轮补了回归用例）：`translateY(-5px)` 会让牌从指针下移走，
   改成 `scale(1.05) translateY(-1px)` + 发光描边，并把鼠标停在下沿 2px 处做命中测试。

3. **牌桌样式四代叠加互相 `!important`**。v2 基础 + v3 叠加 + v3.1 微调 + 外壳改造，
   中央区里水印、计时卡、牌河三层各按自己的百分比定位，最后挤成一团；牌墙被挪到中央区外面 15px。
   处理办法不是再补一条，而是**把历史层的 `!important` 拆掉**，再用第 10 节「牌桌布局 v4」作为唯一裁决层：
   中央区固定为一圈牌墙 + 四片牌河 + 一张紧凑计时卡，手牌按 14 张单行定尺寸。
   拆完之后牌墙才真正围成一圈，弃牌区与信息台也不再互相覆盖（有几何断言兜底）。

### 5.8 账号与经济怎么落地

| 能力 | 实现 | 将来接联机 |
| --- | --- | --- |
| 注册 / 登录 | 本机账号，`localStorage` 存账号列表 + 会话；密码存 djb2 变体哈希（**不是安全凭据**，只用于本机区分） | 换 `register / login / session` 三个函数 |
| 银币 | 初始 5,000，新号见面礼 +4,000；每局按 `computeRound` 增减，扣到 0 为止 | 服务端记账 |
| 段位 | 段位分 + 13 档阶梯（新秀一阶 → 中将），按阈值取档并给出 `385/420` 形式的进度 | 不变 |
| 场次 | 初级 2,000 / 中级 8,000 / 高级 28,000 底分，各有银币门槛；余额不足卡片置灰且点不进 | 不变 |
| 签到 / 回归 | 7 天各 +1,000 银币，连续 3 天额外 +30 金条，按自然日限制 | 服务端校验时间 |
| 赛季 | S25（2026.11.06~2027.01.05），首次登录放一次开季 + 继承动画，之后不再重复 | 不变 |
| 玩法选择 | `VARIANTS` 注册表驱动。石屏开放；个旧 / 宝秀仍是置灰占位 | 补 `defaults` + `scoring` 即可 |

**个旧 / 宝秀依然是锁定占位**：规则细节（牌张、胡型、烂牌胡判定、吃牌限制、分表）不能猜。
确认差异后只需在 `js/core.js` 的 `VARIANTS` 里补配置并把 `available` 改成 `true`，
牌桌、场次、积分、测试都不用改（`tests/variants.test.cjs` 已经验证「换一张计分表，分值立刻跟着变，且守恒与零和仍成立」）。

## 五之后（二）：把登录做成「输一次就能进」（v0.5.0）

上一轮的外壳骨架是能点通的，但登录体验有四个真实问题，反馈原话是"现在也登陆不上"：

1. **必须先去注册**。点「登录」只回一句「账号不存在，请先注册」，而"注册"是旁边一个不起眼的棕色小按钮。用户的心智是"输账号密码进去"，不是"先填表再回来"。
2. **中文昵称注册不了**。当时的正则是 `^[A-Za-z0-9_@.-]{3,20}$`，输入"张三"直接被拒，提示还写着"账号需 3-20 位字母、数字或 _ @ . -"—— 看起来像是账号格式要求严，实际是根本不认中文。
3. **按钮写着「手机号登录」，点开却没有验证码**。没有短信通道却摆一个手机号登录按钮，等于挖坑。
4. **没有办法退出或换号**。登录之后账号写死在会话里，想换个号只能清浏览器缓存。

改法：把认证从 UI 里剥离，做成独立一层，再把交互改成「一步进入」。

### 5.9 认证层：`js/auth.js`

界面不再直接调 `localStorage` 和 `A.register()`，只跟 `Auth` 说话：

```js
await Auth.signInOrSignUp({ account, password })   // 主路径：能登就登，没有就建
await Auth.signUp({ account, password })           // 显式注册，重名 → code:'duplicate'
await Auth.signIn({ account, password })           // 只登录：no-account / bad-password
await Auth.signOut();  await Auth.current()
```

- **方法全部 async**。现在返回立刻 resolve 的 Promise，将来接真实服务端只要实现同样 5 个方法再 `Auth.useProvider(cloud)`，界面代码零改动。
- **失败带 `code` 和 `field`**：`no-account` / `bad-password` / `duplicate` / `bad-account`，界面据此决定提示文案并把焦点打回对应输入框。
- **账号规则只有一处**：`account.js` 的 `checkAccount` / `checkPassword`，`register` 与 UI 都复用它，不会出现"界面放行、内核拒绝"的分裂。

### 5.10 账号规则放宽

| 项 | 之前 | 现在 |
| --- | --- | --- |
| 账号 | 3-20 位，仅 `A-Za-z0-9_@.-` | 2-20 位，**中文** / 字母 / 数字 / `_@.-`；11 位手机号自动识别为 `phone` |
| 密码 | ≥4 位 | 4-32 位，允许空格与符号 |
| 重名 | 「该账号已被注册」 | 「该账号已被注册，直接登录即可」+ `code:'duplicate'` |

### 5.11 登录交互

- 主按钮「登 录」= `signInOrSignUp`：账号不存在就顺手建一个，**密码错了只报错，绝不偷偷新建同名号**（`duplicate` 拦住）。
- 副按钮「注册新账号」= 显式 `signUp`，适合确定要开新号的情况。
- 密码框加「显示 / 隐藏」，参数是 4-32 位任意字符，中文输入法下也能用。
- 「记住账号」默认勾选；关掉后不再回填，但历史列表仍保留（最多 8 条，可点选）。
- 主界面左上角点头像打开账号浮层：当前账号、段位进度、切换账号、退出登录、清空本机存档（`confirm` 二次确认，只删 `honghe-*` / `shiping-*` 前缀的键，不碰别人的数据）。
- 启动页把「手机号登录」改成「账号登录」，把「任何登录方式都需要实名认证」这句照抄来的废话换成实话：「本机账号，一个昵称加密码即可开局 · 不用等短信」。
- 浏览器禁用本地存储（隐私模式）时，启动就提示「账号和进度无法保存」，不让人以为登录成功了。

### 5.12 这一轮新踩的坑

1. **记住账号关了还在回填**。`openLogin` 原来写的是 `if (!acc.value) acc.value = lastAccount()`，输入框里的旧值让"关闭记住"形同虚设。改成每次打开都以 `Auth.lastAccount()` 为准，切换账号时传 `noFill`。
2. **切换账号后被自动填回上一个号**。清空输入框后紧接着 `openLogin()` 又把 `lastAccount()` 填回去，得给 `openLogin` 一个"别填"的开关。
3. **历史账号列表藏不住**。`.login-history{display:flex}` 与 `.hidden{display:none}` 同权重，后写的 flex 赢，于是空列表在账号框下面留了一个空方框。补 `.login-history.hidden{display:none}`。
4. **换号后赛季动画没了**是预期行为（`season-seen` 按浏览器记，不按账号），测试里按真实行为断言，没有为迁就旧断言改产品。

### 5.13 测试

| 命令 | 条数 | 覆盖 |
| --- | --- | --- |
| `npm test` | 108 | 规则 24 / 变体 5 / 账号经济 29 / 认证层 26 / **云端接入 20** / 模拟 4 |
| `npm run test:browser` | 36 | 对局 12 / **登录 11** / 外壳 13 |
| `npm run test:cloud` | 8 | 真打云端：SDK / RLS / 登录通道 / 授权入口 |
| 合计 | **144 + 8** | 全绿，无页面脚本报错 |

登录 26 条纯 Node 用例覆盖：中文/手机号建号、重名不覆盖原密码、密码错不建号、`autoCreate:false`、记住账号开关、历史去重与 8 条上限、清档不误删别人键、密码不落明文、换 provider。
登录 11 条浏览器用例全部**真实点击输入框**，覆盖：手机号本地校验不发请求、没发码就点登录被拦、游客一次进入、游客二次进入不重发见面礼、账号浮层退出、改昵称、CDN 被拦（云端不可用）时仍能游客进桌、手机 390×844 可点中。
云端接入 20 条假 client 用例覆盖：列→界面字段映射（含 `null` 不塌成 0）、`toRow` 永不带 `owner_id`、`update` 返回空数组判 `blocked`、`insert` 撞唯一键回落重读、错误码翻中文、发码只发一次。

## 五之后（三）：接入真实云服务（v0.6.0）

上一版的账号是"本机档案"——一个昵称加密码，存 `localStorage`。换浏览器就没了，这也是为什么"登录机制先做成"只能算半成品。这一版把账号、经济、战绩接到真实云端。

### 5.14 为什么是这个形状

| 决策点 | 选择 | 原因 |
| --- | --- | --- |
| SDK 引入方式 | CDN `<script>` + `WorkBuddyCloud.createWorkBuddyCloud` | 项目是纯静态页，没有任何构建步骤。为了接 SDK 去引 webpack，等于为一行 `import` 增加一整套工具链 |
| 认证方式 | 手机号验证码为主，WorkBuddy / 微信授权为辅，游客兜底 | 麻将桌不该让人背密码。手机号是最低摩擦的方式，授权登录留给不想收短信的人 |
| 游客模式 | 保留，且**云端不可用时自动可进** | 云端挂了不该连牌都打不了。但绝不静默降级——界面上明写"进度只存本机" |
| 账号数据位置 | `mahjong_players` 一行一人，`owner_id` 唯一 | 一个账号一份档案，避免同一人多行导致余额分裂 |
| 战绩 | `mahjong_rounds` 一局一行 | 排行榜、复盘、防作弊都要明细，不能只存总数 |

新增 `js/cloud.js`（约 320 行）作为唯一的数据出入口，`js/auth.js` 重写成双 Provider（`guest` / `cloud`）。**没有一处业务代码直接 `fetch` 云端接口**，全部走 `Cloud.saveProfile` / `Cloud.loadOrCreateProfile` / `Cloud.recordRound` 三个函数。

### 5.15 两张表和五条策略

`mahjong_players`：`id`、`owner_id TEXT NOT NULL DEFAULT auth.uid() UNIQUE`、`owner_name`、`coins`、`gold`、`rank_points`、`season_id`、`season_activated`、`season_seen`、`prev_season jsonb`、`signin jsonb`、`back_gift jsonb`、`stats jsonb`、`welcome_granted`、`created_at`、`updated_at`。

`mahjong_rounds`：`id`、`owner_id`、`owner_name`、`hall_id`、`base_bet`、`win_type`、`seat`、`delta`、`rank_delta`、`balance_after`、`seat_scores jsonb`、`created_at`，配 `mahjong_rounds_owner_time_idx`。

RLS 是**双闸门**，缺一不可：

- **GRANT**：只给 `authenticated` 角色授 `SELECT/INSERT/UPDATE`，`anon` 什么都不给。
- **POLICY**：`players` 三条（read / insert / update own），`rounds` 两条（read / insert own），全部 `USING (owner_id = auth.uid())`，写入侧再加 `WITH CHECK (owner_id = auth.uid())`。

`WITH CHECK` 是关键：没有它，登录用户可以把 `owner_id` 写成别人的 uid，往别人档案里塞数据。客户端 `toRow()` 因此**永远不输出 `owner_id`**，让数据库的 `DEFAULT auth.uid()` 自己填——这条有专门的单测钉死（`assert.equal('owner_id' in row, false)`）。

### 5.16 这一轮新踩的坑

1. **`Number(null) === 0` 把空余额变成 0 元**。云端新行的 `coins` 是 `NULL`，`Number(null)` 得 0，于是新号进桌余额显示 0 而不是默认 5000。`num()` 必须先判 `null / undefined / ''` 再转数字。
2. **`.select()` 返回空数组不等于成功**。被 RLS 拦住时 PostgREST 不报错，只返回 `[]`。所以 `saveProfile` 里 `update(...).select()` 拿到空数组要判成 `code:'blocked'`，不能当写成功。
3. **测试里 `page.evaluate` 忘了 await**。注册接口改成 `async` 之后，外壳测试里 `page.evaluate(() => { __shipingMahjongRegister(...) })` 会在注册完成前返回，牌桌拿着空账号启动，手牌区全空。三处调用全部改成 `await page.evaluate(async () => { await ... })`。
4. **Playwright 的 glob 拦不住 CDN**。想模拟"云端不可用"，用 `**/workbuddy-cloud-sdk/**` 匹配不到 jsDelivr 的地址，得用 predicate：`page.route((u) => u.href.includes('workbuddy-cloud-sdk'), ...)`。
5. **本地调试会被 4xx 刷屏**。没有会话时打 `/auth/session`、号码不存在时打登录接口，都会返回 401/400，浏览器一律记成 console error，把"无控制台报错"的断言冲红。这类 4xx 其实是通道正常的证据，测试里把 `.cloud/` 相关的噪声分流到 `page.__cloudNoise`，正文断言只看真脚本错误。顺带确认了一件好事：数据面在 `127.0.0.1` 上是通的（匿名读返回 `rows=0` 而不是报错），所以本地也能用手机号走通登录；但 OAuth 回跳要落到注册的回调域名，授权登录建议发布后再测。
6. **CSS 老规则把新按钮顶到最上面**。`.login-primary{order:-1}` 是上一版留下的，新版主按钮复用了这个类，直接飞到弹窗顶部。补一条同权重更靠后的 `.login-body .login-primary{order:0}`。同类问题：`.am-rename{display:flex}` 与 `.hidden` 同权重，改名输入框默认就露出来了。
7. **手快点开登录框，按钮再也点不动**。启动页的 HTML 是静态的，比 `await Cloud.init()` 先露出来；这时点「手机号登录」，弹窗按"云端未就绪"把主按钮禁用，而**之后没有任何地方重画**，于是一直禁用。浏览器测试把它抓出来了——不是用例不稳，是真 bug（第一次跑挂、第二次跑过了，正是因为 init 的时机在飘）。修法：`startSession` 在 init 落定后重画一次，`openLogin` 也挂一个 init 落定后的补画。

### 5.17 验证到哪一步

自动化能验的都验了，`npm run test:cloud` 真打云端 8 项：

```
✓ SDK 初始化
✓ 未登录时拿不到会话
✓ 匿名读被 RLS 限制为空
✓ 匿名写被拒绝 —— DATABASE_42501
✓ 手机号登录通道已开启 —— invalid_username_or_password
✓ 验证码方法可用
✓ WorkBuddy 授权可发起 —— www.workbuddy.cn
✓ 微信授权可发起
```

`invalid_username_or_password` 是**好消息**：说明登录接口通着，只是这个手机号还没注册。`DATABASE_42501` 同理——权限链生效才会有这个码，如果 GRANT 漏了会变成表不存在或直接 500。

**自动化验不了的两件事，我没有假装验过**：

1. 真实短信下发（需要真手机号，且会真扣费）。
2. 微信 / WorkBuddy 扫码授权（需要真人扫码）。

我试过绕开短信造一个会话来验证"登录后能读写自己那一行"，SDK 直接把路堵死：

```
signUp requires a verificationToken; run sendOtp + verifyOtp first
```

也就是说这个后端不接受"邮箱 + 密码"直接建号，必须先过验证码。这是好事（少一条被刷号的路），代价是登录后的读写**只能由真人收一条短信来验**。

这两条的验收步骤写在 `README.md` 的「四步人工验证清单」里，需要你拿手机走一遍。

数据面是干净的：`mahjong_players` 0 行、`mahjong_rounds` 0 行，测试没有往真库里塞垃圾数据。

发布之后又在**线上域名**上补了一次实测（不是本地）：

```
status.ready = true          probe = { ok: true, rows: 0, error: null }
登录弹窗说明 = 「首次登录自动建号。银币、段位与战绩存在云端，换手机也一样。」
主按钮 verifyDisabled = false    控制台脚本错误 = 0 条
```

这一步验的是"云端 Origin 与发布域名是否对得上"——对不上时数据面会直接拒（`Current origin is not allowed`），能返回 `rows=0` 就说明白了。

## 五之后（四）：联机大厅与声音（v0.7.0）

需求原话是："加入大厅连线功能，可以连入真实的用户，用户可以取昵称或随机系统分配。除了石屏麻将其它功能先不要，也不用显示，只要快速匹配开始或快速人机对战，要横屏适配手机，要有牌面声音和打出麻将的声音，比如'四万'。"

拆成六件事：真人匹配、昵称、砍掉其它玩法、只留两个入口、横屏、声音。

先把话说在前面：**这个项目没有服务端进程**，它是一堆静态文件 + 一个云数据库。所以"联机"只能在这个约束下设计，不能照抄"开 WebSocket 房间"那一套。

### 5.18 为什么是「房主定稿 + 同种子重放 + 只写真人动作」

先说否决掉的三个方案：

| 方案 | 否决理由 |
| --- | --- |
| 上 WebSocket / Socket.IO | 需要常驻进程，静态站没有；再加一层自建服务器就违背了"发布即上线" |
| 每个动作都写库、每端都重放全部 | 电脑那一手也落库，一局 60~100 条写，流量和延迟都不划算，还会把别人手里的牌暴露给抓包的人 |
| 房主当"服务器"转发状态 | 房主掉线整桌废，而且房主的浏览器成了单点 |

最后采用的是**四条**：

1. **房主定稿**：谁先开房谁当房主，在"满 4 人"或"等够 9 秒"时把房间 `status` 改成 `ready`，同时**定死** `human_count`（2~4）与 `seed`。这一刻之后全房参数一致，不再有"谁说了算"的问题。
2. **同种子确定性重放**：各端拿同一个 `seed`，`mulberry32(seed)` 本地建局——洗牌、发牌、骰子、AI 的每一个随机选择全从这条流取。所以四家看到的是**同一副牌、同一手骰子、同一批电脑决策**。
3. **只写真人动作**：`mahjong_moves` 里只有真人那一手。电脑的动作不落库，各端自己算——既省流量，也没人能通过读日志推出别人的手牌。
4. **800ms 轮询**：`movesSince(roomId, mySeq)` 增量拉，失败按 `1.6^n` 退避，连续 3 次判 `offline` 并提示，不整桌卡死。

这个思路不是拍脑袋的，是照着开源实现的路子来的（`kongxg888/mahjong` 的"动作日志 + 确定性重放"分层）。**动作日志和状态快照分开**是关键：日志是事实，快照是各端自己算出来的结果。

防重靠数据库而不是靠代码：`UNIQUE(room_id, seq)`，撞了就是 `23505`，`Net.pushMove()` 捕到就返回 `{ code: 'dup' }`，上层读一次最大 `seq` 补写。RLS 只允许写自己那一行（`owner_id DEFAULT auth.uid()` + `WITH CHECK`），`mahjong_moves` 的 INSERT 还多一条"必须是房内成员"的 `EXISTS` 子查询——不然谁都能往别人房里塞假牌。

### 5.19 座位旋转：这里差点写错，而且写错了也"看起来能玩"

联机时每台设备都得把自己当 0 号位，不然"我"会坐到自己对面去。第一版我按常识写成 `local = (global - mySeat + 4) % 4`，单测直接炸了。

原因是**内核的座位顺序不是 +1**：

```js
const NEXT_SEAT = [2, 3, 1, 0];   // 0→2→1→3→0
```

这是"东→南→西→北"的逆时针出牌顺序。所以旋转必须**沿着这个环走**，不是做减法：

```js
const CYCLE = [0, 2, 1, 3];               // 环上第 k 个 → 全局座位号
const POS   = { 0: 0, 1: 2, 2: 1, 3: 3 }; // 全局座位号 → 环上位置

function localOf(g, me) { return CYCLE[(POS[g] - POS[me] + 4) % 4]; }
function globalOf(l, me) { return CYCLE[(POS[l] + POS[me]) % 4]; }
```

`Online.rotate(state, mySeat)` 会把 `hands / melds / discards / scores / dealer / current / lastDraw.seat / lastDiscard.from / pendingClaims[].seat / events[].seat,from / kongLog / winner / result.seat` 一次性转过来。漏任何一个字段，表现都是"偶尔有人的牌河错位"——这种 bug 靠手点很难复现。

所以这条数学用测试钉死，两层：

1. **守卫**：`CYCLE` 必须和内核 `NEXT_SEAT` 是同一个环。以后谁改了内核座位顺序，这条先炸，而不是等到线上错位。
2. **等价性**：`seed ∈ {1, 7, 2026} × 位移 ∈ {0,1,2,3}`，把同一局分别按 4 个位移旋转后让 AI 打完整局，每一步都比对"全局指纹"（四个座位的手牌/副露/牌河/分数拼起来）。12 组合全部逐手一致。

顺手还炸出一个同源 bug：`isHumanSeat()` 原本写的是 `seat < humanCount`，在本地视角下这是错的——旋转之后真人座位不再连续。改成显式记 `humanSeats`（`begin()` 里用 `localOf` 把全局真人座位换算成本地座位数组），这个数组同时被 `pump()` 用来判断"是不是该等真人"。

`names` 也有同样的坑：传进来的是**全局座位序**，直接当本地序用，`mySeat=1` 时 0 号位会显示"甲"而不是"乙"。现在 `begin()` 里按 `localOf` 重排一遍再落到界面上。

### 5.20 声音：一个音频文件都没有

要"牌面声音"和"打出'四万'"。两个选择：找 34 个 mp3 塞进仓库，或者合成。

选了合成，因为：仓库不该因为几个音效多出几百 KB；麻将落桌声本质就是一段被带通滤过的噪声，合成听着比压缩过的 mp3 还干净；报牌名用系统 TTS 就够，而且不用为"一万"到"九条"录 34 条音。

`js/audio.js`：

```js
// 落桌：白噪声 → bandpass 1500~2000Hz → 85ms 指数衰减，叠一个 190→120Hz 三角波
clack(strength)
// 报牌：tileWord(3) === '四万'，字牌读「东风/红中/白板/发财」
discardTile(id)  →  clack() + 60ms 后 say(tileWord(id))
// 语音：speechSynthesis，rate 1.12，优先选 zh-CN 音色，播报前先 cancel 防叠音
say(text)
```

iOS 有个硬规矩：`AudioContext` 必须在用户手势里解锁，否则一直是 `suspended`。所以 `boot()` 里挂了**一次性**的 `pointerdown → Sfx.unlock()`，并且监听 `visibilitychange`，切回前台再 `resume()` 一次（后台待久了会被系统挂起）。

顶栏那个「声开 / 声关」按钮同时刷两处（牌桌顶栏和大厅顶栏），以前只刷一处，从大厅静音后进牌桌会显示成"声开"——这个 bug 是自己截图看出来的。

### 5.21 只留两个入口，以及横屏

"除了石屏麻将其它功能先不要，也不用显示"——是**不显示**，不是置灰。所以天梯榜、12 个功能格、个旧/双扣占位卡、底部 9 项导航整段删掉了，`index.html` 里主界面 160-254 行整段换成大厅：一个品牌名、一个昵称框 + 「随机」、两个按钮、一行说明。

这里有个产品判断值得记一笔：**「快速匹配」在未登录时一度被我做成 `disabled`**。截图一看就发现问题——按钮灰到几乎看不见，用户读到的信息是"这功能坏了"，而不是"要先登录"。改成不置灰、加 `needs-login` 类、点一下弹登录并**在弹窗里说明原因**（"连真人玩家需要先登录云端账号；游客只能打人机"）。同一句话在大厅底部也放一行常驻提示。

横屏是硬要求（`844×390`）。竖屏那套"标题在上、按钮堆在中间"在横屏会把屏幕占满、按钮挤成一条。所以第 13 节加了三段 `@media (orientation:landscape) and (max-height:560px)`：

- 大厅改**左右两栏**：品牌在左（`flex:1 1 32%`），昵称行与按钮在右（`36vw` / `38vw`）；
- 牌桌顶栏压到 38px，手牌宽度 `clamp(24px,3.4vw,40px)`，座位卡片收窄；
- 汇总行（状态/提示）`flex-basis:100%` 独占一行，不跟按钮抢宽度。

第一版调完还是挤（截图里三个区各占 1/3，按钮被压成矮条），调了列宽比例才顺眼。

### 5.22 这一轮新踩的坑

- **`POLL_MS is not defined`**：`match()` 里用了 `POLL_MS`，常量忘了声明。Node 与浏览器都直接抛 `ReferenceError`，好在第一次跑测试就炸。
- **Node 里 `nick()` 每次都换名**：`localStorage` 不存在时读到的永远是 `null`，于是每次都重新随机。加了 `memStore = new Map()` 兜底。
- **`DO $$ ... $$` 迁移被 SQL 工具拒**（`DATABASE_42601`）：它只接受单语句。拆成 21 条分别执行——这也是为什么留着 `docs/sql/online-tables.sql`，别人重建时照着逐条跑。
- **账号浮层点不到「改昵称」**：`.lobby{z-index:41}` 盖住了 `.account-menu{z-index:40}`，Playwright 报 `<div class="lobby"> intercepts pointer events`。补 `.screen.home .account-menu{z-index:60}`。
- **`#seat-name-1/2/3` 是 null**：对手座位名字原来没有 id，`paintSeatName()` 找不到元素，于是联机名字画不上去。
- **0 号位显示账号昵称而不是房间昵称**：`loadSeatBalances()` 每次刷新都拿 `account.nick` 覆盖座位名。加 `if (!Online.isOnline())` 才覆盖。
- **注入 `{kind:'pass'}` 被拒**（"当前没有待处理的接牌"）：测试以为对手在等接牌，实际在等出牌。改成按 `o.awaiting.kind` 分派。
- **`__shipingMahjongDebug()` 没有 `turnCount`**：想用它当进度指针，没有。改用"弃牌总数"。
- **本地跑联机会报 `permission denied for table mahjong_moves`**：`127.0.0.1` 没有云端会话，RLS 拒写——这是**预期行为**，不是 bug。`CLOUD_NOISE` 已把这类请求分流，浏览器用例只看真正的脚本错误。

### 5.23 这一轮的测试

```
npm test              115 条全通过（新增 online.test.cjs 7 条）
npm run test:browser   41 条全通过（新增 online.browser 4 条 + 横屏 1 条）
npm run test:cloud      8 条全通过
```

浏览器侧新增的四条联机用例，验的是"真界面真的会动"：

1. 联机开局后座位与名字对得上（`names[0]==='乙'`、`names[1]==='甲'`，验的就是 5.19 那个重排）；
2. **轮到真人对手时不替他出牌**——等 2.5 秒，`current` 与弃牌数都不许变（这条最像"线上那个 bug"）；
3. 注入对手动作后局面推进（用弃牌总数当进度指针）；
4. 出牌真的触发了 `Sfx.discardTile`，且牌名匹配 `/^[一二三四五六七八九][万筒条]$|.../`。

**仍然验不了的**：两台真机 + 两个云端账号的完整互通。本地起服务时云数据面会因为 Origin 不匹配而拒写（这是安全边界，不该绕），造会话又被 `signUp requires a verificationToken` 堵死。所以这一段写成了 README 里的「真机互通验证清单」五步，需要你拿两台手机走一遍。

## 五之后（五）：无庄家、节奏、遮罩、结算自适应、每日福利（v0.8.0）

这一轮六条要求，三条是「规则/数值」，三条是「表现」。规则那三条最怕的是改错地方——改到内核的发牌语义上，整套牌都会乱。

### 5.24 「没有庄家」到底该改哪里

原代码里 `dealer` 这个变量不只决定算分，还决定三件事：**谁先拿 14 张、牌墙从哪里开牌、`NEXT_SEAT` 从谁开始转**。如果直接把 `dealer` 删掉，等于重写发牌器和出牌顺序，风险远大于收益。

所以这一轮只动两处：

1. **算分**：`computeRound` 里 `multiplier` 从「庄家 2 倍 / 闲家 1 倍」改成恒为 `1`。点炮者付 `unit × 2`，其余各付 `unit`；自摸三家各付 `unit × 2`；`unit = baseBet`。段位分也不再乘倍率（赢家 `+7`、点炮 `-3`、其余 `-2`）。
2. **叫法**：界面上一律改「起手」——掷骰层文案 `掷骰定起手`、座位标记字从「庄」改「起」、`title` 写明「起手家（骰子点数决定，不影响算分）」。内核变量名仍是 `dealer`，但注释里注明了它现在的唯一职责是「决定谁先摸牌与开牌位置」。

单测里钉了一条最容易回归的：

```js
test('谁起手都不影响分数（没有庄家）', () => {
  const a = computeRound({ ...base, dealerWin: true });
  const b = computeRound({ ...base, dealerWin: false });
  assert.deepEqual(a.deltas, b.deltas);
});
```

这条用例的价值在于：以后谁再想「把庄家翻倍加回来」，测试会立刻拦住。

### 5.25 AI 放慢与 `STALL_MS` 的硬约束

把 `SPEED.discard` 从 780ms 调到 1600ms，看起来只是改个数字，但桌面上有一套**心跳自愈**：`STALL_MS = 2600`，超过这个时间还看不到 AI 任务在跑，就判定「任务丢了」并重新派发。如果节奏抖动撞上这个阈值，会出现「AI 明明在思考，却被系统认为卡住，于是又派一个新任务」——表现就是偶尔连出两张牌。

所以放慢的同时加了两道保险：

```js
const SPEED = { claim: 1200, discard: 1600, kong: 950 };  // 全部 < 2600
const SPEED_JITTER = 0.12;                                 // 1600 × 1.12 ≈ 1792
```

上限 1792ms，留了 800ms 余量。顺带把「吃碰」和「杠」分开计时——杠的动画短，用 950ms 更跟手；吃碰要等玩家看清，用 1200ms。

### 5.26 被吃碰杠走的牌：内核不删，UI 补回来

引擎里 `claimDiscard` 会 `pile.splice(di, 1)` 把被接走的那张从牌河**删掉**——这是对的，因为「牌河张数」要参与流局判断（四家牌河加起来摸完了就是荒庄），不能留幽灵张。

但玩家看到的是「我刚打出去的那张牌凭空消失了」。两种做法：

- 改内核，让它保留那张牌、另外记一个 `claimed` 标记 → 要动流传判断、要吃碰杠的所有读牌河的地方，牵一发动全身；
- **不改内核**，在渲染时从各家副露的 `m.from` / `m.calledTile` 反推出「谁接走了哪张」，补回到该家牌河末尾 → 只碰 `renderDiscards` 一个函数。

选了第二种。补回来的牌带 `data-claimed-by`，文案是「被某家吃/碰/杠走」，样式上和正常弃牌区分：`filter: grayscale(.3) brightness(.6)` 压暗 + `::after` 铺一层 135° 斜纹 + 金色虚线描边。

遮罩第一版做得很淡（只加了深色斜纹），局部放大截图里几乎看不出来——因为牌面本身是白底，半透明黑压在白底上就是浅灰。改成先压亮度再叠斜纹才立得住。副露里「吃进来的那张」用同一套类名（`.meld-called-tile`），保证两处视觉语言一致。

还有一个细节：`renderDiscards` 每帧都会跑，直接 `innerHTML = ''` 重建会让牌河里的牌一直闪。加了 `box.dataset.sig` 缓存——牌河内容签名没变就直接返回。

### 5.27 结算层：为什么 `scale` 不行，`fixed` 才行

要求是「不要出现拉条，显示完整的牌」。第一版用等比 `transform: scale()` 把整个面板缩进视口，本地看着挺好，但 844×390 的横屏实测**底部三个按钮跑到视口外**（`actionsInside: false`）——因为 `scale` 缩的是视觉，布局盒子没变，`getBoundingClientRect` 一量就露馅。

第二版查到一个更隐蔽的坑：结算层原本是 `.table-frame` 里的 `position: absolute`。而 `.table-frame` / `.felt` 都是 `position: relative` 且带 `transform: translate(-50%, -50%)`——**带 `transform` 的元素会成为 `abspos` 后代的包含块**。于是结算层是相对「牌桌」定位的，牌桌比视口高时，下半截就被 `.app-shell { overflow: hidden }` 裁掉了，按钮不是「跑出去」，是「被裁掉」。

最终方案三步：

1. `#result-modal.table-result-layer { position: fixed !important; inset: 0 !important; }` —— 提到视口级，彻底绕开包含块问题；
2. `fitResult()` 按 `row.clientWidth` 倒算牌宽 `--rw`，让 15 张牌（含副露分组间隔）一行放得下；放不下就进 `is-tight` 收边距字号；
3. 真的还放不下才 `is-scroll`（`overflow-y: auto` + `scrollbar-width: none`）兜底——不会出现可见拉条，但内容可达。

四种视口（1440×900 / 844×390 / 390×844 / 320×900）实测 `overflow: 0`。另外把赢家牌型抽成 `paintResultHand()`，副露按组用 `.result-meld-group` 隔开，胡的那张加 `.winning-tile` 高亮——比原来只显示手牌信息量大得多。

### 5.28 每日福利：为什么「首日不发」

`daily = { day, login, free }`，靠 `dayKey()` 比自然日。设计上有个小坑要提前定：**注册当天算不算「每日登录礼」**？

如果算，玩家注册完会先拿到见面礼、再被弹一个「每日登录礼 +4,000」，等于同一个动作发两次钱。所以 `claimDailyLogin` 对「第一次见到这个账号」返回 `{ ok: false, code: 'first-day' }`——只盖章不发钱，第二天才开始真正发。免费领银币不受这个限制（它本来就是「主动点」的行为）。

`dayKey` 变化时 `freeUsed` 自动归零、`loginTaken` 自动复位，不需要定时任务。

### 5.29 这一轮的测试

```
npm test              118 条全通过（新增 3 条：无庄家 / 每日登录礼 / 免费领银币）
npm run test:browser   44 条全通过（新增 3 条：免费领银币 / 结算自适应 / 被接牌遮罩）
npm run test:cloud      8 条全通过
```

新增的三条浏览器用例值得单独说：

1. **免费领银币**：点一次按钮 → 银币 `+4,000`、计数变 `1/10`、顶栏数字同步刷新；
2. **结算显示完整牌型且不出滚动条**：在三个视口下断言 `overflowY <= 2`、`is-scroll === false`、底部按钮 `getBoundingClientRect` 全在视口内；
3. **被吃碰走的牌仍在牌河且盖遮罩**：断言那张牌还在 DOM 里、`backgroundImage` 匹配 `/gradient/`、`filter` 匹配 `/brightness/`。

另外顺手修了一条存量用例的偶发失败：`tests/browser.test.cjs` 的「手牌 hover 不位移」原来用「弃牌总数」当进度指针，但打出的牌可能立刻被下家吃走，牌河反而变少 → 改成 `discards + melds` 之和，并用 `current` / `phase` 变化兜底。

还有一个新的偶发源：云 SDK 是从公共 CDN（jsdelivr）拉的，CDN 抽风时 `requestfailed` 会记一条 `net::ERR_CONNECTION_CLOSED`，让**跟云端毫无关系**的用例（比如「对手出牌后局面推进」）变红。这跟之前的 `CLOUD_NOISE` 是同一类问题——环境边界，不是脚本错误——所以把 CDN 域名与 `net::ERR_CONNECTION_*` 一起并进了噪声过滤器。过滤只针对网络层，本地资源 404 之类的真错误照样会冒出来；真实的云端连通性仍由 `tests/cloud-live.cjs` 在发布域名上验。加完之后连跑三轮 `44/44`。

## 五之后（六）：品牌、首页、三种玩法与那个"换桌"浮层（v0.9.0）

### 5.30 名字：为什么是「红河麻将」

石屏、宝秀、个旧三个玩法都在**红河州**：石屏县、宝秀镇（属石屏）、个旧市。要往一个 App 里塞三种地方麻将，用一个县级名字当平台名是拧巴的——所以拆成两层：

- **平台名 = 红河麻将**（`js/ui.js` 里的 `BRAND`，`[data-brand]` 由 `applyBrand()` 统一填）；
- **玩法名 = 石屏麻将 / 宝秀麻将 / 个旧麻将**（`js/core.js` 的 `VARIANTS`）。

这样以后加宝秀、个旧，不用再改一次品牌。备选名还有「滇南麻将」「临安牌局」，选了「红河」是因为它对三个玩法都成立、且本地人一看就知道是家乡牌。

### 5.31 Logo：元素越少越立得住

标画在 `index.html` 的 SVG 雪碧里（`#i-logo`），不额外请求图片。构图按"能不能在 24px 认出来"倒推：

1. 玉绿圆盘（径向渐变）+ 金色双环——远看是一个"牌九/筹码"的圆；
2. 中间一张竖着的象牙色麻将牌；
3. 牌面上一个「筒」（绿环 + 红心）；
4. 牌面下部两道水纹，一绿一红——红河。

前两版画复杂了（牌里再套牌、加祥云），缩到 32px 就成灰点。现在这一版在 16px 只剩"绿点 + 白牌"，但轮廓仍成立；180px 下单看也不寒酸。左上角、启动页、浏览器 favicon 用的是同一个符号，favicon 是同一套形状压成的 data URI。

### 5.32 那个"开局后中间冒出换桌 / 分享好友"，是 CSS 权重

上一轮为了让结算面板不被牌桌裁掉，我写了：

```css
#result-modal.table-result-layer{ display:flex!important; ... }
```

而"关掉它"靠的是更早的一条 `.table-result-layer.hidden{ display:none!important }`。两条都带 `!important` 时比的是**选择器权重**：`#result-modal.table-result-layer` 是「id + class」，`.table-result-layer.hidden` 是「class + class」——前者赢。于是 `hidden` 类加了等于没加，结算层从进桌那一刻就一直铺在牌桌中间，那三个按钮（换桌 / 分享好友 / 继续）自然一直挂着。

修法不是删 `!important`（那会退回"牌桌比视口高时按钮被裁"的老问题），而是补一条**同权重**的隐藏规则：

```css
#result-modal.table-result-layer.hidden{ display:none!important }
```

用例用 `getComputedStyle(...).display === 'none'` 钉住，再加一条 `elementFromPoint` 验手牌点得到——浮层如果在，整屏都会拦截点击，这条比看 `display` 更接近"玩家真的能操作"。

### 5.33 首页改版与布局统一

- **昵称框删了**：改昵称本来就有一套（点头像 → 账号浮层 → 改昵称），大厅再放一个输入框是两套入口。相应地 `lobbyNickValue()` 改成直接取档案昵称，`doRandomNick()` 整个删掉。
- **三种玩法**：`.lobby-modes` 是三列网格，石屏实心金边 + 底部指示条，宝秀 / 个旧虚线边框 + 右上角「锁」。**没有用 `disabled`**——灰掉的按钮会被读成"功能坏了"，现在能点、点了一句"规则还在整理"，并且不会抢走选中态。
- **布局统一**：原来大厅的两栏布局只在 `@media (orientation:landscape) and (max-height:560px)` 下生效，于是电脑宽屏（1440×900）是一根竖条、手机横过来又是另一套。改成只判 `orientation:landscape`，两边长得一样；竖屏窄屏才回退单栏，顶栏用 `order` 拆成两行（品牌 + 领银币 + 声音 / 账号条），DOM 顺序没动。
- **`flex-wrap` 的坑**：改成两栏后内容被顶到屏幕上半部分——因为多行 flex 容器的 `align-content` 默认是 `stretch`，四行均分高度、每行内部再居中。加 `align-content:center` 才真正垂直居中。
- **银币到账**：`playSound` 的音色表里原本**没有** `coin`，`bank[kind] || bank.ui` 让"领银币"退化成一个极短的 880Hz 提示音，基本听不出是钱。补了一条三音叠加（988 → 1319 → 1976Hz，B5 → E6 上行五度 + 高频泛音），并在按钮下方飘一个 `+4,000`、钱包数字弹一下。

### 5.34 这一轮的测试

```
npm test              118 条全通过
npm run test:browser   49 条全通过（外壳新增 5 条）
npm run test:cloud      8 条全通过
```

新增的五条都在外壳层，验的是"玩家眼睛里能看到的东西"：

1. 品牌标真的是 SVG、真的在左上角（`left < 80 && top < 40`）、网页标题是「红河麻将」、头像浮层里仍有「改昵称」；
2. 三格玩法：只有一个选中、两个锁、点锁的那格要有说明且不能抢走选中态；
3. 免费领银币：**直接数 `AudioContext.createOscillator` 被调用几次**（≥3 才算响了一声），再加 `+4,000` 飘字与计数 `1/10`；
4. 结算浮层回归：`display === 'none'` + `elementFromPoint` 命中手牌；
5. 1440×900 与 844×390 的 `.lobby` 都必须是 `flex-direction: row`、品牌名 `text-align: left`。

## 五点七、v0.10.0：标题裁切 / 杠分 / 闪电 / 真牌墙 / 立直机皮肤

1. **「标准胡牌」被裁半截**：结算标题是 `position:absolute; top:-14px` 挂在面板外沿——`overflow:hidden` 的面板直接把它上半截吃掉。改成标题在文档流里（`margin:0 auto -14px` 占位），三处 `padding-top`（基础 34 / `is-tight` 24 / 横屏 22）联动降到 8px。教训：**绝对定位的"挂牌"永远会被 overflow:hidden 咬**，要么放进文档流，要么给面板留 padding。
2. **杠分**：内核 `scoreKong` 早就记了 `kongLog`（明杠/暗杠/补杠），但结算只用段位分没管银币。现在 `computeRound` 接 `kongs`：`per = baseBet × {明:1, 补:1, 暗:2}`，三家各付 per。胡牌时"杠分先过账再付胡牌钱"（`have = 余额 + 杠分`），荒牌也照收杠分。结算面板逐条列「暗杠 +12,000」。单测钉死零和。
3. **闪电**：白光炸屏（radial-gradient 一闪）→ SVG 闪电抖三下 → 胡牌张 `is-struck` 高亮，配雷声（白噪声炸响 + 滚雷尾巴 + 58/38Hz 低频）。坑有两个：`.result-hand-row` 是 `overflow:hidden`，贴牌的伪元素被裁半截 → 闪电挂结算层按坐标定位；SVG 里 `filter:blur` 在非等比拉伸时露方框 → 改用三层描边当光晕。
4. **牌墙**：原来西东两面是"贴图绿条"、北南干脆 `display:none`。现在 JS 按剩余牌生成 17 墩/面的 `.ws` 砖块，摸牌时从开牌位的对面开始收——四边可见砖块之和 = `ceil(剩余牌/2)`。`!important` 又立功又埋雷：第 10 节 `display:block!important` 压住新规则，最后用 `.table-screen` 前缀提高权重才生效。
5. **立直机皮肤**：发现牌面/牌背**从一开始就是 FluffyStuff 立直 SVG**（`assets/mahjong/`，见 ASSET-NOTICE.md，公有领域），所以第 6 条需求只差"机台氛围"：`body.skin-riichi` 把实景照片背景换成深绿机台房、桌框换回胡桃木、绒面换回经典深绿金圈。设置面板加「立直牌面」开关，即时生效、`localStorage` 记忆，关掉就是原来的实景桌——正好满足"不行就回滚"。中间试过下载 PNG 版牌面做换肤，发现是重复造轮子（被 `!important` 压成死代码）后删除。
6. 测试：`npm test` 120 / `test:browser` 55 / `test:cloud` 8。

## 六、试玩方式

1. **本地跑**（推荐，功能完整）：
   ```bash
   cd shiping-mahjong-ai
   python3 -m http.server 8080     # 或 npm run serve
   # 浏览器打开 http://127.0.0.1:8080/
   ```
   打开 `http://127.0.0.1:8080/?debug=1` 会额外暴露调试接口与调试日志按钮。

2. **直接开文件**：双击 `index.html` 也能玩，只是调试接口在 `file://` 下不启用。

3. **独立在线预览（v0.8.0 已覆盖更新，与 gh-pages 无关）**：
   <https://shiping-mahjong-ai.app.workbuddy.host/?sharecode=2MS3R37OYC>
   该地址由本次项目目录单独发布，原线上 `gh-pages`（`https://seexx2-svg.github.io/word-kingdom-web/`）**没有**被改动。

   发布时踩了个坑，记在这里：`package.json` 里的 `serve` 脚本是给本地用的 `python3 -m http.server 8080`，**硬编码了 8080**。发布器会自动探测这个脚本当启动命令，于是沙箱里起在了 8080，而平台只认 `$PORT`（3000），报 `SITES_START_FAILED: port 3000 NOT listening`。而且沙箱执行 `startCmd` 时并没有把 `$PORT` 展开（实测被展开成空串），所以启动命令必须写成**字面端口**：

   ```
   startCmd = python3 -m http.server 3000 --bind 0.0.0.0
   ```

   本地的 `npm run serve` 保留不动，两边互不影响。

4. 源码地址：<https://github.com/seexx2-svg/word-kingdom-web/tree/ai-mahjong-next/shiping-mahjong-ai>

## 七、调试接口（仅 localhost / ?debug=1 暴露）

| 接口 | 用途 |
| --- | --- |
| `__shipingMahjongDebug()` | 当前状态快照：阶段、当前玩家、手牌/弃牌/副露张数、接牌队列、AI 任务、日志尾部 |
| `__shipingMahjongLogs()` | 完整调试日志（时间 / 阶段 / 玩家 / 操作 / 来源 / 队列 / 任务状态） |
| `__shipingMahjongAutoPlay(n,{speed})` | 连打 n 局，返回每局结果 |
| `__shipingMahjongSetSpeed(v)` | 动画倍速（0 = 最快） |
| `__shipingMahjongDropAiTask()` | 人为丢弃 AI 任务，验证心跳自愈 |
| `__shipingMahjongForceChi()` / `ForceMelds()` / `ForceWin()` | 构造吃牌 / 四家副露 / 胡牌现场，用于视觉回归 |
| `__shipingMahjongDiceFaces()` | 骰子最终点数与掷骰记录 |
| `__shipingMahjongShell()` | 外壳快照：当前界面、账号（银币/金条/段位/战绩）、场次、底注、结算、已打开的弹层 |
| `__shipingMahjongRegister(a,p,nick,skip)` / `Login(a,p)` / `Logout()` | 绕过输入框注册 / 登录 / 登出 |
| `__shipingMahjongAuth()` | 认证状态：记住的账号、历史账号、是否记住、当前 provider id |
| `__shipingMahjongLoginForm()` | 登录弹窗状态：是否打开、账号值、密码 type、记住勾选、提示文字、是否提交中 |
| `__shipingMahjongAccountMenu(force)` | 打开 / 关闭主界面账号浮层，返回是否可见 |
| `__shipingMahjongEnterHome()` / `SkipSeason()` / `OpenHall()` / `StartTable(id)` | 直接跳主界面 / 跳过赛季 / 开场次 / 进指定场次 |
| `__shipingMahjongOpenSignin()` / `OpenBack()` | 打开签到 / 回归好礼 |
| `__shipingMahjongResetProgress()` | 清空本机账号与赛季标记，回到启动页 |
| `__shipingMahjongOnlineStart(o)` | 不走真实匹配，按指定 `seed / mySeat / humanCount / names` 直接开一局联机牌桌 |
| `__shipingMahjongOnline()` | 联机快照：房间号、我的座位、真人数量、名字、seq、最近拉取、当前等待者、是否卡远端 |
| `__shipingMahjongRemote(seat, action)` | 以对手身份注入一个动作（模拟收到别人的出牌 / 吃碰） |

## 八、已知限制

- **已发布到 `https://shiping-mahjong-ai.app.workbuddy.host/?sharecode=2MS3R37OYC`**（覆盖了 6 月那版），发布后在线上域名实测：`Cloud.status().ready === true`、数据面探针 `rows=0` 无报错、登录弹窗正常、控制台无脚本错误——说明**云端 Origin 与发布域名对得上**。剩下的只有真人收码那一步。
- **短信与扫码授权未做人工验收**，自动化只证明了通道存在，见 5.17。
- **游客进度仍存本机**，这是刻意的：游客本来就是"先试试"，不该占云端一行数据。换成手机号登录后，档案会新建一份，游客那份不会迁移过来。
- **排行榜/天梯是空壳**。`mahjong_rounds` 已经在存明细，但榜单聚合查询与前端展示还没做——现在只有本人的战绩。
- **个旧 / 宝秀尚未开放**：规则细节（牌张、胡型、烂牌胡判定、吃牌限制、分表）需要确认后才填。按本轮要求，它们的入口已经从界面上整个拿掉了，不是置灰。
- **联机两端互通没有自动化证据**：本地起服务时云数据面因 Origin 不匹配拒写，造会话又被 `signUp requires a verificationToken` 堵死。单端能验的都验了（座位旋转等价、真人座位不被抢手、注入动作后推进、出牌触发声音），两台真机的完整互通要按 README 的五步清单人工走一遍。
- **联机是信任客户端的**：动作日志没有服务端复核，四人牌友局够用；要开公开大厅防作弊，判胡与结算必须挪到服务端。
- **出牌延迟下限 = 轮询间隔**（800ms），网络差时一手可能等 1~2 秒。纯静态站没有常驻进程，这是不引入自建服务器的代价。
- 天梯榜、比赛场、约牌等依赖服务端的功能一律只给提示，不编造排名或对手。
- AI 仍沿用原有的启发式（保留对子与搭子，能吃碰杠胡就吃碰杠胡），本次没有改动策略强度。
- 牌桌布局在 1440×900 与 390×844 两种尺寸下逐像素校验过；极端窄高比（如 320×900）会出现手牌区横向滚动，但不会溢出页面。
- 浏览器测试依赖本机安装的 Chrome 或 Edge（`playwright-core` 不下载浏览器），无浏览器的环境只能跑 `npm test`。
