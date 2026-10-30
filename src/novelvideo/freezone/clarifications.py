"""Server-owned Freezone clarification payloads shared by API and MCP adapters."""

from __future__ import annotations

from typing import Any


def video_model_constraint_adjustment_clarification(
    preflight: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the fixed user decision used when no video model fits all constraints."""
    result = {
        "ok": True,
        "status": "video_model_clarification_required",
        "code": "no_compatible_video_model",
        "draft_created": False,
        "retryable": False,
        "required_choice": "video_model_constraint_adjustment",
        "next_action": "request_user_clarification",
        "question": {
            "id": "video_model_constraint_adjustment",
            "title": "选择下一步",
            "prompt": (
                "当前没有视频模型能同时满足全部参考模式、镜头时长和生成参数。"
                "请选择是否调整一类约束。"
            ),
            "mode": "single",
            "options": [
                {
                    "id": "keep_requirements",
                    "label": "保持当前要求并停止",
                    "description": "不修改当前 Plan，也不继续创建 Draft。",
                },
                {
                    "id": "adjust_reference_mode",
                    "label": "调整参考模式",
                    "description": "仅确认调整方向；提供具体新值前不修改参考边或媒体锚点。",
                },
                {
                    "id": "adjust_shot_duration",
                    "label": "调整镜头时长",
                    "description": "仅确认调整方向；提供具体新时长前不修改 Plan。",
                },
                {
                    "id": "specify_video_model",
                    "label": "重新指定模型",
                    "description": "由用户提供具体模型，再使用原约束重新执行 preflight。",
                },
            ],
        },
    }
    if preflight is not None:
        result["preflight"] = preflight
    return result
