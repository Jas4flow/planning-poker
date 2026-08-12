# Planning Poker · 4flow — Codebase Documentation

> A story-point estimation tool for refinement sessions. Pull a story from Jira, vote in private,
> reveal together, write the estimate back. HTML + CSS + vanilla JS (ES modules), no build step, no
> framework, no npm dependencies. Supabase (Postgres + Auth + Realtime) is loaded from a CDN.

This document is the complete reference for the codebase. It covers architecture, the module-by-module
reference, the data model, the security/RBAC model, Jira integration, the test suite, and setup.

---

## Table of contents

1. [Project layout](#1-project-layout)
2. [Architecture](#2-architecture)
3. [Running the app](#3-running-the-app)
4. [Routing & screens](#4-routing--screens)
5. [State model](#5-state-model)
6. [The store (reducer + optimistic dispatch)](#6-the-store-reducer--optimistic-dispatch)
7. [The transport seam (Supabase)](#7-the-transport-seam-supabase)
8. [Supabase client & auth](#8-supabase-client--auth)
9. [Jira integration](#9-jira-integration)
10. [Decks & cards](#10-decks--cards)
11. [Statistics](#11-statistics)
12. [Timer, export, utilities](#12-timer-export-utilities)
13. [UI modules](#13-ui-modules)
14. [Styling](#14-styling)
15. [Data model (Postgres schema)](#15-data-model-postgres-schema)
16. [Security & access control](#16-security--access-control)
17. [Tests](#17-tests)
18. [Deployment](#18-deployment)
19. [Module reference index](#19-module-reference-index)

---

## 1. Project layout

```
index.html                          Landing + Room screens, loads styles + js/app.js
tests.html                          Plain-JS assertion harness over the pure logic
serve.mjs                           Static dev server (127.0.0.1:5173)
proxy.mjs                           CORS proxy for Jira (127.0.0.1:8080)
.gitlab-ci.yml                      CI → GitLab Pages
styles/
  tokens.css                        Brand tokens, light + dark themes
  base.css                          Reset, typography, buttons, inputs, modals, toasts, landing
  room.css                          Header, table + seats, deck, results, sidebar, chat, responsive
js/
  config.js                         Supabase URL + publishable key + CDN import helper
  app.js                            Bootstrap: routing, keyboard shortcuts, presence, action table
  store.js                          State shape, pure reduce(), createStore() optimistic dispatcher
  transport.js                      Supabase transport: load/publish/onRemote/onChat
  supabase.js                       Lazy client, auth, rooms, invites, error mapping
  jira.js                           Jira REST client, ADF→HTML, issue-ref parsing
  jira-mock.js                      Offline fake Jira (localStorage-backed)
  decks.js                          Deck definitions + card helpers
  stats.js                          Average, median, mode, agreement, suggestion, outliers
  timer.js                          Remaining-time + ticker helpers
  export.js                        CSV + JSON export of estimates
  util.js                          DOM, formatting, toast, audio chime, download helpers
  ui/
    landing.js                     Landing screen: sign-in, create, join, lists, setup problems
    seats.js                      Stage/seats/felt rendering, results grid
    deck.js                       Deck strip + card buttons + reactions
    chat.js                       Ephemeral chat feed + composer
    side.js                      Story / People / History sidebar panels
    settings.js                   Jira settings modal
    modals.js                     Modal primitive, confirm/prompt dialogs
    story-modals.js               Add-from-Jira, manual story, JQL import, pick estimate, update points
db/
  schema.sql                       Tables, RLS policies, helper fns, triggers, Realtime pub
  confirm-existing-users.sql       SQL to confirm accounts made while "Confirm email" was on
docs/superpowers/specs/
  2026-08-11-planning-poker-design.md   Approved design write-up (note: describes the pre-Supabase
                                       BroadcastChannel plan; the shipped transport is Supabase)
```

There is **no `package.json`** — the only runtime pieces are `serve.mjs`/`proxy.mjs`, which need Node.
Everything else runs directly in the browser as ES modules.

---

## 2. Architecture

```
                ┌─────────────────────────────── browser ───────────────────────────────┐
                │                                                                         │
   index.html ──▶ js/app.js (bootstrap, hash routing, action table, presence, keys)      │
                       │  dispatch(action)                                                │
                       ▼                                                                  │
                js/store.js  ── reduce(state, action)  [pure, unit-tested]                 │
                       │  adopt/seed → publish(state, version)                             │
                       ▼                                                                  │
                js/transport.js (Supabase) ── load / publish / onRemote / onChat           │
                       │  Realtime: postgres_changes (state) + broadcast (chat)            │
                       └──────────────▶  Supabase (Postgres + Realtime) ◀── other clients │
                js/supabase.js (auth, rooms, invites, error mapping)                       │
                js/jira.js / jira-mock.js ── REST or mock, via proxy.mjs for CORS          │
                └──────────────▶  Jira Cloud (optional)                                    │
                └──────────────▶  localStorage (client-only caches: connection override,   │
                                                    jira config, mock issues, theme)       │
                └──────────────▶  js/decks.js, stats.js, timer.js, export.js, util.js      │
                └──────────────▶  js/ui/* (render pure functions driven by render())       │
                                                                                         │
   Postgres tables (RLS-enforced): pp_profiles, pp_rooms, pp_room_members, pp_jira_settings
```

Key architectural ideas:

- **Every state change is `store.dispatch(action)`.** `reduce(state, action)` is pure and tested in
  isolation. The UI never mutates state directly — it renders from state and dispatches actions.
- **The transport is a single swappable seam.** `transport.js` is the only module that knows how
  state travels between clients. The shipped implementation uses Supabase (Postgres + Realtime).
  Swap this one file and the app becomes multi-machine without touching the UI.
- **Single JSONB room document guarded by a `version` column.** Optimistic concurrency: a writer
  sends the version it read; Postgres accepts the write only if the row still carries that version,
  so two people voting at once can never silently overwrite each other. The loser reloads and replays.
- **Access is enforced by Postgres RLS, not by the client.** The browser asks only for rooms it is a
  member of; RLS returns nothing otherwise. Client code is untrusted by construction.
- **Chat is ephemeral.** It rides a Realtime broadcast, is relayed between connected clients, and
  never touches a table. A message exists only in the browsers that were listening when it was sent.

---

## 3. Running the app

```bash
node serve.mjs          # static server → http://127.0.0.1:5173
```

Optional, only for live Jira calls from the browser (browsers block direct Jira CORS):

```bash
JIRA_HOSTS="4flow.atlassian.net" node proxy.mjs   # CORS proxy → http://127.0.0.1:8080
```

Without a proxy you can still use **Mock Jira** (a localStorage-backed fake with sample issues)
toggled from the Jira settings modal.

Database setup (one-time, in the Supabase SQL editor):

1. Run `db/schema.sql`.
2. Authentication → Providers → Email: **enable anonymous sign-ins**.
3. Authentication → Providers → Email: **turn OFF "Confirm email"** (or run
   `db/confirm-existing-users.sql` for accounts already created).
4. Put the project **publishable** (anon) key in `js/config.js` as `SUPABASE_PUBLISHABLE_KEY`.

> **Security:** never put a `sb_secret_…` / service-role key in client code. It bypasses RLS
> completely and would give every visitor full read/write to the database. Rotate it in
> Settings → API if it was ever exposed. The publishable key in `js/config.js` is *intended* to sit
> in the browser.

---

## 4. Routing & screens

Hash-based routing in `js/app.js`:

| Hash | Screen |
| --- | --- |
| `#/` | Landing (sign-in / create / join / room lists) |
| `#/room/<id>` | Room (live estimation) |
| `#/join/<token>` | Join gate (redeem an invite token) |
| `#/reset` | Password reset / set-new-password |

`app.js` parses the hash, sets up a `session` object `{ roomId, meta, transport, store, chat, cleanup }`,
mounts the screen, and starts a `createTicker(500)` for timer countdown, heartbeat, and presence.

`GLOBAL_ACTIONS` (`toggle-theme`, `settings`, `go-home`, `sign-out`, `reload`) are handled regardless of
screen. Host-only actions are enforced against `room.meta.owner_id`.

Keyboard shortcuts (in a room): `1`–`9`/`0` vote, `R` reveal, `N` next story, `Esc` close dialog, `?`
show shortcuts.

---

## 5. State model

A room is one JSONB document (`pp_rooms.state`). Shape (created by `normalizeRoom` / `createRoom` in
`js/store.js`):

```js
{
  v: 1,                       // SCHEMA_VERSION
  id, name, createdAt,
  hostId,                     // current host (may be handed off)
  deckId,                     // e.g. "fibonacci", "tshirt", "custom"
  customCards: [],            // used when deckId === "custom"
  autoReveal: false,
  timerDuration: 60,
  stories: [                  // ordered; each:
    { id, key?, title, body?, source: "manual"|"jira"|"jql"|"mock",
      url?, pointsField?, estimate?, archived: false,
      order, participants: { [participantId]: { vote, reacted } } }
  ],
  activeStoryId,
  voting: false,              // voting open?
  revealed: false,            // votes revealed?
  timer: { running, endsAt, duration } | null,
  members: { [userId]: { id, name, role: "host"|"member"|"spectator",
                         lastSeen, away } },
  reactions: { [userId]: emoji },
}
```

Selectors in `store.js`: `activeStory(room)`, `isAway(room, id, now)`, `hasSelectedStory(room)`,
`activeVoters(room)`, `allVoted(room)`, `castVotes(room)`.

---

## 6. The store (reducer + optimistic dispatch)

`js/store.js` is the heart of the client. It holds:

- **State shape + `normalizeRoom(state)`** — coerces any loaded document into a valid shape and
  stamps `v`. Guards against malformed/legacy data.
- **`createRoom()` / `createStory()`** — constructors.
- **`reduce(state, action)`** — the pure reducer. Every mutation funnels through here. Action types:

  | Group | Actions |
  | --- | --- |
  | Members | `JOIN`, `HEARTBEAT`, `LEAVE`, `KICK`, `SET_NAME`, `SET_ROLE`, `SET_HOST` |
  | Room | `RENAME_ROOM`, `SET_DECK`, `SET_OPTIONS` |
  | Voting | `VOTE`, `TOGGLE_VOTING`, `REVEAL`, `RESET_ROUND` |
  | Stories | `ADD_STORY`, `UPDATE_STORY`, `DELETE_STORY`, `MOVE_STORY`, `SET_ACTIVE_STORY`, `RESTORE_STORY` |
  | Estimate | `SET_ESTIMATE` |
  | Reactions | `REACT` |
  | Timer | `TIMER_START`, `TIMER_PAUSE`, `TIMER_RESET`, `TIMER_END` |

- **`createStore(transport, { onError })`** — the optimistic, conflict-retrying dispatcher.

### `confirmed` vs `state` (important)

The store keeps two documents:

- `confirmed` — the last version acknowledged by the server.
- `state` — `confirmed` with all locally-dispatched (pending) actions replayed on top.

When a remote update arrives, the store takes the *new `confirmed`*, then **replays every pending
action against it** and adopts that as `state`. This means your half-typed vote or in-flight reveal is
never lost when someone else's change lands — it's re-applied on top of the latest truth.

### Conflict retry

`MAX_WRITE_ATTEMPTS = 4`. On a write, the store publishes `state` with the expected version. If
Postgres rejects it (the row changed underneath us), `transport.publish` returns `{ ok: false }`, the
store reloads the latest `confirmed`, replays pending actions, and retries. After the cap it surfaces
`onError`. `settled` resolves once `state === confirmed` (no pending actions).

`createStore` exposes `adopt(room)` (remote state in), `seed(room)` (initial load), `dispatch(action)`,
and `settled()`.

`AWAY_AFTER_MS = 25000` — presence idle threshold; heartbeat keeps you "here".

---

## 7. The transport seam (Supabase)

`js/transport.js` → `createSupabaseTransport(roomId)`:

- `load()` — `select state, version` from `pp_rooms` where `id = roomId` (RLS filters non-members).
- `publish(state, expectedVersion)` — `update … version = (expectedVersion ?? seenVersion) + 1` with
  `.eq("version", expectedVersion)`. On conflict, returns `{ ok: false }` (read the design note in
  §2 — last-writer-wins with replay/retry). Also sets `name`.
- `onRemote(handler)` — subscribes to `postgres_changes` UPDATE on `pp_rooms` filtered by id; ignores
  events at or below `seenVersion`.
- `onChat(handler)` — subscribes to Realtime `broadcast` (`CHAT_EVENT = "chat"`).
- `sendChat(message)` — broadcast to connected clients only; a failed send is swallowed (a lost chat
  line is not lost work — the sender still saw it locally).
- `close()` — unsubscribe + clear handlers.

`ensureChannel()` / `subscribe()` build the channel once and resolve it on any terminal status
(`SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`) so `sendChat` can never hang forever.

---

## 8. Supabase client & auth

`js/supabase.js` (lazy CDN import of `@supabase/supabase-js@2.58.0` via `client()`):

- **`SupabaseError`** + **`describe(error, fallback)`** — maps PostgREST / GoTrue errors to human
  messages (401 auth, 403 permission, 404 not-found, 400 invalid, network, etc.). Used by the UI.
- **Auth:** `currentSession`, `currentUser`, `isGuest`, `onAuthChange`, `signInOrSignUp` (sign in *or*
  create), `signInAsGuest`, `sendPasswordReset`, `verifyRecoveryCode`, `updatePassword`,
  `hasRecoverySession`, `signOut`, `setDisplayName`, `myProfile`.
- **`setupProblems()`** — checks `mailer_autoconfirm`, `disable_signup`, `external.anonymous_users`
  and reports the three mis-configurations that break the happy path (used by the landing screen's
  "setup problems" banner).
- **Rooms:** `myRooms`, `joinedRooms`, `createRoomRow`, `deleteRoom`, `roomMeta`.
- **Invites (token-as-capability):** `previewInvite`, `redeemInvite`, `leaveRoom`, `removeMember`,
  `touchMembership`, `inviteUrl`. Each room row carries a unique `invite_token`; the invite URL is the
  capability — anyone with the link can join, because RLS grants membership to token holders.

`js/config.js` exports `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, the pinned CDN URL, and
`connection()` / `setConnection()` / `clearConnection()` for a localStorage override key `pp:supabase`
(so you can point the app at a different project from the console).

---

## 9. Jira integration

`js/jira.js` (real) + `js/jira-mock.js` (offline) + `proxy.mjs` (CORS proxy).

### Configuration
- `DEFAULT_POINTS_FIELD = "customfield_10033"`.
- Config lives in `pp_jira_settings` (per account, RLS-guarded) and is mirrored to an in-memory
  `cache`. `loadConfig` / `pushConfig` / `saveConfig` / `clearConfig` / `forgetConfig`; `pullConfig`
  migrates a legacy `localStorage` config.
- `normalizeBaseUrl`, `isConfigured`, `configProblem`.
- `authHeader` — Basic (`email:token`) or Bearer (API token as bearer), per Jira Cloud.
- `normalizeProxy` / `proxyProblem` / `buildUrl` / `request()` (fetch wrapper).

### Issue references
- `parseIssueRef`, `parseIssueRefs` (multi), `baseUrlFromIssueUrl`, `issueUrl`.

### API
- `getIssue` — fetch by key, returns `{ key, summary, description, url, points?, pointsField }`.
- `updateStoryPoints` — write estimate back; reads the value back to confirm.
- `searchIssues` — JQL with fallback endpoints.
- `listFields` / `detectPointsField` — discover the story-points custom field.
- `testConnection` — connectivity/credential probe.

### ADF rendering
Jira descriptions are Atlassian Document Format (ADF). `adfToHtml(node)` is a full ADF node renderer
with `safeUrl` sanitization (no `javascript:` etc.); `adfToText(node)` is the plain-text fallback used
for search/CSV. `toStory(issue)` maps an issue to a room story (`source: "jira"`).

### Mock Jira
`js/jira-mock.js` is a localStorage-backed fake with 6 sample CUMA issues. `getIssue` /
`updateStoryPoints` (rejects non-numbers, like real Jira) / `searchIssues` / `listFields` /
`testConnection`. `mockKeys()`, `LATENCY_MS = 320`. Selected via the settings modal's "Mock" toggle.

### CORS proxy
Browsers block direct Jira REST calls. `proxy.mjs` listens on `127.0.0.1:8080`, forwards only to hosts
in `JIRA_HOSTS` (default `4flow.atlassian.net`), and **never logs or stores the token**. The app
points at it when a proxy URL is configured.

---

## 10. Decks & cards

`js/decks.js`:

- `SPECIAL_CARDS = ["?", "☕"]` — excluded from numeric statistics.
- `DECKS` — `fibonacci`, `fibShort`, `powers`, `tshirt`, `sequential`, and `custom`.
- `DECK_LIST` — ordered metadata for the deck picker.
- Helpers: `isSpecialCard`, `isNumericCard`, `cardToNumber` (handles `"½"`/`"1/2"`), `deckCards(room)`,
  `deckLabel(room)`, `parseCustomDeck(text)`.

---

## 11. Statistics

`js/stats.js` → `computeStats(votes, cards)`:

```js
{ total, countedTotal, specials, average, median, min, max,
  modes, consensus, agreement, distribution, suggestion, outliers }
```

- `agreementPercent` — share of counted votes equal to the modal value.
- `suggestEstimate` — the recommended number (mode, or nearest sensible value on ties/disagreement).
- `findOutliers` — votes far from the cluster.
- `validatePointValue(raw, cards)` — `{ ok, value, error, warning }`, used when setting/accepting an
  estimate (warns if the value isn't a card in the current deck).

---

## 12. Timer, export, utilities

- **`js/timer.js`** — `remainingSeconds(room, now)`, `isTimerFinished(room, now)`,
  `createTicker(intervalMs = 500)` → `{ add(fn), stop() }`. The room ticker drives countdowns,
  heartbeats, and away-detection.
- **`js/export.js`** — `toCsv(room)` / `toJson(room)` over `room.stories` with `COLUMNS`,
  `fileStem(room)`, `downloadCsv` / `downloadJson`.
- **`js/util.js`** — `newId`, `escapeHtml`, `initials`, `textToHtml`, `htmlToText`, `$`/`$$`/`setHtml`,
  `clamp`, `round`, `formatClock`, `formatTime`, `readJson`/`writeJson`/`removeKey`, `copyText`,
  `toast(message, kind, timeout)`, `playReveal()` (WebAudio chime on reveal), `download(filename, text, mime)`.

---

## 13. UI modules

All rendering is driven by `app.js`'s `render()` from current `state`; modules export pure-ish render
functions plus the occasional stateful widget.

- **`js/ui/seats.js`** — `renderStage`, `seat`, `felt` (prompts for no-story / paused / voted /
  revealed states), `results` (stats grid + distribution bars + accept row). `REACTION_TTL_MS = 5000`.
- **`js/ui/deck.js`** — `renderDeck(room, ctx)`, `cardButton`, `REACTIONS` list. Handles the locked
  (revealed/inactive) state.
- **`js/ui/chat.js`** — `createChatFeed` (ephemeral; `SHOW_MS = 10000`, `MAX_VISIBLE = 5`,
  `MAX_LENGTH = 140`), `renderChatBar`, `closeEmojiPicker`, `CHAT_EMOJI`. Mounted **once** (not with the
  deck) so half-typed text survives re-renders.
- **`js/ui/side.js`** — `renderStoryPanel`, `renderPeoplePanel`, `renderHistoryPanel`; `storyNow`,
  `storyRow`, `openStories`, `archivedStories`, `estimatedTotal`, `personRow`, `hostControls`
  (deck / auto-reveal / timer / controls).
- **`js/ui/landing.js`** — `mountLanding`, `renderLanding`, `signInCard` (`signInOrSignUp`),
  `createCard`, `renderResetCard`, `renderNewPasswordCard`, `showSetupProblems`, `loadLists`
  (my/joined rooms), lists/section helpers.
- **`js/ui/settings.js`** — `openSettings`: Jira config modal (mock toggle, baseUrl, email, token,
  proxy, pointsField), Detect, Test connection, Clear credentials; `errorText()`.
- **`js/ui/modals.js`** — `openModal` (one at a time, Esc, focus management, busy/message helpers),
  `confirmDialog`, `promptDialog`, `field()`; `isModalOpen` / `closeModal`.
- **`js/ui/story-modals.js`** — `openAddStoryFromJira`, `openManualStory` (edit too),
  `openJqlImport`, `openPickEstimate`, `openUpdatePoints` (validates, writes to Jira, offers local
  save on failure), `offerLocalSave`.

`app.js` wires these to an action table keyed by `data-act` (vote, reveal, reset, react, timer-*, story
ops, estimates, room ops, export). `window.planningPoker` is exposed for debugging.

---

## 14. Styling

Three layers, all tokens from `styles/tokens.css`:

- **`tokens.css`** — 4flow brand tokens (orange `#FE6B00`, teal `#003E52`, neutrals, semantic colors)
  plus light defaults and a `[data-theme="dark"]` block. Every color resolves from a token, so the
  palette retunes in one file. `--sidebar-width`, `--stage-min` drive the resizable layout.
- **`base.css`** — reset, typography, brand mark, buttons, fields, panels/chips/badges, modal,
  toasts, landing.
- **`room.css`** — header, stage, seat, felt, results, deck strip, chat (composer opens upward),
  sidebar (with a drag resizer), join gate, and responsive breakpoints.

Theme switches via the `data-theme` attribute on `<html>` (toggled by the `toggle-theme` action).

---

## 15. Data model (Postgres schema)

From `db/schema.sql`:

- **`pp_profiles`** — `id` (FK auth.users), `display_name`. Auto-created by `pp_handle_new_user`
  trigger on new auth users.
- **`pp_rooms`** — `id`, `owner_id` (FK auth.users, **frozen** by `pp_touch_room`), `name`,
  `invite_token` (unique), `state` (jsonb), `version` (bigint), `created_at`, `updated_at`.
  `pp_touch_room` trigger prevents changing `owner_id`, `id`, or `invite_token` after insert.
- **`pp_room_members`** — `(room_id, user_id)` PK, `role` (`host`/`member`/`spectator` check).
- **`pp_jira_settings`** — per-account Jira config (RLS: own row only).

**Helper functions (SECURITY DEFINER):** `pp_is_member(room, user)`, `pp_is_owner(room, user)`,
`pp_room_preview(token)` (read a room's name/story count without membership), `pp_join_room(token, user)`
(grant membership via token — the join capability).

**RLS policies** exist on all four tables. Membership/ownership helpers are `SECURITY DEFINER` so the
policies can trust them without recursing. Room state is readable/writable only by members; invite
token + `pp_join_room` is the join path.

**Realtime publication** is configured so `pp_rooms` UPDATEs fan out to subscribers.

`db/confirm-existing-users.sql` confirms accounts created while "Confirm email" was on.

---

## 16. Security & access control

- **RLS is the only enforcement.** Client code is untrusted by construction. A non-member querying
  `pp_rooms` gets nothing back; writes fail policy checks. No room-level secret is checked in JS.
- **Publishable key only.** The anon key in `js/config.js` is safe in the browser. A `sb_secret_…`
  service-role key would bypass RLS entirely — never ship it. Rotate via Settings → API if leaked.
- **Invite = capability URL.** `invite_token` is unguessable; `pp_join_room(token, user)` grants
  membership. Sharing the link is sharing access.
- **Auth helper functions are `SECURITY DEFINER`** so policies evaluate membership/ownership reliably
  without infinite recursion and without exposing helper internals to clients.
- **Token hygiene in the proxy.** `proxy.mjs` forwards only to allow-listed hosts and never logs or
  persists the Jira token.
- **Ephemeral chat.** Chat never hits a table — there is nothing to leak later.
- **XSS surface.** Every field that came off the wire (room state, chat, Jira ADF) is escaped or
  sanitized on render: `escapeHtml` for text, `safeUrl` inside `adfToHtml`, `htmlToText` for CSV.

---

## 17. Tests

`tests.html` is a self-contained assertion harness (no framework). It imports the **pure** logic
modules and runs `check(name, condition, why)` grouped by `group(name)`. The heading turns green when
all assertions pass.

Groups / coverage:

- **decks** — card helpers, custom-deck parsing, special-vs-numeric classification.
- **stats** — `computeStats` (average/median/mode/agreement/suggestion/outliers),
  `validatePointValue` warnings.
- **store reducer** — every action type reduces to the expected shape; concurrency replays.
- **Jira parsing** — `parseIssueRef`/`parseIssueRefs`, `adfToHtml`/`adfToText`, `normalizeBaseUrl`,
  `describeFailure` (401/403/404/400 mappings).
- **export** — `toCsv`/`toJson` column and value correctness.

Open `tests.html` in a browser (served by `serve.mjs`) to run them.

---

## 18. Deployment

`.gitlab-ci.yml`: `node:18` image, an `npm install` (only for any future tooling), then a `pages` job
that copies `index.html`, `styles/`, `js/`, and `db/` into `public/` and publishes to GitLab Pages.
Pinned to the `master` branch. There is no bundler step — the static files are shipped as-is.

> For a Supabase-backed deploy, set `js/config.js` to the target project's publishable key and run
> `db/schema.sql` there. The CDN (esm.sh) supplies Supabase client JS; no build artifacts are needed.

---

## 19. Module reference index

| Module | Role |
| --- | --- |
| `index.html` | Screens + script entry |
| `tests.html` | Pure-logic test harness |
| `serve.mjs` | Dev static server |
| `proxy.mjs` | Jira CORS proxy |
| `db/schema.sql` | Tables, RLS, helpers, triggers, Realtime |
| `db/confirm-existing-users.sql` | Confirm pre-"Confirm email" accounts |
| `styles/tokens.css` | Brand tokens + dark theme |
| `styles/base.css` | Base + controls + modals + toasts |
| `styles/room.css` | Room layout + components + responsive |
| `js/config.js` | Supabase URL/key + CDN + connection override |
| `js/app.js` | Bootstrap, routing, actions, presence, keys |
| `js/store.js` | State shape, `reduce`, optimistic `createStore` |
| `js/transport.js` | Supabase load/publish/onRemote/onChat |
| `js/supabase.js` | Client, auth, rooms, invites, errors |
| `js/jira.js` | Jira REST, ADF, refs |
| `js/jira-mock.js` | Offline fake Jira |
| `js/decks.js` | Deck defs + card helpers |
| `js/stats.js` | Stats computations |
| `js/timer.js` | Timer + ticker |
| `js/export.js` | CSV/JSON export |
| `js/util.js` | DOM/format/toast/audio/download |
| `js/ui/landing.js` | Landing screen |
| `js/ui/seats.js` | Stage/seats/felt/results |
| `js/ui/deck.js` | Deck strip + cards + reactions |
| `js/ui/chat.js` | Ephemeral chat |
| `js/ui/side.js` | Story/People/History panels |
| `js/ui/settings.js` | Jira settings modal |
| `js/ui/modals.js` | Modal primitive + dialogs |
| `js/ui/story-modals.js` | Story/Jira/estimate modals |

---

*Generated from a full read of the source tree. The design spec at
`docs/superpowers/specs/2026-08-11-planning-poker-design.md` describes an earlier BroadcastChannel
transport; the shipped code uses Supabase — this document reflects the shipped code.*
