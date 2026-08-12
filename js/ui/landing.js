/**
 * Landing screen: sign in, create a session, reopen one you own or were
 * invited to. What appears here is whatever Supabase is willing to return —
 * row level security decides, not this file.
 */

import { $, escapeHtml, setHtml, toast } from "../util.js";
import { DECK_LIST } from "../decks.js";
import * as db from "../supabase.js";

let handlers = { onCreate: () => {}, onOpen: () => {} };
let cache = { owned: [], invited: [], loading: false };

export function mountLanding(next) {
  handlers = { ...handlers, ...next };
}

/**
 * @param {{user: object|null, profile: object|null}} auth
 */
export async function renderLanding(auth) {
  const card = $("#landing-card");
  const status = $("#auth-status");
  if (!card) return;

  const guest = !auth.user || db.isGuest(auth.user);
  const name = auth.profile?.display_name || auth.user?.user_metadata?.display_name || "";

  // Jira credentials belong to a signed-in host, not to a visitor on the
  // sign-in screen. Guests reach Jira stories through a session they joined.
  const jiraButton = $("#landing-jira");
  if (jiraButton) jiraButton.hidden = guest;

  setHtml(
    status,
    auth.user
      ? `<span class="chip">${escapeHtml(guest ? `${name || "Guest"} · guest` : auth.user.email)}</span>
         <button class="btn btn--sm btn--ghost" type="button" data-act="sign-out">Sign out</button>`
      : ""
  );

  if (guest) {
    setHtml(card, signInCard(name, auth.user));
    wireSignIn(card);
    void showSetupProblems(card);
    if (auth.user) void loadLists(auth, card);
    return;
  }

  setHtml(card, createCard(name));
  wireCreate(card);
  void loadLists(auth, card);
}

function signInCard(name, guestUser) {
  return `
    <h2 style="font-size: var(--fs-lg)">Sign in to host</h2>
    <p class="hint" style="margin-top: var(--sp-2)">
      New email? The account is created and you are straight in — no confirmation mail. Joining
      somebody else's session needs none of this: just open their invite link.
    </p>
    <form class="stack" id="signin-form" style="margin-top: var(--sp-4)">
      <div class="field">
        <label for="signin-name">Your name</label>
        <input class="input" id="signin-name" maxlength="40" placeholder="Alex"
               autocomplete="name" value="${escapeHtml(name)}" />
      </div>
      <div class="field">
        <label for="signin-email">Email</label>
        <input class="input" id="signin-email" type="email" required
               autocomplete="username" placeholder="you@company.com" />
      </div>
      <div class="field">
        <label for="signin-password">Password</label>
        <input class="input" id="signin-password" type="password" required minlength="6"
               autocomplete="current-password" placeholder="At least 6 characters" />
        <span class="hint">
          Keeps your sessions yours — without it, anyone typing your address would see your backlog.
        </span>
      </div>
      <button class="btn btn--primary btn--lg btn--block" type="submit">Sign in or create account</button>
      <button class="btn btn--ghost btn--block" type="button" id="forgot-password">Forgot your password?</button>
    </form>
    <div id="signin-message"></div>
    ${
      guestUser
        ? `<p class="note" style="margin-top: var(--sp-4)">
             You are signed in as a guest. Guest accounts vote in sessions they were invited to, but
             cannot host their own.
           </p>`
        : ""
    }
    <div id="landing-lists" style="margin-top: var(--sp-5)"></div>`;
}

function createCard(name) {
  return `
    <h2 style="font-size: var(--fs-lg)">Start a session</h2>
    <p class="hint" style="margin-top: var(--sp-2)">
      Hosting as <strong>${escapeHtml(name || "you")}</strong> — change it from the People tab once you are in.
    </p>
    <form class="stack" id="create-form" style="margin-top: var(--sp-4)">
      <div class="field">
        <label for="create-room">Session name</label>
        <input class="input" id="create-room" maxlength="80" placeholder="CUMA refinement" />
      </div>
      <div class="field">
        <label for="create-deck">Deck</label>
        <select class="select" id="create-deck">
          ${DECK_LIST.filter((deck) => deck.id !== "custom")
            .map((deck) => `<option value="${deck.id}">${escapeHtml(deck.label)}</option>`)
            .join("")}
        </select>
      </div>
      <button class="btn btn--primary btn--lg btn--block" type="submit">Create the session</button>
    </form>
    <div id="landing-lists" style="margin-top: var(--sp-5)"></div>`;
}

function wireSignIn(card) {
  const form = card.querySelector("#signin-form");
  if (!form) return;
  const message = card.querySelector("#signin-message");

  card.querySelector("#forgot-password")?.addEventListener("click", () => {
    renderResetCard(card.querySelector("#signin-email").value.trim());
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = card.querySelector("#signin-email").value.trim();
    const password = card.querySelector("#signin-password").value;
    const name = card.querySelector("#signin-name").value.trim();
    if (!email || !password) return;

    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Signing in…";
    setHtml(message, "");

    try {
      const { created } = await db.signInOrSignUp(email, password, name);
      toast(created ? `Account created for ${email}. You are in.` : `Signed in as ${email}.`, "ok");
      // onAuthChange in app.js re-renders the landing screen from here.
    } catch (error) {
      setHtml(message, `<p class="note note--danger" style="margin-top: var(--sp-4)">${escapeHtml(error.message)}</p>`);
      button.disabled = false;
      button.textContent = "Sign in or create account";
      card.querySelector("#signin-password").focus();
    }
  });
}

function wireCreate(card) {
  const form = card.querySelector("#create-form");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Creating…";
    // Nothing here should ever hang, but a wedged promise used to leave the
    // button looking clickable and doing nothing, which reads as "broken app".
    const guard = setTimeout(() => {
      button.disabled = false;
      button.textContent = "Create the session";
      toast("Creating the session is taking too long. Reload and try again.", "error");
    }, 15000);

    Promise.resolve(
      handlers.onCreate({
        roomName: card.querySelector("#create-room").value.trim(),
        deckId: card.querySelector("#create-deck").value,
      })
    ).finally(() => {
      clearTimeout(guard);
      button.disabled = false;
      button.textContent = "Create the session";
    });
  });
}

/* ---------------------------------------------------- password reset ------ */

/**
 * Two steps in one card: ask for the address, then take the code from the email
 * together with the new password. The link in the same email is handled by
 * app.js instead, which lands on #/reset with a session already open.
 */
export function renderResetCard(prefillEmail = "") {
  const card = $("#landing-card");
  if (!card) return;

  setHtml(
    card,
    `<h2 style="font-size: var(--fs-lg)">Reset your password</h2>
     <p class="hint" style="margin-top: var(--sp-2)">
       We email you a six-digit code. Type it below with the new password — or click the link in the
       same email, which brings you back here ready to set one.
     </p>
     <form class="stack" id="reset-form" style="margin-top: var(--sp-4)">
       <div class="field">
         <label for="reset-email">Email</label>
         <input class="input" id="reset-email" type="email" required autocomplete="username"
                value="${escapeHtml(prefillEmail)}" placeholder="you@company.com" autofocus />
       </div>
       <button class="btn btn--primary btn--lg btn--block" type="submit" id="reset-send">Email me a code</button>
     </form>

     <form class="stack" id="code-form" style="margin-top: var(--sp-4)" hidden>
       <div class="field">
         <label for="reset-code">Code from the email</label>
         <input class="input" id="reset-code" inputmode="numeric" autocomplete="one-time-code"
                maxlength="10" placeholder="123456" />
         <span class="hint">Valid for one hour.</span>
       </div>
       <div class="field">
         <label for="reset-password">New password</label>
         <input class="input" id="reset-password" type="password" minlength="6"
                autocomplete="new-password" placeholder="At least 6 characters" />
       </div>
       <button class="btn btn--primary btn--lg btn--block" type="submit">Set the new password</button>
     </form>

     <div id="reset-message"></div>
     <button class="btn btn--ghost btn--block" type="button" id="reset-back" style="margin-top: var(--sp-3)">
       Back to sign in
     </button>`
  );

  const message = card.querySelector("#reset-message");
  const codeForm = card.querySelector("#code-form");
  const say = (text, kind) =>
    setHtml(message, `<p class="note note--${kind}" style="margin-top: var(--sp-4)">${escapeHtml(text)}</p>`);

  card.querySelector("#reset-back").addEventListener("click", () => handlers.onBackToSignIn?.());

  card.querySelector("#reset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = card.querySelector("#reset-email").value.trim();
    const button = card.querySelector("#reset-send");
    button.disabled = true;
    button.textContent = "Sending…";
    setHtml(message, "");
    try {
      await db.sendPasswordReset(email);
      codeForm.hidden = false;
      card.querySelector("#reset-code").focus();
      setHtml(
        message,
        `<p class="note note--ok" style="margin-top: var(--sp-4)">Code sent to ${escapeHtml(
          email
        )}. It may take a minute to arrive.</p>
         <details class="hint" style="margin-top: var(--sp-2)">
           <summary style="cursor:pointer">Email has a link but no code?</summary>
           <p style="margin-top: var(--sp-2)">
             Supabase always creates both, but only prints what the template asks for, and the stock
             template has the link only. In Supabase → Authentication → Emails → Reset Password, add
             <code>{{ .Token }}</code> to the body:
           </p>
           <pre style="white-space:pre-wrap">&lt;p&gt;Your code: &lt;strong&gt;{{ .Token }}&lt;/strong&gt;&lt;/p&gt;</pre>
           <p>The link in the email works either way — it opens this app ready to set a new password.</p>
         </details>`
      );
      button.textContent = "Send another code";
    } catch (error) {
      say(error.message, "danger");
    } finally {
      button.disabled = false;
      if (codeForm.hidden) button.textContent = "Email me a code";
    }
  });

  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = card.querySelector("#reset-email").value.trim();
    const code = card.querySelector("#reset-code").value;
    const password = card.querySelector("#reset-password").value;
    const button = codeForm.querySelector("button");
    button.disabled = true;
    button.textContent = "Saving…";
    setHtml(message, "");
    try {
      await db.verifyRecoveryCode(email, code);
      await db.updatePassword(password);
      toast("Password changed. You are signed in.", "ok");
      handlers.onPasswordChanged?.();
    } catch (error) {
      say(error.message, "danger");
      button.disabled = false;
      button.textContent = "Set the new password";
    }
  });
}

/** The other half of the reset: arrived by clicking the link, session already open. */
export function renderNewPasswordCard() {
  const card = $("#landing-card");
  if (!card) return;

  setHtml(
    card,
    `<h2 style="font-size: var(--fs-lg)">Choose a new password</h2>
     <p class="hint" style="margin-top: var(--sp-2)">The reset link opened a session — set the password and you are in.</p>
     <form class="stack" id="new-password-form" style="margin-top: var(--sp-4)">
       <div class="field">
         <label for="new-password">New password</label>
         <input class="input" id="new-password" type="password" minlength="6" required autofocus
                autocomplete="new-password" placeholder="At least 6 characters" />
       </div>
       <button class="btn btn--primary btn--lg btn--block" type="submit">Save password</button>
     </form>
     <div id="reset-message"></div>`
  );

  card.querySelector("#new-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = card.querySelector("#new-password-form button");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await db.updatePassword(card.querySelector("#new-password").value);
      toast("Password changed. You are signed in.", "ok");
      handlers.onPasswordChanged?.();
    } catch (error) {
      setHtml(
        card.querySelector("#reset-message"),
        `<p class="note note--danger" style="margin-top: var(--sp-4)">${escapeHtml(error.message)}</p>`
      );
      button.disabled = false;
      button.textContent = "Save password";
    }
  });
}

/** Name the dashboard switches that are wrong, before anyone hits them. */
async function showSetupProblems(card) {
  const problems = await db.setupProblems();
  const host = card.querySelector("#signin-message");
  if (!host || !problems.length) return;
  setHtml(
    host,
    `<div class="note note--warn" style="margin-top: var(--sp-4)">
       <strong>Supabase needs ${problems.length === 1 ? "one setting" : `${problems.length} settings`} changed first</strong>
       <ul style="margin: var(--sp-2) 0 0; padding-left: 1.1em">
         ${problems.map((p) => `<li>${escapeHtml(p.title)} — ${escapeHtml(p.fix)}</li>`).join("")}
       </ul>
     </div>`
  );
}

async function loadLists(auth, card) {
  const host = card.querySelector("#landing-lists");
  if (!host) return;
  setHtml(host, `<p class="hint">Loading your sessions…</p>`);
  try {
    const [owned, invited] = await Promise.all([db.myRooms(), db.joinedRooms()]);
    cache = { owned, invited, loading: false };
    setHtml(host, lists(owned, invited));
    host.querySelectorAll("[data-open]").forEach((button) =>
      button.addEventListener("click", () => handlers.onOpen(button.dataset.open))
    );
    host.querySelectorAll("[data-delete]").forEach((button) =>
      button.addEventListener("click", () => handlers.onDelete?.(button.dataset.delete))
    );
  } catch (error) {
    setHtml(host, `<p class="note note--danger">${escapeHtml(error.message)}</p>`);
  }
}

function lists(owned, invited) {
  return `
    ${section("Your sessions", owned, true)}
    ${section("You were invited to", invited, false)}
    ${
      !owned.length && !invited.length
        ? `<p class="hint">Nothing yet. Create a session, or open an invite link somebody sent you.</p>`
        : ""
    }`;
}

function section(title, rooms, owned) {
  if (!rooms.length) return "";
  return `
    <div class="side__section-title" style="margin-top: var(--sp-4)">${escapeHtml(title)}</div>
    <div class="recent">
      ${rooms
        .map(
          (room) => `
        <div class="row row--tight">
          <button class="recent__item" type="button" data-open="${escapeHtml(room.id)}" style="flex:1">
            <strong>${escapeHtml(room.name)}</strong>
            <span class="spacer"></span>
            <span class="muted">${escapeHtml(when(room.updated_at))}</span>
          </button>
          ${
            owned
              ? `<button class="btn btn--sm btn--ghost" type="button" data-delete="${escapeHtml(room.id)}"
                         aria-label="Delete ${escapeHtml(room.name)}" title="Delete this session">×</button>`
              : `<span class="chip">${escapeHtml(room.role || "voter")}</span>`
          }
        </div>`
        )
        .join("")}
    </div>`;
}

function when(timestamp) {
  if (!timestamp) return "";
  const then = new Date(timestamp).getTime();
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function cachedRooms() {
  return cache;
}
