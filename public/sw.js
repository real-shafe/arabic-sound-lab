// Service worker for Arabic Sound Lab: lets the page and its audio work
// offline (F31).
//
// - Install: saves the app shell listed in PRECACHE.
// - Page, scripts, styles, data and audio.json: network first, so a deploy is
//   picked up on the next visit. The saved copy is used only when the request
//   fails (offline or a network error), never because the network is slow:
//   a slow answer could otherwise mix files from two deploys (a new app.js
//   with an old ui.js, or an old audio.json pointing at clips that are gone).
// - /clips/ and /fonts/: cache first. Their file names change whenever their
//   bytes do, so a saved copy never goes stale.
// - Message { type: "cache-clips", urls, id }: downloads and saves those clips
//   in small batches, posting { type: "cache-progress", done, total, failed, id }
//   and finally { type: "cache-done", done, total, failed, error?, id } back to
//   the page that asked (js/offline.js).
//
// A classic script (not a module), so it runs in every browser that has
// service workers. tests/sw.test.mjs checks PRECACHE against public/.

"use strict";

const SHELL_CACHE = "asl-shell-v3";
const CLIPS_CACHE = "asl-clips-v2"; // js/offline.js reads this cache by name
const CACHE_PREFIX = "asl-";

// Paths relative to this file, which sits at the site root. "./" is the page
// itself: Cloudflare redirects /index.html to /, and a redirected response
// can't answer a page load, so the page is saved under its real URL, "/".
const PRECACHE = [
  "./",
  "data.js",
  "audio.json",
  "favicon.svg",
  "site.webmanifest",
  "css/fonts.css",
  "css/app.css",
  "css/mouth.css",
  "css/offline.css",
  "js/app.js",
  "js/ui.js",
  "js/text.js",
  "js/audio.js",
  "js/mouth.js",
  "js/sounds.js",
  "js/views.js",
  "js/offline.js",
  // fonts:start (this block is written by scripts/copy-fonts.mjs)
  "fonts/amiri-arabic-400-normal.2dfffa91.woff2",
  "fonts/ibm-plex-sans-latin-400-normal.24828974.woff2",
  "fonts/ibm-plex-sans-latin-600-normal.90d9c226.woff2",
  "fonts/ibm-plex-sans-latin-ext-400-normal.c23e9877.woff2",
  "fonts/ibm-plex-sans-latin-ext-600-normal.2e84f56d.woff2",
  "fonts/noto-sans-greek-400-normal.3ed6a8d7.woff2",
  "fonts/noto-sans-greek-600-normal.2be63d27.woff2",
  "fonts/noto-sans-latin-400-normal.4251c444.woff2",
  "fonts/noto-sans-latin-600-normal.0a389be1.woff2",
  "fonts/noto-sans-latin-ext-400-normal.e6c7dd9c.woff2",
  "fonts/noto-sans-latin-ext-600-normal.fa1a6abe.woff2",
  // fonts:end
];

const CLIP_BATCH = 6;
const CLIP_PATH = /^clips\/[a-z0-9_-]+\/[A-Za-z0-9_-]+\.mp3$/;

const BASE = new URL("./", self.location.href); // the site root
const ROOT_URL = BASE.href;
const withoutSearch = url => {
  const u = new URL(url, BASE);
  return u.origin + u.pathname;
};
const PRECACHE_URLS = new Set(PRECACHE.map(withoutSearch));

/** Path relative to the site root, or null for other origins and paths above it. */
function relPath(url) {
  let u;
  try { u = new URL(url, BASE); } catch { return null; }
  if (u.origin !== BASE.origin || !u.pathname.startsWith(BASE.pathname)) return null;
  return u.pathname.slice(BASE.pathname.length);
}

/** How a GET request is handled: "clips" | "fonts" (cache first), "shell" (network first), or null (not at all). */
function routeFor(url, mode) {
  const rel = relPath(url);
  if (rel === null || rel === "sw.js") return null;
  if (rel.startsWith("clips/")) return "clips";
  if (rel.startsWith("fonts/")) return "fonts";
  if (mode === "navigate" || PRECACHE_URLS.has(withoutSearch(url))) return "shell";
  return null;
}

/** A same-origin clip URL from a page message, normalized, or null if it isn't one. */
function clipUrl(url) {
  if (typeof url !== "string") return null;
  const rel = relPath(url);
  return rel !== null && CLIP_PATH.test(rel) ? withoutSearch(url) : null;
}

const isCacheable = res => !!res && res.status === 200 && res.type === "basic" && !res.redirected;

// ---------- install / activate ----------

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const results = await Promise.allSettled(PRECACHE.map(async path => {
      const url = new URL(path, BASE).href;
      const res = await fetch(new Request(url, { cache: "reload" }));
      if (!isCacheable(res)) throw new Error(`${path}: HTTP ${res.status}`);
      await cache.put(url, res);
    }));
    const failed = results.filter(r => r.status === "rejected");
    // Missing files are filled in by the network-first handler on a later visit.
    if (failed.length) console.warn(`[sw] could not save ${failed.length} of ${PRECACHE.length} files:`, failed.map(r => r.reason?.message ?? r.reason));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== CLIPS_CACHE) await caches.delete(name);
    }
    // Drop shell entries that are no longer listed (for example fonts from an earlier build).
    const shell = await caches.open(SHELL_CACHE);
    for (const req of await shell.keys()) {
      if (!PRECACHE_URLS.has(withoutSearch(req.url))) await shell.delete(req);
    }
    await self.clients.claim();
  })());
});

// ---------- fetch ----------

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const route = routeFor(req.url, req.mode);
  if (route === "clips") event.respondWith(cacheFirst(event, req, CLIPS_CACHE));
  else if (route === "fonts") event.respondWith(cacheFirst(event, req, SHELL_CACHE));
  else if (route === "shell") event.respondWith(networkFirst(event, req));
});

async function cacheFirst(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (isCacheable(res)) {
    const copy = res.clone();
    event.waitUntil(cache.put(withoutSearch(request.url), copy).catch(() => {}));
  }
  return res;
}

async function networkFirst(event, request) {
  const isPage = request.mode === "navigate";
  const rel = relPath(request.url);
  // Every page load is answered from the one saved page, "/".
  const key = isPage ? ROOT_URL : withoutSearch(request.url);
  const store = isPage ? rel === "" || rel === "index.html" : PRECACHE_URLS.has(key);

  const network = fetch(request);
  event.waitUntil(network.then(res => {
    if (!store || !isCacheable(res)) return;
    const copy = res.clone();
    return caches.open(SHELL_CACHE).then(cache => cache.put(key, copy));
  }).catch(() => {}));

  // No timer: however long the network takes, its answer is the one used.
  try {
    return await network;
  } catch (err) {
    const hit = await caches.open(SHELL_CACHE)
      .then(cache => cache.match(key, { ignoreSearch: true }))
      .catch(() => undefined);
    if (hit) return hit;
    throw err;
  }
}

// ---------- "Save audio for offline use" ----------

let queue = Promise.resolve();
const enqueue = job => (queue = queue.then(job, job));

self.addEventListener("message", event => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "cache-clips") event.waitUntil(enqueue(() => cacheClips(msg, event.source)));
});

async function cacheClips({ urls, id = null }, client) {
  const post = message => {
    try { client?.postMessage({ ...message, id }); } catch { /* the page is gone */ }
  };
  const list = [...new Set((Array.isArray(urls) ? urls : []).map(clipUrl).filter(Boolean))];
  const total = list.length;
  let done = 0;
  let failed = 0;
  let error;

  let cache;
  try {
    cache = await caches.open(CLIPS_CACHE);
  } catch (err) {
    console.warn("[sw] cannot open the clip cache:", err);
    post({ type: "cache-done", done: 0, total, failed: total, error: "storage" });
    return;
  }
  post({ type: "cache-progress", done, total, failed });

  for (let i = 0; i < total && !error; i += CLIP_BATCH) {
    await Promise.all(list.slice(i, i + CLIP_BATCH).map(async url => {
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url);
          if (!isCacheable(res)) throw new Error(`HTTP ${res.status}`);
          await cache.put(url, res);
        }
      } catch (err) {
        failed++;
        if (err?.name === "QuotaExceededError") error = "quota";
        else console.warn(`[sw] could not save ${url}:`, err?.message ?? err);
      }
      done++;
    }));
    post({ type: "cache-progress", done, total, failed });
  }

  // Remove clips of the same voices that the current audio list no longer uses.
  if (!error && total) {
    try {
      const keep = new Set(list);
      const dirs = new Set(list.map(u => u.slice(0, u.lastIndexOf("/") + 1)));
      for (const req of await cache.keys()) {
        const u = withoutSearch(req.url);
        if (!keep.has(u) && dirs.has(u.slice(0, u.lastIndexOf("/") + 1))) await cache.delete(req);
      }
    } catch (err) {
      console.warn("[sw] could not tidy the clip cache:", err);
    }
  }

  post({ type: "cache-done", done, total, failed, ...(error ? { error } : {}) });
}
