"""The interactive-story frame batch uses the existing WorkflowPlan pipeline."""

from __future__ import annotations

import pytest

from novelvideo.freezone.agent_workflows.catalog import (
    get_workflow_skill,
    validate_agent_workflow_plan,
)
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_external_inputs import resolve_external_image_inputs
from novelvideo.freezone.workflow_story_targets import validate_story_frame_targets


SKILL_ID = "text-to-image-video"


def _frame_node(segment_id: str) -> dict:
    return {
        "id": f"frame_{segment_id}",
        "node_type": "imageGenNode",
        "stage": "image",
        "data": {
            "displayName": f"分镜·{segment_id}",
            "prompt": f"为 {segment_id} 制作独立开场分镜图，保持产品外观一致。",
            "workflowCatalog": {
                "skillId": SKILL_ID,
                "recipeId": "general-image",
            },
        },
    }


def test_existing_workflow_skill_supports_story_frame_recipe() -> None:
    package = get_workflow_skill({"skill_id": SKILL_ID})

    assert package["ok"] is True
    assert "imageGenNode" in package["allowed_node_types"]
    assert "general-image" in [item["id"] for item in package["available_recipes"]]


def test_story_frames_compile_as_one_group_and_one_run() -> None:
    frame_ids = ["frame_opening", "frame_choice_a", "frame_ending"]
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": SKILL_ID},
        "title": "影游分镜图",
        "source_context": {
            "story_id": "story-1",
            "targets": [
                {
                    "plan_node_id": frame_id,
                    "story_segment_id": frame_id.removeprefix("frame_"),
                    "video_node_id": f"video-{frame_id}",
                }
                for frame_id in frame_ids
            ],
        },
        "external_inputs": [
            {"id": "product", "node_id": "product-image", "media_kind": "image"}
        ],
        "expected_node_count": 3,
        "expected_node_counts": {"imageGenNode": 3},
        "nodes": [_frame_node(segment_id) for segment_id in ("opening", "choice_a", "ending")],
        "edges": [
            {"source": "product", "target": frame_id, "link_type": "media_input_for"}
            for frame_id in frame_ids
        ],
        "group": {"label": "影游分镜图", "node_ids": frame_ids},
    }

    validated = validate_agent_workflow_plan(plan)
    assert validated["ok"] is True, validated
    assert validated["plan"]["source_context"] == plan["source_context"]

    binding = resolve_external_image_inputs(
        validated["plan"],
        {
            "project_id": "project-1",
            "canvas_id": "canvas-1",
            "revision": 2,
            "nodes": [
                {
                    "id": "product-image",
                    "type": "imageGenNode",
                    "data": {"imageUrl": "/static/projects/project-1/product.png"},
                }
            ],
        },
        project_id="project-1",
        canvas_id="canvas-1",
    )
    graph = build_workflow_graph_commands(
        {
            "plan": validated["plan"],
            "external_node_ids": {"product": binding["product"]["node_id"]},
            "external_media_urls": {"product": binding["product"]["media_url"]},
            "run_after_create": True,
        }
    )

    assert graph["ok"] is True, graph
    commands = graph["commands"]
    assert [item["type"] for item in commands].count("create_node") == 3
    assert [item["type"] for item in commands].count("group_nodes") == 1
    assert [item["type"] for item in commands].count("run_workflow") == 1
    assert not any(item.get("node_type") == "videoNode" for item in commands)
    group = next(item for item in commands if item["type"] == "group_nodes")
    assert group["node_ids"] == frame_ids
    run = next(item for item in commands if item["type"] == "run_workflow")
    assert run["node_ids"] == frame_ids
    assert [
        (item["source"], item["target"])
        for item in commands
        if item["type"] == "create_edge"
    ] == [("product-image", frame_id) for frame_id in frame_ids]
    assert {
        item["data"]["workflowPlanNodeId"]
        for item in commands
        if item["type"] == "create_node"
    } == set(frame_ids)
    assert {
        item["data"]["workflowPlanNodeId"]: item["data"]["storyFrameTarget"]
        for item in commands
        if item["type"] == "create_node"
    } == {
        frame_id: {
            "storyId": "story-1",
            "segmentId": frame_id.removeprefix("frame_"),
            "videoNodeId": f"video-{frame_id}",
            "referenceNodeIds": ["product-image"],
        }
        for frame_id in frame_ids
    }


def test_story_frames_without_reference_use_nonexecuting_input_root() -> None:
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": SKILL_ID},
        "nodes": [
            {
                "id": "brief",
                "node_type": "textAnnotationNode",
                "stage": "input",
                "data": {"content": "已确认的视觉简报"},
            },
            _frame_node("opening"),
            _frame_node("ending"),
        ],
        "edges": [
            {"source": "brief", "target": "frame_opening", "link_type": "prompt_for"},
            {"source": "brief", "target": "frame_ending", "link_type": "prompt_for"},
        ],
        "group": {
            "label": "影游分镜图",
            "node_ids": ["frame_opening", "frame_ending"],
        },
    }

    validated = validate_agent_workflow_plan(plan)
    assert validated["ok"] is True, validated
    graph = build_workflow_graph_commands(
        {"plan": validated["plan"], "run_after_create": True}
    )
    assert graph["ok"] is True, graph
    group = next(item for item in graph["commands"] if item["type"] == "group_nodes")
    assert group["node_ids"] == ["frame_opening", "frame_ending"]


def test_story_frame_targets_match_live_story_video_nodes() -> None:
    plan = {
        "source_context": {"story_id": "story-1", "targets": [
            {"plan_node_id": "frame_opening", "story_segment_id": "opening",
             "video_node_id": "video-opening"},
        ]},
        "nodes": [_frame_node("opening")],
    }
    canvas = {"nodes": [
        {"id": "story-group", "type": "groupNode", "data": {
            "storyGroup": True, "interactiveStoryId": "story-1"}},
        {"id": "video-opening", "type": "videoNode", "parentId": "story-group",
         "data": {"storySegmentId": "opening"}},
    ]}
    validate_story_frame_targets(plan, canvas)

    plan["source_context"]["targets"][0]["video_node_id"] = "video-missing"
    with pytest.raises(ValueError, match="video is unavailable"):
        validate_story_frame_targets(plan, canvas)
    plan["source_context"]["targets"][0]["video_node_id"] = "video-opening"
    canvas["nodes"][1]["data"]["storySegmentId"] = "other-segment"
    with pytest.raises(ValueError, match="no longer belongs"):
        validate_story_frame_targets(plan, canvas)


def test_story_frame_targets_require_every_generated_frame_to_be_mapped() -> None:
    plan = {
        "source_context": {"story_id": "story-1", "targets": [
            {"plan_node_id": "frame_opening", "story_segment_id": "opening",
             "video_node_id": "video-opening"},
        ]},
        "nodes": [_frame_node("opening"), _frame_node("ending")],
    }
    canvas = {"nodes": [
        {"id": "story-group", "type": "groupNode", "data": {
            "storyGroup": True, "interactiveStoryId": "story-1"}},
        {"id": "video-opening", "type": "videoNode", "parentId": "story-group",
         "data": {"storySegmentId": "opening"}},
    ]}
    with pytest.raises(ValueError, match="frame_ending"):
        validate_story_frame_targets(plan, canvas)
