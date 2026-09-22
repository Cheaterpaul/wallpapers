// Zero-dependency wallpaper server.
//
// Serves index.html, a JSON listing of the wallpapers/ folder, and the raw
// image files themselves (with ETag / Range support). No npm install needed.
//
//   node server.mjs
//
// Config via env vars:
//   PORT           listen port                (default 8080)
//   WALLPAPER_DIR  folder to scan for images  (default ./wallpapers)
//
// Each image is shown exactly once per week; the order is reshuffled every
// week using the week number as a seed (see index.html for the client-side
// scheduling math).

import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8951;
const WALLPAPER_DIR = path.resolve(HERE, process.env.WALLPAPER_DIR || "wallpapers");
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const IMAGE_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".jxl",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".jxl": "image/jxl",
};

function contentType(ext) {
  return MIME[ext.toLowerCase()] || "application/octet-stream";
}

// Natural sort: "img2.jpg" before "img10.jpg".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
function naturalSort(a, b) {
  return collator.compare(a, b);
}

// Join a user-supplied name onto dir, refusing anything that escapes it.
function safeJoin(dir, name) {
  const decoded = decodeURIComponent(name);
  const full = path.resolve(dir, "." + path.sep + decoded);
  const rel = path.relative(dir, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

async function listWallpapers() {
  let entries;
  try {
    entries = await readdir(WALLPAPER_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort(naturalSort);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function notFound(res, msg = "Not found") {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

async function serveIndex(res) {
  try {
    const html = await readFile(path.join(HERE, "index.html"));
    res.writeHead(200, {
      "Content-Type": MIME[".html"],
      "Content-Length": html.length,
      "Cache-Control": "no-store",
    });
    res.end(html);
  } catch {
    notFound(res, "index.html missing");
  }
}

async function serveApi(res) {
  const images = await listWallpapers();
  const count = images.length;
  const slotSeconds = count > 0 ? WEEK_SECONDS / count : null;
  sendJson(res, 200, {
    images,
    count,
    serverTime: Date.now(),
    slotSeconds,
  });
}

async function serveImage(req, res, name) {
  const full = safeJoin(WALLPAPER_DIR, name);
  if (!full) return notFound(res, "Bad path");

  let info;
  try {
    info = await stat(full);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);

  const ext = path.extname(full).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return notFound(res);

  const etag = `"${info.mtimeMs.toString(36)}-${info.size.toString(36)}"`;
  const baseHeaders = {
    "Content-Type": contentType(ext),
    "Cache-Control": "public, max-age=300",
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders);
    return res.end();
  }

  // Range support for large images.
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === "" ? null : Number(m[1]);
      let end = m[2] === "" ? null : Number(m[2]);
      if (start === null) {
        // suffix range: last N bytes
        start = Math.max(0, info.size - (end ?? 0));
        end = info.size - 1;
      } else if (end === null || end >= info.size) {
        end = info.size - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
        res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${info.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": end - start + 1,
      });
      if (req.method === "HEAD") return res.end();
      return createReadStream(full, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, { ...baseHeaders, "Content-Length": info.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end("Method not allowed");
    }

    if (pathname === "/" || pathname === "/index.html") return serveIndex(res);
    if (pathname === "/api/wallpapers") return serveApi(res);
    if (pathname.startsWith("/wallpapers/")) {
      return serveImage(req, res, pathname.slice("/wallpapers/".length));
    }
    if (pathname === "/favicon.ico") return notFound(res);

    notFound(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end("Server error");
  }
});

server.listen(PORT, async () => {
  const images = await listWallpapers();
  const slot = images.length ? WEEK_SECONDS / images.length : null;
  console.log(`wallp -> http://localhost:${PORT}`);
  console.log(`  folder : ${WALLPAPER_DIR}`);
  console.log(`  images : ${images.length}`);
  if (slot) {
    const mins = Math.round(slot / 60);
    console.log(`  slot   : ${mins} min  (each image 1x / week, reshuffled weekly)`);
  } else {
    console.log(`  slot   : n/a  (drop images into the folder)`);
  }
});
