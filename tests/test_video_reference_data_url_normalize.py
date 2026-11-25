"""Video providers inline local reference frames as bounded data URLs."""

from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from novelvideo.utils.reference_image import REFERENCE_IMAGE_MAX_EDGE

_WIDE = (REFERENCE_IMAGE_MAX_EDGE + 904, (REFERENCE_IMAGE_MAX_EDGE + 904) // 2)


def _decode(url: str) -> tuple[str, bytes]:
    header, encoded = url.split(",", 1)
    return header, base64.b64decode(encoded)


def _converters():
    from novelvideo.generators import huimengi, video_generator

    def bound(cls, method):
        return getattr(cls.__new__(cls), method)

    return {
        "seedance": bound(video_generator.SeedanceVideoGenerator, "_local_to_data_url"),
        "seedance2": bound(
            video_generator.Seedance2VideoGenerator, "_file_to_data_url"
        ),
        "grok": bound(video_generator.GrokVideoGenerator, "_local_to_data_url"),
        "huimeng": huimengi.local_file_to_data_url,
    }


@pytest.mark.parametrize("provider", ["seedance", "seedance2", "grok", "huimeng"])
def test_image_frames_are_bounded_jpeg(tmp_path, provider):
    path = tmp_path / "first_frame.png"
    Image.new("RGB", _WIDE, (60, 110, 170)).save(path, format="PNG")

    header, data = _decode(_converters()[provider](str(path)))

    assert header == "data:image/jpeg;base64"
    with Image.open(io.BytesIO(data)) as image:
        assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


@pytest.mark.parametrize("provider", ["seedance2", "huimeng"])
def test_non_image_references_pass_through(tmp_path, provider):
    path = tmp_path / "voice.wav"
    path.write_bytes(b"RIFF....WAVEfmt ")

    header, data = _decode(_converters()[provider](str(path)))

    assert header.startswith("data:audio/")
    assert data == b"RIFF....WAVEfmt "


def _huimeng_generator():
    from novelvideo.generators.video_generator import HuimengVideoGenerator

    return HuimengVideoGenerator.__new__(HuimengVideoGenerator)


def test_huimeng_bounds_an_inline_data_url_reference():
    buffer = io.BytesIO()
    Image.new("RGB", _WIDE, (60, 110, 170)).save(buffer, format="PNG")
    url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    sent = _huimeng_generator()._to_upload_url(url, label="ref", log=lambda _m: None)

    header, data = _decode(sent)
    assert header == "data:image/jpeg;base64"
    with Image.open(io.BytesIO(data)) as image:
        assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


def test_huimeng_human_review_uploads_a_bounded_reference(tmp_path, monkeypatch):
    from novelvideo import config
    from novelvideo.utils import oss_client

    monkeypatch.setattr(config, "OUTPUT_DIR", str(tmp_path))
    uploaded = []

    def presign(path, **_kwargs):
        uploaded.append(str(path))
        return "https://oss.invalid/ref"

    monkeypatch.setattr(oss_client, "presign_or_upload_output", presign)
    path = tmp_path / "first_frame.png"
    Image.new("RGB", _WIDE, (60, 110, 170)).save(path, format="PNG")

    sent = _huimeng_generator()._to_upload_url(
        str(path), label="ref", log=lambda _m: None, require_http_url=True
    )

    assert sent == "https://oss.invalid/ref"
    assert uploaded[0].startswith(str(tmp_path))
    with Image.open(uploaded[0]) as image:
        assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


def test_huimeng_human_review_keeps_an_in_bound_reference(tmp_path, monkeypatch):
    from novelvideo.utils import oss_client

    uploaded = []

    def presign(path, **_kwargs):
        uploaded.append(str(path))
        return "https://oss.invalid/ref"

    monkeypatch.setattr(oss_client, "presign_or_upload_output", presign)
    path = tmp_path / "first_frame.png"
    Image.new("RGB", (640, 360), (60, 110, 170)).save(path, format="PNG")

    _huimeng_generator()._to_upload_url(
        str(path), label="ref", log=lambda _m: None, require_http_url=True
    )

    assert uploaded == [str(path)]


def test_huimeng_human_review_does_not_decode_non_image_media(tmp_path, monkeypatch):
    from novelvideo.utils import oss_client, reference_image

    uploaded = []

    def presign(path, **_kwargs):
        uploaded.append(str(path))
        return "https://oss.invalid/ref"

    def refuse(*_args, **_kwargs):
        raise AssertionError("non-image media must not be decoded")

    monkeypatch.setattr(oss_client, "presign_or_upload_output", presign)
    monkeypatch.setattr(reference_image, "normalize_reference_image", refuse)
    path = tmp_path / "motion.mp4"
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42")

    _huimeng_generator()._to_upload_url(
        str(path), label="ref", log=lambda _m: None, require_http_url=True
    )

    assert uploaded == [str(path)]
