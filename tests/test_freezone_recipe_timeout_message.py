from types import SimpleNamespace
import time
import logging
from logging.handlers import RotatingFileHandler

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone
from novelvideo.api.schemas import FreezoneRecipeCompileRequest


def test_recipe_text_timeout_detection_follows_wrapped_exception_chain():
    try:
        try:
            raise TimeoutError("socket read timed out")
        except TimeoutError as exc:
            raise RuntimeError("provider request failed") from exc
    except RuntimeError as wrapped:
        assert freezone._is_recipe_text_generation_timeout(wrapped) is True

    assert freezone._is_recipe_text_generation_timeout(RuntimeError("invalid recipe")) is False
    assert freezone._is_recipe_text_generation_timeout(
        RuntimeError("Request timed out.")
    ) is True


@pytest.mark.anyio
async def test_recipe_text_timeout_returns_explicit_chat_safe_detail(monkeypatch, caplog):
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(freezone, "time", SimpleNamespace(monotonic=lambda: clock.now, time=time.time))
    async def timed_out(**_kwargs):
        clock.now += 301.25
        raise RuntimeError("Request timed out.")

    monkeypatch.setattr(freezone, "generate_recipe_text", timed_out)

    with pytest.raises(HTTPException) as exc_info:
        await freezone.generate_freezone_recipe_text(
            FreezoneRecipeCompileRequest(
                recipe_id="general-text",
                node_kind="text",
                node_prompt="生成分集剧本",
            ),
            user=SimpleNamespace(get=lambda key, default="": "local" if key == "username" else default),
        )

    assert exc_info.value.status_code == 504
    assert exc_info.value.detail == (
        "Recipe 文本生成超时：等待文本生成结果已耗时 302 秒。"
        "本轮未继续执行下游节点。"
    )

    record = next(r for r in caplog.records if getattr(r, "phase", None) == "text_generation")
    assert record.elapsed_ms == 301250
    assert record.recipe_id == "general-text"
    handler = next(h for h in logging.getLogger("novelvideo.api").handlers
                   if isinstance(h, RotatingFileHandler))
    rendered = handler.format(record)
    assert "phase=text_generation" in rendered
    assert "elapsed_ms=301250" in rendered
    assert "recipe_id=general-text" in rendered


@pytest.mark.anyio
@pytest.mark.parametrize("delivery_timeout", [False, True])
async def test_recipe_text_late_success_and_delivery_timeout(monkeypatch, delivery_timeout, caplog):
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(
        freezone, "time", SimpleNamespace(monotonic=lambda: clock.now, time=time.time)
    )
    failures = []

    async def generate(**_kwargs):
        clock.now += 301
        return "完成的文本"

    async def deliver(**_kwargs):
        if delivery_timeout:
            clock.now += 2.1
            raise TimeoutError("internal provider address must not be exposed")

    async def fail(**_kwargs):
        failures.append(True)
        clock.now += 30  # Cleanup must not inflate the measured phase duration.

    monkeypatch.setattr(freezone, "generate_recipe_text", generate)
    monkeypatch.setattr(freezone, "_record_recipe_compile_product_evidence", deliver)
    monkeypatch.setattr(freezone, "_fail_recipe_product_operation", fail)
    body = FreezoneRecipeCompileRequest(recipe_id="general-text", node_kind="text")
    if delivery_timeout:
        with pytest.raises(HTTPException) as exc_info:
            await freezone.generate_freezone_recipe_text(body, user={"username": "local"})
        assert exc_info.value.status_code == 504
        assert exc_info.value.detail == "Recipe 文本交付确认超时：已耗时 3 秒，请检查任务状态。"
        assert failures == [True]
        record = next(r for r in caplog.records if getattr(r, "phase", None) == "text_delivery")
        handler = next(h for h in logging.getLogger("novelvideo.api").handlers
                       if isinstance(h, RotatingFileHandler))
        rendered = handler.format(record)
        assert "phase=text_delivery" in rendered
        assert f"elapsed_ms={record.elapsed_ms}" in rendered
        assert "recipe_id=general-text" in rendered
        assert "internal provider address" not in rendered
    else:
        result = await freezone.generate_freezone_recipe_text(body, user={"username": "local"})
        assert result == {"ok": True, "data": {"content": "完成的文本"}}
        assert failures == []
