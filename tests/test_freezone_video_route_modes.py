from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import FreezoneImageToVideoRequest, FreezoneKeyframeVideoRequest


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
        return object(), "admin", "project", tmp_path, str(tmp_path / "output")

    async def resolve_backend(_model):
        return "newapi_seedance-2.0-mini"

    async def resolve_request(_media_type, _model, _params, *, mode):
        captured["request_mode"] = mode
        return None, {}, capabilities

    async def start(**kwargs):
        captured["start"] = kwargs
        return {"job_id": "job-test"}

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", resolve_project)
    monkeypatch.setattr(freezone_routes, "_resolve_catalog_video_backend", resolve_backend)
    monkeypatch.setattr(freezone_routes, "_resolve_catalog_request", resolve_request)
    monkeypatch.setattr(freezone_routes, "_start_or_enqueue_freezone_video_gen", start)
    monkeypatch.setattr(
        freezone_routes,
        "_resolve_url_list",
        lambda _project_dir, urls: [str(url) for url in urls if url],
    )
    return captured


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
    assert [item["path"] for item in captured["start"]["reference_items"]] == [
        "https://example.com/a.png",
        "https://example.com/b.png",
    ]


def test_image_to_video_requires_an_explicit_new_mode() -> None:
    with pytest.raises(ValidationError, match="gen_mode"):
        FreezoneImageToVideoRequest(
            image_urls=["https://example.com/ref.png"],
            model="catalog-video",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("first_url", "last_url", "expected_mode", "expected_image_path"),
    [
        ("https://example.com/first.png", None, "first_frame", "https://example.com/first.png"),
        (
            "https://example.com/first.png",
            "https://example.com/last.png",
            "first_last_frame",
            "https://example.com/first.png",
        ),
        (None, "https://example.com/last.png", "first_last_frame", None),
    ],
)
async def test_keyframe_route_derives_first_both_and_last_only_protocols(
    monkeypatch,
    tmp_path: Path,
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
        ),
        {"username": "admin"},
    )

    assert captured["request_mode"] == expected_mode
    assert captured["start"]["gen_mode"] == expected_mode
    assert captured["start"]["last_frame_path"] == last_url
    first_items = [
        item for item in captured["start"]["reference_items"] if item["role"] == "首帧"
    ]
    assert (first_items[0]["path"] if first_items else None) == expected_image_path
