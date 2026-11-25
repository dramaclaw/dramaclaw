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
        "seedance2": bound(video_generator.Seedance2VideoGenerator, "_file_to_data_url"),
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
