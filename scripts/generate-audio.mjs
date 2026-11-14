// Voices every playable Arabic string in public/data.js with ElevenLabs, in
// both voices, and writes the clips the page plays:
//
//   public/audio.json                         the manifest the page reads
//   public/clips/<voice>/<sha1 of mp3, 12 hex>.mp3
//
// The page never talks to ElevenLabs, so the API key stays on this machine.
// Each text × voice is requested once as raw 24 kHz PCM, then processed here:
// silence trimmed (40 ms lead-in, 100 ms tail, 5 ms fades), loudness
// normalized to -18 LUFS (BS.1770, K-weighted and gated) under a -1 dBFS
// sample-peak ceiling, and encoded as 64 kbps mono MP3. The slow clip is the
// same audio time-stretched to 0.75x speed with WSOLA (pitch unchanged), so
// both speeds say exactly the same thing in every browser. File names hash
// the MP3 bytes, so the clips can be cached forever.
//
//   npm run audio                          voice anything new or out of date
//   npm run audio -- --dry-run             list what would be voiced, and the character cost
//   npm run audio -- --only قَلْب قَلَم      re-render just these strings
//   npm run audio -- --voice asmaa         only this voice
//   npm run audio -- --force               call the API again for everything in scope
//
// Raw PCM responses are cached in node_modules/.cache/arabic-sound-lab/tts,
// so changing only the processing re-renders without spending characters.
// The key comes from ELEVENLABS_API_KEY, read from .env.local when that file
// exists (the environment wins). --dry-run needs no key.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  PUBLIC_ROOT, REPO_ROOT, VOICES, assertRawPcm, clipRelPath, buildManifest, findUnreferencedClips, finishRun, loadData,
  loadTextKey, pageTexts, planRun, readManifest, renderClip, setEntry, ttsCacheKey, ttsRequest, writeFileAtomic,
  writeManifest,
} from "./lib/pipeline.mjs";

// .env.local is optional: without it the key can come from the environment,
// and --dry-run needs none. Existing environment variables are not overridden.
try {
  process.loadEnvFile(join(REPO_ROOT, ".env.local"));
} catch (err) {
  if (err?.code !== "ENOENT") console.warn(`Could not load .env.local: ${err?.message ?? err}`);
}

const CONCURRENCY = 3; // the Starter plan's limit
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_S = 60;
const CACHE_DIR = join(REPO_ROOT, "node_modules", ".cache", "arabic-sound-lab", "tts");
const MIN_PCM_SECONDS = 0.15;

const USAGE = `Usage: npm run audio -- [options]   (or node scripts/generate-audio.mjs [options])

  --only <texts…>   only these strings (NFC-normalized); re-rendered even if up to date
  --voice <key>     only this voice (${VOICES.map(v => v.key).join(", ")})
  --force           ignore up-to-date clips and the PCM cache; call the API again
  --out <dir>       write audio.json and clips/ under <dir> instead of public/
  --dry-run         print what would be voiced and the character count; no API calls, no writes
  --no-cache        don't read or write the local PCM cache
  -h, --help        this text`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { force: false, dryRun: false, cache: true, only: null, voice: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = name => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return v;
    };
    if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-cache") opts.cache = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--voice") opts.voice = value("--voice");
    else if (a.startsWith("--voice=")) opts.voice = a.slice(8);
    else if (a === "--out") opts.out = value("--out");
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a === "--only") {
      opts.only ??= [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.only.push(argv[++i]);
    } else throw new UsageError(`Unknown argument: ${a}`);
  }
  if (opts.only && !opts.only.length) throw new UsageError("--only needs at least one string");
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const statusOf = err => err?.statusCode ?? err?.status;
const cachePath = (voiceKey, text) => join(CACHE_DIR, voiceKey, `${ttsCacheKey(voiceKey, text)}.pcm`);
const fmtDb = v => (Number.isFinite(v) ? v.toFixed(1) : String(v));

async function readCache(voiceKey, text) {
  try {
    return await readFile(cachePath(voiceKey, text));
  } catch {
    return null;
  }
}

const checkPcm = buf => assertRawPcm(buf, { minSeconds: MIN_PCM_SECONDS });

async function synthesize(client, voiceKey, text, log) {
  const { voiceId, body } = ttsRequest(voiceKey, text);
  for (let attempt = 1; ; attempt++) {
    try {
      const stream = await client.textToSpeech.convert(voiceId, body, { timeoutInSeconds: REQUEST_TIMEOUT_S, maxRetries: 0 });
      const buf = Buffer.from(await new Response(stream).arrayBuffer());
      try {
        checkPcm(buf);
      } catch (err) {
        throw Object.assign(err, { billed: true }); // the API delivered (and charged for) a response
      }
      return buf;
    } catch (err) {
      const status = statusOf(err);
      const retryable = !err.noRetry && (status === 429 || (status >= 500 && status < 600) || status === undefined);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const retryAfter = Number(err.rawResponse?.headers?.get?.("retry-after"));
      const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1) + Math.random() * 500;
      log(`  retry ${attempt}/${MAX_ATTEMPTS - 1} for ${voiceKey} ${text} in ${(wait / 1000).toFixed(1)} s (${status ?? err.code ?? err.message})`);
      await sleep(wait);
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
  const data = await loadData();
  const onPage = pageTexts(data, key);
  if (!onPage.length) throw new Error("playableTexts() returned no strings; refusing to touch the clips.");

  let scopeVoices = VOICES;
  if (opts.voice) {
    const v = VOICES.find(x => x.key === opts.voice);
    if (!v) throw new UsageError(`Unknown voice "${opts.voice}". Voices: ${VOICES.map(x => x.key).join(", ")}`);
    scopeVoices = [v];
  }
  const only = opts.only ? new Set(opts.only.map(key)) : null;
  const pageSet = new Set(onPage);
  const extra = only ? [...only].filter(t => !pageSet.has(t)) : [];
  if (extra.length) console.warn(`Not in playableTexts(), voiced anyway and listed last: ${extra.join("  ")}`);
  const texts = [...onPage, ...extra];

  const old = await readManifest(root, key);
  // entries already holds the queued jobs' old clips, so a job that fails or is
  // never attempted keeps its old clip; a successful render replaces it.
  const plan = await planRun(root, old, texts, { voices: scopeVoices, only, force: opts.force });
  const { entries, reused, keptStale } = plan;
  const jobs = plan.jobs.map(j => ({ ...j, cached: opts.cache && !opts.force && existsSync(cachePath(j.voice.key, j.text)) }));
  const apiJobs = jobs.filter(j => !j.cached);
  const apiChars = apiJobs.reduce((n, j) => n + j.text.length, 0);
  const rel = relative(process.cwd(), root);
  const where = !rel ? "." : rel.startsWith("..") ? root : rel;
  console.log(`${texts.length} strings × ${VOICES.length} voices → ${where}/`);
  console.log(`  ${reused} clips up to date, ${jobs.length} to render (${apiJobs.length} from the API, ${apiChars} characters; ${jobs.length - apiJobs.length} from the PCM cache)` +
    (keptStale ? `, ${keptStale} out-of-date clips outside this run's scope kept as they are` : ""));

  if (opts.dryRun) {
    for (const v of VOICES) {
      const mine = jobs.filter(j => j.voice === v);
      if (!mine.length) continue;
      const chars = mine.filter(j => !j.cached).reduce((n, j) => n + j.text.length, 0);
      console.log(`\n${v.key} (${v.name}): ${mine.length} clips, ${chars} API characters`);
      for (const j of mine) console.log(`  ${j.cached ? "cache" : "api  "}  ${j.text}`);
    }
    const gone = old ? (await findUnreferencedClips(root, buildManifest(entries, texts))).length : 0;
    console.log(`\nDry run: nothing was requested or written.${gone ? ` ${gone}+ unreferenced clip files would be removed.` : ""}`);
    return 0;
  }

  const noKey = () => new Error("ELEVENLABS_API_KEY is not set. Run `npx -y @elevenlabs/cli@latest onboard init` to sign in and store a key in .env.local, then use npm run audio.");
  if (apiJobs.length && !process.env.ELEVENLABS_API_KEY) throw noKey();
  let clientPromise = null;
  const getClient = () => (clientPromise ??= (async () => {
    if (!process.env.ELEVENLABS_API_KEY) throw Object.assign(noKey(), { statusCode: 401 });
    const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
    return new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  })());

  // Save the manifest after every clip, so an interrupted run keeps its progress
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.catch(() => {}).then(() => writeManifest(root, buildManifest(entries, texts)));
    return saving;
  };

  let stopped = false;
  const queue = [...jobs];
  const onSigint = () => {
    if (stopped) process.exit(130);
    stopped = true;
    queue.length = 0;
    console.error("\nStopping after the clips in progress (Ctrl-C again to quit now)…");
  };
  process.on("SIGINT", onSigint);

  let done = 0;
  let charsUsed = 0;
  const failures = [];
  const rendered = [];
  async function worker() {
    for (let job; (job = queue.shift()); ) {
      const { text, voice } = job;
      let source = "cache";
      try {
        let pcm = job.cached ? await readCache(voice.key, text) : null;
        if (pcm) {
          try {
            checkPcm(pcm);
          } catch {
            pcm = null; // a damaged cache entry: ask the API again
          }
        }
        if (!pcm) {
          source = "api";
          pcm = await synthesize(await getClient(), voice.key, text, console.log);
          charsUsed += text.length;
          if (opts.cache) await writeFileAtomic(cachePath(voice.key, text), pcm);
        }
        const clip = renderClip(pcm);
        const normal = clipRelPath(voice.key, clip.normal);
        const slow = clipRelPath(voice.key, clip.slow);
        await writeFileAtomic(join(root, normal), clip.normal);
        await writeFileAtomic(join(root, slow), clip.slow);
        setEntry(entries, text, voice.key, { normal, slow, fp: job.fp, lufs: clip.lufs });
        rendered.push({ ...job, ...clip.stats, source, lufs: clip.lufs });
        await save();
        const s = clip.stats;
        console.log(`  [${++done}/${jobs.length}] ${voice.key.padEnd(7)} ${text}  ${s.seconds.toFixed(2)} s / slow ${s.slowSeconds.toFixed(2)} s  ` +
          `${fmtDb(clip.lufs)} LUFS  peak ${fmtDb(s.peakDb)} dBFS${s.limitDb > 0.05 ? ` (limited ${s.limitDb.toFixed(1)} dB)` : ""}  [${source}]`);
      } catch (err) {
        const status = statusOf(err);
        if (err.billed) charsUsed += text.length;
        failures.push({ ...job, error: err }); // entries still holds job.prev, the old clip, if there was one
        console.error(`  failed: ${voice.key} ${text}: ${status ? `HTTP ${status}: ` : ""}${err.message}`);
        if (status === 401 || status === 402) {
          if (queue.length) console.error(`  stopping: the API refused the key (HTTP ${status}); ${queue.length} clips not attempted`);
          stopped = true;
          queue.length = 0;
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, jobs.length)) }, worker));
  } finally {
    process.off("SIGINT", onSigint);
    await saving.catch(() => {});
  }

  // Final manifest; clip files nothing references any more are removed only
  // when the run finished cleanly, so a stopped or failing run deletes nothing
  const { manifest, removed } = await finishRun(root, entries, texts, { complete: !stopped && !failures.length });

  const clipCount = Object.values(manifest.clips).reduce((n, row) => n + Object.keys(row).length, 0);
  console.log(`\nSummary`);
  console.log(`  rendered ${rendered.length} clips (${rendered.filter(r => r.source === "api").length} from the API), ${charsUsed} characters used`);
  console.log(`  ${reused} up to date${keptStale ? `, ${keptStale} out of date but outside this run's scope` : ""}, ${failures.length} failed` +
    (jobs.length - rendered.length - failures.length > 0 ? `, ${jobs.length - rendered.length - failures.length} not attempted` : ""));
  if (rendered.length) {
    const l = rendered.map(r => r.lufs);
    const limited = rendered.filter(r => r.limitDb > 0.05);
    console.log(`  new clips: ${fmtDb(Math.min(...l))} to ${fmtDb(Math.max(...l))} LUFS, ` +
      `${rendered.reduce((n, r) => n + r.cutStartMs, 0) / rendered.length | 0} ms average silence cut from the start` +
      (limited.length ? `, ${limited.length} needed the peak ceiling` : ""));
  }
  console.log(removed === null
    ? `  cleanup skipped because the run did not finish cleanly; unreferenced clip files are left for the next full run`
    : `  removed ${removed} unreferenced clip files`);
  console.log(`  wrote ${where}/audio.json (${Object.keys(manifest.clips).length} strings, ${clipCount} voice entries)`);
  const missing = texts.flatMap(t => VOICES.filter(v => !manifest.clips[t]?.[v.key]).map(v => `${v.key}:${t}`));
  if (missing.length && missing.length <= 12) console.log(`  still without a clip: ${missing.join("  ")}`);
  else if (missing.length) console.log(`  ${missing.length} text × voice combinations still have no clip`);

  if (failures.length || stopped) {
    console.error(`${failures.length} clips failed${stopped ? " (run stopped early)" : ""}. Run npm run audio again to retry them.`);
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
