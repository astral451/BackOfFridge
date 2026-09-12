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

# Placeholder until real schema version tracking exists (a schema_migrations
# table in the db, per the earlier discussion) - hardcoded for now so every
# backup already carries a SCHEMA_VERSION file in the format the eventual
# real system will use. Once that lands, replace this with something that
# reads the actual applied version out of the database instead.
SCHEMA_VERSION="unversioned"

echo "Stopping container..."
docker compose stop

if [ ! -d data ]; then
  echo "No ./data folder found yet - nothing to back up (first run?)."
else
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
