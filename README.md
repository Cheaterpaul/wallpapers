# wallpapers

A single-purpose webpage that shows a wallpaper, full screen, at native quality.

Point it at an S3-compatible bucket of images and open the page on any screen: a
TV, a spare monitor, a kiosk. It cross-fades through the collection on a schedule,
and every device shows the same image at the same time without any coordination.

- **Whole collection, every week:** each image is shown exactly once per week, in
  a different order each week.
- **In sync everywhere:** the image depends only on the time, so there is no
  database and no state to keep.
- **Original quality:** image bytes are passed through untouched.
- **Usable from other tools:** `/current` and `/random` work as plain image URLs.
- **No dependencies:** one Node file and one HTML file, with no `npm install`.

## Quick start

You need an S3-compatible bucket (MinIO, Garage, AWS, ...) with some images in
it, plus either Node 22.9 or newer (developed on v26) or Docker.

1. Clone the repository and create a `.env` file in it (it's gitignored):

   ```sh
   S3_URL=https://s3.example.com
   BUCKET=wallpaper
   ACCESS_KEY=...
   SECRET_KEY=...
   ```

2. Start the server:

   ```sh
   node --env-file-if-exists=.env server.mjs
   ```

3. Open <http://localhost:8951> and press `f` to go fullscreen.

The server only reads from the bucket, so a read-only key is enough: it needs
`s3:ListBucket` and `s3:GetObject`. On AWS, set `S3_URL` to the regional endpoint
(e.g. `https://s3.eu-central-1.amazonaws.com`) and `S3_REGION` to match.

### Helper scripts

`./start.sh` starts the server if it isn't already running and opens the page in
Chromium. `./stop.sh` stops whatever is listening on `PORT`.

### Docker

A ready-made image for amd64 and arm64 is published to the GitHub Container
Registry, so you don't need to clone the repository. Create the `.env` file from
step 1 above, then run:

```sh
docker run -d --restart unless-stopped --env-file .env -p 8951:8951 \
  ghcr.io/cheaterpaul/wallpapers:latest
```

| image tag       | contents                                   |
| --------------- | ------------------------------------------ |
| `latest`        | the most recent release                    |
| `v1.2.3`        | a specific release, named after its git tag |
| `bleeding-edge` | the newest commit on `main`, unreleased    |

To build the image yourself instead:

```sh
docker build -t wallpapers .
docker run -d --restart unless-stopped --env-file .env -p 8951:8951 wallpapers
```

The image is built by the GitHub Action in `.github/workflows/docker.yml` on pushes
to `main` and `v*` tags; pull requests only build it.

## Adding wallpapers

Upload images to the bucket; no restart is needed. The server re-reads the bucket
every `LIST_TTL` seconds and open pages pick up the change within 5 minutes.

Supported formats are `jpg`, `jpeg`, `png`, `webp`, `avif`, `gif`, `bmp` and `jxl`,
as long as the viewing browser can display them. Subfolders are ignored; use
`S3_PREFIX` to point at one.

`prepare.sh` is an optional helper that needs `ffmpeg`. It converts every image in
a folder (`./new` by default) to a compressed JPEG named `img_NNNN.jpg`, counting
up from the index you give it. **It replaces the originals**, so run it on a copy:

```sh
./prepare.sh 1                 # new/* -> img_0001.jpg, img_0002.jpg, ...
QUALITY=2 ./prepare.sh 42 ~/pics   # 2 is the best quality, 31 the smallest files
```

Adding or removing images changes the schedule straight away, because the length
of each slot depends on the number of images.

## Using it from other tools

`/current` and `/random` return the image itself, so anything that can fetch a URL
can use them:

```sh
curl -o wallpaper.jpg http://localhost:8951/current    # what's on screen now
curl -o next.jpg "http://localhost:8951/current?add=1" # one step further along
curl -o random.jpg http://localhost:8951/random        # a new pick every time
```

Images keep their original format, so the saved file may not really be a JPEG if
your bucket holds other types. See [Endpoints](#endpoints) for the details.

## Security

**The server has no authentication.** Anyone who can reach the port can view every
image in the bucket prefix. If it's reachable from outside your own network, put it
behind a reverse proxy that handles login and HTTPS. The S3 credentials stay on the
server and are never sent to the browser.

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
- `GET /favicon.svg` — the page icon, embedded in `server.mjs` (also served at `/favicon.ico`)
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

## License

[MIT](LICENSE)
