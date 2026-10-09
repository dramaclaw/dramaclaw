from __future__ import annotations

from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from fastapi import HTTPException

from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_external_inputs import resolve_external_image_inputs
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
    binding = resolve_external_image_inputs(
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
    binding = resolve_external_image_inputs(plan, original, project_id="project-a")
    changed = deepcopy(original)
    change(changed)
    with pytest.raises(ValueError):
        resolve_external_image_inputs(
            plan, changed, project_id="project-a", expected=binding
        )


def test_external_image_wrong_project_fails_closed() -> None:
    with pytest.raises(ValueError):
        resolve_external_image_inputs(
            {"external_inputs": [EXTERNAL]},
            _canvas(),
            project_id="project-b",
        )
    with pytest.raises(ValueError):
        resolve_external_image_inputs(
            {"external_inputs": [EXTERNAL]},
            _canvas(),
            project_id="project-a",
            canvas_id="other",
        )
    video = _canvas()
    video["nodes"][0]["data"]["videoUrl"] = "/static/projects/project-a/clip.mp4"
    with pytest.raises(ValueError, match="not an image"):
        resolve_external_image_inputs(
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
    binding = resolve_external_image_inputs(
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
