"""Lock identity and expiry remain stable outside the chat application."""

import ast
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from novelvideo.chat.session_registry import (
    _CHAT_RUN_LOCK_MAX_SECONDS,
    _CHAT_RUN_LOCK_TTL_SECONDS,
    _chat_run_lock_is_stale,
    _chat_run_lock_key,
    _chat_run_lock_project_for_turn,
)


def test_session_registry_has_no_application_or_storage_imports() -> None:
    source = Path(__file__).resolve().parents[1] / "src/novelvideo/chat/session_registry.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert all(
        not name.startswith(("novelvideo", "sqlite3", "openai_codex"))
        for node in imports
        for name in (
            [node.module or ""] if isinstance(node, ast.ImportFrom)
            else [alias.name for alias in node.names]
        )
    )


def test_canvas_agent_lock_scope_and_two_expiry_limits() -> None:
    first = _chat_run_lock_project_for_turn(
        "project-a", tool_mode="freezone_canvas",
        store_scope=SimpleNamespace(canvas_id="canvas-a", agent_id="agent-a"),
    )
    second = _chat_run_lock_project_for_turn(
        "project-a", tool_mode="freezone_canvas",
        store_scope=SimpleNamespace(canvas_id="canvas-a", agent_id="agent-b"),
    )
    assert _chat_run_lock_key(first) != _chat_run_lock_key(second)
    assert _chat_run_lock_key("project-a") == _chat_run_lock_key("project-b")

    now = datetime.now(timezone.utc)
    assert not _chat_run_lock_is_stale(
        now - timedelta(seconds=_CHAT_RUN_LOCK_TTL_SECONDS + 1), now
    )
    assert _chat_run_lock_is_stale(
        now - timedelta(seconds=_CHAT_RUN_LOCK_MAX_SECONDS + 1), now
    )
