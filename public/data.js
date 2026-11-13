// Everything the page teaches, shared by the page (index.html) and the
// clip generator (scripts/generate-audio.mjs). Every Arabic string that
// can be played gets its own ElevenLabs clip, so change it here and run
// `npm run audio` to voice anything new.

export const PLACES = [
  { id: "lab", short: "Lips", name: "Lips", desc: "Both lips, or lower lip on upper teeth" },
  { id: "int", short: "Teeth", name: "Between the teeth", desc: "Tongue tip between the teeth" },
  { id: "alv", short: "Ridge", name: "Teeth and gum ridge", desc: "Tongue tip on the upper teeth or the ridge behind them" },
  { id: "pal", short: "Palate", name: "Hard palate", desc: "Tongue body raised to the roof of the mouth" },
  { id: "vel", short: "Velum", name: "Soft palate", desc: "Back of the tongue on the soft palate" },
  { id: "uvu", short: "Uvula", name: "Uvula", desc: "Very back of the tongue at the uvula" },
  { id: "pha", short: "Pharynx", name: "Pharynx", desc: "Tongue root squeezes the throat walls" },
  { id: "glo", short: "Glottis", name: "Glottis", desc: "The vocal folds in the voice box" }
];

export const C = [
  { ch: "ب", name: "bāʾ", ipa: "b", place: "lab", v: true, syl: "بَا", w: "بَاب", wt: "bāb", g: "door", d: "Like English b. Arabic has no p, so speakers often say b for it in foreign words." },
  { ch: "م", name: "mīm", ipa: "m", place: "lab", v: true, syl: "مَا", w: "مَاء", wt: "māʔ", g: "water", d: "Like English m." },
  { ch: "ف", name: "fāʾ", ipa: "f", place: "lab", v: false, syl: "فَا", w: "فِيل", wt: "fīl", g: "elephant", d: "Like English f. There is no v in native Arabic words." },
  { ch: "و", name: "wāw", ipa: "w", place: "lab", v: true, syl: "وَا", w: "وَلَد", wt: "walad", g: "boy", d: "Like English w. The same letter also writes the long vowel ū." },

  { ch: "ث", name: "thāʾ", ipa: "θ", place: "int", v: false, syl: "ثَا", w: "ثَلْج", wt: "thalj", g: "snow", d: "The th in thin. Tongue tip between the teeth, no voice.", pair: "s-th" },
  { ch: "ذ", name: "dhāl", ipa: "ð", place: "int", v: true, syl: "ذَا", w: "ذَهَب", wt: "dhahab", g: "gold", d: "The th in this. Same position as ث with the voice on.", pair: "z-dh" },
  { ch: "ظ", name: "ẓāʾ", ipa: "ðˤ", place: "int", v: true, emph: true, syl: "ظَا", w: "ظِلّ", wt: "ẓill", g: "shade", d: "The emphatic partner of ذ. Keep the tongue tip between the teeth while pulling the tongue root back toward the throat. The whole syllable sounds deeper.", pair: "dh-zz" },

  { ch: "ت", name: "tāʾ", ipa: "t", place: "alv", v: false, syl: "تَا", w: "تِين", wt: "tīn", g: "figs", d: "Like English t, but with the tongue touching the back of the upper teeth and with less of a puff of air.", pair: "t-tt" },
  { ch: "د", name: "dāl", ipa: "d", place: "alv", v: true, syl: "دَا", w: "دَار", wt: "dār", g: "home", d: "Like English d, made against the back of the upper teeth.", pair: "d-dd" },
  { ch: "ط", name: "ṭāʾ", ipa: "tˤ", place: "alv", v: false, emph: true, syl: "طَا", w: "طِين", wt: "ṭīn", g: "mud", d: "Emphatic t. Say t while hollowing the mouth and pulling the tongue root back. The a after it moves toward the a in father.", pair: "t-tt" },
  { ch: "ض", name: "ḍād", ipa: "dˤ", place: "alv", v: true, emph: true, syl: "ضَا", w: "ضَوْء", wt: "ḍawʔ", g: "light", d: "Emphatic d. Arabic is nicknamed 'the language of ḍād' because grammarians thought this sound was unique to it.", pair: "d-dd" },
  { ch: "س", name: "sīn", ipa: "s", place: "alv", v: false, syl: "سَا", w: "سَيْف", wt: "sayf", g: "sword", d: "Like English s.", pair: "s-ss" },
  { ch: "ص", name: "ṣād", ipa: "sˤ", place: "alv", v: false, emph: true, syl: "صَا", w: "صَيْف", wt: "ṣayf", g: "summer", d: "Emphatic s. The hiss is the same as س. The difference is mostly heard in the darker vowel around it.", pair: "s-ss" },
  { ch: "ز", name: "zāy", ipa: "z", place: "alv", v: true, syl: "زَا", w: "زَيْت", wt: "zayt", g: "oil", d: "Like English z.", pair: "z-dh" },
  { ch: "ن", name: "nūn", ipa: "n", place: "alv", v: true, syl: "نَا", w: "نُور", wt: "nūr", g: "light", d: "Like English n." },
  { ch: "ل", name: "lām", ipa: "l", place: "alv", v: true, syl: "لَا", w: "لَيْل", wt: "layl", g: "night", d: "A clear l, as in leaf rather than the dark l of full. In the word Allah it becomes dark." },
  { ch: "ر", name: "rāʾ", ipa: "r", place: "alv", v: true, syl: "رَا", w: "رَأْس", wt: "raʔs", g: "head", d: "A tapped or trilled r, like Spanish pero or perro. Doubled, it is a full trill." },

  { ch: "ش", name: "shīn", ipa: "ʃ", place: "pal", v: false, syl: "شَا", w: "شَمْس", wt: "shams", g: "sun", d: "The sh in ship." },
  { ch: "ج", name: "jīm", ipa: "dʒ", place: "pal", v: true, syl: "جَا", w: "جَمَل", wt: "jamal", g: "camel", d: "The j in jam in standard Arabic. Cairo says g, and the Levant says the s in measure." },
  { ch: "ي", name: "yāʾ", ipa: "j", place: "pal", v: true, syl: "يَا", w: "يَد", wt: "yad", g: "hand", d: "The y in yes. The same letter also writes the long vowel ī." },

  { ch: "ك", name: "kāf", ipa: "k", place: "vel", v: false, syl: "كَا", w: "كَلْب", wt: "kalb", g: "dog", d: "Like English k, with less of a puff of air.", pair: "k-q" },

  { ch: "ق", name: "qāf", ipa: "q", place: "uvu", v: false, syl: "قَا", w: "قَلْب", wt: "qalb", g: "heart", d: "Like k but further back: the very back of the tongue closes against the uvula. It sounds deeper and more hollow than ك.", pair: "k-q" },
  { ch: "خ", name: "khāʾ", ipa: "χ", place: "uvu", v: false, syl: "خَا", w: "خُبْز", wt: "khubz", g: "bread", d: "The ch of Scottish loch or German Bach. A rough, scraping friction at the back of the mouth.", pair: "hh-kh" },
  { ch: "غ", name: "ghayn", ipa: "ʁ", place: "uvu", v: true, syl: "غَا", w: "غَرْب", wt: "gharb", g: "west", d: "The voiced partner of خ. Close to a French r: a soft gargle with the voice on.", pair: "ain-gh" },

  { ch: "ح", name: "ḥāʾ", ipa: "ħ", place: "pha", v: false, syl: "حَا", w: "حُبّ", wt: "ḥubb", g: "love", d: "A strong, breathy h from the throat. Tighten the throat as if fogging a mirror hard. It has no scrape, which is how it differs from خ.", pair: "h-hh" },
  { ch: "ع", name: "ʿayn", ipa: "ʕ", place: "pha", v: true, syl: "عَا", w: "عَيْن", wt: "ʿayn", g: "eye", d: "The voiced partner of ح. Squeeze the throat with the voice on. It sounds like a tense, strangled vowel. Try saying 'ah' while gently gagging.", pair: "a-ain" },

  { ch: "ء", name: "hamza", ipa: "ʔ", place: "glo", v: false, syl: "أَا", w: "سُؤَال", wt: "suʔāl", g: "question", d: "The catch in the middle of uh-oh. In Arabic it is a full consonant and can appear anywhere in a word.", pair: "a-ain" },
  { ch: "ه", name: "hāʾ", ipa: "h", place: "glo", v: false, syl: "هَا", w: "هَوَاء", wt: "hawāʔ", g: "air", d: "Like English h, but it also occurs at the end of syllables, where English never has it.", pair: "h-hh" }
];

export const PAIRS = {
  "s-ss": { label: "س vs ص", a: ["سَيْف", "sayf", "sword"], b: ["صَيْف", "ṣayf", "summer"], n: "Same hiss. Listen for the darker, further-back vowel after ص." },
  "t-tt": { label: "ت vs ط", a: ["تِين", "tīn", "figs"], b: ["طِين", "ṭīn", "mud"], n: "The emphatic t sounds heavier and lower in pitch." },
  "d-dd": { label: "د vs ض", a: ["دَلَّ", "dalla", "he guided"], b: ["ضَلَّ", "ḍalla", "he went astray"], n: "The a after ض is backed toward the a in father." },
  "dh-zz": { label: "ذ vs ظ", a: ["ذَلَّ", "dhalla", "he was humbled"], b: ["ظَلَّ", "ẓalla", "he remained"], n: "Both start with the tongue between the teeth. ظ adds the pulled-back tongue root." },
  "k-q": { label: "ك vs ق", a: ["كَلْب", "kalb", "dog"], b: ["قَلْب", "qalb", "heart"], n: "ق is made at the uvula, further back than any English stop." },
  "h-hh": { label: "ه vs ح", a: ["هَرَم", "haram", "pyramid"], b: ["حَرَم", "ḥaram", "sanctuary"], n: "ه is a light breath. ح is pushed through a tightened throat." },
  "hh-kh": { label: "ح vs خ", a: ["حَال", "ḥāl", "state"], b: ["خَال", "khāl", "maternal uncle"], n: "ح is a smooth, tense breath. خ has a rough scrape." },
  "a-ain": { label: "ء vs ع", a: ["أَلَم", "ʔalam", "pain"], b: ["عَلَم", "ʿalam", "flag"], n: "ء is a clean catch. ع squeezes the throat and colors the vowel." },
  "ain-gh": { label: "ع vs غ", a: ["عَالِي", "ʿālī", "high"], b: ["غَالِي", "ghālī", "expensive"], n: "ع is made in the throat with no friction. غ is a gargle higher up." },
  "s-th": { label: "س vs ث", a: ["سَارَ", "sāra", "he walked"], b: ["ثَارَ", "thāra", "he revolted"], n: "ث puts the tongue between the teeth, like th in thin." },
  "z-dh": { label: "ز vs ذ", a: ["زَلَّ", "zalla", "he slipped"], b: ["ذَلَّ", "dhalla", "he was humbled"], n: "ذ is the th in this." },
  "len1": { label: "Short vs long a", a: ["كَتَبَ", "kataba", "he wrote"], b: ["كَاتَبَ", "kātaba", "he corresponded with"], n: "The only difference is a held vowel in the first syllable." },
  "len2": { label: "Short vs long a", a: ["جَمَل", "jamal", "camel"], b: ["جَمَال", "jamāl", "beauty"], n: "Long vowels are roughly twice as long, and often take the stress." },
  "gem": { label: "Single vs doubled r", a: ["دَرَسَ", "darasa", "he studied"], b: ["دَرَّسَ", "darrasa", "he taught"], n: "A doubled consonant is held longer. Here it turns 'study' into 'teach'." }
};

export const GROUPS = [
  { title: "Plain vs emphatic", ids: ["s-ss", "t-tt", "d-dd", "dh-zz"] },
  { title: "Back of the mouth and throat", ids: ["k-q", "h-hh", "hh-kh", "a-ain", "ain-gh"] },
  { title: "Between the teeth", ids: ["s-th", "z-dh"] },
  { title: "Length and doubling", ids: ["len1", "len2", "gem"] }
];

export const VOWELS = [
  { ipa: "a", w: "قَلَم", wt: "qalam", g: "pen" },
  { ipa: "aː", w: "بَاب", wt: "bāb", g: "door" },
  { ipa: "i", w: "بِنْت", wt: "bint", g: "girl" },
  { ipa: "iː", w: "فِيل", wt: "fīl", g: "elephant" },
  { ipa: "u", w: "أُمّ", wt: "ʔumm", g: "mother" },
  { ipa: "uː", w: "نُور", wt: "nūr", g: "light" },
  { ipa: "aj", w: "بَيْت", wt: "bayt", g: "house" },
  { ipa: "aw", w: "يَوْم", wt: "yawm", g: "day" }
];

export const VCOLOR = [
  { label: "ā after س vs ص", a: ["سَارَ", "sāra", "he walked"], b: ["صَارَ", "ṣāra", "he became"], n: "After plain س the long a is bright, close to the a in cat. After ص it is deep, like father." },
  { label: "ā after ت vs ط", a: ["تَابَ", "tāba", "he repented"], b: ["طَابَ", "ṭāba", "it was pleasant"], n: "The consonants differ by emphasis. Your ear mostly catches it in the vowel." }
];

export const SUN = [
  { label: "Sun letter ش", a: ["الشَّمْس", "ash-shams", "the sun"], b: ["الْقَمَر", "al-qamar", "the moon"], n: "ash-shams: the l disappears into ش. al-qamar: ق is a moon letter, so the l stays." },
  { label: "Sun letter ن", a: ["النُّور", "an-nūr", "the light"], b: ["الْبَيْت", "al-bayt", "the house"], n: "Tongue-tip consonants are sun letters. Lip and back consonants are moon letters." },
  { label: "Sun letter د", a: ["الدَّار", "ad-dār", "the home"], b: ["الْكَلْب", "al-kalb", "the dog"], n: "The doubled d in ad-dār is held, just like other doubled consonants." }
];

/* Every string the page can play, in page order, without duplicates */
export function playableTexts() {
  const out = new Set();
  for (const c of C) { out.add(c.syl); out.add(c.w); }
  for (const p of Object.values(PAIRS)) { out.add(p.a[0]); out.add(p.b[0]); }
  for (const v of VOWELS) out.add(v.w);
  for (const p of [...VCOLOR, ...SUN]) { out.add(p.a[0]); out.add(p.b[0]); }
  return [...out];
}
