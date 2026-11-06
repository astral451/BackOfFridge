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
  redirect → logged-in flow. Full multi-family isolation was shelved at the time (since built: see "Multi-household support" below)
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
  one-tap Reset button next to the toggle whenever any of them is active
  (search has since moved out of the disclosure to stay always visible;
  see below). The quick-add "+" button also processes whatever's still sitting in the
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
  conflict. Each backup is tagged with a `SCHEMA_VERSION` file: the
  database's real schema version since schema-version tracking shipped
  (below), `"unversioned"` before that.
- Usage-history query tool (`common_sql_commands.sh`) — canned `sqlite3`
  queries over the `item_events` table for "what's actually being used"
  questions without hand-writing SQL each time: most-purchased items,
  activity by user and event type, a recent-activity feed,
  consumed-vs-thrown-out counts, and `catch-up`: bursts of quick
  reductions on one item (see "Usage analysis" in the Roadmap), with each
  burst's tap count, total reduced, and days since the item's previous
  event. Its thresholds are tunable with `BURST_MINUTES` (default 10) and
  `BURST_MIN_TAPS` (default 3). `items` lists every item's current state: amount,
  status, and whether it's active, sorted A-Z by name. `by-name` adds up every
  entry with the same name (case-insensitive, outer spaces ignored) into
  one row per product: entries, active entries, on hand, times purchased,
  consumed (including downward quick-sets, excluding anything undone),
  thrown out, and last used. Each purchase stays its own item with its own
  expiration in the app; this grouping only exists for consumption
  questions, where every "Grape Waterloo" is the same thing. Run with no arguments to list the
  available commands (works even without `sqlite3` installed or a database
  present yet, checked before either of those).
- Dictation-resilient quick-add parsing — `parseQuickAdd` (`public/app.js`)
  no longer treats commas as the thing that decides which field is which,
  since iPhone dictation places them unreliably (and saying "comma" out loud
  to fix that was slow). Each field is now found by a keyword or by being
  unambiguous on its own: a full date anywhere in the line is the
  expiration date, no "expires" needed (purchase date already defaults to
  today); "size"/"volume"/"weight" separate a count from a per-item size
  ("quantity two size 24 ounces"), and so does a comma between the two
  numbers ("two, 24 ounces"), whether typed or said as "comma"; location
  and tag are matched anywhere in the line, not just at the end; a
  relative expiration works without "expires" too ("in two weeks", "a
  month from today"). Built
  against real dictated lines collected in `dictation_examples.md`, which
  also documents the keyword rules. One case stays unfixable by design:
  once dictation has merged "two twenty-four ounces" into "224 ounces",
  the text can't say which was meant. A separator word or comma is what
  prevents that.
- "By location / All items" view toggle — the main list can now show every
  item in one flat list (the server's expiration-first order, location
  shown in each row's detail line) instead of one collapsible section per
  location, for scanning everything at once for what's expiring or low.
  Status chips, search, filters and row actions work the same in both
  views. The choice is remembered per browser in `localStorage`.
- Search box always visible — moved out of the collapsible panel onto the
  toggle row, so searching never needs an extra tap. The panel (now just
  "Filters ▾") holds only location/tag/sort.
- Quick set: tap a row's amount to type what's actually left. Tapping
  the quantity (or a fill-level item's bar) on an active row swaps it for
  a number box pre-filled with the current value. Done/Enter or tapping
  away saves, Escape cancels, and 0 marks the item consumed. This is one
  action for what used to take five or ten − taps when catching the app
  up (see "Usage analysis" in the Roadmap). It also covers setting a new
  fill-level item's real starting level. Saved through the existing PATCH
  with a `recount: true` flag, which records a single `recount` event
  (`{field, from, to, unit}`) instead of `edited`/`fill_level_set`, so
  analysis can tell an explicit correction from consumption at that
  moment. `common_sql_commands.sh catch-up` lists downward recounts
  alongside tap bursts (`via` column). Main inventory page only, for now;
  At a Glance still has just −/+.
- Leading/trailing spaces are stripped from item text fields (name,
  location, tag, unit, notes), so an accidental space before or after a
  name no longer makes " Orange Cream Bubly" a different item from
  "Orange Cream Bubly" in search, sorting and purchase counts. This is
  done twice: in the browser (quick-add parse results, the purchase/edit
  form on save, and Buy again/Edit pre-fills), and again on the server
  for every create and edit (`trimTextFields` in
  `server/src/routes/items.js`, plus `ensureLocation`/`ensureTag`), so the
  API is covered even when called directly. A name that's only spaces is
  rejected in both places. This applies to new entries and edits only:
  existing rows aren't rewritten, though opening one in Edit and saving
  cleans it up.
- Fix: the "⋯" row menu opens upward when there isn't room below it. On
  the last rows of the list it used to open under the fixed quick-add bar,
  leaving its actions untappable.
- Fix: the "⋯" menu on consumed/thrown-out rows (visible under the "All"
  chip) was half-transparent and drawn behind the rows below it. Those
  rows were faded with `opacity` on the whole row, which also faded the
  menu inside it and trapped its z-index within the row. Now only the
  row's contents are faded, not the menu.

- Real schema-version tracking — the first step of the multi-household
  work. Schema changes are now numbered migrations in
  `server/src/migrations/` (listed in order in its `index.js`), run by
  `server/src/migrate.js` at startup. Each runs once, inside its own
  transaction, and is recorded in a `schema_migrations` table (`version`,
  `name`, `applied_at`); a migration that throws partway rolls back
  completely. Migration 001 ("baseline") is the old ad-hoc
  `PRAGMA table_info`/`ALTER` startup blocks from `db.js`, moved unchanged,
  so an existing database is just recorded as version 1 (verified: a
  database made by the previous code ends up byte-for-byte the same in
  schema and rows as restarting the previous code on it). The server
  refuses to start, with a clear log line, if the database is newer than
  the code's highest migration. `restart.sh` writes the real version into
  each backup's `SCHEMA_VERSION` (read through a throwaway container, so no
  host `sqlite3` is needed). `server/scripts/migrate-check.js <db>` is a dry
  run against a copy of a real database: version and row counts before and
  after (per household too, once that column exists), whether every
  existing row came through unchanged, and an integrity check; it never
  writes to the file it's given. `npm test` in `server/` runs the
  migration tests (`node:test`, no new dependency): fresh database, old
  unversioned database, re-run is a no-op, downgrade refused, partial
  failure rolls back, and the check script leaves its input untouched.
  See README "Schema versions and migrations" for the dry-run steps.

- Multi-household support — several households share one deployment, each
  seeing only its own items, history, locations and tags (design:
  "Reference: multi-family data isolation design" below; plan and the
  user's decisions: `agent_handoff_02.md`).
  - **Schema:** migration 002 (households, new-household codes,
    `household_id` on users/items/item_events, locations and tags keyed by
    `(household_id, name)`, `users.status`/`is_admin`/`household_role`).
    Existing data all moved into household #1, "Household 1", verified with
    `migrate-check.js` against a real backup (267 items, 806 events, 12
    locations, 7 tags, 2 users, every row unchanged) before the server was
    allowed to apply it. Triggers stop an item or event being written
    without a household or moved to another one.
  - **Scoping:** the household comes only from the session
    (`req.householdId`, set in `index.js`). All household data goes through
    `server/src/store.js`, where every function takes the household id as
    its first argument and throws without one. Another household's item
    ids return the same 404 as missing ones. Mutating routes go through
    one `can(user, action)` check (`server/src/permissions.js`), which today
    allows every active member everything.
  - **Signup:** a household's invite code joins it; an admin-issued
    new-household code (single use) starts a new one that the person
    names; no code makes a pending account that sees only a "waiting for
    approval" page (`pending.html`) until the admin approves it into a
    household or rejects it. The signup form says what a code does as it's
    typed. Settings shows the household's members and invite code, with a
    button for a new code, and lets any member rename the household (the
    user decided renaming belongs to the household, not the admin).
  - **Admin:** a separate, dedicated login with no household, created only
    from the server's command line (`scripts/admin.js create|grant|revoke|
    reset-password|list`; passwords are generated and printed once).
    `admin.html` lists pending accounts (approve into an existing or new
    household, or reject), issues and revokes new-household codes, and
    moves members between households or removes them (back to waiting for
    approval; the household they left gets a new invite code so the old one
    can't be used to rejoin). There's deliberately no "create an empty
    household" option (the user's call): new households come only from a
    new-household code, where the person names it, or from approving a
    pending account into a new one.
    Household routes return 403 for the admin. Household choosers start
    empty ("choose…"), with the button disabled until a household is
    picked, rather than preselecting one. A Users page (`users.html`) lists
    every account with its household (or none) and status, with move,
    remove, add-to-household, **Block** (can't log in, leaves its
    household; same state as rejecting a signup) and **Unblock** (back to
    waiting for approval), so nobody gets lost once they're out of a
    household.
  - **Logs** name the household on every `ACCESS` line, and signups,
    approvals, rejections and code changes each get their own line.
  - **`common_sql_commands.sh` household filter:** `HOUSEHOLD=<id or name>`
    limits any command to one household, and a new `households` command
    lists them with ids, members and item counts. The script scopes by
    creating temporary `items`/`item_events` views for that one `sqlite3`
    run, which hide the real tables, so none of the queries had to be
    rewritten and nothing is written to the database. Without `HOUSEHOLD`
    every household is covered together, as before, with a warning on
    stderr whenever there's more than one. Built once the second household
    went live (below), since `by-name` and `catch-up` were already mixing
    the two households' data.
  - **In use:** stable in production on the `multi-household` branch. As of
    2026-10-23 a second household (another client, not the original user's)
    is live, with items in several locations. Its first quick-add dictation
    worked first time (`dictation_examples.md` example 7).
  - **Tests** (`npm test`): `test/isolation.test.js` runs the real API with
    two households sharing location/tag names and checks every household
    endpoint and every `:id` route (404, item unchanged), client-sent
    household ids being ignored, pending/admin/anonymous access, single-use
    codes, approval, rejection, and command-line grant/revoke. It was
    checked by deliberately removing household filters from the queries
    and confirming the tests fail. Plus a Playwright pass of signup (both
    code kinds and a bad code), pending, admin approve, settings rename and
    the existing pages at 390px and 1000px.
- **Barcode scanning** (2026-11-06): photo or typed/wedge-scanner barcode,
  decoded on the server, looked up in the household's own products and then
  Open Food Facts. It fills name, Qty and Unit (from the package size), and
  links a new barcode to earlier items entered by name ("Same as your
  ...?"). Within a household, the barcode is a product's identity, and
  items without one go by name. Details in the Roadmap entry "Barcode/visual
  scanning".

## Roadmap

Difficulty grades below (Low/Medium/High) are rough cost/complexity, not
priority — a Low item isn't necessarily more worth doing than a High one.

- **Location customization** — shipped: locations (and tags) are a managed
  list with add/delete, each household with its own.
- **Barcode/visual scanning (Medium)** — shipped 2026-11-06 (tested on
  the server from branch `claude/barcode-scanning` first, including the
  name matching and package-size additions below). Scan a
  barcode to quickly re-up an item instead of retyping it (builds on "Buy
  again"); its pre-filled quantity uses step 1 of "Quantity model" below.

  What was built, following the design below:
  - Camera button in the bottom bar (opens a fresh form straight to the
    camera) and a barcode field + **Scan** button at the top of the
    purchase form. The photo goes to `POST /api/scan` as raw image bytes
    (`express.raw`, no `multer` needed); typed or wedge-scanner barcodes go
    to `GET /api/products/:barcode`. Enter in the barcode field looks it up
    instead of submitting the form.
  - `server/src/barcode.js`: decoding (zxing-wasm reader, wasm loaded from
    `node_modules`), HEIC detection, and normalisation: UPC-A, EAN-13 and
    GTIN-14 all become one 13-digit key; UPC-E is expanded; GS1 Digital
    Link QR codes and GS1 element strings (DataMatrix) give the GTIN and
    the expiry date (AI 17), which fills in Expires.
  - `server/src/openfoodfacts.js` + `server/src/routes/products.js`:
    lookup order is this household's products, then Open Food Facts,
    cached. A result found there fills the name and shows brand/package.
    An unknown barcode, or Open Food Facts being unreachable, still keeps
    the barcode, so the name only has to be typed once.
  - Migration 005: `items.barcode` and the per-household `products` table.
    Buying with a barcode (or adding one to an item through Edit) saves
    that household's name, location, tag, unit, quantity and tracking mode
    for it, so the next scan pre-fills all of it ("Bought before").
  - **Linking earlier names to a barcode** (added after the first round
    of testing on the server). A household that typed or dictated
    "Melon medley waterloon" before scanning got "Sparkling Water Melon
    Medley" from Open Food Facts on the first scan, with no link between
    them.
    - When a lookup's product came from Open Food Facts, it also returns
      `matches`: this household's barcode-less names that look alike
      (`server/src/namematch.js`). Up to 3 are returned; one per name,
      ignoring case.
    - The match compares words: lowercase, punctuation and filler words
      dropped, plural "s" trimmed. Words also match when one starts with
      the other and the shorter has 4+ letters, so a misheard "waterloon"
      meets "water". It scores shared / all distinct words, and also
      tries brand + name. Suggested at a score of 0.4 or more.
    - The form asks *Same as your "..."?* **Yes, use my name** calls
      `POST /api/products/:barcode/link { name }`. That gives the barcode
      to every item of that name (any status, so history counts too),
      records an `edited` event on each, and saves the latest one's
      choices as the barcode's local product. The form then fills like a
      "Bought before" scan. **No** just hides the question. Nothing is
      renamed or linked without a yes.
  - **Package size into Qty and Unit** (also from testing on the server:
    the status line showed the size but the form didn't use it).
    `parsePackage` in `server/src/openfoodfacts.js` reads Open Food
    Facts' free-text `quantity` the way quick add treats "two, 24 ounces":
    Unit = the size of each, Qty = how many when the pack says so.
    - `330 ml` → Unit 330 ml; `12 x 12 fl oz` → Qty 12, Unit 12 fl oz.
    - `18 oz (510 g)` → 18 oz; `400 g e` → 400 g (the EU estimated
      sign); `12 cans` → Qty 12, Unit cans.
    - Text without a number gives nothing.
    - It's applied in `productView` for Open Food Facts rows, so
      products cached before this change get it too.
    - The form only fills Unit when it's empty, and Qty when it's still
      1. A product the household has bought before keeps its own unit
      and quantity.
  - **Product identity, for sorting and counting** (e.g. a future "what
    we buy most"): within a household, the barcode, when an item has one,
    is the product's identity, whatever each item is called. Items
    without one (not scanned yet, or nothing to scan, like
    farmers-market fruit) are identified by name, ignoring case and
    surrounding spaces. In SQL: group by
    `COALESCE(barcode, 'name:' || LOWER(TRIM(name)))`. Linking is what
    keeps earlier dictated entries in the same group as later scans.
    - Caveat: one product in two package sizes has two barcodes (a
      single can and a 12-pack). If they should count together, link both
      to the same name and group by the products table's name instead.
  - Not built yet: the live camera viewfinder (needs HTTPS), and the
    optional vision-model step for barcode-less items.

  **Direction chosen: server-side decoding, no on-device scanning library.**
  The browser only captures; the server decodes and looks up.

  - **Capture (browser):** a Scan button using
    `<input type="file" accept="image/*" capture="environment">`. This opens
    the phone's native camera, takes one photo and uploads it. It works
    whether or not the page is on HTTPS. It's the same input and `multer`
    upload that "Photo capture + recall" below plans, so the two can share
    that plumbing. A live viewfinder (`getUserMedia`) would need HTTPS and
    would in practice mean decoding on the phone, so it's out for now. It's
    a possible add-on later, since the Cloudflare Tunnel setup already
    provides HTTPS.
  - **Typed barcode field:** a plain text field on the purchase form that
    accepts digits. This covers USB/Bluetooth "keyboard-wedge" scanners,
    which type the number and press Enter, plus manual entry. It also
    serves the PC and Supernote, which have no useful camera. It feeds the
    same lookup as the photo path.
  - **Decoding (server): `zxing-wasm`** (zxing-cpp compiled to WebAssembly),
    behind `POST /api/scan` (multipart image). Chosen over `zbarimg` for
    three reasons:
    - Future-proofing. Retail is moving to 2D barcodes (GS1 "Sunrise
      2027": GS1 Digital Link QR codes and GS1 DataMatrix). zxing reads QR,
      DataMatrix and GS1 data, which can carry the expiration date
      (application identifier 17) and could auto-fill `expiration_date`.
      ZBar can't read DataMatrix.
    - Maintenance. zxing-cpp is actively developed; ZBar survives only as
      a slow-moving maintenance fork.
    - Fit. It's a pure npm package with no native build or extra Docker
      system package, and the same package could run in the browser later.
    - Practical notes: shrink large phone photos before decoding, and check
      on a real iPhone that Safari uploads JPEG rather than HEIC. If a
      stubborn 1D barcode case turns up, zbar can be added later as a
      fallback behind the same endpoint.
  - **Lookup order:** (1) this household's own saved products → (2) the
    Open Food Facts API (free, no key; returns name, brand, package size,
    image), called by the server so there's no CORS issue, with the result
    cached → (3) not found: the user types the name once and it's saved for
    next time. Either way the result pre-fills the purchase form through
    `fillFormFromItem`, and the user confirms before saving.
  - **Schema (new migration):** a `barcode` column on `items`, plus a
    `products` table (barcode, name, brand, default category, location,
    unit and purchase quantity, source `local`/`openfoodfacts`,
    fetched_at). The household-specific parts (names you typed, default
    location and quantity) are scoped by `household_id` like everything
    else. Cached Open Food Facts data is public, so it could be shared
    across households, but scoping it too is simpler and safe.
  - **Later, optional:** send the same uploaded photo to a vision model to
    identify barcode-less items (produce) or read a printed "best by" date.
    This needs an API key and costs per call, so it's phase 2.
- **Quick entry card: one form for adding and editing (Medium)** —
  being built in steps on `claude/barcode-scanning`. Clickable mockups:
  https://claude.ai/artifact/JPGBHKB7F1ujrPWv6KbgpK (private to the user).

  The purchase sheet is replaced by a compact card that fits one phone
  screen. Every way in uses it, differing only in what's pre-filled: a
  scan (product bought before, or found on Open Food Facts), **+**, "Buy
  again", and Edit. The card holds:
  - Name (with brand/size from the lookup), and a **quantity stepper**
    (− / number / +, tap the number to type) right under it.
  - **Where:** square tiles (about 80×64 px, long names wrap to two lines)
    in two rows that scroll sideways, since households have 10+
    locations. **Tiles never reorder**: tapping or preselecting one leaves
    it where it is (moving it was jarring). The line beside the heading
    names the selection, since a preselected tile may be off-screen. The
    build should scroll the row to show it, not reorder. Preselected:
    last time's location for a product bought before, else the location
    used for the previous item this trip.
  - **Expires**, with two tabs:
    - *Approx:* chips 3 days / 1 wk / 2 wk / 4 wk / 3 mo / 6 mo / 1 yr /
      None. Each chip shows the date it sets, worked out from today, and a
      line above repeats the full date and "in N days".
    - *Exact date:* three taps, month grid → day grid → year. The likely
      year (the next time that month and day comes round) is highlighted
      so the third tap is a quick confirm. The chosen steps show as small
      buttons (Nov › 19 › 2026) that jump back to that step. A date in
      the past shows a warning.
    - Perishable items open on Exact date, non-perishable on Approx.
      Exact dates matter for meat and milk; approximate is fine for
      shelf-stable food.
  - **Or say it:** a text field with a mic, below the date picker (scroll
    to it), feeding the existing quick-add reader to fill in location and
    date.
  - "More details" opens in place with unit, category, tag, purchase date,
    notes and fill level.
  - **Save & scan next** is the main button, because a whole shopping trip
    is usually entered at once. On iOS the camera can only open in
    response to a tap, so this button's tap opens it. A plain **Save**
    sits beside it, and the header counts items saved this trip.

  Progress:
  - **Step 1 built (2026-11-06): the card shell.** The sheet is now the
    card: full screen on a phone (header, scrolling body, save button
    pinned at the bottom), the side panel from 720px. Name box with
    "Bought before" / "Found on Open Food Facts" above the name and
    brand · package under it; the − / + quantity stepper with the unit
    beside it; location tiles (two rows, sideways scroll, fixed order,
    the row scrolls to the selected tile, tap again to clear, "+ New"
    opens the name box). The hidden `#f-location-select` is still what
    the code reads; `setFormLocation()` keeps tiles, select and the hint
    line in step. Preselect: last time's location on a bought-before
    scan, else where the last item added this page visit went. Unit
    moved under More details; Expires is still a plain date box until
    step 2. +, Buy again, quick add and Edit already use the card, since
    it's the same form.
  - **Step 2 built (2026-11-06): Expires.** Approx / Exact date tabs.
    Approx chips show the date each sets; Exact is month → day → year
    with this month underlined and the likely year outlined ("next Nov
    13"), and the steps as buttons that jump back. A past date warns;
    Feb 29 disables non-leap years. The hidden `#f-expiration` holds the
    value; `setFormExpiry()` sets it from Edit, Buy again, quick add and
    a date read from the barcode. Perishable opens on Exact,
    non-perishable on Approx, and changing the category flips the tab
    while nothing's picked. New items still default to perishable until
    step 5's category guess.
  - **Step 3 built (2026-11-06): Save & scan next.** The footer is
    Save (closes the card) beside the main Save & scan next. That tap
    opens the camera first (iOS only allows it from a tap), clears the
    card for the next item keeping the location, and saves in the
    background; "Saved: Milk ×2 · Pantry · expires …" shows in the card.
    If the save fails and the next item hasn't started, the item goes
    back into the card. The header shows "Trip: N saved". The trip
    (count and last location) is kept in localStorage, so a reload after
    the camera doesn't lose it, and ends after 3 hours with no save.
    Edit shows a single Save changes and doesn't count.
  - **Trip list (2026-11-06, the user's idea).** Tapping "Trip: N
    saved" shows everything saved this trip, newest at the top and
    numbered in the order it went in, as a check before the bags are put
    away. Each row is name, ×qty unit · location · expiry; tapping one
    opens Edit, and saving returns to the list. Deleted items show as
    "Deleted". "Add more" goes back to the card; "End trip" (after a
    confirm) starts the count at 0. The trip keeps item ids in
    localStorage, so it's per phone/browser, not shared across the
    household.
  - Next: step 4, moving **+**, Buy again and Edit fully onto the card
    (they already open it; what's left is checking each pre-fills it as
    designed, e.g. + opening with the name first and suggestions).

  Decisions (2026-11-05):
  - **Typing an item in (+):** the name field comes first, with
    suggestions from this household's products. Done, or picking a
    suggestion, closes the keyboard so the whole card is visible; a
    suggestion fills in the card like a scan of that product would.
  - **Category for a new item:** for scans, guess from the Open Food
    Facts `food_groups_tags` field (meat, fish, milk/dairy → perishable;
    anything also tagged `en:canned-foods` → non-perishable). Otherwise
    default to non-perishable. Whatever is saved is remembered on the
    product. `categories_tags` is too messy to use (user-entered
    duplicates and misspellings); `food_groups_tags` is clean. Checked
    live: Cheerios → breakfast-cereals, Nutella → sugary-snacks,
    Progresso soup → one-dish-meals plus canned-foods. This means adding
    `food_groups_tags,categories_tags` to the lookup's `fields=`.
  - **Quick add stays** as the fastest one-line entry without a form; the
    card's voice field uses the same reader underneath.
  - **Edit** opens on Exact date with the item's current date selected,
    or, with no date, on the tab that matches its category.
  - Both the light and dark themes.
- **Trips: shared shopping trips and the shopping list (Medium/High;
  designed 2026-11-06, being built on `claude/barcode-scanning`)** — grows
  the trip list (see "Quick entry card", Progress) into its own part of
  the app, separate from the inventory. A trip is one shopping run; a
  shopping list is a trip that hasn't started yet. Both use the trip
  list's look: one row per thing, newest at the top.

  What the user asked for (2026-11-06):
  - **Shared.** Two people can scan into the same trip at once, and the
    whole household sees the same trips and lists.
  - **Fix names after unpacking.** A scan saved as "Milk 2%" when the
    household calls it "2% milk": on the trip page, link it to the
    existing name, so it's renamed now and the next scan fills in "2%
    milk". (The scan's "Same as your ...?" question usually catches this
    up front; this is the after-the-fact fix.)
  - **Build a list from what's been used.** A new shopping list starts
    with "things you might want": recently used up or thrown out, low
    stock, expiring soon. Tap the ones you want.
  - **Scanning in the store turns the list into the current trip.**

  **Proposed data model (migration 006).**
  - `trips`: `id` (a random UUID, so more than one list can come later
    without changing anything), `household_id`, `status` (`planned` / `active` /
    `done`), `created_by`, `created_at`, `started_at`, `ended_at`.
  - `trip_entries`: `id`, `trip_id` (the UUID), `household_id`, `name`, `barcode`
    (nullable), `quantity` (wanted, nullable), `source` (`used`,
    `low_stock`, `expiring`, `manual`, or null for something just
    bought), `item_id` (the item saved, null until bought), `added_by`,
    `created_at`, `bought_at`.
    A list row is an entry with no `item_id`; buying it sets `item_id`
    and `bought_at`. Something bought that wasn't on the list is an
    entry created with `item_id` set.
  - Product identity is the one already used: the barcode, else the
    lower-cased trimmed name.

  **Proposed behaviour.**
  - *One current trip per household.* Saving an item adds it to the
    household's `active` trip, or starts one. Both phones see it; the
    trip page re-reads every ~10 s while it's open. A trip ends with
    "End trip" or after 3 hours with no saves (as now).
  - *One shopping list at a time* (a `planned` trip). "Shopping list"
    opens it, or starts one.
  - *Suggestions.* Above the list, "Things you might want", in three
    groups, each row with an Add button:
    - **Used up** in the last 14 days: items consumed or thrown out,
      by product, where nothing of that product is still in stock.
    - **Low stock**: the existing `low_stock` flag.
    - **Expiring** in the next 3 days (replace it before it goes).
    Plus a name box to add anything else, with suggestions from the
    household's products. Already on the list = not suggested.
  - *List to trip.* **Start shopping** on the shopping list makes it the
    active trip (decided 2026-11-06). Saving with no active trip starts
    a new, empty one, as now; the list stays planned until Start
    shopping.
  - *Ticking off.* A save whose barcode or name matches a list row ticks
    it (sets `item_id`). A near match (the existing name matcher) asks
    "Is this the 2% milk on your list?" in the card. A row can also be
    ticked by hand.
  - *The trip page, one page for both.* "Still to get" (unticked list
    rows) at the top, then everything bought, newest first, as now;
    a bought row that came off the list says so. Rows open Edit as
    now.
  - *Link to a name.* Each bought row gets "Same as one of yours…":
    pick an existing household name (with suggestions). The item is
    renamed and, if it has a barcode, the barcode is linked to that
    name (the existing `POST /api/products/:barcode/link`, plus the
    rename).
  - The per-phone trip in localStorage goes away.

  **Proposed build order** (each step tryable on the phone):
  1. Shared trips on the server: migration 006, saves go to the active
     trip, the trip page reads it and re-reads while open.
  2. "Same as one of yours…" on bought rows.
  3. The shopping list: suggestions, picking, adding by name.
  4. List to trip, auto-ticking, "Still to get".

  **Progress:**
  - **Step 1 built (2026-11-06): shared trips on the server.** Migration
    006 (`trips`, `trip_entries`); `src/trips.js`; `GET
    /api/trips/current`, `POST /api/trips/:id/end`. The card saves with
    `trip: true`, which puts the item on the household's active trip
    (starting one) and returns `{ id, count }`. The trip page reads the
    server and re-reads every 10 s while open; once two people have
    added, each row names who. A row shows the item as it is now, or
    "Deleted". End trip ends it for everyone. Idle trips end after 3
    hours, checked whenever the trip is read. "Same as the last item"
    stays per phone (localStorage `lastLocation`), since two people may
    unpack into different rooms. The old per-phone trip is removed.
  - **Steps 3 and 4 built (2026-11-06): the shopping list.** `list.html`
    / `list.js`, linked from the main page's header. The list is the
    household's one `planned` trip. "Things you might want" in three
    groups: Used up lately (consumed or thrown out in 14 days, none
    left), Low stock (`low_stock`), Expiring soon (3 days, or past); a
    product shows once and not if it's already listed. Add by name with
    an optional quantity ("2 bags"); tap a row to change it, ✕ to remove.
    **Start shopping** makes it the active trip (or, if a trip is already
    going, moves its rows into that one) and opens the trip page. Saving
    an item whose barcode or name (ignoring case) matches a list row
    ticks that row (the card says so); ✓ ticks one by hand, and tapping
    a hand-ticked row undoes it. The trip page shows "Still to get" at
    the top, then "Got"; the card's header shows "Trip: N saved · M to
    get". Routes: `GET /api/trips/list`, `POST /api/trips/list/entries`,
    `PATCH`/`DELETE /api/trips/entries/:id`, `POST
    /api/trips/entries/:id/tick`, `POST /api/trips/:id/start`.
    **Add to shopping list** in each item's ⋯ menu on the main page (the
    user's idea, 2026-11-06) adds it with its barcode, so a scan in the
    store ticks it off; a toast says added, or already on the list.
    Not yet: the near-match question ("Is this the 2% milk on your
    list?"); name suggestions while typing on the list.

  **Lists page step 1 built (2026-11-06):** `lists.html` / `lists.js`
  ("Lists" in the main header; `list.html` now goes back to it). Shopping
  now card (started, who, progress through the list, still to get, the
  "Forgot something?" box, Open trip / End trip), Shopping list card
  (count, first six, suggestions waiting, Open list / Start shopping),
  Past trips (20 at a time, "Show older trips"; rows not yet tappable).
  The page re-reads every 15 s. The main page's Shopping now banner
  (re-checked every 30 s and on returning to the page) opens the trip.
  Server: `GET /api/trips` (`trips.overview`), `POST
  /api/trips/:id/entries` (`trips.addToTrip`; refused once a trip is
  over).

  **The Lists page (designed 2026-11-06).** Mockups: the second
  row of https://claude.ai/artifact/JPGBHKB7F1ujrPWv6KbgpK. One place
  to see every list, rather than only reaching them by adding or
  scanning.
  - *Main page:* "Lists" first in the header (replacing "Shopping
    list"; "Manage locations/tags" shorten to "Locations/Tags"). While
    a trip is going, a "Shopping now · 8 saved · 3 still to get · with
    alex" banner above the items, **shown to everyone in the household**
    and opening the trip.
  - *Lists page:* **Shopping now** (the active trip: started when, who,
    progress through the list, what's still to get, Open trip / End
    trip, and an **"Add to this trip"** box so someone at home can add
    what they remember); **Shopping list** (count, first few things,
    suggestions waiting, Open list / Start shopping); **Past trips**
    (date, how many got, time span, who, an amber "N not found" tag).
  - *Shopper's notice:* when someone else adds to the trip, the
    shopper's screen shows **"New item added: Bread · alex added it
    from home"**, and the new row is highlighted in Still to get. (Pages
    already re-read the trip every 10 s while open; the main page and
    the card would also check while a trip is going.)
  - *A past trip:* the trip page's format, read-only. **Not found** (list
    rows never ticked) with **"Put them on the shopping list"**: only on
    that tap, not automatically. **Got**, numbered, newest first, each
    row able to fix its name: "Same as your "2% milk"? Yes, rename"
    (trips step 2).
  - *Suggestions* on the shopping list gain a fourth group, **Often
    used**: the products used up most often (say the last 90 days).
  - Not doing: "Buy these again" for a whole trip. Shopping doesn't
    repeat week to week; low stock, used up and often used cover it.

  **Decided (2026-11-06):**
  - **One list at a time**, but each trip has its own UUID so several
    could be supported later. One big list is how the user shops: what's
    found at the first store gets ticked there, the rest carries on.
  - **"Start shopping"** button on the list, not automatic.
  - **Low stock** is the existing `low_stock` flag; **Expiring** is the
    next 3 days. Used up: 14 days (not objected to).
  - **Quantities on the list are optional**, useful for a recipe.
- **Quantity model: purchased amount and per-unit fill level (Low → Medium,
  two steps)** — two related fixes to what an item's `quantity` means,
  planned together but built in order. Step 1 is small, fixes a bug in use
  today, and is the foundation step 2 builds on.

  **Step 1 (Low) — shipped: "Buy again" pre-fills the original purchase
  quantity, not what's left.** `fillFormFromItem` (public/app.js) used to
  pre-fill the item's *current* `quantity`. That number goes down with
  consumption, so re-buying a 12-pack of Coke with 3 cans left pre-filled
  3 instead of 12.
  - Migration 003 adds `purchased_quantity` to `items`. `store.insertItem`
    sets it from the starting quantity, and nothing else writes it:
    consume, throw-out, undo, the +/- stepper, recounts and edits all leave
    it alone, since the 12-pack was still a 12-pack. It isn't editable
    through PATCH yet; add that if a typo at purchase time turns out to
    need fixing.
  - "Buy again" pre-fills from `purchased_quantity`, falling back to the
    current quantity.
  - Backfill: each existing item takes the quantity from its earliest
    `purchased` event in `item_events` where there is one, otherwise its
    current `quantity` (items from before events existed).
  - Scanning reuses it: the `products` default purchase quantity comes from
    the last purchase of that barcode, so scanning the Coke pre-fills 12.
  - Not covered: "Buy again" on a fill-level item still logs the new
    purchase as a count item, same as before. That carry-over belongs with
    step 2.

  **Step 2 (Medium) — shipped (tested on the server from its own branch
  first): fill level applies to the one open unit, not the whole item.** Before this, `fill_percent` and `quantity` were
  independent. With two gallons of milk tracked by fill level, the `−`
  stepper's "at or below 10% fully consumes the item" rule threw away
  **both** jugs when the first one ran out, and the low-stock badge fired on
  the open jug's percentage even with a full backup in the fridge.
  - For a fill-level item, `quantity` counts units and `fill_percent`
    describes only the **currently open unit**; the rest are full. Rows
    (main list and At a Glance) show e.g. "40% + 1 full".
  - The `−`/`+` stepper (10-point steps) and the quick-set number box
    change only the open unit's `fill_percent`.
  - Finishing the open unit (`−` at or below 10%, or quick-setting 0%)
    consumes **one unit**. `reduceQuantity` (server/src/routes/items.js)
    handles the rest: if any units are left it starts the next at 100%;
    on the last unit the item is consumed, as before. Throw-out works the
    same way, and the "Consumed"/"Throw out" menu prompts count units. The
    event records the open unit's percentage (`open_fill_percent`).
  - Low stock (`serialize`): only when it's the last unit (`quantity` ≤ 1)
    and its fill is at or below the threshold.
  - Undo: migration 004 adds `prev_fill_percent` to the undo slot, so
    undoing "finished a jug" brings back both jugs at the old percentage.
  - The Edit form shows quantity and unit for fill-level items too (it
    used to hide them, so there was no way to say you had 2 jugs), with
    the fill box labelled "Open one, % full".
  - "Buy again" on a fill-level item logs the new purchase as a fill-level
    item at 100%.
  - Not changed: `low_stock` is still computed for consumed/thrown-out
    items as well as active ones, same as before.
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
- **Bulk entry from a list (Medium)** — paste a block of lines (e.g. an
  iPhone Notes list, one item per line) and log them all at once. Each line
  goes through the same `parseQuickAdd` as the quick-add box, and the
  results show as editable review cards with a ✕ to drop one. Nothing is
  saved until "Add all", which addresses the concern that one bad line in
  a batch is hard to go back and fix. Builds directly on the
  dictation-resilient parser (Shipped), so it's only as good as that is.
- **Dictation for adding items — better parsing.** The freeform quick-add
  box shipped above, and its parser was since made resilient to dictation's
  comma placement (see Shipped). Two fancier alternatives were
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
- **Usage analysis: treat quick "catch-up" bursts as backlog, not
  real-time consumption (note for any future trends/analytics work).**
  Real usage pattern: an item logged as 20 units (or 100%) often isn't
  updated as it's used. Later the user notices it's out of date and taps
  − five or ten times in a row to catch it up. Each tap is recorded as its
  own `item_events` row: a `consumed` event with `quantity: 1` for
  count-tracked items, or a `fill_level_set` event for fill-level items.
  Read naively, the history says all of that was consumed in the minute
  the taps happened, when it was actually used gradually over the days or
  weeks since the previous event.

  Rule of thumb for analysis: several reductions on the same item within
  a few minutes of each other (say ≤10 minutes between consecutive
  events) are most likely one catch-up session. Collapse the burst into a
  single reduction whose total is known but whose timing is only bounded:
  sometime between the item's previous event and the burst. Don't count
  it as one moment of consumption. For rates like "how fast does X get
  used" or "what day does it get consumed", spread the burst's total over
  that gap, or exclude bursts from timing questions entirely and keep them
  only for totals.
  `common_sql_commands.sh catch-up` lists these bursts today, for seeing
  how often it happens in real data. This only needs to inform how
  queries are written (e.g. a future trends UI). Nothing about how events
  are recorded needs to change, since the timestamps already carry the
  signal.
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
- **Staging copy for testing branches (Low/Medium)** — a second copy of
  the app on the same server (git worktree, separate Compose project,
  port 3001) running the branch under test against a copy of the newest
  production backup, so the real app stays up and real data stays
  untouched while a feature is tested on the phone. Scoped in
  `staging_plan.md`; not built yet.
- **Archive a household (Low/Medium)** — not built; the user wants it
  for later. Today a household can't be removed or archived. Plan:
  migration 003 adds `households.archived_at`. An archived household's
  members can't reach its data (the same checks that block pending
  accounts, with an "archived" page instead of "waiting"), its invite code
  stops working, and the admin page lists it under a collapsed "Archived"
  section with **Unarchive**, which brings it back exactly as it was.
  `common_sql_commands.sh` skips archived households by default. Nothing
  is deleted: every row keeps its `household_id`, so archiving is just
  switching a household off. A true delete (every item, event, location,
  tag and code for the household) is possible but permanent, recoverable
  only by restoring a backup, which rolls back every household. If it's
  ever wanted, make it "delete an archived household" rather than a
  one-tap button.
- **Multi-household support — remaining pieces.** The core has shipped
  (see Shipped); still to do:
  - Finer permissions, if ever wanted: `users.household_role` and
    `can()` in `server/src/permissions.js` are the hooks.
  - Possibly: rate-limiting signup/login and code checks (codes are 8
    characters from a 31-letter alphabet, so guessing isn't practical, but
    nothing slows repeated tries).

## Reference: multi-family data isolation design

Recorded when this was still expected to ship alongside login. The
reasoning stands for the multi-household work now planned (see
`agent_handoff_02.md`). One correction since it was written: `locations`
(and the later `tags`) table already exists, with the name as its primary
key, so scoping it means a table recreate with a composite
`(household_id, name)` key, not just a new column:

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
