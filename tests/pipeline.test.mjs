// Audio pipeline tests: DSP (trim, loudness, peak ceiling, WSOLA), the MP3
// encoder and frame parser, fingerprints, and manifest/cleanup helpers.
// No network: every signal is synthesized here.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  float32ToInt16, integratedLoudness, kWeightingCoefficients, limitPeak, normalizeLoudness, pcm16leToFloat32, peak,
  peakDb, trimSilence, wsolaStretch,
} from "../scripts/lib/dsp.mjs";
import { LAME_CODEC_DELAY, encodeMp3, parseMp3 } from "../scripts/lib/mp3.mjs";
import {
  DEFAULT_SEED, DSP, VOICES, assertRawPcm, buildManifest, clipRelPath, contentHash, entryUsable, findUnreferencedClips, finishRun,
  fingerprint, planRun, readManifest, renderClip, seedFor, serializeManifest, setEntry, ttsCacheKey,
} from "../scripts/lib/pipeline.mjs";

const SR = 24000;
const TARGET = DSP.loudness.targetLufs;
const CEILING = DSP.loudness.ceilingDb;

const sine = (freq, seconds, amp, rate = SR) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// Deterministic low-level noise (LCG), so tests never flake
function noise(seconds, amp, seed = 7) {
  let s = seed;
  return Float32Array.from({ length: Math.round(seconds * SR) }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return amp * (s / 2 ** 32 - 0.5) * 2;
  });
}

// A tone with 10 ms raised-cosine ramps, so the burst itself doesn't click
function burst(freq, seconds, amp) {
  const x = sine(freq, seconds, amp);
  const r = Math.round(0.01 * SR);
  for (let i = 0; i < r; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / r);
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

// A rough vowel: harmonics of a gliding pitch, with a smooth envelope
function vowel(seconds, f0From, f0To, amp) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f0 = f0From + ((f0To - f0From) * i) / n;
    phase += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h;
    x[i] = amp * v * Math.sin((Math.PI * i) / n);
  }
  return x;
}

const zeroCrossingHz = (x, from, to) => {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return crossings / ((to - from) / SR);
};

const maxStep = x => {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};

const toPcmBytes = x => {
  const i16 = float32ToInt16(x);
  return new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
};

describe("PCM conversion", () => {
  it("reads 16-bit little-endian samples", () => {
    const bytes = Uint8Array.from([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40, 0x01]); // odd last byte ignored
    assert.deepEqual([...pcm16leToFloat32(bytes)], [0, 32767 / 32768, -1, 0.5]);
  });
  it("round-trips through Int16", () => {
    const x = sine(440, 0.05, 0.7);
    const back = pcm16leToFloat32(toPcmBytes(x));
    for (let i = 0; i < x.length; i++) assert.ok(Math.abs(back[i] - x[i]) < 1e-4);
  });
});

describe("trimSilence", () => {
  const lead = Math.round(DSP.trim.leadMs / 1000 * SR);
  const tail = Math.round(DSP.trim.tailMs / 1000 * SR);
  const frame = Math.round(DSP.trim.frameMs / 1000 * SR);

  it("keeps a 40 ms lead-in and 100 ms tail around the sound", () => {
    const x = concat(noise(0.3, 1e-4), burst(300, 0.5, 0.4), noise(0.4, 1e-4, 9));
    const r = trimSilence(x, { sampleRate: SR, ...DSP.trim });
    assert.equal(r.silent, false);
    const expected = lead + Math.round(0.5 * SR) + tail;
    assert.ok(Math.abs(r.signal.length - expected) <= 2 * frame, `length ${r.signal.length} vs ${expected}`);
    // the burst starts about 40 ms in
    const onset = r.signal.findIndex(v => Math.abs(v) > 0.01);
    assert.ok(onset >= lead - frame && onset <= lead + 2 * frame, `onset at ${onset}`);
    // removed most of the 300 ms of leading silence
    assert.ok(r.cutStart > 0.3 * SR - lead - 2 * frame);
  });

  it("fades both ends to zero", () => {
    const x = concat(noise(0.1, 1e-4), burst(300, 0.4, 0.5), noise(0.2, 1e-4));
    const { signal } = trimSilence(x, { sampleRate: SR, ...DSP.trim });
    assert.ok(Math.abs(signal[0]) < 1e-6 && Math.abs(signal[signal.length - 1]) < 1e-6);
  });

  it("pads with silence when the source starts and ends abruptly", () => {
    const x = sine(300, 0.3, 0.5);
    const r = trimSilence(x, { sampleRate: SR, ...DSP.trim });
    assert.equal(r.signal.length, lead + x.length + tail);
    assert.equal(peak(r.signal.subarray(0, lead)), 0);
    assert.equal(peak(r.signal.subarray(r.signal.length - tail)), 0);
    assert.ok(Math.abs(r.signal[lead + Math.round(0.1 * SR)]) <= 0.5); // audio intact after the fade
  });

  it("reports silence", () => {
    assert.equal(trimSilence(new Float32Array(SR), { sampleRate: SR, ...DSP.trim }).silent, true);
    assert.equal(trimSilence(noise(0.5, 1e-5), { sampleRate: SR, ...DSP.trim }).silent, true);
  });
});

describe("loudness", () => {
  it("K-weighting at 48 kHz matches the BS.1770 coefficient table", () => {
    const [shelf, hp] = kWeightingCoefficients(48000);
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} vs ${b}`);
    close(shelf.b0, 1.53512485958697);
    close(shelf.b1, -2.69169618940638);
    close(shelf.b2, 1.19839281085285);
    close(shelf.a1, -1.69065929318241);
    close(shelf.a2, 0.73248077421585);
    close(hp.a1, -1.99004745483398);
    close(hp.a2, 0.99007225036621);
  });

  it("a full-scale 997 Hz sine reads -3.01 LUFS, at 48 and 24 kHz", () => {
    assert.ok(Math.abs(integratedLoudness(sine(997, 3, 1, 48000), 48000) + 3.01) < 0.02);
    assert.ok(Math.abs(integratedLoudness(sine(997, 3, 1), SR) + 3.01) < 0.1);
  });

  it("gating ignores silence around the sound", () => {
    const tone = burst(500, 1, 0.3);
    const padded = concat(new Float32Array(SR), tone, new Float32Array(SR));
    // Ungated, the 2 s of silence would pull the reading down by 4.8 dB; only
    // the blocks straddling the edges of the tone still count.
    const drop = integratedLoudness(tone, SR) - integratedLoudness(padded, SR);
    assert.ok(drop >= 0 && drop < 1.5, `drop ${drop}`);
    assert.equal(integratedLoudness(new Float32Array(SR), SR), -Infinity);
  });

  it("normalizes two sine bursts at very different levels to within ±0.5 dB of the target", () => {
    const quiet = concat(new Float32Array(2400), burst(440, 0.8, 0.02), new Float32Array(2400));
    const loud = concat(new Float32Array(2400), burst(440, 0.8, 0.7), new Float32Array(2400));
    assert.ok(integratedLoudness(loud, SR) - integratedLoudness(quiet, SR) > 25);
    const a = normalizeLoudness(quiet, { sampleRate: SR, ...DSP.loudness });
    const b = normalizeLoudness(loud, { sampleRate: SR, ...DSP.loudness });
    for (const r of [a, b]) {
      const measured = integratedLoudness(r.signal, SR);
      assert.ok(Math.abs(measured - TARGET) <= 0.5, `measured ${measured}`);
      assert.ok(Math.abs(r.lufs - measured) < 1e-9);
      assert.ok(peakDb(r.signal) <= CEILING + 1e-6);
    }
    assert.ok(Math.abs(a.lufs - b.lufs) <= 0.5);
  });

  it("respects the peak ceiling and still reaches the target when bursts stick out", () => {
    // steady voicing plus sharp bursts: at -18 LUFS the bursts would peak far above -1 dBFS
    const x = sine(300, 1, 0.05);
    for (let p = 1200; p < x.length; p += 4800) {
      for (let i = 0; i < 120; i++) x[p + i] += 0.6 * Math.exp(-i / 15) * Math.sin((2 * Math.PI * 2000 * i) / SR);
    }
    assert.ok(peakDb(x) - integratedLoudness(x, SR) > -CEILING - TARGET + 3, "test signal must need limiting");
    const r = normalizeLoudness(x, { sampleRate: SR, ...DSP.loudness });
    assert.ok(r.reductionDb > 1);
    assert.ok(peakDb(r.signal) <= CEILING + 1e-6, `peak ${peakDb(r.signal)}`);
    assert.ok(Math.abs(integratedLoudness(r.signal, SR) - TARGET) <= 0.5);
    assert.ok(!r.signal.some(Number.isNaN));
  });

  it("limitPeak leaves quiet signals alone and caps loud ones without hard steps", () => {
    const quiet = sine(200, 0.2, 0.5);
    assert.deepEqual(limitPeak(quiet, { sampleRate: SR, ceilingDb: -1 }).signal, quiet);
    const loud = sine(200, 0.5, 1.5);
    const { signal, reductionDb } = limitPeak(loud, { sampleRate: SR, ceilingDb: -1 });
    assert.ok(peakDb(signal) <= -1 + 1e-6);
    assert.ok(reductionDb > 4.5);
    assert.ok(maxStep(signal) <= maxStep(loud)); // gain only ever goes down, smoothly
  });
});

describe("WSOLA time-stretch", () => {
  it("stretches a 220 Hz sine to 1/0.75 the length and keeps its pitch", () => {
    const x = sine(220, 2, 0.5);
    const y = wsolaStretch(x, { sampleRate: SR, speed: 0.75, ...DSP.wsola });
    assert.ok(Math.abs(y.length / x.length - 1 / 0.75) / (1 / 0.75) < 0.02);
    assert.ok(!y.some(v => !Number.isFinite(v)), "no NaN or Infinity");
    const hz = zeroCrossingHz(y, Math.round(0.1 * SR), y.length - Math.round(0.1 * SR));
    assert.ok(Math.abs(hz / 220 - 1) < 0.02, `measured ${hz} Hz`);
    // no clicks: no sample step larger than the sine's own steepest slope (plus a little)
    assert.ok(maxStep(y) <= maxStep(x) * 1.2, `max step ${maxStep(y)} vs ${maxStep(x)}`);
    // steady amplitude through the middle (no phase cancellation at frame joins)
    for (let k = Math.round(0.1 * SR); k + 480 < y.length - Math.round(0.1 * SR); k += 480) {
      const p = peak(y.subarray(k, k + 480));
      assert.ok(p > 0.45 && p < 0.55, `window peak ${p} at ${k}`);
    }
  });

  it("handles a gliding, harmonic voice without clicks", () => {
    const x = concat(new Float32Array(960), vowel(0.6, 110, 160, 0.3), new Float32Array(2400));
    const y = wsolaStretch(x, { sampleRate: SR, speed: 0.75, ...DSP.wsola });
    assert.equal(y.length, Math.round(x.length / 0.75));
    assert.ok(!y.some(v => !Number.isFinite(v)));
    assert.ok(maxStep(y) <= maxStep(x) * 1.5);
    assert.ok(Math.abs(integratedLoudness(y, SR) - integratedLoudness(x, SR)) < 1);
  });

  it("returns an empty signal for empty input", () => {
    assert.equal(wsolaStretch(new Float32Array(0), { speed: 0.75 }).length, 0);
  });
});

describe("MP3", () => {
  it("encodes frames with valid sync and a parsed duration within 5% of the input", () => {
    const x = sine(440, 2, 0.5);
    const mp3 = encodeMp3(x, { sampleRate: SR, kbps: DSP.mp3.kbps });
    assert.equal(mp3[0], 0xff);
    assert.equal(mp3[1] & 0xe0, 0xe0);
    const info = parseMp3(mp3);
    assert.equal(info.ok, true, info.error);
    assert.equal(info.firstFrameOffset, 0);
    assert.equal(info.sampleRate, SR);
    assert.equal(info.channels, 1);
    assert.equal(info.layer, 3);
    assert.equal(info.version, "2");
    assert.equal(info.cbr, true);
    assert.ok(Math.abs(info.bitrateKbps - DSP.mp3.kbps) < 0.5);
    assert.ok(Math.abs(info.duration / 2 - 1) < 0.05, `duration ${info.duration}`);
    assert.ok(info.samples - x.length >= LAME_CODEC_DELAY - 576 && info.samples - x.length < LAME_CODEC_DELAY + 1152);
  });

  it("is deterministic, so content-hash names are stable", () => {
    const x = vowel(0.4, 120, 140, 0.3);
    assert.equal(contentHash(encodeMp3(x)), contentHash(encodeMp3(x)));
  });

  it("detects broken files", () => {
    const mp3 = encodeMp3(sine(440, 0.5, 0.5));
    const broken = Uint8Array.from(mp3);
    const third = parseMp3(mp3).firstFrameOffset + 3 * 192; // 64 kbps at 24 kHz: 192-byte frames
    broken.fill(0, third, third + 4);
    assert.equal(parseMp3(broken).ok, false);
    assert.match(parseMp3(broken).error, /lost frame sync/);
    assert.equal(parseMp3(mp3.subarray(0, mp3.length - 10)).ok, false);
    assert.equal(parseMp3(new Uint8Array(0)).ok, false);
    assert.equal(parseMp3(new TextEncoder().encode("<!doctype html>")).ok, false);
  });

  it("skips an ID3v2 tag", () => {
    const mp3 = encodeMp3(sine(440, 0.5, 0.5));
    const id3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)]);
    const info = parseMp3(Uint8Array.from([...id3, ...mp3]));
    assert.equal(info.ok, true, info.error);
    assert.equal(info.id3Bytes, 30);
    assert.equal(info.frames, parseMp3(mp3).frames);
  });
});

describe("assertRawPcm", () => {
  it("accepts PCM whose first sample is -1 (bytes FF FF, which look like an MP3 sync word)", () => {
    const x = concat(Float32Array.of(-1 / 32767, -1 / 32767), vowel(0.4, 120, 140, 0.3));
    const bytes = toPcmBytes(x);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xff);
    assert.doesNotThrow(() => assertRawPcm(bytes));
  });
  it("rejects MP3, WAV and too-short responses", () => {
    assert.throws(() => assertRawPcm(encodeMp3(sine(440, 0.5, 0.5))), /WAV\/MP3/);
    assert.throws(() => assertRawPcm(Uint8Array.from([...new TextEncoder().encode("RIFF"), ...new Uint8Array(20000)])), /WAV\/MP3/);
    assert.throws(() => assertRawPcm(new Uint8Array(100)), e => e.noRetry === true && /short/.test(e.message));
  });
});

describe("renderClip", () => {
  const source = concat(noise(0.25, 2e-4), vowel(0.5, 120, 150, 0.08), noise(0.3, 2e-4, 3));
  const clip = renderClip(toPcmBytes(source));

  it("produces a normalized normal clip and a 0.75x slow clip, both valid MP3", () => {
    const n = parseMp3(clip.normal);
    const s = parseMp3(clip.slow);
    assert.equal(n.ok, true, n.error);
    assert.equal(s.ok, true, s.error);
    assert.ok(Math.abs(clip.lufs - TARGET) <= 0.5, `lufs ${clip.lufs}`);
    assert.ok(clip.stats.peakDb <= CEILING + 1e-6 && clip.stats.slowPeakDb <= CEILING + 1e-6);
    assert.ok(Math.abs(clip.stats.slowSeconds / clip.stats.seconds - 1 / 0.75) < 0.01);
    const content = info => (info.samples - LAME_CODEC_DELAY) / info.sampleRate;
    assert.ok(Math.abs(content(s) / content(n) / (1 / 0.75) - 1) < 0.06);
    assert.ok(Math.abs(clip.stats.slowLufs - clip.lufs) < 1, "slow keeps the loudness");
    assert.ok(clip.stats.cutStartMs > 150, "leading silence trimmed");
  });

  it("names files by content", () => {
    assert.match(clipRelPath("chaouki", clip.normal), /^clips\/chaouki\/[0-9a-f]{12}\.mp3$/);
    assert.notEqual(clipRelPath("chaouki", clip.normal), clipRelPath("chaouki", clip.slow));
    assert.equal(renderClip(toPcmBytes(source)).normal.length, clip.normal.length);
  });

  it("refuses silent audio", () => {
    assert.throws(() => renderClip(new Uint8Array(SR * 2)), /silent/);
  });
});

describe("fingerprints and seeds", () => {
  it("uses the per-voice seed overrides, keyed by NFC text", () => {
    assert.equal(seedFor("chaouki", "لَيْل"), 2);
    assert.equal(seedFor("chaouki", " غَرْب "), 1);
    assert.equal(seedFor("chaouki", "فِيل".normalize("NFD")), 3);
    assert.equal(seedFor("asmaa", "لَيْل"), DEFAULT_SEED);
    assert.equal(seedFor("chaouki", "بَاب"), DEFAULT_SEED);
  });

  it("is a 10-hex hash of voice, model, settings, seed and pipeline", () => {
    const fp = fingerprint("chaouki", "بَاب");
    assert.match(fp, /^[0-9a-f]{10}$/);
    assert.equal(fingerprint("chaouki", "بَاب"), fp);
    assert.equal(fingerprint("chaouki", "قَلَم"), fp, "the text itself is the manifest key, not part of fp");
    assert.notEqual(fingerprint("asmaa", "بَاب"), fp);
    assert.notEqual(fingerprint("chaouki", "لَيْل"), fp, "a different seed re-renders");
    assert.throws(() => fingerprint("nobody", "بَاب"));
  });

  it("caches PCM per request, NFC-insensitively", () => {
    // shadda before or after the fatha is the same text after NFC (F37)
    const a = "\u062F\u064E\u0644\u0651\u064E"; // دَلَّ typed shadda, then fatha (not NFC)
    const b = "\u062F\u064E\u0644\u064E\u0651"; // دَلَّ typed fatha, then shadda (NFC)
    assert.notEqual(a, b, "the raw spellings differ");
    assert.equal(ttsCacheKey("chaouki", a), ttsCacheKey("chaouki", b));
    assert.notEqual(ttsCacheKey("chaouki", a), ttsCacheKey("asmaa", a));
    assert.notEqual(ttsCacheKey("chaouki", a), ttsCacheKey("chaouki", "بَاب"));
  });
});

describe("manifest and cleanup", () => {
  it("builds the contract shape in page and voice order", () => {
    const entries = new Map([
      ["قَلَم", { asmaa: { normal: "clips/asmaa/bbbbbbbbbbbb.mp3", slow: "clips/asmaa/cccccccccccc.mp3", fp: "0123456789", lufs: -18.1, extra: 1 } }],
      ["بَاب", {
        asmaa: { normal: "clips/asmaa/dddddddddddd.mp3", slow: "clips/asmaa/eeeeeeeeeeee.mp3", fp: "0123456789", lufs: -18 },
        chaouki: { normal: "clips/chaouki/aaaaaaaaaaaa.mp3", slow: "clips/chaouki/ffffffffffff.mp3", fp: "9876543210", lufs: -17.9 },
      }],
    ]);
    const m = buildManifest(entries, ["بَاب", "قَلَم", "غَيْر"]);
    assert.equal(m.version, 2);
    assert.equal(m.model, "eleven_v4");
    assert.deepEqual(m.voices.map(v => v.key), VOICES.map(v => v.key));
    assert.deepEqual(m.voices[0], { key: "chaouki", id: "G1HOkzin3NMwRHSq60UI", name: "Chaouki", gender: "male" });
    assert.deepEqual(m.speeds, { normal: 1, slow: 0.75 });
    assert.deepEqual(Object.keys(m.clips), ["بَاب", "قَلَم"]);
    assert.deepEqual(Object.keys(m.clips["بَاب"]), ["chaouki", "asmaa"]);
    assert.deepEqual(Object.keys(m.clips["قَلَم"].asmaa), ["normal", "slow", "fp", "lufs"]);
    assert.deepEqual(JSON.parse(serializeManifest(m)), m);
  });

  it("deletes only unreferenced 12-hex clips and stale temp files", async t => {
    const root = await mkdtemp(join(tmpdir(), "asl-pipeline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "clips", "chaouki");
    await mkdir(dir, { recursive: true });
    await mkdir(join(root, "clips", "other"), { recursive: true });
    const keep = encodeMp3(sine(440, 0.3, 0.5));
    const keepSlow = encodeMp3(sine(440, 0.4, 0.5));
    const keepRel = clipRelPath("chaouki", keep);
    const keepSlowRel = clipRelPath("chaouki", keepSlow);
    await writeFile(join(root, keepRel), keep);
    await writeFile(join(root, keepSlowRel), keepSlow);
    for (const name of ["0123456789ab.mp3", "0123456789ab.mp3.tmp-42", "notes.txt", "0123456789AB.mp3", "0123456789abc.mp3"]) {
      await writeFile(join(dir, name), "x");
    }
    await writeFile(join(root, "clips", "other", "0123456789ab.mp3"), "x");
    const entry = { normal: keepRel, slow: keepSlowRel, fp: "0123456789", lufs: -18 };
    const manifest = buildManifest(new Map([["بَاب", { chaouki: entry }]]), ["بَاب"]);
    const gone = await findUnreferencedClips(root, manifest);
    assert.deepEqual(gone.map(p => p.slice(dir.length + 1)).sort(), ["0123456789ab.mp3", "0123456789ab.mp3.tmp-42"]);
    assert.equal(await entryUsable(root, "chaouki", entry), true);
    assert.equal(await entryUsable(root, "asmaa", entry), false, "path must be in the voice's folder");
    await writeFile(join(root, keepRel), "tampered");
    assert.equal(await entryUsable(root, "chaouki", entry), false, "bytes must still match the hash");
    assert.deepEqual((await readdir(dir)).length, 7, "finding files deletes nothing");
  });

  it("reads manifests NFC-keyed, ignores old versions and refuses broken JSON", async t => {
    const root = await mkdtemp(join(tmpdir(), "asl-pipeline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    assert.equal(await readManifest(root), null);
    // دَلَّ typed shadda, then fatha (F37): not NFC, so readManifest must re-key it
    const raw = "\u062F\u064E\u0644\u0651\u064E";
    const nfc = "\u062F\u064E\u0644\u064E\u0651";
    assert.notEqual(raw, raw.normalize("NFC"), "the test key must not already be NFC");
    assert.equal(raw.normalize("NFC"), nfc);
    await writeFile(join(root, "audio.json"), JSON.stringify({ version: 2, clips: { [raw]: { chaouki: { fp: "x" } } } }));
    const read = await readManifest(root);
    assert.deepEqual(Object.keys(read.clips), [nfc]);
    assert.deepEqual(read.clips[nfc], { chaouki: { fp: "x" } });
    await writeFile(join(root, "audio.json"), JSON.stringify({ voice: {}, clips: {} }));
    assert.equal(await readManifest(root), null);
    await writeFile(join(root, "audio.json"), "{ not json");
    await assert.rejects(readManifest(root), /not valid JSON/);
  });

  // A root with real clip files for `texts` in every voice, and a manifest
  // listing them with a stale fingerprint (as after a DSP or PIPELINE_VERSION
  // change), so every clip is queued and every job has a usable old entry.
  async function staleRoot(t, texts) {
    const root = await mkdtemp(join(tmpdir(), "asl-pipeline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const clips = {};
    let freq = 300;
    for (const text of texts) {
      clips[text] = {};
      for (const v of VOICES) {
        const normal = encodeMp3(sine(freq++, 0.3, 0.5));
        const slow = encodeMp3(sine(freq++, 0.4, 0.5));
        const entry = { normal: clipRelPath(v.key, normal), slow: clipRelPath(v.key, slow), fp: "0000000000", lufs: -18 };
        await mkdir(join(root, "clips", v.key), { recursive: true });
        await writeFile(join(root, entry.normal), normal);
        await writeFile(join(root, entry.slow), slow);
        clips[text][v.key] = entry;
      }
    }
    await writeFile(join(root, "audio.json"), JSON.stringify({ version: 2, clips }));
    return { root, clips };
  }
  const clipFiles = async root =>
    (await Promise.all(VOICES.map(async v => (await readdir(join(root, "clips", v.key))).map(n => `clips/${v.key}/${n}`)))).flat().sort();
  const filesOf = clips => Object.values(clips).flatMap(row => Object.values(row).flatMap(e => [e.normal, e.slow])).sort();

  it("plans stale clips as jobs and keeps their old entries until a render replaces them", async t => {
    const texts = ["بَاب", "قَلَم", "شَمْس"];
    const { root, clips } = await staleRoot(t, texts);
    const plan = await planRun(root, await readManifest(root), texts);
    assert.equal(plan.jobs.length, texts.length * VOICES.length, "every stale clip is queued");
    assert.equal(plan.reused, 0);
    for (const j of plan.jobs) {
      assert.deepEqual(j.prev, clips[j.text][j.voice.key]);
      assert.equal(j.fp, fingerprint(j.voice.key, j.text));
      assert.deepEqual(plan.entries.get(j.text)[j.voice.key], j.prev, "queued jobs keep their old entry from the start");
    }

    // Up-to-date and out-of-scope clips are not queued
    const fresh = await readManifest(root);
    for (const v of VOICES) fresh.clips[texts[0]][v.key].fp = fingerprint(v.key, texts[0]);
    const scoped = await planRun(root, fresh, texts, { voices: VOICES.filter(v => v.key === "asmaa") });
    assert.deepEqual(scoped.jobs.map(j => [j.voice.key, j.text]), [["asmaa", texts[1]], ["asmaa", texts[2]]]);
    assert.equal(scoped.reused, 2);
    assert.equal(scoped.keptStale, 2);
    assert.equal([...scoped.entries.values()].reduce((n, row) => n + Object.keys(row).length, 0), 6, "every usable entry is kept");
    const only = await planRun(root, fresh, texts, { only: new Set([texts[0]]) });
    assert.deepEqual(only.jobs.map(j => [j.voice.key, j.text]), VOICES.map(v => [v.key, texts[0]]), "--only re-renders even fresh clips");
  });

  it("an interrupted or failing run keeps every old clip it did not replace", async t => {
    const texts = ["بَاب", "قَلَم", "شَمْس", "نُور"];
    const { root, clips } = await staleRoot(t, texts);
    const before = await clipFiles(root);
    assert.deepEqual(before, filesOf(clips));
    const plan = await planRun(root, await readManifest(root), texts);

    // One job renders, then the queue is emptied (Ctrl-C, HTTP 401/402): the rest are never attempted
    const [first, ...unattempted] = plan.jobs;
    const bytes = encodeMp3(sine(1000, 0.3, 0.5));
    const slowBytes = encodeMp3(sine(1000, 0.4, 0.5));
    const rendered = { normal: clipRelPath(first.voice.key, bytes), slow: clipRelPath(first.voice.key, slowBytes), fp: first.fp, lufs: -18 };
    await writeFile(join(root, rendered.normal), bytes);
    await writeFile(join(root, rendered.slow), slowBytes);
    setEntry(plan.entries, first.text, first.voice.key, rendered);

    const stopped = await finishRun(root, plan.entries, texts, { complete: false });
    assert.equal(stopped.removed, null, "cleanup is skipped");
    assert.deepEqual(await clipFiles(root), [...before, rendered.normal, rendered.slow].sort(), "no clip file was deleted");
    for (const j of unattempted) assert.deepEqual(stopped.manifest.clips[j.text][j.voice.key], j.prev, `${j.voice.key} ${j.text} keeps its row`);
    assert.deepEqual(stopped.manifest.clips[first.text][first.voice.key], rendered);
    assert.deepEqual((await readManifest(root)).clips, stopped.manifest.clips, "audio.json was written with every row");

    // When cleanup does run, the unattempted jobs' old files are still referenced
    const done = await finishRun(root, plan.entries, texts, { complete: true });
    assert.equal(done.removed, 2, "only the replaced clip's old files go");
    assert.deepEqual(await clipFiles(root), filesOf(done.manifest.clips));
  });

  it("a failing run with no old manifest deletes nothing", async t => {
    const texts = ["بَاب", "قَلَم"];
    const { root, clips } = await staleRoot(t, texts);
    await rm(join(root, "audio.json"));
    const plan = await planRun(root, await readManifest(root), texts);
    assert.equal(plan.jobs.length, texts.length * VOICES.length);
    assert.ok(plan.jobs.every(j => j.prev === null));
    // every job failed (network down), so the run is not complete
    const { manifest, removed } = await finishRun(root, plan.entries, texts, { complete: false });
    assert.equal(removed, null);
    assert.deepEqual(manifest.clips, {});
    assert.deepEqual(await clipFiles(root), filesOf(clips), "the clip files are still there");
  });
});
