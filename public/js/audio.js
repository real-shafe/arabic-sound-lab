// Web Audio playback engine.
//
// Every playable string has pre-generated clips listed in audio.json (two
// voices, two speeds; the slow clips are time-stretched by the generator, so
// the browser never changes the speed itself, F23). This module:
//   - loads that manifest (cache: "no-cache") and reports failures with a
//     plain message for visitors, never developer instructions (F9);
//   - keeps one AudioContext, created and resumed inside a user gesture by
//     unlock(), and asks iOS to treat it as media playback (F25);
//   - fetches and decodes every clip of a sequence BEFORE starting it, keeps
//     decoded buffers in a bounded cache, then schedules all of them back to
//     back on the AudioContext clock with a short gap (F24, F25);
//   - turns every failure into an "error" event with a visitor-facing message
//     plus a console.warn with details. Nothing fails silently.
//
// No DOM or network access happens at import time; everything starts in
// createAudioEngine().

import { key } from "./text.js";

const DEFAULT_VOICE = "chaouki";
const SPEEDS = ["normal", "slow"];
const DEFAULT_GAP_MS = { normal: 300, slow: 450 };
const MAX_GAP_MS = 5000;
const CACHE_MAX_ENTRIES = 300;
const CACHE_MAX_BYTES = 48 * 1024 * 1024; // decoded PCM is float32, about 190 KB per second per channel
const MANIFEST_TIMEOUT_MS = 20000;
const CLIP_TIMEOUT_MS = 20000;
const RESUME_TIMEOUT_MS = 2500;
const START_LEAD_S = 0.05; // schedule slightly ahead so the first sample is never clipped
const VOICE_KEY_RE = /^[a-z0-9_-]{1,40}$/i;

const MSG = {
  offline: "The audio could not be loaded. Check your connection and try again.",
  slow: "Loading the audio took too long. Check your connection and try again.",
  listHttp: status => `The audio list could not be loaded (error ${status}). Please try again later.`,
  listBad: "The audio list could not be read. Please try again later.",
  missing: (text, voiceName) => `No audio is available for ${text} in the ${voiceName} voice.`,
  unavailable: "This sound is not available.",
  clipLoad: text => `The audio for ${text} could not be loaded. Check your connection and try again.`,
  clipDecode: text => `The audio for ${text} could not be played in this browser.`,
  // play(…, { hideText: true }): the quiz prompt must not name the word it is asking about.
  missingHidden: voiceName => `No audio is available for this word in the ${voiceName} voice.`,
  clipLoadHidden: "The word could not be loaded. Check your connection and try again.",
  clipDecodeHidden: "The word could not be played in this browser.",
  unsupported: "Sound is not supported in this browser.",
  blocked: "The browser did not allow sound to start. Tap a play button again.",
  interrupted: "Playback was interrupted. Tap play to try again.",
  recording: "Your recording could not be played.",
  generic: "Something went wrong while playing the audio. Please try again.",
};

const own = (obj, k) => obj != null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, k);
const isEl = el => !!el && typeof el === "object" && !!el.classList && typeof el.classList.add === "function";
const isAudioBuffer = b => !!b && typeof b === "object" && typeof b.duration === "number" && typeof b.getChannelData === "function";

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/** An Error whose message is safe to show to visitors; the technical cause is kept for the console. */
function userError(message, cause) {
  const e = new Error(message);
  if (cause !== undefined) e.cause = cause;
  return e;
}

/**
 * fetch() with a timeout that covers the body as well as the headers.
 * `read(response)` turns the response into the value (it runs inside the timeout).
 */
async function fetchTimed(url, init, ms, read) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`timed out after ${ms} ms: ${url}`);
      e.name = "TimeoutError";
      reject(e);
      try { ac?.abort(); } catch { /* ignore */ }
    }, ms);
  });
  const work = (async () => read(await fetch(url, ac ? { ...init, signal: ac.signal } : init)))();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** decodeAudioData with both the promise form and the callback-only form of older Safari. */
function decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = buf => {
      if (settled) return;
      settled = true;
      if (isAudioBuffer(buf)) resolve(buf);
      else reject(new Error("decodeAudioData returned no buffer"));
    };
    const fail = err => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(`decodeAudioData failed${err ? `: ${err}` : ""}`));
    };
    try {
      const p = ctx.decodeAudioData(arrayBuffer, ok, fail);
      if (p && typeof p.then === "function") p.then(ok, fail);
    } catch (e) {
      fail(e);
    }
  });
}

/** Wait until the context is running (or give up after `ms`). Resolves true when running. */
function waitRunning(ctx, ms) {
  if (ctx.state === "running") return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    let timer = 0;
    const finish = v => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ctx.removeEventListener?.("statechange", onChange); } catch { /* ignore */ }
      resolve(v);
    };
    const onChange = () => { if (ctx.state === "running") finish(true); };
    timer = setTimeout(() => finish(ctx.state === "running"), ms);
    try { ctx.addEventListener?.("statechange", onChange); } catch { /* ignore */ }
    try {
      const p = ctx.resume?.();
      if (p && typeof p.then === "function") p.then(onChange, () => { /* reported by the caller on timeout */ });
    } catch { /* reported by the caller on timeout */ }
  });
}

/** Reference-counted CSS classes so overlapping marks on one element (whole + item) stay balanced. */
function createMarks() {
  const counts = new Map(); // el -> Map(className -> count)
  return {
    add(el, cls) {
      if (!isEl(el)) return;
      let m = counts.get(el);
      if (!m) counts.set(el, (m = new Map()));
      const n = (m.get(cls) || 0) + 1;
      m.set(cls, n);
      if (n === 1) el.classList.add(cls);
    },
    remove(el, cls) {
      const m = counts.get(el);
      const n = m?.get(cls);
      if (!n) return;
      if (n > 1) { m.set(cls, n - 1); return; }
      m.delete(cls);
      el.classList.remove(cls);
    },
    removeAll(cls) {
      for (const [el, m] of counts) {
        if (m.delete(cls)) el.classList.remove(cls);
      }
    },
    clear() {
      for (const [el, m] of counts) for (const cls of m.keys()) el.classList.remove(cls);
      counts.clear();
    },
  };
}

function normalizeItems(items) {
  const arr = Array.isArray(items) ? items : items == null ? [] : [items];
  return arr.map(it => (typeof it === "string" ? { text: it, el: null } : { text: it?.text, el: it?.el ?? null }));
}

/**
 * @param {{ manifestUrl?: string }} [options]
 */
export function createAudioEngine({ manifestUrl = "audio.json" } = {}) {
  const listeners = new Map(); // type -> Set<fn>
  let state = "loading";
  let manifest = null;
  let voices = Object.freeze([]);
  let voice = DEFAULT_VOICE;
  let speed = "normal";
  let ready = null;

  let ctx = null;
  let primed = false;
  let warnedNoWebAudio = false;
  let warnedAudioSession = false;

  let current = null; // the active playback session
  const cache = new Map(); // absolute clip URL -> { promise, bytes }, oldest first
  let cacheBytes = 0;

  const baseHref = globalThis.location?.href ?? "http://localhost/";
  const manifestHref = new URL(manifestUrl, baseHref).href;
  // Manifest clip URLs are relative to the site root, where audio.json lives.
  const absUrl = rel => new URL(rel, manifestHref).href;

  // ---------- events ----------
  function on(type, fn) {
    if (typeof fn !== "function") throw new TypeError("engine.on(type, fn): fn must be a function");
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => { set.delete(fn); };
  }
  function emit(type, detail) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(detail); } catch (e) { console.error(`[audio] "${type}" listener threw:`, e); }
    }
  }
  function setState(s) {
    if (state === s) return;
    state = s;
    emit("state", s);
  }

  // ---------- manifest ----------
  function parseVoices(m) {
    const out = [];
    const seen = new Set();
    for (const v of Array.isArray(m.voices) ? m.voices : []) {
      if (!v || typeof v.key !== "string" || !VOICE_KEY_RE.test(v.key) || seen.has(v.key)) continue;
      seen.add(v.key);
      out.push(Object.freeze({
        key: v.key,
        name: typeof v.name === "string" && v.name ? v.name : v.key,
        gender: typeof v.gender === "string" ? v.gender : "",
      }));
    }
    return Object.freeze(out);
  }

  async function fetchManifest() {
    let m;
    try {
      m = await fetchTimed(manifestHref, { cache: "no-cache" }, MANIFEST_TIMEOUT_MS, async res => {
        if (!res.ok) throw new HttpError(res.status, manifestHref);
        try {
          return await res.json();
        } catch (e) {
          throw userError(MSG.listBad, e);
        }
      });
    } catch (e) {
      if (e instanceof HttpError) throw userError(MSG.listHttp(e.status), e);
      if (e?.message === MSG.listBad) throw e;
      throw userError(e?.name === "TimeoutError" ? MSG.slow : MSG.offline, e);
    }
    if (!m || typeof m !== "object" || !m.clips || typeof m.clips !== "object" || Array.isArray(m.clips)) {
      throw userError(MSG.listBad, new Error(`${manifestHref} has no "clips" object`));
    }
    if (m.version !== 2) console.warn(`[audio] ${manifestHref} has version ${m.version}; this page expects version 2.`);
    const vs = parseVoices(m);
    if (!vs.length) throw userError(MSG.listBad, new Error(`${manifestHref} lists no usable voices`));
    return { m, vs };
  }

  function load() {
    setState("loading");
    const p = fetchManifest().then(({ m, vs }) => {
      manifest = m;
      voices = vs;
      if (!voices.some(v => v.key === voice)) {
        const fallback = voices.some(v => v.key === DEFAULT_VOICE) ? DEFAULT_VOICE : voices[0].key;
        if (voice !== DEFAULT_VOICE) console.warn(`[audio] voice "${voice}" is not in the manifest; using "${fallback}".`);
        voice = fallback;
      }
      setState("ready");
      return m;
    });
    // This handler runs before any consumer's, so state is already "error" when they see the rejection.
    p.catch(err => {
      setState("error");
      console.warn("[audio] could not load the audio manifest:", err?.cause ?? err);
      emit("error", { message: err?.message || MSG.offline });
    });
    ready = p;
    return p;
  }

  function reload() {
    if (state === "loading" && ready) return ready;
    return load();
  }

  // ---------- voice and speed ----------
  function voiceName(k) {
    return voices.find(v => v.key === k)?.name ?? k;
  }

  function setVoice(k) {
    if (typeof k !== "string" || !VOICE_KEY_RE.test(k)) {
      console.warn("[audio] setVoice ignored an invalid voice key:", k);
      return voice;
    }
    if (manifest) {
      if (voices.some(v => v.key === k)) voice = k;
      else console.warn(`[audio] setVoice ignored unknown voice "${k}".`);
    } else {
      voice = k; // checked against the manifest once it loads
    }
    return voice;
  }

  function setSpeed(s) {
    if (SPEEDS.includes(s)) speed = s;
    else console.warn(`[audio] setSpeed ignored "${s}"; use "normal" or "slow".`);
    return speed;
  }

  function resolveVoice(k) {
    if (k == null) return voice;
    if (typeof k === "string" && voices.some(v => v.key === k)) return k;
    console.warn(`[audio] unknown voice "${k}" requested; using "${voice}".`);
    return voice;
  }

  // ---------- lookups ----------
  function urlFor(text, { voice: v, speed: s } = {}) {
    if (!manifest || text == null) return null;
    const k = key(text);
    if (!k || !own(manifest.clips, k)) return null;
    const entry = manifest.clips[k];
    const vk = v ?? voice;
    if (!own(entry, vk)) return null;
    const sk = SPEEDS.includes(s) ? s : speed;
    const u = own(entry[vk], sk) ? entry[vk][sk] : null;
    return typeof u === "string" && u ? u : null;
  }

  function has(text, opts = {}) {
    return urlFor(text, opts) !== null;
  }

  function allUrls({ voice: v } = {}) {
    if (!manifest) return [];
    const vk = v ?? voice;
    const out = new Set();
    for (const entry of Object.values(manifest.clips)) {
      if (!own(entry, vk)) continue;
      for (const s of SPEEDS) {
        const u = own(entry[vk], s) ? entry[vk][s] : null;
        if (typeof u === "string" && u) out.add(u);
      }
    }
    return [...out];
  }

  // ---------- AudioContext ----------
  function unlock() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) {
      if (!warnedNoWebAudio) {
        warnedNoWebAudio = true;
        console.warn("[audio] this browser has no Web Audio API (AudioContext).");
      }
      return null;
    }
    // iOS: play through the silent switch like other media (Safari 16.4+).
    // "play-and-record" is left alone: the recorder sets it for the length of a capture (iOS does
    // not capture while the page forces "playback") and puts the previous type back afterwards.
    // Taps during a recording (the Stop tap, a tile) must not switch it mid-capture.
    try {
      const session = globalThis.navigator?.audioSession;
      if (session && session.type !== "playback" && session.type !== "play-and-record") session.type = "playback";
    } catch (e) {
      if (!warnedAudioSession) {
        warnedAudioSession = true;
        console.warn("[audio] could not set navigator.audioSession.type:", e);
      }
    }
    if (!ctx || ctx.state === "closed") {
      try {
        ctx = new AC({ latencyHint: "interactive" });
      } catch {
        try {
          ctx = new AC();
        } catch (e) {
          console.warn("[audio] could not create an AudioContext:", e);
          ctx = null;
          return null;
        }
      }
      primed = false;
    }
    const running = ctx.state === "running";
    // "suspended" (autoplay policy) or "interrupted" (iOS, e.g. after a call): resume inside this gesture.
    if (!running) {
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === "function") p.catch(e => console.warn(`[audio] AudioContext.resume() was rejected (state "${ctx?.state}"):`, e));
      } catch (e) {
        console.warn("[audio] AudioContext.resume() threw:", e);
      }
    }
    // A one-sample silent buffer started inside the gesture unlocks output on older iOS.
    // Repeated while the context is not running, in case the first call came from a non-activating event.
    if (!primed || !running) {
      primed = true;
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.onended = () => { try { src.disconnect(); } catch { /* ignore */ } };
        src.start(0);
      } catch (e) {
        console.warn("[audio] silent unlock buffer failed:", e);
      }
    }
    return ctx;
  }

  // ---------- decoded buffer cache ----------
  function trimCache() {
    for (const [url, entry] of cache) {
      if (cache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break;
      if (cache.size <= 1) break; // never evict the newest entry
      cache.delete(url);
      cacheBytes -= entry.bytes;
    }
  }

  function getBuffer(audioCtx, url) {
    const hit = cache.get(url);
    if (hit) {
      cache.delete(url); // move to the newest position
      cache.set(url, hit);
      return hit.promise;
    }
    const entry = { promise: null, bytes: 0 };
    entry.promise = fetchTimed(url, {}, CLIP_TIMEOUT_MS, async res => {
      if (!res.ok) throw new HttpError(res.status, url);
      return res.arrayBuffer();
    })
      .then(ab =>
        decode(audioCtx, ab).catch(e => {
          e.stage = "decode";
          throw e;
        }),
      )
      .then(
        buf => {
          if (cache.get(url) === entry) {
            entry.bytes = buf.length * buf.numberOfChannels * 4;
            cacheBytes += entry.bytes;
            trimCache();
          }
          return buf;
        },
        err => {
          if (cache.get(url) === entry) cache.delete(url); // let the next tap try again
          throw err;
        },
      );
    cache.set(url, entry);
    trimCache();
    return entry.promise;
  }

  // ---------- playback sessions ----------
  function newSession() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve, done: false, started: false, sources: [], timers: [], marks: createMarks(), checks: 0 };
  }

  function finish(s, result) {
    if (s.done) return;
    s.done = true;
    for (const t of s.timers) clearTimeout(t);
    s.timers.length = 0;
    for (const src of s.sources) {
      src.onended = null;
      try { src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch { /* ignore */ }
    }
    s.sources.length = 0;
    s.marks.clear();
    if (current === s) current = null;
    if (s.started) emit("end", { result });
    s.resolve(result);
  }

  function fail(s, message) {
    if (s.done) return;
    finish(s, "error");
    emit("error", { message });
  }

  function stop() {
    if (current) finish(current, "stopped");
  }

  /**
   * Schedule decoded buffers back to back on the context clock.
   * items[i].el gets .is-playing while buffer i sounds; `whole` for the whole sequence.
   */
  function schedule(s, audioCtx, items, bufs, gapS, whole, info) {
    s.marks.removeAll("is-loading");
    const now = audioCtx.currentTime;
    const latency = Number.isFinite(audioCtx.outputLatency) ? audioCtx.outputLatency : Number.isFinite(audioCtx.baseLatency) ? audioCtx.baseLatency : 0;
    const delayMs = at => Math.max(0, (at - now + latency) * 1000);
    let t = now + START_LEAD_S;
    let endAt = t;
    let last = null;
    items.forEach((it, i) => {
      const buf = bufs[i];
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      s.sources.push(src);
      src.start(t);
      const start = t;
      const end = t + buf.duration;
      if (isEl(it.el)) {
        s.timers.push(setTimeout(() => { if (!s.done) s.marks.add(it.el, "is-playing"); }, delayMs(start)));
        s.timers.push(setTimeout(() => { if (!s.done) s.marks.remove(it.el, "is-playing"); }, delayMs(end)));
      }
      endAt = end;
      t = end + gapS;
      last = src;
    });
    s.marks.add(whole, "is-playing");
    last.onended = () => finish(s, "ended");

    // Safety net: onended can be missed if the context is interrupted mid-sequence (iOS) or the tab is throttled.
    const check = () => {
      if (s.done) return;
      if (audioCtx.currentTime >= endAt - 0.005) { finish(s, "ended"); return; }
      if (audioCtx.state === "running" && s.checks++ < 5) {
        s.timers.push(setTimeout(check, Math.max(250, (endAt - audioCtx.currentTime) * 1000 + 500)));
        return;
      }
      console.warn(`[audio] playback stalled at ${audioCtx.currentTime.toFixed(2)} s of ${endAt.toFixed(2)} s; AudioContext is "${audioCtx.state}".`);
      fail(s, MSG.interrupted);
    };
    s.timers.push(setTimeout(check, (endAt - now) * 1000 + 1000));

    s.started = true;
    emit("start", info);
  }

  async function ensureRunning(s, audioCtx) {
    if (audioCtx.state === "running") return true;
    const ok = await waitRunning(audioCtx, RESUME_TIMEOUT_MS);
    if (s.done) return false;
    if (!ok) {
      const st = audioCtx.state;
      console.warn(`[audio] AudioContext is "${st}" after resume(); it will be replaced on the next tap.`);
      // A context stuck after an iOS interruption may never resume; the next unlock() (inside a
      // gesture) creates a fresh one. Decoded AudioBuffers are not tied to a context, so the cache stays.
      if (ctx === audioCtx) {
        ctx = null;
        try { audioCtx.close?.()?.catch?.(() => {}); } catch { /* ignore */ }
      }
      fail(s, st === "interrupted" ? MSG.interrupted : MSG.blocked);
    }
    return ok;
  }

  async function runClips(s, audioCtx, items, opts) {
    if (!audioCtx) return fail(s, MSG.unsupported);
    if (!items.length) {
      console.warn("[audio] play() was called with no items.");
      return fail(s, MSG.unavailable);
    }

    // Taps before the manifest has loaded are honored: wait for it (or retry it after an error).
    if (!manifest || state !== "ready") {
      try {
        await (state === "error" ? reload() : ready);
      } catch {
        if (!s.done) finish(s, "error"); // the loader has already emitted the visitor-facing error
        return;
      }
      if (s.done) return;
    }

    // Voice and speed as they were at tap time (validated now that the manifest is in).
    const vk = resolveVoice(opts.voice ?? s.voiceAtTap);
    let sk = SPEEDS.includes(s.speedAtTap) ? s.speedAtTap : speed;
    if (opts.speed != null) {
      if (SPEEDS.includes(opts.speed)) sk = opts.speed;
      else console.warn(`[audio] play() ignored speed "${opts.speed}".`);
    }
    let gapMs = DEFAULT_GAP_MS[sk];
    if (opts.gapMs != null) {
      if (Number.isFinite(opts.gapMs) && opts.gapMs >= 0) gapMs = Math.min(opts.gapMs, MAX_GAP_MS);
      else console.warn(`[audio] play() ignored gapMs ${opts.gapMs}.`);
    }

    const urls = items.map(it => urlFor(it.text, { voice: vk, speed: sk }));
    const missing = items.filter((_, i) => !urls[i]);
    if (missing.length) {
      console.warn(`[audio] no clip for voice "${vk}", speed "${sk}":`, missing.map(it => it.text));
      const t = missing[0].text;
      if (opts.hideText) return fail(s, MSG.missingHidden(voiceName(vk)));
      return fail(s, t != null && key(t) ? MSG.missing(key(t), voiceName(vk)) : MSG.unavailable);
    }

    // Fetch and decode everything first, in parallel, so the sequence never waits mid-way (F24).
    let bufs;
    try {
      bufs = await Promise.all(
        urls.map((u, i) =>
          getBuffer(audioCtx, absUrl(u)).catch(e => {
            e.text = key(items[i].text);
            e.url = u;
            throw e;
          }),
        ),
      );
    } catch (e) {
      if (s.done) return;
      const decodeFailed = e?.stage === "decode";
      console.warn(`[audio] could not ${decodeFailed ? "decode" : "load"} ${e?.url} (${e?.text}):`, e);
      if (opts.hideText) return fail(s, decodeFailed ? MSG.clipDecodeHidden : MSG.clipLoadHidden);
      return fail(s, decodeFailed ? MSG.clipDecode(e.text) : MSG.clipLoad(e?.text ?? ""));
    }
    if (s.done) return;
    if (!(await ensureRunning(s, audioCtx))) return;

    schedule(s, audioCtx, items, bufs, gapMs / 1000, s.whole, {
      kind: "clips",
      texts: items.map(it => key(it.text)),
      voice: vk,
      speed: sk,
    });
  }

  /**
   * Play a sequence of clips. Must be called from the user gesture handler (it unlocks synchronously).
   * @param {Array<{text: string, el?: Element}>|{text: string, el?: Element}|string} items
   * @param {{ whole?: Element, voice?: string, speed?: "normal"|"slow", gapMs?: number, hideText?: boolean }} [opts]
   *   hideText: error messages for visitors do not name the text (the console warning still does).
   *   The quiz uses it for its prompt, whose word must stay hidden until it is answered.
   * @returns {Promise<"ended"|"stopped"|"error">}
   */
  function play(items, opts = {}) {
    const audioCtx = unlock();
    stop();
    const o = opts && typeof opts === "object" ? opts : {};
    const list = normalizeItems(items);
    const s = newSession();
    s.whole = isEl(o.whole) ? o.whole : null;
    s.voiceAtTap = voice;
    s.speedAtTap = speed;
    if (current) finish(current, "stopped"); // an "end" listener may have started playback during stop()
    current = s;
    // Visible feedback while loading or decoding; .is-playing is added once sound is scheduled.
    s.marks.add(s.whole, "is-loading");
    for (const it of list) s.marks.add(it.el, "is-loading");
    runClips(s, audioCtx, list, o).catch(e => {
      console.warn("[audio] unexpected playback failure:", e);
      fail(s, MSG.generic);
    });
    return s.promise;
  }

  /**
   * Play an AudioBuffer (or a Blob / ArrayBuffer to decode, e.g. a MediaRecorder recording)
   * on the same context. Stops any other playback.
   * @returns {Promise<"ended"|"stopped"|"error">}
   */
  function playBuffer(input, opts = {}) {
    const audioCtx = unlock();
    stop();
    const el = isEl(opts?.el) ? opts.el : null;
    const s = newSession();
    if (current) finish(current, "stopped"); // an "end" listener may have started playback during stop()
    current = s;
    (async () => {
      if (!audioCtx) return fail(s, MSG.unsupported);
      let buf = input;
      if (!isAudioBuffer(input)) {
        s.marks.add(el, "is-loading");
        try {
          let ab = null;
          if (input instanceof ArrayBuffer) ab = input.slice(0); // decodeAudioData detaches its argument
          else if (ArrayBuffer.isView(input)) ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
          else if (input && typeof input.arrayBuffer === "function") ab = await input.arrayBuffer();
          if (!ab) throw new TypeError("playBuffer() expects an AudioBuffer, Blob or ArrayBuffer");
          buf = await decode(audioCtx, ab);
        } catch (e) {
          if (s.done) return;
          console.warn("[audio] could not decode the buffer passed to playBuffer():", e);
          return fail(s, MSG.recording);
        }
        if (s.done) return;
      }
      if (!buf.duration) {
        console.warn("[audio] playBuffer() got an empty buffer.");
        return fail(s, MSG.recording);
      }
      if (!(await ensureRunning(s, audioCtx))) return;
      schedule(s, audioCtx, [{ text: null, el: null }], [buf], 0, el, { kind: "buffer", texts: [], voice: null, speed: null });
    })().catch(e => {
      console.warn("[audio] unexpected playBuffer failure:", e);
      fail(s, MSG.recording);
    });
    return s.promise;
  }

  const engine = {
    get ready() { return ready; },
    get state() { return state; },
    reload,
    get voices() { return voices.slice(); },
    get voice() { return voice; },
    set voice(k) { setVoice(k); },
    setVoice,
    get speed() { return speed; },
    set speed(s) { setSpeed(s); },
    setSpeed,
    has,
    urlFor,
    allUrls,
    unlock,
    play,
    stop,
    playBuffer,
    get context() { return ctx; },
    get manifest() { return manifest; },
    on,
  };

  load();
  return engine;
}
