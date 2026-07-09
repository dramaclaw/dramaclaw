"""In-memory canvas URL migration helpers."""

from __future__ import annotations

import re

from copy import deepcopy
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

URL_FIELD_NAMES = {
    "audio_url",
    "audioUrl",
    "base_url",
    "cell_url",
    "committed_slot_url",
    "coverUrl",
    "custom_scene_url",
    "downloadUrl",
    "fileUrl",
    "frame_url",
    "grid_url",
    "imageUrl",
    "mask_url",
    "mediaUrl",
    "master_url",
    "masterUrl",
    "modelUrl",
    "muteVideoUrl",
    "mute_video_url",
    "output_url",
    "pano_360_url",
    "pano360Url",
    "panoUrl",
    "plyUrl",
    "ply_path",
    "ply_url",
    "portrait_url",
    "previewImageUrl",
    "previewVideoUrl",
    "reference_url",
    "referenceImageUrl",
    "reverse_url",
    "reverseUrl",
    "scene_url",
    "sketch_url",
    "source_url",
    "sourceUrl",
    "sog_path",
    "target_url",
    "thumbnailUrl",
    "thumbUrl",
    "url",
    "videoUrl",
    "video_url",
}


def _is_url_field_name(key: str | None) -> bool:
    if not key:
        return False
    return (
        key in URL_FIELD_NAMES or key.endswith("_url") or key.endswith("Url") or key.endswith("URL")
    )


def _rewrite_legacy_project_static_url(
    value: str,
    *,
    project_id: str,
    project_name: str,
    owner_aliases: set[str],
) -> str:
    if not value.startswith("/static/"):
        return value

    parsed = urlsplit(value)
    parts = parsed.path.split("/", 4)
    if len(parts) < 5 or parts[1] != "static":
        return value

    owner = unquote(parts[2])
    project = unquote(parts[3])
    if owner not in owner_aliases or project != project_name:
        return value

    rel_path = parts[4].lstrip("/")
    canonical_path = (
        f"/static/projects/{quote(project_id, safe='')}/{quote(unquote(rel_path), safe='/')}"
    )
    return urlunsplit(("", "", canonical_path, parsed.query, parsed.fragment))


def _prefer_sog_project_static_url(value: str, *, project_dir: Path | None) -> str:
    if project_dir is None:
        return value
    if not value.startswith("/static/projects/"):
        return value

    parsed = urlsplit(value)
    parts = parsed.path.split("/", 4)
    if len(parts) < 5 or parts[1] != "static" or parts[2] != "projects":
        return value

    rel_path = unquote(parts[4].lstrip("/"))
    candidate = (project_dir / rel_path).resolve()
    project_resolved = project_dir.resolve()
    try:
        candidate.relative_to(project_resolved)
    except ValueError:
        return value

    if candidate.suffix.lower() != ".ply":
        return value
    sog_candidate = candidate.with_suffix(".sog")
    if not sog_candidate.exists():
        return value

    sog_rel = sog_candidate.relative_to(project_resolved).as_posix()
    canonical_path = (
        f"/static/projects/{quote(unquote(parts[3]), safe='')}/{quote(sog_rel, safe='/')}"
    )
    return urlunsplit(
        ("", "", canonical_path, f"v={sog_candidate.stat().st_mtime_ns}", parsed.fragment)
    )


def _rewrite_local_project_path_url(
    value: str,
    *,
    project_id: str,
    project_dir: Path | None,
) -> str:
    if project_dir is None:
        return value
    if "://" in value or value.startswith(("/static/", "/api/")):
        return value

    try:
        path = Path(value).expanduser()
    except (OSError, RuntimeError, ValueError):
        return value
    if not path.is_absolute():
        return value

    project_resolved = project_dir.resolve()
    try:
        resolved = path.resolve(strict=False)
        rel_path = resolved.relative_to(project_resolved).as_posix()
    except (OSError, RuntimeError, ValueError):
        return value

    candidate = resolved
    if candidate.suffix.lower() == ".ply":
        sog_candidate = candidate.with_suffix(".sog")
        if sog_candidate.exists():
            candidate = sog_candidate
            rel_path = sog_candidate.relative_to(project_resolved).as_posix()

    canonical_path = f"/static/projects/{quote(project_id, safe='')}/{quote(rel_path, safe='/')}"
    query = ""
    try:
        if candidate.exists():
            query = f"v={candidate.stat().st_mtime_ns}"
    except OSError:
        query = ""
    return urlunsplit(("", "", canonical_path, query, ""))


def migrate_canvas_static_urls_in_memory(
    payload: dict | None,
    *,
    project_id: str,
    owner_username: str,
    project_name: str,
    owner_aliases: set[str] | None = None,
    project_dir: Path | None = None,
) -> dict | None:
    """Return a copy of a canvas payload with legacy project static URLs rewritten.

    This is intentionally read-only: callers must not write the migrated payload
    during canvas load. The next user-initiated save will naturally persist the
    canonical URLs under normal revision control.
    """
    if payload is None:
        return None
    aliases = {owner_username}
    if owner_aliases:
        aliases.update(alias for alias in owner_aliases if alias)

    def visit(value, *, key: str | None = None):
        if isinstance(value, dict):
            return {
                str(child_key): visit(child_value, key=str(child_key))
                for child_key, child_value in value.items()
            }
        if isinstance(value, list):
            return [visit(item, key=key) for item in value]
        if isinstance(value, str) and _is_url_field_name(key):
            canonical = _rewrite_local_project_path_url(
                value,
                project_id=project_id,
                project_dir=project_dir,
            )
            canonical = (
                _rewrite_legacy_project_static_url(
                    value,
                    project_id=project_id,
                    project_name=project_name,
                    owner_aliases=aliases,
                )
                if canonical == value
                else canonical
            )
            return _prefer_sog_project_static_url(canonical, project_dir=project_dir)
        return value

    return visit(deepcopy(payload))


def sanitize_project_local_paths_in_memory(
    payload: dict | list | None,
    *,
    project_id: str,
    project_dir: Path | None,
) -> dict | list | None:
    """Return a copy with local project path prefixes replaced for public APIs."""
    if payload is None or project_dir is None:
        return payload

    try:
        project_resolved = project_dir.resolve()
    except (OSError, RuntimeError):
        project_resolved = project_dir
    # Windows 上同一个目录会以 `C:\x` 与 `C:/x` 两种写法出现在历史数据里,
    # 前缀集合必须同时覆盖,否则只替换得掉其中一种。
    prefix_candidates = {
        str(project_dir),
        str(project_resolved),
        project_dir.as_posix(),
        project_resolved.as_posix(),
    }
    prefixes = sorted(
        (value.rstrip("/\\") for value in prefix_candidates if value),
        key=len,
        reverse=True,
    )
    if not prefixes:
        return deepcopy(payload)

    static_prefix = f"/static/projects/{quote(project_id, safe='')}"

    # 只归一紧随替换前缀的路径 token(至引号/空白/分隔符止),
    # 不碰同一字符串里的无关反斜杠(用户文本、其他盘符路径)。
    tail_re = re.compile(re.escape(static_prefix) + r"[^\s\"'|?#]*")

    def _posixify_token(match: "re.Match[str]") -> str:
        return match.group(0).replace("\\\\", "/").replace("\\", "/")

    def replace_text(text: str) -> str:
        sanitized = text
        for prefix in prefixes:
            sanitized = sanitized.replace(prefix, static_prefix)
        if sanitized != text and "\\" in sanitized:
            sanitized = tail_re.sub(_posixify_token, sanitized)
        return sanitized

    def visit(value):
        if isinstance(value, dict):
            return {str(child_key): visit(child_value) for child_key, child_value in value.items()}
        if isinstance(value, list):
            return [visit(item) for item in value]
        if isinstance(value, str):
            return replace_text(value)
        return value

    return visit(deepcopy(payload))
