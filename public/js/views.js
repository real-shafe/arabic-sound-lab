// HTML for the parts of the page. Pure string building; app.js puts it on the page, wires the
// buttons and updates the quiz frames in place. Every playable word is a button with
// data-say="<Arabic>"; a link to a letter's details has data-more="<slug>"; a practise chip has
// data-practise="<pair id>".

import { esc } from "./ui.js";
import { stripMarks } from "./text.js";
import {
  data, LETTER_GROUPS, placeById, latin, keyOfLetter, keyOfVowel, keyOfMark, MARK_KEYS, madeWhere, pairsForKey, dialectFor, afterArticle,
  markById, SETS, PAIR_LIST, hintOf,
} from "./sounds.js";

const { ROMANIZATION, C, PLACES, VOWELS, MARKS, VCOLOR, DIALECTS, SUN_MOON, SOURCES, COPY } = data;

export const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor"/></svg>';
export const SPEAKER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4Z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';

const ar = s => `<span class="ar" lang="ar" dir="rtl">${esc(s)}</span>`;
const tr = s => `<span class="tr">${esc(s)}</span>`;

const AR_RUN = /[\u0600-\u06FF]+(?:[ \u00A0]+[\u0600-\u06FF]+)*/g;
const isOneLetter = t => stripMarks(t).length === 1 && !!latin(t);

/**
 * Prose with its Arabic marked up. A letter standing on its own (or two of them) gets its Latin
 * symbol right after it, so a reader who does not know the script can follow: ح ḥ.
 */
export function prose(text, tags = null) {
  const s = text == null ? "" : String(text);
  const used = new Set();
  // The first mention of a tagged letter carries the number of its card: ك k ①.
  const tag = t => {
    const n = tags && tags[t];
    if (!n || used.has(t)) return "";
    used.add(t);
    return `<span class="numtag" aria-hidden="true">${esc(n)}</span>`;
  };
  let out = "";
  let last = 0;
  for (const m of s.matchAll(AR_RUN)) {
    out += esc(s.slice(last, m.index));
    const tokens = m[0].split(/[ \u00A0]+/);
    if (tokens.length <= 2 && tokens.every(isOneLetter)) {
      out += tokens.map(t => `<span class="lt">${tag(t)}${ar(t)}${tr(latin(t))}</span>`).join(" ");
    } else {
      out += ar(m[0]);
    }
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

/** A playable word: icon, Arabic, transliteration and gloss. */
export function word(w, label = "") {
  if (!w) return "";
  const sub = [w.tr && tr(w.tr), w.g && `“${esc(w.g)}”`].filter(Boolean).join(" · ");
  return `<button type="button" class="word" data-say="${esc(w.ar)}" aria-label="Play ${esc(w.tr || "")}${w.g ? `, ${esc(w.g)}` : ""}">` +
    `<span class="ic" aria-hidden="true">${PLAY_SVG}</span>` +
    `<span>${ar(w.ar)}<small>${label ? `${esc(label)} · ` : ""}${sub}</small></span></button>`;
}

// ---------- the ear quiz ----------

export function setOptionsHTML() {
  return `<optgroup label="Sets (several pairs mixed)">${SETS.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("")}</optgroup>` +
    `<optgroup label="One pair (the same two words)">${PAIR_LIST.map(p => `<option value="pair:${esc(p.id)}">${esc(p.title)}</option>`).join("")}</optgroup>`;
}

export function earCardHTML() {
  const choice = (slot, n) =>
    `<button type="button" class="choice" data-ui="choice" data-choice="${slot}" title="Key ${n}">` +
    `<span class="badge" aria-hidden="true">${n}</span><span class="spk" aria-hidden="true">${SPEAKER_SVG}</span>` +
    `<span class="ar" lang="ar" dir="rtl" data-part="ar"></span>` +
    `<span class="sub"><span class="l1"><span class="tr" data-part="tr"></span><span class="who" data-part="who"></span></span><span class="gl" data-part="gl"></span></span></button>`;
  return `<div class="frame">
    <div class="q-top">
      <button type="button" class="play" data-ui="play" aria-label="Play the word" title="Play the word (R)">${PLAY_SVG}</button>
      <div class="q-text">
        <div class="q-head"><label class="field"><span>Practise</span><select id="set">${setOptionsHTML()}</select></label><span class="score" data-ui="score"></span></div>
        <div class="q-line"><p class="status" data-ui="status"></p><span class="keys-hint" aria-hidden="true"><span class="kh-long">R replay · 1 2 answer · Enter next</span><span class="kh-short">Keys: R, 1, 2, Enter</span></span></div>
      </div>
    </div>
    <div class="choices">${choice("a", 1)}${choice("b", 2)}</div>
  </div>`;
}

export function quizSurfaceHTML({ places = false } = {}) {
  const buttons = places
    ? `<div class="places" role="group" aria-label="Places in the mouth">${PLACES.map((p, i) =>
      `<button type="button" class="pl" data-ui="place" data-place="${esc(p.id)}" title="${esc(p.name)} (key ${i + 1})"><span class="n" aria-hidden="true">${i + 1}</span><span>${esc(p.short)}</span></button>`).join("")}</div>`
    : "";
  return `<div class="frame">
    <div class="pic" data-ui="pic"></div>${buttons}
    <div class="under">
      <p class="caption" data-ui="caption"></p>
      <div class="more" data-ui="more"></div>
      <button type="button" class="next" data-ui="next" data-off title="Next (Enter)">Next</button>
    </div>
  </div>`;
}

/** The two transliterations with the part that differs marked: kalb / qalb → [k]alb / [q]alb. */
export function diffPair(a, b) {
  const A = [...a], B = [...b];
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  // A doubled letter leaves one side empty (darasa / darrasa): widen by one so both show it.
  if ((A.length - p - s === 0 || B.length - p - s === 0) && p > 0) p--;
  const mark = X => `${esc(X.slice(0, p).join(""))}<b class="diff">${esc(X.slice(p, X.length - s).join(""))}</b>${esc(X.slice(X.length - s).join(""))}`;
  return [mark(A), mark(B)];
}

/** One sound per block; a long vowel or a doubled consonant is one block, twice as wide. */
export function blocksOf(translit) {
  const out = [];
  const chars = [...translit].filter(ch => ch !== "-" && ch !== " ");
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if ("āīū".includes(ch)) out.push({ text: ch, long: true });
    else if (chars[i + 1] === ch && !"aiu".includes(ch)) { out.push({ text: ch + ch, long: true }); i++; }
    else out.push({ text: ch, long: false });
  }
  return out;
}

export function stripsHTML(left, right) {
  const L = blocksOf(left.tr), R = blocksOf(right.tr);
  const row = (blocks, other, n) =>
    `<div class="strip" data-strip="${n === 1 ? "a" : "b"}"><span class="badge" aria-hidden="true">${n}</span><div class="blocks">` +
    blocks.map((b, i) => `<span class="blk${b.long ? " long" : ""}${!other[i] || other[i].text !== b.text ? " diff" : ""}">${esc(b.text)}</span>`).join("") +
    `</div></div>`;
  return `<div class="strips" role="img" aria-label="${esc(left.tr)} and ${esc(right.tr)}: the highlighted sound is held longer in one of them">${row(L, R, 1)}${row(R, L, 2)}</div>`;
}

/**
 * Links from a quiz to a letter's details: outlined pills with a chevron. Two letters carry the numbers
 * of their cards (plain digits: the filled amber circles are the cards and their marks on the picture).
 */
export const moreLinks = letters =>
  letters.length
    ? `<span class="more-l${letters.length > 1 ? " two" : ""}"><span class="ml-long">More about</span><span class="ml-short">More:</span></span>` +
      letters.map((c, i) =>
        `<a class="pill" href="#${esc(c.slug)}" data-more="${esc(c.slug)}" aria-label="More about ${esc(c.name)}">` +
        (letters.length > 1 ? `<span class="pn" aria-hidden="true">${i + 1}</span>${ar(c.ch)}` : `${ar(c.ch)}<span class="pname">${esc(c.name)}</span>`) +
        `<span class="chev" aria-hidden="true">›</span></a>`).join("")
    : "";

// ---------- the mouth quiz ----------

export function mouthCardHTML() {
  return `<div class="frame">
    <div class="p-top">
      <button type="button" class="say-letter" data-ui="say" title="Play the word (R)">
        <span class="glyph" lang="ar" dir="rtl" data-part="glyph"></span><span class="ic" aria-hidden="true">${SPEAKER_SVG}</span>
      </button>
      <div class="q-text">
        <div class="q-head"><span class="p-name" data-part="name"></span><span class="score" data-ui="score"></span></div>
        <div class="p-word" data-part="word"></div>
        <div class="q-line"><p class="status" data-ui="status"></p><span class="keys-hint" aria-hidden="true"><span class="kh-long">R replay · 1–8 answer · Enter next</span><span class="kh-short">Keys: R, 1 to 8, Enter</span></span></div>
      </div>
    </div>
  </div>`;
}

export const wordLine = w => `${ar(w.ar)}${tr(w.tr)} · “${esc(w.g)}”`;

// ---------- All sounds: the list ----------

export function pickerHTML() {
  const groups = LETTER_GROUPS.map(g =>
    `<div class="grp${g.letters.length === 1 ? " one" : ""}" style="--n:${g.letters.length}"><span class="lab">${esc(g.label)}</span><div class="keys">` +
    g.letters.map(c =>
      `<button type="button" class="k" data-key="${esc(keyOfLetter(c.ch))}" aria-pressed="false" aria-label="${esc(c.name)}, ${esc(hintOf(c.ch))}" title="${esc(c.name)}: ${esc(hintOf(c.ch))}" tabindex="-1">` +
      `${ar(c.ch)}<span class="t${/^[ʿʾ]$/.test(latin(c.ch)) ? " ring" : ""}" aria-hidden="true">${esc(latin(c.ch))}</span></button>`).join("") +
    `</div></div>`).join("");
  const vowels = `<div class="grp vowels"><span class="lab">Vowels</span><div class="keys">` +
    VOWELS.map(v =>
      `<button type="button" class="k" data-key="${esc(keyOfVowel(v.id))}" aria-pressed="false" aria-label="${esc(v.label)}" tabindex="-1">` +
      `${ar(v.spell)}<span class="t" aria-hidden="true">${esc(v.label.split(" ").pop())}</span></button>`).join("") +
    `</div></div>`;
  // The marks that are not a vowel of their own: same kind of key, same kind of card.
  const marks = MARK_KEYS.length
    ? `<div class="grp markkeys" style="--n:${MARK_KEYS.length}"><span class="lab">Marks</span><div class="keys">` +
      MARK_KEYS.map(id => {
        const m = markById.get(id);
        return `<button type="button" class="k" data-key="${esc(keyOfMark(id))}" aria-pressed="false" aria-label="${esc(m.name)}, ${esc(m.sound)}" title="${esc(m.name)}: ${esc(m.sound)}" tabindex="-1">` +
          `${ar(m.mark)}<span class="t" aria-hidden="true">${esc(m.name)}</span></button>`;
      }).join("") + `</div></div>`
    : "";
  return groups + vowels + marks;
}

// ---------- a sound's details (All sounds and the letter sheet) ----------

function chipFor(p) {
  if (p.contrast) {
    const order = p.letters;
    const side = c => `${esc(hintOf(c.ch) || latin(c.ch))} ${ar(c.ch)}`;
    return `<button type="button" class="chip" data-practise="${esc(p.id)}" title="Practise this pair in the ear quiz">${side(order[0])}<span class="vs">vs</span>${side(order[1])}${p.colour ? '<span class="vs">before long ā</span>' : ""}</button>`;
  }
  return `<button type="button" class="chip" data-practise="${esc(p.id)}" title="Practise this pair in the ear quiz">${tr(p.a.tr)}<span class="vs">vs</span>${tr(p.b.tr)}</button>`;
}

/** "Practise hearing it": the way from a sound back into the drill, right under its words. */
function practiseBlock(k) {
  const pairs = pairsForKey(k);
  if (!pairs.length) return "";
  return `<div class="d-practise"><div class="d-sub">Practise hearing it</div><div class="chips">${pairs.map(p => chipFor(p)).join("")}</div></div>`;
}

/** A phonetic (IPA) form respelled with the page's own Latin letters, plus e, o, g, ch and zh. */
export function respell(ipa) {
  return String(ipa).replace(/\//g, "")
    .replace(/j/g, "y").replace(/dʒ/g, "j").replace(/tʃ/g, "ch").replace(/ðˤ/g, "ẓ").replace(/dˤ/g, "ḍ")
    .replace(/ʔ/g, "ʾ").replace(/θ/g, "ṯ").replace(/ð/g, "ḏ").replace(/ʒ/g, "zh").replace(/ə/g, "e")
    .replace(/aː/g, "ā").replace(/iː/g, "ī").replace(/uː/g, "ū").replace(/eː/g, "ē").replace(/oː/g, "ō");
}

function citiesCell(row) {
  if (!row) return "";
  const cols = DIALECTS.columns.filter(c => c.id !== "msa");
  return `<div><div class="d-sub">How cities say it</div><div class="words">${word(row, "standard")}</div>` +
    `<div class="regions">${cols.map(c => `<span>${esc(c.name)} <b>${esc(respell(row.forms[c.id]))}</b></span>`).join("")}</div>` +
    `<p class="d-note">Only the standard word has audio.</p></div>`;
}

function letterDetail(c) {
  const k = keyOfLetter(c.ch);
  const facts = [`Made ${madeWhere(c.place)}`, c.emph ? "heavy" : ""].filter(Boolean);
  let shapes;
  if (Array.isArray(c.seats) && c.seats.length) {
    const seatWords = ["hamza-alif", "hamza-waw", "hamza-ya", "hamza-line"].map(id => markById.get(id)?.ex);
    shapes = `<div><div class="d-sub">How it is written</div>${c.seatsNote ? `<p>${prose(c.seatsNote)}</p>` : ""}<div class="words">` +
      c.seats.map((s, i) => word(seatWords[i], `${s.ar} ${s.label.toLowerCase()}`)).join("") + `</div></div>`;
  } else {
    const f = c.forms;
    shapes = `<div><div class="d-sub">Shapes</div><div class="forms">` +
      [["Alone", f.isolated], ["Start", f.initial], ["Middle", f.medial], ["End", f.final]]
        .map(([l, g]) => `<span class="form">${ar(g)}<small>${l}</small></span>`).join("") + `</div></div>`;
  }
  const al = afterArticle(c);
  const article = al
    ? `<div><div class="d-sub">After al- (“the”)</div><p>${prose(al.text)}</p>${al.word ? `<div class="words">${word(al.word)}</div>` : ""}` +
      `${al.exception ? `<p class="d-note">${prose(al.exception)}</p>` : ""}</div>`
    : "";
  // On a phone the picture is small and sits beside the name, so its caption joins the description there.
  const also = "The faint line in the throat: the tongue root is pulled back too.";
  return `<div class="d" data-ui="detail">
    <div class="d-main">
      <div class="d-info">
        <div class="eyebrow">${esc(facts.join(" · "))}</div>
        <div class="d-head"><span class="d-glyph" lang="ar" dir="rtl">${esc(c.ch)}</span>
          <div class="d-name"><span data-ui="detail-title">${esc(c.name)}</span><span class="d-sym">${esc(hintOf(c.ch))} · written ${tr(latin(c.ch))} · /${esc(c.ipa)}/</span></div></div>
      </div>
      <p class="d-desc">${prose(c.d)}${c.emph ? `<span class="d-also-in"> ${also}</span>` : ""}</p>
      <div class="d-pic"><div class="d-mouth" data-mouth="${esc(c.place)}"${c.emph ? ' data-also="pha"' : ""}></div>${c.emph ? `<p class="d-also">${also}</p>` : ""}</div>
      <div class="words">${word(c.ex.initial, "start")}${word(c.ex.medial, "middle")}${word(c.ex.final, "end")}</div>
    </div>
    ${practiseBlock(k)}
    <div class="d-more"><div class="d-col">${shapes}${article}</div><div class="d-col">${citiesCell(dialectFor(k))}</div></div>
    ${c.note ? `<p class="d-note">${prose(c.note)}</p>` : ""}
  </div>`;
}

function vowelDetail(v) {
  const k = keyOfVowel(v.id);
  const mark = v.mark ? markById.get(v.mark) : null;
  const colour = v.id === "a" || v.id === "aa"
    ? `<div class="d-practise"><div class="d-sub">Next to heavy consonants</div><div class="chips">${PAIR_LIST.filter(p => VCOLOR.some(x => x.id === p.id)).map(p => chipFor(p)).join("")}</div></div>`
    : "";
  const cities = citiesCell(dialectFor(k));
  return `<div class="d" data-ui="detail">
    <div class="d-main">
      <div class="d-info">
        <div class="eyebrow">Vowel</div>
        <div class="d-head"><span class="d-glyph v" lang="ar" dir="rtl">${esc(v.spell)}</span>
          <div class="d-name"><span data-ui="detail-title">${esc(v.label[0].toUpperCase() + v.label.slice(1))}</span><span class="d-sym">/${esc(v.ipa)}/ · shown on the letter ${ar("ب")}</span></div></div>
      </div>
      <p class="d-desc">${prose(v.desc)}</p>
      <div class="words">${word(v)}${mark && mark.ex.ar !== v.ar ? word(mark.ex) : ""}</div>
    </div>
    ${practiseBlock(k)}${colour}
    ${cities ? `<div class="d-more"><div class="d-col">${cities}</div><div class="d-col"></div></div>` : ""}
  </div>`;
}

/** One of the small marks that has a key of its own (sukūn, šadda, tanwīn, madda). */
function markDetail(m) {
  const k = keyOfMark(m.id);
  return `<div class="d" data-ui="detail">
    <div class="d-main">
      <div class="d-info">
        <div class="eyebrow">Mark</div>
        <div class="d-head"><span class="d-glyph v" lang="ar" dir="rtl">${esc(m.mark)}</span>
          <div class="d-name"><span data-ui="detail-title">${esc(m.name)}</span><span class="d-sym">${esc(m.sound)}${m.mark.includes("ب") ? ` · shown on the letter ${ar("ب")}` : ""}</span></div></div>
      </div>
      <p class="d-desc">${prose(m.desc)}</p>
      <div class="words">${word(m.ex)}</div>
    </div>
    ${practiseBlock(k)}
  </div>`;
}

/** Details of a sound; `sound` comes from soundOf() in sounds.js. */
export function detailHTML(sound) {
  if (!sound) return "";
  return sound.kind === "letter" ? letterDetail(sound.letter) : sound.kind === "vowel" ? vowelDetail(sound.vowel) : markDetail(sound.mark);
}

// ---------- the reading notes (one sheet, opened from the footer) ----------

/** A reference sheet: { title, html }, or null. "notes" is the only one. */
export function refHTML(id) {
  if (id !== "notes") return null;
  const cols = DIALECTS.columns;
  const table = `<div class="dscroll"><table class="dtable"><thead><tr><th>Word</th>${cols.map(c => `<th>${esc(c.name)}</th>`).join("")}</tr></thead><tbody>` +
    DIALECTS.rows.map(r => `<tr><th>${ar(r.ar)} <span class="tr">${esc(r.g)}</span></th>${cols.map(c => `<td>${esc(r.forms[c.id] || "")}</td>`).join("")}</tr>`).join("") +
    `</tbody></table></div>`;
  const marks = `<div class="marks">${MARKS.map(m =>
    `<div class="mark"><span class="m-glyph" lang="ar" dir="rtl">${esc(m.mark)}</span><div><b>${esc(m.name)}</b> · ${esc(m.sound)}<br>${prose(m.desc)}<br>${word(m.ex)}</div></div>`).join("")}</div>`;
  // The Latin letters that are not what an English reader expects, each with its plain hint.
  const odd = C.filter(c => !/^[a-z]$/.test(latin(c.ch)) || c.ch === "ق").sort((a, b) => a.abjad - b.abjad);
  const keyTable = `<div class="lkey">${odd.map(c =>
    `<span><b class="tr">${esc(latin(c.ch))}</b> ${ar(c.ch)} ${esc(hintOf(c.ch))}</span>`).join("")}` +
    `<span><b class="tr">ā ī ū</b> long vowels, held about twice as long</span></div>`;
  return {
    title: "Reading notes",
    html: `<div class="ref">
    <h3>Key to the Latin letters</h3>${keyTable}
    <h3>The small marks</h3><p>${prose(COPY.marksIntro)}</p>${marks}
    <h3>Latin spelling</h3><p>${prose(COPY.readingNote)}</p><p>${prose(ROMANIZATION.note)}</p>
    <h3>Sun and moon letters</h3><p>${prose(COPY.sunMoonIntro.replace(/ Tap a letter.*$/, ""))}</p><p>${prose(SUN_MOON.rule)}</p>
    <h3>Regional speech</h3><p>${prose(DIALECTS.note)}</p>${table}
    <h3>About the audio</h3><p>${prose(COPY.audioNote)}</p>
    <h3>Keys</h3><p>Ear quiz: R plays the word, 1 and 2 answer (and replay a word after the answer), Enter or N goes on. Mouth quiz: R plays the word, 1 to 8 pick a place, Enter or N goes on. All sounds: the arrow keys move through the list.</p>
    <h3>Sources</h3><ul>${SOURCES.map(s => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.text)}</a>` : esc(s.text)}</li>`).join("")}</ul>
    </div>`,
  };
}

export { placeById };
