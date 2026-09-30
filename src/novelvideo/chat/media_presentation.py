"""Canonical media links and duplicate filtering for chat messages."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from novelvideo.utils.static_urls import project_static_url

_MEDIA_EXTENSIONS = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".gif": "image",
    ".mp4": "video",
    ".mov": "video",
    ".webm": "video",
    ".wav": "audio",
    ".mp3": "audio",
    ".m4a": "audio",
}
_URL_RE = re.compile(r"(https?://[^\s)>\"]+|/static/[^\s)>\"]+)")
_REL_PATH_RE = re.compile(
    r"(?P<path>(?:assets|videos|audio|images|frames|sketches|grids|uploads|scripts)/[^\s)>\"]+\.(?:png|jpg|jpeg|webp|gif|mp4|mov|webm|wav|mp3|m4a))"
)
_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def _media_path_from_static_url(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path if parsed.scheme in {"http", "https"} else url.split("?", 1)[0]
    if not path.startswith("/static/"):
        return None
    rel = path[len("/static/") :]
    parts = rel.split("/", 2)
    if len(parts) == 3:
        return unquote(parts[2])
    return unquote(rel)


def _canonical_project_static_media_url(
    project_id: str,
    project_dir: Path,
    url_or_path: str,
) -> tuple[str, str] | None:
    media_path = _media_path_from_static_url(url_or_path)
    if media_path is None:
        media_path = url_or_path.strip().split("?", 1)[0].lstrip("./")
    if not media_path:
        return None
    local_path = project_dir / media_path
    return project_static_url(project_id, media_path, local_path=local_path), media_path


def _extract_media(
    content: str,
    project: str,
    media_project_dir: Path,
) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    markdown_images = _collect_markdown_image_refs(content)

    def add_item(raw_url: str, path: str | None = None) -> None:
        candidate = raw_url.strip(".,;)]}")
        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            candidate = parsed.path
        if candidate.startswith("/static/"):
            canonical = _canonical_project_static_media_url(
                project, media_project_dir, candidate
            )
            if canonical is None:
                return
            candidate, path = canonical
        ext = Path(urlparse(candidate).path).suffix.lower()
        kind = _MEDIA_EXTENSIONS.get(ext)
        if not kind:
            return
        if kind == "image" and (
            candidate in markdown_images
            or (path and path in markdown_images)
            or (path and path.lstrip("./") in markdown_images)
        ):
            return
        effective_path = path or ""
        if not effective_path:
            effective_path = _media_path_from_static_url(candidate) or ""
        key = f"{kind}:{effective_path or candidate}"
        if key in seen:
            return
        seen.add(key)
        items.append(
            {
                "kind": kind,
                "url": candidate,
                "path": effective_path,
                "label": Path(effective_path or candidate).name,
            }
        )

    for match in _URL_RE.finditer(content):
        url = match.group(1)
        if url.startswith("/static/"):
            add_item(url)
        else:
            add_item(url)

    for match in _REL_PATH_RE.finditer(content):
        rel_path = match.group("path")
        full_path = media_project_dir / rel_path
        if full_path.exists():
            static_url = project_static_url(project, rel_path, local_path=full_path)
            add_item(static_url, rel_path)

    return items


def _collect_markdown_image_refs(content: str) -> set[str]:
    refs: set[str] = set()

    for match in _MARKDOWN_IMAGE_RE.finditer(content):
        raw = (match.group(1) or "").strip().strip("<>").strip(".,;)]}")
        if not raw:
            continue
        refs.add(raw)
        parsed = urlparse(raw)
        path = (
            parsed.path if parsed.scheme in {"http", "https"} else raw.split("?", 1)[0]
        )
        if path:
            refs.add(path)
        static_path = _media_path_from_static_url(raw)
        if static_path:
            refs.add(static_path)
            refs.add(static_path.lstrip("./"))
        elif parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            refs.add(parsed.path)
        elif raw.startswith("/static/"):
            refs.add(raw.split("?", 1)[0])
        else:
            refs.add(path.lstrip("./") if path else raw.lstrip("./"))

    return refs


def _normalize_media_items(
    media: list[dict[str, Any]],
    project: str,
    media_project_dir: Path,
) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()

    for item in media:
        if not isinstance(item, dict):
            continue

        candidate = str(item.get("url", "") or "").strip()
        path = str(item.get("path", "") or "").strip()
        if not candidate and not path:
            continue

        if not candidate and path:
            canonical = _canonical_project_static_media_url(
                project, media_project_dir, path
            )
            if canonical is None:
                continue
            candidate, path = canonical

        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            candidate = parsed.path
        if candidate.startswith("/static/"):
            canonical = _canonical_project_static_media_url(
                project, media_project_dir, candidate
            )
            if canonical is None:
                continue
            candidate, path = canonical

        ext = Path(urlparse(candidate).path).suffix.lower()
        kind = _MEDIA_EXTENSIONS.get(ext)
        if not kind:
            continue

        if not path:
            path = _media_path_from_static_url(candidate) or ""

        key = f"{kind}:{path or candidate}"
        if key in seen:
            continue
        seen.add(key)

        normalized.append(
            {
                "kind": kind,
                "url": candidate,
                "path": path,
                "label": str(item.get("label", "") or Path(path or candidate).name),
            }
        )

    return normalized


def _merge_media_items(*groups: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    seen: set[str] = set()

    for group in groups:
        for item in group:
            kind = str(item.get("kind", "") or "").strip()
            url = str(item.get("url", "") or "").strip()
            path = str(item.get("path", "") or "").strip()
            if not kind or not url:
                continue
            key = f"{kind}:{path or url}"
            if key in seen:
                continue
            seen.add(key)
            merged.append(
                {
                    "kind": kind,
                    "url": url,
                    "path": path,
                    "label": str(item.get("label", "") or Path(path or url).name),
                }
            )

    return merged


def _filter_markdown_duplicate_images(
    content: str, media: list[dict[str, str]]
) -> list[dict[str, str]]:
    markdown_images = _collect_markdown_image_refs(content)
    if not markdown_images:
        return media

    filtered: list[dict[str, str]] = []
    for item in media:
        kind = str(item.get("kind", "") or "").strip()
        if kind != "image":
            filtered.append(item)
            continue

        url = str(item.get("url", "") or "").strip()
        path = str(item.get("path", "") or "").strip()
        if (
            url in markdown_images
            or (path and path in markdown_images)
            or (path and path.lstrip("./") in markdown_images)
        ):
            continue
        filtered.append(item)

    return filtered
