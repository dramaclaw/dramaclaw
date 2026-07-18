"""WebSocket chat endpoint for the React frontend.

Transport contract is typed JSON events. The backend keeps chat storage and
agent process management behind this endpoint so dramaclaw-fe does not need to
know whether the active backend is Hermes, Claude, or Codex.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import AliasChoices, BaseModel, Field

from novelvideo.api.auth import (
    AUTH_COOKIE_NAME,
    get_api_user,
    _verify_agent_bearer,
    _verify_browser_session,
)
from novelvideo.api.deps import list_user_projects
from novelvideo.chat import service as chat_service
from novelvideo.chat.hermes_pool import canvas_bridge_dir_for_profile
from novelvideo.chat.hermes_workspace import ensure_user_hermes_workspace
from novelvideo.chat.store import ChatScope, chat_store
from novelvideo.freezone.canvas_command_bridge import (
    resolve_clarification_result,
    resolve_canvas_command,
    resolve_canvas_context,
    resolve_skill_studio_result,
)
from novelvideo.freezone.agent_config_store import save_user_agent_config_item
from novelvideo.ports import get_usage_meter
from novelvideo.project_context import ProjectContext, resolve_project_context
from novelvideo.shared.billing_errors import (
    BILLING_RULE_NOT_CONFIGURED_MESSAGE,
    INSUFFICIENT_CREDITS_MESSAGE,
    billing_rule_not_configured_payload,
    find_billing_rule_not_configured_error,
    find_insufficient_credits_error,
    insufficient_credits_payload,
)

router = APIRouter()
logger = logging.getLogger(__name__)

AI_ASSISTANT_CHAT_FEATURE_KEY = "ai_assistant_chat"
EMPTY_AGENT_REPLY_MESSAGE = "这轮操作没有收到虾导的有效回复，请稍后重试。"


@router.post("/chat/cancel")
async def cancel_chat_turn(user: dict = Depends(get_api_user)) -> dict[str, Any]:
    """Best-effort cancellation for the active Hermes chat worker.

    The WebSocket receive loop is blocked while a Hermes prompt is streaming,
    so a separate HTTP endpoint gives the frontend an out-of-band stop signal.
    Closing the worker is intentionally coarse, but it is the only reliable way
    to interrupt long-running tool calls with the current Hermes ACP wrapper.
    """
    username = str(user["username"])
    try:
        from novelvideo.chat.hermes_pool import pool as hermes_pool

        cancelled = await hermes_pool.close_user(username)
    except Exception:
        cancelled = False
    try:
        chat_service.force_release_chat_run_lock(username, "")
    except Exception:
        pass
    return {"ok": True, "data": {"cancelled": cancelled}}


class ChatScopePayload(BaseModel):
    kind: str = "home"
    id: str | None = None
    surface: str | None = None
    canvasId: str | None = None
    canvas_id: str | None = None
    agentId: str | None = None
    agent_id: str | None = None


class ChatAttachmentIn(BaseModel):
    id: str | None = None
    type: str | None = None
    kind: str | None = None
    mimeType: str | None = None
    fileName: str | None = None
    fileSize: int | None = None
    content: str | None = None
    url: str | None = None
    path: str | None = None
    label: str | None = None


class ChatMessageIn(BaseModel):
    type: str
    scope: ChatScopePayload | None = None
    text: str
    user_text: str | None = None
    turn_id: str | None = None
    attachments: list[ChatAttachmentIn] = []
    surface: str | None = None
    context: dict[str, Any] = Field(default_factory=dict)


class ScopeSetIn(BaseModel):
    type: str
    scope: ChatScopePayload


class ChatUiEventIn(BaseModel):
    scope: ChatScopePayload
    turn_id: str
    event: dict[str, Any]


class AgentPermissionResultIn(BaseModel):
    scope: ChatScopePayload | None = None
    request_id: str | int
    option_id: str


class FreezoneCanvasAgentsIn(BaseModel):
    project_id: str
    canvas_id: str


class PendingCanvasCommandsIn(BaseModel):
    project_id: str
    canvas_id: str
    agent_id: str | None = Field(default=None, validation_alias=AliasChoices("agent_id", "agentId"))
    seen_keys: list[str] = []


class CanvasCommandToolResultIn(BaseModel):
    turn_id: str | None = None
    bridge_key: str
    project_id: str | None = None
    canvas_id: str | None = None
    agent_id: str | None = Field(default=None, validation_alias=AliasChoices("agent_id", "agentId"))
    tool_call_status: str = "completed"
    canvas_apply_status: str
    applied: bool = False
    cancelled: bool = False
    errors: list[str] = []
    applied_count: int = 0
    opened_ui_actions: int = 0
    created_node_ids: list[str] = []
    command_results: list[dict[str, Any]] = []
    message: str | None = None
    user_message: str | None = None
    agent_hint: str | None = None


class CanvasContextToolResultIn(BaseModel):
    turn_id: str | None = None
    anchor_text_prefix: str | None = None
    bridge_key: str
    project_id: str | None = None
    canvas_id: str | None = None
    agent_id: str | None = Field(default=None, validation_alias=AliasChoices("agent_id", "agentId"))
    tool_call_status: str = "completed"
    canvas_context_status: str | None = None
    ok: bool = True
    responses: list[dict[str, Any]] = []
    errors: list[str] = []
    message: str | None = None


class SkillStudioToolResultIn(BaseModel):
    turn_id: str | None = None
    bridge_key: str
    project_id: str | None = None
    canvas_id: str | None = None
    agent_id: str | None = Field(default=None, validation_alias=AliasChoices("agent_id", "agentId"))
    tool_call_status: str = "completed"
    skill_studio_status: str = "answered"
    ok: bool = True
    action: str = "submit"
    selections: dict[str, Any] = Field(default_factory=dict)
    draft: dict[str, Any] | None = None
    saved_to_catalog: bool = False
    saved_skill_ids: list[str] = Field(default_factory=list)
    saved_recipe_ids: list[str] = Field(default_factory=list)
    errors: list[str] = []
    message: str | None = None


class ClarificationToolResultIn(BaseModel):
    turn_id: str | None = None
    anchor_text_prefix: str | None = None
    bridge_key: str
    project_id: str | None = None
    canvas_id: str | None = None
    agent_id: str | None = Field(default=None, validation_alias=AliasChoices("agent_id", "agentId"))
    tool_call_status: str = "completed"
    clarification_status: str = "answered"
    ok: bool = True
    action: str = "submit"
    answers: dict[str, Any] = Field(default_factory=dict)
    skipped: bool = False
    used_recommended: bool = False
    errors: list[str] = []
    message: str | None = None


class ChatNotificationIn(BaseModel):
    scope: ChatScopePayload | None = None
    text: str


@router.post("/chat/notifications")
async def append_chat_notification(
    payload: ChatNotificationIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    username = str(user["username"])
    scope = _scope_from_model(payload.scope)
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if len(text) > 4000:
        raise HTTPException(status_code=400, detail="text is too long")

    if scope.kind == "project":
        project_ctx = await _project_context_for_scope(user, scope)
        if not scope.id:
            raise HTTPException(status_code=400, detail="project scope id is required")
        message = chat_service.add_assistant_message(
            username,
            str(scope.id),
            text,
            project_dir=project_ctx.output_dir if project_ctx is not None else None,
            project_state_dir=project_ctx.state_dir if project_ctx is not None else None,
        )
    else:
        message = chat_store.append_message(username, scope, "assistant", text)
    return {"ok": True, "data": message}


@router.post("/chat/ui-events")
async def append_chat_ui_event(
    payload: ChatUiEventIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    username = str(user["username"])
    scope = _scope_from_model(payload.scope)
    if scope.kind == "project":
        await _project_context_for_scope(user, scope)
    turn_id = payload.turn_id.strip()
    if not turn_id:
        raise HTTPException(status_code=400, detail="turn_id is required")
    try:
        event = chat_store.append_ui_event(username, scope, turn_id, payload.event)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": event}


@router.post("/chat/permission-result")
async def resolve_agent_permission(
    payload: AgentPermissionResultIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    scope = _scope_from_model(payload.scope)
    if scope.kind in {"project", "freezone"}:
        await _project_context_for_scope(user, scope)
    option_id = payload.option_id.strip()
    if not option_id:
        raise HTTPException(status_code=400, detail="option_id is required")
    from novelvideo.chat.hermes_pool import pool as hermes_pool

    agent_profile = _freezone_agent_profile(scope) if _is_freezone_scope(scope) else "main"
    resolved = await hermes_pool.resolve_permission(
        str(user["username"]),
        agent_profile,
        payload.request_id,
        option_id,
    )
    if not resolved:
        raise HTTPException(status_code=404, detail="permission request is no longer pending")
    return {"ok": True, "data": {"resolved": True}}


@router.post("/chat/freezone-canvas-agents")
async def list_freezone_canvas_agents(
    payload: FreezoneCanvasAgentsIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    project_id = payload.project_id.strip()
    canvas_id = payload.canvas_id.strip()
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required")
    if not canvas_id:
        raise HTTPException(status_code=400, detail="canvas_id is required")
    scope = ChatScope(
        kind="project",
        id=project_id,
        surface="freezone",
        canvas_id=canvas_id,
        agent_id="main",
    )
    await _project_context_for_scope(user, scope)
    agents = chat_store.list_freezone_canvas_agent_summaries(
        str(user["username"]),
        project_id=project_id,
        canvas_id=canvas_id,
    )
    return {"ok": True, "data": {"agents": agents}}


def _canvas_bridge_dir(username: str, *, profile: str = "director") -> Any:
    workspace_profile = "freezone" if profile.startswith("freezone") else "director"
    home = ensure_user_hermes_workspace(username, profile=workspace_profile)
    return canvas_bridge_dir_for_profile(home, profile)


def _is_freezone_scope(scope: ChatScope) -> bool:
    return scope.kind == "freezone" or (scope.kind == "project" and scope.surface == "freezone")


def _canvas_bridge_profile_for_scope(scope: ChatScope) -> str:
    if _is_freezone_scope(scope):
        return f"freezone:{scope.agent_id or 'main'}"
    return "director"


def _candidate_canvas_bridge_dirs_for_scope(username: str, scope: ChatScope) -> list[Any]:
    if not _is_freezone_scope(scope):
        return [_canvas_bridge_dir(username, profile="director")]
    dirs = [
        _canvas_bridge_dir(username, profile=_canvas_bridge_profile_for_scope(scope)),
        _canvas_bridge_dir(username, profile="freezone"),
    ]
    unique: list[Any] = []
    seen: set[str] = set()
    for path in dirs:
        marker = str(path)
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(path)
    return unique


def _freezone_agent_profile(scope: ChatScope) -> str:
    return f"freezone:{scope.agent_id or 'main'}"


def _chat_run_lock_project_for_scope(scope: ChatScope) -> str:
    if _is_freezone_scope(scope) and scope.id:
        return chat_service._chat_run_lock_project_for_turn(
            str(scope.id),
            tool_mode="freezone_canvas",
            store_scope=scope,
        )
    return str(scope.id) if scope.kind == "project" and scope.id else ""


def _freezone_agent_id_from_payload(payload: Any) -> str:
    agent_id = str(
        getattr(payload, "agent_id", None)
        or "main"
    ).strip()
    return agent_id or "main"


def _candidate_canvas_bridge_dirs(username: str, payload: Any) -> list[Any]:
    """Return bridge dirs that may contain the pending file for a canvas tool call.

    Older/freezone-main workers wrote pending files into the Freezone workspace's
    base bridge directory, while newer agent-profiled workers use a
    ``freezone_<agent>`` subdirectory.  Resolve against the directory that
    actually contains the pending file so Hermes does not keep waiting after the
    browser has already applied the command.
    """
    if getattr(payload, "canvas_id", None):
        dirs = [
            _canvas_bridge_dir(
                username,
                profile=f"freezone:{_freezone_agent_id_from_payload(payload)}",
            ),
            _canvas_bridge_dir(username, profile="freezone"),
        ]
    else:
        dirs = [_canvas_bridge_dir(username, profile="director")]
    unique: list[Any] = []
    seen: set[str] = set()
    for path in dirs:
        marker = str(path)
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(path)
    return unique


def _bridge_dir_for_pending_key(username: str, payload: Any) -> Any:
    key = str(getattr(payload, "bridge_key", "") or "").strip()
    candidates = _candidate_canvas_bridge_dirs(username, payload)
    for directory in candidates:
        try:
            if (directory / f"{key}.pending.json").exists():
                return directory
        except Exception:
            continue
    return candidates[0]


async def _close_freezone_agent_worker(username: str, agent_id: str | None) -> bool:
    try:
        from novelvideo.chat.hermes_pool import pool as hermes_pool

        return await hermes_pool.close_user_profile(username, f"freezone:{agent_id or 'main'}")
    except Exception:
        logger.exception("failed to close freezone hermes worker after canvas command cancellation")
        return False


async def _close_canvas_command_worker(username: str, payload: CanvasCommandToolResultIn) -> bool:
    if payload.canvas_id:
        return await _close_freezone_agent_worker(username, _freezone_agent_id_from_payload(payload))
    try:
        from novelvideo.chat.hermes_pool import pool as hermes_pool

        return await hermes_pool.close_user(username)
    except Exception:
        logger.exception("failed to close hermes worker after canvas command cancellation")
        return False


def _resolve_canvas_command_tool_result_payload(
    payload: CanvasCommandToolResultIn,
    *,
    username: str,
) -> dict[str, Any]:
    key = payload.bridge_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="bridge_key is required")
    command_ok = (
        payload.tool_call_status == "completed"
        and payload.canvas_apply_status == "applied"
        and payload.applied
        and not payload.cancelled
        and not payload.errors
    )
    if payload.canvas_apply_status == "cancelled_by_user":
        message = "User cancelled the canvas command before execution."
        agent_instruction = "Do not claim the canvas change was applied; ask the user before retrying."
    elif not command_ok:
        message = payload.user_message or payload.message or "Frontend executor reported that the canvas command failed."
        agent_instruction = (
            payload.agent_hint
            or "Do not claim success. Read errors and command_results, then fix the command before trying again. Do not expose raw canvas protocol details to the user."
        )
    else:
        message = payload.message or "Frontend executor applied the canvas command."
        agent_instruction = "Canvas command applied successfully."
    result = {
        "ok": command_ok,
        "turn_id": payload.turn_id,
        "tool_call_status": payload.tool_call_status,
        "canvas_apply_status": payload.canvas_apply_status,
        "applied": payload.applied,
        "cancelled": payload.cancelled,
        "errors": payload.errors,
        "applied_count": payload.applied_count,
        "opened_ui_actions": payload.opened_ui_actions,
        "created_node_ids": payload.created_node_ids,
        "command_results": payload.command_results,
        "project_id": payload.project_id,
        "canvas_id": payload.canvas_id,
        "message": message,
        "user_message": payload.user_message,
        "agent_instruction": agent_instruction,
        "agent_hint": payload.agent_hint,
    }
    return resolve_canvas_command(
        key,
        result,
        bridge_dir=_bridge_dir_for_pending_key(username, payload),
    )


def _resolve_canvas_context_tool_result_payload(
    payload: CanvasContextToolResultIn,
    *,
    username: str,
) -> dict[str, Any]:
    key = payload.bridge_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="bridge_key is required")
    result = {
        "ok": payload.ok and payload.tool_call_status == "completed",
        "tool_call_status": payload.tool_call_status,
        "canvas_context_status": payload.canvas_context_status
        or ("resolved" if payload.ok and payload.tool_call_status == "completed" else "failed"),
        "responses": payload.responses,
        "errors": payload.errors,
        "project_id": payload.project_id,
        "canvas_id": payload.canvas_id,
        "message": payload.message or "Frontend returned requested canvas context.",
    }
    return resolve_canvas_context(
        key,
        result,
        bridge_dir=_bridge_dir_for_pending_key(username, payload),
    )


def _skill_studio_draft_catalog_ids(draft: dict[str, Any] | None) -> tuple[list[str], list[str]]:
    if not isinstance(draft, dict):
        return [], []
    skill = draft.get("skill")
    skill_id = ""
    if isinstance(skill, dict):
        skill_id = str(skill.get("id") or "").strip()
    recipe_ids: list[str] = []
    recipes = draft.get("recipes")
    if isinstance(recipes, list):
        for recipe in recipes:
            if not isinstance(recipe, dict):
                continue
            recipe_id = str(recipe.get("id") or "").strip()
            if recipe_id:
                recipe_ids.append(recipe_id)
    return ([skill_id] if skill_id else []), recipe_ids


def _save_skill_studio_draft_catalog(
    *,
    username: str,
    draft: dict[str, Any] | None,
) -> tuple[list[str], list[str], list[str]]:
    if not isinstance(draft, dict):
        return [], [], ["Skill Studio draft is missing."]

    saved_skill_ids: list[str] = []
    saved_recipe_ids: list[str] = []
    errors: list[str] = []
    skill = draft.get("skill")
    if isinstance(skill, dict) and str(skill.get("id") or "").strip():
        try:
            saved = save_user_agent_config_item(username=username, kind="skills", payload=skill)
            saved_skill_ids.append(str(saved.get("id") or skill.get("id")))
        except Exception as exc:
            errors.append(f"Failed to save Skill: {exc}")

    recipes = draft.get("recipes")
    if isinstance(recipes, list):
        for index, recipe in enumerate(recipes):
            if not isinstance(recipe, dict) or not str(recipe.get("id") or "").strip():
                continue
            try:
                saved = save_user_agent_config_item(username=username, kind="recipes", payload=recipe)
                saved_recipe_ids.append(str(saved.get("id") or recipe.get("id")))
            except Exception as exc:
                recipe_id = str(recipe.get("id") or f"#{index + 1}")
                errors.append(f"Failed to save Recipe {recipe_id}: {exc}")

    if not saved_skill_ids and not saved_recipe_ids and not errors:
        errors.append("Skill Studio draft does not contain a Skill or Recipe id.")
    return saved_skill_ids, saved_recipe_ids, errors


def _resolve_skill_studio_tool_result_payload(
    payload: SkillStudioToolResultIn,
    *,
    username: str,
) -> dict[str, Any]:
    key = payload.bridge_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="bridge_key is required")
    ok = payload.ok and payload.tool_call_status == "completed" and not payload.errors
    draft_skill_ids, draft_recipe_ids = _skill_studio_draft_catalog_ids(payload.draft)
    saved_to_catalog = payload.saved_to_catalog or payload.skill_studio_status == "catalog_saved"
    saved_skill_ids = payload.saved_skill_ids or draft_skill_ids
    saved_recipe_ids = payload.saved_recipe_ids or draft_recipe_ids
    errors = list(payload.errors)
    cancelled = (
        payload.action == "cancel"
        or payload.skill_studio_status == "catalog_cancelled"
    )
    revision_started = (
        payload.action == "start_revision"
        or payload.skill_studio_status == "revision_started"
    )
    if ok and saved_to_catalog:
        saved_skill_ids, saved_recipe_ids, catalog_errors = _save_skill_studio_draft_catalog(
            username=username,
            draft=payload.draft,
        )
        if catalog_errors:
            errors.extend(catalog_errors)
            ok = False
    if ok:
        if saved_to_catalog:
            agent_instruction = (
                "The frontend has saved this Skill/Recipe draft to the Freezone catalog. "
                "Treat it as official saved catalog content that can be used immediately. "
                "Do not ask the user to save it again."
            )
            message = payload.message or "Frontend saved the Skill/Recipe draft to the Freezone catalog."
        elif cancelled:
            agent_instruction = (
                "The user cancelled saving this Skill/Recipe draft. "
                "Do not continue this Skill Studio flow; acknowledge the cancellation and stop. "
                "Do not create canvas nodes, do not execute workflows, and do not continue to another stage "
                "unless the user explicitly asks for a next step."
            )
            message = payload.message or "Frontend reported that the user cancelled saving the Skill/Recipe draft."
        elif revision_started:
            agent_instruction = (
                "Start a Skill Studio draft revision question flow. "
                "Use the current draft from this tool result as the source of truth. "
                "The user already asked to revise the current draft. "
                "Do not ask whether revision is needed; ask directly about the concrete revision direction, scope, or preference. "
                "Do not ask whether to save the current draft, and do not offer save_now/save_current/confirm_save as a question option; "
                "saving is handled only by the existing draft card UI after an updated draft is presented. "
                "When asking with freezone_request_user_clarification, send exactly one question object in the questions array, "
                "then wait for the answer before deciding the next question. "
                "When enough information is available, use chunked draft tools: "
                "freezone_begin_agent_catalog_draft, freezone_put_agent_catalog_skill, "
                "freezone_put_agent_catalog_recipe once per changed Recipe, or freezone_patch_agent_catalog_draft "
                "for local field edits, then freezone_finish_agent_catalog_draft. "
                "For local edits, prefer freezone_patch_agent_catalog_draft. Use put_skill / put_recipe only when "
                "replacing an entire Skill or Recipe object. Do not regenerate unchanged Recipes. "
                "For target=recipe, pass recipe_id and use patch paths relative to that Recipe object, "
                "for example /system_prompt or /must_have_items; never use /recipes/<recipe_id>/... inside patch.path. "
                "To remove the entire selected Recipe, use exactly one patch operation: "
                '{"op":"remove","path":""}. '
                "Before freezone_begin_agent_catalog_draft, decide the full planned Recipe count for the updated draft "
                "and pass expected_recipe_count; use the full draft count, not only the changed Recipe count. "
                "Do not pass the full Skill/Recipe catalog in one tool call. "
                "Only use freezone_request_user_clarification or the Skill Studio chunked draft tools as the next Skill Studio step. "
                "Do not answer with prose, do not only summarize the requested changes, and do not tell the user to save unless a draft tool call has produced the updated draft. "
                "Do not save catalog content, do not emit canvas commands, and do not treat this as ordinary Freezone creation."
            )
            message = payload.message or "Frontend reported that the user started revising the Skill/Recipe draft."
        else:
            agent_instruction = "Continue the Skill Studio flow using the frontend response."
            message = payload.message or "Frontend returned the user's Skill Studio response."
    else:
        agent_instruction = "Do not continue the Skill Studio flow; handle the frontend error or ask the user to retry."
        message = payload.message or "Frontend reported that the Skill Studio interaction failed."
    result = {
        "ok": ok,
        "turn_id": payload.turn_id,
        "tool_call_status": payload.tool_call_status,
        "skill_studio_status": payload.skill_studio_status,
        "action": payload.action,
        "selections": payload.selections,
        "draft": payload.draft,
        "saved_to_catalog": saved_to_catalog,
        "saved_skill_ids": saved_skill_ids,
        "saved_recipe_ids": saved_recipe_ids,
        "errors": errors,
        "project_id": payload.project_id,
        "canvas_id": payload.canvas_id,
        "message": message,
        "agent_instruction": agent_instruction,
    }
    return resolve_skill_studio_result(
        key,
        result,
        bridge_dir=_canvas_bridge_dir(
            username,
            profile=f"freezone:{_freezone_agent_id_from_payload(payload)}"
            if result.get("canvas_id")
            else "director",
        ),
    )


def _resolve_clarification_tool_result_payload(
    payload: ClarificationToolResultIn,
    *,
    username: str,
) -> dict[str, Any]:
    key = payload.bridge_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="bridge_key is required")
    ok = payload.ok and payload.tool_call_status == "completed" and not payload.errors
    if ok:
        agent_instruction = "Continue using the frontend clarification response."
        message = payload.message or "Frontend returned the user's clarification response."
    else:
        agent_instruction = "Do not continue; handle the clarification error or ask the user to retry."
        message = payload.message or "Frontend reported that the clarification interaction failed."
    result = {
        "ok": ok,
        "turn_id": payload.turn_id,
        "tool_call_status": payload.tool_call_status,
        "clarification_status": payload.clarification_status,
        "action": payload.action,
        "answers": payload.answers,
        "skipped": payload.skipped,
        "used_recommended": payload.used_recommended,
        "errors": payload.errors,
        "project_id": payload.project_id,
        "canvas_id": payload.canvas_id,
        "message": message,
        "agent_instruction": agent_instruction,
    }
    return resolve_clarification_result(
        key,
        result,
        bridge_dir=_canvas_bridge_dir(
            username,
            profile=f"freezone:{_freezone_agent_id_from_payload(payload)}"
            if result.get("canvas_id")
            else "director",
        ),
    )


def _scope_from_interaction_payload(payload: SkillStudioToolResultIn | ClarificationToolResultIn) -> ChatScope | None:
    project_id = str(payload.project_id or "").strip()
    canvas_id = str(payload.canvas_id or "").strip()
    if not project_id or not canvas_id:
        return None
    return ChatScope(
        kind="project",
        id=project_id,
        surface="freezone",
        canvas_id=canvas_id,
        agent_id=_freezone_agent_id_from_payload(payload),
    )


def _persist_skill_studio_result_ui_event(
    *,
    username: str,
    payload: SkillStudioToolResultIn,
) -> None:
    turn_id = str(payload.turn_id or "").strip()
    scope = _scope_from_interaction_payload(payload)
    if not turn_id or scope is None:
        return
    event: dict[str, Any] = {
        "type": "skill_studio.questions" if payload.draft is None else "skill_studio.draft",
        "bridge_key": payload.bridge_key,
        "project_id": payload.project_id,
        "canvas_id": payload.canvas_id,
        "agent_id": payload.agent_id,
        "submitted": True,
        "action": payload.action,
        "skill_studio_status": payload.skill_studio_status,
    }
    if payload.selections:
        event["selections"] = payload.selections
    if payload.draft is not None:
        event["draft"] = payload.draft
    if payload.action == "start_revision" or payload.skill_studio_status == "revision_started":
        event["revision_pending"] = True
    if payload.saved_to_catalog or payload.skill_studio_status == "catalog_saved":
        event["saved_to_catalog"] = True
        draft_skill_ids, draft_recipe_ids = _skill_studio_draft_catalog_ids(payload.draft)
        event["saved_skill_ids"] = payload.saved_skill_ids or draft_skill_ids
        event["saved_recipe_ids"] = payload.saved_recipe_ids or draft_recipe_ids
    chat_store.append_ui_event(username, scope, turn_id, event)


def _persist_clarification_result_ui_event(
    *,
    username: str,
    payload: ClarificationToolResultIn,
) -> None:
    turn_id = str(payload.turn_id or "").strip()
    scope = _scope_from_interaction_payload(payload)
    if not turn_id or scope is None:
        return
    chat_store.append_ui_event(
        username,
        scope,
        turn_id,
        {
            "type": "assistant.clarification.request",
            "bridge_key": payload.bridge_key,
            "project_id": payload.project_id,
            "canvas_id": payload.canvas_id,
            "agent_id": payload.agent_id,
            "submitted": True,
            "action": payload.action,
            "clarification_status": payload.clarification_status,
            "answers": payload.answers,
            "skipped": payload.skipped,
            "used_recommended": payload.used_recommended,
            "anchor_text_prefix": payload.anchor_text_prefix,
        },
    )


def _canvas_context_ui_event(
    payload: CanvasContextToolResultIn,
    resolved: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": "canvas_context_result.v1",
        "type": "canvas_context_result",
        "canvas_id": resolved.get("canvas_id"),
        "bridge_key": payload.bridge_key,
        "result": {
            "ok": resolved.get("ok"),
            "tool_call_status": resolved.get("tool_call_status"),
            "canvas_context_status": resolved.get("canvas_context_status"),
            "responses": resolved.get("responses") or [],
            "errors": resolved.get("errors") or [],
            "message": resolved.get("message"),
        },
        "anchor_text_prefix": payload.anchor_text_prefix,
    }


@router.post("/chat/canvas-command-tool-result")
async def resolve_canvas_command_tool_result(
    payload: CanvasCommandToolResultIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    username = str(user["username"])
    resolved = _resolve_canvas_command_tool_result_payload(payload, username=username)
    if payload.cancelled or payload.canvas_apply_status == "cancelled_by_user":
        await _close_canvas_command_worker(username, payload)
    return {"ok": True, "data": resolved}


@router.post("/chat/canvas-context-tool-result")
async def resolve_canvas_context_tool_result(
    payload: CanvasContextToolResultIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    username = str(user["username"])
    resolved = _resolve_canvas_context_tool_result_payload(payload, username=username)
    context_turn_id = str(payload.turn_id or "").strip()
    project_id = str(resolved.get("project_id") or payload.project_id or "").strip()
    canvas_id = str(resolved.get("canvas_id") or payload.canvas_id or "").strip()
    if context_turn_id and project_id and canvas_id:
        try:
            scope = ChatScope(
                kind="project",
                id=project_id,
                surface="freezone",
                canvas_id=canvas_id,
                agent_id=_freezone_agent_id_from_payload(payload),
            )
            project_ctx = await _project_context_for_scope(user, scope)
            chat_store.append_ui_event(
                username,
                scope,
                context_turn_id,
                _canvas_context_ui_event(payload, resolved),
            )
            if project_ctx is not None:
                # Keep the route symmetric with project-scoped validation even
                # though Freezone chat history is stored through chat_store.
                _ = project_ctx
        except Exception:
            logger.exception("failed to persist canvas.context.result ui event")
    return {"ok": True, "data": resolved}


@router.post("/chat/skill-studio-tool-result")
async def resolve_skill_studio_tool_result(
    payload: SkillStudioToolResultIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    username = str(user["username"])
    resolved = _resolve_skill_studio_tool_result_payload(payload, username=username)
    try:
        _persist_skill_studio_result_ui_event(username=username, payload=payload)
    except Exception:
        logger.exception("failed to persist skill studio result ui event")
    return {"ok": True, "data": resolved}


@router.post("/chat/clarification-tool-result")
async def resolve_clarification_tool_result(
    payload: ClarificationToolResultIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    username = str(user["username"])
    resolved = _resolve_clarification_tool_result_payload(payload, username=username)
    try:
        _persist_clarification_result_ui_event(username=username, payload=payload)
    except Exception:
        logger.exception("failed to persist clarification result ui event")
    return {"ok": True, "data": resolved}


async def _receive_bridge_results_during_turn(
    *,
    websocket: WebSocket,
    username: str,
) -> None:
    while True:
        try:
            raw = await websocket.receive_json()
        except asyncio.CancelledError:
            raise
        except RuntimeError as exc:
            if "WebSocket is not connected" in str(exc):
                return
            raise
        except WebSocketDisconnect:
            return

        event_type = str(raw.get("type") or "")
        if event_type == "canvas.command.result":
            payload = CanvasCommandToolResultIn.model_validate(raw)
            _resolve_canvas_command_tool_result_payload(payload, username=username)
            if payload.cancelled or payload.canvas_apply_status == "cancelled_by_user":
                await _close_canvas_command_worker(username, payload)
            continue

        if event_type == "canvas.context.result":
            payload = CanvasContextToolResultIn.model_validate(raw)
            _resolve_canvas_context_tool_result_payload(payload, username=username)
            continue

        if event_type == "skill_studio.result":
            payload = SkillStudioToolResultIn.model_validate(raw)
            _resolve_skill_studio_tool_result_payload(payload, username=username)
            try:
                _persist_skill_studio_result_ui_event(username=username, payload=payload)
            except Exception:
                logger.exception("failed to persist skill studio result ui event")
            continue

        if event_type == "assistant.clarification.result":
            payload = ClarificationToolResultIn.model_validate(raw)
            _resolve_clarification_tool_result_payload(payload, username=username)
            try:
                _persist_clarification_result_ui_event(username=username, payload=payload)
            except Exception:
                logger.exception("failed to persist clarification result ui event")
            continue

        logger.debug("ignoring websocket event during active chat turn: %s", event_type)


async def _authenticate_ws(websocket: WebSocket) -> dict[str, Any]:
    bearer = websocket.headers.get("Authorization", "").strip()
    if bearer:
        token = bearer.partition(" ")[2].strip() if bearer.lower().startswith("bearer ") else ""
        if token:
            return await _verify_agent_bearer(token)

    cookie_value = websocket.cookies.get(AUTH_COOKIE_NAME)
    return await _verify_browser_session(cookie_value)


def _scope_from_model(model: ChatScopePayload | None) -> ChatScope:
    return ChatScope.from_payload(model.model_dump() if model else None)


def _should_prewarm_on_ws_connect(scope: ChatScope) -> bool:
    return scope.kind != "home"


def _completion_text_or_existing(event_text: object, existing: str) -> str:
    final_text = str(event_text or "").strip()
    if not final_text or final_text.startswith("stop="):
        return existing
    if final_text.lower() == "(hermes timed out)" and existing.strip():
        return existing
    if existing.strip() and _is_completion_notice(final_text):
        if final_text in existing:
            return existing
        return f"{existing.rstrip()}\n\n{final_text}"
    return final_text


def _is_completion_notice(text: str) -> bool:
    return text in {
        "当前任务已开始处理。请稍后让我查看当前任务进度，或在任务完成后再继续下一步。",
        "刚才这一步没有成功启动任务。请先根据返回的错误补齐前置条件；如果是配音缺少声线，可以到「虾塘」上传或录制缺失声线后再继续。",
    }


def _message_content(message: object) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    text = message.get("text")
    if isinstance(text, str):
        return text.strip()
    return ""


def _attachment_context_block(attachments: list[ChatAttachmentIn]) -> str:
    if not attachments:
        return ""
    lines = [
        "[CHAT_ATTACHMENTS]",
        "The browser sent these attachment records with the user message.",
    ]
    for index, attachment in enumerate(attachments, 1):
        lines.append("")
        lines.append(f"{index}. fileName={attachment.fileName or ''}")
        lines.append(f"   type={attachment.type or ''}")
        lines.append(f"   mimeType={attachment.mimeType or ''}")
        if attachment.fileSize is not None:
            lines.append(f"   fileSize={attachment.fileSize}")
        if attachment.url:
            lines.append(f"   url={attachment.url}")
        if attachment.path:
            lines.append(f"   path={attachment.path}")
        if attachment.content:
            lines.append("   content=present")
    lines.append("[/CHAT_ATTACHMENTS]")
    return "\n".join(lines)


def _text_with_attachment_context(text: str, attachments: list[ChatAttachmentIn]) -> str:
    block = _attachment_context_block(attachments)
    return f"{text}\n\n{block}" if block else text


def _attachment_payloads(attachments: list[ChatAttachmentIn]) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for attachment in attachments:
        payload = attachment.model_dump(exclude_none=True)
        if payload:
            payloads.append(payload)
    return payloads


def _should_emit_final_text(final_text: str, last_sent_text: str) -> bool:
    final = " ".join(str(final_text or "").split())
    last = " ".join(str(last_sent_text or "").split())
    return bool(final) and final != last


def _tool_display_payload(text: object, name: object = None) -> tuple[str, str]:
    raw = str(text or "").strip()
    tool_name = str(name or "").strip()
    lines = raw.splitlines()
    if lines and lines[0].lstrip().startswith("→ "):
        first = lines[0].lstrip()[2:].strip()
        head, sep, tail = first.partition(":")
        if sep and head.strip():
            tool_name = tool_name or head.strip()
            lines[0] = tail.strip()
        else:
            tool_name = tool_name or (first.split()[0].strip() if first else "")
            lines = lines[1:]
    body = "\n".join(line for line in lines if line.strip()).strip()
    return tool_name or "agent.tool", body


async def _project_context_for_scope(
    user: dict[str, Any], scope: ChatScope
) -> ProjectContext | None:
    if scope.kind not in {"project", "freezone"} or not scope.id:
        return None
    return await resolve_project_context(
        user=user,
        project_id=str(scope.id),
        required_role="viewer",
    )


async def _requester_user_id_for_chat(user: dict[str, Any], scope: ChatScope) -> str:
    if scope.kind == "project":
        project_ctx = await _project_context_for_scope(user, scope)
        if project_ctx is not None and project_ctx.requester_user_id:
            return project_ctx.requester_user_id
    user_id = str(user.get("id") or user.get("user_id") or "").strip()
    if user_id:
        return user_id
    return str(user.get("username") or "").strip()


async def _require_ai_assistant_access(
    *,
    user: dict[str, Any],
    scope: ChatScope,
) -> None:
    user_id = await _requester_user_id_for_chat(user, scope)
    await get_usage_meter().require_feature_credit_balance(
        user_id=user_id,
        feature_key=AI_ASSISTANT_CHAT_FEATURE_KEY,
        project_id=str(scope.id or "") if scope.kind == "project" else "",
        resource_kind="chat",
        metadata={"scope": scope.to_dict()},
    )


async def _history(
    username: str,
    scope: ChatScope,
    *,
    project_ctx: ProjectContext | None = None,
) -> list[dict[str, Any]]:
    if scope.kind == "project" and (scope.surface or "director") == "director":
        return chat_service.list_messages(
            username,
            str(scope.id),
            project_dir=project_ctx.output_dir if project_ctx is not None else None,
            project_state_dir=project_ctx.state_dir if project_ctx is not None else None,
        )
    if scope.kind == "freezone":
        return chat_store.list_messages(username, scope)
    return chat_store.list_messages(username, scope)


async def _send_scope_changed(
    websocket: WebSocket,
    user: dict[str, Any],
    username: str,
    scope: ChatScope,
) -> ChatScope | None:
    try:
        project_ctx = await _project_context_for_scope(user, scope)
    except HTTPException as exc:
        if scope.kind not in {"project", "freezone"} or exc.status_code != 404:
            raise
        scope = ChatScope(kind="home")
        project_ctx = None
        if not await _send_json_best_effort(
            websocket,
            {"type": "error", "message": "项目不存在或已删除，已切回首页聊天。"}
        ):
            return None
    if not await _send_json_best_effort(
        websocket,
        {
            "type": "scope.changed",
            "scope": scope.to_dict(),
            "history": await _history(username, scope, project_ctx=project_ctx),
            "busy": chat_service.chat_run_lock_is_active(username, _chat_run_lock_project_for_scope(scope)),
        }
    ):
        return None
    return scope


async def _send_json_best_effort(
    websocket: WebSocket,
    payload: dict[str, Any],
    send_lock: asyncio.Lock | None = None,
) -> bool:
    try:
        if send_lock is None:
            await websocket.send_json(payload)
        else:
            async with send_lock:
                await websocket.send_json(payload)
        return True
    except Exception:
        return False


async def _chat_heartbeat(
    websocket: WebSocket,
    *,
    scope: ChatScope,
    turn_id: str,
    send_lock: asyncio.Lock,
    interval_seconds: float = 10.0,
) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        sent = await _send_json_best_effort(
            websocket,
            {"type": "chat.ping", "turn_id": turn_id, "scope": scope.to_dict()},
            send_lock,
        )
        if not sent:
            return


async def _sync_running_agent_scope(username: str, scope: ChatScope) -> None:
    try:
        from novelvideo.chat.hermes_pool import pool as hermes_pool

        await hermes_pool.set_scope_for_user(
            username,
            agent_profile=_freezone_agent_profile(scope) if _is_freezone_scope(scope) else "main",
            scope_kind="project" if _is_freezone_scope(scope) else scope.kind,
            project_id=scope.id if scope.kind in {"project", "freezone"} else None,
        )
    except Exception:
        # Scope switching should not spawn or break the UI if Hermes is absent.
        return


def _load_pending_canvas_command(path: Any) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    commands = payload.get("commands")
    if not isinstance(commands, list) or not commands:
        return None
    envelope = payload.get("envelope")
    if not isinstance(envelope, dict):
        envelope = {
            "schema_version": "canvas_chat_commands.v1",
            "canvas_id": payload.get("canvas_id"),
            "commands": commands,
        }
    if not isinstance(envelope.get("commands"), list) or not envelope.get("commands"):
        return None
    return {
        "key": str(payload.get("key") or path.name.removesuffix(".pending.json")),
        "project_id": payload.get("project_id"),
        "canvas_id": payload.get("canvas_id") or envelope.get("canvas_id"),
        "envelope": envelope,
    }


@router.post("/chat/pending-canvas-commands")
async def list_pending_canvas_commands(
    payload: PendingCanvasCommandsIn,
    user: dict = Depends(get_api_user),
) -> dict[str, Any]:
    username = str(user["username"])
    project_id = payload.project_id.strip()
    canvas_id = payload.canvas_id.strip()
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required")
    if not canvas_id:
        raise HTTPException(status_code=400, detail="canvas_id is required")

    agent_id = str(payload.agent_id or "main").strip() or "main"
    seen_keys = {str(key) for key in payload.seen_keys if str(key).strip()}
    scope = ChatScope(
        kind="project",
        id=project_id,
        surface="freezone",
        canvas_id=canvas_id,
        agent_id=agent_id,
    )
    frames: list[dict[str, Any]] = []
    for bridge_dir in _candidate_canvas_bridge_dirs_for_scope(username, scope):
        try:
            pending_paths = sorted(
                bridge_dir.glob("*.pending.json"),
                key=lambda item: item.stat().st_mtime,
            )
        except Exception:
            continue
        for path in pending_paths:
            key = path.name.removesuffix(".pending.json")
            if key in seen_keys:
                continue
            pending = _load_pending_canvas_command(path)
            if pending is None:
                continue
            if pending.get("project_id") and pending.get("project_id") != project_id:
                continue
            if pending.get("canvas_id") and pending.get("canvas_id") != canvas_id:
                continue
            envelope = pending["envelope"]
            frames.append(
                {
                    "type": "canvas.command",
                    "turn_id": f"external-agent:{key}",
                    "canvas_id": envelope.get("canvas_id") or canvas_id,
                    "agent_id": agent_id,
                    "bridge_key": key,
                    "envelope": envelope,
                    "source": "pending_canvas_bridge",
                }
            )
            if len(frames) >= 10:
                return {"ok": True, "data": {"frames": frames}}
    return {"ok": True, "data": {"frames": frames}}


def _load_pending_canvas_context(path: Any) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    requests = payload.get("requests")
    if not isinstance(requests, list) or not requests:
        return None
    envelope = payload.get("envelope")
    if not isinstance(envelope, dict):
        envelope = {
            "schema_version": "canvas_context_request.v1",
            "canvas_id": payload.get("canvas_id"),
            "requests": requests,
        }
    if envelope.get("schema_version") != "canvas_context_request.v1":
        return None
    if not isinstance(envelope.get("requests"), list) or not envelope.get("requests"):
        return None
    return {
        "key": str(payload.get("key") or path.name.removesuffix(".pending.json")),
        "project_id": payload.get("project_id"),
        "canvas_id": payload.get("canvas_id") or envelope.get("canvas_id"),
        "envelope": envelope,
    }


def _pending_canvas_command_timed_out(path: Any, *, stale_seconds: float = 45.0) -> bool:
    try:
        return (time.time() - path.stat().st_mtime) >= stale_seconds
    except Exception:
        return False


def _drop_resolved_pending_bridge_file(*, bridge_dir: Any, key: str, pending_path: Any) -> bool:
    if not (bridge_dir / f"{key}.result.json").exists():
        return False
    with contextlib.suppress(FileNotFoundError):
        pending_path.unlink()
    return True


def _resolve_stale_pending_canvas_command(
    *,
    bridge_dir: Any,
    path: Any,
    key: str,
    pending: dict[str, Any],
    scope: ChatScope,
    turn_id: str,
) -> bool:
    if not _pending_canvas_command_timed_out(path):
        return False
    envelope = pending.get("envelope") if isinstance(pending, dict) else None
    commands = envelope.get("commands") if isinstance(envelope, dict) else None
    resolve_canvas_command(
        key,
        {
            "ok": False,
            "turn_id": turn_id,
            "tool_call_status": "failed",
            "canvas_apply_status": "timeout",
            "applied": False,
            "cancelled": True,
            "errors": ["Timed out waiting for frontend canvas command result."],
            "applied_count": 0,
            "opened_ui_actions": [],
            "created_node_ids": [],
            "command_results": [],
            "project_id": pending.get("project_id") or scope.id,
            "canvas_id": pending.get("canvas_id") or scope.canvas_id,
            "message": "Canvas command timed out before the frontend reported a result.",
            "user_message": "画布操作等待超时，已自动取消，没有应用新的画布变更。",
            "agent_instruction": (
                "Do not claim success. Tell the user the canvas command timed out and ask "
                "them to retry after checking the canvas connection."
            ),
        },
        bridge_dir=bridge_dir,
    )
    logger.warning(
        "auto-resolved stale canvas.command pending bridge_key=%s turn_id=%s canvas_id=%s commands=%s",
        key,
        turn_id,
        pending.get("canvas_id") or scope.canvas_id,
        len(commands) if isinstance(commands, list) else 0,
    )
    return True


def _resolve_stale_pending_canvas_context(
    *,
    bridge_dir: Any,
    path: Any,
    key: str,
    pending: dict[str, Any],
    scope: ChatScope,
    turn_id: str,
) -> bool:
    if not _pending_canvas_command_timed_out(path):
        return False
    envelope = pending.get("envelope") if isinstance(pending, dict) else None
    requests = envelope.get("requests") if isinstance(envelope, dict) else None
    resolve_canvas_context(
        key,
        {
            "ok": False,
            "turn_id": turn_id,
            "tool_call_status": "failed",
            "canvas_context_status": "timeout",
            "responses": [],
            "errors": ["Timed out waiting for frontend canvas context response."],
            "project_id": pending.get("project_id") or scope.id,
            "canvas_id": pending.get("canvas_id") or scope.canvas_id,
            "message": "Canvas context request timed out before the frontend reported a result.",
            "user_message": "读取画布上下文等待超时，请确认画布页面仍然打开后重试。",
            "agent_instruction": (
                "Do not wait indefinitely. Tell the user the canvas context request timed out "
                "and ask them to retry after checking the canvas connection."
            ),
        },
        bridge_dir=bridge_dir,
    )
    logger.warning(
        "auto-resolved stale canvas.context pending bridge_key=%s turn_id=%s canvas_id=%s requests=%s",
        key,
        turn_id,
        pending.get("canvas_id") or scope.canvas_id,
        len(requests) if isinstance(requests, list) else 0,
    )
    return True


def _load_pending_skill_studio_event(path: Any) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("kind") != "skill_studio_event":
        return None
    event = payload.get("event")
    if not isinstance(event, dict):
        return None
    event_type = str(event.get("type") or "").strip()
    if event_type not in {"skill_studio.questions", "skill_studio.draft", "skill_studio.status"}:
        return None
    if not str(event.get("skill_studio_session_id") or "").strip():
        return None
    return {
        "key": str(payload.get("key") or path.name.removesuffix(".pending.json")),
        "project_id": payload.get("project_id"),
        "canvas_id": payload.get("canvas_id"),
        "event": event,
    }


def _load_pending_clarification_event(path: Any) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("kind") != "clarification_event":
        return None
    event = payload.get("event")
    if not isinstance(event, dict):
        return None
    if str(event.get("type") or "").strip() != "assistant.clarification.request":
        return None
    if not str(event.get("clarification_id") or "").strip():
        return None
    return {
        "key": str(payload.get("key") or path.name.removesuffix(".pending.json")),
        "project_id": payload.get("project_id"),
        "canvas_id": payload.get("canvas_id"),
        "event": event,
    }


async def _watch_pending_canvas_commands(
    *,
    websocket: WebSocket,
    username: str,
    scope: ChatScope,
    turn_id: str,
    send_lock: asyncio.Lock,
    emitted_bridge_keys: set[str],
    started_at: float,
) -> None:
    if not _is_freezone_scope(scope):
        return
    bridge_dirs = _candidate_canvas_bridge_dirs_for_scope(username, scope)
    while True:
        await asyncio.sleep(0.4)
        pending_items = []
        for bridge_dir in bridge_dirs:
            try:
                pending_items.extend((bridge_dir, path) for path in bridge_dir.glob("*.pending.json"))
            except Exception:
                continue
        pending_items = sorted(pending_items, key=lambda item: item[1].stat().st_mtime)
        for bridge_dir, path in pending_items:
            try:
                is_preexisting_pending = path.stat().st_mtime < started_at - 1.0
            except Exception:
                continue
            key = path.name.removesuffix(".pending.json")
            if _drop_resolved_pending_bridge_file(
                bridge_dir=bridge_dir,
                key=key,
                pending_path=path,
            ):
                continue
            pending = _load_pending_canvas_command(path)
            if pending is None:
                continue
            if pending.get("project_id") and pending.get("project_id") != scope.id:
                continue
            if _resolve_stale_pending_canvas_command(
                bridge_dir=bridge_dir,
                path=path,
                key=key,
                pending=pending,
                scope=scope,
                turn_id=turn_id,
            ):
                continue
            if is_preexisting_pending:
                continue
            if key in emitted_bridge_keys:
                continue
            emitted_bridge_keys.add(key)
            envelope = pending["envelope"]
            logger.info(
                "emitting canvas.command from pending bridge turn_id=%s canvas_id=%s commands=%s",
                turn_id,
                envelope.get("canvas_id"),
                len(envelope.get("commands") or []),
            )
            sent = await _send_json_best_effort(
                websocket,
                {
                    "type": "canvas.command",
                    "turn_id": turn_id,
                    "canvas_id": envelope.get("canvas_id"),
                    "agent_id": scope.agent_id or "main",
                    "bridge_key": key,
                    "envelope": envelope,
                },
                send_lock,
            )
            if not sent:
                return


async def _watch_pending_skill_studio_events(
    *,
    websocket: WebSocket,
    username: str,
    scope: ChatScope,
    turn_id: str,
    send_lock: asyncio.Lock | None,
    emitted_bridge_keys: set[str],
    started_at: float,
) -> None:
    if not _is_freezone_scope(scope):
        return
    bridge_dir = _canvas_bridge_dir(username, profile=_canvas_bridge_profile_for_scope(scope))
    while True:
        await asyncio.sleep(0.4)
        try:
            pending_paths = sorted(
                bridge_dir.glob("*.pending.json"),
                key=lambda item: item.stat().st_mtime,
            )
        except Exception:
            continue
        for path in pending_paths:
            try:
                if path.stat().st_mtime < started_at - 1.0:
                    continue
            except Exception:
                continue
            key = path.name.removesuffix(".pending.json")
            if key in emitted_bridge_keys:
                continue
            if _drop_resolved_pending_bridge_file(
                bridge_dir=bridge_dir,
                key=key,
                pending_path=path,
            ):
                continue
            pending = _load_pending_skill_studio_event(path)
            if pending is None:
                continue
            if pending.get("project_id") and pending.get("project_id") != scope.id:
                continue
            emitted_bridge_keys.add(key)
            ui_event = {
                **pending["event"],
                "bridge_key": key,
                "project_id": pending.get("project_id") or scope.id,
                "canvas_id": pending.get("canvas_id") or scope.canvas_id,
                "agent_id": scope.agent_id or "main",
                "turn_id": turn_id,
            }
            try:
                chat_store.append_ui_event(username, scope, turn_id, ui_event)
            except Exception:
                logger.exception("failed to persist skill_studio.event ui event")
            logger.info(
                "emitting skill_studio.event from pending bridge turn_id=%s canvas_id=%s type=%s",
                turn_id,
                pending.get("canvas_id"),
                pending["event"].get("type"),
            )
            sent = await _send_json_best_effort(
                websocket,
                {
                    "type": "skill_studio.event",
                    "scope": scope.to_dict(),
                    "turn_id": turn_id,
                    "canvas_id": pending.get("canvas_id"),
                    "agent_id": scope.agent_id or "main",
                    "bridge_key": key,
                    "event": pending["event"],
                },
                send_lock,
            )
            if not sent:
                return


async def _watch_pending_clarification_events(
    *,
    websocket: WebSocket,
    username: str,
    scope: ChatScope,
    turn_id: str,
    send_lock: asyncio.Lock | None,
    emitted_bridge_keys: set[str],
    started_at: float,
) -> None:
    if not _is_freezone_scope(scope):
        return
    bridge_dir = _canvas_bridge_dir(username, profile=_canvas_bridge_profile_for_scope(scope))
    while True:
        await asyncio.sleep(0.4)
        try:
            pending_paths = sorted(
                bridge_dir.glob("*.pending.json"),
                key=lambda item: item.stat().st_mtime,
            )
        except Exception:
            continue
        for path in pending_paths:
            try:
                if path.stat().st_mtime < started_at - 1.0:
                    continue
            except Exception:
                continue
            key = path.name.removesuffix(".pending.json")
            if key in emitted_bridge_keys:
                continue
            if _drop_resolved_pending_bridge_file(
                bridge_dir=bridge_dir,
                key=key,
                pending_path=path,
            ):
                continue
            pending = _load_pending_clarification_event(path)
            if pending is None:
                continue
            if pending.get("project_id") and pending.get("project_id") != scope.id:
                continue
            emitted_bridge_keys.add(key)
            ui_event = {
                **pending["event"],
                "bridge_key": key,
                "project_id": pending.get("project_id") or scope.id,
                "canvas_id": pending.get("canvas_id") or scope.canvas_id,
                "agent_id": scope.agent_id or "main",
                "turn_id": turn_id,
            }
            try:
                chat_store.append_ui_event(username, scope, turn_id, ui_event)
            except Exception:
                logger.exception("failed to persist assistant.clarification ui event")
            logger.info(
                "emitting assistant.clarification.event from pending bridge turn_id=%s canvas_id=%s",
                turn_id,
                pending.get("canvas_id"),
            )
            sent = await _send_json_best_effort(
                websocket,
                {
                    "type": "assistant.clarification.event",
                    "scope": scope.to_dict(),
                    "turn_id": turn_id,
                    "canvas_id": pending.get("canvas_id"),
                    "agent_id": scope.agent_id or "main",
                    "bridge_key": key,
                    "event": pending["event"],
                },
                send_lock,
            )
            if not sent:
                return


async def _watch_pending_canvas_context_requests(
    *,
    websocket: WebSocket,
    username: str,
    scope: ChatScope,
    turn_id: str,
    send_lock: asyncio.Lock,
    emitted_bridge_keys: set[str],
    started_at: float,
) -> None:
    if not _is_freezone_scope(scope):
        return
    bridge_dirs = _candidate_canvas_bridge_dirs_for_scope(username, scope)
    while True:
        await asyncio.sleep(0.4)
        pending_items = []
        for bridge_dir in bridge_dirs:
            try:
                pending_items.extend((bridge_dir, path) for path in bridge_dir.glob("*.pending.json"))
            except Exception:
                continue
        pending_items = sorted(pending_items, key=lambda item: item[1].stat().st_mtime)
        for bridge_dir, path in pending_items:
            try:
                is_preexisting_pending = path.stat().st_mtime < started_at - 1.0
            except Exception:
                continue
            key = path.name.removesuffix(".pending.json")
            if _drop_resolved_pending_bridge_file(
                bridge_dir=bridge_dir,
                key=key,
                pending_path=path,
            ):
                continue
            pending = _load_pending_canvas_context(path)
            if pending is None:
                continue
            if pending.get("project_id") and pending.get("project_id") != scope.id:
                continue
            if _resolve_stale_pending_canvas_context(
                bridge_dir=bridge_dir,
                path=path,
                key=key,
                pending=pending,
                scope=scope,
                turn_id=turn_id,
            ):
                continue
            if is_preexisting_pending:
                continue
            if key in emitted_bridge_keys:
                continue
            emitted_bridge_keys.add(key)
            envelope = pending["envelope"]
            logger.info(
                "emitting canvas.context.request from pending bridge turn_id=%s canvas_id=%s requests=%s",
                turn_id,
                envelope.get("canvas_id"),
                len(envelope.get("requests") or []),
            )
            sent = await _send_json_best_effort(
                websocket,
                {
                    "type": "canvas.context.request",
                    "turn_id": turn_id,
                    "canvas_id": envelope.get("canvas_id"),
                    "agent_id": scope.agent_id or "main",
                    "bridge_key": key,
                    "envelope": envelope,
                },
                send_lock,
            )
            if not sent:
                return


def _skill_studio_status_frame(
    *,
    scope: ChatScope,
    turn_id: str,
    text: str,
    user_text: str | None = None,
    status: str = "routing",
    message: str | None = None,
) -> dict[str, Any] | None:
    route_text = user_text if user_text is not None else text
    if not chat_service._freezone_skill_studio_requested(route_text):  # type: ignore[attr-defined]
        return None
    status_messages = {
        "routing": "正在整理 Skill 方向...",
    }
    return {
        "type": "skill_studio.status",
        "scope": scope.to_dict(),
        "turn_id": turn_id,
        "status": status,
        "message": message or status_messages.get(status) or "正在整理 Skill 方向...",
    }


async def _stream_project_turn(
    *,
    websocket: WebSocket,
    user: dict[str, Any],
    username: str,
    scope: ChatScope,
    text: str,
    attachments: list[ChatAttachmentIn],
    turn_id: str,
    user_text: str | None = None,
    surface: str | None = None,
    surface_context: dict[str, Any] | None = None,
    store_scope: ChatScope | None = None,
) -> None:
    project = str(scope.id)
    project_ctx = await _project_context_for_scope(user, scope)
    project_dir = project_ctx.output_dir if project_ctx is not None else None
    project_state_dir = project_ctx.state_dir if project_ctx is not None else None
    agent_text = _text_with_attachment_context(text, attachments)
    display_text = str(user_text or text).strip()
    if store_scope is not None:
        chat_store.append_message(
            username,
            store_scope,
            "user",
            display_text,
            media=_attachment_payloads(attachments),
            turn_id=turn_id,
        )
    else:
        chat_service.add_user_message(
            username,
            project,
            display_text,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
    send_lock = asyncio.Lock()
    heartbeat_task = asyncio.create_task(
        _chat_heartbeat(websocket, scope=scope, turn_id=turn_id, send_lock=send_lock)
    )
    bridge_result_receive_task = asyncio.create_task(
        _receive_bridge_results_during_turn(websocket=websocket, username=username)
    )
    emitted_bridge_keys: set[str] = set()
    pending_canvas_task = asyncio.create_task(
        _watch_pending_canvas_commands(
            websocket=websocket,
            username=username,
            scope=scope,
            turn_id=turn_id,
            send_lock=send_lock,
            emitted_bridge_keys=emitted_bridge_keys,
            started_at=time.time(),
        )
    )
    pending_canvas_context_task = asyncio.create_task(
        _watch_pending_canvas_context_requests(
            websocket=websocket,
            username=username,
            scope=scope,
            turn_id=turn_id,
            send_lock=send_lock,
            emitted_bridge_keys=emitted_bridge_keys,
            started_at=time.time(),
        )
    )
    pending_skill_studio_task = asyncio.create_task(
        _watch_pending_skill_studio_events(
            websocket=websocket,
            username=username,
            scope=scope,
            turn_id=turn_id,
            send_lock=send_lock,
            emitted_bridge_keys=emitted_bridge_keys,
            started_at=time.time(),
        )
    )
    pending_clarification_task = asyncio.create_task(
        _watch_pending_clarification_events(
            websocket=websocket,
            username=username,
            scope=scope,
            turn_id=turn_id,
            send_lock=send_lock,
            emitted_bridge_keys=emitted_bridge_keys,
            started_at=time.time(),
        )
    )
    skill_studio_status = _skill_studio_status_frame(
        scope=scope,
        turn_id=turn_id,
        text=agent_text,
        user_text=display_text,
    )
    if skill_studio_status is not None:
        await _send_json_best_effort(websocket, skill_studio_status, send_lock)
    done_sent = False
    assistant_sent_text = ""

    async def on_event(event: dict[str, Any]) -> None:
        nonlocal assistant_sent_text, done_sent
        event_type = event.get("type")
        if event_type == "thread_started":
            await _send_json_best_effort(
                websocket,
                {
                    "type": "thread.started",
                    "scope": scope.to_dict(),
                    "thread_id": event.get("thread_id"),
                    "turn_id": event.get("turn_id") or turn_id,
                },
                send_lock,
            )
        elif event_type == "assistant_delta":
            assistant_sent_text = str(event.get("text") or "")
            await _send_json_best_effort(
                websocket,
                {
                    "type": "assistant.delta",
                    "scope": scope.to_dict(),
                    "text": assistant_sent_text,
                    "turn_id": turn_id,
                    "accumulated": True,
                },
                send_lock,
            )
        elif event_type == "thought_delta":
            await _send_json_best_effort(
                websocket,
                {
                    "type": "agent.thought.delta",
                    "scope": scope.to_dict(),
                    "turn_id": turn_id,
                    "text": str(event.get("text") or ""),
                },
                send_lock,
            )
        elif event_type == "plan_update":
            await _send_json_best_effort(
                websocket,
                {
                    "type": "agent.plan.update",
                    "scope": scope.to_dict(),
                    "turn_id": turn_id,
                    "entries": event.get("entries") or [],
                },
                send_lock,
            )
        elif event_type == "usage_update":
            await _send_json_best_effort(
                websocket,
                {
                    "type": "agent.usage.update",
                    "scope": scope.to_dict(),
                    "turn_id": turn_id,
                    "usage": event.get("usage") or {},
                },
                send_lock,
            )
        elif event_type == "permission_requested":
            await _send_json_best_effort(
                websocket,
                {
                    "type": "agent.permission.requested",
                    "scope": scope.to_dict(),
                    "turn_id": turn_id,
                    "request_id": event.get("request_id"),
                    "text": str(event.get("text") or "需要操作授权"),
                    "options": event.get("options") or [],
                    "tool_call": event.get("tool_call") or {},
                },
                send_lock,
            )
        elif event_type in {"tool_started", "tool_updated", "tool_update"}:
            tool_name, tool_body = _tool_display_payload(event.get("text"), event.get("name"))
            status = str(event.get("status") or (
                "pending" if event_type == "tool_started" else "completed"
            ))
            await _send_json_best_effort(
                websocket,
                {
                    "type": (
                        "agent.tool.started"
                        if event_type == "tool_started"
                        else "agent.tool.updated"
                    ),
                    "scope": scope.to_dict(),
                    "turn_id": turn_id,
                    "call_id": event.get("call_id"),
                    "name": tool_name,
                    "status": status,
                    "text": tool_body,
                    "input": event.get("input"),
                    "output": event.get("output"),
                    "error": event.get("error"),
                },
                send_lock,
            )
        elif event_type == "skill_studio.event":
            await _send_json_best_effort(
                websocket,
                {
                    "type": "skill_studio.event",
                    "scope": scope.to_dict(),
                    "turn_id": event.get("turn_id") or turn_id,
                    "event": event.get("event"),
                },
                send_lock,
            )
        elif event_type == "assistant.clarification.event":
            await _send_json_best_effort(
                websocket,
                {
                    "type": "assistant.clarification.event",
                    "scope": scope.to_dict(),
                    "turn_id": event.get("turn_id") or turn_id,
                    "event": event.get("event"),
                },
                send_lock,
            )
        elif event_type == "assistant_message":
            message = event.get("message")
            if isinstance(message, dict):
                assistant_sent_text = _message_content(message)
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "assistant.message",
                        "scope": scope.to_dict(),
                        "turn_id": turn_id,
                        "message": message,
                    },
                    send_lock,
                )
        elif event_type == "done":
            final_text = _message_content(event.get("message"))
            if _should_emit_final_text(final_text, assistant_sent_text):
                assistant_sent_text = final_text
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "assistant.delta",
                        "scope": scope.to_dict(),
                        "text": final_text,
                        "turn_id": turn_id,
                        "accumulated": True,
                    },
                    send_lock,
                )
            done_sent = await _send_json_best_effort(
                websocket,
                {"type": "chat.done", "turn_id": turn_id, "scope": scope.to_dict()},
                send_lock,
            )

    try:
        await chat_service.stream_assistant_reply(
            username,
            project,
            agent_text,
            on_event,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
            surface=surface,
            surface_context=surface_context,
            store_scope=store_scope,
            turn_id=turn_id,
            route_prompt=display_text,
        )
    finally:
        heartbeat_task.cancel()
        bridge_result_receive_task.cancel()
        pending_canvas_task.cancel()
        pending_canvas_context_task.cancel()
        pending_skill_studio_task.cancel()
        pending_clarification_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task
        with contextlib.suppress(asyncio.CancelledError):
            await bridge_result_receive_task
        with contextlib.suppress(asyncio.CancelledError):
            await pending_canvas_task
        with contextlib.suppress(asyncio.CancelledError):
            await pending_canvas_context_task
        with contextlib.suppress(asyncio.CancelledError):
            await pending_skill_studio_task
        with contextlib.suppress(asyncio.CancelledError):
            await pending_clarification_task
        if not done_sent:
            await _send_json_best_effort(
                websocket,
                {"type": "chat.done", "turn_id": turn_id, "scope": scope.to_dict()},
                send_lock,
            )


async def _stream_home_turn(
    *,
    websocket: WebSocket,
    username: str,
    scope: ChatScope,
    text: str,
    attachments: list[ChatAttachmentIn],
    turn_id: str,
) -> None:
    from novelvideo.chat.hermes_pool import pool as hermes_pool

    before_projects = set(list_user_projects(username))
    previous_assistant = next(
        (
            str(message.get("content") or "")
            for message in reversed(chat_store.list_messages(username, scope))
            if message.get("role") == "assistant"
        ),
        "",
    )
    agent_text = _text_with_attachment_context(text, attachments)
    chat_store.append_message(
        username,
        scope,
        "user",
        text,
        media=_attachment_payloads(attachments),
        turn_id=turn_id,
    )
    thread = await hermes_pool.get_for_user(
        username,
        scope_kind="home",
        project_id=None,
    )

    assistant_text = ""
    assistant_sent_text = ""
    tool_text = ""
    tool_name = ""
    persisted = False
    send_lock = asyncio.Lock()
    heartbeat_task = asyncio.create_task(
        _chat_heartbeat(websocket, scope=scope, turn_id=turn_id, send_lock=send_lock)
    )
    done_sent = False

    def persist_partial_reply() -> dict[str, Any] | None:
        nonlocal persisted, assistant_text
        if persisted:
            return None
        final_text = chat_service._strip_replayed_chat_response(
            assistant_text,
            previous_assistant,
            text,
        ).strip()
        final_text = chat_service._strip_freezone_tool_lifecycle_failure_text(
            final_text,
            tool_mode="freezone_canvas" if _is_freezone_scope(scope) else "default",
        ).strip()
        if not final_text:
            return None
        message = chat_store.append_message(username, scope, "assistant", final_text)
        persisted = True
        return message

    await _send_json_best_effort(
        websocket,
        {
            "type": "thread.started",
            "scope": scope.to_dict(),
            "thread_id": getattr(thread, "id", None) or None,
            "turn_id": turn_id,
        },
        send_lock,
    )
    try:
        async for event in thread.stream(agent_text, current_project=None):
            if event.type == "thread_started":
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "thread.started",
                        "scope": scope.to_dict(),
                        "thread_id": str(event.thread_id or "").strip() or None,
                        "turn_id": str(event.turn_id or "").strip() or turn_id,
                    },
                    send_lock,
                )
            elif event.type == "assistant_delta":
                assistant_text = chat_service._merge_stream_text(assistant_text, event.text)
                display_text = chat_service._strip_replayed_chat_response(
                    assistant_text,
                    previous_assistant,
                    text,
                    suppress_partial_replay=True,
                )
                display_text = chat_service._strip_freezone_tool_lifecycle_failure_text(
                    display_text,
                    tool_mode="freezone_canvas" if _is_freezone_scope(scope) else "default",
                )
                assistant_sent_text = display_text
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "assistant.delta",
                        "scope": scope.to_dict(),
                        "text": display_text,
                        "turn_id": turn_id,
                        "accumulated": True,
                    },
                    send_lock,
                )
            elif event.type == "thought_delta":
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "agent.thought.delta",
                        "scope": scope.to_dict(),
                        "turn_id": turn_id,
                        "text": str(event.text or ""),
                    },
                    send_lock,
                )
            elif event.type == "plan_update":
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "agent.plan.update",
                        "scope": scope.to_dict(),
                        "turn_id": turn_id,
                        "entries": event.entries or [],
                    },
                    send_lock,
                )
            elif event.type == "usage_update":
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "agent.usage.update",
                        "scope": scope.to_dict(),
                        "turn_id": turn_id,
                        "usage": event.usage or {},
                    },
                    send_lock,
                )
            elif event.type == "permission_requested":
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": "agent.permission.requested",
                        "scope": scope.to_dict(),
                        "turn_id": turn_id,
                        "request_id": event.request_id,
                        "text": str(event.text or "需要操作授权"),
                        "options": event.options or [],
                        "tool_call": event.raw or {},
                    },
                    send_lock,
                )
            elif event.type in {"tool_started", "tool_updated", "tool_update"}:
                if event.name:
                    tool_name = event.name
                tool_text += str(event.text or "") + "\n"
                display_name, display_body = _tool_display_payload(tool_text, tool_name)
                await _send_json_best_effort(
                    websocket,
                    {
                        "type": (
                            "agent.tool.started"
                            if event.type == "tool_started"
                            else "agent.tool.updated"
                        ),
                        "scope": scope.to_dict(),
                        "turn_id": turn_id,
                        "call_id": event.call_id,
                        "name": display_name,
                        "status": event.status or (
                            "pending" if event.type == "tool_started" else "completed"
                        ),
                        "text": display_body,
                        "input": event.input,
                        "output": event.output,
                        "error": event.error,
                    },
                    send_lock,
                )
            elif event.type == "complete":
                assistant_text = _completion_text_or_existing(event.text, assistant_text)

        assistant_text = chat_service._strip_replayed_chat_response(
            assistant_text,
            previous_assistant,
            text,
        )
        assistant_text = chat_service._strip_freezone_tool_lifecycle_failure_text(
            assistant_text,
            tool_mode="freezone_canvas" if _is_freezone_scope(scope) else "default",
        )
        assistant_text = assistant_text.strip() or EMPTY_AGENT_REPLY_MESSAGE
        message = chat_store.append_message(username, scope, "assistant", assistant_text)
        persisted = True
        await _send_json_best_effort(
            websocket,
            {
                "type": "assistant.message",
                "scope": scope.to_dict(),
                "turn_id": turn_id,
                "message": message,
            },
            send_lock,
        )
        assistant_sent_text = _message_content(message)
        if _should_emit_final_text(assistant_text, assistant_sent_text):
            assistant_sent_text = assistant_text
            await _send_json_best_effort(
                websocket,
                {
                    "type": "assistant.delta",
                    "scope": scope.to_dict(),
                    "text": assistant_text,
                    "turn_id": turn_id,
                    "accumulated": True,
                },
                send_lock,
            )

        after_projects = set(list_user_projects(username))
        for project in sorted(after_projects - before_projects):
            project_scope = ChatScope(kind="project", id=project)
            chat_store.append_message(
                username,
                project_scope,
                "system",
                f"Created from home conversation turn {turn_id}.",
            )
            await _send_json_best_effort(
                websocket,
                {"type": "project.created", "project": project},
                send_lock,
            )

        done_sent = await _send_json_best_effort(
            websocket,
            {"type": "chat.done", "turn_id": turn_id, "scope": scope.to_dict()},
            send_lock,
        )
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task
        persist_partial_reply()
        if not done_sent:
            await _send_json_best_effort(
                websocket,
                {"type": "chat.done", "turn_id": turn_id, "scope": scope.to_dict()},
                send_lock,
            )


@router.websocket("/chat/ws")
async def chat_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        user = await _authenticate_ws(websocket)
    except Exception:
        await websocket.send_json({"type": "error", "message": "unauthorized"})
        await websocket.close(code=1008)
        return

    username = str(user["username"])
    current_scope = ChatScope(kind="home")
    current_scope = await _send_scope_changed(websocket, user, username, current_scope)
    if current_scope is None:
        return
    # Do not pre-warm the default home scope on connect. The React client often
    # immediately sends scope.set for the active project; warming home first
    # creates a worker that is then rotated and logs a noisy initialize timeout.
    if _should_prewarm_on_ws_connect(current_scope):
        await chat_service.prewarm_chat_backend(
            username,
            project=current_scope.id if current_scope.kind == "project" else None,
        )

    try:
        while True:
            try:
                raw = await websocket.receive_json()
            except RuntimeError as exc:
                if "WebSocket is not connected" in str(exc):
                    return
                raise
            event_type = str(raw.get("type") or "")
            if event_type == "scope.set":
                msg = ScopeSetIn.model_validate(raw)
                requested_scope = _scope_from_model(msg.scope)
                current_scope = await _send_scope_changed(websocket, user, username, requested_scope)
                if current_scope is None:
                    return
                await _sync_running_agent_scope(username, current_scope)
                # Switching project rotates the worker; warm the new scope now so
                # the first message in the project doesn't cold-start.
                await chat_service.prewarm_chat_backend(
                    username,
                    project=current_scope.id if current_scope.kind in {"project", "freezone"} else None,
                    surface="freezone" if _is_freezone_scope(current_scope) else None,
                    agent_id=current_scope.agent_id if _is_freezone_scope(current_scope) else None,
                )
                continue

            if event_type == "canvas.command.result":
                payload = CanvasCommandToolResultIn.model_validate(raw)
                _resolve_canvas_command_tool_result_payload(payload, username=username)
                if payload.cancelled or payload.canvas_apply_status == "cancelled_by_user":
                    await _close_canvas_command_worker(username, payload)
                continue

            if event_type == "canvas.context.result":
                payload = CanvasContextToolResultIn.model_validate(raw)
                _resolve_canvas_context_tool_result_payload(payload, username=username)
                continue

            if event_type == "skill_studio.result":
                payload = SkillStudioToolResultIn.model_validate(raw)
                _resolve_skill_studio_tool_result_payload(payload, username=username)
                try:
                    _persist_skill_studio_result_ui_event(username=username, payload=payload)
                except Exception:
                    logger.exception("failed to persist skill studio result ui event")
                continue

            if event_type == "assistant.clarification.result":
                payload = ClarificationToolResultIn.model_validate(raw)
                _resolve_clarification_tool_result_payload(payload, username=username)
                try:
                    _persist_clarification_result_ui_event(username=username, payload=payload)
                except Exception:
                    logger.exception("failed to persist clarification result ui event")
                continue

            if event_type != "chat.message":
                await _send_json_best_effort(
                    websocket, {"type": "error", "message": f"unsupported event: {event_type}"}
                )
                continue

            msg = ChatMessageIn.model_validate(raw)
            scope = _scope_from_model(msg.scope) if msg.scope else current_scope
            turn_id = (msg.turn_id or "").strip() or uuid.uuid4().hex
            text = msg.text.strip()
            user_text = (msg.user_text or "").strip() or text
            if not text:
                await _send_json_best_effort(
                    websocket, {"type": "error", "turn_id": turn_id, "message": "empty message"}
                )
                continue

            try:
                await _require_ai_assistant_access(user=user, scope=scope)
                if scope.kind in {"project", "freezone"}:
                    await _stream_project_turn(
                        websocket=websocket,
                        user=user,
                        username=username,
                        scope=scope,
                        text=text,
                        attachments=msg.attachments,
                        turn_id=turn_id,
                        user_text=user_text,
                        surface="freezone" if _is_freezone_scope(scope) else msg.surface,
                        surface_context=msg.context if _is_freezone_scope(scope) else None,
                        store_scope=scope if _is_freezone_scope(scope) else None,
                    )
                elif scope.kind == "home":
                    await _stream_home_turn(
                        websocket=websocket,
                        username=username,
                        scope=scope,
                        text=text,
                        attachments=msg.attachments,
                        turn_id=turn_id,
                    )
                else:
                    await _send_json_best_effort(
                        websocket,
                        {
                            "type": "error",
                            "turn_id": turn_id,
                            "message": f"scope not implemented: {scope.kind}",
                        },
                    )
            except Exception as exc:  # noqa: BLE001
                message = str(exc)
                if "当前用户已有 AI 对话正在处理中" in message:
                    await _send_json_best_effort(
                        websocket,
                        {
                            "type": "chat.busy",
                            "turn_id": turn_id,
                            "scope": scope.to_dict(),
                            "message": message,
                        },
                    )
                    continue
                billing_rule_error = find_billing_rule_not_configured_error(exc)
                if billing_rule_error is not None:
                    await _send_json_best_effort(
                        websocket,
                        {
                            "type": "error",
                            "turn_id": turn_id,
                            "message": BILLING_RULE_NOT_CONFIGURED_MESSAGE,
                            "data": billing_rule_not_configured_payload(billing_rule_error),
                        },
                    )
                    continue
                insufficient_error = find_insufficient_credits_error(exc)
                if insufficient_error is not None:
                    await _send_json_best_effort(
                        websocket,
                        {
                            "type": "error",
                            "turn_id": turn_id,
                            "message": INSUFFICIENT_CREDITS_MESSAGE,
                            "data": insufficient_credits_payload(insufficient_error),
                        },
                    )
                    continue
                await _send_json_best_effort(
                    websocket, {"type": "error", "turn_id": turn_id, "message": message}
                )
    except WebSocketDisconnect:
        return
