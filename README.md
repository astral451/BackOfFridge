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
- **Auth:** a single shared `API_KEY`. The browser asks for it once and stores it in
  `localStorage`; every API request sends it as the `x-api-key` header.

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

**macOS/Linux (bash/zsh):**
```bash
cd server
npm install
API_KEY=some-secret npm start
```

**Windows (PowerShell)** — inline `VAR=value command` syntax isn't valid PowerShell,
so set the environment variable as its own statement first:
```powershell
cd server
npm install
$env:API_KEY="some-secret"
npm start
```

Visit `http://localhost:3000`.

### Docker (recommended for the home server)

No Node.js/npm needed on the host for this path — Docker builds it inside the image.

```bash
cp .env.example .env   # then edit API_KEY
docker compose up -d --build
```

Data persists in `./data/inventory.db` on the host, so container rebuilds/restarts
don't lose anything.

This same image runs unmodified on a cloud host (Fly.io, Render, a VPS, etc.) — point
it at that platform's persistent volume for `DB_PATH` instead of a local bind mount.

### Reaching it from your phone / Supernote away from home

The container only listens on the port you expose; it doesn't set up remote access.

**If you currently have a router port forwarded straight to this app: stop.**
A raw port-forward puts your home's public IP directly in front of internet
scanners with no TLS, fronted by nothing but the app's single shared
`API_KEY`. It's fine for a quick local test, but not for anything left running
long-term. Close that port-forward once one of the options below is working.

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

All routes below require the `x-api-key` header.

| Method | Path | Purpose |
|---|---|---|
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
reach it (e.g. a Cloudflare Tunnel URL + the `API_KEY`). That wiring wasn't built yet —
worth a follow-up once the core tracker is in daily use.

## Not built yet / ideas

- Non-perishable-specific views (this session focused on the perishable/expiration
  workflow since that's the immediate need; the schema already supports both).
- Push/email notifications for items expiring soon.
- Voice input via a Claude skill hitting the API above.
- Multi-user accounts (currently single shared API key).
