"""Source launcher explains Linux Hermes sandbox requirements before setup."""

from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    ("system", "backend", "legacy_backend", "sandbox_env", "expects_hint"),
    [
        ("Linux", "", "", {}, True),
        ("Linux", "hermes", "", {}, True),
        ("Linux", "", "hermes", {}, True),
        ("Linux", "codex", "hermes", {}, False),
        ("Darwin", "hermes", "", {}, False),
        *[
            ("Linux", "hermes", "", {flag: value}, False)
            for flag in ("SUPERTALE_ALLOW_UNSANDBOXED", "SUPERTALE_LINUX_SANDBOX")
            for value in ("1", "true", "TRUE", " yes ", "on")
        ],
        ("Linux", "hermes", "", {"SUPERTALE_ALLOW_UNSANDBOXED": "0"}, True),
        ("Linux", "hermes", "", {"SUPERTALE_LINUX_SANDBOX": "false"}, True),
        ("Linux", "hermes", "", {"SUPERTALE_ALLOW_UNSANDBOXED": "invalid"}, True),
        ("Linux", "hermes", "", {
            "SUPERTALE_ALLOW_UNSANDBOXED": "0", "SUPERTALE_LINUX_SANDBOX": "on",
        }, False),
    ],
)
def test_launcher_explains_linux_hermes_opt_in(
    tmp_path, system, backend, legacy_backend, sandbox_env, expects_hint
):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    launcher = scripts / "start-ce.sh"
    launcher.write_text((ROOT / "scripts" / "start-ce.sh").read_text())
    (tmp_path / ".env").write_text("")
    binaries = tmp_path / "bin"
    binaries.mkdir()
    for name, body in {
        "uname": f"echo {system}",
        "pnpm": "exit 0",
        "curl": "exit 0",
        # Stop before dependency installation and API/frontend startup.
        "uv": 'printf "%s" "${SUPERTALE_ALLOW_UNSANDBOXED-unset}" > "$OPT_IN_RESULT"; exit 23',
    }.items():
        executable = binaries / name
        executable.write_text(f"#!/bin/sh\n{body}\n")
        executable.chmod(0o755)
    output = tmp_path / "opt-in"
    result = subprocess.run(
        ["/bin/bash", str(launcher)],
        env={
            "PATH": f"{binaries}:/usr/bin:/bin",
            "HOME": str(tmp_path),
            "DRAMACLAW_CHAT_BACKEND": backend,
            "SUPERTALE_CHAT_BACKEND": legacy_backend,
            "OPT_IN_RESULT": str(output),
            **sandbox_env,
        },
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 23
    assert output.read_text() == sandbox_env.get("SUPERTALE_ALLOW_UNSANDBOXED", "unset"), (
        "The launcher must not change the user's opt-in"
    )
    if expects_hint:
        assert "SUPERTALE_ALLOW_UNSANDBOXED=1" in result.stderr
        assert "single-user local development" in result.stderr
        assert "EE or production" in result.stderr
    else:
        assert "SUPERTALE_ALLOW_UNSANDBOXED" not in result.stderr
