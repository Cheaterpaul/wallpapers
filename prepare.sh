#!/usr/bin/env bash
# Convert every image in a folder to a compressed JPEG named img_NNNN.jpg,
# counting up from a given start index. Originals are replaced.
#
#   ./prepare.sh <start-index> [folder]      (folder defaults to ./new)
#
# Env vars:
#   QUALITY  ffmpeg JPEG quality, 2 (best) .. 31 (smallest)   (default 3)
#
# Files are processed in natural sort order ("a2.png" before "a10.png").
# Everything is converted into a temp folder first; originals are only
# removed once all conversions have succeeded.

set -euo pipefail

usage() {
	echo "usage: $0 <start-index> [folder]" >&2
	exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
[[ "$1" =~ ^[0-9]+$ ]] || { echo "start index must be a non-negative integer" >&2; usage; }

START=$((10#$1))
DIR="${2:-$(dirname "$0")/new}"
QUALITY="${QUALITY:-3}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
[ -d "$DIR" ] || { echo "folder not found: $DIR" >&2; exit 1; }

mapfile -d '' FILES < <(
	find "$DIR" -maxdepth 1 -type f \
		-iregex '.*\.\(jpe?g\|png\|webp\|avif\|gif\|bmp\|jxl\|tiff?\|heic\)' \
		-print0 | sort -zV
)

if [ ${#FILES[@]} -eq 0 ]; then
	echo "no images in $DIR"
	exit 0
fi

TMP="$(mktemp -d "$DIR/.prepare.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

i=$START
for src in "${FILES[@]}"; do
	name="$(printf 'img_%04d.jpg' "$i")"
	echo "$(basename "$src") -> $name"
	ffmpeg -nostdin -loglevel error -y -i "$src" \
		-frames:v 1 -update 1 -pix_fmt yuvj420p -q:v "$QUALITY" \
		"$TMP/$name"
	i=$((i + 1))
done

# All conversions succeeded: swap originals for the new files.
rm -f -- "${FILES[@]}"
mv -- "$TMP"/img_*.jpg "$DIR"/

echo "done: ${#FILES[@]} images -> img_$(printf '%04d' "$START") .. img_$(printf '%04d' $((i - 1)))"
