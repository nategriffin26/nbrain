#!/bin/bash
# Backup (every 6 h under launchd): a consistent pg_dumpall, $BRAIN_HOME (minus raw Postgres data) and this
# repo, to RESTIC_REPOSITORY. More paths: BACKUP_PATHS (space-separated); more excludes: $BRAIN_HOME/backup-excludes
# (restic --exclude-file). An append-only REST server means this machine can't delete or change snapshots.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
set -a; source "$BRAIN_HOME/env"; set +a
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in the env file}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$BRAIN_HOME/restic-password}"

stage="$BRAIN_HOME/backup-stage"
mkdir -p "$stage"
docker exec "$PG_CONTAINER" pg_dumpall -U "$(echo "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:]+):.*#\1#')" >"$stage/postgres.sql.tmp"
mv "$stage/postgres.sql.tmp" "$stage/postgres.sql"

# Repos: everything git doesn't ignore, plus local/.
read -r -a extra <<<"${BACKUP_PATHS:-}"
ignored="$stage/repo-ignored"
: >"$ignored"
for repo in "$ROOT" "${extra[@]}"; do
  [ -d "$repo/.git" ] || continue
  git -C "$repo" ls-files --others --ignored --exclude-standard --directory | grep -v '^local/' | sed -e "s#^#$repo/#" -e 's#/$##' >>"$ignored" || true
done
excludes=(--exclude "$BRAIN_HOME/postgres" --exclude node_modules --exclude-file "$ignored")
[ -f "$BRAIN_HOME/backup-excludes" ] && excludes+=(--exclude-file "$BRAIN_HOME/backup-excludes")

restic backup --host "${BACKUP_HOST:-$(hostname -s)}" --tag brain "${excludes[@]}" "$BRAIN_HOME" "$ROOT" "${extra[@]}"
date -u +%Y-%m-%dT%H:%M:%SZ >"$stage/last-ok"
