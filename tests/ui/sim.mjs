#!/usr/bin/env node
// Simulated-user driver. It keeps one real (headless) Chrome page open and lets a person, or an
// agent playing one, use the site the way a visitor does: look at a screenshot of the viewport,
// tap something on it, scroll, press a key. Nothing else. No DOM access, no source code.
//
// While the user acts, the driver measures every action and logs the moments a real visitor
// would swear at ("flags"):
//
//   DEAD_TAP            a control was tapped and nothing on the screen changed
//   OFFSCREEN_EFFECT    the tap changed something, but outside the screen (above or below it)
//   MOVED_UNDER_FINGER  the control that was tapped moved away from under the finger
//   SCROLL_JUMP         the page scrolled by itself
//   LAYOUT_SHIFT        other controls on the screen moved
//   RESULT_CUT_OFF      most of what changed is below or above the screen
//   SMALL_TARGET        a tap target smaller than 40 px on a touch screen (24 px with a mouse)
//   OVERLAP, CLIPPED_TEXT, CUT_OFF, OVERFLOW_X, TINY_TEXT   static layout faults
//   CONSOLE_ERROR, REQUEST_FAILED
//
// The user never sees the flags; they are written to <dir>/log.jsonl next to the user's own
// notes, and `report` turns one or more sessions into report.md and report.json.
//
//   node tests/ui/sim.mjs start  --dir D --url http://localhost:5173/ --viewport 390x664 --touch --label "First-timer on a phone"
//   node tests/ui/sim.mjs look   --dir D            what is on the screen now
//   node tests/ui/sim.mjs tap    --dir D 7          tap control 7 of the last list
//   node tests/ui/sim.mjs tapxy  --dir D 120 300    tap a point of the screenshot
//   node tests/ui/sim.mjs choose --dir D 4 "Everything"   pick an option of a drop-down
//   node tests/ui/sim.mjs scroll --dir D 400        scroll down 400 px (negative: up)
//   node tests/ui/sim.mjs key    --dir D Enter      press a key (Tab, Enter, Escape, 1, r, ArrowDown …)
//   node tests/ui/sim.mjs back | reload --dir D
//   node tests/ui/sim.mjs note   --dir D --wtf 3 "I tapped a letter and nothing happened?!" --expect "its details right here"
//   node tests/ui/sim.mjs stop   --dir D
//   node tests/ui/sim.mjs report --out R D1 D2 …    (or --base B: every session folder inside B)
//
// Add --flags to any action to print what the driver measured (for debugging the site, not for
// simulated users).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";
import { pageInit, measure, staticFaults as auditPage } from "./measure.mjs";

const SELF = fileURLToPath(import.meta.url);
const IDLE_MS = 20 * 60 * 1000;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--") || ["touch", "flags", "json"].includes(k)) flags[k] = true;
      else { flags[k] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

// =====================================================================================
// Daemon: owns the browser, answers one command at a time
// =====================================================================================

async function serveSession({ dir, url, viewport, touch, label }) {
  const [w, h] = String(viewport).split("x").map(Number);
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "log.jsonl");
  const log = entry => fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");

  const browser = await launch();
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    hasTouch: !!touch,
    isMobile: !!touch,
    deviceScaleFactor: 1,
    ...(touch ? { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36" } : {}),
  });
  await context.addInitScript(pageInit);
  const page = await context.newPage();

  const events = [];
  page.on("console", m => { if (m.type() === "error") events.push({ code: "CONSOLE_ERROR", sev: 2, msg: m.text().slice(0, 300) }); });
  page.on("pageerror", e => events.push({ code: "CONSOLE_ERROR", sev: 3, msg: String(e.message || e).slice(0, 300) }));
  page.on("requestfailed", r => { if (!/ERR_ABORTED/.test(r.failure()?.errorText || "")) events.push({ code: "REQUEST_FAILED", sev: 2, msg: `${r.url()} ${r.failure()?.errorText || ""}` }); });
  page.on("response", r => { if (r.status() >= 400) events.push({ code: "REQUEST_FAILED", sev: 2, msg: `${r.status()} ${r.url()}` }); });
  page.on("dialog", d => { events.push({ code: "DIALOG", sev: 1, msg: `${d.type()}: ${d.message()}` }); d.dismiss().catch(() => {}); });

  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(600);

  // Which clip says what, when the site has an audio manifest in the Sound Lab's shape.
  const heardText = new Map();
  try {
    const res = await page.request.get(new URL("audio.json", url).href);
    if (res.ok()) {
      const manifest = await res.json();
      for (const [text, voices] of Object.entries(manifest.clips || {})) {
        for (const [voice, v] of Object.entries(voices)) {
          for (const speed of ["normal", "slow"]) if (v && v[speed]) heardText.set(String(v[speed]).split("/").pop(), { text, voice, speed });
        }
      }
    }
  } catch { /* no manifest: sounds are reported without their text */ }
  const describeAudio = list => list.map(a => {
    const known = a.url ? heardText.get(String(a.url).split("/").pop()) : null;
    return known ? { ...known, dur: a.dur } : { dur: a.dur };
  });

  let step = 0;
  let lastView = null;
  let scrolled = 0;
  const seenStatic = new Set();
  const pad = n => String(n).padStart(3, "0");
  const shot = async name => {
    const file = path.join(dir, `${pad(step)}-${name}.png`);
    const buf = await page.screenshot({ path: file, scale: "css" });
    return { file, buf };
  };

  async function staticFaults() {
    const faults = await auditPage(page, !!touch);
    const fresh = [];
    for (const f of faults) {
      const k = `${f.code}|${f.sig || ""}`;
      if (seenStatic.has(k)) continue;
      seenStatic.add(k);
      delete f.sig;
      fresh.push(f);
    }
    return fresh;
  }

  async function lookNow(name = "look") {
    const { file } = await shot(name);
    lastView = await page.evaluate(() => window.__sim.view());
    return { screenshot: file, view: lastView };
  }

  // One measured action: before, act, settle, after, flags (see measure.mjs).
  async function act(type, point, doIt, describe) {
    step++;
    events.length = 0;
    const m = await measure(page, { type, point, touch: !!touch, key: describe.key || "", run: doIt });
    const before = path.join(dir, `${pad(step)}-before.png`);
    const after = path.join(dir, `${pad(step)}-after.png`);
    fs.writeFileSync(before, m.before);
    fs.writeFileSync(after, m.after);
    lastView = await page.evaluate(() => window.__sim.view());
    const res = m.res;
    const heard = describeAudio(res.audio || []);
    const flags = [...m.flags, ...events.splice(0), ...(await staticFaults())];
    log({
      type, step, ...describe,
      target: res.target || {}, heard, navigated: m.navigated, sameScreen: m.same,
      scroll: { dy: res.scrollDy, y: lastView.scrollY, max: lastView.scrollMax },
      changed: res.changed, moved: res.moved, firstMutMs: res.firstMutMs,
      flags, before, after, at: new Date().toISOString(),
    });
    return { step, target: res.target || {}, heard, flags, screenshot: after, view: lastView };
  }

  const commands = {
    async look() {
      step++;
      const v = await lookNow();
      const flags = await staticFaults();
      log({ type: "look", step, flags, after: v.screenshot, scroll: { y: v.view.scrollY, max: v.view.scrollMax }, at: new Date().toISOString() });
      return { step, flags, ...v };
    },
    async tap({ pos }) {
      const n = Number(pos[0]);
      const c = lastView?.controls.find(x => x.i === n);
      if (!c) return { error: `There is no control ${pos[0]} in the last list. Run look first.` };
      const point = { x: c.cx, y: c.cy };
      return act("tap", point, () => (touch ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y)), { control: n, point });
    },
    async tapxy({ pos }) {
      const point = { x: Number(pos[0]), y: Number(pos[1]) };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > w || point.y > h) return { error: `Point must be inside the ${w}x${h} screenshot.` };
      return act("tap", point, () => (touch ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y)), { point });
    },
    async hover({ pos }) {
      if (touch) return { error: "A touch screen has no hover." };
      const c = lastView?.controls.find(x => x.i === Number(pos[0]));
      const point = c ? { x: c.cx, y: c.cy } : { x: Number(pos[0]), y: Number(pos[1]) };
      return act("hover", point, () => page.mouse.move(point.x, point.y), { point });
    },
    async choose({ pos }) {
      const c = lastView?.controls.find(x => x.i === Number(pos[0]));
      if (!c || !c.options) return { error: `Control ${pos[0]} is not a drop-down.` };
      const want = String(pos[1] || "").toLowerCase();
      const option = c.options.find(o => o.toLowerCase() === want) || c.options.find(o => o.toLowerCase().includes(want));
      if (!option) return { error: `No option like "${pos[1]}". Options: ${c.options.join(" | ")}` };
      const point = { x: c.cx, y: c.cy };
      return act("choose", point, async () => {
        const handle = await page.evaluateHandle(([x, y]) => document.elementFromPoint(x, y)?.closest("select"), [point.x, point.y]);
        await handle.asElement()?.selectOption({ label: option });
      }, { control: Number(pos[0]), option, point });
    },
    async key({ pos }) {
      const key = pos[0];
      if (!key) return { error: "Which key?" };
      return act("key", null, () => page.keyboard.press(key), { key });
    },
    async type({ pos }) {
      return act("type", null, () => page.keyboard.type(pos.join(" "), { delay: 30 }), { text: pos.join(" ") });
    },
    async scroll({ pos }) {
      const dy = Number(pos[0]);
      if (!Number.isFinite(dy)) return { error: "scroll needs a number of pixels (negative scrolls up)." };
      step++;
      const y0 = await page.evaluate(() => scrollY);
      await page.mouse.move(Math.round(w / 2), Math.round(h / 2));
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(450);
      const v = await lookNow("after");
      const moved = v.view.scrollY - y0;
      scrolled += Math.abs(moved);
      const flags = await staticFaults();
      log({ type: "scroll", step, asked: dy, moved, flags, after: v.screenshot, scroll: { y: v.view.scrollY, max: v.view.scrollMax }, at: new Date().toISOString() });
      return { step, moved, flags, ...v };
    },
    async back() { return act("back", null, () => page.goBack().catch(() => {}), {}); },
    async reload() { return act("reload", null, () => page.reload({ waitUntil: "load" }), {}); },
    async note({ pos, flags }) {
      const wtf = Math.max(0, Math.min(3, Number(flags.wtf ?? 0)));
      log({ type: "note", step, wtf, text: pos.join(" "), expect: flags.expect || null, at: new Date().toISOString() });
      return { ok: true, noted: step };
    },
    async stop() {
      log({ type: "end", step, scrolled, at: new Date().toISOString() });
      setTimeout(async () => { await browser.close().catch(() => {}); process.exit(0); }, 50);
      return { ok: true, stopped: true };
    },
  };

  let queue = Promise.resolve();
  let idle = setTimeout(() => process.exit(0), IDLE_MS);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      clearTimeout(idle);
      idle = setTimeout(() => process.exit(0), IDLE_MS);
      queue = queue.then(async () => {
        let out;
        try {
          const msg = JSON.parse(body || "{}");
          const fn = commands[msg.cmd];
          out = fn ? await fn(msg) : { error: `Unknown command ${msg.cmd}` };
        } catch (e) {
          out = { error: String(e?.message || e) };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    log({ type: "start", label: label || "", url, viewport: `${w}x${h}`, touch: !!touch, at: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ port: server.address().port, pid: process.pid, url, viewport: `${w}x${h}`, touch: !!touch, label: label || "" }));
  });
}

// =====================================================================================
// Client
// =====================================================================================

function printView(out, { showFlags }) {
  if (out.error) { console.log(`ERROR: ${out.error}`); return; }
  if (out.ok) { console.log("ok"); return; }
  const v = out.view;
  if (out.target) console.log(`[step ${out.step}] you acted on: ${out.target.kind || "the page"} "${out.target.text || "(no visible label)"}"`);
  if (out.moved !== undefined && out.target === undefined) console.log(`[step ${out.step}] the page scrolled ${out.moved} px`);
  for (const a of out.heard || []) console.log(a.text ? `SOUND: you hear the word ${a.text}${a.speed === "slow" ? " (slowly)" : ""}` : `SOUND: a sound plays (${a.dur ?? "?"} s)`);
  if (out.heard && !out.heard.length && out.target) console.log("(no sound)");
  console.log(`screenshot: ${out.screenshot}`);
  console.log(`screen ${v.vw}x${v.vh} px. Scrolled ${v.scrollY} px down; ${Math.max(0, v.scrollMax - v.scrollY)} px more below.`);
  console.log("what you can tap on this screen (number, kind, visible text, position x,y and size):");
  for (const c of v.controls) {
    const extra = [c.disabled ? "greyed out" : "", c.pressed ? "selected" : "", c.options ? `options: ${c.options.join(" | ")}` : ""].filter(Boolean).join("; ");
    console.log(`  ${String(c.i).padStart(2)}  ${c.kind.padEnd(10)} "${c.text || "(no visible label)"}"  at ${c.x},${c.y}  ${c.w}x${c.h}${extra ? "  [" + extra + "]" : ""}`);
  }
  if (showFlags) {
    console.log("--- driver flags (never shown to simulated users) ---");
    for (const f of out.flags || []) console.log(`  [${f.sev}] ${f.code}: ${f.msg}`);
    if (!(out.flags || []).length) console.log("  none");
  }
}

async function send(dir, msg) {
  const file = path.join(dir, "session.json");
  if (!fs.existsSync(file)) return { error: `No session in ${dir}. Run start first.` };
  const { port } = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Promise(resolve => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/" }, res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({ error: "bad answer from the session" }); } });
    });
    req.on("error", e => resolve({ error: `The session is not running (${e.code || e.message}). Start it again.` }));
    req.end(JSON.stringify(msg));
  });
}

// ---------- report ----------

function readSession(dir) {
  const file = path.join(dir, "log.jsonl");
  if (!fs.existsSync(file)) return null;
  const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const start = entries.find(e => e.type === "start") || {};
  const actions = entries.filter(e => !["start", "note", "end"].includes(e.type));
  const flags = [];
  for (const e of actions) for (const f of e.flags || []) flags.push({ ...f, step: e.step, action: e.type, target: e.target ? `${e.target.kind} "${e.target.text}"` : "", before: e.before, after: e.after });
  const notes = entries.filter(e => e.type === "note");
  const scrolls = actions.filter(e => e.type === "scroll");
  return {
    dir, label: start.label || path.basename(dir), url: start.url, viewport: start.viewport, touch: start.touch,
    steps: actions.length,
    taps: actions.filter(e => e.type === "tap").length,
    scrolls: scrolls.length,
    scrolledPx: scrolls.reduce((s, e) => s + Math.abs(e.moved || 0), 0),
    flags, notes,
  };
}

function report(dirs, outDir) {
  const sessions = dirs.map(readSession).filter(Boolean);
  fs.mkdirSync(outDir, { recursive: true });
  const lines = ["# Simulated-user report", ""];
  const all = [];
  for (const s of sessions) {
    const hard = s.flags.filter(f => f.sev >= 3);
    const voiced = s.notes.filter(n => n.wtf >= 1);
    lines.push(`## ${s.label}`, "", `${s.viewport}${s.touch ? " touch" : ""} · ${s.url}`, "",
      `${s.steps} actions, ${s.taps} taps, ${s.scrolls} scrolls (${s.scrolledPx} px). Driver flags: ${s.flags.length} (${hard.length} severe). Moments the user complained about: ${voiced.length}.`, "");
    if (s.flags.length) {
      lines.push("### What the driver measured", "", "| step | sev | flag | what happened | screenshot |", "|---|---|---|---|---|");
      for (const f of [...s.flags].sort((a, b) => b.sev - a.sev || a.step - b.step)) {
        lines.push(`| ${f.step} | ${f.sev} | ${f.code} | ${String(f.msg).replace(/\|/g, "/")} | ${f.after || ""} |`);
        all.push({ session: s.label, viewport: s.viewport, ...f });
      }
      lines.push("");
    }
    if (s.notes.length) {
      lines.push("### What the user said", "");
      for (const n of [...s.notes].sort((a, b) => b.wtf - a.wtf || a.step - b.step)) {
        lines.push(`- step ${n.step}, WTF ${n.wtf}/3: “${n.text}”${n.expect ? ` (expected: ${n.expect})` : ""}`);
      }
      lines.push("");
    }
  }
  // The same fault seen by several users, most widespread first.
  // The same fault on different controls (every key of a list, say) is one fault: group by the
  // message with its names and numbers taken out.
  const shape = msg => String(msg).replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "N");
  const groups = new Map();
  for (const f of all) {
    const k = `${f.code}|${shape(f.msg)}`;
    const g = groups.get(k) || { code: f.code, sev: 0, count: 0, sessions: new Set(), targets: new Set(), example: f.msg, shot: f.after };
    g.sev = Math.max(g.sev, f.sev); g.count++; g.sessions.add(`${f.session} (${f.viewport})`);
    if (f.target) g.targets.add(f.target);
    groups.set(k, g);
  }
  const ranked = [...groups.values()].sort((a, b) => b.sev - a.sev || b.sessions.size - a.sessions.size || b.count - a.count);
  const top = ["## Faults, most severe and most widespread first", "", "| sev | flag | times | users | controls | example |", "|---|---|---|---|---|---|"];
  for (const g of ranked) top.push(`| ${g.sev} | ${g.code} | ${g.count} | ${g.sessions.size} | ${g.targets.size} | ${String(g.example).replace(/\|/g, "/")} |`);
  lines.splice(2, 0, ...top, "");
  fs.writeFileSync(path.join(outDir, "report.md"), lines.join("\n"));
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
    sessions: sessions.map(s => ({ ...s, flags: s.flags, notes: s.notes })),
    faults: ranked.map(g => ({ ...g, sessions: [...g.sessions], targets: [...g.targets].slice(0, 12) })),
  }, null, 2));
  const severe = ranked.filter(g => g.sev >= 3).length;
  console.log(`${sessions.length} sessions, ${ranked.length} distinct faults (${severe} severe), ${sessions.reduce((n, s) => n + s.notes.filter(x => x.wtf >= 2).length, 0)} strong complaints.`);
  console.log(`report: ${path.join(outDir, "report.md")}`);
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseArgs(rest);

if (!cmd || cmd === "help" || flags.help) {
  console.log(fs.readFileSync(SELF, "utf8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
} else if (cmd === "_serve") {
  serveSession({ dir: flags.dir, url: flags.url, viewport: flags.viewport || "1280x720", touch: !!flags.touch, label: flags.label }).catch(e => {
    fs.appendFileSync(path.join(flags.dir, "daemon.log"), `\n${e.stack || e}\n`);
    process.exit(1);
  });
} else if (cmd === "report") {
  let dirs = pos;
  if (flags.base) dirs = fs.readdirSync(flags.base).map(d => path.join(flags.base, d)).filter(d => fs.existsSync(path.join(d, "log.jsonl")));
  report(dirs, flags.out || flags.base || ".");
} else if (cmd === "start") {
  if (!flags.dir || !flags.url) { console.log("start needs --dir and --url"); process.exit(1); }
  const dir = path.resolve(flags.dir);
  if (fs.existsSync(path.join(dir, "session.json"))) {
    // A session is still running in this folder: end it, so no browser is left behind.
    const old = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
    await send(dir, { cmd: "stop", pos: [], flags: {} });
    try { process.kill(old.pid); } catch { /* already gone */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const logFd = fs.openSync(path.join(dir, "daemon.log"), "a");
  const args = [SELF, "_serve", "--dir", dir, "--url", flags.url, "--viewport", flags.viewport || "1280x720"];
  if (flags.touch) args.push("--touch");
  if (flags.label) args.push("--label", String(flags.label));
  spawn(process.execPath, args, { detached: true, stdio: ["ignore", logFd, logFd] }).unref();
  const until = Date.now() + 30000;
  while (!fs.existsSync(path.join(dir, "session.json")) && Date.now() < until) await new Promise(r => setTimeout(r, 150));
  if (!fs.existsSync(path.join(dir, "session.json"))) {
    console.log(`ERROR: the session did not start. ${fs.readFileSync(path.join(dir, "daemon.log"), "utf8").slice(-600)}`);
    process.exit(1);
  }
  printView(await send(dir, { cmd: "look" }), { showFlags: !!flags.flags });
} else {
  if (!flags.dir) { console.log(`${cmd} needs --dir`); process.exit(1); }
  const out = await send(path.resolve(flags.dir), { cmd, pos, flags });
  if (flags.json) console.log(JSON.stringify(out, null, 2));
  else printView(out, { showFlags: !!flags.flags });
}
