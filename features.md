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
- **Pattern and consumption tracking** — record every action (purchase,
  consume, throw-out, edit, undo) with a timestamp, so trends over time
  become answerable: how often something's rebought, how much of it
  typically gets thrown out vs. used, which days it tends to get consumed,
  etc.

  This needs a real, structured, append-only event history — something the
  app doesn't have today. What exists now is two things, neither of which
  is this: the text log file (README's "Logging" section) is human-readable
  lines in a file, not a queryable table; and `prev_status`/`prev_quantity`
  on `items` is a single-slot memory for one-level undo, overwritten on the
  next action, not a history. A proper `item_events` table (item id + name,
  event type, quantity delta, from/to status, timestamp) would be the
  foundation piece — and directly feeds two other roadmap items above: the
  favorites purchase-count and the low-stock estimated-depletion-date option
  both need exactly this kind of history to compute from.
- **Favorites filter** — surface the most-purchased items for quick re-up.
  Needs a purchase-count aggregate by item name (current schema tracks each
  purchase as its own row, with no rollup by name yet — counting is a
  `GROUP BY name` query, cheap to add).
- **Quick +/- for single-serve items** — a faster path than the current
  prompt for the common case of "used one." Direction: tapping Consume
  normally decrements by 1 immediately (no prompt), and a long-press opens
  the existing quantity prompt for anything other than 1 (a specific amount,
  or the whole remaining quantity). Throw-out likely gets the same tap/
  long-press split for consistency. This changes today's `promptQuantity`
  behavior (public/app.js), which currently always prompts whenever quantity
  > 1 — the new default skips the prompt for the ordinary single-unit case
  and only asks when the person deliberately holds for it.
- **Narrow-width layout: trim to the essentials** — on a constrained screen,
  actively drop low-value fields instead of just reflowing everything.
  Called out as non-critical at a glance: purchase date, category, and the
  status column. What matters at a glance: is it expired or close to it,
  and how much is left. This refines existing behavior rather than adding
  responsiveness from scratch — `public/styles.css` already has a
  `max-width: 600px` breakpoint that stacks the table into per-item cards,
  but today that stacks *every* field (including the ones called out here
  as unnecessary) rather than dropping any. Status is already conveyed
  visually anyway via row color-coding (`rowClass` in `public/app.js`:
  expired/expiring-soon/thrown_out/consumed) — dropping the redundant text
  status column on narrow layouts loses no information, though it likely
  needs a small legend since color alone isn't self-explanatory to a new
  viewer of the page.
- **Dedicated expiration view** — refined into two specific pages: an
  **Expired** page and an **Expiring soon (< 3 days)** page, rather than one
  general view. Both are filters over data already tracked (expiration_date +
  status), so this is close to a pure UI addition — reuse the existing
  items-list rendering with a fixed filter instead of the location/status
  dropdowns.
- **Low stock indicator** — flag an item as running low, so it shows up
  without having to notice the quantity yourself. Straightforward for
  countable items (e.g. paper towels: alert once quantity drops to/below a
  threshold), harder for bulk/bin items (a giant bag of dog food) where
  quantity was never a meaningful discrete count to begin with.

  **Direction chosen: a visual fill-level meter**, not a numeric threshold.
  A vertical slider/meter per item — drag it to roughly where the item is
  (half full, a quarter left) — used for both the genuinely bulk case (the
  dog food bin) and any item where eyeballing fullness is just easier than
  counting units (a gallon of milk). Low-stock is then "fill level below
  some threshold, e.g. 25%" rather than a unit count at all.

  Implementation notes, not yet built:
  - This is a different tracking mode from the existing numeric `quantity`
    field, so items likely need a per-item choice of tracking mode — e.g.
    `tracking_mode: 'count' | 'fill_level'` plus a `fill_percent` (0-100)
    field — rather than replacing quantity outright, since plenty of items
    (a 12-pack) are still better tracked as a count.
  - Threshold for "running low" at the fill-level: still open — probably a
    sensible global default (e.g. ≤25%) with a per-item override, since
    "low" means something different for a bin you refill occasionally vs.
    a jug you finish in a week.
  - Interaction risk worth testing early: a true vertical range/slider
    control has inconsistent cross-browser support (native `<input
    type="range">` only orients vertically in some browsers; others need
    CSS rotation tricks), and this app has already hit one instance of a
    control not rendering usably on the Supernote's browser (the location
    datalist). Worth a quick real-device check on Supernote before
    committing to a specific slider implementation.

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
