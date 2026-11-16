from copy import deepcopy
import json

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import mcp_runtime, story_tools, workflow_mcp


def descriptions(schema):
    if isinstance(schema, dict):
        return "\n".join(
            [
                str(schema.get("description", "")),
                *(descriptions(v) for v in schema.values()),
            ]
        )
    if isinstance(schema, list):
        return "\n".join(descriptions(v) for v in schema)
    return ""


def without_descriptions(schema):
    if isinstance(schema, dict):
        return {
            k: without_descriptions(v) for k, v in schema.items() if k != "description"
        }
    if isinstance(schema, list):
        return [without_descriptions(v) for v in schema]
    return schema


def published(schema):
    index = {
        "check": ({"parameters": schema, "output_schema": {"type": "object"}}, None)
    }
    return mcp_runtime.build_mcp_tools(index)[0].inputSchema


def test_story_conditions_and_scalar_constraints_are_readable_without_schema_keywords():
    source = story_tools._story_choice_schema()
    saved = deepcopy(source)
    shown = published(source)
    text = descriptions(shown)
    for rule in (
        '"if":',
        '"then":',
        '"else":',
        '"automatic"',
        '"baked_video"',
        '"required":["anchor"]',
        '"minimum":300',
        '"maximum":5000',
        '"minLength":1',
        '"pattern":',
    ):
        assert rule in text
    assert source == saved
    assert without_descriptions(shown) == without_descriptions(source)


@pytest.mark.parametrize(
    "value,valid",
    [
        ({"presentation": "baked_video"}, False),
        ({"presentation": "baked_video", "anchor": {"x": 0, "y": 1}}, False),
        (
            {
                "presentation": "baked_video",
                "anchor": {"x": 0, "y": 1, "width": 0.5, "height": 0.5},
            },
            True,
        ),
        ({"hold_ms": 1}, False),
        ({"hold_ms": 300}, True),
    ],
)
def test_advertised_guidance_preserves_original_acceptance(value, valid):
    source = story_tools._story_interaction_schema()
    assert Draft202012Validator(source).is_valid(value) is valid
    assert Draft202012Validator(published(source)).is_valid(value) is valid


async def test_workflow_tools_publish_limit_and_plan_constraints():
    tools = {tool.name: tool for tool in await workflow_mcp.list_tools()}
    search = tools["workflow_catalog_search"].inputSchema
    assert '"maximum":' in descriptions(search["properties"]["limit"])
    assert '"minLength":' in descriptions(tools["workflow_graph_compile"].inputSchema)


async def test_nested_command_error_identifies_field_without_echoing_user_input():
    calls = []
    schema = {
        "type": "object",
        "properties": {
            "commands": {
                "type": "array",
                "items": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "type": {"enum": ["create"]},
                                "data": {
                                    "type": "object",
                                    "properties": {
                                        "title": {"type": "string", "minLength": 5}
                                    },
                                    "required": ["title"],
                                },
                            },
                            "required": ["type", "data"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "type": {"enum": ["delete"]},
                                "id": {"type": "string"},
                            },
                            "required": ["type", "id"],
                        },
                    ]
                },
            }
        },
    }
    tools = {
        "check": (
            {
                "parameters": schema,
                "output_schema": {
                    "type": "object",
                    "properties": {
                        "ok": {"type": "boolean"},
                        "status": {"type": "string"},
                        "path": {"type": "string"},
                        "message": {"type": "string"},
                    },
                    "required": ["ok", "status"],
                },
            },
            lambda args: calls.append(args),
        )
    }
    result = await mcp_runtime.call_tool(
        "check",
        {"commands": [{"type": "create", "data": {"title": "KEY!"}}]},
        tool_index=tools,
    )
    assert result.isError
    assert result.structuredContent["path"] == "commands[0].data.title"
    assert "minLength" in result.structuredContent["message"]
    assert "KEY!" not in json.dumps(result.model_dump())
    assert calls == []


async def test_missing_nested_field_points_to_the_missing_property():
    schema = {
        "type": "object",
        "properties": {
            "data": {
                "type": "object",
                "properties": {"title": {"type": "string"}},
                "required": ["title"],
            }
        },
    }
    tools = {
        "check": (
            {
                "parameters": schema,
                "output_schema": {
                    "type": "object",
                    "properties": {
                        "ok": {"type": "boolean"},
                        "status": {"type": "string"},
                        "path": {"type": "string"},
                        "message": {"type": "string"},
                    },
                },
            },
            None,
        )
    }
    result = await mcp_runtime.call_tool("check", {"data": {}}, tool_index=tools)
    assert result.structuredContent["path"] == "data.title"


def test_boolean_union_branches_return_a_diagnostic_instead_of_crashing():
    from novelvideo.chat.story_validation import base_validation_error_payload

    schema = {
        "oneOf": [
            False,
            {
                "type": "object",
                "properties": {"type": {"const": "create"}, "n": {"type": "integer"}},
                "required": ["type", "n"],
            },
        ]
    }
    args = {"type": "create", "n": "secret"}
    errors = list(Draft202012Validator(schema).iter_errors(args))
    result = base_validation_error_payload("check", args, schema, errors[0], errors)
    assert result["path"] == "arguments"
    assert "oneOf" in result["message"]
    assert "secret" not in result["message"]


def test_repeated_publication_does_not_accumulate_guidance_or_change_literal_data():
    source = {
        "type": "object",
        "properties": {"text": {"type": "string", "minLength": 1}},
        "examples": [{"if": "this is user data, not a schema"}],
    }
    saved = deepcopy(source)
    assert published(source) == published(source)
    assert source == saved
    assert published(source)["examples"] == source["examples"]


def test_shared_schema_nodes_receive_guidance_once():
    shared = {"type": "string", "minLength": 1}
    source = {"type": "object", "properties": {"first": shared, "second": shared}}
    shown = published(source)
    assert shown["properties"]["first"]["description"].count("Server constraints") == 1
    assert shown["properties"]["first"] == shown["properties"]["second"]
    assert published(shown) == shown
    assert "description" not in shared


def constraint_description(schema):
    return json.loads(
        schema["description"].split(
            "Server constraints (JSON Schema, relative to this value): "
        )[-1]
    )


def assert_choice_guidance(choice):
    expected = story_tools._story_choice_schema()
    assert constraint_description(choice)["allOf"] == expected["allOf"]
    assert (
        constraint_description(choice["properties"]["interaction"])["allOf"]
        == expected["properties"]["interaction"]["allOf"]
    )
    assert constraint_description(
        choice["properties"]["interaction"]["properties"]["hold_ms"]
    ) == {"minimum": 300, "maximum": 5000}


def test_conditions_remain_scoped_to_their_own_object():
    assert_choice_guidance(published(story_tools._story_choice_schema()))
