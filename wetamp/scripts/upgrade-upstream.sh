#!/usr/bin/env bash
# 跟进 upstream/dev。默认 dry-run：fetch（只更新远端跟踪引用）+ 核对引擎事实 + 打印计划，不动任何分支与工作区；
# --apply：在当前分支 merge --no-ff upstream/dev，校验 wetamp/ 之外与 upstream 零差异，改写 wetamp/UPSTREAM（不提交）。永不 push。
# 引擎事实（recover/wait 依赖）登记在 wetamp/UPSTREAM 第 2 行起，逐条对 `git show upstream/dev:<file>` 核对：
#   table <file> <table> <col>...   该文件里 `CREATE TABLE IF NOT EXISTS <table> (` 到 `);` 之间必须有以 <col> 开头的列定义
#   fact <file> <text>              该文件必须原样含 <text>（定位写入点，不是全仓 grep）
set -euo pipefail
apply=0
case "${1:-}" in --apply) apply=1 ;; "") ;; *) echo "usage: upgrade-upstream.sh [--apply]" >&2; exit 2 ;; esac
cd "$(dirname "$0")/../.."
die() { echo "upgrade: $*" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes"
git fetch -q upstream dev
up=$(git rev-parse --short=8 upstream/dev); behind=$(git rev-list --count HEAD..upstream/dev)
echo "branch: $(git rev-parse --abbrev-ref HEAD)  upstream/dev: $up  behind: $behind  recorded: $(head -1 wetamp/UPSTREAM)"
facts=0
while read -r kind file rest; do
  src=$(git show "upstream/dev:$file" 2>/dev/null) || die "upstream/dev no longer has $file; recover/wait needs review"
  case "$kind" in
    table)
      read -r table cols <<<"$rest"
      block=$(awk -v t="CREATE TABLE IF NOT EXISTS $table (" 'index($0, t) { on = 1; next } on && /^ *\);/ { exit } on' <<<"$src")
      [ -n "$block" ] || die "upstream/dev:$file no longer creates $table; recover needs review"
      for col in $cols; do grep -Eq "^ *$col " <<<"$block" || die "upstream/dev:$file: $table.$col missing; recover needs review"; done ;;
    fact) grep -qF -- "$rest" <<<"$src" || die "upstream/dev:$file no longer has: $rest; recover/wait needs review" ;;
    *) die "wetamp/UPSTREAM: unknown line kind '$kind'" ;;
  esac
  facts=$((facts + 1))
done < <(tail -n +2 wetamp/UPSTREAM)
[ "$facts" -gt 0 ] || die "wetamp/UPSTREAM registers no engine facts"
echo "engine facts: ok ($facts)"
db="${ARCHON_HOME:-${SUPERAGENT_HOME:-$HOME/.superagent}/archon}/archon.db"
if [ -f "$db" ]; then
  cols=$(sqlite3 -readonly "$db" "select name from pragma_table_info('remote_agent_workflow_runs')")
  for col in status metadata; do grep -qx "$col" <<<"$cols" || die "$db: remote_agent_workflow_runs.$col missing"; done
  echo "db schema: ok (status, metadata)"
else echo "db schema: skipped (no $db yet)"; fi
[ -z "$(wetamp/scripts/check-upstream-clean.sh 2>/dev/null)" ] || die "files outside wetamp/ already differ from upstream"
[ "$behind" -gt 0 ] || { echo "already up to date"; exit 0; }
version=$(git show upstream/dev:package.json | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -1)
record="commit=$up version=$version branch=dev date=$(date +%F)"
if [ $apply = 0 ]; then
  echo "plan (--apply):"
  echo "  git merge --no-ff --no-edit upstream/dev"
  echo "  wetamp/scripts/check-upstream-clean.sh   # must print nothing"
  echo "  wetamp/UPSTREAM <- $record"
  exit 0
fi
git merge -q --no-ff --no-edit upstream/dev || die "merge stopped; resolve it or run: git merge --abort"
out=$(wetamp/scripts/check-upstream-clean.sh 2>/dev/null)
[ -z "$out" ] || die "after merge, files outside wetamp/ differ from upstream:
$out"
{ echo "$record"; tail -n +2 wetamp/UPSTREAM; } >wetamp/UPSTREAM.new && mv wetamp/UPSTREAM.new wetamp/UPSTREAM
echo "merged $up. next (manual): bun install --frozen-lockfile && (cd wetamp && bun test) && wetamp/scripts/selftest.sh"
echo "  then: git add wetamp/UPSTREAM && git commit -m 'wetamp: track upstream $up'"
