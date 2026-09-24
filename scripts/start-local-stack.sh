#!/usr/bin/env bash
# Start DramaClaw without Docker.  Local configuration is kept in an ignored
# project-root folder, so it is portable with the checkout but never tracked or
# replaced by a normal source update.
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

config_dir="${DRAMACLAW_LOCAL_CONFIG_DIR:-$root_dir/.dramaclaw-local}"
local_env_file="$config_dir/local.env"
if [[ -f "$local_env_file" ]]; then
  # This file is user-owned and ignored by git.  It is ordinary shell syntax
  # so paths containing spaces can be quoted without inventing a parser.
  set -a
  # shellcheck source=/dev/null
  source "$local_env_file"
  set +a
fi
# Existing command-line CE installs historically keep projects in ./state.
# Reuse that data when it exists so switching to this wrapper does not make a
# user's projects appear to disappear; new installs still use a source-external
# data directory by default.
if [ -n "${DRAMACLAW_LOCAL_DATA_DIR:-}" ]; then
  data_dir="$DRAMACLAW_LOCAL_DATA_DIR"
elif [ -d "$root_dir/state/local" ]; then
  data_dir="$root_dir"
else
  data_dir="$HOME/.local/share/dramaclaw-local"
fi

export ST_EDITION=ce
export DRAMACLAW_LOCAL_CONFIG_DIR="$config_dir"
export NOVELVIDEO_DATA_ROOT="$data_dir"
export NOVELVIDEO_OUTPUT_DIR="$data_dir/output"
export NOVELVIDEO_STATE_DIR="$data_dir/state"
export NOVELVIDEO_RUNTIME_DIR="$data_dir/runtime"
export NEWAPI_PROVISIONER_ENABLED=false
# The source still contains compatibility choices for hosted CE deployments.
# This command-line profile exposes and defaults to the local Qwen workflow.
export LOCAL_QWEN_IMAGE_MODEL="${LOCAL_QWEN_IMAGE_MODEL:-Qwen-Image-local}"
export DRAMACLAW_LOCAL_MODELS_ONLY="${DRAMACLAW_LOCAL_MODELS_ONLY:-1}"
export DEFAULT_SKETCH_IMAGE_SELECTION="${DEFAULT_SKETCH_IMAGE_SELECTION:-newapi_qwen_image_local}"
export DEFAULT_RENDER_IMAGE_SELECTION="${DEFAULT_RENDER_IMAGE_SELECTION:-newapi_qwen_image_local}"
export DEFAULT_CHARACTER_IMAGE_SELECTION="${DEFAULT_CHARACTER_IMAGE_SELECTION:-newapi_qwen_image_local}"
# PyTorch's MPS backend still lacks the int8 matrix operator used by Krea's
# ConvRot weights, so let unsupported kernels fall back to CPU on macOS.
if [[ "$(uname -s)" == "Darwin" ]]; then
  export PYTORCH_ENABLE_MPS_FALLBACK="${PYTORCH_ENABLE_MPS_FALLBACK:-1}"
fi

mkdir -p "$data_dir"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to select safe local service ports." >&2
  exit 2
fi

port_is_available() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.bind((host, port))
PY
}

select_available_port() {
  local variable_name="$1"
  local default_port="$2"
  local bind_host="$3"
  local service_name="$4"
  local configured_port="${!variable_name:-}"
  local selected_port="${configured_port:-$default_port}"

  if [[ ! "$selected_port" =~ ^[0-9]+$ ]]; then
    echo "$variable_name must be an integer between 1 and 65535." >&2
    exit 2
  fi
  selected_port=$((10#$selected_port))
  if (( selected_port < 1 || selected_port > 65535 )); then
    echo "$variable_name must be an integer between 1 and 65535." >&2
    exit 2
  fi
  if port_is_available "$bind_host" "$selected_port"; then
    export "$variable_name=$selected_port"
    return
  fi
  if [[ -n "$configured_port" ]]; then
    echo "$service_name port $selected_port is already in use ($variable_name was explicitly configured)." >&2
    exit 1
  fi

  local candidate
  for ((candidate = default_port + 1; candidate <= default_port + 20; candidate++)); do
    if port_is_available "$bind_host" "$candidate"; then
      echo "$service_name port $default_port is already in use; using $candidate instead."
      export "$variable_name=$candidate"
      return
    fi
  done
  echo "No free $service_name port found between $default_port and $((default_port + 20))." >&2
  exit 1
}

# A concurrently running Docker stack commonly owns 8780.  Defaults may move
# to the first free neighboring port, while explicit operator choices fail
# loudly instead of making the readiness probe mistake another service for the
# process launched below.
select_available_port NOVELVIDEO_API_PORT 8780 0.0.0.0 "API"
select_available_port DRAMACLAW_LOCAL_GATEWAY_PORT 3001 127.0.0.1 "Local gateway"
select_available_port SUPERTALE_FE_PORT 5173 0.0.0.0 "Frontend"
export VITE_API_URL="${VITE_API_URL:-http://127.0.0.1:${NOVELVIDEO_API_PORT}}"
echo "Local stack ports: gateway=${DRAMACLAW_LOCAL_GATEWAY_PORT}, API=${NOVELVIDEO_API_PORT}, frontend=${SUPERTALE_FE_PORT}"

comfyui_dir="${COMFYUI_DIR:-}"
comfyui_host="${COMFYUI_HOST:-127.0.0.1}"
comfyui_port="${COMFYUI_PORT:-8188}"
comfyui_base_url="${COMFYUI_BASE_URL:-http://${comfyui_host}:${comfyui_port}}"
comfyui_base_url="${comfyui_base_url%/}"
export COMFYUI_BASE_URL="$comfyui_base_url"
comfyui_start_timeout="${DRAMACLAW_COMFYUI_START_TIMEOUT:-180}"
if [[ -n "${COMFYUI_PYTHON:-}" ]]; then
  comfyui_python="$COMFYUI_PYTHON"
elif [[ -x "$comfyui_dir/../standalone-env/bin/python3.13" ]]; then
  comfyui_python="$comfyui_dir/../standalone-env/bin/python3.13"
else
  comfyui_python="python3"
fi
comfyui_pid=""
comfyui_started=false
gateway_pid=""
app_pid=""

cleanup() {
  trap - INT TERM EXIT
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" >/dev/null 2>&1; then
    kill "$app_pid" >/dev/null 2>&1 || true
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "$gateway_pid" ]] && kill -0 "$gateway_pid" >/dev/null 2>&1; then
    kill "$gateway_pid" >/dev/null 2>&1 || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  if [[ "$comfyui_started" == true ]] && kill -0 "$comfyui_pid" >/dev/null 2>&1; then
    kill "$comfyui_pid" >/dev/null 2>&1 || true
    wait "$comfyui_pid" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

if [[ "${DRAMACLAW_START_COMFYUI:-1}" == "1" ]]; then
  # Reuse comes first: a running ComfyUI does not need its installation path,
  # and requiring COMFYUI_DIR before this probe made a direct first run fail on
  # exactly the machines where ComfyUI was already healthy.
  if curl -fsS --max-time 1 "${comfyui_base_url}/system_stats" >/dev/null 2>&1; then
    echo "Reusing existing ComfyUI at $comfyui_base_url"
  else
    if [[ -z "$comfyui_dir" ]]; then
      echo "ComfyUI is not reachable at $comfyui_base_url and COMFYUI_DIR is not configured." >&2
      echo "Copy config/local/local.env.example to $local_env_file and set the path containing main.py." >&2
      exit 1
    fi
    if [[ ! -f "$comfyui_dir/main.py" ]]; then
      echo "ComfyUI not found: $comfyui_dir" >&2
      echo "Set COMFYUI_DIR to the directory containing main.py, or use DRAMACLAW_START_COMFYUI=0 to disable auto-start." >&2
      exit 1
    fi
    echo "Starting ComfyUI from $comfyui_dir"
    (
      cd "$comfyui_dir"
      exec "$comfyui_python" main.py --listen "$comfyui_host" --port "$comfyui_port" --disable-auto-launch
    ) &
    comfyui_pid=$!
    comfyui_started=true

    comfyui_ready=false
    for ((attempt = 1; attempt <= comfyui_start_timeout; attempt++)); do
      if curl -fsS --max-time 1 "${comfyui_base_url}/system_stats" >/dev/null 2>&1; then
        comfyui_ready=true
        break
      fi
      if ! kill -0 "$comfyui_pid" >/dev/null 2>&1; then
        wait "$comfyui_pid" 2>/dev/null || true
        echo "ComfyUI exited before becoming ready." >&2
        exit 1
      fi
      sleep 1
    done
    if [[ "$comfyui_ready" != true ]]; then
      echo "ComfyUI did not become ready at $comfyui_base_url within ${comfyui_start_timeout} seconds." >&2
      exit 1
    fi
  fi
fi

uv run python -m novelvideo.local_gateway configure
uv run python -m novelvideo.local_gateway serve &
gateway_pid=$!

scripts/start-ce.sh &
app_pid=$!
wait "$app_pid"
