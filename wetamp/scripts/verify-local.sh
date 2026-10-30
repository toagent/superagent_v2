#!/usr/bin/env bash
# 本机投送闸：在临时 detached worktree 里对一个提交依次跑 root workspace bun install --frozen-lockfile → tsc → bun test --timeout 30000 → selftest --fake，
# 结果原子写入 $SUPERAGENT_HOME/verify.json：{commit,ok,at,steps:[{name,exit,ms}],log,last_ok_commit}。
# 同一提交已有定论（含普通失败）时直接复用；信号中断/超时及环境错误不写缓存。twin-toolkit 只投送 ok 的提交。
# 用法：verify-local.sh [--commit <rev>] [--timeout <s>，默认 1500，等锁与跑步骤各用一份]；退出码 0 通过、1 未通过。
set -euo pipefail
WETAMP="$(cd -P "$(dirname "$0")/.." && pwd)"
SA_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"
REV=HEAD TIMEOUT=1500
ORIGINAL_ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in --commit) REV="$2"; shift 2;; --timeout) TIMEOUT="$2"; shift 2;; *) echo "verify-local: unknown arg $1" >&2; exit 1;; esac
done

if [ "${SA_HEAVY_LOCK_HELD:-}" != 1 ]; then
  HEAVY_LOCK="${SA_HEAVY_LOCK_FILE:-/tmp/superagent-heavy-test.lock}"
  case "$(uname -s)" in
    Darwin) exec /usr/bin/lockf -k "$HEAVY_LOCK" env SA_HEAVY_LOCK_HELD=1 "$0" "${ORIGINAL_ARGS[@]}";;
    Linux)
      command -v flock >/dev/null 2>&1 || { echo 'verify-local: flock is required on Linux' >&2; exit 1; }
      exec flock "$HEAVY_LOCK" env SA_HEAVY_LOCK_HELD=1 "$0" "${ORIGINAL_ARGS[@]}";;
    *) echo "verify-local: unsupported platform $(uname -s)" >&2; exit 1;;
  esac
fi
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
if d.get("commit") != sys.argv[2] or any(s.get("exit", 0) >= 128 for s in d.get("steps", [])): sys.exit(3)
print("verify-local: %s %s (cached; log %s)" % (d["commit"][:12], "ok" if d.get("ok") else "FAIL", d.get("log")))
sys.exit(0 if d.get("ok") else 2)' "$OUT" "$SHA" && exit 0
  [ $? = 2 ] && exit 1
  return 1
}

BUN=""
for d in ${BUN_INSTALL:+"$BUN_INSTALL/bin"} "$HOME/.bun/bin" /opt/homebrew/bin; do
  [ -x "$d/bun" ] && { BUN="$d/bun"; export PATH="$d:$PATH"; break; }
done
[ -n "$BUN" ] || { echo "verify-local: bun not found in \$BUN_INSTALL/bin, ~/.bun/bin, /opt/homebrew/bin" >&2; exit 1; }

# 每个提交只跑一次：mkdir 锁；持锁进程已不在时视为陈旧锁。拿到锁后再查一次缓存（可能刚被别人跑完）。
LOCK="$SA_HOME/verify/lock"
reap_path() {
  local marker="$1/" self=$$ ancestors=" $$ " pid ppid state cmd targets="" live="" end
  while [ "$self" -gt 1 ]; do self="$(ps -o ppid= -p "$self" 2>/dev/null | tr -d ' ')" || self=1; [ -n "$self" ] || self=1; ancestors="$ancestors$self "; done
  while read -r pid ppid cmd; do case "$ancestors" in *" $pid "*) ;; *) [[ "$cmd" == *"$marker"* ]] && targets="$targets $pid";; esac; done < <(ps -axo pid=,ppid=,command=)
  [ -z "$targets" ] || kill -TERM $targets 2>/dev/null || echo "verify-local: failed to terminate$targets" >&2
  end=$((SECONDS + 5)); while [ "$SECONDS" -lt "$end" ]; do live=""; for pid in $targets; do read -r state cmd <<< "$(ps -o state=,command= -p "$pid" 2>/dev/null)" || { state=""; cmd=""; }; [[ "$state" != Z* && "$cmd" == *"$marker"* ]] && live="$live $pid"; done; [ -n "$live" ] || return 0; sleep 1; done
  [ -z "$live" ] || { echo "verify-local: killing residual$live" >&2; kill -KILL $live 2>/dev/null || echo "verify-local: failed to kill$live" >&2; }
}
recover() {
  local old common status
  old="$(cat "$LOCK/tmp" 2>/dev/null || true)"
  case "$old" in /*/sa-verify.*) ;; *) return;; esac
  [ ! -L "$old" ] && [ ! -L "$old/wt" ] || return
  if [ -d "$old/wt" ]; then
    [ "$(git -C "$old/wt" rev-parse --show-toplevel 2>/dev/null)" = "$old/wt" ] || return
    common="$(git -C "$old/wt" rev-parse --path-format=absolute --git-common-dir)"
    [ "$common" = "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)" ] || return
    status="$(git -C "$old/wt" status --porcelain=v1 --untracked-files=all)" || return
    [ -z "$status" ] || { echo "verify-local: retained dirty orphan $old" >&2; return; }
    git -C "$REPO" worktree remove "$old/wt" || return
  fi
  reap_path "$old"
  chmod -R u+w "$old" 2>/dev/null || true
  rm -rf "$old" 2>/dev/null || true
  [ ! -e "$old" ] || echo "verify-local: retained $old" >&2
}
lock_owner_alive() {
  local pid="$1" actual expected command
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  actual="$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$actual" ] || return 1
  if [ -f "$LOCK/start" ]; then
    expected="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$LOCK/start")"
    [ -n "$expected" ] && [ "$actual" = "$expected" ]
  else
    command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    [[ "$command" == *verify-local* ]]
  fi
}
DEADLINE=$(( $(date +%s) + TIMEOUT ))
until mkdir "$LOCK" 2>/dev/null; do
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if ! lock_owner_alive "$pid"; then recover; rm -rf "$LOCK"; continue; fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "verify-local: lock $LOCK held by ${pid:-?}" >&2; exit 1; }
  sleep 2
done
echo $$ > "$LOCK/pid"
LC_ALL=C ps -o lstart= -p $$ | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' > "$LOCK/start"
# 等锁另计：步骤预算从拿到锁起算，并发排队不吃掉后续 bun test 的时间。
DEADLINE=$(( $(date +%s) + TIMEOUT ))
TMP_BASE="$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${TMPDIR:-/tmp}")"
case "$TMP_BASE" in
  /tmp/sa-scratch|/tmp/sa-scratch/*|/private/tmp/sa-scratch|/private/tmp/sa-scratch/*) TMP_BASE=/tmp;;
esac
TMP="$(mktemp -d "$TMP_BASE/sa-verify.XXXXXX")"
TMP="$(cd -P "$TMP" && pwd)"
echo "$TMP" > "$LOCK/tmp"
WT="$TMP/wt"
cleanup() {
  reap_path "$TMP"
  if [ -d "$WT" ]; then
    # 软链的 node_modules 先摘掉，删除 worktree 时不会碰到主仓的依赖。
    find "$WT" -maxdepth 3 -name node_modules -type l -exec rm -f {} + 2>/dev/null || true
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  fi
  chmod -R u+w "$TMP" 2>/dev/null || true
  rm -rf "$TMP" 2>/dev/null || true
  [ ! -e "$TMP" ] || echo "verify-local: retained $TMP" >&2
  rm -rf "$LOCK"
}
trap cleanup EXIT
cached || true

LOG="$SA_HOME/verify/${SHA:0:12}.log"
# 各步骤（含 bun test）只碰临时 home，不写调用方的台账。
export SUPERAGENT_HOME="$TMP/sa" ARCHON_HOME="$TMP/sa/archon" XDG_STATE_HOME="$TMP/state"
export TMPDIR="$TMP"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
git config --global user.name 'superagent verify'
git config --global user.email 'verify@superagent.local'
: > "$LOG"
git -C "$REPO" worktree add -q --detach "$WT" "$SHA" >>"$LOG" 2>&1
STEPS=() OK=1 INCONCLUSIVE=0
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
  [ "$rc" -lt 128 ] || INCONCLUSIVE=1
  [ "$rc" = 0 ] || OK=0
}
# 冻结安装失败而 root lock 与主仓一致时，软链主仓已装好的 workspace node_modules。
install() { # <rel dir> <step name>
  local rel="$1" dir="$WT/${1#.}"
  [ "$OK" = 1 ] || return 0
  step "$2" "$dir" "$BUN" install --frozen-lockfile
  [ "$INCONCLUSIVE" = 0 ] || return 0
  [ "$OK" = 0 ] || return 0
  if cmp -s "$dir/bun.lock" "$MAIN/${rel#.}/bun.lock" && [ -d "$MAIN/${rel#.}/node_modules" ]; then
    echo "== $2: frozen install failed; lock matches $MAIN, linking its node_modules" >>"$LOG"
    rm -rf "$dir/node_modules"; ln -s "$MAIN/${rel#.}/node_modules" "$dir/node_modules"
    if [ "$rel" = . ]; then
      for p in "$MAIN"/packages/*/node_modules "$MAIN"/wetamp/node_modules; do
        [ -d "$p" ] || continue
        q="$WT/${p#"$MAIN"/}"; [ -d "$(dirname "$q")" ] && { rm -rf "$q"; ln -s "$p" "$q"; }
      done
    fi
    OK=1; STEPS+=("$2:linked" 0 0)
  fi
}
install . install
step tsc "$WT/wetamp" "$BUN" x tsc --noEmit
# 显式单测时限：Bun 1.4.3 不读 bunfig 的 [test] timeout，负载下 hook 子进程用例会撞默认 5s。
# 四个进程共享 test 步骤的剩余预算；重文件固定分开，其余按文件名轮转。
test_step() {
  local dir="$WT/wetamp" left rc=0 shard_rc=0 t0 i pid pids="" n=0 file
  [ "$OK" = 1 ] || return 0
  left=$(( DEADLINE - $(date +%s) )); [ "$left" -gt 0 ] || left=1
  for i in 1 2 3 4; do : > "$TMP/test-shard.$i"; done
  printf '%s\n' tests/scenarios/scenario-rest.test.ts > "$TMP/test-shard.1"
  printf '%s\n' tests/scenarios/scenario-engine.test.ts > "$TMP/test-shard.2"
  printf '%s\n' tests/scenarios/mutations.test.ts > "$TMP/test-shard.3"
  printf '%s\n' tests/engine-promote.test.ts > "$TMP/test-shard.4"
  while IFS= read -r file; do
    case "$file" in *.test.js|*.test.jsx|*.test.ts|*.test.tsx|*_test.js|*_test.jsx|*_test.ts|*_test.tsx|*.spec.js|*.spec.jsx|*.spec.ts|*.spec.tsx|*_spec.js|*_spec.jsx|*_spec.ts|*_spec.tsx) ;; *) continue;; esac
    case "$file" in tests/scenarios/scenario-rest.test.ts|tests/scenarios/scenario-engine.test.ts|tests/scenarios/mutations.test.ts|tests/engine-promote.test.ts) continue;; esac
    i=$(( n % 4 + 1 )); printf '%s\n' "$file" >> "$TMP/test-shard.$i"; n=$(( n + 1 ))
  done < <(cd "$dir" && find tests -type f | LC_ALL=C sort)
  echo "== test ($dir: 4 shards)" >>"$LOG"; t0="$(ms)"
  for i in 1 2 3 4; do
    ( cd "$dir"; set --; while IFS= read -r file; do set -- "$@" "$dir/$file"; done < "$TMP/test-shard.$i"
      perl -e 'alarm shift; exec @ARGV or exit 127' "$left" env SA_VERIFY_LOCAL=1 "$BUN" test --timeout 30000 "$@" 2>&1 | sed "s/^/[test:shard$i] /" >>"$LOG" ) & pids="$pids $!"
  done
  set +e; for pid in $pids; do wait "$pid"; shard_rc=$?; [ "$shard_rc" -le "$rc" ] || rc="$shard_rc"; done; set -e
  STEPS+=(test "$rc" "$(( $(ms) - t0 ))"); [ "$rc" -lt 128 ] || INCONCLUSIVE=1; [ "$rc" = 0 ] || OK=0
}
# SA_VERIFY_LOCAL=1：单测里内嵌整轮 selftest 的 REC-R1-01 跳过，下一步 selftest 已覆盖。
test_step
step selftest "$WT/wetamp" bash scripts/selftest.sh --fake

if [ "$INCONCLUSIVE" = 1 ]; then
  echo "verify-local: ${SHA:0:12} inconclusive (interrupted; log $LOG)"; exit 1
fi

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
