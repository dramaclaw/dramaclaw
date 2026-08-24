"""文件下载端点（带路径遍历防护）。"""

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from starlette.datastructures import URL

logger = logging.getLogger("novelvideo.api.files")

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import ProjectResolution, resolve_project_scope
from novelvideo.utils.thumbnails import (
    fresh_thumbnail,
    is_thumbnailable,
    normalize_variant,
    thumbnail_declined,
)

router = APIRouter()


# Cache-bust tokens the canvas appends when it knows an image's version
# (``withImageCacheBust`` in the frontend). Their presence is what makes a URL
# safe to cache for a long time.
_VERSION_PARAMS = ("st_v", "v")


def _variant_cache_control(request: Request | None) -> str:
    """Cache policy for a variant, decided by whether the URL is versioned.

    A variant is served from our own bytes rather than redirected to OSS, so we
    own its freshness. The source URL carries no content hash by itself: if the
    caller regenerates an image in place, a plain ``max-age`` would keep showing
    the old thumbnail for the whole window with no way to invalidate it. The LOD
    shell in particular requests variants with no version token at all.

    So: versioned URL -> cache hard, the URL changes when the bytes do.
    Bare URL -> revalidate, and let ``FileResponse``'s ETag/Last-Modified turn
    that into a cheap 304. Variants are stamped with their source's mtime, so
    the validator moves exactly when the source does.
    """

    params = request.query_params if request is not None else {}
    if any(params.get(name) for name in _VERSION_PARAMS):
        return "private, max-age=31536000, immutable"
    return "private, no-cache"


def _etag_matches(request: Request | None, etag: str | None) -> bool:
    """Whether the caller already holds this exact variant."""

    if request is None or not etag:
        return False
    header = request.headers.get("if-none-match")
    if not header:
        return False
    for candidate in header.split(","):
        value = candidate.strip()
        if value == "*":
            return True
        # A proxy may weaken the validator on the way back to us.
        if value.startswith("W/"):
            value = value[2:]
        if value == etag:
            return True
    return False


def _redirect_to_original_url(request: Request) -> RedirectResponse:
    """Move a cold variant request onto the original representation's URL."""

    original = request.url
    forwarded = request.headers.get("x-supertale-original-uri", "").strip()
    if forwarded:
        try:
            candidate = URL(forwarded)
            if (
                not candidate.scheme
                and not candidate.netloc
                and not candidate.fragment
                and candidate.path.startswith("/static/projects/")
            ):
                original = candidate
        except ValueError:
            pass
    original = original.remove_query_params("st_thumb")
    location = original.path
    if original.query:
        location = f"{location}?{original.query}"
    return RedirectResponse(
        url=location,
        status_code=302,
        headers={"Cache-Control": "no-store"},
    )


def _maybe_thumbnail_response(
    project_dir: Path,
    requested: Path,
    variant: str | None,
    request: Request | None = None,
):
    """Serve an already-built variant or redirect a cold one to the original URL.

    The canvas asks for a variant on every img that paints into a small box
    (see ``novelvideo.utils.thumbnails``). A *built* variant is served as local
    bytes rather than an OSS 302: at ~13KB the redirect round-trip plus the
    write-back readiness probe cost more than the transfer, and a freshly
    written variant is not in OSS yet anyway.

    A cold one is a different trade entirely, so it is never built or queued
    here. A valid image variant miss redirects to the same request URL without
    any ``st_thumb`` parameter. That keeps the temporary original response off
    the future variant's cache key and out of the proxy's thumbnail slice path.
    Thumbnail creation belongs to the generation-history write path; opening an
    old or cold canvas must never start image decoding work in the API process.
    """
    if not variant:
        return None
    thumb = fresh_thumbnail(project_dir, requested, variant)
    if thumb is None:
        if thumbnail_declined(project_dir, requested, variant):
            return None
        if (
            request is not None
            and normalize_variant(variant) is not None
            and is_thumbnailable(requested)
        ):
            return _redirect_to_original_url(request)
        return None
    cache_control = _variant_cache_control(request)
    try:
        stat_result = thumb.stat()
    except OSError:  # raced with a rewrite; move the fallback off the variant URL
        if request is not None:
            return _redirect_to_original_url(request)
        return None
    # Passing the stat makes FileResponse compute etag/last-modified now rather
    # than mid-send, so the value is available to answer a conditional request.
    response = FileResponse(
        path=str(thumb),
        media_type="image/webp",
        stat_result=stat_result,
        headers={"Cache-Control": cache_control},
    )
    if _etag_matches(request, response.headers.get("etag")):
        # FileResponse itself never answers a conditional request — that lives in
        # StaticFiles, which does not serve this route. Without this, `no-cache`
        # would mean a full re-download of every variant on every paint, which
        # is worse than the stale window it was chosen to avoid.
        return Response(
            status_code=304,
            headers={
                "Cache-Control": cache_control,
                "ETag": response.headers["etag"],
                "Last-Modified": response.headers["last-modified"],
            },
        )
    return response


def _resolve_project_file(resolved: ProjectResolution, file_path: str) -> Path:
    project_dir = resolved.project_dir
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    requested = (project_dir / file_path).resolve()
    if not requested.is_relative_to(project_dir.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")

    if not requested.exists() or not requested.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return requested


def _serve_or_redirect_to_oss(requested: Path, *, as_download: bool):
    """Serve a resolved project file, preferring a 302 to a presigned OSS URL.

    OUTPUT_DIR is an ossfs mount, so every file here already exists in OSS. When
    OSS delivery is enabled and the object is readable, redirect the browser
    straight to OSS so the edge router/pod stop streaming media bytes under load
    — the heavy transfer happens on a direct browser↔OSS connection. The 302 is
    marked ``no-store`` so the edge router does not cache the short-lived signed
    URL. Falls back to a local ``FileResponse`` whenever OSS delivery is disabled
    or the object is not yet readable in OSS (ossfs write-back lag), so behaviour
    degrades gracefully and same-origin frontend URLs keep working.
    """
    presigned = None
    try:
        if as_download:
            from novelvideo import config
            from novelvideo.utils.oss_client import maybe_presign_existing_output

            if getattr(config, "DOWNLOAD_VIA_OSS", False):
                presigned = maybe_presign_existing_output(requested)
        else:
            from novelvideo.utils.oss_client import maybe_presign_static

            presigned = maybe_presign_static(requested, requested.stat().st_mtime_ns)
    except Exception:
        logger.debug("OSS presign skipped for %s", requested, exc_info=True)
        presigned = None

    if presigned:
        return RedirectResponse(
            url=presigned,
            status_code=302,
            headers={"Cache-Control": "no-store"},
        )

    if as_download:
        return FileResponse(path=str(requested), filename=requested.name)
    return FileResponse(path=str(requested))


@router.get("/projects/{project}/files/{file_path:path}")
async def download_file(
    project: str,
    file_path: str,
    user: dict = Depends(get_api_user),
):
    """下载项目内的生成文件。

    路径相对于 output/{username}/{project}/，
    自动防止目录遍历攻击。
    """
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    requested = _resolve_project_file(resolved, file_path)

    return _serve_or_redirect_to_oss(requested, as_download=True)


@router.get("/projects/{project}/media/{file_path:path}")
async def preview_file(
    project: str,
    file_path: str,
    request: Request,
    st_thumb: str | None = None,
    user: dict = Depends(get_api_user),
):
    """预览项目内媒体文件。

    与 /files 使用同样的鉴权和路径防护，但返回 inline 响应，供 React 的
    <img>/<video>/<audio> 直接使用，避免裸 /static 依赖 NiceGUI session。

    ``st_thumb`` 请求一个降采样变体（见 ``novelvideo.utils.thumbnails``）；
    未知值等同于没传，回落原图。
    """
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    requested = _resolve_project_file(resolved, file_path)
    thumbnail = _maybe_thumbnail_response(
        resolved.project_dir, requested, st_thumb, request
    )
    if thumbnail is not None:
        return thumbnail
    return _serve_or_redirect_to_oss(requested, as_download=False)


async def preview_project_media_file(
    project: str,
    file_path: str,
    user: dict,
    st_thumb: str | None = None,
    request: Request | None = None,
):
    """Serve a project media file for non-/api routes such as /static/projects."""
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    requested = _resolve_project_file(resolved, file_path)
    thumbnail = _maybe_thumbnail_response(
        resolved.project_dir, requested, st_thumb, request
    )
    if thumbnail is not None:
        return thumbnail
    return _serve_or_redirect_to_oss(requested, as_download=False)
