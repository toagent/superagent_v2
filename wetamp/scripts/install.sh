#!/usr/bin/env bash
# 幂等安装：$ARCHON_HOME/.env 两行、config.yaml 只写 aliases/workflows/concurrency.providers（先备份）、建 gen/runs；
# 断言 @sa-coder ≠ @sa-reviewer；渲染 supervise-tick 的 launchd plist（相同不动，不同先备份；只打印 bootstrap 命令，不执行）；
# 末尾 doctor 摘要。可重复跑。plist 目录默认 ~/Library/LaunchAgents，SA_LAUNCHD_DIR 可改（测试与 selftest 用）。
# config.yaml 另写 assistants.codex.codexBinaryPath=wetamp/bin/codex-worker（worker 禁嵌套，见 docs/04-hooks-and-nesting.md）。
# 单独步骤（互斥，不走上面的默认安装）：
#   --hooks [--dry-run]     三端 hook 条目改指 wetamp/hooks/（src/install-hooks.ts）；--dry-run 只打印统一 diff
#   --purge-v1 [--dry-run]  清 V1 hook 条目并把 V1 残留移到 $SUPERAGENT_HOME/backups/v1-<UTC>/（不删除）
#   --remote-hooks          dev/mini 用：只要 node，校验 hooks 与 tiers.json，写 twin-toolkit 读取的 install.json 台账
set -euo pipefail
WETAMP="$(cd -P "$(dirname "$0")/.." && pwd)"
mode="" dry=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hooks|--purge-v1|--remote-hooks) [ -z "$mode" ] || { echo "install.sh: $mode and $1 are exclusive" >&2; exit 64; }; mode="$1";;
    --dry-run) dry=--dry-run;;
    *) echo "install.sh: unknown arg $1" >&2; exit 64;;
  esac
  shift
done
case "$mode" in
  ""|--remote-hooks) [ -z "$dry" ] || { echo "install.sh: --dry-run only applies to --hooks/--purge-v1" >&2; exit 64; };;
  *) exec bun "$WETAMP/src/install-hooks.ts" "$mode" ${dry:+"$dry"};;
esac
if [ "$mode" = --remote-hooks ]; then
  command -v node >/dev/null || { echo "install.sh --remote-hooks: node not found" >&2; exit 1; }
  for f in "$WETAMP"/hooks/*.cjs; do node --check "$f"; done
  # 真跑一次 guard：require 链（../tiers.json 的键）断了会在这里而不是在用户会话里暴露
  err="$(printf '{"hook_event_name":"Stop"}' | node "$WETAMP/hooks/guard.cjs" claude 2>&1)"
  [ -z "$err" ] || { echo "install.sh --remote-hooks: guard.cjs: $err" >&2; exit 1; }
  state="${XDG_STATE_HOME:-$HOME/.local/state}/superagent"; mkdir -p "$state"
  node -e '
const fs = require("node:fs"), [state, wetamp, commit] = process.argv.slice(1), file = state + "/install.json";
// V1 台账（同一位置）先留副本：V1 卸载器仍要读它
if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("\"superagent_v2\"")) fs.copyFileSync(file, file + ".v1-" + Date.now());
fs.writeFileSync(file + ".tmp", JSON.stringify({installer: "superagent_v2", mode: "remote-hooks", wetamp, commit,
  hooks: fs.readdirSync(wetamp + "/hooks").filter(f => f.endsWith(".cjs")).sort(), installed_at: new Date().toISOString()}, null, 2) + "\n");
fs.renameSync(file + ".tmp", file);
console.log("updated " + file);
' "$state" "$WETAMP" "$(git -C "$WETAMP" rev-parse HEAD 2>/dev/null || echo unknown)"
  exit 0
fi
export SUPERAGENT_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"
# 安装时显式给出的 ARCHON_HOME 才写进 plist；未给出则省略，tick 与这里取同一默认值
SA_ARCHON="${ARCHON_HOME:-}"
export ARCHON_HOME="${ARCHON_HOME:-$SUPERAGENT_HOME/archon}"
bun -e "import { install } from '$WETAMP/src/config.ts'; for (const f of install()) console.log('updated ' + f.replace(process.env.HOME, '~'))"
label=com.wetamp.superagent.supervise-tick dir="${SA_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
plist="$dir/$label.plist"
# PATH 取安装时的 PATH 并把 bun 放最前：tick 触发的 resume 要找到 bun、git 与各家 CLI；路径按 XML 转义后代入
new="$(SA_ARCHON="$SA_ARCHON" SA_REPO="${WETAMP%/wetamp}" SA_PATH="$(dirname "$(command -v bun)"):$PATH" bun -e '
const x = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const e = process.env as Record<string, string>;
let t = await Bun.file(process.argv[1]).text();
t = e.SA_ARCHON ? t.replaceAll("__ARCHON_HOME__", x(e.SA_ARCHON)) : t.replace(/ *<key>ARCHON_HOME<\/key>\n *<string>__ARCHON_HOME__<\/string>\n/, "");
console.log(t.replaceAll("__HOME__", x(e.SUPERAGENT_HOME)).replaceAll("__REPO__", x(e.SA_REPO)).replaceAll("__PATH__", x(e.SA_PATH)).trimEnd());
' "$WETAMP/launchd/$label.plist.tmpl")"
if ! { [ -f "$plist" ] && [ "$(cat "$plist")" = "$new" ]; }; then
  mkdir -p "$dir"
  [ -f "$plist" ] && cp "$plist" "$plist.bak-$(date +%Y%m%d%H%M%S)"
  printf '%s\n' "$new" >"$plist"
  echo "updated ${plist/#$HOME/~}"
  echo "  load (manual):   launchctl bootout gui/$(id -u)/$label 2>/dev/null; launchctl bootstrap gui/$(id -u) $plist"
  echo "  unload (manual): launchctl bootout gui/$(id -u)/$label"
fi
[ "${SA_SKIP_DOCTOR:-}" = 1 ] && exit 0
if out="$("$WETAMP/bin/archon" doctor 2>&1)"; then echo "doctor: ok"; else echo "$out" | grep -v "^[○✓]" | tail -20; echo "doctor: FAILED" >&2; exit 1; fi
