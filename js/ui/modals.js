/** Modal machinery: one open modal at a time, Esc to close, focus handled. */

import { $, escapeHtml } from "../util.js";

let current = null;

export function isModalOpen() {
  return Boolean(current);
}

export function closeModal() {
  if (!current) return;
  const { backdrop, onClose, previousFocus } = current;
  current = null;
  backdrop.remove();
  document.removeEventListener("keydown", onEscape, true);
  if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  if (typeof onClose === "function") onClose();
}

function onEscape(event) {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  if (current?.dismissible === false) return;
  closeModal();
}

/**
 * @param {{title: string, body: string, footer?: string, wide?: boolean,
 *          dismissible?: boolean, onMount?: (handle: object) => void,
 *          onClose?: () => void}} options
 *   `dismissible: false` means a click on the backdrop or Escape does nothing —
 *   the dialog closes only through its own buttons. Use it where a stray click
 *   would throw away typing.
 */
export function openModal({ title, body, footer = "", wide = false, dismissible = true, onMount, onClose }) {
  closeModal();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal${wide ? " modal--wide" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal__head">
        <h2 class="modal__title">${escapeHtml(title)}</h2>
        <div class="spacer"></div>
        <button class="btn btn--icon" type="button" data-modal-close aria-label="Close">×</button>
      </div>
      <div class="modal__body" data-modal-body>${body}</div>
      ${footer ? `<div class="modal__foot" data-modal-foot>${footer}</div>` : ""}
    </div>`;

  backdrop.addEventListener("click", (event) => {
    if (event.target.closest("[data-modal-close]")) {
      closeModal();
      return;
    }
    if (event.target === backdrop && dismissible) closeModal();
  });

  $("#modals").appendChild(backdrop);
  document.addEventListener("keydown", onEscape, true);

  const handle = {
    backdrop,
    el: backdrop.querySelector(".modal"),
    body: backdrop.querySelector("[data-modal-body]"),
    footer: backdrop.querySelector("[data-modal-foot]"),
    onClose,
    dismissible,
    previousFocus: document.activeElement,
    close: closeModal,

    /** Show an inline message inside the modal, replacing any previous one. */
    message(text, kind = "danger") {
      handle.clearMessage();
      if (!text) return;
      const note = document.createElement("p");
      note.className = `note note--${kind}`;
      note.dataset.modalMessage = "1";
      note.textContent = text;
      handle.body.appendChild(note);
      note.scrollIntoView({ block: "nearest" });
    },

    clearMessage() {
      handle.body.querySelectorAll("[data-modal-message]").forEach((node) => node.remove());
    },

    /** Disable the footer buttons while an async action runs. */
    busy(isBusy, label) {
      const buttons = backdrop.querySelectorAll(".modal__foot button, [data-busy-target]");
      buttons.forEach((button) => {
        button.disabled = isBusy;
        if (button.dataset.busyLabel === undefined) button.dataset.busyLabel = button.textContent;
        if (isBusy && label && button.classList.contains("btn--primary")) button.textContent = label;
        if (!isBusy) button.textContent = button.dataset.busyLabel;
      });
    },
  };

  current = handle;
  if (typeof onMount === "function") onMount(handle);

  const focusTarget = backdrop.querySelector("[autofocus], input, select, textarea, .btn--primary");
  if (focusTarget) focusTarget.focus();

  return handle;
}

/** Promise-based confirmation, so callers read top to bottom. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const handle = openModal({
      title,
      body: `<p>${escapeHtml(message)}</p>`,
      footer: `
        <button class="btn" type="button" data-modal-close>Cancel</button>
        <button class="btn ${danger ? "btn--primary" : "btn--teal"}" type="button" data-confirm>${escapeHtml(confirmLabel)}</button>`,
      onClose: () => finish(false),
    });

    handle.footer.querySelector("[data-confirm]").addEventListener("click", () => {
      finish(true);
      closeModal();
    });
  });
}

/** Single-line prompt, resolving to the trimmed value or null when cancelled. */
export function promptDialog({ title, label, value = "", placeholder = "", confirmLabel = "Save" }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const handle = openModal({
      title,
      body: field({ id: "prompt-value", label, value, placeholder, attrs: "autofocus" }),
      footer: `
        <button class="btn" type="button" data-modal-close>Cancel</button>
        <button class="btn btn--primary" type="button" data-submit>${escapeHtml(confirmLabel)}</button>`,
      onClose: () => finish(null),
    });

    const input = handle.body.querySelector("#prompt-value");
    const submit = () => {
      const text = input.value.trim();
      if (!text) {
        handle.message("Enter a value.", "warn");
        return;
      }
      finish(text);
      closeModal();
    };

    handle.footer.querySelector("[data-submit]").addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    input.select();
  });
}

/** Shared field markup so modals look consistent. */
export function field({ id, label, type = "text", value = "", placeholder = "", hint = "", attrs = "" }) {
  return `
    <div class="field">
      <label for="${id}">${escapeHtml(label)}</label>
      <input class="input" id="${id}" type="${type}" value="${escapeHtml(value)}"
             placeholder="${escapeHtml(placeholder)}" ${attrs}>
      ${hint ? `<span class="hint">${hint}</span>` : ""}
    </div>`;
}
