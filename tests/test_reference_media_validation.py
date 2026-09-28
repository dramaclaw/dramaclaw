import json
import shutil
import subprocess
from types import SimpleNamespace

import pytest
from PIL import Image

from novelvideo.freezone import reference_validation as validation
from novelvideo.media_model_request_schema import (
    MediaModelSchemaError,
    normalize_media_model_catalog_config,
    validate_media_model_catalog_config,
)


def test_empty_limits_do_not_probe_or_access_files(monkeypatch, tmp_path):
    monkeypatch.setattr(
        validation, "_probe", lambda *_: pytest.fail("unexpected probe")
    )
    assert (
        validation.validate_reference_media(
            [{"type": "image", "path": "https://example.invalid/x.png"}],
            {"referenceImageFormats": [], "referenceImageMinWidth": None},
            tmp_path,
        )
        == []
    )


@pytest.mark.parametrize("width,expected", [(299, ["minWidth"]), (300, []), (301, [])])
def test_pixel_boundary(width, expected, tmp_path):
    path = tmp_path / "portrait.png"
    Image.new("RGB", (width, 300)).save(path)
    errors = validation.validate_reference_media(
        [{"type": "image", "path": str(path)}],
        {"referenceImageMinWidth": 300, "referenceImageMinHeight": 300},
        tmp_path,
    )
    assert [e["code"] for e in errors] == expected
    if errors:
        assert errors[0]["reference_key"] == "portrait.png"
        assert errors[0]["index"] == 1
        assert errors[0]["actual"] == 299


def test_aggregate_real_format_dimensions_size_and_identity(tmp_path):
    path = tmp_path / "pretend.jpg"
    Image.new("RGB", (200, 700)).save(path, format="PNG")
    errors = validation.validate_reference_media(
        [{"type": "image", "path": str(path)}, {"type": "image", "path": str(path)}],
        {
            "referenceImageFormats": ["jpeg"],
            "referenceImageMinWidth": 300,
            "referenceImageMaxHeight": 600,
            "referenceImageMinAspectRatio": 0.4,
            "referenceImageMaxMB": 0.0001,
        },
        tmp_path,
    )
    assert {e["code"] for e in errors} == {
        "format",
        "minWidth",
        "maxHeight",
        "minAspectRatio",
        "maxMB",
    }
    assert {e["index"] for e in errors} == {1, 2}
    assert all(e["name"] == "pretend.jpg" for e in errors)


def test_unreadable_and_remote_fail_without_path_disclosure(tmp_path):
    path = tmp_path / "broken.wav"
    path.write_bytes(b"not audio")
    errors = validation.validate_reference_media(
        [
            {"type": "audio", "path": str(path)},
            {"type": "audio", "path": "https://private.invalid/secret?token=abc"},
        ],
        {"referenceAudioFormats": ["wav", "mp3"]},
        tmp_path,
    )
    assert [e["code"] for e in errors] == ["unreadable", "unreadable"]
    assert "private.invalid" not in json.dumps(errors)
    assert str(tmp_path) not in json.dumps(errors)


def test_video_format_fps_and_single_probe(monkeypatch, tmp_path):
    path = tmp_path / "movie.mp4"
    path.write_bytes(b"x")
    calls = []

    def probe(*args):
        calls.append(args)
        return {"format": "mov", "fps": 120}

    monkeypatch.setattr(validation, "_probe", probe)
    errors = validation.validate_reference_media(
        [{"type": "video", "path": str(path)}] * 2,
        {
            "referenceVideoFormats": ["mp4"],
            "referenceVideoMinFPS": 24,
            "referenceVideoMaxFPS": 60,
        },
        tmp_path,
    )
    assert len(calls) == 1
    assert [e["code"] for e in errors] == ["format", "maxFPS", "format", "maxFPS"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("referenceImageMinWidth", 0),
        ("referenceImageMaxMB", -1),
        ("referenceVideoMaxFPS", float("inf")),
        ("referenceAudioMaxMB", True),
        ("referenceImageMinHeight", 300.5),
        ("referenceAudioFormats", "mp3"),
    ],
)
def test_invalid_config(field, value):
    with pytest.raises(MediaModelSchemaError):
        validate_media_model_catalog_config({field: value}, "video")


def test_config_normalize_clear_and_order():
    with pytest.raises(MediaModelSchemaError):
        normalize_media_model_catalog_config({"referenceAudioFormats": [{}]})
    config = normalize_media_model_catalog_config(
        {"referenceImageFormats": [".JPG", "jpeg"], "referenceVideoMaxFPS": None}
    )
    assert config["referenceImageFormats"] == ["jpeg"]
    validate_media_model_catalog_config(config, "video")
    with pytest.raises(MediaModelSchemaError):
        validate_media_model_catalog_config(
            {"referenceVideoMinFPS": 60, "referenceVideoMaxFPS": 24}, "video"
        )


@pytest.mark.asyncio
async def test_video_validation_precedes_billing_and_includes_last_frame(
    monkeypatch, tmp_path
):
    from fastapi import HTTPException
    from novelvideo.api.routes import freezone

    path = tmp_path / "last.png"
    Image.new("RGB", (100, 300)).save(path)

    async def forbidden(*args, **kwargs):
        pytest.fail("must reject before video probe/billing/enqueue")

    monkeypatch.setattr(freezone, "probe_total_video_duration_seconds", forbidden)
    with pytest.raises(HTTPException) as caught:
        await freezone._start_or_enqueue_freezone_video_gen(
            ctx=None,
            username="test",
            project="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            job_id="test",
            prompt="test",
            reference_items=[],
            last_frame_path=str(path),
            aspect_ratio="16:9",
            resolution="720p",
            duration_seconds=5,
            generate_audio=False,
            human_review=False,
            scene_optimize=None,
            backend="newapi_custom",
            capabilities={"referenceImageMinWidth": 300},
        )
    assert caught.value.status_code == 400
    assert caught.value.detail["code"] == "REFERENCE_MEDIA_INVALID"
    assert caught.value.detail["errors"][0]["role"] == "last_frame"


def test_ffprobe_uses_container_not_extension(monkeypatch, tmp_path):
    path = tmp_path / "fake.wav"
    path.write_bytes(b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 20)

    def run(command, **kwargs):
        assert command[command.index("-protocol_whitelist") + 1] == "file,pipe"
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
                    "streams": [{"codec_type": "audio", "codec_name": "aac"}],
                }
            )
        )

    monkeypatch.setattr(validation.subprocess, "run", run)
    assert validation._probe(path, "audio")["format"] == "m4a"


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="requires media tools",
)
@pytest.mark.parametrize(
    "extension,media",
    [("wav", "audio"), ("mp3", "audio"), ("mp4", "video"), ("mov", "video")],
)
def test_actual_media_container_and_fps(tmp_path, extension, media):
    path = tmp_path / f"sample.{extension}"
    source = (
        ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2"]
        if media == "audio"
        else ["-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=0.2", "-c:v", "mpeg4"]
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", *source, str(path)], check=True, timeout=20
    )
    values = validation._probe(path, media)
    assert values["format"] == extension
    if media == "video":
        assert values["fps"] == 24


def test_heif_metadata_uses_primary_stream_without_new_decoder(monkeypatch, tmp_path):
    path = tmp_path / "sample.heic"
    path.write_bytes(b"\x00\x00\x00\x18ftypheic" + b"\x00" * 20)
    monkeypatch.setattr(
        validation,
        "_ffprobe",
        lambda _: {
            "streams": [
                {"codec_type": "video", "width": 64, "height": 64},
                {
                    "codec_type": "video",
                    "width": 300,
                    "height": 400,
                    "disposition": {"default": 1},
                },
            ]
        },
    )
    assert validation._probe(path, "image") == {
        "format": "heif",
        "width": 300,
        "height": 400,
        "aspectRatio": 0.75,
    }


def test_heif_when_decoder_available(tmp_path):
    pillow_heif = pytest.importorskip("pillow_heif")
    pillow_heif.register_heif_opener()
    path = tmp_path / "sample.heic"
    Image.new("RGB", (300, 300)).save(path, format="HEIF")
    assert (
        validation.validate_reference_media(
            [{"type": "image", "path": str(path)}],
            {"referenceImageFormats": ["heic", "heif"], "referenceImageMinWidth": 300},
            tmp_path,
        )
        == []
    )
