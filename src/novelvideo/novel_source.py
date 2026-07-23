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
