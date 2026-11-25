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


@pytest.mark.parametrize("module_name,class_name", _GENERATORS)
def test_undecodable_reference_is_skipped(tmp_path, module_name, class_name):
    generator = _generator(module_name, class_name)
    path = tmp_path / "broken.png"
    path.write_bytes(b"not-an-image")

    assert generator._load_image_as_part(str(path)) is None


@pytest.mark.parametrize("provider", ["google", "openrouter"])
def test_merged_character_sheet_is_capped(provider):
    generator = _generator(*_GENERATORS[0])
    generator.provider = provider
    panels = [Image.new("RGB", (2048, 1024), (90, 40, 10)) for _ in range(3)]

    part = generator._merge_character_panels(panels)

    image, mime_type = _part_image(part)
    assert (image.format, mime_type) == ("JPEG", "image/jpeg")
    assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE


@pytest.mark.asyncio
async def test_openai_keeps_a_lossless_line_art_part_lossless(tmp_path, monkeypatch):
    import openai

    from novelvideo.generators import nanobanana_grid

    uploads = []

    class FakeImages:
        async def edit(self, *, image, **_kwargs):
            uploads.append(image)
            raise RuntimeError("stop")

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            self.images = FakeImages()

    class FakeMeter:
        async def reserve_current_model_call_credit(self, **_kwargs):
            return ""

        async def refund_model_call_credit_reservation(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(openai, "AsyncOpenAI", FakeOpenAI)
    monkeypatch.setattr(nanobanana_grid, "get_usage_meter", lambda: FakeMeter())
    generator = _generator(*_GENERATORS[0])
    part = generator._load_image_as_part(
        _write_png(tmp_path / "director_sketch_ref.png", (256, 256), mode="RGBA"),
        compress_quality=0,
    )
    _, references = generator._extract_ref_bytes_from_contents([part], include_mime=True)

    await nanobanana_grid._call_openai_image_api(
        api_key="key", model="gpt-image-1", prompt="prompt", reference_images=references
    )

    [(filename, data, mime_type)] = uploads[0]
    assert (filename.endswith(".png"), mime_type) == (True, "image/png")
    assert Image.open(io.BytesIO(data)).mode == "RGBA"
