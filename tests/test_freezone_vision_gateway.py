from __future__ import annotations

import pytest
from pydantic_ai.models.test import TestModel

from novelvideo import config
from novelvideo.freezone.vision_gateway import (
    VisionInput,
    call_freezone_vision_model,
    image_media_type,
)


@pytest.mark.asyncio
async def test_vision_gateway_uses_pydantic_agent_and_logical_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_get_model(model_env, default_model, **kwargs):
        captured.update(
            {
                "model_env": model_env,
                "default_model": default_model,
                **kwargs,
            }
        )
        return TestModel(custom_output_text="视觉解析结果")

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", fake_get_model)
    monkeypatch.setenv("FREEZONE_VISION_MODEL", "custom-vision-model")

    model, output = await call_freezone_vision_model(
        prompt="分析图片",
        images=[VisionInput(data=b"image", media_type="image/png")],
    )

    assert model == "custom-vision-model"
    assert output == "视觉解析结果"
    assert captured["model_env"] == "FREEZONE_VISION_MODEL"
    assert captured["model_name_override"] == "custom-vision-model"


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("frame.png", "image/png"),
        ("frame.jpg", "image/jpeg"),
        ("frame.JPEG", "image/jpeg"),
        ("frame.webp", "image/webp"),
        ("frame.gif", "image/gif"),
        ("frame", "image/png"),
    ],
)
def test_image_media_type(path: str, expected: str) -> None:
    assert image_media_type(path) == expected
