/**
 * Room state: the shape, a pure reducer, and a tiny store.
 *
 * Every change to a room goes through `dispatch`. The reducer is pure so it can
 * be tested directly and so the same action produces the same result in every
 * client. How state reaches other clients is entirely `transport.js`'s business.
 */

import { newId } from "./util.js";
import { DECKS } from "./decks.js";

export const SCHEMA_VERSION = 1;
export const AWAY_AFTER_MS = 25000;

export function createRoom({ id, name, deckId = "fibonacci", customCards = [], host, at = Date.now() }) {
  const room = {
    v: SCHEMA_VERSION,
    id: id || newId(8),
    name: name?.trim() || "Refinement",
    createdAt: at,
    hostId: host?.id || null,
    deckId: DECKS[deckId] ? deckId : "fibonacci",
    customCards,
    autoReveal: false,
    revealOnTimerEnd: false,
    timerDuration: 60,
    participants: {},
    stories: [],
    activeStoryId: null,
    votes: {},
    revealed: false,
    revealedAt: null,
    round: 1,
    timer: { running: false, endsAt: null, remaining: 60 },
  };
  if (host) {
    room.participants[host.id] = participant(host, at);
    room.hostId = host.id;
  }
  return room;
}

function participant({ id, name, role = "voter" }, at) {
  return {
    id,
    name: String(name || "Guest").slice(0, 40),
    role: role === "spectator" ? "spectator" : "voter",
    joinedAt: at,
    lastSeen: at,
    reaction: null,
    // Which story this person has actively joined. Being connected to the
    // room is not the same as being at the table for a given story — this
    // resets implicitly whenever activeStoryId moves on, since the id simply
    // stops matching, with nothing extra to clean up.
    selectedStoryId: null,
  };
}

export function createStory({ title, description = "", key = null, url = null, votingEnabled = false, at = Date.now() }) {
  return {
    id: newId(8),
    key,
    url,
    title: String(title || "Untitled story").slice(0, 300),
    description,
    votingEnabled: Boolean(votingEnabled),
    status: "pending", // pending | estimated
    finalEstimate: null,
    jiraPoints: null,
    jiraSyncedAt: null,
    jiraSyncedBy: null,
    createdAt: at,
    rounds: [],
  };
}

/** Fill in anything missing from a persisted room; return null if unusable. */
export function normalizeRoom(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== SCHEMA_VERSION || !raw.id) return null;
  const base = createRoom({ id: raw.id, name: raw.name, at: raw.createdAt });
  const room = { ...base, ...raw };
  room.hostId = raw.hostId || raw.host_id || raw.owner_id || base.hostId;
  room.participants = raw.participants && typeof raw.participants === "object" ? raw.participants : {};
  room.stories = Array.isArray(raw.stories)
    ? raw.stories.map((s) => ({ ...s, votingEnabled: Boolean(s?.votingEnabled) }))
    : [];
  room.votes = raw.votes && typeof raw.votes === "object" ? raw.votes : {};
  room.timer = raw.timer && typeof raw.timer === "object" ? raw.timer : base.timer;
  return room;
}

/* ---------- Reducer ---------- */

export function reduce(state, action) {
  if (!state) return state;
  const at = action.at ?? Date.now();
  const room = { ...state };

  switch (action.type) {
    case "JOIN": {
      const { id, name, role } = action;
      const existing = room.participants[id];
      room.participants = {
        ...room.participants,
        [id]: existing
          ? { ...existing, name: name ?? existing.name, role: role ?? existing.role, lastSeen: at }
          : participant({ id, name, role }, at),
      };
      // Never let joining make someone host — a room that somehow has no host
      // is repaired against the account that owns it (app.js, from the
      // database), not against whoever happens to open the link next.
      // If somehow hostId matches joining user and they're not the owner, reset it
      if (!room.hostId) {
        room.hostId = null;
      }
      return room;
    }

    case "HEARTBEAT": {
      const person = room.participants[action.id];
      if (!person) return state;
      room.participants = { ...room.participants, [action.id]: { ...person, lastSeen: at } };
      return room;
    }

    case "LEAVE":
      if (!room.participants[action.id]) return state;
      return removeParticipant(room, action.id);

    case "KICK": {
      if (action.by && action.by !== room.hostId) return state;
      if (!room.participants[action.id]) return state;
      return removeParticipant(room, action.id);
    }

    case "SET_NAME": {
      const person = room.participants[action.id];
      if (!person) return state;
      const name = String(action.name || "").trim().slice(0, 40);
      if (!name) return state;
      room.participants = { ...room.participants, [action.id]: { ...person, name } };
      return room;
    }

    case "SET_ROLE": {
      const person = room.participants[action.id];
      if (!person) return state;
      const role = action.role === "spectator" ? "spectator" : "voter";
      room.participants = { ...room.participants, [action.id]: { ...person, role } };
      if (role === "spectator") {
        const votes = { ...room.votes };
        delete votes[action.id];
        room.votes = votes;
      }
      return room;
    }

    case "SET_HOST": {
      if (action.by && action.by !== room.hostId) return state;
      if (!room.participants[action.id]) return state;
      room.hostId = action.id;
      return room;
    }

    case "RENAME_ROOM": {
      const name = String(action.name || "").trim().slice(0, 80);
      if (!name) return state;
      room.name = name;
      return room;
    }

    case "SET_DECK": {
      room.deckId = DECKS[action.deckId] ? action.deckId : room.deckId;
      if (Array.isArray(action.customCards)) room.customCards = action.customCards;
      // Cards from the old deck are meaningless now.
      room.votes = {};
      room.revealed = false;
      room.revealedAt = null;
      return room;
    }

    case "SET_OPTIONS": {
      if (typeof action.autoReveal === "boolean") room.autoReveal = action.autoReveal;
      if (typeof action.revealOnTimerEnd === "boolean") room.revealOnTimerEnd = action.revealOnTimerEnd;
      if (Number.isFinite(action.timerDuration)) {
        room.timerDuration = Math.min(3600, Math.max(10, Math.round(action.timerDuration)));
        if (!room.timer.running) room.timer = { ...room.timer, remaining: room.timerDuration };
      }
      return room;
    }

    case "VOTE": {
      const person = room.participants[action.id];
      const story = activeStory(room);
      if (!person || person.role !== "voter" || !story || !story.votingEnabled) return state;
      if (action.id !== room.hostId && person.selectedStoryId !== story.id) return state;
      const votes = { ...room.votes };
      votes[action.id] = action.card;
      room.votes = votes;
      return room;
    }

    case "SELECT_STORY": {
      const person = room.participants[action.id];
      if (!person) return state;
      const storyId = action.storyId || room.activeStoryId;
      if (!storyId || !room.stories.some((s) => s.id === storyId)) return state;
      if (person.selectedStoryId === storyId) return state;
      room.participants = { ...room.participants, [action.id]: { ...person, selectedStoryId: storyId } };
      return room;
    }

    case "TOGGLE_VOTING": {
      const storyId = action.id || room.activeStoryId;
      if (!storyId) return state;
      let changed = false;
      room.stories = room.stories.map((story) => {
        if (story.id !== storyId) return story;
        changed = true;
        const enabled = typeof action.enabled === "boolean" ? action.enabled : !story.votingEnabled;
        return { ...story, votingEnabled: enabled };
      });
      return changed ? room : state;
    }

    case "REVEAL": {
      if (room.revealed) return state;
      if (action.by && action.by !== room.hostId) return state;
      if (!Object.keys(room.votes).length) return state;
      room.revealed = true;
      room.revealedAt = at;
      room.timer = { ...room.timer, running: false };
      room.stories = room.stories.map((story) =>
        story.id === room.activeStoryId
          ? {
              ...story,
              rounds: [
                ...story.rounds,
                {
                  round: room.round,
                  at,
                  votes: namedVotes(room),
                },
              ],
            }
          : story
      );
      return room;
    }

    case "RESET_ROUND": {
      if (action.by && action.by !== room.hostId) return state;
      room.votes = {};
      room.revealed = false;
      room.revealedAt = null;
      room.round = room.round + 1;
      room.timer = { running: false, endsAt: null, remaining: room.timerDuration };
      room.participants = mapValues(room.participants, (p) => ({ ...p, reaction: null }));
      return room;
    }

    case "ADD_STORY": {
      if (action.by && action.by !== room.hostId) return state;
      const story = action.story;
      if (!story) return state;
      if (story.id && room.stories.some((s) => s.id === story.id)) return state;
      if (story.key && room.stories.some((s) => s.key === story.key)) return state;
      room.stories = [...room.stories, story];
      if (!room.activeStoryId) {
        room.activeStoryId = story.id;
        room.votes = {};
        room.revealed = false;
        room.round = 1;
      }
      return room;
    }

    case "UPDATE_STORY": {
      const patch = action.patch || {};
      let changed = false;
      room.stories = room.stories.map((story) => {
        if (story.id !== action.id) return story;
        changed = true;
        return { ...story, ...patch, id: story.id };
      });
      return changed ? room : state;
    }

    case "DELETE_STORY": {
      if (!room.stories.some((s) => s.id === action.id)) return state;
      room.stories = room.stories.filter((s) => s.id !== action.id);
      if (room.activeStoryId === action.id) {
        const open = room.stories.filter((s) => s.status !== "archived");
        room.activeStoryId = open.find((s) => s.status === "pending")?.id || open[0]?.id || null;
        room.votes = {};
        room.revealed = false;
      }
      return room;
    }

    case "MOVE_STORY": {
      const index = room.stories.findIndex((s) => s.id === action.id);
      const target = index + (action.direction === "up" ? -1 : 1);
      if (index < 0 || target < 0 || target >= room.stories.length) return state;
      const stories = [...room.stories];
      [stories[index], stories[target]] = [stories[target], stories[index]];
      room.stories = stories;
      return room;
    }

    case "SET_ACTIVE_STORY": {
      if (action.id && !room.stories.some((s) => s.id === action.id)) return state;
      if (room.activeStoryId === action.id) return state;
      room.activeStoryId = action.id;
      room.votes = {};
      room.revealed = false;
      room.revealedAt = null;
      room.round = 1;
      room.timer = { running: false, endsAt: null, remaining: room.timerDuration };
      room.participants = mapValues(room.participants, (p) => ({ ...p, reaction: null }));
      return room;
    }

    case "SET_ESTIMATE": {
      // Once the points reach Jira the story is done with: it leaves the
      // backlog and lives on in the history only.
      const archive = Boolean(action.jiraSynced);
      let changed = false;
      room.stories = room.stories.map((story) => {
        if (story.id !== action.id) return story;
        changed = true;
        return {
          ...story,
          finalEstimate: action.value ?? null,
          status:
            action.value === null || action.value === undefined
              ? "pending"
              : archive
              ? "archived"
              : "estimated",
          jiraPoints: action.jiraPoints !== undefined ? action.jiraPoints : story.jiraPoints,
          jiraSyncedAt: action.jiraSynced ? at : story.jiraSyncedAt,
          jiraSyncedBy: action.jiraSynced ? action.by ?? story.jiraSyncedBy : story.jiraSyncedBy,
        };
      });
      if (!changed) return state;
      if (archive && room.activeStoryId === action.id) {
        room.activeStoryId = room.stories.find((s) => s.id !== action.id && s.status !== "archived")?.id || null;
        room.votes = {};
        room.revealed = false;
        room.revealedAt = null;
        room.round = 1;
        room.timer = { running: false, endsAt: null, remaining: room.timerDuration };
      }
      return room;
    }

    case "RESTORE_STORY": {
      let changed = false;
      room.stories = room.stories.map((story) => {
        if (story.id !== action.id || story.status !== "archived") return story;
        changed = true;
        return { ...story, status: "estimated" };
      });
      return changed ? room : state;
    }

    case "REACT": {
      const person = room.participants[action.id];
      if (!person) return state;
      room.participants = {
        ...room.participants,
        [action.id]: { ...person, reaction: { emoji: action.emoji, at } },
      };
      return room;
    }

    case "TIMER_START": {
      const remaining = room.timer.running
        ? Math.max(0, Math.round(((room.timer.endsAt ?? at) - at) / 1000))
        : room.timer.remaining ?? room.timerDuration;
      const seconds = remaining > 0 ? remaining : room.timerDuration;
      room.timer = { running: true, endsAt: at + seconds * 1000, remaining: seconds };
      return room;
    }

    case "TIMER_PAUSE": {
      if (!room.timer.running) return state;
      room.timer = {
        running: false,
        endsAt: null,
        remaining: Math.max(0, Math.round(((room.timer.endsAt ?? at) - at) / 1000)),
      };
      return room;
    }

    case "TIMER_RESET": {
      room.timer = { running: false, endsAt: null, remaining: room.timerDuration };
      return room;
    }

    case "TIMER_END": {
      if (!room.timer.running) return state;
      room.timer = { running: false, endsAt: null, remaining: 0 };
      return room;
    }

    default:
      return state;
  }
}

function nextHost(participants) {
  const remaining = Object.values(participants).sort((a, b) => a.joinedAt - b.joinedAt);
  return remaining[0]?.id || null;
}

/** Drop a participant and, only if that person held it, pass on the host role. */
function removeParticipant(room, id) {
  const participants = { ...room.participants };
  delete participants[id];
  const votes = { ...room.votes };
  delete votes[id];
  room.participants = participants;
  room.votes = votes;
  if (room.hostId === id) room.hostId = nextHost(participants);
  return room;
}

function mapValues(object, fn) {
  const out = {};
  for (const [key, value] of Object.entries(object)) out[key] = fn(value);
  return out;
}

/** Snapshot of the current round as name → card, for the story history. */
function namedVotes(room) {
  const out = {};
  for (const [id, card] of Object.entries(room.votes)) {
    out[room.participants[id]?.name || "Left the room"] = card;
  }
  return out;
}

/* ---------- Selectors ---------- */

export function activeStory(room) {
  if (!room) return null;
  return room.stories.find((s) => s.id === room.activeStoryId) || null;
}

export function isAway(person, now = Date.now()) {
  return now - (person?.lastSeen ?? 0) > AWAY_AFTER_MS;
}

/** The host is always considered present at the table; everyone else has to join the active story first. */
export function hasSelectedStory(room, personId) {
  if (!room || !personId) return false;
  if (personId === room.hostId) return true;
  if (!room.activeStoryId) return false;
  return room.participants[personId]?.selectedStoryId === room.activeStoryId;
}

/** Voters who are present, have joined the active story, and are therefore expected to vote. */
export function activeVoters(room, now = Date.now()) {
  return Object.values(room.participants).filter(
    (p) => p.role === "voter" && !isAway(p, now) && hasSelectedStory(room, p.id)
  );
}

export function allVoted(room, now = Date.now()) {
  const voters = activeVoters(room, now);
  return voters.length > 0 && voters.every((p) => room.votes[p.id] !== undefined);
}

/** Votes of present voters as {name, card}, for the statistics module. */
export function castVotes(room) {
  return Object.entries(room.votes)
    .filter(([id]) => room.participants[id]?.role === "voter")
    .map(([id, card]) => ({ id, name: room.participants[id].name, card }));
}

/* ---------- Store ---------- */

const MAX_WRITE_ATTEMPTS = 4;

/**
 * The store applies actions locally straight away so the UI never waits on the
 * network, then writes them to the transport in the background. If another
 * client got there first the write is refused, and the queued actions are
 * replayed on top of the state that actually won. Actions are small and
 * order-independent enough for that to be safe — and it beats a spinner on
 * every card click.
 *
 * `confirmed`/`confirmedVersion` track what the server last agreed to; `state`
 * is `confirmed` with every still-pending action applied on top, for the UI to
 * read immediately. The two must stay separate: several reducer branches
 * return their input unchanged once a condition is already satisfied — reveal
 * once revealed, a story once added, the active story once selected — which is
 * the right way to write a reducer, but it means replaying a pending action
 * against the state *that action already produced* looks like a no-op and
 * would get skipped without ever reaching the network. Replaying it against
 * `confirmed`, which has not seen it yet, does not have that problem.
 */
export function createStore(transport, { onError } = {}) {
  let state = null;
  let confirmed = null;
  let version = 0;
  let pending = [];
  let flushing = false;
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(state);
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (pending.length) {
        // A snapshot, not a reference — `pending` keeps growing if more
        // actions are dispatched while this batch is awaiting the network,
        // and `batch.length` below has to mean "how many this batch covered",
        // not "how many exist right now".
        const batch = pending.slice();
        let base = confirmed;
        let baseVersion = version;
        let done = false;

        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && !done; attempt += 1) {
          if (attempt > 0) {
            const fresh = await transport.load();
            if (!fresh) break;
            base = fresh.state;
            baseVersion = fresh.version;
          }

          let candidate = base;
          for (const action of batch) candidate = reduce(candidate, action);
          if (candidate === base) {
            confirmed = base;
            version = baseVersion;
            done = true;
            break;
          }

          const result = await transport.publish(candidate, baseVersion);
          if (result.ok) {
            confirmed = result.state || candidate;
            version = result.version;
            done = true;
          }
        }

        // Actions dispatched while this batch was in flight landed after it in
        // `pending` — drop only the ones this batch covered, keep the rest.
        pending = pending.slice(batch.length);

        if (!done && onError) onError(new Error("Could not save to the session — it may have been deleted."));
      }
    } catch (error) {
      if (onError) onError(error);
    } finally {
      flushing = false;
    }
  }

  return {
    getState: () => state,
    getVersion: () => version,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Adopt state that arrived from another client. Local writes win. */
    adopt(next, nextVersion = 0) {
      if (!next) return;
      if (nextVersion && nextVersion <= version) return;
      if (pending.length || flushing) return;
      state = next;
      confirmed = next;
      version = nextVersion || version;
      notify();
    },

    /** Seed the store with state we already hold (first load, or after create). */
    seed(next, nextVersion) {
      state = next;
      confirmed = next;
      version = nextVersion ?? version;
      notify();
    },

    /** Apply an action now, save it in the background. */
    dispatch(action) {
      if (!state) return null;
      const next = reduce(state, action);
      if (next === state) return state;
      state = next;
      pending.push(action);
      notify();
      flush();
      return next;
    },

    /** Wait for queued writes to land — used before navigating away. */
    async settled() {
      await flush();
    },
  };
}
