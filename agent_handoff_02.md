# Agent Handoff 02

Written 2026-10-09, at the end of session 02 (iPhone UX improvements).
Like `agent_handoff_01.md`, this is a one-time snapshot, not maintained
going forward. `features.md` stays the living source of truth for what's
shipped and what's planned. If you leave a note for the session after
yours, make it `agent_handoff_03.md` rather than editing this one.

## Where things stand

`main` contains everything from session 02. The `iPhone-ux-improvements`
branch was merged with `--no-ff` (merge commit `2342aab`), so its history
is one unit in `git log`. Each item below has a full Shipped entry in
`features.md`. In short:

- **Dictation-resilient quick-add parser** (`parseQuickAdd` in
  `public/app.js`). Commas no longer decide which field is which. Each
  field is found by a keyword or by being unambiguous:
  - a full date anywhere is the expiration;
  - "in two weeks" / "a month from today" also set it;
  - "size"/"volume"/"weight" (or a comma between two numbers) separate a
    count from a per-item size;
  - location and tag are matched anywhere in the line.

  The rules and the real dictated lines they were built against are in
  `dictation_examples.md`. Add any new failing line there first.
- **By location / All items toggle** and an **always-visible search box**.
- **Quick set:** tap a row's amount to type what's left. It's sent as
  `PATCH` with `recount: true` and recorded as one `recount` event
  (`{field, from, to, unit}`).
- **Row ⋯ menu fixes.** It opens upward near the bottom bar. It was also
  faded and covered on consumed/thrown-out rows, which is now fixed.
- **Whitespace trimming** of item text fields, in the browser and again on
  the server (`trimTextFields` in `server/src/routes/items.js`).
- **`common_sql_commands.sh`** gained `catch-up` (bursts of − taps and
  downward recounts), `items` (every item A–Z with an active flag), and
  `by-name` (consumption totals per product across all its entries).

### Things learned about real usage

These are worth knowing before designing anything analytics-related.

- **Catch-up is the normal way consumption gets logged.** Most consumption
  is entered in bursts of 4–8 − taps, days after it happened, not as it
  happens. The real database showed about 34 bursts in a month. The
  "Usage analysis" Roadmap entry in `features.md` says how to read it.
- **Bursts minutes after creation are setup, not consumption.** A burst on
  a fill-level item within minutes of it being created is the user setting
  the real starting level.
- **The user does whole-location check-ins**, e.g. updating eight drinks in
  one minute.
- **The same product is often several item rows**, one per purchase. That
  is deliberate: each row has its own expiration. `by-name` is how to
  aggregate them. Spelling variants ("Waterloo grape" vs "Grape Waterloo")
  still split.

## What's next: multi-household support

The user wants to move to a multi-household system next: several
households sharing one deployment, each seeing only its own data. That
was previously shelved (see the Roadmap entry "Full multi-family
isolation" in `features.md`) and is now the next piece of work.

**Nothing is built yet.** This section is the setup: what exists today,
what has to change, a suggested order, and the decisions to confirm with
the user before writing code. Suggested branch name:
`multi-household`.

### The design decision already made

It's recorded in `features.md` under "Reference: multi-family data
isolation design". In short:

- **One database with a tenant column.** All households share one SQLite
  database, with a `household_id` column on the data tables.
- **The household always comes from the logged-in session.** It is never
  read from anything the client sends (no `household_id` in the URL, query
  string or body). That rule is what prevents one household reading
  another's data.
- **Data access requires the household id.** Every data-access path takes
  the household id as a required argument, so a query that forgets it
  fails loudly instead of leaking.

Read that section in full. The reasoning stands and doesn't need to be
redone.

### What exists today (all single-household)

- **`users`**: `id`, `username` (globally unique), `password_hash`. There
  is no household concept at all.
- **`sessions`**: `token`, `user_id`, `expires_at`. In
  `server/src/index.js`, `verifySessionToken` (in `server/src/auth.js`)
  attaches `req.userId` and `req.username` to every `/api` request. That's
  where `req.householdId` should be attached too.
- **Signup is open.** `POST /api/auth/signup` lets anyone who can reach the
  URL create an account, and every account sees the one shared inventory.
  Behind the Cloudflare Tunnel that is already a real exposure. It has to
  change as part of this work: signup should create a new household or
  join one by invite, never land in someone else's.
- **`items`**: all rows belong to the one implicit household.
- **`item_events`**: append-only history. It needs its own `household_id`,
  not one derived from a join to `items`, because events outlive deleted
  items (`by-name` relies on that).
- **`locations` and `tags`**: `name TEXT PRIMARY KEY COLLATE NOCASE`. The
  name *is* the primary key, so two households couldn't both have a
  "Pantry". These need a table recreate with a composite key
  `(household_id, name)`. Use the same guarded recreate-and-copy pattern
  `server/src/db.js` already uses for the NOCASE migration.
  `ensureLocation`/`ensureTag` need a household argument.

### Every query that needs scoping

**`server/src/routes/items.js`**
- `GET /`: the item list, with its status/location/tag filters.
- `GET /:id` and `GET /:id/history`.
- `POST /`: the insert.
- `PATCH /:id`, `POST /:id/consume`, `POST /:id/throw-out`,
  `POST /:id/undo`, `DELETE /:id`. `reduceQuantity()` is shared by consume
  and throw-out.
- `recordEvent()` in `db.js`, called from all of the above.

Every lookup by `:id` must become `WHERE id = ? AND household_id = ?` and
return **404** (not 403) for another household's id, so ids can't be
probed.

**`server/src/routes/meta.js`**
- Locations: list, `/locations/detail`, add, delete (including the
  in-use count).
- Tags: list, `/tags/detail`, add, delete (including the in-use count).
- `/stats`: three `COUNT` queries.

**Front end (`public/`)**
- No front-end query changes should be needed, since the household comes
  from the session.
- Pages will need somewhere to show the household and an invite code.
  `settings.html` is the natural home.
- `glance.html` uses the same APIs, so it's covered automatically.

**Ops scripts**
- `common_sql_commands.sh` queries the whole database. Every command needs
  an optional household filter (e.g. a `HOUSEHOLD` env var). Otherwise
  `by-name`/`catch-up` silently mix households.
- `restart.sh` backs up the whole `data/` folder, so it needs no change.

### Suggested order

1. **Real schema-version tracking first.** It's already on the Roadmap:
   a `schema_migrations` table, with numbered migrations that run once.
   This will be the biggest migration the app has had (new tables, a new
   column on three tables, two table recreates, backfill of existing
   data). Doing it on top of the current ad-hoc "check `PRAGMA
   table_info` and `ALTER`" blocks is how a half-migrated production
   database happens. `restart.sh` already writes a placeholder
   `SCHEMA_VERSION` into every backup, ready to read the real version.
2. **Households table and membership.**
   - Add `household_id` to `items`, `item_events`, `locations` and `tags`.
   - Migrate every existing row, and every existing user, into one default
     household. The user's current data must come through untouched.
     Verify that against a copy of a real backup, not just the scratch
     database.
3. **Session to household in middleware** (`req.householdId`). Then scope
   every query above, with data-access functions taking `householdId` as
   their first argument, per the design doc.
4. **Signup and join flow.**
   - Signup either creates a household or joins one with an invite code.
   - Add a way for a member to see or regenerate their household's invite
     code.
5. **Committed isolation test.** Before calling it done, add a script to
   the repo (not just the scratchpad) that:
   - creates two households with overlapping location/tag names;
   - checks that every endpoint returns nothing from the other household;
   - checks that every `:id` route 404s on the other household's ids.
6. **Then the ops scripts**: the household filter in
   `common_sql_commands.sh`, and the household in log lines.

### Decisions to confirm with the user before coding

Each has a suggested default; ask rather than assume.

- **One household per user, or several?** Default: one (a `household_id`
  on `users`), which is much simpler. A membership table is only needed
  if one person should switch between, say, their own home and a
  parent's.
- **How people join.** Default: an invite code shown on Settings, entered
  at signup. No email, so no mail server.
- **Open signup.** Default: signup without an invite code creates a new,
  empty household. An alternative is an env var such as
  `ALLOW_NEW_HOUSEHOLDS=false` to close signup entirely on a private
  deployment.
- **Roles.** Default: none, every member is equal. Ask whether anyone
  should be able to remove members or rotate the invite code exclusively.
- **Name of the default household** that existing data migrates into,
  e.g. "Home".
- **Data the user may want shared across households.** Probably nothing,
  but confirm. Per-household locations and tags is the plan.

## Working conventions (unchanged from handoff 01, plus a few)

- **Branching:** one branch per feature effort, merged to `main` when
  confirmed working on the user's own server. Both merges so far used
  `--no-ff`.
- **`features.md`:** add a Shipped entry for every feature-sized change,
  and rewrite Roadmap entries when work supersedes them.
- **UI testing:** UI changes get a headless-browser pass (Playwright) at
  phone width (~390px) and at the ≥720px layout, against a seeded scratch
  database. Run the server with `DB_PATH=<scratch>/test.db PORT=3456 node
  src/index.js` from `server/`.
  - Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
  - Playwright resolves from `/opt/node-tools/node_modules/playwright`.
- **Parser changes:** keep every line in `dictation_examples.md` passing.
  Last session drove the real quick-add box with Playwright and compared
  the filled form fields (38 cases). That harness lived in the scratchpad
  and wasn't committed. Rebuild it from the examples file, or consider
  committing one.
- **Cloud container gotchas:**
  - `sqlite3` isn't preinstalled; `apt-get install -y sqlite3` works.
  - `pkill -f "node src/index.js"` kills your own shell, because the
    pattern matches the shell's command line. Use
    `kill $(pgrep -f "^node src/index.js")` instead.
- **The user tests on a real iPhone** against their home server
  (`restart.sh`: backup, pull, rebuild only if code changed). Server-side
  changes need that restart; front-end-only changes just need a reload
  after the pull. Expect real-device feedback to drive follow-ups, as it
  did for the parser this session.
- **Keep it small:** a single-household-origin app on purpose. No bundler,
  minimal dependencies, hand-rolled sessions. Multi-household support
  shouldn't change that philosophy. Nothing in the plan above needs a new
  dependency.
