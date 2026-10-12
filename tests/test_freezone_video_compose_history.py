from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from novelvideo.api.schemas import FreezoneVideoComposeRequest
from novelvideo.freezone.history import read_generation_history
from novelvideo.freezone.jobs import run_freezone_video_compose
from novelvideo.task_backend.runners import freezone as freezone_runner


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

    async def fake_compose(**_kwargs):
        return output

    monkeypatch.setattr("novelvideo.freezone.jobs.run_freezone_video_compose", fake_compose)
    monkeypatch.setattr(freezone_runner, "_update", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, relative: f"/static/project/{relative}",
    )
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
    assert records[0]["result"]["cover_url"] == "/static/project/freezone/covers/cover.png"


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
