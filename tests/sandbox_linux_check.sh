#!/usr/bin/env bash
# Run the Linux Hermes sandbox isolation check inside a throwaway Linux
# container, driving the real codex-linux-sandbox binary vendored in this repo.
#
# Companion to tests/sandbox_smoke.sh (which covers the macOS Seatbelt path).
# The binary + the sandbox code under test both live in this CE repo, so the
# check lives here too.
#
# Usage:   bash tests/sandbox_linux_check.sh
#
# Requires a running Docker/OrbStack daemon. On macOS the arm64/amd64 Linux
# binary is picked to match your host. --privileged is used ONLY so bubblewrap
# can create user namespaces inside the container (mirrors the "host kernel must
# support user namespaces" production requirement); it does not affect the
# sandbox semantics under test.
set -euo pipefail

# repo root = one level up from this script (tests/..)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# codex-linux-sandbox is vendored per arch under deploy/sandbox/
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=amd64 ;;
  *) echo "unsupported host arch: $(uname -m)" >&2; exit 1 ;;
esac

BIN="$ROOT/deploy/sandbox/linux-${ARCH}/codex-linux-sandbox"
CHECK="$ROOT/tests/sandbox_linux_isolation.py"
[ -f "$BIN" ]   || { echo "missing sandbox binary: $BIN" >&2; exit 1; }
[ -f "$CHECK" ] || { echo "missing check script: $CHECK" >&2; exit 1; }

if ! docker version >/dev/null 2>&1; then
  echo "Docker daemon not reachable. Start OrbStack/Docker Desktop first." >&2
  exit 1
fi

echo "arch=${ARCH}  binary=$BIN"
exec docker run --rm --platform "linux/${ARCH}" --privileged \
  -v "$BIN:/opt/cls-src:ro" \
  -v "$CHECK:/check.py:ro" \
  python:3.12-slim-bookworm \
  sh -c '
    set -e
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq bubblewrap >/dev/null 2>&1
    # codex re-execs itself inside the sandbox, so it must be a real file under
    # a bind-mounted tree, not a nested docker volume mount point.
    cp /opt/cls-src /usr/local/bin/codex-linux-sandbox
    chmod +x /usr/local/bin/codex-linux-sandbox
    python3 /check.py
  '
