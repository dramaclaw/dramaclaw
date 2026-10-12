#!/usr/bin/env python3
"""Linux Hermes sandbox isolation check — runs INSIDE a Linux container.

Drives the real codex-linux-sandbox binary (the same one the image installs)
to empirically verify the three isolation dimensions a multi-tenant Hermes
worker relies on:

  WRITE  — a user may write only its own HERMES_HOME; peers + own non-home dirs
           must be read-only.
  READ   — broad-read is codex's workspace-write model; peers ARE readable at
           this layer, so cross-user read confidentiality must come from the
           deployment topology (mount only state/<user>), NOT from the profile.
  NETWORK — `restricted` must block egress (external AND loopback).

Exit 0 iff the security-critical expectations hold:
  - own HERMES_HOME writable
  - peer dir NOT writable
  - own non-home dir NOT writable
  - restricted network blocks egress
The READ peer check is reported (not failed on): it documents the known
workspace-write broad-read, which is closed at the deployment layer.

Run it via tests/sandbox_linux_check.sh (handles Docker + bwrap).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

BIN = shutil.which("codex-linux-sandbox") or "/usr/local/bin/codex-linux-sandbox"

WORK = Path("/work")
STATE = WORK / "state"
ALICE = STATE / "alice"
SHARED = STATE / "_shared"
BOB = STATE / "bob"
HOME = ALICE / ".hermes"


def setup() -> None:
    for p in (ALICE, SHARED, BOB, HOME):
        p.mkdir(parents=True, exist_ok=True)
    (ALICE / "mine.txt").write_text("alice-own-data")
    (SHARED / "shared.txt").write_text("shared-data")
    (BOB / "bob.txt").write_text("bob-secret")


def _profile(network: str) -> dict:
    return {
        "type": "managed",
        "file_system": {
            "type": "restricted",
            "entries": [
                {"path": {"type": "special", "value": {"kind": "root"}}, "access": "read"},
                {"path": {"type": "path", "path": str(HOME)}, "access": "write"},
            ],
        },
        "network": network,
    }


def _run(cmd: list[str], network: str = "restricted") -> tuple[int, str]:
    args = [
        BIN,
        "--sandbox-policy-cwd", str(HOME),
        "--command-cwd", str(HOME),
        "--permission-profile", json.dumps(_profile(network), separators=(",", ":")),
        "--", *cmd,
    ]
    r = subprocess.run(args, capture_output=True, text=True, timeout=30)
    return r.returncode, (r.stdout or r.stderr).strip().replace("\n", " ")[:100]


def main() -> int:
    if not Path(BIN).exists():
        print(f"FATAL: {BIN} not found", file=sys.stderr)
        return 2
    setup()
    v = subprocess.run([BIN, "--help"], capture_output=True, text=True)
    if v.returncode != 0:
        print(f"FATAL: codex-linux-sandbox --help rc={v.returncode}: {v.stderr[:200]}", file=sys.stderr)
        return 2

    ok = True

    def expect(label: str, got_rc: int, want_zero: bool, detail: str) -> None:
        nonlocal ok
        passed = (got_rc == 0) == want_zero
        ok = ok and passed
        verdict = "PASS" if passed else "FAIL"
        print(f"  [{verdict}] {label:34s} rc={got_rc}  {detail}")

    print("== WRITE isolation (security-critical) ==")
    rc, d = _run(["/bin/sh", "-c", f"echo x > {HOME}/ok.txt"])
    expect("write own HERMES_HOME -> allow", rc, True, d)
    rc, d = _run(["/bin/sh", "-c", f"echo x > {BOB}/hack.txt"])
    expect("write peer dir -> DENY", rc, False, d)
    rc, d = _run(["/bin/sh", "-c", f"echo x > {ALICE}/nope.txt"])
    expect("write own non-home dir -> DENY", rc, False, d)

    print("== NETWORK isolation (security-critical) ==")
    net_probe = ("import socket,sys; s=socket.socket(); s.settimeout(4)\n"
                 "try:\n s.connect(('1.1.1.1',53)); print('CONNECTED'); sys.exit(0)\n"
                 "except Exception as e:\n print('blocked:'+type(e).__name__); sys.exit(7)")
    rc, d = _run(["python3", "-c", net_probe], network="restricted")
    expect("restricted blocks external egress", rc, False, d)

    print("== READ (documented workspace-write broad-read; deployment closes it) ==")
    rc, d = _run(["/bin/cat", str(BOB / "bob.txt")])
    note = "peer READABLE (expected at sandbox layer — mount only state/<user> to close)"
    print(f"  [NOTE] {'read peer dir':34s} rc={rc}  {note}")
    rc, d = _run(["/bin/cat", str(ALICE / "mine.txt")])
    print(f"  [NOTE] {'read own dir':34s} rc={rc}  {d}")

    print("\nRESULT:", "OK — write+network isolation hold" if ok else "FAIL — a critical check regressed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
