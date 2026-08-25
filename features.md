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
- Pattern and consumption tracking — every purchase, consume, throw-out,
  edit, undo, and delete is recorded in a real `item_events` table (item
  id/name, event type, JSON detail, timestamp), queryable via
  `GET /api/items/:id/history`. This is the foundation piece the Favorites
  and Low-stock items below were waiting on. No trends/analytics UI over
  this yet (e.g. "average days between purchases") — that's still future
  work, this just makes the data exist and be queryable.
- Low stock indicator, fill-level meter — items can be tracked by `count`
  (the existing numeric quantity, still the default) or `fill_level` (a
  vertical slider, 0-100%, for bin/bulk items or anything easier to eyeball
  than count — a milk jug, a dog food bin). A "Track by fill level" /
  "Track by count" button per item switches modes; a "Low stock" badge
  shows once an item drops to/below its threshold (fill-level items default
  to 25% if no threshold is set; count items need an explicit
  `low_stock_threshold` — there's no sensible universal default across
  different units). The vertical slider is a plain horizontal `<input
  type="range">` rotated with a CSS transform rather than a
  browser-specific vertical-slider API, so it isn't dependent on any one
  browser's implementation — still worth a real check on the Supernote's
  browser, since that's the device that already surfaced one rendering
  issue with a different control (the old location datalist).
- "Edit dates" button — a dedicated action for correcting purchase/expiration
  dates, separate from the location/quantity Edit button. Deliberately left
  out of `item_events` (a date correction isn't a consumption-pattern
  signal), though it's still written to the plain text log. Any edit that
  touches a non-date field is unaffected and still tracked as before.
- "At a Glance" view (`public/glance.html`) — a read-only page with just
  name, location, days until expiration, and count/fill level, no edit
  controls, plus a location filter. For quickly checking status without the
  full inventory table, and a natural fit if the app is ever shared with
  people who should see it but not edit it (raised alongside the
  multi-family idea below). Reuses the same expiration color-coding and
  low-stock badge as the main list, and the existing mobile-stacked layout,
  since it's the same table/CSS pattern.

## Roadmap

- **Login for multiple families** — accounts so more than one household can
  use the same deployment without seeing each other's data.
- **Expose to the outside world, with protections** — currently reachable
  only inside the home network. Making it reachable from anywhere (so other
  family members can check the inventory away from home) needs real auth
  beyond the current single shared `API_KEY` — likely per-person
  credentials rather than one key everyone shares, plus a remote-access
  path (Tailscale/Cloudflare Tunnel, as already noted in the README's
  "Reaching it from your phone" section) rather than a raw port-forward.
  The "At a Glance" read-only view above is a natural low-risk thing to
  expose first, or to give non-editing family members, since it has no
  mutating actions at all.
- **Location customization** — shipped for a single household (locations are
  now a managed list with add/delete). Once multi-family login exists, this
  list needs to be scoped per family like everything else.
- **Barcode/visual scanning** — scan a barcode or product photo to quickly
  re-up an item instead of retyping it (builds on "Buy again").
- **Live search** — a text box that filters the item list as you type, no
  submit button. The app already loads the full active item list into the
  page for the status/location filters, so this is likely a client-side
  filter over that in-memory list (instant, no network round trip, no
  debounce needed) rather than a new server endpoint — worth revisiting
  only if the item list gets large enough that loading everything upfront
  stops being practical. Matching field: item name at minimum; possibly
  notes too, since location already has its own dedicated filter.
- **Favorites filter** — surface the most-purchased items for quick re-up.
  Now unblocked: `item_events` (shipped above) has a `purchased` event per
  purchase, so this is a `GROUP BY item_name` count over that table filtered
  to `event_type = 'purchased'`, rather than needing new tracking.
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
