// Shared helpers for every module: HTML escaping, inline Arabic markup, the
// screen-reader announcer, the visible status line, saved preferences and the
// shared play button. Nothing here touches the DOM at import time, so the
// module can also be imported by Node tests.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escape a value for text content or a double-quoted attribute. null and undefined become "". */
export function esc(s) {
  return s == null ? "" : String(s).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Arabic, Arabic Supplement, Arabic Extended-A/B and the presentation forms.
const AR_CHARS = "؀-ۿݐ-ݿࡰ-ࣿﭐ-﷿ﹰ-﻿";
// A run starts with an Arabic character and continues through Arabic characters, joiners, and
// spaces that sit between two Arabic characters, so a phrase like الأصوات العربية stays one
// right-to-left span and its words keep their order. Punctuation such as "·" or "," ends the run.
const AR_RUN = new RegExp(`[${AR_CHARS}](?:[${AR_CHARS}\\u200C\\u200D]|[ \\u00A0]+(?=[${AR_CHARS}]))*`, "g");

/**
 * HTML-escape prose and wrap every run of Arabic in <span class="ar" lang="ar" dir="rtl">.
 * Use it for every prose string from data.js (COPY, descriptions, notes, labels).
 */
export function arabize(text) {
  const s = text == null ? "" : String(text);
  let out = "";
  let last = 0;
  for (const m of s.matchAll(AR_RUN)) {
    out += esc(s.slice(last, m.index)) + `<span class="ar" lang="ar" dir="rtl">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

const doc = () => (typeof document === "undefined" ? null : document);

// ---------- announcer (F34) ----------
let announceTimer = 0;

/**
 * Read a short message to screen readers through #announcer (aria-live="polite").
 * The region is cleared first and filled a moment later, so a repeated message is read again.
 */
export function announce(message) {
  const d = doc();
  if (!d) return;
  let el = d.getElementById("announcer");
  if (!el) {
    if (!d.body) return;
    el = d.createElement("div");
    el.id = "announcer";
    el.className = "visually-hidden";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    d.body.append(el);
  }
  clearTimeout(announceTimer);
  el.textContent = "";
  const text = message == null ? "" : String(message).trim();
  if (!text) return;
  announceTimer = setTimeout(() => { el.textContent = text; }, 80);
}

// ---------- status line (F9) ----------
let statusTimer = 0;
let statusSeq = 0;
let statusObserver = null;

/**
 * Keep --status-h on <html> at the room the message takes below the bar (0 when none shows).
 * base.css adds it to the page's scroll-padding-top, so a control that receives keyboard focus
 * is scrolled clear of the message as well as of the bar (WCAG 2.4.11).
 */
function trackStatusHeight(d, box) {
  const root = d.documentElement;
  statusObserver?.disconnect();
  statusObserver = null;
  if (!box) {
    root.style.removeProperty("--status-h");
    return;
  }
  const update = () => {
    const h = box.isConnected ? box.offsetTop + box.offsetHeight : 0;
    root.style.setProperty("--status-h", `${Math.ceil(h)}px`);
  };
  update();
  if (typeof ResizeObserver === "function") {
    statusObserver = new ResizeObserver(update);
    statusObserver.observe(box);
  }
}

const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

/**
 * Show a message in the visible status line (#status, role="status"). It hangs just under the
 * sticky bar, so it can be seen from anywhere on the page.
 * @param {string} message  plain text (Arabic in it is marked up automatically)
 * @param {{ kind?: "info"|"error", retry?: () => unknown, timeout?: number }} [options]
 *   retry adds a "Try again" button; timeout (ms, optional) hides an info message on its own.
 */
export function setStatus(message, { kind = "info", retry, timeout = 0 } = {}) {
  const d = doc();
  const el = d?.getElementById("status");
  if (!el) return;
  const text = message == null ? "" : String(message).trim();
  if (!text) {
    clearStatus();
    return;
  }
  clearTimeout(statusTimer);
  const seq = ++statusSeq;
  const k = kind === "error" ? "error" : "info";
  const hadFocus = el.contains(d.activeElement);

  el.dataset.kind = k;
  el.innerHTML =
    `<div class="status-box" data-kind="${k}">` +
    `<span class="status-ic" aria-hidden="true"></span>` +
    `<p class="status-msg">${arabize(text)}</p>` +
    (typeof retry === "function" ? `<button type="button" class="btn is-primary status-retry">Try again</button>` : "") +
    `<button type="button" class="status-close" aria-label="Dismiss message">${ICON_CLOSE}</button>` +
    `</div>`;

  const box = el.firstElementChild;
  const retryBtn = box.querySelector(".status-retry");
  const closeBtn = box.querySelector(".status-close");
  retryBtn?.addEventListener("click", () => {
    try {
      const r = retry();
      if (r && typeof r.catch === "function") r.catch(() => { /* the caller reports its own errors */ });
    } catch (err) {
      console.warn("[ui] retry failed:", err);
    }
  });
  closeBtn.addEventListener("click", () => clearStatus());
  box.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.stopPropagation();
      clearStatus();
    }
  });
  // Keep keyboard focus inside the line when it is replaced while focused (for example after Try again).
  if (hadFocus) (retryBtn || closeBtn).focus({ preventScroll: true });
  trackStatusHeight(d, box);

  const ms = Number(timeout);
  if (k === "info" && Number.isFinite(ms) && ms > 0) {
    const hide = () => {
      if (seq !== statusSeq) return;
      // Never pull a message away from someone who is pointing at it or focused in it.
      if (box.matches(":hover") || box.contains(d.activeElement)) {
        statusTimer = setTimeout(hide, 2000);
        return;
      }
      clearStatus();
    };
    statusTimer = setTimeout(hide, ms);
  }
}

/** Remove the status message. */
export function clearStatus() {
  const d = doc();
  const el = d?.getElementById("status");
  clearTimeout(statusTimer);
  statusSeq++;
  if (d) trackStatusHeight(d, null);
  if (!el) return;
  el.innerHTML = "";
  delete el.dataset.kind;
}

// ---------- preferences ----------
const PREF_PREFIX = "asl:";

/**
 * Saved settings (speed, voice, theme, view) in localStorage. Every access is guarded:
 * private windows and blocked storage fall back to the defaults instead of throwing.
 */
export const prefs = {
  get(name, fallback = null) {
    try {
      const raw = globalThis.localStorage?.getItem(PREF_PREFIX + name);
      if (raw == null) return fallback;
      try {
        const v = JSON.parse(raw);
        return v ?? fallback;
      } catch {
        return raw; // a plain string written by an older version
      }
    } catch {
      return fallback;
    }
  },
  set(name, value) {
    try {
      const ls = globalThis.localStorage;
      if (!ls) return;
      if (value === undefined || value === null) ls.removeItem(PREF_PREFIX + name);
      else ls.setItem(PREF_PREFIX + name, JSON.stringify(value));
    } catch {
      /* storage full or blocked: the setting simply is not remembered */
    }
  },
};

// ---------- shared play button ----------

/**
 * Markup for the shared play button. ar, sub and label are plain text (escaped here; Arabic inside
 * sub is marked up); attrs is raw attribute markup the caller has escaped, e.g. `data-x="…"`.
 * label becomes the aria-label and should be unique on the page for repeated buttons.
 */
export function playButton({ ar = "", sub = "", label = "", attrs = "" } = {}) {
  const name = label == null ? "" : String(label).trim();
  const extra = attrs ? ` ${String(attrs).trim()}` : "";
  const subText = sub == null ? "" : String(sub);
  return (
    `<button class="play-btn" type="button"${name ? ` aria-label="${esc(name)}"` : ""}${extra}>` +
    `<span class="play-ic" aria-hidden="true"></span>` +
    `<span class="play-txt"><span class="ar" lang="ar" dir="rtl">${esc(ar)}</span>` +
    (subText ? `<small>${arabize(subText)}</small>` : "") +
    `</span></button>`
  );
}
