from __future__ import annotations

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

    assert ".cache/hermes-venv" in start_script
    assert '$root_dir/.venv/bin/hermes' not in start_script
    assert 'HERMES_PYTHON="${HERMES_PYTHON:-$HERMES_ENV_DIR/bin/python}"' in setup_script
    assert 'uv pip install --python "$HERMES_PYTHON"' in setup_script
