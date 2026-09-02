"""Bidirectional mapping between StoryDraftV1 and the opaque canvas graph."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from novelvideo.interactive_story.models import (
    StoryCharacter,
    StoryChoice,
    StoryCondition,
    StoryConditionGroup,
    StoryDraftV1,
    StoryEffect,
    StoryMediaRef,
    StorySegment,
    StoryVariable,
    StoryVariableCondition,
    StoryVisitCondition,
)

GROUP_NODE_TYPE = "groupNode"
VIDEO_NODE_TYPE = "videoNode"
STORY_CHOICE_EDGE_TYPE = "storyChoiceEdge"
GROUP_PADDING = 60
CLIP_WIDTH = 460
CLIP_HEIGHT = 300
COLUMN_GAP = 160
ROW_GAP = 120
GROUP_COLOR = "#3b82f6"


class CanvasStoryMappingError(ValueError):
    """Raised when a canvas story group cannot be represented by StoryDraftV1."""


@dataclass(frozen=True)
class StoryCanvasProjection:
    group_id: str
    segment_node_ids: frozenset[str]
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]


def story_group_node_id(story_id: str) -> str:
    return f"story-{story_id}"


def story_segment_node_id(story_id: str, segment_id: str) -> str:
    return f"story-{story_id}-segment-{segment_id}"


def story_choice_edge_id(story_id: str, choice_id: str) -> str:
    return f"story-{story_id}-choice-{choice_id}"


def find_story_group(canvas: dict[str, Any], story_id: str) -> dict[str, Any] | None:
    matches = [
        node
        for node in _dict_list(canvas.get("nodes"))
        if node.get("type") == GROUP_NODE_TYPE
        and isinstance(node.get("data"), dict)
        and node["data"].get("storyGroup") is True
        and node["data"].get("interactiveStoryId") == story_id
    ]
    if len(matches) > 1:
        raise CanvasStoryMappingError(f"story {story_id!r} has more than one canvas group")
    return matches[0] if matches else None


def project_story_to_canvas(
    story: StoryDraftV1,
    *,
    existing_canvas: dict[str, Any] | None = None,
    group_position: dict[str, float] | None = None,
) -> StoryCanvasProjection:
    """Project a valid story to one group, video nodes, and choice edges.

    Existing story nodes are matched by domain metadata so manual layout and
    unrelated node data survive patch operations.
    """

    canvas = existing_canvas or {}
    existing_group = find_story_group(canvas, story.story_id)
    group_id = str(existing_group.get("id")) if existing_group else story_group_node_id(story.story_id)
    existing_nodes = _dict_list(canvas.get("nodes"))
    existing_edges = _dict_list(canvas.get("edges"))
    current_segments = {
        str(data["storySegmentId"]): node
        for node in existing_nodes
        if node.get("type") == VIDEO_NODE_TYPE
        and isinstance((data := node.get("data")), dict)
        and isinstance(data.get("storySegmentId"), str)
        and node.get("parentId") == group_id
    }
    current_segment_node_ids = {str(node.get("id") or "") for node in current_segments.values()}
    current_choices = {
        str(data["storyChoiceId"]): edge
        for edge in existing_edges
        if edge.get("type") == STORY_CHOICE_EDGE_TYPE
        and isinstance((data := edge.get("data")), dict)
        and isinstance(data.get("storyChoiceId"), str)
        and str(edge.get("source") or "") in current_segment_node_ids
    }

    segment_node_by_id = {
        segment.id: str(current_segments.get(segment.id, {}).get("id") or story_segment_node_id(story.story_id, segment.id))
        for segment in story.segments
    }
    computed_positions, computed_width, computed_height = _layout_story(story)
    nodes: list[dict[str, Any]] = []

    for segment in story.segments:
        current = current_segments.get(segment.id) or {}
        data = dict(current.get("data") or {})
        data.update(
            {
                "displayName": segment.title,
                "videoUrl": segment.media.url,
                "aspectRatio": data.get("aspectRatio") or "16:9",
                "narration": segment.script,
                "storySegmentId": segment.id,
                "storyCharacterIds": list(segment.character_ids),
                "storyProductionNotes": segment.production_notes,
                "storyMedia": segment.media.model_dump(exclude_none=True),
            }
        )
        _set_optional(data, "storyRole", "start" if segment.id == story.start_segment_id else None)
        _set_optional(data, "choiceTimeLimitSec", segment.choice_time_limit_sec)
        _set_optional(data, "endingLabel", segment.ending_label)
        node = {
            **current,
            "id": segment_node_by_id[segment.id],
            "type": VIDEO_NODE_TYPE,
            "parentId": group_id,
            "position": current.get("position") or computed_positions[segment.id],
            "width": current.get("width") or CLIP_WIDTH,
            "height": current.get("height") or CLIP_HEIGHT,
            "data": data,
        }
        nodes.append(node)

    group_data = dict((existing_group or {}).get("data") or {})
    group_data.update(
        {
            "label": story.title,
            "storyGroup": True,
            "interactiveStoryId": story.story_id,
            "interactiveStorySchemaVersion": story.schema_version,
            "storySynopsis": story.synopsis,
            "storyCharacters": [item.model_dump() for item in story.characters],
            "storyVariables": [
                {"name": item.name, "label": item.label, "initial": item.initial}
                for item in story.variables
            ],
            "storyVariableDefinitions": [item.model_dump(exclude_none=True) for item in story.variables],
            "backgroundColor": group_data.get("backgroundColor") or GROUP_COLOR,
        }
    )
    position = (existing_group or {}).get("position") or group_position or {"x": 0, "y": 0}
    group_node = {
        **(existing_group or {}),
        "id": group_id,
        "type": GROUP_NODE_TYPE,
        "position": position,
        "width": max(_number((existing_group or {}).get("width")), computed_width),
        "height": max(_number((existing_group or {}).get("height")), computed_height),
        "data": group_data,
    }

    edges: list[dict[str, Any]] = []
    for choice in story.choices:
        current = current_choices.get(choice.id) or {}
        data = dict(current.get("data") or {})
        data.update(
            {
                "storyChoiceId": choice.id,
                "choiceText": choice.text,
                "order": choice.order,
            }
        )
        _set_optional(
            data,
            "condition",
            _condition_to_canvas(choice.condition, segment_node_by_id) if choice.condition else None,
        )
        _set_optional(
            data,
            "effects",
            [{"var": effect.variable, "delta": effect.delta} for effect in choice.effects]
            if choice.effects
            else None,
        )
        _set_optional(data, "isDefault", True if choice.is_default else None)
        edges.append(
            {
                **current,
                "id": str(current.get("id") or story_choice_edge_id(story.story_id, choice.id)),
                "source": segment_node_by_id[choice.source_segment_id],
                "target": segment_node_by_id[choice.target_segment_id],
                "sourceHandle": current.get("sourceHandle") or "source",
                "targetHandle": current.get("targetHandle") or "target",
                "type": STORY_CHOICE_EDGE_TYPE,
                "data": data,
            }
        )

    return StoryCanvasProjection(
        group_id=group_id,
        segment_node_ids=frozenset(segment_node_by_id.values()),
        nodes=[group_node, *nodes],
        edges=edges,
    )


def story_from_canvas(canvas: dict[str, Any], story_id: str) -> StoryDraftV1:
    group = find_story_group(canvas, story_id)
    if group is None:
        raise CanvasStoryMappingError(f"story {story_id!r} was not found")
    group_id = str(group.get("id") or "")
    group_data = group.get("data") if isinstance(group.get("data"), dict) else {}
    segment_nodes = [
        node
        for node in _dict_list(canvas.get("nodes"))
        if node.get("type") == VIDEO_NODE_TYPE and node.get("parentId") == group_id
    ]
    if not segment_nodes:
        raise CanvasStoryMappingError(f"story {story_id!r} has no video segments")

    segment_id_by_node_id: dict[str, str] = {}
    segments: list[StorySegment] = []
    starts: list[str] = []
    for node in segment_nodes:
        node_id = str(node.get("id") or "")
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        segment_id = _domain_id(data.get("storySegmentId"), fallback=node_id, prefix="segment")
        if segment_id in segment_id_by_node_id.values():
            raise CanvasStoryMappingError(f"story {story_id!r} has duplicate segment id {segment_id!r}")
        segment_id_by_node_id[node_id] = segment_id
        if data.get("storyRole") == "start":
            starts.append(segment_id)
        media = _media_from_canvas(data)
        ending_label = _optional_text(data.get("endingLabel"))
        segments.append(
            StorySegment(
                id=segment_id,
                title=_required_text(data.get("displayName"), fallback=segment_id),
                script=_required_text(data.get("narration"), fallback="待补充剧情内容"),
                kind="ending" if ending_label else "scene",
                ending_label=ending_label,
                character_ids=_string_list(data.get("storyCharacterIds")),
                choice_time_limit_sec=_positive_int(data.get("choiceTimeLimitSec")),
                production_notes=str(data.get("storyProductionNotes") or ""),
                media=media,
            )
        )
    if len(starts) != 1:
        raise CanvasStoryMappingError(f"story {story_id!r} must have exactly one explicit start")

    choices: list[StoryChoice] = []
    for edge in _dict_list(canvas.get("edges")):
        if edge.get("type") != STORY_CHOICE_EDGE_TYPE:
            continue
        source_node_id = str(edge.get("source") or "")
        if source_node_id not in segment_id_by_node_id:
            continue
        target_node_id = str(edge.get("target") or "")
        if target_node_id not in segment_id_by_node_id:
            raise CanvasStoryMappingError(
                f"story choice {edge.get('id')!r} points outside story group"
            )
        data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
        choice_id = _domain_id(data.get("storyChoiceId"), fallback=str(edge.get("id") or ""), prefix="choice")
        choices.append(
            StoryChoice(
                id=choice_id,
                source_segment_id=segment_id_by_node_id[source_node_id],
                target_segment_id=segment_id_by_node_id[target_node_id],
                text=_required_text(data.get("choiceText"), fallback="继续"),
                order=max(0, int(data.get("order") or 0)),
                condition=_condition_from_canvas(data.get("condition"), segment_id_by_node_id),
                effects=[
                    StoryEffect(variable=str(effect.get("var") or ""), delta=int(effect.get("delta") or 0))
                    for effect in _dict_list(data.get("effects"))
                ],
                is_default=data.get("isDefault") is True,
            )
        )

    characters = [StoryCharacter.model_validate(item) for item in _dict_list(group_data.get("storyCharacters"))]
    variable_source = group_data.get("storyVariableDefinitions")
    if not isinstance(variable_source, list):
        variable_source = group_data.get("storyVariables")
    variables = [StoryVariable.model_validate(item) for item in _dict_list(variable_source)]
    revision = canvas.get("revision") if isinstance(canvas.get("revision"), int) else 0
    return StoryDraftV1(
        story_id=story_id,
        revision=revision,
        title=_required_text(group_data.get("label"), fallback=story_id),
        synopsis=str(group_data.get("storySynopsis") or ""),
        start_segment_id=starts[0],
        characters=characters,
        variables=variables,
        segments=segments,
        choices=choices,
    )


def story_graph_ids(canvas: dict[str, Any], story_id: str) -> tuple[set[str], set[str]]:
    """Return node and edge IDs owned by one story projection."""

    group = find_story_group(canvas, story_id)
    if group is None:
        return set(), set()
    group_id = str(group.get("id") or "")
    segment_ids = {
        str(node.get("id") or "")
        for node in _dict_list(canvas.get("nodes"))
        if node.get("type") == VIDEO_NODE_TYPE and node.get("parentId") == group_id
    }
    edge_ids = {
        str(edge.get("id") or "")
        for edge in _dict_list(canvas.get("edges"))
        if edge.get("type") == STORY_CHOICE_EDGE_TYPE
        and str(edge.get("source") or "") in segment_ids
    }
    return {group_id, *segment_ids}, edge_ids


def _layout_story(story: StoryDraftV1) -> tuple[dict[str, dict[str, float]], float, float]:
    outgoing: dict[str, list[str]] = {}
    for choice in sorted(story.choices, key=lambda item: (item.source_segment_id, item.order)):
        outgoing.setdefault(choice.source_segment_id, []).append(choice.target_segment_id)
    depths = {story.start_segment_id: 0}
    queue = [story.start_segment_id]
    while queue:
        source = queue.pop(0)
        for target in outgoing.get(source, []):
            if target in depths:
                continue
            depths[target] = depths[source] + 1
            queue.append(target)
    fallback_depth = max(depths.values(), default=-1) + 1
    for segment in story.segments:
        depths.setdefault(segment.id, fallback_depth)
    rows_by_depth: dict[int, list[str]] = {}
    for segment in story.segments:
        rows_by_depth.setdefault(depths[segment.id], []).append(segment.id)
    positions: dict[str, dict[str, float]] = {}
    for depth in sorted(rows_by_depth):
        for row, segment_id in enumerate(rows_by_depth[depth]):
            positions[segment_id] = {
                "x": GROUP_PADDING + depth * (CLIP_WIDTH + COLUMN_GAP),
                "y": GROUP_PADDING + row * (CLIP_HEIGHT + ROW_GAP),
            }
    width = max((position["x"] for position in positions.values()), default=0) + CLIP_WIDTH + GROUP_PADDING
    height = max((position["y"] for position in positions.values()), default=0) + CLIP_HEIGHT + GROUP_PADDING
    return positions, width, height


def _condition_to_canvas(
    condition: StoryCondition,
    segment_node_by_id: dict[str, str],
) -> dict[str, Any]:
    if isinstance(condition, StoryVariableCondition):
        return {"var": condition.variable, "op": condition.operator, "value": condition.value}
    if isinstance(condition, StoryVisitCondition):
        return {
            "visitedNodeId": segment_node_by_id[condition.segment_id],
            "op": condition.operator,
            "value": condition.value,
        }
    return {
        "join": condition.join,
        "items": [_condition_to_canvas(item, segment_node_by_id) for item in condition.items],
    }


def _condition_from_canvas(
    raw: Any,
    segment_id_by_node_id: dict[str, str],
) -> StoryCondition | None:
    if not isinstance(raw, dict):
        return None
    if "join" in raw:
        items = [
            item
            for value in raw.get("items") or []
            if (item := _condition_from_canvas(value, segment_id_by_node_id)) is not None
            and not isinstance(item, StoryConditionGroup)
        ]
        if not items:
            return None
        return StoryConditionGroup(join=raw.get("join"), items=items)
    if "visitedNodeId" in raw:
        node_id = str(raw.get("visitedNodeId") or "")
        if node_id not in segment_id_by_node_id:
            raise CanvasStoryMappingError(f"visit condition references unknown canvas node {node_id!r}")
        return StoryVisitCondition(
            segment_id=segment_id_by_node_id[node_id],
            operator=raw.get("op"),
            value=raw.get("value"),
        )
    return StoryVariableCondition(
        variable=raw.get("var"),
        operator=raw.get("op"),
        value=raw.get("value"),
    )


def _media_from_canvas(data: dict[str, Any]) -> StoryMediaRef:
    raw = data.get("storyMedia")
    media = StoryMediaRef.model_validate(raw) if isinstance(raw, dict) else StoryMediaRef()
    video_url = _optional_text(data.get("videoUrl"))
    if not video_url:
        return media
    if media.source == "placeholder":
        return StoryMediaRef(source="imported", status="ready", url=video_url, version=media.version)
    return StoryMediaRef(
        source=media.source,
        status="ready",
        asset_id=media.asset_id,
        url=video_url,
        version=media.version,
    )


def _domain_id(value: Any, *, fallback: str, prefix: str) -> str:
    candidate = str(value or fallback).strip()
    if candidate and candidate[0].isalnum() and all(char.isalnum() or char in "_-" for char in candidate):
        return candidate[:128]
    digest = hashlib.sha256(candidate.encode("utf-8")).hexdigest()[:20]
    return f"{prefix}_{digest}"


def _set_optional(data: dict[str, Any], key: str, value: Any) -> None:
    if value is None:
        data.pop(key, None)
    else:
        data[key] = value


def _dict_list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _string_list(value: Any) -> list[str]:
    return [str(item) for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _optional_text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _required_text(value: Any, *, fallback: str) -> str:
    return _optional_text(value) or fallback


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _number(value: Any) -> float:
    return float(value) if isinstance(value, int | float) else 0.0
