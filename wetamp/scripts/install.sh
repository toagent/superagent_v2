#!/usr/bin/env bash
# 幂等安装：$ARCHON_HOME/.env 两行、config.yaml 只写 aliases/workflows/concurrency.providers（先备份）、建 gen/runs；
# 断言 @sa-coder ≠ @sa-reviewer；渲染 supervise-tick 的 launchd plist（相同不动，不同先备份；只打印 bootstrap 命令，不执行）；
# 末尾 doctor 摘要。可重复跑。plist 目录默认 ~/Library/LaunchAgents，SA_LAUNCHD_DIR 可改（测试与 selftest 用）。
set -euo pipefail
WETAMP="$(cd -P "$(dirname "$0")/.." && pwd)"
export SUPERAGENT_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"
export ARCHON_HOME="${ARCHON_HOME:-$SUPERAGENT_HOME/archon}"
bun -e "import { install } from '$WETAMP/src/config.ts'; for (const f of install()) console.log('updated ' + f.replace(process.env.HOME, '~'))"
label=com.wetamp.superagent.supervise-tick dir="${SA_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
plist="$dir/$label.plist"
# PATH 取安装时的 PATH 并把 bun 放最前：tick 触发的 resume 要找到 bun、git 与各家 CLI；路径按 XML 转义后代入
new="$(SA_REPO="${WETAMP%/wetamp}" SA_PATH="$(dirname "$(command -v bun)"):$PATH" bun -e '
const x = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const e = process.env as Record<string, string>;
const t = await Bun.file(process.argv[1]).text();
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
