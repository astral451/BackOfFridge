#!/usr/bin/env bash
# Canned sqlite3 queries against the BackOfFridge database, for answering
# "what's actually being used" questions from item_events (the queryable
# purchase/consume/throw-out/edit/undo/delete history - see README's Data
# model section). Requires the sqlite3 CLI on this machine.
#
# Usage:
#   ./common_sql_commands.sh                 # list available commands
#   ./common_sql_commands.sh purchased        # most-purchased items
#   ./common_sql_commands.sh by-user          # activity by user + event type
#   ./common_sql_commands.sh recent           # last 50 events
#   ./common_sql_commands.sh consumed-vs-thrown  # consumed vs thrown-out counts
#
# DB_PATH can be overridden (same convention the server itself uses); it
# defaults to ./data/inventory.db, relative to this script - the same file
# docker-compose bind-mounts into the container.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

DB_PATH="${DB_PATH:-data/inventory.db}"

print_usage() {
  echo "Usage: $0 <command>"
  echo
  echo "Available commands:"
  echo "  purchased            Most-purchased items"
  echo "  by-user              Activity by user and event type"
  echo "  recent               Last 50 events across all items"
  echo "  consumed-vs-thrown   Consumed vs thrown-out counts"
}

query=""
case "${1:-}" in
  purchased)
    query="SELECT item_name, COUNT(*) AS times FROM item_events WHERE event_type='purchased' GROUP BY item_name ORDER BY times DESC LIMIT 20;"
    ;;
  by-user)
    query="SELECT username, event_type, COUNT(*) AS count FROM item_events GROUP BY username, event_type ORDER BY username, count DESC;"
    ;;
  recent)
    query="SELECT created_at, username, event_type, item_name FROM item_events ORDER BY created_at DESC LIMIT 50;"
    ;;
  consumed-vs-thrown)
    query="SELECT event_type, COUNT(*) AS count FROM item_events WHERE event_type IN ('consumed','thrown_out') GROUP BY event_type;"
    ;;
  *)
    print_usage
    [ -n "${1:-}" ] && exit 1
    exit 0
    ;;
esac

# Only get this far for a recognized command - no point demanding sqlite3 or
# the database just to print the usage listing above.
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found on this machine - install it (e.g. apt install sqlite3) and re-run." >&2
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "No database found at $DB_PATH (set DB_PATH to point elsewhere)." >&2
  exit 1
fi

sqlite3 -header -column "$DB_PATH" "$query"
