"""Inline reference parts (SDK image parts) share the reference-image bound."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from novelvideo.utils.reference_image import REFERENCE_IMAGE_MAX_EDGE

_WIDE = (REFERENCE_IMAGE_MAX_EDGE + 904, (REFERENCE_IMAGE_MAX_EDGE + 904) // 2)


def _write_png(path, size, mode="RGB"):
    Image.new(mode, size, (30, 90, 150, 255) if mode == "RGBA" else (30, 90, 150)).save(
        path, format="PNG"
    )
    return str(path)


def _generator(module_name: str, class_name: str):
    import importlib

    cls = getattr(importlib.import_module(module_name), class_name)
    generator = cls.__new__(cls)
    generator.provider = "openrouter"
    return generator


_GENERATORS = [
    ("novelvideo.generators.nanobanana_grid", "NanoBananaGridGenerator"),
    ("novelvideo.generators.nanobanana_character", "NanoBananaCharacterGenerator"),
]


def _part_image(part):
    assert part is not None
    data = part.inline_data.data
    image = Image.open(io.BytesIO(data))
    return image, part.inline_data.mime_type


@pytest.mark.parametrize("module_name,class_name", _GENERATORS)
def test_compressed_part_caps_the_long_edge(tmp_path, module_name, class_name):
    generator = _generator(module_name, class_name)

    part = generator._load_image_as_part(_write_png(tmp_path / "ref.png", _WIDE))

    image, mime_type = _part_image(part)
    assert (image.format, mime_type) == ("JPEG", "image/jpeg")
    assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


@pytest.mark.parametrize("module_name,class_name", _GENERATORS)
def test_uncompressed_part_stays_png_but_is_capped(tmp_path, module_name, class_name):
    generator = _generator(module_name, class_name)

    part = generator._load_image_as_part(
        _write_png(tmp_path / "line_art.png", _WIDE, mode="RGBA"), compress_quality=0
    )

    image, mime_type = _part_image(part)
    assert (image.format, mime_type) == ("PNG", "image/png")
    assert image.mode == "RGBA"
    assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


def test_min_short_side_upscale_still_applies(tmp_path):
    generator = _generator(*_GENERATORS[0])

    part = generator._load_image_as_part(
        _write_png(tmp_path / "spatial.png", (300, 200)),
        compress_quality=0,
        min_short_side=400,
    )

    image, _ = _part_image(part)
    assert image.size == (600, 400)
