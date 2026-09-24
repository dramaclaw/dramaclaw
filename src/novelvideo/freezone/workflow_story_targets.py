"""Validate declared storyboard destinations before a workflow can run.

The plan's source_context is authored by the caller. This is a conditional
consistency check for declared story-frame workflows, not a server-enforced
classification of every image workflow on a canvas that contains a story.
"""

from __future__ import annotations

from typing import Any


def validate_story_frame_targets(
    plan: dict[str, Any], canvas: dict[str, Any] | None
) -> None:
    """Require every image in a declared story-frame plan to target a live clip."""
    context = plan.get("source_context")
    if not isinstance(context, dict) or not ({"story_id", "targets"} & context.keys()):
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
    for target in targets:
        if not isinstance(target, dict):
            raise ValueError("story frame target must be an object")
        plan_id = target.get("plan_node_id")
        segment_id = target.get("story_segment_id")
        video_id = target.get("video_node_id")
        if not all(isinstance(value, str) and value.strip() for value in (
            plan_id, segment_id, video_id,
        )):
            raise ValueError("story frame target identifiers must be non-empty strings")
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
    if mapped_images != plan_images:
        missing = ", ".join(sorted(plan_images - mapped_images))
        raise ValueError(f"storyboard images missing story frame targets: {missing}")
