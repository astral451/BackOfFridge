# Agent Handoff 03

Written 2026-11-04, at the end of session 03 (quantity model + barcode
scanning). Like the earlier handoffs, this is a one-time snapshot, not
maintained going forward. `features.md` stays the living source of truth.
If you leave a note for the session after yours, make it
`agent_handoff_04.md` rather than editing this one.

## Why there's a new session

Barcode scanning is built on branch `claude/barcode-scanning`, but the
session that built it ran in a cloud environment whose network policy
blocks `world.openfoodfacts.org`. Every Open Food Facts (OFF) behaviour was
tested against a local stub server that answers in OFF's documented
format, **never against the real API**. The user created a new environment,
`ENV_BackOfFridge`, which allows that host. **Your first job is the live
check described below.** Start with:

```
git fetch origin claude/barcode-scanning
git checkout claude/barcode-scanning
cd server && npm install && npm test   # expect 59 passing
curl -sS -A "BackOfFridge/1.0 (self-hosted home inventory app)" \
  "https://world.openfoodfacts.org/api/v2/product/5449000000996.json?fields=product_name,brands,quantity"
```

If that curl gets `CONNECT tunnel failed, response 403`, this session is
still not in `ENV_BackOfFridge`. Tell the user rather than working around
it.

## Where things stand

### On `main` (deployed and running on the user's server)

- **Quantity model, step 1:** `items.purchased_quantity` (migration 003).
  It's set once at creation and never changed after. "Buy again"
  pre-fills it, so a 12-pack with 3 left suggests 12.
- **Quantity model, step 2:** for a fill-level item, `quantity` counts units
  and `fill_percent` is the open unit. Finishing it (`−` at ≤10%, or
  quick-set 0%) consumes one unit, and `reduceQuantity` starts the next at
  100%. Low stock waits for the last unit. `prev_fill_percent` (migration
  004) lets undo restore the percentage. Rows show "40% + 1 full". This
  was tested by the user on their server from its own branch, then merged
  `--no-ff`.
- `features.md` has the full entries for both, plus the scanning design.

The database on the user's server is at **schema version 4**.

### On branch `claude/barcode-scanning` (not merged, not yet on the server)

Everything is in `features.md` under "Barcode/visual scanning" and in the
README ("Barcode scanning" section, plus two API table rows). File map:

- `server/src/barcode.js`: decoding with **zxing-wasm** (reader build).
  - The `.wasm` is read from `node_modules` via
    `require.resolve('zxing-wasm/reader/zxing_reader.wasm')`, so it's
    never fetched from a CDN.
  - Also: HEIC detection, plus `interpret(text, format)`, which
    normalises to one 13-digit key (UPC-A/EAN-13/GTIN-14; UPC-E
    expanded; EAN-8 kept) and pulls the GTIN and the AI 17 expiry out of
    GS1 Digital Link URLs and GS1 element strings.
- `server/src/openfoodfacts.js`: `lookup(barcode)` → `{ name, brand,
  package, image_url }`, or `null` for unknown products; it throws when OFF
  can't be reached. Details:
  - `OFF_BASE_URL` overrides the host (the tests point it at a stub).
  - 6 s timeout.
  - It sends a User-Agent and does **not** send the user's email or any
    personal data.
- `server/src/routes/products.js`: `POST /api/scan` (raw image body via
  `express.raw`, 25MB) and `GET /api/products/:barcode`. Lookup order:
  the household's `products` row, then OFF (cached into `products` as
  `source: 'openfoodfacts'`).
- Migration **005** (`barcodes`): `items.barcode`, and the `products` table
  keyed by `(household_id, barcode)`.
  - `store.rememberProduct` writes a `source: 'local'` row when an item
    is bought with a barcode or gets one through Edit.
  - `cacheProductLookup` never overwrites a local row.
- `public/`:
  - A camera button in the bottom bar (opens a fresh form, then the
    camera).
  - A barcode field + Scan button at the top of the purchase sheet.
  - Status line `#scanStatus`.
  - `applyLookup()` in `app.js` fills the form. Enter in the barcode
    field looks it up instead of submitting (wedge scanners send Enter).
  - `apiFetch` now lets a caller override Content-Type.
- Tests:
  - `server/test/barcodes.test.js`: stub OFF server; it generates real
    barcode images with zxing's writer and posts them through
    `/api/scan`.
  - `isolation.test.js` gained the two routes plus a per-household
    products check.

Verified in the old environment: all 59 server tests, and a Playwright run
at 390px:

- A tilted, blurred 3000×4000 JPEG decoded in ~0.8 s.
- Wedge-style typing and Enter worked.
- "Bought before" pre-fill, an unknown barcode, and a photo with no
  barcode all behaved correctly.

**Not verified anywhere yet:**

1. **Real OFF responses.** This is the job for this session, below.
2. **The Docker image.** The old container had the Docker CLI but no
   daemon. The image is `node:20-alpine`; the code was only run on Node
   22. Nothing used should differ (global `fetch`, `AbortSignal.timeout`,
   WebAssembly), but if your environment has a working Docker daemon,
   build it and run a decode inside it.
3. **A real iPhone.** That's for the user: does the camera open straight
   from the bottom-bar button, and do photos arrive as JPEG (not HEIC)?

## Job 1: check Open Food Facts for real

Goal: confirm `openfoodfacts.lookup` and the routes behave against the live
API the way the stub assumes, and fix anything that differs. Suggested
steps:

1. **Raw responses** with curl, using the same `fields=` list as
   `openfoodfacts.js` (`product_name,generic_name,brands,quantity,image_front_small_url`):
   - a well-known product: `5449000000996` (Coca-Cola 330ml);
   - a US UPC in 13-digit form: `0049000028911`. Also try the 12-digit
     form to see whether OFF accepts both, since the app always sends
     13;
   - something likely missing (a store brand, or `4006381333931`);
   - an invalid code like `0000000000000`.

   Things to check in the answers:
   - **Not found:** is it really HTTP 404 with `{ status: 0 }`? The code
     treats 404 as "not found" and any other non-2xx as an error.
   - Does a found product always have `status: 1`?
   - Is `product_name` sometimes empty, with only a
     language-specific field like `product_name_en` filled in? If so,
     consider requesting and falling back to `product_name_en`.
   - Is `brands` comma-separated?
2. **Through the code:** run `require('./src/openfoodfacts').lookup(code)`
   from `server/` for the same codes, then start the server against a
   scratch database (see conventions below) and hit
   `GET /api/products/:barcode` as a logged-in user. Confirm the second
   call is answered from the cache.
3. **Politeness:** OFF rate-limits product reads (roughly 100/minute at
   the time of writing). The app only calls OFF for a barcode the
   household hasn't cached, so normal use is far below that. Don't loop
   over hundreds of codes while testing.
4. **If anything differs from the stub,** fix `openfoodfacts.js` and update
   the stub in `barcodes.test.js` to match reality, so the tests keep
   describing the real API. Consider committing a small manual check
   script (e.g. `server/scripts/off-check.js <barcode>`) so this is
   repeatable. That's optional; ask the user.

Then report back to the user what OFF returned for their kinds of
groceries, and whether anything changed.

## Job 2: the user tests on their server, then merge

After job 1, the user deploys the branch:

```
git checkout claude/barcode-scanning
./restart.sh --build
```

- **Migration 005 is one-way.** Once their database is at version 5,
  `main` (which knows up to 4) refuses to start against it. The way back
  is restoring the backup `restart.sh` takes. If testing goes well, merge
  to `main` with `--no-ff` (as with the previous feature branches), mark
  the `features.md` entry shipped, and have the user switch the server
  back to `main`.
- **Lesson from this session:** the server once sat on a non-`main`
  branch, so `git pull` brought nothing and the schema stayed old. If the
  user reports "it says schema version N", have them check
  `git log -1 --oneline` and `git branch` on the server first. Also,
  `restart.sh` prints the version **before** pulling. It's the version of
  the backup, not of the new code.

## Possible follow-ups (none requested yet)

- Show the OFF product image (`image_url` is stored and returned, but the
  UI doesn't use it).
- Cache "not found on OFF" for a while, so repeat scans of an unknown
  store-brand product don't re-ask OFF every time. Today only hits are
  cached. Once the user saves the item, the barcode becomes a local
  product anyway.
- A live camera viewfinder (needs HTTPS; the Cloudflare Tunnel provides
  it). It would decode in the browser with the same zxing-wasm package.
  The server side wouldn't change.
- The optional vision-model step for barcode-less items or printed
  "best by" dates (phase 2 in `features.md`).

## Working conventions (from handoff 02, plus what this session learned)

- **Branching:** one branch per feature effort. The user tests on their
  server, then it's merged to `main` with `--no-ff`. Small, low-risk
  fixes have gone straight to `main` when the user asked for that.
- **Force-push is blocked** by the session's auto-mode classifier. Don't
  rewrite pushed history. The old branch `claude/food-inventory-tracker-n5l9mf`
  is stale (it was reconciled with a `-s ours` merge); ignore it.
- **`features.md`:** add a Shipped entry for every feature-sized change.
  Rewrite Roadmap entries when work supersedes them.
- **Schema changes** are numbered migrations in `server/src/migrations/`.
  - Never edit a shipped migration.
  - Tests for an older migration pin themselves with
    `MIGRATIONS.slice(0, n)`, so later migrations don't change what they
    check.
  - Version assertions elsewhere use `MIGRATIONS.length`.
- **Route tests without the signup flow:** mount the real router behind a
  stub middleware that sets `req.user = { status: 'active', householdId }`,
  `req.householdId` and `req.username`. See `fill-level-units.test.js` and
  `barcodes.test.js`. `isolation.test.js` uses the full app and real
  signup, and its header asks you to add every new household data route
  to its checks.
- **UI testing:** Playwright at phone width (390px) against a scratch
  database:
  - Start the server with `DB_PATH=... LOG_PATH=... PORT=... node
    src/index.js` from `server/`.
  - Create the admin with `node scripts/admin.js create root`. It prints
    a password; log in, create a new-household code via
    `/api/admin/codes`, then sign up a member with it.
  - Run scripts with `NODE_PATH=$(npm root -g)` so `require('playwright')`
    resolves.
  - Keep harness scripts in the scratchpad unless the user wants them
    committed.
- **Cloud container gotchas (from handoff 02):** `sqlite3` isn't
  preinstalled (`apt-get install -y sqlite3`). Kill a test server with
  `kill $(pgrep -f "^node src/index.js")`, not `pkill -f`, which also
  matches your own shell.
- **Keep it small:** no bundler, minimal dependencies. This session added
  exactly one, `zxing-wasm`. The photo upload uses `express.raw`, not
  `multer`.
