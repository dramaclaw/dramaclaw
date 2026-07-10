"""Static asset URL helpers shared by API, services, and UI layers."""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Union
from urllib.parse import quote


def _prefer_sog_static_package(
    relative_path: str,
    local_path: Optional[Union[str, Path]],
) -> tuple[str, Path | None]:
    """Prefer same-name SOG packages for public static 3GS URLs.

    Historical data often stores `master_sharp.ply` / `reverse_sharp.ply`.
    The browser should load the compressed SOG sidecar whenever it exists so
    PlayCanvas uses the lightweight gsplat package instead of raw PLY.
    """
    rel = str(relative_path).replace("\\", "/").lstrip("/")
    if not local_path:
        return rel, None

    file_path = Path(local_path)
    if file_path.suffix.lower() == ".ply":
        sog_path = file_path.with_suffix(".sog")
        if sog_path.exists():
            return str(Path(rel).with_suffix(".sog")).replace("\\", "/"), sog_path

    return rel, file_path


def project_static_url(
    project_id: str,
    relative_path: str,
    local_path: Optional[Union[str, Path]] = None,
) -> str:
    """Build the canonical protected project static URL.

    The public path is project-id based so shared users do not depend on the
    owner's username/project slug. OpenResty protects and caches this URL, then
    forwards cache misses to the internal project media resolver.
    """
    rel_path, file_path = _prefer_sog_static_package(relative_path, local_path)

    safe_project = quote(str(project_id).strip(), safe="")
    rel = quote(rel_path, safe="/")
    base = f"/static/projects/{safe_project}/{rel}"
    if file_path is not None and file_path.exists():
        return f"{base}?v={file_path.stat().st_mtime_ns}"
    return base


__all__ = ["project_static_url"]
