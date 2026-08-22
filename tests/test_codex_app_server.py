from pathlib import Path
import sqlite3
from types import SimpleNamespace

import pytest

from novelvideo.chat import codex_app_server
from novelvideo.chat.backend_sdk import (
    _start_codex_turn,
    _start_or_resume_codex_thread,
)


def test_runtime_rejects_sdk_bundled_binary():
    with pytest.raises(RuntimeError, match="DramaClaw-patched Codex runtime"):
        codex_app_server._resolve_codex_bin(SimpleNamespace(codex_bin=None))


def test_legacy_log_sanitizer_removes_turn_secrets_from_sqlite(tmp_path):
    database = tmp_path / "logs_2.sqlite"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE logs(feedback_log_body TEXT)")
    connection.executemany(
        "INSERT INTO logs VALUES (?)",
        [
            (
                'responsesapi_client_metadata: Some({"dramaclaw_gateway_api_key": '
                '"gateway-secret", "dramaclaw_control_context_capability": '
                '"capability-secret"}), additional_context: {}',
            ),
            (
                r'client-metadata: {\"dramaclaw_gateway_api_key\":\"gateway-secret\",'
                r'\"dramaclaw_control_context_capability\":\"capability-secret\"}',
            ),
            ("unrelated log row",),
        ],
    )
    connection.commit()
    connection.close()

    assert codex_app_server._sanitize_legacy_turn_metadata(tmp_path) == 2

    raw = database.read_bytes()
    assert b"gateway-secret" not in raw
    assert b"capability-secret" not in raw
    assert b"<redacted>" in raw
    assert codex_app_server._sanitize_legacy_turn_metadata(tmp_path) == 0


def test_control_socket_path_is_short_and_stable(monkeypatch, tmp_path):
    control_dir = tmp_path / "control"
    control_dir.mkdir()
    monkeypatch.setattr(codex_app_server, "_control_dir", lambda: control_dir)

    long_home = tmp_path / ("very-long-project-state-directory-" * 8)
    socket_path, lock_path, signature_path = codex_app_server._control_paths(long_home)
    repeated = codex_app_server._control_paths(long_home)

    assert (socket_path, lock_path, signature_path) == repeated
    assert socket_path.parent == control_dir
    assert socket_path.suffix == ".sock"
    assert len(socket_path.name) < 32


def test_control_socket_identity_changes_with_codex_home(monkeypatch, tmp_path):
    control_dir = tmp_path / "control"
    control_dir.mkdir()
    monkeypatch.setattr(codex_app_server, "_control_dir", lambda: control_dir)

    first = codex_app_server._control_paths(Path("/state/node-a/.codex"))[0]
    second = codex_app_server._control_paths(Path("/state/node-b/.codex"))[0]

    assert first != second


def test_runtime_signature_digest_does_not_embed_gateway_secret():
    signature = (
        "/usr/local/bin/codex",
        "/data/state/.codex-app-server",
        ("model_providers.dramaclaw_gateway.wire_api=\"responses\"",),
        "super-secret-key",
        "http://gateway:3000/v1",
    )

    digest = codex_app_server._signature_digest(signature)

    assert len(digest) == 64
    assert "super-secret-key" not in digest


def test_missing_rollout_starts_a_replacement_thread():
    from openai_codex.errors import InvalidRequestError

    replacement = object()

    class FakeCodex:
        def thread_resume(self, thread_id, **options):
            raise InvalidRequestError(
                -32600,
                f"no rollout found for thread id {thread_id}",
            )

        def thread_start(self, **options):
            assert options == {"model": "DC-codex-agent-LLM"}
            return replacement

    result = _start_or_resume_codex_thread(
        FakeCodex(),
        "stale-thread",
        {"model": "DC-codex-agent-LLM"},
    )

    assert result is replacement


def test_resume_does_not_hide_non_stale_invalid_request():
    from openai_codex.errors import InvalidRequestError

    class FakeCodex:
        def thread_resume(self, thread_id, **options):
            raise InvalidRequestError(-32600, "permission profile is invalid")

        def thread_start(self, **options):
            raise AssertionError("must not replace a valid thread on configuration errors")

    with pytest.raises(InvalidRequestError, match="permission profile is invalid"):
        _start_or_resume_codex_thread(FakeCodex(), "thread-1", {})


def test_turn_metadata_is_sent_on_raw_turn_start():
    calls = []

    class FakeClient:
        def turn_start(self, thread_id, input_items, params=None):
            calls.append((thread_id, input_items, params))
            return SimpleNamespace(turn=SimpleNamespace(id="turn-1"))

    thread = SimpleNamespace(id="thread-1", _client=FakeClient())
    handle = _start_codex_turn(
        thread,
        "hello",
        {
            "dramaclaw_gateway_api_key": "turn-secret",
            "dramaclaw_control_context_capability": "signed-capability",
        },
    )

    assert handle.id == "turn-1"
    assert calls[0][0] == "thread-1"
    assert calls[0][1] == [{"type": "text", "text": "hello"}]
    assert calls[0][2] == {
        "responsesapiClientMetadata": {
            "dramaclaw_gateway_api_key": "turn-secret",
            "dramaclaw_control_context_capability": "signed-capability",
        }
    }
