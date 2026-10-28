# FIX17 — WeChat Mini Program sharing repair

This repository's current main source is the cross-platform web app. The uploaded release bundle also includes a WeChat Mini Program; this patch script keeps its sharing fix tracked here.

## What it changes
- Adds `onShareAppMessage` and `onShareTimeline` callbacks to all eight Mini Program pages.
- Enables friend sharing and Moments sharing in each page's JSON configuration.
- Adds a visible “分享给好友” button on the home page.
- Preserves the selected stage when sharing a game page.

## Apply
Run:

```bash
python patches/fix17-wechat-sharing.py /path/to/WordKingdom-1.0-All-Platforms/WeChat-MiniProgram-1.0
```

Then import the Mini Program folder in WeChat Developer Tools. Source-level checks passed for the FIX17 release bundle; final sharing behavior still needs confirmation in WeChat Developer Tools and on a real device. Moments sharing can depend on the WeChat client/base library and account eligibility.
