import pytest

from novelvideo.hybrid_drama.media import inspect_media, validate_media_probe


def test_media_probe_requires_720p_video_and_audio():
    with pytest.raises(ValueError, match="720p"):
        validate_media_probe(
            {
                "streams": [
                    {"codec_type": "video", "width": 480, "height": 854},
                    {"codec_type": "audio", "channels": 2, "sample_rate": "48000"},
                ]
            }
        )

    validate_media_probe(
        {
            "streams": [
                {"codec_type": "video", "width": 720, "height": 1280},
                {"codec_type": "audio", "channels": 2, "sample_rate": "48000"},
            ]
        }
    )


def test_media_probe_requires_a_decodable_audio_stream_description():
    with pytest.raises(ValueError, match="audio"):
        validate_media_probe(
            {"streams": [{"codec_type": "video", "width": 1280, "height": 720}]}
        )


def test_inspect_media_runs_ffprobe_and_full_decode(monkeypatch, tmp_path):
    calls = []

    class Result:
        returncode = 0
        stdout = '{"streams": [], "format": {"duration": "4.0"}}'
        stderr = ""

    def run(command, **kwargs):
        calls.append(command)
        return Result()

    monkeypatch.setattr("novelvideo.hybrid_drama.media.subprocess.run", run)
    result = inspect_media(tmp_path / "final.mp4", full_decode=True)

    assert calls[0][:2] == ["ffprobe", "-v"]
    assert "-show_streams" in calls[0]
    assert "-show_format" in calls[0]
    assert calls[1][:2] == ["ffmpeg", "-v"]
    assert calls[1][-3:] == ["-f", "null", "-"]
    assert result["full_decode"] is True
