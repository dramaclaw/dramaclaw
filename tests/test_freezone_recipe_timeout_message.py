from types import SimpleNamespace

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
async def test_recipe_text_timeout_returns_explicit_chat_safe_detail(monkeypatch):
    async def timed_out(**_kwargs):
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
        "Recipe 文本生成超时：模型在规定时间内未返回结果，请稍后重试。"
        "本轮未继续执行下游节点。"
    )
