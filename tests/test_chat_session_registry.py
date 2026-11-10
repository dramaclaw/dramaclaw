"""Start locks and persisted turn ownership."""

import ast
import inspect
import json
import fcntl
import os
import subprocess
import sys

import pytest

from novelvideo.chat import session_registry as registry
from pathlib import Path
from types import SimpleNamespace

from novelvideo.chat.session_registry import (
    _chat_run_lock_key,
    _chat_run_lock_project_for_turn,
    acquire_chat_run_lock,
    clear_active_codex_turn_if_thread,
    codex_scope_key,
    get_codex_thread_id,
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


def test_start_locks_preserve_scope_keys(tmp_path):
    assert {_chat_run_lock_key(key) for key in ("", "project-a", "project-b")} == {
        "active_chat_run"
    }
    locks = []
    try:
        for canvas, agent in [("a", "one"), ("a", "two"), ("b", "one")]:
            key = _chat_run_lock_project_for_turn(
                "project-a", tool_mode="freezone_canvas",
                store_scope=SimpleNamespace(canvas_id=canvas, agent_id=agent),
            )
            locks.append(acquire_chat_run_lock(registry.chat_run_lock_path(tmp_path, key),
                                               turn_id=f"{canvas}-{agent}"))
        assert len(locks) == 3
    finally:
        for lock in locks:
            release_chat_run_lock(lock)


def test_start_lock_blocks_separate_open_and_reports_holder(tmp_path):
    path = tmp_path / "chat.lock"
    lock = acquire_chat_run_lock(path, turn_id="business-a")
    try:
        assert registry.probe_chat_start_lock(path).turn_id == "business-a"
        with pytest.raises(registry.ChatTurnBusyError) as error:
            acquire_chat_run_lock(path, turn_id="business-b")
        assert error.value.turn_id == "business-a"
        fd = os.open(path, os.O_RDWR)
        try:
            with pytest.raises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)
    finally:
        release_chat_run_lock(lock)
        release_chat_run_lock(lock)
    assert registry.probe_chat_start_lock(path) is None
    next_lock = acquire_chat_run_lock(path, turn_id="business-b")
    release_chat_run_lock(next_lock)


def test_start_lock_is_freed_when_child_dies(tmp_path):
    path = tmp_path / "chat.lock"
    child = subprocess.Popen(
        [sys.executable, "-c", """
import sys
from pathlib import Path
from novelvideo.chat.session_registry import acquire_chat_run_lock
lock = acquire_chat_run_lock(Path(sys.argv[1]), turn_id="child-turn")
print("ready", flush=True)
sys.stdin.read()
""", str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert child.stdout.readline().strip() == "ready"
        assert registry.probe_chat_start_lock(path).turn_id == "child-turn"
        with pytest.raises(registry.ChatTurnBusyError):
            acquire_chat_run_lock(path, turn_id="parent-turn")
    finally:
        child.kill()
        child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
    lock = acquire_chat_run_lock(path, turn_id="parent-turn")
    release_chat_run_lock(lock)


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
        path, "scope-a", {
            "thread_id": "thread-a", "turn_id": "turn-a", "business_turn_id": "business-a"
        }, **options
    )
    set_active_codex_turn(
        path, "scope-b", {"thread_id": "thread-b", "turn_id": "turn-b"}, **options
    )
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
    set_active_codex_turn(
        path, "scope-a", {"thread_id": "thread-new", "turn_id": "turn-new"}, **options
    )

    assert not clear_active_codex_turn_if_thread(
        path, "scope-a", "thread-old", **options
    )
    assert load_active_codex_turns(path)["scope-a"]["thread_id"] == "thread-new"
    assert clear_active_codex_turn_if_thread(path, "scope-a", "thread-new", **options)
    assert load_active_codex_turns(path) == {}


def test_active_entry_keeps_json_and_claim_requires_matching_turn(tmp_path):
    path = tmp_path / "turns.json"
    options = {"index_file_lock": index_file_lock, "write_json_atomic": write_json_atomic}
    entry = {
        "thread_id": "thread-a", "turn_id": "runtime-a", "started_at": 123.5,
        "token_file": None, "store_scope": {"kind": "home", "id": None},
        "structured_canvas_reply": False,
    }
    set_active_codex_turn(path, "scope", entry, **options)
    assert load_active_codex_turns(path) == {"scope": entry}
    assert registry.claim_active_codex_turn(path, "scope", "old", **options) is None
    assert load_active_codex_turns(path) == {"scope": entry}
    assert registry.claim_active_codex_turn(path, "scope", "runtime-a", **options) == entry
    assert registry.claim_active_codex_turn(path, "scope", "runtime-a", **options) is None
    path.write_text('{"invalid": 1, "valid": {"token_file": null}}')
    assert load_active_codex_turns(path) == {"valid": {"token_file": None}}
