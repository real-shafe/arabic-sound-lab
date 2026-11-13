// Voices every playable Arabic string in public/data.js with ElevenLabs and
// writes the clips to public/audio/, plus public/audio/manifest.json, which
// the page reads to find them. The page itself never talks to ElevenLabs, so
// the API key stays on this machine. The page's Slow button plays the same
// clip at 75% speed with the pitch kept, so both speeds say exactly the same
// thing.
//
//   npm run audio                      voice anything new or out of date
//   npm run audio -- --force           re-voice everything
//   npm run audio -- --only قَلْب قَلَم  re-voice just these strings
//
// The key comes from ELEVENLABS_API_KEY (npm run audio loads .env.local).

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { playableTexts } from "../public/data.js";

// Chaouki: a native Modern Standard Arabic voice from the ElevenLabs Voice
// Library, verified for Arabic on Eleven v4.
export const VOICE = { id: "G1HOkzin3NMwRHSq60UI", name: "Chaouki" };
export const MODEL = {
  modelId: "eleven_v4",
  languageCode: "ar",
  voiceSettings: { stability: 0.75, similarityBoost: 0.75 },
};
const OUTPUT_FORMAT = "mp3_44100_128";

// Same input and settings give the same clip. When a clip comes out wrong
// (npm run audio:check flags it), give it another seed here and rerun.
const DEFAULT_SEED = 1234;
const SEEDS = {
  "لَيْل": 2,
  "غَرْب": 1,
  "فِيل": 3,
};

const CONCURRENCY = 3; // the Starter plan's limit

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const MANIFEST = join(PUBLIC, "audio", "manifest.json");

const hash = s => createHash("sha1").update(s).digest("hex");
const seedFor = text => SEEDS[text] ?? DEFAULT_SEED;
const srcFor = text => `audio/${hash(text).slice(0, 10)}.mp3`;
// A clip is re-voiced when anything that shapes its sound changes
const fingerprint = text => hash(JSON.stringify({ voice: VOICE.id, OUTPUT_FORMAT, seed: seedFor(text), ...MODEL })).slice(0, 10);

function parseArgs(argv) {
  const force = argv.includes("--force");
  const i = argv.indexOf("--only");
  const only = i >= 0 ? new Set(argv.slice(i + 1).filter(a => !a.startsWith("--"))) : null;
  return { force, only };
}

async function loadManifest() {
  if (!existsSync(MANIFEST)) return { clips: {} };
  return JSON.parse(await readFile(MANIFEST, "utf8"));
}

async function synthesize(client, text) {
  for (let attempt = 1; ; attempt++) {
    try {
      const stream = await client.textToSpeech.convert(VOICE.id, {
        text,
        ...MODEL,
        outputFormat: OUTPUT_FORMAT,
        seed: seedFor(text),
      });
      const buf = Buffer.from(await new Response(stream).arrayBuffer());
      if (buf.length < 2000) throw new Error(`suspiciously small clip (${buf.length} bytes)`);
      return buf;
    } catch (err) {
      const status = err.statusCode ?? err.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= 4) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error("ELEVENLABS_API_KEY is not set. Run `npx -y @elevenlabs/cli@latest onboard init` to sign in and store a key in .env.local.");
    process.exit(1);
  }
  const { force, only } = parseArgs(process.argv.slice(2));
  const client = new ElevenLabsClient();
  const texts = playableTexts();
  const old = await loadManifest();
  const clips = {};
  const jobs = [];

  for (const text of texts) {
    const src = srcFor(text);
    const fp = fingerprint(text);
    const prev = old.clips?.[text];
    const fresh = prev && prev.src === src && prev.fp === fp && existsSync(join(PUBLIC, src));
    const wanted = force || (only ? only.has(text) : !fresh);
    if (fresh && !wanted) clips[text] = prev;
    else jobs.push({ text, src, fp });
  }

  // Strings that are no longer on the page: drop their clips
  const stale = Object.keys(old.clips || {}).filter(t => !texts.includes(t));
  for (const t of stale) await rm(join(PUBLIC, old.clips[t].src), { force: true });

  const chars = jobs.reduce((n, j) => n + j.text.length, 0);
  console.log(`${texts.length} strings: ${jobs.length} to voice (${chars} characters)` + (stale.length ? `, ${stale.length} stale clips removed` : ""));

  let done = 0;
  const failures = [];
  const queue = [...jobs];
  async function worker() {
    for (let job; (job = queue.shift()); ) {
      try {
        const buf = await synthesize(client, job.text);
        await mkdir(dirname(join(PUBLIC, job.src)), { recursive: true });
        await writeFile(join(PUBLIC, job.src), buf);
        clips[job.text] = { src: job.src, fp: job.fp };
        done++;
        console.log(`  [${done}/${jobs.length}] ${job.text}  (${(buf.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        failures.push(job);
        console.error(`  failed: ${job.text}: ${err.message}`);
        if ((err.statusCode ?? err.status) === 401) queue.length = 0; // bad key: stop early
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    // Keep whatever finished, even on failure, so a rerun only redoes the rest.
    // Clips are listed in page order so diffs stay readable.
    const ordered = Object.fromEntries(texts.filter(t => clips[t]).map(t => [t, clips[t]]));
    const manifest = { voice: VOICE, model: MODEL.modelId, clips: ordered };
    await mkdir(dirname(MANIFEST), { recursive: true });
    await writeFile(MANIFEST, JSON.stringify(manifest, null, 1) + "\n");
  }

  if (failures.length) {
    console.error(`${failures.length} clips failed. Run npm run audio again to retry them.`);
    process.exit(1);
  }
  console.log("Done. Wrote public/audio/manifest.json");
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
