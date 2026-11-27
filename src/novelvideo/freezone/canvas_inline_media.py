# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Canvas media fields hold file addresses, never inline ``data:`` payloads.

The browser strips these before every save (``canvasSyncCore.ts``); a save that
still carries one is rejected so the payload never reaches the canvas store.
"""

from __future__ import annotations

import re
from typing import Any

INLINE_MEDIA_FIELDS = ("imageUrl", "videoUrl", "audioUrl", "previewImageUrl")
_INLINE_DATA_RE = re.compile(r"^\s*data:", re.IGNORECASE)


def inline_media_fields(nodes: Any) -> list[dict[str, str]]:
    """List node media fields holding an inline ``data:`` URL, in node then field order."""
    found: list[dict[str, str]] = []
    for node in nodes if isinstance(nodes, list) else []:
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict):
            continue
        node_id = str(node.get("id") or "")
        found.extend({"node_id": node_id, "field": field} for field in _inline_fields(data))
        frames = data.get("frames")
        for index, frame in enumerate(frames if isinstance(frames, list) else []):
            if isinstance(frame, dict):
                found.extend(
                    {"node_id": node_id, "field": f"frames[{index}].{field}"}
                    for field in _inline_fields(frame)
                )
    return found


def _inline_fields(record: dict[str, Any]) -> list[str]:
    return [
        field
        for field in INLINE_MEDIA_FIELDS
        if isinstance(record.get(field), str) and _INLINE_DATA_RE.match(record[field])
    ]
