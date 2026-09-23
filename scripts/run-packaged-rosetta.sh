#!/bin/zsh
set -euo pipefail

if [[ -z "${CHATGPT_WEB_NEXT_ROSETTA_EXECUTABLE:-}" ]]; then
  print -u2 'CHATGPT_WEB_NEXT_ROSETTA_EXECUTABLE is required'
  exit 64
fi

exec /usr/bin/arch -x86_64 "$CHATGPT_WEB_NEXT_ROSETTA_EXECUTABLE" "$@"
