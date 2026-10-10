#!/usr/bin/env bash
# 本机投送闸：在临时 detached worktree 里对一个提交依次跑 bun install --frozen-lockfile（根与 wetamp）→ tsc → bun test → selftest --fake，
# 结果原子写入 $SUPERAGENT_HOME/verify.json：{commit,ok,at,steps:[{name,exit,ms}],log,last_ok_commit}。
# 同一提交已有结果（含失败）时直接复用，不重跑；环境错误（找不到 bun、等锁超时）不写缓存。twin-toolkit 只投送 ok 的提交。
# 用法：verify-local.sh [--commit <rev>] [--timeout <s>]；退出码 0 通过、1 未通过。
set -euo pipefail
WETAMP="$(cd -P "$(dirname "$0")/.." && pwd)"
SA_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"
REV=HEAD TIMEOUT=600
while [ $# -gt 0 ]; do
  case "$1" in --commit) REV="$2"; shift 2;; --timeout) TIMEOUT="$2"; shift 2;; *) echo "verify-local: unknown arg $1" >&2; exit 1;; esac
done
REPO="$(git -C "$WETAMP" rev-parse --show-toplevel)"
MAIN="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
SHA="$(git -C "$REPO" rev-parse --verify --quiet "$REV^{commit}")" || { echo "verify-local: no such commit $REV" >&2; exit 1; }
OUT="$SA_HOME/verify.json"
mkdir -p "$SA_HOME/verify"

# 打印缓存结果并按 ok 退出；没有该提交的缓存时返回 1。
cached() {
  [ -f "$OUT" ] || return 1
  python3 -I -c 'import json, sys
d = json.load(open(sys.argv[1]))
if d.get("commit") != sys.argv[2]: sys.exit(3)
print("verify-local: %s %s (cached; log %s)" % (d["commit"][:12], "ok" if d.get("ok") else "FAIL", d.get("log")))
sys.exit(0 if d.get("ok") else 2)' "$OUT" "$SHA" && exit 0
  [ $? = 2 ] && exit 1
  return 1
}
cached || true

BUN=""
for d in ${BUN_INSTALL:+"$BUN_INSTALL/bin"} "$HOME/.bun/bin" /opt/homebrew/bin; do
  [ -x "$d/bun" ] && { BUN="$d/bun"; export PATH="$d:$PATH"; break; }
done
[ -n "$BUN" ] || { echo "verify-local: bun not found in \$BUN_INSTALL/bin, ~/.bun/bin, /opt/homebrew/bin" >&2; exit 1; }

# 每个提交只跑一次：mkdir 锁；持锁进程已不在时视为陈旧锁。拿到锁后再查一次缓存（可能刚被别人跑完）。
LOCK="$SA_HOME/verify/lock"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
until mkdir "$LOCK" 2>/dev/null; do
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "verify-local: lock $LOCK held by ${pid:-?}" >&2; exit 1; }
  sleep 2
done
echo $$ > "$LOCK/pid"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/sa-verify.XXXXXX")"
WT="$TMP/wt"
cleanup() {
  if [ -d "$WT" ]; then
    # 软链的 node_modules 先摘掉，删除 worktree 时不会碰到主仓的依赖。
    find "$WT" -maxdepth 3 -name node_modules -type l -exec rm -f {} + 2>/dev/null || true
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP" "$LOCK"
}
trap cleanup EXIT
cached || true

LOG="$SA_HOME/verify/${SHA:0:12}.log"
# 各步骤（含 bun test）只碰临时 home，不写调用方的台账。
export SUPERAGENT_HOME="$TMP/sa" ARCHON_HOME="$TMP/sa/archon"
: > "$LOG"
git -C "$REPO" worktree add -q --detach "$WT" "$SHA" >>"$LOG" 2>&1
STEPS=() OK=1
ms() { python3 -I -c 'import time; print(int(time.time() * 1000))'; }
# step <name> <dir> <cmd...>：在剩余时间内跑一步（超时 exit 142），记 {name,exit,ms}；失败后不再跑后续步骤。
step() {
  local name="$1" dir="$2" left rc t0; shift 2
  [ "$OK" = 1 ] || return 0
  left=$(( DEADLINE - $(date +%s) )); [ "$left" -gt 0 ] || left=1
  echo "== $name ($dir: $*)" >>"$LOG"
  t0="$(ms)"
  set +e; (cd "$dir" && perl -e 'alarm shift; exec @ARGV or exit 127' "$left" "$@") >>"$LOG" 2>&1; rc=$?; set -e
  STEPS+=("$name" "$rc" "$(( $(ms) - t0 ))")
  [ "$rc" = 0 ] || OK=0
}
# 冻结安装失败而该目录的 lock 与主仓一致时，软链主仓已装好的 node_modules（根目录连同 packages/*）。
install() { # <rel dir> <step name>
  local rel="$1" dir="$WT/${1#.}"
  [ "$OK" = 1 ] || return 0
  step "$2" "$dir" "$BUN" install --frozen-lockfile
  [ "$OK" = 0 ] || return 0
  if cmp -s "$dir/bun.lock" "$MAIN/${rel#.}/bun.lock" && [ -d "$MAIN/${rel#.}/node_modules" ]; then
    echo "== $2: frozen install failed; lock matches $MAIN, linking its node_modules" >>"$LOG"
    rm -rf "$dir/node_modules"; ln -s "$MAIN/${rel#.}/node_modules" "$dir/node_modules"
    if [ "$rel" = . ]; then
      for p in "$MAIN"/packages/*/node_modules; do
        [ -d "$p" ] || continue
        q="$WT/${p#"$MAIN"/}"; [ -d "$(dirname "$q")" ] && { rm -rf "$q"; ln -s "$p" "$q"; }
      done
    fi
    OK=1; STEPS+=("$2:linked" 0 0)
  fi
}
install . install
install wetamp install:wetamp
step tsc "$WT/wetamp" "$BUN" x tsc --noEmit
step test "$WT/wetamp" "$BUN" test
step selftest "$WT/wetamp" bash scripts/selftest.sh --fake

python3 -I -c 'import json, os, sys, time
out, sha, ok, log, *flat = sys.argv[1:]
try: last = json.load(open(out)).get("last_ok_commit")
except (OSError, ValueError): last = None
steps = [{"name": flat[i], "exit": int(flat[i + 1]), "ms": int(flat[i + 2])} for i in range(0, len(flat), 3)]
ok = ok == "1"
d = {"commit": sha, "ok": ok, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "steps": steps, "log": log, "last_ok_commit": sha if ok else last}
tmp = f"{out}.{os.getpid()}.tmp"
with open(tmp, "w") as f: json.dump(d, f, indent=1); f.write("\n")
os.replace(tmp, out)' "$OUT" "$SHA" "$OK" "$LOG" ${STEPS[@]+"${STEPS[@]}"}
if [ "$OK" = 1 ]; then echo "verify-local: ${SHA:0:12} ok (log $LOG)"; exit 0; fi
echo "verify-local: ${SHA:0:12} FAIL (log $LOG)"; exit 1
