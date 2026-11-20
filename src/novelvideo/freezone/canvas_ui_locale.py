# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Persist the project's last-seen canvas UI language."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import tempfile

logger = logging.getLogger(__name__)
_UI_LOCALE_RE = re.compile(r"[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*")


def valid_ui_locale(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if len(value) <= 35 and _UI_LOCALE_RE.fullmatch(value):
        return value
    return None


def recorded_ui_locale(project_dir: Path) -> str | None:
    try:
        data = json.loads((Path(project_dir) / "freezone" / "ui_locale.json").read_text(
            encoding="utf-8",
        ))
        return valid_ui_locale(data.get("locale")) if isinstance(data, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def record_ui_locale(project_dir: Path, locale: object) -> None:
    try:
        locale = valid_ui_locale(locale)
        if locale is None or recorded_ui_locale(project_dir) == locale:
            return
        path = Path(project_dir) / "freezone" / "ui_locale.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=path.parent,
                prefix=".ui_locale-", suffix=".tmp", delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                json.dump({"locale": locale}, temporary)
            os.replace(temporary_path, path)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
    except Exception as exc:
        logger.warning("Canvas UI locale not recorded (%s)", type(exc).__name__)
