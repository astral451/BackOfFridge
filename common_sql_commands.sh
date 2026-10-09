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
#   ./common_sql_commands.sh by-name          # totals per product, across all its entries
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
  echo "  items                Every item A-Z and whether it's active"
  echo "  by-name              Totals per product name, across all its entries"
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
    # count + unit. Sorted A-Z by name.
    query="
SELECT name, location,
  CASE WHEN tracking_mode = 'fill_level' THEN printf('%g', COALESCE(fill_percent, 100)) || '%'
       ELSE TRIM(printf('%g', quantity) || ' ' || COALESCE(unit, '')) END AS amount,
  CASE WHEN status = 'active' THEN 'yes' ELSE 'no' END AS active,
  status, expiration_date AS expires, id
FROM items
ORDER BY name COLLATE NOCASE, id;"
    ;;
  by-name)
    # Every purchase is its own item row (own id, own expiration date) and
    # stays that way in the app - this only adds them up per product for
    # consumption questions, where every "Grape Waterloo" is the same thing.
    # Names are matched case-insensitively, ignoring stray outer spaces;
    # differently worded names ("Waterloo grape") still count separately.
    # Events use the item's current name (so a rename doesn't split a
    # product), falling back to the name stored on the event for deleted
    # items.
    #   consumed    'consumed' events plus downward quantity quick-sets
    #               ('recount'), minus anything later undone. A fill-level
    #               item counts once when it's used up, not per % step.
    #   thrown_out  'thrown_out' events, minus anything later undone.
    #   on_hand     current quantity across active count-tracked entries,
    #               plus the level of each active fill-level entry (30%).
    query="
WITH ev AS (
  SELECT e.*, LOWER(TRIM(COALESCE(i.name, e.item_name))) AS k, TRIM(COALESCE(i.name, e.item_name)) AS nm
  FROM item_events e LEFT JOIN items i ON i.id = e.item_id
),
kept AS (
  -- drop a consume/throw-out that a later undo on the same item reversed
  -- (undo is one level: it reverses the most recent one before it)
  SELECT * FROM ev r
  WHERE r.event_type NOT IN ('consumed', 'thrown_out')
     OR NOT EXISTS (
       SELECT 1 FROM item_events u
       WHERE u.item_id = r.item_id AND u.event_type = 'undo' AND u.id > r.id
         AND NOT EXISTS (
           SELECT 1 FROM item_events x
           WHERE x.item_id = r.item_id AND x.event_type IN ('consumed', 'thrown_out')
             AND x.id > r.id AND x.id < u.id))
),
used AS (
  SELECT k, nm, event_type, created_at,
    CASE
      WHEN event_type = 'consumed' THEN COALESCE(json_extract(detail, '\$.quantity'), 0)
      WHEN event_type = 'recount' AND json_extract(detail, '\$.field') = 'quantity'
           AND json_extract(detail, '\$.to') < json_extract(detail, '\$.from')
        THEN json_extract(detail, '\$.from') - json_extract(detail, '\$.to')
      ELSE 0 END AS consumed_amt,
    CASE WHEN event_type = 'thrown_out' THEN COALESCE(json_extract(detail, '\$.quantity'), 0) ELSE 0 END AS thrown_amt
  FROM kept
),
per AS (
  SELECT k, MAX(nm) AS nm,
    SUM(event_type = 'purchased') AS purchased,
    SUM(consumed_amt) AS consumed,
    SUM(thrown_amt) AS thrown_out,
    MAX(CASE WHEN consumed_amt > 0 THEN created_at END) AS last_used_utc
  FROM used GROUP BY k
),
inv AS (
  SELECT LOWER(TRIM(name)) AS k, COUNT(*) AS entries,
    SUM(status = 'active') AS active,
    SUM(status = 'active' AND tracking_mode <> 'fill_level') AS count_entries,
    SUM(CASE WHEN status = 'active' AND tracking_mode <> 'fill_level' THEN quantity ELSE 0 END) AS on_hand,
    GROUP_CONCAT(CASE WHEN status = 'active' AND tracking_mode = 'fill_level'
                      THEN printf('%g%%', COALESCE(fill_percent, 100)) END, ', ') AS fill_levels
  FROM items GROUP BY k
),
-- display name: the spelling most entries use (latest entry breaks a tie)
spelling AS (
  SELECT k, nm FROM (
    SELECT LOWER(TRIM(name)) AS k, TRIM(name) AS nm,
      ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY COUNT(*) DESC, MAX(id) DESC) AS rn
    FROM items GROUP BY LOWER(TRIM(name)), TRIM(name)
  ) WHERE rn = 1
),
keys AS (SELECT k FROM per UNION SELECT k FROM inv)
SELECT COALESCE(spelling.nm, per.nm) AS product,
  COALESCE(inv.entries, 0) AS entries,
  COALESCE(inv.active, 0) AS active,
  CASE WHEN inv.fill_levels IS NULL THEN printf('%g', COALESCE(inv.on_hand, 0))
       WHEN inv.count_entries = 0 THEN inv.fill_levels
       ELSE printf('%g', inv.on_hand) || ' + ' || inv.fill_levels END AS on_hand,
  COALESCE(per.purchased, 0) AS purchased,
  printf('%g', COALESCE(per.consumed, 0)) AS consumed,
  printf('%g', COALESCE(per.thrown_out, 0)) AS thrown_out,
  per.last_used_utc
FROM keys
LEFT JOIN inv ON inv.k = keys.k
LEFT JOIN spelling ON spelling.k = keys.k
LEFT JOIN per ON per.k = keys.k
ORDER BY COALESCE(per.consumed, 0) DESC, product COLLATE NOCASE;"
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
