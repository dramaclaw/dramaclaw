"""Reference images a chat turn hands the agent model as image input.

Canvas image nodes the user references in a message otherwise reach the agent
only as a link, which it cannot open. Codex accepts image data URLs as turn
input, so the referenced images go along with the prompt and the agent can
actually look at them (for example to block out a previz scene from a photo).
"""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from novelvideo.freezone.paths import resolve_static_url_to_path

logger = logging.getLogger(__name__)

# Gate for gateways whose Responses API cannot carry images yet: a rejected
# image stays in the Codex thread history and would fail every later turn.
CODEX_IMAGE_INPUT_ENV = "CODEX_IMAGE_INPUT"
MAX_TURN_IMAGES = 4
_CANVAS_NODE_REFERENCE_TYPE = "canvas_node_reference"
_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})


def codex_image_input_enabled() -> bool:
    raw = os.environ.get(CODEX_IMAGE_INPUT_ENV, "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def referenced_image_paths(
    attachments: Iterable[Mapping[str, Any]], project_dir: Path
) -> list[Path]:
    """Local files of the image nodes referenced by this turn, at most four."""

    paths: list[Path] = []
    for attachment in attachments:
        if attachment.get("type") != _CANVAS_NODE_REFERENCE_TYPE:
            continue
        try:
            payload = json.loads(str(attachment.get("content") or ""))
        except ValueError:
            continue
        nodes = payload.get("nodes") if isinstance(payload, dict) else None
        for node in nodes if isinstance(nodes, list) else []:
            if not isinstance(node, dict) or node.get("media_type") != "image":
                continue
            source_url = str(node.get("source_url") or "").strip()
            if not source_url:
                continue
            try:
                path = resolve_static_url_to_path(source_url, project_dir)
            except ValueError:
                continue
            if path.suffix.lower() not in _IMAGE_SUFFIXES or not path.is_file():
                continue
            if path not in paths:
                paths.append(path)
            if len(paths) >= MAX_TURN_IMAGES:
                return paths
    return paths


async def image_data_urls(paths: Sequence[Path]) -> list[str]:
    """Compact each image to a JPEG data URL; unreadable images are skipped."""

    from novelvideo.freezone.vision_gateway import load_compact_vision_inputs

    urls: list[str] = []
    for path in paths:
        try:
            (image,) = await load_compact_vision_inputs([path])
        except Exception:
            logger.warning("skip unreadable agent turn image: %s", path, exc_info=True)
            continue
        encoded = base64.b64encode(image.data).decode("ascii")
        urls.append(f"data:{image.media_type};base64,{encoded}")
    return urls
