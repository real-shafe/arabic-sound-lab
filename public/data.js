// Everything the page teaches, in one place so it can be fact-checked in one
// pass. Shared by the page (js/*.js) and the clip generator
// (scripts/generate-audio.mjs): every Arabic string returned by
// playableTexts() gets its own pre-generated clip in each voice.
//
// Conventions
// - Every string is Unicode NFC (so a šadda is stored after its vowel mark).
// - Words are fully vowelled. Nouns and adjectives are shown in pause form:
//   no case vowel, tanwīn or sukūn is written on the last letter (except in
//   the tanwīn example under MARKS). Verbs keep the final vowel of their
//   citation form (كَتَبَ kataba), and the command عُدْ ʿud ends in a sukūn.
//   MARKS.sukun.desc tells the reader this; keep the two in step.
// - `tr` and `name` use ROMANIZATION below and never contain IPA.
// - IPA (`ipa`, DIALECTS forms) never mixes into `tr`; in prose it sits
//   between slashes, as in /ʕ/.

export const ROMANIZATION = {
  name: "Transliteration (DIN 31635 style)",
  note:
    "Each Arabic letter has one Latin symbol, close to the DIN 31635 standard but with j for ج and ʾ written for every pronounced hamza, except the connecting hamza at the start of the article al- and of Allāh, which is left unwritten as in DIN. " +
    "A line over a vowel (ā ī ū) means it is long, a doubled letter means šadda, final ة is written a, and the article is written as it is pronounced (aš-šams, al-qamar).",
  letters: {
    "ء": "ʾ", "ب": "b", "ت": "t", "ث": "ṯ", "ج": "j", "ح": "ḥ", "خ": "ḫ",
    "د": "d", "ذ": "ḏ", "ر": "r", "ز": "z", "س": "s", "ش": "š", "ص": "ṣ",
    "ض": "ḍ", "ط": "ṭ", "ظ": "ẓ", "ع": "ʿ", "غ": "ġ", "ف": "f", "ق": "q",
    "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w", "ي": "y"
  }
};

// Two or three plain words for each sound, for readers who cannot tell ḥ from h at a glance.
// Shown next to a word in the ear quiz and in the key to the Latin letters.
export const HINTS = {
  "ء": "uh-oh catch", "ب": "b", "ت": "plain t", "ث": "th in thin", "ج": "j", "ح": "throaty h", "خ": "rough kh",
  "د": "plain d", "ذ": "th in this", "ر": "tapped r", "ز": "plain z", "س": "plain s", "ش": "sh", "ص": "heavy s",
  "ض": "heavy d", "ط": "heavy t", "ظ": "heavy th", "ع": "tight throat", "غ": "gargled gh", "ف": "f", "ق": "deep q",
  "ك": "plain k", "ل": "l", "م": "m", "ن": "n", "ه": "plain h", "و": "w", "ي": "y"
};

// Front to back: left to right on the mouth diagram, top to bottom in the list.
export const PLACES = [
  {
    id: "lab", short: "Lips", name: "Lips",
    desc: "Both lips, or the lower lip against the upper teeth",
    note: "ف is made with the lower lip against the upper teeth. و rounds the lips and also raises the back of the tongue, as English w does."
  },
  {
    id: "int", short: "Between teeth", name: "Between the teeth",
    desc: "Tongue tip between the upper and lower front teeth"
  },
  {
    id: "alv", short: "Behind teeth", name: "Behind the upper teeth",
    desc: "Tongue tip on the gum ridge just behind the upper front teeth"
  },
  {
    id: "pal", short: "Palate", name: "Hard palate",
    desc: "Tongue blade or body raised toward the hard palate",
    note: "ش and ج are strictly made just behind the gum ridge (postalveolar), like English sh and j; only ي is a true palatal sound. Medieval Arabic grammarians grouped the three together, as this chart does."
  },
  {
    id: "vel", short: "Soft palate", name: "Soft palate",
    desc: "Back of the tongue against the soft palate"
  },
  {
    id: "uvu", short: "Uvula", name: "Uvula",
    desc: "Very back of the tongue at or near the uvula",
    note: "ق is clearly uvular. خ and غ are described as velar in some books and uvular in others, and speakers vary; they are grouped here with ق."
  },
  {
    id: "pha", short: "Throat", name: "Throat (pharynx)",
    desc: "Tongue root pulled back toward the back wall of the throat"
  },
  {
    id: "glo", short: "Voice box", name: "Voice box (glottis)",
    desc: "The vocal folds themselves, inside the larynx"
  }
];

// Display order within a place.
export const MANNERS = [
  { id: "stop", name: "Stop", desc: "The airflow is blocked completely, then released." },
  { id: "affricate", name: "Affricate", desc: "A stop released into friction, like the j of jam." },
  { id: "fricative", name: "Fricative", desc: "Air is pushed through a narrow gap, making a hiss, buzz or rasp." },
  { id: "nasal", name: "Nasal", desc: "The mouth is closed off and the air flows out through the nose." },
  { id: "lateral", name: "Lateral", desc: "The tongue tip touches the gum ridge and air flows past the sides of the tongue." },
  { id: "trill", name: "Trill or tap", desc: "The tongue tip taps the gum ridge once, or vibrates against it several times." },
  { id: "approximant", name: "Approximant", desc: "The tongue or lips come close but leave room for air to flow smoothly, as in English w and y." }
];

// Contextual letter shapes. U+0640 (tatweel) stands for the joining stroke.
// Letters that never join to the following letter repeat their isolated and
// final shapes; hamza on the line joins to neither side.
const T = "ـ";
const joins = ch => ({ isolated: ch, initial: ch + T, medial: T + ch + T, final: T + ch });
const rightOnly = ch => ({ isolated: ch, initial: ch, medial: T + ch, final: T + ch });

// The 28 consonant letters (hamza instead of alif), front to back, and within
// a place in MANNERS order. `abjad` is the 0-based position in the standard
// hijāʾī order: ء ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ ف ق ك ل م ن ه و ي.
export const C = [
  // Lips
  {
    ch: "ب", slug: "ba", name: "bāʾ", ipa: "b",
    place: "lab", manner: "stop", voiced: true, emph: false, sun: false, abjad: 1,
    forms: joins("ب"), syl: "بَا",
    ex: {
      initial: { ar: "بَحْر", tr: "baḥr", g: "sea" },
      medial: { ar: "خُبْز", tr: "ḫubz", g: "bread" },
      final: { ar: "كِتَاب", tr: "kitāb", g: "book" }
    },
    d: "Like English b. Arabic has no p, so p in foreign words is often said as b."
  },
  {
    ch: "ف", slug: "fa", name: "fāʾ", ipa: "f",
    place: "lab", manner: "fricative", voiced: false, emph: false, sun: false, abjad: 19,
    forms: joins("ف"), syl: "فَا",
    ex: {
      initial: { ar: "فِيل", tr: "fīl", g: "elephant" },
      medial: { ar: "سَفَر", tr: "safar", g: "travel" },
      final: { ar: "خَرُوف", tr: "ḫarūf", g: "sheep" }
    },
    d: "Like English f, made with the lower lip against the upper teeth. Arabic has no v of its own; v in foreign words is often said as f."
  },
  {
    ch: "م", slug: "mim", name: "mīm", ipa: "m",
    place: "lab", manner: "nasal", voiced: true, emph: false, sun: false, abjad: 23,
    forms: joins("م"), syl: "مَا",
    ex: {
      initial: { ar: "مَاء", tr: "māʾ", g: "water" },
      medial: { ar: "سَمَك", tr: "samak", g: "fish" },
      final: { ar: "يَوْم", tr: "yawm", g: "day" }
    },
    d: "Like English m."
  },
  {
    ch: "و", slug: "waw", name: "wāw", ipa: "w",
    place: "lab", manner: "approximant", voiced: true, emph: false, sun: false, abjad: 26,
    forms: rightOnly("و"), syl: "وَا",
    ex: {
      initial: { ar: "وَلَد", tr: "walad", g: "boy" },
      medial: { ar: "طَوِيل", tr: "ṭawīl", g: "long, tall" },
      final: { ar: "جَوّ", tr: "jaww", g: "weather, air" }
    },
    d: "Like English w. The same letter also writes the long vowel ū.",
    note: "و rounds the lips and raises the back of the tongue toward the soft palate, so it could also be listed there. It is grouped with the lips here."
  },

  // Between the teeth
  {
    ch: "ث", slug: "tha", name: "ṯāʾ", ipa: "θ",
    place: "int", manner: "fricative", voiced: false, emph: false, sun: true, abjad: 3,
    forms: joins("ث"), syl: "ثَا",
    ex: {
      initial: { ar: "ثَلْج", tr: "ṯalj", g: "snow" },
      medial: { ar: "كَثِير", tr: "kaṯīr", g: "many, a lot" },
      final: { ar: "حَدِيث", tr: "ḥadīṯ", g: "talk, conversation" }
    },
    d: "The th of thin: the tongue tip between or just behind the front teeth, with breath alone."
  },
  {
    ch: "ذ", slug: "dhal", name: "ḏāl", ipa: "ð",
    place: "int", manner: "fricative", voiced: true, emph: false, sun: true, abjad: 8,
    forms: rightOnly("ذ"), syl: "ذَا",
    ex: {
      initial: { ar: "ذَهَب", tr: "ḏahab", g: "gold" },
      medial: { ar: "أُذُن", tr: "ʾuḏun", g: "ear" },
      final: { ar: "تِلْمِيذ", tr: "tilmīḏ", g: "pupil" }
    },
    d: "The th of this: the tongue where it is for ث, plus a hum."
  },
  {
    ch: "ظ", slug: "zaa", name: "ẓāʾ", ipa: "ðˤ",
    place: "int", manner: "fricative", voiced: true, emph: true, sun: true, abjad: 16,
    forms: joins("ظ"), syl: "ظَا",
    ex: {
      initial: { ar: "ظُهْر", tr: "ẓuhr", g: "noon" },
      medial: { ar: "نَظِيف", tr: "naẓīf", g: "clean" },
      final: { ar: "حَظّ", tr: "ḥaẓẓ", g: "luck" }
    },
    d: "The heavy version of ذ: the tongue tip at the teeth as for ذ, with the tongue root pulled back toward the throat. Vowels next to it sound darker.",
    note: "In most spoken dialects ظ and ض have merged into a single sound; see the dialect table."
  },

  // Teeth and gum ridge
  {
    ch: "ت", slug: "ta", name: "tāʾ", ipa: "t",
    place: "alv", manner: "stop", voiced: false, emph: false, sun: true, abjad: 2,
    forms: joins("ت"), syl: "تَا",
    ex: {
      initial: { ar: "تِين", tr: "tīn", g: "figs" },
      medial: { ar: "مِفْتَاح", tr: "miftāḥ", g: "key" },
      final: { ar: "بَيْت", tr: "bayt", g: "house" }
    },
    d: "Like English t, but with the tongue tip against the back of the upper teeth rather than on the ridge behind them."
  },
  {
    ch: "د", slug: "dal", name: "dāl", ipa: "d",
    place: "alv", manner: "stop", voiced: true, emph: false, sun: true, abjad: 7,
    forms: rightOnly("د"), syl: "دَا",
    ex: {
      initial: { ar: "دَرْس", tr: "dars", g: "lesson" },
      medial: { ar: "قَدَم", tr: "qadam", g: "foot" },
      final: { ar: "بَلَد", tr: "balad", g: "country" }
    },
    d: "Like English d, but made against the back of the upper teeth."
  },
  {
    ch: "ط", slug: "taa", name: "ṭāʾ", ipa: "tˤ",
    place: "alv", manner: "stop", voiced: false, emph: true, sun: true, abjad: 15,
    forms: joins("ط"), syl: "طَا",
    ex: {
      initial: { ar: "طَبِيب", tr: "ṭabīb", g: "doctor" },
      medial: { ar: "مَطَر", tr: "maṭar", g: "rain" },
      final: { ar: "وَسَط", tr: "wasaṭ", g: "middle" }
    },
    d: "Heavy t: say t with the tongue root pulled back toward the throat. A following a moves toward the a of father."
  },
  {
    ch: "ض", slug: "dad", name: "ḍād", ipa: "dˤ",
    place: "alv", manner: "stop", voiced: true, emph: true, sun: true, abjad: 14,
    forms: joins("ض"), syl: "ضَا",
    ex: {
      initial: { ar: "ضَيْف", tr: "ḍayf", g: "guest" },
      medial: { ar: "رَمَضَان", tr: "ramaḍān", g: "Ramadan" },
      final: { ar: "أَرْض", tr: "ʾarḍ", g: "earth, land" }
    },
    d: "Heavy d: say d with the tongue root pulled back toward the throat. Arabic is nicknamed luġat aḍ-ḍād, “the language of the ḍād”, because this sound was thought to be unique to it.",
    note: "Early Arabic grammarians described ض as a different sound, probably made with air escaping past the side of the tongue. The standard pronunciation today is a heavy d."
  },
  {
    ch: "س", slug: "sin", name: "sīn", ipa: "s",
    place: "alv", manner: "fricative", voiced: false, emph: false, sun: true, abjad: 11,
    forms: joins("س"), syl: "سَا",
    ex: {
      initial: { ar: "سَيْف", tr: "sayf", g: "sword" },
      medial: { ar: "مَسَاء", tr: "masāʾ", g: "evening" },
      final: { ar: "شَمْس", tr: "šams", g: "sun" }
    },
    d: "Like English s."
  },
  {
    ch: "ز", slug: "zay", name: "zāy", ipa: "z",
    place: "alv", manner: "fricative", voiced: true, emph: false, sun: true, abjad: 10,
    forms: rightOnly("ز"), syl: "زَا",
    ex: {
      initial: { ar: "زَيْت", tr: "zayt", g: "oil" },
      medial: { ar: "مَنْزِل", tr: "manzil", g: "house, home" },
      final: { ar: "مَوْز", tr: "mawz", g: "bananas" }
    },
    d: "Like English z."
  },
  {
    ch: "ص", slug: "sad", name: "ṣād", ipa: "sˤ",
    place: "alv", manner: "fricative", voiced: false, emph: true, sun: true, abjad: 13,
    forms: joins("ص"), syl: "صَا",
    ex: {
      initial: { ar: "صَيْف", tr: "ṣayf", g: "summer" },
      medial: { ar: "بَصَل", tr: "baṣal", g: "onions" },
      final: { ar: "قَمِيص", tr: "qamīṣ", g: "shirt" }
    },
    d: "Heavy s: the hiss of س with the tongue root pulled back toward the throat. Most of the difference is heard in the darker vowels around it."
  },
  {
    ch: "ن", slug: "nun", name: "nūn", ipa: "n",
    place: "alv", manner: "nasal", voiced: true, emph: false, sun: true, abjad: 24,
    forms: joins("ن"), syl: "نَا",
    ex: {
      initial: { ar: "نُور", tr: "nūr", g: "light" },
      medial: { ar: "عِنَب", tr: "ʿinab", g: "grapes" },
      final: { ar: "لِسَان", tr: "lisān", g: "tongue" }
    },
    d: "Like English n."
  },
  {
    ch: "ل", slug: "lam", name: "lām", ipa: "l",
    place: "alv", manner: "lateral", voiced: true, emph: false, sun: true, abjad: 22,
    forms: joins("ل"), syl: "لَا",
    ex: {
      initial: { ar: "لَوْن", tr: "lawn", g: "color" },
      medial: { ar: "قَلَم", tr: "qalam", g: "pen" },
      final: { ar: "جَبَل", tr: "jabal", g: "mountain" }
    },
    d: "A clear l, as in English leaf, not the darker l at the end of full. The main exception is the word Allāh, whose l is dark after a or u."
  },
  {
    ch: "ر", slug: "ra", name: "rāʾ", ipa: "r",
    place: "alv", manner: "trill", voiced: true, emph: false, sun: true, abjad: 9,
    forms: rightOnly("ر"), syl: "رَا",
    ex: {
      initial: { ar: "رَمْل", tr: "raml", g: "sand" },
      medial: { ar: "مَرِيض", tr: "marīḍ", g: "sick" },
      final: { ar: "قَمَر", tr: "qamar", g: "moon" }
    },
    d: "A tapped r, like the r of Spanish pero: one quick flick of the tongue tip. Doubled, as in darrasa, it becomes a rolled r, like Spanish perro. It is never the English r."
  },

  // Hard palate
  {
    ch: "ج", slug: "jim", name: "jīm", ipa: "dʒ",
    place: "pal", manner: "affricate", voiced: true, emph: false, sun: false, abjad: 4,
    forms: joins("ج"), syl: "جَا",
    ex: {
      initial: { ar: "جَمَل", tr: "jamal", g: "camel" },
      medial: { ar: "رَجُل", tr: "rajul", g: "man" },
      final: { ar: "زَوْج", tr: "zawj", g: "husband" }
    },
    d: "In standard Arabic usually the j of jam. It varies by region: many speakers in the Levant and North Africa say the s of measure, and many Egyptians say g.",
    note: "Like English j, ج is made with the tongue blade just behind the gum ridge (postalveolar) rather than at the hard palate itself. It is grouped here with ش and ي, as Arabic grammarians traditionally group them."
  },
  {
    ch: "ش", slug: "shin", name: "šīn", ipa: "ʃ",
    place: "pal", manner: "fricative", voiced: false, emph: false, sun: true, abjad: 12,
    forms: joins("ش"), syl: "شَا",
    ex: {
      initial: { ar: "شَمْس", tr: "šams", g: "sun" },
      medial: { ar: "عَشَاء", tr: "ʿašāʾ", g: "dinner" },
      final: { ar: "جَيْش", tr: "jayš", g: "army" }
    },
    d: "The sh of ship.",
    note: "Like English sh, ش is made with the tongue blade just behind the gum ridge (postalveolar) rather than at the hard palate itself. It is grouped here with ج and ي, as Arabic grammarians traditionally group them."
  },
  {
    ch: "ي", slug: "ya", name: "yāʾ", ipa: "j",
    place: "pal", manner: "approximant", voiced: true, emph: false, sun: false, abjad: 27,
    forms: joins("ي"), syl: "يَا",
    ex: {
      initial: { ar: "يَد", tr: "yad", g: "hand" },
      medial: { ar: "حَيَوَان", tr: "ḥayawān", g: "animal" },
      final: { ar: "شَاي", tr: "šāy", g: "tea" }
    },
    d: "The y of yes. The same letter also writes the long vowel ī. Its IPA symbol is /j/."
  },

  // Soft palate
  {
    ch: "ك", slug: "kaf", name: "kāf", ipa: "k",
    place: "vel", manner: "stop", voiced: false, emph: false, sun: false, abjad: 21,
    forms: joins("ك"), syl: "كَا",
    ex: {
      initial: { ar: "كَلْب", tr: "kalb", g: "dog" },
      medial: { ar: "مَكَان", tr: "makān", g: "place" },
      final: { ar: "سَمَك", tr: "samak", g: "fish" }
    },
    d: "Like English k."
  },

  // Uvula
  {
    ch: "ق", slug: "qaf", name: "qāf", ipa: "q",
    place: "uvu", manner: "stop", voiced: false, emph: false, sun: false, abjad: 20,
    forms: joins("ق"), syl: "قَا",
    ex: {
      initial: { ar: "قَلْب", tr: "qalb", g: "heart" },
      medial: { ar: "فَقِير", tr: "faqīr", g: "poor" },
      final: { ar: "سُوق", tr: "sūq", g: "market" }
    },
    d: "Like k but further back: the very back of the tongue closes against the uvula. It sounds hollower than ك, and a following a is pulled back toward the a of father."
  },
  {
    ch: "خ", slug: "kha", name: "ḫāʾ", ipa: "χ",
    place: "uvu", manner: "fricative", voiced: false, emph: false, sun: false, abjad: 6,
    forms: joins("خ"), syl: "خَا",
    ex: {
      initial: { ar: "خُبْز", tr: "ḫubz", g: "bread" },
      medial: { ar: "أُخْت", tr: "ʾuḫt", g: "sister" },
      final: { ar: "مَطْبَخ", tr: "maṭbaḫ", g: "kitchen" }
    },
    d: "The ch of Scottish loch or German Bach: a rough, scraping sound at the back of the mouth, made with breath alone.",
    note: "Books place خ either at the soft palate, written /x/, or at the uvula, written /χ/, and speakers vary. It is grouped here with ق at the uvula."
  },
  {
    ch: "غ", slug: "ghayn", name: "ġayn", ipa: "ʁ",
    place: "uvu", manner: "fricative", voiced: true, emph: false, sun: false, abjad: 18,
    forms: joins("غ"), syl: "غَا",
    ex: {
      initial: { ar: "غَرْب", tr: "ġarb", g: "west" },
      medial: { ar: "صَغِير", tr: "ṣaġīr", g: "small" },
      final: { ar: "دِمَاغ", tr: "dimāġ", g: "brain" }
    },
    d: "خ with a hum added: a soft gargle, close to the r of French or German.",
    note: "Like خ, غ is placed either at the soft palate, written /ɣ/, or at the uvula, written /ʁ/, and speakers vary. It is grouped here with ق at the uvula."
  },

  // Pharynx
  {
    ch: "ح", slug: "hha", name: "ḥāʾ", ipa: "ħ",
    place: "pha", manner: "fricative", voiced: false, emph: false, sun: false, abjad: 5,
    forms: joins("ح"), syl: "حَا",
    ex: {
      initial: { ar: "حَلِيب", tr: "ḥalīb", g: "milk" },
      medial: { ar: "لَحْم", tr: "laḥm", g: "meat" },
      final: { ar: "رِيح", tr: "rīḥ", g: "wind" }
    },
    d: "A strong, breathy h made by narrowing the throat. It has no scrape, which sets it apart from خ, and no hum, which sets it apart from ع."
  },
  {
    ch: "ع", slug: "ayn", name: "ʿayn", ipa: "ʕ",
    place: "pha", manner: "fricative", voiced: true, emph: false, sun: false, abjad: 17,
    forms: joins("ع"), syl: "عَا",
    ex: {
      initial: { ar: "عَيْن", tr: "ʿayn", g: "eye" },
      medial: { ar: "سَعِيد", tr: "saʿīd", g: "happy" },
      final: { ar: "شَارِع", tr: "šāriʿ", g: "street" }
    },
    d: "Narrow the throat as for ح, but hum as you do it. It is usually smooth, with no scrape, and can sound like a tight, strained vowel."
  },

  // Glottis
  {
    ch: "ء", slug: "hamza", name: "hamza", ipa: "ʔ",
    place: "glo", manner: "stop", voiced: false, emph: false, sun: false, abjad: 0,
    forms: { isolated: "ء", initial: "ء", medial: "ء", final: "ء" }, syl: "آ",
    // Hamza doesn't change shape by position; it sits on a seat chosen by the vowels around it.
    seats: [
      { ar: "أ", label: "On alif" }, { ar: "ؤ", label: "On wāw" },
      { ar: "ئ", label: "On yāʾ" }, { ar: "ء", label: "On the line" }
    ],
    ex: {
      initial: { ar: "أَسَد", tr: "ʾasad", g: "lion" },
      medial: { ar: "سُؤَال", tr: "suʾāl", g: "question" },
      final: { ar: "شَيْء", tr: "šayʾ", g: "thing" }
    },
    d: "The catch in the middle of English uh-oh: the voice box shuts for an instant, then lets go. In Arabic it is a full consonant that can begin, sit inside or end a word.",
    seatsNote: "Hamza rides on ا, و or ي, or stands alone on the line; the vowels around it decide which.",
    note: "At the start of a word hamza always rides on alif (أ إ). Inside a word it usually rides on one of أ ؤ ئ, and that carrier letter is not pronounced. " +
      "It stands on its own (ء) mostly at the end of a word, as in šayʾ. Its syllable is spelled آ, hamza followed by a long ā."
  },
  {
    ch: "ه", slug: "ha", name: "hāʾ", ipa: "h",
    place: "glo", manner: "fricative", voiced: false, emph: false, sun: false, abjad: 25,
    forms: joins("ه"), syl: "هَا",
    ex: {
      initial: { ar: "هَوَاء", tr: "hawāʾ", g: "air" },
      medial: { ar: "نَهَار", tr: "nahār", g: "daytime" },
      final: { ar: "وَجْه", tr: "wajh", g: "face" }
    },
    d: "Like English h, but Arabic also has it at the end of a syllable or word, as in wajh “face” and šahr “month”, where English never does."
  }
];

// Contrast pairs. `letters` are the contrasted consonant letters, [] for
// pure vowel-length pairs. Verbs are given in their usual citation form.
export const PAIRS = {
  "s-ss": {
    label: "س vs ص", letters: ["س", "ص"],
    a: { ar: "سَيْف", tr: "sayf", g: "sword" },
    b: { ar: "صَيْف", tr: "ṣayf", g: "summer" },
    n: "The hiss is almost the same, a little duller for ص. Listen mainly for the darker vowel after ص."
  },
  "t-tt": {
    label: "ت vs ط", letters: ["ت", "ط"],
    a: { ar: "تِين", tr: "tīn", g: "figs" },
    b: { ar: "طِين", tr: "ṭīn", g: "mud" },
    n: "The ī after ط starts further back, so ṭīn sounds darker than tīn. The difference is in the quality of the vowel, not its pitch."
  },
  "d-dd": {
    label: "د vs ض", letters: ["د", "ض"],
    a: { ar: "دَلَّ", tr: "dalla", g: "he guided" },
    b: { ar: "ضَلَّ", tr: "ḍalla", g: "he went astray" },
    n: "The a after ض moves back toward the a of father."
  },
  "dh-zz": {
    label: "ذ vs ظ", letters: ["ذ", "ظ"],
    a: { ar: "ذَلَّ", tr: "ḏalla", g: "he was humbled" },
    b: { ar: "ظَلَّ", tr: "ẓalla", g: "he remained" },
    n: "Both put the tongue tip at the teeth. ظ adds the pulled-back tongue root, which darkens the a."
  },
  "s-th": {
    label: "س vs ث", letters: ["س", "ث"],
    a: { ar: "سَارَ", tr: "sāra", g: "he walked" },
    b: { ar: "ثَارَ", tr: "ṯāra", g: "he revolted" },
    n: "ث puts the tongue tip between the teeth, like the th of thin."
  },
  "z-dh": {
    label: "ز vs ذ", letters: ["ز", "ذ"],
    a: { ar: "زَلَّ", tr: "zalla", g: "he slipped" },
    b: { ar: "ذَلَّ", tr: "ḏalla", g: "he was humbled" },
    n: "ذ is the th of this."
  },
  "k-q": {
    label: "ك vs ق", letters: ["ك", "ق"],
    a: { ar: "كَلْب", tr: "kalb", g: "dog" },
    b: { ar: "قَلْب", tr: "qalb", g: "heart" },
    n: "ق is made at the uvula, further back than English k, and the a after it sounds darker."
  },
  "k-kh": {
    label: "ك vs خ", letters: ["ك", "خ"],
    a: { ar: "كَبِير", tr: "kabīr", g: "big" },
    b: { ar: "خَبِير", tr: "ḫabīr", g: "expert" },
    n: "ك blocks the air. خ never closes: air scrapes through a narrow gap further back."
  },
  "hh-kh": {
    label: "ح vs خ", letters: ["ح", "خ"],
    a: { ar: "حَال", tr: "ḥāl", g: "state, condition" },
    b: { ar: "خَال", tr: "ḫāl", g: "maternal uncle" },
    n: "ح is a smooth, tense breath from the throat. خ has a rough scrape higher up, at the back of the mouth."
  },
  "h-hh": {
    label: "ه vs ح", letters: ["ه", "ح"],
    a: { ar: "هَزَمَ", tr: "hazama", g: "he defeated" },
    b: { ar: "حَزَمَ", tr: "ḥazama", g: "he tied up, packed" },
    n: "ه is a light, relaxed breath. ح is pushed through a narrowed throat."
  },
  "hh-ain": {
    label: "ح vs ع", letters: ["ح", "ع"],
    a: { ar: "حَمَل", tr: "ḥamal", g: "lamb" },
    b: { ar: "عَمَل", tr: "ʿamal", g: "work" },
    n: "Both are made in the throat. ح is breath alone; ع has a hum in it."
  },
  "a-ain": {
    label: "ء vs ع", letters: ["ء", "ع"],
    a: { ar: "أَلَم", tr: "ʾalam", g: "pain" },
    b: { ar: "عَلَم", tr: "ʿalam", g: "flag" },
    n: "ء is a clean catch in the voice box. ع squeezes the throat and colors the vowel."
  },
  "ain-gh": {
    label: "ع vs غ", letters: ["ع", "غ"],
    a: { ar: "عَار", tr: "ʿār", g: "shame" },
    b: { ar: "غَار", tr: "ġār", g: "cave" },
    n: "ع is made low in the throat, smooth, with little or no scrape. غ is a gargle further up, at the back of the mouth."
  },
  "r-gh": {
    label: "ر vs غ", letters: ["ر", "غ"],
    a: { ar: "رَيْب", tr: "rayb", g: "doubt" },
    b: { ar: "غَيْب", tr: "ġayb", g: "the unseen" },
    n: "ر is a tap of the tongue tip. غ is made far back, close to a French or German r, so speakers of those languages should keep that r out of ر."
  },
  "len1": {
    label: "a vs ā, first syllable", letters: [],
    a: { ar: "كَتَبَ", tr: "kataba", g: "he wrote" },
    b: { ar: "كَاتَبَ", tr: "kātaba", g: "he corresponded with" },
    n: "The only difference is the held vowel in the first syllable."
  },
  "len2": {
    label: "a vs ā, second syllable", letters: [],
    a: { ar: "جَمَل", tr: "jamal", g: "camel" },
    b: { ar: "جَمَال", tr: "jamāl", g: "beauty" },
    n: "Long vowels are held clearly longer, often about twice as long, and they often attract the stress."
  },
  "len-i": {
    label: "i vs ī", letters: [],
    a: { ar: "رَحِم", tr: "raḥim", g: "womb" },
    b: { ar: "رَحِيم", tr: "raḥīm", g: "merciful" },
    n: "Hold the i of raḥīm. The stress also moves onto the long vowel."
  },
  "len-u": {
    label: "u vs ū", letters: [],
    a: { ar: "عُدْ", tr: "ʿud", g: "come back" },
    b: { ar: "عُود", tr: "ʿūd", g: "oud (lute)" },
    n: "ʿud is a command, “come back”. ʿūd, the lute, holds the same vowel for longer."
  },
  "gem": {
    label: "Single vs doubled r", letters: ["ر"],
    a: { ar: "دَرَسَ", tr: "darasa", g: "he studied" },
    b: { ar: "دَرَّسَ", tr: "darrasa", g: "he taught" },
    n: "A doubled consonant is held longer, and a doubled r is rolled. Here it turns “study” into “teach”."
  },
  "gem2": {
    label: "Single vs doubled m", letters: ["م"],
    a: { ar: "حَمَام", tr: "ḥamām", g: "pigeons" },
    b: { ar: "حَمَّام", tr: "ḥammām", g: "bathroom" },
    n: "Hold the m of ḥammām. The doubling is the only difference in sound."
  },
  "gem3": {
    label: "Single vs doubled s", letters: ["س"],
    a: { ar: "كَسَرَ", tr: "kasara", g: "he broke" },
    b: { ar: "كَسَّرَ", tr: "kassara", g: "he smashed" },
    n: "Doubling the middle consonant of a verb often makes the action stronger or repeated."
  }
};

export const GROUPS = [
  { id: "emphatic", title: "Plain vs emphatic", ids: ["s-ss", "t-tt", "d-dd", "dh-zz"] },
  { id: "back", title: "Back of the mouth and throat", ids: ["k-q", "k-kh", "hh-kh", "h-hh", "hh-ain", "a-ain", "ain-gh", "r-gh"] },
  { id: "teeth", title: "Between the teeth", ids: ["s-th", "z-dh"] },
  { id: "length", title: "Short vs long vowels", ids: ["len1", "len2", "len-i", "len-u"] },
  { id: "doubling", title: "Single vs doubled consonants", ids: ["gem", "gem2", "gem3"] }
];

// `ipa` without slashes, as in C.
export const VOWELS = [
  {
    id: "a", ipa: "a", label: "short a", spell: "بَ", mark: "fatha", ar: "جَبَل", tr: "jabal", g: "mountain",
    desc: "Close to the a of cat; next to ص ض ط ظ ق خ غ, and usually ر, it moves back toward the a of father. It is written as a small slanted stroke above the letter, called fatḥa."
  },
  {
    id: "aa", ipa: "aː", label: "long ā", spell: "بَا", ar: "بَاب", tr: "bāb", g: "door",
    desc: "The same vowel as short a, held about twice as long; it often takes the stress. It is written as the short-a stroke followed by the letter alif (ا)."
  },
  {
    id: "i", ipa: "i", label: "short i", spell: "بِ", mark: "kasra", ar: "بِنْت", tr: "bint", g: "girl",
    desc: "Close to the i of bit. It is written as a small slanted stroke below the letter, called kasra."
  },
  {
    id: "ii", ipa: "iː", label: "long ī", spell: "بِي", ar: "فِيل", tr: "fīl", g: "elephant",
    desc: "Like the ee of see, held long. It is written as the short-i stroke followed by the letter yāʾ (ي)."
  },
  {
    id: "u", ipa: "u", label: "short u", spell: "بُ", mark: "damma", ar: "كُتُب", tr: "kutub", g: "books",
    desc: "Close to the u of put. It is written as a small curl above the letter, like a tiny و, called ḍamma."
  },
  {
    id: "uu", ipa: "uː", label: "long ū", spell: "بُو", ar: "نُور", tr: "nūr", g: "light",
    desc: "Like the oo of food, held long. It is written as the short-u curl followed by the letter wāw (و)."
  },
  {
    id: "ay", ipa: "aj", label: "diphthong ay", spell: "بَيْ", ar: "بَيْت", tr: "bayt", g: "house",
    desc: "Close to English eye; in most dialects it becomes a long e. It is written as the short-a stroke, then the letter yāʾ (ي) with a small circle above it that means “no vowel”."
  },
  {
    id: "aw", ipa: "aw", label: "diphthong aw", spell: "بَوْ", ar: "يَوْم", tr: "yawm", g: "day",
    desc: "Close to the ow of how; in most dialects it becomes a long o. It is written as the short-a stroke, then the letter wāw (و) with a small circle above it that means “no vowel”."
  }
];

export const VCOLOR = [
  {
    id: "vc-s", label: "ā after س and ص", letters: ["س", "ص"],
    a: { ar: "سَارَ", tr: "sāra", g: "he walked" },
    b: { ar: "صَارَ", tr: "ṣāra", g: "he became" },
    n: "After س the long a is bright, toward the a of cat. After ص it is pulled back, toward the a of father."
  },
  {
    id: "vc-t", label: "ā after ت and ط", letters: ["ت", "ط"],
    a: { ar: "تَابَ", tr: "tāba", g: "he repented" },
    b: { ar: "طَابَ", tr: "ṭāba", g: "it was pleasant" },
    n: "ط is the heavy version of ت, and most of what you hear is the change in the vowel."
  }
];

// `mark` is the sign shown on a carrier letter.
export const MARKS = [
  {
    id: "fatha", name: "fatḥa", mark: "بَ", sound: "short a",
    desc: "A short slanted stroke above the letter: the consonant is followed by a short a.",
    ex: { ar: "كَتَبَ", tr: "kataba", g: "he wrote" }
  },
  {
    id: "kasra", name: "kasra", mark: "بِ", sound: "short i",
    desc: "The same stroke below the letter: a short i.",
    ex: { ar: "بِنْت", tr: "bint", g: "girl" }
  },
  {
    id: "damma", name: "ḍamma", mark: "بُ", sound: "short u",
    desc: "A small curl shaped like a tiny و above the letter: a short u.",
    ex: { ar: "كُتُب", tr: "kutub", g: "books" }
  },
  {
    id: "sukun", name: "sukūn", mark: "بْ", sound: "no vowel",
    desc: "A small circle above the letter: no vowel follows, so the consonant closes the syllable, as the l does in qalb. " +
      "Most words on this page are shown as they sound when said on their own, so no vowel or sukūn is written on their last letter. " +
      "Verbs are given in their dictionary form instead, which ends in a vowel (kataba, “he wrote”), and the command ʿud, “come back”, ends in a written sukūn.",
    ex: { ar: "قَلْب", tr: "qalb", g: "heart" }
  },
  {
    id: "shadda", name: "šadda", mark: "بّ", sound: "doubled consonant",
    desc: "A small sign like a w above the letter: the consonant is doubled, that is, held longer. The vowel mark is written together with it.",
    ex: { ar: "دَرَّسَ", tr: "darrasa", g: "he taught" }
  },
  {
    id: "tanwin", name: "tanwīn", mark: "بٌ", sound: "-un, -in, -an",
    desc: "A doubled vowel mark on the last letter adds an n: -un, -in or -an. It usually marks a noun as indefinite. At the end of a phrase -un and -in are dropped and -an becomes -ā, so the other words on this page are shown without it.",
    ex: { ar: "كِتَابٌ", tr: "kitābun", g: "a book" }
  },
  {
    id: "madda", name: "madda", mark: "آ", sound: "ʾā",
    desc: "A wavy line over alif. It stands for a hamza followed by a long ā, in place of writing two alifs in a row.",
    ex: { ar: "آخِر", tr: "ʾāḫir", g: "last" }
  },
  {
    id: "hamza-alif", name: "hamza on alif", mark: "أ", sound: "ʾ",
    desc: "Hamza usually sits on a seat letter, which is not pronounced. At the start of a word the seat is alif: above it (أ) before a or u, below it (إ) before i.",
    ex: { ar: "أَسَد", tr: "ʾasad", g: "lion" }
  },
  {
    id: "hamza-waw", name: "hamza on wāw", mark: "ؤ", sound: "ʾ",
    desc: "Inside a word the seat depends on the vowels around the hamza. Next to u, unless there is an i, it sits on wāw.",
    ex: { ar: "سُؤَال", tr: "suʾāl", g: "question" }
  },
  {
    id: "hamza-ya", name: "hamza on yāʾ", mark: "ئ", sound: "ʾ",
    desc: "Next to i it sits on a yāʾ written without dots.",
    ex: { ar: "رَئِيس", tr: "raʾīs", g: "president, head" }
  },
  {
    id: "hamza-line", name: "hamza on the line", mark: "ء", sound: "ʾ",
    desc: "At the end of a word after a long vowel or a consonant, and in a few other places, hamza stands on its own.",
    ex: { ar: "مَاء", tr: "māʾ", g: "water" }
  }
];

export const SUN_MOON = {
  sun: ["ت", "ث", "د", "ذ", "ر", "ز", "س", "ش", "ص", "ض", "ط", "ظ", "ل", "ن"],
  moon: ["ء", "ب", "ج", "ح", "خ", "ع", "غ", "ف", "ق", "ك", "م", "ه", "و", "ي"],
  // `rule` says why the split falls where it does (COPY.sunMoonIntro already
  // says what happens to the l); `sunHint` and `moonHint` are the one-line
  // column hints; `exception` is the note shown next to the flagged ج.
  rule:
    "The 14 sun letters are all made with the tongue tip or blade, from the teeth to just behind the gum ridge: ت ث د ذ ر ز س ش ص ض ط ظ ل ن. " +
    "The l of al- is made with the tongue tip too, which is why it merges into them. " +
    "The 14 moon letters are the four lip consonants, ي, the eight consonants from the soft palate back to the glottis, and ج.",
  sunHint: "The l merges into the next letter, which is doubled: aš-šams.",
  moonHint: "The l is pronounced: al-qamar.",
  // Shown after an "exception" flag, so it does not start with that word.
  exception:
    "Today ج is made with the tongue blade, close to ش, yet it is a moon letter, so the l of al-jamal is pronounced. " +
    "When the rule took shape it was probably a stop made further back, like g or a palatal /ɟ/, not a tongue-tip or blade sound.",
  examples: [
    {
      id: "sm-sh", label: "ش (sun) vs ق (moon)", letters: ["ش", "ق"],
      a: { ar: "الشَّمْس", tr: "aš-šams", g: "the sun" },
      b: { ar: "الْقَمَر", tr: "al-qamar", g: "the moon" },
      n: "In aš-šams the l disappears into ش, which is doubled. ق is a moon letter, so the l of al-qamar is pronounced."
    },
    {
      id: "sm-n", label: "ن (sun) vs ب (moon)", letters: ["ن", "ب"],
      a: { ar: "النُّور", tr: "an-nūr", g: "the light" },
      b: { ar: "الْبَيْت", tr: "al-bayt", g: "the house" },
      n: "In an-nūr the l becomes n. ب is made with the lips, so the l of al-bayt stays."
    },
    {
      id: "sm-d", label: "د (sun) vs ك (moon)", letters: ["د", "ك"],
      a: { ar: "الدَّار", tr: "ad-dār", g: "the home" },
      b: { ar: "الْكَلْب", tr: "al-kalb", g: "the dog" },
      n: "The doubled d of ad-dār is held, like any doubled consonant."
    },
    {
      id: "sm-j", label: "ر (sun) vs ج (moon)", letters: ["ر", "ج"],
      a: { ar: "الرَّجُل", tr: "ar-rajul", g: "the man" },
      b: { ar: "الْجَمَل", tr: "al-jamal", g: "the camel" },
      n: "ج is made close to ش, yet the l of al-jamal is pronounced. In ar-rajul it merges into ر."
    }
  ]
};

// Typical urban forms, IPA only. rows[].ar is the MSA word (playable).
export const DIALECTS = {
  note:
    "These are typical urban forms, simplified for comparison; real usage varies with the speaker, the setting and the word. " +
    "Educated speakers often keep the standard sound in formal or learned words, and in such words Cairo and Levantine speakers often say /s z zˤ/ for ث ذ ظ. " +
    "In the Gulf and Iraq, k becomes /tʃ/ only in some words, mostly next to front vowels, and Gulf ج varies between /dʒ/ and /j/; a tilde (~) separates common variants. " +
    "Moroccan Arabic drops or reduces many short vowels and does not distinguish long from short vowels. " +
    "The Baghdad forms are those of Muslim Baghdadi speech; Christian and Jewish Baghdadi and northern Iraqi (e.g. Mosul) speech keep /q/ and /k/ in these words. " +
    "Each column shows how that region pronounces the same word, but for some meanings another word is more usual there: for “shade”, Beirut, Damascus and Baghdad often say /fajj/.",
  columns: [
    { id: "msa", name: "Standard", region: "Modern Standard Arabic" },
    { id: "cairo", name: "Cairo", region: "Egypt" },
    { id: "levant", name: "Beirut / Damascus", region: "Lebanon, Syria" },
    { id: "gulf", name: "Gulf", region: "e.g. Kuwait" },
    { id: "iraq", name: "Baghdad", region: "Iraq" },
    { id: "maghreb", name: "Casablanca", region: "Morocco" }
  ],
  rows: [
    {
      id: "q", ar: "قَهْوَة", tr: "qahwa", g: "coffee",
      forms: { msa: "/qahwa/", cairo: "/ʔahwa/", levant: "/ʔahwe/", gulf: "/gahwa/", iraq: "/gahwa/", maghreb: "/qəhwa/" }
    },
    {
      id: "j", ar: "جَار", tr: "jār", g: "neighbor",
      forms: { msa: "/dʒaːr/", cairo: "/gaːr/", levant: "/ʒaːr/", gulf: "/dʒaːr/ ~ /jaːr/", iraq: "/dʒaːr/", maghreb: "/ʒar/" }
    },
    {
      id: "th", ar: "ثَقِيل", tr: "ṯaqīl", g: "heavy",
      forms: { msa: "/θaqiːl/", cairo: "/tiʔiːl/", levant: "/tʔiːl/", gulf: "/θigiːl/", iraq: "/θigiːl/", maghreb: "/tqil/" }
    },
    {
      id: "dh", ar: "ذَهَب", tr: "ḏahab", g: "gold",
      forms: { msa: "/ðahab/", cairo: "/dahab/", levant: "/dahab/", gulf: "/ðahab/", iraq: "/ðahab/", maghreb: "/dhəb/" }
    },
    {
      id: "zz", ar: "ظِلّ", tr: "ẓill", g: "shade",
      forms: { msa: "/ðˤill/", cairo: "/dˤill/", levant: "/dˤill/", gulf: "/ðˤill/", iraq: "/ðˤill/", maghreb: "/dˤəll/" }
    },
    {
      id: "dd", ar: "أَبْيَض", tr: "ʾabyaḍ", g: "white",
      forms: { msa: "/ʔabjadˤ/", cairo: "/ʔabjadˤ/", levant: "/ʔabjadˤ/", gulf: "/ʔabjaðˤ/", iraq: "/ʔabjaðˤ/", maghreb: "/bjədˤ/" }
    },
    {
      id: "ay", ar: "زَيْت", tr: "zayt", g: "oil",
      forms: { msa: "/zajt/", cairo: "/zeːt/", levant: "/zeːt/", gulf: "/zeːt/", iraq: "/zeːt/", maghreb: "/zit/" }
    },
    {
      id: "aw", ar: "لَوْن", tr: "lawn", g: "color",
      forms: { msa: "/lawn/", cairo: "/loːn/", levant: "/loːn/", gulf: "/loːn/", iraq: "/loːn/", maghreb: "/lun/" }
    },
    {
      id: "k", ar: "كَبِير", tr: "kabīr", g: "big",
      forms: { msa: "/kabiːr/", cairo: "/kibiːr/", levant: "/kbiːr/", gulf: "/tʃibiːr/", iraq: "/tʃibiːr/", maghreb: "/kbir/" }
    }
  ]
};

export const SOURCES = [
  { text: "Robin Thelwall and M. Akram Sa'adeddin (1990). Arabic. Journal of the International Phonetic Association 20(2), Illustrations of the IPA." },
  { text: "Janet C. E. Watson (2002). The Phonology and Morphology of Arabic. Oxford University Press." },
  { text: "Karin C. Ryding (2005). A Reference Grammar of Modern Standard Arabic. Cambridge University Press." },
  { text: "Wikipedia: Arabic phonology", url: "https://en.wikipedia.org/wiki/Arabic_phonology" },
  { text: "Wikipedia: Varieties of Arabic", url: "https://en.wikipedia.org/wiki/Varieties_of_Arabic" },
  { text: "Forvo: Arabic pronunciations recorded by native speakers", url: "https://forvo.com/languages/ar/" }
];

// Every visible prose claim, so it can be fact-checked in one place.
export const COPY = {
  intro:
    "Train your ear for the sounds of Modern Standard Arabic that English doesn't have. " +
    "The audio is synthetic speech from ElevenLabs in two voices, not recordings of people.",
  consonantsIntro:
    "Arabic has 28 consonants, arranged here from the lips to the throat. " +
    "Tap a letter to hear it at the start of a word.",
  // Shown with readingNote in the closed-by-default "How to read this chart" box.
  consonantsMore:
    "In the By place view the rows run from the lips at the top to the throat at the bottom, the same order as the mouth diagram from left to right. " +
    "Five consonants, ق خ غ ح ع, are made at the uvula or in the pharynx, places most English accents never use; ه and ء, at the glottis, match English h and the catch in uh-oh.",
  readingNote:
    "Words are spelled in Latin letters with one symbol per Arabic letter, so ṭ, ḫ and ʿ each stand for a single sound, and a line over a vowel (ā) means it is long. " +
    "Symbols between slashes, such as /ʕ/, are the International Phonetic Alphabet (IPA), which shows the sound itself: ي, for example, is y in the spelling but /j/ in IPA.",
  emphaticLegend:
    "Emphatic: ص ض ط ظ are said with the tongue root pulled back toward the throat, which makes nearby vowels sound darker, more like the a of father than the a of cat.",
  pairsIntro:
    "Each card is a minimal pair: two words that differ in a single sound, or only in the length of a vowel or consonant. " +
    "Play both and listen for that one difference.",
  quizIntro:
    "Hear one word from a pair and pick the one you heard. " +
    "Choose a category, or mix the two voices for a harder test.",
  vowelsIntro:
    "Arabic has three vowel qualities, a, i and u, each short or long, plus the diphthongs ay and aw. " +
    "Long vowels are held clearly longer, often about twice as long. " +
    "Everyday writing leaves out the short vowels, so readers rely on knowing the word.",
  vowelColorTitle: "How consonants color vowels",
  vowelColorIntro:
    "Next to the emphatic consonants ص ض ط ظ, and also next to ق خ غ and usually ر, the vowel a is pulled back toward the a of father. " +
    "Next to most other consonants it is brighter, closer to the a of cat. " +
    "The pitch does not change, only the quality of the vowel.",
  marksIntro:
    "Short vowels and a few other details are written as small marks above or below the letters. " +
    "Everyday texts leave most of them out; this page shows them all so every word can be read exactly.",
  sunMoonIntro:
    "The article al- (ال), meaning “the”, is always spelled the same, but its l is pronounced only before the 14 moon letters. " +
    "Before the 14 sun letters it merges into the next consonant, which is doubled: al-qamar “the moon”, but aš-šams “the sun”. " +
    "Tap a letter to open it in the letter chart.",
  dialectsIntro:
    "Everything else on this page is Modern Standard Arabic. " +
    "Everyday speech differs by region: some consonants, vowels and diphthongs change in largely predictable ways, with exceptions. " +
    "Tap a word to hear the standard form; the other columns are written in IPA.",
  audioNote:
    "All audio is synthetic speech made with ElevenLabs, using the Eleven v4 model and two voices from the ElevenLabs Voice Library, Chaouki (male) and Asmaa (female). " +
    "Slow clips are the same audio, time-stretched in advance to three-quarter speed with the pitch kept. " +
    "Isolated syllables can sound unnatural, and none of the clips has been checked by a fluent Arabic speaker. " +
    "Recordings of real speakers, such as those on Forvo, remain the best reference.",
  syllableNote:
    "The consonant plus a long ā, said on its own, so it may sound less natural than the words.",
  recorderNote:
    "Your recording stays on this device. It is not uploaded or saved."
};

// Every playable Arabic string, NFC, unique, in page order.
export function playableTexts() {
  const out = new Set();
  const add = s => out.add(String(s).normalize("NFC").trim());
  for (const c of C) {
    add(c.syl);
    add(c.ex.initial.ar);
    add(c.ex.medial.ar);
    add(c.ex.final.ar);
  }
  for (const p of Object.values(PAIRS)) { add(p.a.ar); add(p.b.ar); }
  for (const v of VOWELS) add(v.ar);
  for (const p of VCOLOR) { add(p.a.ar); add(p.b.ar); }
  for (const m of MARKS) add(m.ex.ar);
  for (const p of SUN_MOON.examples) { add(p.a.ar); add(p.b.ar); }
  for (const r of DIALECTS.rows) add(r.ar);
  return [...out];
}
