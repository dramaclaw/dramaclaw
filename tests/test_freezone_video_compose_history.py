from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from novelvideo.api.schemas import FreezoneVideoComposeRequest
from novelvideo.freezone import canvas_store
from novelvideo.freezone.history import read_generation_history
from novelvideo.freezone.jobs import run_freezone_video_compose
from novelvideo.task_backend.runners import freezone as freezone_runner
from novelvideo.task_identity import project_task_state_key


def _stub_video_compose_runner(
    monkeypatch: pytest.MonkeyPatch,
    output: Path,
) -> None:
    async def fake_compose(**_kwargs):
        return output

    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_video_compose", fake_compose
    )
    monkeypatch.setattr(freezone_runner, "_update", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, relative: f"/static/project/{relative}",
    )


def test_video_compose_request_accepts_cover_url_and_speed() -> None:
    body = FreezoneVideoComposeRequest.model_validate(
        {
            "coverUrl": "/static/project/freezone/covers/cover.png",
            "tracks": [
                {
                    "track_id": "video",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-a",
                            "source_url": "/static/project/source.mp4",
                            "source_start": 0,
                            "source_end": 4,
                            "speed": 1.5,
                        }
                    ],
                }
            ],
        }
    )

    assert body.cover_url == "/static/project/freezone/covers/cover.png"
    assert body.tracks[0].items[0].speed == 1.5


@pytest.mark.asyncio
async def test_video_compose_runner_records_node_generation_history(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    output = tmp_path / "freezone" / "_outputs" / "freezone_video_compose" / "job-a.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"video")

    _stub_video_compose_runner(monkeypatch, output)
    ctx = SimpleNamespace(project_id="project-a", output_dir=str(tmp_path))
    envelope = {
        "payload": {
            "job_id": "job-a",
            "project_dir": str(tmp_path),
            "canvas_id": "canvas-a",
            "node_id": "compose-a",
            "cover_url": "/static/project/freezone/covers/cover.png",
            "tracks": [],
        }
    }

    result = await freezone_runner._run_freezone_video_compose_async(envelope, ctx)

    assert result["output_url"].endswith("job-a.mp4")
    assert result["cover_url"] == "/static/project/freezone/covers/cover.png"
    records = read_generation_history(
        project_dir=tmp_path,
        canvas_id="canvas-a",
        node_id="compose-a",
    )
    assert len(records) == 1
    assert records[0]["task_type"] == "freezone_video_compose"
    assert records[0]["media_type"] == "video"
    assert records[0]["result"]["output_url"].endswith("job-a.mp4")
    assert (
        records[0]["result"]["cover_url"] == "/static/project/freezone/covers/cover.png"
    )


@pytest.mark.asyncio
async def test_video_compose_runner_projects_result_to_canvas_idempotently(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "output"
    state_dir = tmp_path / "state"
    output = (
        output_dir / "freezone" / "_outputs" / "freezone_video_compose" / "job-a.mp4"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"video")
    task_key = project_task_state_key(
        "freezone_video_compose", "project-a", 0, scope="job-a"
    )
    canvas_store.atomic_write_json(
        canvas_store.canvas_path(state_dir, "canvas-a"),
        {
            "schema_version": 2,
            "canvas_id": "canvas-a",
            "project_id": "project-a",
            "revision": 7,
            "nodes": [
                {
                    "id": "compose-a",
                    "type": "videoComposeNode",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "isGenerating": True,
                        "generationStartedAt": 123,
                        "generationTaskKey": task_key,
                        "generationTaskType": "freezone_video_compose",
                        "generationTaskJobId": "job-a",
                        "generationError": "old error",
                    },
                }
            ],
            "edges": [],
        },
    )

    _stub_video_compose_runner(monkeypatch, output)
    ctx = SimpleNamespace(
        project_id="project-a",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
        requester_user_id="user-a",
    )
    envelope = {
        "payload": {
            "job_id": "job-a",
            "project_dir": str(output_dir),
            "canvas_id": "canvas-a",
            "node_id": "compose-a",
            "cover_url": "/static/project/freezone/covers/cover.png",
            "tracks": [],
        }
    }

    await freezone_runner._run_freezone_video_compose_async(envelope, ctx)
    projected = canvas_store.read_canvas(state_dir, "canvas-a")
    assert projected is not None
    assert projected["revision"] == 8
    node_data = projected["nodes"][0]["data"]
    assert node_data["resultVideoUrl"].endswith("job-a.mp4")
    assert node_data["previewImageUrl"] == "/static/project/freezone/covers/cover.png"
    assert node_data["resultVideoTaskKey"] == task_key
    assert node_data["resultVideoJobId"] == "job-a"
    assert node_data["isGenerating"] is False
    assert node_data["generationStartedAt"] is None
    assert node_data["generationTaskKey"] is None
    assert node_data["generationTaskType"] is None
    assert node_data["generationTaskJobId"] is None
    assert node_data["generationError"] is None

    await freezone_runner._run_freezone_video_compose_async(envelope, ctx)
    replayed = canvas_store.read_canvas(state_dir, "canvas-a")
    assert replayed is not None
    assert replayed["revision"] == 8


@pytest.mark.asyncio
async def test_video_compose_runner_does_not_overwrite_a_newer_generation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "output"
    state_dir = tmp_path / "state"
    output = (
        output_dir / "freezone" / "_outputs" / "freezone_video_compose" / "old-job.mp4"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"video")
    newer_task_key = project_task_state_key(
        "freezone_video_compose", "project-a", 0, scope="new-job"
    )
    canvas_store.atomic_write_json(
        canvas_store.canvas_path(state_dir, "canvas-a"),
        {
            "schema_version": 2,
            "canvas_id": "canvas-a",
            "project_id": "project-a",
            "revision": 3,
            "nodes": [
                {
                    "id": "compose-a",
                    "type": "videoComposeNode",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "isGenerating": True,
                        "generationTaskKey": newer_task_key,
                        "generationTaskType": "freezone_video_compose",
                        "generationTaskJobId": "new-job",
                        "resultVideoUrl": "/static/project/previous.mp4",
                    },
                }
            ],
            "edges": [],
        },
    )

    _stub_video_compose_runner(monkeypatch, output)
    ctx = SimpleNamespace(
        project_id="project-a",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
        requester_user_id="user-a",
    )

    await freezone_runner._run_freezone_video_compose_async(
        {
            "payload": {
                "job_id": "old-job",
                "project_dir": str(output_dir),
                "canvas_id": "canvas-a",
                "node_id": "compose-a",
                "tracks": [],
            }
        },
        ctx,
    )

    canvas = canvas_store.read_canvas(state_dir, "canvas-a")
    assert canvas is not None
    assert canvas["revision"] == 3
    assert canvas["nodes"][0]["data"]["generationTaskJobId"] == "new-job"
    assert (
        canvas["nodes"][0]["data"]["resultVideoUrl"] == "/static/project/previous.mp4"
    )


@pytest.mark.asyncio
async def test_video_compose_overlap_uses_speed_adjusted_duration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    calls: list[tuple[str, dict[str, Any]]] = []

    async def fake_render_video_clip(**kwargs: Any) -> None:
        calls.append(("video", kwargs))
        Path(kwargs["output_path"]).write_bytes(b"clip")

    async def fake_render_gap_clip(**kwargs: Any) -> None:
        calls.append(("gap", kwargs))
        Path(kwargs["output_path"]).write_bytes(b"gap")

    async def fake_concat_media_segments(_segment_paths: list[Path], output_path: Path) -> None:
        output_path.write_bytes(b"concat")

    async def fake_mix_audio_tracks(**kwargs: Any) -> None:
        Path(kwargs["final_output_path"]).write_bytes(b"final")

    monkeypatch.setattr("shutil.which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(
        "novelvideo.freezone.jobs._render_video_clip",
        fake_render_video_clip,
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs._render_gap_clip",
        fake_render_gap_clip,
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs._concat_media_segments",
        fake_concat_media_segments,
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs._mix_audio_tracks",
        fake_mix_audio_tracks,
    )

    output = await run_freezone_video_compose(
        project_dir=tmp_path,
        job_id="job-speed",
        tracks=[
            {
                "kind": "video",
                "items": [
                    {
                        "item_id": "clip-fast",
                        "source_path": str(source),
                        "timeline_start": 0,
                        "source_start": 0,
                        "source_end": 4,
                        "speed": 2,
                    },
                    {
                        "item_id": "clip-next",
                        "source_path": str(source),
                        "timeline_start": 2,
                        "source_start": 0,
                        "source_end": 1,
                        "speed": 1,
                    },
                ],
            }
        ],
    )

    assert output.exists()
    assert [kind for kind, _kwargs in calls] == ["video", "video"]
    assert calls[0][1]["duration"] == 4
    assert calls[0][1]["speed"] == 2


@pytest.mark.asyncio
async def test_video_compose_runner_renders_a_hand_cut_film_through_studio(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A payload that names a Studio film takes the Studio leaf; the ffmpeg leaf never runs."""
    output_dir = tmp_path / "output"
    state_dir = tmp_path / "state"
    output = output_dir / "freezone" / "_outputs" / "freezone_video_compose" / "job-s.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    film_dir = output_dir / "freezone" / "studio" / "canvas-a" / "compose-a"
    task_key = project_task_state_key("freezone_video_compose", "project-a", 0, scope="job-s")
    canvas_store.atomic_write_json(
        canvas_store.canvas_path(state_dir, "canvas-a"),
        {
            "schema_version": 2,
            "canvas_id": "canvas-a",
            "project_id": "project-a",
            "revision": 1,
            "nodes": [
                {
                    "id": "compose-a",
                    "type": "videoComposeNode",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "isGenerating": True,
                        "generationTaskKey": task_key,
                        "generationTaskType": "freezone_video_compose",
                        "generationTaskJobId": "job-s",
                    },
                }
            ],
            "edges": [],
        },
    )
    seen: dict[str, Any] = {}

    async def fake_studio_export(**kwargs):
        seen.update(kwargs)
        output.write_bytes(b"studio render")
        return output

    async def never_ffmpeg(**_kwargs):
        raise AssertionError("the timeline path must not run for a hand-cut film")

    monkeypatch.setattr("novelvideo.freezone.jobs.run_freezone_studio_export", fake_studio_export)
    monkeypatch.setattr("novelvideo.freezone.jobs.run_freezone_video_compose", never_ffmpeg)
    monkeypatch.setattr(freezone_runner, "_update", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, relative: f"/static/project/{relative}",
    )
    ctx = SimpleNamespace(
        project_id="project-a",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
        requester_user_id="user-a",
    )
    envelope = {
        "payload": {
            "job_id": "job-s",
            "project_dir": str(output_dir),
            "canvas_id": "canvas-a",
            "node_id": "compose-a",
            "fps": 24,
            "tracks": [],
            "studio_film_dir": str(film_dir),
        }
    }

    result = await freezone_runner._run_freezone_video_compose_async(envelope, ctx)

    assert seen["film_dir"] == str(film_dir) and seen["fps"] == 24
    assert result["output_url"].endswith("job-s.mp4")
    projected = canvas_store.read_canvas(state_dir, "canvas-a")
    assert projected["nodes"][0]["data"]["resultVideoUrl"].endswith("job-s.mp4")
    assert projected["nodes"][0]["data"]["isGenerating"] is False
