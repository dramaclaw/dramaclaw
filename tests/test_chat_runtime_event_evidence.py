"""Keep Freezone tool evidence parsing outside the chat application."""

import ast
from pathlib import Path
from types import SimpleNamespace

from novelvideo.chat.runtime_event_evidence import (
    _codex_freezone_write_receipt,
    _codex_freezone_write_result_error,
)


def test_runtime_event_evidence_has_no_application_or_persistence_imports() -> None:
    source = Path(__file__).resolve().parents[1] / "src/novelvideo/chat/runtime_event_evidence.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    forbidden = ("novelvideo", "sqlite3", "openai_codex")
    assert all(
        not name.startswith(forbidden)
        for node in imports
        for name in (
            [node.module or ""] if isinstance(node, ast.ImportFrom)
            else [alias.name for alias in node.names]
        )
    )


def test_runtime_event_evidence_requires_saved_canvas_identity() -> None:
    event = SimpleNamespace(
        name="dramaclaw.freezone_emit_canvas_command",
        status="completed",
        error=None,
        structured={
            "ok": True,
            "canvas_apply_status": "applied",
            "applied": True,
            "bridge_key": "bridge-a",
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        },
        output=None,
    )
    assert _codex_freezone_write_receipt(
        event, expected_project="project-a", expected_canvas="canvas-a"
    ) is event.structured
    assert _codex_freezone_write_receipt(event, expected_canvas="canvas-b") is None
    event.structured = {"ok": False, "user_message": "画布写入失败"}
    assert _codex_freezone_write_result_error(event) == "画布写入失败"
