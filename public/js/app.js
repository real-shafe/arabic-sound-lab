// Arabic Sound Lab. Three modes in the shape of the Arabic Keyboard Drill:
//
//   Ear quiz     hear one word of a pair and pick which it was. The mouth under the question shows,
//                as 1 and 2, where each word's contrasted sound is made (or, for pairs that differ
//                only in length, two timelines).
//   Mouth quiz   see a letter, hear it in a word, pick where in the mouth it is made.
//   All sounds   the list of sounds from the lips to the voice box; the chosen one right under it
//                (in a sheet on phones).
//
// How the page is kept calm (tests/ui.test.mjs measures all of it):
//   - Each quiz's parts are built once and then only updated in place, so nothing under the
//     pointer is ever replaced and keyboard focus stays where it is.
//   - Every text slot gets the height of the tallest text it can hold (reserve()), so answering
//     or going on never changes the size of anything.
//   - Nothing scrolls the page, and whatever a tap changes is next to the tap.
//   - Modes and the letter sheet are history entries, so Back steps back inside the site.

import { createAudioEngine } from "./audio.js";
import { createMouth } from "./mouth.js";
import { esc, announce, prefs } from "./ui.js";
import {
  data, PAIR_LIST, pairById, idsOfChoice, setById, letterBySlug, vowelById, KEY_ORDER, soundOf, keyOfLetter, keyOfVowel, keyOfMark,
  placeById, madeWhere, placeIsRight, alsoPlace,
} from "./sounds.js";
import {
  prose, earCardHTML, quizSurfaceHTML, mouthCardHTML, wordLine, diffPair, stripsHTML, moreLinks, pickerHTML, detailHTML, refHTML,
} from "./views.js";

const { C, PLACES } = data;
const $ = id => document.getElementById(id);
const card = $("card");
const surface = $("surface");
const picker = $("picker");
const detail = $("detail");
const tip = $("tip");
const sheet = $("sheet");
const sheetBody = $("sheet-body");
const narrow = matchMedia("(max-width: 640px)");

const el = html => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const tr = s => `<span class="tr">${esc(s)}</span>`;
const shuffle = list => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------- audio ----------

const engine = createAudioEngine({ manifestUrl: "audio.json" });
// Both voices by default: the same word in two voices is twice the practice.
let voicePref = prefs.get("voice2", "mix");
if (!["chaouki", "asmaa", "mix"].includes(voicePref)) voicePref = "mix";
const anyVoice = () => (voicePref === "mix" ? (Math.random() < 0.5 ? "chaouki" : "asmaa") : voicePref);
const plainVoice = () => (voicePref === "mix" ? "chaouki" : voicePref);
engine.setVoice(plainVoice());

function say(text, button, voice = plainVoice()) {
  if (text) engine.play({ text, el: button }, { voice });
}

// ---------- reserved heights ----------

/** Give `slot` the height of the tallest of `candidates` (HTML strings) at its current width. */
function reserve(slot, candidates) {
  if (!slot || !slot.isConnected) return;
  const width = slot.getBoundingClientRect().width;
  if (!width) return;
  const probe = slot.cloneNode(false);
  for (const a of ["id", "data-ui", "role", "aria-live"]) probe.removeAttribute(a);
  probe.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;min-height:0;height:auto;margin:0;width:${width}px`;
  slot.parentNode.append(probe);
  let max = 0;
  for (const html of candidates) {
    probe.innerHTML = html;
    max = Math.max(max, probe.getBoundingClientRect().height);
  }
  probe.remove();
  slot.style.minHeight = `${Math.ceil(max)}px`;
}

// ---------- remembered misses, shuffle bags ----------

const missed = Object.assign({ pairs: {}, letters: {} }, prefs.get("missed", {}));
function record(kind, id, ok) {
  missed[kind][id] = ok ? Math.max(0, (missed[kind][id] || 0) - 1) : (missed[kind][id] || 0) + 1;
  prefs.set("missed", missed);
}

/** Every id once per round (missed ones twice), in random order, never the same one twice in a row. */
function takeFromBag(st, ids, misses) {
  st.bag = (st.bag || []).filter(id => ids.includes(id));
  if (!st.bag.length) st.bag = shuffle(ids.flatMap(id => (misses[id] > 0 ? [id, id] : [id])));
  let i = st.bag.findIndex(id => id !== st.last);
  if (i < 0) i = 0;
  const [id] = st.bag.splice(i, 1);
  st.last = id;
  return id;
}
const scoreText = s => `${s.right} of ${s.total} right`;

// The two scores last as long as the tab does: a reload keeps them, a new visit starts at 0.
const SCORE_KEY = "asl:score";
const CAME_BACK = (() => {
  try { return ["reload", "back_forward"].includes(performance.getEntriesByType("navigation")[0]?.type); } catch { return false; }
})();
function keptScore(name) {
  try {
    if (!CAME_BACK) { sessionStorage.removeItem(SCORE_KEY); return { right: 0, total: 0 }; }
    const s = JSON.parse(sessionStorage.getItem(SCORE_KEY) || "null")?.[name];
    if (s && Number.isInteger(s.right) && Number.isInteger(s.total) && s.right >= 0 && s.right <= s.total && s.total < 1e6) return { right: s.right, total: s.total };
  } catch { /* no storage, or not ours */ }
  return { right: 0, total: 0 };
}
function keepScores() {
  try { sessionStorage.setItem(SCORE_KEY, JSON.stringify({ ear: ear.score, mouth: mq.score })); } catch { /* private mode */ }
}

// =====================================================================================
// Ear quiz
// =====================================================================================

const ear = { choice: prefs.get("set", "back"), score: keptScore("ear"), sides: new Map(), q: null, els: null };
if (!setById.has(ear.choice) && !(String(ear.choice).startsWith("pair:") && pairById.has(String(ear.choice).slice(5)))) ear.choice = "back";

const EAR_PROMPT = "Press play, then pick the word.";
const EAR_PROMPT_PLAYED = "Pick the word you heard.";
// A card tapped before anything was played plays the question instead of counting as a blind guess.
const EAR_PROMPT_TAPPED = "That was the word. Pick it."; // short: one line on a 360 px phone
// A finger on a number in the picture, before the answer (see earBadge).
const EAR_PROMPT_CARDS = "Tap card 1 or 2 to answer.";
const EAR_LEGEND = {
  place: "1 and 2 mark where each word’s sound is made.",
  heavy: "1 and 2 mark where each word’s sound is made. The hollow mark means the tongue root is pulled back as well.",
  length: "1 and 2 differ only in how long one sound is held.",
};
const AI_NOTE = " The voices are AI-made and have not been checked by a fluent speaker.";
// A drill on one pair has one pair of words; say so before it feels stuck on repeat.
const ONE_PAIR = " This drill is just these two words, over and over.";
const onePair = () => idsOfChoice(ear.choice).length === 1;
const legendBase = p => (!p.contrast ? EAR_LEGEND.length : p.letters.some(c => c.emph) ? EAR_LEGEND.heavy : EAR_LEGEND.place);
const earLegend = p => legendBase(p) + (ear.score.total === 0 ? AI_NOTE : onePair() ? ONE_PAIR : "");

function earBuild() {
  const cardEl = el(earCardHTML());
  const surfEl = el(quizSurfaceHTML());
  const q = (root, sel) => root.querySelector(sel);
  ear.cardEl = cardEl;
  ear.surfEl = surfEl;
  ear.els = {
    play: q(cardEl, '[data-ui="play"]'),
    set: q(cardEl, "#set"),
    status: q(cardEl, '[data-ui="status"]'),
    score: q(cardEl, '[data-ui="score"]'),
    a: q(cardEl, '[data-choice="a"]'),
    b: q(cardEl, '[data-choice="b"]'),
    pic: q(surfEl, '[data-ui="pic"]'),
    caption: q(surfEl, '[data-ui="caption"]'),
    more: q(surfEl, '[data-ui="more"]'),
    next: q(surfEl, '[data-ui="next"]'),
  };
  ear.mouth = createMouth({ places: PLACES, size: "md" });
  ear.strips = document.createElement("div");
  ear.els.pic.append(ear.mouth.el, ear.strips);
  ear.els.set.value = ear.choice;
  ear.els.set.addEventListener("change", () => {
    ear.choice = ear.els.set.value;
    prefs.set("set", ear.choice);
    earNewQuestion();
    // Like Next, the voice menu and Slow: the new word is heard at once. Stepping through the menu
    // with the arrow keys stays quiet.
    if (!fromKeyboard() && audioStarted) earPlay(); // only once audio has worked: a menu is not a tap that may start it
    releaseFocus(ear.els.set);
  });
  earNewQuestion();
}

function earNewQuestion() {
  const pair = pairById.get(takeFromBag(ear, idsOfChoice(ear.choice), missed.pairs));
  // Which of the two words is said: random, but not the same one three times running.
  const before = ear.sides.get(pair.id) || [];
  let said = Math.random() < 0.5 ? "a" : "b";
  if (before.length === 2 && before[0] === before[1]) said = before[0] === "a" ? "b" : "a";
  ear.sides.set(pair.id, [...before, said].slice(-2));
  // Which word sits in the left slot.
  let left = Math.random() < 0.5 ? "a" : "b";
  const sig = `${pair.id}|${said}|`;
  if (ear.lastSig === sig + left) left = left === "a" ? "b" : "a";
  ear.lastSig = sig + left;
  const slots = { a: left, b: left === "a" ? "b" : "a" };
  ear.q = { pair, slots, heardSlot: slots.a === said ? "a" : "b", voice: anyVoice(), answered: null, fresh: true, played: false };
  earRender();
}

const numTag = slot => `<span class="numtag" aria-hidden="true">${slot === "a" ? 1 : 2}</span>`;
const earWord = slot => ear.q.pair[ear.q.slots[slot]];
const earLetter = slot => ear.q.pair.letters[ear.q.slots[slot] === "a" ? 0 : 1];

function earRender() {
  const { q, els } = ear;
  const p = q.pair;
  const state = slot => (!q.answered ? "idle" : slot === q.heardSlot ? "right" : slot === q.answered ? "wrong" : "idle");

  if (q.fresh) {
    // The words and the picture change only with the question.
    const [da, db] = diffPair(earWord("a").tr, earWord("b").tr);
    for (const slot of ["a", "b"]) {
      const w = earWord(slot);
      const b = els[slot];
      b.querySelector('[data-part="ar"]').textContent = w.ar;
      b.querySelector('[data-part="tr"]').innerHTML = slot === "a" ? da : db;
      b.querySelector('[data-part="gl"]').textContent = `“${w.g}”`;
      const who = p.names[q.slots[slot] === "a" ? 0 : 1];
      b.querySelector('[data-part="who"]').textContent = who ? ` · ${who}` : "";
    }
    ear.mouth.el.toggleAttribute("hidden", !p.contrast); // an SVG element has no .hidden property
    ear.strips.hidden = p.contrast;
    if (!p.contrast) ear.mouth.setMarks([]);
    ear.strips.innerHTML = p.contrast ? "" : stripsHTML(earWord("a"), earWord("b"));
    q.fresh = false;
  }

  for (const slot of ["a", "b"]) {
    const w = earWord(slot);
    const b = els[slot];
    b.classList.toggle("right", state(slot) === "right");
    b.classList.toggle("wrong", state(slot) === "wrong");
    b.setAttribute("aria-label", q.answered ? `Play ${w.tr}, ${w.g}` : `${slot === "a" ? "1" : "2"}: ${w.tr}, ${w.g}`);
    ear.strips.querySelector(`[data-strip="${slot}"]`)?.classList.toggle("right", state(slot) === "right");
    ear.strips.querySelector(`[data-strip="${slot}"]`)?.classList.toggle("wrong", state(slot) === "wrong");
  }
  if (p.contrast) {
    ear.mouth.setMarks(["a", "b"].map(slot => {
      const c = earLetter(slot);
      return { place: c.place, label: slot === "a" ? "1" : "2", state: state(slot), extra: alsoPlace(c) || undefined };
    }));
  }

  card.dataset.answered = String(!!q.answered);
  const heard = earWord(q.heardSlot);
  els.status.innerHTML = !q.answered
    ? (q.played ? EAR_PROMPT_PLAYED : EAR_PROMPT)
    : q.answered === q.heardSlot
      ? `<b class="ok">Right:</b> ${numTag(q.heardSlot)} ${tr(heard.tr)}.`
      : `<b class="no">Not quite:</b> it was ${numTag(q.heardSlot)} ${tr(heard.tr)}.`;
  els.score.textContent = scoreText(ear.score);
  els.caption.classList.toggle("quiet", !q.answered);
  els.caption.classList.remove("err");
  const tags = p.contrast ? { [earLetter("a").ch]: "1", [earLetter("b").ch]: "2" } : null;
  els.caption.innerHTML = q.answered ? prose(p.n, tags) : earLegend(p);
  els.more.innerHTML = q.answered && p.contrast ? moreLinks([earLetter("a"), earLetter("b")]) : "";
  els.next.toggleAttribute("data-off", !q.answered);
  els.play.setAttribute("aria-label", q.answered ? `Play ${heard.tr} again` : "Play the word");
}

function earMeasure() {
  const { els } = ear;
  const words = PAIR_LIST.flatMap(p => [p.a, p.b]);
  reserve(els.status, [EAR_PROMPT, EAR_PROMPT_PLAYED, EAR_PROMPT_TAPPED, EAR_PROMPT_CARDS, ...words.map(w => `<b class="no">Not quite:</b> it was ${numTag("a")} ${tr(w.tr)}.`)]);
  reserve(els.caption, [...Object.values(EAR_LEGEND).flatMap(t => [t + AI_NOTE, t + ONE_PAIR]), ...PAIR_LIST.map(p => prose(p.n, p.contrast ? { [p.letters[0].ch]: "1", [p.letters[1].ch]: "2" } : null))]);
  reserve(els.more, PAIR_LIST.filter(p => p.contrast).map(p => moreLinks(p.letters)));
  const subs = PAIR_LIST.flatMap(p => [[p.a, p.names[0]], [p.b, p.names[1]]]).map(([w, who]) =>
    `<span class="l1"><span class="tr"><b class="diff">${esc(w.tr)}</b></span><span class="who"> · ${esc(who)}</span></span><span class="gl">“${esc(w.g)}”</span>`);
  for (const slot of ["a", "b"]) reserve(els[slot].querySelector(".sub"), subs);
}

function earPlay() {
  const { q, els } = ear;
  if (!q.played) {
    q.played = true;
    if (!q.answered) els.status.textContent = EAR_PROMPT_PLAYED;
  }
  say(earWord(q.heardSlot).ar, els.play, q.voice);
}

function earAnswer(slot) {
  const { q, els } = ear;
  if (q.answered) {
    say(earWord(slot).ar, els[slot], q.voice);
    return;
  }
  if (!q.played) {
    // Nothing has been heard yet: play the word rather than score a blind guess.
    earPlay();
    els.status.textContent = EAR_PROMPT_TAPPED;
    return;
  }
  q.answered = slot;
  const ok = slot === q.heardSlot;
  ear.score.total++;
  if (ok) ear.score.right++;
  record("pairs", q.pair.id, ok);
  keepScores();
  earRender();
  const heard = earWord(q.heardSlot);
  announce(`${ok ? "Right" : "Not quite"}. It was ${heard.tr}, ${heard.g}. ${q.pair.n}`);
  els.next.focus({ preventScroll: true });
}

/**
   The numbers on the picture are the cards' numbers. With a mouse a number does what its card does. A finger
   gets that only after the answer (to hear a word again): two numbers can touch, and a slip of the thumb must
   not count as a wrong answer, so before the answer the cards are pointed out instead.
*/
function earBadge(slot) {
  const { q, els } = ear;
  if (q.answered || lastPointer !== "touch") {
    earAnswer(slot);
    return;
  }
  els.status.textContent = EAR_PROMPT_CARDS;
  for (const s of ["a", "b"]) {
    els[s].classList.remove("nudge");
    void els[s].offsetWidth; // restart the animation
    els[s].classList.add("nudge");
  }
}

function earNext() {
  if (!ear.q.answered) return;
  const hadFocus = document.activeElement === ear.els.next;
  earNewQuestion();
  if (hadFocus) ear.els.play.focus({ preventScroll: true });
  earPlay();
}

function earPractise(pairId) {
  if (!ear.els) earBuild();
  ear.choice = `pair:${pairId}`;
  ear.els.set.value = ear.choice;
  prefs.set("set", ear.choice);
  earNewQuestion();
}

// =====================================================================================
// Mouth quiz
// =====================================================================================

const mq = { score: keptScore("mouth"), q: null, els: null };
const MQ_PROMPT = "Hear it, then pick the place.";
const MQ_PROMPT_PLAYED = "Pick the place.";
const MQ_LEGEND = "Lips are on the left, the throat is on the right.";
const placeLine = p => `<b>${esc(p.name)}.</b> ${esc(p.desc)}.`;
const HEAVY = " Heavy: the tongue root is pulled back too.";

function mqBuild() {
  const cardEl = el(mouthCardHTML());
  const surfEl = el(quizSurfaceHTML({ places: true }));
  const q = (root, sel) => root.querySelector(sel);
  mq.cardEl = cardEl;
  mq.surfEl = surfEl;
  mq.els = {
    say: q(cardEl, '[data-ui="say"]'),
    glyph: q(cardEl, '[data-part="glyph"]'),
    name: q(cardEl, '[data-part="name"]'),
    word: q(cardEl, '[data-part="word"]'),
    status: q(cardEl, '[data-ui="status"]'),
    score: q(cardEl, '[data-ui="score"]'),
    pic: q(surfEl, '[data-ui="pic"]'),
    places: new Map([...surfEl.querySelectorAll('[data-ui="place"]')].map(b => [b.dataset.place, b])),
    caption: q(surfEl, '[data-ui="caption"]'),
    more: q(surfEl, '[data-ui="more"]'),
    next: q(surfEl, '[data-ui="next"]'),
  };
  mq.mouth = createMouth({ places: PLACES, size: "md" });
  mq.els.pic.append(mq.mouth.el);
  mqNewQuestion();
}

function mqNewQuestion() {
  const slug = takeFromBag(mq, C.map(c => c.slug), missed.letters);
  mq.q = { letter: letterBySlug.get(slug), picked: null, look: null, voice: anyVoice(), played: false };
  mqRender();
}

function mqRender() {
  const { q, els } = mq;
  const c = q.letter;
  const ok = !!q.picked && placeIsRight(c, q.picked);
  const alt = ok && q.picked !== c.place; // right, though the page files it one place along
  const state = id => {
    if (!q.picked) return "quiet";
    if (id === q.picked) return ok ? "right" : "wrong";
    if (id === c.place) return alt ? "idle" : "right";
    return id === q.look ? "idle" : "quiet";
  };
  els.glyph.textContent = c.ch;
  els.name.textContent = c.name;
  els.word.innerHTML = wordLine(c.ex.initial);
  els.say.setAttribute("aria-label", `Play ${c.ex.initial.tr}, a word with ${c.name}`);
  card.dataset.answered = String(!!q.picked);
  els.status.innerHTML = !q.picked
    ? (q.played ? MQ_PROMPT_PLAYED : MQ_PROMPT)
    : ok
      ? `<b class="ok">Right:</b> ${esc(madeWhere(q.picked))}.`
      : `<b class="no">Not quite:</b> it is made ${esc(madeWhere(c.place))}.`;
  els.score.textContent = scoreText(mq.score);
  mq.mouth.setMarks(PLACES.map((p, i) => ({ place: p.id, label: String(i + 1), state: state(p.id) })));
  for (const [id, b] of els.places) {
    const st = state(id);
    b.classList.toggle("right", st === "right");
    b.classList.toggle("wrong", st === "wrong");
    b.classList.toggle("look", st === "idle");
  }
  els.caption.classList.toggle("quiet", !q.picked);
  els.caption.classList.remove("err");
  els.caption.innerHTML = q.picked ? mqCaption(c, q.picked, q.look) : MQ_LEGEND;
  els.more.innerHTML = q.picked ? moreLinks([c]) : "";
  els.next.toggleAttribute("data-off", !q.picked);
}

/** What the caption says once a place was picked (or another one is being looked at). */
function mqCaption(c, picked, look) {
  if (look && look !== c.place) return placeLine(placeById.get(look));
  const alt = picked !== c.place && placeIsRight(c, picked);
  return (alt ? `Right: it is made between the two, and books also place it ${esc(madeWhere(c.place))}. ` : "") +
    placeLine(placeById.get(alt ? picked : c.place)) + (c.emph ? HEAVY : "");
}

function mqMeasure() {
  const { els } = mq;
  reserve(els.status, [MQ_PROMPT, MQ_PROMPT_PLAYED, ...PLACES.map(p => `<b class="no">Not quite:</b> it is made ${esc(madeWhere(p.id))}.`)]);
  reserve(els.caption, [MQ_LEGEND, ...PLACES.map(placeLine), ...C.flatMap(c => PLACES.filter(p => placeIsRight(c, p.id)).map(p => mqCaption(c, p.id, null)))]);
  reserve(els.more, C.map(c => moreLinks([c])));
  reserve(els.word, C.map(c => wordLine(c.ex.initial)));
}

function mqPlay() {
  const { q, els } = mq;
  if (!q.played) {
    q.played = true;
    if (!q.picked) els.status.textContent = MQ_PROMPT_PLAYED;
  }
  say(q.letter.ex.initial.ar, els.say, q.voice);
}

function mqPick(placeId) {
  const { q, els } = mq;
  if (!placeById.has(placeId)) return;
  if (q.picked) {
    // After the answer a place just shows itself.
    q.look = placeId;
    mqRender();
    return;
  }
  q.picked = placeId;
  const ok = placeIsRight(q.letter, placeId);
  mq.score.total++;
  if (ok) mq.score.right++;
  record("letters", q.letter.slug, ok);
  keepScores();
  mqRender();
  const right = placeById.get(q.letter.place);
  announce(`${ok ? "Right" : "Not quite"}. ${q.letter.name} is made ${madeWhere(q.letter.place)}. ${right.desc}.`);
  els.next.focus({ preventScroll: true });
}

function mqNext() {
  if (!mq.q.picked) return;
  const hadFocus = document.activeElement === mq.els.next;
  mqNewQuestion();
  if (hadFocus) mq.els.say.focus({ preventScroll: true });
  mqPlay();
}

// =====================================================================================
// All sounds
// =====================================================================================

const br = { built: false, sel: null };
const TIP = "Tap a sound to see how it is made.";

function brBuild() {
  picker.innerHTML = pickerHTML();
  br.built = true;
  brTabStop(KEY_ORDER[0]);
}
const keyButton = k => picker.querySelector(`.k[data-key="${CSS.escape(k)}"]`);
function brTabStop(k) {
  for (const b of picker.querySelectorAll(".k")) b.tabIndex = b.dataset.key === k ? 0 : -1;
}

function mountMouths(root) {
  for (const slot of root.querySelectorAll("[data-mouth]")) {
    const m = createMouth({ places: PLACES, size: "sm" });
    m.setPlace(slot.dataset.mouth, { also: slot.dataset.also || null });
    slot.replaceChildren(m.el);
  }
}

/** Show a sound right under the list (wide screens). */
function brSelect(k, { focus = false } = {}) {
  if (!soundOf(k)) return;
  br.sel = k;
  for (const b of picker.querySelectorAll(".k")) b.setAttribute("aria-pressed", String(b.dataset.key === k));
  brTabStop(k);
  if (focus) keyButton(k)?.focus({ preventScroll: true });
  if (!narrow.matches) {
    detail.innerHTML = detailHTML(soundOf(k));
    mountMouths(detail);
  }
}

function brMeasure() {
  tip.classList.remove("err");
  tip.textContent = narrow.matches ? TIP : "";
  if (narrow.matches) {
    detail.style.minHeight = "";
    for (const b of picker.querySelectorAll(".k")) b.setAttribute("aria-pressed", "false");
    return;
  }
  if (!br.sel) brSelect(KEY_ORDER[0]);
  else if (!detail.firstElementChild) brSelect(br.sel);
  // The card is never shorter than the room the screen has for it. While the list is pinned this is what lets
  // the page always scroll to the pinned position (a short card over a short footer would un-pin the list and
  // move the key under the pointer); otherwise it keeps the footer at the fold instead of jumping about.
  const pin = pinInfo();
  const above = pin ? pin.top + picker.getBoundingClientRect().height + pin.gap : detail.getBoundingClientRect().top + scrollY + stageGap();
  detail.style.minHeight = `${Math.max(0, Math.floor(innerHeight - above))}px`;
}

const stageGap = () => parseFloat(getComputedStyle(picker.parentElement).rowGap) || 0;
/** Where the list is pinned: its offset from the top of the screen, the gap under it, and the scroll position it is pinned from. Null when it is not pinned. */
function pinInfo() {
  const cs = getComputedStyle(picker);
  if (cs.position !== "sticky") return null;
  const top = parseFloat(cs.top) || 0;
  const gap = stageGap();
  const natural = document.querySelector(".bar").getBoundingClientRect().bottom + scrollY + gap;
  return { top, gap, from: natural - top };
}

/**
   When the list is pinned and the page is scrolled past it, show the newly chosen sound from its
   top. The list does not move (it is pinned in both positions); only the card under it does.
*/
function brShowTop() {
  const pin = pinInfo();
  if (pin && scrollY > pin.from + 1) scrollTo(0, pin.from);
}

/** Say the first example word of a sound. Its own button (under the list, or in the sheet) lights up while it plays, and so does `button`. */
function sayFirstWord(k, button = null) {
  const sound = soundOf(k);
  if (!sound) return;
  const text = sound.kind === "letter" ? sound.letter.ex.initial.ar : sound.kind === "vowel" ? sound.vowel.ar : sound.mark.ex.ar;
  const root = sheet.open ? sheetBody : detail;
  const wordButton = [...root.querySelectorAll(".d-main [data-say]")].find(b => b.dataset.say === text) || null;
  engine.play({ text, el: wordButton }, { voice: plainVoice(), whole: button });
}

let arrowSay = 0;
/** Arrow keys walk the list; on wide screens the details follow. */
function brArrow(from, keyName) {
  const keys = [...picker.querySelectorAll(".k")];
  const i = keys.indexOf(from);
  let to = null;
  if (keyName === "ArrowRight") to = keys[i + 1];
  else if (keyName === "ArrowLeft") to = keys[i - 1];
  else {
    const r = from.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const down = keyName === "ArrowDown";
    const rows = keys
      .map(b => ({ b, r: b.getBoundingClientRect() }))
      .filter(o => (down ? o.r.top > r.bottom - 2 : o.r.bottom < r.top + 2));
    if (rows.length) {
      const edge = down ? Math.min(...rows.map(o => o.r.top)) : Math.max(...rows.map(o => o.r.top));
      const row = rows.filter(o => Math.abs(o.r.top - edge) < 4);
      row.sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx));
      to = row[0].b;
    }
  }
  if (!to) return;
  if (narrow.matches) {
    brTabStop(to.dataset.key);
    to.focus({ preventScroll: true });
  } else {
    brSelect(to.dataset.key, { focus: true });
    brShowTop();
    // Say the sound the arrows stop on, not every one on the way there.
    engine.unlock();
    clearTimeout(arrowSay);
    arrowSay = setTimeout(() => { if (mode === "browse" && br.sel === to.dataset.key) sayFirstWord(br.sel, keyButton(br.sel)); }, 180);
    history.replaceState({ m: "browse", sel: to.dataset.key }, "", hashFor({ m: "browse", sel: to.dataset.key }));
  }
}

// =====================================================================================
// The letter sheet
// =====================================================================================

const sh = { key: null, opener: null, byKeyboard: false };

// A sheet shows a sound ("l:ق", "v:aa", "m:sukun") or a reference text ("ref:notes").
const REF = "ref:";
const isRef = k => typeof k === "string" && k.startsWith(REF);
const sheetable = k => (isRef(k) ? !!refHTML(k.slice(REF.length)) : !!soundOf(k));

function sheetShow(k) {
  if (!sheetable(k)) return;
  sh.key = k;
  if (isRef(k)) {
    const ref = refHTML(k.slice(REF.length));
    sheetBody.innerHTML = ref.html;
    $("sheet-pos").textContent = ref.title;
    sheet.setAttribute("aria-label", ref.title);
    sheet.dataset.from = "ref"; // no stepping; as tall as its text
  } else {
    const sound = soundOf(k);
    sheetBody.innerHTML = detailHTML(sound);
    mountMouths(sheetBody);
    $("sheet-pos").textContent = `${KEY_ORDER.indexOf(k) + 1} of ${KEY_ORDER.length}`;
    sheet.setAttribute("aria-label", `About ${sound.name}`);
    sheet.dataset.from = mode === "browse" ? "list" : "quiz";
  }
  if (!sheet.open) {
    document.documentElement.classList.add("sheet-open");
    sheet.showModal();
    // A text to read: the keyboard's Space, Page Down and arrows scroll it.
    if (isRef(k)) sheetBody.focus({ preventScroll: true });
  }
  sheetBody.scrollTop = 0;
  sheetFade();
}

/** The fade at the sheet's bottom edge says "more below"; at the end of the text it goes. */
function sheetFade() {
  sheet.classList.toggle("at-end", sheetBody.scrollTop + sheetBody.clientHeight >= sheetBody.scrollHeight - 2);
}
sheetBody.addEventListener("scroll", sheetFade, { passive: true });

function sheetHide() {
  if (!sheet.open) return;
  sheet.close();
  document.documentElement.classList.remove("sheet-open");
  sh.key = null;
  let back = sh.opener;
  sh.opener = null;
  // Opened with the mouse or a finger from a quiz, the keyboard goes back to Next (Enter goes on). Opened from
  // the keyboard, it returns to the link that opened the sheet.
  if (sheet.dataset.from === "quiz" && !(sh.byKeyboard && back && back.isConnected)) {
    const next = (mode === "place" ? mq.els : ear.els)?.next;
    if (next && !next.hasAttribute("data-off")) back = next;
  }
  if (back && back.isConnected) back.focus({ preventScroll: true });
}

function sheetStep(by) {
  if (sheet.dataset.from !== "list") return; // only the list's sheet steps through the sounds
  const i = KEY_ORDER.indexOf(sh.key);
  const k = KEY_ORDER[(i + by + KEY_ORDER.length) % KEY_ORDER.length];
  go({ m: mode, sheet: k }, { push: false });
  sayFirstWord(k);
}

/** Close the sheet the way Back does, so the two never disagree. */
const sheetDismiss = () => { if (history.state?.sheet) history.back(); else sheetHide(); };

sheet.addEventListener("cancel", e => { e.preventDefault(); sheetDismiss(); });
sheet.addEventListener("click", e => { if (e.target === sheet) sheetDismiss(); });

// =====================================================================================
// Modes and history
// =====================================================================================

let mode = null;
const MODE_HASH = { pairs: "#ear", place: "#mouth", browse: "#sounds" };
const MODE_LABEL = { pairs: "Ear quiz", place: "Mouth quiz", browse: "All sounds" };

const slugOfKey = k => {
  const s = soundOf(k);
  return !s ? "" : s.kind === "letter" ? s.letter.slug : s.kind === "vowel" ? `vowel-${s.vowel.id}` : `mark-${s.mark.id}`;
};
function keyOfSlug(slug) {
  const s = String(slug || "").toLowerCase();
  if (letterBySlug.has(s)) return keyOfLetter(letterBySlug.get(s).ch);
  if (s.startsWith("vowel-") && vowelById.has(s.slice(6))) return keyOfVowel(s.slice(6));
  if (s.startsWith("mark-") && soundOf(keyOfMark(s.slice(5)))) return keyOfMark(s.slice(5));
  const byChar = C.find(c => c.ch === String(slug).normalize("NFC"));
  return byChar ? keyOfLetter(byChar.ch) : null;
}
function hashFor(st) {
  if (st.sheet) return `#${isRef(st.sheet) ? st.sheet.slice(REF.length) : slugOfKey(st.sheet)}`;
  if (st.m === "browse" && st.sel) return `#${slugOfKey(st.sel)}`;
  return MODE_HASH[st.m] || location.pathname + location.search;
}

function setMode(m) {
  if (m === mode) return;
  const first = mode === null;
  mode = MODE_HASH[m] ? m : "pairs";
  document.body.dataset.mode = mode;
  for (const b of document.querySelectorAll("button[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  prefs.set("mode", mode);
  engine.stop();
  card.setAttribute("aria-label", MODE_LABEL[mode]);
  if (mode === "pairs") {
    if (!ear.els) earBuild();
    card.replaceChildren(ear.cardEl);
    surface.replaceChildren(ear.surfEl);
    surface.removeAttribute("data-pick");
    earRender();
  } else if (mode === "place") {
    if (!mq.els) mqBuild();
    card.replaceChildren(mq.cardEl);
    surface.replaceChildren(mq.surfEl);
    surface.setAttribute("data-pick", "");
    mqRender();
  } else if (!br.built) {
    brBuild();
  }
  measure();
  if (!first) scrollTo(0, 0);
}

function measure() {
  if (mode === "pairs") earMeasure();
  else if (mode === "place") mqMeasure();
  else if (mode === "browse") brMeasure();
}

/**
   Make the page match a history state. `restore` is for Back and Forward: the page returns to where it was
   scrolled when that entry was left. Never plays anything: only a tap or a key does.
*/
function apply(st, { restore = false } = {}) {
  const keyHadFocus = !!document.activeElement?.matches?.("#picker .k");
  setMode(st?.m || "pairs");
  if (mode === "browse" && !narrow.matches) {
    if (st?.sel && soundOf(st.sel) && st.sel !== br.sel) brSelect(st.sel);
    // The keyboard stays on the sound that is shown, so the next arrow key starts from it.
    if (keyHadFocus) keyButton(br.sel)?.focus({ preventScroll: true });
    if (restore) {
      if (typeof st?.y === "number") scrollTo(0, st.y);
      else brShowTop();
    }
  } else if (restore && typeof st?.y === "number") {
    scrollTo(0, st.y);
  }
  if (st?.sheet) sheetShow(st.sheet);
  else sheetHide();
  noteSound();
}

// Every history entry says what its screen shows, so no Back or Forward press can land on an entry that looks
// the same as the one before it. On wide screens an All sounds entry names its sound (the address may still be
// #sounds), and an entry that is left remembers how far the page was scrolled.
function noteSound() {
  const st = history.state;
  if (mode === "browse" && !narrow.matches && br.sel && st && st.m === "browse" && st.sel !== br.sel) history.replaceState({ ...st, sel: br.sel }, "");
}
function stampEntry() {
  const st = history.state;
  if (!st || !MODE_HASH[st.m]) return;
  const now = { ...st, y: Math.round(scrollY) };
  if (st.m === "browse" && !narrow.matches && br.sel) now.sel = br.sel;
  history.replaceState(now, "");
}

/** Go somewhere: a new history entry (or a replaced one) and the page to match. */
function go(st, { push = true } = {}) {
  if (push) {
    stampEntry();
    history.pushState(st, "", hashFor(st));
  } else {
    history.replaceState(st, "", hashFor(st));
  }
  apply(st);
}

function stateFromHash() {
  let h = location.hash.replace(/^#/, "");
  try { h = decodeURIComponent(h); } catch { /* keep as is */ }
  const m = Object.keys(MODE_HASH).find(k => MODE_HASH[k] === `#${h}`);
  if (m) return { m };
  if (sheetable(REF + h)) return { m: "browse", sheet: REF + h }; // #notes: a sheet at every width
  const k = keyOfSlug(h);
  if (k) return narrow.matches ? { m: "browse", sheet: k } : { m: "browse", sel: k };
  return null;
}

addEventListener("popstate", e => {
  let st = e.state;
  if (!st || !MODE_HASH[st.m]) {
    // An entry the page did not write (an address typed or followed by hand): make it one of ours, so the
    // address never says one thing while the screen shows another, and closing a sheet leaves the entry.
    st = stateFromHash() || { m: mode || "pairs" };
    history.replaceState(st, "", hashFor(st));
  }
  apply(st, { restore: true });
});

function openSheet(k, opener) {
  if (!sheetable(k)) return;
  sh.opener = opener || null;
  sh.byKeyboard = fromKeyboard();
  go({ m: mode, sheet: k });
}

/** The control the keyboard wants next in the activity on screen: Next after an answer, else play; in All sounds the chosen sound. */
function focusActivity() {
  const target = mode === "pairs" ? (ear.q.answered ? ear.els.next : ear.els.play)
    : mode === "place" ? (mq.q.picked ? mq.els.next : mq.els.say)
    : keyButton(br.sel) || picker.querySelector('.k[tabindex="0"]');
  target?.focus({ preventScroll: true });
}

function practise(pairId) {
  if (!pairById.has(pairId)) return;
  earPractise(pairId);
  go({ m: "pairs" }); // a new entry, so Back returns to the letter
  ear.els.play.focus({ preventScroll: true });
  if (!ear.q.played) earPlay();
}

// =====================================================================================
// Options, errors, events
// =====================================================================================

function initOptions() {
  const voice = $("voice");
  voice.value = voicePref;
  voice.addEventListener("change", () => {
    voicePref = voice.value;
    prefs.set("voice2", voicePref);
    engine.setVoice(plainVoice());
    if (ear.q) ear.q.voice = anyVoice();
    if (mq.q) mq.q.voice = anyVoice();
    // Let the new voice be heard at once.
    if (mode === "pairs") earPlay();
    else if (mode === "place") mqPlay();
    else if (br.sel) sayFirstWord(br.sel, keyButton(br.sel));
    releaseFocus(voice);
  });
  const slow = $("slow");
  slow.checked = prefs.get("speed", "normal") === "slow";
  engine.setSpeed(slow.checked ? "slow" : "normal");
  slow.addEventListener("change", () => {
    engine.setSpeed(slow.checked ? "slow" : "normal");
    prefs.set("speed", engine.speed);
    if (mode === "pairs" && ear.q.played) earPlay();
    else if (mode === "place" && mq.q.played) mqPlay();
    else if (mode === "browse" && br.sel) sayFirstWord(br.sel, keyButton(br.sel));
    releaseFocus(slow);
  });
}

// A setting changed with the mouse or a finger gives the keyboard back to the page, so R, 1 and 2
// work straight away. Changed from the keyboard, the control keeps the focus.
let lastKeyAt = -1e9;
addEventListener("keydown", () => { lastKeyAt = performance.now(); }, true);
const fromKeyboard = () => performance.now() - lastKeyAt <= 400;
// What the visitor is pointing with ("mouse", "touch" or "pen"): see earBadge.
let lastPointer = "mouse";
addEventListener("pointerdown", e => { lastPointer = e.pointerType || "mouse"; }, true);
function releaseFocus(control) {
  if (!fromKeyboard()) control.blur();
}

// An audio problem is told in the caption (or under the list), which has the room for it.
let errorShown = false;
engine.on("error", ({ message } = {}) => {
  const text = message || "Something went wrong with the audio. Please try again.";
  const retry = engine.state === "error" ? ' <button type="button" class="retry" data-retry>Try again</button>' : "";
  const slot = mode === "pairs" ? ear.els?.caption : mode === "place" ? mq.els?.caption : tip;
  if (!slot) return;
  slot.classList.remove("quiet");
  slot.classList.add("err");
  slot.innerHTML = esc(text) + retry;
  errorShown = true;
});
let audioStarted = false;
engine.on("start", () => {
  audioStarted = true;
  if (!errorShown) return;
  errorShown = false;
  if (mode === "pairs") earRender();
  else if (mode === "place") mqRender();
  else { tip.classList.remove("err"); tip.textContent = narrow.matches ? TIP : ""; }
});

document.addEventListener("click", e => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const hit = sel => t.closest(sel);
  let b;
  if ((b = hit("button[data-mode]"))) {
    if (b.dataset.mode !== mode) {
      go({ m: b.dataset.mode });
      if (fromKeyboard()) focusActivity();
    }
    releaseFocus(b);
  } else if (hit("[data-retry]")) {
    engine.reload();
  } else if ((b = hit("[data-more]"))) {
    e.preventDefault();
    const c = letterBySlug.get(b.dataset.more);
    if (c) openSheet(keyOfLetter(c.ch), b);
  } else if ((b = hit("[data-ref]"))) {
    openSheet(REF + b.dataset.ref, b);
  } else if ((b = hit("[data-practise]"))) {
    practise(b.dataset.practise);
  } else if (hit('[data-ui="sheet-close"]')) {
    sheetDismiss();
  } else if (hit('[data-ui="sheet-prev"]')) {
    sheetStep(-1);
  } else if (hit('[data-ui="sheet-next"]')) {
    sheetStep(1);
  } else if (hit('[data-ui="play"]')) {
    earPlay();
  } else if ((b = hit('[data-ui="choice"]'))) {
    earAnswer(b.dataset.choice);
  } else if (hit('[data-ui="next"]')) {
    if (mode === "place") mqNext();
    else earNext();
  } else if (hit('#card [data-ui="say"]')) {
    mqPlay();
  } else if ((b = hit('[data-ui="place"]'))) {
    mqPick(b.dataset.place);
  } else if (mode === "place" && (b = hit("#surface .mo-mk, #surface .mo-badge"))) {
    mqPick(b.dataset.place);
  } else if (mode === "pairs" && (b = hit("#surface .mo-badge"))) {
    earBadge(b.dataset.label === "2" ? "b" : "a");
  } else if ((b = hit(".k[data-key]"))) {
    // A tap on a sound shows it and says it (again, if it is already the one shown).
    const k = b.dataset.key;
    if (narrow.matches) {
      brTabStop(k);
      openSheet(k, b);
    } else if (k !== br.sel) {
      // Another sound is another entry: Back shows the one before. (The arrow keys step without adding entries.)
      stampEntry();
      brSelect(k);
      brShowTop();
      history.pushState({ m: "browse", sel: k }, "", hashFor({ m: "browse", sel: k }));
    }
    sayFirstWord(k, b);
  } else if ((b = hit("[data-say]"))) {
    say(b.dataset.say, b);
  }
});

document.addEventListener("keydown", e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t && t.closest('textarea, input:not([type="checkbox"])')) return;
  const inMenu = !!(t && t.closest("select"));
  // In a menu only the page's own letter and number keys are taken (they would otherwise jump to
  // an option that starts with that letter); arrows, Enter and Space stay with the menu.
  if (inMenu && !/^[a-z0-9]$/i.test(e.key)) return;
  if (sheet.open) {
    if (e.key === "ArrowRight") sheetStep(1);
    else if (e.key === "ArrowLeft") sheetStep(-1);
    return;
  }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Enter and Space on a button or link belong to that control. The tab of the activity that is
  // already showing has nothing left to do, so Enter there is the quiz's own key (play, or next).
  const onOwnTab = !!(t && t.closest('button[data-mode][aria-pressed="true"]'));
  if ((k === "Enter" || k === " ") && t && t.closest("button, a, summary") && !(k === "Enter" && onOwnTab)) return;
  let used = true;
  if (mode === "pairs") {
    if (k === "r") earPlay();
    else if (k === "1") earAnswer("a");
    else if (k === "2") earAnswer("b");
    else if ((k === "Enter" || k === "n") && ear.q.answered) earNext();
    else if (k === "Enter" && !ear.q.answered) earPlay();
    else used = inMenu;
  } else if (mode === "place") {
    if (k === "r") mqPlay();
    else if (/^[1-8]$/.test(k)) mqPick(PLACES[Number(k) - 1].id);
    else if ((k === "Enter" || k === "n") && mq.q.picked) mqNext();
    else if (k === "Enter" && !mq.q.picked) mqPlay();
    else used = inMenu;
  } else if (mode === "browse" && t && t.matches(".k") && k.startsWith("Arrow")) {
    brArrow(t, k);
  } else {
    used = false;
  }
  if (used) e.preventDefault();
});

let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(measure, 120);
});
narrow.addEventListener("change", () => {
  if (mode === "browse") measure();
});

// ---------- start ----------

initOptions();

history.scrollRestoration = "manual";
const kept = history.state && MODE_HASH[history.state.m] ? history.state : null;
const fromHash = kept ? null : stateFromHash();
if (kept) {
  // A reload: the same screen as before, the letter sheet included.
  apply(kept);
} else if (fromHash?.sheet) {
  // A link to a letter on a phone: the list is underneath, so Back closes the sheet and stays here.
  history.replaceState({ m: "browse" }, "", MODE_HASH.browse);
  history.pushState(fromHash, "", hashFor(fromHash));
  apply(fromHash);
} else if (fromHash) {
  history.replaceState(fromHash, "", hashFor(fromHash));
  apply(fromHash);
} else {
  const st = { m: MODE_HASH[prefs.get("mode", "pairs")] ? prefs.get("mode", "pairs") : "pairs" };
  history.replaceState(st, "", location.pathname + location.search);
  apply(st);
}
document.fonts?.ready.then(measure);

// "Save audio for offline use" in the footer; it also registers the service worker.
import("./offline.js")
  .then(m => m.initOffline({ root: $("offline-root"), engine }))
  .catch(err => console.warn("[app] offline saving is unavailable:", err));
