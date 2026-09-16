# 单词小王国 · Word Kingdom 1.0

> 一个纯前端的英语单词学习游戏：拼写闯关、词源卡片、收藏错题、每日任务。
> 词库内置 2074 条国中基础词，运行时无需联网读取词库，开箱即玩。

版本：1.0

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 拼写闯关 | 10 个关卡，从「新手村」到「终极挑战」，难度与倍率递增 |
| 词源学习卡 | 每个词条附中文释义、词性、例句、Etymonline 中文站词源 |
| 收藏 & 错题本 | 收藏生词、自动记录错题，针对性复习 |
| 每日任务 | 每日 3 次任务，连击 streak 系统 |
| 等级 & 经验 | XP 升级、金币、生命值机制 |
| 音效开关 | 可一键切换音效 |

## 项目结构

```
word-kingdom-web-1.0/
├── index.html                  # 网页入口
├── app.js                      # 主程序（游戏逻辑、状态管理、渲染）
├── style.css                   # 样式
├── wordbook.js                 # 内置词库（2074 条，自动构建生成，勿手动编辑）
├── wordbook-2000-source.json   # 词库数据来源说明
├── opencc_map.json             # 繁简转换映射表
├── simplified-map.json         # 简化映射表
├── build-wordbook.mjs          # 词库构建脚本（Node.js 20+）
├── build-wordbook-fixed.mjs    # 词库构建脚本（修复版）
├── 一键构建词库.bat             # Windows 一键构建入口
├── assets/
│   ├── favicon.png             # 网页图标
│   └── word-kingdom-icon-512.png
├── VERSION.txt                 # 版本信息
└── README.md                   # 本文件
```

## 快速开始

### 在线 / 本地直接运行

1. 直接用浏览器打开 `index.html` 即可，无需安装任何依赖。
2. 或将整个目录部署到任意静态托管服务（GitHub Pages、Vercel、Netlify 等）。

### 部署到 GitHub Pages

1. Fork 或推送到自己的 GitHub 仓库。
2. 仓库 → Settings → Pages → Source 选择 `main` 分支 / 根目录。
3. 等待约 1 分钟，通过 `https://<用户名>.github.io/<仓库名>/` 访问。

## 词库构建（可选）

词库 `wordbook.js` 已内置，普通用户无需重新构建。
若需更新或重建词库（拉取最新词表 + 词源），需 Node.js 20+：

```bash
# 方式一：Windows 一键构建
./一键构建词库.bat

# 方式二：手动执行
node build-wordbook.mjs --workers 2 --delay 800

# 可选参数
#   --workers N      并发数（1-6，默认 2）
#   --delay MS       每次请求间隔毫秒（默认 800）
#   --refresh-ety    强制重新拉取词源
```

构建过程会：
1. 从 [deanliao/vocab_tutor](https://github.com/deanliao/vocab_tutor) 拉取 2074 条词表与中文释义。
2. 从 [Etymonline 中文站](https://www.etymonline.com/cn) 拉取每个词条的词源（断点续跑、自动重试）。
3. 清洗、去重、生成 `wordbook.js`。

> Etymonline 是外部网站，请合理控制请求速率并遵守其网站条款。

## 数据来源

| 数据 | 来源 |
| --- | --- |
| 词表 + 中文释义 + 音标 + 例句 | [deanliao/vocab_tutor](https://github.com/deanliao/vocab_tutor)（公开项目） |
| 词源（中文） | [Etymonline 中文站](https://www.etymonline.com/cn) |
| 繁简转换 | 内置 `opencc_map.json` / `simplified-map.json` |

## 技术栈

- 纯原生 HTML / CSS / JavaScript，无框架、无构建工具、无后端。
- 状态使用 `localStorage` 持久化。
- 词库以 `window.WORD_BOOK` 全局变量注入，离线可玩。

## 浏览器兼容

- 推荐 Chrome / Edge / Firefox 最新版。
- 移动端浏览器同样支持（已做响应式与 viewport 适配）。

## 许可与致谢

- 本项目代码可自由使用与二次开发。
- 词库数据来源于上述公开项目与网站，版权归原作者所有。
- 感谢 [deanliao/vocab_tutor](https://github.com/deanliao/vocab_tutor) 与 [Etymonline 中文站](https://www.etymonline.com/cn) 提供的优秀资源。
