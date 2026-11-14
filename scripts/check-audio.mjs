// Checks the generated clips in public/audio.json:
//
// 1. Speech-to-text: listens to each voice's normal clips with ElevenLabs
//    Scribe and reports the ones whose transcript doesn't match the Arabic
//    they should say. Short vowels and hamza seats are ignored, since Scribe
//    writes plain text. Isolated syllables such as بَا usually come back as
//    letter names (باء) or even English words, so they are reported
//    separately: only whole words are a reliable signal, syllables need a
//    human ear.
// 2. Loudness: the spread of the manifest's measured loudness per voice, and
//    the difference inside each contrast pair (the two words played back to
//    back should match).
// 3. Durations: read from the MP3 frame headers; flags slow clips whose
//    length isn't 1 / 0.75 of the normal clip, and unusually long or short
//    clips. Also catches missing or corrupt files.
//
//   npm run audio:check                    everything, both voices
//   npm run audio:check -- --voice asmaa   one voice
//   npm run audio:check -- --slow          transcribe the slow clips too
//   npm run audio:check -- قَلْب قَلَم        just these strings
//   npm run audio:check -- --no-stt        loudness and duration reports only (no API calls)
//   ... --out <dir>                        check <dir>/audio.json instead of public/
//
// Speech-to-text needs ELEVENLABS_API_KEY, read from .env.local when that file
// exists (the environment wins). --no-stt needs no key.

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LAME_CODEC_DELAY, parseMp3 } from "./lib/mp3.mjs";
import { DSP, MANIFEST_FILE, PUBLIC_ROOT, REPO_ROOT, SPEEDS, loadData, loadTextKey, readManifest } from "./lib/pipeline.mjs";

// .env.local is optional: without it the key can come from the environment,
// and --no-stt needs none. Existing environment variables are not overridden.
try {
  process.loadEnvFile(join(REPO_ROOT, ".env.local"));
} catch (err) {
  if (err?.code !== "ENOENT") console.warn(`Could not load .env.local: ${err?.message ?? err}`);
}

const CONCURRENCY = 3;
const STT_MODEL = "scribe_v3";
const PAIR_TOLERANCE_LU = 0.5;
const TARGET_TOLERANCE_LU = 1;
const RATIO_TOLERANCE = 0.06; // frame rounding alone is up to ±576 samples per file
const LONG_S = 3.5;
const SHORT_S = 0.3;

const USAGE = `Usage: npm run audio:check -- [options] [texts…]   (or node scripts/check-audio.mjs …)

  --voice <key>   only this voice
  --slow          transcribe the slow clips as well as the normal ones
  --no-stt        skip speech-to-text (no API calls); loudness and duration reports only
  --out <dir>     check <dir>/audio.json and <dir>/clips/ instead of public/
  -h, --help      this text`;

// Strip diacritics, tatweel and punctuation; fold alef and hamza forms together.
// A final ة is dropped too: said on its own, سَارَ and سارة sound the same.
const plain = s => s
  .normalize("NFC")
  .replace(/[ً-ٰٟـ]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/[ؤئ]/g, "ء").replace(/ى/g, "ي")
  .replace(/[^ء-ي]/g, "")
  .replace(/ة$/, "");

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { voice: null, slow: false, stt: true, out: null, texts: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slow") opts.slow = true;
    else if (a === "--no-stt") opts.stt = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--voice" || a === "--out") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith("--voice=")) opts.voice = a.slice(8);
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a.startsWith("--")) throw new UsageError(`Unknown argument: ${a}`);
    else opts.texts.push(a);
  }
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const f1 = v => v.toFixed(1);
const f2 = v => v.toFixed(2);

// Contrast pairs from data.js: [label, textA, textB]
function pairsFrom(data, key) {
  const ar = side => (typeof side === "string" ? side : Array.isArray(side) ? side[0] : side?.ar);
  const out = [];
  const add = (label, p) => {
    const a = ar(p?.a);
    const b = ar(p?.b);
    if (a && b) out.push({ label, a: key(a), b: key(b) });
  };
  for (const [id, p] of Object.entries(data.PAIRS ?? {})) add(p.label ?? id, p);
  for (const p of data.VCOLOR ?? []) add(`vowel color: ${p.label ?? p.id}`, p);
  for (const p of data.SUN_MOON?.examples ?? []) add(`sun/moon: ${p.label ?? p.id}`, p);
  return out;
}

async function transcribe(client, path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.speechToText.convert({
        file: createReadStream(path), modelId: STT_MODEL, languageCode: "ar", tagAudioEvents: false,
      });
      return (res.text || "").trim();
    } catch (err) {
      const status = err?.statusCode ?? err?.status;
      if (!(status === 429 || (status >= 500 && status < 600) || status === undefined) || attempt >= 4) throw err;
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 500);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const root = opts.out ? resolve(opts.out) : PUBLIC_ROOT;
  const key = await loadTextKey();
  const manifest = await readManifest(root, key);
  if (!manifest) throw new Error(`No version 2 manifest at ${join(root, MANIFEST_FILE)}. Run npm run audio first.`);

  let data = {};
  try {
    data = await loadData();
  } catch (err) {
    console.warn(`${err.message}\nSyllables and pairs can't be identified without it; continuing.`);
  }
  const syllables = new Set((data.C ?? []).map(c => c.syl).filter(Boolean).map(key));

  let voices = manifest.voices ?? [];
  if (opts.voice) {
    voices = voices.filter(v => v.key === opts.voice);
    if (!voices.length) throw new UsageError(`Unknown voice "${opts.voice}". In the manifest: ${(manifest.voices ?? []).map(v => v.key).join(", ")}`);
  }
  const only = opts.texts.length ? new Set(opts.texts.map(key)) : null;
  const texts = Object.keys(manifest.clips).filter(t => !only || only.has(t));
  if (only) {
    const unknown = [...only].filter(t => !manifest.clips[t]);
    if (unknown.length) console.warn(`Not in the manifest: ${unknown.join("  ")}`);
  }

  // Files: parse every normal and slow clip of the selected voices
  const problems = [];
  const files = new Map(); // rel → parsed
  for (const text of texts) {
    for (const v of voices) {
      const e = manifest.clips[text][v.key];
      if (!e) continue;
      for (const speed of Object.keys(SPEEDS)) {
        const rel = e[speed];
        if (files.has(rel)) continue;
        try {
          const info = parseMp3(await readFile(join(root, rel)));
          files.set(rel, info);
          if (!info.ok) problems.push(`${v.key} ${speed} ${text}: ${rel} is not a valid MP3 (${info.error})`);
        } catch (err) {
          files.set(rel, null);
          problems.push(`${v.key} ${speed} ${text}: ${rel} can't be read (${err.code ?? err.message})`);
        }
      }
    }
  }

  // Speech-to-text
  const rows = [];
  if (opts.stt) {
    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error("ELEVENLABS_API_KEY is not set (in .env.local or the environment). Use --no-stt for the offline reports.");
    }
    const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
    const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
    const speeds = opts.slow ? ["normal", "slow"] : ["normal"];
    const jobs = [];
    for (const v of voices) {
      for (const speed of speeds) {
        for (const text of texts) {
          const rel = manifest.clips[text][v.key]?.[speed];
          if (rel && files.get(rel)?.ok) jobs.push({ text, voice: v.key, speed, rel, index: jobs.length });
        }
      }
    }
    console.log(`Transcribing ${jobs.length} clips with ${STT_MODEL}…`);
    const queue = [...jobs];
    let stop = false;
    async function worker() {
      for (let job; !stop && (job = queue.shift()); ) {
        try {
          const heard = await transcribe(client, join(root, job.rel));
          rows.push({ ...job, heard, ok: plain(heard) === plain(job.text) });
        } catch (err) {
          const status = err?.statusCode ?? err?.status;
          rows.push({ ...job, heard: null, ok: false, error: `${status ? `HTTP ${status}: ` : ""}${err.message}` });
          if (status === 401 || status === 402) stop = true;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    rows.sort((a, b) => a.index - b.index);
    for (const r of rows) {
      const mark = r.error ? "ERR " : r.ok ? "ok  " : syllables.has(r.text) ? "syl?" : "DIFF";
      const secs = files.get(r.rel)?.duration;
      console.log(`${mark} ${r.voice.padEnd(7)} ${r.speed.padEnd(6)} ${secs ? f1(secs) : "?"}s  wanted ${r.text}  heard ${r.error ?? (r.heard || "(nothing)")}`);
    }
    console.log("");
    for (const v of voices) {
      for (const speed of speeds) {
        const mine = rows.filter(r => r.voice === v.key && r.speed === speed);
        if (!mine.length) continue;
        const words = mine.filter(r => !syllables.has(r.text));
        const syl = mine.filter(r => syllables.has(r.text));
        const errors = mine.filter(r => r.error).length;
        console.log(`${v.key} ${speed}: words ${words.filter(r => r.ok).length}/${words.length} transcribe as intended` +
          (syl.length ? `; syllables ${syl.filter(r => r.ok).length}/${syl.length} (unreliable with speech-to-text, listen to them)` : "") +
          (errors ? `; ${errors} could not be transcribed` : ""));
      }
    }
    if (stop) console.log("Stopped early: the API refused the key.");
    console.log("");
  }

  // Loudness
  const target = DSP.loudness.targetLufs;
  console.log(`Loudness (manifest lufs; target ${target} LUFS, peak ceiling ${DSP.loudness.ceilingDb} dBFS)`);
  const pairs = pairsFrom(data, key).filter(p => !only || only.has(p.a) || only.has(p.b));
  for (const v of voices) {
    const vals = texts.map(t => ({ t, l: manifest.clips[t][v.key]?.lufs })).filter(x => Number.isFinite(x.l));
    if (!vals.length) {
      console.log(`  ${v.key}: no clips`);
      continue;
    }
    const ls = vals.map(x => x.l);
    const lo = Math.min(...ls);
    const hi = Math.max(...ls);
    console.log(`  ${v.key}: ${vals.length} clips, ${f1(lo)} to ${f1(hi)} LUFS (spread ${f1(hi - lo)} LU), median ${f1(median(ls))}`);
    const off = vals.filter(x => Math.abs(x.l - target) > TARGET_TOLERANCE_LU);
    if (off.length) console.log(`    more than ${TARGET_TOLERANCE_LU} LU from target: ${off.map(x => `${x.t} ${f1(x.l)}`).join(", ")}`);
    const diffs = pairs
      .map(p => ({ ...p, la: manifest.clips[p.a]?.[v.key]?.lufs, lb: manifest.clips[p.b]?.[v.key]?.lufs }))
      .filter(p => Number.isFinite(p.la) && Number.isFinite(p.lb))
      .map(p => ({ ...p, d: Math.abs(p.la - p.lb) }))
      .sort((x, y) => y.d - x.d);
    if (diffs.length) {
      const big = diffs.filter(p => p.d > PAIR_TOLERANCE_LU);
      console.log(`    within ${diffs.length} pairs: largest difference ${f1(diffs[0].d)} LU (${diffs[0].a} / ${diffs[0].b})` +
        (big.length ? `; over ${PAIR_TOLERANCE_LU} LU: ${big.map(p => `${p.label} ${f1(p.d)}`).join(", ")}` : `; none over ${PAIR_TOLERANCE_LU} LU`));
    }
  }

  // Durations from MP3 frame headers
  const expected = 1 / SPEEDS.slow;
  console.log(`\nDurations (MP3 frame headers; slow/normal expected ${f2(expected)} after removing the ${Math.round((LAME_CODEC_DELAY / 24000) * 1000)} ms codec delay)`);
  for (const v of voices) {
    const items = [];
    for (const t of texts) {
      const e = manifest.clips[t][v.key];
      const n = e && files.get(e.normal);
      const s = e && files.get(e.slow);
      if (!n?.ok || !s?.ok) continue;
      const content = info => info.contentDuration ?? Math.max(0, info.samples - LAME_CODEC_DELAY) / info.sampleRate;
      items.push({ t, normal: n.duration, slow: s.duration, ratio: content(s) / content(n), rates: `${n.sampleRate}/${s.sampleRate}`, kbps: n.bitrateKbps });
    }
    if (!items.length) {
      console.log(`  ${v.key}: no readable clip pairs`);
      continue;
    }
    const nd = items.map(i => i.normal);
    const rs = items.map(i => i.ratio);
    console.log(`  ${v.key}: normal ${f2(Math.min(...nd))} to ${f2(Math.max(...nd))} s (median ${f2(median(nd))}); ` +
      `slow/normal ${f2(Math.min(...rs))} to ${f2(Math.max(...rs))} (median ${f2(median(rs))})`);
    const badRatio = items.filter(i => Math.abs(i.ratio / expected - 1) > RATIO_TOLERANCE);
    if (badRatio.length) console.log(`    slow/normal off by more than ${RATIO_TOLERANCE * 100}%: ${badRatio.map(i => `${i.t} ${f2(i.ratio)}`).join(", ")}`);
    const long = items.filter(i => i.normal > LONG_S);
    if (long.length) console.log(`    over ${LONG_S} s, which is long for one word: ${long.map(i => `${i.t} ${f1(i.normal)}`).join(", ")}`);
    const short = items.filter(i => i.normal < SHORT_S);
    if (short.length) console.log(`    under ${SHORT_S} s: ${short.map(i => `${i.t} ${f2(i.normal)}`).join(", ")}`);
    const formats = new Set(items.map(i => i.rates));
    if (formats.size > 1 || !formats.has("24000/24000")) console.log(`    sample rates seen (normal/slow): ${[...formats].join(", ")}`);
  }

  if (problems.length) {
    console.log(`\n${problems.length} file problems:`);
    for (const p of problems) console.log(`  ${p}`);
    return 1;
  }
  return 0;
}

// Piping into head and the like closes stdout early; that isn't an error
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", err => {
    if (err.code !== "EPIPE") throw err;
  });
}

main().then(
  code => {
    process.exitCode = code;
  },
  err => {
    console.error(err instanceof UsageError ? `${err.message}\n\n${USAGE}` : err?.message || err);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);
