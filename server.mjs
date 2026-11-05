// Zero-dependency wallpaper server.
//
// Serves index.html, a JSON listing of the wallpapers in an S3 bucket, and the
// raw image files themselves (proxied from S3, with ETag / Range support). No
// npm install needed — requests are signed with AWS SigV4 via node:crypto.
//
//   node --env-file-if-exists=.env server.mjs
//
// Config via env vars:
//   PORT        listen port                                (default 8951)
//   S3_URL      S3 endpoint, e.g. https://s3.example.com   (required)
//   BUCKET      bucket name                                (required)
//   ACCESS_KEY  access key id                              (required)
//   SECRET_KEY  secret access key                          (required)
//   S3_REGION   signing region                             (default us-east-1)
//   S3_PREFIX   key prefix ("folder") inside the bucket    (default: bucket root)
//   LIST_TTL    seconds to cache the bucket listing        (default 60)
//
// Each image is shown exactly once per week; the order is reshuffled every
// week using the week number as a seed (see index.html for the client-side
// scheduling math, mirrored here for GET /current).

import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8951;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const S3 = {
  endpoint: (process.env.S3_URL || "").replace(/\/+$/, ""),
  bucket: process.env.BUCKET || "",
  accessKey: process.env.ACCESS_KEY || "",
  secretKey: process.env.SECRET_KEY || "",
  region: process.env.S3_REGION || "us-east-1",
  prefix: (process.env.S3_PREFIX || "").replace(/^\/+|\/+$/g, ""),
};
if (S3.prefix) S3.prefix += "/";
const LIST_TTL_MS = (Number(process.env.LIST_TTL) || 60) * 1000;

const missing = ["S3_URL", "BUCKET", "ACCESS_KEY", "SECRET_KEY"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

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

// ---------------------------------------------------------------------------
// Minimal S3 client (path-style addressing, AWS Signature Version 4).

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const EMPTY_SHA256 = sha256Hex("");

// RFC 3986 encoding as SigV4 expects it (encodeURIComponent leaves !'()* alone).
function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// Signed fetch against `/<bucket>/<key>` with the given query params.
async function s3Fetch(key, query = {}, { headers = {}, signal } = {}) {
  const base = new URL(S3.endpoint);
  const basePath = base.pathname.replace(/\/+$/, "");
  const canonicalUri =
    basePath + "/" + [S3.bucket, ...(key ? key.split("/") : [])].map(uriEncode).join("/");
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(String(query[k]))}`)
    .join("&");

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${S3.region}/s3/aws4_request`;

  const signed = { host: base.host, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": amzDate };
  const signedNames = Object.keys(signed).sort();
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    signedNames.map((h) => `${h}:${signed[h]}\n`).join(""),
    signedNames.join(";"),
    EMPTY_SHA256,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  let k = hmac("AWS4" + S3.secretKey, dateStamp);
  k = hmac(k, S3.region);
  k = hmac(k, "s3");
  k = hmac(k, "aws4_request");
  const signature = createHmac("sha256", k).update(stringToSign).digest("hex");

  const url = `${base.origin}${canonicalUri}${canonicalQuery ? "?" + canonicalQuery : ""}`;
  return fetch(url, {
    headers: {
      ...headers,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": amzDate,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${S3.accessKey}/${scope}, ` +
        `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
    },
    signal,
  });
}

function xmlDecode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

// All object keys directly under S3.prefix (non-recursive, like the old readdir).
async function listObjects() {
  const keys = [];
  let token;
  do {
    const query = { "list-type": "2", delimiter: "/", prefix: S3.prefix };
    if (token) query["continuation-token"] = token;
    const res = await s3Fetch("", query);
    const xml = await res.text();
    if (!res.ok) throw new Error(`S3 list failed: ${res.status} ${xml.slice(0, 300)}`);
    for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)) {
      keys.push(xmlDecode(m[1]));
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated ? xmlDecode(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : null;
  } while (token);
  return keys;
}

// Cached listing so every client poll doesn't hit the bucket.
let listCache = { at: 0, images: [], pending: null };

async function listWallpapers() {
  if (Date.now() - listCache.at < LIST_TTL_MS) return listCache.images;
  listCache.pending ??= listObjects()
    .then((keys) => {
      const images = keys
        .map((k) => k.slice(S3.prefix.length))
        .filter((n) => n && IMAGE_EXT.has(path.extname(n).toLowerCase()))
        .sort(naturalSort);
      listCache = { at: Date.now(), images, pending: null };
      return images;
    })
    .catch((err) => {
      console.error(err.message);
      listCache.pending = null;
      return listCache.images; // serve the last good listing on failure
    });
  return listCache.pending;
}

// ---------------------------------------------------------------------------
// Weekly schedule — must stay identical to the copy in index.html.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(n) {
  n = (n ^ 0xdeadbeef) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 2654435761);
  n = Math.imul(n ^ (n >>> 13), 2246822519);
  n ^= n >>> 16;
  return n >>> 0;
}

function shuffledOrder(weekIndex, n) {
  const order = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(hashSeed(weekIndex));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// The scheduled image at `atMs`, plus ms until it changes.
function currentSlot(images, atMs = Date.now()) {
  const weekMs = WEEK_SECONDS * 1000;
  const weekIndex = Math.floor(atMs / weekMs);
  const slotMs = weekMs / images.length;
  const posInWeek = atMs - weekIndex * weekMs;
  const slotPos = Math.min(images.length - 1, Math.floor(posInWeek / slotMs));
  const imageIndex = shuffledOrder(weekIndex, images.length)[slotPos];
  return { imageIndex, msToNext: slotMs - (posInWeek % slotMs) };
}

// ---------------------------------------------------------------------------

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

// The image scheduled right now, served directly (no redirect) so it can be
// used as a plain image URL. Cacheable only until the slot ends.
//
// `?add=N` steps N images away from the scheduled one, like pressing the arrow
// keys in the page N times: it walks the sorted image list (wrapping around),
// not the weekly shuffle order. Negative N steps backwards.
async function serveCurrent(req, res, url) {
  const add = Number(url.searchParams.get("add") ?? 0);
  if (!Number.isSafeInteger(add)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("add must be an integer");
  }
  const images = await listWallpapers();
  if (!images.length) return notFound(res, "No wallpapers");
  const { imageIndex, msToNext } = currentSlot(images);
  const n = images.length;
  const name = images[(((imageIndex + (add % n)) % n) + n) % n];
  return serveImageNamed(req, res, name, {
    "Cache-Control": `public, max-age=${Math.max(0, Math.floor(msToNext / 1000))}`,
    ...nameHeaders(name),
  });
}

// A different random image on every request; never cached.
async function serveRandom(req, res) {
  const images = await listWallpapers();
  if (!images.length) return notFound(res, "No wallpapers");
  const name = images[Math.floor(Math.random() * images.length)];
  // Strip conditional/range headers: they'd refer to a previous random pick.
  for (const h of ["range", "if-none-match", "if-modified-since"]) delete req.headers[h];
  return serveImageNamed(req, res, name, { "Cache-Control": "no-store", ...nameHeaders(name) });
}

function nameHeaders(name) {
  return {
    "Content-Disposition": `inline; filename*=UTF-8''${uriEncode(name)}`,
    "X-Wallpaper": uriEncode(name),
  };
}

// Proxy an image from S3, passing Range / conditional headers straight through.
async function serveImage(req, res, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return notFound(res, "Bad path");
  }
  if (!name || name.includes("/") || name.includes("\\")) return notFound(res, "Bad path");
  return serveImageNamed(req, res, name);
}

async function serveImageNamed(req, res, name, extraHeaders = {}) {
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return notFound(res);

  const fwd = {};
  for (const h of ["range", "if-none-match", "if-modified-since"]) {
    if (req.headers[h]) fwd[h] = req.headers[h];
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const upstream = await s3Fetch(S3.prefix + name, {}, { headers: fwd, signal: abort.signal });

  if (upstream.status === 404 || upstream.status === 403) {
    await upstream.body?.cancel();
    return notFound(res);
  }
  if (![200, 206, 304, 416].includes(upstream.status)) {
    const text = await upstream.text();
    console.error(`S3 GET ${name} failed: ${upstream.status} ${text.slice(0, 300)}`);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Upstream error");
  }

  const headers = {
    "Content-Type": contentType(ext),
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "Accept-Ranges": "bytes",
    ...extraHeaders,
  };
  for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }

  res.writeHead(upstream.status, headers);
  if (req.method === "HEAD" || !upstream.body || upstream.status === 304) {
    await upstream.body?.cancel();
    return res.end();
  }
  Readable.fromWeb(upstream.body)
    .on("error", () => res.destroy())
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end("Method not allowed");
    }

    if (pathname === "/" || pathname === "/index.html") return await serveIndex(res);
    if (pathname === "/api/wallpapers") return await serveApi(res);
    if (pathname === "/current") return await serveCurrent(req, res, url);
    if (pathname === "/random") return await serveRandom(req, res);
    if (pathname.startsWith("/wallpapers/")) {
      return await serveImage(req, res, pathname.slice("/wallpapers/".length));
    }
    if (pathname === "/favicon.ico") return notFound(res);

    notFound(res);
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end("Server error");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

server.listen(PORT, async () => {
  const images = await listWallpapers();
  const slot = images.length ? WEEK_SECONDS / images.length : null;
  console.log(`wallp -> http://localhost:${PORT}`);
  console.log(`  bucket : ${S3.endpoint}/${S3.bucket}/${S3.prefix}`);
  console.log(`  images : ${images.length}`);
  if (slot) {
    const mins = Math.round(slot / 60);
    console.log(`  slot   : ${mins} min  (each image 1x / week, reshuffled weekly)`);
  } else {
    console.log(`  slot   : n/a  (upload images to the bucket)`);
  }
});
