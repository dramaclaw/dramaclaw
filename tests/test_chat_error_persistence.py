from __future__ import annotations

import json
import sqlite3

import pytest

from novelvideo.api.routes import chat as chat_routes
from novelvideo.chat import backend_sdk
from novelvideo.chat.store import ChatScope, chat_store


@pytest.mark.parametrize(
    "cause", ["Timed out waiting for shared Codex", "connection error"]
)
def test_local_codex_errors_are_not_translated_as_upstream_failures(cause):
    from novelvideo.chat.codex_app_server import CodexRuntimeError

    message = chat_routes._user_facing_chat_error(CodexRuntimeError(cause))
    assert "本地助手运行时不可用" in message
    assert "上游" not in message


def test_missing_hermes_fork_is_a_local_runtime_failure():
    from novelvideo.chat.hermes_fork_requirement import HermesForkMissing

    message = chat_routes._user_facing_chat_error(
        HermesForkMissing("would report connection error")
    )
    assert "本地助手运行时不可用" in message


def test_provider_connection_error_keeps_upstream_message():
    message = chat_routes._user_facing_chat_error(ConnectionError("connection error"))
    assert "无法连接上游模型服务" in message


def test_reasoning_required_error_has_actionable_chinese_message() -> None:
    exc = RuntimeError(
        "Reasoning is mandatory for this endpoint and cannot be disabled. "
        '({"provider_name":null})'
    )

    message = chat_routes._user_facing_chat_error(exc)

    assert "上游模型要求启用推理" in message
    assert "NewAPI" in message
    assert "provider_name" not in message


_MALFORMED_TOOL_CALL_BODY = json.dumps({
    "error": {
        "message": (
            "Prefill server error (400 Bad Request): "
            '{"object":"error","message":"Assistant tool call ***.arguments must be valid '
            'JSON.","type":"BadRequest","param":null,"code":400}'
        ),
        "type": "invalid_request_error",
        "param": "",
        "code": "malformed_json",
    }
})
_SAFE_TOOL_CALL_MESSAGE = "模型生成的工具调用参数不完整，本轮已停止。请重新发送刚才的需求。"
_UPSTREAM_MARKERS = (
    "malformed_json", "Prefill", "Bad Request", "invalid_request_error", "must be valid JSON",
)
_UNRELATED_TOOL_ERROR_BODY = json.dumps({
    "error": {"code": "context_length_exceeded", "message": "input is too long"}
})


def test_malformed_tool_call_error_has_safe_message():
    exc = backend_sdk.CodexMalformedToolCallError(_MALFORMED_TOOL_CALL_BODY)
    assert backend_sdk.CODEX_MALFORMED_TOOL_CALL_MESSAGE == _SAFE_TOOL_CALL_MESSAGE
    assert str(exc) == _SAFE_TOOL_CALL_MESSAGE
    assert chat_routes._user_facing_chat_error(exc) == _SAFE_TOOL_CALL_MESSAGE


def test_malformed_tool_call_raw_error_has_safe_message():
    message = chat_routes._user_facing_chat_error(RuntimeError(_MALFORMED_TOOL_CALL_BODY))
    assert message == _SAFE_TOOL_CALL_MESSAGE
    assert all(marker not in message for marker in _UPSTREAM_MARKERS)


def test_unrelated_upstream_400_error_is_unchanged():
    assert chat_routes._user_facing_chat_error(
        RuntimeError(_UNRELATED_TOOL_ERROR_BODY)
    ) == _UNRELATED_TOOL_ERROR_BODY


@pytest.mark.asyncio
@pytest.mark.parametrize("history_rows", [0, 60])
async def test_home_turn_error_is_persisted_once(monkeypatch, tmp_path, history_rows) -> None:
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="home")
    kwargs = {
        "user": {"username": "test-user"},
        "username": "test-user",
        "scope": scope,
        "turn_id": "turn-failed-1",
        "reason": "模型连接失败",
    }

    first = await chat_routes._persist_chat_turn_error(**kwargs)
    for index in range(history_rows):
        await chat_store.append_message_async(
            "test-user", scope, "user", "Another turn", turn_id=f"turn-other-{index}"
        )
    second = await chat_routes._persist_chat_turn_error(**kwargs)

    assert first is not None
    assert second is not None
    assert first["id"] == second["id"]
    for result in (first, second):
        assert result["chat_error"] is True
        assert "metadata" not in result
        assert result["turn_id"] == "turn-failed-1"
        assert result["content"] == (
            "本轮处理失败：模型连接失败\n\n请根据错误提示处理后重试。"
        )
    with sqlite3.connect(chat_store.db_for("test-user", scope)) as db:
        assert db.execute(
            "SELECT COUNT(*) FROM chat_messages WHERE turn_id = 'turn-failed-1'"
        ).fetchone() == (1,)
