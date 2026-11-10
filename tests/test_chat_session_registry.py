"""Lock identity and expiry remain stable outside the chat application."""

import ast
import inspect
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from novelvideo.chat.session_registry import (
    _CHAT_RUN_LOCK_MAX_SECONDS,
    _CHAT_RUN_LOCK_TTL_SECONDS,
    _chat_run_lock_is_stale,
    _chat_run_lock_key,
    _chat_run_lock_project_for_turn,
    acquire_chat_run_lock,
    clear_active_codex_turn_if_thread,
    codex_scope_key,
    get_codex_thread_id,
    heartbeat_chat_run_lock,
    load_active_codex_turns,
    load_codex_session_state,
    release_chat_run_lock,
    set_active_codex_turn,
    set_codex_thread_id,
)
from novelvideo.utils.state_index_files import index_file_lock, write_json_atomic


def test_session_registry_has_no_application_or_storage_imports() -> None:
    source = (
        Path(__file__).resolve().parents[1] / "src/novelvideo/chat/session_registry.py"
    )
    tree = ast.parse(source.read_text(encoding="utf-8"))
    imports = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
    ]
    assert all(
        not name.startswith(("novelvideo", "sqlite3", "openai_codex"))
        for node in imports
        for name in (
            [node.module or ""]
            if isinstance(node, ast.ImportFrom)
            else [alias.name for alias in node.names]
        )
    )


def test_canvas_agent_lock_scope_and_two_expiry_limits() -> None:
    first = _chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="freezone_canvas",
        store_scope=SimpleNamespace(canvas_id="canvas-a", agent_id="agent-a"),
    )
    second = _chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="freezone_canvas",
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


def test_lock_file_rejects_foreign_heartbeat_and_release(tmp_path: Path) -> None:
    path = tmp_path / "chat.lock"
    lock_id = acquire_chat_run_lock(path, owner_is_active=lambda *_: True)
    assert path.exists()
    assert not heartbeat_chat_run_lock(path, "another-turn")
    release_chat_run_lock(path, "another-turn")
    assert path.exists()
    release_chat_run_lock(path, lock_id)
    assert not path.exists()


def test_codex_scope_key_separates_project_and_canvas() -> None:
    assert codex_scope_key("") == '["main","home",null,"session"]'
    assert codex_scope_key("project-a") == (
        '["main","project","project-a","session"]'
    )
    assert (
        codex_scope_key(
            "project-a",
            agent_profile="freezone:agent-a",
            canvas_id="canvas-a",
        )
        == '["freezone:agent-a","project","project-a","canvas-a","session"]'
    )
    assert (
        codex_scope_key(
            "project-a", agent_profile="other", canvas_id="ignored"
        )
        == '["other","project","project-a",null,"session"]'
    )
    parameters = inspect.signature(codex_scope_key).parameters
    assert "main_protocol" not in parameters
    assert "freezone_protocol" not in parameters


def test_codex_thread_state_preserves_other_scopes_and_ignores_bad_json(
    tmp_path: Path,
) -> None:
    path = tmp_path / "sessions.json"
    path.write_text("{broken", encoding="utf-8")
    assert load_codex_session_state(path) == {}

    options = {
        "index_file_lock": index_file_lock,
        "write_json_atomic": write_json_atomic,
    }
    set_codex_thread_id(path, "scope-a", " thread-a ", **options)
    set_codex_thread_id(path, "scope-b", "thread-b", **options)
    set_codex_thread_id(path, "scope-a", "  ", **options)
    assert load_codex_session_state(path) == {"scope-a": "thread-a", "scope-b": "thread-b"}
    assert get_codex_thread_id(path, "scope-a") == "thread-a"


def test_active_codex_turn_state_retains_business_turn_and_other_scope(
    tmp_path: Path,
) -> None:
    path = tmp_path / "turns.json"
    options = {
        "index_file_lock": index_file_lock,
        "write_json_atomic": write_json_atomic,
    }
    set_active_codex_turn(
        path, "scope-a", ("thread-a", "turn-a", "business-a"), **options
    )
    set_active_codex_turn(path, "scope-b", ("thread-b", "turn-b"), **options)
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "scope-a": {
            "thread_id": "thread-a",
            "turn_id": "turn-a",
            "business_turn_id": "business-a",
        },
        "scope-b": {"thread_id": "thread-b", "turn_id": "turn-b"},
    }
    set_active_codex_turn(path, "scope-a", None, **options)
    assert load_active_codex_turns(path) == {
        "scope-b": {"thread_id": "thread-b", "turn_id": "turn-b"}
    }


def test_clear_active_codex_turn_requires_matching_thread(tmp_path: Path) -> None:
    path = tmp_path / "turns.json"
    options = {
        "index_file_lock": index_file_lock,
        "write_json_atomic": write_json_atomic,
    }
    set_active_codex_turn(path, "scope-a", ("thread-new", "turn-new"), **options)

    assert not clear_active_codex_turn_if_thread(
        path, "scope-a", "thread-old", **options
    )
    assert load_active_codex_turns(path)["scope-a"]["thread_id"] == "thread-new"
    assert clear_active_codex_turn_if_thread(path, "scope-a", "thread-new", **options)
    assert load_active_codex_turns(path) == {}
