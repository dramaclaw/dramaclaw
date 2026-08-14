import pytest


pytestmark = pytest.mark.m09


class FakeHuimengClient:
    def __init__(self):
        self.submitted: tuple[str, dict] | None = None

    async def submit_task(self, *, model: str, params: dict):
        self.submitted = (model, params)
        return {"task_id": "task-1"}

    async def wait_for_completion(self, *_args, **_kwargs):
        return {"result": {"video_url": "https://example.com/out.mp4", "duration": 6}}

    async def download_url(self, _url: str, output_path: str):
        from pathlib import Path

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")


class FakeHuimengClientWithLastFrame(FakeHuimengClient):
    def __init__(self):
        super().__init__()
        self.downloaded_images: list[tuple[str, str]] = []

    async def wait_for_completion(self, *_args, **_kwargs):
        return {
            "result": {
                "video_url": "https://example.com/out.mp4",
                "duration": 6,
                "last_frame_url": "https://example.com/last-frame.png",
            }
        }

    async def download_image_url(self, url: str, output_path: str):
        from pathlib import Path

        self.downloaded_images.append((url, output_path))
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\x89PNG\r\n\x1a\nimage")


class FakeHuimengClientWithTopLevelLastFrame(FakeHuimengClientWithLastFrame):
    async def wait_for_completion(self, *_args, **_kwargs):
        return {
            "status": "completed",
            "last_frame_url": "https://example.com/top-level-last-frame.png",
            "result": {
                "video_url": "https://example.com/out.mp4",
                "duration": 6,
            },
        }


def test_huimeng_seedance2_config_accepts_json_string():
    from novelvideo.generators.video_generator import _seedance2_config_mapping

    config = _seedance2_config_mapping('{"duration": 11, "final_prompt": "configured"}')

    assert config == {"duration": 11, "final_prompt": "configured"}


def test_build_seedance2_first_frame_request_normalizes_prompt_mentions():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

    params = build_seedance2_huimeng_params(
        {
            "mode": Seedance2I2VMode.FIRST_FRAME.value,
            "final_prompt": "以 @图片1 生成视频，不要输出 @ 符号。",
            "duration": 6,
            "human_review": False,
            "human_review_user_set": True,
        },
        first_frame="data:image/png;base64,abc",
    )

    assert params["prompt"] == "以 图片1 生成视频，不要输出 @ 符号。"
    assert params["duration"] == 6
    assert params["image_url"] == "data:image/png;base64,abc"
    assert "human_review" not in params


def test_build_seedance2_multimodal_request_limits_reference_counts():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

    with pytest.raises(ValueError, match="at most 9 images"):
        build_seedance2_huimeng_params(
            {
                "mode": Seedance2I2VMode.MULTIMODAL_REFERENCE.value,
                "final_prompt": "参考图片1生成视频。",
                "human_review": False,
                "human_review_user_set": True,
            },
            reference_images=[f"https://example.com/{idx}.png" for idx in range(10)],
        )


def test_build_seedance2_multimodal_request_validates_prompt_reference_numbers():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

    with pytest.raises(ValueError, match="图片3"):
        build_seedance2_huimeng_params(
            {
                "mode": Seedance2I2VMode.MULTIMODAL_REFERENCE.value,
                "final_prompt": "参考图片3和音频1生成视频。",
                "human_review": False,
                "human_review_user_set": True,
            },
            reference_images=["https://example.com/1.png", "https://example.com/2.png"],
            reference_audios=["https://example.com/1.mp3"],
        )


def test_human_review_requires_http_media_urls():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

    with pytest.raises(ValueError, match="human_review requires HTTP/HTTPS"):
        build_seedance2_huimeng_params(
            {
                "mode": Seedance2I2VMode.FIRST_FRAME.value,
                "final_prompt": "参考图片1生成视频。",
                "human_review": True,
            },
            first_frame="data:image/png;base64,abc",
        )


def test_first_last_frame_request_requires_both_frames():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

    with pytest.raises(ValueError, match="last_frame is required"):
        build_seedance2_huimeng_params(
            {
                "mode": Seedance2I2VMode.FIRST_LAST_FRAME.value,
                "final_prompt": "从图片1自然过渡到图片2。",
                "human_review": False,
                "human_review_user_set": True,
            },
            first_frame="https://example.com/first.png",
        )


def test_build_seedance2_request_passes_scene_optimize():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

    params = build_seedance2_huimeng_params(
        {
            "mode": Seedance2I2VMode.FIRST_FRAME.value,
            "final_prompt": "参考图片1生成视频。",
            "scene_optimize": " anime ",
            "human_review": False,
            "human_review_user_set": True,
        },
        first_frame="https://example.com/first.png",
    )

    assert params["scene_optimize"] == "anime"


async def test_huimeng_seedance2_generator_uses_seedance2_request_builder(tmp_path):
    from novelvideo.generators.video_generator import (
        HuimengVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )

    client = FakeHuimengClient()
    generator = HuimengVideoGenerator(
        model="seedance-2.0-fast",
        resolution="720p",
        generate_audio=True,
        client=client,
    )

    result = await generator.generate(
        image_path=None,
        prompt="参考 @图片1 和 @音频1，人物轻轻抬头。",
        output_path=str(tmp_path / "out.mp4"),
        references=[
            ShotReference("image", "https://example.com/ref.png", "角色参考"),
            ShotReference("audio", "https://example.com/ref.mp3", "音频参考"),
        ],
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
    )

    assert result.status == VideoGenStatus.DONE
    assert client.submitted is not None
    model, params = client.submitted
    assert model == "seedance-2.0-fast"
    assert params["prompt"] == "参考 图片1 和 音频1，人物轻轻抬头。"
    assert params["reference_images"] == ["https://example.com/ref.png"]
    assert params["reference_audios"] == ["https://example.com/ref.mp3"]
    assert params["generate_audio"] is True
    assert params["return_last_frame"] is False
    assert "human_review" not in params


async def test_huimeng_seedance2_generator_preserves_seedance2_config_switches(tmp_path):
    import json

    from novelvideo.generators.video_generator import (
        HuimengVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    client = FakeHuimengClient()
    generator = HuimengVideoGenerator(
        model="seedance-2.0-fast",
        resolution="720p",
        generate_audio=False,
        client=client,
    )

    result = await generator.generate(
        image_path=None,
        prompt="参考图片1生成视频。",
        output_path=str(tmp_path / "out.mp4"),
        references=[ShotReference("image", "https://example.com/ref.png", "角色参考")],
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        seedance2_config=json.dumps(
            {
                "mode": Seedance2I2VMode.MULTIMODAL_REFERENCE.value,
                "final_prompt": "参考图片1生成视频。",
                "generate_audio": True,
                "generate_audio_user_set": True,
                "return_last_frame": True,
                "human_review": True,
                "human_review_user_set": True,
            },
            ensure_ascii=False,
        ),
    )

    assert result.status == VideoGenStatus.DONE
    assert client.submitted is not None
    _model, params = client.submitted
    assert params["generate_audio"] is True
    assert params["return_last_frame"] is True
    assert params["human_review"] is True


async def test_huimeng_seedance2_generator_downloads_returned_last_frame(tmp_path):
    import json

    from novelvideo.generators.video_generator import (
        HuimengVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    client = FakeHuimengClientWithLastFrame()
    generator = HuimengVideoGenerator(
        model="seedance-2.0-fast",
        resolution="720p",
        generate_audio=False,
        client=client,
    )

    result = await generator.generate(
        image_path=None,
        prompt="参考图片1生成视频。",
        output_path=str(tmp_path / "videos" / "beats" / "ep001" / "beat_01.mp4"),
        references=[ShotReference("image", "https://example.com/ref.png", "角色参考")],
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        seedance2_config=json.dumps(
            {
                "mode": Seedance2I2VMode.MULTIMODAL_REFERENCE.value,
                "final_prompt": "参考图片1生成视频。",
                "generate_audio": False,
                "generate_audio_user_set": True,
                "return_last_frame": True,
                "human_review": False,
                "human_review_user_set": True,
            },
            ensure_ascii=False,
        ),
    )

    expected_path = (
        tmp_path
        / "videos"
        / "beats"
        / "ep001"
        / "returned_last_frames"
        / "beat_01.png"
    )
    assert result.status == VideoGenStatus.DONE
    assert result.last_frame_url == "https://example.com/last-frame.png"
    assert result.last_frame_path == expected_path.as_posix()
    assert expected_path.exists()
    assert client.downloaded_images == [
        ("https://example.com/last-frame.png", str(expected_path))
    ]


async def test_huimeng_seedance2_generator_reads_returned_last_frame_from_task_payload(
    tmp_path,
):
    import json

    from novelvideo.generators.video_generator import (
        HuimengVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    client = FakeHuimengClientWithTopLevelLastFrame()
    generator = HuimengVideoGenerator(
        model="seedance-2.0-fast",
        resolution="720p",
        generate_audio=False,
        client=client,
    )

    result = await generator.generate(
        image_path=None,
        prompt="参考图片1生成视频。",
        output_path=str(tmp_path / "videos" / "beats" / "ep001" / "beat_01.mp4"),
        references=[ShotReference("image", "https://example.com/ref.png", "角色参考")],
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        seedance2_config=json.dumps(
            {
                "mode": Seedance2I2VMode.MULTIMODAL_REFERENCE.value,
                "final_prompt": "参考图片1生成视频。",
                "generate_audio": False,
                "generate_audio_user_set": True,
                "return_last_frame": True,
                "human_review": False,
                "human_review_user_set": True,
            },
            ensure_ascii=False,
        ),
    )

    expected_path = (
        tmp_path
        / "videos"
        / "beats"
        / "ep001"
        / "returned_last_frames"
        / "beat_01.png"
    )
    assert result.status == VideoGenStatus.DONE
    assert result.last_frame_url == "https://example.com/top-level-last-frame.png"
    assert result.last_frame_path == expected_path.as_posix()
    assert expected_path.exists()
    assert client.downloaded_images == [
        ("https://example.com/top-level-last-frame.png", str(expected_path))
    ]


async def test_huimeng_seedance2_generator_preserves_disabled_seedance2_config_switches(
    tmp_path,
):
    import json

    from novelvideo.generators.video_generator import (
        HuimengVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    client = FakeHuimengClient()
    generator = HuimengVideoGenerator(
        model="seedance-2.0-fast",
        resolution="720p",
        generate_audio=True,
        client=client,
    )

    result = await generator.generate(
        image_path=None,
        prompt="参考图片1生成视频。",
        output_path=str(tmp_path / "out.mp4"),
        references=[ShotReference("image", "https://example.com/ref.png", "角色参考")],
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        seedance2_config=json.dumps(
            {
                "mode": Seedance2I2VMode.MULTIMODAL_REFERENCE.value,
                "final_prompt": "参考图片1生成视频。",
                "generate_audio": False,
                "generate_audio_user_set": True,
                "return_last_frame": False,
                "human_review": False,
                "human_review_user_set": True,
            },
            ensure_ascii=False,
        ),
    )

    assert result.status == VideoGenStatus.DONE
    assert client.submitted is not None
    _model, params = client.submitted
    assert params["generate_audio"] is False
    assert params["return_last_frame"] is False
    assert "human_review" not in params


async def test_huimeng_seedance2_generator_presigns_local_media_for_human_review(
    tmp_path,
    monkeypatch,
):
    import json

    from novelvideo import config
    from novelvideo.generators.video_generator import (
        HuimengVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.utils import oss_client

    class FakeBucket:
        def __init__(self) -> None:
            self.existing_keys: set[str] = set()
            self.upload_calls: list[tuple[str, str]] = []

        def object_exists(self, key: str) -> bool:
            return key in self.existing_keys

        def sign_url(self, method: str, key: str, expires: int, slash_safe: bool = True) -> str:
            return f"https://fake-oss/{key}?exp={expires}"

        def put_object_from_file(self, key: str, filename: str) -> None:
            self.upload_calls.append((key, filename))
            self.existing_keys.add(key)

    output_root = tmp_path / "output"
    local_ref = output_root / "admin" / "projA" / "assets" / "ref.png"
    local_ref.parent.mkdir(parents=True)
    local_ref.write_bytes(b"fake-png")
    monkeypatch.setattr(config, "OUTPUT_DIR", str(output_root))
    monkeypatch.setattr(config, "OSS_OBJECT_PREFIX", "output", raising=False)
    oss_client._reset_for_tests()
    monkeypatch.setattr(oss_client, "get_bucket", lambda: FakeBucket())

    client = FakeHuimengClient()
    generator = HuimengVideoGenerator(
        model="seedance-2.0-fast",
        resolution="720p",
        client=client,
    )

    result = await generator.generate(
        image_path=None,
        prompt="参考图片1生成视频。",
        output_path=str(tmp_path / "out.mp4"),
        references=[ShotReference("image", str(local_ref), "角色参考")],
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        seedance2_config=json.dumps(
            {
                "mode": Seedance2I2VMode.MULTIMODAL_REFERENCE.value,
                "final_prompt": "参考图片1生成视频。",
                "human_review": True,
                "human_review_user_set": True,
            },
            ensure_ascii=False,
        ),
    )

    assert result.status == VideoGenStatus.DONE
    assert client.submitted is not None
    _model, params = client.submitted
    assert params["human_review"] is True
    assert params["reference_images"] == [
        "https://fake-oss/output/admin/projA/assets/ref.png?exp=900"
    ]


async def test_huimeng_seedance2_generator_rejects_invalid_reference_numbers(tmp_path):
    from novelvideo.generators.video_generator import (
        HuimengVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )

    client = FakeHuimengClient()
    generator = HuimengVideoGenerator(
        model="seedance-2.0-fast",
        resolution="720p",
        client=client,
    )

    result = await generator.generate(
        image_path=None,
        prompt="参考图片2生成视频。",
        output_path=str(tmp_path / "out.mp4"),
        references=[ShotReference("image", "https://example.com/ref.png", "角色参考")],
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
    )

    assert result.status == VideoGenStatus.FAILED
    assert "图片2" in (result.error or "")
    assert client.submitted is None


async def test_newapi_seedance2_generator_preserves_config_resolution_and_scene_optimize(
    tmp_path, monkeypatch
):
    import json
    from pathlib import Path

    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import NewApiVideoGenerator, VideoGenStatus

    captured: dict[str, object] = {}
    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="seedance-2.0-value",
        resolution="720p",
        generate_audio=True,
    )

    async def fake_reserve(*_args, **_kwargs):
        return "reservation-1"

    async def fake_confirm(*_args, **_kwargs):
        return None

    async def fake_refund(*_args, **_kwargs):
        return None

    async def fake_post_json(url: str, payload: dict):
        captured["url"] = url
        captured["payload"] = payload
        return {"id": "task-1", "_newapi_request_id": "req-1"}

    async def fake_get_json(url: str):
        captured["poll_url"] = url
        return {"status": "completed", "url": "https://example.com/out.mp4"}

    async def fake_download_video(_url: str, output_path: str):
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return b"video"

    monkeypatch.setattr(video_module, "_reserve_video_model_call", fake_reserve)
    monkeypatch.setattr(video_module, "_confirm_video_model_call", fake_confirm)
    monkeypatch.setattr(video_module, "_refund_video_model_call", fake_refund)
    monkeypatch.setattr(generator, "_post_json", fake_post_json)
    monkeypatch.setattr(generator, "_get_json", fake_get_json)
    monkeypatch.setattr(generator, "_download_video", fake_download_video)

    result = await generator.generate(
        image_path="https://example.com/first.png",
        prompt="人物抬头，镜头缓慢推进。",
        output_path=str(tmp_path / "out.mp4"),
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        seedance2_config=json.dumps(
            {
                "duration": 8,
                "resolution": "1080p",
                "ratio": "16:9",
                "scene_optimize": "realistic",
                "generate_audio": True,
                "generate_audio_user_set": True,
                "human_review": False,
                "human_review_user_set": True,
            }
        ),
    )

    assert result.status == VideoGenStatus.DONE
    payload = captured["payload"]
    assert isinstance(payload, dict)
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    assert captured["url"] == "https://newapi.example/video/generations"
    assert captured["poll_url"] == "https://newapi.example/video/generations/task-1"
    assert payload["model"] == "seedance-2.0-value"
    assert payload["duration"] == 8
    assert payload["width"] == 1920
    assert payload["height"] == 1080
    assert payload["image"] == "https://example.com/first.png"
    assert payload["n"] == 1
    assert payload["response_format"] == "url"
    assert metadata["scene_optimize"] == "realistic"
    assert metadata["resolution"] == "1080p"
    assert metadata["ratio"] == "16:9"
    assert "image_url" not in metadata
    assert "seconds" not in payload


async def test_newapi_video_generator_handles_wrapped_failure_status(
    tmp_path, monkeypatch
):
    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import NewApiVideoGenerator, VideoGenStatus

    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="seedance-2.0-fast",
    )
    refunded: dict[str, object] = {}

    async def fake_reserve(*_args, **_kwargs):
        return "reservation-1"

    async def fake_refund(*_args, **kwargs):
        refunded.update(kwargs)

    async def fake_post_json(_url: str, _payload: dict):
        return {"task_id": "task-1"}

    async def fake_get_json(_url: str):
        return {
            "code": "success",
            "data": {
                "task_id": "task-1",
                "status": "FAILURE",
                "fail_reason": "InputImageSensitiveContentDetected.PolicyViolation",
            },
        }

    monkeypatch.setattr(video_module, "_reserve_video_model_call", fake_reserve)
    monkeypatch.setattr(video_module, "_refund_video_model_call", fake_refund)
    monkeypatch.setattr(generator, "_post_json", fake_post_json)
    monkeypatch.setattr(generator, "_get_json", fake_get_json)

    result = await generator.generate(
        image_path=None,
        prompt="测试视频",
        output_path=str(tmp_path / "out.mp4"),
        poll_interval=0,
        max_polls=2,
    )

    assert result.status == VideoGenStatus.FAILED
    assert result.error == "InputImageSensitiveContentDetected.PolicyViolation"
    assert refunded["error"] == "InputImageSensitiveContentDetected.PolicyViolation"


async def test_newapi_seedance1_generator_normalizes_adaptive_ratio_to_auto(
    tmp_path, monkeypatch
):
    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    captured: dict[str, object] = {}
    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="seedance-1.0-pro-fast",
        resolution="720p",
    )

    async def fake_reserve(*_args, **_kwargs):
        return "reservation-1"

    async def fake_refund(*_args, **_kwargs):
        return None

    async def fake_post_json(_url: str, payload: dict):
        captured["payload"] = payload
        return {}

    monkeypatch.setattr(video_module, "_reserve_video_model_call", fake_reserve)
    monkeypatch.setattr(video_module, "_refund_video_model_call", fake_refund)
    monkeypatch.setattr(generator, "_post_json", fake_post_json)

    await generator.generate(
        image_path="https://example.com/first.png",
        prompt="人物缓慢抬头。",
        output_path=str(tmp_path / "out.mp4"),
        aspect_ratio="adaptive",
    )

    payload = captured["payload"]
    assert isinstance(payload, dict)
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    assert payload["image"] == "https://example.com/first.png"
    assert metadata["resolution"] == "720p"
    assert metadata["ratio"] == "auto"
    assert "aspect_ratio" not in metadata
    assert "width" not in payload
    assert "height" not in payload


def test_newapi_video_payload_keeps_public_fields_and_model_semantics():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    metadata = {
        "resolution": "720p",
        "ratio": "16:9",
        "first_frame_image": "https://example.com/first.png",
        "last_frame_image": "https://example.com/last.png",
        "reference_images": [
            f"https://example.com/reference-{index}.png" for index in range(1, 6)
        ],
        "reference_videos": ["https://example.com/reference.mp4"],
        "generate_audio": True,
    }
    payload = {
        "model": "video-model",
        "prompt": "animate the references",
        "seconds": "5",
        "metadata": metadata,
    }

    NewApiVideoGenerator._canonicalize_video_payload(payload, metadata)

    assert payload == {
        "model": "video-model",
        "prompt": "animate the references",
        "image": "https://example.com/first.png",
        "duration": 5,
        "width": 1280,
        "height": 720,
        "n": 1,
        "response_format": "url",
        "metadata": {
            "resolution": "720p",
            "ratio": "16:9",
            "last_frame_image": "https://example.com/last.png",
            "reference_images": [
                f"https://example.com/reference-{index}.png" for index in range(1, 6)
            ],
            "reference_videos": ["https://example.com/reference.mp4"],
            "generate_audio": True,
        },
    }


def test_newapi_image_reference_payload_does_not_promote_reference_to_first_frame():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    metadata = {
        "resolution": "720p",
        "ratio": "16:9",
        "reference_images": ["https://example.com/reference.png"],
    }
    payload = {
        "model": "video-model",
        "prompt": "animate the reference",
        "seconds": "5",
        "metadata": metadata,
    }

    NewApiVideoGenerator._canonicalize_video_payload(payload, metadata)

    assert "image" not in payload
    assert payload["metadata"]["reference_images"] == [
        "https://example.com/reference.png"
    ]


def test_newapi_last_only_payload_keeps_tail_without_top_level_first_frame():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    metadata = {
        "resolution": "720p",
        "ratio": "16:9",
        "last_frame_image": "https://example.com/last.png",
    }
    payload = {
        "model": "video-model",
        "prompt": "finish at the target frame",
        "seconds": "5",
        "metadata": metadata,
    }

    NewApiVideoGenerator._canonicalize_video_payload(payload, metadata)

    assert "image" not in payload
    assert payload["metadata"]["last_frame_image"] == "https://example.com/last.png"


@pytest.mark.parametrize(
    ("resolution", "ratio", "expected"),
    [
        ("480p", "16:9", (854, 480)),
        ("1080P", "9:16", (1080, 1920)),
        ("1080", "16:9", (1920, 1080)),
        ("4k", "16:9", (3840, 2160)),
        ("4K", "9:16", (2160, 3840)),
        ("2k", "1:1", (2560, 2560)),
    ],
)
def test_newapi_video_dimensions_distinguish_p_and_k_tiers(
    resolution: str,
    ratio: str,
    expected: tuple[int, int],
):
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    assert NewApiVideoGenerator._video_dimensions(resolution, ratio) == expected


def test_newapi_video_payload_uses_real_dimensions_and_lowercase_resolution():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    metadata = {"resolution": "4K", "ratio": "16:9"}
    payload = {
        "model": "seedance-2.0",
        "prompt": "海边日落。",
        "seconds": "5",
        "metadata": metadata,
    }

    NewApiVideoGenerator._canonicalize_video_payload(payload, metadata)

    assert payload["width"] == 3840
    assert payload["height"] == 2160
    assert payload["metadata"]["resolution"] == "4k"
    assert payload["metadata"]["ratio"] == "16:9"


def test_newapi_video_payload_preserves_auto_duration_and_ratio():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    metadata = {"resolution": "720P", "ratio": "adaptive"}
    payload = {
        "model": "seedance-2.5",
        "prompt": "自动决定画幅和时长。",
        "seconds": "auto",
        "metadata": metadata,
    }

    NewApiVideoGenerator._canonicalize_video_payload(payload, metadata)

    assert payload["duration"] == "auto"
    assert "width" not in payload
    assert "height" not in payload
    assert payload["metadata"]["ratio"] == "auto"
    assert payload["metadata"]["resolution"] == "720p"


def test_newapi_seedance15_payload_preserves_480p_21_9_semantics():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    metadata = {
        "resolution": "480p",
        "ratio": "21:9",
        "image_url": "https://example.com/1281x720.jpg",
        "generate_audio": True,
    }
    payload = {
        "model": "seedance-1.5-pro",
        "prompt": "人物缓慢转身。",
        "seconds": "5",
        "metadata": metadata,
    }

    NewApiVideoGenerator._canonicalize_video_payload(payload, metadata)

    assert payload["width"] == 1120
    assert payload["height"] == 480
    assert payload["image"] == "https://example.com/1281x720.jpg"
    assert payload["metadata"]["ratio"] == "21:9"
    assert payload["metadata"]["resolution"] == "480p"


def test_newapi_video_task_response_accepts_flat_and_data_wrapped_contracts():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    assert NewApiVideoGenerator._task_id_from_submit_response(
        {"task_id": "task-flat"}
    ) == "task-flat"
    assert NewApiVideoGenerator._task_id_from_submit_response(
        {"data": {"id": "task-wrapped"}}
    ) == "task-wrapped"
    assert NewApiVideoGenerator._task_response_data(
        {
            "data": {
                "task_id": "task-wrapped",
                "status": "succeeded",
                "url": "https://example.com/video.mp4",
            }
        }
    ) == {
        "task_id": "task-wrapped",
        "status": "succeeded",
        "url": "https://example.com/video.mp4",
    }


def test_newapi_video_result_url_prefers_normalized_task_result():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    task = NewApiVideoGenerator._task_response_data(
        {
            "code": "success",
            "data": {
                "task_id": "task-wrapped",
                "status": "SUCCESS",
                "result_url": " https://example.com/normalized.mp4 ",
                "metadata": {"url": "https://example.com/legacy-metadata.mp4"},
                "url": "https://example.com/legacy-top-level.mp4",
            },
        }
    )

    assert (
        NewApiVideoGenerator._extract_video_url(task)
        == "https://example.com/normalized.mp4"
    )


@pytest.mark.parametrize(
    ("task", "expected"),
    [
        (
            {"metadata": {"url": "https://example.com/metadata.mp4"}},
            "https://example.com/metadata.mp4",
        ),
        (
            {"video_url": "https://example.com/top-level.mp4"},
            "https://example.com/top-level.mp4",
        ),
    ],
)
def test_newapi_video_result_url_keeps_legacy_fallbacks(task, expected):
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    assert NewApiVideoGenerator._extract_video_url(task) == expected


def test_newapi_video_resolves_gateway_local_result_url():
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="http://newapi:3000/v1",
        model="h3-t2v",
    )

    assert generator._resolve_result_url(
        "http://localhost:3000/v1/public/videos/task-1/content?expires=1&signature=abc"
    ) == (
        "http://newapi:3000/v1/public/videos/task-1/content?expires=1&signature=abc"
    )


async def test_newapi_happyhorse_video_generator_uses_happyhorse_payload(tmp_path, monkeypatch):
    from pathlib import Path

    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )

    captured: dict[str, object] = {}
    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="happyhorse-1.0",
        resolution="1080p",
        generate_audio=True,
    )

    async def fake_reserve(*_args, **_kwargs):
        return "reservation-1"

    async def fake_confirm(*_args, **_kwargs):
        return None

    async def fake_refund(*_args, **_kwargs):
        return None

    async def fake_post_json(url: str, payload: dict):
        captured["url"] = url
        captured["payload"] = payload
        return {"id": "task-1", "_newapi_request_id": "req-1"}

    async def fake_get_json(_url: str):
        return {"status": "completed", "url": "https://example.com/out.mp4"}

    async def fake_download_video(_url: str, output_path: str):
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return b"video"

    monkeypatch.setattr(video_module, "_reserve_video_model_call", fake_reserve)
    monkeypatch.setattr(video_module, "_confirm_video_model_call", fake_confirm)
    monkeypatch.setattr(video_module, "_refund_video_model_call", fake_refund)
    monkeypatch.setattr(generator, "_post_json", fake_post_json)
    monkeypatch.setattr(generator, "_get_json", fake_get_json)
    monkeypatch.setattr(generator, "_download_video", fake_download_video)

    result = await generator.generate(
        image_path="https://example.com/first.png",
        prompt="一只猫在海滩上漫步",
        output_path=str(tmp_path / "out.mp4"),
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        audio_setting="origin",
        references=[
            ShotReference("image", "https://example.com/ref.png", "角色参考"),
            ShotReference("video", "https://example.com/input.mp4", "视频参考"),
        ],
    )

    assert result.status == VideoGenStatus.DONE
    payload = captured["payload"]
    assert isinstance(payload, dict)
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    assert payload["model"] == "happyhorse-1.0"
    assert payload["duration"] == 6
    assert "seconds" not in payload
    # 参考优先：一旦带了参考图/参考视频，首帧(image_url/i2v)与 reference_images/video_url
    # 互斥（同时下发会触发上游 INVALID_PARAMS）。首帧降级为 reference_images 首位，
    # 不再单独发 images/image_url；画幅由输入媒体决定，故 ratio 也被移除。
    assert "images" not in payload
    assert "image" not in payload
    assert "image_url" not in metadata
    assert "aspect_ratio" not in metadata
    assert metadata["resolution"] == "1080p"
    assert metadata["reference_videos"] == ["https://example.com/input.mp4"]
    assert metadata["audio_setting"] == "origin"
    assert metadata["reference_images"] == [
        "https://example.com/first.png",
        "https://example.com/ref.png",
    ]
    assert metadata["watermark"] is False
    assert "generate_audio" not in metadata


async def test_newapi_happyhorse_11_uses_canonical_catalog_driven_protocol(
    tmp_path, monkeypatch
):
    from pathlib import Path

    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )

    captured: dict[str, object] = {}
    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="happyhorse-1.1",
        resolution="720p",
        generate_audio=False,
    )

    async def fake_reserve(*_args, **_kwargs):
        return "reservation-1"

    async def fake_confirm(*_args, **_kwargs):
        return None

    async def fake_refund(*_args, **_kwargs):
        return None

    async def fake_post_json(url: str, payload: dict):
        captured["url"] = url
        captured["payload"] = payload
        return {"id": "task-1", "_newapi_request_id": "req-1"}

    async def fake_get_json(_url: str):
        return {"status": "completed", "url": "https://example.com/out.mp4"}

    async def fake_download_video(_url: str, output_path: str):
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return b"video"

    monkeypatch.setattr(video_module, "_reserve_video_model_call", fake_reserve)
    monkeypatch.setattr(video_module, "_confirm_video_model_call", fake_confirm)
    monkeypatch.setattr(video_module, "_refund_video_model_call", fake_refund)
    monkeypatch.setattr(generator, "_post_json", fake_post_json)
    monkeypatch.setattr(generator, "_get_json", fake_get_json)
    monkeypatch.setattr(generator, "_download_video", fake_download_video)

    prompt = "镜头环绕" * 1300
    result = await generator.generate(
        image_path="",
        prompt=prompt,
        output_path=str(tmp_path / "happyhorse-11.mp4"),
        duration=5,
        aspect_ratio="21:9",
        poll_interval=0,
        max_polls=1,
        gen_mode="image_reference",
        references=[
            ShotReference("image", "https://example.com/a.png", "图片参考"),
            ShotReference("image", "https://example.com/b.png", "图片参考"),
        ],
    )

    assert result.status == VideoGenStatus.DONE
    assert not generator._is_happyhorse_model()

    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["model"] == "happyhorse-1.1"
    assert payload["prompt"] == prompt
    assert payload["duration"] == 5
    assert payload["width"] == 1680
    assert payload["height"] == 720
    assert payload["metadata"] == {
        "resolution": "720p",
        "ratio": "21:9",
        "watermark": False,
        "generate_audio": False,
        "reference_images": [
            "https://example.com/a.png",
            "https://example.com/b.png",
        ],
        "return_last_frame": False,
    }


async def test_newapi_grok_video_channel_uses_relayclaw_video_payload(tmp_path, monkeypatch):
    from pathlib import Path

    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        ShotReference,
        VideoGenStatus,
    )

    captured: dict[str, object] = {}
    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="grok-video-channel",
        resolution="720p",
        generate_audio=False,
    )

    async def fake_reserve(*_args, **_kwargs):
        return "reservation-1"

    async def fake_confirm(*_args, **_kwargs):
        return None

    async def fake_refund(*_args, **_kwargs):
        return None

    async def fake_post_json(url: str, payload: dict):
        captured["url"] = url
        captured["payload"] = payload
        return {"id": "task-1", "_newapi_request_id": "req-1"}

    async def fake_get_json(_url: str):
        return {"status": "completed", "url": "https://example.com/out.mp4"}

    async def fake_download_video(_url: str, output_path: str):
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"video")
        return b"video"

    monkeypatch.setattr(video_module, "_reserve_video_model_call", fake_reserve)
    monkeypatch.setattr(video_module, "_confirm_video_model_call", fake_confirm)
    monkeypatch.setattr(video_module, "_refund_video_model_call", fake_refund)
    monkeypatch.setattr(generator, "_post_json", fake_post_json)
    monkeypatch.setattr(generator, "_get_json", fake_get_json)
    monkeypatch.setattr(generator, "_download_video", fake_download_video)

    result = await generator.generate(
        image_path="https://example.com/first.png",
        prompt="一只猫在海滩上漫步",
        output_path=str(tmp_path / "out.mp4"),
        duration=6,
        aspect_ratio="9:16",
        poll_interval=0,
        max_polls=1,
        references=[
            ShotReference("image", "https://example.com/ref.png", "角色参考"),
            ShotReference("video", "https://example.com/input.mp4", "视频参考"),
        ],
    )

    assert result.status == VideoGenStatus.DONE
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["model"] == "grok-video-channel"
    assert payload["prompt"] == "一只猫在海滩上漫步"
    assert payload["duration"] == 6
    assert "seconds" not in payload
    assert payload["image"] == "https://example.com/first.png"
    assert payload["width"] == 720
    assert payload["height"] == 1280
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["reference_images"] == ["https://example.com/ref.png"]
    assert metadata["resolution"] == "720p"
    assert metadata["ratio"] == "9:16"
    assert "image_url" not in metadata
    assert "video_url" not in metadata
    assert "generate_audio" not in metadata
    assert "watermark" not in metadata


async def test_newapi_catalog_model_builds_huimeng_protocol_multimedia_references():
    from novelvideo.generators.video_generator import NewApiVideoGenerator, ShotReference

    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="kling-v3-omni",
    )
    metadata: dict[str, object] = {}

    await generator._apply_huimeng_protocol_media_inputs(
        metadata,
        mode="all_reference",
        image_path="",
        last_frame_path=None,
        references=[
            ShotReference("image", "https://example.com/ref.png", "角色参考"),
            ShotReference("video", "https://example.com/input.mp4", "视频编辑源"),
            ShotReference("audio", "https://example.com/input.mp3", "音频参考"),
        ],
        log=lambda _message: None,
    )

    assert metadata["reference_images"] == ["https://example.com/ref.png"]
    assert metadata["reference_videos"] == ["https://example.com/input.mp4"]
    assert metadata["reference_audios"] == ["https://example.com/input.mp3"]
    assert set(metadata) == {
        "reference_images",
        "reference_videos",
        "reference_audios",
    }


async def test_newapi_video_edit_keeps_independent_audio_reference():
    from novelvideo.generators.video_generator import NewApiVideoGenerator, ShotReference

    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="happyhorse-1.0",
    )
    metadata: dict[str, object] = {}

    await generator._apply_huimeng_protocol_media_inputs(
        metadata,
        mode="video_edit",
        image_path="",
        last_frame_path=None,
        references=[
            ShotReference("video", "https://example.com/source.mp4", "视频编辑源"),
            ShotReference("audio", "https://example.com/music.mp3", "配乐参考"),
        ],
        log=lambda _message: None,
    )

    assert metadata == {
        "reference_videos": ["https://example.com/source.mp4"],
        "reference_audios": ["https://example.com/music.mp3"],
    }


async def test_newapi_image_to_video_uses_single_reference_image_not_first_frame():
    from novelvideo.generators.video_generator import NewApiVideoGenerator, ShotReference

    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="seedance-2-0-mini",
    )
    metadata: dict[str, object] = {}

    await generator._apply_huimeng_protocol_media_inputs(
        metadata,
        mode="imageToVideo",
        image_path="https://example.com/ref.png",
        last_frame_path=None,
        references=[ShotReference("image", "https://example.com/ref.png", "图片参考")],
        log=lambda _message: None,
    )

    assert metadata == {"reference_images": ["https://example.com/ref.png"]}


@pytest.mark.parametrize(
    ("first_frame", "last_frame", "expected"),
    [
        (
            "https://example.com/first.png",
            None,
            {"first_frame_image": "https://example.com/first.png"},
        ),
        (
            None,
            "https://example.com/last.png",
            {"last_frame_image": "https://example.com/last.png"},
        ),
    ],
)
async def test_newapi_keyframe_protocol_accepts_single_first_or_last_frame(
    first_frame, last_frame, expected
):
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="seedance-2-0-mini",
    )
    metadata: dict[str, object] = {}

    await generator._apply_huimeng_protocol_media_inputs(
        metadata,
        mode="first_last_frame",
        image_path=first_frame or "",
        last_frame_path=last_frame,
        references=[],
        log=lambda _message: None,
    )

    assert metadata == expected


@pytest.mark.parametrize("model", ["seedance-2-0-mini", "kling-v3-omni"])
async def test_newapi_catalog_models_use_same_first_last_frame_protocol(model):
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model=model,
    )
    metadata: dict[str, object] = {}

    await generator._apply_huimeng_protocol_media_inputs(
        metadata,
        mode="first_last_frame",
        image_path="https://example.com/first.png",
        last_frame_path="https://example.com/last.png",
        references=[],
        log=lambda _message: None,
    )

    assert metadata == {
        "first_frame_image": "https://example.com/first.png",
        "last_frame_image": "https://example.com/last.png",
    }


async def test_newapi_video_relay_frame_input_normalizes_local_image_refs(
    tmp_path, monkeypatch
):
    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    frame_path = tmp_path / "frame.png"
    frame_path.write_bytes(b"fake-png")
    captured: dict[str, object] = {}

    def fake_upload_media_bytes(
        data,
        *,
        ext="png",
        ttl=None,
        resource_type="image",
        image_transform=None,
    ):
        captured.update(
            {
                "data": data,
                "ext": ext,
                "ttl": ttl,
                "resource_type": resource_type,
                "image_transform": image_transform,
            }
        )
        return f"https://relay.example/frame.{ext}"

    monkeypatch.setattr(video_module, "upload_media_bytes", fake_upload_media_bytes)

    result = await NewApiVideoGenerator._relay_frame_input(str(frame_path))

    assert result == "https://relay.example/frame.png"
    assert captured["data"] == b"fake-png"
    assert captured["ext"] == "png"
    assert captured["resource_type"] == "image"
    assert captured["image_transform"] == video_module.IMAGE_TRANSFORM_AI_REFERENCE_JPEG


async def test_newapi_video_seedance2_references_normalize_only_image_refs(
    tmp_path, monkeypatch
):
    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import NewApiVideoGenerator, ShotReference

    image_path = tmp_path / "ref.png"
    video_path = tmp_path / "ref.mp4"
    audio_path = tmp_path / "ref.mp3"
    image_path.write_bytes(b"fake-png")
    video_path.write_bytes(b"fake-mp4")
    audio_path.write_bytes(b"fake-mp3")
    captured: list[dict[str, object]] = []

    def fake_upload_media_bytes(
        data,
        *,
        ext="png",
        ttl=None,
        resource_type="image",
        image_transform=None,
    ):
        captured.append(
            {
                "data": data,
                "ext": ext,
                "ttl": ttl,
                "resource_type": resource_type,
                "image_transform": image_transform,
            }
        )
        return f"https://relay.example/{len(captured)}.{ext}"

    monkeypatch.setattr(video_module, "upload_media_bytes", fake_upload_media_bytes)
    generator = NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://newapi.example",
        model="seedance-2.0-value",
    )

    params = await generator._relay_seedance2_references(
        [
            ShotReference("image", str(image_path), "图片参考"),
            ShotReference("video", str(video_path), "视频参考"),
            ShotReference("audio", str(audio_path), "音频参考"),
        ],
        log=lambda _message: None,
    )

    assert params == {
        "reference_images": ["https://relay.example/1.png"],
        "reference_videos": ["https://relay.example/2.mp4"],
        "reference_audios": ["https://relay.example/3.mp3"],
    }
    assert captured[0]["image_transform"] == video_module.IMAGE_TRANSFORM_AI_REFERENCE_JPEG
    assert [item["resource_type"] for item in captured] == ["image", "video", "video"]
    assert captured[1]["image_transform"] is None
    assert captured[2]["image_transform"] is None
    assert all(
        item["ttl"] == video_module.NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS
        for item in captured
    )
