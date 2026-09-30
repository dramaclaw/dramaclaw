"""Tool-name policy has one source and matches the tools the Hermes plugins publish."""

from __future__ import annotations

import ast
import importlib.util
import sys
import types
from pathlib import Path

import pytest

from novelvideo.chat import (
    display_fallback,
    hermes_sdk,
    presentation_mapping,
    runtime_event_evidence,
    service,
    tool_policy,
)

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _restore_tools_registry_modules():
    """Keep dynamic Hermes plugin imports from leaking across test modules/workers."""

    sentinel = object()
    previous = {
        name: sys.modules.get(name, sentinel) for name in ("tools", "tools.registry")
    }
    yield
    for name, value in previous.items():
        if value is sentinel:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = value


def _load_hermes_plugin(plugin_name: str):
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.tool_error = lambda value: value
    registry_module.tool_result = lambda value: value
    sys.modules["tools"] = tools_module
    sys.modules["tools.registry"] = registry_module
    path = ROOT / ".hermes" / "plugins" / plugin_name / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        f"test_tool_policy_{plugin_name}_plugin", path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _published_tool_names(plugin) -> set[str]:
    return {
        entry[0]
        for entry in getattr(plugin, "TOOLS", ())
        if isinstance(entry, tuple) and len(entry) == 3 and isinstance(entry[0], str)
    }


def _imported_module_names(module) -> list[str]:
    tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names.append(node.module or "")
        elif isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
    return names


def test_tool_policy_is_a_stdlib_only_leaf() -> None:
    assert not any(
        name.startswith("novelvideo") for name in _imported_module_names(tool_policy)
    )


def test_freezone_policy_names_are_published_by_the_freezone_plugin() -> None:
    published = _published_tool_names(_load_hermes_plugin("freezone"))
    for policy in (
        tool_policy.FREEZONE_CANVAS_WRITE_TOOLS,
        tool_policy.FREEZONE_TERMINAL_WRITE_TOOLS,
        tool_policy.FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS,
        tool_policy.FREEZONE_WORKFLOW_DRAFT_TOOLS,
        tool_policy.AGENT_PRODUCT_RESULT_TOOLS,
    ):
        assert set(policy) <= published, sorted(set(policy) - published)


def test_mainline_policy_names_are_published_by_the_dramaclaw_plugin() -> None:
    published = _published_tool_names(_load_hermes_plugin("dramaclaw"))
    for policy in (tool_policy.DRAMACLAW_WRITE_TOOLS, tool_policy.DISPLAY_TOOL_NAMES):
        assert set(policy) <= published, sorted(set(policy) - published)


def test_every_plugin_canvas_mutation_is_classified_as_a_canvas_write() -> None:
    """A new bridge-backed canvas tool must be added to the write policy explicitly."""
    plugin = _load_hermes_plugin("freezone")
    mutations = set(plugin._CANVAS_RESULT_TOOLS) - {"freezone_cancel_canvas_action"}
    assert mutations <= tool_policy.FREEZONE_CANVAS_WRITE_TOOLS, sorted(
        mutations - tool_policy.FREEZONE_CANVAS_WRITE_TOOLS
    )


def test_policy_sets_are_internally_consistent() -> None:
    assert (
        tool_policy.FREEZONE_TERMINAL_WRITE_TOOLS
        <= tool_policy.FREEZONE_CANVAS_WRITE_TOOLS
    )
    assert (
        tool_policy.FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS
        < tool_policy.FREEZONE_WORKFLOW_DRAFT_TOOLS
    )
    assert "freezone_confirm_workflow_draft" in tool_policy.FREEZONE_CANVAS_WRITE_TOOLS
    assert not (tool_policy.DISPLAY_TOOL_NAMES & tool_policy.DRAMACLAW_WRITE_TOOLS)


def test_consumers_share_the_policy_objects_instead_of_copies() -> None:
    assert service._AGENT_PRODUCT_RESULT_TOOLS is tool_policy.AGENT_PRODUCT_RESULT_TOOLS
    assert (
        service._FREEZONE_CANVAS_WRITE_TOOLS is tool_policy.FREEZONE_CANVAS_WRITE_TOOLS
    )
    assert (
        runtime_event_evidence._FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS
        is tool_policy.FREEZONE_WORKFLOW_DRAFT_PREPARE_TOOLS
    )
    assert hermes_sdk._DRAMACLAW_WRITE_TOOLS is tool_policy.DRAMACLAW_WRITE_TOOLS
    assert (
        hermes_sdk._FREEZONE_CANVAS_WRITE_TOOLS
        is tool_policy.FREEZONE_CANVAS_WRITE_TOOLS
    )
    assert (
        hermes_sdk._FREEZONE_TERMINAL_WRITE_TOOLS
        is tool_policy.FREEZONE_TERMINAL_WRITE_TOOLS
    )
    assert display_fallback._DISPLAY_TOOL_NAMES is tool_policy.DISPLAY_TOOL_NAMES
    assert presentation_mapping._HIDDEN_TOOL_MARKERS is tool_policy.HIDDEN_TOOL_MARKERS


def test_hidden_tool_policy_keeps_legacy_entrypoint_behaviour() -> None:
    assert tool_policy.is_hidden_chat_tool_event("skill_view", "")
    assert tool_policy.is_hidden_chat_tool_event(None, "→ skills list")
    assert not tool_policy.is_hidden_chat_tool_event("freezone_create_node", "→ create")
    assert presentation_mapping._is_hidden_chat_tool_event("skill_view", "") is True
    assert service._is_hidden_chat_tool_event("freezone_create_node", "x") is False


def test_hermes_adapter_treats_confirm_canvas_action_as_a_canvas_write() -> None:
    """The adapter used to keep a 15-name copy that lacked this bridge-backed tool.

    A confirm call waits on the browser bridge like any other canvas write, so the
    adapter must extend the idle deadline for it instead of timing out early.
    """
    assert hermes_sdk._is_freezone_canvas_write_tool("freezone_confirm_canvas_action")
    assert hermes_sdk._is_freezone_canvas_write_tool(
        "dramaclaw.freezone_confirm_canvas_action"
    )
    assert not hermes_sdk._is_freezone_canvas_write_tool(
        "freezone_cancel_canvas_action"
    )
    assert not hermes_sdk._is_freezone_canvas_write_tool("freezone_get_canvas_context")
