"""Canonical novel-source prerequisite checks."""

from __future__ import annotations

from pathlib import Path


NOVEL_IMPORT_REQUIRED_MESSAGE = "请先导入小说"
NOVEL_IMPORT_REQUIRED_CODE = "NOVEL_IMPORT_REQUIRED"


class NovelImportRequiredError(ValueError):
    error_code = NOVEL_IMPORT_REQUIRED_CODE

    def __init__(self) -> None:
        super().__init__(NOVEL_IMPORT_REQUIRED_MESSAGE)


def novel_import_required_response() -> dict[str, str | bool]:
    return {
        "ok": False,
        "code": NOVEL_IMPORT_REQUIRED_CODE,
        "error": NOVEL_IMPORT_REQUIRED_MESSAGE,
    }


def load_imported_novel_content(project_dir: str | Path) -> str | None:
    novel_path = Path(project_dir) / "novel.txt"
    if not novel_path.exists():
        return None
    return novel_path.read_text(encoding="utf-8")


def has_imported_novel(project_dir: str | Path) -> bool:
    content = load_imported_novel_content(project_dir)
    return bool(content and content.strip())


def require_imported_novel(project_dir: str | Path) -> str:
    content = load_imported_novel_content(project_dir)
    if not content or not content.strip():
        raise NovelImportRequiredError()
    return content


def resolve_uploaded_novel_filename(
    project_dir: str | Path,
    imported_content: str,
    *,
    preferred_filename: str | None = None,
) -> str | None:
    """Resolve the upload that produced the durable imported novel.

    New projects persist the exact filename in project_config. For historical
    projects, compare parsed upload content with novel.txt and choose the newest
    exact match.
    """
    from novelvideo.utils.document_parsers import (
        is_supported_novel_path,
        load_novel_text,
    )

    uploads_dir = Path(project_dir) / "uploads"
    if not uploads_dir.is_dir():
        return None

    def valid_candidate(filename: str | None) -> Path | None:
        if not filename or Path(filename).name != filename:
            return None
        candidate = uploads_dir / filename
        if not candidate.is_file() or not is_supported_novel_path(candidate):
            return None
        return candidate

    preferred = valid_candidate(preferred_filename)
    if preferred is not None:
        return preferred.name

    candidates = sorted(
        (
            path
            for path in uploads_dir.iterdir()
            if path.is_file() and is_supported_novel_path(path)
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        try:
            if load_novel_text(candidate) == imported_content:
                return candidate.name
        except Exception:
            continue
    return None
