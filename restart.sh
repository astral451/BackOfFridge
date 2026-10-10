#!/usr/bin/env bash
# Restarts the BackOfFridge container: backs up the database, pulls the
# latest code, and rebuilds if anything actually changed.
#
# Usage:
#   ./restart.sh          # stop, back up, git pull, start (rebuilding
#                          # automatically if the pull brought in new code)
#   ./restart.sh --build  # same, but always rebuild even if the pull was
#                          # a no-op (e.g. you changed something else, like
#                          # a Dockerfile base image, without a new commit)
#
# The backup is a stopped-container copy of the whole ./data folder (not
# just inventory.db) - the database runs in WAL mode, so recent writes can
# still be sitting in inventory.db-wal rather than the main file, and
# copying only the .db file while it's running could miss them. This
# mirrors the manual recipe in the README's "Backing up before pulling an
# update" section.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BACKUP_ROOT="data-backups"
KEEP=20

# Prints the schema version recorded in data/inventory.db: the highest
# applied migration, "unversioned" for a database from before versioning
# existed, "none" if there's no database yet, or "unknown" if it can't be
# read. Runs a throwaway container from the current image (the server's own
# Node + better-sqlite3), so nothing extra is needed on the host; falls back
# to a host sqlite3 if that's installed. Called while the server is stopped,
# so the version can't change underneath it.
read_schema_version() {
  local js='
    const fs = require("fs");
    const p = process.env.DB_PATH;
    if (!fs.existsSync(p)) { console.log("none"); process.exit(0); }
    const db = new (require("better-sqlite3"))(p);
    const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type=\x27table\x27 AND name=\x27schema_migrations\x27").get();
    console.log(t ? db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get().v : "unversioned");
  '
  local v
  if v=$(docker compose run --rm --no-deps -T backoffridge node -e "$js" 2>/dev/null) && [ -n "$v" ]; then
    echo "$v" | tail -n 1
  elif command -v sqlite3 >/dev/null && [ -f data/inventory.db ]; then
    sqlite3 data/inventory.db "SELECT COALESCE(MAX(version), 0) FROM schema_migrations" 2>/dev/null || echo "unversioned"
  else
    echo "unknown"
  fi
}

echo "Stopping container..."
docker compose stop

if [ ! -d data ]; then
  echo "No ./data folder found yet - nothing to back up (first run?)."
else
  SCHEMA_VERSION=$(read_schema_version)
  mkdir -p "$BACKUP_ROOT"
  stamp=$(date +%Y%m%d-%H%M%S)
  dest="$BACKUP_ROOT/$stamp"

  echo "Backing up data/ -> $dest (schema version: $SCHEMA_VERSION)"
  cp -r data "$dest"
  echo "$SCHEMA_VERSION" > "$dest/SCHEMA_VERSION"

  # Keep only the most recent $KEEP backups so this doesn't grow unbounded
  # across repeated restarts.
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
fi

echo "Pulling latest code..."
if [ -n "$(git status --porcelain)" ]; then
  echo "Local changes in the repo - not pulling automatically." >&2
  echo "Commit, stash, or discard them first, then re-run." >&2
  exit 1
fi
before=$(git rev-parse HEAD)
git pull
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
  echo "Code changed ($before -> $after)."
  rebuild=1
else
  echo "Already up to date."
  rebuild=0
fi

if [ "${1:-}" = "--build" ] || [ "$rebuild" = "1" ]; then
  echo "Rebuilding and starting..."
  docker compose up -d --build
else
  echo "Starting..."
  docker compose start
fi

echo "Done."
