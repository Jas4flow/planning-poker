/** Small shared helpers: ids, DOM, escaping, storage, toasts. */

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

/** Short, URL-friendly, collision-unlikely id. */
export function newId(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Initials for an avatar, at most two characters. */
export function initials(name) {
  const parts = String(name || "?")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Escape plain text and turn blank lines into paragraphs. Safe to inject. */
export function textToHtml(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Reverse of textToHtml, good enough to refill an edit form. */
export function htmlToText(html) {
  const div = document.createElement("div");
  div.innerHTML = String(html || "")
    .replace(/<\/(p|div|li|h[1-6]|pre|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  return (div.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Same tag set the rich-text story editor offers and .story-desc knows how to
 * render. Anything else — scripts, styles, event handlers, embeds pasted from
 * elsewhere — is stripped before the HTML is stored or shown to anyone else
 * in the room.
 */
const RTE_ALLOWED_TAGS = new Set([
  "P", "BR", "STRONG", "B", "EM", "I", "U", "S", "STRIKE",
  "UL", "OL", "LI", "A", "BLOCKQUOTE", "H3", "H4", "CODE", "PRE", "HR",
]);

/** Tags removed together with their contents, rather than unwrapped. */
const RTE_STRIP_ENTIRELY = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "IMG",
  "VIDEO", "AUDIO", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "LINK", "META",
]);

/** Keep only a safe subset of HTML — for rich-text input that may carry pasted markup. */
export function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toRemove = [];
  const toUnwrap = [];
  let node = walker.nextNode();
  while (node) {
    if (RTE_STRIP_ENTIRELY.has(node.tagName)) {
      toRemove.push(node);
    } else if (!RTE_ALLOWED_TAGS.has(node.tagName)) {
      toUnwrap.push(node);
    } else {
      for (const attr of Array.from(node.attributes)) {
        if (node.tagName === "A" && attr.name === "href" && /^(https?:|mailto:)/i.test(attr.value.trim())) continue;
        node.removeAttribute(attr.name);
      }
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    }
    node = walker.nextNode();
  }
  for (const dead of toRemove) dead.remove();
  for (const wrapper of toUnwrap) {
    while (wrapper.firstChild) wrapper.parentNode.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }
  return template.innerHTML;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Replace an element's children with parsed HTML. */
export function setHtml(el, html) {
  if (el) el.innerHTML = html;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Round to at most `digits` decimals and drop trailing zeroes. */
export function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ---------- localStorage helpers (never throw) ---------- */

export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ---------- Clipboard ---------- */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts, where the async clipboard is unavailable.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------- Toasts ---------- */

const TOAST_ICONS = { ok: "✓", error: "!", warn: "!", info: "i" };

export function toast(message, kind = "info", timeout = 5200) {
  const host = $("#toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `
    <span aria-hidden="true">${TOAST_ICONS[kind] || "i"}</span>
    <span class="toast__text">${escapeHtml(message)}</span>
    <button class="toast__close" type="button" aria-label="Dismiss">×</button>`;
  el.querySelector(".toast__close").addEventListener("click", () => el.remove());
  host.appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
}

/* ---------- Sound ---------- */

/** Short two-note chime for card reveal, synthesised so there is no asset to ship. */
export function playReveal() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.24);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.11);
      osc.stop(now + i * 0.11 + 0.26);
    });
    setTimeout(() => ctx.close(), 700);
  } catch {
    /* audio is a nicety; never let it break a reveal */
  }
}

export function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
