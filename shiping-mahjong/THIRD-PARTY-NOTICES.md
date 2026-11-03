# 第三方素材及致谢

本项目采用了 [tiansh/tjmj](https://github.com/tiansh/tjmj) 项目中的麻将牌面 PNG 图（目录为 `tp/w`、`tp/b`、`tp/t`、`tp/z` 和 `tp/h.png`），现以未修改的原文件复制到本项目的 `assets/tiles/` 目录。牌图来源说明见该项目 `index.html`：牌面由 Jerry Crimson Mann 绘制，来自 Wikipedia。

牌面图通过 CSS 相对 `url()` 引用本仓库中的本地文件，不再依赖上游图片 CDN。原项目代码声明 GPL v3；本项目规则引擎和页面代码采用 GPL-3.0-or-later。对每张 Wikipedia 图片的单独文件许可，仍应以其原始 Commons/Wikipedia 文件页标注为准；本项目不对未核实的图片许可作额外声明。

上游项目：<https://github.com/tiansh/tjmj>
原始页面声明：GPL version 3；牌面作者/来源说明见上游 `index.html`。