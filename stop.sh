#!/bin/sh
# Stop the wallp server started by start.sh (whatever is listening on $PORT).

set -e

PORT="${PORT:-8951}"

listener_pids() {
	# PIDs of processes listening on $PORT.
	if command -v ss >/dev/null 2>&1; then
		ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
	elif command -v lsof >/dev/null 2>&1; then
		lsof -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null
	fi
}

PIDS="$(listener_pids)"
if [ -z "${PIDS}" ]; then
	echo "wallp not running on port ${PORT}"
	exit 0
fi

echo "stopping wallp (pid ${PIDS}) on port ${PORT}"
kill ${PIDS}

# Wait for it to exit (max ~5s), then force it.
i=0
while [ -n "$(listener_pids)" ]; do
	i=$((i + 1))
	if [ "$i" -ge 50 ]; then
		echo "still running, sending SIGKILL" >&2
		kill -9 ${PIDS} 2>/dev/null || true
		break
	fi
	sleep 0.1
done
echo "stopped"
