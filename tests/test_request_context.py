from __future__ import annotations

import asyncio
import importlib.util
import os
import subprocess
import sys
import threading
from pathlib import Path
from textwrap import dedent

import pytest

_PLUGIN_ROOT = Path(__file__).resolve().parents[1] / ".hermes" / "plugins"
_PLUGIN_NAMES = ("dramaclaw", "freezone")
_TIMEOUT = 10


def _load_by_path(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _values(label):
    return {
        "DRAMACLAW_AGENT_KEY": f"fake-key-{label}",
        "DRAMACLAW_AGENT_TOKEN": f"fake-token-{label}",
        "DRAMACLAW_USERNAME": f"user-{label}",
        "DRAMACLAW_PROJECT_ID": f"project-{label}",
        "DRAMACLAW_CANVAS_ID": f"canvas-{label}",
        "DRAMACLAW_TURN_ID": f"turn-{label}",
    }


@pytest.fixture(autouse=True)
def process_env(monkeypatch, tmp_path):
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *args, **kwargs: False)
    for name in (
        "DRAMACLAW_AGENT_KEY_FILE",
        "DRAMACLAW_AGENT_TOKEN_FILE",
        "DRAMACLAW_TOOL_MODE_FILE",
        "DRAMACLAW_USER",
        "SUPERTALE_USER",
        "FREEZONE_USER",
        "HERMES_HOME",
    ):
        monkeypatch.delenv(name, raising=False)
    values = {
        **_values("process"),
        "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR": str(tmp_path / "process-bridge"),
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    return values


@pytest.fixture
def plugin_loader(monkeypatch):
    from novelvideo.chat import dramaclaw_mcp

    monkeypatch.delenv("DRAMACLAW_ROOT", raising=False)
    for name in ("tools", "tools.registry"):
        monkeypatch.setitem(sys.modules, name, None)
        del sys.modules[name]
    dramaclaw_mcp._install_hermes_registry_shim()
    return dramaclaw_mcp._load_plugin


def _story_canvas():
    from novelvideo.chat import story_tools

    def read_outline(method, path, *, query):
        return query["canvas_id"]

    tools = story_tools.build_tools(
        schema=lambda *args, **kwargs: {"parameters": {}},
        request=read_outline,
        project_from_args=lambda args: "fake-project",
        tool_result=str,
        tool_error=pytest.fail,
    )
    handlers = {name: handler for name, _, handler in tools}
    return handlers["dramaclaw_get_interactive_story_outline"]({})


def _read_project_canvas_turn(freezone):
    return [
        freezone._default_project_id(),
        freezone._default_canvas_id(),
        freezone._canvas_agent_identity()[1],
    ]


def test_no_scope_uses_process_environment(process_env, monkeypatch, plugin_loader):
    from novelvideo.chat import request_context, workflow_mcp
    from novelvideo.freezone import canvas_command_bridge
    from novelvideo.freezone.agent_workflows import catalog

    missing = "DRAMACLAW_TEST_MISSING"
    monkeypatch.delenv(missing, raising=False)
    fallback = object()
    assert not request_context.active()
    assert request_context.get(missing) == os.environ.get(missing) is None
    assert request_context.get(missing, fallback) is os.environ.get(missing, fallback)
    assert (
        request_context.get("DRAMACLAW_USERNAME", fallback)
        == process_env["DRAMACLAW_USERNAME"]
    )
    monkeypatch.setenv(missing, "")
    assert (
        request_context.get(missing, fallback)
        == os.environ.get(missing, fallback)
        == ""
    )

    dramaclaw = plugin_loader("dramaclaw")
    freezone = plugin_loader("freezone")
    assert _read_project_canvas_turn(freezone) == [
        "project-process",
        "canvas-process",
        "turn-process",
    ]
    assert dramaclaw._current_agent_token() == "fake-token-process"
    assert dramaclaw._agent_key_configured()
    assert workflow_mcp._username() == catalog._catalog_username() == "user-process"
    assert canvas_command_bridge._bridge_dir() == Path(
        process_env["DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR"]
    )
    assert _story_canvas() == "canvas-process"


def test_nested_scope_replaces_and_restores_environment_readers(
    tmp_path, plugin_loader, monkeypatch
):
    from novelvideo.chat import request_context, workflow_mcp
    from novelvideo.freezone import canvas_command_bridge
    from novelvideo.freezone.agent_workflows import catalog

    dramaclaw = plugin_loader("dramaclaw")
    freezone = plugin_loader("freezone")
    outer = {
        **_values("outer"),
        "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR": str(tmp_path / "outer-bridge"),
    }
    monkeypatch.setattr(
        canvas_command_bridge.tempfile, "gettempdir", lambda: str(tmp_path)
    )
    with request_context.scope(outer):
        outer["DRAMACLAW_PROJECT_ID"] = "mutated-project"
        assert request_context.active()
        assert request_context.get("DRAMACLAW_PROJECT_ID") == "project-outer"
        assert _read_project_canvas_turn(freezone) == [
            "project-outer",
            "canvas-outer",
            "turn-outer",
        ]
        assert dramaclaw._current_agent_token() == "fake-token-outer"
        assert dramaclaw._agent_key_configured()
        assert workflow_mcp._username() == catalog._catalog_username() == "user-outer"
        assert canvas_command_bridge._bridge_dir() == tmp_path / "outer-bridge"
        assert _story_canvas() == "canvas-outer"

        with request_context.scope({"DRAMACLAW_CANVAS_ID": "canvas-inner"}):
            assert request_context.active()
            assert request_context.get("DRAMACLAW_PROJECT_ID", "missing") == "missing"
            assert _read_project_canvas_turn(freezone) == ["", "canvas-inner", None]
            assert dramaclaw._current_agent_token() == ""
            assert not dramaclaw._agent_key_configured()
            assert workflow_mcp._username() == catalog._catalog_username() == "local"
            assert _story_canvas() == "canvas-inner"
            assert (
                canvas_command_bridge._bridge_dir()
                == tmp_path / "supertale_canvas_command_bridge"
            )

        with request_context.scope({}):
            assert request_context.active()
            assert _story_canvas() == "default"

        assert _read_project_canvas_turn(freezone) == [
            "project-outer",
            "canvas-outer",
            "turn-outer",
        ]

    assert not request_context.active()
    assert request_context.get("DRAMACLAW_PROJECT_ID") == "project-process"
    assert _read_project_canvas_turn(freezone) == [
        "project-process",
        "canvas-process",
        "turn-process",
    ]
    assert dramaclaw._current_agent_token() == "fake-token-process"


async def test_overlapping_threaded_tool_calls_keep_request_values(
    plugin_loader, monkeypatch
):
    from novelvideo.chat import mcp_runtime, request_context, workflow_mcp

    dramaclaw = plugin_loader("dramaclaw")
    freezone = plugin_loader("freezone")
    key_session = dramaclaw._SHARED_AGENT_KEY_SESSION
    monkeypatch.setattr(key_session, "_LOCKS", {})
    monkeypatch.setattr(key_session, "_CACHE", {})
    monkeypatch.setattr(key_session, "_SECRETS", set())
    # Capture the value read by the real key-session request before any network operation.
    monkeypatch.setattr(
        key_session,
        "_exchange",
        lambda api_base, key, *args: {"key": key},
    )
    barrier = threading.Barrier(2, timeout=_TIMEOUT)

    def read_values(_arguments):
        barrier.wait()
        exchange = key_session.request(
            api_base="https://request-context.invalid",
            api_path="/api/v1/projects",
            method="GET",
            query_string="",
            payload=None,
            headers={},
            timeout=_TIMEOUT,
            opener=pytest.fail,
            decode_success=pytest.fail,
            shape_http_error=pytest.fail,
        )
        return {
            "ok": True,
            "values": [
                exchange["key"],
                dramaclaw._current_agent_token(),
                workflow_mcp._username(),
                *_read_project_canvas_turn(freezone),
            ],
        }

    tools = {
        "read_values": (
            {
                "output_schema": {
                    "type": "object",
                    "properties": {"values": {"type": "array"}},
                }
            },
            read_values,
        )
    }

    async def read_in_scope(label, *, via_mcp):
        with request_context.scope(_values(label)):
            if via_mcp:
                result = await mcp_runtime.call_tool(
                    "read_values", {}, tool_index=tools
                )
                assert result.isError is False
                return result.structuredContent["values"]
            result = await asyncio.to_thread(read_values, {})
            return result["values"]

    first, second = await asyncio.gather(
        read_in_scope("first", via_mcp=False),
        read_in_scope("second", via_mcp=True),
    )
    assert first == list(_values("first").values())
    assert second == list(_values("second").values())


def test_all_package_and_plugin_loaders_share_scope(plugin_loader):
    from novelvideo.chat import request_context, workflow_mcp

    from test_freezone_plugin import _load_plugin_module

    copies = [
        _load_by_path(
            f"context_copy_{name}", _PLUGIN_ROOT / name / "_request_context.py"
        )
        for name in _PLUGIN_NAMES
    ]
    dramaclaw_by_path, freezone_by_path = (
        _load_by_path(f"plugin_copy_{name}", _PLUGIN_ROOT / name / "__init__.py")
        for name in _PLUGIN_NAMES
    )
    dramaclaw_mcp = plugin_loader("dramaclaw")
    freezone_mcp = plugin_loader("freezone")
    freezone_native = _load_plugin_module()
    for context in (request_context, *copies):
        with context.scope(_values("shared")):
            assert workflow_mcp._username() == "user-shared"
            for plugin in (dramaclaw_by_path, dramaclaw_mcp):
                assert plugin._current_agent_token() == "fake-token-shared"
            for plugin in (freezone_by_path, freezone_mcp, freezone_native):
                assert _read_project_canvas_turn(plugin) == [
                    "project-shared",
                    "canvas-shared",
                    "turn-shared",
                ]


def test_plugins_share_scope_without_application_package(tmp_path):
    script = dedent("""
        import importlib.util
        import sys
        import types
        from pathlib import Path

        sys.modules["novelvideo"] = None
        tools = types.ModuleType("tools")
        registry = types.ModuleType("tools.registry")
        registry.tool_result = registry.tool_error = str
        tools.registry = registry
        sys.modules["tools"] = tools
        sys.modules["tools.registry"] = registry
        root = Path(sys.argv[1])

        def load(name, path):
            spec = importlib.util.spec_from_file_location(name, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module

        dramaclaw = load("standalone_drama", root / "dramaclaw" / "__init__.py")
        freezone = load("standalone_zone", root / "freezone" / "__init__.py")
        dramaclaw_context = load("standalone_ctx_drama", root / "dramaclaw" / "_request_context.py")
        freezone_context = load("standalone_ctx_zone", root / "freezone" / "_request_context.py")
        with dramaclaw_context.scope({"DRAMACLAW_PROJECT_ID": "standalone-project"}):
            assert freezone._default_project_id() == "standalone-project"
        with freezone_context.scope({"DRAMACLAW_AGENT_TOKEN": "fake-token-standalone"}):
            assert dramaclaw._current_agent_token() == "fake-token-standalone"
        assert freezone._default_project_id() == "project-process"
        assert dramaclaw._current_agent_token() == "fake-token-process"
        """)
    subprocess.run(
        [sys.executable, "-I", "-c", script, str(_PLUGIN_ROOT)],
        cwd=tmp_path,
        check=True,
        timeout=_TIMEOUT,
    )


def test_batch_dispatcher_keeps_submit_scope_after_exit(plugin_loader, monkeypatch):
    from novelvideo.chat import request_context

    dramaclaw = plugin_loader("dramaclaw")
    allow_submit = threading.Event()
    observed = []

    def available_slots(project, queue_kind):
        if not allow_submit.wait(timeout=_TIMEOUT):
            raise TimeoutError
        return 1

    def submit_item(beat):
        observed.append((beat, dramaclaw._current_agent_token()))
        return {"ok": True}

    monkeypatch.setattr(dramaclaw, "_batch_available_slots", available_slots)
    try:
        with request_context.scope(_values("submit")):
            dramaclaw._launch_capacity_aware_batch_dispatcher(
                batch_id="fake-batch",
                project="project-submit",
                queue_kind="video",
                pending=[1],
                submit_item=submit_item,
            )
            thread = dramaclaw._AGENT_BATCH_DISPATCHERS["fake-batch"]
    finally:
        allow_submit.set()

    thread.join(timeout=_TIMEOUT)
    assert thread.daemon
    assert not thread.is_alive()
    assert observed == [(1, "fake-token-submit")]
