// Shared pieces of the audio pipeline: voice and model settings, the DSP
// chain that turns one ElevenLabs PCM response into the normal and slow MP3
// clips, settings fingerprints, and reading/writing public/audio.json and the
// content-addressed files in public/clips/<voice>/.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyFades, integratedLoudness, limitPeak, normalizeLoudness, pcm16leToFloat32, peakDb, trimSilence, wsolaStretch } from "./dsp.mjs";
import { encodeMp3, parseMp3 } from "./mp3.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PUBLIC_ROOT = join(REPO_ROOT, "public");
export const MANIFEST_FILE = "audio.json";

// Bump when the processing changes in a way the DSP settings below don't
// capture (a different algorithm, a bug fix), so every clip is re-rendered.
export const PIPELINE_VERSION = 1;

export const MODEL_ID = "eleven_v4";
export const LANGUAGE_CODE = "ar";
export const VOICE_SETTINGS = Object.freeze({ stability: 0.75, similarityBoost: 0.75 });
// 16-bit little-endian mono PCM at 24 kHz: lossless input for the DSP below
export const OUTPUT_FORMAT = "pcm_24000";
export const SAMPLE_RATE = 24000;

// Voice Library voices; the first is the page's default
export const VOICES = Object.freeze([
  Object.freeze({ key: "chaouki", id: "G1HOkzin3NMwRHSq60UI", name: "Chaouki", gender: "male" }),
  Object.freeze({ key: "asmaa", id: "qi4PkV9c01kb869Vh7Su", name: "Asmaa", gender: "female" }),
]);
export const SPEEDS = Object.freeze({ normal: 1, slow: 0.75 });

/**
 * Processing settings. Every value here is part of each clip's fingerprint,
 * so changing one re-renders the clips (from the local PCM cache when it has
 * them, without new API calls).
 *
 * Loudness: BS.1770-4 integrated loudness (K-weighted, gated) brought to
 * -18 LUFS, with a -1 dBFS sample-peak ceiling. Short clips are shorter than
 * a few gating blocks, so the measure is "BS.1770-style" rather than a
 * broadcast-compliant reading, but it is applied the same way to every clip.
 */
export const DSP = Object.freeze({
  trim: Object.freeze({ leadMs: 40, tailMs: 100, fadeMs: 5, frameMs: 10, relativeDb: -40, floorDb: -60 }),
  loudness: Object.freeze({ targetLufs: -18, ceilingDb: -1 }),
  wsola: Object.freeze({ frameMs: 30, toleranceMs: 12 }),
  mp3: Object.freeze({ kbps: 64 }),
});

/** NFC key, identical to key() in public/js/text.js. */
export const nfcKey = s => String(s).normalize("NFC").trim();

// Same text and settings give the same clip. When a clip comes out wrong
// (npm run audio:check flags it, or it sounds off), give it another seed
// here and rerun. Keys are NFC text.
export const DEFAULT_SEED = 1234;
const nfcKeys = obj => Object.freeze(Object.fromEntries(Object.entries(obj).map(([t, s]) => [nfcKey(t), s])));
export const SEEDS = Object.freeze({
  // Chosen by trying seeds until Scribe heard the intended word (Nov 2026).
  chaouki: nfcKeys({
    "لَيْل": 2, "غَرْب": 1, "فِيل": 3, "مَرِيض": 2, "حَظّ": 2, "ظَلَّ": 2,
    "دِمَاغ": 1, "قَمِيص": 1, "غَيْب": 1, "صَيْف": 1, "وَجْه": 1,
  }),
  asmaa: nfcKeys({
    "سَفَر": 4, "شَاي": 3, "ظُهْر": 1, "بَلَد": 1, "ضَلَّ": 1, "ذَلَّ": 1, "خَال": 1, "وَجْه": 2,
  }),
});

const sha1 = data => createHash("sha1").update(data).digest("hex");

export function voiceByKey(voiceKey) {
  return VOICES.find(v => v.key === voiceKey) ?? null;
}

export function seedFor(voiceKey, text) {
  return SEEDS[voiceKey]?.[nfcKey(text)] ?? DEFAULT_SEED;
}

/** What the API is asked for. Also the identity of a cached PCM response. */
export function ttsRequest(voiceKey, text) {
  const voice = voiceByKey(voiceKey);
  if (!voice) throw new Error(`unknown voice "${voiceKey}"`);
  return {
    voiceId: voice.id,
    body: {
      text: nfcKey(text),
      modelId: MODEL_ID,
      languageCode: LANGUAGE_CODE,
      voiceSettings: { ...VOICE_SETTINGS },
      outputFormat: OUTPUT_FORMAT,
      seed: seedFor(voiceKey, text),
    },
  };
}

/** Cache key of the raw PCM for this request (independent of the DSP settings). */
export function ttsCacheKey(voiceKey, text) {
  const { voiceId, body } = ttsRequest(voiceKey, text);
  return sha1(JSON.stringify({ voiceId, ...body })).slice(0, 20);
}

/**
 * 10-hex fingerprint of everything that shapes a voice's clip apart from the
 * text itself: voice id, model, language, voice settings, seed, output format,
 * pipeline version and DSP settings. A changed fingerprint means re-render.
 */
export function fingerprint(voiceKey, text) {
  const { voiceId, body } = ttsRequest(voiceKey, text);
  const { text: _text, ...settings } = body;
  return sha1(JSON.stringify({ voiceId, ...settings, pipeline: PIPELINE_VERSION, dsp: DSP })).slice(0, 10);
}

/**
 * Throw (with noRetry set) unless buf looks like the raw PCM we asked for.
 * Deliberately not a frame-sync byte test: PCM that starts with the sample -1
 * is FF FF, which looks like an MP3 sync word. A real MP3 parses as a whole
 * chain of frames; PCM never does.
 */
export function assertRawPcm(buf, { minSeconds = 0.15, sampleRate = SAMPLE_RATE } = {}) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (head === "RIFF" || head.startsWith("ID3") || parseMp3(bytes).ok) {
    throw Object.assign(new Error("expected raw PCM but got a WAV/MP3 file"), { noRetry: true });
  }
  if (bytes.length < minSeconds * sampleRate * 2) {
    throw Object.assign(new Error(`suspiciously short audio (${bytes.length} bytes)`), { noRetry: true });
  }
}

/**
 * One API response (16-bit LE mono PCM bytes) → both clips.
 * trim → loudness-normalize with peak ceiling = normal;
 * WSOLA stretch of normal to 1 / 0.75 duration → peak ceiling = slow;
 * both encoded as 64 kbps mono MP3.
 */
export function renderClip(pcmBytes, { sampleRate = SAMPLE_RATE } = {}) {
  const raw = pcm16leToFloat32(pcmBytes);
  const trimmed = trimSilence(raw, { sampleRate, ...DSP.trim });
  if (trimmed.silent) throw new Error(`the audio is silent (${(raw.length / sampleRate).toFixed(2)} s, nothing above ${trimmed.thresholdDb.toFixed(0)} dBFS)`);
  const normal = normalizeLoudness(trimmed.signal, { sampleRate, ...DSP.loudness });
  const stretched = wsolaStretch(normal.signal, { sampleRate, speed: SPEEDS.slow, ...DSP.wsola });
  applyFades(stretched, { sampleRate, fadeMs: DSP.trim.fadeMs });
  const slow = limitPeak(stretched, { sampleRate, ceilingDb: DSP.loudness.ceilingDb });
  return {
    normal: encodeMp3(normal.signal, { sampleRate, ...DSP.mp3 }),
    slow: encodeMp3(slow.signal, { sampleRate, ...DSP.mp3 }),
    lufs: Math.round(normal.lufs * 10) / 10,
    stats: {
      rawSeconds: raw.length / sampleRate,
      seconds: normal.signal.length / sampleRate,
      slowSeconds: slow.signal.length / sampleRate,
      cutStartMs: (trimmed.cutStart / sampleRate) * 1000,
      cutEndMs: (trimmed.cutEnd / sampleRate) * 1000,
      inputLufs: normal.inputLufs,
      gainDb: normal.gainDb,
      peakDb: peakDb(normal.signal),
      limitDb: normal.reductionDb,
      slowLufs: integratedLoudness(slow.signal, sampleRate),
      slowPeakDb: peakDb(slow.signal),
      slowLimitDb: slow.reductionDb,
    },
  };
}

/** First 12 hex of sha1(bytes): the file name of a clip. */
export const contentHash = bytes => sha1(bytes).slice(0, 12);
export const clipRelPath = (voiceKey, bytes) => `clips/${voiceKey}/${contentHash(bytes)}.mp3`;
export const CLIP_FILE = /^[0-9a-f]{12}\.mp3$/;
const TEMP_FILE = /^[0-9a-f]{12}\.mp3\.tmp-\d+$/;

/** Write via a temp file and rename, so a crash never leaves half a file under a final name. */
export async function writeFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** True when rel is clips/<voiceKey>/<hash>.mp3, the file exists and its bytes still match the hash. */
export async function clipFileValid(root, voiceKey, rel) {
  if (typeof rel !== "string") return false;
  const m = /^clips\/([a-z0-9-]+)\/([0-9a-f]{12})\.mp3$/.exec(rel);
  if (!m || m[1] !== voiceKey) return false;
  try {
    return contentHash(await readFile(join(root, rel))) === m[2];
  } catch {
    return false;
  }
}

/** A manifest entry whose files are all present and intact. */
export async function entryUsable(root, voiceKey, entry) {
  return !!entry && typeof entry.fp === "string"
    && (await clipFileValid(root, voiceKey, entry.normal))
    && (await clipFileValid(root, voiceKey, entry.slow));
}

/**
 * Read <root>/audio.json. Returns null when there is none (or it is the
 * wrong version); throws when it exists but can't be parsed, so a damaged
 * manifest never leads to clips being deleted as unreferenced. Clip keys are
 * re-keyed through `key` (NFC).
 */
export async function readManifest(root, key = nfcKey) {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} exists but is not valid JSON (${err.message}). Fix or remove it and run again.`);
  }
  if (manifest?.version !== 2 || typeof manifest.clips !== "object" || !manifest.clips) return null;
  const clips = {};
  for (const [text, voices] of Object.entries(manifest.clips)) {
    const k = key(text);
    if (!clips[k]) clips[k] = { ...voices };
  }
  return { ...manifest, clips };
}

/**
 * Build the manifest from entries (Map text → { voiceKey: entry }), with
 * clips in `order` (page order) and voices in VOICES order.
 */
export function buildManifest(entries, order) {
  const clips = {};
  for (const text of order) {
    const byVoice = entries.get(text);
    if (!byVoice) continue;
    const row = {};
    for (const v of VOICES) {
      const e = byVoice[v.key];
      if (e) row[v.key] = { normal: e.normal, slow: e.slow, fp: e.fp, lufs: e.lufs };
    }
    if (Object.keys(row).length) clips[text] = row;
  }
  return {
    version: 2,
    model: MODEL_ID,
    voices: VOICES.map(v => ({ key: v.key, id: v.id, name: v.name, gender: v.gender })),
    speeds: { ...SPEEDS },
    clips,
  };
}

/** JSON with one line per clip entry, so diffs stay readable. */
export function serializeManifest(manifest) {
  const j = v => JSON.stringify(v);
  const lines = ["{"];
  lines.push(`  "version": ${j(manifest.version)},`);
  lines.push(`  "model": ${j(manifest.model)},`);
  lines.push(`  "voices": [`);
  lines.push(manifest.voices.map(v => `    ${j(v)}`).join(",\n"));
  lines.push(`  ],`);
  lines.push(`  "speeds": ${j(manifest.speeds)},`);
  const texts = Object.keys(manifest.clips);
  if (!texts.length) lines.push(`  "clips": {}`);
  else {
    lines.push(`  "clips": {`);
    lines.push(texts.map(t => {
      const row = manifest.clips[t];
      const inner = Object.keys(row).map(vk => `      ${j(vk)}: ${j(row[vk])}`).join(",\n");
      return `    ${j(t)}: {\n${inner}\n    }`;
    }).join(",\n"));
    lines.push(`  }`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

export async function writeManifest(root, manifest) {
  await writeFileAtomic(join(root, MANIFEST_FILE), serializeManifest(manifest));
}

/**
 * Files in <root>/clips/<voice>/ that the manifest doesn't reference: only
 * 12-hex .mp3 names (and leftover temp files from an interrupted write) are
 * ever candidates, anything else in the folder is left alone.
 */
export async function findUnreferencedClips(root, manifest) {
  const referenced = new Set();
  for (const row of Object.values(manifest.clips)) {
    for (const e of Object.values(row)) {
      referenced.add(e.normal);
      referenced.add(e.slow);
    }
  }
  const out = [];
  for (const v of VOICES) {
    const dir = join(root, "clips", v.key);
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (TEMP_FILE.test(name) || (CLIP_FILE.test(name) && !referenced.has(`clips/${v.key}/${name}`))) out.push(join(dir, name));
    }
  }
  return out.sort();
}

export async function removeFiles(paths) {
  for (const p of paths) await rm(p, { force: true });
  return paths.length;
}

/** entries: Map text → { voiceKey: entry }. */
export function setEntry(entries, text, voiceKey, entry) {
  if (!entries.has(text)) entries.set(text, {});
  entries.get(text)[voiceKey] = entry;
}

/**
 * Plan a generator run over `texts` (NFC keys, page order) against `old`
 * (readManifest() result, or null). A text × voice becomes a job when it is in
 * scope (`voices`, `only`) and is forced, named in `only`, or not up to date.
 *
 * `entries` starts with every usable old entry, the queued jobs' included, so
 * a job that fails or never runs (Ctrl-C, a refused key) keeps its old clip
 * in the manifest and on disk; a successful render replaces it.
 */
export async function planRun(root, old, texts, { voices = VOICES, only = null, force = false } = {}) {
  const inScopeVoice = new Set(voices.map(v => v.key));
  const entries = new Map();
  const jobs = [];
  let reused = 0;
  let keptStale = 0;
  for (const text of texts) {
    for (const voice of VOICES) {
      const prev = old?.clips?.[text]?.[voice.key];
      const usable = await entryUsable(root, voice.key, prev);
      const fp = fingerprint(voice.key, text);
      const fresh = usable && prev.fp === fp;
      const inScope = inScopeVoice.has(voice.key) && (!only || only.has(text));
      if (usable) setEntry(entries, text, voice.key, prev);
      if (inScope && (force || only || !fresh)) jobs.push({ text, voice, fp, prev: usable ? prev : null });
      else if (fresh) reused++;
      else if (usable) keptStale++;
    }
  }
  return { entries, jobs, reused, keptStale };
}

/**
 * Write the final manifest from `entries`. Clip files it no longer references
 * are deleted only when `complete` (no failures, not stopped early): an
 * unfinished run leaves every file in place for the next full run to tidy, so
 * it can never delete clips it did not get to. `removed` is null when skipped.
 */
export async function finishRun(root, entries, texts, { complete }) {
  const manifest = buildManifest(entries, texts);
  await writeManifest(root, manifest);
  const removed = complete ? await removeFiles(await findUnreferencedClips(root, manifest)) : null;
  return { manifest, removed };
}

/**
 * key() from public/js/text.js when it loads, else an identical inline copy
 * (the generator must not depend on the browser modules being finished).
 */
export async function loadTextKey() {
  try {
    const mod = await import(pathToFileURL(join(PUBLIC_ROOT, "js", "text.js")).href);
    if (typeof mod.key === "function" && mod.key(" بَّ ") === nfcKey(" بَّ ")) return mod.key;
  } catch {
    // fall through
  }
  return nfcKey;
}

/** public/data.js as a module; throws a readable error when it can't be imported. */
export async function loadData() {
  const path = join(PUBLIC_ROOT, "data.js");
  try {
    return await import(pathToFileURL(path).href);
  } catch (err) {
    throw new Error(`Could not import ${path}: ${err.message}`);
  }
}

/** playableTexts() as unique NFC keys in page order. */
export function pageTexts(data, key = nfcKey) {
  if (typeof data.playableTexts !== "function") throw new Error("public/data.js has no playableTexts() export");
  const out = [];
  const seen = new Set();
  for (const t of data.playableTexts()) {
    const k = key(t);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
