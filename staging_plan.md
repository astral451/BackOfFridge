# Staging: testing changes without taking the real app down

Scoping notes, written 2026-10-10 during session 03. **Not built yet**, and
not urgent: this is the plan to pick up when it's wanted. When it's built,
move the result into README and features.md and mark this file as done.

## The problem

There's one copy of the app today. Testing a branch means pulling it onto
the real server, so:

- the real app is down for the restart, and broken if the branch is;
- the branch runs against the real database, so a bad migration or a bug
  writes to real data (the backup in `restart.sh` makes that recoverable,
  but only by rolling back everything since);
- you can't compare old and new side by side on the phone.

`migrate-check.js` covers part of this (it proves a migration is safe on a
copy of real data), but not "does the new app actually work on my phone".

## The idea

A second, separate copy of the app on the same server, the **staging**
copy, running the branch under test against a **copy** of the real data.
The real copy (**production**) keeps running `main`, untouched.

```
~/apps/BackOfFridge           production: branch main, port 3000, ./data
~/apps/BackOfFridge-staging   staging: any branch, port 3001, its own ./data
                              (seeded from the newest production backup)
```

Flow for a feature branch:

1. Build the branch in staging. Refresh staging's data from the newest
   production backup first, so it's tested on today's real data.
2. Test on the phone against staging.
3. When it's right: merge to `main`, then `./restart.sh` in production
   (backup, pull, rebuild, the same as today).
4. Staging's data is throwaway. Nothing written there ever goes back to
   production.

Cost: one more small container (the app idles at a few tens of MB) and a
second copy of the database on disk.

## Pieces

### 1. A second checkout: a git worktree

`git worktree add ../BackOfFridge-staging <branch>` gives a second working
folder sharing the same repository, on its own branch. Production's folder
never changes branch, so `restart.sh` there keeps pulling `main`. Switching
staging to another branch is a `git checkout` inside the staging folder.

(Using the *same* folder for both doesn't work: it can only have one branch
checked out at a time.)

### 2. A separate Docker Compose project

Run staging as its own Compose project, so its container, image and network
are separate from production's even though the compose file is the same:

```bash
docker compose -p backoffridge-staging -f docker-compose.yml -f docker-compose.staging.yml up -d --build
```

A small `docker-compose.staging.yml` override would set:

- **Port 3001** (production stays on 3000).
- **Its own data folder.** In the worktree, `./data` already *is* separate
  (`data/` is gitignored, so each folder has its own), but naming it
  `./data-staging` in the override makes it obvious which is which.
- **`APP_ENV=staging`**, for the banner and cookie name below.
- **No `cloudflared`** by default (see "Reaching staging" below).

### 3. A `staging.sh` script

The staging counterpart of `restart.sh`, run from the production folder:

- `./staging.sh up <branch>`: create the worktree if needed, check out and
  pull `<branch>`, refresh the data, build, start.
- `./staging.sh refresh-data`: stop staging, copy the newest
  `data-backups/<timestamp>` into staging's data folder, start again.
- `./staging.sh down`: stop and remove the staging container (keeps the
  worktree and data).
- `./staging.sh status`: which branch, which schema version, which backup
  its data came from.

Refreshing from a backup rather than copying production's live `data/`
avoids copying a running WAL database (the same reason `restart.sh` stops
the container before backing up), and it doesn't need production stopped.

### 4. Small app changes

Two things in the app itself, both a few lines:

- **A visible STAGING banner** when `APP_ENV=staging`: a coloured strip on
  every page. On a phone the two copies otherwise look identical, and it
  matters which one you're adding real groceries to.
- **A separate session cookie name in staging** (e.g.
  `session_token_staging`). Browsers keep cookies per host name, *not* per
  port. `http://192.168.1.10:3000` and `:3001` would share one
  `session_token` cookie, so logging into one would log you out of (or
  into) the other. A different cookie name keeps them apart. (A separate
  host name for staging, below, also avoids this.)

### 5. Reaching staging from the phone

Options, simplest first:

- **Home wifi only**: `http://<server-ip>:3001`. No setup. Enough for most
  testing.
- **A second Cloudflare Tunnel hostname** (e.g. `staging.<your-domain>`)
  routed to port 3001: one more public-hostname entry on the existing
  Named Tunnel in the Cloudflare dashboard, no second `cloudflared`
  container needed. One catch: the existing `cloudflared` sits on
  production's Compose network, so it can't reach staging by service name;
  the route would point at the server's own address and port instead
  (e.g. `http://192.168.1.10:3001`). Worth adding
  Cloudflare Access (email login in front of it) so staging isn't open to
  the internet. Only needed for testing away from home.

## Things to be careful about

- **Staging holds a full copy of real data**, including password hashes and
  live session tokens. A session token copied from production is valid in
  staging too. That's fine on the home network; it's a reason to put
  Cloudflare Access in front if staging is ever exposed publicly.
- **Never point staging at production's `data/`.** The override file and
  `staging.sh` should both refuse to use a path that resolves to
  production's data folder.
- **Migrations run in staging first.** That's the point: a branch with a
  new migration upgrades staging's copy on start, and the real database
  only after merge. The dry-run (`migrate-check.js`) is still worth running
  against a fresh backup right before the production restart, since
  staging's copy may be days old by then.
- **Staging's schema can be ahead of production's.** Refreshing staging
  from a production backup rolls its data back to production's version,
  which is fine: the branch's migrations simply run again on start.
- **Disk:** each refresh is one copy of `data/` (small today: a few MB).

## Rough size

Small: a compose override file, a shell script of about the same size as
`restart.sh`, the banner and cookie-name changes, and a README section. No
new dependencies. A single session could build and test it, apart from the
Cloudflare hostname, which is a dashboard step.

## Open questions for the user

- Home wifi only to start, or a staging hostname through the tunnel too?
- Should `staging.sh up` refresh the data automatically every time, or keep
  staging's data between branch switches unless you ask?
- Production has been running the `multi-household` branch while it was
  built, which is the situation this plan avoids. Once that branch is merged
  and production is back on `main`, it's a natural point to set staging up.
