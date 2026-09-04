"""Agent-neutral workflow draft helpers shared by Freezone adapters."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

SCHEMA_VERSION = "freezone_workflow_draft.v1"
PATCHABLE_FIELDS = {
    "assumptions",
    "include_audio",
    "include_compose",
    "inputs",
    "items",
    "planner",
    "summary",
    "title",
    "user_goal",
}
MERGED_OBJECT_FIELDS = {"inputs"}
IDENTITY_ECHO_FIELDS = {"skill_id", "draft_id", "canvas_id"}


def build_workflow_draft_patch(
    *,
    payload: dict[str, Any],
    changes: dict[str, Any],
    compile_intent: Any,
    run_after_create: bool | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    # 模型常把 skill_id/draft_id 原样回显进 changes；等值回显不是修改,直接忽略。
    changes = {
        key: value
        for key, value in changes.items()
        if not (
            key in IDENTITY_ECHO_FIELDS and str(value) == str(payload.get(key) or "")
        )
    }
    unsupported = sorted(set(changes) - PATCHABLE_FIELDS)
    if unsupported:
        return None, {
            "ok": False,
            "status": "invalid_workflow_draft_patch",
            "error": f"unsupported workflow draft field: {unsupported[0]}",
            "unsupported_fields": unsupported,
            "patchable_fields": sorted(PATCHABLE_FIELDS),
            "agent_instruction": (
                "Retry freezone_patch_workflow_draft exactly once, keeping only "
                "patchable fields in changes: "
                + ", ".join(sorted(PATCHABLE_FIELDS))
                + ". Drop every other key."
            ),
        }
    intent = deepcopy(payload.get("intent") or {})
    before_intent = deepcopy(intent)
    for key, value in changes.items():
        if value is None:
            intent.pop(key, None)
        elif key in MERGED_OBJECT_FIELDS and isinstance(value, dict):
            current = intent.get(key) if isinstance(intent.get(key), dict) else {}
            merged = {**current, **value}
            intent[key] = {
                item_key: item for item_key, item in merged.items() if item is not None
            }
        else:
            intent[key] = deepcopy(value)
    compiled = compile_intent(intent)
    if not isinstance(compiled, dict) or not compiled.get("ok"):
        return None, (
            compiled
            if isinstance(compiled, dict)
            else {
                "ok": False,
                "status": "workflow_draft_compile_failed",
                "error": "workflow draft compiler returned an invalid result",
            }
        )
    result = {
        "intent": intent,
        "compiled": deepcopy(compiled),
        "last_changes": {
            key: deepcopy(intent.get(key))
            for key in changes
            if before_intent.get(key) != intent.get(key)
        },
    }
    if run_after_create is not None:
        result["run_after_create"] = bool(run_after_create)
    return result, None


def public_workflow_draft(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "status": "workflow_draft_ready",
        "schema_version": SCHEMA_VERSION,
        "draft_id": payload.get("draft_id"),
        "operation_id": payload.get("operation_id"),
        "revision": payload.get("revision"),
        "draft_status": payload.get("status"),
        "skill_id": payload.get("skill_id"),
        "plan_digest": payload.get("plan_digest"),
        "run_after_create": bool(payload.get("run_after_create")),
        "preview": deepcopy(payload.get("preview") or {}),
        "last_changes": deepcopy(payload.get("last_changes") or {}),
        "expires_at": payload.get("expires_at"),
        "message": "工作流方案草稿已准备完成，可继续调整或确认创建。",
    }
