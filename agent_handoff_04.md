# Agent Handoff 04

Written 2026-11-06, at the end of session 04 (live Open Food Facts check,
scanning follow-ups, update safety, and the design of the quick entry card).
Like the earlier handoffs, this is a one-time snapshot, not maintained going
forward. `features.md` stays the living source of truth. If you leave a note
for the session after yours, make it `agent_handoff_05.md` rather than
editing this one.

## Where things stand

### On `main` (merge `d8cb75b`)

**Barcode scanning has shipped.** The user tested it on their server from
`claude/barcode-scanning`, then it was merged `--no-ff`. The database on the
user's server is at **schema version 5**. Beyond what handoff 03 described,
this session added:

- **The live Open Food Facts check** (handoff 03's job 1). `lookup()`
  handled every real response correctly. Only the test stub was out of
  date; it now holds real responses. Facts worth knowing:
  - Unknown product: HTTP 404, `{ status: 0 }`.
  - A code OFF rejects outright (e.g. all zeros): **HTTP 200** with
    `{ status: 0 }`. The code treats both as "not found".
  - A 12-digit UPC and its 13-digit form both work.
  - `brands` is comma-separated, consumer brand first.
  - `product_name` is in the product's main language: Milka comes back in
    French. `product_name_en` exists but can be junk (Cheerios: "My Bff"),
    so it's not used.
  - `4006381333931` exists on OFF as a junk "Diagnostic Test Product DELETE
    ME". Don't use it as a "missing" example; `2900000001237` is a real 404.
- **Name matching** (`server/src/namematch.js`,
  `POST /api/products/:barcode/link`). When OFF names a barcode the
  household hasn't linked yet, the lookup also returns `matches`: up to 3
  names the household entered without a barcode that look alike. The form
  asks *Same as your "Melon medley waterloon"?* Yes gives the barcode to
  all those items (an `edited` event each) and makes the latest one what
  the barcode pre-fills.
- **Barcode as product identity.** Within a household, the barcode is the
  product's identity when an item has one; otherwise the name (ignoring
  case and surrounding spaces). Group by
  `COALESCE(barcode, 'name:' || LOWER(TRIM(name)))` for a future "what we
  buy most". Caveat: one product in two package sizes has two barcodes.
- **Package size into Qty/Unit** (`parsePackage` in
  `server/src/openfoodfacts.js`). OFF's free-text size fills the form the
  way quick add treats "two, 24 ounces": Unit = size of each, Qty = how
  many (`12 x 12 fl oz` → Qty 12, Unit "12 fl oz"). It only fills
  untouched fields. Checked live with `0041192100147` (Frosted Mini
  Wheats, `32 oz`).

All 67 server tests pass on `main`.

### Branch `claude/barcode-scanning` (where the next job happens)

The user asked to keep working on this branch for the entry-UI rewrite, and
their server is checked out on it. It has been brought level with `main`
(merge commit plus this handoff), so new commits go on top. The name no
longer describes the work; that's the user's choice, so keep it.

### Branch `claude/update-safety` (built, not deployed, not merged)

Commit `bbdfb5c`, started from `main` **before** scanning merged. Full entry
in its own `features.md` ("Update safety"). In short:

- **Who's online.** `server/src/activity.js` records each signed-in
  request, plus a 60 s heartbeat (`POST /api/ping`, not logged) from
  visible pages. "Online" means seen in the last 2 minutes. The times are
  kept in `data/activity.json`. `scripts/activity.js` prints them and
  exits 3 when someone is online. The admin page has "Who's online".
- **`restart.sh`:**
  - Asks before updating if someone is online; stops if there's no
    terminal to ask in; `--force` skips the question.
  - Builds before stopping the server, and stops only the app service,
    so the Cloudflare tunnel stays up.
  - Creates `data/MAINTENANCE` before the stop, which makes `/api/*`
    answer 503 "being updated".
  - Runs its main steps as one `{ ... }` block, so `git pull` changing
    the script mid-run is safe.
- **SIGTERM handling** in `src/index.js`, which saves 10 s on every stop.
- **`public/connection.js`:** the "Server is being updated" notice. It
  reloads the page when the server is back, but not if a form is open or
  a save was lost, and it never resends a save.
- **`LOG_PATH=/data/app.log`** in `docker-compose.yml`. The log used to
  sit inside the container and was lost on every rebuild.

**Before deploying it:** merge `main` into it. Started from the old
`main`, it only knows schema version 4, and the server (now at 5) would
refuse to start on it. A test merge with scanning was clean, and all 68
tests passed on the merged code. Not yet tested anywhere:
- Real Docker. This container has no Docker daemon; `restart.sh` was
  checked against a stand-in `docker` command.
- The interactive "Update anyway? [y/N]" prompt, which needs a TTY.
- The first real run, which skips the activity check because the old
  server has no `scripts/activity.js`. It says so and continues.

The user hasn't said when they want it deployed. Ask.

## The next job: the quick entry card

Replace the purchase sheet with a compact card used by **every** way of
adding or changing an item: a scan (bought before, or found on OFF), the
**+** button, "Buy again", and Edit.

- **Design and decisions:** `features.md`, Roadmap entry "Quick entry card:
  one form for adding and editing". It's complete: layout, every decision
  and its reason. Read it first.
- **Clickable mockups:** https://claude.ai/artifact/JPGBHKB7F1ujrPWv6KbgpK
  (a Design canvas, private to the user). Read it with the Artifact
  tool's `read` action, not a web fetch. There are two phone screens:
  - "Granola bar: approximate expiry"
  - "Chicken: exact date, 3 taps"
  `project/Main.dc.html` holds the working prototype logic: chip sizes,
  how the dates are worked out, the month → day → year steps, the
  highlighted likely year, and "Save & scan next". Treat it as a visual
  and behavioural reference only; the real build uses the app's own
  plain JS and `styles.css` (no bundler, no framework).

The decisions the user made, in brief:
- **Location:** square tiles (about 80×64 px, two rows, scrolling
  sideways; 10+ locations). **Tiles never reorder** (moving them was
  jarring), so scroll the row to show the selected tile. Preselected:
  last time's location for a product bought before, else the previous
  item's this trip.
- **Expiry:** Approx chips (3 days … 1 yr, None), each showing the date
  it sets, or an Exact date picked in 3 taps (month grid → day grid →
  year), with the likely year highlighted. **Perishable opens Exact,
  non-perishable opens Approx.** The app's category field is already just
  perishable/nonperishable.
- **Category for a new scanned item:** guess from OFF `food_groups_tags`
  (meat, fish, milk/dairy → perishable; also tagged `en:canned-foods` →
  not). Otherwise default to non-perishable. Remember what's saved. **This
  needs `food_groups_tags,categories_tags` added to `FIELDS` in
  `openfoodfacts.js`**, and the stub updated.
- **Quantity stepper** right under the name (− / number / +).
- **Typing an item in (+):** the name comes first, with suggestions from
  the household's products. Done or picking one closes the keyboard and
  shows the whole card.
- **"Or say it"** field with a mic, below the date picker, using the
  existing quick-add reader. The quick-add bar stays as it is.
- **Save & scan next** is the main button, because a whole shopping trip
  is entered at once. On iOS the camera can only open from a user's tap,
  so that tap is what opens it. A plain Save sits beside it, and the
  header counts items saved this trip.
- "More details" opens in place: unit, category, tag, purchase date,
  notes, fill level.
- **Edit** opens on Exact date with the item's date selected.
- Both light and dark themes.

Suggested approach: build it in steps the user can try on the phone between
commits.
1. The card shell with location tiles and the quantity stepper, driven
   from scans.
2. The expiry chips and the 3-tap picker.
3. "Save & scan next".
4. Moving **+**, Buy again and Edit onto the card.
5. "Or say it", and the category guess from OFF.

The current form's logic to reuse or carry over is in `public/app.js`:
`applyLookup`, `fillFormFromItem`, the quick-add parser (around lines
240–620; `monthDateToISO` already finds the next occurrence of a month and
day), `showFillField`, and the submit handler.

## Lessons from this session

- **Switching branches can leave the wrong packages installed.**
  `npm install` on a branch without `zxing-wasm` removes it, and every
  scanning test then fails in setup (and hangs). Re-run `npm install` in
  `server/` after switching branches.
- **A crashed Playwright harness leaves its test server running** on its
  port, and the next run silently talks to the old server. Before
  rerunning, check `pgrep -f src/index.js`, and stop servers in a
  `finally`.
- **Playwright:** to wait for an element to disappear, use
  `waitForSelector(sel, { state: 'hidden' })`. A `[hidden]` selector
  waits for it to be *visible*.
- **`GET /api/items?status=all` returns nothing:** `status` is an exact
  filter. Leave it out to get every status.
- **Test harnesses** lived in the scratchpad and weren't committed: a
  stand-in OFF server on a local port with `OFF_BASE_URL`; a stand-in
  `docker` on `PATH` that records its calls; Playwright at 390px against
  a real `node src/index.js`. They're quick to rebuild from these notes.
- **OFF politeness:** about 100 product reads a minute. This session used a
  few dozen requests in total.

## Working conventions (unchanged from handoff 03, plus)

- One branch per feature effort, except that the user chose to keep
  `claude/barcode-scanning` for the entry UI. The user tests on their
  server, then it's merged `--no-ff`. Report before merging.
- **Force-push is blocked.** Don't rewrite pushed history.
- `features.md`: a Shipped entry for every feature-sized change, and
  rewrite Roadmap entries when work supersedes them.
- **Schema changes** are numbered migrations in `server/src/migrations/`.
  Never edit a shipped migration (005 is shipped). The next is 006.
- Route tests: mount the real router behind a stub login middleware (see
  `barcodes.test.js`). Add new household data routes to
  `isolation.test.js`'s `HOUSEHOLD_ENDPOINTS`.
- UI testing:
  - Playwright at 390px against a scratch database: `DB_PATH=...
    LOG_PATH=... PORT=... node src/index.js`.
  - Create the admin with `node scripts/admin.js create root`.
  - Get a code via `POST /api/admin/codes`, then sign up a member.
  - Run with `NODE_PATH=$(npm root -g)`.
- Keep it small: no bundler, minimal dependencies.
