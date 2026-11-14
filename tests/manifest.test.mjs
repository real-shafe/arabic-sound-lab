// Checks public/audio.json against public/data.js and the files in
// public/clips/ (F35, F37): every playable string has a normal and a slow clip
// in every voice, every file exists and is named by its own hash, and no clip
// file is left over. Fails until `npm run audio` has been run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { playableTexts } from "../public/data.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const MANIFEST = join(PUBLIC, "audio.json");
const CLIPS = join(PUBLIC, "clips");
const VOICES = [
  { key: "chaouki", id: "G1HOkzin3NMwRHSq60UI", name: "Chaouki", gender: "male" },
  { key: "asmaa", id: "qi4PkV9c01kb869Vh7Su", name: "Asmaa", gender: "female" },
];
const SPEEDS = ["normal", "slow"];

const key = s => String(s).normalize("NFC").trim();
const toPosix = p => p.split(sep).join("/");

function loadManifest() {
  assert.ok(existsSync(MANIFEST), "public/audio.json is missing: run npm run audio");
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

function listMp3(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMp3(p));
    else if (entry.name.endsWith(".mp3")) out.push(toPosix(relative(PUBLIC, p)));
  }
  return out;
}

test("audio.json exists and has the version 2 header", () => {
  const m = loadManifest();
  assert.equal(m.version, 2);
  assert.equal(m.model, "eleven_v4");
  assert.deepEqual(m.voices, VOICES);
  assert.deepEqual(m.speeds, { normal: 1, slow: 0.75 });
  assert.ok(m.clips && typeof m.clips === "object" && !Array.isArray(m.clips), "clips is an object");
});

test("every playable text has a normal and a slow clip in every voice, and the files exist", () => {
  const m = loadManifest();
  const missing = [];
  for (const text of playableTexts().map(key)) {
    const entry = m.clips[text];
    if (!entry) { missing.push(`${text}: no entry`); continue; }
    for (const v of VOICES) {
      const e = entry[v.key];
      if (!e) { missing.push(`${text}: no ${v.key} clips`); continue; }
      for (const speed of SPEEDS) {
        const rel = e[speed];
        if (typeof rel !== "string" || !new RegExp(`^clips/${v.key}/[0-9a-f]{12}\\.mp3$`).test(rel)) {
          missing.push(`${text}: ${v.key} ${speed} is ${JSON.stringify(rel)}`);
        } else if (!existsSync(join(PUBLIC, rel))) {
          missing.push(`${text}: ${v.key} ${speed} file ${rel} is missing`);
        }
      }
      if (e.normal === e.slow) missing.push(`${text}: ${v.key} normal and slow are the same file`);
      if (typeof e.fp !== "string" || !/^[0-9a-f]{10}$/.test(e.fp)) missing.push(`${text}: ${v.key} fp ${JSON.stringify(e.fp)}`);
      if (typeof e.lufs !== "number" || !Number.isFinite(e.lufs)) missing.push(`${text}: ${v.key} lufs ${JSON.stringify(e.lufs)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("audio.json has no entries for texts the page no longer uses", () => {
  const m = loadManifest();
  const wanted = new Set(playableTexts().map(key));
  assert.deepEqual(Object.keys(m.clips).filter(t => !wanted.has(t)), []);
  for (const t of Object.keys(m.clips)) assert.equal(t, key(t), `manifest key ${JSON.stringify(t)} is NFC and trimmed`);
});

test("clip files are named by the hash of their bytes", () => {
  const m = loadManifest();
  const bad = [];
  for (const entry of Object.values(m.clips)) {
    for (const v of Object.values(entry)) {
      for (const speed of SPEEDS) {
        const rel = v?.[speed];
        if (typeof rel !== "string" || !existsSync(join(PUBLIC, rel))) continue; // reported above
        const hash = createHash("sha1").update(readFileSync(join(PUBLIC, rel))).digest("hex").slice(0, 12);
        if (!rel.endsWith(`/${hash}.mp3`)) bad.push(`${rel} has hash ${hash}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("no orphan mp3 files in public/clips", () => {
  const m = loadManifest();
  const referenced = new Set();
  for (const entry of Object.values(m.clips)) {
    for (const v of Object.values(entry)) for (const speed of SPEEDS) if (typeof v?.[speed] === "string") referenced.add(v[speed]);
  }
  assert.deepEqual(listMp3(CLIPS).filter(rel => !referenced.has(rel)), []);
});
