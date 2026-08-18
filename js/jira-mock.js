/**
 * Offline stand-in for Jira.
 *
 * Stores issues in the same shape the real REST API returns, so `toStory` and
 * the ADF renderer are exercised for real. Writes persist to localStorage so a
 * demo survives a reload. Enable it with Mock mode in Settings.
 */

import { toStory, JiraError, DEFAULT_POINTS_FIELD } from "./jira.js";
import { readJson, writeJson } from "./util.js";

const STORE_KEY = "pp:jira-mock";
const LATENCY_MS = 320;

const doc = (...content) => ({ type: "doc", version: 1, content });
const p = (...content) => ({ type: "paragraph", content });
const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const strong = [{ type: "strong" }];
const bullets = (...items) => ({
  type: "bulletList",
  content: items.map((text) => ({ type: "listItem", content: [p(t(text))] })),
});

function seedIssues() {
  return {
    "CUMA-101": issue("CUMA-101", "Refinement board shows sprint capacity", "Story", "In Refinement", 5, doc(
      p(t("As a "), t("scrum master", strong), t(" I want the refinement board to show remaining sprint capacity so the team stops over-committing.")),
      p(t("Acceptance criteria", strong)),
      bullets(
        "Capacity bar is visible above the story list.",
        "Committed points update as estimates are accepted.",
        "Bar turns amber above 90% and red above 100%."
      )
    )),
    "CUMA-102": issue("CUMA-102", "Bulk-update story points from the estimation session", "Story", "To Do", null, doc(
      p(t("Facilitators currently retype every estimate into Jira after the session. Allow the agreed value to be written back in one action.")),
      p(t("Notes", strong)),
      bullets("Field id is configurable per instance.", "Show the value Jira echoes back after writing.")
    )),
    "CUMA-103": issue("CUMA-103", "Carrier tender response times exceed SLA", "Bug", "In Progress", 3, doc(
      p(t("Tender responses from two carriers arrive after the 30 minute SLA. Reproduced on staging with the EU tender set.")),
      { type: "codeBlock", attrs: { language: "text" }, content: [t("tender_id=88213 waited 41m12s\ntender_id=88240 waited 37m03s")] },
      p(t("Expected: escalation fires at 30 minutes."))
    ), MOCK_PEOPLE[1]),
    "CUMA-104": issue("CUMA-104", "Anonymous voting option for estimation rounds", "Story", "To Do", null, doc(
      p(t("Some teams want estimates revealed without names attached so seniority does not anchor the discussion.")),
      bullets("Host toggles anonymity per room.", "Distribution still shows counts.", "Names hidden in the export as well.")
    )),
    "CUMA-105": issue("CUMA-105", "Import backlog by JQL into a refinement session", "Story", "To Do", 8, doc(
      p(t("Pull a whole sprint or filter into the session instead of adding issues one by one.")),
      p(t("Example: "), t("project = CUMA AND sprint in openSprints() ORDER BY rank", [{ type: "code" }]))
    ), MOCK_PEOPLE[2]),
    "CUMA-106": issue("CUMA-106", "Session summary export for the sprint report", "Task", "Done", 2, doc(
      p(t("Export the session as CSV so the estimates and agreement levels can be attached to the sprint report."))
    )),
  };
}

/** A small fixed roster, standing in for whatever Jira's own directory would return. */
const MOCK_PEOPLE = [
  { accountId: "mock-alice", name: "Alice Ng", email: "alice@example.com" },
  { accountId: "mock-ben", name: "Ben Osei", email: "ben@example.com" },
  { accountId: "mock-carla", name: "Carla Reyes", email: "carla@example.com" },
  { accountId: "mock-driss", name: "Driss Amrani", email: "driss@example.com" },
];

function issue(key, summary, type, status, points, description, assignee = null) {
  return {
    key,
    fields: {
      summary,
      description,
      status: { name: status },
      issuetype: { name: type },
      priority: { name: "Medium" },
      assignee: assignee ? { accountId: assignee.accountId, displayName: assignee.name } : null,
      labels: type === "Bug" ? ["logistics", "sla"] : ["refinement"],
      [DEFAULT_POINTS_FIELD]: points,
    },
  };
}

function db() {
  const stored = readJson(STORE_KEY);
  if (stored && typeof stored === "object" && Object.keys(stored).length) return stored;
  const fresh = seedIssues();
  writeJson(STORE_KEY, fresh);
  return fresh;
}

function persist(issues) {
  writeJson(STORE_KEY, issues);
}

const wait = () => new Promise((resolve) => setTimeout(resolve, LATENCY_MS));

/** Keys available in mock mode, shown as hints in the UI. */
export function mockKeys() {
  return Object.keys(db());
}

export async function getIssue(key, config) {
  await wait();
  const issues = db();
  const found = issues[key];
  if (!found) {
    throw new JiraError(
      `Mock Jira has no issue ${key}. Available: ${Object.keys(issues).join(", ")}.`,
      { status: 404, kind: "not-found" }
    );
  }
  return toStory(withPointsField(found, config), config);
}

export async function updateStoryPoints(key, value, config) {
  await wait();
  const issues = db();
  const found = issues[key];
  if (!found) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  if (typeof value !== "number") {
    // Mirrors what a real numeric custom field does with a text value.
    throw new JiraError(
      `${config.pointsField}: Operation value must be a number (mock Jira rejected "${value}").`,
      { status: 400, kind: "invalid" }
    );
  }
  found.fields[DEFAULT_POINTS_FIELD] = value;
  persist(issues);
  return { key, points: value };
}

export async function addComment(key, text) {
  await wait();
  const issues = db();
  const found = issues[key];
  if (!found) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  found.fields.comments = [...(found.fields.comments || []), { text, at: Date.now() }];
  persist(issues);
}

/** A small linear workflow, just enough to exercise "only some moves are legal from here". */
const WORKFLOW = {
  "In Refinement": [{ id: "21", name: "Ready for sprint", toStatus: "To Do" }],
  "To Do": [{ id: "11", name: "Start progress", toStatus: "In Progress" }],
  "In Progress": [
    { id: "31", name: "Stop progress", toStatus: "To Do" },
    { id: "32", name: "Done", toStatus: "Done" },
  ],
  Done: [{ id: "41", name: "Reopen", toStatus: "To Do" }],
};

export async function getTransitions(key) {
  await wait();
  const found = db()[key];
  if (!found) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  return WORKFLOW[found.fields.status.name] || [];
}

export async function applyTransition(key, transitionId) {
  await wait();
  const issues = db();
  const found = issues[key];
  if (!found) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  const chosen = (WORKFLOW[found.fields.status.name] || []).find((t) => t.id === transitionId);
  if (!chosen) {
    throw new JiraError(`That transition is no longer available for ${key}.`, { status: 400, kind: "invalid" });
  }
  found.fields.status = { name: chosen.toStatus };
  persist(issues);
  return chosen.toStatus;
}

export async function searchAssignableUsers(key, query = "") {
  await wait();
  if (!db()[key]) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  const text = query.trim().toLowerCase();
  return MOCK_PEOPLE.filter((p) => !text || p.name.toLowerCase().includes(text) || p.email.toLowerCase().includes(text)).map(
    (p) => ({ accountId: p.accountId, name: p.name, email: p.email, avatarUrl: "" })
  );
}

export async function setAssignee(key, accountId) {
  await wait();
  const issues = db();
  const found = issues[key];
  if (!found) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  if (!accountId) {
    found.fields.assignee = null;
  } else {
    const person = MOCK_PEOPLE.find((p) => p.accountId === accountId);
    if (!person) throw new JiraError(`Mock Jira has no such person.`, { status: 400, kind: "invalid" });
    found.fields.assignee = { accountId: person.accountId, displayName: person.name };
  }
  persist(issues);
}

/** One board's worth of sprints, shared across every mock project — enough to exercise "pick one". */
const MOCK_SPRINTS = [
  { id: 1, name: "Sprint 24", state: "active" },
  { id: 2, name: "Sprint 25", state: "future" },
  { id: 3, name: "Sprint 26", state: "future" },
];

export async function getIssueSprint(key) {
  await wait();
  const found = db()[key];
  if (!found) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  const sprintId = found.fields.sprintId;
  return sprintId ? MOCK_SPRINTS.find((s) => s.id === sprintId) || null : null;
}

export async function listSprints() {
  await wait();
  return MOCK_SPRINTS;
}

export async function setSprint(key, sprintId) {
  await wait();
  const issues = db();
  const found = issues[key];
  if (!found) throw new JiraError(`Mock Jira has no issue ${key}.`, { status: 404, kind: "not-found" });
  if (sprintId && !MOCK_SPRINTS.some((s) => s.id === sprintId)) {
    throw new JiraError("Mock Jira has no such sprint.", { status: 400, kind: "invalid" });
  }
  found.fields.sprintId = sprintId || null;
  persist(issues);
}

export async function searchIssues(jql, config, maxResults = 25) {
  await wait();
  const issues = Object.values(db());
  const projectMatch = String(jql || "").match(/project\s*=\s*"?([A-Za-z][A-Za-z0-9_]*)"?/i);
  const project = projectMatch ? projectMatch[1].toUpperCase() : null;
  const doneWanted = /status\s*=\s*"?done"?/i.test(jql);
  return issues
    .filter((entry) => (project ? entry.key.startsWith(`${project}-`) : true))
    .filter((entry) => (doneWanted ? entry.fields.status.name === "Done" : true))
    .slice(0, maxResults)
    .map((entry) => toStory(withPointsField(entry, config), config));
}

/** Mirrors the real Backlog screen: open issues not yet pulled into a sprint, in rank order. */
export async function projectBacklog(projectKey, config) {
  await wait();
  const project = String(projectKey || "").toUpperCase();
  return Object.entries(db())
    .filter(([key]) => key.startsWith(`${project}-`))
    .filter(([, entry]) => entry.fields.status.name !== "Done" && !entry.fields.sprintId)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, entry]) => toStory(withPointsField(entry, config), config));
}

export async function listProjects() {
  await wait();
  const seen = new Set(Object.keys(db()).map((key) => key.split("-")[0]));
  const named = { CUMA: "CUMA — Customer Master Data" };
  const projects = Array.from(seen).map((key) => ({ id: key, key, name: named[key] || key }));
  // A couple with no seeded issues, so the "nothing open here" empty state in
  // the backlog picker has something to show against too.
  projects.push({ id: "ECLIPSE", key: "ECLIPSE", name: "ECLIPSE — Platform" });
  projects.push({ id: "DEMO", key: "DEMO", name: "DEMO — Sandbox" });
  return projects;
}

export async function listFields() {
  await wait();
  return [
    { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
    { id: DEFAULT_POINTS_FIELD, name: "Story Points", custom: true, schema: { type: "number" } },
    { id: "customfield_10026", name: "Story point estimate", custom: true, schema: { type: "number" } },
    { id: "customfield_10020", name: "Sprint", custom: true, schema: { type: "array" } },
  ];
}

export async function testConnection() {
  await wait();
  return { name: "Mock user (offline)", accountId: "mock-account" };
}

/**
 * The mock keeps points under the default field id; copy it to whichever field
 * the user configured so mapping behaves as it would against real Jira.
 */
function withPointsField(entry, config) {
  const field = config?.pointsField || DEFAULT_POINTS_FIELD;
  if (field === DEFAULT_POINTS_FIELD) return entry;
  return {
    ...entry,
    fields: { ...entry.fields, [field]: entry.fields[DEFAULT_POINTS_FIELD] },
  };
}
