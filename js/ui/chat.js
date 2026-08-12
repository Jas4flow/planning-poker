/**
 * Ephemeral chat: a composer beside the deck, one bubble at a time above the
 * table.
 *
 * Messages are never stored — not in the room document, not in a table. They
 * arrive over a Realtime broadcast, sit on screen for ten seconds, and are
 * gone. Somebody who joins a minute later has no way to read what was said,
 * which is the intent.
 *
 * Everything rendered here came off the wire from another browser, so every
 * field is escaped and clamped on the way in, not just on the way out.
 */

import { escapeHtml, initials } from "../util.js";

export const CHAT_EMOJI = ["😀", "😂", "👍", "🎉", "🤔", "🙌", "😅", "🙏"];

const SHOW_MS = 10000;
const MAX_LENGTH = 140;
/** A flood must not build a backlog that takes minutes to drain. */
const MAX_QUEUED = 6;

/**
 * A feed that shows one message at a time in `hostEl`, each for ten seconds.
 * @param {HTMLElement} hostEl
 */
export function createChatFeed(hostEl) {
  const queue = [];
  let timer = null;

  function step() {
    const message = queue.shift();
    if (!message) {
      timer = null;
      hostEl.innerHTML = "";
      return;
    }
    hostEl.innerHTML = bubble(message);
    timer = setTimeout(step, SHOW_MS);
  }

  return {
    push(raw) {
      const text = String(raw?.text ?? "").trim().slice(0, MAX_LENGTH);
      if (!text) return;
      queue.push({
        name: String(raw?.name ?? "").trim().slice(0, 40),
        text,
        system: raw?.kind === "system",
      });
      // Keep the newest — an old line nobody has seen yet is worth less than
      // the one that just arrived.
      if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
      if (!timer) step();
    },

    clear() {
      queue.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
      hostEl.innerHTML = "";
    },
  };
}

function bubble({ name, text, system }) {
  if (system) return `<p class="chat-bubble chat-bubble--system">${escapeHtml(text)}</p>`;
  return `
    <p class="chat-bubble">
      <span class="seat__avatar">${escapeHtml(initials(name))}</span>
      <span class="chat-bubble__who">${escapeHtml(name)}</span>
      <span class="chat-bubble__text">${escapeHtml(text)}</span>
    </p>`;
}

/**
 * The composer. Mounted once when the room opens rather than rendered with the
 * deck: `render()` replaces the deck wholesale on every state change, which
 * would wipe half-typed text from under the person typing it.
 */
export function renderChatBar() {
  return `
    <form class="chat-bar" id="chat-bar" autocomplete="off">
      <div class="chat-bar__emoji" role="group" aria-label="Add an emoji">
        ${CHAT_EMOJI.map(
          (emoji) =>
            `<button type="button" data-act="chat-emoji" data-emoji="${escapeHtml(emoji)}"
                     title="Add ${escapeHtml(emoji)}" tabindex="-1">${emoji}</button>`
        ).join("")}
      </div>
      <input class="input chat-bar__input" id="chat-input" maxlength="${MAX_LENGTH}"
             placeholder="Message the room…" aria-label="Message the room">
      <button class="btn btn--sm btn--primary" type="submit">Send</button>
    </form>`;
}
