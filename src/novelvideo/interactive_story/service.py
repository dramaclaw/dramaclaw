"""Atomic application service for interactive stories stored inside canvases."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import ValidationError

from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_lock import CanvasLockBusy
from novelvideo.interactive_story.canvas_mapper import (
    CanvasStoryMappingError,
    find_story_group,
    project_story_to_canvas,
    story_from_canvas,
    story_graph_ids,
)
from novelvideo.interactive_story.models import (
    AddStoryChoice,
    AddStorySegment,
    ConfirmInteractiveStoryStagesRequest,
    ConfirmStoryOutlineRequest,
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    InteractiveStoryError,
    InteractiveStoryIssue,
    InteractiveStoryMutationResult,
    InteractiveStoryOutlineReadResult,
    InteractiveStoryOutlineSaveResult,
    InteractiveStoryProgressResult,
    InteractiveStoryReadResult,
    InteractiveStoryStageConfirmationResult,
    InteractiveStoryValidationResult,
    PendingStoryOutline,
    RemoveStoryCharacter,
    RemoveStoryChoice,
    RemoveStorySegment,
    RemoveStoryFlag,
    RemoveStoryVariable,
    SaveStoryOutlineRequest,
    SetStoryStart,
    StoryChoice,
    StoryDraftV2,
    StoryMediaRef,
    StoryPatchV2,
    StorySegment,
    UpdateStoryChoice,
    UpdateStoryMetadata,
    UpdateStorySegment,
    UpsertStoryCharacter,
    UpsertStoryFlag,
    UpsertStoryVariable,
    ValidateInteractiveStoryRequest,
)
from novelvideo.interactive_story.path_analysis import analyze_story_paths
from novelvideo.interactive_story.stage_progress import (
    build_progress_result,
    collect_stage_evidence,
    confirmed_manual_stages,
    find_first_story_group,
)

AGENT_CREATE_SAVE_SOURCE = "agent_create"
AGENT_PATCH_SAVE_SOURCE = "agent_patch"
AGENT_OUTLINE_SAVE_SOURCE = "agent_outline"
USER_OUTLINE_CONFIRM_SAVE_SOURCE = "user_outline_confirm"
AGENT_STAGE_CONFIRM_SAVE_SOURCE = "agent_stage_confirm"
# 待确认大纲寄存在画布级 metadata；正式故事仍以画布节点为唯一事实源。
PENDING_OUTLINE_METADATA_KEY = "pendingStoryOutline"


class InteractiveStoryServiceError(RuntimeError):
    """Runtime-neutral failure that adapters can serialize without translation logic."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        story_id: str | None = None,
        current_revision: int | None = None,
        issues: list[InteractiveStoryIssue] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.story_id = story_id
        self.current_revision = current_revision
        self.issues = issues or []

    def to_contract(self) -> InteractiveStoryError:
        return InteractiveStoryError(
            code=self.code,
            message=str(self),
            story_id=self.story_id,
            current_revision=self.current_revision,
            issues=self.issues,
        )


class InteractiveStoryService:
    """Create/read/patch/validate stories in the existing Freezone canvas store."""

    def __init__(
        self, project_dir: Path, *, project_id: str, actor_id: str = ""
    ) -> None:
        self.project_dir = Path(project_dir)
        self.project_id = project_id
        self.actor_id = actor_id

    def create(
        self, request: CreateInteractiveStoryRequest
    ) -> InteractiveStoryMutationResult:
        def build_payload(existing: dict | None) -> dict:
            current = existing or {}
            if existing is None and request.base_revision != 0:
                raise canvas_store.CanvasRevisionConflict(
                    current_revision=0,
                    base_revision=request.base_revision,
                )
            existing_group = find_first_story_group(current)
            if existing_group is not None:
                existing_story_id = str(
                    (existing_group.get("data") or {}).get("interactiveStoryId") or ""
                ).strip()
                raise InteractiveStoryServiceError(
                    "story_already_exists",
                    "canvas already contains interactive story "
                    f"{existing_story_id!r}; only one interactive story is allowed per canvas",
                    story_id=existing_story_id,
                )
            _require_confirmed_outline_for_create(current)
            projection = project_story_to_canvas(
                request.story,
                existing_canvas=current,
                group_position=_next_group_position(current),
            )
            _ensure_projection_ids_available(
                current, projection.nodes, projection.edges
            )
            nodes = [*_dict_list(current.get("nodes")), *projection.nodes]
            edges = [*_dict_list(current.get("edges")), *projection.edges]
            metadata = _link_confirmed_outline(current.get("metadata"), request.story.story_id)
            return self._canvas_payload(
                current,
                canvas_id=request.canvas_id,
                nodes=nodes,
                edges=edges,
                save_source=AGENT_CREATE_SAVE_SOURCE,
                metadata=metadata,
            )

        saved = self._save(
            canvas_id=request.canvas_id,
            base_revision=request.base_revision,
            idempotency_key=request.idempotency_key,
            request_payload=request.model_dump(mode="json"),
            build_payload=build_payload,
            story_id=request.story.story_id,
            save_source=AGENT_CREATE_SAVE_SOURCE,
        )
        story = self._story_after_save(request.canvas_id, request.story.story_id)
        return InteractiveStoryMutationResult(
            project_id=self.project_id,
            canvas_id=request.canvas_id,
            story_id=story.story_id,
            revision=_saved_revision(saved),
            idempotent=saved.idempotent,
            issues=issues_for_story(story),
        )

    def get(self, request: GetInteractiveStoryRequest) -> InteractiveStoryReadResult:
        canvas = self._read_canvas(request.canvas_id, request.story_id)
        story = self._map_story(canvas, request.story_id)
        return InteractiveStoryReadResult(
            canvas_id=request.canvas_id,
            story=story,
            issues=issues_for_story(story),
        )

    def patch(self, patch: StoryPatchV2) -> InteractiveStoryMutationResult:
        def build_payload(existing: dict | None) -> dict:
            if existing is None:
                raise InteractiveStoryServiceError(
                    "story_not_found",
                    f"story {patch.story_id!r} was not found",
                    story_id=patch.story_id,
                )
            current_story = self._map_story(existing, patch.story_id)
            updated_story = apply_story_patch(current_story, patch)
            projection = project_story_to_canvas(
                updated_story, existing_canvas=existing
            )
            owned_node_ids, owned_edge_ids = story_graph_ids(existing, patch.story_id)
            removed_node_ids = owned_node_ids - {
                str(node.get("id") or "") for node in projection.nodes
            }
            nodes = [
                node
                for node in _dict_list(existing.get("nodes"))
                if str(node.get("id") or "") not in owned_node_ids
            ]
            edges = [
                edge
                for edge in _dict_list(existing.get("edges"))
                if str(edge.get("id") or "") not in owned_edge_ids
                and str(edge.get("source") or "") not in removed_node_ids
                and str(edge.get("target") or "") not in removed_node_ids
            ]
            nodes.extend(projection.nodes)
            edges.extend(projection.edges)
            return self._canvas_payload(
                existing,
                canvas_id=patch.canvas_id,
                nodes=nodes,
                edges=edges,
                save_source=AGENT_PATCH_SAVE_SOURCE,
            )

        saved = self._save(
            canvas_id=patch.canvas_id,
            base_revision=patch.base_revision,
            idempotency_key=patch.idempotency_key,
            request_payload=patch.model_dump(mode="json"),
            build_payload=build_payload,
            story_id=patch.story_id,
            save_source=AGENT_PATCH_SAVE_SOURCE,
        )
        story = self._story_after_save(patch.canvas_id, patch.story_id)
        return InteractiveStoryMutationResult(
            project_id=self.project_id,
            canvas_id=patch.canvas_id,
            story_id=story.story_id,
            revision=_saved_revision(saved),
            idempotent=saved.idempotent,
            issues=issues_for_story(story),
        )

    def validate(
        self,
        request: ValidateInteractiveStoryRequest,
    ) -> InteractiveStoryValidationResult:
        canvas = self._read_canvas(request.canvas_id, request.story_id)
        try:
            story = story_from_canvas(canvas, request.story_id)
        except (CanvasStoryMappingError, ValidationError, ValueError) as exc:
            issue = InteractiveStoryIssue(
                severity="error",
                code="invalid_story",
                message=str(exc),
                entity_type="story",
                entity_id=request.story_id,
            )
            revision = (
                canvas.get("revision") if isinstance(canvas.get("revision"), int) else 0
            )
            return InteractiveStoryValidationResult(
                canvas_id=request.canvas_id,
                story_id=request.story_id,
                revision=revision,
                valid=False,
                issues=[issue],
            )
        issues = issues_for_story(story)
        return InteractiveStoryValidationResult(
            canvas_id=request.canvas_id,
            story_id=request.story_id,
            revision=story.revision,
            valid=not any(issue.severity == "error" for issue in issues),
            issues=issues,
        )

    def save_outline(
        self, request: SaveStoryOutlineRequest
    ) -> InteractiveStoryOutlineSaveResult:
        """Upsert the canvas-level pending outline without touching nodes/edges."""

        def build_payload(existing: dict | None) -> dict:
            current = existing or {}
            if existing is None and request.base_revision != 0:
                raise canvas_store.CanvasRevisionConflict(
                    current_revision=0,
                    base_revision=request.base_revision,
                )
            metadata = _with_outline(
                current.get("metadata"),
                _next_outline_state(
                    _stored_outline(current.get("metadata")), request.outline
                ),
            )
            return self._canvas_payload(
                current,
                canvas_id=request.canvas_id,
                nodes=_dict_list(current.get("nodes")),
                edges=_dict_list(current.get("edges")),
                save_source=AGENT_OUTLINE_SAVE_SOURCE,
                metadata=metadata,
            )

        saved = self._save(
            canvas_id=request.canvas_id,
            base_revision=request.base_revision,
            idempotency_key=request.idempotency_key,
            request_payload=request.model_dump(mode="json"),
            build_payload=build_payload,
            story_id=request.outline.outline_id,
            save_source=AGENT_OUTLINE_SAVE_SOURCE,
        )
        return self._outline_result(
            request.canvas_id,
            _saved_revision(saved),
            idempotent=saved.idempotent,
        )

    def confirm_outline(
        self, request: ConfirmStoryOutlineRequest
    ) -> InteractiveStoryOutlineSaveResult:
        """Record the user's canvas-side confirmation; never rewrites outline content."""

        def build_payload(existing: dict | None) -> dict:
            current = existing or {}
            stored = _stored_outline(current.get("metadata"))
            if (
                existing is None
                or stored is None
                or stored.outline_id != request.outline_id
            ):
                raise InteractiveStoryServiceError(
                    "outline_not_found",
                    f"pending outline {request.outline_id!r} was not found",
                    story_id=request.outline_id,
                )
            metadata = _with_outline(
                current.get("metadata"),
                stored.model_copy(
                    update={
                        "status": request.status,
                        "updated_at": canvas_store.utc_now_iso(),
                    }
                ),
            )
            return self._canvas_payload(
                current,
                canvas_id=request.canvas_id,
                nodes=_dict_list(current.get("nodes")),
                edges=_dict_list(current.get("edges")),
                save_source=USER_OUTLINE_CONFIRM_SAVE_SOURCE,
                metadata=metadata,
            )

        saved = self._save(
            canvas_id=request.canvas_id,
            base_revision=request.base_revision,
            idempotency_key=request.idempotency_key,
            request_payload=request.model_dump(mode="json"),
            build_payload=build_payload,
            story_id=request.outline_id,
            save_source=USER_OUTLINE_CONFIRM_SAVE_SOURCE,
        )
        return self._outline_result(
            request.canvas_id,
            _saved_revision(saved),
            idempotent=saved.idempotent,
        )

    def get_outline(self, canvas_id: str) -> InteractiveStoryOutlineReadResult:
        try:
            canvas = canvas_store.read_canvas(self.project_dir, canvas_id)
        except (canvas_store.CanvasStoreError, OSError, ValueError) as exc:
            raise InteractiveStoryServiceError(
                "canvas_write_failed", str(exc)
            ) from exc
        if canvas is None:
            return InteractiveStoryOutlineReadResult(
                canvas_id=canvas_id, revision=0, outline=None
            )
        revision = canvas.get("revision") if isinstance(canvas.get("revision"), int) else 0
        return InteractiveStoryOutlineReadResult(
            canvas_id=canvas_id,
            revision=revision,
            outline=_stored_outline(canvas.get("metadata")),
        )

    def progress(self, canvas_id: str) -> InteractiveStoryProgressResult:
        """Read-only stage progress mirroring the frontend canvas nav.

        This read call writes nothing: statuses are re-derived from canvas
        artifacts and explicit stage confirmations on every call so the Agent
        gates production plans on the same evidence the user can see.
        """

        try:
            canvas = canvas_store.read_canvas(self.project_dir, canvas_id)
        except (canvas_store.CanvasStoreError, OSError, ValueError) as exc:
            raise InteractiveStoryServiceError(
                "canvas_write_failed", str(exc)
            ) from exc
        if canvas is None:
            canvas = {"nodes": [], "edges": []}
        revision = canvas.get("revision") if isinstance(canvas.get("revision"), int) else 0
        outline = _stored_outline(canvas.get("metadata"))
        group = find_first_story_group(canvas)
        lint_error_count = 0
        if group is not None:
            story_id = str((group.get("data") or {}).get("interactiveStoryId") or "")
            try:
                story = story_from_canvas(canvas, story_id)
            except (CanvasStoryMappingError, ValidationError, ValueError):
                # 故事结构已损坏到无法映射：至少计一个 error，与前端
                # lintStory 的 no_start/dangling 拒绝口径对齐。
                lint_error_count = 1
            else:
                lint_error_count = sum(
                    1
                    for issue in issues_for_story(story)
                    if issue.severity == "error"
                )
        evidence = collect_stage_evidence(
            canvas, outline, lint_error_count=lint_error_count, story_group=group
        )
        return build_progress_result(
            canvas_id=canvas_id, revision=revision, outline=outline, evidence=evidence
        )

    def confirm_stages(
        self, request: ConfirmInteractiveStoryStagesRequest
    ) -> InteractiveStoryStageConfirmationResult:
        """Persist or reopen explicit user confirmations for manual stages."""

        def build_payload(existing: dict | None) -> dict:
            if existing is None:
                raise InteractiveStoryServiceError(
                    "story_not_found",
                    f"story {request.story_id!r} was not found",
                    story_id=request.story_id,
                )
            group = find_story_group(existing, request.story_id)
            if group is None:
                raise InteractiveStoryServiceError(
                    "story_not_found",
                    f"story {request.story_id!r} was not found",
                    story_id=request.story_id,
                )
            group_id = str(group.get("id") or "")
            nodes: list[dict[str, Any]] = []
            for node in _dict_list(existing.get("nodes")):
                if str(node.get("id") or "") != group_id:
                    nodes.append(node)
                    continue
                updated = dict(node)
                data = dict(updated.get("data") or {})
                raw = data.get("storyStageConfirmations")
                confirmations = dict(raw) if isinstance(raw, dict) else {}
                for stage in dict.fromkeys(request.stages):
                    if request.action == "confirm":
                        confirmations[stage] = {
                            "status": "confirmed",
                            "confirmedAt": canvas_store.utc_now_iso(),
                            "confirmedBy": self.actor_id,
                        }
                    else:
                        confirmations.pop(stage, None)
                data["storyStageConfirmations"] = confirmations
                updated["data"] = data
                nodes.append(updated)
            return self._canvas_payload(
                existing,
                canvas_id=request.canvas_id,
                nodes=nodes,
                edges=_dict_list(existing.get("edges")),
                save_source=AGENT_STAGE_CONFIRM_SAVE_SOURCE,
            )

        saved = self._save(
            canvas_id=request.canvas_id,
            base_revision=request.base_revision,
            idempotency_key=request.idempotency_key,
            request_payload=request.model_dump(mode="json"),
            build_payload=build_payload,
            story_id=request.story_id,
            save_source=AGENT_STAGE_CONFIRM_SAVE_SOURCE,
        )
        canvas = self._read_canvas(request.canvas_id, request.story_id)
        group = find_story_group(canvas, request.story_id)
        return InteractiveStoryStageConfirmationResult(
            project_id=self.project_id,
            canvas_id=request.canvas_id,
            story_id=request.story_id,
            revision=_saved_revision(saved),
            confirmed_stages=confirmed_manual_stages(group),
            idempotent=saved.idempotent,
        )

    def _outline_result(
        self, canvas_id: str, revision: int, *, idempotent: bool
    ) -> InteractiveStoryOutlineSaveResult:
        try:
            canvas = canvas_store.read_canvas(self.project_dir, canvas_id)
        except (canvas_store.CanvasStoreError, OSError, ValueError) as exc:
            raise InteractiveStoryServiceError(
                "canvas_write_failed", str(exc)
            ) from exc
        outline = _stored_outline((canvas or {}).get("metadata"))
        if outline is None:
            raise InteractiveStoryServiceError(
                "canvas_write_failed", "outline missing after canvas save"
            )
        return InteractiveStoryOutlineSaveResult(
            project_id=self.project_id,
            canvas_id=canvas_id,
            outline_id=outline.outline_id,
            status=outline.status,
            revision=revision,
            idempotent=idempotent,
        )

    def _save(
        self,
        *,
        canvas_id: str,
        base_revision: int,
        idempotency_key: str,
        request_payload: dict[str, Any],
        build_payload: Any,
        story_id: str,
        save_source: str,
    ) -> canvas_store.CanvasSaveResult:
        try:
            return canvas_store.save_canvas(
                self.project_dir,
                canvas_id,
                base_revision=base_revision,
                build_payload=build_payload,
                client_save_id=idempotency_key,
                request_hash=canvas_store.canvas_request_hash(request_payload),
                save_source=save_source,
            )
        except InteractiveStoryServiceError:
            raise
        except canvas_store.CanvasRevisionConflict as exc:
            raise InteractiveStoryServiceError(
                "revision_conflict",
                "canvas revision conflict",
                story_id=story_id,
                current_revision=exc.current_revision,
            ) from exc
        except canvas_store.CanvasIdempotencyConflict as exc:
            raise InteractiveStoryServiceError(
                "idempotency_conflict",
                "idempotency key was reused for a different request",
                story_id=story_id,
            ) from exc
        except (canvas_store.CanvasStoreError, CanvasLockBusy, OSError) as exc:
            raise InteractiveStoryServiceError(
                "canvas_write_failed",
                str(exc),
                story_id=story_id,
            ) from exc
        except (CanvasStoryMappingError, ValidationError, ValueError) as exc:
            raise InteractiveStoryServiceError(
                "invalid_story",
                str(exc),
                story_id=story_id,
            ) from exc

    def _read_canvas(self, canvas_id: str, story_id: str) -> dict[str, Any]:
        try:
            canvas = canvas_store.read_canvas(self.project_dir, canvas_id)
        except (canvas_store.CanvasStoreError, OSError, ValueError) as exc:
            raise InteractiveStoryServiceError(
                "canvas_write_failed",
                str(exc),
                story_id=story_id,
            ) from exc
        if canvas is None:
            raise InteractiveStoryServiceError(
                "story_not_found",
                f"story {story_id!r} was not found",
                story_id=story_id,
            )
        return canvas

    def _map_story(self, canvas: dict[str, Any], story_id: str) -> StoryDraftV2:
        try:
            story_group = find_story_group(canvas, story_id)
        except CanvasStoryMappingError as exc:
            raise InteractiveStoryServiceError(
                "invalid_story", str(exc), story_id=story_id
            ) from exc
        if story_group is None:
            raise InteractiveStoryServiceError(
                "story_not_found",
                f"story {story_id!r} was not found",
                story_id=story_id,
            )
        try:
            return story_from_canvas(canvas, story_id)
        except CanvasStoryMappingError as exc:
            raise InteractiveStoryServiceError(
                "invalid_story", str(exc), story_id=story_id
            ) from exc
        except (ValidationError, ValueError) as exc:
            raise InteractiveStoryServiceError(
                "invalid_story",
                str(exc),
                story_id=story_id,
            ) from exc

    def _story_after_save(self, canvas_id: str, story_id: str) -> StoryDraftV2:
        return self._map_story(self._read_canvas(canvas_id, story_id), story_id)

    def _canvas_payload(
        self,
        existing: dict[str, Any],
        *,
        canvas_id: str,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        save_source: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = canvas_store.utc_now_iso()
        current_revision = (
            existing.get("revision") if isinstance(existing.get("revision"), int) else 0
        )
        payload = dict(existing)
        payload.update(
            {
                "schema_version": 2,
                "canvas_id": canvas_id,
                "project_id": existing.get("project_id") or self.project_id,
                "canvas_scope": existing.get("canvas_scope") or "default",
                "revision": current_revision + 1,
                "nodes": nodes,
                "edges": edges,
                "viewport": existing.get("viewport"),
                "metadata": (
                    metadata if metadata is not None else existing.get("metadata")
                ),
                "owner_principal_type": existing.get("owner_principal_type") or "user",
                "owner_principal_id": existing.get("owner_principal_id")
                or self.actor_id,
                "access_model": existing.get("access_model") or "project_role",
                "min_project_role": existing.get("min_project_role") or "editor",
                "created_by": existing.get("created_by") or self.actor_id,
                "created_at": existing.get("created_at") or now,
                "updated_by": self.actor_id,
                "updated_at": now,
                "save_source": save_source,
            }
        )
        return payload


def apply_story_patch(story: StoryDraftV2, patch: StoryPatchV2) -> StoryDraftV2:
    """Apply typed operations in order and validate the complete resulting graph."""

    if story.story_id != patch.story_id:
        raise ValueError("patch story_id does not match loaded story")
    if story.revision != patch.base_revision:
        raise canvas_store.CanvasRevisionConflict(
            current_revision=story.revision,
            base_revision=patch.base_revision,
        )

    title = story.title
    synopsis = story.synopsis
    start_segment_id = story.start_segment_id
    characters = list(story.characters)
    variables = list(story.variables)
    flags = list(story.flags)
    segments = list(story.segments)
    choices = list(story.choices)

    for operation in patch.operations:
        if isinstance(operation, UpdateStoryMetadata):
            changes = operation.changes.model_dump(exclude_unset=True)
            title = changes.get("title", title)
            synopsis = changes.get("synopsis", synopsis)
        elif isinstance(operation, SetStoryStart):
            start_segment_id = operation.segment_id
        elif isinstance(operation, AddStorySegment):
            if any(item.id == operation.segment.id for item in segments):
                raise ValueError(f"segment {operation.segment.id!r} already exists")
            segments.append(operation.segment)
        elif isinstance(operation, UpdateStorySegment):
            index = _index_by(segments, "id", operation.segment_id, "segment")
            changes = operation.changes.model_dump(exclude_unset=True)
            if "media" in changes and changes["media"] is None:
                changes["media"] = StoryMediaRef().model_dump()
            merged = {
                **segments[index].model_dump(),
                **changes,
            }
            segments[index] = StorySegment.model_validate(merged)
        elif isinstance(operation, RemoveStorySegment):
            index = _index_by(segments, "id", operation.segment_id, "segment")
            segments.pop(index)
            choices = [
                choice
                for choice in choices
                if choice.source_segment_id != operation.segment_id
                and choice.target_segment_id != operation.segment_id
            ]
        elif isinstance(operation, AddStoryChoice):
            if any(item.id == operation.choice.id for item in choices):
                raise ValueError(f"choice {operation.choice.id!r} already exists")
            choices.append(operation.choice)
        elif isinstance(operation, UpdateStoryChoice):
            index = _index_by(choices, "id", operation.choice_id, "choice")
            merged = {
                **choices[index].model_dump(),
                **operation.changes.model_dump(exclude_unset=True),
            }
            choices[index] = StoryChoice.model_validate(merged)
        elif isinstance(operation, RemoveStoryChoice):
            index = _index_by(choices, "id", operation.choice_id, "choice")
            choices.pop(index)
        elif isinstance(operation, UpsertStoryVariable):
            variables = _upsert(
                variables, "name", operation.variable.name, operation.variable
            )
        elif isinstance(operation, RemoveStoryVariable):
            index = _index_by(variables, "name", operation.variable_name, "variable")
            variables.pop(index)
        elif isinstance(operation, UpsertStoryFlag):
            flags = _upsert(flags, "name", operation.flag.name, operation.flag)
        elif isinstance(operation, RemoveStoryFlag):
            index = _index_by(flags, "name", operation.flag_name, "flag")
            flags.pop(index)
        elif isinstance(operation, UpsertStoryCharacter):
            characters = _upsert(
                characters, "id", operation.character.id, operation.character
            )
        elif isinstance(operation, RemoveStoryCharacter):
            index = _index_by(characters, "id", operation.character_id, "character")
            characters.pop(index)

    return StoryDraftV2(
        story_id=story.story_id,
        revision=patch.base_revision + 1,
        title=title,
        synopsis=synopsis,
        start_segment_id=start_segment_id,
        characters=characters,
        variables=variables,
        flags=flags,
        segments=segments,
        choices=choices,
    )


def issues_for_story(story: StoryDraftV2) -> list[InteractiveStoryIssue]:
    outgoing: dict[str, list[str]] = {}
    choices_by_source: dict[str, list[StoryChoice]] = {}
    for choice in story.choices:
        outgoing.setdefault(choice.source_segment_id, []).append(
            choice.target_segment_id
        )
        choices_by_source.setdefault(choice.source_segment_id, []).append(choice)
    reached: set[str] = set()
    queue = [story.start_segment_id]
    while queue:
        segment_id = queue.pop(0)
        if segment_id in reached:
            continue
        reached.add(segment_id)
        queue.extend(outgoing.get(segment_id, []))

    issues: list[InteractiveStoryIssue] = []
    for segment in story.segments:
        if segment.id not in reached:
            issues.append(
                InteractiveStoryIssue(
                    severity="warning",
                    code="unreachable",
                    message="剧情节点从开始节点不可达。",
                    entity_type="segment",
                    entity_id=segment.id,
                )
            )
        if not (segment.media.url or segment.media.asset_id):
            issues.append(
                InteractiveStoryIssue(
                    severity="warning",
                    code="missing_video",
                    message="节点尚未绑定视频，将使用占位卡试玩。",
                    entity_type="segment",
                    entity_id=segment.id,
                )
            )
        elif (
            segment.media.status == "ready"
            and segment.media.asset_id
            and not segment.media.url
        ):
            issues.append(
                InteractiveStoryIssue(
                    severity="warning",
                    code="media_url_unresolved",
                    message="节点已绑定素材，但尚未解析为播放器可用的视频地址。",
                    entity_type="segment",
                    entity_id=segment.id,
                )
            )
        source_choices = choices_by_source.get(segment.id, [])
        automatic = sorted(
            (choice for choice in source_choices if choice.mode == "automatic"),
            key=lambda choice: choice.order,
        )
        visible = [choice for choice in source_choices if choice.mode == "visible"]
        fallbacks = [choice for choice in automatic if choice.condition is None]
        if automatic and not fallbacks and not visible:
            issues.append(
                InteractiveStoryIssue(
                    severity="warning",
                    code="automatic_no_fallback",
                    message="自动分支没有兜底路径，条件都不满足时剧情会停止。",
                    entity_type="segment",
                    entity_id=segment.id,
                )
            )
        for index, choice in enumerate(automatic):
            if choice.condition is None and (
                index != len(automatic) - 1 or len(fallbacks) > 1 or visible
            ):
                issues.append(
                    InteractiveStoryIssue(
                        severity="error",
                        code="automatic_fallback_order",
                        message="无条件自动分支必须是该节点最后且唯一的兜底路径。",
                        entity_type="choice",
                        entity_id=choice.id,
                    )
                )
        if (
            segment.choice_time_limit_sec is not None
            and visible
            and not any(choice.is_default for choice in visible)
        ):
            issues.append(
                InteractiveStoryIssue(
                    severity="warning",
                    code="timed_choice_uses_first_default",
                    message="限时节点未指定默认选项，超时将选择第一个可用选项。",
                    entity_type="segment",
                    entity_id=segment.id,
                )
            )
        if segment.kind == "scene" and segment.id not in outgoing:
            issues.append(
                InteractiveStoryIssue(
                    severity="info",
                    code="leaf_no_ending",
                    message="叶子节点尚未标记为结局。",
                    entity_type="segment",
                    entity_id=segment.id,
                )
            )
    issues.extend(analyze_story_paths(story))
    severity_order = {"error": 0, "warning": 1, "info": 2}
    return sorted(issues, key=lambda issue: severity_order[issue.severity])


def _stored_outline(metadata: Any) -> PendingStoryOutline | None:
    """Parse the pending outline slot; unreadable content degrades to absent."""
    if not isinstance(metadata, dict):
        return None
    raw = metadata.get(PENDING_OUTLINE_METADATA_KEY)
    if not isinstance(raw, dict):
        return None
    try:
        return PendingStoryOutline.model_validate(raw)
    except ValidationError:
        return None


def _require_confirmed_outline_for_create(canvas: dict) -> None:
    """Hard gate on the formal-story create path.

    A canvas that carries a pending outline slot may only be created into
    once the user confirmed it on the plan card. This is enforced here (not
    just at the MCP tool entry) so no caller can bypass the confirmation.
    A missing slot stays permissive for outline-free direct creation; an
    unreadable slot fails closed because its confirmation cannot be proven.
    """
    metadata = canvas.get("metadata")
    if not isinstance(metadata, dict):
        return
    if metadata.get(PENDING_OUTLINE_METADATA_KEY) is None:
        return
    stored = _stored_outline(metadata)
    if stored is None or stored.status in {"pending", "needs_revision"}:
        raise InteractiveStoryServiceError(
            "outline_not_confirmed",
            "the canvas still carries a user-unconfirmed pending story outline"
            + (f" (status={stored.status!r})" if stored is not None else " (unreadable slot)")
            + "; ask the user to confirm it on the plan card before creating",
        )


def _with_outline(metadata: Any, outline: PendingStoryOutline) -> dict[str, Any]:
    """Return new metadata carrying only the outline slot changed."""
    merged = dict(metadata) if isinstance(metadata, dict) else {}
    merged[PENDING_OUTLINE_METADATA_KEY] = outline.model_dump(mode="json")
    return merged


def _next_outline_state(
    previous: PendingStoryOutline | None, incoming: PendingStoryOutline
) -> PendingStoryOutline:
    """Apply confirmation-reset rules to an agent-side outline write.

    An identical re-save keeps an existing confirmation (safe retries); any
    content change resets to pending because the user approved different text.
    Agents never persist confirmed/linked: those statuses belong to the canvas
    confirmation and the create-time link respectively.
    """
    now = canvas_store.utc_now_iso()
    if previous is not None and previous.outline_id == incoming.outline_id:
        content = {"exclude": {"status", "updated_at", "story_id"}}
        if previous.model_dump(mode="json", **content) == incoming.model_dump(
            mode="json", **content
        ) and previous.status in {"confirmed", "linked"}:
            return previous.model_copy(update={"updated_at": now})
    return incoming.model_copy(
        update={
            "status": (
                incoming.status
                if incoming.status in {"pending", "needs_revision"}
                else "pending"
            ),
            "story_id": None,
            "updated_at": now,
        }
    )


def _link_confirmed_outline(metadata: Any, story_id: str) -> dict[str, Any] | None:
    """Mark a confirmed outline as linked to the newly created story.

    Returns None when there is nothing to change so the create path keeps
    reusing the existing metadata untouched.
    """
    outline = _stored_outline(metadata)
    if outline is None or outline.status != "confirmed" or outline.story_id is not None:
        return None
    return _with_outline(
        metadata,
        outline.model_copy(
            update={
                "status": "linked",
                "story_id": story_id,
                "updated_at": canvas_store.utc_now_iso(),
            }
        ),
    )


def _ensure_projection_ids_available(
    canvas: dict[str, Any],
    projected_nodes: list[dict[str, Any]],
    projected_edges: list[dict[str, Any]],
) -> None:
    existing_node_ids = {
        str(node.get("id") or "") for node in _dict_list(canvas.get("nodes"))
    }
    existing_edge_ids = {
        str(edge.get("id") or "") for edge in _dict_list(canvas.get("edges"))
    }
    node_conflicts = existing_node_ids & {
        str(node.get("id") or "") for node in projected_nodes
    }
    edge_conflicts = existing_edge_ids & {
        str(edge.get("id") or "") for edge in projected_edges
    }
    if node_conflicts or edge_conflicts:
        conflicts = sorted(node_conflicts | edge_conflicts)
        raise InteractiveStoryServiceError(
            "story_id_conflict",
            f"story projection IDs conflict with existing canvas entities: {conflicts!r}",
        )


def _next_group_position(canvas: dict[str, Any]) -> dict[str, float]:
    right = 0.0
    for node in _dict_list(canvas.get("nodes")):
        if node.get("parentId"):
            continue
        position = (
            node.get("position") if isinstance(node.get("position"), dict) else {}
        )
        x = position.get("x") if isinstance(position.get("x"), int | float) else 0
        width = node.get("width") if isinstance(node.get("width"), int | float) else 320
        right = max(right, float(x) + float(width))
    return {"x": right + 200 if right else 0, "y": 0}


def _saved_revision(saved: canvas_store.CanvasSaveResult) -> int:
    source = (
        saved.response_cache
        if isinstance(saved.response_cache, dict)
        else saved.payload
    )
    revision = source.get("revision") if isinstance(source, dict) else None
    if not isinstance(revision, int):
        raise InteractiveStoryServiceError(
            "canvas_write_failed", "canvas save returned no revision"
        )
    return revision


def _index_by(items: list[Any], field: str, value: str, label: str) -> int:
    for index, item in enumerate(items):
        if getattr(item, field) == value:
            return index
    raise ValueError(f"{label} {value!r} was not found")


def _upsert(items: list[Any], field: str, value: str, replacement: Any) -> list[Any]:
    updated = list(items)
    for index, item in enumerate(updated):
        if getattr(item, field) == value:
            updated[index] = replacement
            return updated
    updated.append(replacement)
    return updated


def _dict_list(value: Any) -> list[dict[str, Any]]:
    return (
        [item for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )
