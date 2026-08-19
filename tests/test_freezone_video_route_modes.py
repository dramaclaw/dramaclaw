from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import (
    FreezoneImageToVideoRequest,
    FreezoneKeyframeVideoRequest,
    FreezoneVideoEditRequest,
    FreezoneVideoGenRequest,
    FreezoneVideoOmniGenRequest,
)


def _catalog(*modes: str) -> dict:
    return {
        "catalog_id": "catalog-video",
        "supportedModes": list(modes),
        "referenceImageMax": 9,
        "resolutionOptions": ["720p"],
        "minDuration": 1,
        "maxDuration": 15,
    }


async def _install_route_fakes(monkeypatch, tmp_path: Path, capabilities: dict) -> dict:
    captured: dict = {}

    async def resolve_project(_project, _user):
        return (
            SimpleNamespace(requester_user_id="user-1"),
            "admin",
            "project",
            tmp_path,
            str(tmp_path / "output"),
        )

    async def resolve_backend(_model, *, requester_user_id):
        assert requester_user_id == "user-1"
        return "newapi_seedance-2.0-mini"

    async def resolve_request(
        _media_type,
        _model,
        _params,
        *,
        mode,
        requester_user_id,
    ):
        assert requester_user_id == "user-1"
        captured["request_mode"] = mode
        return None, {}, capabilities

    async def start(**kwargs):
        captured["start"] = kwargs
        return {"job_id": "job-test"}

    async def validate_audio(reference_items, *, capabilities, backend):
        captured["validated_audio_items"] = reference_items

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", resolve_project)
    monkeypatch.setattr(freezone_routes, "_resolve_catalog_video_backend", resolve_backend)
    monkeypatch.setattr(freezone_routes, "_resolve_catalog_request", resolve_request)
    monkeypatch.setattr(freezone_routes, "_start_or_enqueue_freezone_video_gen", start)
    monkeypatch.setattr(
        freezone_routes,
        "_validate_catalog_reference_audio_items",
        validate_audio,
    )
    monkeypatch.setattr(
        freezone_routes,
        "_resolve_url_list",
        lambda _project_dir, urls: [str(url) for url in urls if url],
    )
    return captured


@pytest.mark.asyncio
async def test_video_edit_forwards_configured_independent_audio(
    monkeypatch, tmp_path: Path
) -> None:
    capabilities = _catalog("video_edit")
    capabilities.update(
        {
            "referenceVideoMax": 1,
            "referenceAudioMax": 2,
            "referenceAudioMinSeconds": 1,
            "referenceAudioMaxSeconds": 15,
        }
    )
    captured = await _install_route_fakes(monkeypatch, tmp_path, capabilities)

    await freezone_routes.freezone_video_edit(
        "project",
        FreezoneVideoEditRequest(
            video_url="https://example.com/source.mp4",
            image_urls=["https://example.com/style.png"],
            audio_urls=["https://example.com/music.mp3"],
            model="catalog-video",
            gen_mode="videoEdit",
        ),
        {"username": "admin"},
    )

    assert captured["request_mode"] == "videoEdit"
    assert captured["start"]["gen_mode"] == "video_edit"
    assert captured["start"]["aspect_ratio"] == "auto"
    assert captured["start"]["duration_seconds"] is None
    assert captured["start"]["reference_items"] == [
        {
            "type": "video",
            "path": "https://example.com/source.mp4",
            "role": "视频编辑源",
        },
        {
            "type": "image",
            "path": "https://example.com/style.png",
            "role": "图片参考",
        },
        {
            "type": "audio",
            "path": "https://example.com/music.mp3",
            "role": "配乐参考",
        },
    ]
    assert captured["validated_audio_items"] == captured["start"]["reference_items"]


@pytest.mark.asyncio
async def test_video_edit_rejects_audio_when_catalog_cap_is_zero(
    monkeypatch, tmp_path: Path
) -> None:
    capabilities = _catalog("video_edit")
    capabilities.update({"referenceVideoMax": 1, "referenceAudioMax": 0})
    await _install_route_fakes(monkeypatch, tmp_path, capabilities)

    with pytest.raises(HTTPException, match="at most 0 audio references"):
        await freezone_routes.freezone_video_edit(
            "project",
            FreezoneVideoEditRequest(
                video_url="https://example.com/source.mp4",
                audio_urls=["https://example.com/music.mp3"],
                model="catalog-video",
                gen_mode="videoEdit",
            ),
            {"username": "admin"},
        )


@pytest.mark.asyncio
async def test_image_to_video_uses_one_reference_image_not_first_frame(
    monkeypatch, tmp_path: Path
) -> None:
    captured = await _install_route_fakes(
        monkeypatch,
        tmp_path,
        _catalog("image_to_video"),
    )

    await freezone_routes.freezone_video_i2v(
        "project",
        FreezoneImageToVideoRequest(
            image_urls=["https://example.com/ref.png"],
            model="catalog-video",
            gen_mode="imageToVideo",
        ),
        {"username": "admin"},
    )

    assert captured["request_mode"] == "imageToVideo"
    assert captured["start"]["gen_mode"] == "image_reference"
    assert captured["start"]["requested_gen_mode"] == "imageToVideo"
    assert captured["start"]["reference_items"] == [
        {"type": "image", "path": "https://example.com/ref.png", "role": "图片参考"}
    ]


@pytest.mark.asyncio
async def test_image_to_video_rejects_more_than_one_image(monkeypatch, tmp_path: Path) -> None:
    await _install_route_fakes(monkeypatch, tmp_path, _catalog("image_to_video"))

    with pytest.raises(HTTPException, match="exactly one image"):
        await freezone_routes.freezone_video_i2v(
            "project",
            FreezoneImageToVideoRequest(
                image_urls=["https://example.com/a.png", "https://example.com/b.png"],
                model="catalog-video",
                gen_mode="imageToVideo",
            ),
            {"username": "admin"},
        )


@pytest.mark.asyncio
async def test_image_to_video_does_not_use_image_reference_capability(
    monkeypatch, tmp_path: Path
) -> None:
    await _install_route_fakes(monkeypatch, tmp_path, _catalog("image_reference"))

    with pytest.raises(HTTPException, match="image_to_video"):
        await freezone_routes.freezone_video_i2v(
            "project",
            FreezoneImageToVideoRequest(
                image_urls=["https://example.com/ref.png"],
                model="catalog-video",
                gen_mode="imageToVideo",
            ),
            {"username": "admin"},
        )


@pytest.mark.asyncio
async def test_image_reference_does_not_use_image_to_video_capability(
    monkeypatch, tmp_path: Path
) -> None:
    await _install_route_fakes(monkeypatch, tmp_path, _catalog("image_to_video"))

    with pytest.raises(HTTPException, match="image_reference"):
        await freezone_routes.freezone_video_i2v(
            "project",
            FreezoneImageToVideoRequest(
                image_urls=["https://example.com/a.png", "https://example.com/b.png"],
                model="catalog-video",
                gen_mode="imageReference",
            ),
            {"username": "admin"},
        )


@pytest.mark.asyncio
async def test_image_reference_keeps_multi_image_reference_protocol(
    monkeypatch, tmp_path: Path
) -> None:
    captured = await _install_route_fakes(
        monkeypatch,
        tmp_path,
        _catalog("image_reference"),
    )

    await freezone_routes.freezone_video_i2v(
        "project",
        FreezoneImageToVideoRequest(
            image_urls=["https://example.com/a.png", "https://example.com/b.png"],
            model="catalog-video",
            gen_mode="imageReference",
        ),
        {"username": "admin"},
    )

    assert captured["request_mode"] == "imageReference"
    assert captured["start"]["gen_mode"] == "image_reference"
    assert captured["start"]["requested_gen_mode"] == "imageReference"
    assert [item["path"] for item in captured["start"]["reference_items"]] == [
        "https://example.com/a.png",
        "https://example.com/b.png",
    ]


@pytest.mark.asyncio
async def test_video_edit_rejects_model_without_catalog_capability(
    monkeypatch, tmp_path: Path
) -> None:
    await _install_route_fakes(
        monkeypatch,
        tmp_path,
        _catalog("text_to_video", "first_frame", "image_reference"),
    )

    with pytest.raises(HTTPException, match="video_edit"):
        await freezone_routes.freezone_video_edit(
            "project",
            FreezoneVideoEditRequest(
                video_url="https://example.com/input.mp4",
                model="happyhorse-1.1",
                gen_mode="videoEdit",
            ),
            {"username": "admin"},
        )


def test_image_to_video_requires_an_explicit_new_mode() -> None:
    with pytest.raises(ValidationError, match="gen_mode"):
        FreezoneImageToVideoRequest(
            image_urls=["https://example.com/ref.png"],
            model="catalog-video",
        )


def test_fixed_video_routes_reject_cross_route_modes() -> None:
    with pytest.raises(ValidationError, match="gen_mode"):
        FreezoneVideoGenRequest(prompt="rain", gen_mode="allReference")
    with pytest.raises(ValidationError, match="gen_mode"):
        FreezoneVideoOmniGenRequest(prompt="rain", gen_mode="textToVideo")
    with pytest.raises(ValidationError, match="gen_mode"):
        FreezoneVideoEditRequest(video_url="video.mp4", gen_mode="firstFrame")


def test_keyframe_route_requires_explicit_mode() -> None:
    with pytest.raises(ValidationError, match="gen_mode"):
        FreezoneKeyframeVideoRequest(
            first_frame_url="https://example.com/ref.png",
            model="catalog-video",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("requested_mode", "first_url", "last_url", "expected_mode", "expected_image_path"),
    [
        (
            "firstFrame",
            "https://example.com/first.png",
            None,
            "first_frame",
            "https://example.com/first.png",
        ),
        (
            "firstLastFrame",
            "https://example.com/first.png",
            None,
            "first_last_frame",
            "https://example.com/first.png",
        ),
        (
            "firstLastFrame",
            "https://example.com/first.png",
            "https://example.com/last.png",
            "first_last_frame",
            "https://example.com/first.png",
        ),
        (
            "firstLastFrame",
            None,
            "https://example.com/last.png",
            "first_last_frame",
            None,
        ),
    ],
)
async def test_keyframe_route_preserves_selected_mode_for_all_frame_combinations(
    monkeypatch,
    tmp_path: Path,
    requested_mode: str,
    first_url: str | None,
    last_url: str | None,
    expected_mode: str,
    expected_image_path: str | None,
) -> None:
    captured = await _install_route_fakes(
        monkeypatch,
        tmp_path,
        _catalog("first_frame", "first_last_frame"),
    )

    await freezone_routes.freezone_video_keyframes(
        "project",
        FreezoneKeyframeVideoRequest(
            first_frame_url=first_url,
            last_frame_url=last_url,
            model="catalog-video",
            gen_mode=requested_mode,
        ),
        {"username": "admin"},
    )

    assert captured["request_mode"] == requested_mode
    assert captured["start"]["gen_mode"] == expected_mode
    assert captured["start"]["requested_gen_mode"] == requested_mode
    assert captured["start"]["aspect_ratio"] == "auto"
    assert captured["start"]["duration_seconds"] == 5
    assert captured["start"]["last_frame_path"] == last_url
    first_items = [
        item for item in captured["start"]["reference_items"] if item["role"] == "首帧"
    ]
    assert (first_items[0]["path"] if first_items else None) == expected_image_path


@pytest.mark.asyncio
async def test_text_to_video_preserves_selected_ratio_and_duration(
    monkeypatch, tmp_path: Path
) -> None:
    captured = await _install_route_fakes(
        monkeypatch,
        tmp_path,
        _catalog("text_to_video"),
    )

    await freezone_routes.freezone_video_gen(
        "project",
        FreezoneVideoGenRequest(
            prompt="rainy street",
            aspect_ratio="9:16",
            duration_seconds=9,
            model="catalog-video",
        ),
        {"username": "admin"},
    )

    assert captured["start"]["aspect_ratio"] == "9:16"
    assert captured["start"]["duration_seconds"] == 9


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("first_url", "last_url", "message"),
    [
        (None, None, "requires first_frame_url"),
        (
            "https://example.com/first.png",
            "https://example.com/last.png",
            "does not accept last_frame_url",
        ),
    ],
)
async def test_first_frame_mode_rejects_invalid_frame_combinations(
    monkeypatch,
    tmp_path: Path,
    first_url: str | None,
    last_url: str | None,
    message: str,
) -> None:
    await _install_route_fakes(monkeypatch, tmp_path, _catalog("first_frame"))

    with pytest.raises(HTTPException, match=message):
        await freezone_routes.freezone_video_keyframes(
            "project",
            FreezoneKeyframeVideoRequest(
                first_frame_url=first_url,
                last_frame_url=last_url,
                model="catalog-video",
                gen_mode="firstFrame",
            ),
            {"username": "admin"},
        )
