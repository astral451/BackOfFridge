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
#   ./common_sql_commands.sh catch-up         # bursts of quick reductions
#   ./common_sql_commands.sh items            # every item, and whether it's active
#
# catch-up finds rapid runs of reductions on one item (several - taps a
# few minutes apart) - almost always catching the app up on consumption
# that really happened gradually since the item's previous event, not
# consumption at that moment (see features.md, "Usage analysis"). A
# downward quick-set ('recount' event, typed in by tapping the amount) is
# an explicit catch-up, so it's listed even on its own. Tunable:
#   BURST_MINUTES   max minutes between taps in one burst (default 10)
#   BURST_MIN_TAPS  fewest taps that count as a burst (default 3)
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
  echo "  catch-up             Bursts of quick reductions (catch-up, not real-time use)"
  echo "  items                Every item and whether it's active (active first)"
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
  items)
    # Reads the items table itself (current state), not item_events.
    # Amount shows the fill level for fill-tracked items, otherwise the
    # count + unit. Active items first, then by location and name.
    query="
SELECT id, name, location,
  CASE WHEN tracking_mode = 'fill_level' THEN printf('%g', COALESCE(fill_percent, 100)) || '%'
       ELSE TRIM(printf('%g', quantity) || ' ' || COALESCE(unit, '')) END AS amount,
  CASE WHEN status = 'active' THEN 'yes' ELSE 'no' END AS active,
  status, expiration_date AS expires
FROM items
ORDER BY status <> 'active', location COLLATE NOCASE, name COLLATE NOCASE;"
    ;;
  catch-up)
    BURST_MINUTES="${BURST_MINUTES:-10}"
    BURST_MIN_TAPS="${BURST_MIN_TAPS:-3}"
    case "$BURST_MINUTES$BURST_MIN_TAPS" in
      *[!0-9]*) echo "BURST_MINUTES and BURST_MIN_TAPS must be whole numbers." >&2; exit 1 ;;
    esac
    # A reduction is a 'consumed' event (count items, or a fill-level item
    # taken to empty), a 'fill_level_set' that went down, or a 'recount'
    # that went down. A new burst
    # starts whenever the gap since the item's previous reduction exceeds
    # BURST_MINUTES; bursts with fewer than BURST_MIN_TAPS taps are dropped.
    # days_since_prev is the window the burst's consumption really happened
    # in: from the item's last event of any kind before the burst. Times
    # are UTC, as stored.
    query="
WITH reductions AS (
  SELECT id, item_id, item_name, created_at,
    CASE WHEN event_type = 'consumed' THEN COALESCE(json_extract(detail, '\$.quantity'), 0)
         ELSE json_extract(detail, '\$.from') - json_extract(detail, '\$.to') END AS amount,
    CASE WHEN event_type = 'fill_level_set' THEN '%'
         ELSE COALESCE(json_extract(detail, '\$.unit'), '') END AS unit,
    event_type = 'recount' AS is_recount
  FROM item_events
  WHERE event_type = 'consumed'
     OR (event_type IN ('fill_level_set', 'recount') AND json_extract(detail, '\$.to') < json_extract(detail, '\$.from'))
),
gaps AS (
  SELECT *, LAG(created_at) OVER (PARTITION BY item_id ORDER BY created_at, id) AS prev_at
  FROM reductions
),
numbered AS (
  SELECT *, SUM(CASE WHEN prev_at IS NULL
                       OR (julianday(created_at) - julianday(prev_at)) * 1440 > $BURST_MINUTES
                     THEN 1 ELSE 0 END)
            OVER (PARTITION BY item_id ORDER BY created_at, id) AS burst
  FROM gaps
),
bursts AS (
  SELECT item_id, item_name, MIN(id) AS first_id, MIN(created_at) AS started_utc,
    COUNT(*) AS taps, SUM(amount) AS total, MAX(unit) AS unit,
    ROUND((julianday(MAX(created_at)) - julianday(MIN(created_at))) * 1440, 1) AS span_min,
    CASE WHEN MAX(is_recount) = 1 THEN 'recount' ELSE 'taps' END AS via
  FROM numbered
  GROUP BY item_id, burst
  HAVING COUNT(*) >= $BURST_MIN_TAPS OR MAX(is_recount) = 1
)
SELECT b.item_name, b.started_utc, b.via, b.taps, b.span_min,
  -- a unit that's itself a size ('.63 oz', '12 oz') reads as a multiple
  TRIM(b.total || CASE WHEN b.unit GLOB '[0-9.]*' THEN ' x ' ELSE ' ' END || b.unit) AS total_reduced,
  ROUND(julianday(b.started_utc) - julianday(
    (SELECT MAX(e.created_at) FROM item_events e WHERE e.item_id = b.item_id AND e.id < b.first_id)
  ), 1) AS days_since_prev
FROM bursts b
ORDER BY b.started_utc DESC;"
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
