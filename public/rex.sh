#!/usr/bin/env bash
# Rex CLI — chat with Rex (on the VPS) from any terminal.
# Requires: bash + curl. No SSH, no keys — just the dashboard password.
#
# Install:
#   curl -s -u admin:PASSWORD https://ardigitalnexus.com/rex.sh -o rex && chmod +x rex
# Run:
#   ./rex                       # prompts for password
#   REX_AUTH=admin:PASS ./rex   # non-interactive
#
set -uo pipefail

URL="${REX_URL:-https://ardigitalnexus.com}"
AUTH="${REX_AUTH:-}"

if [ -z "$AUTH" ]; then
  read -rp "Rex username [admin]: " U; U="${U:-admin}"
  read -rsp "Rex password: " P; echo
  AUTH="$U:$P"
fi

# Quick auth check
if ! curl -fs -u "$AUTH" -o /dev/null "$URL/api/stats"; then
  echo "✗ Could not reach Rex or wrong password ($URL)"; exit 1
fi

printf "\033[35mRex\033[0m — connected to %s. Type a message, 'exit' to quit.\n" "$URL"
while true; do
  printf "\n\033[36myou ›\033[0m "
  IFS= read -r MSG || break
  [ -z "$MSG" ] && continue
  case "$MSG" in exit|quit|q) break ;; esac
  ANS=$(curl -s -u "$AUTH" -X POST "$URL/api/chat" -H "Content-Type: text/plain" --data-binary "$MSG")
  [ -z "$ANS" ] && ANS="(no response)"
  printf "\033[35mrex ›\033[0m %s\n" "$ANS"
done
