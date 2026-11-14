// What a visitor would mind about one action, measured in the page. Shared by the simulated-user
// driver (tests/ui/sim.mjs) and the UI contract test (tests/ui.test.mjs).
//
//   await context.addInitScript(pageInit);            // before the site's scripts, on every load
//   const m = await measure(page, { type: "tap", point: { x, y }, touch, run: () => page.mouse.click(x, y) });
//   m.flags  -> [{ code, sev, msg }]   sev 3 = a visitor swears, 2 = annoying, 1 = note
//
// Flags: DEAD_TAP, OFFSCREEN_EFFECT, RESULT_CUT_OFF, SCROLL_JUMP, MOVED_UNDER_FINGER, LAYOUT_SHIFT,
// SMALL_TARGET. staticFaults(page, touch) adds OVERFLOW_X, SMALL_TARGET, CUT_OFF, OVERLAP, TINY_TEXT,
// CLIPPED_TEXT for the screen as it stands.

/** Runs inside the page. Installs window.__sim (view, audit, begin, end, quietFor) and records sounds. */
export function pageInit() {
  if (window.__sim) return;
  const INTERACTIVE =
    'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="tab"],[role="link"],' +
    '[role="checkbox"],[role="switch"],[role="option"],[tabindex]:not([tabindex="-1"]),label[for],[onclick]';
  const vw = () => window.innerWidth;
  const vh = () => window.innerHeight;
  const rectOf = el => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const area = r => Math.max(0, r.w) * Math.max(0, r.h);
  const visArea = r =>
    Math.max(0, Math.min(r.x + r.w, vw()) - Math.max(r.x, 0)) * Math.max(0, Math.min(r.y + r.h, vh()) - Math.max(r.y, 0));
  const shown = el => {
    if (!el.isConnected) return false;
    // Inside a closed <details> (or any content-visibility: hidden box) nothing is drawn, though it has a size.
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const visuallyHidden = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 && r.height <= 2) return true;
    const s = getComputedStyle(el);
    return s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)";
  };
  const clean = s => String(s || "").replace(/\s+/g, " ").trim();
  const interactiveOf = el => (el && el.closest ? el.closest(INTERACTIVE) : null);
  // Pinned to the screen (sticky or fixed): it keeps its place while the page scrolls under it.
  const pinned = el => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === "sticky" || pos === "fixed") return true;
    }
    return false;
  };

  // The part of a box that its scrolling or clipping ancestors let through (content scrolled under a
  // sheet's head is not "overlapping" the buttons in that head).
  const clipped = (el, r) => {
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/auto|scroll|hidden|clip/.test(s.overflowX + " " + s.overflowY)) {
        const b = n.getBoundingClientRect();
        x0 = Math.max(x0, b.left); y0 = Math.max(y0, b.top); x1 = Math.min(x1, b.right); y1 = Math.min(y1, b.bottom);
      }
    }
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  };

  // The area a tap on this control really has: a checkbox inside a label is as big as the label.
  const effective = el => {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      const label = el.closest("label") || (el.labels && el.labels[0]);
      if (label) return label;
    }
    return el;
  };

  // Only what a sighted visitor can read: no aria-label, no title.
  function visibleText(el) {
    if (el instanceof HTMLSelectElement) return clean(el.selectedOptions[0]?.textContent);
    if (el instanceof HTMLInputElement) {
      const label = clean((el.closest("label") || (el.labels && el.labels[0]))?.innerText);
      if (el.type === "checkbox" || el.type === "radio") return `${label} [${el.checked ? "x" : " "}]`;
      return clean(el.value) || clean(el.placeholder) || label;
    }
    if (el instanceof SVGElement) {
      return clean([...el.querySelectorAll("text")].map(t => t.textContent).join(" "));
    }
    return clean(el.innerText);
  }
  const kindOf = el => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return el.type === "checkbox" ? "checkbox" : el.type === "range" ? "slider" : `input`;
    if (tag === "select") return "drop-down";
    if (tag === "summary") return "expander";
    return tag;
  };
  // Stable identity of a control across re-renders: what it is and what it says.
  const sig = el => {
    if (!el || !el.tagName) return "";
    const data = [...el.attributes].filter(a => a.name.startsWith("data-") && !a.name.startsWith("data-sim")).map(a => `${a.name}=${a.value}`).join(",");
    return `${kindOf(el)}|${visibleText(el).replace(/\[[x ]\]$/, "").slice(0, 60)}|${data.slice(0, 80)}`;
  };

  /** Controls a visitor can see and reach right now. */
  function controls({ all = false } = {}) {
    const out = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!shown(el)) continue;
      const eff = effective(el);
      const r = rectOf(eff);
      const v = visArea(r);
      if (!all) {
        if (v < Math.min(area(r) * 0.4, 24 * 24)) continue;
        // Covered by something else (a sheet, a backdrop)?
        const cx = (Math.max(r.x, 0) + Math.min(r.x + r.w, vw())) / 2;
        const cy = (Math.max(r.y, 0) + Math.min(r.y + r.h, vh())) / 2;
        const hit = document.elementFromPoint(cx, cy);
        const wrap = hit && hit.closest ? hit.closest("label") : null;
        if (!hit || !(eff.contains(hit) || el.contains(hit) || (wrap && wrap.contains(el)))) continue;
      }
      const item = {
        el,
        kind: kindOf(el),
        text: visibleText(el),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        pressed: el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true",
        sig: sig(el),
        pinned: pinned(el),
        r,
      };
      // Where it is for the visitor: on the page, or on the screen when it is pinned there.
      item.doc = item.pinned ? { x: r.x, y: r.y, w: r.w, h: r.h } : { x: r.x + scrollX, y: r.y + scrollY, w: r.w, h: r.h };
      if (el instanceof HTMLSelectElement) item.options = [...el.options].map(o => clean(o.textContent));
      out.push(item);
    }
    // A label[for] and its input are one control for the visitor: keep the input.
    return out.filter(c => !(c.el.tagName === "LABEL" && out.some(o => o !== c && c.el.contains(o.el))));
  }

  /** Static layout faults visible right now. */
  function audit(touch) {
    const faults = [];
    const docEl = document.documentElement;
    if (docEl.scrollWidth - vw() > 1) faults.push({ code: "OVERFLOW_X", sev: 3, msg: `The page is ${docEl.scrollWidth - vw()} px wider than the screen and scrolls sideways.` });
    const cs = controls();
    const min = touch ? 40 : 24;
    for (const c of cs) {
      if (c.disabled) continue;
      const inline = c.kind === "link" && getComputedStyle(c.el).display.startsWith("inline");
      if (!inline && (c.r.w < min - 0.5 || c.r.h < min - 0.5)) {
        faults.push({ code: "SMALL_TARGET", sev: touch ? 2 : 1, sig: c.sig, msg: `${c.kind} "${c.text || "(no visible label)"}" is only ${Math.round(c.r.w)}×${Math.round(c.r.h)} px.` });
      }
      if (c.r.x < -1 || c.r.x + c.r.w > vw() + 1) {
        faults.push({ code: "CUT_OFF", sev: 2, sig: c.sig, msg: `${c.kind} "${c.text}" is cut off at the side of the screen.` });
      }
    }
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (a.pinned !== b.pinned) continue; // one of them scrolls under a pinned bar
        if (effective(a.el) === effective(b.el)) continue;
        const ra = clipped(a.el, a.r), rb = clipped(b.el, b.r);
        const ix = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
        const iy = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
        if (ix > 2 && iy > 2 && ix * iy > 0.2 * Math.min(area(a.r), area(b.r))) {
          faults.push({ code: "OVERLAP", sev: 2, sig: `${a.sig}&${b.sig}`, msg: `"${a.text}" and "${b.text}" overlap.` });
        }
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || seen.has(el) || !clean(walker.currentNode.textContent)) continue;
      seen.add(el);
      if (!shown(el) || visuallyHidden(el) || el.closest("svg, option, select, noscript")) continue;
      const r = rectOf(el);
      if (visArea(r) <= 0) continue;
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      if (size && size < 11) faults.push({ code: "TINY_TEXT", sev: 1, sig: sig(el) + clean(el.textContent).slice(0, 30), msg: `Text "${clean(el.textContent).slice(0, 40)}" is ${size} px.` });
      // Clipped by itself or by an ancestor that hides overflow.
      for (let box = el; box && box !== document.body; box = box.parentElement) {
        const bs = getComputedStyle(box);
        const clipX = /hidden|clip/.test(bs.overflowX) && box.scrollWidth > box.clientWidth + 1;
        const clipY = /hidden|clip/.test(bs.overflowY) && box.scrollHeight > box.clientHeight + 2;
        if (clipX || clipY) {
          faults.push({ code: "CLIPPED_TEXT", sev: 2, sig: sig(box) + clean(box.textContent).slice(0, 30), msg: `Text is clipped: "${clean(box.textContent).slice(0, 50)}".` });
          break;
        }
      }
    }
    return faults;
  }

  function view() {
    const docEl = document.documentElement;
    return {
      vw: vw(),
      vh: vh(),
      scrollY: Math.round(scrollY),
      scrollMax: Math.max(0, Math.round(docEl.scrollHeight - vh())),
      title: document.title,
      url: location.href,
      controls: controls().map((c, i) => ({
        i: i + 1, kind: c.kind, text: c.text, disabled: c.disabled, pressed: c.pressed, options: c.options,
        x: Math.round(c.r.x), y: Math.round(c.r.y), w: Math.round(c.r.w), h: Math.round(c.r.h),
        cx: Math.round((Math.max(c.r.x, 0) + Math.min(c.r.x + c.r.w, vw())) / 2),
        cy: Math.round((Math.max(c.r.y, 0) + Math.min(c.r.y + c.r.h, vh())) / 2),
      })),
    };
  }

  let cur = null;
  function begin(x, y) {
    const hit = x == null ? document.activeElement : document.elementFromPoint(x, y);
    const inter = interactiveOf(hit);
    const target = inter || hit || document.body;
    cur = {
      pt: x == null ? null : { x, y },
      scroll0: { x: scrollX, y: scrollY },
      url0: location.href,
      target,
      targetSig: sig(target),
      targetKind: kindOf(target),
      targetText: visibleText(target),
      targetInteractive: !!inter,
      targetDisabled: !!inter && (inter.disabled === true || inter.getAttribute("aria-disabled") === "true"),
      targetAnchor: !!inter && inter.tagName === "A" && (inter.getAttribute("href") || "").startsWith("#"),
      targetPinned: pinned(target),
      r0: rectOf(effective(target)),
      controls0: controls(),
      muts: new Set(),
      t0: performance.now(),
      firstMut: null,
      lastMut: performance.now(),
      audio0: window.__simAudio.length,
    };
    cur.obs = new MutationObserver(list => {
      const now = performance.now();
      for (const m of list) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (t) cur.muts.add(t);
        for (const n of m.addedNodes) if (n.nodeType === 1) cur.muts.add(n);
      }
      if (cur.firstMut == null) cur.firstMut = now - cur.t0;
      cur.lastMut = now;
    });
    cur.obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    return { target: { kind: cur.targetKind, text: cur.targetText, interactive: cur.targetInteractive, disabled: cur.targetDisabled } };
  }
  const quietFor = () => (cur ? performance.now() - cur.lastMut : 1e9);

  function end() {
    const st = cur;
    if (!st) return null;
    st.obs.disconnect();
    const out = {
      target: { kind: st.targetKind, text: st.targetText, interactive: st.targetInteractive, disabled: st.targetDisabled, anchor: st.targetAnchor, pinned: st.targetPinned, w: Math.round(st.r0.w), h: Math.round(st.r0.h) },
      scrollDy: Math.round(scrollY - st.scroll0.y),
      scrollYAfter: Math.round(scrollY),
      urlChanged: location.href !== st.url0,
      firstMutMs: st.firstMut == null ? null : Math.round(st.firstMut),
      audio: window.__simAudio.slice(st.audio0),
    };

    // What changed, and how much of it the visitor can see.
    let els = [...st.muts].filter(el => el.isConnected && el !== document.documentElement && el !== document.body && !el.closest("head"));
    els = els.filter(el => !els.some(o => o !== el && o.contains(el)));
    let aIn = 0, above = 0, below = 0;
    const regions = [];
    for (const el of els) {
      if (!shown(el) || visuallyHidden(el)) continue;
      const r = rectOf(el);
      if (area(r) < 16) continue;
      const v = visArea(r);
      const up = Math.max(0, Math.min(r.y + r.h, 0) - r.y) * r.w;
      const down = Math.max(0, r.y + r.h - Math.max(r.y, vh())) * r.w;
      aIn += v; above += up; below += down;
      regions.push({ what: `${kindOf(el)}${el.id ? "#" + el.id : ""}${el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : ""}`, text: clean(el.innerText || el.textContent).slice(0, 50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), visible: area(r) ? Math.round((v / area(r)) * 100) : 0 });
    }
    out.changed = { visible: Math.round(aIn), above: Math.round(above), below: Math.round(below), regions: regions.slice(0, 8) };

    // Where did the tapped control go?
    if (st.pt) {
      let now = st.target.isConnected ? st.target : null;
      if (!now) {
        const same = [...document.querySelectorAll(INTERACTIVE)].filter(el => sig(el) === st.targetSig && shown(el));
        same.sort((a, b) => Math.abs(rectOf(a).y - st.r0.y) - Math.abs(rectOf(b).y - st.r0.y));
        now = same[0] || null;
      }
      if (now && shown(now)) {
        const r1 = rectOf(effective(now));
        out.moved = { dx: Math.round(r1.x - st.r0.x), dy: Math.round(r1.y - st.r0.y) };
      } else out.moved = { gone: true };
      const hit1 = document.elementFromPoint(st.pt.x, st.pt.y);
      const under = interactiveOf(hit1);
      out.underNow = under ? { kind: kindOf(under), text: visibleText(under), same: under === st.target || sig(under) === st.targetSig } : null;
    }

    // Did other controls that were on screen move (in page coordinates, so a scroll alone does not count)?
    const after = controls({ all: true });
    const shifts = [];
    for (const c0 of st.controls0) {
      if (c0.el === st.target) continue;
      let c1 = c0.el.isConnected ? after.find(a => a.el === c0.el) : null;
      if (!c1) {
        const same = after.filter(a => a.sig === c0.sig);
        same.sort((a, b) => Math.hypot(a.doc.x - c0.doc.x, a.doc.y - c0.doc.y) - Math.hypot(b.doc.x - c0.doc.x, b.doc.y - c0.doc.y));
        c1 = same[0];
      }
      if (!c1) continue;
      const dx = c1.doc.x - c0.doc.x, dy = c1.doc.y - c0.doc.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        const near = st.pt ? Math.hypot(c0.r.x + c0.r.w / 2 - st.pt.x, c0.r.y + c0.r.h / 2 - st.pt.y) : 9999;
        shifts.push({ text: c0.text.slice(0, 40), kind: c0.kind, dx: Math.round(dx), dy: Math.round(dy), near: Math.round(near) });
      }
    }
    out.shifts = shifts;
    cur = null;
    return out;
  }

  // Sounds: a visitor hears them, so the driver has to know that one played (and which clip).
  window.__simAudio = [];
  const tag = (o, url) => { try { if (url) Object.defineProperty(o, "__simUrl", { value: url, configurable: true }); } catch { /* frozen */ } return o; };
  if (window.Response) {
    const ab = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function () { return tag(await ab.call(this), this.url); };
  }
  const slice = ArrayBuffer.prototype.slice;
  ArrayBuffer.prototype.slice = function (...a) { return tag(slice.apply(this, a), this.__simUrl); };
  for (const Ctx of [window.AudioContext, window.webkitAudioContext].filter(Boolean)) {
    const dec = Ctx.prototype.decodeAudioData;
    Ctx.prototype.decodeAudioData = function (buf, ok, err) {
      const url = buf && buf.__simUrl;
      if (typeof ok === "function") return dec.call(this, buf, b => ok(tag(b, url)), err);
      const p = dec.call(this, buf);
      return p && p.then ? p.then(b => tag(b, url)) : p;
    };
  }
  if (window.AudioBufferSourceNode) {
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      window.__simAudio.push({ at: Math.round(performance.now()), dur: this.buffer ? Math.round(this.buffer.duration * 100) / 100 : null, url: (this.buffer && this.buffer.__simUrl) || null });
      return start.apply(this, a);
    };
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    window.__simAudio.push({ at: Math.round(performance.now()), dur: Number.isFinite(this.duration) ? this.duration : null, url: this.currentSrc || this.src || null });
    return play.apply(this, a);
  };

  window.__sim = { view, audit, begin, end, quietFor };
}

/** Wait until the page has stopped changing (at most about 3 s). */
export async function settle(page) {
  await page.waitForTimeout(250);
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    const quiet = await page.evaluate(() => window.__sim.quietFor()).catch(() => 1e9);
    if (quiet > 350) break;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(120);
}

/**
 * Do one action and measure it.
 * @param {import("playwright-core").Page} page
 * @param {{ type: string, point?: {x:number,y:number}|null, touch?: boolean, key?: string, run: () => Promise<unknown> }} action
 * @returns {Promise<{ res: any, flags: Array<{code:string, sev:number, msg:string}>, same: boolean, navigated: boolean, before: Buffer, after: Buffer }>}
 */
export async function measure(page, { type, point = null, touch = false, key = "", run }) {
  const before = await page.screenshot({ scale: "css" });
  const info = await page.evaluate(([x, y]) => window.__sim.begin(x, y), point ? [point.x, point.y] : [null, null]);
  const urlBefore = page.url();
  await run();
  await settle(page);
  let res = await page.evaluate(() => window.__sim.end()).catch(() => null);
  const navigated = page.url().split("#")[0] !== urlBefore.split("#")[0] || res == null;
  if (res == null) res = { target: info.target, scrollDy: 0, audio: [], changed: { visible: 0, above: 0, below: 0, regions: [] }, shifts: [] };
  const after = await page.screenshot({ scale: "css" });
  const same = before.equals(after);
  return { res, flags: navigated ? [] : judge(res, { type, key, touch, same, pointed: !!point }), same, navigated, before, after };
}

/** Turn one measurement into flags. */
export function judge(res, { type, key = "", touch = false, same = false, pointed = true }) {
  const flags = [];
  const t = res.target || {};
  const name = `${t.kind || "element"} "${t.text || "(no visible label)"}"`;
  const did = type === "key" ? `pressed ${key}` : `tapped ${name}`;
  const out = res.changed.above + res.changed.below;
  const where = res.changed.above > res.changed.below ? "above" : "below";
  const scrollKey = type === "key" && /^(Tab|Shift\+Tab|Space| |PageDown|PageUp|ArrowDown|ArrowUp|Home|End)$/.test(key);
  const heard = (res.audio || []).length > 0;

  // A screen change inside the page (the address changed) that lands at the top is a navigation,
  // not a jump; an expander that opens under the tap may run on below the screen.
  const newScreen = !!res.urlChanged && res.scrollYAfter === 0;
  const opensBelow = t.kind === "expander" && res.changed.visible > 15000;

  if (same && !heard && t.interactive && !t.disabled && type !== "hover") {
    flags.push({ code: "DEAD_TAP", sev: 3, msg: `You ${did} and nothing on the screen changed.` + (out > 2000 ? ` Something did change ${where} the screen, where you cannot see it.` : "") });
  } else if (newScreen || opensBelow) {
    // nothing to hold against it
  } else if (out > 20000 && out > 2 * res.changed.visible) {
    flags.push({ code: "OFFSCREEN_EFFECT", sev: 3, msg: `You ${did}; most of what changed is ${where} the screen (${Math.round(out / 1000)}k px² off-screen, ${Math.round(res.changed.visible / 1000)}k px² visible).`, regions: res.changed.regions });
  } else if (out > 20000 && res.changed.visible > 0 && out > 0.6 * res.changed.visible) {
    flags.push({ code: "RESULT_CUT_OFF", sev: 2, msg: `A large part of what changed after you ${did} is ${where} the screen.`, regions: res.changed.regions });
  }
  // A control pinned to the screen that stays under the finger while the page beneath it resets is not a jump.
  const heldStill = !!t.pinned && res.moved && !res.moved.gone && Math.abs(res.moved.dx) <= 3 && Math.abs(res.moved.dy) <= 3;
  if (Math.abs(res.scrollDy) > 8 && !scrollKey && !t.anchor && type !== "scroll" && !newScreen && !heldStill) {
    flags.push({ code: "SCROLL_JUMP", sev: 3, msg: `The page scrolled by itself (${res.scrollDy > 0 ? "down" : "up"} ${Math.abs(res.scrollDy)} px) when you ${did}.` });
  }
  if (res.moved && !res.moved.gone && (Math.abs(res.moved.dx) > 3 || Math.abs(res.moved.dy) > 3) && !t.anchor) {
    flags.push({ code: "MOVED_UNDER_FINGER", sev: 3, msg: `${name} moved ${Math.abs(res.moved.dy)} px ${res.moved.dy > 0 ? "down" : "up"}${res.moved.dx ? ` and ${Math.abs(res.moved.dx)} px sideways` : ""} when you tapped it.` + (res.underNow && !res.underNow.same ? ` "${res.underNow.text}" is now under your finger.` : "") });
  }
  const shifts = res.shifts || [];
  if (shifts.length) {
    const worst = shifts.reduce((a, b) => (Math.hypot(b.dx, b.dy) > Math.hypot(a.dx, a.dy) ? b : a));
    const close = shifts.some(s => s.near < 260) && !newScreen && !opensBelow;
    flags.push({ code: "LAYOUT_SHIFT", sev: close ? 2 : 1, msg: `${shifts.length} other control${shifts.length > 1 ? "s" : ""} on the screen moved (for example "${worst.text}" by ${worst.dy} px down, ${worst.dx} px across).`, shifts: shifts.slice(0, 6) });
  }
  const min = touch ? 40 : 24;
  if (pointed && t.interactive && !t.disabled && (t.w < min - 0.5 || t.h < min - 0.5)) {
    flags.push({ code: "SMALL_TARGET", sev: touch ? 2 : 1, msg: `You tapped ${name}, which is only ${t.w}×${t.h} px.` });
  }
  return flags;
}

/** Layout faults of the screen as it stands. */
export function staticFaults(page, touch = false) {
  return page.evaluate(t => window.__sim.audit(t), !!touch);
}
