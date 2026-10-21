#!/bin/bash
# Restart dev.brain.memory-mcp (reloading its plist) while 127.0.0.1:$MEMORY_MCP_PORT keeps answering. macOS can't share a listening
# port between processes, so the port moves twice, and each move waits until the successor is initialised and retrying the
# bind (server.ts logs "waiting for port"); the gap is then one 20 ms retry tick:
#   1. a standby copy starts and waits on the port; launchd's instance is booted out; the standby binds.
#   2. handback: a fresh launchd instance starts and waits; the standby stops; the launchd instance binds.
# Restarts are serialised (mkdir lock). Interrupted or failed after step 1, the trap runs the handback, so the port never
# stays with an unsupervised standby; a standby left by an earlier crash of this script is adopted and handed back.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
set -a; source "$BRAIN_HOME/env"; set +a
PORT="${MEMORY_MCP_PORT:-8830}"
U=$(id -u)
LABEL=dev.brain.memory-mcp
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
JOB_LOG="${BRAIN_LOGS:-$BRAIN_HOME/logs}/memory-mcp.out.log"
LOCK="${TMPDIR:-/tmp}/brain-restart-memory-mcp.lock"
mkdir "$LOCK" 2>/dev/null || { echo "another memory-mcp restart is running ($LOCK)"; exit 1; }

standby=""
standby_log="$(mktemp -t memory-mcp-standby)"
job_pid() { launchctl list | awk -v l="$LABEL" '$3==l && $1!="-"{print $1}'; }
holder() { lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
parent_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
launchd_holds() { local h j; h=$(holder); j=$(job_pid); [ -n "$h" ] && [ -n "$j" ] && [ "$(parent_of "$h")" = "$j" ]; }
standby_holds() { local h; h=$(holder); [ -n "$h" ] && [ -n "$standby" ] && { [ "$h" = "$standby" ] || [ "$(parent_of "$h")" = "$standby" ]; }; }
wait_for() { local tries=$1; shift; for _ in $(seq 1 "$tries"); do "$@" && return 0; sleep 0.1; done; return 1; }
stop_standby() { pkill -TERM -P "$standby" 2>/dev/null || true; kill -TERM "$standby" 2>/dev/null || true; }
log_since() { tail -n +"$(($1 + 1))" "$JOB_LOG" 2>/dev/null | grep -q "waiting for port"; }

# The standby holds 8830: start a fresh launchd instance (booting out any old one, which can't hold the port), wait until
# it is initialised and waiting, then stop the standby and confirm launchd's instance took the port.
handback() {
  launchctl bootout "gui/$U/$LABEL" 2>/dev/null || true
  wait_for 50 bash -c "! launchctl print gui/$U/$LABEL >/dev/null 2>&1" || true
  local mark; mark=$(wc -l <"$JOB_LOG" 2>/dev/null || echo 0)
  local ok=""
  for _ in 1 2 3 4 5; do launchctl bootstrap "gui/$U" "$PLIST" 2>/dev/null && { ok=1; break; }; sleep 1; done
  [ -n "$ok" ] || { echo "memory-mcp: launchctl bootstrap failed; standby (pid $standby) keeps serving, unsupervised"; return 1; }
  wait_for 600 log_since "$mark" || { echo "memory-mcp: new launchd instance never got ready; standby (pid $standby) keeps serving"; return 1; }
  stop_standby
  wait_for 600 launchd_holds || { echo "memory-mcp: launchd instance did not take $PORT"; return 1; }
  standby=""
}

recover() {
  local code=$?
  trap - EXIT INT TERM HUP
  if [ -n "$standby" ]; then
    if standby_holds; then handback || code=1
    else stop_standby; launchctl print "gui/$U/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "gui/$U" "$PLIST" 2>/dev/null || true
    fi
  fi
  rm -f "$standby_log"; rmdir "$LOCK" 2>/dev/null || true
  exit "$code"
}
trap recover EXIT
trap 'exit 130' INT TERM HUP

h=$(holder)
if [ -n "$h" ] && ! launchd_holds; then
  # a standby from an interrupted earlier run still serves: adopt it (its wrapper, the holder's parent) and hand back
  standby=$(parent_of "$h"); [ "$standby" = 1 ] && standby=$h
  echo "memory-mcp: adopting standby $standby left by an earlier run"
else
  # 1. standby takes the port
  nohup "$ROOT/bin/run-memory-mcp.sh" >"$standby_log" 2>&1 &
  standby=$!
  wait_for 600 grep -q "waiting for port" "$standby_log" || { echo "standby never got ready: $(tail -3 "$standby_log")"; exit 1; }
  launchctl bootout "gui/$U/$LABEL" 2>/dev/null || true
  wait_for 600 standby_holds || { echo "standby never took $PORT: $(tail -3 "$standby_log")"; exit 1; }
fi

# 2. handback
handback
echo "memory-mcp: pid $(holder) (launchd $(job_pid)) holds $PORT"
