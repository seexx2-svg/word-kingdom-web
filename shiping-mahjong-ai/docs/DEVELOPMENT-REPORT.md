# 石屏麻将 · ai-mahjong-next 开发报告

> 分支：`ai-mahjong-next`　目录：`shiping-mahjong-ai/`
> 基线：`shiping-mahjong` 分支（提交 `845dd27`）的完整源码
> 版本：`0.2.0`（`package.json`）

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
5. **本地调试会刷一屏 401/400**。`127.0.0.1` 不在云端白名单里，每次打开都会有几条失败请求。这不是 bug，但会把"无控制台报错"的断言冲红——测试里把 `.cloud/` 相关噪声分流到单独的 `page.__cloudNoise`，正文断言只看真脚本错误。
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

这两条的验收步骤写在 `README.md` 的「四步人工验证清单」里，需要你拿手机走一遍。

数据面是干净的：`mahjong_players` 0 行、`mahjong_rounds` 0 行，测试没有往真库里塞垃圾数据。

## 六、试玩方式

1. **本地跑**（推荐，功能完整）：
   ```bash
   cd shiping-mahjong-ai
   python3 -m http.server 8080     # 或 npm run serve
   # 浏览器打开 http://127.0.0.1:8080/
   ```
   打开 `http://127.0.0.1:8080/?debug=1` 会额外暴露调试接口与调试日志按钮。

2. **直接开文件**：双击 `index.html` 也能玩，只是调试接口在 `file://` 下不启用。

3. **独立在线预览（本次新部署，与 gh-pages 无关）**：
   <https://shiping-mahjong-ai.app.workbuddy.host/?sharecode=2MS3R37OYC>
   该地址由本次项目目录单独发布，原线上 `gh-pages`（`https://seexx2-svg.github.io/word-kingdom-web/`）**没有**被改动。

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

## 八、已知限制

- **账号与经济已进云端，但线上那张分享链接还是旧版**。云端 `endpoint` 就是 `shiping-mahjong-ai.app.workbuddy.host`，域名要对得上才能登录，所以在重新发布之前，线上地址仍是 6 月的旧页面（没有登录页），只能本地跑。
- **短信与扫码授权未做人工验收**，自动化只证明了通道存在，见 5.17。
- **游客进度仍存本机**，这是刻意的：游客本来就是"先试试"，不该占云端一行数据。换成手机号登录后，档案会新建一份，游客那份不会迁移过来。
- **排行榜/天梯是空壳**。`mahjong_rounds` 已经在存明细，但榜单聚合查询与前端展示还没做——现在只有本人的战绩。
- **个旧 / 宝秀尚未开放**：规则细节（牌张、胡型、烂牌胡判定、吃牌限制、分表）需要确认后才填。现在点它们不会生效。
- 天梯榜、比赛场、约牌等依赖服务端的功能一律只给提示，不编造排名或对手。
- AI 仍沿用原有的启发式（保留对子与搭子，能吃碰杠胡就吃碰杠胡），本次没有改动策略强度。
- 牌桌布局在 1440×900 与 390×844 两种尺寸下逐像素校验过；极端窄高比（如 320×900）会出现手牌区横向滚动，但不会溢出页面。
- 浏览器测试依赖本机安装的 Chrome 或 Edge（`playwright-core` 不下载浏览器），无浏览器的环境只能跑 `npm test`。
