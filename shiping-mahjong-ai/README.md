# 石屏麻将（浏览器单机版）

这是一个原生 HTML/CSS/JavaScript 网页麻将游戏，无需安装游戏引擎、无构建步骤。

> **本目录是 `ai-mahjong-next` 分支的开发副本**，由 `shiping-mahjong/` 原样复制后继续开发。
> 原目录 `shiping-mahjong/` 与线上 `gh-pages` 均未被改动。
> 本次改动要点：回合状态机重构（修卡死）、出牌动画、吃碰杠副露展示、3D 骰子、桌内胡牌结算、四家牌桌布局重排、本地玩家档案与玩法大厅（个旧 / 宝秀占位）。
> 详细说明见 [`docs/DEVELOPMENT-REPORT.md`](docs/DEVELOPMENT-REPORT.md)，截图见 `docs/screenshots/`。

## 运行
直接双击 `index.html` 也可以开始。牌面素材随项目保存在 `assets/mahjong/`（SVG）与 `assets/tiles/`（PNG），无需访问外部图片 CDN。

推荐用本地服务器运行（调试接口需要 http 环境）：

```bash
python3 -m http.server 8080     # 或 npm run serve
# 打开 http://127.0.0.1:8080/
```

**在线试玩（本次独立部署，不影响 gh-pages）**：<https://shiping-mahjong-ai.app.workbuddy.host/?sharecode=2MS3R37OYC>

## 本地大厅（玩家档案 · 积分账本 · 玩法选择）

点左上角品牌区（或菜单里的「大厅」）打开：

- **玩家档案**：可建多个本地档案，切换即切换视角；每个档案独立累计各玩法积分与战绩（局数 / 胡牌次数）。
- **玩法选择**：当前只有「石屏麻将」开放；「个旧麻将」「宝秀麻将」是占位卡片（置灰、不可点），规则确认后只需在 `js/core.js` 的 `VARIANTS` 里补上 `defaults` 与 `scoring` 并置 `available: true`。
- **积分账本**：每局结束按 `score[0]` 累加到当前档案，按玩法分开记账，存在浏览器 localStorage，刷新不丢。
- 存储层已抽成 `loadProfiles / saveProfiles / saveActiveProfile`，将来接云端账号只需替换这几个函数的实现，界面层不用改。

## 测试

```bash
npm test              # 规则 + 玩法变体 + 人机模拟（33 条，纯 Node，无需浏览器）
npm run test:browser  # 真实浏览器测试（16 条，需要本机 Chrome/Edge 与 npm i）
npm run test:all      # 两者都跑
```

## 规则
- 136 张：万、筒、条、东南西北中发白；每张 4 张，无花牌、无混儿。
- 庄家 14 张，其他玩家 13 张；三名电脑玩家。
- 吃上家、碰任意家；明杠、暗杠、补杠；杠后补牌。
- 标准胡：4 副顺子/刻子 + 一对将；支持自摸、点炮。
- 烂牌胡：14 张不重复；字牌不限；每门数牌只允许落在 147、258、369 的一组点数。
- 计分：杠 +3/-1/-1/-1；自摸 +9/-3/-3/-3；点炮 +4/-2/-1/-1。
- 吃、碰、杠、烂牌胡可以分别开关，保存至浏览器 localStorage。

## 文件
- `index.html`：页面结构（含大厅）
- `styles.css`：牌桌、响应式布局和静态本地牌面图片路径
- `js/core.js`：牌库、玩法变体注册表、胡牌判定、操作与计分
- `js/ui.js`：单机对局、界面交互、本地档案与积分账本

## 牌面素材与许可
牌面 PNG 已复制到 `assets/tiles/`，共 35 张（万、筒、条、字牌和牌背），CSS 使用逐一列明的相对 `url()` 路径，可静态扫描。素材来自 [tiansh/tjmj](https://github.com/tiansh/tjmj)，其原页面注明牌面由 Jerry Crimson Mann 绘制、来源 Wikipedia。各图片的具体许可及再分发条件以对应原始文件页为准，见 `THIRD-PARTY-NOTICES.md`。

## 开源
本项目代码按 GPL-3.0-or-later 发布。