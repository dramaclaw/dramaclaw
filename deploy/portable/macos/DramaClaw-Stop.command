#!/bin/bash
# DramaClaw portable - stop script (kills only processes from this package)
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDS=$(pgrep -f "$ROOT/runtime/python/bin/python3" || true)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null
  sleep 1
  # force-kill stragglers
  PIDS2=$(pgrep -f "$ROOT/runtime/python/bin/python3" || true)
  [ -n "$PIDS2" ] && echo "$PIDS2" | xargs kill -9 2>/dev/null
  echo "DramaClaw stopped."
else
  echo "DramaClaw is not running."
fi
read -n 1 -s -r -p "Press any key to close..."
