# wallp

A single-purpose webpage that shows a wallpaper, full screen, at native quality.

## Run

Wallpapers live in an S3-compatible bucket (MinIO, Garage, AWS, ...). Put the
credentials in `.env` (gitignored):

```sh
S3_URL=https://s3.example.com
BUCKET=wallpaper
ACCESS_KEY=...
SECRET_KEY=...
```

```sh
node --env-file-if-exists=.env server.mjs   # or ./start.sh
```

Then open <http://localhost:8951>.

No dependencies — plain Node (tested on v26). Nothing to install; S3 requests
are signed with SigV4 using `node:crypto`.

### Docker

```sh
docker build -t wallp .
docker run --env-file .env -p 8951:8951 wallp
```

The GitHub Action in `.github/workflows/docker.yml` builds a multi-arch image
(amd64/arm64) and pushes it to `ghcr.io/<owner>/<repo>` on pushes to `main` and
`v*` tags; pull requests only build.

## Config (env vars)

| var          | default      | meaning                                          |
| ------------ | ------------ | ------------------------------------------------ |
| `PORT`       | `8951`       | listen port                                      |
| `S3_URL`     | —            | S3 endpoint (path-style addressing)              |
| `BUCKET`     | —            | bucket name                                      |
| `ACCESS_KEY` | —            | access key id                                    |
| `SECRET_KEY` | —            | secret access key                                |
| `S3_REGION`  | `us-east-1`  | SigV4 signing region                             |
| `S3_PREFIX`  | *(root)*     | "folder" inside the bucket to scan               |
| `LIST_TTL`   | `60`         | seconds to cache the bucket listing              |

Only objects directly under the prefix with an image extension are shown.

## How the wallpaper is chosen

The displayed image is a deterministic function of the wall-clock time, like a
TOTP code — every device loading the page at the same moment shows the same
wallpaper, with no server state.

Each of the `N` images is shown exactly once per week, one slot each:

```
slotSeconds = 604800 / N
weekIndex   = floor(serverTimeSeconds / 604800)
slotIndex   = floor((serverTimeSeconds mod 604800) / slotSeconds)
order       = seededShuffle(weekIndex)   // permutation of [0, N)
imageIndex  = order[slotIndex]
```

`seededShuffle` is a Fisher-Yates shuffle driven by a small PRNG (mulberry32)
seeded from `weekIndex`, so the order is different every week but identical
across every device for that week — no coordination needed. On each slot
boundary the page cross-fades to the next image in that week's order. The
browser trusts the server's clock (`serverTime` in `/api/wallpapers`), not its
own.

## Keys

| key            | action                                                        |
| -------------- | ------------------------------------------------------------- |
| `f`            | toggle fullscreen                                             |
| `→` / `←`      | peek at other wallpapers (snaps back at the next slot)        |
| `Esc`          | stop peeking, return to the scheduled wallpaper              |

The cursor hides after 2s of no movement.

## Endpoints

- `GET /` — the page
- `GET /api/wallpapers` — `{ images, count, serverTime, slotSeconds }`
- `GET /wallpapers/<file>` — the raw image, proxied from S3 (ETag, `Range`, no re-encoding)
- `GET /current` — the image scheduled right now, served directly (same bytes as
  `/wallpapers/<file>`), so it works as a plain image URL for other tools.
  `Cache-Control: max-age` lasts until the slot ends; the filename is in
  `X-Wallpaper` and `Content-Disposition`. `?add=N` returns the image `N` steps
  from the scheduled one, the same as pressing `→` `N` times in the page
  (negative `N` for `←`); it wraps around the sorted image list.
- `GET /random` — a random image on every request (`Cache-Control: no-store`),
  same headers otherwise.

## Making it look even better

The page already serves original bytes untouched, uses `<img>` + `object-fit:
cover` with no fractional transforms, decodes each image before showing it, and
honours EXIF orientation. Bigger wins from here, roughly in order:

1. **Resolution-matched sources.** Upscaling a 1080p image onto a 4K/HiDPI panel
   looks soft. Keep multiple sizes per wallpaper and serve the smallest one that
   still covers `devicePixelRatio * viewport`.
2. **AVIF/JXL at visually-lossless quality** via an optional `sharp`/`ffmpeg`
   build step — same look, much smaller, faster first paint; serve with
   `<picture>` + original fallback.
3. **Blur-up placeholder.** Ship a ~20px blurred data-URI per image in the API
   response so a cold load is never black.
4. **Wide gamut / HDR.** Preserve ICC profiles; offer Display-P3 / HDR (AVIF
   PQ/HLG) variants behind `@media (dynamic-range: high)`.
5. **Service worker** cache-first for `wallpapers/*`, pre-caching upcoming slots
   so transitions never touch the network.
6. **Content-hashed filenames** → `Cache-Control: immutable` and no revalidation.
7. **Bucket notifications + SSE** to push bucket changes instantly instead of the 5-min
   poll; HTTP/2 via `node:http2` or a Caddy front.
8. **Predictable schedule.** Align slot 0 to Monday 00:00 in a chosen timezone
   instead of the Unix epoch week boundary.
9. **Ambient extras.** Slow integer-pixel Ken Burns drift; dim-on-idle for OLED.
