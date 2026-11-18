from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone as routes
from novelvideo.freezone import jobs
from novelvideo.freezone.video_enhancement import (
    CLAYMORE_PROCESSING_MODELS,
    claymore_source_error,
)


def catalog_entry(identifier: str, model: str, mode: str) -> dict:
    return {
        "catalogId": identifier,
        "apiModel": f"newapi_{model}",
        "supportedModes": [mode],
        "resolutionOptions": ["1080p", "2k", "4k"],
        "referenceVideoMax": 1,
    }


@pytest.fixture
def catalog():
    return [
        catalog_entry("clay-up", CLAYMORE_PROCESSING_MODELS["video_upscale"], "video_upscale"),
        catalog_entry(
            "clay-fps", CLAYMORE_PROCESSING_MODELS["video_frame_rate"], "video_frame_rate"
        ),
        catalog_entry("standard-up", "video-super-resolution", "video_upscale"),
        catalog_entry("standard-fps", "video-frame-rate", "video_frame_rate"),
        catalog_entry("topaz-up", "topaz-video-upscale", "video_upscale"),
        catalog_entry("topaz-fps", "topaz-video-frame-rate", "video_frame_rate"),
    ]


@pytest.mark.parametrize("mode,suffix", [("video_upscale", "up"), ("video_frame_rate", "fps")])
def test_enhancement_plans_select_their_own_models(catalog, mode, suffix):
    for scheme, identifier in [("standard", "standard"), ("topaz", "topaz"), ("claymore", "clay")]:
        entry = routes._video_processing_entry(catalog, mode, scheme)
        assert entry["catalogId"] == f"{identifier}-{suffix}"
    claymore = routes._video_processing_entry(catalog, mode, "claymore")
    assert "enhancementGroup" not in claymore
    assert routes._video_processing_entry([claymore, dict(claymore)], mode, "claymore") is None
    assert (
        routes._video_processing_entry([{**claymore, "supportedModes": []}], mode, "claymore")
        is None
    )


@pytest.fixture
def source_meta():
    return {"width": 720, "height": 1280, "fps": 24, "duration": 4.064}


@pytest.mark.parametrize(
    "change,resolution,frame_rate",
    [
        ({"fps": 0.5}, "1080p", False),
        ({"width": 63}, "1080p", False),
        ({"width": 721}, "1080p", False),
        ({"duration": 121}, "1080p", False),
        ({"width": 1922}, "1080p", False),
        ({"fps": 30}, "4k", False),
        ({"width": 1920, "height": 1080}, "4k", False),
        ({"fps": 25}, "1080p", True),
        ({}, "2k", True),
        ({"hdr": True}, "1080p", False),
        ({"constant_frame_rate": False}, "1080p", False),
        ({"pixel_format": "yuv420p10le"}, "1080p", False),
        ({"field_order": "tt"}, "1080p", False),
        ({"sample_aspect_ratio": "4:3"}, "1080p", False),
        ({"rotated": True}, "1080p", False),
    ],
)
def test_claymore_rejects_unsupported_source_profiles(source_meta, change, resolution, frame_rate):
    assert claymore_source_error({**source_meta, **change}, resolution, frame_rate=frame_rate)


def test_claymore_preserves_portrait_and_qualified_four_k(source_meta):
    assert claymore_source_error(source_meta, "1080p", frame_rate=True) is None
    assert claymore_source_error(source_meta, "4k") is None


@pytest.fixture
def prepared_catalog(tmp_path, monkeypatch, catalog, source_meta):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    monkeypatch.setattr(routes, "resolve_static_url_to_path", lambda *_: source)

    async def probe(*_args, **_kwargs):
        return dict(source_meta)

    async def scoped_catalog(*_args, **_kwargs):
        return catalog

    async def resolve(_kind, identifier, _params, *, mode, requester_user_id):
        assert requester_user_id == "viewer"
        entry = next(item for item in catalog if item["catalogId"] == identifier)
        assert mode in entry["supportedModes"]
        return {"endpoint": "video/generations", "parameters": []}, {}, entry

    monkeypatch.setattr(jobs, "probe_video_stream", probe)
    monkeypatch.setattr(routes, "_scoped_media_model_catalog", scoped_catalog)
    monkeypatch.setattr(routes, "_resolve_catalog_request", resolve)
    return source


@pytest.mark.asyncio
@pytest.mark.parametrize("target_fps", [None, 60])
async def test_claymore_quotes_and_executes_the_same_frozen_stages(
    tmp_path,
    monkeypatch,
    catalog,
    prepared_catalog,
    target_fps,
):
    request = routes.FreezoneVideoUpscaleRequest(
        enhancement_model="claymore",
        source_url="/source.mp4",
        target_fps=target_fps,
        smart_interpolation=False,
    )
    source, _meta, models, billing = await routes._prepare_video_upscale(
        body=request,
        project_dir=tmp_path,
        requester_user_id="viewer",
    )
    expected = ["video_upscale", *(["video_frame_rate"] if target_fps else [])]
    assert billing["feature_key"] == "freezone.video_enhance"
    assert [stage["mode"] for stage in billing["pricing_stages"]] == expected
    assert [stage["catalog_id"] for stage in billing["pricing_stages"]] == [
        "clay-up",
        *(["clay-fps"] if target_fps else []),
    ]
    assert all(stage["enhancement_model"] == "claymore" for stage in billing["pricing_stages"])
    assert all(stage["duration_seconds"] == 5 for stage in billing["pricing_stages"])
    catalog.clear()  # Execution uses its accepted task snapshot, not a new catalog lookup.
    calls = []

    async def process(**kwargs):
        assert Path(kwargs["source_path"]).exists()
        calls.append(kwargs)
        Path(kwargs["output_path"]).write_bytes(kwargs["mode"].encode())

    monkeypatch.setattr(jobs, "_run_video_processing_model", process)
    output, _ = await jobs.run_freezone_video_upscale(
        project_dir=tmp_path,
        job_id="third-plan",
        source_path=str(source),
        resolution="1080p",
        target_fps=target_fps,
        smart_interpolation=False,
        **models,
    )
    assert output.exists()
    assert [call["mode"] for call in calls] == expected
    assert [call["backend"] for call in calls] == [
        f"newapi_{CLAYMORE_PROCESSING_MODELS[mode]}" for mode in expected
    ]
    assert calls[0]["processing_metadata"] == {}
    if target_fps:
        assert calls[1]["processing_metadata"] == {"target_fps": 60, "smart_interpolation": False}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override",
    [
        {"slowdown": "2x"},
        {"target_fps": 30},
        {"target_fps": 60, "resolution": "2k"},
        {"face_enhance": True},
        {"scene": "anime"},
    ],
)
async def test_claymore_rejects_unsupported_options_before_quoting(
    tmp_path, prepared_catalog, override
):
    with pytest.raises(HTTPException) as raised:
        await routes._prepare_video_upscale(
            body=routes.FreezoneVideoUpscaleRequest(
                enhancement_model="claymore", source_url="/source.mp4", **override
            ),
            project_dir=tmp_path,
            requester_user_id="viewer",
        )
    assert raised.value.status_code == 400


@pytest.mark.asyncio
async def test_claymore_requires_the_second_model_only_for_frame_rate(
    tmp_path,
    catalog,
    prepared_catalog,
):
    catalog[:] = [item for item in catalog if item["catalogId"] != "clay-fps"]
    request = routes.FreezoneVideoUpscaleRequest(
        enhancement_model="claymore", source_url="/source.mp4"
    )
    await routes._prepare_video_upscale(
        body=request, project_dir=tmp_path, requester_user_id="viewer"
    )
    with pytest.raises(HTTPException) as raised:
        await routes._prepare_video_upscale(
            body=request.model_copy(update={"target_fps": 60}),
            project_dir=tmp_path,
            requester_user_id="viewer",
        )
    assert raised.value.status_code == 409


@pytest.mark.asyncio
async def test_claymore_probe_exposes_only_configured_supported_options(
    tmp_path,
    monkeypatch,
    catalog,
    source_meta,
    prepared_catalog,
):
    from types import SimpleNamespace

    async def project(*_args, **_kwargs):
        return (
            SimpleNamespace(requester_user_id="viewer"),
            "user",
            "project",
            tmp_path,
            str(tmp_path),
        )

    monkeypatch.setattr(routes, "_resolve_freezone_project", project)
    result = await routes.freezone_video_upscale_probe(
        project="project",
        source_url="/source.mp4",
        enhancement_model="claymore",
        user={},
    )
    assert result["data"]["enhancement_models"] == ["topaz", "standard", "claymore"]
    assert result["data"]["upscale_resolutions"] == ["1080p", "2k", "4k"]
    assert result["data"]["frame_rate_resolutions"] == ["1080p"]
    source_meta["fps"] = 25
    result = await routes.freezone_video_upscale_probe(
        project="project",
        source_url="/source.mp4",
        enhancement_model="claymore",
        user={},
    )
    assert result["data"]["upscale_resolutions"] == ["1080p", "2k"]
    assert result["data"]["frame_rate_resolutions"] == []


@pytest.mark.asyncio
async def test_claymore_rejects_a_changed_model_identity_during_resolution(
    monkeypatch,
    catalog,
):
    async def scoped(*_args, **_kwargs):
        return catalog

    async def resolve(*_args, **_kwargs):
        return {}, {}, catalog_entry("changed", "video-super-resolution", "video_upscale")

    monkeypatch.setattr(routes, "_scoped_media_model_catalog", scoped)
    monkeypatch.setattr(routes, "_resolve_catalog_request", resolve)
    with pytest.raises(HTTPException) as raised:
        await routes._resolve_video_processing_model(
            "video_upscale", requester_user_id="viewer", scheme="claymore"
        )
    assert raised.value.status_code == 409


@pytest.mark.asyncio
async def test_claymore_rejects_an_incomplete_frozen_plan_before_model_egress(
    tmp_path,
    monkeypatch,
    prepared_catalog,
):
    async def unexpected(**_kwargs):
        pytest.fail("an incomplete enhancement plan must fail before a paid model call")

    monkeypatch.setattr(jobs, "_run_video_processing_model", unexpected)
    with pytest.raises(RuntimeError, match="unsupported Claymore"):
        await jobs.run_freezone_video_upscale(
            project_dir=tmp_path,
            job_id="incomplete-plan",
            source_path=str(prepared_catalog),
            resolution="1080p",
            target_fps=60,
            enhancement_model="claymore",
            upscale_backend="newapi_claymore-video-upscale",
            frame_rate_backend=None,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["video_upscale", "video_frame_rate"])
async def test_claymore_uses_the_normal_dc_media_wire_contract(tmp_path, monkeypatch, mode):
    from novelvideo.generators import video_generator as generator_module

    generator = generator_module.NewApiVideoGenerator(
        model=CLAYMORE_PROCESSING_MODELS[mode],
        api_key="ordinary-token",
        endpoint="https://gateway.example/v1",
        resolution="1080p",
        generate_audio=False,
    )
    posted = []

    async def relay(*_args, **_kwargs):
        return "https://media.example/relay/source.mp4"

    async def post(url, payload, **kwargs):
        posted.append((url, payload, kwargs))
        raise RuntimeError("stop after capturing final request")

    async def noop(*_args, **_kwargs):
        return ""

    monkeypatch.setattr(generator, "_relay_media_input", relay)
    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator_module, "_reserve_video_model_call", noop)
    monkeypatch.setattr(generator_module, "_refund_video_model_call", noop)
    monkeypatch.setattr(generator_module, "update_current_model_call_log", noop)
    await generator.generate(
        image_path=None,
        prompt="",
        output_path=str(tmp_path / "output.mp4"),
        aspect_ratio="auto",
        duration=5,
        references=[generator_module.ShotReference("video", "/source.mp4", "源视频")],
        gen_mode=mode,
        processing_metadata=(
            {"target_fps": 60, "smart_interpolation": False} if mode == "video_frame_rate" else {}
        ),
    )
    assert len(posted) == 1
    url, payload, kwargs = posted[0]
    assert url == "https://gateway.example/v1/video/generations"
    assert generator.headers == {
        "Authorization": "Bearer ordinary-token",
        "Content-Type": "application/json",
    }
    assert not kwargs  # Uses ordinary gateway credentials, without a private header protocol.
    assert payload["model"] == CLAYMORE_PROCESSING_MODELS[mode]
    assert payload["duration"] == 5
    assert payload["n"] == 1 and payload["response_format"] == "url"
    assert not {"seconds", "size", "width", "height", "aspect_ratio", "mode"}.intersection(payload)
    metadata = payload["metadata"]
    assert metadata["ratio"] == "auto" and metadata["resolution"] == "1080p"
    assert metadata["reference_videos"] == ["https://media.example/relay/source.mp4"]
    assert not {"source_sha256", "scene", "face_enhance", "resolution_tier"}.intersection(metadata)
    if mode == "video_frame_rate":
        assert metadata["target_fps"] == 60 and metadata["smart_interpolation"] is False
