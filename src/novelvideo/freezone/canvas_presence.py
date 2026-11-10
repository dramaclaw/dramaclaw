# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Per-subscription browser heartbeats stored with project canvas state."""

from __future__ import annotations

import hashlib
import os
import re
import time
from pathlib import Path

PRESENCE_MAX_AGE_SECONDS = 60
_SUBSCRIBER_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,80}")


def _presence_dir(project_dir: Path, canvas_id: str) -> Path:
    digest = hashlib.sha256(canvas_id.encode("utf-8")).hexdigest()
    return Path(project_dir) / "freezone" / "canvas_presence" / digest


def _presence_path(project_dir: Path, canvas_id: str, subscriber_id: str) -> Path:
    if not _SUBSCRIBER_ID_RE.fullmatch(subscriber_id):
        raise ValueError("Invalid canvas presence subscriber id")
    return _presence_dir(project_dir, canvas_id) / subscriber_id


def touch_canvas_presence(
    project_dir: Path, canvas_id: str, subscriber_id: str, *, now: float | None = None,
) -> None:
    path = _presence_path(project_dir, canvas_id, subscriber_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    if now is not None:
        os.utime(path, (now, now))


def remove_canvas_presence(project_dir: Path, canvas_id: str, subscriber_id: str) -> None:
    _presence_path(project_dir, canvas_id, subscriber_id).unlink(missing_ok=True)


def canvas_browser_open(project_dir: Path, canvas_id: str, *, now: float | None = None) -> bool:
    timestamp = time.time() if now is None else now
    browser_open = False
    try:
        for record in _presence_dir(project_dir, canvas_id).iterdir():
            try:
                age = timestamp - record.stat().st_mtime
                if age > 10 * 60:
                    record.unlink(missing_ok=True)
                elif 0 <= age <= PRESENCE_MAX_AGE_SECONDS:
                    browser_open = True
            except OSError:
                # Another subscription may disappear while this scan is in progress.
                continue
    except OSError:
        pass
    return browser_open
