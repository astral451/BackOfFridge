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

### Decisions (confirmed with the user, 2026-10-09)

The user answered these directly; build to them rather than re-asking.
The few points still awaiting a yes are marked.

- **One person belongs to one household.** Use a `household_id` column on
  `users`, not a membership table.
- **New households come from the admin.** The admin issues a
  *new-household invite code*. Whoever redeems it at signup names the
  household and becomes its first member. This is the "new household
  option" the user asked for, while keeping household creation gated by
  the admin.
- **Joining an existing household uses that household's invite code**,
  shown on its Settings page.
- **Signup without a code becomes a pending account**, not a disallowed
  one. The user asked whether this could notify an admin to let them in.
  The approach proposed, pending the user's yes:
  - Create the account with `users.status = 'pending'`. It can't reach
    any data and sees a "waiting for approval" page.
  - The admin page shows a pending count and a list. For each account the
    admin can approve it into a new household (the admin names it),
    approve it into an existing household, or reject it.
  - The notification is in-app only (no mail server), plus a server log
    line.

  If that turns out to be too complicated, the user's fallback is to
  disallow code-less signup entirely.
- **The admin is system-wide**, over all households (a separate
  `users.is_admin` flag, not a household role).
- **Permissions are universal within a household for now**: every member
  can change items, locations and tags. But the structure must exist for
  finer permissions later:
  - a household role column on `users` (`household_role`, default
    `'member'`);
  - every mutating route goes through one central check (e.g.
    `can(req.user, 'items:write')`), which today returns true for any
    active member.

  Adding permissions later should then mean changing that one function
  and the roles, not touching every route.
- **The admin account: a separate, dedicated login.** Proposed, pending
  the user's yes:
  - Don't promote one of the everyday household logins. A lost phone with
    a 30-day session shouldn't carry system-wide power, and "one person,
    one household" means the admin oversees the system rather than being
    a member of a household.
  - Bootstrap from the server's command line, not the web: a small script
    such as `node server/scripts/admin.js create <username>` /
    `grant <username>` / `revoke <username>`, run via
    `docker compose exec`. Shell access to the server is the proof of
    ownership; there's no admin password in env files and no web route
    that grants admin.
  - The user also wanted to test the grant process, so `grant` should
    work on an existing login. Test it on a throwaway account.
- **Existing data.**
  - The migration moves every existing item, event, location, tag and
    user into household #1, with a placeholder name ("Household 1").
  - The user names it through the admin's household loop
    (create/rename households), so build rename into that page.
- **Versioning is required, and comes first** (step 1 above). The user
  explicitly asked that, since this is both a server and a database
  update, versioning must work before the household migration runs on
  their real data.
  - **Migration runner:** a `schema_migrations` table (`version`,
    `name`, `applied_at`) and numbered migrations that run once each, in
    order, each inside a transaction (SQLite DDL is transactional, so a
    failure rolls back completely).
  - **Baseline migration (001):** today's schema, written idempotently so
    an existing database just gets marked as being at 001 with no
    changes.
  - **Household migration (002):** the household change.
  - **Downgrade protection:** refuse to start if the database's version is
    newer than the code's highest migration.
  - **Backups:** `restart.sh` writes the real applied version into each
    backup's `SCHEMA_VERSION` instead of `"unversioned"`.
  - **Dry run:** a check the user can run on the server against a copy of
    a backup (e.g. `node server/scripts/migrate-check.js <copy.db>`). It
    applies pending migrations to the copy and prints before/after counts
    (items, events, locations, tags, users, and per household), so the
    user can confirm their data lands in household #1 before the real
    restart. The cloud session can't see the user's real database, so
    this is how the migration gets verified against real data.

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
