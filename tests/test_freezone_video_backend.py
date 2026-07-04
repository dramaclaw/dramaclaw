from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone.jobs import run_freezone_video_gen
from novelvideo.generators.video_generator import (
    HuimengVideoGenerator,
    Seedance2VideoGenerator,
    ShotReference,
)
from novelvideo.generators.video_generator import VideoGenResult, VideoGenStatus
from novelvideo.freezone.video_node import (
    add_video_character_library_item,
    build_freezone_image_to_video_prompt,
    build_freezone_keyframe_video_prompt,
    build_freezone_omni_video_prompt,
    build_freezone_video_prompt,
    delete_video_character_library_item,
    get_freezone_video_model_names,
    get_freezone_video_model_options,
    get_video_camera_template,
    is_freezone_happyhorse_backend,
    is_freezone_seedance2_backend,
    load_video_character_library,
    normalize_video_aspect_ratio,
    normalize_video_resolution,
    normalize_video_resolution_for_backend,
    resolve_freezone_video_backend,
    summarize_omni_reference_counts,
    validate_omni_reference_limits,
)


def test_build_freezone_video_prompt_includes_camera_template_and_character_names() -> None:
    prompt = build_freezone_video_prompt(
        user_prompt="赛博朋克街头，角色缓慢向前走",
        camera_template_id="follow_tracking",
        character_names=["林小满", "阿七"],
        marks=[{"label": "老人", "point_x": 0.2, "point_y": 0.5}],
    )

    assert "赛博朋克街头" in prompt
    assert "跟随拍摄" in prompt
    assert "林小满、阿七" in prompt
    assert "重点元素标记" in prompt
    assert "老人" in prompt


def test_video_camera_template_lookup_works() -> None:
    template = get_video_camera_template("locked_off")

    assert template is not None
    assert template["name"] == "固定镜头"


def test_video_character_library_roundtrip(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    item = add_video_character_library_item(
        project_dir,
        name="林小满",
        image_urls=["/static/admin/58/freezone/_uploads/char.png"],
    )

    items = load_video_character_library(project_dir)
    assert len(items) == 1
    assert items[0]["id"] == item["id"]
    assert items[0]["name"] == "林小满"

    deleted = delete_video_character_library_item(project_dir, item["id"])
    assert deleted is True
    assert load_video_character_library(project_dir) == []


def test_video_ratio_and_resolution_normalization() -> None:
    assert normalize_video_aspect_ratio("auto") == "16:9"
    assert normalize_video_aspect_ratio("9:16") == "9:16"
    assert normalize_video_resolution("720P") == "720p"


def test_build_freezone_omni_video_prompt_includes_theme() -> None:
    prompt = build_freezone_omni_video_prompt(
        user_prompt="雨夜中老人躺在病床上，年轻男子伸手整理氧气管。",
        theme="压抑、克制、纪实感",
        camera_template_id="orbit_up",
        marks=[{"label": "氧气管", "point_x": 0.7, "point_y": 0.6}],
    )

    assert "压抑、克制、纪实感" in prompt
    assert "盘旋抬升" in prompt
    assert "氧气管" in prompt


def test_build_freezone_image_to_video_prompt_includes_first_frame_and_marks() -> None:
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="老人缓慢抬眼，呼吸微弱。",
        camera_template_id="pedestal_up",
        marks=[{"label": "老人", "point_x": 0.15, "point_y": 0.45, "note": "主体"}],
    )

    assert "老人缓慢抬眼" in prompt
    assert "镜头上升" in prompt
    assert "老人" in prompt
    assert "主体" in prompt
    assert "首帧约束" in prompt


def test_build_freezone_image_to_video_prompt_supports_multi_image_references() -> None:
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="老人微微抬头，保持病房压抑氛围。",
        camera_template_id="follow_tracking",
        reference_image_count=3,
    )

    assert "图片参考约束" in prompt
    assert "多张输入图片" in prompt
    assert "跟随拍摄" in prompt


def test_build_freezone_image_to_video_prompt_supports_box_marks() -> None:
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="老人微微转头。",
        camera_template_id="locked_off",
        marks=[{"label": "老人", "box_x": 0.05, "box_y": 0.2, "box_width": 0.3, "box_height": 0.5}],
    )

    assert "重点元素标记" in prompt
    assert "老人" in prompt
    assert "左侧中间" in prompt


def test_build_freezone_keyframe_video_prompt_handles_first_and_last_frame() -> None:
    prompt = build_freezone_keyframe_video_prompt(
        user_prompt="老人抬眼后镜头缓慢推进到病床侧面。",
        camera_template_id="pedestal_up",
        marks=[{"label": "老人", "point_x": 0.4, "point_y": 0.4}],
        has_first_frame=True,
        has_last_frame=True,
    )

    assert "老人抬眼后镜头缓慢推进到病床侧面" in prompt
    assert "镜头上升" in prompt
    assert "首尾帧约束" in prompt
    assert "老人" in prompt


def test_video_model_options_and_resolution_work() -> None:
    names = get_freezone_video_model_names()
    options = get_freezone_video_model_options()
    ids = {item["id"] for item in options}
    labels = {item["label"] for item in options}
    api_models = {item["apiModel"] for item in options}

    assert names[0] == "newapi_seedance-2.0-fast"
    assert {
        "newapi_seedance-2.0-fast",
        "newapi_seedance-1.0-pro-fast",
        "newapi_seedance-1.5-pro",
        "newapi_grok-video-channel",
    }.issubset(names)
    assert ids == set(names)
    assert api_models == set(names)
    assert all(item["providerId"] == "newapi" for item in options)
    assert "Seedance1.0 Pro Fast" in labels
    assert "Seedance1.5 Pro" in labels
    assert "Seedance2.0 Fast" in labels
    assert "HappyHorse 1.0" in labels
    assert "Grok Video Channel" in labels
    assert normalize_video_resolution("720P") == "720p"
    happyhorse = next(item for item in options if item["id"] == "newapi_happyhorse-1.0")
    assert happyhorse["resolutionOptions"] == ["720p", "1080p"]
    assert happyhorse["minDuration"] == 3
    assert happyhorse["maxDuration"] == 15
    assert normalize_video_resolution_for_backend("newapi_happyhorse-1.0", "480p") == "720p"
    grok = next(item for item in options if item["id"] == "newapi_grok-video-channel")
    assert grok["resolutionOptions"] == ["720p", "480p"]
    assert grok["minDuration"] == 6
    assert grok["maxDuration"] == 30
    assert normalize_video_resolution_for_backend("newapi_grok-video-channel", "1080p") == "720p"


def test_resolve_freezone_video_backend_accepts_id_and_label() -> None:
    assert (
        resolve_freezone_video_backend("newapi_seedance-1.0-pro-fast")
        == "newapi_seedance-1.0-pro-fast"
    )
    assert resolve_freezone_video_backend("Seedance1.5 Pro") == "newapi_seedance-1.5-pro"
    assert resolve_freezone_video_backend("huimeng_seedance20_fast") == "newapi_seedance-2.0-fast"
    assert resolve_freezone_video_backend("seedance_fast") == "newapi_seedance-1.0-pro-fast"
    assert resolve_freezone_video_backend("Seedance 1.5 有声") == "newapi_seedance-1.5-pro"
    assert resolve_freezone_video_backend(None) == "newapi_seedance-2.0-fast"


def test_seedance2_backend_detection_accepts_newapi_and_legacy_values() -> None:
    assert is_freezone_seedance2_backend("newapi_seedance-2.0-fast")
    assert is_freezone_seedance2_backend("huimeng_seedance-2.0-fast")
    assert is_freezone_seedance2_backend("seedance_2")
    assert not is_freezone_seedance2_backend("newapi_seedance-1.5-pro")


def test_happyhorse_backend_detection_accepts_newapi_value() -> None:
    assert is_freezone_happyhorse_backend("newapi_happyhorse-1.0")
    assert not is_freezone_happyhorse_backend("newapi_seedance-2.0-fast")


@pytest.mark.asyncio
async def test_freezone_video_gen_allows_newapi_seedance2_text_to_video(
    monkeypatch, tmp_path: Path
):
    captured: dict[str, dict] = {}

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            captured["generate"] = kwargs
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake mp4")
            return VideoGenResult(status=VideoGenStatus.DONE, video_path=str(output_path))

    def fake_create_video_generator(**kwargs):
        captured["create"] = kwargs
        return FakeVideoGenerator()

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        fake_create_video_generator,
    )

    out = await run_freezone_video_gen(
        project_dir=tmp_path,
        job_id="job_newapi_t2v",
        prompt="雨夜街头，镜头缓慢推进",
        reference_items=[],
        backend="newapi_seedance-2.0-fast",
    )

    assert out.exists()
    assert captured["create"]["backend"] == "newapi_seedance-2.0-fast"
    assert captured["generate"]["image_path"] is None
    assert captured["generate"]["references"] == []


@pytest.mark.asyncio
async def test_freezone_video_gen_allows_newapi_fast_text_to_video(monkeypatch, tmp_path: Path):
    captured: dict[str, dict] = {}

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            captured["generate"] = kwargs
            output_path = Path(kwargs["output_path"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake mp4")
            return VideoGenResult(status=VideoGenStatus.DONE, video_path=str(output_path))

    def fake_create_video_generator(**kwargs):
        captured["create"] = kwargs
        return FakeVideoGenerator()

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        fake_create_video_generator,
    )

    out = await run_freezone_video_gen(
        project_dir=tmp_path,
        job_id="job_newapi_fast_t2v",
        prompt="雨夜街头，镜头缓慢推进",
        reference_items=[],
        backend="newapi_seedance-1.0-pro-fast",
    )

    assert out.exists()
    assert captured["create"]["backend"] == "newapi_seedance-1.0-pro-fast"
    assert captured["generate"]["image_path"] is None
    assert captured["generate"]["references"] == []


def test_seedance2_model_selection_prefers_omni_model_for_mixed_references() -> None:
    generator = object.__new__(Seedance2VideoGenerator)

    assert (
        generator._select_generation_model(image_count=1, video_count=0, audio_count=0)
        == "seedance-2.0-i2v"
    )
    assert (
        generator._select_generation_model(image_count=1, video_count=1, audio_count=0)
        == "seedance-2.0"
    )
    assert (
        generator._select_generation_model(image_count=0, video_count=1, audio_count=0)
        == "seedance-2.0"
    )


def test_huimeng_multimodal_reference_params_support_images_videos_and_audio(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "ref.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    video_path = tmp_path / "ref.mp4"
    video_path.write_bytes(b"\x00\x00\x00\x18ftypmp42fake")
    audio_path = tmp_path / "ref.wav"
    audio_path.write_bytes(b"RIFFfakeWAVEfmt ")

    generator = object.__new__(HuimengVideoGenerator)
    params, counts = generator._build_reference_params(
        [
            ShotReference("image", str(image_path), "角色参考"),
            ShotReference("video", str(video_path), "动作参考"),
            ShotReference("audio", str(audio_path), "音频参考"),
        ],
        log=lambda _msg: None,
    )

    assert counts == {"image_count": 1, "video_count": 1, "audio_count": 1}
    assert params["reference_images"][0].startswith("data:image/png;base64,")
    assert params["reference_videos"][0].startswith("data:video/mp4;base64,")
    assert params["reference_audios"][0].startswith("data:audio/x-wav;base64,")


def test_validate_omni_reference_limits_and_summary() -> None:
    items = [{"type": "image", "url": f"/static/{i}.png"} for i in range(9)]
    items += [{"type": "video", "url": f"/static/{i}.mp4"} for i in range(3)]
    counts = summarize_omni_reference_counts(items)

    assert counts == {
        "image_count": 9,
        "video_count": 3,
        "audio_count": 0,
        "total_count": 12,
    }

    validate_omni_reference_limits(items)

    too_many_images = [{"type": "image", "url": f"/static/{i}.png"} for i in range(10)]
    try:
        validate_omni_reference_limits(too_many_images)
        raise AssertionError("expected validate_omni_reference_limits to fail")
    except ValueError as exc:
        assert "<= 9" in str(exc)
