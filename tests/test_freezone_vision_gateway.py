from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from PIL import Image
from pydantic_ai.models.test import TestModel

from novelvideo import config
from novelvideo.freezone.vision_gateway import (
    FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
    FREEZONE_VISION_IMAGE_MAX_SOURCE_BYTES,
    FREEZONE_VISION_IMAGE_MAX_SOURCE_PIXELS,
    VisionInput,
    VisionTransportContext,
    call_freezone_vision_model,
    image_media_type,
    load_compact_vision_inputs,
)


@pytest.mark.asyncio
async def test_vision_gateway_uses_explicit_request_scoped_transport_without_global_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    explicit = VisionTransportContext(
        model_name="request-vision-model",
        model=TestModel(custom_output_text="request-scoped-result"),
    )
    environment_before = dict(os.environ)
    monkeypatch.setattr(
        config,
        "get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: pytest.fail(
            "explicit transport must bypass global config"
        ),
    )

    model, output = await call_freezone_vision_model(
        prompt="分析图片",
        images=[VisionInput(data=b"image", media_type="image/png")],
        timeout_seconds=FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
        transport_context=explicit,
    )

    assert model == "request-vision-model"
    assert output == "request-scoped-result"
    assert dict(os.environ) == environment_before
    assert "TestModel" not in repr(explicit)


@pytest.mark.asyncio
async def test_vision_gateway_rejects_untyped_transport_context_before_model_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        config,
        "get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: pytest.fail("malformed context must fail closed"),
    )

    with pytest.raises(TypeError, match="transport_context"):
        await call_freezone_vision_model(
            prompt="分析图片",
            images=[VisionInput(data=b"image", media_type="image/png")],
            timeout_seconds=FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
            transport_context={"model_name": "forged"},
        )


@pytest.mark.asyncio
async def test_vision_gateway_uses_pydantic_agent_and_logical_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_get_model(model_env, default_model=None, **kwargs):
        captured.update(
            {
                "model_env": model_env,
                "default_model": default_model,
                **kwargs,
            }
        )
        return TestModel(custom_output_text="视觉解析结果")

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", fake_get_model)
    monkeypatch.setattr(
        config,
        "get_effective_newapi_text_model_name",
        lambda *_args, **_kwargs: "custom-vision-model",
    )
    monkeypatch.setenv("FREEZONE_VISION_MODEL", "custom-vision-model")

    model, output = await call_freezone_vision_model(
        prompt="分析图片",
        images=[VisionInput(data=b"image", media_type="image/png")],
        timeout_seconds=FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS,
    )

    assert model == "custom-vision-model"
    assert output == "视觉解析结果"
    assert captured["model_env"] == "FREEZONE_VISION_MODEL"
    assert captured["model_name_override"] == "custom-vision-model"
    assert (
        captured["timeout_seconds_override"] == FREEZONE_VIDEO_ANALYSIS_TIMEOUT_SECONDS
    )


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


@pytest.mark.asyncio
async def test_compact_vision_inputs_resize_to_1280_jpeg_without_touching_source(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "frame.png"
    Image.new("RGB", (3840, 2160), (32, 64, 96)).save(source_path)
    source_bytes = source_path.read_bytes()

    inputs = await load_compact_vision_inputs([source_path])

    assert len(inputs) == 1
    assert inputs[0].media_type == "image/jpeg"
    assert inputs[0].data.startswith(b"\xff\xd8")
    with Image.open(io.BytesIO(inputs[0].data)) as compacted:
        assert compacted.mode == "RGB"
        assert compacted.size == (1280, 720)
    assert source_path.read_bytes() == source_bytes


@pytest.mark.asyncio
async def test_compact_vision_inputs_do_not_upscale_and_flatten_alpha(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "transparent.png"
    source = Image.new("RGBA", (640, 360), (0, 0, 0, 0))
    source.putpixel((320, 180), (255, 0, 0, 255))
    source.save(source_path)

    inputs = await load_compact_vision_inputs([source_path])

    with Image.open(io.BytesIO(inputs[0].data)) as compacted:
        assert compacted.size == (640, 360)
        assert compacted.mode == "RGB"
        background = compacted.getpixel((0, 0))
        assert all(channel >= 245 for channel in background)


@pytest.mark.asyncio
async def test_compact_vision_inputs_keep_batch_order(tmp_path: Path) -> None:
    paths: list[Path] = []
    for index, color in enumerate(((240, 20, 20), (20, 20, 240))):
        path = tmp_path / f"frame_{index}.png"
        Image.new("RGB", (320, 180), color).save(path)
        paths.append(path)

    inputs = await load_compact_vision_inputs(paths)

    assert len(inputs) == 2
    with Image.open(io.BytesIO(inputs[0].data)) as first:
        assert first.getpixel((160, 90))[0] > first.getpixel((160, 90))[2]
    with Image.open(io.BytesIO(inputs[1].data)) as second:
        assert second.getpixel((160, 90))[2] > second.getpixel((160, 90))[0]


@pytest.mark.asyncio
async def test_compact_vision_inputs_reject_compressed_large_image_before_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from PIL import ImageOps

    source_path = tmp_path / "compressed-large.png"
    Image.new("RGB", (8000, 8000), (7, 7, 7)).save(source_path)
    assert source_path.stat().st_size < FREEZONE_VISION_IMAGE_MAX_SOURCE_BYTES
    assert 8000 * 8000 > FREEZONE_VISION_IMAGE_MAX_SOURCE_PIXELS

    monkeypatch.setattr(
        ImageOps,
        "exif_transpose",
        lambda *_args, **_kwargs: pytest.fail(
            "oversized source reached full-decode path"
        ),
    )

    with pytest.raises(ValueError, match="exceeds pixel limit"):
        await load_compact_vision_inputs([source_path])


@pytest.mark.asyncio
async def test_compact_vision_inputs_reject_large_file_before_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "oversized.bin"
    with source_path.open("wb") as source_file:
        source_file.truncate(FREEZONE_VISION_IMAGE_MAX_SOURCE_BYTES + 1)

    monkeypatch.setattr(
        Image,
        "open",
        lambda *_args, **_kwargs: pytest.fail(
            "oversized source reached image header parsing"
        ),
    )

    with pytest.raises(ValueError, match="exceeds source byte limit"):
        await load_compact_vision_inputs([source_path])
