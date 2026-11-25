"""One normalization point for every reference image sent to a model.

Reference images leave the process through several transports (relay URLs,
multipart uploads, data URLs, inline SDK parts). Each must bound what it sends
the same way: a capped long edge, a guard against decompression bombs, and an
optional lossless mode for line-art anchors that JPEG would smear.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image


def _image(size, *, mode="RGB", fmt="PNG") -> bytes:
    color = (10, 120, 200, 255) if mode == "RGBA" else (10, 120, 200)
    buffer = io.BytesIO()
    Image.new(mode, size, color).save(buffer, format=fmt)
    return buffer.getvalue()


def _decode(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


def test_long_edge_is_capped_and_aspect_ratio_kept():
    from novelvideo.utils.reference_image import (
        REFERENCE_IMAGE_MAX_EDGE,
        normalize_reference_image,
    )

    result = normalize_reference_image(_image((6000, 3000)), ext="png")

    image = _decode(result.data)
    assert image.size == (REFERENCE_IMAGE_MAX_EDGE, REFERENCE_IMAGE_MAX_EDGE // 2)
    assert (result.ext, result.mime_type, image.format) == ("jpg", "image/jpeg", "JPEG")


def test_a_4k_output_reused_as_reference_keeps_its_resolution():
    from novelvideo.utils.reference_image import normalize_reference_image

    result = normalize_reference_image(_image((3840, 2160)), ext="png")

    assert _decode(result.data).size == (3840, 2160)


def test_transparency_is_flattened_onto_white():
    from novelvideo.utils.reference_image import normalize_reference_image

    buffer = io.BytesIO()
    Image.new("RGBA", (8, 8), (0, 0, 0, 0)).save(buffer, format="PNG")

    result = normalize_reference_image(buffer.getvalue(), ext="png")

    image = _decode(result.data)
    assert image.mode == "RGB"
    assert all(channel > 240 for channel in image.getpixel((4, 4)))


def test_lossless_mode_keeps_png_and_only_resizes():
    from novelvideo.utils.reference_image import (
        REFERENCE_IMAGE_MAX_EDGE,
        normalize_reference_image,
    )

    result = normalize_reference_image(
        _image((5000, 1000), mode="RGBA"), ext="png", lossless=True
    )

    image = _decode(result.data)
    assert (result.ext, result.mime_type, image.format) == ("png", "image/png", "PNG")
    assert image.mode == "RGBA"
    assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


def test_lossless_mode_leaves_small_images_byte_identical():
    from novelvideo.utils.reference_image import normalize_reference_image

    source = _image((640, 480))

    result = normalize_reference_image(source, ext="png", lossless=True)

    assert result.data == source


def test_min_short_side_upscales_small_references():
    from novelvideo.utils.reference_image import normalize_reference_image

    result = normalize_reference_image(
        _image((200, 100)), ext="png", lossless=True, min_short_side=400
    )

    assert _decode(result.data).size == (800, 400)


def test_oversized_pixel_count_is_refused_before_decoding(monkeypatch):
    from novelvideo.utils import reference_image

    monkeypatch.setattr(reference_image, "REFERENCE_IMAGE_MAX_SOURCE_PIXELS", 100)

    with pytest.raises(reference_image.ReferenceImageTooLarge) as excinfo:
        reference_image.normalize_reference_image(_image((20, 20)), ext="png")

    assert "400" in str(excinfo.value) and "100" in str(excinfo.value)


def test_oversized_source_bytes_are_refused(monkeypatch):
    from novelvideo.utils import reference_image

    monkeypatch.setattr(reference_image, "REFERENCE_IMAGE_MAX_SOURCE_BYTES", 10)

    with pytest.raises(reference_image.ReferenceImageTooLarge):
        reference_image.normalize_reference_image(_image((20, 20)), ext="png")


def test_undecodable_input_is_returned_unchanged():
    from novelvideo.utils.reference_image import normalize_reference_image

    result = normalize_reference_image(b"not-an-image", ext="png")

    assert (result.data, result.ext, result.mime_type) == (
        b"not-an-image",
        "png",
        "image/png",
    )


def test_relay_transform_applies_the_same_cap():
    from novelvideo.storage.media_relay import (
        IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
        transform_image_bytes,
    )
    from novelvideo.utils.reference_image import REFERENCE_IMAGE_MAX_EDGE

    data, ext = transform_image_bytes(
        _image((6000, 3000)),
        ext="png",
        image_transform=IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
    )

    assert ext == "jpg"
    assert max(_decode(data).size) == REFERENCE_IMAGE_MAX_EDGE
