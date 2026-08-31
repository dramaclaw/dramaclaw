"""小说上传 & 导入端点。"""

import logging
import os
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any

import anyio
from anyio.lowlevel import RunVar
from fastapi import APIRouter, Depends, File, Form, UploadFile

from novelvideo.api.auth import get_api_user, require_scope
from novelvideo.api.chapter_preview import (
    build_chapter_preview,
    count_billable_novel_chars,
    load_novel_text,
)
from novelvideo.api.deps import resolve_project_scope
from novelvideo.api.schemas import IngestStart
from novelvideo.knowledge_pipeline import is_structured_pipeline
from novelvideo.graph_preview import (
    empty_graph_preview,
    load_graph_preview,
)
from novelvideo.project_config import (
    default_aspect_ratio_for_spine_template,
    load_project_config_file_from_state_dir,
    save_project_config_in_state_dir,
)
from novelvideo.ports import get_task_backend
from novelvideo.task_identity import project_task_state_key
from novelvideo.utils.document_parsers import (
    DocumentParseError,
    MAX_NOVEL_IMPORT_CHARS,
    is_supported_novel_path,
    supported_novel_extensions_label,
)
from novelvideo.utils.screenplay_quality import build_import_format_check
from novelvideo.utils.async_ops import run_sync_bounded
from novelvideo.utils.upload_safety import (
    MAX_NOVEL_IMPORT_BYTES,
    MAX_NOVEL_UPLOAD_BYTES,
    UploadTooLargeError,
    create_staged_upload_file,
    is_safe_upload_target,
    sanitize_upload_filename,
    stream_to_file_with_limit,
)

logger = logging.getLogger("novelvideo.api.ingest")
router = APIRouter()
_INGEST_UPLOAD_CONCURRENCY = 2
_ingest_upload_limiter_var: RunVar[anyio.CapacityLimiter] = RunVar(
    "ingest_upload_limiter"
)


def _ingest_upload_limiter() -> anyio.CapacityLimiter:
    """Return the upload-processing gate scoped to the current async run."""

    limiter = _ingest_upload_limiter_var.get(None)
    if limiter is None:
        limiter = anyio.CapacityLimiter(_INGEST_UPLOAD_CONCURRENCY)
        _ingest_upload_limiter_var.set(limiter)
    return limiter


async def _run_ingest_upload_operation(
    operation: Callable[..., Any], /, *args: Any, **kwargs: Any
) -> Any:
    """Run blocking upload work off-loop without abandoning its limiter token."""

    return await run_sync_bounded(
        operation,
        *args,
        limiter=_ingest_upload_limiter(),
        **kwargs,
    )


@router.get("/projects/{project}/ingest/graph")
async def get_ingest_knowledge_graph(
    project: str,
    user: dict = Depends(get_api_user),
):
    """Return the persisted graph preview without opening Ladybug on normal reads."""

    resolved = await resolve_project_scope(project, user, required_role="viewer")
    ctx = resolved.ctx

    # A missing novel.txt means an import has not completed (or a rebuild
    # invalidated the old graph). Do not race the active/failed import by
    # returning a stale sidecar or opening its embedded graph database from an
    # API worker.
    if not (ctx.output_dir / "novel.txt").is_file():
        return {"ok": True, "data": empty_graph_preview()}

    # structured_v1 projects never build a graph, so there is never a sidecar
    # to read and the client renders nothing for an empty preview.
    if is_structured_pipeline(ctx.state_dir):
        return {"ok": True, "data": empty_graph_preview()}

    # Written during import, before novel.txt — which is the public "import
    # succeeded" marker — so a project that imported successfully has one.
    #
    # Projects predating the sidecar do not, and are left without a preview
    # rather than materialized on demand. Backfilling meant a viewer-role GET
    # opening Ladybug from an API worker and waiting on the project graph lock
    # with no timeout: during a rebuild that is the length of the rebuild, held
    # by a request that asyncio.shield keeps alive after the client is gone.
    # And the wait bought nothing — the first thing it did on acquiring the
    # lock was re-check novel.txt, find it removed by the rebuild, and return
    # the empty preview anyway.
    #
    # Nothing downstream reads this file; it is one visualization on the import
    # page, and the client already renders nothing for an empty one. A missing
    # preview is a missing picture, not missing data, and re-importing produces
    # it.
    snapshot = load_graph_preview(ctx.state_dir)
    if snapshot is not None:
        return {"ok": True, "data": snapshot}
    return {"ok": True, "data": empty_graph_preview()}


def _unsupported_format_response(filename: str) -> dict:
    suffix = Path(filename).suffix.lower() or "无扩展名"
    return {
        "ok": False,
        "error": f"不支持的文件类型: {suffix}，当前支持: {supported_novel_extensions_label()}",
        "error_type": "unsupported",
    }


def _format_file_size_limit(limit_bytes: int) -> str:
    if limit_bytes % (1024 * 1024) == 0:
        return f"{limit_bytes // (1024 * 1024)}MB"
    return f"{limit_bytes // 1024}KB"


def _file_too_large_response(
    limit_bytes: int = MAX_NOVEL_UPLOAD_BYTES,
) -> dict:
    limit_label = _format_file_size_limit(limit_bytes)
    return {
        "ok": False,
        "error": f"文件超过 {limit_label} 上限，请压缩文件或拆分正文后重新上传。",
        "error_type": "file_too_large",
        "data": {"limit_bytes": limit_bytes},
    }


def _text_too_large_response(actual_chars: int) -> dict:
    return {
        "ok": False,
        "error": (
            f"正文共 {actual_chars:,} 字，超过单次导入上限 "
            f"{MAX_NOVEL_IMPORT_CHARS:,} 字。请拆分后重新上传。"
        ),
        "error_type": "text_too_large",
        "data": {
            "limit_chars": MAX_NOVEL_IMPORT_CHARS,
            "actual_chars": actual_chars,
        },
    }


def _upload_novel_sync(
    *,
    project: str,
    upload_stream: Any,
    filename: str | None,
    project_dir: Path,
    state_dir: str | Path,
    spine_template: str | None,
) -> dict:
    """Stage, parse, preview, and atomically persist one novel upload."""

    uploads_dir = project_dir / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)

    safe_name = sanitize_upload_filename(filename)
    if not is_safe_upload_target(uploads_dir, safe_name):
        return {"ok": False, "error": "非法文件名"}
    if not is_supported_novel_path(safe_name):
        return _unsupported_format_response(safe_name)
    dest = uploads_dir / safe_name
    staging_dir = uploads_dir / ".staging"
    staging_dir.mkdir(exist_ok=True)
    staged_path = create_staged_upload_file(
        staging_dir,
        suffix=Path(safe_name).suffix,
        destination=dest,
    )
    try:
        try:
            size = stream_to_file_with_limit(upload_stream, staged_path)
        except UploadTooLargeError:
            return _file_too_large_response()

        data = {"filename": safe_name, "size": size}
        try:
            content = load_novel_text(staged_path)
            billable_chars = count_billable_novel_chars(content)
            if billable_chars > MAX_NOVEL_IMPORT_CHARS:
                return _text_too_large_response(billable_chars)
            project_config = load_project_config_file_from_state_dir(state_dir)
            requested_spine_template = str(
                spine_template
                or project_config.get("spine_template")
                or "drama"
            ).strip()
            preview = build_chapter_preview(
                content,
                include_scene_blocks=requested_spine_template != "narrated",
            )
        except DocumentParseError as exc:
            logger.warning(
                "[%s] failed to parse uploaded novel: %s: %s",
                project,
                safe_name,
                exc,
            )
            return {
                "ok": False,
                "error": f"解析章节失败: {exc}",
                "error_type": "parse",
                "format": exc.source_format,
                "detail": str(exc),
            }
        except Exception:
            logger.warning(
                "[%s] failed to build chapter preview", project, exc_info=True
            )
            return {"ok": False, "error": "解析章节失败"}

        has_chapters = bool(preview.get("chapters"))
        format_check = build_import_format_check(
            content,
            has_chapters=has_chapters,
            chapters=preview.get("chapters"),
        )
        if not has_chapters:
            return {
                "ok": False,
                "error": "解析章节失败: 未检测到有效章节内容",
                "format_check": format_check,
            }

        try:
            os.replace(staged_path, dest)
        except OSError:
            logger.exception(
                "[%s] failed to persist uploaded novel: %s", project, safe_name
            )
            return {"ok": False, "error": "保存上传文件失败"}

        data.update(preview)
        data["format_check"] = format_check
        return {"ok": True, "data": data}
    finally:
        try:
            staged_path.unlink(missing_ok=True)
        except OSError:
            logger.warning(
                "[%s] failed to remove staged upload: %s",
                project,
                staged_path.name,
                exc_info=True,
            )


@router.post("/projects/{project}/ingest/upload")
async def upload_novel(
    project: str,
    file: UploadFile = File(...),
    spine_template: Annotated[str | None, Form()] = None,
    user: dict = Depends(get_api_user),
):
    """上传小说文件到项目的 uploads/ 目录。"""
    logger.info("[%s] upload_novel: %s", project, file.filename)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    return await _run_ingest_upload_operation(
        _upload_novel_sync,
        project=project,
        upload_stream=file.file,
        filename=file.filename,
        project_dir=Path(resolved.project_dir),
        state_dir=resolved.state_dir,
        spine_template=spine_template,
    )


@router.post("/projects/{project}/ingest/start")
async def start_ingest(
    project: str, body: IngestStart, user: dict = Depends(require_scope("tasks:submit"))
):
    """触发小说导入（构建知识图谱）。"""
    logger.info("[%s] start_ingest: %s (rebuild=%s)", project, body.filename, body.rebuild)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    project_dir = resolved.project_dir
    uploads_dir = project_dir / "uploads"
    safe_name = sanitize_upload_filename(body.filename)
    if safe_name != body.filename or not is_safe_upload_target(uploads_dir, safe_name):
        return {"ok": False, "error": "非法文件名"}
    if not is_supported_novel_path(safe_name):
        return _unsupported_format_response(safe_name)
    novel_path = uploads_dir / safe_name

    # Historical projects may only retain the canonical, already-parsed
    # ``novel.txt`` and have no original file under ``uploads/``.  Preserve a
    # durable copy before queuing the rebuild: the Cognee rebuild deliberately
    # removes the canonical marker early, so passing that marker itself to the
    # worker would make a failed rebuild impossible to retry.
    if not novel_path.exists() and safe_name == "novel.txt":
        imported_novel_path = project_dir / "novel.txt"
        if imported_novel_path.is_file():
            uploads_dir.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(imported_novel_path, novel_path)
            except OSError:
                logger.exception("[%s] failed to preserve legacy novel source", project)
                return {"ok": False, "error": "无法保存历史原文，请重新上传后再导入"}

    if not novel_path.exists():
        return {"ok": False, "error": f"File '{body.filename}' not found in uploads/"}

    try:
        if novel_path.stat().st_size > MAX_NOVEL_IMPORT_BYTES:
            return _file_too_large_response(MAX_NOVEL_IMPORT_BYTES)
    except OSError:
        logger.warning("[%s] failed to stat uploaded novel", project, exc_info=True)
        return {"ok": False, "error": "无法读取上传文件，请重新上传后再导入"}

    try:
        content = load_novel_text(novel_path)
        billable_chars = count_billable_novel_chars(content)
        if billable_chars > MAX_NOVEL_IMPORT_CHARS:
            return _text_too_large_response(billable_chars)
    except DocumentParseError as exc:
        return {
            "ok": False,
            "error": f"解析章节失败: {exc}",
            "error_type": "parse",
            "format": exc.source_format,
            "detail": str(exc),
        }
    except Exception:
        logger.warning(
            "[%s] failed to parse uploaded novel for billing",
            project,
            exc_info=True,
        )
        return {"ok": False, "error": "解析章节失败"}

    current_project_config = load_project_config_file_from_state_dir(resolved.state_dir)
    requested_spine_template = str(
        body.spine_template
        or current_project_config.get("spine_template")
        or "drama"
    ).strip()
    effective_spine_template = (
        "narrated" if requested_spine_template == "narrated" else "drama"
    )
    if effective_spine_template == "drama":
        preview = build_chapter_preview(content)
        format_check = build_import_format_check(
            content,
            has_chapters=bool(preview.get("chapters")),
            chapters=preview.get("chapters"),
            require_scene_headers=True,
        )
        if format_check["level"] == "blocking":
            return {
                "ok": False,
                "error": format_check["summary"],
                "error_type": "screenplay_format",
                "format_check": format_check,
            }

    config = {
        "rebuild": body.rebuild,
        "spine_template": effective_spine_template,
    }
    # Persist the exact source used by this import. The ingest page can then
    # rebuild from the existing upload without forcing the user to upload again.
    project_config_updates = {"ingest_source_filename": safe_name}
    if body.spine_template is not None:
        if not body.rebuild:
            return {"ok": False, "error": "项目类型只能在重新导入时修改"}
        project_config_updates.update(
            {
                "spine_template": body.spine_template,
                "aspect_ratio": default_aspect_ratio_for_spine_template(
                    body.spine_template
                ),
            }
        )
    save_project_config_in_state_dir(resolved.state_dir, config=project_config_updates)

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            product_surface="mainline",
            task_type="ingest_fast",
            queue_kind="default",
            episode=0,
            payload={
                "novel_path": str(novel_path),
                "config": config,
                "billing": {
                    "billable_chars": billable_chars,
                    "billing_quantity": billable_chars,
                },
            },
        )
        return {
            "ok": True,
            "task_type": "ingest_fast",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("ingest_fast", ctx.project_id, 0),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"导入任务已进入队列: {safe_name}",
        }

    return {"ok": False, "error": "导入需要 project context"}
