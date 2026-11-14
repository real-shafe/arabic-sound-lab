// Offline use (F31): registers the service worker (sw.js) and renders the
// "Save audio for offline use" box in the footer (#offline-root).
//
// The service worker saves the page itself when it installs. This box asks it
// to download every clip of the selected voice, both speeds, and shows the
// progress it reports back. No DOM access at import time.

import { announce } from "./ui.js";

// Same name as CLIPS_CACHE in sw.js (tests/sw.test.mjs checks they match).
const CLIPS_CACHE = "asl-clips-v2";
const SAMPLE_COUNT = 8; // clips measured with HEAD to estimate the download size
const FALLBACK_CLIP_BYTES = 9000; // 64 kbps mono MP3s of about a second
const READY_TIMEOUT_MS = 10000; // wait this long for the service worker to activate
const STALL_MS = 30000; // no progress for this long counts as stopped

const supportsOffline = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof caches !== "undefined" &&
  globalThis.isSecureContext !== false;

/**
 * @param {{ root?: HTMLElement | null, engine?: object }} options
 */
export function initOffline({ root, engine } = {}) {
  const supported = supportsOffline();
  const registration = supported ? registerWorker() : Promise.resolve(null);
  if (!root) return;

  root.classList.add("off");
  if (!supported) {
    root.innerHTML =
      '<h2 class="off-title">Offline use</h2>' +
      '<p class="off-desc muted">Saving the page for offline use needs a browser with service workers, on a secure (https) connection.</p>';
    return;
  }

  root.innerHTML =
    '<h2 class="off-title">Offline use</h2>' +
    '<p class="off-desc">Save the page and every clip of the selected voice in this browser, so the lab keeps working without a connection.</p>' +
    '<div class="off-row">' +
    '<button type="button" class="btn off-btn" aria-describedby="off-size" aria-disabled="true">Save audio for offline use</button>' +
    '<span class="off-size muted" id="off-size">Loading the audio list…</span>' +
    "</div>" +
    '<div class="off-progress" hidden>' +
    '<progress class="off-bar" max="1" value="0" aria-label="Clips saved"></progress>' +
    '<span class="off-count"></span>' +
    "</div>" +
    '<p class="off-status" hidden></p>';

  const button = root.querySelector(".off-btn");
  const sizeEl = root.querySelector(".off-size");
  const progressEl = root.querySelector(".off-progress");
  const bar = root.querySelector(".off-bar");
  const countEl = root.querySelector(".off-count");
  const statusEl = root.querySelector(".off-status");

  const estimates = new Map(); // voice key -> Promise<bytes>
  let saving = false;
  let refreshToken = 0;
  // The size is measured (a few HEAD requests) only once the box has been on screen.
  let seen = typeof IntersectionObserver !== "function";

  const voiceKey = () => engine?.voice ?? null;
  const voiceName = key => engine?.voices?.find(v => v.key === key)?.name ?? key ?? "";
  const urlsFor = key => {
    if (!engine || engine.state !== "ready" || typeof engine.allUrls !== "function") return [];
    return engine.allUrls({ voice: key }).map(u => new URL(u, document.baseURI).href);
  };

  // The button is switched off with aria-disabled rather than the disabled
  // property: a disabled button drops keyboard focus to <body>, and the button
  // is usually focused when it switches off (right after it is pressed, and
  // when the save finishes). An aria-disabled button keeps focus, stays in the
  // tab order and is announced as unavailable; save() ignores presses on it.
  function setEnabled(on) {
    if (on) button.removeAttribute("aria-disabled");
    else button.setAttribute("aria-disabled", "true");
  }
  const isEnabled = () => button.getAttribute("aria-disabled") !== "true";

  function setStatusText(text) {
    statusEl.textContent = text || "";
    statusEl.hidden = !text;
  }

  function showProgress(done, total) {
    progressEl.hidden = false;
    bar.max = Math.max(total, 1);
    bar.value = Math.min(done, total);
    countEl.textContent = `${done} of ${total} clips`;
  }

  /** Refreshes the button and size line for the current voice and engine state. */
  async function refresh() {
    if (saving) return;
    const token = ++refreshToken;
    const state = engine?.state ?? "error";
    if (state === "loading") {
      setEnabled(false);
      sizeEl.textContent = "Loading the audio list…";
      return;
    }
    if (state !== "ready") {
      setEnabled(false);
      sizeEl.textContent = "The audio list did not load, so there is nothing to save yet.";
      return;
    }
    const key = voiceKey();
    const urls = urlsFor(key);
    const name = voiceName(key);
    if (!urls.length) {
      setEnabled(false);
      sizeEl.textContent = `No clips found for ${name}.`;
      return;
    }
    const [bytes, saved] = await Promise.all([seen ? estimateBytes(key, urls) : null, countSaved(urls)]);
    if (token !== refreshToken || saving) return;
    const size = bytes ? `${urls.length} clips, about ${formatBytes(bytes)}` : `${urls.length} clips`;
    if (saved >= urls.length) {
      setEnabled(false);
      sizeEl.textContent = `${name}: all ${urls.length} clips are saved in this browser.`;
    } else {
      setEnabled(true);
      sizeEl.textContent = saved > 0
        ? `${name}: ${size}. ${saved} already saved.`
        : `${name}: ${size}.`;
    }
  }

  function estimateBytes(key, urls) {
    if (!estimates.has(key)) estimates.set(key, measure(urls));
    return estimates.get(key);
  }

  async function save() {
    if (saving || !isEnabled()) return;
    const key = voiceKey();
    const urls = urlsFor(key);
    if (!urls.length) return;
    const name = voiceName(key);
    saving = true;
    setEnabled(false);
    button.textContent = "Saving…";
    setStatusText("");
    showProgress(0, urls.length);
    announce(`Saving ${urls.length} clips for offline use.`);
    navigator.storage?.persist?.().catch(() => {});

    let result;
    try {
      const reg = await registration;
      const worker = reg && (await activeWorker(reg));
      if (!worker) throw new Error("no active service worker");
      result = await runJob(worker, urls, (done, total) => showProgress(done, total));
    } catch (err) {
      console.warn("[offline] could not save the clips:", err);
      result = { error: err?.message === "stalled" ? "stalled" : "unavailable" };
    }

    saving = false;
    button.textContent = "Save audio for offline use";
    const message = describeResult(result, urls.length, name, await otherVoicesUnsaved(key));
    setStatusText(message);
    announce(message);
    if (!result.error && !result.failed) progressEl.hidden = true;
    refresh();
  }

  function describeResult(result, total, name, othersUnsaved) {
    const saved = Math.max(0, (result.done ?? 0) - (result.failed ?? 0));
    if (result.error === "unavailable") {
      return "Offline saving is not available right now. Reload the page and try again.";
    }
    if (result.error === "stalled") {
      return "Saving stopped before it finished. Press the button again to save the rest.";
    }
    if (result.error === "storage") {
      return "This browser would not let the page store files. Private browsing can block it.";
    }
    if (result.error === "quota") {
      return `The browser ran out of storage space after ${saved} of ${total} clips. Free some space and try again.`;
    }
    if (result.failed) {
      return `Saved ${saved} of ${total} clips. ${result.failed} could not be downloaded; try again on a better connection.`;
    }
    const tail = othersUnsaved ? " To use the other voice offline too, switch voice and save again." : "";
    return `Saved all ${total} clips for ${name}. The page and these clips now work without a connection.${tail}`;
  }

  async function otherVoicesUnsaved(key) {
    const others = (engine?.voices ?? []).filter(v => v.key !== key);
    for (const v of others) {
      const urls = urlsFor(v.key);
      if (urls.length && (await countSaved(urls)) < urls.length) return true;
    }
    return false;
  }

  button.addEventListener("click", save);

  // Refresh when the audio list loads, when the voice changes (the voice
  // buttons in #bar carry data-voice), and whenever the box scrolls into view.
  engine?.on?.("state", () => refresh());
  document.addEventListener("change", e => {
    if (e.target instanceof Element && e.target.closest("#voice")) setTimeout(refresh, 0);
  });
  document.addEventListener("click", e => {
    if (e.target instanceof Element && e.target.closest("[data-voice]")) setTimeout(refresh, 0);
  });
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      seen = true;
      refresh();
    }).observe(root);
  }
  refresh();
}

// ---------- service worker ----------

function registerWorker() {
  return new Promise(resolve => {
    const go = () => {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).then(resolve, err => {
        console.warn("[offline] service worker registration failed:", err);
        resolve(null);
      });
    };
    // Register after the page has loaded, so it doesn't compete with first paint.
    if (document.readyState === "complete") go();
    else window.addEventListener("load", go, { once: true });
  });
}

async function activeWorker(reg) {
  if (reg.active) return reg.active;
  const ready = navigator.serviceWorker.ready.then(r => r.active);
  const timeout = new Promise(resolve => setTimeout(resolve, READY_TIMEOUT_MS, null));
  return Promise.race([ready, timeout]);
}

/** Posts one cache-clips job and resolves with the worker's final report. */
function runJob(worker, urls, onProgress) {
  const container = navigator.serviceWorker;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    let stallTimer;
    const arm = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish(null, new Error("stalled")), STALL_MS);
    };
    const finish = (value, err) => {
      clearTimeout(stallTimer);
      container.removeEventListener("message", onMessage);
      if (err) reject(err);
      else resolve(value);
    };
    const onMessage = event => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || msg.id !== id) return;
      if (msg.type === "cache-progress") {
        arm();
        onProgress(msg.done ?? 0, msg.total ?? urls.length);
      } else if (msg.type === "cache-done") {
        onProgress(msg.done ?? 0, msg.total ?? urls.length);
        finish({ done: msg.done ?? 0, total: msg.total ?? urls.length, failed: msg.failed ?? 0, error: msg.error });
      }
    };
    container.addEventListener("message", onMessage);
    container.startMessages?.();
    arm();
    worker.postMessage({ type: "cache-clips", urls, id });
  });
}

// ---------- cache inspection and size ----------

/** How many of these absolute URLs are already in the clip cache. */
async function countSaved(urls) {
  try {
    if (!(await caches.has(CLIPS_CACHE))) return 0;
    const cache = await caches.open(CLIPS_CACHE);
    const have = new Set((await cache.keys()).map(r => r.url.split("?")[0]));
    return urls.reduce((n, u) => n + (have.has(u) ? 1 : 0), 0);
  } catch {
    return 0;
  }
}

/** Total download size: the average Content-Length of a few clips times the count. */
async function measure(urls) {
  const step = Math.max(1, Math.floor(urls.length / SAMPLE_COUNT));
  const sample = [];
  for (let i = 0; i < urls.length && sample.length < SAMPLE_COUNT; i += step) sample.push(urls[i]);
  const sizes = await Promise.all(sample.map(async u => {
    try {
      const res = await fetch(u, { method: "HEAD" });
      const n = Number(res.headers.get("content-length"));
      return res.ok && n > 0 ? n : null;
    } catch {
      return null;
    }
  }));
  const known = sizes.filter(n => n !== null);
  const average = known.length ? known.reduce((a, b) => a + b, 0) / known.length : FALLBACK_CLIP_BYTES;
  return average * urls.length;
}

function formatBytes(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
