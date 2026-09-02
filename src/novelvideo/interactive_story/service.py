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
    CreateInteractiveStoryRequest,
    GetInteractiveStoryRequest,
    InteractiveStoryError,
    InteractiveStoryIssue,
    InteractiveStoryMutationResult,
    InteractiveStoryReadResult,
    InteractiveStoryValidationResult,
    RemoveStoryCharacter,
    RemoveStoryChoice,
    RemoveStorySegment,
    RemoveStoryVariable,
    SetStoryStart,
    StoryChoice,
    StoryDraftV1,
    StoryMediaRef,
    StoryPatchV1,
    StorySegment,
    UpdateStoryChoice,
    UpdateStoryMetadata,
    UpdateStorySegment,
    UpsertStoryCharacter,
    UpsertStoryVariable,
    ValidateInteractiveStoryRequest,
)

AGENT_CREATE_SAVE_SOURCE = "agent_create"
AGENT_PATCH_SAVE_SOURCE = "agent_patch"


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
            if find_story_group(current, request.story.story_id) is not None:
                raise InteractiveStoryServiceError(
                    "story_already_exists",
                    f"story {request.story.story_id!r} already exists",
                    story_id=request.story.story_id,
                )
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
            return self._canvas_payload(
                current,
                canvas_id=request.canvas_id,
                nodes=nodes,
                edges=edges,
                save_source=AGENT_CREATE_SAVE_SOURCE,
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

    def patch(self, patch: StoryPatchV1) -> InteractiveStoryMutationResult:
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
            nodes = [
                node
                for node in _dict_list(existing.get("nodes"))
                if str(node.get("id") or "") not in owned_node_ids
            ]
            edges = [
                edge
                for edge in _dict_list(existing.get("edges"))
                if str(edge.get("id") or "") not in owned_edge_ids
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

    def _map_story(self, canvas: dict[str, Any], story_id: str) -> StoryDraftV1:
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

    def _story_after_save(self, canvas_id: str, story_id: str) -> StoryDraftV1:
        return self._map_story(self._read_canvas(canvas_id, story_id), story_id)

    def _canvas_payload(
        self,
        existing: dict[str, Any],
        *,
        canvas_id: str,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        save_source: str,
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
                "metadata": existing.get("metadata"),
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


def apply_story_patch(story: StoryDraftV1, patch: StoryPatchV1) -> StoryDraftV1:
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
        elif isinstance(operation, UpsertStoryCharacter):
            characters = _upsert(
                characters, "id", operation.character.id, operation.character
            )
        elif isinstance(operation, RemoveStoryCharacter):
            index = _index_by(characters, "id", operation.character_id, "character")
            characters.pop(index)

    return StoryDraftV1(
        story_id=story.story_id,
        revision=patch.base_revision + 1,
        title=title,
        synopsis=synopsis,
        start_segment_id=start_segment_id,
        characters=characters,
        variables=variables,
        segments=segments,
        choices=choices,
    )


def issues_for_story(story: StoryDraftV1) -> list[InteractiveStoryIssue]:
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
        if (
            segment.choice_time_limit_sec is not None
            and source_choices
            and not any(choice.is_default for choice in source_choices)
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
    severity_order = {"error": 0, "warning": 1, "info": 2}
    return sorted(issues, key=lambda issue: severity_order[issue.severity])


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
