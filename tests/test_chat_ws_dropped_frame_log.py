from __future__ import annotations

import logging

import pytest

from novelvideo.api.routes import chat as chat_routes


class _ClosedWebSocket:
    """A socket the client already closed, which is what `abort()` used to produce."""

    async def send_json(self, payload: dict[str, object]) -> None:
        raise RuntimeError("Cannot call \"send\" once a close message has been sent.")


@pytest.mark.asyncio
async def test_dropped_ws_frame_is_logged_with_type_and_turn(caplog) -> None:
    caplog.set_level(logging.WARNING, logger=chat_routes.logger.name)

    sent = await chat_routes._send_json_best_effort(
        _ClosedWebSocket(),
        {
            "type": "agent.turn.completed",
            "turn_id": "turn-123",
            "disposition": "cancelled",
            "message": {"text": "用户内容不该进日志"},
        },
    )

    assert sent is False
    records = [record for record in caplog.records if record.levelno >= logging.WARNING]
    assert records, "丢掉的终态帧必须留下日志，否则这类问题在线上完全不可观测"
    text = " ".join(record.getMessage() for record in records)
    assert "agent.turn.completed" in text
    assert "turn-123" in text
    # 脱敏：只记帧类型与轮次标识，不记 payload 内容。
    assert "用户内容不该进日志" not in text
