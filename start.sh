#!/bin/sh
# Start the wallp server (only if it isn't already running) and open Firefox on it.

set -e

cd "$(dirname "$0")"

PORT="${PORT:-8951}"
URL="http://localhost:${PORT}"

is_running() {
	# True if something is already listening on $PORT.
	if command -v ss >/dev/null 2>&1; then
		ss -ltn 2>/dev/null | grep -q ":${PORT} "
	elif command -v lsof >/dev/null 2>&1; then
		lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
	else
		# Last resort: try to connect.
		(exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null
	fi
}

if is_running; then
	echo "wallp already running on ${URL}"
else
	echo "starting wallp on ${URL}"
	PORT="${PORT}" node --env-file-if-exists=.env server.mjs &
	# Wait for the port to come up (max ~10s).
	i=0
	while ! is_running; do
		i=$((i + 1))
		[ "$i" -ge 100 ] && { echo "server did not start" >&2; exit 1; }
		sleep 0.1
	done
fi

chromium "${URL}" >/dev/null 2>&1 &
