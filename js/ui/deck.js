/** The card strip along the bottom of the stage. */

import { escapeHtml } from "../util.js";
import { deckCards, deckLabel } from "../decks.js";
import { activeStory } from "../store.js";

export const REACTIONS = ["👍", "👎", "🎉", "🤔", "☕", "⏱"];

export function renderDeck(room, ctx) {
  const cards = deckCards(room);
  const myVote = room.votes[ctx.meId];
  const story = activeStory(room);
  const isVotingEnabled = Boolean(story?.votingEnabled);
  const locked = ctx.isSpectator || !story || !isVotingEnabled;

  const reason = ctx.isSpectator
    ? "You are a spectator — switch to voting to pick a card."
    : !story
    ? "Put a story on the table first."
    : !isVotingEnabled
    ? "Voting is currently disabled for this story. The host can enable voting to start."
    : room.revealed && myVote !== undefined
    ? `You picked ${myVote}. Click another card to change your vote.`
    : room.revealed
    ? "Cards are revealed. Click a card to cast your vote."
    : myVote !== undefined
    ? `You picked ${myVote}. Click it or another card to change your vote.`
    : "Click a card, or press its number.";

  return `
    <div class="deck__head">
      <span class="eyebrow">${escapeHtml(deckLabel(room))}</span>
      <span class="muted">${escapeHtml(reason)}</span>
      <div class="spacer"></div>
      <div class="reactions" role="group" aria-label="Reactions">
        ${REACTIONS.map(
          (emoji) =>
            `<button type="button" data-act="react" data-emoji="${escapeHtml(emoji)}" title="Send ${escapeHtml(
              emoji
            )}">${emoji}</button>`
        ).join("")}
      </div>
      <button class="btn btn--sm" type="button" data-act="toggle-role">
        ${ctx.isSpectator ? "Join the voting" : "Just watch"}
      </button>
    </div>
    <div class="deck__cards" role="group" aria-label="Estimation cards">
      ${cards.map((card, index) => cardButton(card, index, myVote, locked)).join("")}
    </div>`;
}

function cardButton(card, index, myVote, locked) {
  const shortcut = index < 9 ? String(index + 1) : index === 9 ? "0" : "";
  return `
    <button class="card-btn" type="button" data-act="vote" data-card="${escapeHtml(card)}"
            aria-pressed="${myVote === card}" ${locked ? "disabled" : ""}
            aria-label="Vote ${escapeHtml(card)}">
      ${shortcut ? `<span class="card-btn__key" aria-hidden="true">${shortcut}</span>` : ""}
      ${escapeHtml(card)}
    </button>`;
}
