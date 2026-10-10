from __future__ import annotations

import pytest

from novelvideo.api.routes import chat as chat_routes
from novelvideo.chat.store import ChatScope, chat_store


def test_reasoning_required_error_has_actionable_chinese_message() -> None:
    exc = RuntimeError(
        "Reasoning is mandatory for this endpoint and cannot be disabled. "
        '({"provider_name":null})'
    )

    message = chat_routes._user_facing_chat_error(exc)

    assert "上游模型要求启用推理" in message
    assert "NewAPI" in message
    assert "provider_name" not in message


@pytest.mark.asyncio
async def test_home_turn_error_is_persisted_once(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="home")
    kwargs = {
        "user": {"username": "alice"},
        "username": "alice",
        "scope": scope,
        "turn_id": "turn-failed-1",
        "reason": "模型连接失败",
    }

    first = await chat_routes._persist_chat_turn_error(**kwargs)
    second = await chat_routes._persist_chat_turn_error(**kwargs)
    history = chat_store.list_messages("alice", scope)

    assert first is not None
    assert second is not None
    assert first["id"] == second["id"]
    assert len(history) == 1
    assert history[0]["turn_id"] == "turn-failed-1"
    assert history[0]["chat_error"] is True
    assert history[0]["content"] == (
        "本轮处理失败：模型连接失败\n\n请根据错误提示处理后重试。"
    )
