"""Validate declared storyboard destinations before a workflow can run.

The plan's source_context is authored by the caller. This is a conditional
consistency check for declared story-frame workflows, not a server-enforced
classification of every image workflow on a canvas that contains a story.
"""

from __future__ import annotations

from typing import Any


def is_story_image_production_plan(plan: dict[str, Any]) -> bool:
    """Recognize a complete image batch targeting an already authored story.

    The saved story supplies planning and video destinations outside this
    graph. API draft creation, revision and claim still validate every target
    against the live canvas before admitting any generation task.
    """
    skill = plan.get("skill")
    context = plan.get("source_context")
    if (
        not isinstance(skill, dict)
        or skill.get("id") != "text-to-image-video"
        or not isinstance(context, dict)
        or not isinstance(context.get("story_id"), str)
        or not context["story_id"].strip()
    ):
        return False
    image_ids: set[str] = set()
    for node in plan.get("nodes") or []:
        if not isinstance(node, dict):
            return False
        node_type = node.get("node_type")
        if node_type == "imageGenNode":
            image_ids.add(node.get("id"))
            continue
        data = node.get("data") or {}
        catalog = data.get("workflowCatalog") or {}
        if (
            node_type != "textAnnotationNode"
            or (node.get("stage") or data.get("stage")) not in {"input", "resource", "asset"}
            or catalog.get("recipeId")
        ):
            return False
    mapped: set[str] = set()
    for field in ("targets", "asset_targets"):
        targets = context.get(field, [])
        if not isinstance(targets, list):
            return False
        for target in targets:
            if not isinstance(target, dict):
                return False
            node_id = target.get("plan_node_id")
            if node_id not in image_ids or node_id in mapped:
                return False
            mapped.add(node_id)
    return bool(image_ids) and mapped == image_ids


def validate_story_asset_targets(
    plan: dict[str, Any], canvas: dict[str, Any] | None
) -> None:
    """Check subject/scene image destinations against the saved story plan."""
    context = plan.get("source_context")
    if not isinstance(context, dict) or "asset_targets" not in context:
        return
    story_id = context.get("story_id")
    targets = context.get("asset_targets")
    if not isinstance(story_id, str) or not story_id.strip():
        raise ValueError("story asset targets require a story_id")
    if not isinstance(targets, list) or not targets:
        raise ValueError("story asset targets require a non-empty asset_targets list")
    if not isinstance(canvas, dict):
        raise ValueError("story asset target canvas is unavailable")
    nodes = {node.get("id"): node for node in canvas.get("nodes") or [] if isinstance(node, dict)}
    groups = [node for node in nodes.values() if node.get("type") == "groupNode"
              and isinstance(node.get("data"), dict)
              and node["data"].get("storyGroup") is True
              and node["data"].get("interactiveStoryId") == story_id]
    if len(groups) != 1:
        raise ValueError("story asset target story group is unavailable or ambiguous")
    group = groups[0]
    data = group["data"]
    subjects = {item.get("id") for item in data.get("storyCharacters") or [] if isinstance(item, dict)}
    scenes = {item.get("id") for item in data.get("storyScenes") or [] if isinstance(item, dict)}
    videos = {node.get("data", {}).get("storySegmentId"): node for node in nodes.values()
              if node.get("type") == "videoNode" and node.get("parentId") == group.get("id")
              and isinstance(node.get("data"), dict)}
    plan_images = {node.get("id") for node in plan.get("nodes") or []
                   if isinstance(node, dict) and node.get("node_type") == "imageGenNode"}
    mapped: set[str] = set()
    for index, target in enumerate(targets):
        prefix = f"source_context.asset_targets[{index}]"
        if not isinstance(target, dict):
            raise ValueError(f"{prefix} must be an object")
        plan_id = target.get("plan_node_id")
        kind = target.get("kind")
        entity_id = target.get("entity_id")
        segment_ids = target.get("segment_ids")
        if not all(isinstance(value, str) and value.strip() for value in (plan_id, entity_id)):
            raise ValueError(f"{prefix} requires non-empty plan_node_id and entity_id")
        if plan_id not in plan_images or plan_id in mapped:
            raise ValueError(f"{prefix} has an unknown or duplicate image: {plan_id}")
        if kind not in ("subject", "scene"):
            raise ValueError(f"{prefix}.kind must be subject or scene")
        if entity_id not in (subjects if kind == "subject" else scenes):
            raise ValueError(f"{prefix}.entity_id is absent from the story plan: {entity_id}")
        if (not isinstance(segment_ids, list) or not segment_ids
                or any(not isinstance(item, str) or not item.strip() for item in segment_ids)
                or len(segment_ids) != len(set(segment_ids))):
            raise ValueError(f"{prefix}.segment_ids must be a non-empty unique list")
        for segment_id in segment_ids:
            video = videos.get(segment_id)
            video_data = video.get("data") if isinstance(video, dict) else None
            if not isinstance(video_data, dict):
                raise ValueError(f"{prefix} refers to an unavailable story segment: {segment_id}")
            if kind == "subject" and entity_id not in (video_data.get("storyCharacterIds") or []):
                raise ValueError(f"{prefix} subject is not planned for segment {segment_id}")
            if kind == "scene" and entity_id not in {
                ref.get("scene_id") for ref in video_data.get("storySceneRefs") or []
                if isinstance(ref, dict)
            }:
                raise ValueError(f"{prefix} scene is not planned for segment {segment_id}")
        mapped.add(plan_id)
    frame_targets = context.get("targets") or []
    frame_ids = {item.get("plan_node_id") for item in frame_targets if isinstance(item, dict)}
    if mapped & frame_ids:
        raise ValueError("a story image cannot be both an asset and a storyboard frame")
    if mapped | frame_ids != plan_images:
        raise ValueError(f"story images missing asset targets: {sorted(plan_images - mapped - frame_ids)}")


def validate_story_frame_targets(
    plan: dict[str, Any], canvas: dict[str, Any] | None
) -> None:
    """Require every image in a declared story-frame plan to target a live clip."""
    context = plan.get("source_context")
    if not isinstance(context, dict) or (
        "targets" not in context and ("story_id" not in context or "asset_targets" in context)
    ):
        return

    story_id = context.get("story_id")
    targets = context.get("targets")
    if not isinstance(story_id, str) or not story_id.strip():
        raise ValueError("story frame targets require a story_id")
    if not isinstance(targets, list) or not targets:
        raise ValueError("story frame targets require a non-empty targets list")
    if not isinstance(canvas, dict):
        raise ValueError("story frame target canvas is unavailable")

    plan_images = {
        node.get("id")
        for node in plan.get("nodes") or []
        if isinstance(node, dict) and node.get("node_type") == "imageGenNode"
    }
    canvas_nodes = {
        node.get("id"): node
        for node in canvas.get("nodes") or []
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    mapped_images: set[str] = set()
    required_ids = ("plan_node_id", "story_segment_id", "video_node_id")
    for index, target in enumerate(targets):
        if not isinstance(target, dict):
            raise ValueError(f"source_context.targets[{index}] must be an object")
        invalid_ids = [
            key for key in required_ids
            if not isinstance(target.get(key), str) or not target[key].strip()
        ]
        if invalid_ids:
            raise ValueError(
                f"source_context.targets[{index}] has missing or empty identifiers: "
                f"{', '.join(invalid_ids)}; required keys: {', '.join(required_ids)}; "
                f"received keys: {', '.join(sorted(map(str, target)))}"
            )
        plan_id = target.get("plan_node_id")
        segment_id = target.get("story_segment_id")
        video_id = target.get("video_node_id")
        if plan_id not in plan_images or plan_id in mapped_images:
            raise ValueError(f"story frame target has an unknown or duplicate image: {plan_id}")
        mapped_images.add(plan_id)
        video = canvas_nodes.get(video_id)
        if not isinstance(video, dict) or video.get("type") != "videoNode":
            raise ValueError(f"story frame target video is unavailable: {video_id}")
        video_data = video.get("data")
        group = canvas_nodes.get(video.get("parentId"))
        group_data = group.get("data") if isinstance(group, dict) else None
        if (
            not isinstance(video_data, dict)
            or video_data.get("storySegmentId") != segment_id
            or not isinstance(group_data, dict)
            or group_data.get("storyGroup") is not True
            or group_data.get("interactiveStoryId") != story_id
        ):
            raise ValueError(f"story frame target no longer belongs to this story: {video_id}")
    asset_targets = context.get("asset_targets", [])
    if not isinstance(asset_targets, list):
        raise ValueError("source_context.asset_targets must be a list")
    asset_ids = {item.get("plan_node_id") for item in asset_targets
                 if isinstance(item, dict)}
    if mapped_images | asset_ids != plan_images:
        missing = ", ".join(sorted(plan_images - mapped_images - asset_ids))
        raise ValueError(f"storyboard images missing story frame targets: {missing}")
