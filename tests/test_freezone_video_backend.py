from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone.jobs import run_freezone_video_gen
from novelvideo.generators.video_generator import (
    HuimengVideoGenerator,
    Seedance2VideoGenerator,
    ShotReference,
    newapi_video_backend_options,
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
    normalize_video_duration_for_backend,
    normalize_video_resolution,
    normalize_video_resolution_for_backend,
    resolve_freezone_video_backend,
    summarize_omni_reference_counts,
    validate_omni_reference_audio_durations,
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


def test_build_freezone_image_to_video_prompt_uses_image_reference_semantics() -> None:
    prompt = build_freezone_image_to_video_prompt(
        user_prompt="老人缓慢抬眼，呼吸微弱。",
        camera_template_id="pedestal_up",
        marks=[{"label": "老人", "point_x": 0.15, "point_y": 0.45, "note": "主体"}],
    )

    assert "老人缓慢抬眼" in prompt
    assert "镜头上升" in prompt
    assert "老人" in prompt
    assert "主体" in prompt
    assert "图片参考约束" in prompt
    assert "不要强制把输入图片锁定为视频第一帧" in prompt
    assert "首帧约束" not in prompt


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
    }.issubset(names)
    assert "newapi_grok-video-channel" not in names
    assert ids == set(names)
    assert api_models == set(names)
    assert all(item["providerId"] == "newapi" for item in options)
    assert "Seedance1.0 Pro Fast" in labels
    assert "Seedance1.5 Pro" in labels
    assert "Seedance2.0 Fast" in labels
    assert "HappyHorse 1.0" in labels
    assert "Grok Video Channel" not in labels
    assert normalize_video_resolution("720P") == "720p"
    happyhorse = next(item for item in options if item["id"] == "newapi_happyhorse-1.0")
    assert happyhorse["resolutionOptions"] == ["720p", "1080p"]
    assert happyhorse["minDuration"] == 3
    assert happyhorse["maxDuration"] == 15
    assert normalize_video_resolution_for_backend("newapi_happyhorse-1.0", "480p") == "720p"


def test_catalog_resolution_options_override_legacy_video_whitelist() -> None:
    assert (
        normalize_video_resolution_for_backend(
            "newapi_Kling-V2.1",
            "4K",
            ["1080p", "4K"],
        )
        == "4K"
    )


def test_catalog_duration_bounds_override_legacy_video_bounds() -> None:
    assert (
        normalize_video_duration_for_backend(
            "newapi_happyhorse-1.0",
            20,
            2,
            30,
        )
        == 20
    )
    assert (
        normalize_video_duration_for_backend(
            "newapi_happyhorse-1.0",
            1,
            2,
            30,
        )
        == 2
    )


def test_video_duration_normalization_uses_ceiling_and_backend_bounds() -> None:
    assert normalize_video_duration_for_backend(
        "newapi_seedance-1.0-pro-fast",
        1,
    ) == 2
    assert normalize_video_duration_for_backend(
        "newapi_seedance-1.0-pro-fast",
        100,
    ) == 12
    assert normalize_video_duration_for_backend(
        "newapi_seedance-1.0-pro-fast",
        5.1,
    ) == 6


def test_newapi_video_backend_preserves_gateway_model_case() -> None:
    from novelvideo.generators.video_generator import parse_newapi_video_backend

    assert parse_newapi_video_backend("newapi_Kling-V2.1") == "Kling-V2.1"


def test_grok_video_channel_is_not_exposed_even_if_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    from novelvideo import config

    monkeypatch.setattr(
        config,
        "NEWAPI_VIDEO_MODELS",
        ["seedance-2.0-fast", "grok-video-channel"],
    )

    assert "newapi_grok-video-channel" not in newapi_video_backend_options()
    assert "newapi_grok-video-channel" not in get_freezone_video_model_names()
    with pytest.raises(ValueError, match="unknown video model"):
        resolve_freezone_video_backend("newapi_grok-video-channel")


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


def test_freezone_rejects_removed_wan26_backend() -> None:
    with pytest.raises(ValueError, match="unknown video model"):
        resolve_freezone_video_backend("wan26")


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


@pytest.mark.asyncio
async def test_freezone_keyframe_tail_only_does_not_promote_tail_to_first_frame(
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

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        lambda **_kwargs: FakeVideoGenerator(),
    )

    tail_path = tmp_path / "tail.png"
    tail_path.write_bytes(b"fake image")
    await run_freezone_video_gen(
        project_dir=tmp_path,
        job_id="job_tail_only",
        prompt="最终停在目标构图",
        reference_items=[{"type": "image", "path": str(tail_path), "role": "尾帧"}],
        backend="newapi_seedance-2.0",
        last_frame_path=str(tail_path),
        gen_mode="first_last_frame",
    )

    assert captured["generate"]["image_path"] is None
    assert captured["generate"]["last_frame_path"] == str(tail_path)


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

    validate_omni_reference_limits(
        [{"type": "image", "url": "/static/a.png"}],
        image_max=1,
        video_max=0,
        audio_max=0,
        total_max=1,
    )
    with pytest.raises(ValueError, match="image references count must be <= 1"):
        validate_omni_reference_limits(
            [
                {"type": "image", "url": "/static/a.png"},
                {"type": "image", "url": "/static/b.png"},
            ],
            image_max=1,
            video_max=0,
            audio_max=0,
            total_max=2,
        )


def test_validate_omni_reference_audio_durations_per_clip_bounds() -> None:
    # 厂商逐条口径：1.8s ≤ 时长 ≤ 15.2s，两端都是闭区间。
    validate_omni_reference_audio_durations([("a.wav", 1.8)])
    validate_omni_reference_audio_durations([("a.wav", 15.2)])

    with pytest.raises(ValueError, match=r"must be >= 1\.8s") as short_exc:
        validate_omni_reference_audio_durations([("ok.wav", 5.0), ("tiny.wav", 0.9)])
    # 只点名越界的那条，别把合规的也列进去让用户猜。
    assert "tiny.wav (0.9s)" in str(short_exc.value)
    assert "ok.wav" not in str(short_exc.value)

    with pytest.raises(ValueError, match=r"must be <= 15\.2s"):
        validate_omni_reference_audio_durations([("long.wav", 15.201)])


def test_validate_omni_reference_audio_durations_total_bound() -> None:
    """3 条各 6s：逐条全合规，总计 18s —— 2026-08-06 3060 两次任务就死在这。

    厂商报文：`audio total duration (seconds) ... must be less than or equal to 15.2
    for model doubao-seedance-2-0 in r2v`。别把这条当成多余的本地规则删掉。
    """
    with pytest.raises(ValueError, match="total duration must be <= 15.2s") as exc:
        validate_omni_reference_audio_durations(
            [("a.wav", 6.0), ("b.wav", 6.0), ("c.wav", 6.0)]
        )
    assert "got 18s" in str(exc.value)

    # 顶格 15.2s 必须放行：浮点和会漂到 15.200000000000001，裸比较会误拦。
    validate_omni_reference_audio_durations(
        [("a.wav", 6.0), ("b.wav", 6.0), ("c.wav", 3.2)]
    )
    # 单条顶格同样不能被总和这条误伤（兜底上限与单条上限同值）。
    validate_omni_reference_audio_durations([("a.wav", 15.2)])

    # 单条越界优先上报：先换掉那条，再谈整体裁剪。
    with pytest.raises(ValueError, match="must be <= 15.2s"):
        validate_omni_reference_audio_durations([("a.wav", 20.0), ("b.wav", 6.0)])

    # 上限走传入值（后台 referenceAudioTotalMaxSeconds）。
    validate_omni_reference_audio_durations(
        [("a.wav", 6.0), ("b.wav", 6.0)], total_max_seconds=30.0
    )
    with pytest.raises(ValueError, match="total duration must be <= 10s"):
        validate_omni_reference_audio_durations(
            [("a.wav", 6.0), ("b.wav", 6.0)], total_max_seconds=10.0
        )


def test_validate_omni_reference_audio_durations_skips_unmeasured() -> None:
    """探测不出的条目不参与判定——漏算只会让和更小，不会因此误拦。"""
    validate_omni_reference_audio_durations([("unknown.wav", None)])
    validate_omni_reference_audio_durations(
        [("a.wav", 6.0), ("unknown.wav", None), ("c.wav", 6.0)]
    )
    validate_omni_reference_audio_durations([])
    # 0 / 负数是 ffprobe 的垃圾输出，同样按「测不出」处理，别当成一条 0s 的太短音频。
    validate_omni_reference_audio_durations([("weird.wav", 0.0), ("neg.wav", -1.0)])
