#!/usr/bin/env python3
"""FIX18 patch helper for Word Kingdom's WeChat Mini Program.

Run against the WeChat-MiniProgram-1.0 directory in the full release ZIP.
The official FIX18 ZIP already contains these edits; this script is for applying
the same changes to a separate working copy.
"""
from pathlib import Path
import json
import sys

def replace_once(path, old, new):
    s = path.read_text(encoding="utf-8")
    if new in s:
        return
    if old not in s:
        raise SystemExit(f"Expected source fragment not found in {path}")
    path.write_text(s.replace(old, new, 1), encoding="utf-8")

def main(root):
    root = Path(root)
    replace_once(root/"pages/index/index.wxml",
      '<view class="quick-row share-entry"><button class="quick" open-type="share">📤 分享给好友</button><view class="sub share-tip">分享到朋友圈：点击右上角“···”菜单</view></view>',
      '''<view class="share-panel">
  <button class="share-cta" open-type="share" hover-class="share-cta-hover">
    <view class="share-icon">↗</view>
    <view class="share-copy"><view class="share-title">邀请好友一起闯关</view><view class="share-desc">分享单词小王国，边玩边学英语</view></view>
    <view class="share-arrow">›</view>
  </button>
  <view class="share-moments"><text class="share-sparkle">✦</text> 也可以点击右上角「···」分享到朋友圈</view>
</view>''')
    sound = root/"utils/sound.js"
    replace_once(sound,
      "const MUSIC_MIGRATION_KEY='wk_music_singleton_v4';\nif(wx.getStorageSync(MUSIC_MIGRATION_KEY)!=='1'){wx.setStorageSync('wg_music','0');wx.setStorageSync(MUSIC_MIGRATION_KEY,'1');}\nconst app=typeof getApp==='function'?getApp():null;const gd=app&&app.globalData?app.globalData:{};\nconst pools={},cursor={};let music=gd.__wkMusicContext||null;let musicOn=wx.getStorageSync('wg_music')==='1';",
      "const MUSIC_DEFAULT_KEY='wk_music_default_on_v1';\nif(wx.getStorageSync(MUSIC_DEFAULT_KEY)!=='1'){if(wx.getStorageSync('wk_music_singleton_v4')==='1'||wx.getStorageSync('wg_music')==='')wx.setStorageSync('wg_music','1');wx.setStorageSync(MUSIC_DEFAULT_KEY,'1');}\nconst app=typeof getApp==='function'?getApp():null;const gd=app&&app.globalData?app.globalData:{};\nconst pools={},cursor={};let music=gd.__wkMusicContext||null;let musicOn=wx.getStorageSync('wg_music')!=='0';")
    app = root/"app.js"
    replace_once(app,
      "onShow(){}",
      "onShow(){try{require('./utils/sound').resumeMusic()}catch(e){}}")
    indexjs = root/"pages/index/index.js"
    replace_once(indexjs,
      "const {isMusicOn}=require('../../utils/sound');",
      "const {isMusicOn,resumeMusic}=require('../../utils/sound');")
    replace_once(indexjs, "onShow(){this.sync()},", "onShow(){resumeMusic();this.sync()},")
    levels = root/"pages/levels/levels.wxss"
    s = levels.read_text(encoding="utf-8")
    marker = "/* FIX15: compact map for narrow phones. */"
    if marker in s:
        s = s[:s.index(marker)]
        levels.write_text(s, encoding="utf-8")
    if "FIX18: responsive level map" not in levels.read_text(encoding="utf-8"):
        with levels.open("a", encoding="utf-8") as f:
            f.write("""
/* FIX18: responsive level map; keep labels readable on narrow phones */
.level-page{min-height:100vh;height:auto;overflow-x:hidden}
.level-page .container.level-container{width:100%;max-width:1100rpx;padding:24rpx 24rpx 72rpx;box-sizing:border-box}
.level-page .map-card{width:100%;padding:20rpx 16rpx 24rpx;box-sizing:border-box}
.level-page .level-row{width:100%;min-width:0;gap:12rpx;min-height:126rpx}
.level-page .level-rail{width:66rpx;flex:0 0 66rpx}
.level-page .node-number{width:54rpx;height:54rpx;font-size:24rpx}
.level-page .level-card{min-width:0;padding:15rpx 16rpx}
.level-page .level-card-top{align-items:flex-start;flex-wrap:wrap;gap:6rpx 10rpx}
.level-page .level-name{font-size:27rpx;line-height:1.25;overflow-wrap:anywhere}
.level-page .level-badge{font-size:18rpx;white-space:normal;max-width:100%}
.level-page .level-meta{font-size:19rpx;line-height:1.4;overflow-wrap:anywhere}
.level-page .level-stars{font-size:20rpx}
@media(max-width:480px){.level-page .container.level-container{padding:16rpx 14rpx 64rpx}.level-page .page-head{gap:8rpx}.level-page .page-head .title{font-size:32rpx;line-height:1.2}.level-page .page-head .sub{font-size:19rpx;line-height:1.45}.level-page .page-head .pill{font-size:17rpx;padding:7rpx 9rpx;max-width:34%;white-space:normal;line-height:1.3}.level-page .map-card{padding:12rpx 8rpx 16rpx;border-radius:18rpx}.level-page .level-row{gap:8rpx;min-height:108rpx}.level-page .level-rail{width:48rpx;flex-basis:48rpx}.level-page .node-number{width:40rpx;height:40rpx;font-size:19rpx;border-width:3rpx}.level-page .rail-line{width:4rpx;min-height:48rpx}.level-page .level-card{padding:11rpx 10rpx;border-radius:13rpx}.level-page .level-name{font-size:23rpx;line-height:1.25}.level-page .level-badge{font-size:15rpx;padding:4rpx 6rpx}.level-page .level-meta{font-size:16rpx;line-height:1.35;margin-top:5rpx}.level-page .level-stars{font-size:18rpx;margin-top:4rpx}.level-page .level-detail{padding:14rpx}.level-page .level-detail-sub{font-size:17rpx;line-height:1.55}.level-page .quick-grid{gap:8rpx}.level-page .quick{font-size:20rpx;padding:12rpx 6rpx}}
@media(max-width:340px){.level-page .level-row{gap:6rpx}.level-page .level-rail{width:40rpx;flex-basis:40rpx}.level-page .node-number{width:34rpx;height:34rpx;font-size:17rpx}.level-page .level-card{padding:9rpx 8rpx}.level-page .level-name{font-size:21rpx}.level-page .level-meta{font-size:15rpx}}
""")
    for f in root.rglob("*.json"):
        json.loads(f.read_text(encoding="utf-8"))
    print("FIX18 applied. Verify audio and sharing in WeChat Developer Tools and on a device.")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python fix18-ui-music-map.py /path/to/WeChat-MiniProgram-1.0")
    main(sys.argv[1])
