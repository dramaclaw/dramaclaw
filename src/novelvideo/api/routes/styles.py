"""风格管理端点。"""

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import FileResponse

logger = logging.getLogger("novelvideo.api.styles")

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import resolve_project_scope
from novelvideo.api.schemas import StylePreviewRequest


def _custom_preview_url(project: str | None, preview_path: str | None) -> str | None:
    if not project or not preview_path:
        return None
    from urllib.parse import quote

    return f"/api/v1/projects/{quote(project, safe='')}/media/{quote(preview_path, safe='/')}"

router = APIRouter()


@router.get("/styles")
async def list_styles(
    project: str | None = Query(None, description="项目名；提供时返回该项目的自定义风格"),
    user: dict = Depends(get_api_user),
):
    """列出所有风格（预设 + 自定义）。"""
    from novelvideo.services.style_service import StyleService

    username = user["username"]
    project_name = project
    if project:
        resolved = await resolve_project_scope(project, user, required_role="viewer")
        username = resolved.username
        project_name = resolved.project_name
    styles = StyleService.list_all_styles(username=username, project=project_name)
    for style in styles:
        if style.get("type") == "custom":
            style["preview_url"] = _custom_preview_url(
                project,
                style.get("preview_path"),
            )
    return {"ok": True, "data": styles}


@router.get("/styles/{style_id}")
async def get_style(
    style_id: str,
    project: str | None = Query(None, description="项目名"),
    user: dict = Depends(get_api_user),
):
    """获取风格详情。"""
    from novelvideo.services.style_service import StyleService

    username = user["username"]
    project_name = project
    if project:
        resolved = await resolve_project_scope(project, user, required_role="viewer")
        username = resolved.username
        project_name = resolved.project_name
    style = StyleService.get_style(style_id, username=username, project=project_name)
    if style is None:
        return {"ok": False, "error": f"Style '{style_id}' not found"}

    payload = style.model_dump() if hasattr(style, "model_dump") else style.__dict__
    if not payload.get("is_preset"):
        payload["preview_url"] = _custom_preview_url(project, payload.get("preview_path"))
    return {"ok": True, "data": payload}


@router.get("/styles/{style_id}/preview")
async def get_style_preview(
    style_id: str,
    project: str | None = Query(None, description="项目名"),
    user: dict = Depends(get_api_user),
):
    """返回预设风格的参考预览图。"""
    from novelvideo.services.style_service import StyleService

    username = user["username"]
    project_name = project
    if project:
        resolved = await resolve_project_scope(project, user, required_role="viewer")
        username = resolved.username
        project_name = resolved.project_name

    if not StyleService.get_preset(style_id):
        style = StyleService.get_style(
            style_id,
            username=username,
            project=project_name,
        )
        if style:
            if not project or not getattr(style, "preview_path", None):
                return {"ok": False, "error": "自定义风格暂无参考图"}
            preview_path = (resolved.project_dir / style.preview_path).resolve()
            if not preview_path.is_relative_to(resolved.project_dir.resolve()) or not preview_path.exists():
                return {"ok": False, "error": "自定义风格参考图不存在"}
            return FileResponse(path=str(preview_path), media_type="image/*")
        return {"ok": False, "error": f"Style '{style_id}' not found"}

    preview_path = StyleService.PRESETS_DIR / f"{style_id}.png"
    if not preview_path.exists():
        return {"ok": False, "error": f"预设风格 '{style_id}' 暂无参考图"}

    return FileResponse(
        path=str(preview_path),
        media_type="image/png",
        filename=f"preview_{style_id}.png",
    )


@router.post("/styles")
async def create_style(body: dict, user: dict = Depends(get_api_user)):
    """创建自定义风格。"""
    from novelvideo.services.style_service import StyleService
    from novelvideo.models import StyleConfig

    style_id = body.get("id")
    project = body.get("project")
    if not style_id:
        return {"ok": False, "error": "Style id is required"}
    if not project:
        return {"ok": False, "error": "Project is required"}
    resolved = await resolve_project_scope(project, user, required_role="editor")

    # 检查是否与预设冲突
    if StyleService.get_preset(style_id):
        return {"ok": False, "error": f"Cannot override preset style '{style_id}'"}

    try:
        config_payload = dict(body.get("config", {}) or {})
        preview_path = body.get("preview_path")
        config_payload["id"] = style_id
        config_payload["name"] = body.get("name") or config_payload.get("name") or style_id
        config = StyleConfig(**config_payload)
        if preview_path:
            config.preview_path = StyleService.validate_style_preview_path(
                resolved.project_dir,
                style_id,
                str(preview_path),
            )
        else:
            config.preview_path = StyleService.find_style_preview(
                resolved.project_dir,
                style_id,
            )
        success = StyleService.save_custom_style(
            style_id,
            config,
            username=resolved.username,
            project=resolved.project_name,
        )
        if not success:
            return {"ok": False, "error": "保存自定义风格失败"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        return {"ok": False, "error": str(e)}

    return {"ok": True, "data": {"id": style_id, "message": "风格已创建"}}


@router.delete("/styles/{style_id}")
async def delete_style(
    style_id: str,
    project: str | None = Query(None, description="项目名"),
    user: dict = Depends(get_api_user),
):
    """删除自定义风格。"""
    from novelvideo.services.style_service import StyleService

    # 不允许删除预设
    if StyleService.get_preset(style_id):
        return {"ok": False, "error": "Cannot delete preset styles"}

    if not project:
        return {"ok": False, "error": "Project is required"}
    resolved = await resolve_project_scope(project, user, required_role="editor")
    success = StyleService.delete_custom_style(
        style_id,
        username=resolved.username,
        project=resolved.project_name,
    )
    if not success:
        return {"ok": False, "error": f"Custom style '{style_id}' not found"}

    return {"ok": True, "data": {"id": style_id, "message": "风格已删除"}}


@router.post("/styles/{style_id}/preview")
async def preview_style(
    style_id: str, body: StylePreviewRequest, user: dict = Depends(get_api_user)
):
    """使用指定风格生成预览图。"""
    from novelvideo.services.style_service import StyleService

    username = user["username"]
    project_name = body.project
    if body.project:
        resolved = await resolve_project_scope(body.project, user, required_role="viewer")
        username = resolved.username
        project_name = resolved.project_name
    style = StyleService.get_style(
        style_id,
        username=username,
        project=project_name,
    )
    if style is None:
        return {"ok": False, "error": f"Style '{style_id}' not found"}

    from novelvideo.generators.image_generator import generate_character_reference_unified
    import tempfile

    # 使用临时目录生成预览图
    tmp_dir = tempfile.mkdtemp(prefix="style_preview_")

    try:
        paths = await generate_character_reference_unified(
            character_name="preview",
            appearance_prompt=body.prompt,
            style=style_id,
            model=body.model,
            output_dir=tmp_dir,
            project_dir=tmp_dir,
            count=1,
        )
    except Exception as e:
        return {"ok": False, "error": f"Preview generation failed: {e}"}

    if not paths:
        return {"ok": False, "error": "No preview image generated"}

    from fastapi.responses import FileResponse

    return FileResponse(
        path=paths[0],
        media_type="image/png",
        filename=f"preview_{style_id}.png",
    )


@router.post("/projects/{project}/styles/analyze")
async def analyze_style(
    project: str,
    file: UploadFile = File(...),
    style_id: str = Form(""),
    user: dict = Depends(get_api_user),
):
    """上传参考图片，AI 分析并提取风格参数。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    from novelvideo.services.style_service import StyleService
    from novelvideo.generators.style_analyzer import StyleAnalyzer
    from novelvideo.ports import get_usage_meter

    content = await file.read()
    if not content:
        return {"ok": False, "error": "No file uploaded"}

    mime_type = file.content_type or "image/jpeg"

    preview_token = None
    try:
        if style_id.strip():
            extension = Path(file.filename or "").suffix.lower() or ".png"
            preview_token = StyleService.stage_style_preview(
                resolved.project_dir,
                content,
                extension,
            )
        if resolved.ctx is not None:
            billing_user_id = (
                str(getattr(resolved.ctx, "requester_user_id", "") or "").strip()
                or str(getattr(resolved.ctx, "owner_id", "") or "").strip()
            )
            get_usage_meter().set_llm_usage_context(
                billing_user_id,
                project_id=resolved.ctx.project_id,
                resource_kind="script",
                billing_metadata={
                    "billing_user_id": billing_user_id,
                    "requester_user_id": str(
                        getattr(resolved.ctx, "requester_user_id", "") or ""
                    ).strip(),
                    "project_owner_id": str(getattr(resolved.ctx, "owner_id", "") or "").strip(),
                    "source": "style_analyzer",
                },
            )
        analyzer = StyleAnalyzer()
        result = await analyzer.analyze(content, mime_type=mime_type)
    except Exception as e:
        return {"ok": False, "error": f"Style analysis failed: {e}"}
    finally:
        get_usage_meter().clear_llm_usage_context()

    data = dict(result)
    if preview_token:
        data["preview_token"] = preview_token
    return {"ok": True, "data": data}


@router.post("/projects/{project}/styles/preview-upload")
async def upload_style_preview(
    project: str,
    file: UploadFile = File(...),
    style_id: str = Form(...),
    user: dict = Depends(get_api_user),
):
    """立即保存自定义风格参考图，不等待 AI 风格分析。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    from novelvideo.services.style_service import StyleService

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="No preview image uploaded")

    extension = Path(file.filename or "").suffix.lower() or ".png"
    allowed_mime_types = {
        ".png": {"image/png"},
        ".jpg": {"image/jpeg"},
        ".jpeg": {"image/jpeg"},
        ".webp": {"image/webp"},
        ".gif": {"image/gif"},
    }
    if (
        extension not in allowed_mime_types
        or (file.content_type or "").lower() not in allowed_mime_types[extension]
    ):
        raise HTTPException(
            status_code=415,
            detail="Unsupported style preview image type",
        )

    try:
        staged_token = StyleService.stage_style_preview(
            resolved.project_dir,
            content,
            extension,
        )
        preview_token = StyleService.finalize_style_preview(
            resolved.project_dir,
            style_id,
            staged_token,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        logger.exception("Failed to persist style preview for %s", style_id)
        raise HTTPException(status_code=500, detail="Failed to persist style preview") from e

    return {"ok": True, "data": {"preview_path": preview_token}}
