#!/usr/bin/env bash
# M10-D FOSS_ONLY 手动闸：CE 小说 -> MP4，LLM 用真实 key，媒体生成走 --mock。
set -euo pipefail

PROJECT=${FOSS_ONLY_PROJECT:-foss_e2e}
NOVEL_FIXTURE=${FOSS_ONLY_NOVEL:-tests/fixtures/foss_only_short_novel.txt}
VIDEO_DIR="output/${PROJECT}/videos"
STEP_TIMEOUT=${FOSS_ONLY_STEP_TIMEOUT:-900}

export ST_EDITION=ce
export ST_CONTROL_PLANE_DSN=
export ST_REDIS_URL=
export ST_CELERY_BROKER_URL=
export ST_CELERY_RESULT_BACKEND=

if [ ! -f "$NOVEL_FIXTURE" ]; then
  echo "FOSS_ONLY fixture missing: $NOVEL_FIXTURE" >&2
  exit 2
fi

gateway_check=$(uv run python - <<'PY'
from novelvideo.config import get_effective_newapi_gateway_config

gateway = get_effective_newapi_gateway_config()
configured = bool(gateway.api_key and gateway.base_url)
print(f"{gateway.source}:{int(configured)}")
PY
)
gateway_source=${gateway_check%%:*}
gateway_configured=${gateway_check##*:}

if [ "$gateway_configured" != 1 ]; then
  echo "FOSS_ONLY requires a configured CE NewAPI gateway (source=$gateway_source)." >&2
  echo "Open Settings → Model Configuration and configure the official or local NewAPI channel." >&2
  exit 2
fi

run_step() {
  local name=$1
  shift
  echo "FOSS_ONLY STEP ▶ $name"
  if python3 - "$STEP_TIMEOUT" "$@" <<'PY'
import subprocess
import sys

timeout_s = int(sys.argv[1])
cmd = sys.argv[2:]
try:
    raise SystemExit(subprocess.run(cmd, timeout=timeout_s).returncode)
except subprocess.TimeoutExpired:
    print(f"command timed out after {timeout_s}s: {' '.join(cmd)}", file=sys.stderr)
    raise SystemExit(124)
PY
  then
    echo "FOSS_ONLY PASS ✔ $name"
  else
    local status=$?
    echo "FOSS_ONLY FAIL ✘ $name (exit=$status, timeout=${STEP_TIMEOUT}s)" >&2
    return "$status"
  fi
}

uv run python - <<'PY'
from novelvideo.ports.registry import ensure_bootstrap
from novelvideo.ports import get_task_backend
from novelvideo.ports.local.tasks import InlineTaskBackend

ensure_bootstrap()
backend = get_task_backend()
if not isinstance(backend, InlineTaskBackend):
    raise SystemExit(f"expected InlineTaskBackend, got {type(backend).__name__}")
print(f"Inline backend: {type(backend).__name__}")
PY

mkdir -p "$VIDEO_DIR" acceptance-logs
MARKER=$(mktemp "acceptance-logs/foss-only-marker-XXXXXX")

echo "FOSS_ONLY project=$PROJECT gateway=$gateway_source fixture=$NOVEL_FIXTURE"

run_step "cognee-ingest" \
  uv run novelvideo cognee-ingest --project "$PROJECT" --novel "$NOVEL_FIXTURE" --episodes 1
run_step "generate-script" \
  uv run novelvideo generate-script --project "$PROJECT" --episode 1 --duration 10
run_step "generate --mock" \
  uv run novelvideo generate --project "$PROJECT" --episode 1 --mock

shopt -s nullglob
videos=("$VIDEO_DIR"/ep001_*.mp4)
shopt -u nullglob

if [ "${#videos[@]}" -eq 0 ]; then
  echo "No output video matched $VIDEO_DIR/ep001_*.mp4" >&2
  exit 1
fi

selected=
for video in "${videos[@]}"; do
  if [ -s "$video" ] && [ "$video" -nt "$MARKER" ]; then
    selected=$video
    break
  fi
done

if [ -z "$selected" ]; then
  echo "No non-empty ep001_*.mp4 was produced after this run" >&2
  exit 1
fi

ffprobe -v error "$selected" >/dev/null
echo "FOSS_ONLY MP4 OK: $selected"
