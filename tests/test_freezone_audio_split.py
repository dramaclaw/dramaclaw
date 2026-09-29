"""音频智能切分的算法与只读 API 合同。"""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.freezone.audio_split import (
    AudioSplitPreview,
    AudioSplitSegment,
    build_audio_split_preview,
    parse_silence_intervals,
)


def test_parse_silence_intervals_closes_trailing_silence() -> None:
    stderr = """
[silencedetect] silence_start: 1.2
[silencedetect] silence_end: 2.0 | silence_duration: 0.8
[silencedetect] silence_start: 8.5
"""

    assert parse_silence_intervals(stderr, 10.0) == [(1.2, 2.0), (8.5, 10.0)]


def test_build_preview_cuts_at_silence_midpoints_and_covers_duration() -> None:
    preview = build_audio_split_preview(
        duration_sec=12.0,
        silence_intervals=[(2.0, 4.0), (7.0, 9.0)],
        min_segment_sec=0.5,
    )

    assert preview.segments == (
        AudioSplitSegment(0.0, 3.0),
        AudioSplitSegment(3.0, 8.0),
        AudioSplitSegment(8.0, 12.0),
    )
    assert preview.detected_silence_count == 2
    assert preview.limited is False


def test_build_preview_filters_tiny_edge_segments_and_limits_fanout() -> None:
    preview = build_audio_split_preview(
        duration_sec=30.0,
        silence_intervals=[(index - 0.1, index + 0.1) for index in range(1, 30)],
        min_segment_sec=1.5,
        max_segments=4,
    )

    assert len(preview.segments) == 4
    assert preview.segments[0].start_sec == 0.0
    assert preview.segments[-1].end_sec == 30.0
    assert preview.limited is True


@pytest.mark.asyncio
@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="ffmpeg and ffprobe are required",
)
async def test_real_ffmpeg_detects_silence_without_writing_split_outputs(
    tmp_path: Path,
) -> None:
    from novelvideo.freezone.audio_split import analyze_audio_split

    source = tmp_path / "tone-silence-tone.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=if(between(t\\,1\\,2)\\,0\\,sin(2*PI*440*t)):s=48000:d=3",
            str(source),
        ],
        check=True,
        capture_output=True,
    )

    preview = await analyze_audio_split(
        source_path=source.as_posix(),
        silence_threshold_db=-40,
        min_silence_sec=0.3,
        min_segment_sec=0.5,
    )

    assert len(preview.segments) == 2
    assert preview.segments[0].end_sec == pytest.approx(1.5, abs=0.05)
    assert preview.segments[1].start_sec == preview.segments[0].end_sec
    assert list(tmp_path.iterdir()) == [source]


@pytest.mark.asyncio
async def test_audio_split_preview_route_is_read_only_and_typed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_path = tmp_path / "source.m4a"
    audio_path.write_bytes(b"m4a")
    captured: dict[str, object] = {}

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return SimpleNamespace(project_id=project), "owner", project, tmp_path, str(tmp_path)

    async def fake_analyze(**kwargs):
        captured.update(kwargs)
        return AudioSplitPreview(
            duration_sec=6.0,
            segments=(AudioSplitSegment(0.0, 2.5), AudioSplitSegment(2.5, 6.0)),
            detected_silence_count=1,
            limited=False,
        )

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: audio_path,
    )
    monkeypatch.setattr("novelvideo.freezone.audio_split.analyze_audio_split", fake_analyze)

    result = await freezone_routes.freezone_audio_split_preview(
        project="project_1",
        body=freezone_routes.FreezoneAudioSplitPreviewRequest(
            source_url="/static/projects/project_1/source.m4a",
            silence_threshold_db=-32,
            min_silence_sec=0.6,
            min_segment_sec=1.0,
        ),
        user={"username": "owner"},
    )

    assert result["data"] == {
        "duration_sec": 6.0,
        "segments": [
            {"start_sec": 0.0, "end_sec": 2.5},
            {"start_sec": 2.5, "end_sec": 6.0},
        ],
        "detected_silence_count": 1,
        "limited": False,
    }
    assert captured == {
        "source_path": audio_path.as_posix(),
        "silence_threshold_db": -32.0,
        "min_silence_sec": 0.6,
        "min_segment_sec": 1.0,
        "max_segments": 24,
    }
