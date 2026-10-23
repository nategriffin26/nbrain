#!/bin/bash
# The ingest process: connectors → brain.events → memory, plus the upkeep loops (src/ingest.ts). With KEYCHAIN_PREFIX set,
# the Workers AI token comes from the login Keychain when the env file does not hold it.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
set -a; source "$BRAIN_HOME/env"; set +a
if [ -n "${KEYCHAIN_PREFIX:-}" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  export CLOUDFLARE_API_TOKEN="$(/usr/bin/security find-generic-password -s "$KEYCHAIN_PREFIX-cf-ai" -w 2>/dev/null || true)"
fi
cd "$ROOT"
exec ./node_modules/.bin/tsx src/ingest.ts
