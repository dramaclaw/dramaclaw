from __future__ import annotations

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from novelvideo.chat import mcp_runtime


def _tool_index(handler):
    return {
        "echo": (
            {
                "description": "Echo one integer.",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "integer"}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
                "output_schema": {
                    "type": "object",
                    "properties": {
                        "ok": {"type": "boolean"},
                        "status": {"type": "string"},
                        "value": {"type": "integer"},
                        "error": {"type": "string"},
                        "path": {"type": "string"},
                        "integer_string_fields": {"type": "array"},
                    },
                    "required": ["ok", "status"],
                    "additionalProperties": False,
                },
            },
            handler,
        )
    }


@pytest.mark.parametrize("async_handler", [False, True])
async def test_runtime_awaits_handler_and_validates_declared_output(async_handler):
    def sync(args):
        return {"ok": True, "data": {"value": args["value"]}}

    async def asynchronous(args):
        return sync(args)

    tools = _tool_index(asynchronous if async_handler else sync)
    result = await mcp_runtime.call_tool("echo", {"value": 3}, tool_index=tools)
    assert result.isError is False
    assert result.structuredContent == {"ok": True, "status": "completed", "value": 3}


async def test_invalid_arguments_are_rejected_before_side_effects():
    calls = []
    result = await mcp_runtime.call_tool(
        "echo", {"value": "3"}, tool_index=_tool_index(lambda args: calls.append(args))
    )
    assert result.isError is True
    assert result.structuredContent["error"] == "tool_arguments_invalid"
    assert result.structuredContent["integer_string_fields"] == [["value"]]
    assert calls == []


async def test_runtime_rejects_handler_output_that_violates_contract():
    with pytest.raises(ValidationError):
        await mcp_runtime.call_tool(
            "echo",
            {"value": 3},
            tool_index=_tool_index(lambda args: {"ok": True, "value": "invalid"}),
        )


def test_correction_paths_are_exact_for_required_nested_extra_and_scalar_errors():
    schema = {
        "type": "object",
        "properties": {
            "outline": {
                "type": "object", "additionalProperties": False,
                "properties": {"title": {"type": "string"}, "kind": {"enum": ["ad", "story"]}},
                "required": ["title", "kind"],
            },
            "revision": {"type": "integer"},
            "key": {"type": "string"},
        },
        "required": ["outline", "revision", "key"],
    }
    errors = list(Draft202012Validator(schema).iter_errors(
        {"outline": {"unexpected": 1}, "revision": "7"}
    ))
    paths, complete = mcp_runtime.validation_correction_paths(errors)
    assert complete is True
    assert {tuple(path) for path in paths} == {
        ("key",), ("revision",), ("outline", "title"), ("outline", "kind"),
        ("outline", "unexpected"),
    }


def test_correction_paths_narrow_discriminated_union_without_touching_other_variants():
    schema = {
        "type": "object", "properties": {"operations": {"type": "array", "items": {"oneOf": [
            {"type": "object", "properties": {"op": {"const": "edit"}, "value": {"type": "string"}}, "required": ["op", "value"]},
            {"type": "object", "properties": {"op": {"const": "delete"}, "target": {"type": "string"}}, "required": ["op", "target"]},
        ]}}},
    }
    errors = list(Draft202012Validator(schema).iter_errors({"operations": [{"op": "edit", "value": 12}]}))
    assert mcp_runtime.validation_correction_paths(errors) == ([["operations", 0, "value"]], True)


def test_correction_paths_allow_a_single_invalid_scalar_array_element():
    schema = {"type": "object", "properties": {"questions": {
        "type": "array", "items": {"type": "string"}
    }}}
    errors = list(Draft202012Validator(schema).iter_errors({"questions": ["ok", 3]}))
    assert mcp_runtime.validation_correction_paths(errors, schema) == (
        [["questions", 1]], True
    )


@pytest.mark.parametrize(
    ("schema", "arguments"),
    [
        ({"type": "object", "properties": {"choice": {"oneOf": [
            {"type": "object", "required": ["a"]}, {"type": "object", "required": ["b"]},
        ]}}}, {"choice": {}}),
        ({"type": "object", "properties": {"choice": {"oneOf": [
            {"type": "object", "properties": {"kind": {"const": "ad"}}, "required": ["title"]},
            {"type": "object", "required": ["other"]},
        ]}}}, {"choice": {"kind": "ad"}}),
        ({"type": "object", "properties": {"choice": {"oneOf": [
            {"type": "object"}, {"type": "null"},
        ]}}}, {"choice": "not-an-object"}),
        ({"type": "object", "properties": {"choice": {"anyOf": [
            {"type": "array"}, {"type": "null"},
        ]}}}, {"choice": "not-an-array"}),
        ({"type": "object", "properties": {"items": {"type": "array", "uniqueItems": True}}},
         {"items": ["duplicate", "duplicate"]}),
        ({"type": "object", "properties": {"story": {"type": "object"}},
          "required": ["story"]}, {}),
        ({"type": "object", "properties": {"story": {"type": "object"}}},
         {"story": "not-an-object"}),
        ({"type": "object", "additionalProperties": False}, {"unknown": {"data": 1}}),
        ({"type": "object", "properties": {"canvas_id": {"type": "string"}}},
         {"canvas_id": 3}),
        ({"type": "object"}, "not-an-object"),
    ],
)
def test_correction_paths_fail_closed_for_ambiguous_or_whole_container_errors(schema, arguments):
    errors = list(Draft202012Validator(schema).iter_errors(arguments))
    assert mcp_runtime.validation_correction_paths(errors)[1] is False


def test_correction_paths_allow_scalar_union_correction():
    schema = {"type": "object", "properties": {"count": {"oneOf": [
        {"type": "integer"}, {"type": "null"},
    ]}}}
    errors = list(Draft202012Validator(schema).iter_errors({"count": "not-an-integer"}))
    assert mcp_runtime.validation_correction_paths(errors, schema) == ([["count"]], True)
