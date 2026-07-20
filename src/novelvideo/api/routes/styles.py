"""风格管理端点。"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, UploadFile, File, Query
from fastapi.responses import FileResponse

logger = logging.getLogger("novelvideo.api.styles")

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import resolve_project_scope
from novelvideo.api.schemas import StylePreviewRequest

router = APIRouter()

STYLE_ANALYSIS_FEATURE_KEY = "mainline.style_analysis"
STYLE_ANALYSIS_TASK_TYPE = "style_analysis"
MODEL_CALL_CREDIT_POLICY_FEATURE_INCLUDED = "feature_included"


def _requester_user_id_for_billing(resolved: Any, user: dict) -> str:
    ctx = getattr(resolved, "ctx", None)
    return str(
        getattr(ctx, "requester_user_id", "")
        or user.get("id")
        or user.get("user_id")
        or user.get("username")
        or ""
    )


def style_analysis_billing_params() -> dict[str, Any]:
    from novelvideo.config import get_newapi_text_model_name

    return {
        "pricing_kind": "text",
        "pricing_model": get_newapi_text_model_name(
            "STYLE_ANALYZER_MODEL",
            "gemini-3.5-flash",
        ),
        "pricing_params": {},
        "pricing_quantity": 1,
    }


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

    return {"ok": True, "data": style.model_dump() if hasattr(style, "model_dump") else style.__dict__}


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
        if StyleService.get_style(
            style_id,
            username=username,
            project=project_name,
        ):
            return {"ok": False, "error": "自定义风格暂不支持预览"}
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
        config_payload["id"] = style_id
        config_payload["name"] = body.get("name") or config_payload.get("name") or style_id
        config = StyleConfig(**config_payload)
        success = StyleService.save_custom_style(
            style_id,
            config,
            username=resolved.username,
            project=resolved.project_name,
        )
        if not success:
            return {"ok": False, "error": "保存自定义风格失败"}
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
    user: dict = Depends(get_api_user),
):
    """上传参考图片，AI 分析并提取风格参数。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    from novelvideo.generators.style_analyzer import StyleAnalyzer
    from novelvideo.ports import get_usage_meter

    content = await file.read()
    if not content:
        return {"ok": False, "error": "No file uploaded"}

    mime_type = file.content_type or "image/jpeg"

    usage_meter = get_usage_meter()
    ctx = getattr(resolved, "ctx", None)
    project_id = str(getattr(ctx, "project_id", "") or "")
    billing_user_id = _requester_user_id_for_billing(resolved, user)
    reservation = await usage_meter.reserve_feature_start_credits(
        user_id=billing_user_id,
        feature_key=STYLE_ANALYSIS_FEATURE_KEY,
        project_id=project_id,
        resource_kind="script",
        task_type=STYLE_ANALYSIS_TASK_TYPE,
        metadata={
            "source": "sync_api",
            "endpoint": "analyze_style",
            "mime_type": mime_type,
        },
        params=style_analysis_billing_params(),
        require_price_rule=True,
        require_positive_cost=True,
    )
    reservation_id = str(reservation.get("id") or "")
    billing_metadata: dict[str, Any] = {
        "model_call_credit_policy": MODEL_CALL_CREDIT_POLICY_FEATURE_INCLUDED,
        "feature_key": STYLE_ANALYSIS_FEATURE_KEY,
        "source": "sync_api",
    }
    if reservation_id:
        billing_metadata.update(
            {
                "feature_credit_reservation_id": reservation_id,
                "feature_credit_charge_id": reservation_id,
                "feature_credit_cost": str(reservation.get("cost") or 0),
            }
        )

    try:
        usage_meter.set_llm_usage_context(
            billing_user_id,
            project_id=project_id,
            resource_kind="script",
            billing_metadata=billing_metadata,
        )
        analyzer = StyleAnalyzer()
        result = await analyzer.analyze(content, mime_type=mime_type)
        if reservation_id:
            await usage_meter.confirm_feature_credit_reservation(
                reservation_id,
                metadata={
                    "source": "sync_api",
                    "endpoint": "analyze_style",
                    "mime_type": mime_type,
                },
            )
    except Exception as e:
        if reservation_id:
            try:
                await usage_meter.refund_feature_credit_reservation(
                    reservation_id,
                    metadata={
                        "source": "sync_api",
                        "endpoint": "analyze_style",
                        "mime_type": mime_type,
                        "error": str(e),
                    },
                )
            except Exception:
                logger.exception(
                    "Failed to refund style analysis feature credit reservation"
                )
        return {"ok": False, "error": f"Style analysis failed: {e}"}
    finally:
        usage_meter.clear_llm_usage_context()

    return {"ok": True, "data": result}
