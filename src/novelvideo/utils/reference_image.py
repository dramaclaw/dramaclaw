"""Bound every reference image before it is sent to a model.

Reference images leave the process through relay URLs, multipart uploads, data
URLs and inline SDK parts. All of them go through ``normalize_reference_image``
so the size a provider receives does not depend on which transport sent it.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

# Large enough that a reused 4K output (3840x2160) keeps its resolution; only
# larger inputs (camera photos, stitched panoramas) are scaled down.
REFERENCE_IMAGE_MAX_EDGE = 4096
REFERENCE_IMAGE_JPEG_QUALITY = 95
REFERENCE_IMAGE_MAX_SOURCE_BYTES = 64 * 1024 * 1024
REFERENCE_IMAGE_MAX_SOURCE_PIXELS = 40_000_000

REFERENCE_CACHE_DIRNAME = ".reference-cache"

_EXT_BY_FORMAT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}

_MIME_BY_EXT = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
}


class ReferenceImageTooLarge(ValueError):
    """The reference exceeds the source limits and is not sent anywhere."""


class PreparedReference(bytes):
    """Reference bytes that ``prepare_reference_image`` already normalized.

    Loaders choose the encoding (a JPEG quality, or lossless for line art);
    every later transport sees this type and sends the bytes unchanged instead
    of normalizing them a second time with its own defaults.
    """

    mime_type: str
    size: tuple[int, int]

    def __new__(cls, data: bytes, *, mime_type: str, size: tuple[int, int]):
        prepared = super().__new__(cls, data)
        prepared.mime_type = mime_type
        prepared.size = size
        return prepared

    def __reduce__(self):
        # bytes subclasses copy and pickle through __new__; pass the metadata.
        return (_restore_prepared_reference, (bytes(self), self.mime_type, self.size))


def _restore_prepared_reference(data, mime_type, size):
    return PreparedReference(data, mime_type=mime_type, size=tuple(size))


@dataclass(frozen=True)
class NormalizedImage:
    data: bytes
    ext: str
    mime_type: str
    source_size: tuple[int, int] | None = None
    size: tuple[int, int] | None = None
    source_format: str = ""
    source_mode: str = ""


def mime_type_for_ext(ext: str) -> str:
    return _MIME_BY_EXT.get(_clean_ext(ext), "image/png")


def normalize_reference_image(
    data: bytes,
    *,
    ext: str = "png",
    quality: int = REFERENCE_IMAGE_JPEG_QUALITY,
    lossless: bool = False,
    min_short_side: int = 0,
) -> NormalizedImage:
    """Return the bytes to send for one reference image.

    - The long edge is capped at ``REFERENCE_IMAGE_MAX_EDGE``.
    - ``min_short_side`` upscales small references first (the cap still wins).
    - Default output is JPEG at ``quality`` with transparency flattened onto
      white. ``lossless=True`` keeps the source untouched unless it must be
      resized, and then writes PNG.
    - Inputs Pillow cannot decode are returned unchanged.
    - Sources over the byte or pixel limit raise ``ReferenceImageTooLarge``
      before they are decoded, rather than being sent at full size.
    """
    from PIL import Image, ImageOps, UnidentifiedImageError

    if isinstance(data, PreparedReference):
        prepared_ext = _ext_for_mime(data.mime_type)
        return NormalizedImage(
            data,
            prepared_ext,
            data.mime_type,
            source_size=data.size,
            size=data.size,
            source_format=prepared_ext.upper(),
        )

    source_ext = _clean_ext(ext)
    unchanged = NormalizedImage(data, source_ext, mime_type_for_ext(source_ext))
    if len(data) > REFERENCE_IMAGE_MAX_SOURCE_BYTES:
        raise ReferenceImageTooLarge(
            f"reference image is {len(data)} bytes; the limit is "
            f"{REFERENCE_IMAGE_MAX_SOURCE_BYTES} bytes. Use a smaller image."
        )

    try:
        source = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError as exc:
        # Pillow refuses some huge canvases while reading the header.
        raise ReferenceImageTooLarge(
            f"reference image is too large to decode ({exc}); the limit is "
            f"{REFERENCE_IMAGE_MAX_SOURCE_PIXELS} pixels. Use a smaller image."
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError):
        return unchanged

    with source:
        width, height = source.size
        pixels = width * height
        if pixels > REFERENCE_IMAGE_MAX_SOURCE_PIXELS:
            raise ReferenceImageTooLarge(
                f"reference image is {width}x{height} ({pixels} pixels); the limit "
                f"is {REFERENCE_IMAGE_MAX_SOURCE_PIXELS} pixels. Use a smaller image."
            )
        source_format = (source.format or source_ext).upper()
        source_mode = source.mode
        try:
            # Decode fully first: a truncated file is not a usable reference, and
            # some formats store the orientation after the pixel data.
            source.load()
            needs_transpose = source.getexif().get(_EXIF_ORIENTATION, 1) not in (0, 1)
            image = ImageOps.exif_transpose(source) if needs_transpose else source
            target = _target_size(image.size, min_short_side=min_short_side)

            if lossless:
                actual_ext = _EXT_BY_FORMAT.get(source.format or "")
                if target == image.size and not needs_transpose and actual_ext:
                    return NormalizedImage(
                        data,
                        actual_ext,
                        mime_type_for_ext(actual_ext),
                        source_size=(width, height),
                        size=(width, height),
                        source_format=source_format,
                        source_mode=source_mode,
                    )
                if target != image.size:
                    image = image.resize(target, Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                image.save(buffer, format="PNG")
                return NormalizedImage(
                    buffer.getvalue(),
                    "png",
                    "image/png",
                    source_size=(width, height),
                    size=image.size,
                    source_format=source_format,
                    source_mode=source_mode,
                )

            image = _flatten_to_rgb(image)
            if target != image.size:
                image = image.resize(target, Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=quality, optimize=True)
        except (OSError, ValueError):
            return unchanged

    return NormalizedImage(
        buffer.getvalue(),
        "jpg",
        "image/jpeg",
        source_size=(width, height),
        size=image.size,
        source_format=source_format,
        source_mode=source_mode,
    )


def prepare_reference_image(
    data: bytes,
    *,
    ext: str = "png",
    quality: int = REFERENCE_IMAGE_JPEG_QUALITY,
    lossless: bool = False,
    min_short_side: int = 0,
) -> PreparedReference | None:
    """Normalize a reference once and mark it so transports send it as is.

    Returns ``None`` when the bytes are not a decodable image.
    """
    result = normalize_reference_image(
        data, ext=ext, quality=quality, lossless=lossless, min_short_side=min_short_side
    )
    if result.size is None:
        return None
    return PreparedReference(result.data, mime_type=result.mime_type, size=result.size)


def fit_reference_image(image):
    """Resize a Pillow image composed in memory so its long edge fits the cap."""
    from PIL import Image

    target = _target_size(image.size, min_short_side=0)
    if target == image.size:
        return image
    return image.resize(target, Image.Resampling.LANCZOS)


def bound_reference_data_url(url: str) -> str:
    """Bound an image data URL a caller passed in; other values are returned as is."""
    import base64
    import binascii

    header, sep, encoded = url.partition(",")
    header = header.strip().lower()
    if not (sep and header.startswith("data:image/") and header.endswith(";base64")):
        return url
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return url
    result = normalize_reference_image(
        data, ext=header[len("data:image/") : -len(";base64")]
    )
    if result.size is None:
        return url
    return f"data:{result.mime_type};base64,{base64.b64encode(result.data).decode('ascii')}"


def bounded_reference_file(path):
    """Return a file whose image fits the cap, for transports that send a URL.

    In-bound files (and non-images) are returned unchanged so existing objects
    are reused. An oversized image is written once to
    ``OUTPUT_DIR/.reference-cache/<content hash>.<ext>`` and that path is
    returned. The name follows the bytes, so a changed source never reuses an
    object uploaded for older bytes, and asset folders never see the file.
    """
    import hashlib
    import mimetypes
    import os
    import tempfile
    from pathlib import Path

    from novelvideo import config

    source = Path(path)
    if not (mimetypes.guess_type(source.name)[0] or "").startswith("image/"):
        return source
    result = normalize_reference_image(
        source.read_bytes(), ext=source.suffix.lstrip(".") or "png"
    )
    if result.size is None or result.size == result.source_size:
        return source
    cache_dir = Path(config.OUTPUT_DIR) / REFERENCE_CACHE_DIRNAME
    bounded = cache_dir / f"{hashlib.sha256(result.data).hexdigest()}.{result.ext}"
    if not bounded.exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=cache_dir, prefix=".", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(result.data)
            os.chmod(tmp, 0o644)  # mkstemp creates 0600; match other outputs
            os.replace(tmp, bounded)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
    return bounded


def encode_reference_image_file(
    path, *, quality: int = REFERENCE_IMAGE_JPEG_QUALITY
) -> bytes:
    """Read an image file and return it as a bounded JPEG."""
    from pathlib import Path

    source = Path(path)
    data = source.read_bytes()
    result = normalize_reference_image(
        data, ext=source.suffix.lstrip(".") or "png", quality=quality
    )
    if result.size is None:
        raise ValueError(f"{source.name} is not a decodable image")
    return result.data


def reference_file_to_data_url(path, *, mime_type: str | None = None) -> str:
    """Inline a local reference file as a data URL.

    Image files are bounded first; other media (video, audio) are inlined as is.
    """
    import base64
    import mimetypes
    from pathlib import Path

    source = Path(path)
    data = source.read_bytes()
    mime = (
        mime_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    )
    if mime.startswith("image/"):
        result = normalize_reference_image(
            data, ext=source.suffix.lstrip(".") or mime.rsplit("/", 1)[-1]
        )
        if result.size is not None:
            data, mime = result.data, result.mime_type
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def normalize_reference_inputs(
    reference_images, *, lossless: bool = False
) -> list[tuple[str, bytes, str]]:
    """Normalize a provider reference list into ``(filename, bytes, mime)``.

    Accepts the shapes image transports take: raw ``bytes``,
    ``(bytes, mime_type)`` or ``(filename, bytes, mime_type)``.
    """
    normalized: list[tuple[str, bytes, str]] = []
    for index, image_ref in enumerate(reference_images or []):
        filename = f"reference_{index + 1}.png"
        mime_type = "image/png"
        if isinstance(image_ref, tuple):
            if len(image_ref) == 3:
                filename, data, mime_type = image_ref
            elif len(image_ref) == 2:
                data, mime_type = image_ref
            else:
                data = image_ref[0]
        else:
            data = image_ref
        if not isinstance(data, PreparedReference):
            data = bytes(data)
        filename = str(filename or f"reference_{index + 1}.png")
        stem, dot, suffix = filename.rpartition(".")
        source_ext = suffix if dot else str(mime_type or "image/png").rsplit("/", 1)[-1]
        result = normalize_reference_image(data, ext=source_ext, lossless=lossless)
        normalized.append(
            (f"{stem if dot else filename}.{result.ext}", result.data, result.mime_type)
        )
    return normalized


def _target_size(size: tuple[int, int], *, min_short_side: int) -> tuple[int, int]:
    width, height = size
    scale = 1.0
    short_side = min(width, height)
    if min_short_side > 0 and 0 < short_side < min_short_side:
        scale = min_short_side / short_side
    if max(width, height) * scale > REFERENCE_IMAGE_MAX_EDGE:
        scale = REFERENCE_IMAGE_MAX_EDGE / max(width, height)
    if scale == 1.0:
        return size
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def _flatten_to_rgb(image):
    from PIL import Image

    if image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    ):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    if image.mode != "RGB":
        return image.convert("RGB")
    return image


_EXIF_ORIENTATION = 0x0112


def _ext_for_mime(mime_type: str) -> str:
    for ext, mime in _MIME_BY_EXT.items():
        if mime == mime_type:
            return _clean_ext(ext)
    return "png"


def _clean_ext(ext: str) -> str:
    value = str(ext or "").strip().lower().lstrip(".")
    return "jpg" if value == "jpeg" else (value or "png")
