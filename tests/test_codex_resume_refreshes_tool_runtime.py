"""Regression test for stale per-turn Agent credentials in a loaded Codex thread.

Run from the repository root with:
    PYTHONDONTWRITEBYTECODE=1 uv run pytest -q -p no:cacheprovider --tb=line \
        tests/test_codex_resume_refreshes_tool_runtime.py

The test uses a real, isolated Codex App Server and two local HTTP servers with
fake credentials. It does not contact a real model gateway or application API.
CODEX_BIN must point to the DramaClaw-patched Codex runtime, exactly as the
application requires; the SDK's bundled stock binary is never used, and the test
is skipped when CODEX_BIN is unset. Without the loaded-thread refresh in
``backend_sdk._start_or_resume_codex_thread`` the second turn fails with the
tool's token-not-configured error; with it both turns use their own credential.
"""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))

from novelvideo import config as app_config  # noqa: E402
from novelvideo.chat import backend_sdk, codex_app_server, service  # noqa: E402
from test_codex_app_server import (  # noqa: E402
    _recording_responses_gateway,
    _response_completed,
    _response_created,
    _responses_sse,
)


def _tool_call(turn: int, namespace: str, name: str) -> bytes:
    response_id = f"response-{turn}"
    return _responses_sse(
        _response_created(response_id),
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": f"call-{turn}",
                "namespace": namespace,
                "name": name,
                "arguments": "{}",
            },
        },
        _response_completed(response_id),
    )


def _reply(turn: int) -> bytes:
    response_id = f"final-{turn}"
    return _responses_sse(
        _response_created(response_id),
        {
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": f"message-{turn}",
                "content": [{"type": "output_text", "text": "已读取。"}],
            },
        },
        _response_completed(response_id),
    )


@contextmanager
def _fake_project_api(kind: str):
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler callback
            # Only test credentials are supplied; never log the header itself.
            header = self.headers.get("Authorization")
            received.append(
                "first"
                if header == "Bearer test-turn-one"
                else "second" if header == "Bearer test-turn-two" else "unknown"
            )
            data = (
                {"revision": 1, "nodes": [], "edges": []}
                if kind == "story"
                else {"tasks": [], "count": 0}
            )
            body = json.dumps({"ok": True, "data": data}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", received
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def _write_token(path: Path, value: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)


@pytest.fixture
def isolated_codex_ipc(monkeypatch):
    # macOS Unix sockets have a short path limit. Use a separate short root
    # instead of the running application's shared /tmp/claymore-<uid> directory.
    with tempfile.TemporaryDirectory(prefix="sttk-", dir="/tmp") as path:
        monkeypatch.setattr(codex_app_server, "_control_dir", lambda: Path(path))
        yield


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["story", "project"])
async def test_current_turn_credentials_when_previous_thread_is_subscribed(
    kind,
    monkeypatch,
    tmp_path,
    isolated_codex_ipc,
):
    """Both Agent MCP servers must use the second turn's credential."""
    if kind == "story":
        namespace = "mcp__dramaclaw_interactive_story"
        tool_name = "dramaclaw_get_freezone_canvas"
        mode = "freezone_canvas"
    else:
        namespace = "mcp__dramaclaw"
        tool_name = "dramaclaw_list_tasks"
        mode = "default"

    responses = [
        _tool_call(1, namespace, tool_name),
        _reply(1),
        _tool_call(2, namespace, tool_name),
        _reply(2),
    ]
    token_root = tmp_path / "runtime" / "codex" / "turn_tokens"
    first_token = token_root / "turn-one.token"
    second_token = token_root / "turn-two.token"
    _write_token(first_token, "test-turn-one")
    _write_token(second_token, "test-turn-two")

    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setattr(app_config, "RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setattr(app_config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(app_config, "OUTPUT_DIR", str(tmp_path / "output"))
    # The production model selector can consult the user's settings database;
    # this deterministic mock has no reason to read or update that database.
    monkeypatch.setattr(service, "_codex_model", lambda: "DC-codex-agent-LLM")
    monkeypatch.setattr(service, "_codex_reasoning_effort", lambda: "low")
    monkeypatch.delenv("DRAMACLAW_CODEX_MODEL_CATALOG_FILE", raising=False)
    # Do not allow an inherited local-trust or legacy environment token to mask
    # a missing file. These values belong to this subprocess only.
    monkeypatch.delenv("DRAMACLAW_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("DRAMACLAW_LOCAL_AGENT_TRUST", raising=False)
    monkeypatch.delenv("DRAMACLAW_CE_OWNER", raising=False)

    with _fake_project_api(kind) as (api_url, received):
        with _recording_responses_gateway(responses) as (gateway_url, requests):
            configured = os.environ.get("CODEX_BIN", "").strip()
            if not configured:
                pytest.skip(
                    "CODEX_BIN must point to the DramaClaw-patched Codex runtime"
                )
            codex_bin = Path(configured).expanduser()
            assert codex_bin.is_file(), f"Codex binary not found: {codex_bin}"
            env = {
                # Only carry the runtime essentials. Do not copy real model
                # keys, Agent credentials, proxies, or application settings.
                "PATH": os.environ.get("PATH", os.defpath),
                "HOME": str(tmp_path),
                "TMPDIR": str(tmp_path),
                "LANG": "C.UTF-8",
                "CODEX_HOME": str(tmp_path / "codex-home"),
                "DRAMACLAW_API_URL": api_url,
                "DRAMACLAW_PROJECT_ID": "test-project",
                "DRAMACLAW_CANVAS_ID": "test-canvas",
                "DRAMACLAW_USERNAME": "local",
                "DRAMACLAW_TOOL_MODE": mode,
                "DRAMACLAW_ROOT": str(ROOT),
                "DRAMACLAW_AGENT_TOKEN_FILE": str(first_token),
                "NOVELVIDEO_OUTPUT_DIR": str(tmp_path / "output"),
                "NOVELVIDEO_RUNTIME_DIR": str(tmp_path / "runtime"),
                "NOVELVIDEO_STATE_DIR": str(tmp_path / "state"),
                "PYTHONPATH": str(ROOT / "src"),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            overrides = service._codex_mcp_config_overrides(
                service._dramaclaw_mcp_servers(mode)
            )

            def new_client(turn_env):
                return backend_sdk.CodexClient(
                    codex_bin=codex_bin,
                    cwd=tmp_path,
                    env=turn_env,
                    model="DC-codex-agent-LLM",
                    model_provider="dramaclaw_gateway",
                    developer_instructions="Use the requested tool.",
                    config_overrides=service._codex_gateway_config_overrides(
                        gateway_url
                    ),
                    thread_config_overrides=overrides,
                    turn_metadata={"dramaclaw_gateway_api_key": "test-gateway-key"},
                )

            try:
                first = new_client(env).thread_start()
                first_events = [
                    event async for event in first.stream("读取测试项目的状态")
                ]
                first_calls = [
                    event for event in first_events if event.type == "tool_updated"
                ]
                assert (
                    len(first_calls) == 1
                    and (first_calls[0].structured or {}).get("ok") is True
                ), f"first turn tool failed: {first_calls}"
                assert received == [
                    "first"
                ], "first request did not use the first test credential"
                first_token.unlink()

                from openai_codex import CodexConfig

                config = CodexConfig(
                    codex_bin=str(codex_bin),
                    cwd=str(tmp_path),
                    env=env,
                    config_overrides=service._codex_gateway_config_overrides(
                        gateway_url
                    ),
                )
                # Keep a second connection subscribed to the first thread so it
                # stays loaded with its original MCP process while turn two starts.
                with codex_app_server.shared_codex(config) as keeper:
                    assert keeper.thread_resume(first.id).id == first.id
                    next_env = {**env, "DRAMACLAW_AGENT_TOKEN_FILE": str(second_token)}
                    second = new_client(next_env).thread_resume(first.id)
                    events = [
                        event async for event in second.stream("继续读取测试项目的状态")
                    ]
            finally:
                codex_app_server.stop_shared_codex_runtime()

    calls = [event for event in events if event.type == "tool_updated"]
    assert len(calls) == 1, f"expected one second-turn tool call, got {len(calls)}"
    result = calls[0].structured or {}
    assert calls[0].status == "completed" and result.get("ok") is True, (
        f"second turn {tool_name} failed: {result.get('error') or result!r}; "
        f"simulated API request markers: {received!r}"
    )
    assert received == [
        "first",
        "second",
    ], f"second turn must use its own credential, got request markers {received!r}"
    history = json.dumps(requests[-2]["body"]["input"], ensure_ascii=False)
    assert "读取测试项目的状态" in history
    assert "继续读取测试项目的状态" in history
