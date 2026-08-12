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

/** Enough to react with, few enough to scan in one look. */
export const CHAT_EMOJI = [
  "😀", "😄", "😅", "😂", "🙂", "😉", "😍", "🤩",
  "🤔", "😐", "😴", "😮", "😢", "😤", "🤯", "🥳",
  "👍", "👎", "👏", "🙌", "🙏", "💪", "🔥", "💯",
  "🎉", "✅", "❌", "⚠️", "☕", "⏱", "🚀", "🐛",
];

const SHOW_MS = 10000;
const MAX_LENGTH = 140;
/** A flood must not bury the board it is sitting on top of. */
const MAX_VISIBLE = 5;

/**
 * A feed that stacks messages in `hostEl`, newest underneath, each holding its
 * own ten seconds. Several arriving inside one window all stay on screen and
 * then leave independently as their time runs out, so a quick exchange reads as
 * a conversation rather than a slideshow.
 *
 * @param {HTMLElement} hostEl
 */
export function createChatFeed(hostEl) {
  /** @type {{node: HTMLElement, timer: number}[]} oldest first */
  const shown = [];

  function drop(entry) {
    clearTimeout(entry.timer);
    entry.node.remove();
    const index = shown.indexOf(entry);
    if (index >= 0) shown.splice(index, 1);
  }

  return {
    push(raw) {
      const text = String(raw?.text ?? "").trim().slice(0, MAX_LENGTH);
      if (!text) return;

      const holder = document.createElement("div");
      holder.innerHTML = bubble({
        name: String(raw?.name ?? "").trim().slice(0, 40),
        text,
        system: raw?.kind === "system",
      });
      const node = holder.firstElementChild;
      if (!node) return;

      const entry = { node, timer: 0 };
      entry.timer = setTimeout(() => drop(entry), SHOW_MS);
      shown.push(entry);
      hostEl.appendChild(node);

      // Past the cap the oldest goes early — it has been read, and the newest
      // line matters more than a full stack.
      while (shown.length > MAX_VISIBLE) drop(shown[0]);
    },

    clear() {
      while (shown.length) drop(shown[0]);
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
      <div class="chat-bar__field">
        <input class="input chat-bar__input" id="chat-input" maxlength="${MAX_LENGTH}"
               placeholder="Message the room…" aria-label="Message the room">
        <button class="chat-bar__smiley" id="chat-emoji-toggle" type="button" data-act="chat-emoji-toggle"
                aria-expanded="false" aria-controls="chat-emoji-picker" aria-label="Add an emoji"
                title="Add an emoji">🙂</button>
        <div class="chat-bar__picker" id="chat-emoji-picker" role="group" aria-label="Emoji" hidden>
          ${CHAT_EMOJI.map(
            (emoji) =>
              `<button type="button" data-act="chat-emoji" data-emoji="${escapeHtml(emoji)}"
                       title="Add ${escapeHtml(emoji)}">${emoji}</button>`
          ).join("")}
        </div>
      </div>
      <button class="btn btn--sm btn--primary" type="submit">Send</button>
    </form>`;
}

/**
 * Close the picker. Picking an emoji does not call this — the picker stays put
 * so several can be added in a row. Safe to call when there is no composer on
 * screen.
 */
export function closeEmojiPicker() {
  const picker = document.getElementById("chat-emoji-picker");
  const toggle = document.getElementById("chat-emoji-toggle");
  if (picker) picker.hidden = true;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}
