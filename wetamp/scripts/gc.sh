#!/usr/bin/env bash
# 清理已终局且已合入的 run：Archon worktree（不 --force）、本地分支（-d）、gen/<run>、runs/<run>.json。
# asks.json 不在这里改：它的唯一写者是 supervise-tick（持 supervise.lock），tick 自己丢掉没有 ledger 的 run 的条目。
# 默认 dry-run 只打印计划；--apply 才执行。只处理 `superagent status` 为 completed/cancelled 且分支已是
# 本地目标分支祖先（land 过或无提交）的 run，其余列出原因跳过。从不删远端分支（不用 archon complete /
# isolation cleanup --merged）；Archon 的 run 记录与环境行留给 `archon workflow cleanup` / `isolation cleanup`。
set -euo pipefail
usage() { echo "usage: gc.sh [--apply] [run...]" >&2; exit 2; }
apply=0; [ "${1:-}" = --apply ] && { apply=1; shift; }
for a in "$@"; do [[ $a == -* ]] && usage; done
command -v jq >/dev/null || { echo "gc: jq not found" >&2; exit 1; }
WETAMP="$(cd "$(dirname "$0")/.." && pwd)"
SA="${SUPERAGENT_HOME:-$HOME/.superagent}"; AH="${ARCHON_HOME:-$SA/archon}"
if [ $# -eq 0 ]; then set -- $(find "$SA/runs" -maxdepth 1 -name '*.json' 2>/dev/null | sed 's#.*/##; s#\.json$##' | sort); fi
do_() { echo "  $*"; [ $apply = 0 ] || "$@"; }
rc=0
for run in "$@"; do
  L="$SA/runs/$run.json"
  [ -f "$L" ] || { echo "skip $run: no ledger"; rc=1; continue; }
  code=0; "$WETAMP/bin/superagent" status "$run" >/dev/null 2>&1 || code=$?
  [ $code = 0 ] || [ $code = 2 ] || { echo "skip $run: not terminal (status exit $code)"; continue; }
  repo=$(jq -r .repo "$L"); branch=$(jq -r .branch "$L"); gen=$(jq -r .gen_dir "$L")
  # gen_dir 只认 generate 写出的 $SA/gen/<run> 本身（不认 ../ 或软链），在动 worktree/分支之前拒绝
  [ "$gen" = "$SA/gen/$run" ] && [ ! -L "$gen" ] ||
    { echo "refuse $run: gen_dir $gen is not \$SUPERAGENT_HOME/gen/$run"; rc=1; continue; }
  target=$(jq -r .base_ref "$gen/plan.json" 2>/dev/null) || { echo "skip $run: no $gen/plan.json"; rc=1; continue; }
  target=${target#origin/}
  if git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    git -C "$repo" merge-base --is-ancestor "refs/heads/$branch" "refs/heads/$target" ||
      { echo "skip $run: $branch not merged into $target (land first, or delete it yourself)"; continue; }
  fi
  echo "gc $run:"
  wt=$(git -C "$repo" worktree list --porcelain | awk -v b="branch refs/heads/$branch" \
    '/^worktree /{w=substr($0,10)} $0==b{print w}')
  if [ -n "$wt" ]; then
    case "$wt" in "$AH"/*) ;; *) echo "  refuse: worktree $wt is outside \$ARCHON_HOME"; rc=1; continue ;; esac
    do_ git -C "$repo" worktree remove "$wt" || { rc=1; continue; }
  fi
  git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null && { do_ git -C "$repo" branch -d "$branch" || { rc=1; continue; }; }
  [ ! -e "$gen" ] || do_ rm -rf "$gen"
  do_ rm -f "$L"
done
[ $apply = 1 ] || echo "(dry-run; rerun with --apply)"
exit $rc
