# Features

## Shipped

- Log a purchase: name, category (perishable/nonperishable), location (free
  text), quantity, unit, purchase date, expiration date, notes.
- Track status: active / consumed / thrown_out.
- Partial consume/throw-out — remove some of a quantity without wiping out
  the whole item.
- Undo — reverse the most recent consume/throw-out on an item (one level).
- "Buy again" — pre-fills the purchase form from an existing item.
- Dashboard stats: active / expiring soon (≤3 days) / expired counts.
- Filter by status and location.
- REST API (see README) protected by a shared `API_KEY`, documented as the
  future integration point for automation (e.g. voice logging).
- Docker packaging, portable between a home server and a cloud host.

## Roadmap

- **Login for multiple families** — accounts so more than one household can
  use the same deployment without seeing each other's data.
- **Location customization** — let a family define and manage their own named
  storage locations (currently free text with autocomplete; no dedicated
  per-family list or per-location settings yet).
- **Barcode/visual scanning** — scan a barcode or product photo to quickly
  re-up an item instead of retyping it (builds on "Buy again").
- **Favorites filter** — surface the most-purchased items for quick re-up.
  Needs a purchase-count aggregate by item name (current schema tracks each
  purchase as its own row, with no rollup by name yet — counting is a
  `GROUP BY name` query, cheap to add).
- **Dedicated expiration view** — a view sorted/grouped by days-until-expiry
  across all locations, not just the count on the dashboard. The items list
  already sorts by expiration date and color-codes soon/expired rows, so this
  is mostly a focused view/page on data already being tracked, rather than
  new tracking.

## Open design question: multi-family data isolation

Raised when discussing location customization — worth deciding before
building login, since it shapes the schema and every query:

- **Shared DB, tenant column (recommended default):** add a `family_id` to
  `items` (and to a new `locations` table) and scope every query by it.
  One database file, one deployment, cheapest to run and simplest to
  back up. This is the standard approach for a small multi-tenant app and
  is what most SaaS products do at this scale.
- **Separate SQLite file per family:** stronger isolation (a bug can't leak
  data across families since there's no shared table), but means dynamic
  per-request database selection, and N small files to manage/back up
  instead of one.
- **Separate deployment per family:** simplest mental model (fully
  independent apps) but not really "hosting for many families at once" —
  each family would need their own container/URL, closer to what you have
  today for a single household.

None of this is built yet — this is a placeholder for the decision once
login work starts.
