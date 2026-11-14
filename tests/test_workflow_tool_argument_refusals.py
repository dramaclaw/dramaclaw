"""Workflow draft refusals explain accepted arguments without sending HTTP requests."""

import asyncio
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp, workflow_mcp


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


def assert_refusal(agent, name, result, errors, example, *, status="tool_arguments_invalid"):
    assert agent.requests == []
    sc = result.structuredContent
    assert result.isError is True
    assert sc["ok"] is False
    assert sc["error"] == "tool_arguments_invalid"
    assert sc["status"] == status
    assert sc["retryable"] is True
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
        errors=[
            {
                "path": "answers.image_variants_per_node",
                "problem": "invalid_value",
                "accepted": ANSWER_SHAPES,
                "example": "1",
                "message": "answers.image_variants_per_node: 1 is not accepted. Accepted: "
                + " | ".join(ANSWER_SHAPES)
                + '. Example: "1".',
            }
        ],
        example=example,
    )


def test_confirm_refusal_lists_known_fields_for_an_unknown_argument(workflow_agent):
    name = "freezone_confirm_workflow_draft"
    result = workflow_agent.call(name, {"draft_id": "d1", "revision": 3, "run_after_create": True})
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors=[
            {
                "path": "run_after_create",
                "problem": "unknown_field",
                "accepted": ["project_id", "canvas_id", "draft_id", "revision"],
                "message": "run_after_create: field is not allowed. "
                "Known fields: project_id, canvas_id, draft_id, revision.",
            }
        ],
        example={"draft_id": "d1", "revision": 3},
    )


def test_confirm_refusal_gives_the_missing_field_shape_and_example(workflow_agent):
    name = "freezone_confirm_workflow_draft"
    result = workflow_agent.call(name, {"draft_id": "d1"})
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors=[
            {
                "path": "revision",
                "problem": "missing_field",
                "accepted": ["integer"],
                "example": 1,
                "message": "revision: field is required. Accepted: integer. Example: 1.",
            }
        ],
        example={"draft_id": "d1", "revision": 1},
    )


def test_refusal_reports_every_invalid_field_with_its_allowed_values(workflow_agent):
    name = "freezone_request_user_clarification"
    result = workflow_agent.call(
        name,
        {
            "generation_media_types": ["image"],
            "generation_preferences": {
                "image_variants_per_node": "2",
                "video_variants_per_node": 3,
            },
        },
    )
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


PREPARE_CALLS = [
    {
        "draft_id": "wf-autumn-3node",
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
        "workflow": {
            "edges": [
                {"dependency_for": "execution", "from": "n1_text_autumn", "to": "n2_img_maple"},
                {"dependency_for": "execution", "from": "n1_text_autumn", "to": "n3_img_ginkgo"},
            ],
            "nodes": [
                {
                    "data": {
                        "purpose": "write a short poem of no more than 10 "
                        "characters about autumn as the image prompt",
                        "task": "text",
                    },
                    "id": "n1_text_autumn",
                    "type": "text",
                },
                {
                    "data": {
                        "count": 1,
                        "prompt_for": "n1_text_autumn",
                        "subject": "red maple leaves",
                    },
                    "id": "n2_img_maple",
                    "type": "image",
                },
                {
                    "data": {
                        "count": 1,
                        "prompt_for": "n1_text_autumn",
                        "subject": "ginkgo leaves",
                    },
                    "id": "n3_img_ginkgo",
                    "type": "image",
                },
            ],
            "run_after_create": True,
            "schema_version": "freezone_workflow_intent.v1",
        },
    },
    {
        "intent": {
            "edges": [
                {"dependency_for": "execution", "from": "n1_text_autumn", "to": "n2_img_maple"},
                {"dependency_for": "execution", "from": "n1_text_autumn", "to": "n3_img_ginkgo"},
            ],
            "nodes": [
                {
                    "data": {
                        "purpose": "write a short poem of no more than 10 "
                        "characters about autumn as the image prompt",
                        "task": "text",
                    },
                    "id": "n1_text_autumn",
                    "type": "text",
                },
                {
                    "data": {
                        "count": 1,
                        "prompt_for": "n1_text_autumn",
                        "subject": "red maple leaves",
                    },
                    "id": "n2_img_maple",
                    "type": "image",
                },
                {
                    "data": {
                        "count": 1,
                        "prompt_for": "n1_text_autumn",
                        "subject": "ginkgo leaves",
                    },
                    "id": "n3_img_ginkgo",
                    "type": "image",
                },
            ],
            "run_after_create": True,
            "schema_version": "freezone_workflow_intent.v1",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
    {
        "intent": {
            "inputs": {"image_aspect_ratio": "1:1", "image_variants_per_node": 1},
            "items": [
                {
                    "id": "n1_text_autumn",
                    "prompt": "write a short poem of no more than 10 characters about "
                    "autumn as the image prompt",
                    "task": "text",
                },
                {
                    "id": "n2_img_maple",
                    "prompt_for": "n1_text_autumn",
                    "subject": "red maple leaves",
                    "task": "image",
                },
                {
                    "id": "n3_img_ginkgo",
                    "prompt_for": "n1_text_autumn",
                    "subject": "ginkgo leaves",
                    "task": "image",
                },
            ],
            "run_after_create": True,
            "skill_id": "text-to-image",
            "user_goal": "build a three-node workflow on the canvas: one text node writes a "
            "short poem of no more than 10 characters about autumn as the "
            "image prompt; two image nodes both consume the text node's output "
            "as prompt, one draws red maple leaves and one draws ginkgo "
            "leaves, minimum resolution and lowest quality, 1 image each; "
            "nodes connected by dependency edges from the text node to both "
            "image nodes; no video or audio; run immediately after building",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
    {
        "intent": {
            "inputs": {"image_aspect_ratio": "1:1", "image_variants_per_node": 1},
            "items": [
                {
                    "recipe_id": "general-image",
                    "title": "n2_img_maple",
                    "subject": "red maple leaves",
                },
                {
                    "recipe_id": "general-image",
                    "title": "n3_img_ginkgo",
                    "subject": "ginkgo leaves",
                },
            ],
            "run_after_create": True,
            "skill_id": "text-to-image",
            "user_goal": "build a three-node workflow on the canvas: one text node writes a "
            "short poem of no more than 10 characters about autumn as the "
            "image prompt; two image nodes both consume the text node's output "
            "as prompt, one draws red maple leaves and one draws ginkgo "
            "leaves, minimum resolution and lowest quality, 1 image each; "
            "nodes connected by dependency edges from the text node to both "
            "image nodes; no video or audio; run immediately after building",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
    {
        "intent": {
            "inputs": {"image_aspect_ratio": "1:1", "image_variants_per_node": 1},
            "items": [
                {"id": "n2_img_maple", "recipe_id": "general-image", "title": "n2_img_maple"},
                {"id": "n3_img_ginkgo", "recipe_id": "general-image", "title": "n3_img_ginkgo"},
            ],
            "run_after_create": True,
            "skill_id": "text-to-image",
            "user_goal": "build a three-node workflow on the canvas: one text node writes a "
            "short poem of no more than 10 characters about autumn as the "
            "image prompt; two image nodes both consume the text node's output "
            "as prompt, one draws red maple leaves and one draws ginkgo "
            "leaves, minimum resolution and lowest quality, 1 image each; "
            "nodes connected by dependency edges from the text node to both "
            "image nodes; no video or audio; run immediately after building",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
]


PREPARE_ERRORS = [
    [
        {
            "path": "draft_id",
            "problem": "unknown_field",
            "accepted": [
                "project_id",
                "canvas_id",
                "intent",
                "plan",
                "generation_answers",
                "bindings",
                "operation_id",
                "run_after_create",
            ],
            "message": 'draft_id: field is not allowed. Known '
            'fields: project_id, canvas_id, intent, '
            "plan, generation_answers, bindings, operation_id, run_after_create.",
        },
        {
            "path": "workflow",
            "problem": "unknown_field",
            "accepted": [
                "project_id",
                "canvas_id",
                "intent",
                "plan",
                "generation_answers",
                "bindings",
                "operation_id",
                "run_after_create",
            ],
            "message": 'workflow: field is not allowed. Known '
            'fields: project_id, canvas_id, intent, '
            "plan, generation_answers, bindings, operation_id, run_after_create.",
        },
    ],
    [
        {
            "path": "intent.skill_id",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<skill_id>",
            "message": 'intent.skill_id: field is required. '
            'Accepted: string. Example: "<skill_id>".',
        },
        {
            "path": "intent.user_goal",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<user_goal>",
            "message": "intent.user_goal: field is required. Accepted: string. Example: "
            '"<user_goal>".',
        },
        {
            "path": "intent.edges",
            "problem": "unknown_field",
            "accepted": [
                "external_inputs",
                "schema_version",
                "skill_id",
                "user_goal",
                "title",
                "summary",
                "inputs",
                "planner",
                "items",
                "include_audio",
                "include_compose",
                "assumptions",
            ],
            "message": "intent.edges: field is not allowed. Known fields: external_inputs, "
            "schema_version, skill_id, user_goal, title, summary, inputs, planner, items, "
            "include_audio, include_compose, assumptions.",
        },
        {
            "path": "intent.nodes",
            "problem": "unknown_field",
            "accepted": [
                "external_inputs",
                "schema_version",
                "skill_id",
                "user_goal",
                "title",
                "summary",
                "inputs",
                "planner",
                "items",
                "include_audio",
                "include_compose",
                "assumptions",
            ],
            "message": "intent.nodes: field is not allowed. Known fields: external_inputs, "
            "schema_version, skill_id, user_goal, title, summary, inputs, planner, items, "
            "include_audio, include_compose, assumptions.",
        },
        {
            "path": "intent.run_after_create",
            "problem": "unknown_field",
            "accepted": [
                "external_inputs",
                "schema_version",
                "skill_id",
                "user_goal",
                "title",
                "summary",
                "inputs",
                "planner",
                "items",
                "include_audio",
                "include_compose",
                "assumptions",
            ],
            "message": 'intent.run_after_create: field is not '
            'allowed. Known fields: external_inputs, '
            "schema_version, skill_id, user_goal, title, summary, inputs, planner, items, "
            "include_audio, include_compose, assumptions. run_after_create is a field of "
            "the top-level arguments.",
        },
    ],
    [
        {
            "path": "intent.items[0].title",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<title>",
            "message": "intent.items[0].title: field is required. Accepted: string. Example: "
            '"<title>".',
        },
        {
            "path": "intent.items[0].recipe_id",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<recipe_id>",
            "message": "intent.items[0].recipe_id: field is required. Accepted: string. Example: "
            '"<recipe_id>".',
        },
        {
            "path": "intent.items[0].task",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": 'intent.items[0].task: field is not '
            'allowed. Known fields: id, title, prompt, '
            "narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.items[1].title",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<title>",
            "message": "intent.items[1].title: field is required. Accepted: string. Example: "
            '"<title>".',
        },
        {
            "path": "intent.items[1].recipe_id",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<recipe_id>",
            "message": "intent.items[1].recipe_id: field is required. Accepted: string. Example: "
            '"<recipe_id>".',
        },
        {
            "path": "intent.items[1].prompt_for",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": "intent.items[1].prompt_for: field is not allowed. Known fields: id, title, "
            "prompt, narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.items[1].subject",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": "intent.items[1].subject: field is not allowed. Known fields: id, title, "
            "prompt, narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.items[1].task",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": 'intent.items[1].task: field is not '
            'allowed. Known fields: id, title, prompt, '
            "narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.items[2].title",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<title>",
            "message": "intent.items[2].title: field is required. Accepted: string. Example: "
            '"<title>".',
        },
        {
            "path": "intent.items[2].recipe_id",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<recipe_id>",
            "message": "intent.items[2].recipe_id: field is required. Accepted: string. Example: "
            '"<recipe_id>".',
        },
        {
            "path": "intent.items[2].prompt_for",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": "intent.items[2].prompt_for: field is not allowed. Known fields: id, title, "
            "prompt, narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.items[2].subject",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": "intent.items[2].subject: field is not allowed. Known fields: id, title, "
            "prompt, narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.items[2].task",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": 'intent.items[2].task: field is not '
            'allowed. Known fields: id, title, prompt, '
            "narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.run_after_create",
            "problem": "unknown_field",
            "accepted": [
                "external_inputs",
                "schema_version",
                "skill_id",
                "user_goal",
                "title",
                "summary",
                "inputs",
                "planner",
                "items",
                "include_audio",
                "include_compose",
                "assumptions",
            ],
            "message": 'intent.run_after_create: field is not '
            'allowed. Known fields: external_inputs, '
            "schema_version, skill_id, user_goal, title, summary, inputs, planner, items, "
            "include_audio, include_compose, assumptions. run_after_create is a field of "
            "the top-level arguments.",
        },
    ],
    [
        {
            "path": "intent.items[0].id",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<id>",
            "message": 'intent.items[0].id: field is required. Accepted: string. Example: "<id>".',
        },
        {
            "path": "intent.items[0].subject",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": "intent.items[0].subject: field is not allowed. Known fields: id, title, "
            "prompt, narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.items[1].id",
            "problem": "missing_field",
            "accepted": ["string"],
            "example": "<id>",
            "message": 'intent.items[1].id: field is required. Accepted: string. Example: "<id>".',
        },
        {
            "path": "intent.items[1].subject",
            "problem": "unknown_field",
            "accepted": [
                "id",
                "title",
                "prompt",
                "narration",
                "audio_kind",
                "music_length_ms",
                "duration_seconds",
                "recipe_id",
                "depends_on",
                "reference_inputs",
                "stage",
                "timeline_role",
                "requires_generated_audio",
            ],
            "message": "intent.items[1].subject: field is not allowed. Known fields: id, title, "
            "prompt, narration, audio_kind, music_length_ms, duration_seconds, recipe_id, "
            "depends_on, reference_inputs, stage, timeline_role, "
            "requires_generated_audio.",
        },
        {
            "path": "intent.run_after_create",
            "problem": "unknown_field",
            "accepted": [
                "external_inputs",
                "schema_version",
                "skill_id",
                "user_goal",
                "title",
                "summary",
                "inputs",
                "planner",
                "items",
                "include_audio",
                "include_compose",
                "assumptions",
            ],
            "message": 'intent.run_after_create: field is not '
            'allowed. Known fields: external_inputs, '
            "schema_version, skill_id, user_goal, title, summary, inputs, planner, items, "
            "include_audio, include_compose, assumptions. run_after_create is a field of "
            "the top-level arguments.",
        },
    ],
    [
        {
            "path": "intent.run_after_create",
            "problem": "unknown_field",
            "accepted": [
                "external_inputs",
                "schema_version",
                "skill_id",
                "user_goal",
                "title",
                "summary",
                "inputs",
                "planner",
                "items",
                "include_audio",
                "include_compose",
                "assumptions",
            ],
            "message": 'intent.run_after_create: field is not '
            'allowed. Known fields: external_inputs, '
            "schema_version, skill_id, user_goal, title, summary, inputs, planner, items, "
            "include_audio, include_compose, assumptions. run_after_create is a field of "
            "the top-level arguments.",
        }
    ],
]


PREPARE_EXAMPLES = [
    {
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
        "intent": {"skill_id": "<skill_id>", "user_goal": "<user_goal>"},
    },
    {
        "intent": {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": "<skill_id>",
            "user_goal": "<user_goal>",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
    {
        "intent": {
            "inputs": {"image_aspect_ratio": "1:1", "image_variants_per_node": 1},
            "items": [
                {
                    "id": "n1_text_autumn",
                    "prompt": "write a short poem of no more than 10 characters about "
                    "autumn as the image prompt",
                    "title": "<title>",
                    "recipe_id": "<recipe_id>",
                },
                {"id": "n2_img_maple", "title": "<title>", "recipe_id": "<recipe_id>"},
                {"id": "n3_img_ginkgo", "title": "<title>", "recipe_id": "<recipe_id>"},
            ],
            "skill_id": "text-to-image",
            "user_goal": "build a three-node workflow on the canvas: one text node writes a "
            "short poem of no more than 10 characters about autumn as the "
            "image prompt; two image nodes both consume the text node's output "
            "as prompt, one draws red maple leaves and one draws ginkgo "
            "leaves, minimum resolution and lowest quality, 1 image each; "
            "nodes connected by dependency edges from the text node to both "
            "image nodes; no video or audio; run immediately after building",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
    {
        "intent": {
            "inputs": {"image_aspect_ratio": "1:1", "image_variants_per_node": 1},
            "items": [
                {"recipe_id": "general-image", "title": "n2_img_maple", "id": "<id>"},
                {"recipe_id": "general-image", "title": "n3_img_ginkgo", "id": "<id>"},
            ],
            "skill_id": "text-to-image",
            "user_goal": "build a three-node workflow on the canvas: one text node writes a "
            "short poem of no more than 10 characters about autumn as the "
            "image prompt; two image nodes both consume the text node's output "
            "as prompt, one draws red maple leaves and one draws ginkgo "
            "leaves, minimum resolution and lowest quality, 1 image each; "
            "nodes connected by dependency edges from the text node to both "
            "image nodes; no video or audio; run immediately after building",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
    {
        "intent": {
            "inputs": {"image_aspect_ratio": "1:1", "image_variants_per_node": 1},
            "items": [
                {"id": "n2_img_maple", "recipe_id": "general-image", "title": "n2_img_maple"},
                {"id": "n3_img_ginkgo", "recipe_id": "general-image", "title": "n3_img_ginkgo"},
            ],
            "skill_id": "text-to-image",
            "user_goal": "build a three-node workflow on the canvas: one text node writes a "
            "short poem of no more than 10 characters about autumn as the "
            "image prompt; two image nodes both consume the text node's output "
            "as prompt, one draws red maple leaves and one draws ginkgo "
            "leaves, minimum resolution and lowest quality, 1 image each; "
            "nodes connected by dependency edges from the text node to both "
            "image nodes; no video or audio; run immediately after building",
        },
        "operation_id": "agent_product_0e5abaf93fb0483dbd5cf7b4ede2d695",
        "run_after_create": True,
    },
]


VALID_PLAN = {
    "schema_version": "freezone_workflow_plan.v1",
    "skill": {"id": "page"},
    "nodes": [
        {"id": "shot", "node_type": "videoNode", "data": {"workflowCatalog": {"recipeId": "r"}}}
    ],
    "edges": [],
}

NODE_ERRORS = [
    {
        "path": "plan.nodes[0].scene",
        "problem": "unknown_field",
        "accepted": [
            "id",
            "title",
            "label",
            "name",
            "stage",
            "content",
            "text",
            "prompt",
            "description",
            "position",
            "data",
            "node_type",
        ],
        "message": 'plan.nodes[0].scene: field is not '
        'allowed for node_type videoNode; allowed keys: '
        'content, data, description, id, label, name, '
        'node_type, position, prompt, stage, text, title',
    }
]


PREPARE_ALTERNATIVES = [
    (
        'intent (object with external_inputs (array of objects), schema_version (one of '
        '"freezone_workflow_intent.v1"), skill_id (string), user_goal (string), title '
        '(string), summary (string), inputs (object), planner (object), items (array of '
        'objects), include_audio (boolean), include_compose (boolean), assumptions (array of '
        'strings))'
    ),
    (
        'plan (object with external_inputs (array of objects), schema_version (one of '
        '"freezone_workflow_plan.v1"), workflow_type (string), title (string), summary '
        '(string), mode (string), source_context (object), analysis (object), phases (array of '
        'strings), assumptions (array of strings), missing_inputs (array), expansion_rules '
        '(object), execution_policy (object), inputs (object), expected_node_count (integer), '
        'expected_node_counts (object), skill (object), nodes (array of objects), edges (array '
        'of objects), groups (array of objects), group (object or array of objects), layout '
        '(object))'
    ),
]

@pytest.mark.parametrize("index", range(5), ids=["call1", "call2", "call3", "call4", "call5"])
def test_prepare_refusal_names_fixes_for_recorded_arguments(workflow_agent, index):
    name = "freezone_prepare_workflow"
    errors = deepcopy(PREPARE_ERRORS[index])
    if index == 0:
        accepted = PREPARE_ALTERNATIVES
        errors.append(
            {
                "path": "arguments",
                "problem": "missing_field",
                "accepted": accepted,
                "example": {"intent": {"skill_id": "<skill_id>", "user_goal": "<user_goal>"}},
                "message": "arguments: provide exactly one of intent, plan. Accepted: "
                + " | ".join(accepted)
                + '. Example: {"intent": {"skill_id": "<skill_id>", "user_goal": "<user_goal>"}}.',
            }
        )
    example = PREPARE_EXAMPLES[index]
    Draft202012Validator(workflow_agent.tools[name].inputSchema).validate(example)
    result = workflow_agent.call(name, deepcopy(PREPARE_CALLS[index]))
    assert_refusal(workflow_agent, name, result, errors, example)


def test_prepare_refusal_explains_conflicting_alternatives(workflow_agent):
    name = "freezone_prepare_workflow"
    result = workflow_agent.call(
        name,
        {
            "operation_id": "op-1",
            "intent": {"skill_id": "text-to-image", "user_goal": "g"},
            "plan": deepcopy(VALID_PLAN),
        },
    )
    sc = result.structuredContent
    assert sc["retryable"] is True
    assert len(sc["errors"]) == 1
    error = sc["errors"][0]
    assert error["path"] == "arguments"
    assert error["problem"] == "conflicting_fields"
    assert error["message"].startswith(
        "arguments: provide exactly one of intent, plan; got intent, plan. "
        "Accepted: intent (object with "
    )
    assert "example" not in error
    accepted = PREPARE_ALTERNATIVES
    assert_refusal(
        workflow_agent,
        name,
        result,
        [
            {
                "path": "arguments",
                "problem": "conflicting_fields",
                "accepted": accepted,
                "message": 'arguments: provide exactly one of '
                'intent, plan; got intent, plan. Accepted: '
                + " | ".join(accepted)
                + ".",
            }
        ],
        sc["example"],
    )


def test_plan_draft_refusal_keeps_node_diagnostics_and_accepted_fields(workflow_agent):
    name = "freezone_prepare_workflow_plan_draft"
    args = {"operation_id": "op-1", "plan": deepcopy(VALID_PLAN)}
    Draft202012Validator(workflow_agent.tools[name].inputSchema).validate(args)
    args["plan"]["nodes"][0]["scene"] = "s1"
    result = workflow_agent.call(name, args)
    sc = result.structuredContent
    assert sc["phase"] == "graph_compile"
    assert_refusal(
        workflow_agent,
        name,
        result,
        NODE_ERRORS,
        {"operation_id": "op-1", "plan": VALID_PLAN},
        status="workflow_validation_failed",
    )
    assert "plan.schema_version 必须为 freezone_workflow_plan.v1" in sc["agent_instruction"]


def test_plan_draft_refusal_explains_node_and_edge_constraint(workflow_agent):
    name = "freezone_prepare_workflow_plan_draft"
    plan = deepcopy(VALID_PLAN)
    plan["nodes"][0]["id"] = "a"
    plan["nodes"].append(
        {
            "id": "b",
            "node_type": "videoNode",
            "data": {"workflowCatalog": {"recipeId": "r"}},
        }
    )
    result = workflow_agent.call(name, {"operation_id": "op-1", "plan": plan})
    sc = result.structuredContent
    errors = [
        {
            "path": "plan",
            "problem": "invalid_value",
            "accepted": [
                "object with nodes (array with at most 1 item)",
                'object with nodes (array with at least 2 '
                'items), edges (array with at least 1 item)',
            ],
            "message": 'plan: this object is not accepted. '
            'Accepted: object with nodes (array with at '
            'most 1 item) | object with nodes (array with '
            'at least 2 items), edges (array with at least '
            "1 item).",
        }
    ]
    assert sc["errors"] == errors
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors,
        sc["example"],
        status="workflow_validation_failed",
    )


def test_workflow_graph_compile_refusal_names_the_node_fix():
    name = "workflow_graph_compile"
    tools = {tool.name: tool for tool in asyncio.run(workflow_mcp.list_tools())}
    example = {"plan": deepcopy(VALID_PLAN)}
    Draft202012Validator(tools[name].inputSchema).validate(example)
    args = deepcopy(example)
    args["plan"]["nodes"][0]["scene"] = "s1"
    result = asyncio.run(workflow_mcp.call_tool(name, args))
    sc = result.structuredContent
    assert sc["ok"] is False
    assert sc["status"] == "tool_arguments_invalid"
    assert sc["errors"] == NODE_ERRORS
    assert sc["retryable"] is True
    assert sc["error"] == sc["message"] == NODE_ERRORS[0]["message"]
    assert sc["path"] == "plan.nodes[0].scene"
    assert sc["next_action"] == (
        "Fix the listed errors and call the tool once with corrected arguments."
    )
    assert "keep the user's real values" in sc["agent_instruction"]
    assert "Sending the same arguments again fails the same way." in sc["agent_instruction"]
    assert sc["example"] == example
    Draft202012Validator(tools[name].inputSchema).validate(sc["example"])


TEXT_TITLE_ERROR = {
    "path": "commands[0].data",
    "problem": "missing_field",
    "accepted": ["displayName (string)", "title (string)"],
    "example": {"displayName": "<displayName>"},
    "message": "commands[0].data: provide at least one of displayName, title. "
    "Accepted: displayName (string) | title (string). "
    'Example: {"displayName": "<displayName>"}.',
}
TEXT_CONTENT_ERROR = {
    "path": "commands[0].data.content",
    "problem": "missing_field",
    "accepted": ["string"],
    "example": "<content>",
    "message": 'commands[0].data.content: field is required. Accepted: string. '
    'Example: "<content>".',
}
TEXT_DATA_ERROR = {
    "path": "commands[0].data",
    "problem": "missing_field",
    "accepted": ["object with displayName (string), title (string), content (string)"],
    "example": {"content": "<content>", "displayName": "<displayName>"},
    "message": "commands[0].data: field is required. "
    "Accepted: object with displayName (string), title (string), content (string). "
    'Example: {"content": "<content>", "displayName": "<displayName>"}.',
}


def _text_command(data):
    command = {"type": "create_node", "node_type": "textAnnotationNode", "client_id": "poem"}
    if data is not None:
        command["data"] = data
    return command


@pytest.mark.parametrize("name", [
    "freezone_emit_canvas_command", "freezone_validate_canvas_commands",
])
@pytest.mark.parametrize(("data", "errors", "repaired"), [
    (
        {"content": "Leaves fall"},
        [TEXT_TITLE_ERROR],
        {"content": "Leaves fall", "displayName": "<displayName>"},
    ),
    (
        {"displayName": "Autumn"},
        [TEXT_CONTENT_ERROR],
        {"displayName": "Autumn", "content": "<content>"},
    ),
    (
        {},
        [TEXT_CONTENT_ERROR, TEXT_TITLE_ERROR],
        {"content": "<content>", "displayName": "<displayName>"},
    ),
    (
        None,
        [TEXT_DATA_ERROR],
        {"content": "<content>", "displayName": "<displayName>"},
    ),
])
def test_text_node_refusal_names_each_missing_field(workflow_agent, name, data, errors, repaired):
    args = {"canvas_id": "canvas-1", "commands": [_text_command(data)]}
    result = workflow_agent.call(name, deepcopy(args))
    assert_refusal(
        workflow_agent,
        name,
        result,
        errors=errors,
        example={"canvas_id": "canvas-1", "commands": [_text_command(repaired)]},
    )
    sc = result.structuredContent
    assert "node_type" not in sc["message"]
    assert "textAnnotationNode" in sc["agent_instruction"]
    assert "displayName" in sc["agent_instruction"]


def test_text_node_refusal_does_not_echo_html_from_the_same_batch(workflow_agent):
    html = "<main>private draft markup</main>"
    args = {"commands": [
        {"type": "html_artifact", "action": "create", "title": "Draft", "html": html},
        {"type": "create_node", "node_type": "textAnnotationNode", "data": {"content": "x"}},
    ]}
    result = workflow_agent.call("freezone_emit_canvas_command", args)
    sc = result.structuredContent
    assert workflow_agent.requests == []
    assert sc["retryable"] is True
    assert [error["path"] for error in sc["errors"]] == ["commands[1].data"]
    assert "example" not in sc
    assert html not in json.dumps(sc, ensure_ascii=False)
    assert html not in result.content[0].text
