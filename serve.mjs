/**
 * Static file server for the app, with caching switched off.
 *
 * `python -m http.server` answers with 304 Not Modified based on timestamps,
 * which during development hands out a mix of old and new files — an old
 * index.html against new modules renders a page whose buttons are wired to
 * nothing. Every response here carries no-store, so a reload is always a real
 * reload.
 *
 * Run:  node serve.mjs        →  http://localhost:5173/
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const PORT = Number(process.env.PORT || 5173);
const ROOT = process.cwd();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".sql": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  const noCache = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  };

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";

    // Keep the request inside the project directory.
    const target = normalize(join(ROOT, path));
    if (!target.startsWith(ROOT + sep) && target !== ROOT) {
      res.writeHead(403, noCache).end("Forbidden");
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { ...noCache, "Content-Type": "text/plain" }).end("Not found");
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      ...noCache,
      "Content-Type": TYPES[extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { ...noCache, "Content-Type": "text/plain" }).end(String(error.message));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Planning Poker on http://localhost:${PORT}/`);
  console.log("Caching is disabled — every reload fetches fresh files.");
});
