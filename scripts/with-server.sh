#!/usr/bin/env bash
# Run a command with the Vite dev server up for its duration: scripts/with-server.sh <cmd...>
cd "$(dirname "$0")/.."
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/ 2>/dev/null | grep -q 200; then
  exec "$@"
fi
npx vite --port 5173 --host 127.0.0.1 --strictPort > /tmp/vite-$$.log 2>&1 &
VPID=$!
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/ 2>/dev/null | grep -q 200; then break; fi
  sleep 0.5
done
"$@"
STATUS=$?
kill $VPID 2>/dev/null
wait $VPID 2>/dev/null
exit $STATUS
