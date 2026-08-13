"""Queue naming helpers shared by task backends."""

from __future__ import annotations

QUEUE_KINDS = {"default", "video", "world", "ffmpeg"}


def normalize_queue_kind(kind: str | None) -> str:
    """Normalize a lane name, rejecting unknown ones instead of falling back.

    A misspelled lane used to land silently in ``default``. Once lanes carry
    their own quotas that fallback hides the mistake instead of reporting it,
    so an unknown lane is now a hard error.

    An absent lane (``None`` or blank) still means ``default`` — that is what
    "no lane given" has always meant here, and it is not a misspelling.
    """
    value = (kind or "default").strip().lower() or "default"
    if value not in QUEUE_KINDS:
        raise ValueError(f"unknown queue kind: {kind!r}")
    return value


def queue_name(home_node_id: str, kind: str | None = None) -> str:
    lane = normalize_queue_kind(kind)
    safe_node = str(home_node_id or "local").replace(":", "_").replace("/", "_")
    safe_lane = lane.replace(":", "_").replace("/", "_")
    return f"node.{safe_node}.{safe_lane}"
