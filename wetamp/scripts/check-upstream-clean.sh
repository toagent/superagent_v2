#!/usr/bin/env bash
# 仓库内 wetamp/ 之外只允许 FORK 登记的 upstream 差异（已提交 + 工作区）。输出为空即干净。
set -euo pipefail
cd "$(dirname "$0")/../.."
if git rev-parse --verify -q upstream/dev >/dev/null; then base="$(git merge-base HEAD upstream/dev)"
else echo "warning: no upstream/dev, comparing with dev" >&2; base="$(git merge-base HEAD dev)"; fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/wetamp-upstream.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
{ git diff --name-only "$base" -- . ':!wetamp'; git ls-files --others --exclude-standard -- . ':!wetamp' ':!.context'; } | LC_ALL=C sort -u >"$tmp/diff"
if [ -f wetamp/FORK ]; then
  sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' wetamp/FORK | LC_ALL=C sort -u >"$tmp/fork"
else : >"$tmp/fork"; fi
comm -23 "$tmp/diff" "$tmp/fork"
comm -13 "$tmp/diff" "$tmp/fork" | sed 's/^/stale: /'
