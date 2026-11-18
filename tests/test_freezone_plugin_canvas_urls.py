# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Canvas links in bound tool results and published MCP contracts."""

import json

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp
from novelvideo.freezone.workflow_observation import summarize_workflow_run
from test_freezone_plugin import _load_plugin_module
from test_freezone_plugin import _restore_tools_registry_modules as _restore_tools_registry_modules
from test_freezone_plugin_server_executor import CONFIRMATION, CONFIRMATION_ID, CREATE, DELETE
from test_freezone_plugin_server_executor import agent as agent

LINK = "https://api-supplied.example/projects/p/freezone?canvas=c"
FORGED = "https://forged.example"
GUIDANCE = (
    " When the result has canvas_url, give that link to the user exactly as returned; "
    "do not download images, send images as attachments, or compose image addresses. "
    "To show an image, use the image_url returned by freezone_get_node_detail."
)
IMAGE_GUIDANCE = (
    " When a node in the result has image_url, show that image in your reply as a Markdown image "
    "using the address exactly as returned, and also give canvas_url exactly as returned. The "
    "address is time-limited. When there is no image_url, give only canvas_url. Do not download "
    "images, send images as attachments, or compose image addresses yourself."
)
LEGACY_GUIDANCE = "do not download images or send images as attachments."
SIGNED_IMAGE = "https://objects.example.test/image.png?sig=a%2Fb&expires=123"
SOURCE_IMAGE = "/static/projects/p/images/image.png"
NODE_DETAIL_TOOL = "freezone_get_node_detail"
NEW_NODE = {"node_type": "textAnnotationNode", "data": {"title": "Hello", "content": "hello"}}
CASES = {
    "create_canvas": ("canvases:create", {"name": "Plan"}),
    "list_canvases": ("canvases:agent-view", {}),
    "emit_canvas_command": ("agent-commands", {"commands": CREATE}),
    "create_node": ("agent-commands", NEW_NODE),
    "add_next_node": ("agent-commands", {**NEW_NODE, "source_node_id": "n"}),
    "run_node_action": ("agent-context", {"node_id": "n", "action": "history"}),
    "run_workflow": ("agent-commands", {"scope": "canvas"}),
    "confirm_canvas_action": ("/decision", {"confirmation_id": CONFIRMATION_ID}),
    "observe_workflow_run": ("workflow-runs/run_1", {"run_id": "run_1"}),
    "get_node_detail": ("agent-context", {"node_id": "n"}),
    "summarize_canvas": ("agent-context", {}),
}
OUTSIDE = {
    "update_node_data": ("agent-commands", {"node_id": "n", "data": {"title": "Updated"}}),
    "cancel_canvas_action": ("/decision", {"confirmation_id": CONFIRMATION_ID}),
    "get_neighbor_graph": ("agent-context", {"node_id": "n"}),
}


def _with_link(tool, result):
    if tool == "list_canvases":
        return {**result, "canvases": [{**row, "canvas_url": LINK} for row in result["canvases"]]}
    return {**result, "canvas_url": LINK}


def _assert_no_link(result):
    assert "canvas_url" not in result
    assert all("canvas_url" not in row for row in result.get("canvases", []))


@pytest.fixture
def host(agent, monkeypatch):
    plugin, _, _, _ = agent
    monkeypatch.delenv("DRAMACLAW_AGENT_KEY", raising=False)
    monkeypatch.delenv("DRAMACLAW_AGENT_TOKEN_FILE", raising=False)
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.setenv("DRAMACLAW_PUBLIC_ORIGIN", FORGED)
    monkeypatch.setattr(plugin, "_resolve_canvas_generation_recommendations", lambda *_: None)

    # Exercise the workflow server-result branch with a canned success after admission.
    original_kinds = plugin.confirmation_kinds
    monkeypatch.setattr(plugin, "confirmation_kinds", lambda commands: (
        [] if [command["type"] for command in commands] == ["run_workflow"]
        else original_kinds(commands)
    ))
    requires_frontend = plugin._requires_frontend_canvas_executor
    monkeypatch.setattr(plugin, "_requires_frontend_canvas_executor", lambda commands: (
        [command["type"] for command in commands] != ["run_workflow"]
        and requires_frontend(commands)
    ))

    original_request = plugin._request
    index = dramaclaw_mcp._tool_index(plugin)

    def call(
        tool, *, api_link=False, product=False, extra=None, decision_status="executed",
        image_url=None, pending=False,
    ):
        if product:
            monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
        else:
            monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
        suffix, args = (CASES | OUTSIDE)[tool]
        if pending:
            suffix, args = "/confirmations", {"commands": DELETE}
        calls = []

        def request(method, path, **kwargs):
            if not path.endswith(suffix):
                return original_request(method, path, **kwargs)
            calls.append(kwargs)
            if pending:
                data = CONFIRMATION
            elif tool == "create_canvas":
                data = {"status": "created", "canvas_id": "c", "display_name": "Plan",
                        "revision": 7}
            elif tool == "list_canvases":
                data = {"quota": {}, "canvases": [{
                    "canvas_id": "c", "display_name": "Plan", "kind": "user_created",
                    "creator_username": "alice", "created_by_viewer": True,
                    "created_from_this_chat": True, "modified_at": "2026-01-01T00:00:00Z",
                }]}
            elif suffix == "agent-context":
                context_type = kwargs["body"]["requests"][0]["type"]
                data = {
                    "ok": True, "tool_call_status": "completed",
                    "canvas_context_status": "resolved",
                    "responses": [{"type": context_type, "data": {}}], "errors": [],
                }
                if tool == "get_node_detail":
                    node = {"node_id": "n", "media_type": "image", "source_url": SOURCE_IMAGE}
                    if image_url is not None:
                        node["image_url"] = image_url
                    data["responses"][0]["data"]["nodes"] = [node]
            elif tool == "observe_workflow_run":
                data = {**summarize_workflow_run({
                    "run_id": "run_1", "status": "running", "actions": [],
                }), "changed": False}
            elif tool == "confirm_canvas_action" and decision_status != "executed":
                data = {"status": decision_status, "confirmation_id": CONFIRMATION_ID,
                        "run_id": "run_1", "actions": [], "bridge_key": "bridge-test"}
            else:
                data = original_request(method, path, **kwargs)["data"]
            return {"ok": True, "data": _with_link(tool, data) if api_link else data}

        monkeypatch.setattr(plugin, "_request", request)
        name = f"freezone_{tool}"
        result = index[name][1]({**args, **(extra or {})})
        return result, calls

    return plugin, index, call


@pytest.mark.parametrize("tool", CASES)
def test_bound_tools_forward_only_api_links_outside_product_chat(host, tool):
    _, _, call = host
    no_link, _ = call(tool)
    product_baseline, _ = call(tool, product=True)
    product, product_calls = call(tool, api_link=True, product=True)
    external, external_calls = call(tool, api_link=True)
    for result in (no_link, product, external):
        assert result["ok"] is True, result
    _assert_no_link(no_link)
    _assert_no_link(product)
    assert product == product_baseline
    assert len(external_calls) == len(product_calls) == 1

    if tool == "list_canvases":
        assert "canvas_url" not in external
        assert [row["canvas_url"] for row in external["canvases"]] == [LINK]
    else:
        assert external["canvas_url"] == LINK

    if CASES[tool][0] == "agent-context":
        assert external_calls[0]["body"]["include_canvas_url"] is True
        assert "include_canvas_url" not in product_calls[0]["body"]
    elif tool == "observe_workflow_run":
        flag = external_calls[0]["query"]["include_canvas_url"]
        assert str(flag).lower() == "true"
        assert "include_canvas_url" not in product_calls[0]["query"]


@pytest.mark.parametrize("tool", OUTSIDE)
def test_other_bound_tools_strip_api_links(host, tool):
    _, _, call = host
    result, calls = call(tool, api_link=True)
    assert result["ok"] is True, result
    assert len(calls) == 1
    _assert_no_link(result)
    if OUTSIDE[tool][0] == "agent-context":
        assert "include_canvas_url" not in calls[0]["body"]


@pytest.mark.parametrize("tool", CASES)
def test_bound_tools_do_not_echo_url_arguments(host, tool):
    _, _, call = host
    result, _ = call(tool, extra={"canvas_url": "https://argument.example"})
    _assert_no_link(result)


@pytest.mark.parametrize("status", ["running", "submitted"])
def test_bound_confirmation_forwards_links_for_in_progress_decisions(host, status):
    _, _, call = host
    result, _ = call("confirm_canvas_action", api_link=True, decision_status=status)
    assert result["ok"] is True and result["status"] == status, result
    assert result["canvas_url"] == LINK


@pytest.mark.parametrize("tool", CASES)
def test_published_schema_accepts_success_with_or_without_canvas_url(host, tool):
    _, index, call = host
    name = f"freezone_{tool}"
    schema = dramaclaw_mcp._output_schema_for_tool(name, index)
    validator = Draft202012Validator(schema)
    result, _ = call(tool)
    assert result["ok"] is True, result
    baseline = dramaclaw_mcp._normalize_structured_result(schema, result)
    validator.validate(baseline)
    expected = _with_link(tool, baseline)
    assert schema["properties"]["canvas_url"]["type"] == "string"
    validator.validate({**baseline, "canvas_url": LINK})
    validator.validate(expected)
    linked, _ = call(tool, api_link=True)
    structured = dramaclaw_mcp._normalize_structured_result(schema, linked)
    validator.validate(structured)
    if tool == "list_canvases":
        assert structured["canvases"] == expected["canvases"]
    else:
        assert structured["canvas_url"] == LINK


@pytest.mark.parametrize("tool", OUTSIDE)
def test_other_published_schemas_reject_canvas_url(host, tool):
    _, index, call = host
    name = f"freezone_{tool}"
    schema = dramaclaw_mcp._output_schema_for_tool(name, index)
    result, _ = call(tool)
    baseline = dramaclaw_mcp._normalize_structured_result(schema, result)
    validator = Draft202012Validator(schema)
    assert result["ok"] is True, result
    validator.validate(baseline)
    assert not validator.is_valid(_with_link(tool, baseline))


@pytest.mark.parametrize("product", [False, True])
def test_canvas_url_allowlist_and_description_guidance(monkeypatch, product):
    # Descriptions are fixed when the tool process loads the plugin, like other host guidance.
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    if product:
        monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-1")
    else:
        monkeypatch.delenv("DRAMACLAW_TURN_ID", raising=False)
    plugin = _load_plugin_module(api_executor=True)
    expected = {f"freezone_{tool}" for tool in CASES}
    descriptions = {name: schema["description"] for name, schema, _ in plugin.TOOLS}
    assert expected <= descriptions.keys()
    assert plugin._CANVAS_URL_TOOLS == expected
    guided = {name for name, desc in descriptions.items() if GUIDANCE in desc}
    image_guided = {name for name, desc in descriptions.items() if IMAGE_GUIDANCE in desc}
    assert guided == (set() if product else expected - {NODE_DETAIL_TOOL})
    assert image_guided == (set() if product else {NODE_DETAIL_TOOL})
    assert not any(LEGACY_GUIDANCE in desc for desc in descriptions.values())
    assert all(descriptions[name].endswith(GUIDANCE) for name in guided)
    assert all(descriptions[name].endswith(IMAGE_GUIDANCE) for name in image_guided)


@pytest.mark.parametrize("api_link", [True, False])
def test_create_canvas_external_link_instruction(host, api_link):
    _, _, call = host
    result, _ = call("create_canvas", api_link=api_link)
    assert result["ok"] is True, result
    expected = (
        f"Give the user this link exactly as given: {LINK}" if api_link else
        "No page link is available. Do not compose an address; tell the user the canvas name "
        "and canvas_id instead."
    )
    assert result["agent_instruction"].endswith(expected)


def test_create_canvas_product_chat_keeps_relative_link_instruction(host):
    _, _, call = host
    result, _ = call("create_canvas", api_link=True, product=True)
    assert result["ok"] is True, result
    assert result["canvas_path"] == "/projects/p/freezone?canvas=c"
    link = "[Plan](/projects/p/freezone?canvas=c)"
    assert result["canvas_link_markdown"] == link
    assert result["agent_instruction"].endswith(
        f"Show the user this link to the new canvas exactly as given: {link}"
    )
    _assert_no_link(result)


@pytest.mark.parametrize("tool", [
    tool for tool, (suffix, _) in (CASES | OUTSIDE).items() if suffix == "agent-context"
])
def test_only_external_node_detail_requests_signed_images(host, tool):
    _, _, call = host
    external, [external_request] = call(tool)
    product, [product_request] = call(tool, product=True)
    assert external["ok"] and product["ok"]
    assert "include_image_urls" not in product_request["body"]
    if tool == "get_node_detail":
        assert external_request["body"]["include_image_urls"] is True
    else:
        assert "include_image_urls" not in external_request["body"]


@pytest.mark.parametrize("image_url", [None, SIGNED_IMAGE], ids=["absent", "signed"])
def test_node_detail_forwards_only_api_image_and_schema_accepts_it(host, image_url):
    _, index, call = host
    result, [request] = call("get_node_detail", image_url=image_url, extra={"image_url": FORGED})
    assert result["ok"] is True, result
    assert '"image_url"' not in json.dumps(request["body"])
    assert FORGED not in json.dumps(request["body"])
    assert FORGED not in json.dumps(result)
    node = {"node_id": "n", "media_type": "image", "source_url": SOURCE_IMAGE}
    if image_url is not None:
        node["image_url"] = image_url
    assert result["responses"][0]["data"]["nodes"] == [node]

    schema = dramaclaw_mcp._output_schema_for_tool(NODE_DETAIL_TOOL, index)
    assert "image_url" not in schema["properties"]
    structured = dramaclaw_mcp._normalize_structured_result(schema, result)
    Draft202012Validator(schema).validate(structured)
    assert structured["responses"][0]["data"]["nodes"] == [node]


@pytest.mark.parametrize(("product", "api_link"), [
    pytest.param(False, False, id="external-unset"),
    pytest.param(False, True, id="external-configured"),
    pytest.param(True, True, id="product-configured"),
])
def test_pending_confirmation_canvas_url_and_schema(host, product, api_link):
    _, index, call = host
    tool = "emit_canvas_command"
    result, [_] = call(tool, pending=True, product=product, api_link=api_link)
    assert result["ok"] is True and result["status"] == "confirmation_required", result
    schema = dramaclaw_mcp._output_schema_for_tool(f"freezone_{tool}", index)
    structured = dramaclaw_mcp._normalize_structured_result(schema, result)
    Draft202012Validator(schema).validate(structured)

    if api_link and not product:
        assert result["canvas_url"] == structured["canvas_url"] == LINK
    else:
        assert "canvas_url" not in result
        assert "canvas_url" not in structured
