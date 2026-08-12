/**
 * Bootstrap and wiring.
 *
 * Rendering is deliberately dumb: the UI modules turn state into HTML, and every
 * interaction is a `data-act` attribute handled by the table below. State lives
 * in store.js, travels through transport.js, and is guarded by row level
 * security in the database.
 */

import {
  $,
  $$,
  newId,
  readJson,
  writeJson,
  setHtml,
  escapeHtml,
  toast,
  copyText,
  playReveal,
  formatClock,
} from "./util.js";
import { createStore, createRoom, activeStory, allVoted, castVotes } from "./store.js";
import { createSupabaseTransport } from "./transport.js";
import * as db from "./supabase.js";
import { deckCards, deckLabel, parseCustomDeck, DECKS } from "./decks.js";
import { computeStats } from "./stats.js";
import * as jira from "./jira.js";
import { createTicker, remainingSeconds, isTimerFinished } from "./timer.js";
import { downloadCsv, downloadJson } from "./export.js";
import { renderStage } from "./ui/seats.js";
import { renderDeck } from "./ui/deck.js";
import { renderStoryPanel, renderPeoplePanel, renderHistoryPanel } from "./ui/side.js";
import { createChatFeed, renderChatBar } from "./ui/chat.js";
import { mountLanding, renderLanding, renderNewPasswordCard } from "./ui/landing.js";
import { openModal, closeModal, confirmDialog, promptDialog, isModalOpen } from "./ui/modals.js";
import { openSettings } from "./ui/settings.js";
import {
  openAddStoryFromJira,
  openManualStory,
  openJqlImport,
  openPickEstimate,
  openUpdatePoints,
} from "./ui/story-modals.js";

const PREFS_KEY = "pp:prefs";
const HEARTBEAT_MS = 20000;

let prefs = { theme: "light", sound: true, ...(readJson(PREFS_KEY) || {}) };
let auth = { user: null, profile: null };
let me = { id: "", name: "" };
let session = null; // { roomId, meta, transport, store, cleanup: [] }
let sideTab = "story";
let wasRevealed = false;
let ticks = 0;

const ticker = createTicker(500);

/* ---------- Preferences ---------- */

function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  writeJson(PREFS_KEY, prefs);
  applyTheme();
}

function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme === "dark" ? "dark" : "light";
}

/* ---------- Auth ---------- */

async function refreshAuth() {
  const user = await db.currentUser();
  const profile = user ? await db.myProfile() : null;
  auth = { user, profile };
  me = {
    id: user?.id || "",
    name: profile?.display_name || user?.user_metadata?.display_name || "Guest",
  };
  // Jira settings belong to the account, so they are reloaded with it.
  if (user) await jira.pullConfig().catch(() => {});
  else jira.forgetConfig();
  return auth;
}

/* ---------- Routing ---------- */

async function route() {
  const hash = location.hash;
  const room = hash.match(/^#\/room\/([\w-]+)/);
  const join = hash.match(/^#\/join\/([\w-]+)/);

  if (hash.startsWith("#/reset")) return showPasswordReset();
  if (join) return showJoin(join[1]);
  if (room) return enterRoom(room[1]);
  return showLanding();
}

async function showLanding() {
  await leaveSession();
  $("#screen-room").hidden = true;
  $("#screen-landing").hidden = false;
  closeOverlay();
  document.title = "Planning Poker · 4flow";
  await renderLanding(auth);
}

/** Arrived from the link in a reset email: a session is already open. */
async function showPasswordReset() {
  await leaveSession();
  $("#screen-room").hidden = true;
  $("#screen-landing").hidden = false;
  closeOverlay();
  await refreshAuth();

  if (!auth.user) {
    toast("That reset link has expired. Ask for a new code.", "warn");
    location.hash = "#/";
    return;
  }
  renderNewPasswordCard();
}

function openRoom(roomId) {
  location.hash = `#/room/${roomId}`;
}

/* ---------- Session lifecycle ---------- */

async function leaveSession() {
  if (!session) return;
  const current = session;
  session = null;
  current.cleanup.forEach((fn) => fn());
  await current.store.settled().catch(() => {});
  current.transport.close();
}

async function enterRoom(roomId) {
  if (session?.roomId === roomId) return;
  await leaveSession();

  $("#screen-landing").hidden = true;
  $("#screen-room").hidden = false;
  showOverlay(`<p class="hint">Opening the session…</p>`);

  if (!auth.user) {
    return showOverlay(
      overlayCard(
        "Sign in first",
        `<p class="hint">Open the invite link you were sent, or sign in on the start page to host your own session.</p>`,
        `<button class="btn btn--primary btn--block" type="button" data-act="go-home">Back to the start</button>`
      )
    );
  }

  let meta;
  try {
    meta = await db.roomMeta(roomId);
  } catch (error) {
    return showOverlay(overlayCard("Could not open the session", `<p class="note note--danger">${escapeHtml(error.message)}</p>`, backButton()));
  }

  if (!meta) {
    return showOverlay(
      overlayCard(
        "No access to this session",
        `<p class="hint">
           This session either does not exist, or you were never invited to it. Sessions are private to
           their host and the people who opened their invite link.
         </p>`,
        backButton()
      )
    );
  }

  const transport = createSupabaseTransport(roomId);
  const store = createStore(transport, { onError: (error) => toast(db.describe(error), "error") });
  const cleanup = [];

  cleanup.push(transport.onRemote((state, version) => store.adopt(state, version)));
  cleanup.push(store.subscribe(() => render()));

  // The composer is mounted once, not with the deck: render() replaces the deck
  // on every state change and would wipe text from under the person typing it.
  const chat = createChatFeed($("#chat-feed"));
  setHtml($("#chat-bar-host"), renderChatBar());
  cleanup.push(transport.onChat((message) => chat.push(message)));
  cleanup.push(() => {
    chat.clear();
    setHtml($("#chat-bar-host"), "");
  });

  session = { roomId, meta, transport, store, chat, cleanup };

  let initial;
  try {
    initial = await transport.load();
  } catch (error) {
    return showOverlay(overlayCard("Could not load the session", `<p class="note note--danger">${escapeHtml(db.describe(error))}</p>`, backButton()));
  }

  if (!initial) {
    return showOverlay(overlayCard("This session is empty", `<p class="hint">Its state could not be read. Ask the host to create it again.</p>`, backButton()));
  }

  // The room owner (from pp_rooms.owner_id) is the source of truth for who
  // the host is. Always enforce this so that stale state can never let a
  // guest become host by being the first to JOIN.
  if (meta.owner_id) {
    initial.state.hostId = meta.owner_id;
  }

  store.seed(initial.state, initial.version);
  closeOverlay();
  const joinRole = pendingRole || undefined;
  pendingRole = null;
  const room = store.getState();
  const myRole = !auth.user ? "voter" : joinRole;
  store.dispatch({ type: "JOIN", id: me.id, name: me.name, role: myRole });
  void db.touchMembership(roomId, { display_name: me.name });
  const updatedRoom = store.getState();
  if (updatedRoom.activeStoryId && me.id !== updatedRoom.hostId) {
    store.dispatch({ type: "SELECT_STORY", id: me.id, storyId: updatedRoom.activeStoryId });
  }
  render();
}

/* ---------- Invite / join ---------- */

async function showJoin(token) {
  await leaveSession();
  $("#screen-landing").hidden = true;
  $("#screen-room").hidden = false;
  showOverlay(`<p class="hint">Reading the invite…</p>`);

  let preview;
  try {
    preview = await db.previewInvite(token);
  } catch (error) {
    return showOverlay(overlayCard("Invite could not be read", `<p class="note note--danger">${escapeHtml(error.message)}</p>`, backButton()));
  }

  if (!preview) {
    return showOverlay(overlayCard("Invite not valid", `<p class="hint">That link does not point at a session any more.</p>`, backButton()));
  }

  showOverlay(
    overlayCard(
      "You are invited",
      `<div class="story-now" style="margin-bottom: var(--sp-4)">
         <div class="story-now__key">SESSION</div>
         <h3 class="story-now__title">${escapeHtml(preview.roomName)}</h3>
         <p class="hint">Hosted by ${escapeHtml(preview.hostName)} · ${preview.memberCount} already in the room</p>
       </div>
       <div class="field">
         <label for="join-name">Your name</label>
         <input class="input" id="join-name" maxlength="40" required autofocus value="${escapeHtml(
           auth.user ? me.name : ""
         )}" placeholder="Alex">
       </div>
       <div class="field" style="margin-top: var(--sp-3)">
         <label for="join-role">How are you joining?</label>
         <select class="select" id="join-role">
           <option value="voter">As a voter — I pick cards</option>
           <option value="spectator">As a spectator — I only watch</option>
         </select>
       </div>
       <p class="hint" style="margin-top: var(--sp-3)">
         No account needed. You get a guest session in this browser and can see this room only.
       </p>`,
      `<button class="btn btn--primary btn--lg btn--block" type="button" id="join-go">Join the session</button>
       <button class="btn btn--ghost btn--block" type="button" data-act="go-home" style="margin-top: var(--sp-2)">Cancel</button>`
    )
  );

  const button = $("#join-go");
  button.addEventListener("click", async () => {
    const name = $("#join-name").value.trim();
    if (!name) return $("#join-name").focus();
    const role = $("#join-role").value;
    button.disabled = true;
    button.textContent = "Joining…";
    try {
      // Always go through signInAsGuest — it reuses existing anonymous
      // sessions but signs out non-anonymous ones (e.g. the host opening
      // the invite in the same browser) to create a fresh guest identity.
      await db.signInAsGuest(name);
      await refreshAuth();
      const roomId = await db.redeemInvite(token, name, role);
      pendingRole = role;
      openRoom(roomId);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Join the session";
    }
  });
}

let pendingRole = null;

/* ---------- Overlay ---------- */

function showOverlay(html) {
  setHtml($("#gate-host"), `<div class="gate"><div class="gate__card stack">${html}</div></div>`);
}

function overlayCard(title, body, footer = "") {
  return `
    <div>
      <span class="wordmark">
        <span class="wordmark__four">4</span>flow
        <span class="wordmark__rule" aria-hidden="true"></span>
        <span class="wordmark__app">Planning Poker</span>
      </span>
    </div>
    <h1 style="font-size: var(--fs-lg)">${escapeHtml(title)}</h1>
    ${body}
    ${footer}`;
}

function backButton() {
  return `<button class="btn btn--primary btn--block" type="button" data-act="go-home">Back to the start</button>`;
}

function closeOverlay() {
  setHtml($("#gate-host"), "");
}

/* ---------- Rendering ---------- */

function context(room) {
  return {
    meId: me.id,
    isHost: room.hostId === me.id,
    isSpectator: room.participants[me.id]?.role === "spectator",
    isOwner: session?.meta?.owner_id === me.id,
    now: Date.now(),
    inviteUrl: session?.meta?.invite_token ? db.inviteUrl(session.meta.invite_token) : "",
  };
}

function render() {
  const room = session?.store.getState();
  if (!room) return;
  const ctx = context(room);

  document.title = `${room.name} · Planning Poker`;
  setHtml($("#room-head"), header(room, ctx));
  setHtml($("#table-area"), renderStage(room, ctx));
  setHtml($("#deck"), renderDeck(room, ctx));

  const panel = $(`#panel-${sideTab}`);
  const scroll = panel ? panel.scrollTop : 0;
  if (sideTab === "story") setHtml($("#panel-story"), renderStoryPanel(room, ctx));
  if (sideTab === "people") setHtml($("#panel-people"), renderPeoplePanel(room, ctx));
  if (sideTab === "history") setHtml($("#panel-history"), renderHistoryPanel(room, ctx));
  if (panel) panel.scrollTop = scroll;

  if (room.revealed && !wasRevealed) {
    if (prefs.sound) playReveal();
    const tableEl = $("#table-area");
    if (tableEl) tableEl.scrollTop = 0;
  }
  wasRevealed = room.revealed;

  if (pendingRole) {
    const role = pendingRole;
    pendingRole = null;
    if (room.participants[me.id]?.role !== role) {
      session.store.dispatch({ type: "SET_ROLE", id: me.id, role });
    }
  }

  maybeAutoReveal(room, ctx);
}

function header(room, ctx) {
  const story = activeStory(room);
  return `
    <span class="wordmark head-hide">
      <span class="wordmark__four">4</span>flow
      <span class="wordmark__rule" aria-hidden="true"></span>
      <span class="wordmark__app">Planning Poker</span>
    </span>
    <div class="room__name">
      <h1>${escapeHtml(room.name)}</h1>
      <span class="chip head-hide">${escapeHtml(deckLabel(room))}</span>
      ${story?.key ? `<span class="chip chip--brand">${escapeHtml(story.key)}</span>` : ""}
    </div>
    <div class="spacer"></div>
    <span class="chip head-hide">Round ${room.round}</span>
    <button class="btn btn--sm" type="button" data-act="copy-invite">Invite</button>
    <button class="btn btn--icon" type="button" data-act="toggle-sound"
            aria-label="${prefs.sound ? "Mute" : "Unmute"}" title="${prefs.sound ? "Mute" : "Unmute"}">
      ${prefs.sound ? "🔊" : "🔇"}
    </button>
    <button class="btn btn--icon" type="button" data-act="toggle-theme" aria-label="Switch theme" title="Switch theme">◐</button>
    ${ctx.isOwner ? `<button class="btn btn--sm" type="button" data-act="settings">Jira</button>` : ""}
    <button class="btn btn--sm btn--ghost" type="button" data-act="leave">Leave</button>`;
}

/** Reveal without being asked, when the room is set up that way. */
function maybeAutoReveal(room, ctx) {
  if (!ctx.isHost || room.revealed) return;
  if (room.autoReveal && allVoted(room, ctx.now)) {
    session.store.dispatch({ type: "REVEAL" });
  }
}

/* ---------- Ticker: timer, presence, heartbeat ---------- */

ticker.add((now) => {
  const room = session?.store.getState();
  if (!room) return;
  ticks += 1;

  if (room.timer.running) {
    const label = $(".felt__timer");
    const seconds = remainingSeconds(room, now);
    if (label) {
      label.textContent = formatClock(seconds);
      label.classList.toggle("felt__timer--low", seconds <= 10);
    }
    if (isTimerFinished(room, now) && room.hostId === me.id) {
      session.store.dispatch({ type: "TIMER_END" });
      if (room.revealOnTimerEnd && Object.keys(room.votes).length) {
        session.store.dispatch({ type: "REVEAL" });
      } else {
        toast("Time is up.", "warn");
      }
    }
  }

  if (ticks % (HEARTBEAT_MS / 500) === 0 && room.participants[me.id]) {
    session.store.dispatch({ type: "HEARTBEAT", id: me.id });
    void db.touchMembership(session.roomId, {});
  } else if (ticks % 10 === 0) {
    render(); // refresh "away" markers and reaction bubbles
  }
});

/* ---------- Actions ---------- */

const GLOBAL_ACTIONS = ["toggle-theme", "settings", "go-home", "sign-out", "reload"];

const actions = {
  /* global */
  "toggle-theme": () => savePrefs({ theme: prefs.theme === "dark" ? "light" : "dark" }),
  "toggle-sound": () => {
    savePrefs({ sound: !prefs.sound });
    render();
  },
  settings: () => openSettings({ onSaved: () => session && render() }),
  "go-home": () => {
    location.hash = "#/";
  },
  reload: () => location.reload(),
  "sign-out": async () => {
    await leaveSession();
    await db.signOut();
    await refreshAuth();
    location.hash = "#/";
    await showLanding();
  },

  /* voting */
  vote: (el) => castCard(el.dataset.card),
  reveal: () => {
    const room = session.store.getState();
    if (room && room.hostId === me.id) {
      session.store.dispatch({ type: "REVEAL", by: me.id });
    } else {
      toast("Only the host can reveal the cards.", "warn");
    }
  },
  reset: () => {
    const room = session.store.getState();
    if (room && room.hostId === me.id) {
      session.store.dispatch({ type: "RESET_ROUND", by: me.id });
    }
  },
  react: (el) => session.store.dispatch({ type: "REACT", id: me.id, emoji: el.dataset.emoji }),

  /* chat */
  "chat-emoji": (el) => {
    const input = $("#chat-input");
    if (!input) return;
    input.value = `${input.value}${el.dataset.emoji}`.slice(0, input.maxLength);
    input.focus();
  },
  "toggle-role": () => {
    const room = session.store.getState();
    const role = room.participants[me.id]?.role === "spectator" ? "voter" : "spectator";
    session.store.dispatch({ type: "SET_ROLE", id: me.id, role });
    void db.touchMembership(session.roomId, { role });
  },

  /* timer */
  "timer-start": () => session.store.dispatch({ type: "TIMER_START" }),
  "timer-pause": () => session.store.dispatch({ type: "TIMER_PAUSE" }),
  "timer-reset": () => session.store.dispatch({ type: "TIMER_RESET" }),

  /* stories */
  "toggle-voting": (el) => {
    const room = session.store.getState();
    if (!room || room.hostId !== me.id) {
      toast("Only the host can toggle voting.", "warn");
      return;
    }
    const storyId = el.dataset.id || room.activeStoryId;
    if (!storyId) return;
    const story = room.stories.find((s) => s.id === storyId);
    if (!story) return;
    const nextEnabled = !story.votingEnabled;
    session.store.dispatch({ type: "TOGGLE_VOTING", id: storyId, enabled: nextEnabled });
  },
  "add-story": () => {
    const room = session.store.getState();
    if (room && room.hostId !== me.id) return toast("Only the host can add stories.", "warn");
    openAddStoryFromJira({ store: session.store });
  },
  "add-story-manual": () => {
    const room = session.store.getState();
    if (room && room.hostId !== me.id) return toast("Only the host can add stories.", "warn");
    openManualStory({ store: session.store });
  },
  "import-jql": () => {
    const room = session.store.getState();
    if (room && room.hostId !== me.id) return toast("Only the host can import stories.", "warn");
    openJqlImport({ store: session.store });
  },
  "edit-story": () => {
    const story = activeStory(session.store.getState());
    if (story) openManualStory({ store: session.store, story });
  },
  "set-active-story": (el) => session.store.dispatch({ type: "SET_ACTIVE_STORY", id: el.dataset.id }),
  "select-story": (el) => session.store.dispatch({ type: "SELECT_STORY", id: me.id, storyId: el.dataset.id }),
  "move-story": (el) =>
    session.store.dispatch({ type: "MOVE_STORY", id: el.dataset.id, direction: el.dataset.direction }),
  "delete-story": async (el) => {
    const room = session.store.getState();
    const story = room.stories.find((s) => s.id === el.dataset.id);
    if (!story) return;
    const yes = await confirmDialog({
      title: "Remove story",
      message: `Remove "${story.title}" from this session? Jira is not touched.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (yes) session.store.dispatch({ type: "DELETE_STORY", id: story.id });
  },
  "restore-story": (el) => {
    session.store.dispatch({ type: "RESTORE_STORY", id: el.dataset.id });
    toast("Back in the backlog.", "ok");
  },
  "next-story": () => {
    const room = session.store.getState();
    const index = room.stories.findIndex((s) => s.id === room.activeStoryId);
    const next = room.stories.slice(index + 1).find((s) => s.status !== "archived");
    if (next) session.store.dispatch({ type: "SET_ACTIVE_STORY", id: next.id });
    else toast("That was the last story in the backlog.", "info");
  },
  "refresh-story": async () => {
    const room = session.store.getState();
    const story = activeStory(room);
    if (!story?.key) return;
    try {
      const issue = await jira.getIssue(story.key);
      session.store.dispatch({
        type: "UPDATE_STORY",
        id: story.id,
        patch: { title: issue.title, description: issue.description, jiraPoints: issue.points, url: issue.url },
      });
      toast(`${issue.key} refreshed from Jira.`, "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  },

  /* estimates */
  "accept-estimate": (el) => {
    const story = activeStory(session.store.getState());
    if (story) session.store.dispatch({ type: "SET_ESTIMATE", id: story.id, value: el.dataset.value });
  },
  // Changes only your own card in the current round — never the story's final
  // estimate. That is what "Accept …" and "Update story point" are for, and
  // they stay with the owner.
  "edit-estimate": () => {
    const room = session.store.getState();
    const story = activeStory(room);
    if (!story) return;
    if (room.participants[me.id]?.role !== "voter") {
      return toast("Spectators do not hold a card.", "warn");
    }
    if (!story.votingEnabled) return toast("Voting is closed for this story.", "warn");
    const myVote = room.votes[me.id];
    const cards = deckCards(room);
    const cardHtml = cards
      .map(
        (card) =>
          `<button class="card-btn" type="button" data-value="${escapeHtml(card)}"
                   aria-pressed="${myVote === card}">${escapeHtml(card)}</button>`
      )
      .join("");

    const handle = openModal({
      title: "Change your card",
      body: `
        <p class="hint">Only your own card changes — everyone else keeps theirs.</p>
        <div class="deck__cards" style="justify-content:center">${cardHtml}</div>`,
    });

    handle.body.querySelectorAll("[data-value]").forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.dataset.value;
        castCard(card);
        closeModal();
        toast(`Your card is now ${card}.`, "ok");
      });
    });
  },
  "pick-estimate": () => {
    const room = session.store.getState();
    const story = activeStory(room);
    if (story) openPickEstimate({ store: session.store, room, story, suggestion: suggestionFor(room) });
  },
  "update-points": () => {
    const room = session.store.getState();
    const story = activeStory(room);
    if (!story) {
      toast("Put a story on the table first.", "warn");
      return;
    }
    openUpdatePoints({ store: session.store, room, story, me, suggestion: suggestionFor(room) });
  },

  /* room */
  "copy-invite": async () => {
    const url = context(session.store.getState()).inviteUrl;
    if (!url) return toast("No invite link for this session.", "warn");
    toast((await copyText(url)) ? "Invite link copied." : url, "ok");
  },
  "rename-room": async () => {
    const room = session.store.getState();
    const name = await promptDialog({ title: "Rename session", label: "Session name", value: room.name });
    if (name) session.store.dispatch({ type: "RENAME_ROOM", name });
  },
  "rename-me": async () => {
    const name = await promptDialog({ title: "Your name", label: "Display name", value: me.name });
    if (!name) return;
    me = { ...me, name };
    await db.setDisplayName(name);
    void db.touchMembership(session.roomId, { display_name: name });
    session.store.dispatch({ type: "SET_NAME", id: me.id, name });
  },
  "make-host": (el) => {
    const room = session.store.getState();
    if (room && room.hostId !== me.id) return toast("Only the host can transfer host.", "warn");
    session.store.dispatch({ type: "SET_HOST", id: el.dataset.id, by: me.id });
  },
  kick: async (el) => {
    const room = session.store.getState();
    if (room && room.hostId !== me.id) return toast("Only the host can remove someone.", "warn");
    const person = room.participants[el.dataset.id];
    if (!person) return;
    const yes = await confirmDialog({
      title: "Remove from room",
      message: `Remove ${person.name} from this session? They lose access until you send the invite link again.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!yes) return;
    session.store.dispatch({ type: "KICK", id: person.id, by: me.id });
    try {
      await db.removeMember(session.roomId, person.id);
    } catch (error) {
      toast(error.message, "error");
    }
  },
  "clear-room": async () => {
    const room = session.store.getState();
    const yes = await confirmDialog({
      title: "Clear session",
      message: "Remove every story and all round history from this session? Jira is not touched.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!yes) return;
    for (const story of [...room.stories]) session.store.dispatch({ type: "DELETE_STORY", id: story.id });
    session.store.dispatch({ type: "RESET_ROUND" });
  },
  leave: async () => {
    const yes = await confirmDialog({
      title: "Leave the session",
      message: "You can come back from the same invite link at any time.",
      confirmLabel: "Leave",
    });
    if (!yes) return;
    session.store.dispatch({ type: "LEAVE", id: me.id });
    await session.store.settled().catch(() => {});
    location.hash = "#/";
  },

  /* export */
  "export-csv": () => downloadCsv(session.store.getState()),
  "export-json": () => downloadJson(session.store.getState()),
};

function suggestionFor(room) {
  if (!room.revealed) return undefined;
  const stats = computeStats(castVotes(room), deckCards(room));
  return stats.suggestion ?? undefined;
}

/**
 * Show a message here and fire it at everyone else. The local copy is not an
 * optimisation — broadcasts do not echo to the sender, so without it you would
 * never see your own line.
 */
function say(message) {
  if (!session) return;
  session.chat.push(message);
  void session.transport.sendChat(message);
}

/**
 * Put a card down. Once the cards are face up a change is visible to everyone,
 * so it gets announced — otherwise the average quietly moves and nobody knows
 * why.
 */
function castCard(card) {
  const before = session.store.getState();
  const after = session.store.dispatch({ type: "VOTE", id: me.id, card });
  if (!before.revealed || after === before) return;
  if (before.votes[me.id] === card) return;
  say({ kind: "system", text: `${me.name} changed the estimation` });
}

/* ---------- Event wiring ---------- */

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const handler = actions[target.dataset.act];
  if (!handler) return;
  if (!session && !GLOBAL_ACTIONS.includes(target.dataset.act)) return;
  event.preventDefault();
  handler(target, event);
});

/* Chat: Enter or Send, then straight back to an empty box. */
document.addEventListener("submit", (event) => {
  const form = event.target.closest("#chat-bar");
  if (!form) return;
  event.preventDefault();
  if (!session) return;
  const input = form.querySelector("#chat-input");
  const text = input.value.trim();
  input.value = "";
  if (!text) return;
  say({ name: me.name, text });
});

document.addEventListener("change", (event) => {
  const target = event.target.closest("[data-act]");
  if (!target || !session) return;
  const store = session.store;

  switch (target.dataset.act) {
    case "change-deck": {
      if (target.value === "custom") {
        openCustomDeck();
        render();
        return;
      }
      store.dispatch({ type: "SET_DECK", deckId: target.value });
      return;
    }
    case "toggle-auto-reveal":
      store.dispatch({ type: "SET_OPTIONS", autoReveal: target.checked });
      return;
    case "toggle-timer-reveal":
      store.dispatch({ type: "SET_OPTIONS", revealOnTimerEnd: target.checked });
      return;
    case "set-timer-duration":
      store.dispatch({ type: "SET_OPTIONS", timerDuration: Number(target.value) });
      return;
    default:
  }
});

function openCustomDeck() {
  const room = session.store.getState();
  const handle = openModal({
    title: "Custom deck",
    body: `
      <div class="field">
        <label for="custom-cards">Cards</label>
        <input class="input" id="custom-cards" autofocus
               value="${escapeHtml((room.customCards || []).join(", ") || "1, 2, 3, 5, 8, ?, ☕")}">
        <span class="hint">Separated by commas, in the order they should appear.</span>
      </div>`,
    footer: `
      <button class="btn" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-save>Use this deck</button>`,
  });

  handle.footer.querySelector("[data-save]").addEventListener("click", () => {
    const cards = parseCustomDeck(handle.body.querySelector("#custom-cards").value);
    if (cards.length < 2) {
      handle.message("A deck needs at least two cards.", "warn");
      return;
    }
    session.store.dispatch({ type: "SET_DECK", deckId: "custom", customCards: cards });
    closeModal();
  });
}

/* Sidebar tabs */
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  sideTab = tab.dataset.tab;
  $$("#side-tabs .side__tab").forEach((button) =>
    button.setAttribute("aria-selected", String(button.dataset.tab === sideTab))
  );
  ["story", "people", "history"].forEach((name) => {
    $(`#panel-${name}`).hidden = name !== sideTab;
  });
  render();
});

/* Keyboard shortcuts */
document.addEventListener("keydown", (event) => {
  if (!session || isModalOpen() || event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const room = session.store.getState();
  if (!room) return;
  const ctx = context(room);

  if (/^[0-9]$/.test(event.key)) {
    const index = event.key === "0" ? 9 : Number(event.key) - 1;
    const card = deckCards(room)[index];
    // No `revealed` guard: the deck stays clickable after the reveal, so the
    // shortcut for the same click has to work then too.
    if (card && !ctx.isSpectator && activeStory(room)) {
      event.preventDefault();
      castCard(card);
    }
    return;
  }

  const key = event.key.toLowerCase();
  if (key === "r" && ctx.isHost) {
    event.preventDefault();
    session.store.dispatch({ type: room.revealed ? "RESET_ROUND" : "REVEAL" });
  } else if (key === "n" && ctx.isHost) {
    event.preventDefault();
    actions["next-story"]();
  } else if (key === "?") {
    event.preventDefault();
    showShortcuts();
  }
});

function showShortcuts() {
  openModal({
    title: "Keyboard shortcuts",
    body: `
      <ul class="stack stack--tight" style="list-style:none;padding:0;margin:0">
        <li><strong>1–9, 0</strong> — pick the matching card</li>
        <li><strong>R</strong> — reveal, or start the next round (host)</li>
        <li><strong>N</strong> — next story (host)</li>
        <li><strong>Esc</strong> — close a dialog</li>
        <li><strong>?</strong> — this list</li>
      </ul>`,
    footer: `<button class="btn btn--primary" type="button" data-modal-close>Got it</button>`,
  });
}

/* ---------- Start ---------- */

mountLanding({
  onCreate: async ({ roomName, deckId }) => {
    try {
      // The name comes from the signed-in account — no point asking twice.
      const name = me.name || "Host";
      const title = roomName || `${name}'s refinement`;
      const id = newId(8);
      const state = createRoom({ id, name: title, deckId, host: { id: me.id, name } });
      await db.createRoomRow({ id, name: title, state });
      openRoom(id);
    } catch (error) {
      toast(error.message, "error");
    }
  },
  onOpen: openRoom,
  onBackToSignIn: async () => {
    await refreshAuth();
    await renderLanding(auth);
  },
  onPasswordChanged: async () => {
    await refreshAuth();
    if (location.hash.startsWith("#/reset")) location.hash = "#/";
    else await renderLanding(auth);
  },
  onDelete: async (roomId) => {
    const yes = await confirmDialog({
      title: "Delete session",
      message: "The session, its backlog and its history are deleted for everyone. Jira is not touched.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!yes) return;
    try {
      await db.deleteRoom(roomId);
      toast("Session deleted.", "ok");
      await renderLanding(auth);
    } catch (error) {
      toast(error.message, "error");
    }
  },
});

async function boot() {
  applyTheme();
  await refreshAuth();
  await route();
  window.addEventListener("hashchange", route);
  await db.onAuthChange(async (supabaseSession, event) => {
    const before = auth.user?.id;
    await refreshAuth();

    if (event === "PASSWORD_RECOVERY") {
      // Opened from a reset link. supabase-js has already eaten the fragment,
      // so this event is the only way to know why we are here.
      await leaveSession();
      $("#screen-room").hidden = true;
      $("#screen-landing").hidden = false;
      closeOverlay();
      renderNewPasswordCard();
      return;
    }

    if (auth.user?.id !== before) {
      // Signed in, signed up, or signed out in another tab.
      if (!location.hash.startsWith("#/room/")) await route();
    }
    if (!supabaseSession && session) location.hash = "#/";
  });
}

boot().catch((error) => {
  setHtml(
    $("#gate-host"),
    `<div class="gate"><div class="gate__card stack">
       <h1 style="font-size: var(--fs-lg)">Could not start</h1>
       <p class="note note--danger">${escapeHtml(db.describe(error))}</p>
       <button class="btn btn--primary" type="button" data-act="reload">Try again</button>
     </div></div>`
  );
});

// Exposed for poking around in the console.
window.planningPoker = {
  get room() {
    return session?.store.getState() || null;
  },
  get me() {
    return me;
  },
  get auth() {
    return auth;
  },
  DECKS,
};
