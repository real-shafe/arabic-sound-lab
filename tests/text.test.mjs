// Tests for the shared text keys in public/js/text.js (F37).
import { test } from "node:test";
import assert from "node:assert/strict";
import { key, stripMarks, ARABIC } from "../public/js/text.js";

const DAL = "د";
const FATHA = "َ";
const DAMMA = "ُ";
const KASRA = "ِ";
const SHADDA = "ّ";
const SUKUN = "ْ";
const codepoints = s => [...s].map(c => c.codePointAt(0).toString(16).padStart(4, "0")).join(" ");

test("key() makes shadda-before-vowel and vowel-before-shadda spellings identical", () => {
  const shaddaFirst = DAL + SHADDA + FATHA; // دَّ typed shadda, then fatha
  const vowelFirst = DAL + FATHA + SHADDA; //  دَّ typed fatha, then shadda
  assert.notEqual(shaddaFirst, vowelFirst, "the raw spellings differ");
  assert.equal(key(shaddaFirst), key(vowelFirst), `${codepoints(key(shaddaFirst))} vs ${codepoints(key(vowelFirst))}`);

  for (const vowel of [DAMMA, KASRA, "ً", "ٌ", "ٍ"]) {
    assert.equal(key(DAL + SHADDA + vowel), key(DAL + vowel + SHADDA), `shadda with U+${vowel.codePointAt(0).toString(16)}`);
  }
});

test("key() matches whole words whatever the shadda order", () => {
  // دَلَّ "he guided" and ضَلَّ "he went astray" typed both ways
  assert.equal(key("دَلَّ"), key("دَلَّ"));
  assert.equal(key("ضَلَّ"), key("ضَلَّ"));
  // دَرَّسَ "he taught": shadda + fatha in the middle of the word
  assert.equal(key("دَرَّسَ"), key("دَرَّسَ"));
  // A clip table keyed with key() finds a string typed in the other order
  const table = { [key("شَدَّة")]: "clip" }; // شَدَّة, shadda typed before fatha
  assert.equal(table[key("شَدَّة")], "clip");
  assert.equal(table[key("شَدَّة")], "clip"); // fatha typed before shadda
});

test("key() composes alif + madda and alif + hamza into single letters", () => {
  assert.equal(key("آ"), "آ"); // آ
  assert.equal(key("أ"), "أ"); // أ
  assert.equal(key("إ"), "إ"); // إ
});

test("key() trims surrounding whitespace but keeps inner spaces", () => {
  assert.equal(key("  عَالٍ \n"), key("عَالٍ"));
  assert.equal(key("\tالشَّمْس "), key("الشَّمْس"));
  assert.equal(key(" أَلَم عَلَم "), "أَلَم عَلَم");
});

test("key() is idempotent", () => {
  const samples = [
    DAL + SHADDA + FATHA,
    " آ ",
    "شَدَّة",
    "القَمَر",
    "ʿayn",
    "",
  ];
  for (const s of samples) assert.equal(key(key(s)), key(s), JSON.stringify(s));
});

test("key() returns NFC strings and accepts non-strings", () => {
  const k = key(DAL + SHADDA + FATHA);
  assert.equal(k, k.normalize("NFC"));
  assert.equal(key(42), "42");
});

test("stripMarks() removes harakat, shadda, sukun, tanwin, dagger alif and tatweel", () => {
  assert.equal(stripMarks("دَرَّسَ"), "درس"); // دَرَّسَ → درس
  assert.equal(stripMarks("قَلْب"), "قلب"); // قَلْب → قلب
  assert.equal(stripMarks("كِتَابٌ"), "كتاب"); // كِتَابٌ → كتاب
  assert.equal(stripMarks("عَالٍ"), "عال"); // عَالٍ → عال
  assert.equal(stripMarks("شُكْرًا"), "شكرا"); // شُكْرًا → شكرا
  assert.equal(stripMarks("هٰذَا"), "هذا"); // هٰذَا → هذا (dagger alif)
  assert.equal(stripMarks("عــ"), "ع"); // tatweel
  assert.equal(stripMarks("ـعـ"), "ع");
  for (let cp = 0x064b; cp <= 0x065f; cp++) {
    assert.equal(stripMarks(DAL + String.fromCodePoint(cp)), DAL, `U+${cp.toString(16)}`);
  }
});

test("stripMarks() keeps every letter, including hamza and its carriers", () => {
  const letters = "ءابتثجحخدذرزسشصضطظعغفقكلمنهويأإآؤئةى";
  assert.equal(stripMarks(letters), letters);
  // A hamza or madda typed as a separate mark stays with its letter
  assert.equal(stripMarks("آ"), "آ");
  assert.equal(stripMarks("أَ"), "أ");
  // Latin text and spaces are untouched
  assert.equal(stripMarks("ʿayn /ʕ/ عَ"), "ʿayn /ʕ/ ع");
});

test("stripMarks() result has no marks left and is stable", () => {
  const s = stripMarks("الشَّمْسُ");
  assert.equal(s, "الشمس");
  assert.equal(stripMarks(s), s);
  assert.doesNotMatch(s, /[ً-ٰٟـ]/);
});

test("ARABIC detects Arabic characters and has no lastIndex state", () => {
  assert.ok(ARABIC.test("ع"));
  assert.ok(ARABIC.test("the letter ع in a sentence"));
  assert.ok(ARABIC.test("َ")); // a lone mark is in the block too
  assert.ok(!ARABIC.test("ʿayn /ʕ/"));
  assert.ok(!ARABIC.test(""));
  assert.equal(ARABIC.global, false);
  assert.equal(ARABIC.test("ع"), ARABIC.test("ع"));
});
