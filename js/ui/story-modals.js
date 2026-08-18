/** Story modals: add from Jira, add by hand, import by JQL, set and push estimates. */

import { openModal, closeModal, field } from "./modals.js";
import { openSettings, errorText } from "./settings.js";
import { richTextField, mountRichText } from "./rte.js";
import { escapeHtml, toast, round, readJson, writeJson } from "../util.js";
import { createStory } from "../store.js";
import { deckCards, cardToNumber } from "../decks.js";
import { validatePointValue } from "../stats.js";
import * as jira from "../jira.js";
import { mockKeys } from "../jira-mock.js";
import * as ai from "../ai.js";

/* ---------- Add from Jira ---------- */

export function openAddStoryFromJira({ store, activate = true }) {
  const config = jira.loadConfig();
  const problem = jira.configProblem(config);

  const handle = openModal({
    title: "Add stories from Jira",
    body: `
      ${field({
        id: "jira-ref",
        label: "Issue keys or URLs",
        placeholder: config.mock ? mockKeys().slice(0, 2).join(", ") : "CUMA-130, CUMA-131",
        attrs: "autofocus",
      })}
      <p class="hint">
        One key, or several separated by commas — <code>CUMA-130, CUMA-131</code>. URLs work too.
        The summary becomes the heading and the description is shown to everyone in the room.
        ${config.mock ? `Mock issues: ${escapeHtml(mockKeys().join(", "))}.` : ""}
      </p>
      ${problem ? `<p class="note note--warn">${escapeHtml(problem)} Open Settings to connect, or switch on Mock mode.</p>` : ""}`,
    footer: `
      <button class="btn" type="button" data-settings>Settings</button>
      <div class="spacer"></div>
      <button class="btn" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-fetch>Fetch story</button>`,
  });

  const input = handle.body.querySelector("#jira-ref");

  handle.footer.querySelector("[data-settings]").addEventListener("click", () =>
    openSettings({ onSaved: () => openAddStoryFromJira({ store, activate }) })
  );

  let fetching = false;
  const fetchStory = async () => {
    if (fetching) return;
    fetching = true;
    handle.clearMessage();
    const raw = input.value.trim();
    if (!raw) {
      handle.message("Paste an issue key or URL.", "warn");
      fetching = false;
      return;
    }
    const keys = jira.parseIssueRefs(raw);
    if (!keys.length) {
      handle.message(`"${raw}" does not contain a Jira issue key.`, "warn");
      fetching = false;
      return;
    }

    const existing = new Set(
      (store.getState()?.stories || [])
        .filter((s) => s.status !== "archived")
        .map((s) => s.key)
        .filter(Boolean)
    );
    const added = [];
    const skipped = [];
    const failed = [];

    handle.busy(true, keys.length > 1 ? `Fetching 0/${keys.length}…` : "Fetching…");
    try {
      for (const [index, key] of keys.entries()) {
        if (keys.length > 1) handle.busy(true, `Fetching ${index}/${keys.length}…`);
        if (existing.has(key)) {
          skipped.push(key);
          continue;
        }
        try {
          const issue = await jira.getIssue(key);
          const story = createStory({
            title: issue.title,
            description: issue.description,
            key: issue.key,
            url: issue.url,
          });
          story.jiraPoints = issue.points;
          story.jiraStatus = issue.status || null;
          story.jiraAssignee = issue.assignee || null;
          story.jiraAssigneeId = issue.assigneeId || null;
          story.jiraPriority = issue.priority || null;
          // A separate call (the sprint field lives on the Agile API, not
          // the plain issue fetch above) — fine for the handful of keys
          // typed here, but skipped in the bulk import paths (JQL, project
          // backlog) to avoid one extra request per issue; those can be
          // refreshed individually afterward instead.
          try {
            const sprint = await jira.getIssueSprint(issue.key);
            story.jiraSprint = sprint?.name || null;
            story.jiraSprintId = sprint?.id || null;
          } catch {
            /* no board/sprint on this project — not fatal, just leave it unset */
          }
          if (issue.points !== null && issue.points !== undefined) {
            story.finalEstimate = String(issue.points);
          }
          store.dispatch({ type: "ADD_STORY", story });
          if (activate && added.length === 0) {
            const currentRoom = store.getState();
            if (currentRoom && currentRoom.activeStoryId !== story.id) {
              store.dispatch({ type: "SET_ACTIVE_STORY", id: story.id });
            }
          }
          existing.add(key);
          added.push(issue);
        } catch (error) {
          failed.push({ key, message: errorText(error) });
        }
      }
    } finally {
      handle.busy(false);
      fetching = false;
    }

    if (added.length) {
      toast(
        added.length === 1
          ? `${added[0].key} added${
              added[0].points !== null && added[0].points !== undefined ? ` (currently ${added[0].points} points)` : ""
            }.`
          : `${added.length} stories added: ${added.map((i) => i.key).join(", ")}.`,
        "ok"
      );
    }

    if (!failed.length && !skipped.length) {
      // Show success message for 1.5 seconds before auto-closing
      handle.message("✓ All stories added", "ok");
      setTimeout(() => closeModal(), 1500);
      return;
    }

    const notes = [];
    if (skipped.length) notes.push(`Already in the backlog: ${skipped.join(", ")}.`);
    if (failed.length) notes.push(failed.map((f) => `${f.key} — ${f.message}`).join("\n"));
    handle.message(notes.join("\n"), failed.length ? "danger" : "warn");
    if (added.length || skipped.length) input.value = failed.map((f) => f.key).join(", ");
  };

  handle.footer.querySelector("[data-fetch]").addEventListener("click", fetchStory);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") fetchStory();
  });

  return handle;
}

/* ---------- Add or edit by hand ---------- */

export function openManualStory({ store, story = null }) {
  const editing = Boolean(story);

  const handle = openModal({
    title: editing ? "Edit story" : "Add a story by hand",
    body: `
      ${field({ id: "story-title", label: "Heading", value: story?.title || "", attrs: "autofocus" })}
      ${richTextField({
        id: "story-desc",
        label: "Description",
        value: story?.description || "",
        placeholder: "What does this story cover?",
      })}
      ${field({
        id: "story-key",
        label: "Jira key (optional)",
        value: story?.key || "",
        placeholder: "CUMA-123",
        hint: "Link a Jira issue so the estimate can be written back.",
      })}`,
    footer: editing
      ? `
      <button class="btn" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--secondary" type="button" data-save-local>Save local</button>
      <button class="btn btn--primary" type="button" data-save-jira>Save & send to Jira</button>`
      : `
      <button class="btn" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-save>Add story</button>`,
  });

  const desc = mountRichText(handle.body, "story-desc");

  const saveHandler = () => {
    const title = handle.body.querySelector("#story-title").value.trim();
    if (!title) {
      handle.message("Give the story a heading.", "warn");
      return;
    }
    const description = desc.getHtml();
    const rawKey = handle.body.querySelector("#story-key").value.trim();
    const key = rawKey ? jira.parseIssueRef(rawKey) : null;
    if (rawKey && !key) {
      handle.message(`"${rawKey}" is not a Jira issue key.`, "warn");
      return;
    }

    if (editing) {
      store.dispatch({
        type: "UPDATE_STORY",
        id: story.id,
        patch: { title, description, key, url: key ? jira.issueUrl(key) : null },
      });
    } else {
      const created = createStory({ title, description, key, url: key ? jira.issueUrl(key) : null });
      store.dispatch({ type: "ADD_STORY", story: created });
      store.dispatch({ type: "SET_ACTIVE_STORY", id: created.id });
    }
    closeModal();
  };

  // Add or edit: single save button
  if (!editing) {
    handle.footer.querySelector("[data-save]").addEventListener("click", saveHandler);
    return handle;
  }

  // Edit mode: two save buttons
  handle.footer.querySelector("[data-save-local]").addEventListener("click", saveHandler);

  handle.footer.querySelector("[data-save-jira]").addEventListener("click", async () => {
    const title = handle.body.querySelector("#story-title").value.trim();
    if (!title) {
      handle.message("Give the story a heading.", "warn");
      return;
    }
    const description = desc.getHtml();
    const rawKey = handle.body.querySelector("#story-key").value.trim();
    const key = rawKey ? jira.parseIssueRef(rawKey) : null;
    if (rawKey && !key) {
      handle.message(`"${rawKey}" is not a Jira issue key.`, "warn");
      return;
    }

    // Save locally first
    store.dispatch({
      type: "UPDATE_STORY",
      id: story.id,
      patch: { title, description, key, url: key ? jira.issueUrl(key) : null },
    });

    // Then sync to Jira if the story has a key
    if (key) {
      handle.busy(true, "Updating Jira…");
      try {
        await jira.updateIssueFields(key, {
          summary: title,
          description,
        });
        handle.message(`✓ Updated ${key} in Jira`, "ok");
        setTimeout(() => closeModal(), 500);
      } catch (error) {
        handle.busy(false);
        const message = error?.message || String(error);
        handle.message(
          `Could not update Jira: ${message}`,
          error?.kind === "config" ? "warn" : "danger"
        );
      }
    } else {
      closeModal();
    }
  });

  return handle;
}

/* ---------- Import from backlog ---------- */

const LAST_PROJECTS_KEY = "pp:jira-last-projects";

/** Tolerates the old single-string shape this key used to hold. */
function rememberedProjectKeys() {
  const raw = readJson(LAST_PROJECTS_KEY, []);
  if (Array.isArray(raw)) return raw;
  return raw ? [raw] : [];
}

/**
 * Search picks one or more projects — each click adds it as a chip and clears
 * the search box for the next one, rather than replacing a single selection —
 * and the combined open issues across all of them land in one checklist
 * below, so a multi-project backlog does not need repeating the whole flow
 * once per project.
 */
export function openImportFromBacklog({ store, activate = false }) {
  const config = jira.loadConfig();
  let projects = [];
  const selectedKeys = new Set(); // filled once `projects` resolves and remembered keys are validated against it
  const issuesByProject = new Map(); // key -> { status: "loading"|"ready"|"error", issues, message }
  let checked = new Set();

  const handle = openModal({
    title: "Import from backlog",
    wide: true,
    body: `
      <div class="field">
        <label for="backlog-search">Project</label>
        <div class="stack stack--tight" id="backlog-chips"></div>
        <input class="input" id="backlog-search" placeholder="Search projects…" autocomplete="off">
      </div>
      <div class="stack stack--tight" id="backlog-projects" style="max-height:160px; overflow-y:auto">
        <p class="hint">Loading projects…</p>
      </div>
      <div id="backlog-issues" style="margin-top: var(--sp-4)">
        <p class="hint">Pick one or more projects to see their open issues.</p>
      </div>
      ${
        jira.configProblem(config)
          ? `<p class="note note--warn">${escapeHtml(jira.configProblem(config))} Open Settings first.</p>`
          : ""
      }`,
    footer: `
      <button class="btn" type="button" data-settings>Settings</button>
      <div class="spacer"></div>
      <button class="btn" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-add disabled>Add selected</button>`,
  });

  handle.footer.querySelector("[data-settings]").addEventListener("click", () =>
    openSettings({ onSaved: () => openImportFromBacklog({ store, activate }) })
  );

  const chipsHost = handle.body.querySelector("#backlog-chips");
  const projectsHost = handle.body.querySelector("#backlog-projects");
  const issuesHost = handle.body.querySelector("#backlog-issues");
  const addButton = handle.footer.querySelector("[data-add]");
  const searchInput = handle.body.querySelector("#backlog-search");

  function renderChips() {
    chipsHost.innerHTML = Array.from(selectedKeys)
      .map((key) => {
        const project = projects.find((p) => p.key === key);
        return `
        <button class="chip chip--brand chip--btn" type="button" data-remove-project="${escapeHtml(key)}"
                title="Remove ${escapeHtml(key)}">
          ${escapeHtml(key)}${project ? ` — ${escapeHtml(project.name)}` : ""} ×
        </button>`;
      })
      .join("");
    chipsHost.querySelectorAll("[data-remove-project]").forEach((chip) => {
      chip.addEventListener("click", () => toggleProject(chip.dataset.removeProject));
    });
  }

  function renderProjects(filterText = "") {
    const text = filterText.trim().toLowerCase();
    const visible = text
      ? projects.filter((p) => p.key.toLowerCase().includes(text) || p.name.toLowerCase().includes(text))
      : projects;
    if (!visible.length) {
      projectsHost.innerHTML = `<p class="hint">No projects match “${escapeHtml(filterText)}”.</p>`;
      return;
    }
    projectsHost.innerHTML = visible
      .map(
        (p) => `
      <button class="btn btn--block${selectedKeys.has(p.key) ? " btn--primary" : ""}" type="button"
              data-project-key="${escapeHtml(p.key)}" style="justify-content:flex-start">
        <strong>${escapeHtml(p.key)}</strong>&nbsp;<span class="muted">${escapeHtml(p.name)}</span>
        ${selectedKeys.has(p.key) ? "&nbsp;✓" : ""}
      </button>`
      )
      .join("");
    projectsHost.querySelectorAll("[data-project-key]").forEach((button) => {
      button.addEventListener("click", () => toggleProject(button.dataset.projectKey));
    });
  }

  function toggleProject(key) {
    if (selectedKeys.has(key)) {
      selectedKeys.delete(key);
    } else {
      selectedKeys.add(key);
      searchInput.value = ""; // ready to search for the next one
      if (!issuesByProject.has(key)) loadProject(key);
    }
    writeJson(LAST_PROJECTS_KEY, Array.from(selectedKeys));
    renderChips();
    renderProjects(searchInput.value);
    renderIssues();
  }

  async function loadProject(key) {
    issuesByProject.set(key, { status: "loading" });
    renderIssues();
    try {
      const issues = await jira.projectBacklog(key, config);
      issuesByProject.set(key, { status: "ready", issues });
    } catch (error) {
      issuesByProject.set(key, { status: "error", message: errorText(error) });
    }
    renderIssues();
  }

  function renderIssues() {
    if (!selectedKeys.size) {
      issuesHost.innerHTML = `<p class="hint">Pick one or more projects to see their open issues.</p>`;
      return;
    }

    const existing = new Set(
      (store.getState()?.stories || [])
        .filter((s) => s.status !== "archived")
        .map((s) => s.key)
        .filter(Boolean)
    );
    // Drop selections for issues whose project got removed, or that someone
    // else has since added, so "N selected" never counts something no longer
    // choosable.
    for (const key of checked) {
      const projectKey = key.split("-")[0];
      if (!selectedKeys.has(projectKey) || existing.has(key)) checked.delete(key);
    }

    const sections = Array.from(selectedKeys).map((key) => {
      const entry = issuesByProject.get(key) || { status: "loading" };
      if (entry.status === "loading") {
        return `<p class="hint">Loading ${escapeHtml(key)}’s backlog…</p>`;
      }
      if (entry.status === "error") {
        return `<p class="note note--danger">${escapeHtml(key)}: ${escapeHtml(entry.message)}</p>`;
      }
      if (!entry.issues.length) {
        return `<p class="hint">No open issues in ${escapeHtml(key)}.</p>`;
      }
      return `
        <div class="side__section-title">${escapeHtml(key)} <span class="chip">${entry.issues.length}</span></div>
        <div class="stack stack--tight">
          ${entry.issues
            .map((issue) => {
              const already = existing.has(issue.key);
              return `
            <label class="check" style="${already ? "opacity:0.5" : ""}">
              <input type="checkbox" data-issue-key="${escapeHtml(issue.key)}"
                     ${already ? "disabled" : ""} ${checked.has(issue.key) ? "checked" : ""}>
              <span><strong>${escapeHtml(issue.key)}</strong> ${escapeHtml(issue.title)}</span>
              ${already ? `<span class="chip">already in backlog</span>` : ""}
              ${issue.status ? `<span class="chip chip--teal">${escapeHtml(issue.status)}</span>` : ""}
            </label>`;
            })
            .join("")}
        </div>`;
    });

    const anySelectable = Array.from(issuesByProject.values()).some(
      (e) => e.status === "ready" && e.issues.some((i) => !existing.has(i.key))
    );

    issuesHost.innerHTML = `
      ${
        anySelectable
          ? `<div class="row row--tight" style="margin-bottom:var(--sp-2)">
               <label class="check"><input type="checkbox" id="backlog-select-all"> Select all</label>
             </div>`
          : ""
      }
      <div style="max-height:320px; overflow-y:auto">${sections.join("")}</div>`;

    issuesHost.querySelectorAll("[data-issue-key]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) checked.add(input.dataset.issueKey);
        else checked.delete(input.dataset.issueKey);
        updateAddButton();
      });
    });
    const selectAll = issuesHost.querySelector("#backlog-select-all");
    if (selectAll) {
      selectAll.addEventListener("change", () => {
        issuesHost.querySelectorAll("[data-issue-key]:not(:disabled)").forEach((input) => {
          input.checked = selectAll.checked;
          if (selectAll.checked) checked.add(input.dataset.issueKey);
          else checked.delete(input.dataset.issueKey);
        });
        updateAddButton();
      });
    }
    updateAddButton();
  }

  function updateAddButton() {
    addButton.disabled = checked.size === 0;
    addButton.textContent = checked.size ? `Add selected (${checked.size})` : "Add selected";
  }

  searchInput.addEventListener("input", () => renderProjects(searchInput.value));

  addButton.addEventListener("click", () => {
    // Re-checked against the live room, not the snapshot the lists were built
    // from — someone else may have added one of these in the meantime.
    const existing = new Set(
      (store.getState()?.stories || [])
        .filter((s) => s.status !== "archived")
        .map((s) => s.key)
        .filter(Boolean)
    );
    const allIssues = Array.from(issuesByProject.values()).flatMap((e) => e.issues || []);
    let added = 0;
    let skipped = 0;
    let firstAdded = null;
    for (const key of checked) {
      if (existing.has(key)) {
        skipped += 1;
        continue;
      }
      const issue = allIssues.find((i) => i.key === key);
      if (!issue) continue;
      const story = createStory({ title: issue.title, description: issue.description, key: issue.key, url: issue.url });
      story.jiraPoints = issue.points;
      story.jiraStatus = issue.status || null;
      story.jiraAssignee = issue.assignee || null;
      story.jiraAssigneeId = issue.assigneeId || null;
      story.jiraPriority = issue.priority || null;
      store.dispatch({ type: "ADD_STORY", story });
      existing.add(key);
      if (!firstAdded) firstAdded = story;
      added += 1;
    }
    if (activate && firstAdded) {
      const room = store.getState();
      if (room && room.activeStoryId !== firstAdded.id) {
        store.dispatch({ type: "SET_ACTIVE_STORY", id: firstAdded.id });
      }
    }
    if (!added) {
      toast(`Nothing new to add — ${skipped} selected issue${skipped === 1 ? "" : "s"} already in the backlog.`, "warn");
      return;
    }
    toast(
      `Added ${added} issue${added === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} already in the backlog` : ""}.`,
      "ok"
    );
    closeModal();
  });

  jira
    .listProjects(config)
    .then((list) => {
      projects = list;
      const remembered = rememberedProjectKeys().filter((key) => projects.some((p) => p.key === key));
      remembered.forEach((key) => selectedKeys.add(key));
      renderChips();
      renderProjects();
      renderIssues();
      remembered.forEach((key) => loadProject(key));
    })
    .catch((error) => {
      projectsHost.innerHTML = `<p class="note note--danger">${escapeHtml(errorText(error))}</p>`;
    });

  return handle;
}

/* ---------- Import by JQL ---------- */

export function openJqlImport({ store }) {
  const config = jira.loadConfig();
  const suggestion = "project = CUMA AND sprint in openSprints() ORDER BY rank";

  const handle = openModal({
    title: "Import stories by JQL",
    wide: true,
    body: `
      <div class="field">
        <label for="jql">JQL</label>
        <textarea class="textarea" id="jql" autofocus>${escapeHtml(suggestion)}</textarea>
        <span class="hint">Up to 25 issues are imported. Issues already in the backlog are skipped.</span>
      </div>
      ${
        jira.configProblem(config)
          ? `<p class="note note--warn">${escapeHtml(jira.configProblem(config))}</p>`
          : ""
      }`,
    footer: `
      <button class="btn" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-import>Import</button>`,
  });

  let importing = false;
  handle.footer.querySelector("[data-import]").addEventListener("click", async () => {
    if (importing) return;
    importing = true;
    handle.clearMessage();
    const jql = handle.body.querySelector("#jql").value.trim();
    if (!jql) {
      handle.message("Enter a JQL query.", "warn");
      importing = false;
      return;
    }

    handle.busy(true, "Importing…");
    try {
      const issues = await jira.searchIssues(jql);
      const existing = new Set(
      (store.getState()?.stories || [])
        .filter((s) => s.status !== "archived")
        .map((s) => s.key)
        .filter(Boolean)
    );
      let added = 0;
      for (const issue of issues) {
        if (existing.has(issue.key)) continue;
        const story = createStory({
          title: issue.title,
          description: issue.description,
          key: issue.key,
          url: issue.url,
        });
        story.jiraPoints = issue.points;
        story.jiraStatus = issue.status || null;
        story.jiraAssignee = issue.assignee || null;
        story.jiraAssigneeId = issue.assigneeId || null;
        story.jiraPriority = issue.priority || null;
        store.dispatch({ type: "ADD_STORY", story });
        existing.add(issue.key);
        added += 1;
      }
      if (!added) {
        handle.message(`No new issues — the query matched ${issues.length}, all already in the backlog.`, "warn");
      } else {
        toast(`Imported ${added} issue${added === 1 ? "" : "s"}.`, "ok");
        closeModal();
      }
    } catch (error) {
      handle.message(errorText(error), "danger");
    } finally {
      handle.busy(false);
      importing = false;
    }
  });

  return handle;
}

/* ---------- Pick an estimate without touching Jira ---------- */

export function openPickEstimate({ store, room, story, suggestion }) {
  const cards = deckCards(room);

  const handle = openModal({
    title: "Set the estimate",
    body: `
      <p class="hint">Stored in the session only. Use <strong>Update story point</strong> to write it to Jira.</p>
      <div class="deck__cards">
        ${cards
          .map(
            (card) =>
              `<button class="card-btn" type="button" data-pick="${escapeHtml(card)}"
                       aria-pressed="${String(story.finalEstimate) === card}">${escapeHtml(card)}</button>`
          )
          .join("")}
      </div>`,
    footer: `
      <button class="btn btn--danger" type="button" data-clear>Clear estimate</button>
      <div class="spacer"></div>
      <button class="btn" type="button" data-modal-close>Close</button>`,
  });

  handle.body.querySelectorAll("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      store.dispatch({ type: "SET_ESTIMATE", id: story.id, value: button.dataset.pick });
      closeModal();
    });
  });

  handle.footer.querySelector("[data-clear]").addEventListener("click", () => {
    store.dispatch({ type: "SET_ESTIMATE", id: story.id, value: null });
    closeModal();
  });

  if (suggestion) handle.message(`Suggested by this round: ${suggestion}`, "ok");
  return handle;
}

/* ---------- Write the estimate back to Jira ---------- */

export function openUpdatePoints({ store, room, story, me, suggestion, roundStats }) {
  const config = jira.loadConfig();
  const cards = deckCards(room);
  const numericCards = cards.filter((card) => cardToNumber(card) !== null);
  const prefill =
    suggestion ??
    (story.finalEstimate !== null && story.finalEstimate !== undefined ? String(story.finalEstimate) : "");

  const handle = openModal({
    title: "Update story point in Jira",
    wide: true,
    body: `
      <div class="story-now">
        <div class="story-now__key">${story.key ? escapeHtml(story.key) : "NOT LINKED TO JIRA"}</div>
        <h3 class="story-now__title">${escapeHtml(story.title)}</h3>
        ${
          story.jiraPoints !== null && story.jiraPoints !== undefined
            ? `<p class="hint">Currently ${escapeHtml(String(story.jiraPoints))} in Jira.</p>`
            : `<p class="hint">No story points set in Jira yet.</p>`
        }
      </div>

      ${
        story.key
          ? ""
          : field({
              id: "points-key",
              label: "Jira issue key",
              placeholder: "CUMA-123",
              hint: "This story was added by hand — say which issue to update.",
            })
      }

      <div class="field">
        <label for="points-value">Story points</label>
        <input class="input" id="points-value" type="text" inputmode="decimal"
               value="${escapeHtml(prefill)}" placeholder="e.g. 5" autofocus>
        <span class="hint">
          Written to <code>${escapeHtml(config.pointsField)}</code>${config.mock ? " in mock Jira" : ""}.
        </span>
      </div>

      <div class="deck__cards" data-quick>
        ${numericCards
          .map(
            (card) =>
              `<button class="card-btn" type="button" data-quick-pick="${escapeHtml(card)}"
                       aria-pressed="${prefill === card}">${escapeHtml(card)}</button>`
          )
          .join("")}
      </div>

      ${
        roundStats
          ? `<div class="field">
               <div class="row row--tight" style="align-items:center">
                 <label style="margin:0">AI round summary</label>
                 <div class="spacer"></div>
                 <button class="btn btn--sm btn--ghost" type="button" data-generate-summary>✨ Generate</button>
               </div>
               <textarea class="textarea" id="round-summary" rows="3"
                 placeholder="Generate a short summary of this round to optionally post as a Jira comment…"></textarea>
               ${
                 story.key
                   ? `<label class="check"><input type="checkbox" id="post-comment"> Also post this as a comment on ${escapeHtml(
                       story.key
                     )}</label>`
                   : `<span class="hint">Link this story to a Jira issue first to post it as a comment.</span>`
               }
             </div>`
          : ""
      }

      ${
        jira.configProblem(config)
          ? `<p class="note note--warn">${escapeHtml(jira.configProblem(config))} Open Settings first.</p>`
          : ""
      }`,
    footer: `
      <button class="btn" type="button" data-settings>Settings</button>
      <div class="spacer"></div>
      <button class="btn" type="button" data-modal-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-update>Update Jira</button>`,
  });

  const valueInput = handle.body.querySelector("#points-value");
  const keyInput = handle.body.querySelector("#points-key");

  handle.body.querySelectorAll("[data-quick-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      valueInput.value = button.dataset.quickPick;
      handle.body
        .querySelectorAll("[data-quick-pick]")
        .forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
      valueInput.focus();
    });
  });

  handle.footer.querySelector("[data-settings]").addEventListener("click", () =>
    openSettings({ onSaved: () => openUpdatePoints({ store, room, story, me, suggestion, roundStats }) })
  );

  const generateButton = handle.body.querySelector("[data-generate-summary]");
  if (generateButton) {
    generateButton.addEventListener("click", async () => {
      generateButton.disabled = true;
      generateButton.textContent = "Thinking…";
      try {
        const text = await ai.summarizeRound({
          title: story.title,
          points: valueInput.value || story.finalEstimate || "—",
          average: roundStats.average,
          agreement: roundStats.agreement,
          votes: roundStats.votes,
        });
        handle.body.querySelector("#round-summary").value = text;
        const commentBox = handle.body.querySelector("#post-comment");
        if (commentBox) commentBox.checked = true;
      } catch (error) {
        handle.message(errorText(error), "danger");
      } finally {
        generateButton.disabled = false;
        generateButton.textContent = "✨ Generate";
      }
    });
  }

  const update = async () => {
    handle.clearMessage();

    const key = story.key || (keyInput ? jira.parseIssueRef(keyInput.value) : null);
    if (!key) {
      handle.message("Enter the Jira issue key this story belongs to.", "warn");
      return;
    }

    const check = validatePointValue(valueInput.value, cards);
    if (!check.ok) {
      handle.message(check.error, "warn");
      return;
    }

    handle.busy(true, "Updating…");
    try {
      const result = await jira.updateStoryPoints(key, check.value);
      const stored = result.points === null || result.points === undefined ? check.value : result.points;

      if (!story.key) {
        store.dispatch({ type: "UPDATE_STORY", id: story.id, patch: { key, url: jira.issueUrl(key) } });
      }
      store.dispatch({
        type: "SET_ESTIMATE",
        id: story.id,
        value: String(stored),
        jiraPoints: stored,
        jiraSynced: true,
        by: me?.name,
      });

      toast(`${key} now has ${stored} story point${Number(stored) === 1 ? "" : "s"} in Jira.`, "ok");

      // Best-effort and separate from the point update above: a failed
      // comment should not make it look like the (already successful) point
      // write failed too.
      const commentBox = handle.body.querySelector("#post-comment");
      const summaryText = handle.body.querySelector("#round-summary")?.value.trim();
      if (commentBox?.checked && summaryText) {
        try {
          await jira.addComment(key, summaryText);
        } catch (error) {
          toast(`Points saved, but the comment could not be posted: ${errorText(error)}`, "warn");
        }
      }

      closeModal();
    } catch (error) {
      handle.message(errorText(error), "danger");
      offerLocalSave(handle, store, story, check.value);
    } finally {
      handle.busy(false);
    }
  };

  handle.footer.querySelector("[data-update]").addEventListener("click", update);
  valueInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") update();
  });
  valueInput.select();

  if (hasValue(suggestion)) handle.message(`This round suggests ${suggestion}.`, "ok");
  return handle;
}

/* ---------- Change status (Jira workflow) ---------- */

/**
 * Which move is legal from here is entirely Jira's call — a workflow only
 * allows certain next statuses from wherever the issue sits right now — so
 * this always asks Jira fresh rather than offering a fixed list, and the
 * story's own jiraStatus only updates once Jira has actually accepted the
 * move (never optimistically).
 */
export function openChangeStatus({ store, story }) {
  const handle = openModal({
    title: "Change status",
    body: `<p class="hint">Asking Jira what moves are open from here…</p>`,
  });

  const load = async () => {
    try {
      const transitions = await jira.getTransitions(story.key);
      if (!transitions.length) {
        handle.body.innerHTML = `
          ${statusNow(story)}
          <p class="hint">Jira has no further moves from here for ${escapeHtml(story.key)}.</p>`;
        return;
      }
      handle.body.innerHTML = `
        ${statusNow(story)}
        <div class="stack stack--tight">
          ${transitions
            .map(
              (t) => `
            <button class="btn btn--block" type="button" data-transition-id="${escapeHtml(t.id)}"
                    style="justify-content:space-between">
              <span>${escapeHtml(t.name)}</span>
              ${t.toStatus ? `<span class="chip chip--teal">${escapeHtml(t.toStatus)}</span>` : ""}
            </button>`
            )
            .join("")}
        </div>`;

      handle.body.querySelectorAll("[data-transition-id]").forEach((button) => {
        button.addEventListener("click", () => applyTransition(button, transitions));
      });
    } catch (error) {
      handle.body.innerHTML = statusNow(story);
      handle.message(errorText(error), "danger");
    }
  };

  const applyTransition = async (button, transitions) => {
    handle.clearMessage();
    handle.body.querySelectorAll("[data-transition-id]").forEach((b) => (b.disabled = true));
    try {
      const chosen = transitions.find((t) => t.id === button.dataset.transitionId);
      const landedOn = await jira.applyTransition(story.key, button.dataset.transitionId);
      store.dispatch({ type: "UPDATE_STORY", id: story.id, patch: { jiraStatus: landedOn || chosen?.toStatus || "" } });
      toast(`${story.key} moved to ${landedOn || chosen?.toStatus}.`, "ok");
      closeModal();
    } catch (error) {
      handle.message(errorText(error), "danger");
      handle.body.querySelectorAll("[data-transition-id]").forEach((b) => (b.disabled = false));
    }
  };

  void load();
  return handle;
}

function statusNow(story) {
  return `<p class="hint">Current: ${
    story.jiraStatus ? `<span class="chip chip--teal">${escapeHtml(story.jiraStatus)}</span>` : "unknown"
  }</p>`;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

/** After a failed write, let the facilitator at least keep the number locally. */
function offerLocalSave(handle, store, story, value) {
  if (handle.footer.querySelector("[data-local]")) return;
  const button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  button.dataset.local = "1";
  button.textContent = `Keep ${round(Number(value), 2) ?? value} in the session only`;
  button.addEventListener("click", () => {
    store.dispatch({ type: "SET_ESTIMATE", id: story.id, value: String(value) });
    toast("Estimate saved in the session, not in Jira.", "warn");
    closeModal();
  });
  handle.footer.insertBefore(button, handle.footer.querySelector("[data-update]"));
}

