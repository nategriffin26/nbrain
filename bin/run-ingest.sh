#!/bin/bash
# The ingest process: connectors → brain.events → memory, plus the upkeep loops (src/ingest.ts).
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
set -a; source "$BRAIN_HOME/env"; set +a
cd "$ROOT"
exec ./node_modules/.bin/tsx src/ingest.ts
