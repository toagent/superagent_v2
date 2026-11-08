# Sourced by the secret-firewall command prefix: route this shell's output through sa-redact
# and, on exit, wait (bounded) until the redactor has flushed, because clients read output
# as soon as the shell exits and process substitutions are not waitable in zsh.
__sa_done="$(/usr/bin/mktemp -u /tmp/sa-done.XXXXXX)"
exec 3>&1 4>&2
# install.sh renders the absolute node path: non-login shells (Codex core env) may lack node on PATH.
__sa_node="${SA_NODE:-__SA_NODE__}"
[ -x "$__sa_node" ] || __sa_node=node
__sa_tools="__SA_TOOL_DIRS__"
# A redactor that cannot start must say so instead of silently dropping all output.
exec > >(PATH="$PATH:$__sa_tools" "$__sa_node" "${SA_REDACT_CJS:-$HOME/.wetamp/jail/sa-redact.cjs}" || { cat >/dev/null; printf '[REDACTED:scan_failed redactor_unavailable]\n'; }; : >"$__sa_done") 2>&1
__sa_finish() {
  exec 1>&3 2>&4
  __sa_i=0
  while [ ! -e "$__sa_done" ] && [ "$__sa_i" -lt 500 ]; do sleep 0.01; __sa_i=$((__sa_i + 1)); done
  /bin/rm -f "$__sa_done"
}
if [ -n "${ZSH_VERSION:-}" ]; then zshexit_functions+=(__sa_finish); else trap __sa_finish EXIT; fi
