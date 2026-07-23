"""小说上传 & 导入端点。"""

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, File, UploadFile

from novelvideo.api.auth import get_api_user, require_scope
from novelvideo.api.chapter_preview import (
    build_chapter_preview,
    count_billable_novel_chars,
    load_novel_text,
)
from novelvideo.api.deps import resolve_project_scope
from novelvideo.api.deps import get_cognee_store
from novelvideo.api.schemas import IngestStart
from novelvideo.project_config import (
    default_aspect_ratio_for_spine_template,
    load_project_config,
    save_project_config,
)
from novelvideo.ports import get_task_backend
from novelvideo.task_identity import project_task_state_key
from novelvideo.utils.document_parsers import (
    DocumentParseError,
    is_supported_novel_path,
    supported_novel_extensions_label,
)
from novelvideo.utils.screenplay_quality import build_import_format_check
from novelvideo.utils.upload_safety import (
    MAX_UPLOAD_BYTES,
    UploadTooLargeError,
    is_safe_upload_target,
    sanitize_upload_filename,
    stream_to_file_with_limit,
)

logger = logging.getLogger("novelvideo.api.ingest")
router = APIRouter()


@router.get("/projects/{project}/ingest/graph")
async def get_ingest_knowledge_graph(
    project: str,
    store=Depends(get_cognee_store),
):
    """Return the imported project's real Cognee graph for visualization."""
    snapshot = await store.get_graph_snapshot()
    return {"ok": True, "data": snapshot}


def _unsupported_format_response(filename: str) -> dict:
    suffix = Path(filename).suffix.lower() or "无扩展名"
    return {
        "ok": False,
        "error": f"不支持的文件类型: {suffix}，当前支持: {supported_novel_extensions_label()}",
        "error_type": "unsupported",
    }


@router.post("/projects/{project}/ingest/upload")
async def upload_novel(
    project: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """上传小说文件到项目的 uploads/ 目录。"""
    logger.info("[%s] upload_novel: %s", project, file.filename)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    project_dir = resolved.project_dir
    uploads_dir = project_dir / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)

    safe_name = sanitize_upload_filename(file.filename)
    if not is_safe_upload_target(uploads_dir, safe_name):
        return {"ok": False, "error": "非法文件名"}
    if not is_supported_novel_path(safe_name):
        return _unsupported_format_response(safe_name)
    dest = uploads_dir / safe_name
    try:
        size = stream_to_file_with_limit(file.file, dest)
    except UploadTooLargeError:
        return {
            "ok": False,
            "error": f"文件超过上限 ({MAX_UPLOAD_BYTES // (1024 * 1024)}MB)",
        }

    data = {"filename": safe_name, "size": size}
    try:
        content = load_novel_text(dest)
        preview = build_chapter_preview(content)
    except DocumentParseError as exc:
        logger.warning("[%s] failed to parse uploaded novel: %s: %s", project, safe_name, exc)
        return {
            "ok": False,
            "error": f"解析章节失败: {exc}",
            "error_type": "parse",
            "format": exc.source_format,
            "detail": str(exc),
        }
    except Exception:
        logger.warning("[%s] failed to build chapter preview", project, exc_info=True)
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
    data.update(preview)
    data["format_check"] = format_check

    return {"ok": True, "data": data}


@router.post("/projects/{project}/ingest/start")
async def start_ingest(
    project: str, body: IngestStart, user: dict = Depends(require_scope("tasks:submit"))
):
    """触发小说导入（构建知识图谱）。"""
    logger.info("[%s] start_ingest: %s (rebuild=%s)", project, body.filename, body.rebuild)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    uploads_dir = project_dir / "uploads"
    safe_name = sanitize_upload_filename(body.filename)
    if safe_name != body.filename or not is_safe_upload_target(uploads_dir, safe_name):
        return {"ok": False, "error": "非法文件名"}
    if not is_supported_novel_path(safe_name):
        return _unsupported_format_response(safe_name)
    novel_path = uploads_dir / safe_name

    if not novel_path.exists():
        return {"ok": False, "error": f"File '{body.filename}' not found in uploads/"}

    try:
        billable_chars = count_billable_novel_chars(load_novel_text(novel_path))
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

    config = {"rebuild": body.rebuild}
    if body.spine_template is not None:
        if not body.rebuild:
            return {"ok": False, "error": "项目类型只能在重新导入时修改"}
        project_config = load_project_config(username, project_name)
        project_config["spine_template"] = body.spine_template
        project_config["aspect_ratio"] = default_aspect_ratio_for_spine_template(
            body.spine_template
        )
        save_project_config(username, project_name, project_config)
        config["spine_template"] = body.spine_template

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
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
