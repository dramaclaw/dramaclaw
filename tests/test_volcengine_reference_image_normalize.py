"""Volcengine image requests and the DirectorWorld builder send bounded references."""

from __future__ import annotations

import base64
import io
import json

import httpx
import pytest
from PIL import Image

from novelvideo.utils.reference_image import REFERENCE_IMAGE_MAX_EDGE

_WIDE = (REFERENCE_IMAGE_MAX_EDGE + 904, (REFERENCE_IMAGE_MAX_EDGE + 904) // 2)


def _write_png(tmp_path) -> str:
    path = tmp_path / "input.png"
    Image.new("RGB", _WIDE, (70, 120, 180)).save(path, format="PNG")
    return str(path)


def _assert_bounded_jpeg_data_url(url: str) -> None:
    header, encoded = url.split(",", 1)
    assert header == "data:image/jpeg;base64"
    with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
        assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


@pytest.fixture
def volcengine(monkeypatch):
    from novelvideo.generators import image_generator

    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(400, text="stop")

    class MockedAsyncClient(httpx.AsyncClient):
        def __init__(self, **_kwargs):
            super().__init__(transport=httpx.MockTransport(handler))

    async def reserve(*_args, **_kwargs):
        return ""

    async def refund(*_args, **_kwargs):
        return None

    monkeypatch.setattr(image_generator.httpx, "AsyncClient", MockedAsyncClient)
    monkeypatch.setattr(image_generator, "_reserve_image_model_call", reserve)
    monkeypatch.setattr(image_generator, "_refund_image_model_call", refund)
    generator = image_generator.VolcengineImageGenerator(
        api_key="key", endpoint="http://volcengine.invalid"
    )
    return generator, bodies


@pytest.mark.asyncio
async def test_seedream_upscale_sends_bounded_reference(tmp_path, volcengine):
    generator, bodies = volcengine

    await generator.upscale_with_img2img(_write_png(tmp_path), str(tmp_path / "out.png"))

    [body] = bodies
    _assert_bounded_jpeg_data_url(body["image_urls"][0])


@pytest.mark.asyncio
async def test_seededit_sends_bounded_reference(tmp_path, volcengine):
    generator, bodies = volcengine

    await generator.edit_with_seededit(
        _write_png(tmp_path), str(tmp_path / "out.png"), prompt="edit"
    )

    [body] = bodies
    _assert_bounded_jpeg_data_url(body["image"])


def test_seedream_reference_compression_caps_the_long_edge(tmp_path, volcengine):
    generator, _ = volcengine

    encoded, mime_type = generator._compress_image(_write_png(tmp_path), quality=60)

    _assert_bounded_jpeg_data_url(f"data:{mime_type};base64,{encoded}")


def test_director_world_reference_is_bounded(tmp_path):
    from pathlib import Path

    from novelvideo.director_world.block_world_builder import image_to_data_url

    _assert_bounded_jpeg_data_url(image_to_data_url(Path(_write_png(tmp_path))))
