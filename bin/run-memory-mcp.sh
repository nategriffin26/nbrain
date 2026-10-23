#!/bin/bash
# memory-mcp on 127.0.0.1:$MEMORY_MCP_PORT (src/mcp/server.ts). It never gets the superuser DATABASE_URL: only its own
# roles, from the env file (MEMORY_RO/WRITER_DATABASE_URL) or, with KEYCHAIN_PREFIX set, the macOS login Keychain, which
# also holds the Workers AI token when the env file does not. Without a writer URL, remember/save/skill_save are off.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
set -a; source "$BRAIN_HOME/env"; set +a
export MEMORY_MCP_PORT="${MEMORY_MCP_PORT:-8830}" MEMORY_MCP_HOME="${MEMORY_MCP_HOME:-$BRAIN_HOME/memory-mcp}"
if [ -n "${KEYCHAIN_PREFIX:-}" ]; then
  at="${DATABASE_URL#*@}"   # host:port/db
  RO="$(/usr/bin/security find-generic-password -a memory_ro -s "$KEYCHAIN_PREFIX-ro" -w)"
  export MEMORY_RO_DATABASE_URL="postgres://memory_ro:${RO}@${at}"
  if W="$(/usr/bin/security find-generic-password -a memory_writer -s "$KEYCHAIN_PREFIX-writer" -w 2>/dev/null)"; then
    export MEMORY_WRITER_DATABASE_URL="postgres://memory_writer:${W}@${at}"
  fi
  unset RO W at
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || export CLOUDFLARE_API_TOKEN="$(/usr/bin/security find-generic-password -s "$KEYCHAIN_PREFIX-cf-ai" -w 2>/dev/null || true)"
fi
unset DATABASE_URL
cd "$ROOT"
exec ./node_modules/.bin/tsx src/mcp/server.ts
