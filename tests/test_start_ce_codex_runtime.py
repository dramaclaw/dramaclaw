"""The native launcher provisions Codex before starting any application service."""

from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    ("backend", "legacy_backend", "expected_code"),
    [
        ("", "", 23),
        ("codex", "", 23),
        (" CODEX ", "", 23),
        ("", "codex", 23),
        ("codex", "hermes", 23),
        ("hermes", "", 2),
        ("", "hermes", 2),
        ("invalid", "", 2),
    ],
)
@pytest.mark.parametrize("setup_fails", [False, True])
def test_launcher_resolves_codex_before_sync(
    tmp_path, backend, legacy_backend, expected_code, setup_fails
):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    launcher = scripts / "start-ce.sh"
    launcher.write_text((ROOT / "scripts" / "start-ce.sh").read_text())
    # .env configuration must reach the helper, and its resolved absolute path
    # must reach uv; neither helper nor launcher starts a real service here.
    (tmp_path / ".env").write_text('CODEX_BIN="./my runtime/codex"\n')
    (scripts / "setup-codex.sh").write_text(
        "#!/bin/bash\nset -eu\n"
        '[ "$CODEX_BIN" = "./my runtime/codex" ]\n'
        '[ "$ST_EDITION" = ce ] && [ -z "$ST_CONTROL_PLANE_DSN" ]\n'
        'printf "%s" "$NOVELVIDEO_RUNTIME_DIR" > "$SETUP_RESULT"\n'
        + ("exit 29\n" if setup_fails else 'printf "%s/codex" "$PWD"\n')
    )
    binaries = tmp_path / "bin"
    binaries.mkdir()
    for name, body in {
        "pnpm": "exit 0",
        "curl": "exit 0",
        "uv": (
            'printf "%s\\n" "$DRAMACLAW_CHAT_BACKEND" "$CODEX_BIN" "$*" '
            '> "$UV_RESULT"; exit 23'
        ),
    }.items():
        executable = binaries / name
        executable.write_text(f"#!/bin/sh\n{body}\n")
        executable.chmod(0o755)
    uv_output = tmp_path / "uv-output"
    setup_output = tmp_path / "setup-output"
    result = subprocess.run(
        ["/bin/bash", str(launcher)],
        env={
            "PATH": f"{binaries}:/usr/bin:/bin",
            "HOME": str(tmp_path),
            "DRAMACLAW_CHAT_BACKEND": backend,
            "SUPERTALE_CHAT_BACKEND": legacy_backend,
            "SETUP_RESULT": str(setup_output),
            "UV_RESULT": str(uv_output),
            "ST_CONTROL_PLANE_DSN": "must-not-use-ee",
        },
        capture_output=True,
        text=True,
        timeout=5,
    )
    if expected_code == 2:
        assert result.returncode == 2
        assert "Set DRAMACLAW_CHAT_BACKEND=codex in .env" in result.stderr
        assert not setup_output.exists()
        assert not uv_output.exists()
    else:
        assert setup_output.read_text() == str(tmp_path / "runtime")
        if setup_fails:
            assert result.returncode == 29
            assert not uv_output.exists()
        else:
            assert result.returncode == 23
            assert uv_output.read_text().splitlines() == [
                "codex",
                str(tmp_path / "codex"),
                "sync --group dev",
            ]
