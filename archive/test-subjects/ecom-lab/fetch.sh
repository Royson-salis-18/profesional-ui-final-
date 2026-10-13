#!/usr/bin/env bash
# Fetch the upstream project at the commit these scenarios were written against (not vendored into this repo).
set -euo pipefail
cd "$(dirname "$0")"
PIN=2de1ef8542678ab974cdaf9c7c014fc48d5a3150
if [ ! -d upstream/.git ]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone --quiet https://github.com/tahaberkamcadev/ecom upstream
fi
git -C upstream fetch --quiet --depth 1 origin "$PIN" 2>/dev/null || true
git -C upstream checkout --quiet "$PIN"
[ -f upstream/.env ] || cp upstream/.env.example upstream/.env
echo "upstream at $(git -C upstream rev-parse --short HEAD)"
