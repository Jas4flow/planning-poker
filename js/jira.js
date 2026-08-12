/**
 * Jira REST client.
 *
 * Browsers block authenticated cross-origin calls to Jira Cloud, so a proxy URL
 * can be configured; when nothing is reachable, Mock mode serves a fake Jira so
 * every flow stays demoable. All errors are turned into messages a facilitator
 * can act on — see `describeFailure`.
 */

import { readJson, removeKey, escapeHtml } from "./util.js";
import { client, currentUser } from "./supabase.js";
import * as mock from "./jira-mock.js";

/** Where settings used to live. Migrated to Supabase on first sign-in, then removed. */
const LEGACY_KEY = "pp:jira";
/**
 * "Story Points" on 4flow's Jira. Note that `customfield_10016`
 * ("Story point estimate", the team-managed-project field) also exists there
 * but is unused — writing to it would look like it worked and change nothing.
 * Press Detect in Settings to confirm on any other instance.
 */
export const DEFAULT_POINTS_FIELD = "customfield_10033";

export const defaultConfig = {
  baseUrl: "",
  email: "",
  token: "",
  pointsField: DEFAULT_POINTS_FIELD,
  proxy: "",
  mock: false,
};

/**
 * Settings live in Supabase, one row per account, readable only by that account
 * (see pp_jira_settings in db/schema.sql). They are mirrored into this
 * in-memory cache so the rest of the app can read them synchronously; the cache
 * is filled by pullConfig() whenever the signed-in account changes.
 */
let cache = null;

export function loadConfig() {
  return { ...defaultConfig, ...(cache || {}) };
}

function tidy(config) {
  return {
    ...config,
    baseUrl: normalizeBaseUrl(config.baseUrl),
    proxy: normalizeProxy(config.proxy),
    pointsField: (config.pointsField || DEFAULT_POINTS_FIELD).trim(),
    mock: Boolean(config.mock),
  };
}

const fromRow = (row) => ({
  baseUrl: row.base_url || "",
  email: row.email || "",
  token: row.token || "",
  pointsField: row.points_field || DEFAULT_POINTS_FIELD,
  proxy: row.proxy || "",
  mock: Boolean(row.mock),
});

const toRow = (userId, config) => ({
  user_id: userId,
  base_url: config.baseUrl,
  email: config.email,
  token: config.token,
  points_field: config.pointsField,
  proxy: config.proxy,
  mock: config.mock,
  updated_at: new Date().toISOString(),
});

/** Load this account's settings. Call it after sign-in and after sign-out. */
export async function pullConfig() {
  const user = await currentUser();
  if (!user) {
    cache = null;
    return loadConfig();
  }

  const supabase = await client();
  const { data, error } = await supabase
    .from("pp_jira_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.warn("Could not read Jira settings:", error.message);
    cache = null;
    return loadConfig();
  }

  if (data) {
    cache = tidy(fromRow(data));
    return loadConfig();
  }

  // First sign-in on a browser that still holds the old localStorage copy:
  // move it up to the account, then stop keeping a local copy.
  const legacy = readJson(LEGACY_KEY);
  if (legacy && (legacy.baseUrl || legacy.token || legacy.mock)) {
    cache = tidy({ ...defaultConfig, ...legacy });
    await pushConfig(user.id, cache).catch(() => {});
    removeKey(LEGACY_KEY);
  } else {
    cache = null;
  }
  return loadConfig();
}

async function pushConfig(userId, config) {
  const supabase = await client();
  const { error } = await supabase
    .from("pp_jira_settings")
    .upsert(toRow(userId, config), { onConflict: "user_id" });
  if (error) throw new JiraError(`Could not save the Jira settings: ${error.message}`, { kind: "config" });
}

export async function saveConfig(patch) {
  const next = tidy({ ...loadConfig(), ...patch });
  const user = await currentUser();
  if (!user) throw new JiraError("Sign in before saving Jira settings.", { kind: "config" });
  await pushConfig(user.id, next);
  cache = next;
  return next;
}

export async function clearConfig() {
  const user = await currentUser();
  if (user) {
    const supabase = await client();
    await supabase.from("pp_jira_settings").delete().eq("user_id", user.id);
  }
  removeKey(LEGACY_KEY);
  cache = null;
}

/** Drop the cached settings without touching the stored ones — used on sign-out. */
export function forgetConfig() {
  cache = null;
}

export function normalizeBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

/** True when the client has enough configuration to talk to a real Jira. */
export function isConfigured(config = loadConfig()) {
  if (config.mock) return true;
  return Boolean(config.baseUrl && config.token);
}

/** Human-readable reason the client cannot be used yet. */
export function configProblem(config = loadConfig()) {
  if (config.mock) return null;
  if (!config.baseUrl) return "No Jira URL configured.";
  if (!config.token) return "No Jira API token configured.";
  return null;
}

/* ---------- Issue references ---------- */

const KEY_PATTERN = /([A-Z][A-Z0-9_]+-\d+)/i;

/**
 * Accepts a plain key (`CUMA-123`) or any Jira URL that contains one
 * (`/browse/CUMA-123`, `...?selectedIssue=CUMA-123`, `/issues/?jql=...`).
 */
export function parseIssueRef(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const direct = text.match(/^([A-Za-z][A-Za-z0-9_]+-\d+)$/);
  if (direct) return direct[1].toUpperCase();
  const fromUrl = text.match(/(?:\/browse\/|selectedIssue=|issues\/|\/issue\/)([A-Za-z][A-Za-z0-9_]+-\d+)/);
  if (fromUrl) return fromUrl[1].toUpperCase();
  const loose = text.match(KEY_PATTERN);
  return loose ? loose[1].toUpperCase() : null;
}

/**
 * Several references at once: `CUMA-130, CUMA-131` or a list of URLs, separated
 * by commas, semicolons, newlines or spaces. Duplicates are dropped, order kept.
 */
export function parseIssueRefs(input) {
  const seen = new Set();
  const keys = [];
  for (const chunk of String(input || "").split(/[\s,;]+/)) {
    const key = parseIssueRef(chunk);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Base URL of a pasted Jira issue URL, so Settings can be pre-filled. */
export function baseUrlFromIssueUrl(input) {
  try {
    const url = new URL(String(input).trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function issueUrl(key, config = loadConfig()) {
  if (config.mock) return `#mock/${key}`;
  return config.baseUrl ? `${config.baseUrl}/browse/${key}` : "";
}

/* ---------- Transport ---------- */

export class JiraError extends Error {
  constructor(message, { status = 0, kind = "unknown", detail = "" } = {}) {
    super(message);
    this.name = "JiraError";
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}

function authHeader(config) {
  // Jira Cloud uses email + API token over Basic auth; Jira Server/Data Center
  // personal access tokens are sent as a bearer token with no email.
  if (config.email) return `Basic ${btoa(`${config.email}:${config.token}`)}`;
  return `Bearer ${config.token}`;
}

/**
 * Tidy a proxy address typed by hand: add the scheme if it is missing, and add
 * the separating slash a prefix-style proxy needs. Without this,
 * `localhost:8080` silently becomes `localhost:8080https://…`, which fetch
 * rejects as a network error that looks exactly like a CORS failure.
 */
export function normalizeProxy(value) {
  let proxy = String(value || "").trim();
  if (!proxy) return "";
  if (!/^https?:\/\//i.test(proxy)) proxy = `http://${proxy}`;
  if (proxy.includes("{url}")) return proxy;
  if (!/[/?=&]$/.test(proxy)) proxy += "/";
  return proxy;
}

/**
 * Complain about a proxy that cannot possibly work, before a request is sent.
 * @returns {string} an empty string when it looks usable
 */
export function proxyProblem(proxy, baseUrl) {
  const value = normalizeProxy(proxy);
  if (!value) return "";
  try {
    const url = new URL(value.replace("{url}", "x"));
    if (typeof location !== "undefined" && url.host === location.host) {
      return `${url.host} is this app's own web server, not the Jira proxy. Run "node proxy.mjs" and use http://localhost:8080/ instead.`;
    }
    if (baseUrl && url.host === new URL(baseUrl).host) {
      return "The proxy cannot be the Jira site itself — that is the request the browser blocks.";
    }
  } catch {
    return "That proxy address is not a valid URL.";
  }
  return "";
}

/**
 * Build the request URL, routing through the proxy when one is configured.
 * `{url}` in the proxy is replaced with the URL-encoded target; otherwise the
 * target is appended as-is (the convention cors-anywhere style proxies use).
 */
export function buildUrl(path, config) {
  const target = `${config.baseUrl}${path}`;
  const proxy = normalizeProxy(config.proxy);
  if (!proxy) return target;
  if (proxy.includes("{url}")) return proxy.replace("{url}", encodeURIComponent(target));
  return `${proxy}${target}`;
}

async function request(path, { method = "GET", body, config = loadConfig() } = {}) {
  const problem = configProblem(config);
  if (problem) throw new JiraError(problem, { kind: "config" });

  const url = buildUrl(path, config);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: authHeader(config),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new JiraError(
      "The browser blocked the request to Jira (CORS or network). Set a proxy URL in Settings, or switch on Mock mode to try the app offline.",
      { kind: "network", detail: String(cause?.message || cause) }
    );
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) throw describeFailure(response, payload, text);
  return payload;
}

/** Turn an HTTP failure into something worth showing a person. */
export function describeFailure(response, payload, text = "") {
  const status = response.status;
  const jiraMessages = collectJiraMessages(payload);
  const detail = jiraMessages || (text || "").slice(0, 300);

  if (status === 401) {
    return new JiraError("Jira rejected the credentials (401). Check the email and API token in Settings.", {
      status,
      kind: "auth",
      detail,
    });
  }
  if (status === 403) {
    return new JiraError(
      "Jira accepted the login but refused the action (403). The account may lack permission on this issue or project.",
      { status, kind: "permission", detail }
    );
  }
  if (status === 404) {
    return new JiraError("Jira could not find that issue or endpoint (404). Check the issue key and the Jira URL.", {
      status,
      kind: "not-found",
      detail,
    });
  }
  if (status === 429) {
    return new JiraError("Jira is rate-limiting the request (429). Wait a moment and try again.", {
      status,
      kind: "rate-limit",
      detail,
    });
  }
  if (status === 400 || status === 422) {
    return new JiraError(detail || "Jira rejected the value (400). The field may not accept this input.", {
      status,
      kind: "invalid",
      detail,
    });
  }
  if (status >= 500) {
    return new JiraError(`Jira returned a server error (${status}). Try again shortly.`, {
      status,
      kind: "server",
      detail,
    });
  }
  return new JiraError(detail || `Jira request failed (${status}).`, { status, kind: "unknown", detail });
}

function collectJiraMessages(payload) {
  if (!payload) return "";
  const parts = [];
  if (Array.isArray(payload.errorMessages)) parts.push(...payload.errorMessages);
  if (payload.errors && typeof payload.errors === "object") {
    for (const [field, message] of Object.entries(payload.errors)) parts.push(`${field}: ${message}`);
  }
  if (payload.message) parts.push(payload.message);
  return parts.filter(Boolean).join(" · ");
}

/* ---------- API ---------- */

const ISSUE_FIELDS = ["summary", "description", "status", "issuetype", "priority", "assignee", "labels"];

export async function getIssue(keyOrRef, config = loadConfig()) {
  const key = parseIssueRef(keyOrRef);
  if (!key) throw new JiraError(`"${keyOrRef}" does not look like a Jira issue key or URL.`, { kind: "input" });
  if (config.mock) return mock.getIssue(key, config);

  const fields = [...ISSUE_FIELDS, config.pointsField].join(",");
  const issue = await request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`, { config });
  return toStory(issue, config);
}

export async function updateStoryPoints(key, value, config = loadConfig()) {
  if (config.mock) return mock.updateStoryPoints(key, value, config);

  await request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { fields: { [config.pointsField]: value } },
    config,
  });
  // Read the issue back so the UI can show what Jira actually stored.
  const fresh = await request(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${config.pointsField},summary`,
    { config }
  );
  return { key, points: fresh?.fields?.[config.pointsField] ?? null };
}

export async function searchIssues(jql, config = loadConfig(), maxResults = 25) {
  if (config.mock) return mock.searchIssues(jql, config, maxResults);

  const fields = [...ISSUE_FIELDS, config.pointsField].join(",");
  const query = `jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${fields}`;
  let payload;
  try {
    // Current endpoint on Jira Cloud.
    payload = await request(`/rest/api/3/search/jql?${query}`, { config });
  } catch (error) {
    if (error.status === 404 || error.status === 410) {
      // Older Cloud and Server instances.
      payload = await request(`/rest/api/3/search?${query}`, { config });
    } else {
      throw error;
    }
  }
  return (payload?.issues || []).map((issue) => toStory(issue, config));
}

export async function listFields(config = loadConfig()) {
  if (config.mock) return mock.listFields(config);
  const fields = await request("/rest/api/3/field", { config });
  return Array.isArray(fields) ? fields : [];
}

/** Find the story point field id by name, preferring the classic "Story Points". */
export async function detectPointsField(config = loadConfig()) {
  const fields = await listFields(config);
  const candidates = fields.filter((field) => /story\s*point/i.test(field?.name || ""));
  if (!candidates.length) {
    throw new JiraError(
      'No field named like "Story Points" exists on this Jira. Ask an admin for the custom field id.',
      { kind: "not-found" }
    );
  }
  const exact = candidates.find((field) => /^story\s*points$/i.test(field.name));
  const chosen = exact || candidates[0];
  return { id: chosen.id, name: chosen.name, candidates };
}

export async function testConnection(config = loadConfig()) {
  if (config.mock) return mock.testConnection(config);
  const me = await request("/rest/api/3/myself", { config });
  return { name: me?.displayName || me?.emailAddress || "unknown user", accountId: me?.accountId };
}

/* ---------- Mapping ---------- */

export function toStory(issue, config = loadConfig()) {
  const fields = issue?.fields || {};
  const points = fields[config.pointsField];
  return {
    key: issue?.key || "",
    url: issueUrl(issue?.key, config),
    title: fields.summary || issue?.key || "Untitled issue",
    description: adfToHtml(fields.description),
    descriptionText: adfToText(fields.description),
    points: points === undefined ? null : points,
    status: fields.status?.name || "",
    type: fields.issuetype?.name || "",
    priority: fields.priority?.name || "",
    assignee: fields.assignee?.displayName || "",
    labels: Array.isArray(fields.labels) ? fields.labels : [],
  };
}

/* ---------- Atlassian Document Format ---------- */

/**
 * Render an ADF description as safe HTML. Text is escaped, only a known set of
 * nodes produces markup, and anything unrecognised falls back to its text.
 * Jira Server (API v2) sends a plain string instead, which is handled too.
 */
export function adfToHtml(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return plainTextToHtml(doc);
  if (!Array.isArray(doc.content)) return "";
  return doc.content.map(nodeToHtml).join("");
}

function nodeToHtml(node) {
  if (!node || typeof node !== "object") return "";
  const kids = () => (node.content || []).map(nodeToHtml).join("");

  switch (node.type) {
    case "paragraph":
      return `<p>${kids() || "&nbsp;"}</p>`;
    case "text":
      return applyMarks(escapeHtml(node.text || ""), node.marks);
    case "hardBreak":
      return "<br>";
    case "heading": {
      const level = Math.min(4, Math.max(3, (node.attrs?.level || 3) + 1));
      return `<h${level}>${kids()}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${kids()}</ul>`;
    case "orderedList":
      return `<ol>${kids()}</ol>`;
    case "listItem":
      return `<li>${kids()}</li>`;
    case "taskList":
      return `<ul>${kids()}</ul>`;
    case "taskItem":
      return `<li>${node.attrs?.state === "DONE" ? "☑" : "☐"} ${kids()}</li>`;
    case "codeBlock":
      return `<pre><code>${escapeHtml(textOf(node))}</code></pre>`;
    case "blockquote":
      return `<blockquote>${kids()}</blockquote>`;
    case "panel":
      return `<blockquote>${kids()}</blockquote>`;
    case "rule":
      return "<hr>";
    case "mention":
      return `<strong>@${escapeHtml(String(node.attrs?.text || "").replace(/^@/, ""))}</strong>`;
    case "emoji":
      return escapeHtml(node.attrs?.text || node.attrs?.shortName || "");
    case "status":
      return `<code>${escapeHtml(node.attrs?.text || "")}</code>`;
    case "date":
      return escapeHtml(formatAdfDate(node.attrs?.timestamp));
    case "inlineCard":
    case "blockCard": {
      const href = safeUrl(node.attrs?.url);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(node.attrs.url)}</a>` : "";
    }
    case "mediaSingle":
    case "mediaGroup":
      return `<p class="muted">[attachment: ${escapeHtml(mediaName(node))}]</p>`;
    case "media":
      return "";
    case "table":
      return `<div class="story-desc__table"><table>${kids()}</table></div>`;
    case "tableRow":
      return `<tr>${kids()}</tr>`;
    case "tableHeader":
      return `<th>${kids()}</th>`;
    case "tableCell":
      return `<td>${kids()}</td>`;
    case "expand":
    case "nestedExpand":
      return `<p><strong>${escapeHtml(node.attrs?.title || "Details")}</strong></p>${kids()}`;
    default:
      return kids();
  }
}

function applyMarks(html, marks) {
  if (!Array.isArray(marks)) return html;
  let out = html;
  for (const mark of marks) {
    switch (mark?.type) {
      case "strong":
        out = `<strong>${out}</strong>`;
        break;
      case "em":
        out = `<em>${out}</em>`;
        break;
      case "code":
        out = `<code>${out}</code>`;
        break;
      case "strike":
        out = `<s>${out}</s>`;
        break;
      case "underline":
        out = `<u>${out}</u>`;
        break;
      case "link": {
        const href = safeUrl(mark.attrs?.href);
        if (href) out = `<a href="${href}" target="_blank" rel="noopener noreferrer">${out}</a>`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Only http(s) and mailto links survive; everything else is dropped. */
function safeUrl(value) {
  const url = String(value || "").trim();
  if (!/^(https?:|mailto:)/i.test(url)) return "";
  return escapeHtml(url);
}

function mediaName(node) {
  const media = (node.content || []).find((child) => child.type === "media");
  return media?.attrs?.alt || media?.attrs?.id || "file";
}

function formatAdfDate(timestamp) {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString();
}

function plainTextToHtml(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Plain-text rendering of ADF, used for exports and tests. */
export function adfToText(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  return collectText(doc.content || [])
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectText(nodes) {
  return nodes.map(textOfNode).join("");
}

function textOfNode(node) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "text":
      return node.text || "";
    case "hardBreak":
      return "\n";
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
      return `${collectText(node.content || [])}\n\n`;
    case "listItem":
      return `• ${collectText(node.content || []).trim()}\n`;
    case "taskItem":
      return `${node.attrs?.state === "DONE" ? "[x]" : "[ ]"} ${collectText(node.content || []).trim()}\n`;
    case "rule":
      return "\n---\n";
    case "mention":
      return node.attrs?.text || "";
    case "emoji":
      return node.attrs?.text || node.attrs?.shortName || "";
    case "inlineCard":
    case "blockCard":
      return node.attrs?.url || "";
    case "tableCell":
    case "tableHeader":
      return `${collectText(node.content || []).trim()}\t`;
    case "tableRow":
      return `${collectText(node.content || [])}\n`;
    default:
      return collectText(node.content || []);
  }
}

function textOf(node) {
  return (node.content || []).map((child) => child.text || "").join("");
}
