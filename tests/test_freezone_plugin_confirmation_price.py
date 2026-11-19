# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Confirmation tools report server-provided prices and input blockers."""

import re

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp
from test_freezone_plugin_server_executor import (
    CONFIRMATION,
    DELETE,
    _respond,
    _restore_tools_registry_modules as _restore_tools_registry_modules,
    agent as agent,
)

PAID = [{"type": "run_node_action", "node_id": "n1", "action": "generate_image"}]
IMAGE = {
    "node_id": "n1", "action": "generate_image", "status": "known",
    "credits": 30, "display": "30",
}
KNOWN = {"status": "known", "credits": 30, "display": "30", "items": [IMAGE]}
UNKNOWN = {
    "status": "unknown", "reason": "quote_failed", "items": [{
        "node_id": "n2", "action": "generate_video", "status": "unknown",
        "reason": "quote_failed",
    }],
}
UNKNOWN_TEXT = "The price is unknown: the server could not price this generation."
PRICE_TEXT = "This will cost 30 credits."
CONFIRMATION_TOOLS = {
    "freezone_emit_canvas_command",
    "freezone_confirm_workflow_draft",
    "freezone_delete_nodes",
    "freezone_run_node_action",
    "freezone_run_workflow",
}


def call_confirmation(agent, monkeypatch, response, *, commands=PAID):
    plugin, calls, _, _ = agent
    monkeypatch.setattr(plugin, "_resolve_canvas_generation_recommendations", lambda *_: None)
    _respond(agent, monkeypatch, "/confirmations", response)
    index = dramaclaw_mcp._tool_index(plugin)
    result = index["freezone_emit_canvas_command"][1]({"commands": commands})
    assert [path for method, path, _ in calls if method == "POST"] == [
        "/api/v1/projects/p/freezone/canvases/c/confirmations",
    ]
    return result


@pytest.mark.parametrize(
    "price,text",
    [
        (KNOWN, PRICE_TEXT),
        ({"status": "not_metered"},
         "This deployment does not deduct credits; the model provider's own cost "
         "is not known here."),
        (UNKNOWN, UNKNOWN_TEXT),
        ({**UNKNOWN, "known_credits": 30, "items": [IMAGE, *UNKNOWN["items"]]},
         "The price is unknown: 1 of 2 actions could not be priced; "
         "the priced part costs 30 credits."),
        (None, UNKNOWN_TEXT),
    ],
    ids=["known", "not-metered", "unknown", "partly-known", "older-api"],
)
@pytest.mark.parametrize("external", [False, True], ids=["product", "external"])
def test_paid_confirmation_price_text(agent, monkeypatch, external, price, text):
    if external:
        monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    data = {**CONFIRMATION, "kinds": ["paid_generation"]}
    if price is not None:
        data["price"] = price
    result = call_confirmation(agent, monkeypatch, {"ok": True, "data": data})
    assert result["status"] == "confirmation_required"
    assert result["price"] == (
        price if price is not None else {"status": "unknown", "reason": "not_provided"}
    )
    assert result["price_text"] == text


@pytest.mark.parametrize("branch", ["card", "conversation", "written"])
@pytest.mark.parametrize("external", [False, True], ids=["product", "external"])
def test_paid_confirmation_instruction_quotes_server_price(agent, monkeypatch, external, branch):
    if external:
        monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    if branch == "card":
        monkeypatch.setenv("DRAMACLAW_TURN_ID", "t1")
    data = {**CONFIRMATION, "kinds": ["paid_generation"], "price": UNKNOWN}
    if branch == "written":
        data["written"] = {"created_node_ids": ["n1"], "created_edge_ids": [], "nodes": []}
    result = call_confirmation(agent, monkeypatch, {"ok": True, "data": data})
    assert result["confirmation_via"] == ("card" if branch == "card" else "conversation")
    assert ("written" in result) == (branch == "written")
    instruction = result["agent_instruction"].lower()
    assert "do not give any estimate" not in instruction
    assert "without giving any estimate" not in instruction
    assert re.search(r"quot\w*[^.!?]*price_text[^.!?]*exactly", instruction)
    assert re.search(r"price is unknown[^.!?]*tell the user[^.!?]*unknown", instruction)
    assert re.search(r"(?:never|do not) estimate[^.!?]*compute[^.!?]*guess", instruction)


def test_non_paid_tool_confirmation_has_no_price_fields(agent, monkeypatch):
    result = call_confirmation(
        agent, monkeypatch, {"ok": True, "data": CONFIRMATION}, commands=DELETE,
    )
    assert result["status"] == "confirmation_required"
    assert {"price", "price_text"}.isdisjoint(result)


def test_input_not_ready_tool_result_explains_blocker(agent, monkeypatch):
    blockers = [{
        "node_id": "n2", "title": "Clip", "node_type": "videoNode",
        "action": "generate_video", "code": "missing_media",
        "message": "A source keyframe is required.",
        "inputs": [{"node_id": "n1", "title": "First frame", "node_type": "uploadNode",
                    "state": "uploading"}],
    }]
    message = "Clip needs a source keyframe."
    result = call_confirmation(agent, monkeypatch, {
        "ok": False, "code": "generation_input_not_ready", "not_ready": blockers,
        "message": message,
    })
    assert result["ok"] is False
    assert result["code"] == "generation_input_not_ready"
    assert result["message"] == message
    assert "confirmation_id" not in result
    assert result["canvas_apply_status"] == "not_applied"
    assert result["applied"] is False
    assert result["blockers"] == blockers
    assert result["retryable"] is False
    instruction = result["agent_instruction"].lower()
    for phrase in ("nothing was created", "no confirmation exists", "no credits will be spent",
                   "tell the user", "until", "input", "different wiring"):
        assert phrase in instruction


@pytest.mark.parametrize("tool", sorted(CONFIRMATION_TOOLS))
def test_confirmation_schema_accepts_optional_price_fields(agent, monkeypatch, tool):
    plugin, _, _, _ = agent
    index = dramaclaw_mcp._tool_index(plugin)
    result = call_confirmation(agent, monkeypatch, {"ok": True, "data": CONFIRMATION},
                               commands=DELETE)
    schema = dramaclaw_mcp._output_schema_for_tool(tool, index)
    validator = Draft202012Validator(schema)
    structured = dramaclaw_mcp._normalize_structured_result(schema, result)
    validator.validate(structured)
    priced = {**structured, "price": KNOWN, "price_text": PRICE_TEXT}
    validator.validate(priced)
    assert dramaclaw_mcp._normalize_structured_result(schema, priced) == priced
    assert not validator.is_valid({**priced, "price": 30})
    assert not validator.is_valid({**priced, "price_text": 30})


def test_other_tool_schemas_reject_confirmation_price_fields(agent):
    plugin, _, _, _ = agent
    index = dramaclaw_mcp._tool_index(plugin)
    for tool in index.keys() - CONFIRMATION_TOOLS:
        if not tool.startswith("freezone_"):
            continue
        schema = dramaclaw_mcp._output_schema_for_tool(tool, index)
        validator = Draft202012Validator(schema)
        failure = {"ok": False, "status": "failed", "error": "Unavailable"}
        validator.validate(failure)
        for field, value in {"price": KNOWN, "price_text": PRICE_TEXT}.items():
            assert not validator.is_valid({**failure, field: value}), (tool, field)
