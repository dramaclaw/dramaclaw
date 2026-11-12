"""Workflow draft refusals explain accepted arguments without sending HTTP requests."""

import asyncio
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp


RECORDED = {
    "answers": {
        "image_aspect_ratio": "1:1",
        "image_model": "recommended",
        "image_quality": "lowest",
        "image_resolution": "minimal",
        "image_variants_per_node": 1,
    },
    "clarification_id": "c7a8520a41b546e7af3e562947ef99f1",
    "context_key": "autumn-poem-image-plan-01",
    "generation_media_types": ["image"],
    "new_request": False,
    "target_node_ids": ["node_66c29299ce6441e6b6bca39070e678e6"],
}

ANSWER_SHAPES = [
    "string",
    "array of strings",
    "object with option_ids (array of strings), option_id (string), custom_text (string),"
    " customText (string)",
]


@pytest.fixture()
def workflow_agent(monkeypatch):
    for name, value in {
        "DRAMACLAW_API_URL": "http://testserver",
        "DRAMACLAW_AGENT_TOKEN": "token",
        "DRAMACLAW_PROJECT_ID": "demo",
        "DRAMACLAW_CANVAS_ID": "canvas-1",
        "DRAMACLAW_TOOL_MODE": "freezone_canvas",
    }.items():
        monkeypatch.setenv(name, value)

    plugin = dramaclaw_mcp._load_plugin("freezone")
    tool_index = dramaclaw_mcp._tool_index(plugin)
    requests = []

    def urlopen(request, *args, **kwargs):
        requests.append(request)
        raise AssertionError("Invalid tool arguments must not send an HTTP request")

    monkeypatch.setattr(plugin, "urlopen", urlopen)
    tools = {tool.name: tool for tool in dramaclaw_mcp.build_mcp_tools(tool_index)}

    def call(name, args):
        return asyncio.run(dramaclaw_mcp.call_tool(name, args, tool_index=tool_index))

    return SimpleNamespace(call=call, tools=tools, requests=requests)


def assert_refusal(agent, name, result, errors, example):
    assert agent.requests == []
    sc = result.structuredContent
    assert result.isError is True
    assert sc["ok"] is False
    assert sc["error"] == "tool_arguments_invalid"
    assert sc["status"] == "tool_arguments_invalid"
    assert sc["retryable"] is False
    assert sc["errors"] == errors
    assert sc["message"] == "; ".join(error["message"] for error in sc["errors"])
    assert sc["path"] == sc["errors"][0]["path"]
    assert sc["next_action"] == (
        "Fix the listed errors and call the tool once with corrected arguments."
    )
    assert "keep the user's real values" in sc["agent_instruction"]
    assert "Sending the same arguments again fails the same way." in sc["agent_instruction"]
    assert sc["example"] == example
    Draft202012Validator(agent.tools[name].inputSchema).validate(sc["example"])
    Draft202012Validator(agent.tools[name].outputSchema).validate(sc)
    text = json.loads(result.content[0].text)
    assert text["errors"] == sc["errors"]
    assert text["example"] == sc["example"]


def test_clarification_refusal_lists_accepted_answer_shapes(workflow_agent):
    name = "freezone_request_user_clarification"
    example = deepcopy(RECORDED)
    example["answers"]["image_variants_per_node"] = "1"
    result = workflow_agent.call(name, deepcopy(RECORDED))
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors=[{
            "path": "answers.image_variants_per_node",
            "problem": "invalid_value",
            "accepted": ANSWER_SHAPES,
            "example": "1",
            "message": "answers.image_variants_per_node: 1 is not accepted. Accepted: "
            + " | ".join(ANSWER_SHAPES) + '. Example: "1".',
        }],
        example=example,
    )


def test_confirm_refusal_lists_known_fields_for_an_unknown_argument(workflow_agent):
    name = "freezone_confirm_workflow_draft"
    result = workflow_agent.call(name, {"draft_id": "d1", "revision": 3, "run_after_create": True})
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors=[{
            "path": "run_after_create",
            "problem": "unknown_field",
            "accepted": ["project_id", "canvas_id", "draft_id", "revision"],
            "message": "run_after_create is not a known field. "
            "Known fields: project_id, canvas_id, draft_id, revision.",
        }],
        example={"draft_id": "d1", "revision": 3},
    )


def test_confirm_refusal_gives_the_missing_field_shape_and_example(workflow_agent):
    name = "freezone_confirm_workflow_draft"
    result = workflow_agent.call(name, {"draft_id": "d1"})
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors=[{
            "path": "revision",
            "problem": "missing_field",
            "accepted": ["integer"],
            "example": 1,
            "message": "revision is required. Accepted: integer. Example: 1.",
        }],
        example={"draft_id": "d1", "revision": 1},
    )


def test_refusal_reports_every_invalid_field_with_its_allowed_values(workflow_agent):
    name = "freezone_request_user_clarification"
    result = workflow_agent.call(name, {
        "generation_media_types": ["image"],
        "generation_preferences": {"image_variants_per_node": "2", "video_variants_per_node": 3},
    })
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors=[
            {
                "path": "generation_preferences.image_variants_per_node",
                "problem": "invalid_value",
                "accepted": ["one of 1, 2, 4"],
                "example": 2,
                "message": 'generation_preferences.image_variants_per_node: "2" is not accepted. '
                "Accepted: one of 1, 2, 4. Example: 2.",
            },
            {
                "path": "generation_preferences.video_variants_per_node",
                "problem": "invalid_value",
                "accepted": ["one of 1, 2, 4"],
                "example": 1,
                "message": "generation_preferences.video_variants_per_node: 3 is not accepted. "
                "Accepted: one of 1, 2, 4. Example: 1.",
            },
        ],
        example={
            "generation_media_types": ["image"],
            "generation_preferences": {"image_variants_per_node": 2, "video_variants_per_node": 1},
        },
    )
