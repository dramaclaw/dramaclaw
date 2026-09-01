#!/usr/bin/env bash
# Start the SuperTale CE API and bundled frontend locally.
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

api_port="${NOVELVIDEO_API_PORT:-8780}"
api_host="${NOVELVIDEO_API_HOST:-0.0.0.0}"
frontend_port="${SUPERTALE_FE_PORT:-5173}"
frontend_host="${SUPERTALE_FE_HOST:-0.0.0.0}"
api_ready_timeout="${NOVELVIDEO_API_READY_TIMEOUT:-90}"
api_pid=""
fe_pid=""

cleanup() {
  trap - INT TERM EXIT
  if [ -n "$fe_pid" ] && kill -0 "$fe_pid" >/dev/null 2>&1; then
    echo "Stopping frontend..."
    kill "$fe_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$api_pid" ] && kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "Stopping API..."
    kill "$api_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$fe_pid" ] || [ -n "$api_pid" ]; then
    wait "$fe_pid" "$api_pid" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it first: https://docs.astral.sh/uv/" >&2
  exit 2
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required for the bundled frontend. Install it first: corepack enable && corepack prepare pnpm@11.5.0 --activate" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the local API health check." >&2
  exit 2
fi

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "Created .env from .env.example."
    echo "Edit .env and set NEWAPI_BASE_URL / NEWAPI_API_KEY for generation features."
  else
    echo ".env.example is missing; continuing with shell environment only." >&2
  fi
fi

if [ -f ".env" ]; then
  set -a
  # shellcheck source=/dev/null
  source ".env"
  set +a
fi

# Force standalone CE mode. Empty strings intentionally override any .env values.
export ST_EDITION=ce
export ST_CONTROL_PLANE_DSN=
export ST_REDIS_URL=
export ST_CELERY_BROKER_URL=
export ST_CELERY_RESULT_BACKEND=
export NOVELVIDEO_API_HOST="$api_host"
export NOVELVIDEO_API_PORT="$api_port"
export NOVELVIDEO_API_URL="http://127.0.0.1:${api_port}"
export DRAMACLAW_API_URL="$NOVELVIDEO_API_URL"
export SUPERTALE_API_URL="$NOVELVIDEO_API_URL"
# Make the local CE storage roots explicit so Hermes does not emit a fallback
# warning on every first chat turn. These are the same paths derived from the
# repository root when no overrides are provided.
export NOVELVIDEO_DATA_ROOT="${NOVELVIDEO_DATA_ROOT:-$root_dir}"
export NOVELVIDEO_STATE_DIR="${NOVELVIDEO_STATE_DIR:-$NOVELVIDEO_DATA_ROOT/state}"
export NOVELVIDEO_OUTPUT_DIR="${NOVELVIDEO_OUTPUT_DIR:-$NOVELVIDEO_DATA_ROOT/output}"
export NOVELVIDEO_RUNTIME_DIR="${NOVELVIDEO_RUNTIME_DIR:-$NOVELVIDEO_DATA_ROOT/runtime}"

if [ "${NEWAPI_API_KEY:-}" = "your_newapi_token" ] || [ -z "${NEWAPI_API_KEY:-}" ]; then
  echo "Warning: NEWAPI_API_KEY is not configured. API can start, but AI generation will fail." >&2
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Warning: ffmpeg is not on PATH. Video/audio processing may fail." >&2
fi

echo "Checking/installing dependencies with uv sync --group dev ..."
uv sync --group dev

# Keep the Hermes fork in its own environment. The fork currently pins an
# older OpenAI SDK than pydantic-ai requires for Recipe text execution; putting
# both in the application .venv makes setup-hermes silently downgrade the API
# runtime and every generate_text action fails before its model request starts.
hermes_env_dir="${HERMES_ENV_DIR:-$root_dir/.cache/hermes-venv}"
export HERMES_ENV_DIR="$hermes_env_dir"
export HERMES_CLI_PATH="${HERMES_CLI_PATH:-$hermes_env_dir/bin/hermes}"
export HERMES_PYTHON="${HERMES_PYTHON:-$hermes_env_dir/bin/python}"
export HERMES_BASE_PYTHON="${HERMES_BASE_PYTHON:-$root_dir/.venv/bin/python}"
echo "Checking Hermes CLI version ..."
scripts/setup-hermes.sh

if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend dependencies with pnpm install ..."
  (cd frontend && pnpm install)
fi

echo "Starting SuperTale CE API at http://${api_host}:${api_port}/api/v1"
echo "Health check: http://127.0.0.1:${api_port}/api/v1/config"
# Dependencies are synchronized explicitly above.  `uv run` otherwise performs
# an implicit sync in this background process, which can download the 100+ MiB
# Codex binary while the readiness timeout is already counting down.
uv run --no-sync novelvideo api --host "$api_host" --port "$api_port" &
api_pid="$!"

echo "Waiting for API readiness..."
api_ready_url="http://127.0.0.1:${api_port}/api/v1/config"
api_ready_deadline=$((SECONDS + api_ready_timeout))
until curl -fsS --max-time 2 "$api_ready_url" >/dev/null 2>&1; do
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "API process exited before becoming ready." >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$api_ready_deadline" ]; then
    echo "API did not become ready within ${api_ready_timeout}s: ${api_ready_url}" >&2
    exit 1
  fi
  sleep 1
done
echo "API is ready."

echo "Starting SuperTale CE frontend at http://127.0.0.1:${frontend_port}"
echo "Frontend API target comes from frontend/.env"
(
  cd frontend
  pnpm dev --host "$frontend_host" --port "$frontend_port"
) &
fe_pid="$!"

echo "Press Ctrl+C to stop."

while true; do
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then
    echo "API process exited."
    exit 1
  fi
  if ! kill -0 "$fe_pid" >/dev/null 2>&1; then
    echo "Frontend process exited."
    exit 1
  fi
  sleep 1
done
