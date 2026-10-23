#!/bin/bash
# macOS: render launchd/*.plist.in for this checkout into $BRAIN_HOME/launchd and link them into ~/Library/LaunchAgents.
# It never loads or restarts a job: load a new one with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`;
# restart memory-mcp only with bin/restart-memory-mcp.sh (no gap). Optional jobs: skip one with SKIP="backup".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
set -a; source "$BRAIN_HOME/env"; set +a
out="$BRAIN_HOME/launchd" logs="${BRAIN_LOGS:-$BRAIN_HOME/logs}"
mkdir -p "$out" "$logs" "$HOME/Library/LaunchAgents"
for template in "$ROOT"/launchd/*.plist.in; do
  name="$(basename "$template" .in)"
  job="${name#dev.brain.}"; job="${job%.plist}"
  case " ${SKIP:-} " in *" $job "*) continue ;; esac
  sed -e "s#__REPO__#$ROOT#g" -e "s#__LOGS__#$logs#g" "$template" >"$out/$name"
  ln -sfn "$out/$name" "$HOME/Library/LaunchAgents/$name"
  echo "$HOME/Library/LaunchAgents/$name -> $out/$name"
done
