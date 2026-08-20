#!/usr/bin/env bash
# Install or verify the Hermes fork DramaClaw requires.
#
# Not from PyPI. A release keeps the same version string as the fork and then
# drops the `_meta` extension the per-turn credential travels in, so every turn
# fails closed and reports it as a connection error — with the gateway seeing
# no request at all. `hermes --version` cannot tell the two apart, which is why
# this checks behaviour instead.
#
# Not `uv tool install` either: upstream refuses to build a wheel or sdist on
# purpose ("distributed via the shell installer, Docker image, or Nix"), so an
# editable install from a clone is the supported path a pinned ref can use.
# This mirrors what the Dockerfile does, so a developer's environment and the
# image agree.
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-install}"

HERMES_REPO="${HERMES_REPO:-https://github.com/dramaclaw/hermes-agent.git}"
HERMES_REF="${HERMES_REF:-brainclaw/evidence-plane}"
HERMES_SOURCE_DIR="${HERMES_SOURCE_DIR:-$root_dir/.cache/hermes-agent}"
HERMES_PYTHON="${HERMES_PYTHON:-$root_dir/.venv/bin/python}"
if [ ! -x "$HERMES_PYTHON" ]; then
  HERMES_PYTHON="$(command -v python3)"
fi

# The property this deployment actually depends on: does `_meta` survive the
# ACP router? Probed in the interpreter that will run the worker.
fork_is_installed() {
  "$HERMES_PYTHON" - <<'PY' 2>/dev/null
import sys
try:
    from acp_adapter.server import _recover_turn_meta
    if _recover_turn_meta({"session_id": "s", "dramaclaw.probe": "v"}).get(
            "dramaclaw.probe") != "v":
        sys.exit(1)
    from agent.gateway_credential import apply_to_headers, refuse_foreign_endpoint  # noqa: F401
except Exception:
    sys.exit(1)
PY
}

if fork_is_installed; then
  echo "Hermes fork is installed ($(hermes --version 2>/dev/null | head -n 1))."
  exit 0
fi

if [ "$mode" = "--check" ] || [ "$mode" = "check" ]; then
  if command -v hermes >/dev/null 2>&1; then
    echo "A Hermes is installed, but it is not the fork: it drops the _meta" >&2
    echo "extension the per-turn credential travels in, so every turn would" >&2
    echo "fail closed. Run: scripts/setup-hermes.sh" >&2
  else
    echo "Hermes is not installed. Run: scripts/setup-hermes.sh" >&2
  fi
  exit 1
fi

command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 2; }
command -v uv  >/dev/null 2>&1 || {
  echo "uv is required: https://docs.astral.sh/uv/" >&2; exit 2; }

if [ -d "$HERMES_SOURCE_DIR/.git" ]; then
  echo "Updating $HERMES_SOURCE_DIR to $HERMES_REF ..."
  git -C "$HERMES_SOURCE_DIR" fetch --quiet origin "$HERMES_REF"
  git -C "$HERMES_SOURCE_DIR" checkout --quiet FETCH_HEAD
else
  echo "Cloning $HERMES_REPO@$HERMES_REF ..."
  git clone --progress --branch "$HERMES_REF" "$HERMES_REPO" "$HERMES_SOURCE_DIR" \
    || { git clone --progress "$HERMES_REPO" "$HERMES_SOURCE_DIR"
         git -C "$HERMES_SOURCE_DIR" checkout --quiet "$HERMES_REF"; }
fi

installed_sha="$(git -C "$HERMES_SOURCE_DIR" rev-parse HEAD)"
uv pip install --python "$HERMES_PYTHON" -e "$HERMES_SOURCE_DIR[acp]"
HERMES_SOURCE_DIR="$HERMES_SOURCE_DIR" "$HERMES_PYTHON" "$root_dir/deploy/patch_hermes_acp_toolsets.py"

if ! fork_is_installed; then
  echo "Install finished, but the result is not the fork — _meta does not" >&2
  echo "survive the ACP router. Check $HERMES_SOURCE_DIR@$installed_sha." >&2
  exit 1
fi

echo "Hermes fork ready: ${installed_sha:0:12} ($(hermes --version 2>/dev/null | head -n 1))"
