"""Direct image providers send normalized references, whatever the caller passed.

Callers hand these transports raw file bytes (often a reused 4K PNG output).
The transport is the one place every caller passes through, so the bound is
applied there rather than in each caller.
"""

from __future__ import annotations

import base64
import io
import json

import httpx
import pytest
from PIL import Image

from novelvideo.utils.reference_image import REFERENCE_IMAGE_MAX_EDGE

_SOURCE_SIZE = (REFERENCE_IMAGE_MAX_EDGE + 904, (REFERENCE_IMAGE_MAX_EDGE + 904) // 2)


def _large_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", _SOURCE_SIZE, (20, 80, 160, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


def _assert_bounded_jpeg(data: bytes) -> None:
    with Image.open(io.BytesIO(data)) as image:
        assert image.format == "JPEG"
        assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


def _data_url_bytes(url: str) -> bytes:
    header, encoded = url.split(",", 1)
    assert header == "data:image/jpeg;base64"
    return base64.b64decode(encoded)


@pytest.mark.asyncio
async def test_openrouter_sends_bounded_jpeg_data_urls(monkeypatch):
    from novelvideo.generators import nanobanana_grid

    payloads: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payloads.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": []})

    class MockedAsyncClient(httpx.AsyncClient):
        def __init__(self, **_kwargs):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", MockedAsyncClient)

    async def capable(*_args):
        return True, ""

    monkeypatch.setattr(nanobanana_grid, "_check_openrouter_image_capability", capable)

    await nanobanana_grid._call_openrouter_image_api(
        "key", "model", "prompt", reference_images=[_large_png()]
    )

    [payload] = payloads
    images = [
        part["image_url"]["url"]
        for part in payload["messages"][0]["content"]
        if part["type"] == "image_url"
    ]
    assert len(images) == 1
    _assert_bounded_jpeg(_data_url_bytes(images[0]))


@pytest.mark.asyncio
async def test_huimeng_sends_bounded_jpeg_data_urls(monkeypatch):
    from novelvideo.generators import nanobanana_grid

    submitted: list[dict] = []

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def submit_task(self, *, model, params):
            submitted.append(params)
            raise RuntimeError("stop")

    monkeypatch.setattr(nanobanana_grid, "HuimengiTaskClient", FakeClient)

    await nanobanana_grid._call_huimeng_image_api(
        api_key="key",
        model="model",
        prompt="prompt",
        reference_images=[("ref.png", _large_png(), "image/png")],
    )

    [params] = submitted
    _assert_bounded_jpeg(_data_url_bytes(params["image"]))


@pytest.mark.asyncio
async def test_openai_edit_uploads_bounded_jpeg_files(monkeypatch):
    import openai

    from novelvideo.generators import nanobanana_grid

    uploads: list[list[tuple[str, bytes, str]]] = []

    class FakeImages:
        async def edit(self, *, image, **_kwargs):
            uploads.append(image)
            raise RuntimeError("stop")

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            self.images = FakeImages()

    class FakeMeter:
        async def reserve_current_model_call_credit(self, **_kwargs):
            return ""

        async def refund_model_call_credit_reservation(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(openai, "AsyncOpenAI", FakeOpenAI)
    monkeypatch.setattr(nanobanana_grid, "get_usage_meter", lambda: FakeMeter())

    await nanobanana_grid._call_openai_image_api(
        api_key="key",
        model="gpt-image-1",
        prompt="prompt",
        reference_images=[_large_png()],
    )

    assert uploads
    [(filename, data, mime_type)] = uploads[0]
    assert (filename.endswith(".jpg"), mime_type) == (True, "image/jpeg")
    _assert_bounded_jpeg(data)
