// Shared by the UI contract test (tests/ui.test.mjs) and the simulated-user driver (tests/ui/sim.mjs):
// find a Chrome to drive with playwright-core, and serve public/ on a free port.

import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Path of a Chrome or Chromium binary, or null. CHROME_PATH wins. */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
      candidates.push(join(cache, dir, "chrome-linux64", "chrome"), join(cache, dir, "chrome-linux", "chrome"));
    }
  }
  return candidates.find(p => existsSync(p)) || null;
}

/** playwright-core's chromium, or null when the package is not installed. */
export async function loadChromium() {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    return null;
  }
}

/** Launch headless Chrome. Throws a readable error when there is none. */
export async function launch() {
  const chromium = await loadChromium();
  const executablePath = findChrome();
  if (!chromium) throw new Error("playwright-core is not installed (npm install)");
  if (!executablePath) throw new Error("No Chrome found; set CHROME_PATH");
  // CI runners (GitHub Actions) have no user namespace for Chrome's sandbox.
  const args = ["--disable-audio-output", "--hide-scrollbars", ...(process.env.CI ? ["--no-sandbox"] : [])];
  return chromium.launch({ executablePath, headless: true, args });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Serve public/ with scripts/serve.mjs on a free port. Returns { url, stop }. */
export async function serve() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "scripts", "serve.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("static server did not start")), 8000);
    child.stdout.on("data", () => { clearTimeout(timer); resolve(); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`static server exited (${code})`)); });
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}
