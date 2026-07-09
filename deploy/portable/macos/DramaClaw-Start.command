#!/bin/bash
# DramaClaw portable test build - macOS start script
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

# --- CE standalone mode (mirror docker-compose.release.yml) ---
export ST_EDITION=ce
export ST_CONTROL_PLANE_DSN=
export ST_REDIS_URL=
export ST_CELERY_BROKER_URL=
export ST_CELERY_RESULT_BACKEND=
export NEWAPI_PROVISIONER_ENABLED=true
export NEWAPI_BASE_URL="${NEWAPI_BASE_URL:-https://relayclaw.cdnfg.com/v1}"

# --- data under ~/Library/Application Support/DramaClaw ---
DATA_DIR="$HOME/Library/Application Support/DramaClaw"
mkdir -p "$DATA_DIR/state" "$DATA_DIR/output"
export NOVELVIDEO_DATA_ROOT="$DATA_DIR"
export NOVELVIDEO_STATE_DIR="$DATA_DIR/state"
export NOVELVIDEO_OUTPUT_DIR="$DATA_DIR/output"

# --- bundled runtime ---
export PYTHONPATH="$ROOT/runtime/env"
export PATH="$ROOT/runtime/ffmpeg:$PATH"
# world(3DGS/SHARP) PLY->SOG needs the bundled Node CLI
if [ -x "$ROOT/runtime/node/bin/splat-transform" ]; then
  export ST_SPLAT_TRANSFORM_BIN="$ROOT/runtime/node/bin/splat-transform"
  export PATH="$ROOT/runtime/node/bin:$PATH"
fi
export DRAMACLAW_FRONTEND_DIST="$ROOT/frontend"
export DRAMACLAW_CHAT_BACKEND=hermes
export HERMES_CLI_PATH="$ROOT/runtime/hermes/hermes.sh"
export PYTHONUTF8=1

echo "Starting DramaClaw at http://127.0.0.1:8780 ..."
echo "(first start may take ~1 minute; browser opens when ready)"
(
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 http://127.0.0.1:8780/api/v1/config >/dev/null 2>&1; then
      open http://127.0.0.1:8780
      break
    fi
    sleep 2
  done
) &
exec "$ROOT/runtime/python/bin/python3" -c "import sys; from novelvideo.cli import app; sys.exit(app())" api --host 127.0.0.1 --port 8780
