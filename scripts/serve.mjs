// Tiny static server for public/, so the page can load its modules and clips
// over http (they don't load from file://). No dependencies.
//
//   npm run dev            http://localhost:5173
//   PORT=8080 npm run dev

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC + sep)) { res.writeHead(403).end(); return; }
  let stat;
  try { stat = statSync(file); } catch { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
  if (!stat.isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-cache",
  });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Arabic Sound Lab on http://localhost:${PORT}`));
