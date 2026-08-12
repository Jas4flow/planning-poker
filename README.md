# Planning Poker · 4flow

Story point estimation for refinement sessions. Pull stories out of Jira, let everyone pick a card in
private, reveal them all at once, and write the agreed estimate back to the issue in one click.

HTML, CSS and JavaScript in the browser; Supabase (Postgres + Auth + Realtime) for storage and
sharing. No build step and no npm install — `supabase-js` is loaded from a CDN at runtime.

## Run it

ES modules need to be served over HTTP (opening `index.html` from disk will not work):

```bash
node serve.mjs
```

Then open <http://localhost:5173/>. Logic tests live at <http://localhost:5173/tests.html> — the
heading turns green when all pass.

Use this rather than `python -m http.server`. That one answers 304 Not Modified from file
timestamps, and while you are editing it will happily serve a fresh `index.html` beside cached old
modules — a page that looks correct and whose buttons are wired to nothing. `serve.mjs` sends
`no-store` on every response, so a reload is always a real reload.

## Set up the database — do this once

1. Open your project at <https://supabase.com/dashboard> → **SQL Editor** → **New query**.
2. Paste the whole of [`db/schema.sql`](db/schema.sql) and press **Run**. It is idempotent, so
   running it again later is safe.
3. Go to **Authentication → Sign In / Providers** and switch on **Anonymous sign-ins**. Guests who
   open an invite link need it; without it they cannot join.
4. Go to **Authentication → Sign In / Providers → Email** and switch **off** "Confirm email".
   Hosts sign in the moment they submit the form; leaving confirmation on would send them to their
   inbox instead. Leave **Allow new users to sign up** on.

   The setting is not retroactive. Any account created while it was on stays unconfirmed and cannot
   sign in — run [`db/confirm-existing-users.sql`](db/confirm-existing-users.sql) once to clear
   those, or delete the user under **Authentication → Users** and sign up again.

The landing screen checks all of this on load and names whatever is still wrong, so you do not have
to remember this list.

Everything the app creates is prefixed `pp_` — `pp_rooms`, `pp_room_members`, `pp_profiles` — because
this project already contains a `public.profiles` table belonging to another application. That table
is not touched.

### Keys

`js/config.js` holds the project URL and the **publishable** key. That key is designed to sit in
client code: it identifies the project and grants nothing on its own, because every rule is enforced
by row level security in Postgres.

> **Never put a `sb_secret_…` / service-role key in this app.** It bypasses row level security
> completely, which would give every visitor full read and write access to the whole database. If one
> has ever been pasted into client code or a chat, rotate it in **Settings → API**.

## Who can see what

| | |
| --- | --- |
| **You** | The sessions you created. Nobody else's, ever. |
| **People you invite** | Only the sessions whose invite link they opened, and only while they are members. |
| **Everyone else** | Nothing. A request for a session you were not invited to returns no rows. |

The invite link (`#/join/<token>`) carries a secret token. Holding the token is the permission:
opening the link signs the visitor in as a guest, adds them to that one session, and nothing else.
Membership rows can only be written by the `pp_join_room()` function, which demands the token — a
client cannot forge its way into a session by calling the API differently. The host can remove
someone, which revokes their access immediately.

Hosting needs an account — name, email, password, one form. An unknown email creates the account and
signs you straight in; a known one signs you in. No confirmation mail either way.

The password is not decoration. Supabase cannot sign anyone in from an email address alone, and if it
could, anybody who typed your address would inherit your sessions and your backlog. The password is
what makes "your data is yours" true rather than decorative.

Voting needs nothing at all — invite link, name, done.

### Forgotten passwords

**Forgot your password?** on the sign-in card emails a six-digit code. Type the code and the new
password, and you are signed in. The same email also contains a link, which opens the app straight on
a "choose a new password" screen — either route works.

For the code to be visible, the email template has to print it. Go to **Authentication → Emails →
Reset Password** and make sure the body contains `{{ .Token }}`, for example:

```html
<h2>Reset your password</h2>
<p>Your code is <strong>{{ .Token }}</strong> — it is valid for one hour.</p>
<p>Or <a href="{{ .ConfirmationURL }}">click here</a> to choose a new password.</p>
```

The stock template only has `{{ .ConfirmationURL }}`, so without this edit the link works and the
code never appears. Note also that Supabase's built-in mail service allows only a handful of messages
per hour on the free tier; wire up an SMTP provider under **Project Settings → Authentication → SMTP**
before a real session.

## Connect Jira

Open **Jira settings** and fill in:

| Field | What to put there |
| --- | --- |
| Jira base URL | `https://your-company.atlassian.net` — the site only, no path |
| Email | Your Atlassian account email. Leave empty on Jira Server/Data Center to send the token as a bearer token |
| API token | Create one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Story point field id | `customfield_10033` on 4flow's Jira — that is the "Story Points" field with the real values. `customfield_10016` ("Story point estimate") also exists there but is unused, so writing to it silently changes nothing. Press **Detect** on any other instance |
| Proxy URL | `http://localhost:8080/` — see below |

Press **Test connection** before you start a session.

### The proxy — needed for real Jira Cloud

Start it from this folder in its own terminal and leave it running:

```bash
node proxy.mjs
```

It listens on `127.0.0.1:8080` and forwards only to `4flow.atlassian.net` (change with
`JIRA_HOSTS=other-site.atlassian.net node proxy.mjs`), so it is not an open relay. Your Jira token
passes straight through and is never logged or stored.

### Why a proxy is needed at all

Jira Cloud does not allow authenticated cross-origin requests from a browser, so the page cannot call
`your-company.atlassian.net` directly. Three ways round it:

Jira Cloud sends no `Access-Control-Allow-Origin` header for authenticated `/rest/api/3` calls, so
the browser throws the request away before Jira ever sees it — that is the "Failed to fetch" error.
Nothing in the page can change that; the call has to leave from somewhere that is not a browser.
Three ways:

1. **`node proxy.mjs`** — above. Simplest, works today.
2. **A gateway your company already runs** in front of Jira with your origin allowed.
3. **Mock mode** — tick it in Settings. A built-in fake Jira with six sample `CUMA-*` issues serves
   every flow offline, writing story points included. For demos, not for real estimates.

Jira settings are stored per account in `pp_jira_settings`, so the same connection works from any
browser you sign in on. Row level security limits every account to its own row — verified by signing
in as a second account and querying the table directly, which returns nothing. **Clear credentials**
deletes the row.

The token is readable by anyone with database-owner access to the project (you, and anyone holding
the service-role key), as any stored credential is. Use a Jira API token scoped to the account you
are happy to estimate with, and revoke it at
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) if that changes.

## Using it

1. **Sign in** — name, email, password. New email creates the account and signs you in. Then
   **create a session** — name, deck.
2. **Add stories** — *Add from Jira* takes one issue key, or several separated by commas:
   `CUMA-130, CUMA-131`. URLs work too, and mixed lists. Each summary becomes a heading and each
   description is shown to everyone, with lists, code blocks and links preserved. *Import by JQL*
   pulls in a whole sprint or filter.
3. **Invite the team** — press **Invite** and send the link. They pick a name, choose voter or
   spectator, and are in. No account, no setup.
4. **Vote** — click a card or press its number. Nobody sees anything but "voted" until the reveal.
5. **Reveal** — the host presses *Reveal cards*, or the room reveals itself once everyone has voted.
   You get the distribution, average, median, most-picked card, range and an agreement percentage,
   with lone far-out votes flagged for discussion.
6. **Update story point** — asks for the value, prefilled with what the round suggests, validates it
   against the deck, writes it to your story point field, reads the issue back, and shows what Jira
   actually stored. **The story then leaves the backlog and lives in the History tab**, so the
   planning list only ever holds what is still to estimate. A story can be put back with ↩ in
   History.

### Everything else in the box

Spectator mode · host controls (reveal, reset, rename, change deck, remove someone, transfer host) ·
round timer with optional reveal-on-timeout · emoji reactions · reveal sound · dark mode · backlog
with reordering · per-story round history · totals · CSV and JSON export · away detection · custom
decks.

**Keyboard:** `1`–`9`, `0` pick a card · `R` reveal or start the next round · `N` next story ·
`Esc` close a dialog · `?` show this list.

## Layout

```
index.html            Landing → Invite → Room, hash routing (#/room/<id>, #/join/<token>)
tests.html            111 assertions over the pure logic
db/schema.sql         tables, row level security, invite functions, realtime
styles/tokens.css     4flow brand tokens (orange #FE6B00, teal #003E52), light + dark
styles/base.css       typography, buttons, inputs, modals, toasts
styles/room.css       table + seats, card deck, results, sidebar
js/config.js          Supabase URL + publishable key
js/supabase.js        auth, sessions, membership, invites
js/transport.js       the seam: reads and writes room state, listens on Realtime
js/store.js           state shape, pure reducer, optimistic store with conflict retry
js/app.js             bootstrap, routing, the action table, shortcuts, presence
js/jira.js            REST client, ADF → HTML, issue-ref parsing, error mapping
js/jira-mock.js       offline fake Jira
js/decks.js  js/stats.js  js/timer.js  js/export.js  js/util.js
js/ui/*.js            seats, deck, sidebar, landing, modals, settings, story modals
```

Room state is one JSONB document guarded by a `version` column. Writers send the version they read,
so two people voting at the same instant cannot silently overwrite each other — the loser reloads and
replays. The UI applies your own actions immediately and saves in the background, so no click waits
on the network.

## Notes and limits

- Guest accounts live in one browser. Clearing site data means rejoining from the invite link.
- T-shirt decks have no average — the app reports the most-picked size and warns that Jira's numeric
  story point field rejects text.
- `?` and `☕` count as cast votes but never enter the numeric statistics.
- Deleting a session removes it for everyone. Jira is never touched by anything in the app except the
  explicit **Update story point** action.
