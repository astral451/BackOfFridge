# Features

## Shipped

- Log a purchase: name, category (perishable/nonperishable), location (free
  text), quantity, unit, purchase date, expiration date, notes.
- Track status: active / consumed / thrown_out.
- Partial consume/throw-out — remove some of a quantity without wiping out
  the whole item.
- Undo — reverse the most recent consume/throw-out on an item (one level).
- "Buy again" — pre-fills the purchase form from an existing item.
- Edit an item's location or quantity directly (PATCH endpoint already
  supported any field; this exposes location/quantity in the UI).
- Locations are now a managed list (their own table, not just whatever text
  happens to be on items): a "Manage locations" page shows each location with
  its item count, lets you add a new one, and delete an unused one (deletion
  is refused if any item still references it).
- Dashboard stats: active / expiring soon (≤3 days) / expired counts.
- Filter by status and location.
- REST API (see README) protected by a shared `API_KEY`, documented as the
  future integration point for automation (e.g. voice logging).
- Docker packaging, portable between a home server and a cloud host.
- Access and purchase logging — every API request logs an ACCESS/ACCESS
  DENIED line, purchases log a friendlier line, both to stdout and a
  persisted log file (see README).

## Roadmap

- **Login for multiple families** — accounts so more than one household can
  use the same deployment without seeing each other's data.
- **Location customization** — shipped for a single household (locations are
  now a managed list with add/delete). Once multi-family login exists, this
  list needs to be scoped per family like everything else.
- **Barcode/visual scanning** — scan a barcode or product photo to quickly
  re-up an item instead of retyping it (builds on "Buy again").
- **Favorites filter** — surface the most-purchased items for quick re-up.
  Needs a purchase-count aggregate by item name (current schema tracks each
  purchase as its own row, with no rollup by name yet — counting is a
  `GROUP BY name` query, cheap to add).
- **Dedicated expiration view** — refined into two specific pages: an
  **Expired** page and an **Expiring soon (< 3 days)** page, rather than one
  general view. Both are filters over data already tracked (expiration_date +
  status), so this is close to a pure UI addition — reuse the existing
  items-list rendering with a fixed filter instead of the location/status
  dropdowns.
- **Low stock indicator** — flag an item as running low, so it shows up
  without having to notice the quantity yourself. Straightforward for
  countable items (e.g. paper towels: alert once quantity drops to/below a
  threshold — likely a per-item or per-name "low stock at" number, since a
  sensible threshold varies by item).

  Harder case, called out specifically: bulk/bin items like a giant bag of
  dog food, where quantity was never a meaningful discrete count to begin
  with, so it doesn't decrement per use the way a countable item does.
  Quantity-based thresholds don't work here since there's no reliable
  quantity being tracked. Candidate approaches, undecided:
  - Manual status: a "running low" toggle/flag the person sets by eye,
    independent of quantity.
  - Estimated depletion date: infer roughly when it'll run out from the
    average time between past purchases of that item (needs the favorites/
    purchase-history aggregate above), surfacing it a few days before the
    predicted date rather than tracking a count at all.
  - A rough percentage-remaining field, updated manually on occasion (e.g.
    "1/4 left"), converted to a threshold check instead of a unit count.

  No decision yet — needs to be picked before building this, since it
  determines whether it's a variant of the quantity system or a separate
  mechanism entirely.

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

**Decision: shared DB, tightly controlled queries.**

The concern raised: if a client can influence which family's rows a query
returns (e.g. a `family_id` in a URL param or request body), that's an IDOR
(Insecure Direct Object Reference) — anyone who guesses/changes that value
reads another family's data. That's a real risk, but it's a risk in *how
queries are written*, not in sharing one database file. Handled correctly,
this is the same model most multi-tenant SaaS apps use (one shared database,
isolated per customer entirely through server-enforced scoping) — e.g.
Stripe and GitHub both work this way.

The rule that makes it safe: **the server derives `family_id` from
server-side auth state (the logged-in session), never from anything the
client sends.** A request can't ask for another family's data because no
parameter exists that would let it — there's nothing to tamper with.

To make that hold structurally rather than by developer discipline alone:
- Every data-access function takes `family_id` as a required first
  argument — e.g. `getItems(familyId, filters)` — so it's a compile-time-ish
  error to write a query that forgets it, rather than a habit to remember
  route by route.
- The `family_id` value itself only ever comes from the authenticated
  session in middleware, attached to `req`, never read from `req.query`,
  `req.body`, or `req.params`.
- New endpoints get a quick check in review: does this handler's query take
  `family_id` from the session-derived value, not from client input?

If this stops feeling sufficient later, the fallback is the separate-SQLite-
file-per-family option above, which enforces isolation at the filesystem
level instead of the query level — but that's not needed today.
