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
    assert result.last_frame_path == str(expected_path)
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
    assert result.last_frame_path == str(expected_path)
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
    assert payload["model"] == "seedance-2.0-value"
    assert metadata["resolution"] == "1080p"
    assert metadata["ratio"] == "16:9"
    assert metadata["scene_optimize"] == "realistic"
    assert metadata["image_url"] == "https://example.com/first.png"
    assert payload["seconds"] == "8"


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
    assert payload["seconds"] == "6"
    assert payload["images"] == ["https://example.com/first.png"]
    assert metadata["ratio"] == "9:16"
    assert metadata["resolution"] == "1080P"
    assert metadata["image_url"] == "https://example.com/first.png"
    assert metadata["video_url"] == "https://example.com/input.mp4"
    assert metadata["audio_setting"] == "origin"
    assert metadata["reference_images"] == ["https://example.com/ref.png"]
    assert metadata["watermark"] is False
    assert "generate_audio" not in metadata


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
    assert payload["seconds"] == "6"
    assert payload["images"] == ["https://example.com/first.png"]
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["resolution"] == "720p"
    assert metadata["ratio"] == "9:16"
    assert metadata["image_url"] == "https://example.com/first.png"
    assert metadata["reference_images"] == ["https://example.com/ref.png"]
    assert "video_url" not in metadata
    assert "generate_audio" not in metadata
    assert "watermark" not in metadata


async def test_newapi_video_relay_frame_input_normalizes_local_image_refs(
    tmp_path, monkeypatch
):
    from novelvideo.generators import video_generator as video_module
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    frame_path = tmp_path / "frame.png"
    frame_path.write_bytes(b"fake-png")
    captured: dict[str, object] = {}

    def fake_upload_image_bytes(data, *, ext="png", ttl=None, image_transform=None):
        captured.update(
            {
                "data": data,
                "ext": ext,
                "ttl": ttl,
                "image_transform": image_transform,
            }
        )
        return f"https://relay.example/frame.{ext}"

    monkeypatch.setattr(video_module, "upload_image_bytes", fake_upload_image_bytes)

    result = await NewApiVideoGenerator._relay_frame_input(str(frame_path))

    assert result == "https://relay.example/frame.png"
    assert captured["data"] == b"fake-png"
    assert captured["ext"] == "png"
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

    def fake_upload_image_bytes(data, *, ext="png", ttl=None, image_transform=None):
        captured.append(
            {
                "data": data,
                "ext": ext,
                "ttl": ttl,
                "image_transform": image_transform,
            }
        )
        return f"https://relay.example/{len(captured)}.{ext}"

    monkeypatch.setattr(video_module, "upload_image_bytes", fake_upload_image_bytes)
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
    assert captured[1]["image_transform"] is None
    assert captured[2]["image_transform"] is None
