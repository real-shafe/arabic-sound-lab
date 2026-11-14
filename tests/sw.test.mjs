// Checks the offline and caching setup (F31, F35, F36): the service worker's
// precache list against the files in public/, its routing and clip saving
// (run in a sandbox with fake caches and fetch), the font files and
// fonts.css, the _headers rules, and the web app manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const read = rel => readFileSync(join(PUBLIC, rel), "utf8");
const listDir = (rel, ext) => (existsSync(join(PUBLIC, rel)) ? readdirSync(join(PUBLIC, rel)).filter(n => n.endsWith(ext)) : []);
const ORIGIN = "https://arabic-sound-lab.test";
const SW_SOURCE = read("sw.js");

// ---------- a sandboxed service worker ----------

function makeResponse(url, body = "", { status = 200, type = "basic", redirected = false } = {}) {
  return {
    url, body, status, type, redirected, ok: status >= 200 && status < 300,
    clone() { return makeResponse(url, body, { status, type, redirected }); },
  };
}

/**
 * Fake CacheStorage + fetch. `files` maps site paths ("/js/app.js") to bodies;
 * `delay` (ms) makes every online fetch answer that much later.
 */
function makeEnv({ files = {}, online = true, delay = 0 } = {}) {
  const stores = new Map();
  const fetched = [];
  const keyOf = r => (typeof r === "string" ? r : r.url);
  const bare = u => u.split("?")[0];
  const cacheObject = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async match(req, opts = {}) {
        const u = keyOf(req);
        if (m.has(u)) return m.get(u);
        if (opts.ignoreSearch) for (const [k, v] of m) if (bare(k) === bare(u)) return v;
        return undefined;
      },
      async put(req, res) { m.set(keyOf(req), res); },
      async keys() { return [...m.keys()].map(url => ({ url })); },
      async delete(req) { return m.delete(keyOf(req)); },
    };
  };
  const caches = {
    async open(name) { return cacheObject(name); },
    async keys() { return [...stores.keys()]; },
    async has(name) { return stores.has(name); },
    async delete(name) { return stores.delete(name); },
  };
  const env = {
    stores, fetched, caches,
    online,
    async fetch(input) {
      const url = keyOf(input);
      fetched.push(url);
      if (!env.online) throw new TypeError("Failed to fetch");
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const path = new URL(url).pathname;
      return path in files ? makeResponse(url, files[path]) : makeResponse(url, "Not found", { status: 404 });
    },
  };
  return env;
}

class FakeRequest {
  constructor(url, init = {}) { this.url = String(url); this.cache = init.cache; }
}

/**
 * Runs sw.js in a sandbox. `timers` replaces the worker's setTimeout and
 * clearTimeout, so a test can make any timer in it fire at once.
 */
function loadWorker(env = makeEnv(), { timers = { setTimeout, clearTimeout } } = {}) {
  const listeners = {};
  const posted = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { scope: `${ORIGIN}/` },
    addEventListener(type, fn) { listeners[type] = fn; },
    async skipWaiting() {},
    clients: { async claim() {} },
  };
  const context = vm.createContext({
    self, console: { warn() {}, log() {}, error() {} }, URL,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    caches: env.caches, fetch: env.fetch, Request: FakeRequest,
  });
  vm.runInContext(
    SW_SOURCE + "\n;globalThis.__sw = { PRECACHE, SHELL_CACHE, CLIPS_CACHE, routeFor, clipUrl };",
    context,
    { filename: "sw.js" },
  );
  const sw = context.__sw;
  return {
    env, listeners, posted,
    PRECACHE: Array.from(sw.PRECACHE),
    SHELL_CACHE: sw.SHELL_CACHE,
    CLIPS_CACHE: sw.CLIPS_CACHE,
    routeFor: sw.routeFor,
    clipUrl: sw.clipUrl,
  };
}

function extendableEvent(extra = {}) {
  const waits = [];
  return { waits, waitUntil(p) { waits.push(Promise.resolve(p)); }, ...extra, settle: () => Promise.allSettled(waits) };
}

function fetchEvent(url, { mode = "cors", method = "GET" } = {}) {
  const ev = extendableEvent({
    request: { url, mode, method, headers: { has: () => false } },
    response: null,
  });
  ev.respondWith = p => { ev.response = Promise.resolve(p); };
  return ev;
}

const { PRECACHE, SHELL_CACHE, CLIPS_CACHE } = loadWorker();
const fileFor = entry => (entry === "./" ? "index.html" : entry);

// ---------- precache list ----------

test("service worker cache names", () => {
  assert.equal(SHELL_CACHE, "asl-shell-v4");
  assert.equal(CLIPS_CACHE, "asl-clips-v2");
  const offline = read("js/offline.js");
  const m = /const CLIPS_CACHE = "([^"]+)"/.exec(offline);
  assert.ok(m, "js/offline.js defines CLIPS_CACHE");
  assert.equal(m[1], CLIPS_CACHE, "js/offline.js reads the same clip cache as sw.js");
});

test("every precached file exists in public/", () => {
  assert.equal(new Set(PRECACHE).size, PRECACHE.length, "no duplicates");
  const missing = PRECACHE.filter(entry => !existsSync(join(PUBLIC, fileFor(entry))));
  assert.deepEqual(missing, []);
  for (const entry of PRECACHE) {
    assert.ok(!entry.startsWith("/") && !entry.includes(".."), `${entry} is relative to the site root`);
    assert.ok(!/^(sw\.js|_headers|clips\/)/.test(entry), `${entry} must not be precached`);
  }
});

test("the precache list covers the page, every script, stylesheet and font", () => {
  for (const must of ["./", "data.js", "audio.json", "favicon.svg", "site.webmanifest", "css/fonts.css"]) {
    assert.ok(PRECACHE.includes(must), `${must} is precached`);
  }
  const unlisted = [
    ...listDir("js", ".js").map(n => `js/${n}`),
    ...listDir("css", ".css").map(n => `css/${n}`),
    ...listDir("fonts", ".woff2").map(n => `fonts/${n}`),
  ].filter(rel => !PRECACHE.includes(rel));
  assert.deepEqual(unlisted, [], "files in public/ that sw.js does not precache");
});

// ---------- routing and caching behaviour ----------

test("routes: clips and fonts cache first, shell files network first, everything else untouched", () => {
  const { routeFor } = loadWorker();
  assert.equal(routeFor(`${ORIGIN}/clips/chaouki/0123456789ab.mp3`), "clips");
  assert.equal(routeFor(`${ORIGIN}/fonts/amiri-arabic-400-normal.woff2`), "fonts");
  assert.equal(routeFor(`${ORIGIN}/js/app.js`), "shell");
  assert.equal(routeFor(`${ORIGIN}/audio.json`), "shell");
  assert.equal(routeFor(`${ORIGIN}/`, "navigate"), "shell");
  assert.equal(routeFor(`${ORIGIN}/?utm=x`, "navigate"), "shell");
  assert.equal(routeFor(`${ORIGIN}/og.png`), null, "files outside the shell go to the network");
  assert.equal(routeFor(`${ORIGIN}/sw.js`), null);
  assert.equal(routeFor("https://elsewhere.test/js/app.js"), null, "other origins are not intercepted");
});

test("clip URLs from the page are validated", () => {
  const { clipUrl } = loadWorker();
  assert.equal(clipUrl("clips/asmaa/0123456789ab.mp3"), `${ORIGIN}/clips/asmaa/0123456789ab.mp3`);
  assert.equal(clipUrl(`${ORIGIN}/clips/asmaa/0123456789ab.mp3?v=1`), `${ORIGIN}/clips/asmaa/0123456789ab.mp3`);
  assert.equal(clipUrl("https://elsewhere.test/clips/asmaa/0123456789ab.mp3"), null);
  assert.equal(clipUrl("js/app.js"), null);
  assert.equal(clipUrl("clips/../js/app.js"), null);
  assert.equal(clipUrl(42), null);
});

test("install saves the shell and tolerates a missing file", async () => {
  const files = Object.fromEntries(PRECACHE.map(p => [new URL(p, `${ORIGIN}/`).pathname, `body of ${p}`]));
  delete files["/audio.json"];
  const w = loadWorker(makeEnv({ files }));
  const ev = extendableEvent();
  w.listeners.install(ev);
  const [result] = await ev.settle();
  assert.equal(result.status, "fulfilled", "install succeeds even with a file missing");
  const shell = w.env.stores.get(SHELL_CACHE);
  assert.equal(shell.size, PRECACHE.length - 1);
  assert.ok(shell.has(`${ORIGIN}/`), "the page is saved under /");
  assert.ok(!shell.has(`${ORIGIN}/audio.json`));
});

test("activate removes old asl- caches and unlisted shell entries", async () => {
  const w = loadWorker();
  const { caches, stores } = w.env;
  await (await caches.open("asl-shell-v1")).put(`${ORIGIN}/`, makeResponse(`${ORIGIN}/`));
  await (await caches.open("other-app")).put(`${ORIGIN}/x`, makeResponse(`${ORIGIN}/x`));
  const shell = await caches.open(SHELL_CACHE);
  await shell.put(`${ORIGIN}/js/app.js`, makeResponse(`${ORIGIN}/js/app.js`));
  await shell.put(`${ORIGIN}/fonts/old-font.woff2`, makeResponse(`${ORIGIN}/fonts/old-font.woff2`));
  const ev = extendableEvent();
  w.listeners.activate(ev);
  await ev.settle();
  assert.ok(!stores.has("asl-shell-v1"));
  assert.ok(stores.has("other-app"), "caches of other apps are left alone");
  assert.ok(stores.get(SHELL_CACHE).has(`${ORIGIN}/js/app.js`));
  assert.ok(!stores.get(SHELL_CACHE).has(`${ORIGIN}/fonts/old-font.woff2`));
});

test("a saved clip is served without touching the network", async () => {
  const w = loadWorker(makeEnv({ online: false }));
  const url = `${ORIGIN}/clips/chaouki/0123456789ab.mp3`;
  await (await w.env.caches.open(CLIPS_CACHE)).put(url, makeResponse(url, "mp3"));
  const ev = fetchEvent(url);
  w.listeners.fetch(ev);
  assert.ok(ev.response, "the worker answers");
  assert.equal((await ev.response).body, "mp3");
  assert.deepEqual(w.env.fetched, []);
});

test("an unsaved clip is fetched and then kept", async () => {
  const w = loadWorker(makeEnv({ files: { "/clips/asmaa/0123456789ab.mp3": "mp3" } }));
  const url = `${ORIGIN}/clips/asmaa/0123456789ab.mp3`;
  const ev = fetchEvent(url);
  w.listeners.fetch(ev);
  assert.equal((await ev.response).body, "mp3");
  await ev.settle();
  assert.ok(w.env.stores.get(CLIPS_CACHE).has(url));
});

test("offline, the page and its scripts come from the saved shell", async () => {
  const w = loadWorker(makeEnv({ online: false }));
  const shell = await w.env.caches.open(SHELL_CACHE);
  await shell.put(`${ORIGIN}/`, makeResponse(`${ORIGIN}/`, "page"));
  await shell.put(`${ORIGIN}/js/app.js`, makeResponse(`${ORIGIN}/js/app.js`, "app"));

  const page = fetchEvent(`${ORIGIN}/?from=home`, { mode: "navigate" });
  w.listeners.fetch(page);
  assert.equal((await page.response).body, "page");

  const script = fetchEvent(`${ORIGIN}/js/app.js`);
  w.listeners.fetch(script);
  assert.equal((await script.response).body, "app");
});

test("online, shell files come from the network and refresh the saved copy", async () => {
  const w = loadWorker(makeEnv({ files: { "/js/app.js": "new app" } }));
  const shell = await w.env.caches.open(SHELL_CACHE);
  await shell.put(`${ORIGIN}/js/app.js`, makeResponse(`${ORIGIN}/js/app.js`, "old app"));
  const ev = fetchEvent(`${ORIGIN}/js/app.js`);
  w.listeners.fetch(ev);
  assert.equal((await ev.response).body, "new app");
  await ev.settle();
  assert.equal(w.env.stores.get(SHELL_CACHE).get(`${ORIGIN}/js/app.js`).body, "new app");
});

// Timers that fire straight away: if sw.js raced the network against a timer,
// the timer would win here, before the slow fetch answers.
const instantTimers = {
  setTimeout: (fn, _ms, ...args) => setImmediate(fn, ...args),
  clearTimeout: handle => clearImmediate(handle),
};

test("online but slow, shell files and audio.json still come from the network, not the saved copy", async () => {
  const files = { "/": "new page", "/js/app.js": "new app", "/audio.json": "new manifest" };
  const w = loadWorker(makeEnv({ files, delay: 30 }), { timers: instantTimers });
  const shell = await w.env.caches.open(SHELL_CACHE);
  await shell.put(`${ORIGIN}/`, makeResponse(`${ORIGIN}/`, "old page"));
  await shell.put(`${ORIGIN}/js/app.js`, makeResponse(`${ORIGIN}/js/app.js`, "old app"));
  await shell.put(`${ORIGIN}/audio.json`, makeResponse(`${ORIGIN}/audio.json`, "old manifest"));

  const events = [
    [fetchEvent(`${ORIGIN}/`, { mode: "navigate" }), "new page"],
    [fetchEvent(`${ORIGIN}/js/app.js`), "new app"],
    [fetchEvent(`${ORIGIN}/audio.json`), "new manifest"],
  ];
  for (const [ev, body] of events) {
    w.listeners.fetch(ev);
    assert.equal((await ev.response).body, body, ev.request.url);
    await ev.settle();
  }
  assert.equal(w.env.stores.get(SHELL_CACHE).get(`${ORIGIN}/audio.json`).body, "new manifest", "the saved copy is refreshed");
});

test("offline with nothing saved, a shell request fails instead of hanging", async () => {
  const w = loadWorker(makeEnv({ online: false }));
  const ev = fetchEvent(`${ORIGIN}/js/app.js`);
  w.listeners.fetch(ev);
  await assert.rejects(ev.response);
});

test("non-GET, cross-origin and unlisted requests are left to the browser", () => {
  const w = loadWorker();
  for (const ev of [
    fetchEvent(`${ORIGIN}/js/app.js`, { method: "HEAD" }),
    fetchEvent("https://elsewhere.test/x.js"),
    fetchEvent(`${ORIGIN}/og.png`),
  ]) {
    w.listeners.fetch(ev);
    assert.equal(ev.response, null, ev.request.url);
  }
});

test("cache-clips saves the clips, reports progress and tidies stale clips of that voice", async () => {
  const good = ["clips/chaouki/aaaaaaaaaaaa.mp3", "clips/chaouki/bbbbbbbbbbbb.mp3", "clips/chaouki/cccccccccccc.mp3"];
  const files = Object.fromEntries(good.map(p => [`/${p}`, p]));
  const w = loadWorker(makeEnv({ files }));
  const clips = await w.env.caches.open(CLIPS_CACHE);
  await clips.put(`${ORIGIN}/clips/chaouki/000000000000.mp3`, makeResponse("stale"));
  await clips.put(`${ORIGIN}/clips/asmaa/111111111111.mp3`, makeResponse("other voice"));

  const messages = [];
  const ev = extendableEvent({
    data: { type: "cache-clips", id: "job1", urls: [...good, good[0], "https://elsewhere.test/clips/x/y.mp3", "js/app.js", "clips/chaouki/dddddddddddd.mp3"] },
    source: { postMessage: m => messages.push(m) },
  });
  w.listeners.message(ev);
  await ev.settle();

  const done = messages.at(-1);
  assert.equal(done.type, "cache-done");
  assert.equal(done.id, "job1");
  assert.equal(done.total, 4, "duplicates and foreign URLs are dropped");
  assert.equal(done.done, 4);
  assert.equal(done.failed, 1, "the one clip the server doesn't have");
  assert.ok(messages.some(m => m.type === "cache-progress"), "progress is reported");
  const saved = w.env.stores.get(CLIPS_CACHE);
  for (const p of good) assert.ok(saved.has(`${ORIGIN}/${p}`), p);
  assert.ok(!saved.has(`${ORIGIN}/clips/chaouki/000000000000.mp3`), "stale clip of the same voice removed");
  assert.ok(saved.has(`${ORIGIN}/clips/asmaa/111111111111.mp3`), "other voice untouched");
});

// ---------- fonts (F36) ----------

function fontFaces() {
  const css = read("css/fonts.css");
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
    family: /font-family:\s*"([^"]+)"/.exec(body)?.[1],
    weight: Number(/font-weight:\s*(\d+)/.exec(body)?.[1]),
    style: /font-style:\s*(\w+)/.exec(body)?.[1],
    display: /font-display:\s*(\w+)/.exec(body)?.[1],
    urls: [...body.matchAll(/url\("?([^")]+)"?\)/g)].map(m => m[1]),
    range: /unicode-range:\s*([^;]+);/.exec(body)?.[1],
  }));
}

test("fonts.css declares only the faces the page uses, self-hosted", () => {
  const faces = fontFaces();
  assert.ok(faces.length > 0, "fonts.css has @font-face rules");
  const weights = {};
  for (const f of faces) (weights[f.family] ??= new Set()).add(f.weight);
  assert.deepEqual(Object.keys(weights).sort(), ["Amiri", "IBM Plex Sans", "Noto Sans"]);
  assert.deepEqual([...weights.Amiri], [400]);
  assert.deepEqual([...weights["IBM Plex Sans"]].sort(), [400, 600]);
  assert.deepEqual([...weights["Noto Sans"]].sort(), [400, 600]);
  const allowed = {
    "Amiri": /^amiri-arabic-(400)-normal\.[0-9a-f]{8}\.woff2$/,
    "IBM Plex Sans": /^ibm-plex-sans-(?:latin|latin-ext)-(400|600)-normal\.[0-9a-f]{8}\.woff2$/,
    "Noto Sans": /^noto-sans-(?:greek|latin|latin-ext)-(400|600)-normal\.[0-9a-f]{8}\.woff2$/,
  };
  for (const f of faces) {
    assert.equal(f.style, "normal");
    assert.equal(f.display, "swap", `${f.family} ${f.weight}: font-display swap`);
    assert.ok(f.range, `${f.family} ${f.weight}: has a unicode-range`);
    assert.equal(f.urls.length, 1);
    const [url] = f.urls;
    assert.ok(url.startsWith("../fonts/"), `${url} is self-hosted`);
    const name = url.slice("../fonts/".length);
    const m = allowed[f.family].exec(name);
    assert.ok(m, `${f.family} uses ${name}`);
    assert.equal(Number(m[1]), f.weight, `${name} is weight ${f.weight}`);
    assert.ok(existsSync(join(PUBLIC, "fonts", name)), `public/fonts/${name} exists`);
  }
  const used = new Set(faces.flatMap(f => f.urls.map(u => u.slice("../fonts/".length))));
  assert.deepEqual(listDir("fonts", ".woff2").filter(n => !used.has(n)), [], "no unused font files");
});

test("the font licenses ship with the fonts", () => {
  for (const pkg of ["amiri", "ibm-plex-sans", "noto-sans"]) {
    const rel = `fonts/LICENSE-${pkg}.txt`;
    assert.ok(existsSync(join(PUBLIC, rel)), rel);
    assert.match(read(rel), /SIL Open Font License/, rel);
  }
});

// ---------- _headers (F35) ----------

function headerRules() {
  const rules = [];
  for (const line of read("_headers").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: {} });
    else {
      const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
      assert.ok(m && rules.length, `bad _headers line: ${line}`);
      rules.at(-1).headers[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  return rules;
}
const patternRegex = p =>
  new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:[A-Za-z]\w*/g, "[^/]+") + "$");
const headersFor = (rules, path) => rules.filter(r => patternRegex(r.pattern).test(path));

test("_headers: clips and fonts are immutable, sw.js is revalidated", () => {
  const rules = headerRules();
  const cacheControl = path => headersFor(rules, path).map(r => r.headers["cache-control"]).filter(Boolean);
  assert.deepEqual(cacheControl("/clips/chaouki/0123456789ab.mp3"), ["public, max-age=31536000, immutable"]);
  assert.deepEqual(cacheControl("/fonts/amiri-arabic-400-normal.0123abcd.woff2"), ["public, max-age=31536000, immutable"]);
  assert.deepEqual(cacheControl("/sw.js"), ["no-cache"]);
  assert.deepEqual(cacheControl("/audio.json"), [], "the manifest keeps the default revalidation");
});

test("_headers: no two rules set the same header on one path", () => {
  const rules = headerRules();
  const samples = new Set(["/", "/index.html", "/audio.json", "/sw.js", "/js/app.js", "/css/app.css",
    "/clips/chaouki/0123456789ab.mp3", "/fonts/x.woff2", "/fonts/LICENSE-amiri.txt"]);
  for (const r of rules) samples.add(r.pattern.replace(/\*/g, "x/y.z").replace(/:[A-Za-z]\w*/g, "x"));
  for (const path of samples) {
    const seen = new Map();
    for (const r of headersFor(rules, path)) {
      for (const h of Object.keys(r.headers)) {
        assert.ok(!seen.has(h), `${path}: "${h}" set by both ${seen.get(h)} and ${r.pattern}`);
        seen.set(h, r.pattern);
      }
    }
  }
});

// ---------- favicon and web app manifest (F8) ----------

test("favicon.svg is an SVG with a viewBox", () => {
  const svg = read("favicon.svg");
  assert.match(svg, /^<svg[^>]*\sviewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<\/svg>\s*$/);
});

test("site.webmanifest is valid and its icons exist", () => {
  const m = JSON.parse(read("site.webmanifest"));
  assert.equal(m.name, "Arabic Sound Lab");
  assert.ok(m.short_name && m.short_name.length <= 12, "short_name fits under a home-screen icon");
  assert.equal(m.start_url, "/");
  assert.equal(m.display, "standalone");
  assert.match(m.theme_color, /^#[0-9A-Fa-f]{6}$/);
  assert.match(m.background_color, /^#[0-9A-Fa-f]{6}$/);
  // The installed app's splash and title bar must be the page's own colour, not an older scheme's.
  const pageColor = /<meta name="theme-color" content="(#[0-9A-Fa-f]{6})">/.exec(read("index.html"))?.[1];
  assert.ok(pageColor, "index.html names a theme colour");
  assert.equal(m.theme_color.toLowerCase(), pageColor.toLowerCase(), "manifest theme colour is the page's");
  assert.equal(m.background_color.toLowerCase(), pageColor.toLowerCase(), "manifest background is the page's");
  assert.ok(m.icons.some(i => i.src === "favicon.svg" && i.sizes === "any"), "SVG icon");
  assert.ok(m.icons.some(i => i.src === "apple-touch-icon.png" && i.sizes === "180x180"), "180px PNG icon");
  for (const icon of m.icons) assert.ok(existsSync(join(PUBLIC, icon.src)), `public/${icon.src} exists`);
});
