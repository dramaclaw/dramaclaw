from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo import ports
from novelvideo.media_archive_copy import copy_archived_result
from novelvideo.ports.registry import PortNotRegistered
from novelvideo.ports.video_delivery import VideoDeliveryError


ARCHIVE = {
    "asset_id": 42,
    "status": "success",
    "storage_provider": "aliyun_oss",
    "bucket": "archive-source",
    "object_key": "results/image.png",
    "url": "https://archive.example/image.png",
    "content_type": "image/png",
    "size": 5,
    "sha256": "a" * 64,
}


@pytest.mark.asyncio
async def test_disabled_media_copy_keeps_download_path(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(ports, "get_video_result_delivery", lambda: None)
    assert not await copy_archived_result(None, tmp_path / "image.png")


@pytest.mark.asyncio
async def test_enabled_media_copy_uses_archive_once(monkeypatch, tmp_path: Path):
    calls = []

    class Delivery:
        async def deliver(self, *, source, output_path):
            calls.append((source, output_path))
            Path(output_path).write_bytes(b"image")

    monkeypatch.setattr(ports, "get_video_result_delivery", lambda: Delivery())
    output = tmp_path / "nested" / "image.png"
    assert await copy_archived_result(ARCHIVE, output)
    assert output.read_bytes() == b"image"
    assert len(calls) == 1
    assert calls[0][0].object_key == "results/image.png"


@pytest.mark.asyncio
async def test_media_copy_preserves_existing_image_before_replacement(
    monkeypatch, tmp_path: Path
):
    class Delivery:
        async def deliver(self, *, source, output_path):
            Path(output_path).write_bytes(b"new-image")

    monkeypatch.setattr(ports, "get_video_result_delivery", lambda: Delivery())
    output = tmp_path / "scene.png"
    previous = tmp_path / "scene.previous.png"
    output.write_bytes(b"old-image")
    assert await copy_archived_result(
        ARCHIVE,
        output,
        before_copy=lambda: output.replace(previous),
    )
    assert previous.read_bytes() == b"old-image"
    assert output.read_bytes() == b"new-image"


@pytest.mark.asyncio
async def test_enabled_media_copy_requires_complete_archive(
    monkeypatch, tmp_path: Path
):
    monkeypatch.setattr(ports, "get_video_result_delivery", lambda: object())
    with pytest.raises(VideoDeliveryError, match="MEDIA_ARCHIVE_UNAVAILABLE"):
        await copy_archived_result({"status": "pending"}, tmp_path / "image.png")


@pytest.mark.asyncio
async def test_enabled_copy_does_not_hide_missing_delivery_port(
    monkeypatch, tmp_path: Path
):
    def missing_port():
        raise PortNotRegistered("video_result_delivery")

    monkeypatch.setenv("ST_MEDIA_ARCHIVE_COPY_ENABLED", "true")
    monkeypatch.setattr(ports, "get_video_result_delivery", missing_port)
    with pytest.raises(VideoDeliveryError, match="MEDIA_DELIVERY_PORT_UNAVAILABLE"):
        await copy_archived_result(ARCHIVE, tmp_path / "image.png")


@pytest.mark.asyncio
async def test_image_response_copies_archive_without_downloading(
    monkeypatch, tmp_path: Path
):
    import httpx

    from novelvideo.generators.nanobanana_grid import _call_newapi_image_api

    class Delivery:
        async def deliver(self, *, source, output_path):
            Path(output_path).write_bytes(b"copied-image")

    class Response:
        headers = {"x-newapi-request-id": "image-request-1"}

        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [{"url": ARCHIVE["url"], "archive": ARCHIVE}]}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, *args, **kwargs):
            return Response()

        async def get(self, *args, **kwargs):
            raise AssertionError("archive copy must not download the URL")

    monkeypatch.setattr(ports, "get_video_result_delivery", lambda: Delivery())
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    output = tmp_path / "image.png"
    state = {}
    image, _, error = await _call_newapi_image_api(
        api_key="test-token",
        model="test-image-model",
        prompt="test",
        base_url="https://gateway.example/v1",
        delivery_path=output,
        delivery_state=state,
    )
    assert error == ""
    assert image == b"copied-image"
    assert state == {"copied": True}

    def fail_read_bytes(self):
        raise AssertionError("path-only delivery must not read copied image bytes")

    monkeypatch.setattr(Path, "read_bytes", fail_read_bytes)
    path_only_state = {}
    path_only, _, error = await _call_newapi_image_api(
        api_key="test-token",
        model="test-image-model",
        prompt="test",
        base_url="https://gateway.example/v1",
        delivery_path=tmp_path / "path-only.png",
        delivery_state=path_only_state,
        read_copied_bytes=False,
    )
    assert error == ""
    assert path_only is None
    assert path_only_state == {"copied": True, "sha256": ARCHIVE["sha256"]}


@pytest.mark.asyncio
async def test_prop_reference_accepts_copied_file_without_image_bytes(
    monkeypatch, tmp_path
):
    from novelvideo.generators import nanobanana_prop

    async def copied_image(**kwargs):
        assert kwargs["read_copied_bytes"] is False
        Path(kwargs["delivery_path"]).write_bytes(b"copied-prop")
        kwargs["delivery_state"]["copied"] = True
        return None, "", ""

    monkeypatch.setattr(nanobanana_prop, "_call_newapi_image_api", copied_image)
    output = tmp_path / "prop.png"
    result = await nanobanana_prop._generate_via_newapi(
        prompt="jade pendant",
        output_path=str(output),
        api_key="test-token",
        model="test-image-model",
        base_url="https://gateway.example/v1",
    )
    assert result == str(output)
    assert output.read_bytes() == b"copied-prop"


@pytest.mark.asyncio
async def test_scene_360_accepts_copied_file_without_image_bytes(monkeypatch, tmp_path):
    from novelvideo.director_world import scene_360_builder

    async def copied_image(**kwargs):
        assert kwargs["read_copied_bytes"] is False
        Path(kwargs["delivery_path"]).write_bytes(b"copied-panorama")
        kwargs["delivery_state"]["copied"] = True
        return None, "", ""

    monkeypatch.setattr(scene_360_builder, "load_env", lambda: None)
    monkeypatch.setattr(scene_360_builder, "build_prompt", lambda **kwargs: "test prompt")
    monkeypatch.setattr(
        scene_360_builder,
        "_resolve_newapi_credentials",
        lambda: ("test-token", "https://gateway.example/v1"),
    )
    monkeypatch.setattr(scene_360_builder, "_call_newapi_image_api", copied_image)
    monkeypatch.setattr(scene_360_builder, "make_contact_sheet", lambda *args: None)
    args = SimpleNamespace(
        quality="medium",
        image_size="1K",
        provider="newapi",
        output_dir=str(tmp_path),
        text_only=True,
        scene_name="test scene",
        master="",
        reverse_master="",
        spatial_layout="",
        model="test-image-model",
        scene_description="test scene",
        style="live_action",
        layer_mode="full",
    )
    assert await scene_360_builder.run(args) == 0
    assert (tmp_path / "scene_panorama_2to1.png").read_bytes() == b"copied-panorama"


@pytest.mark.asyncio
async def test_audio_url_copies_archive_without_downloading(
    monkeypatch, tmp_path: Path
):
    import httpx

    pytest.importorskip("langid")

    from novelvideo import config
    from novelvideo.freezone.audio_node import _write_newapi_audio_speech

    class Delivery:
        async def deliver(self, *, source, output_path):
            Path(output_path).write_bytes(b"copied-audio")

    class Response:
        headers = {"content-type": "application/json"}

        def raise_for_status(self):
            pass

        def json(self):
            return {"audio": {"url": ARCHIVE["url"]}, "archive": ARCHIVE}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, *args, **kwargs):
            return Response()

        async def get(self, *args, **kwargs):
            raise AssertionError("archive copy must not download the URL")

    monkeypatch.setattr(ports, "get_video_result_delivery", lambda: Delivery())
    monkeypatch.setattr(
        config,
        "get_newapi_runtime_credentials",
        lambda **_: ("token", "https://gateway.example/v1"),
    )
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    output = tmp_path / "audio.mp3"
    await _write_newapi_audio_speech(
        output_path=output,
        model="test-audio-model",
        input_text="hello",
        response_format="mp3",
    )
    assert output.read_bytes() == b"copied-audio"
