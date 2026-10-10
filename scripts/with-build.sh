#!/usr/bin/env bash
# Build a snapshot of the app and serve it (vite preview) for the duration of a command, so
# source edits made while a long headless run is in progress can't hot-reload the page:
#   scripts/with-build.sh <outDir> <cmd...>     (the command sees APP_URL)
cd "$(dirname "$0")/.."
OUT="$1"; shift
PORT=${PORT:-4173}
npx vite build --outDir "$OUT" --emptyOutDir > /tmp/vite-build-$$.log 2>&1 || { tail -20 /tmp/vite-build-$$.log; exit 1; }
npx vite preview --outDir "$OUT" --port "$PORT" --host 127.0.0.1 --strictPort > /tmp/vite-preview-$$.log 2>&1 &
VPID=$!
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q 200; then break; fi
  sleep 0.5
done
APP_URL="http://127.0.0.1:$PORT/" "$@"
STATUS=$?
kill $VPID 2>/dev/null
# npx leaves the vite node process running on its own: stop the server for this outDir too
pkill -f "vite preview --outDir $OUT --port $PORT" 2>/dev/null
wait $VPID 2>/dev/null
exit $STATUS
