#!/usr/bin/env bash

inject_managed_secrets() {
  local owner=${1:-secret-env} secret_list="$HOME/.wetamp/secrets.list" secret value
  [ -f "$secret_list" ] || return 0
  while IFS= read -r secret; do
    [[ "$secret" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "$owner: 跳过非法凭据名" >&2; continue; }
    [ -z "${!secret:-}" ] || continue
    value="$(security find-generic-password -a "$secret" -s "superagent-secret:$secret" -w 2>/dev/null)" || {
      echo "$owner: 凭据 $secret 不可用，本次未注入" >&2
      continue
    }
    export "$secret=$value"
  done < "$secret_list"
}
