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
a variant, and old data benefits on first request without any backfill.
Freshness is exact rather than heuristic: a generated variant is stamped
with its source's mtime, so ``thumb.mtime == source.mtime`` means current
and a regenerated source invalidates automatically without leaving stale
files behind.

Every failure path returns ``None`` so the caller falls back to the
original. A slow node beats a broken one.
"""

from __future__ import annotations

import asyncio
import logging
import os
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
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

# Anything larger is served as-is. Pillow's own decompression-bomb guard
# covers pixel counts; this covers the file-size side (a 200MB TIFF would
# otherwise pin a worker thread and a few GB of RAM).
_MAX_SOURCE_BYTES = 64 * 1024 * 1024

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

# --- where an HTTP render runs --------------------------------------------
#
# A render must not run on Starlette's shared threadpool. That pool is ~40
# threads for the whole app, and ``ensure_thumbnail`` blocks on the semaphore
# above: 40 concurrent cold thumbnails would take 40 of those threads, run four
# of them, and leave 36 parked on the semaphore while every other blocking call
# in the process waits behind them. That is precisely the starvation the
# semaphore exists to prevent, just moved one layer out.
#
# A dedicated executor makes the bound structural. Excess work waits in this
# executor's own queue instead of holding a thread that something else needs.

_render_pool: Optional["ThreadPoolExecutor"] = None
_render_pool_pid: Optional[int] = None
_render_pool_lock = threading.Lock()


def _render_pool_for_requests() -> "ThreadPoolExecutor":
    """Lazily create the HTTP render pool, once per process (see prewarm)."""

    global _render_pool, _render_pool_pid
    pid = os.getpid()
    with _render_pool_lock:
        if _render_pool is not None and _render_pool_pid == pid:
            return _render_pool
        _render_pool = ThreadPoolExecutor(
            max_workers=DEFAULT_RENDER_CONCURRENCY,
            thread_name_prefix="thumb-render",
        )
        _render_pool_pid = pid
        return _render_pool


async def ensure_thumbnail_async(
    project_dir: Path, source: Path, variant: str | None
) -> Optional[Path]:
    """``ensure_thumbnail`` off the event loop, on the render pool.

    The entry point for request handlers. Same contract as the sync version,
    including ``None`` meaning "serve the original".
    """

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _render_pool_for_requests(), ensure_thumbnail, project_dir, source, variant
    )


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
            # Nothing to gain once the source already fits: `thumbnail` would be
            # a no-op and we would spend a decode and a write to hand back a
            # re-encoded copy that can come out *larger* than the original. The
            # history strip and the LOD shell ask for `thumb` unconditionally,
            # so small sources reach this constantly. `None` means "serve the
            # original", which is exactly right here.
            if max(im.size) <= max_edge:
                return None
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
# A generation runner knows a file's final bytes the moment it writes them,
# and that is the cheapest moment to build its variants: the source is still
# in the page cache and nobody is waiting on the result. Prewarming is
# strictly an optimization over the read path -- every miss still falls back
# to ``ensure_thumbnail`` on first request -- so it is fire-and-forget. No
# caller may pay for it, least of all an async request handler, hence a
# bounded queue that drops rather than blocks when saturated.

_PREWARM_WORKERS = 2
_PREWARM_QUEUE_SIZE = 512

_PrewarmJob = tuple[Path, Path, str]

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

    Returns how many jobs were accepted: 0 when the source is not an image or
    the queue is saturated, in which case the read path builds the variant on
    first request instead. Defaults to every known variant so a newly added
    one is prewarmed without revisiting the call sites.
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
            try:
                work.put_nowait((project_dir, source, name))
            except queue.Full:
                logger.debug("prewarm queue full, dropping %s (%s)", source, name)
                continue
            queued += 1
        return queued
    except Exception:
        logger.debug("prewarm skipped for %s", source, exc_info=True)
        return 0
