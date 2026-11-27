"""Guards for how the DramaClaw MCP server publishes the two canvas command tools.

``freezone_emit_canvas_command`` and ``freezone_validate_canvas_commands`` validate each
command against an 18-branch ``oneOf`` in the plugin registry. Published as is, that
schema is about twice Codex's default ``tool_input_schema_max_bytes`` (5000). Codex then
strips every description and, still over budget, collapses all nested structure, so the
model would see ``commands`` with no fields at all. The server therefore publishes a flat
projection generated from the registry: one object holding the union of all command
fields, plus one description listing what each command type requires. The server keeps
validating every call against the registry, so what it accepts does not change.

``codex_schema_compaction`` (next to this module) ports Codex's schema pipeline; see its
docstring for the Codex version and the size measure. ``scripts/check_workflow_agent_contracts.py``
covers the workflow MCP server only, so the JSON Schema meta-validation of these two
tools lives here.

The snapshot fixture pins, as SHA-256 of compact JSON in original key order, the
registry ``parameters`` of the two tools and the published ``inputSchema`` of every other
tool. Regenerate it with ``uv run python tests/test_canvas_command_schema_publication.py``
after an intended change, and commit the fixture diff together with that change.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable, Iterator
from unittest import mock

import pytest
from jsonschema import Draft202012Validator
from mcp.shared.memory import create_connected_server_and_client_session

from codex_schema_compaction import (
    DEFAULT_MAX_BYTES,
    codex_tool_parameters,
    parse_schema,
    prepare,
    prepared_size,
)
from novelvideo.chat import dramaclaw_mcp, mcp_runtime

CANVAS_TOOLS = ("freezone_emit_canvas_command", "freezone_validate_canvas_commands")
# The product raises Codex's budget to this value for its own turns.
PRODUCT_MAX_BYTES = 65536
# Room left for new command types or fields before the published schema nears the cliff.
HEADROOM_BYTES = 500
PROFILES = {"freezone": "freezone_canvas", "dramaclaw": ""}
SNAPSHOT = (
    Path(__file__).parent / "fixtures" / "canvas_command_publication_snapshot.json"
)
REFRESH = "uv run python tests/test_canvas_command_schema_publication.py"
_COMPOSITIONS = ("anyOf", "oneOf", "allOf")

# One valid command per registry branch; the coverage test names any branch left out.
VALID_COMMANDS: dict[str, dict[str, Any]] = {
    "html_artifact": {
        "type": "html_artifact",
        "action": "create",
        "title": "Board",
        "html": "<p>board</p>",
        "client_id": "board",
        "position": {"x": 0, "y": 0},
        "reference_node_ids": ["n1"],
    },
    "create_text_node": {
        "type": "create_node",
        "node_type": "textAnnotationNode",
        "client_id": "note",
        "position": {"x": 10, "y": 20},
        "data": {"displayName": "Title", "content": "Body"},
    },
    "create_node": {
        "type": "create_node",
        "node_type": "imageGenNode",
        "client_id": "image",
        "data": {"prompt": "a cat"},
    },
    "add_next_node": {
        "type": "add_next_node",
        "source_node_id": "n1",
        "node_type": "videoNode",
        "connect": True,
        "data": {},
    },
    "update_node_data": {
        "type": "update_node_data",
        "node_id": "n1",
        "data": {"prompt": "a dog"},
    },
    "delete_nodes": {"type": "delete_nodes", "node_ids": ["n1"]},
    "clear_canvas": {"type": "clear_canvas"},
    "delete_edges_by_id": {"type": "delete_edges", "edge_ids": ["e1"]},
    "delete_edges_by_pair": {
        "type": "delete_edges",
        "pairs": [{"source": "n1", "target": "n2"}],
    },
    "create_edge": {
        "type": "create_edge",
        "source": "n1",
        "target": "n2",
        "link_type": "media_input_for",
    },
    "layout_nodes": {"type": "layout_nodes", "mode": "grid", "node_ids": ["n1", "n2"]},
    "group_nodes": {"type": "group_nodes", "node_ids": ["n1", "n2"], "label": "Group"},
    "move_nodes_to": {"type": "move_nodes", "positions": {"n1": {"x": 1, "y": 2}}},
    "move_nodes_by": {"type": "move_nodes", "deltas": {"n1": {"x": 1, "y": 2}}},
    "select_nodes": {"type": "select_nodes", "node_ids": ["n1"], "focus": True},
    "run_node_action": {
        "type": "run_node_action",
        "node_id": "n1",
        "action": "generate",
        "parameters": {},
    },
    "open_mainline_projection": {"type": "open_mainline_projection", "request": {}},
    "run_workflow": {
        "type": "run_workflow",
        "scope": "canvas",
        "direction": "downstream",
    },
}

# Typical rejections that mix or bend branches; mutations of VALID_COMMANDS add the rest.
MIXED_COMMANDS: dict[str, Any] = {
    "move_nodes_positions_and_deltas": [
        {
            "type": "move_nodes",
            "positions": {"n1": {"x": 1, "y": 2}},
            "deltas": {"n1": {"x": 1, "y": 2}},
        }
    ],
    "delete_edges_ids_and_pairs": [
        {
            "type": "delete_edges",
            "edge_ids": ["e1"],
            "pairs": [{"source": "n1", "target": "n2"}],
        }
    ],
    "add_next_node_with_position": [
        {"type": "add_next_node", "source_node_id": "n1", "position": {"x": 0, "y": 0}}
    ],
    "html_artifact_with_node_type": [
        {"type": "html_artifact", "action": "create", "node_type": "htmlArtifactNode"}
    ],
    "text_node_without_title": [
        {
            "type": "create_node",
            "node_type": "textAnnotationNode",
            "data": {"content": "Body"},
        }
    ],
    "text_node_without_content": [
        {
            "type": "create_node",
            "node_type": "textAnnotationNode",
            "data": {"displayName": "T"},
        }
    ],
    "create_group_node": [{"type": "create_node", "node_type": "groupNode"}],
    "run_workflow_without_target": [{"type": "run_workflow"}],
    "run_workflow_selection_without_nodes": [
        {"type": "run_workflow", "scope": "selection"}
    ],
    "unknown_type": [{"type": "explode"}],
    "missing_type": [
        {
            "node_type": "textAnnotationNode",
            "data": {"displayName": "T", "content": "Body"},
        }
    ],
    "legacy_camel_case": [{"command": "create_node", "nodeType": "textAnnotationNode"}],
    "empty_command": [{}],
    "second_command_invalid": [{"type": "clear_canvas"}, {"type": "delete_nodes"}],
    "commands_not_an_array": "create a node",
}


def _digest(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


@contextmanager
def _profile(mode: str) -> Iterator[mcp_runtime.ToolIndex]:
    """Load one agent profile's plugin fresh, with optional tool families at defaults."""
    env = {
        "DRAMACLAW_PROJECT_ID": "publication-project",
        "DRAMACLAW_CANVAS_ID": "publication-canvas",
        "DRAMACLAW_TOOL_MODE": mode,
    }
    with ExitStack() as stack:
        stack.enter_context(mock.patch.dict(os.environ, env))
        for name in ("DRAMACLAW_AGENT_PROFILE", "SUPERTALE_OPENFILM_STUDIO_ENABLED"):
            os.environ.pop(name, None)
        stack.enter_context(mock.patch.object(dramaclaw_mcp, "_PLUGIN_CACHE", {}))
        stack.enter_context(mock.patch.object(dramaclaw_mcp, "_PLUGIN_TOOL_CACHE", {}))
        stack.enter_context(
            mock.patch.object(dramaclaw_mcp, "_EXCLUDE_STORY_TOOLS", False)
        )
        yield dramaclaw_mcp._agent_tools()


def _load(mode: str) -> tuple[mcp_runtime.ToolIndex, dict[str, Any]]:
    with _profile(mode) as index:
        tools = {tool.name: tool for tool in dramaclaw_mcp.build_mcp_tools(index)}
    return index, tools


@pytest.fixture(scope="module")
def freezone() -> tuple[mcp_runtime.ToolIndex, dict[str, Any]]:
    return _load(PROFILES["freezone"])


def _snapshot() -> dict[str, Any]:
    return json.loads(SNAPSHOT.read_text())


def _current_snapshot() -> dict[str, Any]:
    snapshot: dict[str, Any] = {
        "_comment": (
            "SHA-256 of compact JSON (original key order). Regenerate with "
            f"`{REFRESH}`; see tests/test_canvas_command_schema_publication.py."
        ),
        "published_input_schemas": {},
    }
    for profile, mode in PROFILES.items():
        index, tools = _load(mode)
        if profile == "freezone":
            snapshot["registry_parameters"] = {
                name: _digest(index[name][0]["parameters"]) for name in CANVAS_TOOLS
            }
        snapshot["published_input_schemas"][profile] = {
            name: _digest(tool.inputSchema)
            for name, tool in sorted(tools.items())
            if name not in CANVAS_TOOLS
        }
    return snapshot


def _nodes(schema: Any, path: str = "$") -> Iterator[tuple[str, dict[str, Any]]]:
    """Every subschema with the instance path it constrains."""
    if not isinstance(schema, dict):
        return
    yield path, schema
    for key in _COMPOSITIONS:
        for variant in schema.get(key) or []:
            yield from _nodes(variant, path)
    for name, child in (schema.get("properties") or {}).items():
        yield from _nodes(child, f"{path}.{name}")
    if isinstance(schema.get("items"), dict):
        yield from _nodes(schema["items"], f"{path}[]")
    if isinstance(schema.get("additionalProperties"), dict):
        yield from _nodes(schema["additionalProperties"], f"{path}{{}}")


def _paths(schema: Any) -> set[str]:
    return {path for path, _ in _nodes(schema)}


def _literals(schema: dict[str, Any]) -> list[Any]:
    if "const" in schema:
        return [schema["const"]]
    return list(schema.get("enum") or [])


def _branches(parameters: dict[str, Any]) -> list[dict[str, Any]]:
    return parameters["properties"]["commands"]["items"]["oneOf"]


def _command_type(branch: dict[str, Any]) -> str:
    (value,) = _literals(branch["properties"]["type"])
    return value


def _required_names(schema: dict[str, Any]) -> set[str]:
    """Fields a schema requires, including alternatives and inside required objects."""
    properties = schema.get("properties") or {}
    names = set(schema.get("required") or [])
    for alternative in schema.get("anyOf") or []:
        names |= _required_names({"properties": properties, **alternative})
    for name in list(names):
        if isinstance(properties.get(name), dict):
            names |= _required_names(properties[name])
    return names


def _mentions(text: str, word: Any) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(str(word))}(?![\w-])", text) is not None


def _type_segments(description: str, types: list[str]) -> dict[str, str]:
    starts = {}
    for command_type in types:
        found = list(re.finditer(rf"(?<!\w){re.escape(command_type)}: ", description))
        assert len(found) == 1, (command_type, description)
        starts[command_type] = found[0].start()
    ordered = sorted(starts, key=starts.__getitem__)
    ends = [starts[t] for t in ordered[1:]] + [len(description)]
    return {t: description[starts[t] : end] for t, end in zip(ordered, ends)}


@pytest.mark.parametrize("name", CANVAS_TOOLS)
def test_published_schema_fits_codex_default_budget(name, freezone):
    _, tools = freezone
    size = prepared_size(tools[name].inputSchema)
    cliff = (
        f"Past {DEFAULT_MAX_BYTES} bytes Codex first strips every description, which "
        "drops the per-type requirements, and if the schema is still too large it "
        "collapses every nested structure at once: commands[] items become {} and the "
        "model sees none of the command fields (a cliff, not a gradual loss)."
    )
    assert size <= DEFAULT_MAX_BYTES, (
        f"{name} publishes {size} bytes in Codex's normalized measure, over the "
        f"default budget of {DEFAULT_MAX_BYTES}. {cliff}"
    )
    assert size <= DEFAULT_MAX_BYTES - HEADROOM_BYTES, (
        f"{name} publishes {size} bytes, leaving {DEFAULT_MAX_BYTES - size} of the "
        f"{HEADROOM_BYTES}-byte headroom this guard keeps under Codex's default budget. "
        f"{cliff} Shorten the generated description or the registry wording before "
        "adding more."
    )


@pytest.mark.parametrize("name", CANVAS_TOOLS)
def test_published_schema_keeps_every_command_field(name, freezone):
    index, tools = freezone
    registry = index[name][0]["parameters"]
    published = tools[name].inputSchema
    assert _paths(published) == _paths(registry)

    items = published["properties"]["commands"]["items"]
    assert not set(items) & set(
        _COMPOSITIONS
    ), "commands[] items must be one flat object"
    branches = _branches(registry)
    types = list(dict.fromkeys(_command_type(branch) for branch in branches))
    assert items["properties"]["type"]["enum"] == types
    assert items["required"] == ["type"]
    assert items["additionalProperties"] is False

    description = items.get("description") or ""
    segments = _type_segments(description, types)
    for branch in branches:
        command_type = _command_type(branch)
        missing = sorted(
            field
            for field in _required_names(branch) - {"type"}
            if not _mentions(segments[command_type], field)
        )
        assert not missing, (command_type, missing, segments[command_type])

    published_literals: dict[str, set[str]] = {}
    for path, node in _nodes(published):
        published_literals.setdefault(path, set()).update(
            map(json.dumps, _literals(node))
        )
    for path, node in _nodes(registry):
        for value in _literals(node):
            if json.dumps(value) not in published_literals.get(path, set()):
                assert _mentions(description, value), (
                    f"{path} allows {value!r} in the registry, but the published schema "
                    "neither lists it in an enum at that path nor names it in the "
                    "commands[] description"
                )


@pytest.mark.parametrize("budget", [DEFAULT_MAX_BYTES, PRODUCT_MAX_BYTES])
@pytest.mark.parametrize("name", CANVAS_TOOLS)
def test_codex_compaction_leaves_published_schema_intact(name, budget, freezone):
    """Codex only normalizes the schema (it never carries keywords such as minLength);
    none of its compaction passes may run."""
    _, tools = freezone
    published = tools[name].inputSchema
    trace: list[tuple[str, int]] = []
    sent = codex_tool_parameters(published, budget, trace)
    assert [step for step, _ in trace] == ["prepared"], trace
    assert sent == parse_schema(prepare(published))
    assert _paths(sent) == _paths(published)
    assert (
        sent["properties"]["commands"]["items"]["description"]
        == published["properties"]["commands"]["items"]["description"]
    )


@pytest.mark.parametrize("name", CANVAS_TOOLS)
def test_published_schema_is_valid_draft_2020_12(name, freezone):
    _, tools = freezone
    Draft202012Validator.check_schema(tools[name].inputSchema)


def test_canvas_registry_parameters_are_unchanged():
    with _profile(PROFILES["freezone"]) as index:
        before = {name: _digest(index[name][0]["parameters"]) for name in CANVAS_TOOLS}
        dramaclaw_mcp.build_mcp_tools(index)
        after = {name: _digest(index[name][0]["parameters"]) for name in CANVAS_TOOLS}
    assert (
        after == before
    ), "publishing must not modify the registry the server validates with"
    assert before == _snapshot()["registry_parameters"], (
        "The registry parameters of the canvas command tools differ from the snapshot. "
        "The server validates calls with them, and the flat schema it publishes is "
        "generated from them, so an intended registry change needs no publication edit: "
        f"refresh the snapshot with `{REFRESH}`, commit the fixture diff with the change, "
        "and make sure the size and field guards in this module still pass."
    )


@pytest.mark.parametrize("profile", PROFILES)
def test_other_tools_publish_unchanged(profile):
    expected = _snapshot()["published_input_schemas"][profile]
    _, tools = _load(PROFILES[profile])
    current = {
        name: _digest(tool.inputSchema)
        for name, tool in tools.items()
        if name not in CANVAS_TOOLS
    }
    changed = sorted(
        name
        for name in expected.keys() & current.keys()
        if expected[name] != current[name]
    )
    added = sorted(current.keys() - expected.keys())
    removed = sorted(expected.keys() - current.keys())
    assert not (changed or added or removed), (
        f"Published inputSchema in the {profile} profile differs from the snapshot: "
        f"changed={changed} added={added} removed={removed}. This guard pins that the "
        "flat canvas command publication touches no other tool. If you changed these "
        "tools on purpose (their registry parameters, or their publication in "
        "dramaclaw_mcp.build_mcp_tools), refresh the snapshot with "
        f"`{REFRESH}` and commit the fixture diff together with that change. "
        "Otherwise the canvas publication step has leaked into other tools."
    )


def _wrong_type(value: Any) -> Any:
    return 7 if isinstance(value, str) else "wrong-type"


def _behaviour_payloads(parameters: dict[str, Any]) -> dict[str, Any]:
    """Every registry branch with valid input, then typical rejections of each."""
    branches = _branches(parameters)
    union: list[str] = []
    for branch in branches:
        union += [field for field in branch["properties"] if field not in union]
    payloads: dict[str, Any] = {}
    for label, command in VALID_COMMANDS.items():
        payloads[label] = [command]
        (branch,) = [
            branch
            for branch in branches
            if Draft202012Validator(branch).is_valid(command)
        ]
        for field in branch.get("required") or []:
            payloads[f"{label}:missing:{field}"] = [
                {key: value for key, value in command.items() if key != field}
            ]
        for field, value in command.items():
            payloads[f"{label}:wrong_type:{field}"] = [
                {**command, field: _wrong_type(value)}
            ]
        foreign = next(field for field in union if field not in branch["properties"])
        payloads[f"{label}:extra:{foreign}"] = [
            {**command, foreign: command.get(foreign, "x")}
        ]
        payloads[f"{label}:extra:unexpected_field"] = [
            {**command, "unexpected_field": "x"}
        ]
    payloads["batch_with_client_alias"] = [
        VALID_COMMANDS["create_text_node"],
        {
            "type": "create_edge",
            "source": "note",
            "target": "n2",
            "link_type": "context_for",
        },
    ]
    payloads.update(MIXED_COMMANDS)
    return payloads


def _stub_index(
    index: mcp_runtime.ToolIndex, received: list[Any]
) -> mcp_runtime.ToolIndex:
    """Real registry schemas; handlers that record what reached them (the real ones
    talk to the canvas bridge)."""

    def handler(arguments: dict[str, Any]) -> str:
        received.append(deepcopy(arguments))
        return json.dumps(
            {
                "ok": True,
                "status": "stub_reached_handler",
                "command_id": "stub",
                "commands": [],
                "errors": [],
                "warnings": [],
            }
        )

    stubbed = dict(index)
    for name in CANVAS_TOOLS:
        stubbed[name] = (index[name][0], handler)
    return stubbed


async def _call_through_server(
    index: mcp_runtime.ToolIndex,
    build: Callable[[mcp_runtime.ToolIndex], list[Any]],
    payloads: dict[str, Any],
) -> tuple[dict[str, Any], dict[tuple[str, str], Any]]:
    """tools/list then tools/call on the real SERVER over an in-memory MCP session."""
    received: list[Any] = []
    stubbed = _stub_index(index, received)
    listed: dict[str, Any] = {}
    results: dict[tuple[str, str], Any] = {}
    with ExitStack() as stack:
        stack.enter_context(
            mock.patch.object(dramaclaw_mcp, "_agent_tools", lambda: stubbed)
        )
        stack.enter_context(mock.patch.object(dramaclaw_mcp, "build_mcp_tools", build))
        async with create_connected_server_and_client_session(
            dramaclaw_mcp.SERVER
        ) as client:
            for tool in (await client.list_tools()).tools:
                if tool.name in CANVAS_TOOLS:
                    listed[tool.name] = tool.inputSchema
            for name in CANVAS_TOOLS:
                for label, commands in payloads.items():
                    received.clear()
                    result = await client.call_tool(name, {"commands": commands})
                    results[name, label] = {
                        "isError": result.isError,
                        "structuredContent": result.structuredContent,
                        "content": [
                            block.model_dump(mode="json") for block in result.content
                        ],
                        "handler_received": deepcopy(received),
                    }
    return listed, results


async def test_flat_publication_does_not_change_what_the_server_accepts(
    freezone, monkeypatch
):
    """Baseline: the same calls with the registry published as is, which is what this
    server published before the flat projection. Both runs go through the real SERVER in
    one test run, so the comparison stays meaningful as the registry or the rejection
    messages evolve, without a recorded fixture to refresh."""
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "publication-project")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "publication-canvas")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", PROFILES["freezone"])
    index, _ = freezone
    registry = index[CANVAS_TOOLS[0]][0]["parameters"]
    for name in CANVAS_TOOLS[1:]:
        assert _branches(index[name][0]["parameters"]) == _branches(registry)

    branches = _branches(registry)
    uncovered = [
        index_
        for index_, branch in enumerate(branches)
        if not any(
            Draft202012Validator(branch).is_valid(c) for c in VALID_COMMANDS.values()
        )
    ]
    assert not uncovered, (
        f"registry command branches {uncovered} have no valid example in VALID_COMMANDS; "
        "add one so this comparison covers them"
    )
    payloads = _behaviour_payloads(registry)
    for label in [*VALID_COMMANDS, "batch_with_client_alias"]:
        assert Draft202012Validator(registry).is_valid(
            {"commands": payloads[label]}
        ), label
    for label in MIXED_COMMANDS:
        assert not Draft202012Validator(registry).is_valid(
            {"commands": payloads[label]}
        ), label

    as_is_listed, as_is = await _call_through_server(
        index, mcp_runtime.build_mcp_tools, payloads
    )
    listed, flat = await _call_through_server(
        index, dramaclaw_mcp.build_mcp_tools, payloads
    )

    differing = [key for key in as_is if as_is[key] != flat[key]]
    assert not differing, (len(differing), differing[:10])
    for (name, label), result in flat.items():
        accepted = not result["isError"] and bool(result["handler_received"])
        expected = Draft202012Validator(index[name][0]["parameters"]).is_valid(
            {"commands": payloads[label]}
        )
        assert accepted is expected, (name, label, result["structuredContent"])
        if not accepted:
            assert (
                result["structuredContent"]["error"] == "tool_arguments_invalid"
            ), label

    # The comparison only means something if the published schema really differs from
    # the registry: some calls it would let through must still be refused by the server.
    # It must never be stricter, or a client checking it would hold back valid calls.
    for name in CANVAS_TOOLS:
        assert listed[name] != as_is_listed[name]
        published = Draft202012Validator(listed[name])
        stricter = sorted(
            label
            for label, commands in payloads.items()
            if not flat[name, label]["isError"]
            and not published.is_valid({"commands": commands})
        )
        assert (
            not stricter
        ), f"{name}: the published schema refuses accepted calls {stricter}"
        looser = sorted(
            label
            for label, commands in payloads.items()
            if published.is_valid({"commands": commands})
            and flat[name, label]["isError"]
        )
        assert looser, f"{name}: no refused call is allowed by the published schema"


if __name__ == "__main__":
    SNAPSHOT.write_text(
        json.dumps(_current_snapshot(), indent=2, sort_keys=True) + "\n"
    )
    print(f"wrote {SNAPSHOT}")
