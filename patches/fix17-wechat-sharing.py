#!/usr/bin/env python3
"""Apply Word Kingdom FIX17 WeChat Mini Program sharing repair.

Usage:
  python patches/fix17-wechat-sharing.py /path/to/WeChat-MiniProgram-1.0
"""
from pathlib import Path
import json
import re
import sys

PAGES = {
    "index": ("pages/index/index", "把单词小王国分享给朋友，一起闯关学英语！", False),
    "levels": ("pages/levels/levels", "来单词小王国挑战英语闯关！", False),
    "connect": ("pages/connect/connect", "来单词小王国玩单词连线，一起学英语！", True),
    "search": ("pages/search/search", "来单词小王国找隐藏单词，挑战一下！", True),
    "guess": ("pages/guess/guess", "来单词小王国猜英语单词，看看你能答对几题！", True),
    "hangman": ("pages/hangman/hangman", "来单词小王国玩猜字游戏，一起挑战！", True),
    "spelling": ("pages/spelling/spelling", "来单词小王国背英语单词，边玩边学！", False),
    "library": ("pages/library/library", "来单词小王国整理单词本，一起学英语！", False),
}

def main(root: Path):
    if not (root / "app.json").exists():
        raise SystemExit(f"Not a WeChat mini-program root: {root}")
    for name, (page_path, title, has_stage) in PAGES.items():
        js = root / "pages" / name / f"{name}.js"
        source = js.read_text(encoding="utf-8")
        suffix = " + `?stage=${stage}`" if has_stage else ""
        query = "`from=timeline&stage=${stage}`" if has_stage else "'from=timeline'"
        block = (
            "  onShareAppMessage() {\n"
            "    const stage = Number(this.stage || (this.data && this.data.stage) || wx.getStorageSync('wg_stage') || 1);\n"
            f"    return {{ title: '{title}', path: '/{page_path}'{suffix} }};\n"
            "  },\n"
            "  onShareTimeline() {\n"
            "    const stage = Number(this.stage || (this.data && this.data.stage) || wx.getStorageSync('wg_stage') || 1);\n"
            f"    return {{ title: '{title}', query: {query} }};\n"
            "  },\n"
        )
        if "onShareAppMessage()" in source:
            source, count = re.subn(
                r"  onShareAppMessage\(\) \{.*?  onShareTimeline\(\) \{.*?  \},\n",
                block, source, count=1, flags=re.S
            )
            if count != 1:
                raise SystemExit(f"Could not update sharing callbacks in {js}")
        else:
            source = source.replace("Page({", "Page({\n" + block, 1)
        js.write_text(source, encoding="utf-8")

        config_path = root / "pages" / name / f"{name}.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["enableShareAppMessage"] = True
        config["enableShareTimeline"] = True
        config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    wxml = root / "pages/index/index.wxml"
    source = wxml.read_text(encoding="utf-8")
    if 'open-type="share"' not in source:
        source = source.replace(
            '<view class="stat-grid">',
            '<view class="quick-row share-entry"><button class="quick" open-type="share">📤 分享给好友</button>'
            '<view class="sub share-tip">分享到朋友圈：点击右上角“···”菜单</view></view>\n<view class="stat-grid">',
            1,
        )
        wxml.write_text(source, encoding="utf-8")

    wxss = root / "app.wxss"
    source = wxss.read_text(encoding="utf-8")
    if ".share-entry" not in source:
        source += "\n/* FIX17: WeChat sharing entry */\n.share-entry{align-items:center;gap:8rpx;margin:14rpx 0 4rpx}.share-entry .quick{flex:0 0 auto;min-width:220rpx}.share-tip{font-size:22rpx;line-height:1.4}\n"
        wxss.write_text(source, encoding="utf-8")
    print("FIX17 sharing repair applied to eight pages.")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Pass the path to the WeChat-MiniProgram-1.0 directory.")
    main(Path(sys.argv[1]).resolve())
