from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_pydantic_ai_openai_adapter_imports_with_locked_sdk():
    # Recipe text generation imports this lazily. A Hermes install used to
    # downgrade openai after uv sync, so application startup still succeeded
    # while every generate_text action failed with a generic HTTP 503.
    from pydantic_ai.models.openai import OpenAIChatModel

    assert OpenAIChatModel is not None


def test_local_ce_keeps_hermes_out_of_application_venv():
    start_script = (ROOT / "scripts" / "start-ce.sh").read_text(encoding="utf-8")
    setup_script = (ROOT / "scripts" / "setup-hermes.sh").read_text(encoding="utf-8")

    assert "setup-hermes.sh" not in start_script
    assert "HERMES_ENV_DIR" not in start_script
    assert 'codex_bin="$(bash "$root_dir/scripts/setup-codex.sh")"' in start_script
    assert 'export CODEX_BIN="$codex_bin"' in start_script
    assert "git clone" not in setup_script
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/setup-hermes.sh")], capture_output=True, text=True
    )
    assert result.returncode == 2
    assert "retired" in result.stderr and "scripts/start-ce.sh" in result.stderr


def test_source_startup_docs_configure_codex_runtime():
    documented_paths = (
        ROOT / "README.md",
        ROOT / "docs" / "en" / "getting-started" / "installation.md",
        ROOT / "docs" / "zh" / "getting-started" / "installation.md",
    )

    for path in documented_paths:
        content = path.read_text(encoding="utf-8")
        assert "scripts/start-ce.sh" in content
        assert "0.164.0" in content
        assert "SHA256" in content
        assert "CODEX_BIN" in content
        assert "hermes" not in content.lower()


def test_env_example_selects_codex_for_source_development():
    content = (ROOT / ".env.example").read_text(encoding="utf-8")

    assert "\nDRAMACLAW_CHAT_BACKEND=codex\n" in content
    assert "HERMES_MODEL=" not in content
