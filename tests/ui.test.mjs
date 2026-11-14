// UI contract: the rules a visitor feels, measured in a real browser at phone, tablet and desktop
// sizes. It drives the three modes and fails when
//
//   - a tap changes something the visitor cannot see, or nothing at all       (DEAD_TAP, OFFSCREEN_EFFECT)
//   - the page scrolls by itself                                              (SCROLL_JUMP)
//   - the tapped control, or any other control on screen, moves               (MOVED_UNDER_FINGER, LAYOUT_SHIFT)
//   - what is needed for the current step does not fit on one screen
//   - a region changes size between questions or when the answer is shown
//   - Back leaves the site, or a letter's details replace the quiz instead of opening over it
//   - a control is too small to tap, overlaps another, is cut off, or text is clipped or tiny
//
// Needs playwright-core and a local Chrome (see tests/ui/browser.mjs); skipped when either is missing.
// The measuring code is shared with the simulated-user driver (tests/ui/sim.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { findChrome, loadChromium, launch, serve } from "./ui/browser.mjs";
import { pageInit, measure, staticFaults } from "./ui/measure.mjs";

const skip = !(await loadChromium()) ? "playwright-core is not installed" : !findChrome() ? "no Chrome found (set CHROME_PATH)" : false;

const SCREENS = [
  { name: "phone 360x640", w: 360, h: 640, touch: true },
  { name: "phone 390x664", w: 390, h: 664, touch: true },
  { name: "tablet 768x1024", w: 768, h: 1024, touch: true },
  { name: "window 800x841", w: 800, h: 841, touch: false },
  { name: "desktop 1024x768", w: 1024, h: 768, touch: false },
  { name: "laptop 1366x650", w: 1366, h: 650, touch: false },
];
const NARROW = 640; // at or below this width All sounds shows a letter in a sheet over the picker

let browser, site;
test.before(async () => {
  if (skip) return;
  [browser, site] = await Promise.all([launch(), serve()]);
});
test.after(async () => {
  await browser?.close();
  site?.stop();
});

// ---------- helpers ----------

async function open(screen, hash = "") {
  const context = await browser.newContext({
    viewport: { width: screen.w, height: screen.h },
    hasTouch: screen.touch,
    isMobile: screen.touch,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(pageInit);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.message || e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(site.url + hash, { waitUntil: "load" });
  await page.waitForSelector('button[data-mode][aria-pressed="true"]', { timeout: 10000 });
  await page.waitForTimeout(400);
  return { page, context, errors, screen };
}

const box = async (page, selector) => {
  const el = page.locator(selector).first();
  assert.ok(await el.count(), `${selector} exists`);
  const b = await el.boundingBox();
  assert.ok(b, `${selector} is rendered`);
  return b;
};

/** The whole of `selector` is on screen, without scrolling. */
async function onScreen(s, selector, what = selector) {
  const b = await box(s.page, selector);
  const y = await s.page.evaluate(() => scrollY);
  assert.equal(y, 0, `${s.screen.name}: the page is not scrolled when checking ${what}`);
  assert.ok(b.x >= -0.5 && b.x + b.width <= s.screen.w + 0.5, `${s.screen.name}: ${what} fits the width (x ${b.x.toFixed(0)}, w ${b.width.toFixed(0)})`);
  assert.ok(b.y >= -0.5 && b.y + b.height <= s.screen.h + 0.5, `${s.screen.name}: ${what} fits on one screen (ends at ${(b.y + b.height).toFixed(0)} of ${s.screen.h} px)`);
  return b;
}

const bad = (flags, allow = []) => flags.filter(f => f.sev >= 2 && !allow.includes(f.code));

/** Tap the middle of `selector` like a visitor and return the measurement. The control must be on screen. */
async function tap(s, selector, { allow = [], what = selector, mustChange = true } = {}) {
  const b = await box(s.page, selector);
  const point = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  assert.ok(point.x >= 0 && point.x <= s.screen.w && point.y >= 0 && point.y <= s.screen.h, `${s.screen.name}: ${what} can be tapped without scrolling (it is at y ${point.y})`);
  const m = await measure(s.page, {
    type: "tap", point, touch: s.screen.touch,
    run: () => (s.screen.touch ? s.page.touchscreen.tap(point.x, point.y) : s.page.mouse.click(point.x, point.y)),
  });
  const flags = bad(m.flags, mustChange ? allow : [...allow, "DEAD_TAP"]);
  assert.deepEqual(flags.map(f => `${f.code}: ${f.msg}`), [], `${s.screen.name}: tapping ${what}`);
  return m;
}

async function press(s, key, { allow = [] } = {}) {
  const m = await measure(s.page, { type: "key", key, touch: s.screen.touch, run: () => s.page.keyboard.press(key) });
  assert.deepEqual(bad(m.flags, allow).map(f => `${f.code}: ${f.msg}`), [], `${s.screen.name}: pressing ${key}`);
  return m;
}

/** Switching mode redraws the page below the mode bar, so only the bar itself has to stay put. */
async function mode(s, name) {
  const before = await box(s.page, `button[data-mode="${name}"]`);
  await tap(s, `button[data-mode="${name}"]`, { allow: ["LAYOUT_SHIFT", "RESULT_CUT_OFF", "OFFSCREEN_EFFECT"], what: `the ${name} mode button`, mustChange: false });
  const after = await box(s.page, `button[data-mode="${name}"]`);
  assert.deepEqual([after.x, after.y].map(Math.round), [before.x, before.y].map(Math.round), `${s.screen.name}: the mode bar stays where it is`);
  assert.equal(await s.page.locator(`button[data-mode="${name}"]`).getAttribute("aria-pressed"), "true");
  await s.page.evaluate(() => scrollTo(0, 0));
}

async function noStaticFaults(s, where) {
  const faults = (await staticFaults(s.page, s.screen.touch)).filter(f => f.sev >= 2 || f.code === "TINY_TEXT");
  assert.deepEqual(faults.map(f => `${f.code}: ${f.msg}`), [], `${s.screen.name}: layout faults in ${where}`);
}

const rects = (page, selectors) => page.evaluate(sel => sel.map(q => {
  const el = document.querySelector(q);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
}), selectors);

const heard = m => (m.res.audio || []).length;

/** A quiz fits its screen with room to spare: the picture is not squeezed to its minimum, and nothing pokes out of its panel. */
async function quizFits(s, what) {
  const m = await s.page.evaluate(() => {
    const r = q => document.querySelector(q).getBoundingClientRect();
    const surf = document.querySelector("#surface");
    return {
      pic: r("#surface .pic").height, under: r("#surface .under").bottom,
      inner: surf.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(surf).paddingBottom) || 0),
      next: r('[data-ui="next"]').bottom, vh: innerHeight,
    };
  });
  assert.ok(m.pic >= 155, `${s.screen.name}: the picture in ${what} is ${Math.round(m.pic)} px tall (at least 155)`);
  assert.ok(m.under <= m.inner + 0.5, `${s.screen.name}: the caption and Next stay inside the panel in ${what} (${m.under.toFixed(1)} of ${m.inner.toFixed(1)})`);
  assert.ok(m.next <= m.vh - 6, `${s.screen.name}: Next ends ${Math.round(m.vh - m.next)} px above the screen's edge in ${what}`);
}

/** What the screen shows, for "did this Back press change anything?". */
const screenState = page => page.evaluate(() => {
  const sheet = document.getElementById("sheet");
  return [
    location.hash,
    document.querySelector('button[data-mode][aria-pressed="true"]')?.dataset.mode,
    document.body.dataset.mode === "browse" ? document.querySelector('#picker .k[aria-pressed="true"]')?.dataset.key || "" : "",
    document.body.dataset.mode === "browse" ? document.querySelector('#detail [data-ui="detail-title"]')?.textContent || "" : "",
    sheet.open ? sheet.querySelector('[data-ui="detail-title"]')?.textContent || document.getElementById("sheet-pos").textContent : "",
  ].join(" | ");
});

/** Count sounds started from now on (the page's Web Audio sources). */
const countPlays = page => page.evaluate(() => {
  if (!window.__plays) {
    window.__plays = { n: 0 };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { window.__plays.n++; return start.apply(this, a); };
  }
  return window.__plays.n;
});

// Windows where the list of sounds is pinned while its card scrolls.
const PINNED = [{ name: "smallest pinned window 641x760", w: 641, h: 760, touch: false }, SCREENS[2], SCREENS[3], SCREENS[4]];

// ---------- the three modes on every screen ----------

for (const screen of SCREENS) {
  test(`hear the difference: ${screen.name}`, { skip }, async () => {
    const s = await open(screen);
    try {
      assert.equal(await s.page.locator('button[data-mode="pairs"]').getAttribute("aria-pressed"), "true", "the listening drill is the first thing a visitor gets");
      // Everything for the step is on one screen: play, both choices, the picture and its caption.
      await onScreen(s, '[data-ui="play"]', "the play button");
      await onScreen(s, '[data-ui="choice"][data-choice="a"]', "the first choice");
      await onScreen(s, '[data-ui="choice"][data-choice="b"]', "the second choice");
      await onScreen(s, "#surface", "the picture under the question");
      await onScreen(s, "#voice", "the voice menu");
      await onScreen(s, "#slow", "the slow switch");
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0, `${screen.name}: the quiz is one screen, with nothing to scroll to`);
      await quizFits(s, "the ear quiz");
      await noStaticFaults(s, "hear the difference");

      const frame = ["#card", "#surface", '[data-ui="play"]', '[data-ui="choice"][data-choice="a"]', '[data-ui="choice"][data-choice="b"]', '[data-ui="next"]'];
      const first = await rects(s.page, frame);
      // A word tapped before anything was played plays the question; it is not scored as a blind guess.
      const early = await tap(s, '[data-ui="choice"][data-choice="a"]', { what: "a word before playing" });
      assert.ok(heard(early), `${screen.name}: the first tap on a word plays the question`);
      assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false", "nothing is scored before the word was heard");
      assert.deepEqual(await rects(s.page, frame), first);
      for (let round = 0; round < 3; round++) {
        const played = await tap(s, '[data-ui="play"]', { what: "play" });
        assert.ok(heard(played), `${screen.name}: play makes a sound`);
        const pick = round % 2 ? "b" : "a";
        await tap(s, `[data-ui="choice"][data-choice="${pick}"]`, { what: `choice ${pick}` });
        assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true");
        await onScreen(s, '[data-ui="status"]', "the verdict");
        await onScreen(s, '[data-ui="next"]', "the next button");
        assert.equal((await s.page.locator('[data-ui="next"]').innerText()).trim(), "Next", "after an answer the button says Next");
        assert.deepEqual(await rects(s.page, frame), first, `${screen.name}: nothing changes size or place when the answer is shown`);
        await quizFits(s, "the answered ear quiz");
        // "More about": its pills are on one row, big enough for the pointer in use, and clear of Next.
        const pills = await s.page.locator('#surface [data-ui="more"] .pill').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { y: Math.round(r.y), h: r.height, right: r.right }; }));
        if (pills.length) {
          const nextBox = await box(s.page, '[data-ui="next"]');
          assert.ok(pills.every(p => p.y === pills[0].y), `${screen.name}: the More about pills share one row`);
          assert.ok(pills.every(p => p.h >= (screen.touch ? 40 : 32) - 0.5), `${screen.name}: the pills are tall enough (${pills.map(p => p.h)})`);
          assert.ok(pills.every(p => p.right <= nextBox.x - 6), `${screen.name}: the pills stay clear of Next`);
        }
        // After the answer a choice replays its word: no dead controls.
        const again = await tap(s, `[data-ui="choice"][data-choice="${pick === "a" ? "b" : "a"}"]`, { what: "a choice after answering" });
        assert.ok(heard(again), `${screen.name}: a choice replays its word after the answer`);
        await tap(s, '[data-ui="next"]', { what: "next" });
        assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false");
        assert.deepEqual(await rects(s.page, frame), first, `${screen.name}: the next question has the same frame`);
      }
      assert.deepEqual(s.errors, [], "no console errors or failed requests");
    } finally {
      await s.context.close();
    }
  });

  test(`mouth quiz: ${screen.name}`, { skip }, async () => {
    const s = await open(screen);
    try {
      await mode(s, "place");
      await onScreen(s, "#card", "the question");
      await onScreen(s, "#surface", "the mouth, the eight places and the caption");
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0, `${screen.name}: the quiz is one screen, with nothing to scroll to`);
      await quizFits(s, "the mouth quiz");
      await noStaticFaults(s, "the mouth quiz");
      assert.equal(await s.page.locator('[data-ui="place"]').count(), 8, "eight place buttons");
      const frame = ["#card", "#surface", "#surface svg.mo", '[data-ui="place"][data-place="lab"]', '[data-ui="place"][data-place="glo"]', '[data-ui="next"]'];
      const first = await rects(s.page, frame);
      const places = ["pha", "alv", "lab", "glo"];
      for (let round = 0; round < 3; round++) {
        const said = await tap(s, '#card [data-ui="say"]', { what: "the example word" });
        assert.ok(heard(said), `${screen.name}: the word plays`);
        if (round === 1 && !screen.touch) {
          // With a mouse a spot on the picture answers too.
          await tap(s, `#surface .mo-mk[data-place="${places[round]}"]`, { what: `the ${places[round]} spot on the mouth` });
        } else {
          await tap(s, `[data-ui="place"][data-place="${places[round]}"]`, { what: `the ${places[round]} place button` });
        }
        assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true");
        await onScreen(s, '[data-ui="status"]', "the verdict");
        await onScreen(s, '[data-ui="next"]', "the next button");
        await onScreen(s, "#surface svg.mo", "the mouth, with the right place shown");
        assert.deepEqual(await rects(s.page, frame), first, `${screen.name}: nothing changes size or place when the answer is shown`);
        // Another place after the answer still does something (it shows that place).
        await tap(s, `[data-ui="place"][data-place="${places[round + 1]}"]`, { what: "another place after answering" });
        assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true", "looking at another place is not a second answer");
        assert.deepEqual(await rects(s.page, frame), first);
        await tap(s, '[data-ui="next"]', { what: "next" });
        assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false");
        assert.deepEqual(await rects(s.page, frame), first, `${screen.name}: the next question has the same frame`);
      }
      assert.deepEqual(s.errors, [], "no console errors or failed requests");
    } finally {
      await s.context.close();
    }
  });

  test(`all sounds: ${screen.name}`, { skip }, async () => {
    const s = await open(screen);
    try {
      await mode(s, "browse");
      await onScreen(s, '[data-ui="picker"]', "the whole list of sounds");
      await noStaticFaults(s, "all sounds");
      const keys = await s.page.locator('[data-ui="picker"] .k[data-key]').evaluateAll(els => els.map(e => e.dataset.key));
      assert.equal(keys.length, 40, "28 letters, 8 vowels and 4 marks are in the list");
      if (screen.w <= NARROW) await onScreen(s, "#tip", "the line that says what a tap does");
      // Group labels: one line each, none on top of another, and the ridge letters' second group says "Also".
      const labs = await s.page.locator('[data-ui="picker"] .lab').evaluateAll(els => els.map(e => { const range = document.createRange(); range.selectNodeContents(e); const r = range.getBoundingClientRect(); return { t: e.textContent, x: r.x, y: r.y, w: r.width, h: r.height }; }));
      assert.ok(labs.every(l => l.h <= 15), `${screen.name}: every group label is one line (${labs.filter(l => l.h > 15).map(l => l.t)})`);
      assert.equal(labs.filter(l => l.t === "Behind teeth").length, 1, "one group is called Behind teeth");
      assert.equal(labs.filter(l => l.t === "Also behind teeth").length, 1, "its continuation says Also");
      for (const a of labs) for (const b of labs) {
        if (a !== b && Math.abs(a.y - b.y) < 2) assert.ok(a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5, `${screen.name}: the labels "${a.t}" and "${b.t}" do not run into each other`);
      }
      // Not the first key first: it is the one shown on arrival.
      const sample = [keys[9], keys[27], keys[keys.length - 1], keys[20], keys[0], keys[1]];
      const pickerBefore = await rects(s.page, ['[data-ui="picker"]']);

      if (screen.w > NARROW) {
        // Picker first, the letter right under it: a tap changes what is directly below, nothing moves.
        const detail = await box(s.page, "#detail");
        const picker = await box(s.page, '[data-ui="picker"]');
        assert.ok(detail.y >= picker.y + picker.height - 1, `${screen.name}: the letter's details come after the list, not before it`);
        assert.ok(screen.h - detail.y >= 150, `${screen.name}: at least 150 px of the details are on screen under the list (${Math.round(screen.h - detail.y)} px)`);
        let lastTitle = await s.page.locator('#detail [data-ui="detail-title"]').innerText();
        // The details stay where they are; only their length may differ, and nothing but the footer is below them.
        const place = async () => (await rects(s.page, ["#detail"]))[0].slice(0, 3);
        const detailBefore = await place();
        for (const k of sample) {
          await tap(s, `[data-ui="picker"] .k[data-key="${k}"]`, { what: `sound ${k}`, allow: ["RESULT_CUT_OFF"] });
          const title = await s.page.locator('#detail [data-ui="detail-title"]').innerText();
          assert.notEqual(title, lastTitle, `${screen.name}: the details changed to the tapped sound`);
          lastTitle = title;
          await onScreen(s, '#detail [data-ui="detail-title"]', "the name of the tapped sound");
          assert.deepEqual(await rects(s.page, ['[data-ui="picker"]']), pickerBefore, `${screen.name}: the list stays put`);
          assert.deepEqual(await place(), detailBefore, `${screen.name}: the details stay in the same place`);
          assert.equal(await s.page.locator(`[data-ui="picker"] .k[data-key="${k}"]`).getAttribute("aria-pressed"), "true");
        }
        // The sound that is already shown is not a dead key: tapping it says it again.
        const again = await tap(s, `[data-ui="picker"] .k[data-key="${sample[sample.length - 1]}"]`, { what: "the sound already shown" });
        assert.ok(heard(again), `${screen.name}: tapping the shown sound plays it`);
        const word = await tap(s, "#detail [data-say]", { what: "an example word" });
        assert.ok(heard(word), `${screen.name}: an example word plays`);
      } else {
        // Phones: the list is the screen; a letter opens in a sheet over it and nothing behind moves.
        for (const k of sample.slice(0, 4)) {
          await tap(s, `[data-ui="picker"] .k[data-key="${k}"]`, { what: `sound ${k}`, allow: ["LAYOUT_SHIFT"] });
          const sheet = await box(s.page, '[data-ui="sheet"]');
          assert.ok(sheet.y >= 0 && sheet.y + sheet.height <= screen.h + 0.5, `${screen.name}: the sheet is on screen`);
          await onScreen(s, '[data-ui="sheet"] [data-ui="detail-title"]', "the name of the tapped sound");
          await onScreen(s, '[data-ui="sheet-close"]', "the close button");
          assert.deepEqual(await rects(s.page, ['[data-ui="picker"]']), pickerBefore, `${screen.name}: the list behind the sheet stays put`);
          const title = await s.page.locator('[data-ui="sheet"] [data-ui="detail-title"]').innerText();
          await tap(s, '[data-ui="sheet-next"]', { what: "next sound in the sheet" });
          assert.notEqual(await s.page.locator('[data-ui="sheet"] [data-ui="detail-title"]').innerText(), title, "the sheet steps to the next sound");
          const word = await tap(s, '[data-ui="sheet"] [data-say]', { what: "an example word" });
          assert.ok(heard(word), `${screen.name}: an example word plays`);
          await tap(s, '[data-ui="sheet-close"]', { what: "close", allow: ["LAYOUT_SHIFT"] });
          assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), false, "the sheet closes");
          assert.deepEqual(await rects(s.page, ['[data-ui="picker"]']), pickerBefore);
        }
      }
      assert.deepEqual(s.errors, [], "no console errors or failed requests");
    } finally {
      await s.context.close();
    }
  });
}

// ---------- reserved space is big enough for every pair, letter and place ----------

test("no text outgrows its reserved space, on any screen", { skip }, async () => {
  for (const screen of SCREENS) {
    const s = await open(screen);
    try {
      // Walk many questions of every kind and require one frame for all of them.
      await s.page.selectOption("#set", "all");
      await s.page.locator("body").click({ position: { x: 2, y: 2 } });
      await s.page.keyboard.press("r");
      const frame = ["#card", "#surface"];
      const first = await rects(s.page, frame);
      for (let i = 0; i < 26; i++) {
        await s.page.keyboard.press("1");
        assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true");
        assert.deepEqual(await rects(s.page, frame), first, `${screen.name}: answered question ${i + 1} keeps the frame`);
        await s.page.keyboard.press("Enter");
        assert.deepEqual(await rects(s.page, frame), first, `${screen.name}: question ${i + 2} keeps the frame`);
      }
      const clipped = (await staticFaults(s.page, screen.touch)).filter(f => f.code === "CLIPPED_TEXT" || f.code === "OVERFLOW_X");
      assert.deepEqual(clipped.map(f => f.msg), [], `${screen.name}: clipped text in the listening drill`);

      await s.page.locator('button[data-mode="place"]').click();
      const frame2 = ["#card", "#surface"];
      const first2 = await rects(s.page, frame2);
      for (let i = 0; i < 30; i++) {
        await s.page.locator('#surface .mo-mk[data-place="pal"]').dispatchEvent("click");
        assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true", "a click on a spot of the mouth answers");
        assert.deepEqual(await rects(s.page, frame2), first2, `${screen.name}: answered mouth question ${i + 1} keeps the frame`);
        await s.page.keyboard.press("Enter");
        assert.deepEqual(await rects(s.page, frame2), first2, `${screen.name}: mouth question ${i + 2} keeps the frame`);
      }
      const clipped2 = (await staticFaults(s.page, screen.touch)).filter(f => f.code === "CLIPPED_TEXT" || f.code === "OVERFLOW_X");
      assert.deepEqual(clipped2.map(f => f.msg), [], `${screen.name}: clipped text in the mouth drill`);
    } finally {
      await s.context.close();
    }
  }
});

// ---------- keyboard, deep links, going back, the letter sheet ----------

test("keyboard: R replays, 1 and 2 answer, Enter goes on, focus stays visible", { skip }, async () => {
  const s = await open(SCREENS[3]);
  try {
    const r = await press(s, "r");
    assert.ok(heard(r), "R plays the word");
    await press(s, "2");
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true");
    const again = await press(s, "1");
    assert.ok(heard(again), "after the answer 1 replays the first word");
    const words = await s.page.locator('[data-ui="choice"]').allInnerTexts();
    let changed = false;
    for (let i = 0; i < 8 && !changed; i++) {
      await press(s, "Enter", { allow: ["LAYOUT_SHIFT"] });
      assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false", "Enter moves to a new question");
      changed = (await s.page.locator('[data-ui="choice"]').allInnerTexts()).join() !== words.join();
      if (!changed) await press(s, "1");
    }
    assert.ok(changed, "new questions bring new words");

    const focusShown = () => s.page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      const st = getComputedStyle(el);
      return (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0) || st.boxShadow !== "none";
    });
    // Answer with a focused choice: the focus must not vanish, and Enter must not skip the answer.
    await s.page.locator('[data-ui="choice"][data-choice="a"]').focus();
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true", "Enter on a choice answers");
    assert.ok(await focusShown(), "focus is still visible after answering");

    // Mouth quiz: number keys answer; Enter on a focused place answers once and does not jump to the next question.
    await s.page.locator('button[data-mode="place"]').click();
    await press(s, "7", { allow: ["LAYOUT_SHIFT"] });
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true", "7 picks the throat");
    await press(s, "n", { allow: ["LAYOUT_SHIFT"] });
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false", "N goes on");
    await s.page.locator('[data-ui="place"][data-place="alv"]').focus();
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(300);
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true", "Enter on a place answers and stays on the answer");
    assert.ok(await focusShown(), "focus is still visible after answering");
  } finally {
    await s.context.close();
  }
});

test("keyboard in the menu: R plays instead of jumping to an option, and Enter plays an unheard question", { skip }, async () => {
  const s = await open(SCREENS[3]);
  try {
    const enter = await press(s, "Enter");
    assert.ok(heard(enter), "Enter plays the word when nothing was heard yet");
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false");
    await s.page.locator("#set").focus();
    await s.page.keyboard.press("ArrowDown");
    const chosen = await s.page.locator("#set").inputValue();
    const r = await press(s, "r");
    assert.ok(heard(r), "R plays while the menu has the focus");
    assert.equal(await s.page.locator("#set").inputValue(), chosen, "R did not change the menu");
  } finally {
    await s.context.close();
  }
});

test("shortcuts still work after a setting was changed with the mouse", { skip }, async () => {
  const s = await open(SCREENS[3]);
  try {
    await s.page.locator("#slow").click();
    const r = await press(s, "r");
    assert.ok(heard(r), "R plays after ticking Slow");
    await s.page.selectOption("#set", "length");
    await press(s, "r");
    await press(s, "1");
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true", "1 answers after choosing a set");
    assert.equal(await s.page.locator("#set").inputValue(), "length", "the key did not change the menu");
  } finally {
    await s.context.close();
  }
});

test("the pinned list never moves under the pointer, from the tallest card to the shortest, at the very bottom of the page", { skip }, async () => {
  for (const screen of PINNED) {
    const s = await open(screen, "#hamza");
    try {
      const top = () => s.page.evaluate(() => Math.round(document.getElementById("picker").getBoundingClientRect().top));
      assert.equal(await s.page.evaluate(() => getComputedStyle(document.getElementById("picker")).position), "sticky", `${screen.name}: the list is pinned here`);
      await s.page.evaluate(() => scrollTo(0, 1e6));
      await s.page.waitForTimeout(300);
      assert.equal(await top(), 8, `${screen.name}: at the bottom of the page the list is still pinned, not half pushed off`);
      // Tallest card (hamza) to the shortest (short i): the page must scroll to show it, the key must not move.
      const key = '[data-ui="picker"] .k[data-key="v:i"]';
      const before = await box(s.page, key);
      await tap(s, key, { what: "a pinned key at the bottom of the page", allow: ["RESULT_CUT_OFF"] });
      const after = await box(s.page, key);
      assert.ok(Math.abs(after.y - before.y) <= 1 && Math.abs(after.x - before.x) <= 1, `${screen.name}: the key stays under the pointer (moved ${Math.round(after.y - before.y)} px)`);
      assert.equal(await top(), 8, `${screen.name}: the list is still pinned after the tap`);
      const title = await box(s.page, '#detail [data-ui="detail-title"]');
      const picker = await box(s.page, '[data-ui="picker"]');
      assert.ok(title.y >= picker.y + picker.height && title.y + title.height <= screen.h, `${screen.name}: the chosen sound's name is on screen, under the list`);
      // The same from the keyboard.
      await s.page.locator('[data-ui="picker"] .k[data-key="l:ء"]').click();
      await s.page.evaluate(() => scrollTo(0, 1e6));
      await s.page.waitForTimeout(300);
      await s.page.locator('[data-ui="picker"] .k[data-key="l:ء"]').focus();
      const kb = await box(s.page, '[data-ui="picker"] .k[data-key="l:ء"]');
      await s.page.keyboard.press("ArrowRight");
      await s.page.waitForTimeout(400);
      const ka = await box(s.page, '[data-ui="picker"] .k[data-key="l:ء"]');
      assert.ok(Math.abs(ka.y - kb.y) <= 1, `${screen.name}: an arrow key does not move the list either`);
      assert.equal(await top(), 8);
      // Back shows the sound before, where it was left; the list stays pinned through Back and Forward.
      await s.page.goBack();
      await s.page.waitForTimeout(400);
      assert.equal(await top(), 8, `${screen.name}: the list is pinned after Back`);
      await s.page.goForward();
      await s.page.waitForTimeout(400);
      assert.equal(await top(), 8, `${screen.name}: and after Forward`);
      assert.ok(await s.page.evaluate(() => scrollY <= document.documentElement.scrollHeight - innerHeight + 1), "the page is not scrolled past its end");
      assert.deepEqual(s.errors, []);
    } finally {
      await s.context.close();
    }
  }
});

test("a sound chosen from the pinned list while scrolled shows from its top, and the list does not move", { skip }, async () => {
  const s = await open(SCREENS[3], "#qaf");
  try {
    await s.page.mouse.move(400, 600);
    await s.page.mouse.wheel(0, 420);
    await s.page.waitForTimeout(400);
    const key = '[data-ui="picker"] .k[data-key="l:ص"]';
    const before = await box(s.page, key);
    assert.ok(before.y >= 0 && before.y < 200, "the list is pinned at the top while the page is scrolled");
    const m = await measure(s.page, {
      type: "tap", point: { x: before.x + before.width / 2, y: before.y + before.height / 2 }, touch: false,
      run: () => s.page.mouse.click(before.x + before.width / 2, before.y + before.height / 2),
    });
    assert.deepEqual(bad(m.flags, ["RESULT_CUT_OFF"]).map(f => `${f.code}: ${f.msg}`), [], "tapping a pinned key while scrolled");
    const after = await box(s.page, key);
    assert.ok(Math.abs(after.y - before.y) <= 1 && Math.abs(after.x - before.x) <= 1, "the key stays under the pointer");
    const title = await box(s.page, '#detail [data-ui="detail-title"]');
    const picker = await box(s.page, '[data-ui="picker"]');
    assert.ok(title.y >= picker.y + picker.height, "the new sound's name is below the list, not behind it");
    assert.ok(title.y + title.height <= SCREENS[3].h, "and on screen");
    assert.match(await s.page.locator('#detail [data-ui="detail-title"]').innerText(), /ṣād/);
  } finally {
    await s.context.close();
  }
});

test("Back steps through the modes and never drops out of the site by surprise", { skip }, async () => {
  const s = await open(SCREENS[3]);
  try {
    const pressed = () => s.page.locator('button[data-mode][aria-pressed="true"]').getAttribute("data-mode");
    await mode(s, "place");
    await mode(s, "browse");
    await s.page.goBack();
    await s.page.waitForTimeout(300);
    assert.equal(await pressed(), "place", "Back returns to the mouth quiz");
    await s.page.goBack();
    await s.page.waitForTimeout(300);
    assert.equal(await pressed(), "pairs", "Back returns to the ear quiz");
    assert.ok(s.page.url().startsWith(site.url), "still on the site");
    assert.equal(await s.page.evaluate(() => scrollY), 0, "going back does not scroll the page");
  } finally {
    await s.context.close();
  }
});

test("deep link #ayn opens that letter, on desktop and on a phone", { skip }, async () => {
  for (const screen of [SCREENS[3], SCREENS[1]]) {
    const s = await open(screen, "#ayn");
    try {
      assert.equal(await s.page.locator('button[data-mode="browse"]').getAttribute("aria-pressed"), "true", `${screen.name}: All sounds is open`);
      const scope = screen.w > NARROW ? "#detail " : '[data-ui="sheet"] ';
      const title = await s.page.locator(`${scope}[data-ui="detail-title"]`).innerText();
      assert.match(title, /ʿayn/, `${screen.name}: the letter shown is ʿayn`);
      await onScreen(s, `${scope}[data-ui="detail-title"]`, "the letter's name");
      if (screen.w <= NARROW) {
        await s.page.goBack().catch(() => {});
        await s.page.waitForTimeout(400);
        assert.ok(s.page.url().startsWith(site.url), "Back stays on the site");
        assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), false, "Back closes the sheet");
        await onScreen(s, '[data-ui="picker"]', "the list after going back");
      }
    } finally {
      await s.context.close();
    }
  }
});

test("More about a letter opens a sheet over the quiz and gives the quiz back untouched", { skip }, async () => {
  for (const screen of [SCREENS[3], SCREENS[1]]) {
    const s = await open(screen);
    try {
      await s.page.selectOption("#set", "back");
      await s.page.locator("body").click({ position: { x: 2, y: 2 } });
      await s.page.keyboard.press("r");
      await s.page.keyboard.press("1");
      const frame = ["#card", "#surface", '[data-ui="choice"][data-choice="a"]', '[data-ui="next"]'];
      const before = await rects(s.page, frame);
      const words = await s.page.locator('[data-ui="choice"]').allInnerTexts();
      await tap(s, '#surface [data-more]', { what: "More about a letter", allow: ["LAYOUT_SHIFT"] });
      const sheet = await box(s.page, '[data-ui="sheet"]');
      assert.ok(sheet.y >= 0 && sheet.y + sheet.height <= screen.h + 0.5, `${screen.name}: the sheet is on screen`);
      await onScreen(s, '[data-ui="sheet"] [data-ui="detail-title"]', "the letter's name in the sheet");
      assert.deepEqual(await rects(s.page, frame), before, `${screen.name}: the quiz behind the sheet does not move`);
      await s.page.goBack();
      await s.page.waitForTimeout(400);
      assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), false, "Back closes the sheet");
      assert.equal(await s.page.locator('button[data-mode="pairs"]').getAttribute("aria-pressed"), "true", "still in the ear quiz");
      assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true", "the answered question is still there");
      assert.deepEqual(await s.page.locator('[data-ui="choice"]').allInnerTexts(), words);
      assert.deepEqual(await rects(s.page, frame), before);
      // Escape closes it too.
      await tap(s, '#surface [data-more]', { what: "More about a letter", allow: ["LAYOUT_SHIFT"] });
      await s.page.keyboard.press("Escape");
      await s.page.waitForTimeout(400);
      assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), false, "Escape closes the sheet");
      assert.deepEqual(await rects(s.page, frame), before);
    } finally {
      await s.context.close();
    }
  }
});

test("practise from a letter starts the ear quiz on that pair, and the quiz keeps its question across modes", { skip }, async () => {
  const s = await open(SCREENS[3], "#qaf");
  try {
    await tap(s, "#detail [data-practise]", { what: "a practise chip", allow: ["LAYOUT_SHIFT", "RESULT_CUT_OFF", "OFFSCREEN_EFFECT"] });
    assert.equal(await s.page.locator('button[data-mode="pairs"]').getAttribute("aria-pressed"), "true");
    const words = (await s.page.locator('[data-ui="choice"]').allInnerTexts()).join(" ");
    assert.match(words, /qalb/, "the pair with ق is asked");
    await s.page.evaluate(() => scrollTo(0, 0));
    await mode(s, "place");
    await mode(s, "pairs");
    assert.equal((await s.page.locator('[data-ui="choice"]').allInnerTexts()).join(" "), words, "the question is still there after visiting another mode");
  } finally {
    await s.context.close();
  }
});

// ---------- history: every Back and Forward press changes the screen ----------

test("Back and Forward step through the sounds that were looked at, and no press leaves the screen as it was", { skip }, async () => {
  for (const screen of [SCREENS[5], SCREENS[3]]) {
    const s = await open(screen);
    try {
      await mode(s, "browse");
      const shownFirst = await s.page.locator('#picker .k[aria-pressed="true"]').getAttribute("data-key");
      const visited = ["l:ق", "l:ح", "l:ع", "l:ت"];
      for (const k of visited) await tap(s, `[data-ui="picker"] .k[data-key="${k}"]`, { what: `sound ${k}`, allow: ["RESULT_CUT_OFF"] });
      const pressedKey = () => s.page.locator('#picker .k[aria-pressed="true"]').getAttribute("data-key");
      const seen = [await screenState(s.page)];
      const step = async (dir, what) => {
        await (dir < 0 ? s.page.goBack() : s.page.goForward());
        await s.page.waitForTimeout(350);
        const now = await screenState(s.page);
        assert.notEqual(now, seen[seen.length - 1], `${screen.name}: ${what} changed the screen`);
        assert.ok(s.page.url().startsWith(site.url), `${screen.name}: ${what} stays on the site`);
        seen.push(now);
      };
      await step(-1, "Back 1");
      assert.equal(await pressedKey(), "l:ع", "Back shows the sound before");
      assert.equal(await s.page.evaluate(() => document.activeElement?.dataset?.key), "l:ع", "the keyboard's focus follows the sound that is shown");
      await step(-1, "Back 2");
      await step(-1, "Back 3");
      assert.equal(await pressedKey(), "l:ق");
      await step(-1, "Back 4");
      assert.equal(await pressedKey(), shownFirst, "Back 4 shows the sound All sounds opened with");
      assert.equal(await s.page.evaluate(() => location.hash), "#sounds");
      await step(-1, "Back 5");
      assert.equal(await s.page.locator('button[data-mode][aria-pressed="true"]').getAttribute("data-mode"), "pairs", "Back 5 is the ear quiz again");
      for (let i = 1; i <= 5; i++) await step(1, `Forward ${i}`);
      assert.equal(await pressedKey(), "l:ت", "Forward returns to the last sound");
      // The same sound twice is one entry, and the arrow keys step without adding entries.
      const len = await s.page.evaluate(() => history.length);
      await tap(s, '[data-ui="picker"] .k[data-key="l:ت"]', { what: "the sound already shown" });
      await s.page.locator('#picker .k[aria-pressed="true"]').focus();
      await s.page.keyboard.press("ArrowRight");
      await s.page.waitForTimeout(400);
      assert.equal(await pressedKey(), "l:د", "the arrow key steps from the sound on screen");
      assert.equal(await s.page.evaluate(() => history.length), len, "neither adds a history entry");
      assert.deepEqual(s.errors, []);
    } finally {
      await s.context.close();
    }
  }
});

test("Back after practising from a sound returns to that sound, where the page was", { skip }, async () => {
  const s = await open(SCREENS[3], "#qaf");
  try {
    await s.page.locator("#detail [data-practise]").first().scrollIntoViewIfNeeded();
    const y = await s.page.evaluate(() => scrollY);
    await s.page.locator("#detail [data-practise]").first().click();
    await s.page.waitForTimeout(350);
    assert.equal(await s.page.locator('button[data-mode][aria-pressed="true"]').getAttribute("data-mode"), "pairs");
    await s.page.goBack();
    await s.page.waitForTimeout(350);
    assert.equal(await s.page.locator('#picker .k[aria-pressed="true"]').getAttribute("data-key"), "l:ق", "Back shows the sound again");
    assert.equal(await s.page.evaluate(() => scrollY), y, "at the scroll position it was left at");
  } finally {
    await s.context.close();
  }
});

test("Back, Forward and reload never play a sound; stepping does", { skip }, async () => {
  const s = await open(SCREENS[3]);
  try {
    await mode(s, "browse");
    await tap(s, '[data-ui="picker"] .k[data-key="l:ق"]', { what: "a sound", allow: ["RESULT_CUT_OFF"] });
    await tap(s, '[data-ui="picker"] .k[data-key="l:ح"]', { what: "a sound", allow: ["RESULT_CUT_OFF"] });
    await s.page.waitForTimeout(1500);
    const base = await countPlays(s.page);
    await s.page.goBack();
    await s.page.waitForTimeout(500);
    await s.page.goForward();
    await s.page.waitForTimeout(500);
    assert.equal(await countPlays(s.page), base, "Back and Forward are silent");
    await s.page.reload();
    await s.page.waitForSelector('#picker .k[aria-pressed="true"]');
    await s.page.waitForTimeout(600);
    assert.equal(await countPlays(s.page), 0, "a reload is silent");
    assert.equal(await s.page.locator(".err").count(), 0, "and shows no audio error");
    // Five quick arrow presses say only the sound they stop on.
    await s.page.locator('#picker .k[aria-pressed="true"]').focus();
    for (let i = 0; i < 5; i++) await s.page.keyboard.press("ArrowRight");
    await s.page.waitForTimeout(900);
    const n = await countPlays(s.page);
    assert.ok(n >= 1 && n <= 2, `one sound for five quick arrow presses (the first sound after a load also starts a silent unlock; got ${n})`);
  } finally {
    await s.context.close();
  }
});

// ---------- the reading notes ----------

test("the reading notes open over the page and close by the X, Escape, the backdrop and Back, leaving no trace", { skip }, async () => {
  for (const screen of [SCREENS[1], SCREENS[5]]) {
    const s = await open(screen);
    try {
      await mode(s, "browse");
      const link = '[data-ref="notes"]';
      await s.page.locator(link).scrollIntoViewIfNeeded();
      await s.page.waitForTimeout(250);
      const y = await s.page.evaluate(() => scrollY);
      const len = await s.page.evaluate(() => history.length);
      const hashBefore = await s.page.evaluate(() => location.hash);
      const closers = {
        "the X": () => tap(s, '[data-ui="sheet-close"]', { what: "the X", allow: ["LAYOUT_SHIFT"] }),
        Escape: () => s.page.keyboard.press("Escape"),
        "the backdrop": () => (screen.touch ? s.page.touchscreen.tap(Math.round(screen.w / 2), 12) : s.page.mouse.click(12, 12)),
        Back: () => s.page.goBack(),
      };
      for (const [name, close] of Object.entries(closers)) {
        await tap(s, link, { what: "the reading notes link", allow: ["LAYOUT_SHIFT"] });
        const sheet = await box(s.page, '[data-ui="sheet"]');
        assert.ok(sheet.y >= 0 && sheet.y + sheet.height <= screen.h + 0.5, `${screen.name}: the notes are on screen`);
        assert.equal(await s.page.locator("#sheet-pos").innerText(), "Reading notes");
        assert.equal(await s.page.locator('[data-ui="sheet-next"]').isVisible(), false, "no arrows on the notes");
        assert.equal(await s.page.evaluate(() => location.hash), "#notes");
        assert.match(await s.page.locator("#sheet-body").innerText(), /KEY TO THE LATIN LETTERS/i);
        // The arrow keys are not for stepping here.
        await s.page.keyboard.press("ArrowRight");
        assert.equal(await s.page.locator("#sheet-pos").innerText(), "Reading notes", "an arrow key does not turn the notes into a letter");
        await close();
        await s.page.waitForTimeout(400);
        assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), false, `${screen.name}: ${name} closes the notes`);
        assert.equal(await s.page.evaluate(() => location.hash), hashBefore, `${screen.name}: after ${name} the address is what it was`);
        // history.length counts the entry the closed sheet left ahead of this one; it must never grow beyond that.
        assert.ok(await s.page.evaluate(() => history.length) <= len + 1, `${screen.name}: after ${name} no history entries pile up`);
        assert.equal(await s.page.evaluate(() => scrollY), y, `${screen.name}: after ${name} the page is where it was`);
        assert.equal(await s.page.evaluate(() => document.activeElement?.dataset?.ref), "notes", `${screen.name}: after ${name} the keyboard is back on the link`);
      }
      assert.deepEqual(s.errors, []);
    } finally {
      await s.context.close();
    }
  }
});

test("a direct link to #notes or to a mark opens it, and Back stays on the site with the list in view", { skip }, async () => {
  for (const screen of [SCREENS[1], SCREENS[5]]) {
    const s = await open(screen, "#notes");
    try {
      assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), true, `${screen.name}: the notes are open`);
      assert.equal(await s.page.locator("#sheet-pos").innerText(), "Reading notes");
      await s.page.reload();
      await s.page.waitForSelector('button[data-mode][aria-pressed="true"]');
      await s.page.waitForTimeout(300);
      assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), true, "a reload keeps them open");
      await s.page.goBack();
      await s.page.waitForTimeout(400);
      assert.ok(s.page.url().startsWith(site.url), "Back stays on the site");
      assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), false, "and closes the notes");
      await onScreen(s, '[data-ui="picker"]', "the list after going back");
      await s.page.goForward();
      await s.page.waitForTimeout(400);
      assert.equal(await s.page.locator('[data-ui="sheet"]').isVisible(), true, "Forward opens them again");
    } finally {
      await s.context.close();
    }
    const m = await open(screen, "#mark-shadda");
    try {
      const scope = screen.w > NARROW ? "#detail " : '[data-ui="sheet"] ';
      assert.match(await m.page.locator(`${scope}[data-ui="detail-title"]`).innerText(), /šadda/, `${screen.name}: the mark's card is shown`);
      const said = await tap(m, `${scope}[data-say]`, { what: "the mark's example word" });
      assert.ok(heard(said), "its word plays");
    } finally {
      await m.context.close();
    }
  }
});

// ---------- keyboard: an activity opened from the keyboard is ready for the keyboard ----------

test("keyboard: Enter on an activity's tab opens it, and Enter then plays, answers go on, with no dead press", { skip }, async () => {
  const s = await open(SCREENS[3]);
  try {
    const len = await s.page.evaluate(() => history.length);
    await s.page.locator('button[data-mode="place"]').focus();
    await press(s, "Enter", { allow: ["LAYOUT_SHIFT", "RESULT_CUT_OFF", "OFFSCREEN_EFFECT"] });
    assert.equal(await s.page.locator('button[data-mode="place"]').getAttribute("aria-pressed"), "true");
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset?.ui), "say", "the keyboard is on the letter button");
    const played = await press(s, "Enter");
    assert.ok(heard(played), "Enter plays the word");
    await press(s, "3");
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true");
    await press(s, "Enter", { allow: ["LAYOUT_SHIFT"] });
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false", "Enter goes on to the next letter");
    assert.equal(await s.page.evaluate(() => history.length), len + 1, "one history entry for one change of activity");
    // Back on the tab of the activity that is showing, Enter is still the quiz's key.
    await s.page.locator('button[data-mode="place"]').focus();
    const again = await press(s, "Enter");
    assert.ok(heard(again), "Enter on the tab of the showing activity plays");
    // Opened by keyboard with an answered question waiting, Enter means Next (the simulated user's dead key).
    await press(s, "2");
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true");
    await s.page.locator('button[data-mode="pairs"]').focus();
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(300);
    await s.page.keyboard.press("r");
    await s.page.keyboard.press("1");
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "true");
    await s.page.locator('button[data-mode="place"]').focus();
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(300);
    await s.page.locator('button[data-mode="pairs"]').focus();
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(300);
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset?.ui), "next", "back in the ear quiz with an answer showing, the keyboard is on Next");
    await press(s, "Enter", { allow: ["LAYOUT_SHIFT"] });
    assert.equal(await s.page.locator("#card").getAttribute("data-answered"), "false", "and Enter goes on");
  } finally {
    await s.context.close();
  }
});

// ---------- the score ----------

test("the score survives a reload and starts again on a new visit", { skip }, async () => {
  const s = await open(SCREENS[3]);
  try {
    for (let i = 0; i < 2; i++) {
      await s.page.keyboard.press("r");
      await s.page.keyboard.press("1");
      await s.page.keyboard.press("Enter");
    }
    assert.match(await s.page.locator('[data-ui="score"]').innerText(), /of 2 right/);
    await s.page.reload();
    await s.page.waitForSelector('[data-ui="score"]');
    assert.match(await s.page.locator('[data-ui="score"]').innerText(), /of 2 right/, "a reload keeps the score");
    await s.page.goto(site.url, { waitUntil: "load" });
    await s.page.waitForSelector('[data-ui="score"]');
    assert.match(await s.page.locator('[data-ui="score"]').innerText(), /^0 of 0 right/, "a new visit in the same tab starts at 0");
  } finally {
    await s.context.close();
  }
});

// ---------- small things that broke on real phones ----------

test("the vowel marks of every answer word stay inside their card", { skip }, async () => {
  for (const screen of [SCREENS[0], SCREENS[1], SCREENS[5]]) {
    const s = await open(screen);
    try {
      const pairs = await s.page.locator("#set option").evaluateAll(els => els.map(e => e.value).filter(v => v.startsWith("pair:")));
      assert.ok(pairs.length >= 20);
      for (const value of pairs) {
        await s.page.selectOption("#set", value);
        const bad = await s.page.evaluate(() => {
          const cv = document.createElement("canvas").getContext("2d");
          const out = [];
          for (const card of document.querySelectorAll('[data-ui="choice"]')) {
            const el = card.querySelector('[data-part="ar"]');
            const cs = getComputedStyle(el);
            cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            cv.direction = "rtl";
            const m = cv.measureText(el.textContent);
            const r = el.getBoundingClientRect();
            const baseline = r.top + (r.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
            const room = baseline - m.actualBoundingBoxAscent - card.getBoundingClientRect().top;
            if (room < 3) out.push(`${el.textContent}: ${room.toFixed(1)} px`);
          }
          return out;
        });
        assert.deepEqual(bad, [], `${screen.name}: marks at least 3 px inside the card for ${value}`);
      }
    } finally {
      await s.context.close();
    }
  }
});

test("on phones the voice menu shows its choice in full, keeps its width, and leaves the title alone", { skip }, async () => {
  for (const screen of [SCREENS[0], SCREENS[1], { name: "phone 412x800", w: 412, h: 800, touch: true }]) {
    const s = await open(screen);
    try {
      const widths = new Set();
      for (const v of ["mix", "chaouki", "asmaa"]) {
        await s.page.selectOption("#voice", v);
        const m = await s.page.evaluate(() => {
          const sel = document.getElementById("voice");
          const cs = getComputedStyle(sel);
          const cv = document.createElement("canvas").getContext("2d");
          cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const r = sel.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(document.querySelector("h1"));
          const title = [...range.getClientRects()].filter(q => q.width > 0).reduce((a, q) => Math.max(a, q.right), 0);
          return { text: cv.measureText(sel.selectedOptions[0].textContent).width, w: r.width, gap: document.querySelector(".prefs").getBoundingClientRect().left - title };
        });
        widths.add(Math.round(m.w));
        assert.ok(m.text + 26 <= m.w, `${screen.name}: "${v}" fits the menu (${Math.round(m.text)} px of text in ${Math.round(m.w)} px)`);
        assert.ok(m.gap >= 8, `${screen.name}: at least 8 px between the title and the settings (${m.gap.toFixed(1)})`);
      }
      assert.equal(widths.size, 1, `${screen.name}: the menu is one width for every choice`);
    } finally {
      await s.context.close();
    }
  }
});

test("a number on the ear quiz's picture: a mouse answers with it, a finger is pointed to the cards until the answer is in", { skip }, async () => {
  const badge = n => `#surface .mo-badge[data-label="${n}"]`;
  const mouse = await open(SCREENS[5]);
  try {
    await mouse.page.selectOption("#set", "pair:k-q");
    await tap(mouse, '[data-ui="play"]', { what: "play" });
    await tap(mouse, badge(2), { what: "number 2 on the picture" });
    assert.equal(await mouse.page.locator("#card").getAttribute("data-answered"), "true", "a click on the number answers");
    const again = await tap(mouse, badge(1), { what: "number 1 after the answer" });
    assert.ok(heard(again), "after the answer a number replays its word");
  } finally {
    await mouse.context.close();
  }
  const finger = await open(SCREENS[0]);
  try {
    await finger.page.selectOption("#set", "pair:s-ss");
    await tap(finger, '[data-ui="play"]', { what: "play" });
    const frame = ["#card", "#surface", '[data-ui="choice"][data-choice="a"]'];
    const before = await rects(finger.page, frame);
    await tap(finger, badge(1), { what: "number 1 on the picture, with a finger" });
    assert.equal(await finger.page.locator("#card").getAttribute("data-answered"), "false", "a finger on a number is never scored");
    assert.match(await finger.page.locator('[data-ui="status"]').innerText(), /Tap card 1 or 2/);
    assert.deepEqual(await rects(finger.page, frame), before, "and nothing changes size");
    await tap(finger, '[data-ui="choice"][data-choice="a"]', { what: "card 1" });
    const replay = await tap(finger, badge(2), { what: "number 2 after the answer" });
    assert.ok(heard(replay), "after the answer a finger on a number replays its word");
  } finally {
    await finger.context.close();
  }
});

test("a sound's sheet on a phone shows the picture, the description and a word to play without scrolling", { skip }, async () => {
  for (const screen of [SCREENS[0], SCREENS[1]]) {
    const s = await open(screen);
    try {
      await mode(s, "browse");
      const tops = new Set();
      for (const k of ["l:ض", "l:ص", "l:ء", "l:ر", "l:ك", "l:ج"]) {
        await tap(s, `[data-ui="picker"] .k[data-key="${k}"]`, { what: `sound ${k}`, allow: ["LAYOUT_SHIFT"] });
        const m = await s.page.evaluate(() => {
          const body = document.getElementById("sheet-body").getBoundingClientRect();
          const r = q => document.querySelector(`#sheet-body ${q}`).getBoundingClientRect();
          return { bodyBottom: body.bottom, pic: r(".d-mouth"), word: r(".d-main .word"), desc: r(".d-desc") };
        });
        tops.add(Math.round(m.pic.top));
        assert.ok(m.pic.bottom <= m.bodyBottom, `${screen.name} ${k}: the picture is in view`);
        assert.ok(m.desc.bottom <= m.bodyBottom, `${screen.name} ${k}: the description is in view`);
        assert.ok(m.word.bottom <= m.bodyBottom - 30, `${screen.name} ${k}: the first word's button is in view above the fade (${Math.round(m.word.bottom)} of ${Math.round(m.bodyBottom)})`);
        await tap(s, '[data-ui="sheet-close"]', { what: "close", allow: ["LAYOUT_SHIFT"] });
      }
      assert.equal(tops.size, 1, `${screen.name}: the picture is at the same height for every letter`);
    } finally {
      await s.context.close();
    }
  }
});

test("More about a letter from a quiz shows the way back into the drill without scrolling", { skip }, async () => {
  for (const screen of [SCREENS[5], SCREENS[3], SCREENS[2]]) {
    const s = await open(screen);
    try {
      for (const value of ["pair:h-hh", "pair:s-ss", "pair:k-q"]) {
        await s.page.selectOption("#set", value);
        await s.page.locator("body").click({ position: { x: 2, y: 2 } });
        await s.page.keyboard.press("r");
        await s.page.keyboard.press("1");
        await tap(s, "#surface [data-more]", { what: "More about a letter", allow: ["LAYOUT_SHIFT"] });
        const m = await s.page.evaluate(() => {
          const body = document.getElementById("sheet-body").getBoundingClientRect();
          const p = document.querySelector("#sheet-body .d-practise")?.getBoundingClientRect();
          return { bodyBottom: body.bottom, practise: p ? p.bottom : null };
        });
        assert.ok(m.practise != null, `${value}: the letter has pairs to practise`);
        assert.ok(m.practise <= m.bodyBottom - 30, `${screen.name} ${value}: "Practise hearing it" is in view (${Math.round(m.practise)} of ${Math.round(m.bodyBottom)})`);
        await s.page.keyboard.press("Escape");
        await s.page.waitForTimeout(300);
        await s.page.keyboard.press("Enter");
      }
    } finally {
      await s.context.close();
    }
  }
});

test("a drill on one pair says that it is the same two words", { skip }, async () => {
  const s = await open(SCREENS[0]);
  try {
    const cap = () => s.page.evaluate(() => Math.round(document.querySelector('[data-ui="caption"]').getBoundingClientRect().height));
    const reserved = await cap();
    await s.page.selectOption("#set", "pair:h-hh");
    await tap(s, '[data-ui="play"]', { what: "play" });
    await tap(s, '[data-ui="choice"][data-choice="a"]', { what: "card 1" });
    await tap(s, '[data-ui="next"]', { what: "next" });
    assert.match(await s.page.locator('[data-ui="caption"]').innerText(), /just these two words/);
    assert.equal(await cap(), reserved, "and the line under the picture has not grown for it");
    await s.page.selectOption("#set", "back");
    assert.doesNotMatch(await s.page.locator('[data-ui="caption"]').innerText(), /just these two words/, "a set of several pairs does not say it");
  } finally {
    await s.context.close();
  }
});
