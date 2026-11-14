// Consistency checks for public/data.js (F37, and the content rules behind
// F3, F4, F15–F20): NFC text, the 28 consonants, letter forms, example words
// that really have the letter where they claim, pair coverage, one
// romanization system, the dialect table, COPY and playableTexts().
import { test } from "node:test";
import assert from "node:assert/strict";
import * as data from "../public/data.js";

const { ROMANIZATION, PLACES, MANNERS, C, PAIRS, GROUPS, VOWELS, VCOLOR, MARKS, SUN_MOON, DIALECTS, SOURCES, COPY, playableTexts } = data;

const ARABIC = /[؀-ۿ]/;
const TATWEEL = "ـ";
// Harakat, tanwin, shadda, sukun, other marks, dagger alif, tatweel
const MARKS_RE = /[ً-ٰٟـ]/g;
const HAMZA_SEATS = /[أإؤئآ]/g; // أ إ ؤ ئ آ
const HIJAI = "ءبتثجحخدذرزسشصضطظعغفقكلمنهوي";
const PLACE_IDS = ["lab", "int", "alv", "pal", "vel", "uvu", "pha", "glo"];
const MANNER_IDS = ["stop", "affricate", "fricative", "nasal", "lateral", "trill", "approximant"];
const DIALECT_COLUMNS = ["msa", "cairo", "levant", "gulf", "iraq", "maghreb"];
const COPY_KEYS = [
  "intro", "consonantsIntro", "consonantsMore", "readingNote", "emphaticLegend", "pairsIntro", "quizIntro", "vowelsIntro",
  "vowelColorTitle", "vowelColorIntro", "marksIntro", "sunMoonIntro", "dialectsIntro", "audioNote",
  "syllableNote", "recorderNote",
];
// Element ids on the page; a letter slug used as #slug must not collide with them.
const PAGE_IDS = [
  "card", "surface", "picker", "tip", "detail", "sheet", "sheet-body", "sheet-pos", "set", "voice", "slow", "announcer",
  "offline-root", "off-size", "ear", "mouth", "sounds", "notes",
];
// The one romanization system (F17): ROMANIZATION symbols, a i u ā ī ū, the
// article's hyphen, spaces between words.
const TR_CHARS = /^[ʾbtṯjḥḫdḏrzsšṣḍṭẓʿġfqklmnhwyaiuāīū -]+$/u;

const nfc = s => s.normalize("NFC");
/** Letters only: marks and tatweel removed, hamza seats folded to ء. */
const fold = s => nfc(s).replace(MARKS_RE, "").replace(HAMZA_SEATS, "ء");
/** fold() without a leading article ال. */
const foldWord = s => {
  const f = fold(s);
  return f.startsWith("ال") && f.length > 3 ? f.slice(2) : f;
};
const isWord = w => w && typeof w === "object" && ["ar", "tr", "g"].every(k => typeof w[k] === "string" && w[k].trim() !== "");
const letterChars = new Set(C.map(c => c.ch));

/** Calls fn(value, path, key) for every string (and every object key) in v. */
function walkStrings(v, fn, path = "", key = "") {
  if (typeof v === "string") fn(v, path, key);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, fn, `${path}[${i}]`, key));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      fn(k, `${path} (key)`, "");
      walkStrings(x, fn, path ? `${path}.${k}` : k, k);
    }
  }
}
const allExports = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v !== "function"));

test("every Arabic string in data.js is NFC", () => {
  const bad = [];
  walkStrings(allExports, (s, path) => {
    if (ARABIC.test(s) && s !== nfc(s)) bad.push(path);
  });
  assert.deepEqual(bad, [], "not NFC (for example šadda typed before the vowel mark)");
});

test("no exclamation marks and US spelling in any text", () => {
  const bad = [];
  walkStrings(allExports, (s, path) => {
    if (s.includes("!")) bad.push(`${path}: "!"`);
    if (/\bcolour/i.test(s)) bad.push(`${path}: "colour"`);
  });
  assert.deepEqual(bad, []);
});

test("PLACES and MANNERS have the contract ids in order", () => {
  assert.deepEqual(PLACES.map(p => p.id), PLACE_IDS);
  assert.deepEqual(MANNERS.map(m => m.id), MANNER_IDS);
  for (const p of PLACES) for (const k of ["short", "name", "desc"]) assert.ok(typeof p[k] === "string" && p[k].trim(), `PLACES ${p.id}.${k}`);
  for (const m of MANNERS) for (const k of ["name", "desc"]) assert.ok(typeof m[k] === "string" && m[k].trim(), `MANNERS ${m.id}.${k}`);
});

test("C has the 28 consonant letters with unique letters, slugs and abjad 0..27 in hijāʾī order", () => {
  assert.equal(C.length, 28);
  assert.equal(new Set(C.map(c => c.ch)).size, 28, "letters are unique");
  assert.equal(new Set(C.map(c => c.slug)).size, 28, "slugs are unique");
  assert.ok(!letterChars.has("ا"), "alif is not a consonant entry");
  assert.deepEqual(C.map(c => c.abjad).sort((a, b) => a - b), [...Array(28).keys()], "abjad is 0..27");
  for (const c of C) {
    assert.equal(HIJAI[c.abjad], c.ch, `${c.slug}: abjad ${c.abjad} is ${HIJAI[c.abjad]} in hijāʾī order`);
    assert.match(c.slug, /^[a-z][a-z0-9-]*$/, `${c.ch}: slug is lower-case ASCII`);
    assert.ok(!PAGE_IDS.includes(c.slug), `${c.ch}: slug "${c.slug}" collides with a page id`);
    assert.ok(typeof c.name === "string" && c.name.trim(), `${c.slug}: name`);
    assert.ok(typeof c.ipa === "string" && c.ipa.trim() && !c.ipa.includes("/"), `${c.slug}: ipa without slashes`);
    assert.ok(typeof c.d === "string" && c.d.trim(), `${c.slug}: description`);
    if ("note" in c) assert.ok(typeof c.note === "string" && c.note.trim(), `${c.slug}: note`);
  }
});

test("every consonant has a valid place and manner and boolean flags", () => {
  for (const c of C) {
    assert.ok(PLACE_IDS.includes(c.place), `${c.slug}: place "${c.place}"`);
    assert.ok(MANNER_IDS.includes(c.manner), `${c.slug}: manner "${c.manner}"`);
    for (const k of ["voiced", "emph", "sun"]) assert.equal(typeof c[k], "boolean", `${c.slug}.${k}`);
  }
  for (const id of PLACE_IDS) assert.ok(C.some(c => c.place === id), `place ${id} has at least one letter`);
  assert.deepEqual(C.filter(c => c.emph).map(c => c.ch).sort(), ["ص", "ض", "ط", "ظ"].sort(), "the four emphatics");
});

test("sun and moon letters: 14 each, disjoint, all 28, matching C[].sun", () => {
  const { sun, moon } = SUN_MOON;
  assert.equal(sun.length, 14);
  assert.equal(moon.length, 14);
  assert.equal(new Set(sun).size, 14);
  assert.equal(new Set(moon).size, 14);
  assert.deepEqual(sun.filter(ch => moon.includes(ch)), [], "disjoint");
  assert.deepEqual([...sun, ...moon].sort(), [...letterChars].sort(), "together they are the 28 letters");
  for (const c of C) assert.equal(c.sun, sun.includes(c.ch), `${c.slug}.sun`);
  assert.ok(moon.includes("ج"), "ج is a moon letter");
  assert.ok(typeof SUN_MOON.rule === "string" && SUN_MOON.rule.trim());
  for (const k of ["exception", "sunHint", "moonHint"]) {
    assert.ok(typeof SUN_MOON[k] === "string" && SUN_MOON[k].trim(), `SUN_MOON.${k}`);
  }
});

test("letter forms use U+0640 tatweel and follow each letter's joining", () => {
  const rightJoining = new Set(["د", "ذ", "ر", "ز", "و"]);
  const nonJoining = new Set(["ء"]);
  for (const c of C) {
    const f = c.forms;
    assert.ok(f && typeof f === "object", `${c.slug}: forms`);
    const ch = c.ch;
    const T = TATWEEL;
    let want;
    if (nonJoining.has(ch)) want = { isolated: ch, initial: ch, medial: ch, final: ch };
    else if (rightJoining.has(ch)) want = { isolated: ch, initial: ch, medial: T + ch, final: T + ch };
    else want = { isolated: ch, initial: ch + T, medial: T + ch + T, final: T + ch };
    assert.deepEqual({ isolated: f.isolated, initial: f.initial, medial: f.medial, final: f.final }, want, `${c.slug} forms`);
  }
});

test("each consonant has initial, medial and final example words with the letter in that position", () => {
  const rom = ROMANIZATION.letters;
  for (const c of C) {
    for (const pos of ["initial", "medial", "final"]) {
      const w = c.ex?.[pos];
      assert.ok(isWord(w), `${c.slug}: ex.${pos} has ar, tr, g`);
      assert.ok(ARABIC.test(w.ar), `${c.slug}: ex.${pos}.ar is Arabic`);
    }
    const ch = c.ch;
    const ini = foldWord(c.ex.initial.ar);
    const med = foldWord(c.ex.medial.ar);
    const fin = foldWord(c.ex.final.ar);
    assert.equal(ini[0], ch, `${c.slug}: ${c.ex.initial.ar} starts with ${ch}`);
    assert.equal(fin.at(-1), ch, `${c.slug}: ${c.ex.final.ar} ends with ${ch}`);
    const inner = [...med].slice(1, -1);
    assert.ok(inner.includes(ch), `${c.slug}: ${c.ex.medial.ar} has ${ch} inside the word`);

    // The transliteration agrees: the letter's symbol at the start, inside, at the end.
    const r = rom[ch];
    assert.ok(c.ex.initial.tr.startsWith(r), `${c.slug}: ${c.ex.initial.tr} starts with ${r}`);
    assert.ok(c.ex.final.tr.endsWith(r), `${c.slug}: ${c.ex.final.tr} ends with ${r}`);
    assert.ok(c.ex.medial.tr.slice(1, -1).includes(r), `${c.slug}: ${c.ex.medial.tr} has ${r} inside`);
  }
});

test("syllables: one per letter, starting with the letter; hamza's is آ (F15)", () => {
  for (const c of C) {
    assert.ok(typeof c.syl === "string" && ARABIC.test(c.syl), `${c.slug}: syl`);
    assert.equal(fold(c.syl)[0], c.ch, `${c.slug}: ${c.syl} starts with ${c.ch}`);
  }
  assert.equal(C.find(c => c.ch === "ء").syl, "آ");
});

test("ROMANIZATION has one symbol for each of the 28 letters", () => {
  assert.ok(typeof ROMANIZATION.name === "string" && ROMANIZATION.name.trim());
  assert.ok(typeof ROMANIZATION.note === "string" && ROMANIZATION.note.trim());
  const letters = ROMANIZATION.letters;
  assert.deepEqual(Object.keys(letters).sort(), [...letterChars].sort());
  for (const [ch, r] of Object.entries(letters)) {
    assert.equal([...r].length, 1, `${ch} → "${r}" is one symbol`);
    assert.match(r, TR_CHARS, `${ch} → "${r}"`);
  }
  assert.equal(new Set(Object.values(letters)).size, 28, "symbols are unique");
  assert.equal(letters["ء"], "ʾ");
});

test("romanization: no ʔ in any tr or name, and every tr uses only the one system's symbols (F17)", () => {
  const bad = [];
  walkStrings(allExports, (s, path, key) => {
    if ((key === "tr" || key === "name") && s.includes("ʔ")) bad.push(`${path}: ${s}`);
    if (key === "tr" && !TR_CHARS.test(s)) bad.push(`${path}: "${s}" has a symbol outside the system`);
  });
  assert.deepEqual(bad, []);
});

test("pairs, groups and contrast cards are complete and consistent", () => {
  const ids = Object.keys(PAIRS);
  assert.ok(ids.length >= 19, "at least the 19 pairs of v1");
  for (const g of GROUPS) {
    assert.ok(typeof g.id === "string" && typeof g.title === "string" && g.title.trim(), `group ${g.id}`);
    assert.ok(Array.isArray(g.ids) && g.ids.length, `group ${g.id} has pairs`);
    for (const id of g.ids) assert.ok(id in PAIRS, `group ${g.id}: pair "${id}" exists in PAIRS`);
  }
  const grouped = GROUPS.flatMap(g => g.ids);
  assert.equal(new Set(grouped).size, grouped.length, "no pair is in two groups");
  assert.deepEqual(ids.filter(id => !grouped.includes(id)), [], "every pair is in a group");

  const cards = [
    ...Object.entries(PAIRS).map(([id, p]) => [`PAIRS.${id}`, p]),
    ...VCOLOR.map(p => [`VCOLOR.${p.id}`, p]),
    ...SUN_MOON.examples.map(p => [`SUN_MOON.examples.${p.id}`, p]),
  ];
  for (const [name, p] of cards) {
    assert.ok(typeof p.label === "string" && p.label.trim(), `${name}: label`);
    assert.ok(Array.isArray(p.letters), `${name}: letters is an array`);
    for (const ch of p.letters) assert.ok(letterChars.has(ch), `${name}: "${ch}" is one of the 28 letters`);
    assert.ok(isWord(p.a) && isWord(p.b), `${name}: a and b have ar, tr, g`);
    assert.notEqual(nfc(p.a.ar), nfc(p.b.ar), `${name}: the two words differ`);
    assert.ok(typeof p.n === "string" && p.n.trim(), `${name}: note`);
    if (p.letters.length === 2) {
      assert.ok(fold(p.a.ar).includes(p.letters[0]), `${name}: ${p.a.ar} has ${p.letters[0]}`);
      assert.ok(fold(p.b.ar).includes(p.letters[1]), `${name}: ${p.b.ar} has ${p.letters[1]}`);
    } else if (p.letters.length === 1) {
      assert.ok(fold(p.a.ar).includes(p.letters[0]) && fold(p.b.ar).includes(p.letters[0]), `${name}: both words have ${p.letters[0]}`);
    }
  }
  for (const p of VCOLOR) assert.ok(typeof p.id === "string" && p.id, "VCOLOR id");
});

test("sun and moon examples: a sun letter assimilates, a moon letter keeps al- (F16)", () => {
  const rom = ROMANIZATION.letters;
  assert.ok(SUN_MOON.examples.length >= 2);
  for (const p of SUN_MOON.examples) {
    const [s, m] = p.letters;
    assert.ok(SUN_MOON.sun.includes(s), `${p.id}: ${s} is a sun letter`);
    assert.ok(SUN_MOON.moon.includes(m), `${p.id}: ${m} is a moon letter`);
    assert.ok(fold(p.a.ar).startsWith("ال" + s), `${p.id}: ${p.a.ar} is al- + ${s}`);
    assert.ok(fold(p.b.ar).startsWith("ال" + m), `${p.id}: ${p.b.ar} is al- + ${m}`);
    assert.ok(p.a.tr.startsWith(`a${rom[s]}-${rom[s]}`), `${p.id}: ${p.a.tr} shows the assimilation`);
    assert.ok(p.b.tr.startsWith("al-"), `${p.id}: ${p.b.tr} starts with al-`);
  }
});

test("vowels and marks are complete", () => {
  assert.ok(VOWELS.length >= 6);
  for (const v of VOWELS) {
    assert.ok(isWord(v), `vowel ${v.label}: ar, tr, g`);
    assert.ok(typeof v.ipa === "string" && v.ipa.trim() && !v.ipa.includes("/"), `vowel ${v.label}: ipa`);
    assert.ok(typeof v.label === "string" && v.label.trim());
  }
  assert.ok(MARKS.length >= 5);
  assert.equal(new Set(MARKS.map(m => m.id)).size, MARKS.length, "mark ids are unique");
  for (const m of MARKS) {
    for (const k of ["id", "name", "mark", "sound", "desc"]) assert.ok(typeof m[k] === "string" && m[k].trim(), `mark ${m.id}.${k}`);
    assert.ok(ARABIC.test(m.mark), `mark ${m.id}: mark is Arabic`);
    assert.ok(isWord(m.ex), `mark ${m.id}: ex has ar, tr, g`);
  }
});

test("dialect table: the six columns and an /IPA/ form in every cell (F20)", () => {
  assert.ok(typeof DIALECTS.note === "string" && DIALECTS.note.trim());
  assert.deepEqual(DIALECTS.columns.map(c => c.id), DIALECT_COLUMNS);
  for (const col of DIALECTS.columns) assert.ok(col.name?.trim() && col.region?.trim(), `column ${col.id}`);
  assert.ok(DIALECTS.rows.length >= 5);
  assert.equal(new Set(DIALECTS.rows.map(r => r.id)).size, DIALECTS.rows.length, "row ids are unique");
  for (const row of DIALECTS.rows) {
    assert.ok(isWord(row) && ARABIC.test(row.ar), `row ${row.id}: ar, tr, g`);
    for (const col of DIALECT_COLUMNS) {
      const f = row.forms?.[col];
      assert.match(f ?? "", /^\/[^/]+\/( ~ \/[^/]+\/)*$/, `row ${row.id}, ${col}: "${f}" is /IPA/`);
    }
  }
});

test("SOURCES have text and https links", () => {
  assert.ok(SOURCES.length >= 1);
  for (const s of SOURCES) {
    assert.ok(typeof s.text === "string" && s.text.trim());
    if (s.url !== undefined) assert.match(s.url, /^https:\/\//, s.text);
  }
});

// MARKS.sukun.desc says words are shown without a final vowel or sukūn, except verbs (dictionary
// form) and the command عُدْ, and MARKS.tanwin.desc says only its own example carries tanwīn.
test("final vowels, sukūn and tanwīn match what MARKS.sukun and MARKS.tanwin say", () => {
  const gloss = new Map();
  const walk = o => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (typeof o.ar === "string" && typeof o.g === "string") {
      const k = o.ar.normalize("NFC").trim();
      if (!gloss.has(k)) gloss.set(k, o.g);
    }
    Object.values(o).forEach(walk);
  };
  walk([C, PAIRS, VOWELS, VCOLOR, MARKS, SUN_MOON, DIALECTS]);
  const tanwinEx = MARKS.find(m => m.id === "tanwin").ex.ar.normalize("NFC").trim();
  for (const t of playableTexts()) {
    const s = t.replace(/\u0651/g, "");
    if (/[\u064B-\u064D]$/.test(s)) assert.equal(t, tanwinEx, `${t}: only the tanwīn example ends in tanwīn`);
    else if (/[\u064E-\u0650\u0652]$/.test(s)) {
      const g = gloss.get(t) ?? "";
      assert.ok(/^(he|it) /.test(g) || t === "عُدْ", `${t} (${g}): a final vowel or sukūn is only written on verbs and عُدْ`);
    }
  }
});

test("COPY has every contract key, non-empty", () => {
  for (const k of COPY_KEYS) assert.ok(typeof COPY[k] === "string" && COPY[k].trim(), `COPY.${k}`);
});

test("playableTexts(): unique, NFC, trimmed, Arabic, and covering every playable word", () => {
  const texts = playableTexts();
  assert.ok(Array.isArray(texts) && texts.length > 0);
  assert.equal(new Set(texts).size, texts.length, "unique");
  for (const t of texts) {
    assert.equal(typeof t, "string");
    assert.equal(t, nfc(t).trim(), `"${t}" is NFC and trimmed`);
    assert.ok(ARABIC.test(t), `"${t}" is Arabic`);
  }
  const have = new Set(texts);
  const expected = [
    ...C.flatMap(c => [c.syl, c.ex.initial.ar, c.ex.medial.ar, c.ex.final.ar]),
    ...Object.values(PAIRS).flatMap(p => [p.a.ar, p.b.ar]),
    ...VOWELS.map(v => v.ar),
    ...VCOLOR.flatMap(p => [p.a.ar, p.b.ar]),
    ...MARKS.map(m => m.ex.ar),
    ...SUN_MOON.examples.flatMap(p => [p.a.ar, p.b.ar]),
    ...DIALECTS.rows.map(r => r.ar),
  ].map(s => nfc(s).trim());
  assert.deepEqual([...new Set(expected.filter(s => !have.has(s)))], [], "missing from playableTexts()");
  assert.deepEqual(texts.filter(t => !expected.includes(t)), [], "in playableTexts() but not shown anywhere");
});
