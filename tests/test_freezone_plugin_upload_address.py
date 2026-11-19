# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Upload address tools and the product-chat compatibility contract."""

import hashlib
import json
import logging
import re
import sys
import urllib.request
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp
from test_freezone_plugin import _restore_tools_registry_modules as _restore_tools_registry_modules
from test_freezone_plugin_canvas_create_tools import _Response, _payload

TOOL = "freezone_get_upload_address"
SCHEMA_TOOL = "freezone_get_node_create_schema"
SESSION = "test-fake-session-token-not-a-secret"
KEY = "test-fake-agent-key-not-a-secret"
TICKET = "test-fake-upload-ticket-not-a-secret"
MINT = "/api/v1/projects/proj/freezone/upload-address"
CONTEXT = "/api/v1/projects/proj/freezone/canvases/default/agent-context"
ADDRESS = f"https://upload.example.test/api/v1/projects/proj/freezone/upload?upload_ticket={TICKET}"
ADDRESS_DATA = {
    "upload_url": ADDRESS,
    "expires_in_seconds": 600,
    "method": "POST",
    "file_field": "file",
    "max_bytes": 123456,
    "allowed_suffixes": [".mxf", ".png"],
}
SCHEMA_ARGS = {"node_type": "uploadNode"}

# Captured from the product chat plugin and canvas worker at 6e0008c14.
PRODUCT_SCHEMA_BYTES = (
    '{"project_id": "proj", "canvas_id": "default", "tool_call_status": "completed", '
    '"canvas_context_status": "resolved", "ok": true, "responses": [{"type": "node_create_schema", '
    '"node_type": "uploadNode", "data": {"node_type": "uploadNode", '
    '"editable_fields": ["displayName"], '
    '"create_schema": {"displayName": {"type": "string", "label": "显示名称"}}, '
    '"stable_create_fields": ["displayName"], "dynamic_or_enum_fields": [], '
    '"instruction": "Choose a model, then request node_create_schema again with model_id before '
    'choosing model-dependent parameters. Use only fields declared in create_schema."}}], '
    '"errors": [], "message": "Frontend returned requested canvas context."}'
).encode()
ORIGINAL_INSTRUCTION = json.loads(PRODUCT_SCHEMA_BYTES)["responses"][0]["data"]["instruction"]
# Trimmed from the canvas worker's answers for the two node types at 63e8a0298.
MEDIA_NODE_SCHEMAS = {
    "videoNode": {
        "node_type": "videoNode",
        "editable_fields": ["displayName", "prompt", "generateAudio"],
        "create_schema": {
            "displayName": {"type": "string", "label": "显示名称"},
            "prompt": {"type": "string", "label": "提示词"},
            "generateAudio": {"type": "boolean", "label": "生成音频"},
        },
        "stable_create_fields": ["displayName", "prompt"],
        "dynamic_or_enum_fields": [],
        "instruction": ORIGINAL_INSTRUCTION,
    },
    "audioNode": {
        "node_type": "audioNode",
        "editable_fields": ["displayName", "text", "prompt"],
        "create_schema": {
            "displayName": {"type": "string", "label": "显示名称"},
            "text": {"type": "string", "label": "文本"},
            "prompt": {"type": "string", "label": "提示词"},
        },
        "stable_create_fields": ["displayName", "text", "prompt"],
        "dynamic_or_enum_fields": [],
        "instruction": ORIGINAL_INSTRUCTION,
    },
}
UPLOAD_FIELDS = {
    "uploadNode": {"imageUrl": "string", "previewImageUrl": "string", "sourceFileName": "string"},
    "videoNode": {"videoUrl": "string", "sourceFileName": "string", "referenceOnly": "boolean"},
    "audioNode": {"audioUrl": "string", "sourceFileName": "string"},
}
MEDIA_TERMS = (
    "uploadNode", "imageUrl", "previewImageUrl", "videoNode", "videoUrl", "referenceOnly",
    "audioNode", "audioUrl", "sourceFileName", "displayName",
)


def _server_schema_answer(node_type):
    answer = json.loads(PRODUCT_SCHEMA_BYTES)
    if node_type != "uploadNode":
        answer["responses"] = [{
            "type": "node_create_schema", "node_type": node_type,
            "data": json.loads(json.dumps(MEDIA_NODE_SCHEMAS[node_type])),
        }]
    return answer


def _assert_media_kinds_explained(instruction):
    for term in MEDIA_TERMS:
        assert term in instruction, term
    address = instruction.index(TOOL)
    upload = instruction.index("data.url", address)
    assert upload < instruction.index("freezone_create_node", upload)
    assert re.search(r"referenceOnly\W+(?:to |set to |is |= ?)?true", instruction)
    # An upload node holds images only.
    [rule] = [
        sentence for sentence in re.split(r"(?<=[.!?])\s+", instruction)
        if re.search(r"\b(?:never|must not|do not)\b", sentence, re.IGNORECASE)
        and "uploadNode" in sentence
    ]
    assert "videoUrl" in rule and "audioUrl" in rule


# SHA-256 of the ordered list of every tool name, description, and parameters.
PRODUCT_TOOLS_SHA256 = "1fb620a572005ae8054657d819e6303b7a79004b8d4c8364e7f9cac1d791c3d8"


@pytest.fixture
def load_host(monkeypatch):
    for name in ("tools", "tools.registry"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    for name, value in {
        "DRAMACLAW_API_URL": "http://api.example.test",
        "DRAMACLAW_AGENT_TOKEN": SESSION,
        "DRAMACLAW_AGENT_KEY": KEY,
        "DRAMACLAW_PROJECT_ID": "proj",
        "DRAMACLAW_CANVAS_ID": "default",
        "DRAMACLAW_TOOL_MODE": "freezone_canvas",
        "SUPERTALE_OPENFILM_STUDIO_ENABLED": "1",
    }.items():
        monkeypatch.setenv(name, value)
    for name in (
        "DRAMACLAW_AGENT_PROFILE", "DRAMACLAW_AGENT_TOKEN_FILE",
        "DRAMACLAW_AGENT_KEY_FILE", "DRAMACLAW_LOCAL_AGENT_TRUST",
    ):
        monkeypatch.delenv(name, raising=False)

    def load(*, product=False, executor="server", unavailable=False):
        host = SimpleNamespace(executor=executor, requests=[])
        if product:
            monkeypatch.delenv("DRAMACLAW_EXTERNAL_MCP", raising=False)
            monkeypatch.setenv("DRAMACLAW_TURN_ID", "turn-1")
        else:
            monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
            monkeypatch.delenv("DRAMACLAW_TURN_ID", raising=False)

        def urlopen(request, **_):
            parts = urlsplit(request.full_url)
            method = request.get_method()
            host.requests.append((method, parts.path))
            if (method, parts.path) == ("GET", "/api/v1/config"):
                response = {"ok": True, "data": {"agent_canvas_executor": host.executor}}
            elif (method, parts.path) == ("POST", MINT):
                assert request.get_header("Authorization") == f"Bearer {SESSION}"
                assert all(KEY not in value for _, value in request.header_items())
                assert not parts.query
                assert not request.data or json.loads(request.data) == {}
                response = {"ok": True, "data": ADDRESS_DATA}
                if unavailable:
                    response = {
                        "ok": False, "error": "Upload address unavailable",
                        "data": {"code": "upload_address_unavailable"},
                    }
            elif (method, parts.path) == ("POST", CONTEXT):
                [context_request] = json.loads(request.data)["requests"]
                assert context_request["type"] == "node_create_schema"
                assert set(context_request) == {"type", "node_type"}
                response = {"ok": True, "data": _server_schema_answer(context_request["node_type"])}
            else:
                pytest.fail(f"Unexpected API request {method} {parts.path}")
            return _Response(200, json.dumps(response).encode())

        monkeypatch.setattr(urllib.request, "urlopen", urlopen)
        host.plugin = dramaclaw_mcp._load_plugin("freezone")
        host.index = dramaclaw_mcp._tool_index(host.plugin)
        host.tools = {tool.name: tool for tool in dramaclaw_mcp.build_mcp_tools(host.index)}
        return host

    return load


def _handler(host):
    assert TOOL in host.index, f"{TOOL} is missing from the external tool registry"
    return host.index[TOOL][1]


async def _call(host):
    _handler(host)
    result = await dramaclaw_mcp.call_tool(TOOL, {"project_id": "proj"}, tool_index=host.index)
    data = result.structuredContent
    Draft202012Validator(host.tools[TOOL].outputSchema).validate(data)
    return data


async def test_external_server_publishes_upload_tool_and_returns_address(load_host):
    host = load_host()
    assert TOOL in host.tools, f"{TOOL} is missing from the published MCP tools"
    schema = host.tools[TOOL].inputSchema
    assert set(schema["properties"]) == {"project_id"}
    assert schema["properties"]["project_id"]["type"] == "string"
    assert schema["additionalProperties"] is False

    result = await _call(host)
    assert result["ok"] is True
    assert result["status"] == "ready"
    assert result["project_id"] == "proj"
    assert {key: result[key] for key in ADDRESS_DATA} == ADDRESS_DATA
    assert result["usage_example"] == f'curl -sS -X POST -F "file=@/path/to/image.png" "{ADDRESS}"'
    instruction = result["agent_instruction"]
    _assert_media_kinds_explained(instruction)
    for term in ("local", "reus", "expir", "user"):
        assert term in instruction.lower()
    assert host.requests.count(("POST", MINT)) == 1


async def test_external_upload_address_unavailable_falls_back_to_browser(load_host):
    host = load_host(unavailable=True)
    result = await _call(host)
    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["code"] == "upload_address_unavailable"
    assert "upload_url" not in json.dumps(result)
    assert "user" in result["message"].lower()
    assert "browser" in result["message"].lower()
    assert host.requests.count(("POST", MINT)) == 1


async def test_external_upload_instruction_explains_request_limit(load_host):
    result = await _call(load_host())
    assert result["max_bytes"] == ADDRESS_DATA["max_bytes"]
    instruction = result["agent_instruction"].lower()
    assert "max_bytes" in instruction
    assert re.search(r"(?:whole|entire|total|full) (?:multipart )?(?:upload )?(?:request|body)", instruction)
    assert re.search(r"file(?: itself| size)?[^.!?]*(?:smaller|below|less than)", instruction)


def test_product_chat_tool_list_matches_pre_upload_contract(load_host):
    host = load_host(product=True)
    assert TOOL not in host.tools
    contract = [
        (name, schema["description"], schema["parameters"])
        for name, (schema, _) in host.index.items()
    ]
    encoded = json.dumps(contract, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert len(contract) == 71
    assert hashlib.sha256(encoded.encode()).hexdigest() == PRODUCT_TOOLS_SHA256


def test_product_chat_upload_node_create_schema_matches_pre_upload_bytes(load_host):
    host = load_host(product=True)
    result = host.index[SCHEMA_TOOL][1](SCHEMA_ARGS)
    assert result.encode() == PRODUCT_SCHEMA_BYTES


def test_external_browser_refuses_upload_address_like_canvas_list(load_host):
    host = load_host()
    handler = _handler(host)
    host.executor = "browser"
    host.plugin._AGENT_CANVAS_EXECUTOR_CACHE = None
    listing = _payload(host.index["freezone_list_canvases"][1]({}))
    result = _payload(handler({"project_id": "proj"}))
    assert result["ok"] is listing["ok"] is False
    assert result["code"] == listing["code"] == "canvas_server_executor_required"
    assert result["retryable"] is listing["retryable"] is False
    assert all(path == "/api/v1/config" for _, path in host.requests)
    # Listing does not depend on a network read at import; the call is what is refused.
    assert TOOL in load_host(executor="browser").tools


async def test_external_address_does_not_expose_credentials_or_log_ticket(load_host, caplog):
    caplog.set_level(logging.DEBUG)
    host = load_host()
    assert TOOL in host.tools, f"{TOOL} is missing from the published MCP tools"
    schema = host.tools[TOOL].inputSchema
    assert set(schema["properties"]) == {"project_id"}
    result = await _call(host)
    assert result["upload_url"] == ADDRESS
    rendered = json.dumps(result)
    for secret in (SESSION, KEY):
        assert secret not in rendered
    for secret in (SESSION, KEY, TICKET):
        assert secret not in caplog.text


def test_external_server_upload_node_schema_explains_upload_sequence(load_host):
    host = load_host()
    result = _payload(host.index[SCHEMA_TOOL][1](SCHEMA_ARGS))
    assert result["ok"] is True
    [response] = result["responses"]
    schema = response["data"]
    fields = {"imageUrl", "previewImageUrl", "sourceFileName"}
    assert fields <= schema["create_schema"].keys()
    assert fields <= set(schema["stable_create_fields"])
    assert schema["editable_fields"] == ["displayName"]
    instruction = schema["instruction"]
    address = instruction.index(TOOL)
    upload = instruction.index("data.url", address)
    assert upload < instruction.index("imageUrl", upload)
    assert "previewImageUrl" in instruction[upload:]


@pytest.mark.parametrize("node_type", ["videoNode", "audioNode"])
def test_external_server_media_node_schema_lists_upload_fields(load_host, node_type):
    host = load_host()
    result = _payload(host.index[SCHEMA_TOOL][1]({"node_type": node_type}))
    assert result["ok"] is True
    [response] = result["responses"]
    schema = response["data"]
    original = MEDIA_NODE_SCHEMAS[node_type]
    fields = UPLOAD_FIELDS[node_type]
    assert {name: schema["create_schema"][name]["type"] for name in fields} == fields
    assert all(schema["create_schema"][name]["label"] for name in fields)
    assert schema["stable_create_fields"] == [*original["stable_create_fields"], *fields]
    # Node updates do not accept the upload fields.
    assert schema["editable_fields"] == original["editable_fields"]
    assert {
        name: spec for name, spec in schema["create_schema"].items() if name not in fields
    } == original["create_schema"]
    # Generation guidance stays; the upload order is added to it.
    assert schema["instruction"].startswith(original["instruction"])
    _assert_media_kinds_explained(schema["instruction"])


def test_external_server_upload_node_schema_names_every_media_kind(load_host):
    host = load_host()
    result = _payload(host.index[SCHEMA_TOOL][1](SCHEMA_ARGS))
    schema = result["responses"][0]["data"]
    assert set(UPLOAD_FIELDS["uploadNode"]) <= schema["create_schema"].keys()
    assert not {"videoUrl", "audioUrl"} & schema["create_schema"].keys()
    _assert_media_kinds_explained(schema["instruction"])


@pytest.mark.parametrize("node_type", ["videoNode", "audioNode"])
def test_product_chat_media_node_create_schema_is_passed_through(load_host, node_type):
    host = load_host(product=True)
    result = host.index[SCHEMA_TOOL][1]({"node_type": node_type})
    expected = json.dumps(_server_schema_answer(node_type), ensure_ascii=False)
    assert result.encode() == expected.encode()


@pytest.mark.parametrize("command_type,extra", [
    ("create_node", {}),
    ("add_next_node", {"source_node_id": "source"}),
])
@pytest.mark.parametrize("field,node_type", [("videoUrl", "videoNode"), ("audioUrl", "audioNode")])
def test_external_refuses_new_upload_node_holding_video_or_audio(
    load_host, command_type, extra, field, node_type,
):
    host = load_host()
    address = "/static/projects/proj/freezone/uploads/file.bin"
    command = {"type": command_type, "node_type": "uploadNode", "data": {field: address}, **extra}
    refusal = _payload(host.plugin._validate_write_commands_shape("proj", "default", [command]))
    assert refusal["ok"] is False
    assert refusal["status"] == "upload_node_media_kind"
    assert "commands[0]" in refusal["error"]
    assert node_type in refusal["error"] and field in refusal["error"]
    # Refused before anything is sent to the server.
    assert all(path == "/api/v1/config" for _, path in host.requests)

    created = _payload(host.index["freezone_create_node"][1]({
        "project_id": "proj", "canvas_id": "default", "node_type": "uploadNode",
        "data": {field: address},
    }))
    assert created["ok"] is False
    assert created["status"] == "upload_node_media_kind"
    assert all(path == "/api/v1/config" for _, path in host.requests)


def test_upload_node_media_kind_rule_leaves_other_commands_alone(load_host):
    address = "/static/projects/proj/freezone/uploads/file.bin"
    host = load_host()
    accepted = [
        {"type": "create_node", "node_type": "uploadNode",
         "data": {"imageUrl": address, "previewImageUrl": address, "videoUrl": None, "audioUrl": ""}},
        {"type": "create_node", "node_type": "videoNode",
         "data": {"videoUrl": address, "referenceOnly": True}},
        {"type": "create_node", "node_type": "audioNode", "data": {"audioUrl": address}},
        # Stored nodes are not rewritten or refused.
        {"type": "update_node_data", "node_id": "old", "data": {"displayName": "Old"}},
    ]
    assert host.plugin._validate_write_commands_shape("proj", "default", accepted) is None
    # Product chat keeps its behaviour.
    product = load_host(product=True)
    legacy = [{"type": "create_node", "node_type": "uploadNode", "data": {"videoUrl": address}}]
    assert product.plugin._validate_write_commands_shape("proj", "default", legacy) is None
