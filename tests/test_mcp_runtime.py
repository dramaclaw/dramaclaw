from __future__ import annotations

import pytest
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
