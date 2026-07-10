from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.project_context import ProjectContext


pytestmark = pytest.mark.m09


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="alice",
        requester_user_id="user_editor",
        requester_username="bob",
        requester_principals=(("user", "user_editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=True,
    )


@pytest.mark.asyncio
async def test_single_video_runner_includes_returned_last_frame_in_task_result(
    tmp_path,
    monkeypatch,
):
    from novelvideo.generators.video_generator import VideoGenStatus
    from novelvideo.task_backend.runners import video as video_runner

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            video_path = Path(kwargs["output_path"])
            video_path.parent.mkdir(parents=True, exist_ok=True)
            video_path.write_bytes(b"video")
            last_frame_path = video_path.parent / "returned_last_frames" / "beat_01.png"
            last_frame_path.parent.mkdir(parents=True, exist_ok=True)
            last_frame_path.write_bytes(b"image")
            return SimpleNamespace(
                status=VideoGenStatus.DONE,
                error=None,
                provider_task_id="provider-task-1",
                last_frame_path=last_frame_path.as_posix(),
                last_frame_url="https://example.com/last-frame.png",
            )

    monkeypatch.setattr(video_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        lambda backend: FakeVideoGenerator(),
    )
    monkeypatch.setattr(
        "novelvideo.generators.video_pool_indexer.add_video_to_pool",
        lambda **_kwargs: SimpleNamespace(id="pool-1"),
    )

    result = await video_runner._run_single_video_async(
        {
            "task_type": "single_video",
            "episode": 1,
            "beat_num": 1,
            "payload": {
                "config": {
                    "frame_path": "",
                    "prompt": "test",
                    "video_backend": "mock",
                }
            },
        },
        _ctx(tmp_path),
    )

    assert result["provider_task_id"] == "provider-task-1"
    assert result["last_frame_path"].endswith(
        "videos/beats/ep001/returned_last_frames/beat_01.png"
    )
    assert result["last_frame_url"] == "https://example.com/last-frame.png"


@pytest.mark.asyncio
async def test_single_video_runner_preserves_seedance2_config_resolution(
    tmp_path,
    monkeypatch,
):
    from novelvideo.generators.video_generator import VideoGenStatus
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.task_backend.runners import video as video_runner

    prepare_calls = []
    generate_calls = []

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            generate_calls.append(kwargs)
            video_path = Path(kwargs["output_path"])
            video_path.parent.mkdir(parents=True, exist_ok=True)
            video_path.write_bytes(b"video")
            return SimpleNamespace(
                status=VideoGenStatus.DONE,
                error=None,
                provider_task_id="provider-task-1",
                last_frame_path="",
                last_frame_url="",
            )

    async def fake_prepare(**kwargs):
        prepare_calls.append(kwargs)
        seedance2_config_json = kwargs["beat"]["seedance2_config_json"]
        return SimpleNamespace(
            prompt="configured prompt",
            seedance2_config_json=seedance2_config_json,
            duration=6,
            mode=Seedance2I2VMode.FIRST_FRAME,
            image_path="https://example.com/first.png",
            last_frame_path=None,
            references=[],
        )

    monkeypatch.setattr(video_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        lambda backend: FakeVideoGenerator(),
    )
    monkeypatch.setattr(
        "novelvideo.seedance2_i2v.pipeline.prepare_seedance2_generation_inputs",
        fake_prepare,
    )
    monkeypatch.setattr(
        "novelvideo.generators.video_pool_indexer.add_video_to_pool",
        lambda **_kwargs: SimpleNamespace(id="pool-1"),
    )

    result = await video_runner._run_single_video_async(
        {
            "task_type": "single_video",
            "episode": 1,
            "beat_num": 1,
            "payload": {
                "config": {
                    "beat": {
                        "beat_number": 1,
                        "seedance2_config_json": (
                            '{"final_prompt":"configured prompt",'
                            '"duration":8,"resolution":"1080p","ratio":"16:9"}'
                        ),
                    },
                    "frame_path": "https://example.com/first.png",
                    "prompt": "configured prompt",
                    "video_backend": "newapi_seedance-2.0",
                    "video_duration": 6,
                }
            },
        },
        _ctx(tmp_path),
    )

    assert result["provider_task_id"] == "provider-task-1"
    assert prepare_calls[0]["resolution"] is None
    assert '"duration":8' in generate_calls[0]["seedance2_config"]
    assert '"resolution":"1080p"' in generate_calls[0]["seedance2_config"]
    assert '"ratio":"16:9"' in generate_calls[0]["seedance2_config"]


@pytest.mark.asyncio
async def test_single_video_runner_passes_happyhorse_references_and_audio_setting(
    tmp_path,
    monkeypatch,
):
    from novelvideo.generators.video_generator import ShotReference, VideoGenStatus
    from novelvideo.task_backend.runners import video as video_runner

    generate_calls = []

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    class FakeVideoGenerator:
        async def generate(self, **kwargs):
            generate_calls.append(kwargs)
            video_path = Path(kwargs["output_path"])
            video_path.parent.mkdir(parents=True, exist_ok=True)
            video_path.write_bytes(b"video")
            return SimpleNamespace(
                status=VideoGenStatus.DONE,
                error=None,
                provider_task_id="provider-task-1",
                last_frame_path="",
                last_frame_url="",
            )

    monkeypatch.setattr(video_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        lambda backend, **_kwargs: FakeVideoGenerator(),
    )
    monkeypatch.setattr(
        "novelvideo.generators.video_pool_indexer.add_video_to_pool",
        lambda **_kwargs: SimpleNamespace(id="pool-1"),
    )

    result = await video_runner._run_single_video_async(
        {
            "task_type": "single_video",
            "episode": 1,
            "beat_num": 1,
            "payload": {
                "config": {
                    "beat": {"beat_number": 1},
                    "frame_path": None,
                    "prompt": "happyhorse prompt",
                    "video_backend": "newapi_happyhorse-1.0",
                    "video_duration": 7,
                    "ratio": "1:1",
                    "audio_setting": "origin",
                    "references": [
                        {
                            "type": "image",
                            "path": "https://example.com/ref.png",
                            "role": "图片1",
                        }
                    ],
                }
            },
        },
        _ctx(tmp_path),
    )

    assert result["provider_task_id"] == "provider-task-1"
    assert generate_calls[0]["image_path"] is None
    assert generate_calls[0]["aspect_ratio"] == "1:1"
    assert generate_calls[0]["audio_setting"] == "origin"
    assert generate_calls[0]["references"] == [
        ShotReference("image", "https://example.com/ref.png", "图片1")
    ]
