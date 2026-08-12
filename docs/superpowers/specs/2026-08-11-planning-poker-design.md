# Planning Poker (4flow) — Design

**Date:** 2026-08-11
**Status:** Approved

## Purpose

A story-point estimation tool in the spirit of planningpokeronline.com, built with HTML, CSS and
JavaScript only (no build step, no framework, no npm dependencies), styled with 4flow's brand.
A story is pulled from Jira by key or URL — its summary becomes the heading and its description the
body — the team votes, and a single **Update story point** action writes the agreed estimate back to
the Jira issue.

## Brand tokens (measured from 4flow.com)

| Token | Value | Use |
| --- | --- | --- |
| `--brand-orange` | `#FE6B00` | primary action, active card, accents |
| `--brand-teal-900` | `#003E52` | headers, table felt, dark surfaces |
| `--brand-teal-700` | `#0D485B` | secondary dark surface |
| `--ink` | `#000000` | body text |
| `--surface` | `#FFFFFF` | cards, panels |
| `--surface-muted` | `#F9F9F9` | page background |
| type | `"Avenir Next LT Pro", "Avenir Next", "Segoe UI", Helvetica, Arial, sans-serif` | all text |

A dark theme is derived from the same tokens; every colour used in CSS comes from a token so the
palette can be retuned in one file.

## Architecture

```
index.html            Landing → Join → Room, hash routing (#/room/<id>)
tests.html            plain-JS assertions over the pure logic
styles/tokens.css     brand tokens, light + dark
styles/base.css       typography, buttons, inputs, modals, toasts
styles/room.css       table + seats, card deck, results, story panel
js/app.js             bootstrap, routing, keyboard shortcuts, presence
js/store.js           state shape, pure reducer, dispatch, subscribe
js/transport.js       BroadcastChannel + localStorage (the swappable seam)
js/jira.js            Jira REST client, ADF→text, issue-ref parsing
js/jira-mock.js       offline fake Jira
js/decks.js           deck definitions
js/stats.js           average, median, mode, agreement, suggestion
js/timer.js  js/export.js  js/util.js
js/ui/landing.js  seats.js  deck.js  results.js  stories.js  modals.js  settings.js
```

**The seam.** Every state change is `store.dispatch(action)`; `reduce(state, action)` is pure and
unit-tested. `transport.js` is the only module that knows how state travels between clients. Today:
`BroadcastChannel` for instant fan-out plus `localStorage` for persistence and late joiners, with the
`storage` event as a fallback. Dispatch reads the latest persisted state before reducing, so
concurrent tabs converge last-write-wins without a merge algorithm. Replacing this one file with a
WebSocket or Firebase client makes the app multi-machine without touching the UI.

## State shape

```js
{
  v: 1, id, name, createdAt, hostId, deckId, customCards: [],
  autoReveal: false, timerDuration: 60,
  participants: { [id]: { id, name, role: 'voter'|'spectator', joinedAt, lastSeen, reaction } },
  stories: [ { id, key, url, title, description, status, finalEstimate, jiraPoints, rounds: [] } ],
  activeStoryId, votes: { [participantId]: card }, revealed: false, round: 1,
  timer: { running, endsAt, remaining }
}
```

Identity lives at `pp:me`, Jira config at `pp:jira`, room state at `pp:room:<id>`, recent rooms at
`pp:rooms`. Every persisted record carries a schema version and is ignored if the version is unknown.

## Features

- **Rooms** — create with name, deck and your display name; shareable `#/room/<id>` link; join as
  voter or spectator; host may reveal, reset, rename the room, change the deck, kick, and transfer
  host. Host passes to the next participant automatically if the host leaves.
- **Voting** — pick a card by click or number key; votes hidden until reveal (seats show only
  "voted"); change your vote freely before reveal; reveal by host or automatically when all active
  voters have voted; re-vote resets the round and archives the previous one.
- **Decks** — Fibonacci, short Fibonacci, powers of 2, T-shirt, sequential 0–10, custom; all with
  `?` and `☕`, which never count towards numeric statistics.
- **Results** — distribution bars with voter names, average, median, mode, min/max, agreement
  percentage, consensus badge, and a suggested estimate snapped to the nearest deck card.
  Spectators and away participants are excluded from the maths and from the all-voted check.
- **Timer** — per-round countdown, start/pause/reset, duration configurable by the host.
- **Stories** — panel listing stories with add, delete, reorder, set active, and final estimate;
  per-story round history; totals; CSV and JSON export.
- **Jira** — add a story by key (`CUMA-123`) or by pasting an issue URL; fetch summary and
  description (ADF rendered to readable text, lists and code preserved); optional JQL import of a
  sprint or backlog; **Update story point** opens a modal prefilled with the consensus or average,
  validates the value, `PUT`s it to the configured story-point field, then re-reads the issue and
  shows the value Jira echoed back.
- **Settings** — Jira base URL, email, API token (or bearer token for Jira Server), story-point
  field ID (default `customfield_10016`) with a detect helper that scans `/rest/api/3/field`,
  optional proxy URL supporting a `{url}` placeholder, Test connection, Mock mode, Clear
  credentials.
- **Polish** — dark mode, emoji reactions, reveal sound (mutable), copyable invite link, recent
  rooms on the landing screen, keyboard shortcuts (`1`–`9`/`0` pick, `R` reveal, `N` next story,
  `Esc` close), aria labels and visible focus throughout.

## Data flow

`click → store.dispatch(action) → reduce → transport.publish → other tabs adopt state → subscribers
re-render`. Jira calls live only in `js/jira.js`, are triggered only by explicit user action, and
write their results into room state as plain data — so voters read the story without holding Jira
credentials themselves.

## Error handling

`jira.js` maps failures to actionable messages: network/CORS ("the browser blocked the request — set
a proxy URL in Settings or switch on Mock mode"), 401 (email or token wrong), 403 (no permission on
this issue), 404 (issue key not found), 400/422 on update (surfaces Jira's own field error, e.g. the
field is not a number field). Failures appear as a toast plus inline text in the originating modal;
nothing fails silently. Malformed persisted state is discarded rather than crashing the room.

## Testing

`tests.html` asserts the pure logic: statistics with specials and spectators mixed in, deck
resolution, agreement bounds, issue-key and URL parsing, ADF→text conversion, point validation, and
store reducer transitions (vote, reveal, reset, kick, host transfer). Mock mode covers the
click-through path: connect → fetch story → vote in three tabs → reveal → update points.

## Accepted constraints

- Sync is same-browser (tabs and windows) because the app has no backend; the transport seam exists
  so a server can be added later.
- The Jira API token is kept in `localStorage`, which is acceptable for a locally run tool. The
  Settings panel says so and offers Clear credentials.
- ES modules require the page to be served over HTTP; the README gives a one-line command.
