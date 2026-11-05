#!/usr/bin/env bash
# Updates and restarts the BackOfFridge server: checks nobody is using the
# app, pulls the latest code, builds it while the old server keeps running,
# then stops it, backs up the database and starts the new version. Downtime
# is just the stop, backup and start: usually a few seconds.
#
# Usage:
#   ./restart.sh            # check, pull, build if the pull brought new code,
#                           # stop, back up, start
#   ./restart.sh --build    # same, but always rebuild even if the pull was
#                           # a no-op (e.g. you changed something else, like
#                           # a Dockerfile base image, without a new commit)
#   ./restart.sh --force    # don't ask when someone is online
#
# Before anything else it runs scripts/activity.js in the running server.
# If someone has had the app open in the last 2 minutes it names them and
# asks whether to go ahead (or stops, when there's no terminal to ask in).
#
# Just before stopping, it creates data/MAINTENANCE: the server then answers
# API calls with "being updated", and open pages show that notice until the
# new server is up (public/connection.js). The new server removes the file
# when it starts, and so does this script when it exits.
#
# The backup is a stopped-container copy of the whole ./data folder (not
# just inventory.db) - the database runs in WAL mode, so recent writes can
# still be sitting in inventory.db-wal rather than the main file, and
# copying only the .db file while it's running could miss them. This
# mirrors the manual recipe in the README's "Backing up before pulling an
# update" section. The schema version it records is the database's, from
# before the new code has run against it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BACKUP_ROOT="data-backups"
KEEP=20
SERVICE="backoffridge"

FORCE=0
BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --force) FORCE=1 ;;
    *) echo "Unknown option: $arg (use --build and/or --force)" >&2; exit 1 ;;
  esac
done

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

# Asks the running server who's online. Exit code 3 from activity.js means
# someone is. An older server without the script, or a stopped one, is no
# reason to block the update.
check_activity() {
  if [ -z "$(docker compose ps -q --status running "$SERVICE" 2>/dev/null)" ]; then
    echo "Server isn't running - skipping the activity check."
    return 0
  fi
  echo "Checking who's using the app..."
  local status=0
  docker compose exec -T "$SERVICE" node scripts/activity.js || status=$?
  if [ "$status" = 0 ]; then
    return 0
  elif [ "$status" != 3 ]; then
    echo "(Couldn't check activity - the running version may be too old to have it. Continuing.)"
    return 0
  fi
  if [ "$FORCE" = 1 ]; then
    echo "--force: updating anyway."
    return 0
  fi
  if [ -t 0 ]; then
    local answer
    read -r -p "Someone is using the app right now. Update anyway? [y/N] " answer
    case "$answer" in
      y|Y|yes|YES) return 0 ;;
    esac
  fi
  echo "Not updating. Try again in a few minutes, or run with --force." >&2
  exit 1
}

# Everything below is one { ... } block ending in exit: bash reads the whole
# block before running it, so the git pull replacing this file mid-run can't
# change what's executed.
{
if [ -n "$(git status --porcelain)" ]; then
  echo "Local changes in the repo - not updating." >&2
  echo "Commit, stash, or discard them first, then re-run." >&2
  exit 1
fi

check_activity

echo "Pulling latest code..."
before=$(git rev-parse HEAD)
git pull
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
  echo "Code changed ($before -> $after)."
  BUILD=1
else
  echo "Already up to date."
fi

if [ "$BUILD" = 1 ]; then
  echo "Building the new version (the current server keeps running meanwhile)..."
  docker compose build "$SERVICE"
fi

if [ -d data ]; then
  trap 'rm -f data/MAINTENANCE' EXIT
  touch data/MAINTENANCE 2>/dev/null \
    || echo "(Couldn't create data/MAINTENANCE - open pages will still notice once the server stops.)"
fi

echo "Stopping server..."
docker compose stop "$SERVICE"

if [ ! -d data ]; then
  echo "No ./data folder found yet - nothing to back up (first run?)."
else
  SCHEMA_VERSION=$(read_schema_version)
  mkdir -p "$BACKUP_ROOT"
  stamp=$(date +%Y%m%d-%H%M%S)
  dest="$BACKUP_ROOT/$stamp"

  echo "Backing up data/ -> $dest (schema version: $SCHEMA_VERSION)"
  cp -r data "$dest"
  rm -f "$dest/MAINTENANCE"
  echo "$SCHEMA_VERSION" > "$dest/SCHEMA_VERSION"

  # Keep only the most recent $KEEP backups so this doesn't grow unbounded
  # across repeated restarts.
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
fi

echo "Starting..."
docker compose up -d

echo "Done."
exit 0
}
