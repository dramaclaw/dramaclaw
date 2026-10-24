"""Authenticated director operations; user decisions cannot be forged by Agent tools."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes.remix import _call
from novelvideo.freezone import canvas_store
from novelvideo.freezone.paths import CANVAS_ID_RE
from novelvideo.freezone.remix.store import RemixArtifactStore
from novelvideo.freezone.remix.material_work import MaterialSourceConflict, MaterialWorkRequestError
from novelvideo.freezone.remix.production_store import production_store
from novelvideo.freezone.remix.production_plan_v2 import OutputV2
from novelvideo.freezone.remix.production_node_entry import ProductionNodesRequest
from novelvideo.api.reference_operation_logging import ReferenceOperationRoute, current_request_id

router = APIRouter(prefix="/projects/{project}/freezone/canvases/{canvas_id}/director",
                   route_class=ReferenceOperationRoute)
logger = logging.getLogger(__name__)


_MATERIAL_SPEECH_CONFLICT_CODES = frozenset({
    "material_speech_source_conflict",
    "material_step_dialogue_turns_mismatch",
})


def _bounded_material_ids(value: object) -> list[str]:
    items = value if isinstance(value, list) else [value]
    return [str(item)[:80] for item in items
            if isinstance(item, str) and item.strip()][:8]


def _material_work_error_detail(error: BaseException, *, request_id: str | None = None,
                                code: str = "material_work_request_invalid",
                                status: int = 422) -> dict[str, Any]:
    detail = getattr(error, "details", None)
    if not isinstance(detail, dict):
        detail = {}
    message = detail.get("message") or str(error) or "素材工作包请求无效"
    errors = detail.get("errors")
    if not isinstance(errors, list) or not errors:
        errors = [{"path": "material_work", "message": str(message)[:300]}]
    bounded_errors = [
        {"path": str(item.get("path", "material_work"))[:160],
         "message": str(item.get("message", message))[:300]}
        for item in errors[:8] if isinstance(item, dict)
    ]
    bounded_code = str(detail.get("code") or code)[:96]
    result = {
        "code": bounded_code,
        "phase": str(detail.get("phase") or "material_plan_drafting")[:96],
        "message": str(message)[:300],
        "errors": bounded_errors or [{"path": "material_work", "message": str(message)[:300]}],
        "next_action": str(detail.get("next_action") or "correct_material_request")[:96],
        "retryable": bool(detail.get("retryable", False)),
        "side_effects": "none",
        **({"request_id": request_id} if request_id else {}),
    }
    # A speech-owner conflict names the placement, turns and steps that disagree.
    # The Agent only reads the sentence without them and re-submits the same work,
    # so the ids have to survive the transport in a bounded form.
    if bounded_code in _MATERIAL_SPEECH_CONFLICT_CODES:
        placement = _bounded_material_ids(detail.get("placement_id"))
        if placement:
            result["placement_id"] = placement[0]
        for key in ("turn_ids", "step_ids"):
            ids = _bounded_material_ids(detail.get(key))
            if ids:
                result[key] = ids
    return result


def _material_work_internal_error(*, request_id: str | None) -> dict[str, Any]:
    return {
        "code": "material_work_internal_error",
        "phase": "material_plan_drafting",
        "message": "素材工作包保存失败，服务端未能完成处理",
        "next_action": "inspect_request_id_and_correct_material_request",
        "retryable": False,
        "side_effects": "unknown",
        **({"request_id": request_id} if request_id else {}),
    }


async def _context(project: str, canvas_id: str, user: dict, role: str = "editor", *, allow_unsaved: bool = False, agent_id: str | None = None):
    from novelvideo.api.routes.freezone import _resolve_freezone_project
    from novelvideo.api.routes.chat import _enforce_agent_chat_scope
    from novelvideo.chat.store import ChatScope
    if not CANVAS_ID_RE.fullmatch(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    _enforce_agent_chat_scope(user, ChatScope(kind="project", id=project, surface="freezone", canvas_id=canvas_id, agent_id=agent_id), require_write=role == "editor")
    ctx, _, _, _, _ = await _resolve_freezone_project(project, user, required_role=role)
    canvas = await asyncio.to_thread(canvas_store.read_canvas, ctx.state_dir, canvas_id)
    if canvas is None and allow_unsaved:
        return ctx, None, None
    if not canvas or canvas.get("project_id") != ctx.project_id:
        raise HTTPException(404, "canvas not found")
    if canvas.get("access_model") in {"private", "user_private"} and canvas.get("owner_principal_id") != ctx.requester_user_id:
        raise HTTPException(403, "private canvas access denied")
    return ctx, canvas, production_store(ctx)


def _data(value):
    return {"ok": True, "data": value}


class DirectorRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_ref: dict[str, Any]
    command_id: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern=r"^(direction|plan|material|composition)$")
    proposal: dict[str, Any]
    summary: str = Field(min_length=1, max_length=10000)


class SpeechReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_ref: dict[str, Any]
    recognition_ref: dict[str, Any]
    take_id: str = Field(min_length=1, max_length=128)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=200, ge=1, le=500)


class SpeechCorrectionRequest(SpeechReviewRequest):
    corrections: list[dict[str, Any]] = Field(max_length=20000)


class AdvanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_ref: dict[str, Any]
    event: dict[str, Any]


class PlanReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_ref: dict[str, Any]
    plan_ref: dict[str, Any]
    findings: list[dict[str, Any]] = Field(max_length=500)


class ProductionBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_ref: dict[str, Any]
    commands: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    command_id: str = Field(min_length=1, max_length=128)


class MaterialWorkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_ref: dict[str, Any]
    plan_ref: dict[str, Any]
    requirements: list[dict[str, Any]] = Field(min_length=1, max_length=200)
    steps: list[dict[str, Any]] = Field(min_length=1, max_length=200)
    command_id: str = Field(min_length=1, max_length=128)
    select_for_commission: bool = False


class SelectMaterialWorkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_ref: dict[str, Any]
    work_ref: dict[str, Any]
    command_id: str = Field(min_length=1, max_length=128)


class DirectPlanOutput(OutputV2):
    @model_validator(mode="before")
    @classmethod
    def accept_integer_fps(cls, value: Any) -> Any:
        if isinstance(value, dict) and "fps" in value:
            if type(value["fps"]) is not int or "fps_num" in value or "fps_den" in value:
                raise ValueError("fps must be an integer without fps_num or fps_den")
            return {**{key: item for key, item in value.items() if key != "fps"},
                    "fps_num": value["fps"], "fps_den": 1}
        return value


class DirectPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_ref: dict[str, Any]
    goal: str = Field(min_length=1, max_length=2000)
    output: DirectPlanOutput
    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    include_compose: bool = True


async def _commission_in_scope(store, ref, ctx, canvas_id):
    from novelvideo.freezone.remix.reference_commission import read_reference_commission
    commission = await _call(read_reference_commission, store, ref, latest=True)
    if commission["canvas_id"] != canvas_id or commission["requester_user_id"] != ctx.requester_user_id:
        raise HTTPException(403, "commission belongs to another canvas or actor")
    return commission


def _belongs_to_analysis(canvas, analysis_id, plan_id):
    reachable = {analysis_id}
    for _ in range(len(canvas.get("nodes", []))):
        children = {edge.get("target") for edge in canvas.get("edges", []) if edge.get("source") in reachable}
        if children <= reachable:
            break
        reachable |= children
    return plan_id in reachable


async def _plan_in_canvas(store, ref, canvas):
    if not isinstance(ref, dict) or not isinstance(ref.get("artifact_id"), str) or type(ref.get("revision")) is not int or ref["revision"] < 1 or ref.get("project_id", store.project_id) != store.project_id:
        raise HTTPException(422, "exact project plan revision required")
    saved = await _call(store.read, ref["artifact_id"], ref["revision"])
    if saved["schema"] != "production_plan.v2":
        raise HTTPException(422, "saved production plan required")
    node = next((n for n in canvas.get("nodes", []) if n.get("type") == "scriptNode" and
                 (n.get("data", {}).get("productionPlanV2Ref") or {}).get("artifactId", (n.get("data", {}).get("productionPlanV2Ref") or {}).get("artifact_id")) == ref["artifact_id"]), None)
    if node is None:
        raise HTTPException(404, "plan is not on the current canvas")
    return saved, node


@router.get("/state")
async def director_state(project: str, canvas_id: str, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.reference_director import list_director_artifacts
    ctx, canvas, store = await _context(project, canvas_id, user, "viewer", allow_unsaved=True)
    if canvas is None:
        return _data({"commissions": [], "decisions": [], "material_work": [],
                      "speech_corrections": [], "material_reviews": [], "output_reviews": []})
    result = await _call(list_director_artifacts, store, canvas_id, ctx.requester_user_id)
    plan_nodes = {((node.get("data", {}).get("productionPlanV2Ref") or {}).get("artifactId")): node["id"]
                  for node in canvas.get("nodes", []) if node.get("type") == "scriptNode"}
    for preview in result.get("speech_corrections", []):
        preview["node_id"] = plan_nodes.get(preview["source_plan_ref"]["artifact_id"])
        from novelvideo.freezone.remix.agent_speech_review import _source
        try:
            _, take, resource, turns, words = await _call(_source, store, preview["source_plan_ref"], preview["take_id"], preview["recognition_ref"])
        except HTTPException:
            preview["original_words"] = []
            preview["target_text"] = ""
            continue
        selected_ids = {row["word_id"] for row in preview["corrections"]}
        preview["original_words"] = [word for word in words if word["id"] in selected_ids]
        preview["target_text"] = "\n".join((turn.get("speaker", "") + "：" if turn.get("speaker") else "") + turn["text"] for turn in turns)
        source = next((node for node in canvas.get("nodes", []) if node["id"] == resource["node_id"]), None)
        preview["source_node_id"] = resource["node_id"]
        preview["source_url"] = source.get("data", {}).get("videoUrl") or source.get("data", {}).get("audioUrl") if source else None
    return _data(result)


async def _production_read(project, canvas_id, user, agent_id, reader, **kwargs):
    ctx, canvas, store = await _context(project, canvas_id, user, "viewer", allow_unsaved=True, agent_id=agent_id)
    if canvas is None:
        if kwargs.get("commission_id"):
            raise HTTPException(404, "canvas not found")
        return {"branches": [], "selection_required": False, "inventory_truncated": False}
    from novelvideo.chat.reference_remix_continuation import coordinator

    def read_current():
        with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as guard:
            current = canvas_store.read_canvas(ctx.state_dir, canvas_id)
            if not current or current.get("project_id") != ctx.project_id:
                raise HTTPException(404, "canvas not found")
            if current.get("access_model") in {"private", "user_private"} and current.get("owner_principal_id") != ctx.requester_user_id:
                raise HTTPException(403, "private canvas access denied")
            arguments = dict(canvas=current, canvas_id=canvas_id, agent_id=agent_id,
                             requester_user_id=ctx.requester_user_id, **kwargs)
            if reader.__name__ == "read_current_production":
                arguments.update(state_dir=ctx.state_dir,
                    runs=coordinator.production_for_actor(ctx, canvas_id, agent_id))
            if reader.__name__ == "read_current_production":
                from novelvideo.freezone.remix.production_discovery_index import read_with_production_index
                result = read_with_production_index(ctx, store, canvas_id=canvas_id, agent_id=agent_id,
                    reader=reader, _defer_rebuild=True, **{key: value for key, value in arguments.items()
                                      if key not in {"canvas_id", "agent_id"}})
            else:
                result = reader(store, **arguments)
            guard.reassert()
            return result

    def read_authorized():
        try:
            return read_current()
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

    result = await _call(read_authorized)
    if reader.__name__ == "read_current_production" and result.get("index_status") == "refreshing":
        # Native admission happens after both authorization read leases have
        # closed. Optional queue capacity never hides current saved facts.
        from novelvideo.freezone.remix.production_discovery_index import schedule_production_index_rebuild
        await schedule_production_index_rebuild(ctx, canvas_id=canvas_id, agent_id=agent_id)
    return result


@router.get("/production-state")
async def production_state(project: str, canvas_id: str,
                           commission_id: str | None = Query(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$"),
                           agent_id: str = Query(default="main", min_length=1, max_length=128),
                           user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.production_inventory import read_current_production
    state = await _production_read(project, canvas_id, user, agent_id, read_current_production,
                                   commission_id=commission_id)
    if commission_id and state.get('phase') == 'preparing_materials':
        from novelvideo.api.routes import freezone
        from novelvideo.freezone.workflow_preflight import _catalog_entry_for_model

        ctx, _, store = await _context(project, canvas_id, user, 'viewer', agent_id=agent_id)
        from novelvideo.freezone.remix.reference_commission import read_reference_commission
        commission = await _call(read_reference_commission, store, state['commission_ref'], latest=True)
        choices = await _saved_material_generation_choices(ctx, canvas_id, commission)
        capabilities = {}
        for kind in ('image', 'video'):
            model = choices.get(f'{kind}_model')
            if not isinstance(model, str) or not model:
                continue
            try:
                catalog = await freezone._scoped_media_model_catalog(
                    kind, requester_user_id=ctx.requester_user_id)
            except HTTPException as exc:
                if exc.status_code != 503:
                    raise
                capabilities[kind] = {'model': model, 'status': 'catalog_unavailable'}
                continue
            entry = _catalog_entry_for_model(catalog or [], model)
            if entry is None:
                capabilities[kind] = {'model': model, 'status': 'model_unavailable'}
                continue
            summary = {'model': model, 'status': 'available',
                       'resolution_options': entry.get('resolutionOptions') or [],
                       'ratio_options': entry.get('ratioOptions') or []}
            if kind == 'video':
                minimum = entry.get('minDuration')
                maximum = entry.get('maxDuration')
                options = entry.get('durationOptions')
                declared = ([value for value in options if type(value) is int]
                            if isinstance(options, list) else range(4, 16))
                summary.update(
                    allowed_duration_seconds=[value for value in declared
                                              if 4 <= value <= 15
                                              and (type(minimum) not in (int, float) or value >= minimum)
                                              and (type(maximum) not in (int, float) or value <= maximum)],
                    supported_modes=entry.get('supportedModes') or [],
                    reference_image_max=entry.get('referenceImageMax'),
                    supports_generate_audio=entry.get('supportsGenerateAudio'),
                )
            capabilities[kind] = summary
        state['model_capabilities'] = capabilities
    return _data(state)


@router.get("/conversation-cards")
async def conversation_cards(project: str, canvas_id: str,
                             commission_id: str = Query(pattern=r"^[A-Za-z0-9_-]{1,64}$"),
                             refs: str = Query(min_length=2, max_length=8192),
                             agent_id: str = Query(default="main", min_length=1, max_length=128),
                             user: dict = Depends(get_api_user)):
    import json
    from novelvideo.freezone.remix.conversation_cards import read_conversation_cards
    from novelvideo.chat.reference_remix_continuation import coordinator
    try:
        parsed = json.loads(refs)
        if not isinstance(parsed, list) or not 1 <= len(parsed) <= 20 or any(not isinstance(ref, dict) for ref in parsed):
            raise ValueError("1 to 20 card references required")
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, "invalid card references") from exc
    ctx, _, _ = await _context(project, canvas_id, user, "viewer", agent_id=agent_id)
    def reader(store, **arguments):
        return read_conversation_cards(store, runs=coordinator.production_for_actor(ctx, canvas_id, agent_id),
                                       refs=parsed, **arguments)
    return _data(await _production_read(project, canvas_id, user, agent_id, reader, commission_id=commission_id))


@router.get("/history")
async def production_history(project: str, canvas_id: str,
                             commission_id: str = Query(pattern=r"^[A-Za-z0-9_-]{1,64}$"),
                             cursor: str | None = Query(default=None, max_length=1024),
                             limit: int = Query(default=20, ge=1, le=100),
                             agent_id: str = Query(default="main", min_length=1, max_length=128),
                             user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.production_inventory import read_production_history
    return _data(await _production_read(project, canvas_id, user, agent_id, read_production_history,
                                       commission_id=commission_id, cursor=cursor, limit=limit))


@router.post("/decisions")
async def prepare_decision(project: str, canvas_id: str, body: DirectorRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.reference_director import prepare_reference_decision
    ctx, _, store = await _context(project, canvas_id, user)
    commission = await _commission_in_scope(store, body.commission_ref, ctx, canvas_id)
    if (body.kind == 'plan' and commission['phase'] == 'awaiting_plan_review'
            and body.commission_ref == commission['commission_ref']
            and body.proposal.get('plan_ref') in (None, commission['plan_ref'])):
        raise HTTPException(422, detail={
            'error': 'plan must be reviewed before user confirmation',
            'blocker': {
                'code': 'plan_review_required', 'project_id': ctx.project_id,
                'canvas_id': canvas_id, 'requester_user_id': ctx.requester_user_id,
                'commission_id': commission['commission_ref']['artifact_id'],
                'plan_ref': commission['plan_ref'],
                'direction_revision': commission['direction_revision'],
                'next_tool': 'freezone_review_production_plan',
            },
        })
    result = await _call(prepare_reference_decision, store, body.commission_ref, body.kind, body.proposal, body.summary, body.command_id)
    await _emit_director_update(ctx, canvas_id)
    return _data(result)


class UserCardConfirmation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    decision_ref: dict[str, Any]
    commission_ref: dict[str, Any]
    agent_id: str = Field(default='main', min_length=1, max_length=128)
    expected_projection_revision: str = Field(pattern=r'^[a-f0-9]{64}$')


class AgentReferencePlanConfirmation(BaseModel):
    """Exact references supplied by the host context, never free-form intent."""

    model_config = ConfigDict(extra="forbid")
    commission_ref: dict[str, Any]
    plan_ref: dict[str, Any]


def _validate_agent_reference(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {"artifact_id", "revision", "project_id"}:
        raise HTTPException(422, {"code": "invalid_reference_plan_confirmation",
                                  "field_path": field, "retryable": False})
    if (not isinstance(value.get("artifact_id"), str) or not value["artifact_id"].strip()
            or type(value.get("revision")) is not int or value["revision"] < 1
            or ("project_id" in value and not isinstance(value["project_id"], str))):
        raise HTTPException(422, {"code": "invalid_reference_plan_confirmation",
                                  "field_path": field, "retryable": False})
    return dict(value)


async def _confirm_reference_plan_for_agent(
    *, project: str, canvas_id: str, body: AgentReferencePlanConfirmation,
    request: Request, agent_id: str, user: dict,
):
    """Confirm the exact presented plan under the active human-turn fence."""
    if user.get("credential_kind") not in {"agent_session", "local_trusted_agent"}:
        raise HTTPException(403, "reference plan confirmation requires the Agent action")
    turn_id = request.headers.get("X-DramaClaw-Turn-ID", "").strip()
    if not turn_id:
        raise HTTPException(403, {"code": "human_turn_binding_required", "retryable": False})
    ctx, _, store = await _context(project, canvas_id, user, agent_id=agent_id)
    from dataclasses import replace
    from novelvideo.chat.reference_direction_commit import _human_context
    from novelvideo.chat.store import chat_store
    from novelvideo.freezone.remix.reference_commission import read_reference_commission
    from novelvideo.freezone.remix.reference_director import confirm_reference_decision, list_director_artifacts
    from novelvideo.chat.plan_confirmation_delivery import find_plan_presentation
    binding, human_scope, _, human_message = await asyncio.to_thread(
        _human_context, ctx=ctx, canvas_id=canvas_id, agent_id=agent_id, turn_id=turn_id,
    )
    identity = f"{ctx.requester_user_id}:{canvas_id}:{agent_id}:{human_message['id']}"
    receipt_id = "chat-message:" + identity
    submitted_commission_ref = _validate_agent_reference(body.commission_ref, "commission_ref")
    submitted_plan_ref = _validate_agent_reference(body.plan_ref, "plan_ref")
    if (submitted_commission_ref.get("project_id", ctx.project_id) != ctx.project_id
            or submitted_plan_ref.get("project_id", ctx.project_id) != ctx.project_id):
        raise HTTPException(409, {"code": "reference_scope_mismatch", "retryable": False})
    commission_ref = {**submitted_commission_ref, "project_id": ctx.project_id}
    plan_ref = {**submitted_plan_ref, "project_id": ctx.project_id}
    current = await _call(read_reference_commission, store, commission_ref, latest=True)
    if current["commission_ref"] != commission_ref:
        raise HTTPException(409, {"code": "stale_commission_ref",
                                  "commission_ref": current["commission_ref"],
                                  "retryable": False})
    existing_receipt = next(
        (row for row in current.get("decisions", []) if row.get("message_id") == receipt_id),
        None,
    )
    if existing_receipt is not None:
        return {
            "commission": current,
            "decision_ref": existing_receipt.get("decision_ref"),
            "message_id": receipt_id,
            "replayed": True,
        }
    if current.get("plan_ref") != plan_ref or current.get("phase") != "awaiting_plan_confirmation":
        raise HTTPException(409, {"code": "plan_confirmation_target_changed",
                                  "commission_ref": current["commission_ref"],
                                  "plan_ref": current.get("plan_ref"),
                                  "retryable": False})
    canonical_scope = replace(human_scope, id=ctx.project_id)
    artifacts = list_director_artifacts(store, canvas_id, ctx.requester_user_id, limit=None)
    decisions = [
        row for row in artifacts["decisions"]
        if row["kind"] == "plan"
        and row["commission_ref"] == current["commission_ref"]
        and row.get("proposal", {}).get("plan_ref") == plan_ref
    ]
    if len(decisions) != 1:
        raise HTTPException(409, {"code": "plan_confirmation_target_unavailable", "retryable": False})
    presented = await asyncio.to_thread(
        find_plan_presentation, chat_store, ctx.requester_username,
        canonical_scope, decision_ref=decisions[0]["decision_ref"],
        plan_ref=plan_ref, review_ref=current.get("review_ref"),
        before_message_id=human_message["id"],
        requester_user_id=ctx.requester_user_id,
    )
    if presented is None:
        raise HTTPException(409, {
            "code": "plan_confirmation_requires_presented_plan",
            "retryable": False,
            "next_action": "Present the exact reviewed plan in ordinary chat before confirming it.",
        })
    result = await _call(
        confirm_reference_decision, store, decisions[0]["decision_ref"],
        project_id=ctx.project_id, canvas_id=canvas_id,
        requester_user_id=ctx.requester_user_id, message_id=identity,
        message_content=human_message["content"],
        expected_commission_ref=current["commission_ref"],
    )
    await _notify_commission(ctx, canvas_id, result["commission"], "agent-plan-confirmed")
    await _emit_director_update(ctx, canvas_id)
    return {**result, "message_id": receipt_id, "human_message_id": human_message["id"],
            "turn_id": binding["turn_id"], "replayed": False}


@router.post("/decisions/confirm-reference-plan")
async def confirm_reference_plan_for_agent(
    project: str, canvas_id: str, body: AgentReferencePlanConfirmation,
    request: Request, agent_id: str = Query(default="main", min_length=1, max_length=128),
    user: dict = Depends(get_api_user),
):
    return _data(await _confirm_reference_plan_for_agent(
        project=project, canvas_id=canvas_id, body=body,
        request=request, agent_id=agent_id, user=user,
    ))


@router.post("/decisions/{artifact_id}/confirm")
async def confirm_decision(project: str, canvas_id: str, artifact_id: str, body: UserCardConfirmation | None = Body(default=None), user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.reference_director import confirm_reference_decision
    if user.get("credential_kind") in {"agent_session", "local_trusted_agent"}:
        raise HTTPException(403, "a user decision is required")
    ctx, _, store = await _context(project, canvas_id, user, agent_id=body.agent_id if body else None)
    decision = await _call(store.read_latest, artifact_id)
    if body:
        from novelvideo.freezone.remix.reference_commission import read_reference_commission
        current = await _call(read_reference_commission, store, body.commission_ref, latest=True)
        if current['commission_ref'] != {**body.commission_ref, 'project_id': ctx.project_id}:
            raise HTTPException(409, '作品方案版本已变化，请刷新卡片')
        if artifact_id != body.decision_ref.get('artifact_id') or body.decision_ref.get('revision') != decision['revision'] or body.decision_ref.get('project_id', ctx.project_id) != ctx.project_id or decision['payload']['commission_ref']['artifact_id'] != current['commission_ref']['artifact_id']:
            raise HTTPException(409, '制作选择版本已变化，请刷新卡片')
        from novelvideo.freezone.remix.conversation_cards import read_conversation_cards
        from novelvideo.chat.reference_remix_continuation import coordinator
        await _production_read(project, canvas_id, user, body.agent_id,
            lambda evidence_store, **arguments: read_conversation_cards(evidence_store,
                runs=coordinator.production_for_actor(ctx, canvas_id, body.agent_id),
                refs=[body.decision_ref], **arguments), commission_id=current['commission_ref']['artifact_id'])
        from novelvideo.freezone.remix.production_inventory import read_current_production
        projection = await _production_read(project, canvas_id, user, body.agent_id, read_current_production,
            commission_id=current['commission_ref']['artifact_id'])
        if projection['projection_revision'] != body.expected_projection_revision:
            raise HTTPException(409, '制作状态已变化，请刷新卡片')
    if body:
        from novelvideo.freezone.remix.reference_director import confirm_reference_card
        runs = await asyncio.to_thread(coordinator.production_for_actor, ctx, canvas_id, body.agent_id)
        def confirm_guarded_card():
            try:
                return confirm_reference_card(store, ctx, canvas_id=canvas_id, decision_ref=body.decision_ref,
                    commission_ref=body.commission_ref, agent_id=body.agent_id,
                    expected_projection_revision=body.expected_projection_revision, runs=runs)
            except PermissionError as exc:
                raise HTTPException(403, str(exc)) from exc
        result = await _call(confirm_guarded_card)
    elif decision['payload'].get('kind') == 'material':
        def confirm_current_material():
            with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as guard:
                current = canvas_store.read_canvas(ctx.state_dir, canvas_id)
                if not current or current.get('project_id') != ctx.project_id:
                    raise HTTPException(404, 'canvas not found')
                if current.get('access_model') in {'private', 'user_private'} and current.get('owner_principal_id') != ctx.requester_user_id:
                    raise HTTPException(403, 'private canvas access denied')
                return confirm_reference_decision(store, body.decision_ref if body else {'artifact_id': artifact_id}, expected_commission_ref=body.commission_ref if body else None, project_id=ctx.project_id,
                    canvas_id=canvas_id, requester_user_id=ctx.requester_user_id, canvas=current,
                    workflow_state_dir=ctx.state_dir, _canvas_guard=guard)
        try:
            result = await _call(confirm_current_material)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
    else:
        result = await _call(confirm_reference_decision, store, body.decision_ref if body else {"artifact_id": artifact_id}, expected_commission_ref=body.commission_ref if body else None, project_id=ctx.project_id, canvas_id=canvas_id, requester_user_id=ctx.requester_user_id)
    await _notify_commission(ctx, canvas_id, result['commission'], 'user-decision:' + artifact_id)
    await _emit_director_update(ctx, canvas_id)
    return _data(result)


def _review_plan_on_current_canvas(ctx, store, canvas_id, commission, plan_ref, findings):
    """Keep the canvas target fixed through plan review publication."""
    from novelvideo.freezone.remix.plan_review_settlement import submit_plan_review
    from novelvideo.freezone.remix.production_goal import plan_goal_matches

    with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as guard:
        canvas = canvas_store.read_canvas(ctx.state_dir, canvas_id)
        if not canvas or canvas.get('project_id') != ctx.project_id:
            raise HTTPException(404, 'canvas not found')
        if (canvas.get('access_model') in {'private', 'user_private'}
                and canvas.get('owner_principal_id') != ctx.requester_user_id):
            raise HTTPException(403, 'private canvas access denied')
        if (not isinstance(plan_ref, dict) or not isinstance(plan_ref.get('artifact_id'), str)
                or type(plan_ref.get('revision')) is not int or plan_ref['revision'] < 1
                or plan_ref.get('project_id', store.project_id) != store.project_id):
            raise HTTPException(422, 'exact project plan revision required')
        saved_plan = store.read(plan_ref['artifact_id'], plan_ref['revision'])
        if saved_plan['schema'] != 'production_plan.v2':
            raise HTTPException(422, 'saved production plan required')
        matching = [node for node in canvas.get('nodes', [])
                    if node.get('type') == 'scriptNode'
                    and (node.get('data', {}).get('productionPlanV2Ref') or {}).get(
                        'artifactId', (node.get('data', {}).get('productionPlanV2Ref') or {}).get('artifact_id'))
                    == plan_ref['artifact_id']]
        if len(matching) != 1:
            raise HTTPException(404, 'plan is not uniquely on the current canvas')
        plan_node = matching[0]
        if not _belongs_to_analysis(canvas, commission['analysis_node_id'], plan_node['id']):
            raise HTTPException(409, 'plan is not derived from this reference analysis')
        node_data = plan_node.get('data') or {}
        node_ref = node_data.get('productionPlanV2Ref') or {}
        original = store.read(plan_ref['artifact_id'], 1)
        original_target = (original['payload'].get('provenance') or {}).get('node_target')
        provenance = saved_plan['payload'].get('provenance') or {}
        task_target = provenance.get('node_target')
        # Directly authored plans keep their existing revision workflow: the
        # production-batch command can revise the artifact before the canvas
        # pointer catches up. Task-produced plans require the exact node input.
        if ((original_target is not None and node_ref.get('revision') != plan_ref['revision'])
                or node_data.get('productionPlanV2Dirty') is True
                or node_data.get('productionPlanV2Conflict') is True):
            raise HTTPException(409, {'code': 'plan_target_changed',
                                      'message': '当前画布节点已变化，请先同步并审核对应版本的作品方案'})
        if original_target != task_target:
            raise HTTPException(409, {'code': 'plan_target_changed'})
        if isinstance(task_target, dict):
            node_payload = node_data.get('processingPayload') or {}
            if (task_target.get('canvas_id') != canvas_id
                    or task_target.get('node_id') != plan_node['id']
                    or task_target.get('node_revision') != (node_data.get('remixNodeRevision') or 1)
                    or not plan_goal_matches(node_payload.get('topic'), task_target.get('goal'))
                    or (node_data.get('remixDirectionEdited') is True
                        and node_payload.get('requirements') != provenance.get('requirements'))):
                raise HTTPException(409, {'code': 'plan_target_changed',
                                          'message': '当前画布节点已变化，请先同步并审核对应版本的作品方案'})
        guard.reassert()
        result = submit_plan_review(store, commission_ref=commission['commission_ref'],
                                    plan_ref=plan_ref, findings=findings)
        guard.reassert()
        return result


@router.post("/plan-review")
async def plan_review(project: str, canvas_id: str, body: PlanReviewRequest, user: dict = Depends(get_api_user)):
    ctx, _, store = await _context(project, canvas_id, user)
    commission = await _commission_in_scope(store, body.commission_ref, ctx, canvas_id)
    try:
        result = await _call(_review_plan_on_current_canvas, ctx, store, canvas_id,
                             commission, body.plan_ref, body.findings)
    except HTTPException:
        raise
    except Exception as exc:
        from novelvideo.api.reference_operation_logging import log_plan_review_failure
        log_plan_review_failure(project_id=ctx.project_id, canvas_id=canvas_id,
                                commission_ref=commission['commission_ref'], plan_ref=body.plan_ref,
                                phase=commission['phase'], error=exc)
        raise
    await _emit_director_update(ctx, canvas_id)
    return _data(result)


@router.post("/direct-plan")
async def direct_plan(project: str, canvas_id: str, body: DirectPlanRequest, user: dict = Depends(get_api_user)):
    from copy import deepcopy
    import hashlib
    from novelvideo.freezone.remix.contracts import validate_payload
    if user.get('credential_kind') in {'agent_session', 'local_trusted_agent'}:
        raise HTTPException(409, 'Agent 创建作品方案请提交 workflow Intent，等待画布确认后执行')
    ctx, canvas, store = await _context(project, canvas_id, user)
    commission = await _commission_in_scope(store, body.commission_ref, ctx, canvas_id)
    if commission["phase"] != "drafting_plan":
        raise HTTPException(409, "confirm direction before direct plan authoring")
    confirmed_goal = (commission.get("direction") or {}).get("target_goal")
    if confirmed_goal and body.goal != confirmed_goal:
        raise HTTPException(409, "plan goal differs from confirmed direction")
    plan = validate_payload("production_plan.v2", {"schema_version": 2, "goal": body.goal, "output": body.output.model_dump(),
                         "beats": [], "resources": [], "placements": [], "provenance": {}})
    for field, value in (commission.get("direction") or {}).get("output_requirements", {}).items():
        if plan["output"].get(field) != value:
            raise HTTPException(409, "output differs from confirmed direction")
    key = hashlib.sha256((canvas_id + ":" + ctx.requester_user_id + ":" + body.command_id).encode()).hexdigest()[:32]
    node_id, compose_id = "direct-plan-" + key, "direct-compose-" + key
    def publish():
        with store._locked() as guard:
            try:
                old = store._read(key, 1)
            except FileNotFoundError:
                old = None
            if old:
                if old["payload"] != plan:
                    raise ValueError("direct plan command_id reused with different content")
                return old
            return store._publish(artifact_id=key, schema="production_plan.v2", revision=1, payload=plan,
                upstream_refs=store._reference_list([commission["commission_ref"]], store.project_id), created_by=ctx.requester_user_id, guard=guard)
    saved = await _call(publish)
    if not any(node["id"] == node_id for node in canvas.get("nodes", [])):
        analysis = next((node for node in canvas.get("nodes", []) if node["id"] == commission["analysis_node_id"]), None)
        if not analysis:
            raise HTTPException(404, "reference analysis no longer exists")
        position = analysis.get("position") or {"x": 0, "y": 0}
        def build(existing):
            updated = deepcopy(existing)
            if any(node["id"] == node_id for node in updated.get("nodes", [])):
                return updated
            updated["nodes"].append({"id": node_id, "type": "scriptNode", "position": {"x": position["x"] + 460, "y": position["y"]},
                "data": {"displayName": "作品方案", "remixRole": "production_plan", "semanticOutputRole": "production_plan",
                         "productionPlanV2Ref": {"artifactId": key, "revision": 1}, "productionPlanV2Draft": saved["payload"], "productionPlanV2Dirty": False}})
            updated["edges"].append({"id": "direct-edge-" + key, "source": analysis["id"], "target": node_id, "sourceHandle": "source", "targetHandle": "target", "data": {"linkType": "media_input_for"}})
            if body.include_compose:
                updated["nodes"].append({"id": compose_id, "type": "videoComposeNode", "position": {"x": position["x"] + 920, "y": position["y"]},
                    "data": {"displayName": "视频合成", "productionPlanNodeId": node_id, "processingAction": "compile_production_plan"}})
                updated["edges"].append({"id": "direct-compose-edge-" + key, "source": node_id, "target": compose_id, "sourceHandle": "source", "targetHandle": "target", "data": {"linkType": "composition_input_for"}})
            updated["revision"] = int(updated["revision"]) + 1
            updated["updated_at"] = canvas_store.utc_now_iso()
            return updated
        canvas_save = await asyncio.to_thread(canvas_store.save_canvas, ctx.state_dir, canvas_id, base_revision=canvas["revision"], build_payload=build, save_source="director_direct_plan")
        canvas = canvas_save.payload
    await _emit_director_update(ctx, canvas_id)
    await _emit_director_update(ctx, canvas_id, canvas_changed=True)
    return _data({"project_id": project, "canvas_id": canvas_id, "canvas_apply_status": "direct_applied",
                  "applied": True, "revision": canvas["revision"],
                  "plan_ref": {"artifact_id": key, "revision": saved["revision"]}, "node_id": node_id,
                  "compose_node_id": compose_id if body.include_compose else None, "instruction": "Read and edit this native empty plan through bounded production commands; then review the saved result."})


@router.post("/production-batch")
async def production_batch(project: str, canvas_id: str, body: ProductionBatchRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.production_commands import apply_production_commands, ProductionCommandConflict
    _, canvas, store = await _context(project, canvas_id, user)
    plan, _ = await _plan_in_canvas(store, body.plan_ref, canvas)
    try:
        return _data(await _call(apply_production_commands, store, body.plan_ref, body.commands, body.command_id))
    except ProductionCommandConflict as exc:
        raise HTTPException(409, {"message": str(exc), "current_revision": exc.current_revision}) from exc


@router.post("/material-work")
async def material_work(project: str, canvas_id: str, body: MaterialWorkRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.material_work import (
        material_workflow_intent,
        missing_material_parameter_choices, material_duration_issues,
        material_parameter_conflicts, material_lifecycle_status,
    )
    from novelvideo.freezone.remix.store import RemixArtifactConflict
    ctx, canvas, store = await _context(project, canvas_id, user)
    plan, _ = await _plan_in_canvas(store, body.plan_ref, canvas)
    commission = await _commission_in_scope(store, body.commission_ref, ctx, canvas_id)
    if commission["phase"] != "preparing_materials":
        raise HTTPException(409, "confirm the reviewed plan before material production")
    from novelvideo.freezone.remix.production_review import production_decision_fingerprint
    review = await _call(store.read, commission["review_ref"]["artifact_id"], commission["review_ref"]["revision"])
    if commission["plan_ref"]["artifact_id"] != body.plan_ref["artifact_id"] or production_decision_fingerprint(plan["payload"]) != review["payload"]["decision_fingerprint"]:
        raise HTTPException(409, "plan content changed; review and confirm before producing materials")
    if (any(step.get('source') == 'generate' and step.get('media_kind') in {'image', 'video'}
            for step in body.steps)
            and 'preserve_replace' not in (commission.get('direction') or {})):
        raise HTTPException(409, {
            'code': 'visual_preservation_unverified',
            'message': '旧方向没有核对视觉保留约束；请依据原用户确认消息重新核对方向，再对当前方案复审。系统不会自动重新分析原片或起草方案',
            'next_action': 'review_direction_preservation',
        })
    for step in body.steps:
        for reference in step.get("references", []):
            if reference.get("node_id") and not any(n["id"] == reference["node_id"] for n in canvas.get("nodes", [])):
                raise HTTPException(404, "material reference is not on this canvas")
    duration_issues = material_duration_issues(body.steps)
    if duration_issues:
        raise HTTPException(422, {
            "code": "material_duration_invalid", "issues": duration_issues,
            "message": "请逐个视频素材步骤填写模型可支持的 4～15 秒整数时长",
        })
    confirmed_choices = await _saved_material_generation_choices(ctx, canvas_id, commission)
    conflicts = material_parameter_conflicts(body.steps, confirmed_choices)
    if conflicts:
        raise HTTPException(409, {
            "code": "material_parameter_choice_conflict", "conflicts": conflicts,
            "message": "素材步骤参数与当前用户确认的选择不一致；请先更新步骤或让用户重新选择",
        })
    try:
        from novelvideo.freezone.remix.reference_commission import (
            AuthenticatedMaterialCreationEvidence, MaterialWorkAssociationInterrupted, prepare_commission_material_work,
        )

        def create_current():
            with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as guard:
                current_canvas = canvas_store.read_canvas(ctx.state_dir, canvas_id)
                evidence = AuthenticatedMaterialCreationEvidence(ctx.project_id, canvas_id, ctx.requester_user_id)
                return prepare_commission_material_work(
                    store, body.commission_ref, body.plan_ref, body.requirements, body.steps,
                    body.command_id, select_for_commission=body.select_for_commission, host_evidence=evidence,
                    canvas=current_canvas, direction=commission.get('direction'),
                    confirmed_choices=confirmed_choices, _canvas_guard=guard)

        result = await asyncio.to_thread(create_current)
    except HTTPException:
        raise
    except MaterialWorkAssociationInterrupted as exc:
        raise HTTPException(500, {
            **_material_work_internal_error(request_id=current_request_id()),
            'code': 'material_work_association_interrupted', 'side_effects': 'saved',
            'work_ref': exc.work_ref, 'next_action': 'select_material_work',
            'message': '素材工作包已保存，关联未完成；保留 work_ref，明确选择后使用现有选择入口',
        }) from exc
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RemixArtifactConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except (MaterialWorkRequestError, MaterialSourceConflict, ValueError) as exc:
        raise HTTPException(
            422,
            _material_work_error_detail(exc, request_id=current_request_id()),
        ) from exc
    except Exception as exc:
        request_id = current_request_id()
        logger.exception("material work preparation failed request_id=%s", request_id)
        raise HTTPException(
            500,
            _material_work_internal_error(request_id=request_id),
        ) from exc
    artifact = await _call(store.read, result["work_ref"]["artifact_id"], result["work_ref"]["revision"])
    await _emit_director_update(ctx, canvas_id)
    missing_choices = missing_material_parameter_choices(artifact["payload"]["steps"], confirmed_choices)
    ready_for_native_generation = not bool(missing_choices)
    intent = (await _call(material_workflow_intent, artifact["payload"], canvas=canvas, store=store)
              if ready_for_native_generation else {"items": []})
    return _data({**result, "workflow_intent": intent, "work": artifact["payload"],
                  "material_lifecycle": material_lifecycle_status(artifact["payload"]),
                  "generation_readiness": {
                      "confirmed_choices": bool(confirmed_choices),
                      "missing_choices": missing_choices,
                      "ready_for_native_generation": ready_for_native_generation,
                  },
                  "next_action": ("select_material_work" if result.get('selection_status') == 'selection_required' else "prepare_native_generation"
                                   if ready_for_native_generation
                                   else "request_user_clarification"),
                  "agent_instruction": ("素材工作包已保存，尚未关联。用户明确选择后调用 freezone_select_material_work；不要准备新草稿或自动重试。"
                      if result.get("selection_status") == "selection_required" else
                      "素材工作包已保存。它只记录依赖、提示词、参考关系和每个视频步骤的 4～15 秒时长，"
                      "不会启动实际生成。请通过现有参数卡补齐缺失选择；不要重复保存工作包或自动重试。"
                      if not ready_for_native_generation else
                      "素材工作包已保存，参数选择已齐全。请读取当前 work_ref，准备原生工作流草稿并继续使用现有画布确认卡；"
                      "不要把工作包保存或草稿创建说成素材已生成。"
                  )})


async def _saved_material_generation_choices(ctx, canvas_id: str, commission: dict) -> dict:
    """Read only browser-submitted choices for this exact current commission."""
    from novelvideo.chat.reference_remix_continuation import coordinator
    from novelvideo.freezone.remix.reference_parameter_receipts import (
        generation_requirements_digest, generation_requirements_snapshot,
        merged_reference_parameter_answers, material_parameter_values,
    )
    from novelvideo.freezone.workflow_drafts import read_reference_parameter_submissions

    candidates = await _call(coordinator.store.list_for_actor, ctx, canvas_id, None)
    commission_id = commission['commission_ref']['artifact_id']
    matches = [run for run in candidates
               if (run.get('commission_ref') or {}).get('artifact_id') == commission_id
               and run.get('status') not in {'cancelled', 'failed', 'stale', 'superseded'}]
    # Multiple retained continuation runs can each contain a different saved
    # answer. Do not let their listing order decide which user choice wins.
    if len(matches) != 1:
        return {}
    run = matches[0]
    agent_id = run.get('agent_id')
    digest = generation_requirements_digest(commission, run.get('inputs') or {})
    scope = {'project_id': ctx.project_id, 'canvas_id': canvas_id,
             'agent_id': agent_id, 'requester_user_id': ctx.requester_user_id,
             'commission_id': commission_id}
    interactions = list(run.get('generation_parameter_receipts')
                        or ([run['user_interaction_receipt']]
                            if run.get('user_interaction_receipt') else []))
    interactions.extend(await _call(
        read_reference_parameter_submissions, project_dir=ctx.state_dir,
        scope=scope, requirements_digest=digest, include_prior_requirements=True,
    ))
    answers = merged_reference_parameter_answers(
        interactions, scope, digest,
        current_requirements=generation_requirements_snapshot(
            commission, run.get('inputs') or {}),
    )
    return material_parameter_values(answers)


@router.post("/select-material-work")
async def select_material_work(project: str, canvas_id: str, body: SelectMaterialWorkRequest,
                               user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.reference_commission import (
        AuthenticatedDecisionEvidence, select_material_work as select_work,
    )
    ctx, _, store = await _context(project, canvas_id, user)

    def select_current():
        with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as guard:
            canvas = canvas_store.read_canvas(ctx.state_dir, canvas_id)
            if not canvas or canvas.get("project_id") != ctx.project_id:
                raise HTTPException(404, "canvas not found")
            if canvas.get("access_model") in {"private", "user_private"} and canvas.get("owner_principal_id") != ctx.requester_user_id:
                raise HTTPException(403, "private canvas access denied")
            evidence = AuthenticatedDecisionEvidence(ctx.project_id, canvas_id, ctx.requester_user_id, body.command_id)
            return select_work(store, body.commission_ref, body.work_ref, body.command_id,
                               host_evidence=evidence, canvas=canvas, _canvas_guard=guard)

    try:
        result = await _call(select_current)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    await _emit_director_update(ctx, canvas_id)
    return _data(result)


@router.post("/speech-review")
async def speech_review(project: str, canvas_id: str, body: SpeechReviewRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.agent_speech_review import get_speech_review
    _, canvas, store = await _context(project, canvas_id, user, "viewer")
    await _plan_in_canvas(store, body.plan_ref, canvas)
    return _data(await _call(get_speech_review, store, body.plan_ref, body.take_id, body.recognition_ref, offset=body.offset, limit=body.limit))


@router.post("/speech-correction")
async def speech_correction(project: str, canvas_id: str, body: SpeechCorrectionRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.agent_speech_review import preview_speech_correction
    ctx, canvas, store = await _context(project, canvas_id, user)
    await _plan_in_canvas(store, body.plan_ref, canvas)
    saved = await _call(preview_speech_correction, store, body.plan_ref, body.take_id, body.recognition_ref,
                        body.corrections, actor_id=ctx.requester_user_id,
                        actor_kind="agent" if user.get("credential_kind") in {"agent_session", "local_trusted_agent"} else "user")
    await _emit_director_update(ctx, canvas_id)
    return _data({"preview_ref": {"artifact_id": saved["id"], "revision": saved["revision"]}, **saved["payload"]})


@router.post("/speech-corrections/{artifact_id}/confirm")
async def confirm_speech_correction(project: str, canvas_id: str, artifact_id: str, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.agent_speech_review import create_speech_correction_review, apply_speech_correction
    if user.get("credential_kind") in {"agent_session", "local_trusted_agent"}:
        raise HTTPException(403, "user confirmation is required for unverified lexical correction")
    ctx, canvas, store = await _context(project, canvas_id, user)
    preview = await _call(store.read, artifact_id, 1)
    if preview["schema"] != "speech_correction_preview.v1":
        raise HTTPException(422, "speech preview required")
    _, node = await _plan_in_canvas(store, preview["payload"]["source_plan_ref"], canvas)
    preview_ref = {"artifact_id": artifact_id, "revision": 1}
    review = await _call(create_speech_correction_review, store, preview_ref, actor_id=ctx.requester_user_id, actor_kind="user", accepted=True)
    saved = await _call(apply_speech_correction, store, preview_ref, {"artifact_id": review["id"], "revision": review["revision"]}, "confirm-" + artifact_id)
    await _emit_director_update(ctx, canvas_id)
    return _data({"plan": saved, "node_id": node["id"]})


@router.post("/advance")
async def advance_director(project: str, canvas_id: str, body: AdvanceRequest, user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.reference_commission import advance_reference_commission
    if body.event.get("type") in {"direction_confirmed", "plan_confirmed", "editable_composition_confirmed"}:
        raise HTTPException(403, "use the user confirmation surface")
    ctx, _, store = await _context(project, canvas_id, user)
    commission = await _commission_in_scope(store, body.commission_ref, ctx, canvas_id)
    result = await _call(advance_reference_commission, store, commission["commission_ref"], body.event, body.commission_ref["revision"])
    await _notify_commission(ctx, canvas_id, result, "artifact:" + result["commission_ref"]["artifact_id"] + ":" + str(result["commission_ref"]["revision"]))
    return _data(result)


async def _notify_commission(ctx, canvas_id, commission, event_key):
    from novelvideo.chat.reference_remix_continuation import automatic_reference_continuation_enabled, coordinator
    if commission.get('parent_commission_ref') and commission['phase'] != 'completed':
        from novelvideo.freezone.remix.reference_commission import read_reference_commission, advance_reference_commission
        store = RemixArtifactStore(Path(ctx.output_dir),ctx.project_id,created_by=ctx.requester_user_id)
        parent = await _call(read_reference_commission,store,commission['parent_commission_ref'],latest=True)
        if parent['phase'] == 'completed':
            await _call(advance_reference_commission,store,parent['commission_ref'],
                {'type':'branches_reopened','commission_ref':commission['commission_ref']},parent['commission_ref']['revision'])
    if not automatic_reference_continuation_enabled():
        return
    for run in await asyncio.to_thread(coordinator.production_for_actor, ctx, canvas_id, None):
        if (run.get("commission_ref") or {}).get("artifact_id") in {commission["commission_ref"]["artifact_id"], (commission.get('parent_commission_ref') or {}).get('artifact_id')}:
            await coordinator.continue_commission(ctx=ctx, run_id=run["run_id"], event_key=event_key)
            return


async def _emit_director_update(ctx, canvas_id, *, canvas_changed=False):
    from novelvideo.chat.reference_remix_continuation import coordinator
    from novelvideo.freezone.remix.conversation_cards import publish_conversation_cards
    from novelvideo.freezone.remix.director_notifications import broadcast_director_update
    runs = await asyncio.to_thread(coordinator.production_for_actor, ctx, canvas_id, None)
    await publish_conversation_cards(ctx, canvas_id=canvas_id, runs=runs)
    await broadcast_director_update(ctx, canvas_id=canvas_id,
        agent_ids=[run.get('agent_id') for run in runs], canvas_changed=canvas_changed)


class AdvanceProductionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    commission_ref: dict[str, Any]
    expected_projection_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    command_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    agent_id: str = Field(default='main', min_length=1, max_length=128)


@router.post('/advance-production')
async def advance_current_production(project: str, canvas_id: str, body: AdvanceProductionRequest,
                                     user: dict = Depends(get_api_user)):
    from novelvideo.chat.reference_remix_continuation import automatic_reference_continuation_enabled
    from novelvideo.freezone.remix.production_advancement import advance_production
    from novelvideo.freezone.remix.store import RemixArtifactConflict
    from novelvideo.freezone.canvas_lock import CanvasLockBusy
    ctx, _, _ = await _context(project, canvas_id, user, agent_id=body.agent_id)
    try:
        state = await advance_production(ctx, canvas_id=canvas_id, commission_ref=body.commission_ref,
            expected_projection_revision=body.expected_projection_revision, command_id=body.command_id,
            agent_id=body.agent_id,
            automation_enrollment_command=(body.command_id if automatic_reference_continuation_enabled()
                and user.get('credential_kind') not in {'agent_session', 'local_trusted_agent'} else None))
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RemixArtifactConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, 'Current production evidence not found') from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except (CanvasLockBusy, OSError) as exc:
        raise HTTPException(503, 'Production storage temporarily unavailable; retry') from exc
    await _emit_director_update(ctx, canvas_id, canvas_changed=bool((state.get('advancement') or {}).get('action')))
    return _data(state)


class ResumeProductionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    commission_ref: dict[str, Any]
    command_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    agent_id: str = Field(default='main', min_length=1, max_length=128)


@router.get('/production-recovery')
async def production_recovery(project: str, canvas_id: str,
    agent_id: str = Query(default='main', min_length=1, max_length=128), user: dict = Depends(get_api_user)):
    from novelvideo.chat.reference_remix_continuation import coordinator
    ctx, canvas, _ = await _context(project, canvas_id, user, 'viewer', agent_id=agent_id)
    def read():
        with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, canvas_id) as guard:
            current = canvas_store.read_canvas(ctx.state_dir, canvas_id)
            candidates = coordinator.production_recovery_candidates(ctx, canvas_id=canvas_id, agent_id=agent_id, canvas=current)
            guard.reassert()
            return [{key: item['commission'][key] for key in ('commission_ref','goal','phase','analysis_node_id')}
                for item in candidates.values()]
    try:
        items = await asyncio.to_thread(read)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    return _data({'scope': {'project_id': ctx.project_id, 'canvas_id': canvas_id, 'agent_id': agent_id}, 'items': items})


@router.post('/resume-production')
async def resume_current_production(project: str, canvas_id: str, body: ResumeProductionRequest,
                                    user: dict = Depends(get_api_user)):
    from novelvideo.chat.reference_remix_continuation import automatic_reference_continuation_enabled, coordinator
    from novelvideo.freezone.remix.store import RemixArtifactConflict
    from novelvideo.freezone.canvas_lock import CanvasLockBusy
    if user.get('credential_kind') in {'agent_session','local_trusted_agent'}:
        raise HTTPException(403, 'production resume requires an explicit user request')
    ctx, canvas, _ = await _context(project, canvas_id, user, agent_id=body.agent_id)
    if not automatic_reference_continuation_enabled():
        raise HTTPException(503, 'automatic reference continuation is disabled')
    try:
        ref = await coordinator.resume_commission_production(ctx=ctx, canvas_id=canvas_id,
            commission_ref=body.commission_ref, command_id=body.command_id, agent_id=body.agent_id, observed_canvas=canvas)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RemixArtifactConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except (CanvasLockBusy, OSError) as exc:
        raise HTTPException(503, 'Production recovery storage temporarily unavailable') from exc
    await _emit_director_update(ctx, canvas_id)
    return _data({'accepted': True, 'commission_ref': ref,
        'scope': {'project_id': ctx.project_id, 'canvas_id': canvas_id, 'agent_id': body.agent_id}})


@router.post('/production-nodes/prepare')
async def prepare_production_nodes_entry(project: str, canvas_id: str, body: ProductionNodesRequest,
                                         request: Request,
                                         agent_id: str = Query(default='main', min_length=1, max_length=128),
                                         user: dict = Depends(get_api_user)):
    from novelvideo.freezone.remix.production_node_entry import prepare_production_nodes
    bound_agent_id = request.headers.get('X-DramaClaw-Agent-ID', '').strip() or agent_id
    ctx, _, _ = await _context(project, canvas_id, user, agent_id=bound_agent_id)
    return _data(await prepare_production_nodes(
        ctx=ctx, canvas_id=canvas_id, request=body, agent_id=bound_agent_id,
        turn_id=request.headers.get('X-DramaClaw-Turn-ID', ''),
        agent_request=user.get('credential_kind') in {'agent_session', 'local_trusted_agent'},
    ))
