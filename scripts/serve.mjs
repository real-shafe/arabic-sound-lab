// Tiny static server for public/, so the page can load its modules, clips and
// service worker over http (they don't load from file://). No dependencies.
//
//   npm run dev            http://localhost:5173
//   PORT=8080 npm run dev
//
// localhost counts as a secure context, so the service worker and the
// microphone work here as they do on https.

import { createServer } from "node:http";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public"));
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function send(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/** Absolute path of the file for a URL path, or null if it isn't a servable file inside public/. */
function resolveFile(urlPath) {
  let path;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed %-escape
  }
  if (path.includes("\0")) return null;
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC + sep)) return null;
  // Like Cloudflare, don't serve the _headers config or dotfiles.
  if (basename(file).startsWith("_") || file.slice(PUBLIC.length).split(sep).some(part => part.startsWith("."))) return null;
  let real;
  try {
    real = realpathSync(file); // follows symlinks, so check where they lead too
  } catch {
    return null;
  }
  if (!real.startsWith(PUBLIC + sep)) return null;
  return real;
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    send(res, 405, "Method not allowed");
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    send(res, 400, "Bad request");
    return;
  }
  const file = resolveFile(pathname);
  let stat = null;
  if (file) {
    try { stat = statSync(file); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    send(res, 404, "Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});

server.on("error", err => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is in use. Try PORT=5174 npm run dev` : err.message);
  process.exitCode = 1;
});

server.listen(PORT, () => console.log(`Arabic Sound Lab on http://localhost:${PORT}`));
