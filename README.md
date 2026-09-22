# wallp

A single-purpose webpage that shows a wallpaper, full screen, at native quality.

## Run

```sh
node server.mjs
```

Then open <http://localhost:8080>. Put images in `wallpapers/` (see
`wallpapers/README.md`).

No dependencies — plain Node (tested on v26). Nothing to install.

## Config (env vars)

| var             | default        | meaning                                   |
| --------------- | -------------- | ----------------------------------------- |
| `PORT`          | `8080`         | listen port                               |
| `WALLPAPER_DIR` | `./wallpapers` | folder to scan                            |

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
- `GET /wallpapers/<file>` — the raw image (ETag, `Range`, no re-encoding)

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
7. **`fs.watch` + SSE** to push folder changes instantly instead of the 5-min
   poll; HTTP/2 via `node:http2` or a Caddy front.
8. **Predictable schedule.** Align slot 0 to Monday 00:00 in a chosen timezone
   instead of the Unix epoch week boundary.
9. **Ambient extras.** Slow integer-pixel Ken Burns drift; dim-on-idle for OLED.
