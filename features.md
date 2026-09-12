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
- REST API (see README), documented as the future integration point for
  automation (e.g. voice logging) — originally protected by a shared
  `API_KEY`, since replaced by real per-user login (below).
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
- Cloudflare Tunnel documentation + optional `docker-compose.yml` service —
  the recommended path for reaching the app from outside the home network
  without a router port-forward (README's "Cloudflare Tunnel" section
  covers both a free zero-setup Quick Tunnel for testing and a stable
  Named Tunnel for a permanent hostname). The `cloudflared` service in
  `docker-compose.yml` only starts if `TUNNEL_TOKEN` + `COMPOSE_PROFILES=tunnel`
  are set, so a plain `docker compose up` is unaffected otherwise.
- Per-user login — replaces the single shared `API_KEY` with real accounts
  (username + password, hand-rolled session cookie/`sessions` table rather
  than a session-store library). Deliberately scoped down from full
  multi-family isolation: no `family_id`, no separate households, no
  invite-code/join flow — one shared inventory, same as before, just with
  per-person accounts instead of one password everyone knows. `item_events`
  rows are now attributed to the `username` who caused them — the concrete
  motivating case: if one family member already reduced the milk, another
  checking the history sees that and doesn't duplicate the update.
  Verified with curl (signup/login/logout, wrong password rejected, a
  second user's action correctly attributed in another user's view of the
  same item's history) and a headless-browser run of the actual signup →
  redirect → logged-in flow. Full multi-family isolation is shelved below
  as a distinct, larger, "only if actually needed" item — it isn't required
  for this and wasn't built.
- Location matching is now case-insensitive — `locations.name` has a
  `COLLATE NOCASE` primary key (a guarded recreate-and-copy migration for
  existing databases, since SQLite can't alter a column's collation in
  place), so "Fridge" and "fridge" are treated as the same managed
  location instead of silently becoming two. Every query comparing
  `items.location` against `locations.name` (the `/locations/detail` join,
  the delete-in-use check, the `GET /api/items?location=` filter) got an
  explicit `COLLATE NOCASE` added too, since SQLite's collation-precedence
  rule favors the left operand's own collation and `items.location` has
  none declared — relying on `locations.name`'s NOCASE alone wouldn't have
  been enough.
- The Edit button's location field is now a real `<select>` instead of a
  `window.prompt()` (which is plain text only and can't render a
  dropdown) — clicking Edit swaps the row's actions cell for an inline
  panel with a location dropdown (populated from `GET /api/locations`,
  pre-selected to the current value) plus a quantity input and Save/
  Cancel buttons.
- Live search across all fields, and sorting — a search box filters the
  item list as you type (name, location, category, tag, notes, unit,
  status, case-insensitive substring match), and a sort control switches
  between the default expiration-first order, recently-added, and name.
  Both operate client-side on the already-loaded item list (`lastItems` in
  `public/app.js`), no new network round trips.
- Item categorization ("tags") — a second single-value managed list,
  distinct from the existing `category` field (which stays the
  perishable/nonperishable enum, untouched). Mirrors the Locations pattern
  end-to-end: a case-insensitive `tags` table, a "Manage tags" page
  (`public/tags.html`), a tag `<select>` in the purchase form, a Tag
  column and filter dropdown in the item list, and `GET/POST/DELETE
  /api/tags` routes (delete refused while any item still references the
  tag).
- Quick-add dictation box — a freeform text input above the purchase form.
  Dictation itself needed no app code (every phone keyboard already
  dictates into any text field); `parseQuickAdd()` (`public/app.js`)
  pre-fills the existing detailed form for the user to review and adjust —
  it does not submit directly, since the parser is a heuristic and stays
  fragile on truly odd phrasing. Commas are treated as absolute separators
  when present (segment 0 is always the name); without one, a tokenized
  pass works from the outer boundaries inward — a trailing location match,
  then a trailing tag match, then a trailing quantity/unit match, with
  whatever's left at the front becoming the name — so "Raw carrots 1 5lb
  kitchen fridge" and "Raw carrots quantity 1, 5 pounds, kitchen fridge"
  land on the same result. Location/tag matching is fuzzy (a small
  Levenshtein matcher), so a typo like "Dinng Fridge" still finds a
  managed "Dining Fridge". An "expires ..." phrase is also recognized:
  a month-name or numeric date (month-day-year, matching this app's own
  date inputs) or a duration ("in 1 week") relative to the purchase date,
  pre-filling the expiration field. Dictation splitting a teen number at
  the syllable boundary ("four teen" for "fourteen") is joined back to a
  numeral before any of this runs; not extended past nineteen, since
  dictation reliably gives plain digits beyond that.
- Quick +/- buttons — a `−`/`+` pair next to each active item's quantity
  (full item list) or count (At a Glance), for the common "used/added one"
  case with no prompt. Count-tracked items step by 1 (`−` calls `/consume`
  for one unit, `+` is a plain quantity PATCH); fill-level items step by
  10 percentage points, and a `−` at or below 10% fully consumes the item
  instead of going negative, mirroring how `reduceQuantity`
  (`server/src/routes/items.js`) already floors a count-based consume at
  zero server-side. At a Glance is otherwise read-only by design — this is
  a deliberate small exception for one fast, low-risk action. A specific
  amount, or throwing out instead of consuming, still goes through the
  existing prompt/button flow.
- Full-field edit view — the overflow menu's "Edit" action opens the same
  purchase-sheet form used to log a new item, pre-filled with every editable
  field (name, category, location, tag, quantity/unit or a Fill % input
  shown only for fill-tracked items, purchase/expiration dates, notes), and
  submits a PATCH to the existing item instead of a POST. Replaced an
  earlier row-based inline editor (`startFullFieldEdit`, one colspan'd table
  cell) that predated the phone-first restyle's grouped-div item list and
  had gone silently broken in translation (an inner helper function
  accidentally shadowed the row-element parameter of the same name) — reusing
  the existing purchase sheet instead of re-fixing a second bespoke editor
  means there's only one form's worth of fields/validation to maintain.
- Phone-first restyle ("Cold Storage") — a full visual and structural pass
  built for a phone held in one hand first, on the `claude/phone-first-restyle`
  branch. Items group by location into collapsible sections (`public/app.js`'s
  `renderItems`, collapse state kept in a module-level `collapsedGroups`); a
  fixed bottom bar carries quick-add and a "+" that opens a sliding sheet
  (a permanent side panel at ≥720px instead) for the full purchase form;
  every row gets one "⋯" overflow menu for its secondary actions (throw out,
  consume, undo, edit, change tracking mode, buy again, delete) instead of a
  wall of buttons; a uniform-width +/- stepper keeps count and fill-level
  rows aligned, with the fill-percentage bar stacked below the buttons
  rather than squeezed beside them. At ≥720px the purchase form also shows
  every field at once instead of behind "More fields ▾", since there's room
  for it there. Status chips (All/Active/Expiring soon/Low stock) replace
  the old "active only" checkbox and satisfy what the Roadmap used to list
  as a separate "Dedicated expiration view" — Expiring soon/Low stock
  reuse data already computed per item, no new query needed. A
  "Search, filter, sort ▾" disclosure holds the existing location/tag/
  search/sort controls (search first, since it's the most-used one), with a
  one-tap Reset button next to the toggle whenever any of them is active.
  The quick-add "+" button also processes whatever's still sitting in the
  quick-add box (dictation often leaves text there without a keyboard
  Return press) instead of silently discarding it in favor of a blank form.
- Light theme, auto-switching ("Pantry Fresh") — a warm cream, sage-green
  light palette, now the default alongside the original dark "Cold Storage"
  one. Every color already ran through CSS custom properties from the
  restyle above, so adding a second theme meant only restructuring
  `:root` in `public/styles.css`: light tokens as the default, dark tokens
  moved under `@media (prefers-color-scheme: dark)` — the app follows the
  browser/OS setting automatically.
- Settings page (`public/settings.html`) — an Appearance control
  (Auto/Light/Dark) overriding the OS theme per-browser, stored in
  `localStorage` and applied by a small inline script at the top of every
  page's `<head>` (before the stylesheet loads, so there's no flash of the
  wrong theme). `styles.css` gains matching `:root[data-theme="dark"]` and
  `:not([data-theme="light"])`-guarded override blocks so an explicit
  choice wins over the OS setting in either direction. Built ahead of the
  planned photo capture/recall feature specifically so that has a page to
  land in later without needing its own settings infrastructure built at
  the same time — no image-related UI shipped yet.
- Automated restart + backup (`restart.sh`) — stops the container, backs up
  the whole `data/` folder (not just `inventory.db` — WAL mode means recent
  writes can still be sitting in a separate `-wal` file) into
  `data-backups/<timestamp>`, pruned to the most recent 20, then `git pull`s
  and rebuilds the Docker image only if the pull actually moved `HEAD`
  (otherwise just restarts, keeping a no-op run fast). Refuses to pull over
  an uncommitted local change rather than risking a mid-script merge
  conflict. Each backup is tagged with a placeholder `SCHEMA_VERSION` file
  (currently just `"unversioned"`), ready for the real schema-version
  tracking system below once that exists.
- Usage-history query tool (`common_sql_commands.sh`) — canned `sqlite3`
  queries over the `item_events` table for "what's actually being used"
  questions without hand-writing SQL each time: most-purchased items,
  activity by user and event type, a recent-activity feed, and
  consumed-vs-thrown-out counts. Run with no arguments to list the
  available commands (works even without `sqlite3` installed or a database
  present yet, checked before either of those).

## Roadmap

Difficulty grades below (Low/Medium/High) are rough cost/complexity, not
priority — a Low item isn't necessarily more worth doing than a High one.

- **Location customization** — shipped for a single household (locations are
  now a managed list with add/delete). If full multi-family isolation is
  ever built (see the shelved item below), this list would need to be
  scoped per family like everything else — not needed for the single
  shared inventory this app has today.
- **Barcode/visual scanning** — scan a barcode or product photo to quickly
  re-up an item instead of retyping it (builds on "Buy again").
- **Photo capture + recall (Low/Medium)** — **decided: manual only, no
  recognition, at least for now.** Store a photo per item (new
  `item_photos` table or a `photo_path` column; files under the existing
  bind-mounted `/data` directory alongside `inventory.db`, served the same
  way `public/` is). "Recall" means browsing a small photo gallery and
  tapping the match — reuses the existing `fillFormFromItem` pre-fill in
  `public/app.js` once picked, just a visual way to find the item instead
  of the text list. Needs one new small dependency (`multer`, for the
  upload) and a mobile file input with `capture="environment"` to open the
  camera directly. (An automatic "photo → recognized as the same product"
  version was considered and explicitly not pursued — it would need real
  image matching, likely an external vision API call per photo, and
  barcode scanning above already covers the same "auto-identify a
  product" goal far more cheaply and reliably if that's ever wanted.)
- **Dictation for adding items — better parsing.** The freeform quick-add
  box + naive regex parser shipped above; two fancier alternatives were
  considered and not chosen for that pass, still available as a fast-
  follow if the naive parser proves too fragile in practice: parsing via
  an LLM call instead of regex (Medium — more robust, but a new external
  dependency/API key/per-call cost) and in-browser live speech-to-text via
  the Web Speech API (Medium-High — real cross-browser risk, decent in
  Chrome/Android but inconsistent-to-absent in Safari/iOS and Firefox;
  this app has already hit browser-compatibility surprises twice on
  exactly this kind of not-universally-supported API — the location
  `<datalist>`, the vertical fill-level slider — same risk class here).
- **AI agent with direct DB/API access — on hold, "not worth it yet."**
  Similar goal to dictation above, but by letting an agent (e.g. Claude)
  call the API on your behalf instead of the app doing speech-to-text
  itself — and the preferred direction if this is picked up later is
  exactly this "use an existing agent" approach below, not a bespoke
  in-app AI feature. This is the gap already flagged in the README's API
  section made concrete: the API requires a real browser session cookie
  today (per-user login, shipped) — there's no credential suited to an
  external automated client yet.
  - *Personal access token, separate from browser sessions (Medium):* a
    long-lived, per-user, revocable token checked via an `Authorization:
    Bearer` header alongside the existing cookie-based session middleware
    in `server/src/index.js`. Worth scoping it to item-mutating endpoints
    only, not account management.
  - *A skill/connector wrapping the existing endpoints (Medium, depends on
    the token above):* mostly a manifest/tool-definition layer over
    endpoints that already exist (`POST /api/items`, `/consume`,
    `/throw-out`, etc.), not new backend logic. Notably this reuses
    Claude's own language understanding instead of writing a custom
    parser — once the token exists, this may cost *less* than the
    LLM-parsing dictation option above, since it offloads the
    natural-language part to an agent that already exists.
  - *End-to-end, including a stable public URL (High overall):* an
    external agent can't reliably call a URL that changes every restart,
    so this also depends on the Cloudflare Named Tunnel work already in
    progress (the `eu.org` domain application) rather than the ephemeral
    Quick Tunnel. Graded High as a whole not because any one piece is
    novel, but because it touches auth again, needs a stable public
    endpoint, and needs an external integration layer all together.
- **Favorites filter** — surface the most-purchased items for quick re-up.
  Now unblocked: `item_events` (shipped above) has a `purchased` event per
  purchase, so this is a `GROUP BY item_name` count over that table filtered
  to `event_type = 'purchased'`, rather than needing new tracking.
- **Narrow-width layout: trim to the essentials** — partially addressed by
  the phone-first restyle (compact grouped rows, status chips, color-coded
  expiry) but not finished: on the smallest screens, actively drop
  low-value fields from each row rather than just keeping them small.
  Purchase date and category are still shown on every row regardless of
  width; what matters at a glance is whether something's expired or close
  to it, and how much is left, both already conveyed by the row's
  background tint and the stepper.
- **Real schema-version tracking** — schema changes today are ad-hoc,
  guarded `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` blocks checked at
  startup in `server/src/db.js` (safe and idempotent, but no migrations
  table, no ordered/named history, no way to tell which of the accumulated
  migrations a given database file has already had applied). Planned
  approach: a `schema_migrations` table (`version`, `applied_at`), the
  existing ad-hoc blocks pulled out into numbered migration files, only
  the ones not yet recorded run at startup. `restart.sh` already writes a
  placeholder `SCHEMA_VERSION` file into every backup, ready to be swapped
  for the real applied version once this exists.
- **Full multi-family isolation** (separate households sharing one
  deployment, each with private data) — shelved, larger, only worth doing
  if this is ever actually hosted for more than one household. The
  per-user login item above deliberately does *not* include this: it's
  one shared inventory with per-person accounts, not per-family
  isolation. If this is ever picked up, the design work below (data
  isolation approach + the security decision behind it) still stands and
  doesn't need to be redone.

## Reference: multi-family data isolation design (if picked up later)

Recorded when this was still expected to ship alongside login — kept here
since the reasoning stands whenever full multi-family isolation is
actually built, even though it's currently shelved:

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
