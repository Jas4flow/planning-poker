/** Jira connection settings. */

import { openModal, closeModal, confirmDialog } from "./modals.js";
import { escapeHtml, toast } from "../util.js";
import * as jira from "../jira.js";
import { mockKeys } from "../jira-mock.js";

export function openSettings({ onSaved } = {}) {
  const config = jira.loadConfig();

  const handle = openModal({
    title: "Jira connection",
    wide: true,
    // A stray click on the page behind must not discard a half-typed token.
    dismissible: false,
    body: `
      <label class="check">
        <input type="checkbox" id="cfg-mock" ${config.mock ? "checked" : ""}>
        <span>
          <strong>Mock mode</strong> — use a built-in fake Jira. Nothing leaves the browser and every flow
          works offline. Sample issues: ${escapeHtml(mockKeys().join(", "))}.
        </span>
      </label>

      <div id="cfg-real" class="stack" ${config.mock ? "hidden" : ""}>
        <div class="field">
          <label for="cfg-base">Jira base URL</label>
          <input class="input" id="cfg-base" type="url" value="${escapeHtml(config.baseUrl)}"
                 placeholder="https://your-company.atlassian.net">
          <span class="hint">No trailing path — just the site.</span>
        </div>

        <div class="row">
          <div class="field">
            <label for="cfg-email">Email</label>
            <input class="input" id="cfg-email" type="email" value="${escapeHtml(config.email)}"
                   placeholder="you@company.com">
            <span class="hint">Leave empty to send the token as a bearer token (Jira Server / Data Center).</span>
          </div>
          <div class="field">
            <label for="cfg-token">API token</label>
            <input class="input" id="cfg-token" type="password" value="${escapeHtml(config.token)}"
                   placeholder="••••••••" autocomplete="off">
            <span class="hint">
              Create one at
              <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">id.atlassian.com</a>.
            </span>
          </div>
        </div>

        <div class="field">
          <label for="cfg-proxy">CORS Proxy URL (optional override)</label>
          <input class="input" id="cfg-proxy" type="text" value="${escapeHtml(config.proxy)}"
                 placeholder="http://localhost:8080/">
          <span class="hint">
            ✓ Pre-configured with a free Supabase Edge Function (no setup needed). 
            Leave empty to use the default. To use a local proxy, run <code>node proxy.mjs</code> and enter <code>http://localhost:8080/</code>.
          </span>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label for="cfg-field">Story point field id</label>
          <input class="input" id="cfg-field" type="text" value="${escapeHtml(config.pointsField)}"
                 placeholder="${jira.DEFAULT_POINTS_FIELD}">
          <span class="hint">
            <code>customfield_10033</code> on 4flow's Jira. Press <strong>Detect</strong> to confirm —
            beware <code>customfield_10016</code> ("Story point estimate"), which exists but is unused there.
          </span>
        </div>
        <button class="btn" type="button" id="cfg-detect" data-busy-target>Detect</button>
      </div>

      <p class="hint">
        Saved to your account, so the same connection works from any browser you sign in on. Nobody
        else can read it.
      </p>`,
    footer: `
      <button class="btn btn--danger" type="button" id="cfg-clear">Clear credentials</button>
      <div class="spacer"></div>
      <button class="btn" type="button" data-modal-close>Close</button>
      <button class="btn" type="button" id="cfg-test">Test connection</button>
      <button class="btn btn--primary" type="button" id="cfg-save">Save</button>`,
  });

  const el = (id) => handle.backdrop.querySelector(id);
  const mock = el("#cfg-mock");

  const readForm = () => ({
    mock: mock.checked,
    baseUrl: jira.normalizeBaseUrl(el("#cfg-base").value),
    email: el("#cfg-email").value.trim(),
    token: el("#cfg-token").value.trim(),
    proxy: jira.normalizeProxy(el("#cfg-proxy").value),
    pointsField: el("#cfg-field").value.trim() || jira.DEFAULT_POINTS_FIELD,
  });

  mock.addEventListener("change", () => {
    el("#cfg-real").hidden = mock.checked;
  });

  const proxyInput = el("#cfg-proxy");
  if (proxyInput) {
    proxyInput.addEventListener("blur", () => {
      const tidied = jira.normalizeProxy(proxyInput.value);
      if (tidied !== proxyInput.value) proxyInput.value = tidied;
      const problem = jira.proxyProblem(tidied, jira.normalizeBaseUrl(el("#cfg-base").value));
      if (problem) handle.message(problem, "warn");
    });
  }

  el("#cfg-test").addEventListener("click", async () => {
    handle.clearMessage();
    const form = readForm();
    const problem = jira.proxyProblem(form.proxy, form.baseUrl);
    if (problem && !form.mock) {
      handle.message(problem, "warn");
      return;
    }
    handle.busy(true, "Testing…");
    try {
      const who = await jira.testConnection(form);
      handle.message(`Connected to Jira as ${who.name}.`, "ok");
    } catch (error) {
      handle.message(errorText(error), "danger");
    } finally {
      handle.busy(false);
    }
  });

  el("#cfg-detect").addEventListener("click", async () => {
    handle.clearMessage();
    handle.busy(true);
    try {
      const found = await jira.detectPointsField(readForm());
      el("#cfg-field").value = found.id;
      const others = found.candidates.filter((c) => c.id !== found.id);
      handle.message(
        `Using "${found.name}" (${found.id}).` +
          (others.length ? ` Also found: ${others.map((c) => `${c.name} (${c.id})`).join(", ")}.` : ""),
        "ok"
      );
    } catch (error) {
      handle.message(errorText(error), "danger");
    } finally {
      handle.busy(false);
    }
  });

  el("#cfg-clear").addEventListener("click", async () => {
    const yes = await confirmDialog({
      title: "Clear Jira credentials",
      message: "The Jira URL, email and API token will be removed from this browser.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!yes) {
      openSettings({ onSaved });
      return;
    }
    try {
      await jira.clearConfig();
      toast("Jira credentials cleared.", "ok");
      if (onSaved) onSaved(jira.loadConfig());
    } catch (error) {
      toast(error.message, "error");
    }
  });

  el("#cfg-save").addEventListener("click", async () => {
    handle.clearMessage();
    const form = readForm();
    if (!form.mock && !form.baseUrl) {
      handle.message("Add a Jira base URL, or switch on Mock mode.", "warn");
      return;
    }
    if (!form.mock && !form.token) {
      handle.message("Add an API token, or switch on Mock mode.", "warn");
      return;
    }

    handle.busy(true, "Saving…");
    try {
      const saved = await jira.saveConfig(form);
      toast(saved.mock ? "Saved — using mock Jira." : "Jira settings saved to your account.", "ok");
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (error) {
      handle.message(error.message, "danger");
    } finally {
      handle.busy(false);
    }
  });

  return handle;
}

export function errorText(error) {
  if (!error) return "Something went wrong.";
  const detail = error.detail && error.detail !== error.message ? `\n${error.detail}` : "";
  return `${error.message}${detail}`;
}
