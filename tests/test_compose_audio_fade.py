import array
import math
import shutil
import subprocess

import pytest
from pydantic import ValidationError

from novelvideo.api.schemas import FreezoneVideoComposeItem
from novelvideo.freezone import jobs


def test_compose_item_preserves_fade_and_rejects_invalid_duration():
    values = dict(item_id="bgm", source_url="/bgm.wav", source_end=4, volume=0.7)
    assert FreezoneVideoComposeItem(**values, fade_out=2).model_dump()["fade_out"] == 2
    assert FreezoneVideoComposeItem(**values).model_dump()["fade_out"] == 0
    for duration in (-1, float("nan"), float("inf"), 5):
        with pytest.raises(ValidationError):
            FreezoneVideoComposeItem(**values, fade_out=duration)


@pytest.mark.asyncio
@pytest.mark.parametrize("speed", [1, 2])
async def test_audio_clip_fades_last_two_seconds_without_changing_earlier_volume(
    tmp_path, speed
):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg required")
    source = tmp_path / "source.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            str(source),
        ],
        check=True,
    )
    paths = [tmp_path / "plain.m4a", tmp_path / "fade.m4a"]
    for path, fade in zip(paths, (0, 2 / speed)):
        await jobs._render_audio_clip(
            source_path=str(source),
            output_path=path,
            source_start=0,
            duration=4,
            volume=0.7,
            fade_out=fade,
            speed=speed,
        )

    def rms(path, start, end):
        result = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(path),
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "8000",
                "pipe:1",
            ],
            capture_output=True,
            check=True,
        )
        samples = array.array("h", result.stdout)
        values = samples[int(start * 8000) : int(end * 8000)]
        return math.sqrt(sum(v * v for v in values) / len(values))

    assert rms(paths[1], 0.5 / speed, 1 / speed) == pytest.approx(
        rms(paths[0], 0.5 / speed, 1 / speed), rel=0.03
    )
    assert (
        rms(paths[1], 3.8 / speed, 3.95 / speed)
        < rms(paths[0], 3.8 / speed, 3.95 / speed) * 0.12
    )


def test_fades_are_not_silently_accepted_by_unsupported_tracks_or_studio():
    from novelvideo.api.schemas import (
        FreezoneVideoComposeTrack,
        FreezoneVideoComposeStudioRequest,
    )

    item = dict(item_id="bgm", source_url="/bgm.wav", source_end=4, fade_out=2)
    with pytest.raises(ValidationError, match="only on audio"):
        FreezoneVideoComposeTrack(track_id="video", kind="video", items=[item])
    with pytest.raises(ValidationError, match="Studio does not support"):
        FreezoneVideoComposeStudioRequest(
            canvas_id="canvas",
            node_id="compose",
            tracks=[
                dict(track_id="music", kind="audio", items=[item]),
            ],
        )


@pytest.mark.asyncio
async def test_mix_carries_audio_effects_and_does_not_restore_zero_volume(
    monkeypatch, tmp_path
):
    calls = []

    async def render(**kwargs):
        calls.append(kwargs)

    async def run(_cmd):
        pass

    monkeypatch.setattr(jobs, "_render_audio_clip", render)
    monkeypatch.setattr(jobs, "_run_cmd", run)
    item = dict(
        source_path="/bgm.wav",
        source_start=0,
        source_end=8,
        volume=0.7,
        fade_out=2,
        speed=2,
    )
    await jobs._mix_audio_tracks(
        base_video_path=tmp_path / "base.mp4",
        final_output_path=tmp_path / "out.mp4",
        audio_items=[item, {**item, "volume": 0}],
        temp_dir=tmp_path,
    )
    assert len(calls) == 1
    assert calls[0]["volume"] == 0.7
    assert calls[0]["fade_out"] == 2
    assert calls[0]["speed"] == 2
