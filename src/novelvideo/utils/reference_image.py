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

_MIME_BY_EXT = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
}


class ReferenceImageTooLarge(ValueError):
    """The reference exceeds the source limits and is not sent anywhere."""


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

    source_ext = _clean_ext(ext)
    unchanged = NormalizedImage(data, source_ext, mime_type_for_ext(source_ext))
    if len(data) > REFERENCE_IMAGE_MAX_SOURCE_BYTES:
        raise ReferenceImageTooLarge(
            f"reference image is {len(data)} bytes; the limit is "
            f"{REFERENCE_IMAGE_MAX_SOURCE_BYTES} bytes. Use a smaller image."
        )

    try:
        source = Image.open(io.BytesIO(data))
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
            image = ImageOps.exif_transpose(source)
            target = _target_size(image.size, min_short_side=min_short_side)

            if lossless:
                if target == image.size and image is source:
                    return NormalizedImage(
                        data,
                        source_ext,
                        mime_type_for_ext(source_ext),
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


def encode_reference_image_file(path, *, quality: int = REFERENCE_IMAGE_JPEG_QUALITY) -> bytes:
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
    mime = mime_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
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
        filename = str(filename or f"reference_{index + 1}.png")
        stem, dot, suffix = filename.rpartition(".")
        source_ext = suffix if dot else str(mime_type or "image/png").rsplit("/", 1)[-1]
        result = normalize_reference_image(bytes(data), ext=source_ext, lossless=lossless)
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


def _clean_ext(ext: str) -> str:
    value = str(ext or "").strip().lower().lstrip(".")
    return "jpg" if value == "jpeg" else (value or "png")
