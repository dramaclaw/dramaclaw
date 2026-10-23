from __future__ import annotations

from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from fastapi import HTTPException

from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_external_inputs import resolve_external_inputs
from novelvideo.freezone.workflow_drafts import create_workflow_draft
from novelvideo.freezone.workflow_schema import (
    workflow_intent_json_schema,
    workflow_plan_json_schema,
)
from novelvideo.freezone.workflow_transactions import bind_workflow_inputs

SKILL = {
    "id": "ecommerce-ad",
    "version": "1",
    "allowed_recipe_ids": ["ecommerce-remix-image"],
    "input_parameters": [],
}
RECIPE = {
    "id": "ecommerce-remix-image",
    "version": "1",
    "output_kind": "image",
    "requires_source_media": True,
}
EXTERNAL = {"id": "cup", "node_id": "red-cup-source", "media_kind": "image"}


def _intent() -> dict:
    return {
        "schema_version": "freezone_workflow_intent.v1",
        "skill_id": "ecommerce-ad",
        "user_goal": "只引用红杯，保留杯形，改蓝色背景，不加字",
        "include_audio": False,
        "include_compose": False,
        "external_inputs": [deepcopy(EXTERNAL)],
        "items": [
            {
                "id": "red-cup-blue-bg-image",
                "title": "蓝底红杯",
                "prompt": "保留杯形，改蓝色背景，不加字",
                "recipe_id": "ecommerce-remix-image",
                "reference_inputs": ["cup"],
            }
        ],
    }


def _canvas(
    *, image_url: str = "/static/projects/project-a/red-cup.png", revision: int = 3
) -> dict:
    return {
        "project_id": "project-a",
        "canvas_id": "default",
        "revision": revision,
        "nodes": [
            {
                "id": "red-cup-source",
                "type": "uploadNode",
                "data": {
                    "imageUrl": image_url,
                    "displayName": "红杯原图",
                },
            },
            {
                "id": "distractor-source",
                "type": "uploadNode",
                "data": {
                    "imageUrl": "/static/projects/project-a/distractor.png",
                },
            },
        ],
    }


def test_existing_image_compiles_to_real_media_edge_without_copy(
    monkeypatch, tmp_path
) -> None:
    assert not list(
        Draft202012Validator(workflow_intent_json_schema()).iter_errors(_intent())
    )
    monkeypatch.setattr(catalog, "_load_skill", lambda _id: SKILL)
    monkeypatch.setattr(catalog, "_intent_recipe_index", lambda: {RECIPE["id"]: RECIPE})
    monkeypatch.setattr(catalog, "_load_skills", lambda: [SKILL])
    monkeypatch.setattr(catalog, "_load_agent_config_items", lambda *args: [RECIPE])
    result = catalog.compile_workflow_intent(_intent())
    assert result["ok"] is True, result.get("errors")
    assert not list(
        Draft202012Validator(workflow_plan_json_schema()).iter_errors(result["plan"])
    )
    binding = resolve_external_inputs(
        result["plan"], _canvas(), project_id="project-a"
    )
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent=_intent(),
        compiled={**result, "external_inputs_verified": binding},
    )
    assert draft["preview"]["external_inputs"] == [
        {
            "id": "cup",
            "node_id": "red-cup-source",
            "display_name": "红杯原图",
        }
    ]
    graph = build_workflow_graph_commands(
        {
            "plan": result["plan"],
            "external_node_ids": {"cup": binding["cup"]["node_id"]},
            "external_media_urls": {"cup": binding["cup"]["media_url"]},
            "run_after_create": True,
        }
    )
    assert graph["ok"] is True, graph.get("errors")
    commands = graph["commands"]
    target = next(
        command
        for command in commands
        if command.get("type") == "create_node"
        and command.get("data", {}).get("workflowPlanNodeId") == "red-cup-blue-bg-image"
    )
    assert target["data"]["workflowCatalog"]["skillId"] == "ecommerce-ad"
    assert target["data"]["workflowCatalog"]["recipeId"] == "ecommerce-remix-image"
    assert target["data"]["workflowCatalog"]["recipeVersion"] == "1"
    assert target["data"]["workflowCatalog"]["promptBuilder"]["planItem"]["prompt"] == (
        "保留杯形，改蓝色背景，不加字"
    )
    assert not any(
        command.get("type") == "create_node"
        and command.get("data", {}).get("workflowPlanNodeId") == "cup"
        for command in commands
    )
    assert [
        command
        for command in commands
        if command.get("type") == "create_edge"
        and command.get("link_type") == "media_input_for"
    ] == [
        {
            "type": "create_edge",
            "source": "red-cup-source",
            "target": "red-cup-blue-bg-image",
            "link_type": "media_input_for",
            "expected_source_image_url": "/static/projects/project-a/red-cup.png",
        }
    ]
    assert all(command.get("source") != "distractor-source" for command in commands)
    assert "red-cup-source" not in next(
        command["node_ids"] for command in commands if command["type"] == "run_workflow"
    )


@pytest.mark.parametrize(
    "change",
    [
        lambda canvas: canvas.update(revision=4),
        lambda canvas: canvas["nodes"].pop(0),
        lambda canvas: canvas["nodes"][0].update(type="textAnnotationNode"),
        lambda canvas: canvas["nodes"][0]["data"].update(
            imageUrl="/static/projects/project-a/new.png"
        ),
        lambda canvas: canvas["nodes"][0]["data"].update(imageUrl=None),
    ],
)
def test_external_image_change_fails_before_confirmation(change) -> None:
    plan = {"external_inputs": [EXTERNAL]}
    original = _canvas()
    binding = resolve_external_inputs(plan, original, project_id="project-a")
    changed = deepcopy(original)
    change(changed)
    with pytest.raises(ValueError):
        resolve_external_inputs(
            plan, changed, project_id="project-a", expected=binding
        )


def test_external_image_wrong_project_fails_closed() -> None:
    with pytest.raises(ValueError):
        resolve_external_inputs(
            {"external_inputs": [EXTERNAL]},
            _canvas(),
            project_id="project-b",
        )
    with pytest.raises(ValueError):
        resolve_external_inputs(
            {"external_inputs": [EXTERNAL]},
            _canvas(),
            project_id="project-a",
            canvas_id="other",
        )
    video = _canvas()
    video["nodes"][0]["data"]["videoUrl"] = "/static/projects/project-a/clip.mp4"
    with pytest.raises(ValueError, match='media_kind "video"'):
        resolve_external_inputs(
            {"external_inputs": [EXTERNAL]},
            video,
            project_id="project-a",
        )


@pytest.mark.parametrize(
    ("node_type", "media_field"),
    [
        ("imageGenNode", "referenceImageUrl"),
        ("uploadNode", "source_url"),
    ],
)
def test_uploaded_image_without_generated_output_is_external_input(
    node_type: str, media_field: str
) -> None:
    canvas = _canvas()
    source = canvas["nodes"][0]
    source["type"] = node_type
    source["data"][media_field] = source["data"].pop("imageUrl")
    binding = resolve_external_inputs(
        {"external_inputs": [EXTERNAL]}, canvas, project_id="project-a"
    )
    assert binding["cup"]["media_url"] == "/static/projects/project-a/red-cup.png"


def test_custom_plan_reference_binding_uses_external_alias() -> None:
    plan = {
        "nodes": [{"id": "result", "node_type": "imageGenNode", "data": {}}],
        "external_inputs": [EXTERNAL],
        "edges": [],
    }
    bound = bind_workflow_inputs(
        plan,
        [
            {
                "source": "cup",
                "target": "result",
                "usage": "reference",
            }
        ],
    )
    assert bound["edges"] == [
        {
            "source": "cup",
            "target": "result",
            "link_type": "media_input_for",
        }
    ]


@pytest.mark.asyncio
async def test_draft_route_rechecks_source_before_claim(monkeypatch) -> None:
    from novelvideo.api.routes import freezone

    canvas = _canvas()
    monkeypatch.setattr(freezone.canvas_store, "read_canvas", lambda *_: canvas)
    compiled = {"plan": {"external_inputs": [EXTERNAL]}}
    binding = await freezone._resolve_workflow_draft_external_inputs(
        compiled,
        state_dir=Path("/unused"),
        canvas_id="default",
        project_id="project-a",
    )
    canvas["revision"] += 1
    with pytest.raises(HTTPException) as error:
        await freezone._resolve_workflow_draft_external_inputs(
            compiled,
            state_dir=Path("/unused"),
            canvas_id="default",
            project_id="project-a",
            expected=binding,
            require_verified=True,
        )
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "workflow_external_input_unavailable"
    assert "tell the user" in error.value.detail["message"]


VIDEO_EXTERNAL = {"id": "camera", "node_id": "previz-recording", "media_kind": "video"}


def _video_canvas() -> dict:
    canvas = _canvas()
    canvas["nodes"].append(
        {
            "id": "previz-recording",
            "type": "videoNode",
            "data": {
                "videoUrl": "/static/projects/project-a/previz.mp4",
                "displayName": "预演台全局录制",
            },
        }
    )
    return canvas


def _video_plan(target_type: str = "videoNode") -> dict:
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "external_inputs": [deepcopy(VIDEO_EXTERNAL)],
        "nodes": [{"id": "shot", "node_type": target_type, "data": {}}],
        "edges": [
            {"source": "camera", "target": "shot", "link_type": "media_input_for"}
        ],
    }


@pytest.mark.parametrize(
    "node",
    [
        {"type": "videoNode", "data": {"videoUrl": "/static/projects/project-a/previz.mp4"}},
        {
            "type": "uploadNode",
            "data": {
                "videoUrl": "/static/projects/project-a/previz.mp4",
                "previewImageUrl": "/static/projects/project-a/poster.png",
            },
        },
    ],
)
def test_existing_video_resolves_as_external_input(node: dict) -> None:
    canvas = _canvas()
    canvas["nodes"].append({"id": "previz-recording", **node})
    binding = resolve_external_inputs(
        {"external_inputs": [VIDEO_EXTERNAL]}, canvas, project_id="project-a"
    )
    assert binding["camera"]["media_url"] == "/static/projects/project-a/previz.mp4"


def test_video_declared_as_image_names_the_right_media_kind() -> None:
    with pytest.raises(ValueError, match='media_kind "video"'):
        resolve_external_inputs(
            {"external_inputs": [{**VIDEO_EXTERNAL, "media_kind": "image"}]},
            _video_canvas(),
            project_id="project-a",
        )
    with pytest.raises(ValueError, match='media_kind "image"'):
        resolve_external_inputs(
            {"external_inputs": [{**EXTERNAL, "media_kind": "video"}]},
            _canvas(),
            project_id="project-a",
        )


def test_video_without_persistent_media_fails_closed() -> None:
    canvas = _video_canvas()
    canvas["nodes"][-1]["data"]["videoUrl"] = ""
    with pytest.raises(ValueError, match="no persistent media"):
        resolve_external_inputs(
            {"external_inputs": [VIDEO_EXTERNAL]}, canvas, project_id="project-a"
        )


def test_video_external_input_plan_emits_video_url_guard() -> None:
    from novelvideo.freezone.workflow_plan import validate_workflow_plan

    plan = _video_plan()
    assert not [
        error
        for error in Draft202012Validator(workflow_plan_json_schema()).iter_errors(plan)
        if "external_inputs" in error.absolute_path
    ]
    assert validate_workflow_plan(plan)["ok"] is True
    graph = build_workflow_graph_commands(
        {
            "plan": plan,
            "external_media_urls": {"camera": "/static/projects/project-a/previz.mp4"},
        }
    )
    assert graph["ok"] is True, graph.get("errors")
    assert [
        command for command in graph["commands"] if command["type"] == "create_edge"
    ] == [
        {
            "type": "create_edge",
            "source": "previz-recording",
            "target": "shot",
            "link_type": "media_input_for",
            "expected_source_video_url": "/static/projects/project-a/previz.mp4",
        }
    ]


def test_video_external_input_only_feeds_video_nodes() -> None:
    from novelvideo.freezone.workflow_plan import validate_workflow_plan

    errors = validate_workflow_plan(_video_plan("imageGenNode"))["errors"]
    assert any(
        "external video input can only reference a videoNode" in issue["message"]
        for issue in errors
    )


def test_custom_plan_binding_accepts_external_video() -> None:
    plan = {
        "nodes": [{"id": "shot", "node_type": "videoNode", "data": {}}],
        "external_inputs": [VIDEO_EXTERNAL],
        "edges": [],
    }
    bound = bind_workflow_inputs(
        plan, [{"source": "camera", "target": "shot", "usage": "reference"}]
    )
    assert bound["edges"] == [
        {"source": "camera", "target": "shot", "link_type": "media_input_for"}
    ]


def test_intent_accepts_external_video_kind() -> None:
    intent = _intent()
    intent["external_inputs"] = [{**VIDEO_EXTERNAL, "media_kind": "audio"}]
    result = catalog.compile_workflow_intent(intent)
    assert result["ok"] is False
    assert "media_kind must be image or video" in str(result)
    assert not list(
        Draft202012Validator(workflow_intent_json_schema()).iter_errors(
            {**_intent(), "external_inputs": [VIDEO_EXTERNAL]}
        )
    )
