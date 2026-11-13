# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Every outcome of freezone_get_node_action_catalog fits the tool's own output schema.

A node id that is not on the canvas used to come back as ``ok`` with ``data: null``.
The tool's output schema rejects that, so the Agent only saw a schema error and sent
the same invented id again. These tests drive both canvas executors (the browser
bridge and the server agent-context route) through the MCP runtime, which validates
every result against the published output schema.
"""

import asyncio
import json

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp

TOOL = "freezone_get_node_action_catalog"
PROJECT = "project-a"
CANVAS = "canvas_b"
MISSING = "canvas_b:new-ginkgo-image"
EXECUTORS = ("browser", "server")
CATALOG = {
    "node_id": "n-image", "node_type": "imageGenNode",
    "actions": [{"action": "generate_image", "paid": True}],
}


def _context(responses, *, ok=True, **extra):
    return {
        "ok": ok,
        "tool_call_status": "completed" if ok else "failed",
        "canvas_context_status": "resolved" if ok else "failed",
        "responses": responses,
        "errors": [] if ok else ["Node worker failed to read the canvas."],
        "project_id": PROJECT,
        "canvas_id": CANVAS,
        "message": "Frontend returned requested canvas context.",
        **extra,
    }


@pytest.fixture
def plugin(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", PROJECT)
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", CANVAS)
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    return dramaclaw_mcp._plugin("freezone")


def _answer(monkeypatch, plugin, executor, payload):
    """Make the chosen executor answer the context request with ``payload``.

    ``payload`` is the canvas context body for the browser bridge, or the plugin's
    ``_request`` result for the server route.
    """
    calls = []
    monkeypatch.setattr(plugin, "_agent_canvas_executor", lambda: executor)
    if executor == "browser":
        monkeypatch.setattr(plugin, "canvas_context_bridge_key", lambda **kwargs: "bridge-a")

        def put(**kwargs):
            calls.append(kwargs["requests"])

        monkeypatch.setattr(plugin, "put_pending_canvas_context", put)
        monkeypatch.setattr(plugin, "wait_canvas_context_result", lambda *a, **k: payload)
        return calls

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs.get("body")))
        return payload

    monkeypatch.setattr(plugin, "_request", request)
    return calls


def _server_ok(body):
    return {"ok": True, "data": body}


def _call(args):
    result = asyncio.run(dramaclaw_mcp.call_tool(TOOL, args))
    Draft202012Validator(dramaclaw_mcp._output_schema_for_tool(TOOL)).validate(
        result.structuredContent
    )
    return result


def _missing_node(executor):
    body = _context([{"type": "node_action_catalog", "node_id": MISSING, "data": None}])
    return body if executor == "browser" else _server_ok(body)


@pytest.mark.parametrize("executor", EXECUTORS)
@pytest.mark.parametrize("action", [None, "generate_image"])
def test_unknown_node_id_is_a_clear_refusal(monkeypatch, plugin, executor, action):
    calls = _answer(monkeypatch, plugin, executor, _missing_node(executor))
    args = {"node_id": MISSING, **({"action": action} if action else {})}
    result = _call(args)
    payload = result.structuredContent
    assert result.isError is True
    assert payload["ok"] is False
    assert payload["status"] == payload["code"] == "node_not_found"
    assert payload["retryable"] is False
    assert payload["next_action"] == "summarize_canvas_or_tell_user"
    assert payload["node_id"] == MISSING
    assert payload["canvas_id"] == CANVAS
    assert payload["project_id"] == PROJECT
    assert MISSING in payload["error"]
    instruction = payload["agent_instruction"]
    for phrase in (
        "does not exist",
        "Do not call freezone_get_node_action_catalog again with this node_id",
        "Do not invent or construct node ids",
        "freezone_summarize_canvas",
        "tell the user",
    ):
        assert phrase in instruction, instruction
    text = result.content[0].text
    assert "node_not_found" in text
    assert "is not valid under any of the given schemas" not in text
    assert len(calls) == 1


@pytest.mark.parametrize("executor", EXECUTORS)
def test_real_node_catalog_and_unknown_action_pass_through(monkeypatch, plugin, executor):
    unknown_action = {"node_id": "n-image", "action": "dance", "action_found": False,
                      "instruction": "Pick one of the listed actions."}
    for data in (CATALOG, unknown_action):
        body = _context([{"type": "node_action_catalog", "node_id": "n-image", "data": data}])
        _answer(monkeypatch, plugin, executor, body if executor == "browser" else _server_ok(body))
        result = _call({"node_id": "n-image"})
        assert result.isError is False
        assert result.structuredContent["ok"] is True
        assert result.structuredContent["responses"][0]["data"] == data


@pytest.mark.parametrize("executor", EXECUTORS)
@pytest.mark.parametrize("responses", [
    [],
    [{"type": "node_action_catalog", "node_id": "n-image"}],
    [{"type": "node_action_catalog", "node_id": "n-image", "data": "nonsense"}],
    [{"type": "canvas_summary", "data": {}}],
])
def test_incomplete_answer_is_a_refusal_inside_the_schema(
    monkeypatch, plugin, executor, responses
):
    body = _context(responses)
    _answer(monkeypatch, plugin, executor, body if executor == "browser" else _server_ok(body))
    result = _call({"node_id": "n-image"})
    payload = result.structuredContent
    assert result.isError is True
    assert payload["ok"] is False
    assert payload["status"] == payload["code"] == "canvas_context_incomplete"
    assert payload["retryable"] is False
    assert payload["errors"]
    assert "Do not repeat this call with the same arguments" in payload["agent_instruction"]


def test_browser_answer_without_ids_keeps_the_catalog(monkeypatch, plugin):
    body = _context(
        [{"type": "node_action_catalog", "node_id": "n-image", "data": CATALOG}],
        project_id=None, canvas_id=None,
    )
    _answer(monkeypatch, plugin, "browser", body)
    result = _call({"node_id": "n-image"})
    assert result.isError is False
    assert result.structuredContent["responses"][0]["data"] == CATALOG
    assert "project_id" not in result.structuredContent
    assert "canvas_id" not in result.structuredContent


@pytest.mark.parametrize(("executor", "payload"), [
    ("browser", None),  # the browser never answered: the bridge returns its timeout result
    ("browser", _context([], ok=False)),
    ("server", {"ok": False, "status_code": 503, "code": "canvas_core_unavailable",
                "error": "Canvas core is unavailable."}),
    ("server", {"ok": False, "status_code": 422, "error": "Invalid canvas context request."}),
    ("server", _server_ok(_context([], ok=False))),
])
def test_failures_stay_errors_inside_the_schema(monkeypatch, plugin, executor, payload):
    _answer(monkeypatch, plugin, executor, payload)
    result = _call({"node_id": "n-image"})
    assert result.isError is True
    assert result.structuredContent["ok"] is False
    assert result.structuredContent.get("errors") or result.structuredContent.get("message")


def test_missing_bridge_is_an_error_inside_the_schema(monkeypatch, plugin):
    monkeypatch.setattr(plugin, "_agent_canvas_executor", lambda: "browser")
    monkeypatch.setattr(plugin, "canvas_context_bridge_key", None)
    result = _call({"node_id": "n-image"})
    assert result.isError is True
    assert "bridge is unavailable" in json.dumps(result.structuredContent)
