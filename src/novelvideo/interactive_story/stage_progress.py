"""Read-only derivation of creative-pipeline stage progress from canvas evidence.

Mirrors the frontend stage-D layer (``frontend/src/features/canvas/story/storyStages.ts``)
so the Agent sees the same progress the user sees on the canvas: statuses come
exclusively from verifiable canvas artifacts (outline metadata, story group,
segment narration/prompt/video, lint errors), never from stored progress.  This
module must not write anything and must not become a second source of truth.
"""

from __future__ import annotations

from typing import Any

from novelvideo.interactive_story.canvas_mapper import (
    GROUP_NODE_TYPE,
    STORY_CHOICE_EDGE_TYPE,
    VIDEO_NODE_TYPE,
)
from novelvideo.interactive_story.models import (
    InteractiveStoryProgressResult,
    InteractiveStoryStage,
    InteractiveStoryStageEvidence,
    ManualStoryStageId,
    PendingStoryOutline,
    StoryStageId,
    StoryStageStatus,
)

# 与前端 STORY_STAGE_ORDER 保持一致的阶段顺序；广告与影游共用同一套创作流水线。
STORY_STAGE_ORDER: tuple[StoryStageId, ...] = (
    "proposal",
    "outline",
    "script",
    "characters",
    "scenes",
    "storyboard",
    "video",
    "complete",
)

def find_first_story_group(canvas: dict[str, Any]) -> dict[str, Any] | None:
    """Return the first canvas group carrying an interactive story id.

    Matches the frontend nav projection, which picks the first group node with
    ``storyGroup === true`` and a non-empty ``interactiveStoryId``.
    """

    for node in canvas.get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") != GROUP_NODE_TYPE:
            continue
        data = node.get("data")
        if (
            isinstance(data, dict)
            and data.get("storyGroup") is True
            and str(data.get("interactiveStoryId") or "").strip()
        ):
            return node
    return None


def _member_segment_nodes(
    canvas: dict[str, Any], group_id: str
) -> list[dict[str, Any]]:
    return [
        node
        for node in canvas.get("nodes") or []
        if isinstance(node, dict)
        and node.get("type") == VIDEO_NODE_TYPE
        and str(node.get("parentId") or "") == group_id
    ]


def _non_empty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def confirmed_manual_stages(
    story_group: dict[str, Any] | None,
) -> list[ManualStoryStageId]:
    if story_group is None:
        return []
    data = story_group.get("data") if isinstance(story_group.get("data"), dict) else {}
    raw = data.get("storyStageConfirmations")
    if not isinstance(raw, dict):
        return []
    allowed: tuple[ManualStoryStageId, ...] = (
        "characters",
        "scenes",
        "storyboard",
        "complete",
    )
    return [
        stage
        for stage in allowed
        if isinstance(raw.get(stage), dict)
        and raw[stage].get("status") == "confirmed"
    ]


def collect_stage_evidence(
    canvas: dict[str, Any],
    outline: PendingStoryOutline | None,
    *,
    lint_error_count: int,
    story_group: dict[str, Any] | None,
) -> InteractiveStoryStageEvidence:
    """Count canvas artifacts the same way the frontend nav projection does."""

    segment_count = 0
    script_ready_count = 0
    prompt_ready_count = 0
    video_ready_count = 0
    synopsis_present = False
    character_count = 0
    has_story_group = story_group is not None
    lint_errors = lint_error_count
    if story_group is not None:
        group_id = str(story_group.get("id") or "")
        members = _member_segment_nodes(canvas, group_id)
        for node in members:
            segment_count += 1
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            # 与前端一致：videoUrl 只在实际素材落库后才有值，生成中不算就绪。
            if _non_empty_text(data.get("narration")):
                script_ready_count += 1
            if _non_empty_text(data.get("prompt")):
                prompt_ready_count += 1
            if data.get("videoUrl"):
                video_ready_count += 1
        group_data = (
            story_group.get("data") if isinstance(story_group.get("data"), dict) else {}
        )
        synopsis_present = _non_empty_text(group_data.get("storySynopsis"))
        characters = group_data.get("storyCharacters")
        character_count = len(characters) if isinstance(characters, list) else 0
        # 前端 lintStory 把组内选择边指向组外计为 dangling_edge error；故事映射
        # 失败时 service 已折算为 1，这里只补映射成功但边悬空的画布级情况。
        member_ids = {str(node.get("id") or "") for node in members}
        for edge in canvas.get("edges") or []:
            if (
                isinstance(edge, dict)
                and edge.get("type") == STORY_CHOICE_EDGE_TYPE
                and str(edge.get("source") or "") in member_ids
                and str(edge.get("target") or "") not in member_ids
            ):
                lint_errors += 1
    return InteractiveStoryStageEvidence(
        outline_status=outline.status if outline else None,
        outline_kind=outline.kind if outline else None,
        has_story_group=has_story_group,
        synopsis_present=synopsis_present,
        segment_count=segment_count,
        script_ready_count=script_ready_count,
        prompt_ready_count=prompt_ready_count,
        video_ready_count=video_ready_count,
        lint_error_count=lint_errors,
        character_count=character_count,
        confirmed_stages=confirmed_manual_stages(story_group),
    )


def _outline_approved(outline: PendingStoryOutline | None) -> bool:
    return outline is not None and outline.status in {"confirmed", "linked"}


def _stage(id: StoryStageId, status: StoryStageStatus) -> InteractiveStoryStage:
    return InteractiveStoryStage(id=id, status=status)


def _proposal_stage(
    evidence: InteractiveStoryStageEvidence, outline: PendingStoryOutline | None
) -> InteractiveStoryStage:
    if outline is None:
        return _stage("proposal", "todo")
    return _stage("proposal", "done" if _outline_approved(outline) else "active")


def _script_like_stage(
    id: StoryStageId, evidence: InteractiveStoryStageEvidence
) -> InteractiveStoryStage:
    if not evidence.has_story_group:
        return _stage(id, "todo")
    complete = (
        evidence.segment_count > 0
        and evidence.script_ready_count == evidence.segment_count
        and evidence.lint_error_count == 0
    )
    return _stage(id, "done" if complete else "active")


def _video_stage(evidence: InteractiveStoryStageEvidence) -> InteractiveStoryStage:
    if evidence.segment_count == 0:
        return _stage("video", "todo")
    if evidence.video_ready_count == evidence.segment_count:
        return _stage("video", "done")
    return _stage("video", "active" if evidence.video_ready_count > 0 else "todo")


def derive_stages(
    evidence: InteractiveStoryStageEvidence, outline: PendingStoryOutline | None
) -> list[InteractiveStoryStage]:
    """Port of the frontend ``deriveStoryStages`` decision table, verbatim."""

    stages: list[InteractiveStoryStage] = [_proposal_stage(evidence, outline)]

    approved = _outline_approved(outline)
    stages.append(
        _stage(
            "outline",
            "done"
            if approved or (evidence.has_story_group and evidence.synopsis_present)
            else "active"
            if outline is not None
            else "todo",
        )
    )
    stages.append(_script_like_stage("script", evidence))
    confirmed = set(evidence.confirmed_stages)
    # 这些阶段没有稳定的自动判据，只接受用户通过虾导作出的显式确认。
    if not evidence.has_story_group:
        stages.append(_stage("characters", "todo"))
    else:
        stages.append(
            _stage("characters", "done" if "characters" in confirmed else "manual")
        )
    stages.append(_stage("scenes", "done" if "scenes" in confirmed else "manual"))
    stages.append(
        _stage("storyboard", "done" if "storyboard" in confirmed else "manual")
    )
    stages.append(_video_stage(evidence))
    # 「完成」要求可试玩且交付项已验证，不等同于 Validate 通过。
    stages.append(_stage("complete", "done" if "complete" in confirmed else "manual"))
    return stages


def build_progress_result(
    *,
    canvas_id: str,
    revision: int,
    outline: PendingStoryOutline | None,
    evidence: InteractiveStoryStageEvidence,
) -> InteractiveStoryProgressResult:
    stages = derive_stages(evidence, outline)
    # 顺序优先：manual 也是尚未完成，不能越过它把后续「视频」误报为当前阶段。
    current = next((stage for stage in stages if stage.status != "done"), None)
    return InteractiveStoryProgressResult(
        canvas_id=canvas_id,
        revision=revision,
        kind=evidence.outline_kind or "story",
        stages=stages,
        current_stage_id=current.id if current else None,
        evidence=evidence,
    )
