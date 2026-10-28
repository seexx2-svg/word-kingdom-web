#!/usr/bin/env python3
"""Sync all platform folders from the Word Kingdom all-platform ZIP into a repo clone.

Example:
  python patches/sync-fix22-platforms.py --archive /path/to/WordKingdom-1.0-All-Platforms-fix22-search-map-score-share.zip --repo .
  python patches/sync-fix22-platforms.py --archive /path/to/package.zip --repo . --commit --push
"""
from __future__ import annotations
import argparse
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

PLATFORMS = ("Web-1.0", "WeChat-MiniProgram-1.0", "Douyin-MiniProgram-1.0", "iOS-1.0")
ROOT_DOCS = (
    "README.txt", "CROSS_PLATFORM_SYNC.md", "BUILD_STAMP.txt",
    "VALIDATION.txt", "FIX22_NOTES.txt", "WORD_BOOK_POLICY.txt",
    "WORD_BOOK_SOURCE_NOTE.txt",
)

def run(cmd: list[str], cwd: Path) -> None:
    subprocess.run(cmd, cwd=cwd, check=True)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True, type=Path, help="FIX22 all-platform ZIP")
    ap.add_argument("--repo", required=True, type=Path, help="local word-kingdom-web git clone")
    ap.add_argument("--commit", action="store_true", help="git add and commit synced files")
    ap.add_argument("--push", action="store_true", help="push the commit to origin (requires --commit)")
    args = ap.parse_args()
    archive, repo = args.archive.resolve(), args.repo.resolve()
    if not archive.is_file() or not zipfile.is_zipfile(archive):
        ap.error(f"not a readable ZIP: {archive}")
    if not (repo / ".git").exists():
        ap.error(f"--repo is not a git clone: {repo}")
    if args.push and not args.commit:
        ap.error("--push requires --commit")

    with tempfile.TemporaryDirectory(prefix="wordkingdom-fix22-") as tmp:
        tmpdir = Path(tmp)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(tmpdir)
        roots = list(tmpdir.glob("WordKingdom-1.0-All-Platforms"))
        if not roots:
            ap.error("ZIP does not contain WordKingdom-1.0-All-Platforms/")
        src = roots[0]
        missing = [p for p in PLATFORMS if not (src / p).is_dir()]
        if missing:
            ap.error("ZIP is missing platform folders: " + ", ".join(missing))

        # The Web project is the repository's existing root application.
        for item in (src / "Web-1.0").iterdir():
            dest = repo / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, dest)

        # Keep each native platform under its own top-level directory.
        for name in PLATFORMS[1:]:
            shutil.copytree(src / name, repo / name, dirs_exist_ok=True)

        for name in ROOT_DOCS:
            item = src / name
            if item.is_file():
                shutil.copy2(item, repo / name)

    if args.commit:
        run(["git", "add", "-A"], repo)
        status = subprocess.run(["git", "status", "--porcelain"], cwd=repo, text=True, capture_output=True, check=True).stdout.strip()
        if not status:
            print("No changes to commit.")
            return 0
        run(["git", "commit", "-m", "Sync Word Kingdom FIX22 all-platform sources"], repo)
        if args.push:
            run(["git", "push", "origin", "HEAD"], repo)
    print("Synced Web, WeChat Mini Program, Douyin Mini Program, iOS, and root documentation.")
    if not args.commit:
        print("Review with git status, then commit and push when ready.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
