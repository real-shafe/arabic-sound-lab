// Listens to every generated clip with ElevenLabs speech-to-text (Scribe) and
// reports the ones whose transcript doesn't match the Arabic they should say.
// Short vowels and hamza seats are ignored, since Scribe writes plain text.
// Isolated syllables such as بَا usually come back as letter names (باء) or
// even English words, so only whole words are a reliable signal; syllables
// need a human ear.
//
//   npm run audio:check              check every clip
//   npm run audio:check -- قَلْب قَلَم  check just these strings

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { C } from "../public/data.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const CONCURRENCY = 3;
const SYLLABLES = new Set(C.map(c => c.syl));

// Strip diacritics, tatweel and punctuation; fold alef and hamza forms together.
// A final ة is dropped too: said on its own, سَارَ and سارة sound the same.
const plain = s => s
  .normalize("NFC")
  .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/[ؤئ]/g, "ء").replace(/ى/g, "ي")
  .replace(/[^\u0621-\u064A]/g, "")
  .replace(/\u0629$/, "");

async function main() {
  const only = new Set(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(join(PUBLIC, "audio", "manifest.json"), "utf8"));
  const client = new ElevenLabsClient();
  const jobs = Object.entries(manifest.clips)
    .filter(([text]) => !only.size || only.has(text))
    .map(([text, { src }]) => ({ text, src }));

  const rows = [];
  const queue = [...jobs];
  async function worker() {
    for (let job; (job = queue.shift()); ) {
      const path = join(PUBLIC, job.src);
      const res = await client.speechToText.convert({ file: createReadStream(path), modelId: "scribe_v3", languageCode: "ar", tagAudioEvents: false });
      const heard = (res.text || "").trim();
      const seconds = statSync(path).size * 8 / 128000; // 128 kbps CBR
      rows.push({ ...job, heard, seconds, ok: plain(heard) === plain(job.text) });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const order = new Map(jobs.map((j, i) => [j.src, i]));
  rows.sort((a, b) => order.get(a.src) - order.get(b.src));
  for (const r of rows) {
    const mark = r.ok ? "ok  " : SYLLABLES.has(r.text) ? "syl?" : "DIFF";
    console.log(`${mark} ${r.seconds.toFixed(1)}s  wanted ${r.text}  heard ${r.heard || "(nothing)"}`);
  }
  const words = rows.filter(r => !SYLLABLES.has(r.text));
  const syl = rows.filter(r => SYLLABLES.has(r.text));
  console.log(`\nWords: ${words.filter(r => r.ok).length}/${words.length} transcribe as intended.`);
  if (syl.length) console.log(`Syllables: ${syl.filter(r => r.ok).length}/${syl.length} (speech-to-text is unreliable on these; listen to them).`);
  const long = rows.filter(r => r.seconds > 3.5);
  if (long.length) console.log(`Over 3.5 s, which is long for one word: ${long.map(r => r.text).join(", ")}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
