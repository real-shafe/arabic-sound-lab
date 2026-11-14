// MP3 encoding (LAME, via @breezystack/lamejs) and a small MP3 frame parser
// used to check what was written: frame sync, sample rate, bitrate and
// duration, read straight from the frame headers.

import { Mp3Encoder } from "@breezystack/lamejs";
import { float32ToInt16 } from "./dsp.mjs";

/**
 * LAME's nominal codec delay in samples (576 encoder delay + 529 decoder
 * delay). The files carry no LAME/Info tag, so decoders do not trim it: a
 * decoded clip starts with this much extra silence and the frame count
 * includes it plus up to one frame of end padding.
 */
export const LAME_CODEC_DELAY = 1105;

/** Encode mono samples (Float32Array in [-1, 1] or Int16Array) as CBR MP3. */
export function encodeMp3(samples, { sampleRate = 24000, kbps = 64 } = {}) {
  const pcm = samples instanceof Int16Array ? samples : float32ToInt16(samples);
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const parts = [];
  const CHUNK = 1152; // a multiple of 576, as lamejs expects
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const part = encoder.encodeBuffer(pcm.subarray(i, i + CHUNK));
    if (part.length) parts.push(Uint8Array.from(part));
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(Uint8Array.from(tail));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Bitrates in kbps by [version group][layer], index 1..14
const BITRATES = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { "1": [44100, 48000, 32000], "2": [22050, 24000, 16000], "2.5": [11025, 12000, 8000] };
const VERSIONS = ["2.5", null, "2", "1"];
const LAYERS = [null, 3, 2, 1];

/** Parse the 4-byte frame header at `offset`; null when it isn't one. */
export function parseFrameHeader(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = VERSIONS[(b1 >> 3) & 3];
  const layer = LAYERS[(b1 >> 1) & 3];
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (!version || !layer || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const group = version === "1" ? "1" : "2";
  const bitrate = BITRATES[`${group}-${layer}`][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const padding = (b2 >> 1) & 1;
  const channels = b3 >> 6 === 3 ? 1 : 2;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 || version === "1" ? 1152 : 576;
  const length = layer === 1
    ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
    : Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRate) + padding;
  return { version, layer, bitrate, sampleRate, padding, channels, samplesPerFrame, length, crc: (b1 & 1) === 0 };
}

const ascii = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n));

// A Xing/Info (or VBRI) tag frame carries metadata, not audio
function readTagFrame(bytes, offset, header) {
  const side = header.version === "1" ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17;
  const at = offset + 4 + (header.crc ? 2 : 0) + side;
  const id = ascii(bytes, at, 4);
  if (id === "Xing" || id === "Info") {
    const flags = (bytes[at + 4] << 24) | (bytes[at + 5] << 16) | (bytes[at + 6] << 8) | bytes[at + 7];
    let p = at + 8;
    let frames = null;
    if (flags & 1) {
      frames = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      p += 4;
    }
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    let encoderDelay = null;
    let encoderPadding = null;
    if (/^(LAME|Lavf|Lavc|L3.9)/.test(ascii(bytes, p, 4)) && p + 24 <= offset + header.length) {
      encoderDelay = (bytes[p + 21] << 4) | (bytes[p + 22] >> 4);
      encoderPadding = ((bytes[p + 22] & 0x0f) << 8) | bytes[p + 23];
    }
    return { kind: id, frames, encoderDelay, encoderPadding };
  }
  if (ascii(bytes, offset + 36, 4) === "VBRI") return { kind: "VBRI", frames: null, encoderDelay: null, encoderPadding: null };
  return null;
}

/**
 * Walk every frame of an MP3 file. Returns
 * { ok, error?, sampleRate, channels, version, layer, frames (audio frames),
 *   samples, duration (s, all audio frames), contentDuration (s, only when a
 *   LAME tag states delay and padding), bitrateKbps (average), cbr, tag,
 *   id3Bytes, firstFrameOffset, trailingBytes }.
 * `ok` is false when there is no frame at the start (after any ID3v2 tag),
 * frames do not chain, or the stream changes sample rate or channel count.
 */
export function parseMp3(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const result = {
    ok: false, error: null, sampleRate: 0, channels: 0, version: null, layer: null,
    frames: 0, samples: 0, duration: 0, contentDuration: null, bitrateKbps: 0, cbr: true,
    tag: null, id3Bytes: 0, firstFrameOffset: -1, trailingBytes: 0,
  };
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3" && bytes.length >= 10) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size + (bytes[5] & 0x10 ? 10 : 0);
    result.id3Bytes = offset;
  }
  const first = parseFrameHeader(bytes, offset);
  if (!first) {
    result.error = bytes.length ? `no MP3 frame sync at byte ${offset}` : "empty file";
    return result;
  }
  result.firstFrameOffset = offset;
  Object.assign(result, { sampleRate: first.sampleRate, channels: first.channels, version: first.version, layer: first.layer });
  let audioBytes = 0;
  let bitrate = null;
  let index = 0;
  while (offset < bytes.length) {
    const header = parseFrameHeader(bytes, offset);
    if (!header) {
      const rest = bytes.length - offset;
      if (rest === 128 && ascii(bytes, offset, 3) === "TAG") break; // ID3v1 trailer
      result.error = `lost frame sync at byte ${offset} (${rest} bytes left)`;
      result.trailingBytes = rest;
      return result;
    }
    if (header.sampleRate !== first.sampleRate || header.channels !== first.channels || header.layer !== first.layer) {
      result.error = `stream format changes at byte ${offset}`;
      return result;
    }
    if (offset + header.length > bytes.length) {
      result.error = `last frame truncated at byte ${offset}`;
      result.trailingBytes = bytes.length - offset;
      return result;
    }
    const tag = index === 0 ? readTagFrame(bytes, offset, header) : null;
    if (tag) result.tag = tag;
    else {
      result.frames++;
      result.samples += header.samplesPerFrame;
      audioBytes += header.length;
      if (bitrate === null) bitrate = header.bitrate;
      else if (bitrate !== header.bitrate) result.cbr = false;
    }
    offset += header.length;
    index++;
  }
  if (!result.frames) {
    result.error = "no audio frames";
    return result;
  }
  result.duration = result.samples / result.sampleRate;
  result.bitrateKbps = (audioBytes * 8) / result.duration / 1000;
  if (result.tag?.encoderDelay != null) {
    // Same arithmetic as FFmpeg: the 529-sample decoder delay cancels out
    const content = result.samples - result.tag.encoderDelay - result.tag.encoderPadding;
    result.contentDuration = Math.max(0, content) / result.sampleRate;
  }
  result.ok = true;
  return result;
}
