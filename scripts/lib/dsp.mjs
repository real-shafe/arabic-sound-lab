// Signal processing for the clip pipeline: PCM conversion, silence trimming,
// loudness measurement and normalization, a peak ceiling, and a WSOLA
// time-stretch for the slow clips. Pure functions on mono Float32Array
// signals (full scale = ±1.0). No dependencies and no I/O, so the tests can
// exercise every step without the network.

const dbToGain = db => 10 ** (db / 20);
const gainToDb = g => 20 * Math.log10(g);

/** Signed 16-bit little-endian mono PCM bytes → Float32Array in [-1, 1). */
export function pcm16leToFloat32(bytes) {
  const n = bytes.byteLength >> 1; // an odd trailing byte is ignored
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Float32Array → Int16Array, clamped and rounded. */
export function float32ToInt16(x) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** Largest absolute sample value. */
export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

/** Sample peak in dBFS (-Infinity for silence). */
export const peakDb = x => gainToDb(peak(x));

/** Raised-cosine fade-in and fade-out, in place. Returns x. */
export function applyFades(x, { sampleRate = 24000, fadeMs = 5 } = {}) {
  const n = Math.min(Math.round((fadeMs / 1000) * sampleRate), Math.floor(x.length / 2));
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

/**
 * Cut leading and trailing silence, keeping a fixed lead-in before the first
 * sound and a tail after the last one (padded with digital silence when the
 * source has less), with short fades on the kept audio so nothing clicks.
 *
 * "Sound" is any 10 ms frame whose RMS is within `relativeDb` of the loudest
 * frame and above `floorDb`. The lead-in and tail protect quiet onsets and
 * releases (an initial burst, a final qalqala echo, a fading h) that sit
 * just under the threshold.
 */
export function trimSilence(x, {
  sampleRate = 24000,
  leadMs = 40,
  tailMs = 100,
  fadeMs = 5,
  frameMs = 10,
  relativeDb = -40,
  floorDb = -60,
} = {}) {
  const f = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const frames = Math.ceil(x.length / f);
  const levels = new Float64Array(frames);
  let top = -Infinity;
  for (let k = 0; k < frames; k++) {
    const a = k * f;
    const b = Math.min(x.length, a + f);
    let s = 0;
    for (let i = a; i < b; i++) s += x[i] * x[i];
    levels[k] = 10 * Math.log10(s / (b - a) + 1e-20);
    if (levels[k] > top) top = levels[k];
  }
  const threshold = Math.max(top + relativeDb, floorDb);
  let first = -1;
  let last = -1;
  for (let k = 0; k < frames; k++) {
    if (levels[k] > threshold) {
      if (first < 0) first = k;
      last = k;
    }
  }
  if (first < 0) {
    return { signal: new Float32Array(0), silent: true, thresholdDb: threshold };
  }
  const soundStart = first * f;
  const soundEnd = Math.min(x.length, (last + 1) * f);
  const lead = Math.round((leadMs / 1000) * sampleRate);
  const tail = Math.round((tailMs / 1000) * sampleRate);
  const from = Math.max(0, soundStart - lead);
  const to = Math.min(x.length, soundEnd + tail);
  const segment = applyFades(x.slice(from, to), { sampleRate, fadeMs });
  const padStart = lead - (soundStart - from);
  const padEnd = tail - (to - soundEnd);
  const signal = new Float32Array(padStart + segment.length + padEnd);
  signal.set(segment, padStart);
  return {
    signal,
    silent: false,
    thresholdDb: threshold,
    soundStart, // sample index in the input
    soundEnd,
    cutStart: from, // samples removed from the start of the input
    cutEnd: x.length - to,
  };
}

/**
 * ITU-R BS.1770 K-weighting as two biquads, derived from the analog
 * prototype so it is correct at any sample rate (the standard only tabulates
 * 48 kHz). Same derivation as libebur128.
 */
export function kWeightingCoefficients(sampleRate) {
  // Stage 1: high shelf, about +4 dB above 2 kHz (the head's acoustic effect)
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: the RLB high-pass at about 38 Hz
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, highpass];
}

function biquad(x, { b0, b1, b2, a1, a2 }) {
  const out = new Float64Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + z1;
    z1 = b1 * xi - a1 * yi + z2;
    z2 = b2 * xi - a2 * yi;
    out[i] = yi;
  }
  return out;
}

/**
 * Integrated loudness in LUFS (BS.1770-4): K-weighting, 400 ms blocks with
 * 75 % overlap, an absolute gate at -70 LUFS and a relative gate 10 LU below
 * the ungated mean. A clip shorter than one block is measured as one block.
 * Returns -Infinity for silence.
 */
export function integratedLoudness(x, sampleRate = 24000) {
  if (!x.length) return -Infinity;
  const [shelf, highpass] = kWeightingCoefficients(sampleRate);
  const y = biquad(biquad(x, shelf), highpass);
  const cum = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) cum[i + 1] = cum[i] + y[i] * y[i];
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const z = [];
  if (y.length < block) z.push(cum[y.length] / y.length);
  else for (let s = 0; s + block <= y.length; s += hop) z.push((cum[s + block] - cum[s]) / block);
  const lufs = ms => -0.691 + 10 * Math.log10(ms);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const aboveAbsolute = z.filter(ms => lufs(ms) > -70);
  if (!aboveAbsolute.length) return -Infinity;
  const relativeGate = lufs(mean(aboveAbsolute)) - 10;
  const gated = aboveAbsolute.filter(ms => lufs(ms) > relativeGate);
  return lufs(mean(gated));
}

// Minimum of a[] over [i - w, i + w] for every i (monotonic deque, O(n))
function slidingMin(a, w) {
  const n = a.length;
  const out = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + w);
    for (; j <= hi; j++) {
      while (tail > head && a[dq[tail - 1]] >= a[j]) tail--;
      dq[tail++] = j;
    }
    while (dq[head] < i - w) head++;
    out[i] = a[dq[head]];
  }
  return out;
}

// Mean of a[] over [i - w, i + w] (clipped at the ends) for every i
function boxMean(a, w) {
  const n = a.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + a[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(n, i + w + 1);
    out[i] = (cum[hi] - cum[lo]) / (hi - lo);
  }
  return out;
}

/**
 * Sample-peak ceiling. Where a sample would exceed the ceiling, a smooth gain
 * dip (a minimum filter followed by a moving average of the same radius, so
 * the gain is never above what any nearby sample needs) pulls it under.
 * Returns a new signal; the input is not modified.
 */
export function limitPeak(x, { sampleRate = 24000, ceilingDb = -1, windowMs = 5 } = {}) {
  const ceiling = dbToGain(ceilingDb);
  const signal = Float32Array.from(x);
  if (peak(x) <= ceiling) return { signal, reductionDb: 0 };
  const need = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    need[i] = a > ceiling ? ceiling / a : 1;
  }
  const w = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const gain = boxMean(slidingMin(need, w), w);
  let minGain = 1;
  for (let i = 0; i < x.length; i++) {
    let v = x[i] * gain[i];
    // float rounding can leave a sample a hair over the line
    if (v > ceiling) v = ceiling;
    else if (v < -ceiling) v = -ceiling;
    signal[i] = v;
    if (gain[i] < minGain) minGain = gain[i];
  }
  return { signal, reductionDb: -gainToDb(minGain) };
}

/**
 * Bring a clip to a target integrated loudness without letting any sample
 * pass the peak ceiling. When the ceiling bites, the measured loudness drops
 * a little, so the gain is nudged up and the ceiling reapplied (at most 6 dB
 * of extra push, which ordinary speech never needs).
 */
export function normalizeLoudness(x, { sampleRate = 24000, targetLufs = -18, ceilingDb = -1 } = {}) {
  const before = integratedLoudness(x, sampleRate);
  if (!Number.isFinite(before)) {
    return { signal: Float32Array.from(x), lufs: before, inputLufs: before, gainDb: 0, reductionDb: 0 };
  }
  const baseGain = targetLufs - before;
  const maxGain = baseGain + 6;
  let gainDb = baseGain;
  let prev = null; // { gainDb, lufs } of the previous pass, for a secant step
  let result;
  let lufs;
  for (let pass = 0; pass < 8; pass++) {
    const g = dbToGain(gainDb);
    const scaled = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) scaled[i] = x[i] * g;
    result = limitPeak(scaled, { sampleRate, ceilingDb });
    lufs = integratedLoudness(result.signal, sampleRate);
    const error = targetLufs - lufs;
    if (Math.abs(error) < 0.05 || gainDb >= maxGain) break;
    // Once the ceiling bites, 1 dB more gain buys less than 1 LU: follow the measured slope
    let slope = 1;
    if (prev && gainDb !== prev.gainDb) slope = Math.min(1, Math.max(0.1, (lufs - prev.lufs) / (gainDb - prev.gainDb)));
    prev = { gainDb, lufs };
    gainDb = Math.min(gainDb + error / slope, maxGain);
  }
  return { signal: result.signal, lufs, inputLufs: before, gainDb, reductionDb: result.reductionDb };
}

/**
 * WSOLA time-stretch (waveform-similarity overlap-add; Verhelst & Roelands
 * 1993). Changes duration by 1 / speed while keeping pitch and timbre: each
 * output frame is copied from near its nominal input position, shifted by up
 * to ±toleranceMs so that its waveform lines up with the natural continuation
 * of the previous frame, then overlap-added with a Hann window at 50 %
 * overlap. The tolerance must exceed half the longest pitch period (12 ms
 * covers voices down to about 42 Hz).
 */
export function wsolaStretch(x, { speed = 0.75, sampleRate = 24000, frameMs = 30, toleranceMs = 12 } = {}) {
  if (!(speed > 0)) throw new RangeError("speed must be positive");
  const outLen = Math.round(x.length / speed);
  if (!x.length) return new Float32Array(0);
  const N = 2 * Math.max(8, Math.round(((frameMs / 1000) * sampleRate) / 2));
  const half = N / 2;
  const synthesisHop = half;
  const analysisHop = synthesisHop * speed;
  const tol = Math.max(1, Math.round((toleranceMs / 1000) * sampleRate));

  // Zero-padded copy so every frame and search window stays in bounds
  const pad = 2 * N + tol + 2 * Math.ceil(analysisHop);
  const xp = new Float32Array(x.length + 2 * pad + N);
  xp.set(x, pad);
  const energy = new Float64Array(xp.length + 1);
  for (let i = 0; i < xp.length; i++) energy[i + 1] = energy[i] + xp[i] * xp[i];

  const win = new Float32Array(N);
  for (let k = 0; k < N; k++) win[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N); // periodic Hann: sums to 1 at 50 % overlap

  const frames = Math.ceil(Math.max(0, outLen - 1) / synthesisHop) + 2;
  const y = new Float64Array(frames * synthesisHop + N);
  const wsum = new Float64Array(y.length);
  let delta = 0;
  for (let m = 0; m < frames; m++) {
    // Frame m is centered on output sample m * synthesisHop (y index + half)
    const start = Math.round(m * analysisHop) + delta - half + pad;
    const ostart = m * synthesisHop;
    for (let k = 0; k < N; k++) {
      y[ostart + k] += xp[start + k] * win[k];
      wsum[ostart + k] += win[k];
    }
    // Pick the next frame's offset: best normalized match to the natural continuation
    const natural = start + synthesisHop;
    const nominal = Math.round((m + 1) * analysisHop) - half + pad;
    let bestScore = -Infinity;
    let best = 0;
    for (let d = -tol; d <= tol; d++) {
      const c = nominal + d;
      let dot = 0;
      for (let k = 0; k < N; k++) dot += xp[natural + k] * xp[c + k];
      const score = dot / Math.sqrt(energy[c + N] - energy[c] + 1e-12);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    delta = best;
  }
  const out = new Float32Array(outLen);
  for (let t = 0; t < outLen; t++) {
    const w = wsum[t + half];
    out[t] = w > 1e-3 ? y[t + half] / w : 0;
  }
  return out;
}
