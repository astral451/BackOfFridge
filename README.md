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

## Running it

### Local (no Docker)

```bash
cd server
npm install
API_KEY=some-secret npm start
```

Visit `http://localhost:3000`.

### Docker (recommended for the home server)

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
Options, cheapest first:
- **Tailscale / a WireGuard tunnel** on the home server — phone joins the same
  private network, hits it by hostname, no port forwarding.
- **Cloudflare Tunnel** — free, gives you a public HTTPS URL without opening a port
  on your router.
- Traditional port-forward + your own domain/TLS if you want it fully public.

## API (for future automation, e.g. a voice-logging skill)

All routes below require the `x-api-key` header.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/items` | List items. Filters: `status`, `location`, `category`, `expiring_within_days` |
| GET | `/api/items/:id` | Get one item |
| POST | `/api/items` | Log a purchase (`name` required; `category`, `location`, `quantity`, `unit`, `purchase_date`, `expiration_date`, `notes` optional) |
| PATCH | `/api/items/:id` | Update any field |
| POST | `/api/items/:id/throw-out` | Mark thrown out (sets `status` + `thrown_out_date`, defaults to today) |
| POST | `/api/items/:id/consume` | Mark used up |
| DELETE | `/api/items/:id` | Remove an item |
| GET | `/api/locations` | Distinct locations already in use, for autocomplete |
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
