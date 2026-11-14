// The page's view of data.js: the order and grouping of the sounds, the pairs the ear quiz draws
// from, and the lookups that tie a sound to its pairs, its regional forms and what happens to it
// after al-. No DOM work here.

import * as data from "../data.js";
import { key } from "./text.js";

const { ROMANIZATION, HINTS, PLACES, MANNERS, C, PAIRS, GROUPS, VOWELS, VCOLOR, MARKS, SUN_MOON, DIALECTS } = data;

export { data };

export const placeById = new Map(PLACES.map(p => [p.id, p]));
export const letterByChar = new Map(C.map(c => [key(c.ch), c]));
export const letterBySlug = new Map(C.map(c => [c.slug, c]));
export const vowelById = new Map(VOWELS.map(v => [v.id, v]));
export const markById = new Map(MARKS.map(m => [m.id, m]));

/** Two or three plain words for a letter's sound (ح → "throaty h"). */
export const hintOf = ch => HINTS[key(ch)] || "";

/** The one Latin symbol of a letter (ح → ḥ). */
export const latin = ch => ROMANIZATION.letters[key(ch)] || "";

// Ids of the keys in the list of sounds: letters by their character, vowels and marks by id.
export const keyOfLetter = ch => `l:${key(ch)}`;
export const keyOfVowel = id => `v:${id}`;
export const keyOfMark = id => `m:${id}`;

// The small marks that are keys of their own. The three short-vowel marks are the vowel keys a, i and u,
// and hamza's carrier letters are in hamza's own card.
export const MARK_KEYS = ["sukun", "shadda", "tanwin", "madda"].filter(id => markById.has(id));

const MANNER_ORDER = MANNERS.map(m => m.id);
const lettersAt = place => C.filter(c => c.place === place).sort((a, b) => MANNER_ORDER.indexOf(a.manner) - MANNER_ORDER.indexOf(b.manner));

/**
 * The letters in the order of the mouth, lips first, cut into groups whose sizes (4 3 7 | 3 3 1 3 2 2)
 * fill rows of 14 on wide screens and rows of 7 on phones. The ten ridge letters take two groups.
 */
export const LETTER_GROUPS = PLACES.flatMap(p => {
  const letters = lettersAt(p.id);
  if (letters.length <= 7) return [{ place: p, label: p.short, letters }];
  return [{ place: p, label: p.short, letters: letters.slice(0, 7) }, { place: p, label: `Also ${p.short.toLowerCase()}`, letters: letters.slice(7) }];
});

/** Every key, in list order: the 28 letters, the 8 vowels, then the marks. */
export const KEY_ORDER = [
  ...LETTER_GROUPS.flatMap(g => g.letters.map(c => keyOfLetter(c.ch))),
  ...VOWELS.map(v => keyOfVowel(v.id)),
  ...MARK_KEYS.map(keyOfMark),
];

/** What a key stands for. */
export function soundOf(k) {
  if (typeof k !== "string") return null;
  if (k.startsWith("l:")) {
    const c = letterByChar.get(k.slice(2));
    return c ? { kind: "letter", key: k, letter: c, name: c.name, slug: c.slug } : null;
  }
  if (k.startsWith("v:")) {
    const v = vowelById.get(k.slice(2));
    return v ? { kind: "vowel", key: k, vowel: v, name: v.label, slug: null } : null;
  }
  if (k.startsWith("m:")) {
    const m = markById.get(k.slice(2));
    return m && MARK_KEYS.includes(m.id) ? { kind: "mark", key: k, mark: m, name: m.name, slug: null } : null;
  }
  return null;
}

/** Where a sound is made, as the start of a sentence and as the end of one. */
const MADE = {
  lab: "with the lips",
  int: "between the teeth",
  alv: "just behind the upper teeth",
  pal: "at the hard palate",
  vel: "at the soft palate",
  uvu: "at the uvula",
  pha: "in the throat",
  glo: "in the voice box",
};
/** "in the throat": reads after "made" and after "it is made". */
export const madeWhere = placeId => MADE[placeId] || "";

// Vowel-length pairs point at vowel keys instead of letters.
const PAIR_KEYS = {
  len1: [keyOfVowel("a"), keyOfVowel("aa")],
  len2: [keyOfVowel("a"), keyOfVowel("aa")],
  "len-i": [keyOfVowel("i"), keyOfVowel("ii")],
  "len-u": [keyOfVowel("u"), keyOfVowel("uu")],
};

// What each side of a pair is, in a word or two, for the corner of its card.
const LENGTH_NAMES = { len1: ["short a", "long ā"], len2: ["short a", "long ā"], "len-i": ["short i", "long ī"], "len-u": ["short u", "long ū"] };

const DOUBLING = new Set(GROUPS.find(g => g.id === "doubling")?.ids || []);

/** Every contrast the ear quiz can ask about: PAIRS plus the vowel-color pairs. */
export const PAIR_LIST = [
  ...Object.entries(PAIRS).map(([id, p]) => ({ id, ...p })),
  ...VCOLOR.map(p => ({ ...p })),
].map(p => {
  const letters = (p.letters || []).map(ch => letterByChar.get(key(ch))).filter(Boolean);
  const contrast = letters.length === 2;
  const keys = [...(PAIR_KEYS[p.id] || letters.map(c => keyOfLetter(c.ch)))];
  if (DOUBLING.has(p.id)) keys.push(keyOfMark("shadda")); // the doubling pairs train what šadda writes
  // "ḥ ح vs h ه" for two letters; the two words for a difference of length.
  const title = contrast
    ? letters.map(c => `${hintOf(c.ch) || latin(c.ch)} ${c.ch}`).join(" vs ") + (VCOLOR.some(v => v.id === p.id) ? " (long ā)" : "")
    : `${p.a.tr} / ${p.b.tr}`;
  const names = contrast
    ? letters.map(c => hintOf(c.ch) || c.name)
    : LENGTH_NAMES[p.id] || (letters[0] ? [`single ${latin(letters[0].ch)}`, `doubled ${latin(letters[0].ch)}`] : ["", ""]);
  return { ...p, letters, keys, contrast, title, names, colour: VCOLOR.some(v => v.id === p.id) };
});
export const pairById = new Map(PAIR_LIST.map(p => [p.id, p]));

const group = id => GROUPS.find(g => g.id === id)?.ids || [];

/** The sets of the Sounds menu. */
export const SETS = [
  { id: "back", label: "Throat sounds", ids: group("back") },
  { id: "emphatic", label: "Plain vs heavy", ids: [...group("emphatic"), ...VCOLOR.map(p => p.id)] },
  { id: "teeth", label: "th sounds", ids: group("teeth") },
  { id: "length", label: "Long vowels", ids: group("length") },
  { id: "doubling", label: "Doubling", ids: group("doubling") },
  { id: "all", label: "Everything", ids: PAIR_LIST.map(p => p.id) },
].map(s => ({ ...s, ids: s.ids.filter(id => pairById.has(id)) }));
export const setById = new Map(SETS.map(s => [s.id, s]));

/** The pair ids a value of the Sounds menu stands for: a set id, or "pair:<id>" for one pair. */
export function idsOfChoice(value) {
  if (typeof value === "string" && value.startsWith("pair:") && pairById.has(value.slice(5))) return [value.slice(5)];
  return (setById.get(value) || SETS[0]).ids;
}

/** Pairs that train this sound. */
export const pairsForKey = k => PAIR_LIST.filter(p => p.keys.includes(k));

// Rows of the regional table that show what happens to a sound.
const DIALECT_ROW_FOR = {
  [keyOfLetter("ق")]: "q", [keyOfLetter("ج")]: "j", [keyOfLetter("ث")]: "th", [keyOfLetter("ذ")]: "dh",
  [keyOfLetter("ظ")]: "zz", [keyOfLetter("ض")]: "dd", [keyOfLetter("ك")]: "k",
  [keyOfVowel("ay")]: "ay", [keyOfVowel("aw")]: "aw",
};
export function dialectFor(k) {
  const id = DIALECT_ROW_FOR[k];
  return id ? DIALECTS.rows.find(r => r.id === id) || null : null;
}

/** What happens to the l of al- before this letter, with the example word that shows it when there is one. */
export function afterArticle(c) {
  const ch = key(c.ch);
  const sun = SUN_MOON.sun.some(x => key(x) === ch);
  const moon = SUN_MOON.moon.some(x => key(x) === ch);
  if (!sun && !moon) return null;
  let word = null;
  for (const ex of SUN_MOON.examples) {
    const i = ex.letters.findIndex(x => key(x) === ch);
    if (i >= 0) { word = i === 0 ? ex.a : ex.b; break; }
  }
  return {
    sun,
    word,
    text: sun
      ? "The l of al- is not pronounced before this letter; the letter is doubled instead."
      : "The l of al- is pronounced before this letter.",
    exception: ch === key("ج") ? SUN_MOON.exception : null,
  };
}

// Mouth-quiz answers that books disagree on (see the PLACES notes) also count as right.
const ALSO_RIGHT = { "خ": ["vel"], "غ": ["vel"], "و": ["vel"], "ش": ["alv"], "ج": ["alv"] };
export function placeIsRight(c, placeId) {
  return c.place === placeId || (ALSO_RIGHT[key(c.ch)] || []).includes(placeId);
}

/** The second place of an emphatic consonant: its pulled-back tongue root. */
export const alsoPlace = c => (c?.emph ? "pha" : null);
