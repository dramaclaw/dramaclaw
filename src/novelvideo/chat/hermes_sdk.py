"""Hermes chat backend SDK adapter.

Speaks ACP (Agent Client Protocol — agentclientprotocol.com) over stdin/stdout
JSON-RPC to a sandboxed ``hermes acp`` subprocess. Same shape as
ClaudeSdkClient / CodexClient so chat_service.py can dispatch uniformly.

Public:
    HermesSdkClient   — holds spawn config (cli_path, cwd, env, model)
    HermesSdkThread   — one session; yields ChatBackendEvent on stream()

See docs/hermes-acp-protocol.md for the full protocol.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

from novelvideo.security import SandboxSpec, wrap_command
from novelvideo.chat.backend_sdk import ChatBackendEvent

_log = logging.getLogger(__name__)

# How long to wait for the ACP initialize response before giving up.
INITIALIZE_TIMEOUT = 30.0
# How long to wait for hermes to produce a session/new response.
SESSION_NEW_TIMEOUT = 90.0  # cold start runs startup probes (vision/aux); allow them to finish


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


# Per-line stdout read timeout while streaming a prompt. Freezone canvas write
# tools can legitimately block while the browser validates/applies commands, so
# keep this longer than the canvas bridge wait to avoid premature "(hermes timed out)".
CANVAS_COMMAND_RESULT_TIMEOUT = _env_float("DRAMACLAW_CANVAS_COMMAND_RESULT_TIMEOUT_SECONDS", 600.0)
HERMES_STDIO_LINE_LIMIT_BYTES = max(
    65536,
    _env_int("DRAMACLAW_HERMES_STDIO_LINE_LIMIT_BYTES", 4 * 1024 * 1024),
)
STREAM_READ_TIMEOUT = max(
    180.0,
    CANVAS_COMMAND_RESULT_TIMEOUT + 30.0,
    _env_float("HERMES_STREAM_READ_TIMEOUT_SECONDS", 0.0),
)
try:
    TURN_TOOL_CALL_LIMIT = max(1, int(os.environ.get("HERMES_TURN_TOOL_CALL_LIMIT", "20")))
except ValueError:
    TURN_TOOL_CALL_LIMIT = 20
FREEZONE_TURN_TOOL_CALL_LIMIT = max(
    TURN_TOOL_CALL_LIMIT,
    80,
)
TOOL_DETAIL_LIMIT = 1600
PERMISSION_REQUEST_TIMEOUT_SECONDS = 60.0
CONTENT_FILTER_MESSAGE = (
    "本轮回复被模型网关的内容安全过滤拦截了，虾导没有拿到可用输出。"
    "请把需求拆得更具体，避免一次性要求完成整集或包含敏感/违规描述；"
    "也可以先让我只列当前制作进度和下一步。"
)
DRAMACLAW_ONE_STEP_STOP_MESSAGE = (
    "当前任务已开始处理。请稍后让我查看当前任务进度，或在任务完成后再继续下一步。"
)
DRAMACLAW_WRITE_FAILED_STOP_MESSAGE = (
    "刚才这一步没有成功启动任务。请先根据返回的错误补齐前置条件；"
    "如果是配音缺少声线，可以到「虾塘」上传或录制缺失声线后再继续。"
)

_DRAMACLAW_WRITE_TOOLS = {
    "dramaclaw_post",
    "dramaclaw_patch",
    "dramaclaw_delete",
    "dramaclaw_build_characters",
    "dramaclaw_plan_episodes",
    "dramaclaw_generate_script",
    "dramaclaw_update_character_face_prompt",
    "dramaclaw_plan_identities",
    "dramaclaw_plan_scenes",
    "dramaclaw_plan_props",
    "dramaclaw_generate_scene_master",
    "dramaclaw_generate_scene_reverse",
    "dramaclaw_generate_sketches",
    "dramaclaw_detect_sketch_identities",
    "dramaclaw_optimize_video_global",
    "dramaclaw_generate_audio",
    "dramaclaw_render_first_frames",
    "dramaclaw_compose_episode",
    "dramaclaw_generate_portrait",
    "dramaclaw_generate_identity_image",
    "dramaclaw_start_single_video",
    "dramaclaw_run_freezone_skill",
    "dramaclaw_save_freezone_canvas",
    "dramaclaw_delete_freezone_canvas",
    "dramaclaw_create_freezone_canvas_from_preset",
}

_FREEZONE_CANVAS_WRITE_TOOLS = {
    "freezone_emit_canvas_command",
    "freezone_create_workflow_graph",
    "freezone_create_node",
    "freezone_add_next_node",
    "freezone_update_node_data",
    "freezone_create_edge",
    "freezone_delete_nodes",
    "freezone_delete_edges",
    "freezone_move_nodes",
    "freezone_layout_nodes",
    "freezone_group_nodes",
    "freezone_select_nodes",
    "freezone_open_mainline_projection",
    "freezone_run_node_action",
}
FREEZONE_FAILED_WRITE_RETRY_LIMIT = 1

_TOOL_DETAIL_FIELDS = (
    ("command", "命令"),
    ("cmd", "命令"),
    ("arguments", "参数"),
    ("args", "参数"),
    ("input", "输入"),
    ("preview", "预览"),
    ("content", "内容"),
)


def _first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _split_tool_title(title: object) -> tuple[str, str]:
    text = str(title or "").strip()
    if not text:
        return "tool", ""
    head, sep, tail = text.partition(":")
    if sep and head.strip():
        return head.strip(), tail.strip()
    return text.split()[0].strip() or "tool", text


def _redact_tool_detail(text: str) -> str:
    text = re.sub(
        r"(?i)(api[_-]?key|token|authorization|password|secret)(['\"\s:=]+)[^'\"\s,}]+",
        r"\1\2***",
        text,
    )
    text = re.sub(r"(?i)(bearer\s+)[a-z0-9._~+/=-]+", r"\1***", text)
    return text


def _compact_tool_detail(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value.strip()
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except TypeError:
            text = str(value)
    text = _redact_tool_detail(text.strip())
    if len(text) > TOOL_DETAIL_LIMIT:
        return f"{text[:TOOL_DETAIL_LIMIT]}..."
    return text


def _has_content_filter_signal(value: object) -> bool:
    if isinstance(value, str):
        lowered = value.lower()
        return "content_filter" in lowered or "content filter triggered" in lowered
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() == "finish_reason" and str(item).lower() == "content_filter":
                return True
            if _has_content_filter_signal(item):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(_has_content_filter_signal(item) for item in value)
    return False


def _is_dramaclaw_write_tool(name: object) -> bool:
    return str(name or "").strip() in _DRAMACLAW_WRITE_TOOLS


def _is_freezone_tool(name: object) -> bool:
    return str(name or "").strip().startswith("freezone_")


def _turn_tool_call_limit_for_tool(name: object) -> int:
    if _is_freezone_tool(name):
        return FREEZONE_TURN_TOOL_CALL_LIMIT
    return TURN_TOOL_CALL_LIMIT


def _tool_call_limit_stop_message(name: object) -> str:
    if _is_freezone_tool(name):
        return (
            "本轮操作已停止：虾画连续调用工具过多，可能在重复读取或修改 Skill Studio 草稿。"
            "请缩小修改范围，例如只调整 Skill 元信息，或只调整某一个 Recipe。"
        )
    return (
        "本轮操作已停止：虾导连续调用工具过多，可能在自动推进过大范围。"
        "请缩小指令范围，例如只检查前置条件，或只启动一个具体 beat 的视频任务。"
    )


def _should_stop_after_write_tool(first_write_tool: str | None, next_tool_name: object) -> bool:
    return _is_dramaclaw_write_tool(first_write_tool) and _is_dramaclaw_write_tool(next_tool_name)


def _is_freezone_canvas_write_tool(name: object) -> bool:
    return str(name or "").strip() in _FREEZONE_CANVAS_WRITE_TOOLS


def _can_retry_failed_canvas_write(
    first_write_tool: str | None,
    next_tool_name: object,
    *,
    first_write_failed: bool,
    failed_write_retry_count: int,
) -> bool:
    return (
        first_write_failed
        and failed_write_retry_count < FREEZONE_FAILED_WRITE_RETRY_LIMIT
        and _is_freezone_canvas_write_tool(first_write_tool)
        and _is_freezone_canvas_write_tool(next_tool_name)
    )


def _is_failed_tool_update(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    status = str(value.get("status") or "").strip().lower()
    if status in {"failed", "error", "cancelled", "canceled"}:
        return True
    for key in ("error", "message", "result"):
        item = value.get(key)
        if isinstance(item, dict):
            if item.get("ok") is False:
                return True
            if str(item.get("status") or "").strip().lower() in {"failed", "error"}:
                return True
    return False


def _should_mark_first_write_failed(
    first_write_tool: str | None,
    active_tool_name: str | None,
    update: object,
) -> bool:
    return (
        first_write_tool is not None
        and active_tool_name == first_write_tool
        and _is_failed_tool_update(update)
    )


def _format_tool_call_text(update: dict, title: object) -> str:
    lines = [f"→ {title}"]
    seen: set[str] = set()
    for key, label in _TOOL_DETAIL_FIELDS:
        if key in seen:
            continue
        value = update.get(key)
        if value in (None, "", [], {}):
            continue
        detail = _compact_tool_detail(value)
        if detail:
            lines.append(f"{label}: {detail}")
            seen.add(key)
    return "\n".join(lines)


class HermesSdkClient:
    """Holds spawn configuration for a hermes worker subprocess.

    Each HermesSdkThread reuses this client (cli_path/cwd/env are constant
    per-user), but spawns a fresh subprocess. Hermes' own ACP session
    semantics (resume/fork) live on the thread.
    """

    def __init__(
        self,
        *,
        cli_path: Path,
        cwd: Path,
        env: dict[str, str],
        model: str | None,
        username: str,
    ) -> None:
        self._cli_path = cli_path
        self._cwd = cwd
        self._env = env
        self._model = (model or "").strip() or None
        self._username = username

    def thread_start(self) -> "HermesSdkThread":
        return HermesSdkThread(
            cli_path=self._cli_path,
            cwd=self._cwd,
            env=self._env,
            model=self._model,
            username=self._username,
            session_id=None,
        )

    def thread_resume(self, session_id: str) -> "HermesSdkThread":
        return HermesSdkThread(
            cli_path=self._cli_path,
            cwd=self._cwd,
            env=self._env,
            model=self._model,
            username=self._username,
            session_id=(session_id or "").strip() or None,
        )


class HermesSdkThread:
    """One ACP session against a sandboxed hermes subprocess.

    Lifecycle:
        1. stream() lazily spawns hermes-acp on first call
        2. JSON-RPC: initialize → session/new (or session/resume) → session/prompt
        3. notifications surfaced as ChatBackendEvent
        4. on close, terminate subprocess + revoke the control-plane agent
           session (caller's responsibility in HermesPool)
    """

    def __init__(
        self,
        *,
        cli_path: Path,
        cwd: Path,
        env: dict[str, str],
        model: str | None,
        username: str,
        session_id: str | None,
    ) -> None:
        self._cli_path = cli_path
        self._cwd = cwd
        self._env = env
        self._model = model
        self._username = username
        self.id: str = session_id or ""
        self._is_new = session_id is None
        self._proc: asyncio.subprocess.Process | None = None
        self._req_counter = 0
        self._closed = False
        self._initialized = False
        self._tool_names_by_call_id: dict[str, str] = {}
        self._tool_inputs_by_call_id: dict[str, Any] = {}
        self._pending_permissions: dict[
            str, tuple[str | int, set[str], float, str]
        ] = {}
        # Serializes the spawn→initialize→session prologue so a background
        # warm() and the first real stream() can't interleave on the shared
        # JSON-RPC stdio. Whichever runs first pays the cold start; the other
        # awaits it and then proceeds against the ready session.
        self._setup_lock = asyncio.Lock()

    def _next_id(self) -> int:
        self._req_counter += 1
        return self._req_counter

    async def _send(self, method: str, params: dict[str, Any]) -> int:
        if self._proc is None or self._proc.stdin is None:
            raise RuntimeError("hermes subprocess not started")
        req_id = self._next_id()
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        line = json.dumps(msg) + "\n"
        self._proc.stdin.write(line.encode("utf-8"))
        await self._proc.stdin.drain()
        return req_id

    async def resolve_permission(self, request_id: str | int, option_id: str) -> bool:
        """Resolve one server-initiated ACP permission request."""
        if self._proc is None or self._proc.stdin is None:
            return False
        key = str(request_id)
        pending = self._pending_permissions.get(key)
        if pending is None:
            return False
        original_id, allowed_options, expires_at, _turn_id = pending
        if time.monotonic() >= expires_at:
            self._pending_permissions.pop(key, None)
            return False
        if option_id not in allowed_options:
            return False
        response = {
            "jsonrpc": "2.0",
            "id": original_id,
            "result": {
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id,
                }
            },
        }
        self._proc.stdin.write((json.dumps(response) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()
        self._pending_permissions.pop(key, None)
        return True

    def _clear_pending_permissions_for_turn(self, turn_id: str) -> None:
        stale = [
            key
            for key, (_request_id, _options, _expires_at, pending_turn_id)
            in self._pending_permissions.items()
            if pending_turn_id == turn_id
        ]
        for key in stale:
            self._pending_permissions.pop(key, None)

    async def _spawn(self) -> None:
        """Launch the hermes acp subprocess inside our sandbox."""
        if self._proc is not None:
            return
        base_cmd = [str(self._cli_path), "acp"]
        # Wrap with OS sandbox (codex-linux-sandbox on Linux; sandbox-exec on macOS).
        sandboxed = wrap_command(base_cmd, SandboxSpec(user=self._username, hermes_home=self._cwd))
        _log.info("spawning hermes acp for user=%s (sandboxed=%s)", self._username,
                  sandboxed[0] != base_cmd[0])
        self._proc = await asyncio.create_subprocess_exec(
            *sandboxed,
            cwd=str(self._cwd),
            env=self._env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=HERMES_STDIO_LINE_LIMIT_BYTES,
        )

    async def _read_until_id(
        self, target_id: int, timeout: float
    ) -> tuple[dict | None, list[dict]]:
        """Read JSON-RPC messages until we see ``id == target_id``.

        Returns ``(response_payload, notifications_seen)``.
        notifications_seen captures any server-initiated messages along the way
        (no ``id``, or different id) that the caller may want to surface as
        ChatBackendEvent.
        """
        notifications: list[dict] = []
        assert self._proc is not None and self._proc.stdout is not None
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = max(0.1, deadline - asyncio.get_event_loop().time())
            try:
                line = await asyncio.wait_for(
                    self._proc.stdout.readline(), timeout=remaining
                )
            except asyncio.TimeoutError:
                return None, notifications
            if not line:
                return None, notifications
            try:
                msg = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                _log.warning("non-JSON line from hermes: %r", line[:200])
                continue
            if isinstance(msg, dict) and msg.get("id") == target_id:
                return msg, notifications
            notifications.append(msg)

    async def _initialize(self) -> None:
        if self._initialized:
            return
        req_id = await self._send(
            "initialize",
            {
                "protocolVersion": 1,
                "clientInfo": {"name": "dramaclaw", "version": "0.1.0"},
            },
        )
        resp, _ = await self._read_until_id(req_id, INITIALIZE_TIMEOUT)
        if resp is None:
            raise RuntimeError("hermes initialize timed out")
        if "error" in resp:
            raise RuntimeError(f"hermes initialize error: {resp['error']}")
        self._initialized = True
        _log.debug("hermes initialized: %s", resp.get("result", {}).get("agentInfo"))

    async def _ensure_session(self) -> None:
        """Create or resume the ACP session. Updates ``self.id``."""
        if self.id and not self._is_new:
            req_id = await self._send(
                "session/load",
                {"sessionId": self.id, "cwd": str(self._cwd), "mcpServers": []},
            )
            resp, _ = await self._read_until_id(req_id, SESSION_NEW_TIMEOUT)
            if resp and "error" not in resp:
                return
            _log.warning("session/load failed, falling back to session/new: %s",
                         resp.get("error") if resp else "timeout")
            self._is_new = True

        req_id = await self._send(
            "session/new",
            {"cwd": str(self._cwd), "mcpServers": []},
        )
        resp, _ = await self._read_until_id(req_id, SESSION_NEW_TIMEOUT)
        if resp is None:
            raise RuntimeError("hermes session/new timed out")
        if "error" in resp:
            raise RuntimeError(f"hermes session/new error: {resp['error']}")
        result = resp.get("result", {})
        self.id = result.get("sessionId") or f"hermes-{uuid.uuid4().hex}"
        self._is_new = False

    async def _prepare(self) -> None:
        """Spawn + initialize + create/resume session (the cold-start prologue).

        Idempotent and serialized via ``_setup_lock`` so a background warm() and
        the first real stream() never interleave on the JSON-RPC stdio.
        """
        async with self._setup_lock:
            await self._spawn()
            if self._proc is None or self._proc.stdout is None:
                raise RuntimeError("hermes subprocess failed to start")
            await self._initialize()
            await self._ensure_session()

    async def warm(self) -> None:
        """Pre-pay the cold start (spawn + initialize + session) without a prompt.

        Best-effort: called proactively when the user opens a chat/switches scope
        so the first real message hits a ready session. Failures are logged, not
        raised — a failed warm just means the first stream() pays the cold start.
        """
        if self._closed:
            return
        try:
            await self._prepare()
            _log.info("hermes worker warmed for user=%s session=%s", self._username, self.id)
        except Exception as e:  # noqa: BLE001 - best-effort prewarm
            _log.warning("hermes warm() failed for user=%s: %s", self._username, e)

    async def stream(self, prompt: str, *, current_project: str | None = None) \
            -> AsyncIterator[ChatBackendEvent]:
        """Send a prompt and yield ChatBackendEvent items as hermes streams them.

        ``current_project`` is included as a prompt prefix so per-user hermes
        knows which DramaClaw project the user is talking about (see plan).
        """
        if self._closed:
            raise RuntimeError("HermesSdkThread is closed")

        await self._prepare()
        turn_id = uuid.uuid4().hex
        try:
            assert self._proc is not None and self._proc.stdout is not None
            # Compose prompt blocks (ACP supports rich content; we send plain text).
            text = prompt
            if current_project:
                text = f"[CONTEXT: current_project={current_project}]\n\n{prompt}"
            yield ChatBackendEvent(type="thread_started", thread_id=self.id, turn_id=turn_id)

            req_id = await self._send(
                "session/prompt",
                {
                    "sessionId": self.id,
                    "messageId": turn_id,
                    "prompt": [{"type": "text", "text": text}],
                },
            )

            # Read until we see the final session/prompt response (id matches).
            # Along the way emit assistant/tool/plan/thought/usage events for any
            # session/update notifications hermes sends.
            assert self._proc.stdout is not None
            deadline = asyncio.get_event_loop().time() + STREAM_READ_TIMEOUT
            tool_call_count = 0
            first_write_tool: str | None = None
            active_tool_name: str | None = None
            first_write_failed = False
            failed_write_retry_count = 0
            while True:
                remaining = max(0.1, deadline - asyncio.get_event_loop().time())
                try:
                    line = await asyncio.wait_for(
                        self._proc.stdout.readline(), timeout=remaining
                    )
                except asyncio.TimeoutError:
                    yield ChatBackendEvent(
                        type="complete", thread_id=self.id, turn_id=turn_id,
                        text="(hermes timed out)",
                    )
                    return
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    continue

                # Final response for our session/prompt call
                if msg.get("id") == req_id:
                    if _has_content_filter_signal(msg):
                        yield ChatBackendEvent(
                            type="complete",
                            thread_id=self.id,
                            turn_id=turn_id,
                            text=CONTENT_FILTER_MESSAGE,
                        )
                        return
                    err = msg.get("error")
                    if err:
                        yield ChatBackendEvent(
                            type="complete", thread_id=self.id, turn_id=turn_id,
                            text=(
                                CONTENT_FILTER_MESSAGE
                                if _has_content_filter_signal(err)
                                else f"error: {err.get('message', err)}"
                            ),
                        )
                    else:
                        yield ChatBackendEvent(
                            type="complete", thread_id=self.id, turn_id=turn_id,
                            text="",
                        )
                    return

                # Server-initiated notifications (session/update etc.)
                # ACP notifications carry assistant chunks, tool calls, etc.
                ev = self._translate_notification(msg, turn_id)
                if ev is not None:
                    if ev.type == "tool_started":
                        tool_call_count += 1
                        tool_name = str(ev.name or "").strip()
                        active_tool_name = tool_name
                        if _should_stop_after_write_tool(first_write_tool, tool_name):
                            if _can_retry_failed_canvas_write(
                                first_write_tool,
                                tool_name,
                                first_write_failed=first_write_failed,
                                failed_write_retry_count=failed_write_retry_count,
                            ):
                                failed_write_retry_count += 1
                                _log.info(
                                    "Hermes turn retrying failed Freezone canvas write: "
                                    "thread=%s turn=%s first_write=%s retry=%s next_tool=%s",
                                    self.id,
                                    turn_id,
                                    first_write_tool,
                                    failed_write_retry_count,
                                    tool_name or "tool",
                                )
                                first_write_tool = None
                                first_write_failed = False
                            else:
                                stop_text = (
                                    DRAMACLAW_WRITE_FAILED_STOP_MESSAGE
                                    if first_write_failed
                                    else DRAMACLAW_ONE_STEP_STOP_MESSAGE
                                )
                                _log.warning(
                                    "Hermes turn attempted tool after write task: thread=%s turn=%s "
                                    "first_write=%s first_write_failed=%s next_tool=%s",
                                    self.id,
                                    turn_id,
                                    first_write_tool,
                                    first_write_failed,
                                    tool_name or "tool",
                                )
                                await self.close()
                                yield ChatBackendEvent(
                                    type="complete",
                                    thread_id=self.id,
                                    turn_id=turn_id,
                                    text=stop_text,
                                )
                                return
                        if _is_dramaclaw_write_tool(tool_name):
                            first_write_tool = tool_name
                            first_write_failed = False
                        tool_call_limit = _turn_tool_call_limit_for_tool(tool_name)
                        if tool_call_count > tool_call_limit:
                            _log.warning(
                                "Hermes turn exceeded tool call limit: thread=%s turn=%s limit=%s",
                                self.id,
                                turn_id,
                                tool_call_limit,
                            )
                            await self.close()
                            yield ChatBackendEvent(
                                type="complete",
                                thread_id=self.id,
                                turn_id=turn_id,
                                text=_tool_call_limit_stop_message(tool_name),
                            )
                            return
                    elif (
                        ev.type == "tool_updated"
                        and (ev.raw or {}).get("sessionUpdate") == "tool_call_update"
                        and _should_mark_first_write_failed(
                            first_write_tool,
                            active_tool_name,
                            ev.raw,
                        )
                    ):
                        first_write_failed = True
                    yield ev
        finally:
            # Don't kill subprocess here — caller may want to send more prompts.
            # HermesPool handles cleanup on idle / shutdown.
            self._clear_pending_permissions_for_turn(turn_id)
            self._tool_names_by_call_id.clear()
            self._tool_inputs_by_call_id.clear()

    def _translate_notification(self, msg: dict, turn_id: str) -> ChatBackendEvent | None:
        """Map ACP session/update notifications to ChatBackendEvent.

        ACP session/update payload shape (per acp.schema):
            {"method": "session/update", "params": {
                "sessionId": "...", "update": {<one of many variants>}
            }}

        Preserve ACP's structured runtime information so clients can render
        plans, reasoning, tool lifecycle state, and context usage without
        parsing presentation text.
        """
        method = msg.get("method")
        if method == "session/request_permission":
            params = msg.get("params") or {}
            request_id = msg.get("id")
            raw_options = params.get("options")
            options = [option for option in raw_options if isinstance(option, dict)] \
                if isinstance(raw_options, list) else []
            allowed_options = {
                str(option.get("optionId") or option.get("option_id") or "").strip()
                for option in options
            }
            allowed_options.discard("")
            if request_id is None or not allowed_options:
                return None
            self._pending_permissions[str(request_id)] = (
                request_id,
                allowed_options,
                time.monotonic() + PERMISSION_REQUEST_TIMEOUT_SECONDS,
                turn_id,
            )
            tool_call = params.get("toolCall") or params.get("tool_call") or {}
            title = tool_call.get("title") if isinstance(tool_call, dict) else None
            return ChatBackendEvent(
                type="permission_requested",
                thread_id=self.id,
                turn_id=turn_id,
                text=str(title or "需要操作授权"),
                request_id=request_id,
                options=options,
                raw=tool_call,
            )
        if method != "session/update":
            return None
        update = (msg.get("params") or {}).get("update") or {}
        kind = update.get("sessionUpdate")

        if kind == "agent_message_chunk":
            content = update.get("content") or {}
            text = content.get("text") if isinstance(content, dict) else None
            return ChatBackendEvent(
                type="assistant_delta", thread_id=self.id, turn_id=turn_id,
                text=text or "",
            )
        if kind == "agent_thought_chunk":
            content = update.get("content") or {}
            text = content.get("text") if isinstance(content, dict) else None
            return ChatBackendEvent(
                type="thought_delta", thread_id=self.id, turn_id=turn_id,
                text=text or "", raw=update,
            )
        if kind == "plan":
            raw_entries = update.get("entries")
            entries = [entry for entry in raw_entries if isinstance(entry, dict)] \
                if isinstance(raw_entries, list) else []
            return ChatBackendEvent(
                type="plan_update", thread_id=self.id, turn_id=turn_id,
                entries=entries, raw=update,
            )
        if kind == "tool_call":
            title = update.get("title") or update.get("kind") or "tool"
            tool_name, _body = _split_tool_title(title)
            tool_input = _first_present(update, "rawInput", "raw_input")
            call_id = str(
                update.get("toolCallId")
                or update.get("tool_call_id")
                or update.get("id")
                or ""
            ).strip() or None
            if call_id:
                self._tool_names_by_call_id[call_id] = tool_name
                self._tool_inputs_by_call_id[call_id] = tool_input
            return ChatBackendEvent(
                type="tool_started", thread_id=self.id, turn_id=turn_id,
                text=_format_tool_call_text(update, title),
                name=tool_name,
                call_id=call_id,
                status=str(update.get("status") or "pending"),
                input=tool_input,
                raw=update,
            )
        if kind == "tool_call_update":
            status = str(update.get("status") or "updated")
            call_id = str(
                update.get("toolCallId")
                or update.get("tool_call_id")
                or update.get("id")
                or ""
            ).strip() or None
            update_title = update.get("title") or update.get("kind")
            tool_name = self._tool_names_by_call_id.get(call_id or "")
            if not tool_name and update_title:
                tool_name, _body = _split_tool_title(update_title)
            tool_input = self._tool_inputs_by_call_id.get(call_id or "")
            update_input = _first_present(update, "rawInput", "raw_input")
            tool_output = _first_present(
                update, "rawOutput", "raw_output", "result", "content"
            )
            tool_error = update.get("error")
            if tool_error is None and isinstance(tool_output, dict):
                tool_error = tool_output.get("error")
            if call_id and status.lower() in {
                "completed", "failed", "cancelled", "canceled", "error"
            }:
                self._tool_names_by_call_id.pop(call_id, None)
                self._tool_inputs_by_call_id.pop(call_id, None)
            return ChatBackendEvent(
                type="tool_updated", thread_id=self.id, turn_id=turn_id,
                text=f"  {status}",
                name=tool_name,
                call_id=call_id,
                status=status,
                input=update_input if update_input is not None else tool_input,
                output=tool_output,
                error=tool_error,
                raw=update,
            )
        if kind == "usage_update":
            return ChatBackendEvent(
                type="usage_update", thread_id=self.id, turn_id=turn_id,
                usage={key: value for key, value in update.items() if key != "sessionUpdate"},
                raw=update,
            )
        _log.debug("ignoring unsupported Hermes ACP session update: %s", kind)
        return None

    async def close(self) -> None:
        """Terminate the hermes subprocess."""
        self._pending_permissions.clear()
        self._tool_names_by_call_id.clear()
        self._tool_inputs_by_call_id.clear()
        if self._closed:
            return
        self._closed = True
        if self._proc is None:
            return
        try:
            if self._proc.stdin is not None and not self._proc.stdin.is_closing():
                self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._proc.terminate()
            await asyncio.wait_for(self._proc.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            self._proc.kill()
            await self._proc.wait()
        except ProcessLookupError:
            pass

    @property
    def is_closed(self) -> bool:
        return self._closed


__all__ = ["HermesSdkClient", "HermesSdkThread"]
