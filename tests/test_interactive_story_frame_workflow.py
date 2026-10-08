"""The interactive-story frame batch uses the existing WorkflowPlan pipeline."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import re

import pytest
from jsonschema import Draft202012Validator

from novelvideo.freezone.agent_workflows.catalog import (
    get_workflow_skill,
    validate_agent_workflow_plan,
)
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_external_inputs import resolve_external_image_inputs
from novelvideo.freezone.workflow_schema import workflow_plan_json_schema
from novelvideo.freezone.workflow_story_targets import (
    is_story_image_production_plan,
    validate_story_asset_targets,
    validate_story_frame_targets,
)


@pytest.fixture
def reference_image_example() -> dict:
    guide = (
        Path(__file__).resolve().parents[1]
        / "src/novelvideo/agent_skills/interactive-story/references/reference-images.md"
    ).read_text(encoding="utf-8")
    return json.loads(re.findall(r"```json\n(.*?)\n```", guide, re.DOTALL)[0])


@pytest.fixture
def reference_image_canvas() -> dict:
    return {"nodes": [
        {"id": "story-group", "type": "groupNode", "data": {
            "storyGroup": True, "interactiveStoryId": "story-driving",
            "storyCharacters": [{"id": "driver"}, {"id": "vehicle"}],
            "storyScenes": [{"id": "cockpit"}],
        }},
        *({"id": f"video-{segment}", "type": "videoNode", "parentId": "story-group",
           "data": {"storySegmentId": segment, "storyCharacterIds": ["driver", "vehicle"],
                    "storySceneRefs": [{"scene_id": "cockpit", "usage": "setting"}]}}
          for segment in ("opening", "escape")),
    ]}


def test_documented_character_images_compile_without_planning_or_video(
    reference_image_example, reference_image_canvas,
) -> None:
    plan = reference_image_example
    Draft202012Validator(workflow_plan_json_schema()).validate(plan)
    package = get_workflow_skill({"skill_id": plan["skill"]["id"]})
    assert package["skill"]["version"] == plan["skill"]["version"]
    validated = validate_agent_workflow_plan(plan)
    assert validated["ok"] is True, validated
    assert not validated["preflight"]["blockers"], validated["preflight"]
    assert is_story_image_production_plan(validated["plan"])
    validate_story_asset_targets(validated["plan"], reference_image_canvas)
    validate_story_frame_targets(validated["plan"], reference_image_canvas)

    graph = build_workflow_graph_commands({"plan": validated["plan"], "run_after_create": True})
    assert graph["ok"] is True, graph
    created = [item for item in graph["commands"] if item["type"] == "create_node"]
    assert [item["node_type"] for item in created].count("imageGenNode") == 2
    assert all(item["node_type"] in {"imageGenNode", "textAnnotationNode"} for item in created)
    brief = next(item for item in created if item["node_type"] == "textAnnotationNode")
    assert not brief["data"].get("workflowCatalog", {}).get("recipeId")
    assert {item["data"]["workflowPlanNodeId"]: item["data"]["storyAssetTarget"]["entityId"]
            for item in created if item["node_type"] == "imageGenNode"} == {
        "driver_ref": "driver", "cockpit_ref": "vehicle",
    }
    runs = [item for item in graph["commands"] if item["type"] == "run_workflow"]
    assert len(runs) == 1
    assert runs[0]["direction"] == "node"
    assert set(runs[0]["node_ids"]) == {"brief", "driver_ref", "cockpit_ref"}


@pytest.mark.parametrize("mistake", ["missing", "duplicate_asset", "asset_and_frame"])
def test_character_image_mapping_repair_preserves_image_scope(
    reference_image_example, reference_image_canvas, mistake,
) -> None:
    original = reference_image_example
    plan = deepcopy(original)
    targets = plan["source_context"]["asset_targets"]
    if mistake == "missing":
        targets.pop()
    elif mistake == "duplicate_asset":
        targets.append({**targets[1], "kind": "scene", "entity_id": "cockpit"})
    else:
        plan["source_context"]["targets"] = [{
            "plan_node_id": "cockpit_ref", "story_segment_id": "opening",
            "video_node_id": "video-opening",
        }]
    assert not is_story_image_production_plan(plan)
    failed = validate_agent_workflow_plan(plan)
    assert {item["stage"] for item in failed["preflight"]["blockers"]
            if item["code"] == "skill_stage_missing"} == {"planning", "video"}
    with pytest.raises(ValueError):
        validate_story_asset_targets(plan, reference_image_canvas)

    # Repair only the mapping: the images, briefs, edges and groups stay intact.
    plan["source_context"] = deepcopy(original["source_context"])
    assert plan == original
    repaired = validate_agent_workflow_plan(plan)
    assert repaired["ok"] is True, repaired
    assert not repaired["preflight"]["blockers"], repaired["preflight"]
    validate_story_asset_targets(repaired["plan"], reference_image_canvas)


@pytest.mark.parametrize(("field", "value", "message"), [
    ("kind", "character", "kind must be subject or scene"),
    ("entity_id", "missing-driver", "absent from the story plan"),
    ("segment_ids", ["missing-segment"], "unavailable story segment"),
    ("segment_ids", ["opening", "opening"], "non-empty unique list"),
])
def test_character_image_example_requires_real_unique_story_assets(
    reference_image_example, reference_image_canvas, field, value, message,
) -> None:
    reference_image_example["source_context"]["asset_targets"][0][field] = value
    with pytest.raises(ValueError, match=message):
        validate_story_asset_targets(reference_image_example, reference_image_canvas)


def test_character_image_example_rejects_asset_not_used_in_segment(
    reference_image_example, reference_image_canvas,
) -> None:
    reference_image_canvas["nodes"][1]["data"]["storyCharacterIds"] = ["vehicle"]
    with pytest.raises(ValueError, match="subject is not planned for segment opening"):
        validate_story_asset_targets(reference_image_example, reference_image_canvas)


def test_reference_image_can_target_scene_when_that_is_its_only_use(
    reference_image_example, reference_image_canvas,
) -> None:
    plan = reference_image_example
    plan["source_context"]["asset_targets"][1].update(kind="scene", entity_id="cockpit")
    assert is_story_image_production_plan(plan)
    validate_story_asset_targets(plan, reference_image_canvas)
    reference_image_canvas["nodes"][1]["data"]["storySceneRefs"] = []
    with pytest.raises(ValueError, match="scene is not planned for segment opening"):
        validate_story_asset_targets(plan, reference_image_canvas)


def test_executable_planning_brief_does_not_qualify_as_story_image_batch(
    reference_image_example,
) -> None:
    plan = reference_image_example
    brief = plan["nodes"][0]
    brief["stage"] = "planning"
    brief["data"]["workflowCatalog"] = {
        "skillId": SKILL_ID, "recipeId": "general-text",
    }
    assert not is_story_image_production_plan(plan)
    validated = validate_agent_workflow_plan(plan)
    assert any(item["code"] == "skill_stage_missing" and item["stage"] == "video"
               for item in validated["preflight"]["blockers"])


def test_story_asset_targets_require_saved_plan_and_map_generated_image() -> None:
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": SKILL_ID},
        "title": "影游场景素材",
        "source_context": {"story_id": "story-1", "asset_targets": [{
            "plan_node_id": "scene_image", "kind": "scene", "entity_id": "street",
            "segment_ids": ["opening", "return"],
        }]},
        "expected_node_count": 1,
        "expected_node_counts": {"imageGenNode": 1},
        "nodes": [{**_frame_node("street"), "id": "scene_image"}],
        "edges": [],
        "group": {"label": "场景", "node_ids": ["scene_image"]},
    }
    canvas = {"nodes": [
        {"id": "group", "type": "groupNode", "data": {
            "storyGroup": True, "interactiveStoryId": "story-1",
            "storyCharacters": [{"id": "headphones", "kind": "product"}],
            "storyScenes": [{"id": "street"}],
        }},
        *({"id": f"video-{segment_id}", "type": "videoNode", "parentId": "group",
           "data": {"storySegmentId": segment_id, "storyCharacterIds": ["headphones"],
                    "storySceneRefs": [{"scene_id": "street", "usage": "setting"}]}}
          for segment_id in ("opening", "return")),
    ]}
    validated = validate_agent_workflow_plan(plan)
    assert validated["ok"] is True, validated
    assert not validated["preflight"]["blockers"], validated["preflight"]
    assert validated["plan"]["source_context"] == plan["source_context"]
    validate_story_asset_targets(validated["plan"], canvas)
    graph = build_workflow_graph_commands({"plan": validated["plan"]})
    assert graph["ok"] is True
    image = next(item for item in graph["commands"] if item["type"] == "create_node")
    assert image["data"]["storyAssetTarget"] == {
        "storyId": "story-1", "kind": "scene", "entityId": "street",
        "segmentIds": ["opening", "return"],
    }
    run_graph = build_workflow_graph_commands({"plan": validated["plan"], "run_after_create": True})
    assert next(item for item in run_graph["commands"] if item["type"] == "run_workflow")["direction"] == "node"
    canvas["nodes"][2]["data"]["storySceneRefs"] = []
    with pytest.raises(ValueError, match="not planned"):
        validate_story_asset_targets(plan, canvas)
    plan["source_context"]["asset_targets"][0]["kind"] = "subject"
    plan["source_context"]["asset_targets"][0]["entity_id"] = "headphones"
    validate_story_asset_targets(plan, canvas)


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


@pytest.mark.parametrize("mapping", ["absent", "story_id_only", "partial", "duplicate"])
def test_incomplete_story_mapping_keeps_standard_workflow_stage_gate(mapping) -> None:
    targets = [
        {"plan_node_id": f"frame_{segment}", "story_segment_id": segment,
         "video_node_id": f"video-{segment}"}
        for segment in ("opening", "ending")
    ]
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "skill": {"id": SKILL_ID},
        "nodes": [
            {"id": "brief", "node_type": "textAnnotationNode", "stage": "input",
             "data": {"content": "已确认的视觉简报"}},
            _frame_node("opening"), _frame_node("ending"),
        ],
        "edges": [
            {"source": "brief", "target": f"frame_{segment}", "link_type": "prompt_for"}
            for segment in ("opening", "ending")
        ],
    }
    if mapping != "absent":
        plan["source_context"] = {"story_id": "story-1"}
    if mapping == "partial":
        plan["source_context"]["targets"] = targets[:1]
    elif mapping == "duplicate":
        plan["source_context"]["targets"] = [*targets, targets[0]]

    validated = validate_agent_workflow_plan(plan)

    assert validated["ok"] is True, validated
    assert {item["stage"] for item in validated["preflight"]["blockers"]
            if item["code"] == "skill_stage_missing"} == {"planning", "video"}


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
    assert not validated["preflight"]["blockers"], validated["preflight"]
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
    assert run["direction"] == "node"
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


def test_story_frame_targets_report_incorrect_identifier_keys() -> None:
    plan = {
        "source_context": {"story_id": "story-1", "targets": [
            {"frame_id": "frame_opening", "segment_id": "opening",
             "video_node_id": "video-opening"},
        ]},
        "nodes": [_frame_node("opening")],
    }

    with pytest.raises(ValueError) as exc_info:
        validate_story_frame_targets(plan, {"nodes": []})

    message = str(exc_info.value)
    assert "source_context.targets[0]" in message
    assert "plan_node_id, story_segment_id" in message
    assert "required keys: plan_node_id, story_segment_id, video_node_id" in message
    assert "received keys: frame_id, segment_id, video_node_id" in message


def test_story_frame_targets_report_empty_identifier_at_target_index() -> None:
    plan = {
        "source_context": {"story_id": "story-1", "targets": [
            {"plan_node_id": "frame_opening", "story_segment_id": "opening",
             "video_node_id": "video-opening"},
            {"plan_node_id": "frame_ending", "story_segment_id": " ",
             "video_node_id": "video-ending"},
        ]},
        "nodes": [_frame_node("opening"), _frame_node("ending")],
    }
    canvas = {"nodes": [
        {"id": "story-group", "type": "groupNode", "data": {
            "storyGroup": True, "interactiveStoryId": "story-1"}},
        {"id": "video-opening", "type": "videoNode", "parentId": "story-group",
         "data": {"storySegmentId": "opening"}},
    ]}

    with pytest.raises(ValueError, match=r"source_context\.targets\[1\].*story_segment_id"):
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


def test_malformed_asset_targets_in_mixed_story_plan_raise_validation_error() -> None:
    plan = {
        "source_context": {
            "story_id": "story-1",
            "targets": [{"plan_node_id": "frame_opening", "story_segment_id": "opening",
                         "video_node_id": "video-opening"}],
            "asset_targets": 7,
        },
        "nodes": [_frame_node("opening")],
    }
    canvas = {"nodes": [
        {"id": "story-group", "type": "groupNode", "data": {
            "storyGroup": True, "interactiveStoryId": "story-1"}},
        {"id": "video-opening", "type": "videoNode", "parentId": "story-group",
         "data": {"storySegmentId": "opening"}},
    ]}
    with pytest.raises(ValueError, match="source_context.asset_targets must be a list"):
        validate_story_frame_targets(plan, canvas)
