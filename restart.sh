#!/usr/bin/env bash
# Restarts the BackOfFridge container, backing up the database first.
#
# Usage:
#   ./restart.sh          # stop, back up, start
#   ./restart.sh --build  # stop, back up, rebuild the image, start (use
#                          # this after a `git pull` that changed code)
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
KEEP=10

if [ ! -d data ]; then
  echo "No ./data folder found yet - nothing to back up (first run?)."
else
  mkdir -p "$BACKUP_ROOT"
  stamp=$(date +%Y%m%d-%H%M%S)
  dest="$BACKUP_ROOT/$stamp"

  echo "Stopping container..."
  docker compose stop

  echo "Backing up data/ -> $dest"
  cp -r data "$dest"

  # Keep only the most recent $KEEP backups so this doesn't grow unbounded
  # across repeated restarts.
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
fi

if [ "${1:-}" = "--build" ]; then
  echo "Rebuilding and starting..."
  docker compose up -d --build
else
  echo "Starting..."
  docker compose start
fi

echo "Done."
