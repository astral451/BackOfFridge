# BackOfFridge

A small self-hosted inventory tracker: log what you buy, where you stored it, when it
expires, and when you throw it out. Built as a plain web app (no app-store install)
so it works from any browser — iPhone Safari, a PC, or the Supernote's browser when
it's on wifi.

## Stack

- **Backend:** Node.js + Express + SQLite (`better-sqlite3`) — one process, one file
  database, low resource use. No build step.
- **Frontend:** static HTML/CSS/vanilla JS served by the same server. No framework,
  no bundler — keeps it working in older/limited browsers like Supernote's.
- **Auth:** real per-person accounts (username + password), not a shared secret.
  Logging in sets an httpOnly session cookie; the browser sends it automatically
  on every request. One shared inventory — everyone who's signed up sees and
  edits the same data (no per-family isolation; see `features.md` for why
  that's deliberately out of scope for now). Sign up at `login.html`.

## Data model

Everything is an `item`: `name`, `category` (`perishable` / `nonperishable`),
`location` (free text — "fridge", "chest freezer", "pantry shelf 2", ...), `quantity`,
`unit`, `purchase_date`, `expiration_date`, `status` (`active` / `consumed` /
`thrown_out`), `thrown_out_date`, `notes`. The same table already covers non-perishable
items — just set `category: "nonperishable"` and leave `expiration_date` blank.

Two more fields support low-stock tracking: `tracking_mode` (`count` — the
default, uses `quantity` — or `fill_level`, for things like a bin of dog food
or a milk jug where a discrete count doesn't really apply) and `fill_percent`
(0-100, set via a slider in the UI when `tracking_mode` is `fill_level`).
`low_stock_threshold` marks when an item should be flagged as running low —
interpreted as a quantity for `count` items or a percentage for `fill_level`
items (fill-level items default to 25% if no threshold is set; count items
have no default, since a sensible number varies too much by unit to guess).

Every purchase, consume, throw-out, edit, undo, and delete is also recorded
in `item_events` (item id/name, event type, a JSON detail blob, timestamp) —
an actual queryable history, distinct from the human-readable log file below
and from the single-slot undo memory. See `GET /api/items/:id/history`. One
exception: a PATCH that only changes `purchase_date`/`expiration_date` (the
"Edit dates" button — for correcting a date mistake, not a consumption
event) is left out of `item_events` since it isn't a usage pattern worth
tracking, though it's still written to the plain text log below.

Each `item_events` row also records the `username` of whoever did it, so
"who reduced this already" is answerable in the history rather than
everyone editing blind. `users` (username, bcrypt password hash) and
`sessions` (opaque token, expiry) back the login system — hand-rolled
rather than a session-store library, matching this project's preference
for small, direct dependencies.

## Running it

### Prerequisites

You need either Node.js (which includes `npm`) or Docker — not both. Pick whichever
path below you plan to use.

**Installing Node.js + npm:**

- **macOS:** `brew install node` (install [Homebrew](https://brew.sh) first if you
  don't have it), or download the installer from
  [nodejs.org](https://nodejs.org/) (choose the LTS version).
- **Windows:** download the LTS installer from [nodejs.org](https://nodejs.org/) and
  run it — npm is included automatically. Or, if you use
  [winget](https://learn.microsoft.com/windows/package-manager/winget/):
  `winget install OpenJS.NodeJS.LTS`.

  If `node -v` works afterward but `npm -v` fails with
  `File ... npm.ps1 cannot be loaded because running scripts is disabled on this
  system`, PowerShell's execution policy is blocking it (npm itself is fine).
  Fix it by opening PowerShell **as Administrator** and running:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```
  Confirm with `Y`, then close that window and try `npm -v` again in a normal
  PowerShell window.
- **Linux (Debian/Ubuntu):** the version in `apt` is often old, so use NodeSource:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
- **macOS/Linux via nvm** (lets you manage multiple Node versions — requires
  `bash`, so this is not for Windows/PowerShell; Windows users should use the
  installer or `winget` option above, or [nvm-windows](https://github.com/coreybutler/nvm-windows)
  if you specifically want an nvm-style tool):
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  nvm install --lts
  ```

Verify it worked:

```bash
node -v
npm -v
```

**Installing Docker** (if you'd rather skip Node/npm entirely — the container builds
the app itself): install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
(macOS/Windows) or, on Linux, follow the
[official install guide](https://docs.docker.com/engine/install/) for your
distribution. Verify with `docker --version` and `docker compose version`.

### Local (no Docker)

```bash
cd server
npm install
npm start
```

Visit `http://localhost:3000` — it redirects to `login.html` since nobody's
signed up yet. Sign up there to create the first account.

### Docker (recommended for the home server)

No Node.js/npm needed on the host for this path — Docker builds it inside the image.

```bash
cp .env.example .env
docker compose up -d --build
```

Visit `http://localhost:3000` and sign up to create the first account. Data
persists in `./data/inventory.db` on the host, so container rebuilds/restarts
don't lose anything.

This same image runs unmodified on a cloud host (Fly.io, Render, a VPS, etc.) — point
it at that platform's persistent volume for `DB_PATH` instead of a local bind mount.

### Backing up before pulling an update

Worth doing before any `git pull` + `docker compose up --build`, since new
code can change the database schema on startup (see "Schema versions and
migrations" below). Backing up first costs nothing and means a bad upgrade
is always recoverable. `./restart.sh` does this automatically (stop, copy
`data/` into `data-backups/<timestamp>`, keep the last 20, start again —
pass `--build` to also rebuild the image after a `git pull`). Each backup
gets a `SCHEMA_VERSION` file holding the database's schema version at the
time (`unversioned` for a database from before versioning existed):

```bash
./restart.sh          # backup + restart, no rebuild
./restart.sh --build  # backup + rebuild + restart (after a git pull)
```

Or do it by hand:

```bash
cd ~/apps/BackOfFridge   # or wherever you cloned it
docker compose stop
cp -r data data-backup-$(date +%Y%m%d-%H%M%S)
docker compose start
```

The `stop`/`start` around the copy matters: the database runs in WAL mode,
so a copy taken while the app is running could miss very recent writes that
are still sitting in `inventory.db-wal` rather than the main file — copying
the whole (stopped) `data` folder avoids that. To restore, stop the
container, swap `data` for the backed-up folder, and start it again.

### Schema versions and migrations

Schema changes are numbered migrations in `server/src/migrations/`. The
database records the ones it has had in a `schema_migrations` table
(`version`, `name`, `applied_at`). At startup the server applies any it
hasn't had yet, in order, each in its own transaction: a migration that fails
partway rolls back completely, leaving the database at the previous version.
The startup log says which version the database is at:

```bash
docker compose logs backoffridge | grep -i "schema"
```

Migration 001 is the schema as it was before versioning existed, so an
existing database just gets recorded as version 1 with nothing changed.

If the database is at a *newer* version than the code knows (e.g. after
rolling the code back), the server refuses to start and says so in the logs,
rather than run old code against a schema it doesn't understand. Deploy the
newer code again, or restore a backup whose `SCHEMA_VERSION` the code knows.

**Dry run before a schema upgrade.** `server/scripts/migrate-check.js`
applies the pending migrations to a *copy* of a database and reports what
changed: version before and after, row counts per table (and per household,
once households exist), whether every existing row came through unchanged,
and an integrity check. The file you point it at is never written to. To
check new code against your real data before restarting onto it:

```bash
cd ~/apps/BackOfFridge
git pull                      # the new code; the running container is unaffected
docker compose build          # build the new image without restarting
ls data-backups/              # pick the newest backup restart.sh made
docker compose run --rm --no-deps \
  -v "$PWD/data-backups:/backups:ro" \
  backoffridge node scripts/migrate-check.js /backups/<timestamp>/inventory.db
```

It ends with `RESULT: OK` (exit code 0) or `RESULT: PROBLEMS FOUND`. Add
`--keep` to keep the migrated copy for a closer look (it's inside the
throwaway container, so only useful when running outside Docker). If it
looks right, restart onto the new code with `./restart.sh --build` (`--build`
is needed because the pull already happened, so `restart.sh` would otherwise
see no new commits and skip the rebuild).

Without Docker, from `server/`: `node scripts/migrate-check.js <path/to/inventory.db>`.
`npm test` (in `server/`) runs the migration tests.

### Reaching it from your phone / Supernote away from home

The container only listens on the port you expose; it doesn't set up remote access.

**If you currently have a router port forwarded straight to this app: stop.**
A raw port-forward puts your home's public IP directly in front of internet
scanners with no TLS. It's fine for a quick local test, but not for anything
left running long-term. Close that port-forward once one of the options
below is working.

Options, cheapest first:
- **Tailscale / a WireGuard tunnel** on the home server — phone joins the same
  private network, hits it by hostname, no port forwarding, no public exposure
  at all. Best choice if only your own devices need access.
- **Cloudflare Tunnel** (recommended for letting family members reach it from
  their own devices) — see the dedicated section below. No open port, free
  HTTPS, and the outbound connection is initiated by your server, so there's
  nothing on your router for a scanner to find.
- Traditional port-forward + your own domain/TLS if you want it fully public —
  not recommended; the two options above get you the same reachability
  without exposing the port itself.

### Cloudflare Tunnel

Cloudflare's tunnel, automatic HTTPS, and DNS hosting are genuinely free. A
**stable, memorable hostname** on top of it (rather than one that changes
every time you restart) needs a domain you own — cheap (a few dollars a
year from any registrar), not literally $0. Two paths depending on whether
you want that now or just want to test tonight:

**Quick Tunnel — free, zero signup, right now, but the URL is ephemeral**
(changes every time you restart it, so it's for testing, not a bookmark):
```bash
docker run --rm -it cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:3000
```
(replace `host.docker.internal` with your server's LAN IP if that hostname
doesn't resolve on your setup). It prints a random `https://something.trycloudflare.com`
URL — visit it, confirm the app loads over HTTPS from outside your network,
then stop it. This just proves the tunnel path works before committing to
the stable setup below.

**Named Tunnel — a stable hostname, needs a domain in your Cloudflare account:**
1. Get a domain (if you don't have one) from any registrar, then add it to a
   free Cloudflare account (Websites → Add a site) and switch the domain's
   nameservers to Cloudflare's, as their dashboard walks you through.
2. In the Cloudflare dashboard: Zero Trust → Networks → Tunnels → Create a
   tunnel. Name it (e.g. `backoffridge`), choose Docker as the connector
   type, and it gives you a `TUNNEL_TOKEN`.
3. Add that token to your `.env`, along with the profile flag that turns the
   `cloudflared` service on (it's skipped otherwise, so a plain
   `docker compose up` doesn't try to run a tunnel with no token):
   ```
   TUNNEL_TOKEN=the-token-from-the-dashboard
   COMPOSE_PROFILES=tunnel
   ```
4. Still in the tunnel's setup, add a **Public Hostname**: pick a subdomain
   (e.g. `pantry.yourdomain.com`), service type `HTTP`, and
   `backoffridge:3000` as the target (that's the app's Docker Compose
   service name, reachable by name on the shared Docker network — not
   `localhost`, since `cloudflared` runs in its own container).
5. `docker compose up -d --build` — the `cloudflared` service (already in
   `docker-compose.yml`, only runs if `TUNNEL_TOKEN` is set) connects out to
   Cloudflare automatically. Visit your chosen hostname from outside your
   network to confirm it works, then close the router port-forward for good.

## Logging

Every API request logs an `ACCESS` (or `ACCESS DENIED` for a bad/missing key)
line with the method, path, and requester IP, and purchases additionally log a
friendlier `PURCHASED "name" x<qty> <unit> -> <location>` line. Each line is
written both to stdout and to a local file, `<DB volume>/app.log` (so under
Docker that's inside your `./data` bind mount, right next to `inventory.db` —
same persistence, no extra volume needed).

To watch it live: `docker compose logs -f` (handy to leave running in a
`screen` session on the server). To read the persisted file directly:
`tail -f ./data/app.log`.

## API (for future automation, e.g. a voice-logging skill)

Every route below except the `/api/auth/*` ones requires a valid session
cookie (i.e. you're logged in as a real user — see "Auth" above).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | Create an account. Body `{ username, password }` (password 6+ chars). Logs you in. |
| POST | `/api/auth/login` | Log in. Body `{ username, password }` |
| POST | `/api/auth/logout` | Log out (clears the session) |
| GET | `/api/auth/me` | Currently logged-in username, or 401 if not logged in |
| GET | `/api/items` | List items. Filters: `status`, `location`, `category`, `expiring_within_days` |
| GET | `/api/items/:id` | Get one item |
| POST | `/api/items` | Log a purchase (`name` required; `category`, `location`, `quantity`, `unit`, `purchase_date`, `expiration_date`, `notes` optional) |
| PATCH | `/api/items/:id` | Update any field |
| POST | `/api/items/:id/throw-out` | Throw out some or all of an item. Body `{ quantity? }` — omit to throw out everything remaining, or pass a number to remove just that many (item stays `active` with the reduced quantity) |
| POST | `/api/items/:id/consume` | Same as above, but marks it `consumed` instead of `thrown_out` |
| POST | `/api/items/:id/undo` | Reverse the most recent throw-out/consume call on this item (one level of undo) |
| GET | `/api/items/:id/history` | This item's recorded events (purchased, consumed, thrown_out, edited, fill_level_set, undo, deleted), newest first |
| DELETE | `/api/items/:id` | Remove an item |
| GET | `/api/locations` | Managed location names, for the purchase form/filter dropdowns |
| GET | `/api/locations/detail` | Locations with a count of items currently referencing each, for the manage-locations page |
| POST | `/api/locations` | Add a new location. Body `{ name }` |
| DELETE | `/api/locations/:name` | Remove a location — fails with a 400 if any item still references it |
| GET | `/api/stats` | Counts: active / expiring soon (≤3 days) / expired |

This API is intentionally the integration point for the voice-logging idea: a Claude
Code skill or connector can call these same endpoints once you decide how you want to
reach it (e.g. a Cloudflare Tunnel URL). It would need its own credential rather than
a browser session cookie, though — a per-user personal access token, most likely.
That hasn't been built; worth a follow-up once the core tracker is in daily use.

## Not built yet / ideas

- Non-perishable-specific views (this session focused on the perishable/expiration
  workflow since that's the immediate need; the schema already supports both).
- Push/email notifications for items expiring soon.
- Voice input via a Claude skill hitting the API above — needs the personal-access-token
  idea mentioned just above first.
- Full multi-family isolation (separate households on one shared deployment). Login is
  per-user now, but everyone shares one inventory — see `features.md` for the shelved
  design if this ever becomes necessary.
