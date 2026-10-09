#!/usr/bin/env bash
# 不变量 1：仓库内 wetamp/ 之外相对 upstream 零改动（已提交 + 工作区）。输出为空即干净。
set -euo pipefail
cd "$(dirname "$0")/../.."
if git rev-parse --verify -q upstream/dev >/dev/null; then base="$(git merge-base HEAD upstream/dev)"
else echo "warning: no upstream/dev, comparing with dev" >&2; base="$(git merge-base HEAD dev)"; fi
git diff --stat "$base" -- . ':!wetamp'
git status --porcelain --untracked-files=all -- . ':!wetamp' ':!.context'
