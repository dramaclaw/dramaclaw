"""Shared project directory conventions for CE and EE registries."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from pypinyin import lazy_pinyin


def project_directory_name(project_name: str) -> str:
    """Keep new directory names portable without changing the display name.

    Call only when creating a project: existing records may use different
    spellings or directories and must always retain their stored paths.
    """
    normalized = unicodedata.normalize("NFKC", project_name)
    parts = lazy_pinyin(normalized) if not normalized.isascii() else [normalized]
    # Rare characters absent from the pronunciation dictionary keep a stable
    # ASCII code point instead of disappearing from the directory name.
    romanized = "_".join(
        "".join(
            char if char.isascii() else f"_u{ord(char):x}_" if char.isalnum() else "_"
            for char in part
        )
        for part in parts
    )
    if re.fullmatch(r"[a-zA-Z0-9_]+", project_name):
        name = project_name
    else:
        name = re.sub(r"[^a-zA-Z0-9]+", "_", romanized).strip("_") or "project"
    if re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", name, re.IGNORECASE):
        name = f"project_{name}"
    return name[:64]


def default_project_dirs(owner_username: str, project_name: str) -> tuple[str, str, str]:
    from novelvideo import config

    return (
        str((Path(config.OUTPUT_DIR) / owner_username / project_name).resolve()),
        str((Path(config.STATE_DIR) / owner_username / project_name).resolve()),
        str((Path(config.RUNTIME_DIR) / owner_username / project_name).resolve()),
    )
