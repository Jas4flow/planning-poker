/** Sidebar: the story on the table, the backlog, people, and round history. */

import { escapeHtml, initials, formatTime, round } from "../util.js";
import { activeStory, isAway, hasSelectedStory } from "../store.js";
import { deckCards, DECK_LIST } from "../decks.js";
import { computeStats } from "../stats.js";

export function renderStoryPanel(room, ctx) {
  const story = activeStory(room);
  return `
    ${story ? storyNow(story, ctx, room) : `<p class="empty">Nothing on the table yet.</p>`}

    <div>
      <div class="side__section-title">
        Backlog
        <span class="chip">${openStories(room).length}</span>
        ${
          archivedStories(room).length
            ? `<span class="chip chip--ok" title="Written to Jira — see the History tab">${
                archivedStories(room).length
              } done</span>`
            : ""
        }
        <div class="spacer"></div>
        <span class="chip chip--teal">${estimatedTotal(room)} pts</span>
      </div>
      ${
        openStories(room).length
          ? `<ul class="story-list">${openStories(room).map((s) => storyRow(s, room, ctx)).join("")}</ul>`
          : `<p class="empty">${
              archivedStories(room).length
                ? "Every story is estimated and written to Jira. They are in the History tab."
                : "Add the story you are about to estimate."
            }</p>`
      }
    </div>

    ${
      ctx.isHost
        ? `<div class="row row--tight" style="flex-wrap:wrap">
             <button class="btn btn--sm btn--primary" type="button" data-act="add-story">Add from Jira</button>
             <button class="btn btn--sm" type="button" data-act="add-story-manual">Add by hand</button>
             <button class="btn btn--sm" type="button" data-act="import-jql">Import by JQL</button>
           </div>`
        : ""
    }

    <div class="row row--tight">
      <button class="btn btn--sm btn--ghost" type="button" data-act="export-csv">Export CSV</button>
      <button class="btn btn--sm btn--ghost" type="button" data-act="export-json">Export JSON</button>
    </div>`;
}

function storyNow(story, ctx, room) {
  return `
    <article class="story-now">
      <div class="story-now__key">
        ${story.key ? escapeHtml(story.key) : "MANUAL STORY"}
        ${
          story.url && /^https?:/i.test(story.url)
            ? `<a href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">open in Jira ↗</a>`
            : ""
        }
        <div class="spacer"></div>
        ${
          story.jiraStatus
            ? ctx.isOwner && story.key
              ? `<button class="chip chip--teal chip--btn" type="button" data-act="change-status"
                   title="Change status in Jira">${escapeHtml(story.jiraStatus)} ▾</button>`
              : `<span class="chip chip--teal">${escapeHtml(story.jiraStatus)}</span>`
            : ""
        }
        ${
          story.finalEstimate !== null && story.finalEstimate !== undefined
            ? `<span class="points">${escapeHtml(story.finalEstimate)}</span>`
            : `<span class="points points--pending">–</span>`
        }
      </div>
      <h2 class="story-now__title">${escapeHtml(story.title)}</h2>
      ${
        story.description
          ? `<div class="story-desc">${story.description}</div>`
          : `<p class="hint">No description.</p>`
      }
      ${
        story.jiraSyncedAt
          ? `<p class="note note--ok">Story points ${escapeHtml(String(story.jiraPoints))} written to Jira at ${formatTime(
              story.jiraSyncedAt
            )}${story.jiraSyncedBy ? ` by ${escapeHtml(story.jiraSyncedBy)}` : ""}.</p>`
          : ""
      }
      <div class="row row--tight" style="flex-wrap:wrap">
        ${
          ctx.isHost
            ? `<button class="btn btn--sm ${story.votingEnabled ? "btn--warn" : "btn--primary"}" type="button" data-act="toggle-voting" data-id="${story.id}">
                 ${story.votingEnabled ? "Pause voting" : "Start voting"}
               </button>`
            : `<span class="chip ${story.votingEnabled ? "chip--ok" : "chip--warn"}">
                 ${story.votingEnabled ? "Voting open" : "Voting paused"}
               </span>`
        }
        ${
          !hasSelectedStory(room, ctx.meId)
            ? `<button class="btn btn--sm btn--primary" type="button" data-act="select-story" data-id="${story.id}">Join here</button>`
            : ""
        }
        ${
          ctx.isOwner
            ? `<button class="btn btn--sm btn--primary" type="button" data-act="update-points">Update story point</button>`
            : ""
        }
        ${
          story.key && ctx.isOwner
            ? `<button class="btn btn--sm" type="button" data-act="refresh-story">Refresh from Jira</button>`
            : ""
        }
        ${
          ctx.isOwner
            ? `<button class="btn btn--sm btn--ghost" type="button" data-act="edit-story">Edit</button>`
            : ""
        }
      </div>
      ${ctx.isHost ? "" : `<p class="hint">Anyone can write the agreed estimate back to Jira with their own credentials.</p>`}
    </article>`;
}

function storyRow(story, room, ctx) {
  const isActive = story.id === room.activeStoryId;
  return `
    <li class="story-item${isActive ? " story-item--active" : ""}${
    story.status === "estimated" ? " story-item--estimated" : ""
  }" data-id="${story.id}">
      <button class="story-item__drag" type="button" data-drag-handle data-id="${story.id}"
              aria-label="Drag to reorder ${escapeHtml(story.title)}" title="Drag to reorder">⠿</button>
      <button class="story-item__pick" type="button" data-act="set-active-story" data-id="${story.id}"
              aria-label="Put ${escapeHtml(story.title)} on the table" title="Put on the table">${isActive ? "●" : ""}</button>
      <div class="story-item__main">
        <div class="story-item__title">${escapeHtml(story.title)}</div>
        <div class="story-item__meta">
          ${story.key ? `<span>${escapeHtml(story.key)}</span>` : "<span>manual</span>"}
          ${story.jiraStatus ? `<span class="chip chip--teal" style="font-size:10px;padding:1px 5px">${escapeHtml(story.jiraStatus)}</span>` : ""}
          ${story.votingEnabled ? '<span class="chip chip--ok" style="font-size:10px;padding:1px 5px">voting open</span>' : ""}
          ${story.rounds.length ? `<span>· ${story.rounds.length} round${story.rounds.length === 1 ? "" : "s"}</span>` : ""}
          ${story.jiraSyncedAt ? "<span>· synced</span>" : ""}
        </div>
      </div>
      <div class="story-item__actions">
        ${
          ctx?.isHost
            ? `<button type="button" data-act="toggle-voting" data-id="${story.id}"
                       title="${story.votingEnabled ? "Pause voting" : "Start voting"}"
                       style="font-size:11px;padding:2px 6px">
                 ${story.votingEnabled ? "Pause" : "Vote"}
               </button>`
            : ""
        }
        <span class="${
          story.finalEstimate === null || story.finalEstimate === undefined ? "points points--pending" : "points"
        }">${
    story.finalEstimate === null || story.finalEstimate === undefined ? "–" : escapeHtml(story.finalEstimate)
  }</span>
        <button type="button" data-act="move-story" data-id="${story.id}" data-direction="up" aria-label="Move up" title="Move up">↑</button>
        <button type="button" data-act="move-story" data-id="${story.id}" data-direction="down" aria-label="Move down" title="Move down">↓</button>
        <button type="button" data-act="delete-story" data-id="${story.id}" aria-label="Remove" title="Remove">×</button>
      </div>
    </li>`;
}

/** Stories still up for estimation. Synced ones move out to the history. */
export function openStories(room) {
  return room.stories.filter((story) => story.status !== "archived");
}

export function archivedStories(room) {
  return room.stories.filter((story) => story.status === "archived");
}

function estimatedTotal(room) {
  return room.stories.reduce((sum, story) => {
    const value = Number(story.finalEstimate);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

/* ---------- People ---------- */

export function renderPeoplePanel(room, ctx) {
  const now = ctx.now || Date.now();
  // A backgrounded tab throttles its heartbeat and looks "away" within
  // seconds — that is normal, and personRow already renders an "away" badge
  // for it. Filtering them out here instead made someone who just switched
  // tabs look like they had left the room entirely.
  const people = Object.values(room.participants).sort((a, b) => a.joinedAt - b.joinedAt);

  return `
    <div>
      <div class="side__section-title">Invite</div>
      <div class="row row--tight">
        <input class="input" id="invite-link" readonly value="${escapeHtml(ctx.inviteUrl)}" aria-label="Invite link">
        <button class="btn" type="button" data-act="copy-invite">Copy</button>
      </div>
      <p class="hint" style="margin-top:8px">
        Everyone opening this link in this browser joins the same room. Sync is per browser — see the README for
        adding a server.
      </p>
    </div>

    <div>
      <div class="side__section-title">In the room <span class="chip">${people.length}</span></div>
      <ul class="people">
        ${people.map((person) => personRow(person, room, ctx, now)).join("")}
      </ul>
    </div>

    ${ctx.isHost ? hostControls(room) : `<p class="hint">${escapeHtml(hostName(room))} is hosting this session.</p>`}`;
}

function personRow(person, room, ctx, now) {
  const away = isAway(person, now);
  // A backgrounded/minimized tab, not yet stale enough to count as away —
  // set instantly by the visibilitychange listener in app.js, not by a
  // heartbeat timeout.
  const offline = person.online === false && !away;
  const voted = room.votes[person.id] !== undefined;
  return `
    <li class="person${away ? " person--away" : offline ? " person--offline" : ""}">
      <span class="seat__avatar">${escapeHtml(initials(person.name))}</span>
      <span class="person__name">
        ${escapeHtml(person.name)}${person.id === ctx.meId ? " (you)" : ""}
        ${person.id === room.hostId ? '<span class="seat__host" title="Host">★</span>' : ""}
      </span>
      ${
        person.role === "spectator"
          ? '<span class="chip">watching</span>'
          : voted
          ? `<span class="chip chip--ok">${room.revealed ? escapeHtml(room.votes[person.id]) : "voted"}</span>`
          : `<span class="chip${away || offline ? "" : " chip--warn"}">${
              away ? "away" : offline ? "offline" : "thinking"
            }</span>`
      }
      <span class="person__actions">
        ${
          ctx.isHost && person.id !== ctx.meId
            ? `<button class="btn btn--sm btn--ghost" type="button" data-act="make-host" data-id="${person.id}" title="Make host">★</button>
               <button class="btn btn--sm btn--ghost" type="button" data-act="kick" data-id="${person.id}" title="Remove from room">×</button>`
            : ""
        }
        ${
          person.id === ctx.meId
            ? `<button class="btn btn--sm btn--ghost" type="button" data-act="rename-me" title="Change your name">✎</button>`
            : ""
        }
      </span>
    </li>`;
}

function hostName(room) {
  return room.participants[room.hostId]?.name || "Nobody";
}

function hostControls(room) {
  return `
    <div class="stack stack--tight">
      <div class="side__section-title">Host controls</div>

      <div class="field">
        <label for="deck-select">Deck</label>
        <select class="select" id="deck-select" data-act="change-deck">
          ${DECK_LIST.map(
            (deck) =>
              `<option value="${deck.id}" ${deck.id === room.deckId ? "selected" : ""}>${escapeHtml(deck.label)}</option>`
          ).join("")}
        </select>
      </div>

      <label class="check">
        <input type="checkbox" data-act="toggle-auto-reveal" ${room.autoReveal ? "checked" : ""}>
        <span>Reveal automatically once everyone has voted</span>
      </label>

      <label class="check">
        <input type="checkbox" data-act="toggle-timer-reveal" ${room.revealOnTimerEnd ? "checked" : ""}>
        <span>Reveal when the timer runs out</span>
      </label>

      <div class="field">
        <label for="timer-duration">Round timer (seconds)</label>
        <input class="input" id="timer-duration" type="number" min="10" max="3600" step="5"
               value="${room.timerDuration}" data-act="set-timer-duration">
      </div>

      <div class="row row--tight" style="flex-wrap:wrap">
        <button class="btn btn--sm" type="button" data-act="rename-room">Rename room</button>
        <button class="btn btn--sm" type="button" data-act="timer-reset">Reset timer</button>
        <button class="btn btn--sm btn--danger" type="button" data-act="clear-room">Clear session</button>
      </div>
    </div>`;
}

/* ---------- History ---------- */

export function renderHistoryPanel(room, ctx) {
  const cards = deckCards(room);
  const done = archivedStories(room);
  const stories = room.stories.filter((story) => story.rounds.length);

  if (!stories.length && !done.length) {
    return `<p class="empty">Estimated stories land here once their points are written to Jira.</p>`;
  }

  const written = done.length
    ? `<div>
         <div class="side__section-title">
           Written to Jira <span class="chip chip--ok">${done.length}</span>
           <div class="spacer"></div>
           <span class="chip chip--teal">${done.reduce(
             (sum, s) => sum + (Number(s.finalEstimate) || 0),
             0
           )} pts</span>
         </div>
         <ul class="story-list">
           ${done
             .map(
               (story) => `
             <li class="story-item story-item--estimated">
               <span class="story-item__pick" aria-hidden="true">✓</span>
               <div class="story-item__main">
                 <div class="story-item__title">${escapeHtml(story.title)}</div>
                 <div class="story-item__meta">
                   ${story.key ? `<span>${escapeHtml(story.key)}</span>` : "<span>manual</span>"}
                   ${story.jiraSyncedAt ? `<span>· ${formatTime(story.jiraSyncedAt)}</span>` : ""}
                   ${story.jiraSyncedBy ? `<span>· by ${escapeHtml(story.jiraSyncedBy)}</span>` : ""}
                 </div>
               </div>
               <div class="story-item__actions">
                 <span class="points">${escapeHtml(story.finalEstimate ?? "–")}</span>
                 ${
                   ctx?.isOwner
                     ? `<button type="button" data-act="update-points-history" data-id="${story.id}"
                         aria-label="Update ${escapeHtml(story.title)}'s story point in Jira"
                         title="Update story point in Jira">✎</button>`
                     : ""
                 }
                 <button type="button" data-act="restore-story" data-id="${story.id}"
                         aria-label="Put ${escapeHtml(story.title)} back on the story board"
                         title="Put back on the story board">↩</button>
               </div>
             </li>`
             )
             .join("")}
         </ul>
       </div>`
    : "";

  if (!stories.length) return written;

  return (
    written +
    stories
    .slice()
    .reverse()
    .map((story) => {
      const rows = story.rounds
        .slice()
        .reverse()
        .map((entry) => {
          const votes = Object.entries(entry.votes || {}).map(([name, card]) => ({ name, card }));
          const stats = computeStats(votes, cards);
          return `
            <div class="log__row">
              <span class="log__when">${formatTime(entry.at)}</span>
              <span>
                <strong>Round ${entry.round}</strong> —
                ${stats.average === null ? "no numbers" : `avg ${round(stats.average, 2)}`},
                ${stats.agreement === null ? "–" : `${stats.agreement}%`} agreement<br>
                <span class="muted">${votes
                  .map((v) => `${escapeHtml(v.name)}: ${escapeHtml(v.card)}`)
                  .join(" · ")}</span>
              </span>
            </div>`;
        })
        .join("");

      const isOnBoard = story.status !== "archived" && story.id === room.activeStoryId;
      return `
        <div>
          <div class="side__section-title">
            ${story.key ? `${escapeHtml(story.key)} · ` : ""}${escapeHtml(story.title)}
            <div class="spacer"></div>
            ${
              story.finalEstimate !== null && story.finalEstimate !== undefined
                ? `<span class="points">${escapeHtml(story.finalEstimate)}</span>`
                : ""
            }
            ${
              ctx?.isOwner
                ? `<button class="btn btn--icon" type="button" data-act="update-points-history" data-id="${story.id}"
                     aria-label="Update ${escapeHtml(story.title)}'s story point in Jira"
                     title="Update story point in Jira">✎</button>`
                : ""
            }
            ${
              !isOnBoard
                ? `<button class="btn btn--icon" type="button"
                     data-act="${story.status === "archived" ? "restore-story" : "set-active-story"}" data-id="${story.id}"
                     aria-label="Put ${escapeHtml(story.title)} back on the story board"
                     title="Put back on the story board">↩</button>`
                : ""
            }
          </div>
          <div class="log">${rows}</div>
        </div>`;
      })
      .join("")
  );
}
