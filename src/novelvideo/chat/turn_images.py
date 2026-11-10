"""Reference images a chat turn hands the agent model as image input.

Canvas image nodes the user references in a message otherwise reach the agent
only as a link, which it cannot open. Codex accepts local image paths as turn
input, so the referenced images go along with the prompt and the agent can
actually look at them (for example to block out a previz scene from a photo).

Only file paths enter the Codex thread. A compacted copy is written under the
project output and its path is sent; inline ``data:`` URLs never are, because
they would be stored in the thread and come back with every history read.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from novelvideo.freezone.paths import resolve_static_url_to_path

logger = logging.getLogger(__name__)

# Gate for gateways whose Responses API cannot carry images yet: a rejected
# image stays in the Codex thread history and would fail every later turn.
CODEX_IMAGE_INPUT_ENV = "CODEX_IMAGE_INPUT"
MAX_TURN_IMAGES = 4
# Compacted copies of turn images, under the project output directory.
TURN_IMAGE_DIRNAME = ".chat-turn-images"
CANVAS_NODE_REFERENCE_TYPE = "canvas_node_reference"
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
        if attachment.get("type") != CANVAS_NODE_REFERENCE_TYPE:
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


async def turn_image_files(paths: Sequence[Path], project_dir: Path) -> list[Path]:
    """Compact each image to a JPEG file under the output; unreadable ones are skipped.

    Files are named by content hash, so the same image reuses one file.
    """

    from novelvideo.freezone.vision_gateway import load_compact_vision_inputs

    target_dir = Path(project_dir) / TURN_IMAGE_DIRNAME
    files: list[Path] = []
    for path in paths:
        try:
            (image,) = await load_compact_vision_inputs([path])
        except Exception:
            logger.warning("skip unreadable agent turn image: %s", path, exc_info=True)
            continue
        target = target_dir / f"{hashlib.sha256(image.data).hexdigest()[:32]}.jpg"
        if not target.is_file():
            target_dir.mkdir(parents=True, exist_ok=True)
            fd, partial_name = tempfile.mkstemp(
                dir=target_dir, prefix=target.name + ".", suffix=".part"
            )
            partial = Path(partial_name)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(image.data)
                partial.replace(target)
            finally:
                partial.unlink(missing_ok=True)
        files.append(target)
    return files
