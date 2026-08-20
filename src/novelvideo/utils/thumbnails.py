"""On-demand downscaled image variants for media served over ``/static``.

The canvas UI renders full-resolution originals into tiny boxes — a node's
generation-history strip paints 5504x3072 PNGs into 56x56 thumbnails. The
bytes are only half the problem: even over localhost, where transfer is
free, nine such images cost ~2.1s of main-thread decode + raster in the
browser and drop seven frames. Serving a pre-shrunk variant removes that
work entirely (measured: 105.4MB -> 0.23MB, 2156ms of long tasks -> 0).

The cache is addressed purely by source path::

    <project_dir>/_thumbs/<variant>/<path relative to project_dir>.webp

so nothing about it leaks into a data schema. History records and canvas
JSON keep storing the original URL; callers opt in per render by asking for
a variant, and old data benefits without any backfill.
Freshness is exact rather than heuristic: a generated variant is stamped
with its source's mtime, so ``thumb.mtime == source.mtime`` means current
and a regenerated source invalidates automatically without leaving stale
files behind.

Building and serving are deliberately separate. ``fresh_thumbnail`` is what a
request calls and it never builds; ``ensure_thumbnail`` builds and only ever
runs in the background. A variant a request wants but does not have is queued
and the original goes out instead, so a cold project costs exactly what it did
before variants existed and warms itself up as it is used.

Every failure path returns ``None`` so the caller falls back to the
original. A slow node beats a broken one.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Optional

logger = logging.getLogger("novelvideo.thumbnails")

# Longest-edge pixel budget per variant. Allowlist — an unknown variant is
# treated as "no variant" rather than an error, so a stale frontend can never
# turn this into a 500 or a free image-resizing service.
VARIANTS: dict[str, int] = {
    # 56px box in the history strip / ~200px asset grids, with headroom for
    # 3x DPR. Measured ~13KB per 5504x3072 source.
    "thumb": 320,
    # Canvas node bodies. A default image node is 580 CSS px wide, so this
    # covers it at 2x DPR with room to spare, while still cutting a
    # 5504x3072 source from 16.9MP of decode to 1.4MP. Nodes are shown at
    # zoom <= 1 for all but close inspection, and close inspection goes
    # through the fullscreen viewer, which is always served the original.
    "card": 1280,
}

THUMB_ROOT = "_thumbs"

# Formats Pillow reads cheaply and that survive a WEBP round-trip. GIF is
# excluded on purpose: flattening an animation to one frame is a visible
# regression, and the original is small enough not to matter.
_SUPPORTED_SUFFIXES = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
)

# Two independent ceilings, because neither one implies the other. A 200MB TIFF
# is mostly a read cost; a 300KB PNG of flat colour is 10000x10000 and costs
# 441MB of RSS to decode. Pillow does not save us from the second: its
# decompression-bomb *error* only fires above 2x MAX_IMAGE_PIXELS (~179MP) and
# everything below that merely warns and decodes anyway.
#
# The pixel ceiling is set from what a worker may hold at once: 40MP at 4 bytes
# is ~160MB decoded, and DEFAULT_RENDER_CONCURRENCY of those is the real bound.
# It still clears 8K (7680x4320 = 33MP) with room to spare, and anything past it
# is served as its original — the same fallback every other decline takes.
_MAX_SOURCE_BYTES = 64 * 1024 * 1024
_MAX_SOURCE_PIXELS = 40_000_000

_WEBP_QUALITY = 80
_WEBP_METHOD = 4

# Bound concurrent decodes so a burst of cold thumbnails (a history strip is
# nine at once) cannot monopolise the machine. This is a process-wide ceiling
# across every caller — HTTP, prewarm workers, offline backfill.
DEFAULT_RENDER_CONCURRENCY = 4
_render_slots = threading.Semaphore(DEFAULT_RENDER_CONCURRENCY)


def set_render_concurrency(slots: int) -> None:
    """Resize the decode budget. Offline backfill only.

    The default is deliberately small because a serving process must keep
    threads for ordinary requests. A batch job has no such neighbour and is
    otherwise capped at four cores no matter what ``--jobs`` says. Swapping
    the semaphore is only safe before any render starts, so this must not be
    called from a running server.
    """

    global _render_slots
    _render_slots = threading.Semaphore(max(1, int(slots)))


# Striped locks collapse the thundering herd when several requests race for
# the same cold thumbnail. Striping rather than a per-path dict keeps memory
# flat over a long-lived process; a hash collision only costs serialization.
_STRIPE_COUNT = 64
_stripes = tuple(threading.Lock() for _ in range(_STRIPE_COUNT))


def _stripe_for(path: Path) -> threading.Lock:
    return _stripes[hash(str(path)) % _STRIPE_COUNT]


def normalize_variant(value: str | None) -> Optional[str]:
    """Return a known variant name, or ``None`` for absent/unknown input."""

    if not value:
        return None
    name = value.strip().lower()
    return name if name in VARIANTS else None


def thumbnail_path(project_dir: Path, source: Path, variant: str) -> Optional[Path]:
    """Map a source file to its cache location, or ``None`` if out of scope."""

    try:
        rel = source.resolve().relative_to(project_dir.resolve())
    except (OSError, ValueError):
        return None
    # Never thumbnail a thumbnail — that would nest caches on every request.
    if rel.parts and rel.parts[0] == THUMB_ROOT:
        return None
    # Suffix is appended rather than replaced so `a.png` and `a.jpg` cannot
    # collide on a shared `a.webp`.
    return project_dir / THUMB_ROOT / variant / rel.with_name(rel.name + ".webp")


def is_thumbnailable(source: Path) -> bool:
    return source.suffix.lower() in _SUPPORTED_SUFFIXES


def ensure_thumbnail(
    project_dir: Path, source: Path, variant: str | None
) -> Optional[Path]:
    """Return a current thumbnail for ``source``, building it if needed.

    Returns ``None`` whenever the caller should serve the original instead:
    unknown variant, unsupported or oversized source, animated image, or any
    decode/encode failure. Blocking and CPU-bound — call it off the event
    loop.
    """

    name = normalize_variant(variant)
    if name is None:
        return None
    max_edge = VARIANTS[name]

    try:
        if not is_thumbnailable(source):
            return None
        dest = thumbnail_path(project_dir, source, name)
        if dest is None:
            return None
        stat = source.stat()
        if stat.st_size > _MAX_SOURCE_BYTES:
            return None
        source_mtime_ns = stat.st_mtime_ns

        if _is_current(dest, source_mtime_ns):
            return dest
        with _stripe_for(dest):
            # Re-check under the lock: whoever we queued behind may have just
            # written exactly the file we were about to render.
            if _is_current(dest, source_mtime_ns):
                return dest
            with _render_slots:
                return _render(source, dest, max_edge, source_mtime_ns)
    except Exception:
        logger.debug("thumbnail skipped for %s (%s)", source, variant, exc_info=True)
        return None


def fresh_thumbnail(
    project_dir: Path, source: Path, variant: str | None
) -> Optional[Path]:
    """Return an already-current variant for ``source``. Never builds one.

    This is the request path's entry point, and the reason it does not build is
    where the bytes live. Serving a request *without* a variant is a 302 to a
    presigned OSS URL — the original never travels through this process. The
    moment we build on demand we have to read and decode that original locally
    instead, so a cold canvas of 200 nodes would pull every full-resolution
    source over the ossfs mount just to hand back a smaller copy of it. That is
    a worse first visit than the one variants were introduced to fix.

    So a miss falls back to the redirect and queues the build for next time: a
    cold project behaves exactly as it did before variants existed, and warms
    itself up as it is used. Variants can only ever be an improvement, which is
    also what makes the offline backfill purely optional.

    Cheap enough to call on the event loop — two stats, fewer than the path
    resolution the caller already did to get here.
    """

    name = normalize_variant(variant)
    if name is None:
        return None
    try:
        dest = thumbnail_path(project_dir, source, name)
        if dest is None:
            return None
        return dest if _is_current(dest, source.stat().st_mtime_ns) else None
    except OSError:
        return None


def _is_current(dest: Path, source_mtime_ns: int) -> bool:
    try:
        return dest.stat().st_mtime_ns == source_mtime_ns
    except OSError:
        return False


def _render(
    source: Path, dest: Path, max_edge: int, source_mtime_ns: int
) -> Optional[Path]:
    from PIL import Image, ImageOps

    with Image.open(source) as opened:
        if getattr(opened, "is_animated", False):
            return None

        # Everything from here to `thumbnail` is decided on the header alone.
        # `Image.open` is lazy, so `.size` is known before a single pixel is
        # read, and both of the decisions below are answers we can give without
        # reading any — which matters because the very next call is the one that
        # allocates the full bitmap.
        width, height = opened.size
        if width <= 0 or height <= 0:
            return None
        if width * height > _MAX_SOURCE_PIXELS:
            return None
        # Nothing to gain once the source already fits: `thumbnail` would be a
        # no-op and we would spend a decode and a write to hand back a
        # re-encoded copy that can come out *larger* than the original. The
        # history strip and the LOD shell ask for `thumb` unconditionally, so
        # small sources reach this constantly — which is exactly why the check
        # belongs above the decode rather than below it. `None` means "serve the
        # original", which is right here. Orientation cannot change the verdict:
        # a transpose swaps the two numbers and `max` is blind to that.
        if max(width, height) <= max_edge:
            return None

        # No-op for everything but JPEG, where it lets libjpeg decode at a
        # reduced scale — most of the win on the formats that support it.
        opened.draft("RGB", (max_edge, max_edge))
        # A browser applies the EXIF orientation tag when it paints the
        # original, so a phone photo the user sees upright is stored rotated.
        # Bake the rotation in, or the variant stands in for the original while
        # disagreeing with it — the node shows the photo sideways and the
        # fullscreen viewer (always the original) snaps it upright. Both other
        # resize paths in the codebase do this: media_relay.py and the freezone
        # crop route.
        im = ImageOps.exif_transpose(opened) or opened
        try:
            im.thumbnail((max_edge, max_edge), Image.LANCZOS)
            has_alpha = im.mode in {"RGBA", "LA"} or (
                im.mode == "P" and "transparency" in im.info
            )
            out = im.convert("RGBA" if has_alpha else "RGB")
        finally:
            # exif_transpose returns a new image when it rotates; closing the
            # original's context does not cover it.
            if im is not opened:
                im.close()

    dest.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename so a concurrent reader never opens a partial file.
    tmp = dest.with_name(f"{dest.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        out.save(tmp, "WEBP", quality=_WEBP_QUALITY, method=_WEBP_METHOD)
        # Stamp the source's mtime onto the variant; that equality *is* the
        # freshness check, and it closes the race where the source is
        # rewritten while we render.
        os.utime(tmp, ns=(source_mtime_ns, source_mtime_ns))
        os.replace(tmp, dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return dest


# --- background prewarm ---------------------------------------------------
#
# Two feeders. A generation runner knows a file's final bytes the moment it
# writes them, and that is the cheapest moment to build its variants: the source
# is still in the page cache and nobody is waiting on the result. The read path
# feeds it too, because ``fresh_thumbnail`` deliberately refuses to build on a
# miss -- the request is served from OSS and the build happens here instead.
#
# Nothing may ever pay for this, least of all a request handler, hence a bounded
# queue that drops rather than blocks when saturated. A drop only means the next
# visit is cold again.

# These are the only renderers in a serving process now that the read path never
# builds, and they share the process-wide decode budget regardless, so matching
# it exactly is what keeps that budget reachable.
_PREWARM_WORKERS = DEFAULT_RENDER_CONCURRENCY
_PREWARM_QUEUE_SIZE = 512

_PrewarmJob = tuple[Path, Path, str]

# The read path queues on every miss, so one paint of a cold canvas offers the
# same job once per visible node -- and again on the next paint, since nothing
# is current yet. Without this, a single canvas load would pack the queue with
# copies of a handful of jobs and drop the genuinely distinct ones. Keyed on the
# strings rather than resolved paths so queueing stays syscall-free; a dedup
# missed that way only costs one redundant job.
_PrewarmKey = tuple[str, str, str]
_prewarm_inflight: set[_PrewarmKey] = set()
_prewarm_inflight_lock = threading.Lock()

_prewarm_lock = threading.Lock()
_prewarm_queue: Optional["queue.Queue[_PrewarmJob]"] = None
_prewarm_pid: Optional[int] = None


def _prewarm_worker(work: "queue.Queue[_PrewarmJob]") -> None:
    while True:
        project_dir, source, variant = work.get()
        try:
            ensure_thumbnail(project_dir, source, variant)
        except Exception:  # ensure_thumbnail swallows its own; belt and braces
            logger.debug("prewarm failed for %s (%s)", source, variant, exc_info=True)
        finally:
            with _prewarm_inflight_lock:
                _prewarm_inflight.discard((str(project_dir), str(source), variant))
            work.task_done()


def _prewarm_channel() -> "queue.Queue[_PrewarmJob]":
    """Lazily start the workers, once per process.

    Started on first use rather than at import so a pre-fork parent (Celery's
    default pool) never hands dead thread objects to its children; the pid
    check re-creates the queue inside whichever process actually prewarms.
    """

    global _prewarm_queue, _prewarm_pid
    pid = os.getpid()
    with _prewarm_lock:
        if _prewarm_queue is not None and _prewarm_pid == pid:
            return _prewarm_queue
        with _prewarm_inflight_lock:
            _prewarm_inflight.clear()
        work: "queue.Queue[_PrewarmJob]" = queue.Queue(_PREWARM_QUEUE_SIZE)
        for index in range(_PREWARM_WORKERS):
            threading.Thread(
                target=_prewarm_worker,
                args=(work,),
                name=f"thumb-prewarm-{index}",
                daemon=True,
            ).start()
        _prewarm_queue = work
        _prewarm_pid = pid
        return work


def prewarm(
    project_dir: Path, source: Path, variants: Iterable[str] | None = None
) -> int:
    """Queue variant generation for ``source``. Never blocks, never raises.

    Returns how many jobs were accepted, which is 0 when the source is not an
    image, when the queue is saturated, or when an identical job is already in
    flight. A rejected job is not an error: the variant simply stays cold and
    the next request serves the original, exactly as it does today. Defaults to
    every known variant so a newly added one is prewarmed without revisiting
    the call sites.
    """

    try:
        if not is_thumbnailable(source):
            return 0
        work = _prewarm_channel()
        queued = 0
        for variant in VARIANTS if variants is None else variants:
            name = normalize_variant(variant)
            if name is None:
                continue
            key = (str(project_dir), str(source), name)
            with _prewarm_inflight_lock:
                if key in _prewarm_inflight:
                    continue
                _prewarm_inflight.add(key)
            try:
                work.put_nowait((project_dir, source, name))
            except queue.Full:
                with _prewarm_inflight_lock:
                    _prewarm_inflight.discard(key)
                logger.debug("prewarm queue full, dropping %s (%s)", source, name)
                continue
            queued += 1
        return queued
    except Exception:
        logger.debug("prewarm skipped for %s", source, exc_info=True)
        return 0
