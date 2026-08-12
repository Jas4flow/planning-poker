/**
 * Minimal rich-text editor: a toolbar over a contenteditable box. Output is
 * sanitized HTML in the same shape Jira descriptions already render in (see
 * .story-desc in room.css), so no separate storage format is needed —
 * getHtml() is exactly what goes into story.description.
 */

import { sanitizeHtml, escapeHtml } from "../util.js";

const TOOLS = [
  { cmd: "bold", label: "B", title: "Bold (Ctrl+B)" },
  { cmd: "italic", label: "I", title: "Italic (Ctrl+I)" },
  { cmd: "insertUnorderedList", label: "•", title: "Bullet list" },
  { cmd: "insertOrderedList", label: "1.", title: "Numbered list" },
  { cmd: "link", label: "🔗", title: "Link" },
  { cmd: "removeFormat", label: "⨉", title: "Clear formatting" },
];

/** Field markup to drop into a modal body. Wire it up with mountRichText() once mounted. */
export function richTextField({ id, label = "Description", value = "", placeholder = "" }) {
  return `
    <div class="field">
      <label for="${id}">${escapeHtml(label)}</label>
      <div class="rte" data-rte>
        <div class="rte__toolbar" role="toolbar" aria-label="${escapeHtml(label)} formatting">
          ${TOOLS.map(
            (tool) =>
              `<button class="rte__btn" type="button" data-cmd="${tool.cmd}" title="${escapeHtml(
                tool.title
              )}" aria-label="${escapeHtml(tool.title)}">${tool.label}</button>`
          ).join("")}
        </div>
        <div class="rte__editor story-desc" id="${id}" contenteditable="true"
             data-placeholder="${escapeHtml(placeholder)}" role="textbox"
             aria-multiline="true">${sanitizeHtml(value)}</div>
      </div>
    </div>`;
}

/** Wire up the toolbar for a field built by richTextField(). Call once the modal is in the DOM. */
export function mountRichText(root, id) {
  const editor = root.querySelector(`#${id}`);
  const wrap = editor.closest("[data-rte]");

  wrap.querySelectorAll("[data-cmd]").forEach((button) => {
    button.addEventListener("click", () => {
      editor.focus();
      const cmd = button.dataset.cmd;
      if (cmd === "link") {
        const url = window.prompt("Link URL (https://…)");
        if (!url) return;
        document.execCommand("createLink", false, url);
        return;
      }
      document.execCommand(cmd, false, null);
    });
  });

  return {
    el: editor,
    getHtml: () => sanitizeHtml(editor.innerHTML),
    focus: () => editor.focus(),
  };
}
