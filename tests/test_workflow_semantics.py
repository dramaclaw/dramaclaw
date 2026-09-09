from copy import deepcopy

import pytest

from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_plan import validate_workflow_plan


@pytest.mark.parametrize("field", ["semanticOutputRole", "ioRole"])
@pytest.mark.parametrize(
    "role,link,target,valid",
    [
        ("input_text", "context_for", "textAnnotationNode", False),
        ("planning_text", "prompt_for", "imageGenNode", False),
        ("context_text", "prompt_for", "audioNode", False),
        ("planning_text", "context_for", "textAnnotationNode", True),
        ("context_text", "context_for", "textAnnotationNode", True),
        ("input_text", "prompt_for", "imageGenNode", True),
        (None, "prompt_for", "videoNode", True),
        (None, "context_for", "textAnnotationNode", True),
    ],
)
def test_plan_and_compiler_agree_on_text_roles(field, role, link, target, valid):
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "nodes": [
            {
                "id": "source",
                "node_type": "textAnnotationNode",
                "stage": "input",
                "data": {
                    "title": "Source",
                    "content": "Source",
                    **({field: role} if role else {}),
                },
            },
            {
                "id": "target",
                "node_type": target,
                "stage": "input",
                "data": {"title": "Target", "content": "Target"},
            },
        ],
        "edges": [{"source": "source", "target": "target", "link_type": link}],
    }
    original = deepcopy(plan)
    validated = validate_workflow_plan(plan)
    compiled = build_workflow_graph_commands({"plan": plan})
    assert compiled["ok"] is valid, compiled
    if not valid:
        assert not validated["ok"]
        assert any("source role" in error["message"] for error in validated["errors"])
        assert compiled["commands"] == []
    else:
        node = compiled["commands"][0]
        assert node["data"].get(field) == role
    assert plan == original


def test_explicit_planning_prompt_bridge_compiles_without_changing_brief():
    plan = {
        "nodes": [
            {
                "id": "brief",
                "node_type": "textAnnotationNode",
                "data": {"semanticOutputRole": "planning_text"},
            },
            {
                "id": "prompt",
                "node_type": "textAnnotationNode",
                "data": {"semanticOutputRole": "input_text"},
            },
            {"id": "image", "node_type": "imageGenNode"},
        ],
        "edges": [
            {"source": "brief", "target": "prompt", "link_type": "context_for"},
            {"source": "prompt", "target": "image", "link_type": "prompt_for"},
        ],
    }
    result = build_workflow_graph_commands({"plan": plan})
    assert result["ok"]
    assert result["commands"][0]["data"]["semanticOutputRole"] == "planning_text"
    assert len([c for c in result["commands"] if c["type"] == "create_edge"]) == 2
