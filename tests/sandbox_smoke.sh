#!/usr/bin/env bash
# Phase 1 verification: sandbox profile read/write asymmetry + Python runtime.
# Generates the macOS Seatbelt profile via sandbox_wrap.build_macos_profile(),
# then runs 14 test cases. All must PASS to exit Phase 1.
#
# Usage:
#   bash tests/sandbox_smoke.sh
#
# Env (optional):
#   SUPERTALE_USER=admin     # which user to simulate
#   HERMES_HOME=/tmp/hermes-poc

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(pwd)"

USER_NAME="${SUPERTALE_USER:-admin}"
HOME_DIR="${HERMES_HOME:-/tmp/hermes-poc}"
mkdir -p "$HOME_DIR/tmp"
chmod 700 "$HOME_DIR"

# Resolve the hermes CLI from PATH / HERMES_CLI_PATH rather than a hardcoded
# per-machine home (T13). Falls back to the image default.
HERMES_BIN="${HERMES_CLI_PATH:-$(command -v hermes 2>/dev/null || echo /root/.local/bin/hermes)}"

# Build profile via Python (writes to a temp file, then exports as $PROFILE)
PROFILE=$(.venv/bin/python3 - <<PY
from novelvideo.security import SandboxSpec, build_macos_profile
from pathlib import Path
spec = SandboxSpec(user="$USER_NAME", hermes_home=Path("$HOME_DIR"))
print(build_macos_profile(spec))
PY
)
[ -n "$PROFILE" ] || { echo "❌ failed to build profile"; exit 1; }

SBX="/usr/bin/sandbox-exec -p $PROFILE --"

pass=0
fail=0
expect_pass() { # test_id, expected-PASS command (exit 0 = ok)
    local id="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "  ✓ $id";  pass=$((pass+1))
    else
        echo "  ✗ $id (expected PASS, got fail)"; fail=$((fail+1))
    fi
}
expect_fail() { # test_id, expected-FAIL command (exit non-0)
    local id="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "  ✗ $id (expected FAIL, got pass)"; fail=$((fail+1))
    else
        echo "  ✓ $id";  pass=$((pass+1))
    fi
}

echo "═══ Sandbox Smoke Tests ═══"
echo "User:       $USER_NAME"
echo "HERMES_HOME: $HOME_DIR"
echo

echo "── Reads (whitelist) ──"
expect_pass "T1   read /usr/bin/python3" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/cat /usr/bin/python3

# macOS: /etc/ssl/cert.pem may not exist; try common locations
SSL_CERT=""
for c in /etc/ssl/cert.pem /private/etc/ssl/cert.pem /usr/local/etc/openssl/cert.pem; do
    [ -r "$c" ] && SSL_CERT="$c" && break
done
if [ -n "$SSL_CERT" ]; then
    expect_pass "T2   read SSL cert ($SSL_CERT)" \
        /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/cat "$SSL_CERT"
else
    echo "  - T2   no SSL cert at known paths (skipped)"
fi

expect_fail "T2b  read /etc/shadow (denied)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/cat /etc/shadow

# ~/.ssh/id_rsa may not exist; use a known-deny path (~/.ssh dir itself)
expect_fail "T3   read ~/.ssh/anything (host secret)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/ls "$HOME/.ssh"

# T4: in workspace-write mode read is broadly allowed; we don't deny read /tmp
# (write /tmp is denied — see T11b). Cross-user secret protection relies on
# ~/.ssh-style explicit denies (T3) and other-user paths (T6/T7), not /tmp.
expect_pass "T4   read /tmp (allowed under workspace-write; write covered by T11b)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/ls /tmp

# Need to create test files for self / other
SELF_FILE="$REPO_ROOT/state/$USER_NAME/.hermes/probe.txt"
mkdir -p "$(dirname "$SELF_FILE")"; echo "self" > "$SELF_FILE"
expect_pass "T5   read own state/$USER_NAME/.hermes" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/cat "$SELF_FILE"

# Create a fake "other" user
OTHER_NAME="zztest_isolation_$$"
OTHER_STATE="$REPO_ROOT/state/$OTHER_NAME"
OTHER_OUT="$REPO_ROOT/output/$OTHER_NAME"
mkdir -p "$OTHER_STATE" "$OTHER_OUT"
echo "other-state" > "$OTHER_STATE/secret.txt"
echo "other-output" > "$OTHER_OUT/secret.txt"
trap "rm -rf $OTHER_STATE $OTHER_OUT" EXIT

# Profile was already built before OTHER_* existed → rebuild
PROFILE=$(.venv/bin/python3 - <<PY
from novelvideo.security import SandboxSpec, build_macos_profile
from pathlib import Path
spec = SandboxSpec(user="$USER_NAME", hermes_home=Path("$HOME_DIR"))
print(build_macos_profile(spec))
PY
)

expect_fail "T6   read other-user state ($OTHER_NAME)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/cat "$OTHER_STATE/secret.txt"

expect_fail "T7   read other-user output ($OTHER_NAME)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/cat "$OTHER_OUT/secret.txt"

echo
echo "── Writes (HERMES_HOME only) ──"
expect_fail "T8   write /etc/x (denied)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/sh -c "echo x > /etc/x"

expect_pass "T9   write \$HERMES_HOME/x (allowed)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/sh -c "echo x > $HOME_DIR/x"

expect_pass "T10  write \$HERMES_HOME/tmp/y (per-user tmpdir)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/sh -c "echo y > $HOME_DIR/tmp/y"

expect_fail "T11  write output/$USER_NAME/x (business path denied — go via API)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/sh -c "echo x > $REPO_ROOT/output/$USER_NAME/probe_should_fail"

# T11b: write /tmp denied (forces TMPDIR=HERMES_HOME/tmp)
expect_fail "T11b write /tmp/x (host /tmp denied)" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- /bin/sh -c "echo x > /tmp/probe_should_fail"

echo
echo "── Python runtime in sandbox ──"
expect_pass "T12  import ssl + sqlite3 + json" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- \
        "$REPO_ROOT/.venv/bin/python3" -c "import ssl, sqlite3, json; print('ok')"

# T13: import hermes_agent — hermes is in uv tool's own venv, not SuperTale .venv;
# this verifies sandbox lets us at least *run* /usr/local/bin/hermes which is what matters.
expect_pass "T13  exec hermes --version" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- "$HERMES_BIN" --version

# T14: tempfile uses TMPDIR=$HERMES_HOME/tmp
expect_pass "T14  tempfile honors TMPDIR" \
    /usr/bin/sandbox-exec -p "$PROFILE" -- env "TMPDIR=$HOME_DIR/tmp" \
        "$REPO_ROOT/.venv/bin/python3" -c "
import tempfile, os, sys
fd, path = tempfile.mkstemp()
os.close(fd)
assert path.startswith('$HOME_DIR/tmp'), 'tempfile at unexpected path: ' + path
"

echo
echo "═══ Result ═══"
echo "PASS: $pass"
echo "FAIL: $fail"
[ "$fail" -eq 0 ] && exit 0 || exit 1
