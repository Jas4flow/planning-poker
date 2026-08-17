/**
 * Client for the ai-proxy Edge Function (supabase/functions/ai-proxy) — every
 * AI feature in the app goes through here. The NVIDIA key lives only in that
 * function's server-side secrets; nothing here ever holds or sends one.
 *
 * These are nudges, not authorities: every result is shown as a suggestion
 * the room can take or ignore, never applied on its own.
 */

import { client } from "./supabase.js";

export class AiError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiError";
  }
}

async function ask(messages, { maxTokens } = {}) {
  const supabase = await client();
  const { data, error } = await supabase.functions.invoke("ai-proxy", {
    body: { messages, maxTokens },
  });
  if (error) {
    throw new AiError(error.message || "Could not reach the AI service.");
  }
  if (data?.error) throw new AiError(data.error);
  const text = data?.text;
  if (!text) throw new AiError("The AI service returned an empty response.");
  return text;
}

const SYSTEM_ESTIMATE =
  "You help a Scrum team estimate story points before they vote. Read the story and reply with ONLY a compact " +
  "JSON object: {\"value\": \"<one card from the given deck>\", \"reason\": \"<one short sentence>\"}. Pick the " +
  "single closest card from the deck list provided — never invent a value outside it. " +
  "If past estimated stories are given, calibrate against them — a guess grounded in this team's own past sizing " +
  "beats one from general judgement alone, so lean on the closest comparable rather than picking in a vacuum. " +
  "No prose outside the JSON.";

/**
 * A starting-point suggestion before the room votes — never auto-applied.
 * `pastStories` (this room's own already-estimated stories, most recent
 * first) grounds the guess in how this specific team actually sizes things,
 * rather than a generic judgement call with nothing to calibrate against.
 */
export async function suggestEstimate({ title, description, deckCards, pastStories = [] }) {
  const examples = pastStories
    .slice(0, 8)
    .map((s) => `- "${s.title}" → ${s.points}`)
    .join("\n");
  const prompt =
    `Deck (pick exactly one of these): ${deckCards.join(", ")}\n\n` +
    (examples ? `This team's own past estimates, for calibration:\n${examples}\n\n` : "") +
    `Story to estimate: ${title}\n\n${description || "(no description)"}`;
  const raw = await ask([
    { role: "system", content: SYSTEM_ESTIMATE },
    { role: "user", content: prompt },
  ]);
  let parsed;
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
  } catch {
    throw new AiError("Could not make sense of the AI's suggestion — try again.");
  }
  const value = String(parsed.value ?? "").trim();
  if (!deckCards.includes(value)) {
    throw new AiError(`The AI suggested "${value}", which isn't a card in this deck.`);
  }
  return { value, reason: String(parsed.reason ?? "").trim() };
}

/** A short stand-in for a long Jira description, shown collapsed above the full text. */
export async function summarizeDescription({ title, descriptionText }) {
  return ask([
    {
      role: "system",
      content:
        "Summarize a Jira story for someone about to estimate it, in 2-3 short sentences: what it is and why it " +
        "matters. Plain text, no markdown, no preamble like \"This story is about\".",
    },
    { role: "user", content: `${title}\n\n${descriptionText || "(no description)"}` },
  ]);
}

/** Why a round's votes might have spread out, to focus the re-discussion — only called on low agreement. */
export async function explainDisagreement({ title, description, distribution }) {
  const dist = distribution.map((d) => `${d.card}: ${d.voters.join(", ") || d.count}`).join("; ");
  return ask([
    {
      role: "system",
      content:
        "A planning-poker round had low agreement. Suggest 2-3 short, concrete possible reasons for the spread, " +
        "grounded in the story text where you can (ambiguity, hidden scope, unknowns) — not generic estimation " +
        "advice. Plain text, one reason per line, no numbering.",
    },
    { role: "user", content: `Story: ${title}\n\n${description || "(no description)"}\n\nVotes: ${dist}` },
  ]);
}

/** A short writeup of a round's outcome, offered as the Jira comment when writing the estimate back. */
export async function summarizeRound({ title, points, average, agreement, votes }) {
  const voteList = votes.map((v) => `${v.name}: ${v.card}`).join(", ");
  return ask([
    {
      role: "system",
      content:
        "Write a short Jira comment (2-4 sentences, plain text, no markdown) recording a planning-poker round's " +
        "outcome: the agreed estimate, and anything notable about how the group got there. Neutral, factual tone.",
    },
    {
      role: "user",
      content: `Story: ${title}\nAgreed estimate: ${points}\nAverage: ${average ?? "n/a"}\nAgreement: ${
        agreement ?? "n/a"
      }%\nVotes: ${voteList}`,
    },
  ]);
}

/*
 * Natural-language command bar. Deliberately a small, fixed action set the
 * model chooses from — never free-form code or arbitrary state changes —
 * and the app (not the model) does the actual work once a person confirms.
 * Add a new supported action here as its own case, not by loosening this
 * into "do anything the model says".
 */
const SUPPORTED_ACTIONS = ["import_all_backlog", "remove_story", "change_status", "change_assignee"];

const SYSTEM_COMMAND = `You turn one sentence into exactly one app action, or say it isn't supported yet.
Reply with ONLY a compact JSON object, no prose outside it.

Supported actions:
- "import_all_backlog": add every open (not-done) issue from a Jira project's backlog into the room.
  Args: { "projectKey": "<the project key, e.g. CUMA>" }.
  If the sentence names a project key or a name matching one of the known projects, use it.
  If it names none and exactly one project is given as the default, use that default.
  If it names none and there is no default, respond unsupported and ask which project.
- "remove_story": remove one story from the room's current backlog (below).
  Args: { "storyQuery": "<copied EXACTLY from the backlog list below — its key or its title, verbatim, do not paraphrase or shorten it>" }.
- "change_status": move one story to a different Jira status.
  Args: { "storyQuery": "<same as above>", "statusName": "<the plain status name they asked for, e.g. \"Done\", \"In Progress\" — not a transition button label>" }.
- "change_assignee": assign one story to someone in Jira.
  Args: { "storyQuery": "<same as above>", "personName": "<the name they said, as said>" }.
For remove_story/change_status/change_assignee, only use a storyQuery that actually appears in the backlog list given below — never invent or guess one.

For a supported action, reply: {"action": "<name>", "args": {...}, "confirm": "<one short yes/no question describing exactly what will happen>"}
For anything else (including a request that doesn't map to a supported action, names a story not in the given backlog, or is missing required info): {"action": "unsupported", "message": "<one short sentence explaining what's missing or that this isn't supported yet>"}`;

/**
 * @param {string} text - what the person typed
 * @param {{projects: {key:string,name:string}[], defaultProjectKey?: string, stories?: {key:string,title:string}[], history?: {role:string, content:string}[]}} context
 *   `history` is prior chat turns (plain {role, content} pairs, oldest first)
 *   so a follow-up like "CUMA" after the AI asked "which project?" resolves
 *   using the earlier turn instead of being judged on its own. `stories` is
 *   the room's current backlog, so the model can only ever name a story that
 *   is actually there — the app still re-resolves storyQuery itself rather
 *   than trusting this, since the model can hallucinate a plausible-looking
 *   one anyway.
 */
export async function interpretCommand(text, { projects, defaultProjectKey, stories = [], history = [] }) {
  const known = projects.map((p) => `${p.key} (${p.name})`).join(", ") || "(none)";
  const backlog = stories.map((s) => (s.key ? `${s.key}: ${s.title}` : s.title)).join("\n") || "(empty)";
  const prompt =
    `Known projects: ${known}\n` +
    `Default project if none is named: ${defaultProjectKey || "(none)"}\n\n` +
    `Current backlog stories:\n${backlog}\n\n` +
    `Sentence: "${text}"`;
  const raw = await ask([
    { role: "system", content: SYSTEM_COMMAND },
    ...history,
    { role: "user", content: prompt },
  ]);
  let parsed;
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
  } catch {
    throw new AiError("Could not make sense of the AI's response — try rephrasing.");
  }
  if (parsed.action === "unsupported" || !SUPPORTED_ACTIONS.includes(parsed.action)) {
    return { action: "unsupported", message: String(parsed.message || "That isn't supported yet.") };
  }
  if (parsed.action === "import_all_backlog") {
    const projectKey = String(parsed.args?.projectKey || "").toUpperCase();
    if (!projectKey || !projects.some((p) => p.key === projectKey)) {
      return { action: "unsupported", message: "Which project? Name one, e.g. \"add all backlog stories for CUMA\"." };
    }
    return { action: "import_all_backlog", projectKey, confirm: String(parsed.confirm || `Add every open issue in ${projectKey}?`) };
  }
  if (parsed.action === "remove_story") {
    const storyQuery = String(parsed.args?.storyQuery || "").trim();
    if (!storyQuery) return { action: "unsupported", message: "Which story? Name its title or key." };
    return { action: "remove_story", storyQuery };
  }
  if (parsed.action === "change_status") {
    const storyQuery = String(parsed.args?.storyQuery || "").trim();
    const statusName = String(parsed.args?.statusName || "").trim();
    if (!storyQuery || !statusName) return { action: "unsupported", message: "Which story, and which status?" };
    return { action: "change_status", storyQuery, statusName };
  }
  if (parsed.action === "change_assignee") {
    const storyQuery = String(parsed.args?.storyQuery || "").trim();
    const personName = String(parsed.args?.personName || "").trim();
    if (!storyQuery || !personName) return { action: "unsupported", message: "Which story, and assign to whom?" };
    return { action: "change_assignee", storyQuery, personName };
  }
  return { action: "unsupported", message: "That isn't supported yet." };
}
