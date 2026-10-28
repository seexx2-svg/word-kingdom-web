# FIX22 — all-platform source sync

This release archive is the FIX22 source of truth and contains 214 ZIP entries covering:

- Web (the repository's root application)
- WeChat Mini Program
- Douyin Mini Program
- iOS project
- Shared project notes and validation records

Changes in FIX22:
1. WeChat word search now offers “下一题” after both target words are found and starts a fresh puzzle/timer.
2. WeChat and Douyin level-map controls are larger, wrap text, and constrain widths to reduce overflow.
3. WeChat home shows score alongside lives.
4. WeChat share control is a compact square icon independent of the title row.

## Syncing the complete archive into this repository

The GitHub connector can commit text files, but it does not expose a binary-archive upload operation. The full archive therefore still needs to be copied into a local clone before every platform source file and binary asset exists in GitHub.

Use `patches/sync-fix22-platforms.py` with the FIX22 ZIP produced for this release:

```bash
python patches/sync-fix22-platforms.py --archive /path/to/WordKingdom-1.0-All-Platforms-fix22-search-map-score-share.zip --repo .
git status
git add -A
git commit -m "Sync Word Kingdom FIX22 all-platform sources"
git push origin main
```

Or add `--commit --push` to the script to perform the last three steps automatically. Run from a trusted local clone and review `git status` before pushing. Automated source checks do not substitute for device testing.
