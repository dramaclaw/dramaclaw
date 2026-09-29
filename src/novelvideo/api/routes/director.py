"""Thin authenticated adapter for the independent TV Director work state."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel

from novelvideo.api.auth import get_api_user
from novelvideo.director.models import (
    CreateWork,
    FinalizeEpisode,
    GenerateDraft,
    HistoryCommand,
    ProposeChange,
    PutDocument,
    UpdateWork,
)
from novelvideo.director.store import (
    DirectorConflict,
    DirectorInvalidState,
    DirectorNotFound,
    DirectorStore,
)
from novelvideo.director.writing import (
    compile_generation,
    director_model_contract,
)
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.schemas.execution import ExecutionCommand, ExecutionFault
from novelvideo.director.schemas.documents import DocumentCommand
from novelvideo.director.repository import DocumentRepository
from novelvideo.director.migrations.v2 import preview_legacy
from novelvideo.director.quality import QualityService
from novelvideo.director.outline_review import outline_quality_report
from novelvideo.director.schemas.quality import FinalizeCommand
from novelvideo.director.revisions import RevisionService
from novelvideo.director.schemas.revisions import RevisionPreviewCommand, CommitRevision
from novelvideo.director.schemas.planning import WorkflowCommand
from novelvideo.director.workflow import WorkflowService, dispatch_planning
from novelvideo.director.media import MediaPrepare, MediaRepository
from novelvideo.director.media_batch import BatchApproval, BatchPrepare, MediaBatchRepository, NodePosition
from novelvideo.project_context import require_project_home_node, resolve_project_context

router = APIRouter()
T = TypeVar("T")


def _result(operation: Callable[[], T]) -> dict[str, Any]:
    try:
        return {"ok": True, "data": operation()}
    except ExecutionFault as exc:
        raise HTTPException(exc.status, exc.as_dict()) from exc
    except DirectorNotFound as exc:
        raise HTTPException(404, {"code": "DIRECTOR_NOT_FOUND", "message": str(exc)}) from exc
    except DirectorConflict as exc:
        raise HTTPException(409, {"code": "STALE_DOCUMENT", "message": str(exc)}) from exc
    except DirectorInvalidState as exc:
        raise HTTPException(409, {"code": "INVALID_CHECKPOINT", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(422, {"code": "DIRECTOR_VALIDATION_ERROR", "message": str(exc)}) from exc


async def _store(project: str, user: dict, role: str) -> DirectorStore:
    ctx = await resolve_project_context(user=user, project_id=project, required_role=role)
    require_project_home_node(ctx, operation="TV Director access")
    return DirectorStore(ctx.state_dir)


@router.get("/projects/{project}/director/model", tags=["director"])
async def get_director_model(project: str, user: dict = Depends(get_api_user)):
    await _store(project, user, "viewer")
    return _result(director_model_contract)


@router.get("/projects/{project}/director/works/{work_id}/media", tags=["director"])
async def director_media(project: str, work_id: str, user: dict = Depends(get_api_user)):
    repository = MediaRepository(await _store(project, user, "viewer"))
    return _result(lambda: repository.list(work_id))


@router.get("/projects/{project}/director/works/{work_id}/media/source/{kind}", tags=["director"])
async def director_media_source(project: str, work_id: str, kind: str, user: dict = Depends(get_api_user)):
    repository = MediaRepository(await _store(project, user, "viewer"))
    return _result(lambda: repository.source(work_id, kind))


@router.post("/projects/{project}/director/works/{work_id}/media/prepare", tags=["director"])
async def prepare_director_media(project: str, work_id: str, body: MediaPrepare, user: dict = Depends(get_api_user)):
    from .freezone import freezone_image_models

    repository = MediaRepository(await _store(project, user, "editor"))
    catalog = (await freezone_image_models(project, user))["data"]
    return _result(lambda: repository.prepare(_execution_actor(user), work_id, body, catalog))


class MediaApproval(BaseModel):
    approved: bool
    acknowledge_unknown_cost: bool


@router.get("/projects/{project}/director/works/{work_id}/media/batches", tags=["director"])
async def director_media_batches(project: str, work_id: str, user: dict = Depends(get_api_user)):
    repository = MediaBatchRepository(MediaRepository(await _store(project, user, "viewer")))
    return _result(lambda: repository.list(work_id))


@router.post("/projects/{project}/director/works/{work_id}/media/batches", tags=["director"])
async def prepare_director_batch(project: str, work_id: str, body: BatchPrepare, user: dict = Depends(get_api_user)):
    from .freezone import freezone_image_models

    repository = MediaBatchRepository(MediaRepository(await _store(project, user, "editor")))
    catalog = (await freezone_image_models(project, user))["data"]
    return _result(lambda: repository.prepare(_execution_actor(user), work_id, body, catalog))


@router.post("/projects/{project}/director/works/{work_id}/media/batches/{batch_id}/approve", tags=["director"])
async def approve_director_batch(project: str, work_id: str, batch_id: str, body: BatchApproval, user: dict = Depends(get_api_user)):
    from .freezone import freezone_image_models

    repository = MediaBatchRepository(MediaRepository(await _store(project, user, "editor")))
    catalog = (await freezone_image_models(project, user))["data"]
    batch = _result(lambda: repository.approve(_execution_actor(user), work_id, batch_id, body, catalog))["data"]
    for intent_id in batch["selectedIds"]:
        # Enqueue only; generation itself belongs to the existing task worker.
        # A crash leaves prepared entries resumable, submitting entries unknown.
        await confirm_director_media(project, work_id, intent_id,
                                     MediaApproval(approved=True, acknowledge_unknown_cost=True), user)
    return {"ok": True, "data": next(b for b in repository.list(work_id) if b["id"] == batch_id)}


@router.post("/projects/{project}/director/works/{work_id}/media/batches/{batch_id}/cancel", tags=["director"])
async def cancel_director_batch(project: str, work_id: str, batch_id: str, user: dict = Depends(get_api_user)):
    repository = MediaBatchRepository(MediaRepository(await _store(project, user, "editor")))
    return _result(lambda: repository.cancel(_execution_actor(user), work_id, batch_id))


@router.patch("/projects/{project}/director/works/{work_id}/media/nodes/{node_id}", tags=["director"])
async def move_director_media_node(project: str, work_id: str, node_id: str, body: NodePosition, user: dict = Depends(get_api_user)):
    repository = MediaBatchRepository(MediaRepository(await _store(project, user, "editor")))
    return _result(lambda: repository.move(work_id, node_id, body))


@router.post("/projects/{project}/director/works/{work_id}/media/{intent_id}/confirm", tags=["director"])
async def confirm_director_media(project: str, work_id: str, intent_id: str, body: MediaApproval,
                                 user: dict = Depends(get_api_user)):
    from .freezone import freezone_gen, freezone_image_models
    from novelvideo.api.schemas import FreezoneGenRequest

    repository = MediaRepository(await _store(project, user, "editor"))
    if not body.approved or not body.acknowledge_unknown_cost:
        raise HTTPException(422, {"code": "MEDIA_APPROVAL_REQUIRED"})
    catalog = (await freezone_image_models(project, user))["data"]
    intent, claimed = _result(lambda: repository.claim(_execution_actor(user), work_id, intent_id, catalog))["data"]
    if not claimed:
        return {"ok": True, "data": intent}
    try:
        response = await freezone_gen(project, FreezoneGenRequest.model_validate(intent["request"]["actual"]), user)
        if isinstance(response, BaseModel):
            response = response.model_dump()
        result = response["data"]
        if not result.get("task_key") or not result.get("job_id"):
            raise ValueError("MEDIA_TASK_RECEIPT_INVALID")
    except Exception:
        # Even an HTTP error may follow an accepted job. Never mint a retry here.
        return {"ok": True, "data": repository.finish(work_id, intent_id, None)}
    return {"ok": True, "data": repository.finish(work_id, intent_id, result)}


@router.get("/projects/{project}/director/works", tags=["director"])
async def list_director_works(project: str, archived: bool = False, user: dict = Depends(get_api_user)):
    store = await _store(project, user, "viewer")
    return _result(lambda: store.list_works(archived=archived))


@router.post("/projects/{project}/director/works/{work_id}/history", tags=["director"])
async def director_history_command(project: str, work_id: str, body: HistoryCommand, user: dict = Depends(get_api_user)):
    store = await _store(project, user, "editor")
    return _result(lambda: store.history_command(work_id, body, _execution_actor(user)))


@router.post("/projects/{project}/director/works", tags=["director"])
async def create_director_work(project: str, body: CreateWork, user: dict = Depends(get_api_user)):
    store = await _store(project, user, "editor")
    return _result(lambda: store.create_work(body))


@router.patch("/projects/{project}/director/works/{work_id}", tags=["director"])
async def update_director_work(
    project: str, work_id: str, body: UpdateWork, user: dict = Depends(get_api_user),
):
    store = await _store(project, user, "editor")
    return _result(lambda: store.update_work(work_id, body))


@router.get("/projects/{project}/director/works/{work_id}", tags=["director"])
async def get_director_work(project: str, work_id: str, user: dict = Depends(get_api_user)):
    store = await _store(project, user, "viewer")

    def read() -> dict[str, Any]:
        return {
            "work": store.get_work(work_id, include_source=True),
            "documents": store.list_documents(work_id),
            "changes": store.list_changes(work_id),
            "runs": store.list_runs(work_id),
        }

    return _result(read)


@router.get("/projects/{project}/director/works/{work_id}/documents/{doc_key}", tags=["director"])
async def get_director_document(project: str, work_id: str, doc_key: str, user: dict = Depends(get_api_user)):
    store = await _store(project, user, "viewer")
    return _result(lambda: store.get_document(work_id, _validate_doc_key(doc_key)))


@router.put("/projects/{project}/director/works/{work_id}/documents/{doc_key}", tags=["director"])
async def put_director_document(
    project: str, work_id: str, doc_key: str, body: PutDocument,
    user: dict = Depends(get_api_user),
):
    store = await _store(project, user, "editor")
    return _result(lambda: store.put_document(work_id, _validate_doc_key(doc_key), body.content, body.expected_version))


def _validate_doc_key(doc_key: str) -> str:
    if doc_key in {"outline", "characters", "relations", "scenes", "props"}:
        return doc_key
    if len(doc_key) == 11 and doc_key.startswith("episode-") and doc_key[8:].isdigit():
        ordinal = int(doc_key[8:])
        if 1 <= ordinal <= 100:
            return doc_key
    raise ValueError("invalid document key")


@router.post("/projects/{project}/director/works/{work_id}/changes", tags=["director"])
async def propose_director_change(
    project: str, work_id: str, body: ProposeChange,
    user: dict = Depends(get_api_user),
):
    store = await _store(project, user, "editor")
    return _result(lambda: store.propose_change(work_id, _validate_doc_key(body.doc_key), body.content, body.expected_version, body.reason))


class DecideChange(BaseModel):
    accept: bool


@router.post("/projects/{project}/director/works/{work_id}/changes/{change_id}/decision", tags=["director"])
async def decide_director_change(
    project: str, work_id: str, change_id: str, body: DecideChange,
    user: dict = Depends(get_api_user),
):
    store = await _store(project, user, "editor")
    return _result(lambda: store.decide_change(work_id, change_id, body.accept))


@router.post("/projects/{project}/director/works/{work_id}/finalize", tags=["director"])
async def finalize_director_episode(
    project: str, work_id: str, body: FinalizeEpisode,
    user: dict = Depends(get_api_user),
):
    store = await _store(project, user, "editor")
    return _result(lambda: store.finalize_episode(
        work_id, body.episode_ordinal, body.expected_version, body.quality_acknowledged
    ))


@router.get("/projects/{project}/director/works/{work_id}/quality/{ordinal}", tags=["director"])
async def get_director_quality_report(
    project: str, work_id: str, ordinal: int, user: dict = Depends(get_api_user),
):
    if not 1 <= ordinal <= 100:
        raise HTTPException(422, {"code": "DIRECTOR_VALIDATION_ERROR", "message": "invalid episode ordinal"})
    store = await _store(project, user, "viewer")
    return _result(lambda: store.quality_report(work_id, ordinal))


@router.get("/projects/{project}/director/works/{work_id}/events", tags=["director"])
async def list_director_events(
    project: str, work_id: str, after_seq: int = Query(default=0, ge=0),
    user: dict = Depends(get_api_user),
):
    store = await _store(project, user, "viewer")
    return _result(lambda: store.list_events(work_id, after_seq))


@router.post("/projects/{project}/director/works/{work_id}/generate/preview", tags=["director"])
async def preview_director_generation(
    project: str, work_id: str, body: GenerateDraft,
    user: dict = Depends(get_api_user),
):
    store = await _store(project, user, "editor")

    def preview() -> dict[str, Any]:
        compiled = compile_generation(store, work_id, body)
        return {
            "input_sha256": compiled["input_sha256"],
            "parameters": compiled["parameters"],
            "doc_key": compiled["doc_key"],
            "model_cost": "provider_configured_unknown",
        }

    return _result(preview)


@router.post("/projects/{project}/director/works/{work_id}/generate", tags=["director"])
async def generate_director_draft(
    project: str, work_id: str, body: GenerateDraft,
    user: dict = Depends(get_api_user),
):
    await _store(project, user, "editor")

    # Old clients have no durable intent ID or bounded authorization. Keeping
    # their write path would bypass the v2 outbox and allow a refresh to bill
    # twice. Reads, drafts and legacy history remain compatible.
    raise HTTPException(409, {"code": "EXECUTION_V2_REQUIRED", "messageKey": "director.execution.errors.EXECUTION_V2_REQUIRED"})


@router.get("/projects/{project}/director/v2/capabilities", tags=["director"])
async def get_execution_capabilities(project: str, user: dict = Depends(get_api_user)):
    await _store(project, user, "viewer")
    return _result(execution_capability)


@router.get("/projects/{project}/director/v2/works/{work_id}/runs", tags=["director"])
async def get_execution_runs(project: str, work_id: str, user: dict = Depends(get_api_user)):
    repository = ExecutionRepository(await _store(project, user, "viewer"))
    return _result(lambda: repository.list_operations(work_id))


@router.get("/projects/{project}/director/v2/works/{work_id}/events", tags=["director"])
async def get_execution_events(project: str, work_id: str, after_seq: int = Query(default=0, ge=0),
                               user: dict = Depends(get_api_user)):
    repository = ExecutionRepository(await _store(project, user, "viewer"))
    return _result(lambda: repository.events(work_id, after_seq))


@router.get("/projects/{project}/director/v2/works/{work_id}/runs/{run_id}/result", tags=["director"])
async def get_execution_result(project: str, work_id: str, run_id: str, user: dict = Depends(get_api_user)):
    repository = ExecutionRepository(await _store(project, user, "viewer"))
    return _result(lambda: repository.retained_result(work_id, run_id))


def _execution_actor(user: dict) -> str:
    value = user.get("user_id") or user.get("id") or user.get("username")
    if not value:
        raise HTTPException(403, {"code": "FORBIDDEN"})
    return str(value)


async def _execution_command(project: str, body: ExecutionCommand, user: dict,
                             background: BackgroundTasks, allowed: set[str]) -> dict:
    store = await _store(project, user, "editor")
    if body.payload.type not in allowed:
        raise HTTPException(422, {"code": "INVALID_COMMAND_TYPE"})
    repository = ExecutionRepository(store)
    result = _result(lambda: ExecutionService(repository).execute(_execution_actor(user), body))
    projection = result["data"]["result"]
    if body.payload.type in {"approval.grant", "run.resume"} and projection.get("status") == "queued":
        # Claim is an atomic, durable guard even if duplicate HTTP deliveries
        # enqueue two BackgroundTasks, or another worker handles the same ID.
        background.add_task(dispatch_writing, repository, body.work_id, projection["id"])
    return result


@router.post("/projects/{project}/director/v2/approvals/commands", tags=["director"], status_code=202)
async def execute_cost_command(project: str, body: ExecutionCommand, background: BackgroundTasks,
                               user: dict = Depends(get_api_user)):
    return await _execution_command(project, body, user, background, {"cost.quote", "approval.grant"})


@router.post("/projects/{project}/director/v2/runs/{run_id}/commands", tags=["director"], status_code=202)
async def execute_run_command(project: str, run_id: str, body: ExecutionCommand,
                              background: BackgroundTasks, user: dict = Depends(get_api_user)):
    if getattr(body.payload, "run_id", None) != run_id:
        raise HTTPException(422, {"code": "RUN_SCOPE_MISMATCH"})
    return await _execution_command(project, body, user, background, {"run.cancel", "run.resume"})


@router.get("/projects/{project}/director/v2/works/{work_id}/documents", tags=["director"])
async def get_canonical_documents(project: str, work_id: str, user: dict = Depends(get_api_user)):
    repository = DocumentRepository(await _store(project, user, "viewer"))
    return _result(lambda: repository.projection(work_id))


@router.get("/projects/{project}/director/v2/works/{work_id}/drafts", tags=["director"])
async def get_document_drafts(project: str, work_id: str, user: dict = Depends(get_api_user)):
    repository = DocumentRepository(await _store(project, user, "viewer"))
    return _result(lambda: repository.drafts(work_id, _execution_actor(user)))


@router.get("/projects/{project}/director/v2/works/{work_id}/import-preview", tags=["director"])
async def get_legacy_import_preview(project: str, work_id: str, user: dict = Depends(get_api_user)):
    store = await _store(project, user, "editor")
    return _result(lambda: preview_legacy(store, work_id))


@router.post("/projects/{project}/director/v2/documents/commands", tags=["director"])
async def execute_document_command(project: str, body: DocumentCommand, user: dict = Depends(get_api_user)):
    repository = DocumentRepository(await _store(project, user, "editor"))
    return _result(lambda: repository.execute(_execution_actor(user), body))


@router.get("/projects/{project}/director/v2/works/{work_id}/quality/{ordinal}", tags=["director"])
async def get_quality_v2(project: str, work_id: str, ordinal: int, user: dict = Depends(get_api_user)):
    if not 1 <= ordinal <= 100:
        raise HTTPException(422, {"code": "INVALID_EPISODE_ORDINAL"})
    service = QualityService(await _store(project, user, "viewer"))
    return _result(lambda: service.report(work_id, ordinal))


@router.post("/projects/{project}/director/v2/episodes/commands", tags=["director"])
async def finalize_v2(project: str, body: FinalizeCommand, user: dict = Depends(get_api_user)):
    service = QualityService(await _store(project, user, "editor"))
    return _result(lambda: service.finalize(_execution_actor(user), body))


@router.get("/projects/{project}/director/v2/works/{work_id}/outline-quality", tags=["director"])
async def get_outline_quality(project: str, work_id: str, user: dict = Depends(get_api_user)):
    store = await _store(project, user, "viewer")
    return _result(lambda: outline_quality_report(store, work_id))


@router.post("/projects/{project}/director/v2/revisions/preview", tags=["director"])
async def preview_revision(project: str, body: RevisionPreviewCommand, user: dict = Depends(get_api_user)):
    service = RevisionService(await _store(project, user, "editor"))
    return _result(lambda: service.preview(_execution_actor(user), body))


@router.post("/projects/{project}/director/v2/revisions/commands", tags=["director"])
async def commit_revision(project: str, body: CommitRevision, user: dict = Depends(get_api_user)):
    service = RevisionService(await _store(project, user, "editor"))
    return _result(lambda: service.commit(_execution_actor(user), body))


@router.get("/projects/{project}/director/v2/works/{work_id}/settings-history", tags=["director"])
async def settings_history(project: str, work_id: str, user: dict = Depends(get_api_user)):
    service = RevisionService(await _store(project, user, "viewer"))
    return _result(lambda: service.history(work_id))


@router.get("/projects/{project}/director/v2/works/{work_id}/planning", tags=["director"])
async def get_planning_workflow(project: str, work_id: str, user: dict = Depends(get_api_user)):
    repository = ExecutionRepository(await _store(project, user, "viewer"))
    return _result(lambda: WorkflowService(repository).projection(work_id))


@router.post("/projects/{project}/director/v2/planning/commands", tags=["director"], status_code=202)
async def execute_planning_command(project: str, body: WorkflowCommand, background: BackgroundTasks,
                                   user: dict = Depends(get_api_user)):
    repository = ExecutionRepository(await _store(project, user, "editor"))
    result = _result(lambda: WorkflowService(repository).execute(_execution_actor(user), body))
    if body.payload.type in {"planning.grant", "planning.resume"} and result["data"]["result"].get("phase") == "EXEC":
        background.add_task(dispatch_planning, repository, body.work_id)
    return result
