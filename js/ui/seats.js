/** The table: seats around the felt, the felt itself, and the revealed results. */

import { escapeHtml, initials, formatClock, round } from "../util.js";
import { activeStory, activeVoters, castVotes, isAway, hasSelectedStory } from "../store.js";
import { deckCards } from "../decks.js";
import { computeStats } from "../stats.js";
import { remainingSeconds } from "../timer.js";

const REACTION_TTL_MS = 5000;

export function renderStage(room, ctx) {
  const now = ctx.now || Date.now();
  // The table shows whoever is here right now and has joined the current story.
  // Being connected to the room is not the same as being at the table for it,
  // and someone whose heartbeat has stopped is no longer in the round at all —
  // an empty seat for them just makes the count harder to read.
  const people = Object.values(room.participants)
    .filter(
      (p) =>
        hasSelectedStory(room, p.id) &&
        (!isAway(p, now) || room.votes[p.id] !== undefined)
    )
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const half = Math.ceil(people.length / 2);
  const stats = room.revealed ? computeStats(castVotes(room), deckCards(room)) : null;

  return `
    <div class="seat-row seat-row--top">${people.slice(0, half).map((p) => seat(p, room, ctx, now, stats, "top")).join("")}</div>
    ${felt(room, ctx, now, stats)}
    <div class="seat-row seat-row--bottom">${people.slice(half).map((p) => seat(p, room, ctx, now, stats, "bottom")).join("")}</div>
    ${stats ? results(room, ctx, stats) : ""}`;
}

function seat(person, room, ctx, now, stats, side) {
  const vote = room.votes[person.id];
  const isSpectator = person.role === "spectator";
  // LEAVE (store.js) hard-resets lastSeen to the literal 0 — a deliberate
  // departure, not the vague staleness a heartbeat that just stopped arriving
  // would produce, so it reads as "offline" like a backgrounded tab rather
  // than "away".
  const left = person.lastSeen === 0;
  const away = !left && isAway(person, now);
  const offline = left || (person.online === false && !away);
  const outlier = stats && vote && stats.outliers.includes(vote);
  const showReaction = person.reaction && now - person.reaction.at < REACTION_TTL_MS;

  let cardClass = "seat__card";
  let cardText = isSpectator ? "👁" : "";
  if (!isSpectator && vote !== undefined) {
    cardClass += room.revealed ? " seat__card--revealed" : " seat__card--voted";
    if (room.revealed) cardText = escapeHtml(vote);
    if (person.id === ctx.meId) cardClass += " seat__card--mine";
    if (room.revealed && outlier) cardClass += " seat__card--outlier";
  }

  return `
    <div class="seat seat--${side}${isSpectator ? " seat--spectator" : ""}${
    away ? " seat--away" : offline ? " seat--offline" : ""
  }"
         title="${escapeHtml(person.name)}${offline ? " (offline)" : ""}">
      ${showReaction ? `<span class="seat__reaction">${escapeHtml(person.reaction.emoji)}</span>` : ""}
      <div class="${cardClass}">${cardText}</div>
      <div class="seat__who">
        <span class="seat__avatar">${escapeHtml(initials(person.name))}</span>
        <span class="seat__name">${escapeHtml(person.name)}${
          person.id === room.hostId ? ' <span class="seat__host" title="Host">★</span>' : ""
        }</span>
      </div>
    </div>`;
}

function felt(room, ctx, now, stats) {
  const story = activeStory(room);
  const voters = activeVoters(room, now);
  const votedCount = voters.filter((p) => room.votes[p.id] !== undefined).length;
  const seconds = remainingSeconds(room, now);
  const timerShown = room.timer.running || seconds !== room.timerDuration;

  let inner;
  if (!story) {
    inner = `
      <p class="felt__prompt">No story on the table</p>
      <p class="felt__sub">${ctx.isHost ? "Add one from Jira by key or URL, or write it by hand." : "Waiting for the host to add a story."}</p>
      ${ctx.isHost ? '<button class="btn btn--primary" type="button" data-act="add-story">Add a story</button>' : ""}`;
  } else if (!story.votingEnabled) {
    inner = `
      <p class="felt__prompt">Voting paused for this story</p>
      <p class="felt__sub">The host needs to start voting for participants to cast cards.</p>
      ${
        ctx.isHost
          ? `<button class="btn btn--primary" type="button" data-act="toggle-voting" data-id="${story.id}">Start voting</button>`
          : ""
      }`;
  } else if (room.revealed) {
    inner = `
      <p class="felt__prompt">${
        stats.consensus ? "Consensus 🎉" : stats.suggestion ? `Suggested estimate ${escapeHtml(stats.suggestion)}` : "Cards are on the table"
      }</p>
      <p class="felt__sub">${escapeHtml(summaryLine(stats))}</p>
      <div class="row row--tight">
        ${ctx.isHost ? '<button class="btn btn--primary" type="button" data-act="reset">Vote again</button>' : ""}
        ${ctx.isHost ? '<button class="btn" type="button" data-act="next-story">Next story</button>' : ""}
      </div>`;
  } else {
    inner = `
      <p class="felt__prompt">${
        ctx.isSpectator ? "You are watching this round" : "Pick your card"
      }</p>
      <p class="felt__sub">${votedCount} of ${voters.length} voted${
        room.autoReveal ? " · auto-reveal on" : ""
      }</p>
      ${timerShown ? `<p class="felt__timer${seconds <= 10 ? " felt__timer--low" : ""}">${formatClock(seconds)}</p>` : ""}
      <div class="row row--tight">
        ${
          ctx.isHost
            ? `<button class="btn btn--primary" type="button" data-act="reveal" ${
                votedCount ? "" : "disabled"
              }>Reveal cards</button>`
            : `<span class="felt__sub">${votedCount ? "Waiting for the host to reveal" : ""}</span>`
        }
        ${
          ctx.isHost
            ? `<button class="btn" type="button" data-act="${room.timer.running ? "timer-pause" : "timer-start"}">
                 ${room.timer.running ? "Pause timer" : "Start timer"}
               </button>`
            : ""
        }
      </div>
      ${ctx.isHost ? aiEstimateSuggestion(story, ctx.estimateSuggestion) : ""}`;
  }

  return `<div class="felt"><div class="felt__inner">${inner}</div></div>`;
}

/**
 * A starting-point nudge before the room votes — shown only to whoever asked
 * for it (this is local UI state, not room state), and never applied to a
 * card automatically. The reveal/reason wording makes clear it is a
 * suggestion to weigh, not an answer.
 */
function aiEstimateSuggestion(story, suggestion) {
  if (!suggestion || suggestion.storyId !== story.id) {
    return `<button class="btn btn--ghost btn--sm" type="button" data-act="suggest-estimate" style="margin-top:var(--sp-2)">✨ AI suggestion</button>`;
  }
  if (suggestion.loading) {
    return `<p class="felt__sub" style="margin-top:var(--sp-2)">✨ Thinking…</p>`;
  }
  if (suggestion.error) {
    return `<p class="felt__sub felt__ai-error" style="margin-top:var(--sp-2)">${escapeHtml(suggestion.error)}</p>`;
  }
  return `
    <p class="felt__sub" style="margin-top:var(--sp-2)">
      ✨ AI suggests <span class="chip chip--brand">${escapeHtml(suggestion.value)}</span>
      ${suggestion.reason ? ` — ${escapeHtml(suggestion.reason)}` : ""}
    </p>`;
}

function summaryLine(stats) {
  const bits = [];
  if (stats.average !== null) bits.push(`average ${round(stats.average, 2)}`);
  if (stats.agreement !== null) bits.push(`${stats.agreement}% agreement`);
  bits.push(`${stats.total} vote${stats.total === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

function results(room, ctx, stats) {
  const story = activeStory(room);
  const tallest = Math.max(...stats.distribution.map((d) => d.count), 1);

  return `
    <section class="results" aria-label="Round results">
      <div class="results__stats">
        ${stat("Average", stats.average === null ? "–" : round(stats.average, 2), true)}
        ${stat("Median", stats.median === null ? "–" : round(stats.median, 2))}
        ${stat("Most picked", stats.modes.length ? stats.modes.join(" / ") : "–")}
        ${stat("Range", stats.min === null ? "–" : `${round(stats.min, 2)}–${round(stats.max, 2)}`)}
        ${stat("Agreement", stats.agreement === null ? "–" : `${stats.agreement}%`)}
        ${stat("Voted", `${stats.total}${stats.specials ? ` (+${stats.specials})` : ""}`)}
      </div>

      <div class="panel dist">
        ${stats.distribution
          .map(
            (bucket) => `
          <div class="dist__col${bucket.isTop ? " dist__col--top" : ""}">
            <span class="dist__count">${bucket.count}</span>
            <div class="dist__bar" style="height:${Math.round((bucket.count / tallest) * 45) + 6}px"></div>
            <div class="dist__card">
              ${escapeHtml(bucket.card)}
            </div>
            <span class="dist__voters">${bucket.voters.map((n) => escapeHtml(n)).join(", ")}</span>
          </div>`
          )
          .join("")}
      </div>

      ${story && stats.agreement !== null && stats.agreement < 70 ? disagreementBox(story, ctx.disagreementExplain) : ""}
      ${story ? acceptRow(story, stats, ctx) : ""}
    </section>`;
}

/** Only offered when agreement is actually low — no point asking the AI to explain a round everyone agreed on. */
function disagreementBox(story, explain) {
  if (!explain || explain.storyId !== story.id) {
    return `
      <div style="text-align:center; margin-bottom:var(--sp-3)">
        <button class="btn btn--ghost btn--sm" type="button" data-act="explain-disagreement">✨ Why the spread? (AI)</button>
      </div>`;
  }
  if (explain.loading) {
    return `<p class="hint" style="text-align:center; margin-bottom:var(--sp-3)">✨ Thinking…</p>`;
  }
  if (explain.error) {
    return `<p class="note note--danger" style="margin-bottom:var(--sp-3)">${escapeHtml(explain.error)}</p>`;
  }
  return `
    <div class="note" style="margin-bottom:var(--sp-3); white-space:pre-line">✨ ${escapeHtml(explain.text)}</div>`;
}

function stat(label, value, accent = false) {
  return `
    <div class="stat${accent ? " stat--accent" : ""}">
      <div class="stat__value">${escapeHtml(value)}</div>
      <div class="stat__label">${escapeHtml(label)}</div>
    </div>`;
}

function acceptRow(story, stats, ctx) {
  const suggestion = stats.suggestion;
  return `
    <div class="row row--tight" style="flex-wrap:wrap; justify-content:center">
      ${
        ctx.isOwner && suggestion
          ? `<button class="btn btn--teal" type="button" data-act="accept-estimate" data-value="${escapeHtml(suggestion)}">
               Accept ${escapeHtml(suggestion)} for this story
             </button>`
          : ""
      }
      ${
        ctx.isSpectator
          ? ""
          : `<button class="btn" type="button" data-act="edit-estimate">Change my card</button>`
      }
      ${
        ctx.isOwner
          ? `<button class="btn btn--primary" type="button" data-act="update-points">
               ${story.key ? `Update story point in Jira` : "Update story point"}
             </button>`
          : ""
      }
    </div>`;
}
