# Teaching guide

Back of Fridge asks a lot of a new user at launch, and today most of it is
learned by poking at the interface. This guide is where we show how things
work: short written steps, annotated screenshots, and a short video on a
**fake** household for anything that is easier to watch than to read.

It is a living document. Every new feature, and every change to an old one,
gets a guide entry (or an update to its entry) as part of shipping it.

> Status: **draft**. Not yet linked from `features.md`; that link is added
> once `main` is clean (see "Rollout" at the bottom).

## Principles

- **Show the real thing.** Screenshots come from the actual app, at phone
  width (390px), because that's where most use happens.
- **Fake data only.** All images and videos use the demo household (below).
  Never real item names, usernames, invite codes, or barcodes of real
  purchases.
- **Small and replaceable.** A clip is under ~45 seconds, one task each, no
  audio needed. When the UI changes, re-record that one clip.
- **Written steps stand alone.** Someone who can't play the video (or is on
  the Supernote's limited browser) should still be able to follow the text.

## Layout

```
docs/teaching/
  README.md              this file: conventions + topic index
  topics/<topic>.md      one page per topic, from TEMPLATE.md
  media/<topic>/         that topic's images and videos
    01-open-menu.png
    02-choose-consume.png
    consume-partial.mp4
```

Topic pages link to media with relative paths, so they render on GitHub and
can later be served from the app unchanged.

## Media conventions

| | Images | Video |
|---|---|---|
| Format | PNG | MP4 (H.264), no audio required |
| Size | 390px wide viewport, captured at 2x | Same viewport, 390px wide |
| Length | n/a | 45s or less, one task |
| Naming | `NN-short-action.png`, numbered in step order | `task-name.mp4` |
| Annotation | Red outline or arrow on the control being described; keep the rest untouched | A visible tap indicator instead of narration |

**Capturing** reuses the Playwright setup already used for UI testing
(handoff 04): run the real server against a scratch database, seed the demo
household, drive the app at 390px, and take screenshots or use Playwright's
video recording. Because it is scripted, a re-record after a UI change is a
re-run, not a redo by hand.

**Demo household.** One seed script (to be written, e.g.
`server/scripts/seed-demo.js`) builds a repeatable fake household: a few
locations (Fridge, Chest freezer, Pantry), about 15 items at varied
expiration states (fresh, expiring soon, expired, low stock), a fill-level
item, two members, and a couple of products with barcodes. Every screenshot
and video starts from this same state so they look consistent.

**Repo weight.** Screenshots are fine in git. Videos add up. Keep each clip
small (compress, 390px wide), and if the media folder passes roughly 50 MB,
move videos to Git LFS or external hosting and leave links in the topic
pages. This is an open decision; see below.

## Topic page template

Each topic page uses `topics/TEMPLATE.md`: what it's for, where to find it,
numbered steps with an image each, a video link, things that commonly go
wrong, and a "last verified against" note so stale entries are easy to spot.

## Topic index

Priority topics are the features most likely to be missed because nothing in
the interface announces them.

| Topic | Why it gets lost | Media planned | Status |
|---|---|---|---|
| **Scanning** (photo, typed or wedge-scanner barcode; "Bought before"; Save & scan next) | Entry point is one button; the card, link-to-earlier-items, and Open Food Facts fill-in are invisible until you try them | Images: scan button, result card, "Bought before" card. Video: scan an item, fix a wrong match, save and scan next | Not written. Feature is shipped. |
| **Shopping lists** | Not a shipped feature yet; write the entry alongside the feature, not after | TBD with the feature | Placeholder. Waiting on the feature. |
| **The ⋯ menu** (Consumed, Throw out, Undo, Edit, Track by count/fill level, Buy again, Delete) | Every secondary action is hidden behind one icon on each row | Images: the icon on a row, the open menu. Video: partial consume, undo it, edit a quantity | Not written. Feature is shipped. |

Add rows as features ship. Suggested next candidates: Edit dates, locations
and tags management, At a Glance view, household invites, low-stock
thresholds and the fill-level slider.

## Definition of done for a feature

A feature or UI change isn't finished until:

1. Its topic page exists or is updated, including a "last verified" note.
2. Any screenshot or clip it changes is re-captured from the demo household.
3. `features.md` has its Shipped entry (existing convention).

## Rollout

Other branches don't have this guide yet.

1. This draft goes into `main` first. It only adds new files under
   `docs/teaching/`, so merging `main` into an existing feature branch
   shouldn't conflict, and the first merge of any branch back to `main` brings
   nothing new for the guide.
2. Each feature branch adds its own topic page and media under
   `docs/teaching/topics/` and `docs/teaching/media/<topic>/`. Different
   topics touch different files, so branches don't collide. Only the index
   table above is shared; edit it with a one-row change.
3. Once `main` is clean, add a single link to `docs/teaching/README.md` from
   `features.md`, and from the top-level README.

## Open decisions

- **Where does the guide live for users?** Start as markdown in the repo.
  Later it could be served from the app (a Help page or "?" links on the
  ⋯ menu and scan button) using the same files.
- **Videos in git, LFS, or hosted?** Decide before the first video lands.
- **Who records?** Proposal: scripted capture from the demo household, so
  either of us can regenerate everything after a UI change.
