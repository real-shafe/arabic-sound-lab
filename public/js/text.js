// Shared text helpers. Every clip lookup in the page, the audio generator and
// the tests goes through key(), so a string matches its clip however its marks
// were typed (F37).
//
// NFC canonical ordering sorts combining marks by combining class, so shadda
// typed before or after a short vowel ("دّ" + fatha or "د" + fatha + shadda)
// becomes the same code-point sequence, and alif + madda becomes آ.
// No DOM access here: this module is also imported by Node scripts and tests.

/** Lookup key for an Arabic string: Unicode NFC, surrounding whitespace removed. */
export const key = s => String(s).normalize("NFC").trim();

// Tanwin, harakat, shadda, sukun, madda/hamza above and below, other marks
// U+064B–U+065F, dagger (superscript) alif U+0670, and tatweel U+0640.
const MARKS_RE = /[ً-ٰٟـ]/g;

/**
 * Removes Arabic diacritics and tatweel and keeps the letters. The text is
 * NFC-normalized first so a hamza or madda typed as a separate mark is folded
 * into its letter (أ إ آ ؤ ئ) and kept, instead of being stripped off it.
 */
export const stripMarks = s => String(s).normalize("NFC").replace(MARKS_RE, "");

/** Matches any character in the Arabic block (U+0600–U+06FF). Not global, so .test() has no state. */
export const ARABIC = /[؀-ۿ]/;
