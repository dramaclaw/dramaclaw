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


def test_decompression_bombs_are_refused_as_too_large():
    """A tiny file can declare a huge canvas; Pillow's own bomb guard must not
    escape as a different exception type."""
    from novelvideo.utils.reference_image import (
        ReferenceImageTooLarge,
        normalize_reference_image,
    )

    buffer = io.BytesIO()
    Image.new("1", (15000, 15000)).save(buffer, format="PNG")

    with pytest.raises(ReferenceImageTooLarge):
        normalize_reference_image(buffer.getvalue())


def test_lossless_mode_leaves_small_jpegs_byte_identical():
    from novelvideo.utils.reference_image import normalize_reference_image

    data = _image((16, 16), fmt="JPEG")

    result = normalize_reference_image(data, ext="jpg", lossless=True)

    assert (result.data, result.mime_type) == (data, "image/jpeg")


def test_prepared_references_are_not_normalized_twice():
    """Bytes a loader already normalized keep their encoding at every leaf, so
    a lossless line-art anchor is not re-encoded as JPEG on the way out."""
    from novelvideo.storage.media_relay import (
        IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
        transform_image_bytes,
    )
    from novelvideo.utils.reference_image import (
        normalize_reference_inputs,
        prepare_reference_image,
    )

    prepared = prepare_reference_image(
        _image((64, 64), mode="RGBA"), ext="png", lossless=True
    )

    [(filename, data, mime_type)] = normalize_reference_inputs(
        [(prepared, "image/png")]
    )
    assert (filename.endswith(".png"), data, mime_type) == (True, prepared, "image/png")
    assert transform_image_bytes(
        prepared, ext="png", image_transform=IMAGE_TRANSFORM_AI_REFERENCE_JPEG
    ) == (prepared, "png")


def test_truncated_images_are_not_prepared():
    """A header that parses is not enough: a file whose pixels are cut off is
    not a usable reference in lossless mode either."""
    from novelvideo.utils.reference_image import prepare_reference_image

    data = _image((512, 512), fmt="JPEG")

    assert (
        prepare_reference_image(data[: len(data) // 2], ext="jpg", lossless=True)
        is None
    )


def _png_with_late_xmp_orientation() -> bytes:
    import struct
    import zlib

    # An early eXIf chunk without an orientation, then the orientation in XMP
    # after the pixel data: only a full decode sees it.
    exif = Image.Exif()
    exif[0x010E] = "reference"
    buffer = io.BytesIO()
    Image.new("RGB", (5000, 32), (10, 120, 200)).save(buffer, format="PNG", exif=exif)
    data = buffer.getvalue()
    payload = b"XML:com.adobe.xmp\x00<tiff:Orientation>6</tiff:Orientation>"
    chunk = b"tEXt" + payload
    # Insert the chunk just before IEND, i.e. after the pixel data.
    return (
        data[:-12]
        + struct.pack(">I", len(payload))
        + chunk
        + struct.pack(">I", zlib.crc32(chunk))
        + data[-12:]
    )


def test_orientation_stored_after_the_pixels_is_applied():
    from novelvideo.utils.reference_image import normalize_reference_image

    result = normalize_reference_image(_png_with_late_xmp_orientation(), ext="png")

    width, height = result.size
    assert height > width


def test_lossless_pass_through_reports_the_actual_encoding():
    """A JPEG saved under a .png name is sent as image/jpeg, not mislabelled."""
    from novelvideo.utils.reference_image import normalize_reference_image

    data = _image((64, 64), fmt="JPEG")

    result = normalize_reference_image(data, ext="png", lossless=True)

    assert (result.data, result.ext, result.mime_type) == (data, "jpg", "image/jpeg")


def test_data_url_media_type_is_case_insensitive():
    import base64

    from novelvideo.utils.reference_image import (
        REFERENCE_IMAGE_MAX_EDGE,
        bound_reference_data_url,
    )

    url = "data:Image/PNG;BASE64," + base64.b64encode(_image((5000, 32))).decode()

    header, encoded = bound_reference_data_url(url).split(",", 1)

    assert header == "data:image/jpeg;base64"
    assert max(_decode(base64.b64decode(encoded)).size) == REFERENCE_IMAGE_MAX_EDGE


def test_prepared_references_survive_copy_and_pickle():
    import copy
    import pickle

    from novelvideo.utils.reference_image import (
        PreparedReference,
        prepare_reference_image,
    )

    prepared = prepare_reference_image(_image((16, 16)), ext="png", lossless=True)

    for clone in (
        copy.copy(prepared),
        copy.deepcopy(prepared),
        pickle.loads(pickle.dumps(prepared)),
    ):
        assert isinstance(clone, PreparedReference)
        assert (clone, clone.mime_type, clone.size) == (prepared, "image/png", (16, 16))


@pytest.fixture
def output_dir(tmp_path, monkeypatch):
    from novelvideo import config

    root = tmp_path / "output"
    root.mkdir()
    monkeypatch.setattr(config, "OUTPUT_DIR", str(root))
    return root


def _save(path, size, color) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)


def _pixel(path):
    with Image.open(path) as image:
        return image.convert("RGB").getpixel((0, 0))


def test_bounded_files_of_different_sources_do_not_collide(output_dir):
    from novelvideo.utils.reference_image import bounded_reference_file

    png = output_dir / "proj" / "shot.png"
    jpg = output_dir / "proj" / "shot.jpg"
    _save(png, (5000, 32), (250, 0, 0))
    _save(jpg, (5000, 32), (0, 0, 250))

    bounded_png = bounded_reference_file(png)
    bounded_jpg = bounded_reference_file(jpg)

    assert bounded_png != bounded_jpg
    assert _pixel(bounded_png)[0] > 200
    assert _pixel(bounded_jpg)[2] > 200


def test_bounded_file_follows_source_changes(output_dir):
    """The derived file is uploaded by path; a changed source must not reuse
    the object a stale derived file was uploaded under."""
    from novelvideo.utils.reference_image import bounded_reference_file

    source = output_dir / "proj" / "shot.png"
    _save(source, (5000, 32), (250, 0, 0))
    first = bounded_reference_file(source)
    _save(source, (5000, 32), (0, 0, 250))

    second = bounded_reference_file(source)

    assert second != first
    assert _pixel(second)[2] > 200


def test_bounded_files_stay_out_of_scanned_asset_folders(output_dir):
    from novelvideo.generators.pool_indexer import build_pool_index
    from novelvideo.utils.reference_image import bounded_reference_file

    grids = output_dir / "proj" / "grids" / "ep001"
    source = grids / "sketch" / "beat_01_t20261125120000.png"
    _save(source, (5000, 32), (250, 0, 0))
    before = [image.cell_path for image in build_pool_index(grids, 1).images]

    bounded_reference_file(source)

    assert [image.cell_path for image in build_pool_index(grids, 1).images] == before


def test_concurrent_bounding_of_one_source_succeeds(output_dir, monkeypatch):
    import os
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from novelvideo.utils.reference_image import bounded_reference_file

    source = output_dir / "proj" / "shot.png"
    _save(source, (5000, 32), (250, 0, 0))
    barrier = threading.Barrier(2)
    replace = os.replace

    def replace_together(src, dst):
        # Let both writers reach the rename before either finishes.
        try:
            barrier.wait(timeout=2)
        except threading.BrokenBarrierError:
            pass
        return replace(src, dst)

    monkeypatch.setattr(os, "replace", replace_together)
    with ThreadPoolExecutor(2) as pool:
        jobs = [pool.submit(bounded_reference_file, source) for _ in range(2)]
        results = [job.result() for job in jobs]

    assert results[0] == results[1]
    assert _pixel(results[0])[0] > 200
