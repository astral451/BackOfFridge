# Agent Handoff 01

Written 2026-10-03, at the end of the session that built the phone-first
restyle. This file exists so a fresh agent session can pick up this project
without needing the previous session's chat history — everything that
matters is either in this file, `features.md`, or the git log.

## Where things stand

`main` now has everything from the (now-merged) `claude/phone-first-restyle`
branch: the full dark/light phone-first UI restyle, a Settings page,
`restart.sh` (backup + git pull + conditional rebuild), and
`common_sql_commands.sh`. See `features.md` for the full Shipped/Roadmap
list — keep that file in sync as things ship; it's the living source of
truth for project status, not this file.

This file is a one-time snapshot, not maintained going forward. If a later
session wants to leave a similar note for the one after it, give it the
next number (`agent_handoff_02.md`, etc.) rather than editing this one.

## Start here

1. Read `features.md` (Shipped + Roadmap) and `README.md` for the full
   picture — data model, deployment, API.
2. Check `git log --oneline -20` on `main` for recent history.
3. The user runs this on a home server via Docker Compose, with
   `restart.sh` handling backup + pull + restart. They have `sqlite3` on
   that machine and use `common_sql_commands.sh` to query usage history.

## What's next: UX-driven feature planning

The user's stated intent for the next phase: plan new features based on
**user experience** — i.e. starting from how the app is actually used,
not from the existing Roadmap list in `features.md` (though that list is
still a useful input/backlog, not a thing to ignore). No specific features
were scoped yet — this is a planning conversation that didn't happen in
this session's lifetime, so there's nothing to resume mid-thought here.

Worth bringing into that conversation:
- `common_sql_commands.sh`'s queries (most-purchased items, activity by
  user, recent events) are a real, already-built way to ground feature
  ideas in actual usage data rather than guessing.
- The existing Roadmap in `features.md` (Favorites filter, photo capture,
  barcode scanning, smarter dictation, narrow-width trimming, real
  schema-version tracking, AI agent access, multi-family isolation) is
  prior art worth checking new ideas against before proposing something
  that overlaps.

## Working conventions this project has settled into

- Branch per feature effort, PR/merge to `main` when a chunk of work is
  done and confirmed working (not merged mid-flight).
- `features.md` gets a Shipped entry for every feature-sized change — not
  small tweaks (a renamed label, a one-line bug fix). Roadmap entries get
  removed or rewritten when shipped work supersedes them, not just left
  stale.
- Changes touching the UI get verified with a headless-browser pass
  (Playwright, Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`)
  at both phone width (~390px) and the ≥720px wide layout, against a
  seeded scratch database — not just a syntax check.
- This is a small self-hosted single-household app on purpose — no
  bundler, minimal dependencies, no premature abstraction. Multi-family
  isolation is deliberately shelved (see `features.md`'s design-doc
  section) unless the user explicitly asks to pick it up.
