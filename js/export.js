/** Session exports: CSV for spreadsheets, JSON for anything else. */

import { deckCards, deckLabel } from "./decks.js";
import { computeStats } from "./stats.js";
import { download } from "./util.js";

const COLUMNS = [
  "Jira key",
  "Title",
  "Status",
  "Final estimate",
  "Points in Jira",
  "Rounds",
  "Average",
  "Median",
  "Agreement %",
  "Last round votes",
  "Synced to Jira",
];

export function toCsv(room) {
  const cards = deckCards(room);
  const rows = [COLUMNS];

  for (const story of room.stories) {
    const last = story.rounds[story.rounds.length - 1];
    const stats = last ? statsForRound(last, cards) : null;
    rows.push([
      story.key || "",
      story.title,
      story.status,
      story.finalEstimate ?? "",
      story.jiraPoints ?? "",
      story.rounds.length,
      stats?.average ?? "",
      stats?.median ?? "",
      stats?.agreement ?? "",
      last ? Object.entries(last.votes).map(([name, card]) => `${name}=${card}`).join(" | ") : "",
      story.jiraSyncedAt ? new Date(story.jiraSyncedAt).toISOString() : "",
    ]);
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function statsForRound(round, cards) {
  const votes = Object.entries(round.votes || {}).map(([name, card]) => ({ name, card }));
  return computeStats(votes, cards);
}

export function toJson(room) {
  const cards = deckCards(room);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      room: { id: room.id, name: room.name, deck: deckLabel(room), cards },
      participants: Object.values(room.participants).map(({ id, name, role }) => ({ id, name, role })),
      stories: room.stories.map((story) => ({
        key: story.key,
        url: story.url,
        title: story.title,
        status: story.status,
        finalEstimate: story.finalEstimate,
        jiraPoints: story.jiraPoints,
        jiraSyncedAt: story.jiraSyncedAt ? new Date(story.jiraSyncedAt).toISOString() : null,
        rounds: story.rounds.map((round) => ({
          round: round.round,
          at: new Date(round.at).toISOString(),
          votes: round.votes,
          stats: summarize(statsForRound(round, cards)),
        })),
      })),
    },
    null,
    2
  );
}

function summarize(stats) {
  if (!stats) return null;
  const { average, median, min, max, modes, agreement, consensus, countedTotal } = stats;
  return { average, median, min, max, modes, agreement, consensus, voters: countedTotal };
}

function fileStem(room) {
  const slug = String(room.name || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "session";
  return `planning-poker-${slug}-${new Date().toISOString().slice(0, 10)}`;
}

export function downloadCsv(room) {
  download(`${fileStem(room)}.csv`, toCsv(room), "text/csv");
}

export function downloadJson(room) {
  download(`${fileStem(room)}.json`, toJson(room), "application/json");
}
