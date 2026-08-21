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
import hashlib
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


# How long to wait for the ACP initialize response before giving up. Some
# Hermes builds perform plugin/tool bootstrap during initialize, so keep this
# aligned with session/new's cold-start budget.
INITIALIZE_TIMEOUT = 90.0
# How long to wait for hermes to produce a session/new response.
SESSION_NEW_TIMEOUT = 90.0


# Per-line stdout read timeout while streaming a prompt. Freezone canvas write
# tools can legitimately block while the browser validates/applies commands, so
# keep this longer than the canvas bridge wait to avoid premature "(hermes timed out)".
CANVAS_COMMAND_RESULT_TIMEOUT = _env_float("DRAMACLAW_CANVAS_COMMAND_RESULT_TIMEOUT_SECONDS", 600.0)
HERMES_STDIO_LINE_LIMIT_BYTES = max(
    65536,
    _env_int("DRAMACLAW_HERMES_STDIO_LINE_LIMIT_BYTES", 4 * 1024 * 1024),
)
STREAM_IDLE_TIMEOUT = 300.0
STREAM_TOTAL_TIMEOUT = max(1800.0, STREAM_IDLE_TIMEOUT)
try:
    TURN_TOOL_CALL_LIMIT = max(0, int(os.environ.get("HERMES_TURN_TOOL_CALL_LIMIT", "0")))
except ValueError:
    TURN_TOOL_CALL_LIMIT = 0
FREEZONE_TURN_TOOL_CALL_LIMIT = max(
    1,
    _env_int("HERMES_FREEZONE_TURN_TOOL_CALL_LIMIT", 20),
)
REPEATED_READ_TOOL_CALL_LIMIT = max(
    1,
    _env_int("HERMES_REPEATED_READ_TOOL_CALL_LIMIT", 2),
)
REPEATED_FAILED_TOOL_CALL_LIMIT = max(
    2,
    _env_int("HERMES_REPEATED_FAILED_TOOL_CALL_LIMIT", 2),
)
REPEATED_VALIDATION_TOOL_CALL_LIMIT = max(
    2,
    _env_int("HERMES_REPEATED_VALIDATION_TOOL_CALL_LIMIT", 3),
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
    "刚才这一步没有成功启动任务，系统已阻止重复提交。请根据本轮返回的具体错误处理后再重试。"
)


class HermesSessionUnavailableError(RuntimeError):
    """Raised when Hermes can no longer load or prompt a cached ACP session."""


def _is_session_unavailable_error(error: Any) -> bool:
    if not error:
        return False
    if isinstance(error, dict):
        text = " ".join(
            str(value)
            for value in (
                error.get("message"),
                error.get("code"),
                error.get("data"),
            )
            if value is not None
        )
    else:
        text = str(error)
    normalized = text.lower()
    return (
        "session" in normalized
        and "not found" in normalized
    ) or "failed to recreate agent for acp session" in normalized

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
    "dramaclaw_prepare_system_voices",
    "dramaclaw_render_first_frames",
    "dramaclaw_compose_episode",
    "dramaclaw_generate_portrait",
    "dramaclaw_generate_identity_image",
    "dramaclaw_start_single_video",
    "dramaclaw_start_video_batch",
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


def _refresh_stream_idle_deadline(*, now: float, total_deadline: float) -> float:
    return min(total_deadline, now + STREAM_IDLE_TIMEOUT)

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


def _compact_log_detail(value: object, limit: int = 2000) -> str:
    text = _compact_tool_detail(value)
    if len(text) > limit:
        return f"{text[:limit]}..."
    return text


def _summarize_acp_message(msg: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if "id" in msg:
        summary["id"] = msg.get("id")
    method = msg.get("method")
    if method:
        summary["method"] = method
    if "error" in msg:
        summary["error"] = msg.get("error")
    if "result" in msg:
        result = msg.get("result")
        summary["result_keys"] = (
            sorted(result.keys()) if isinstance(result, dict) else type(result).__name__
        )
    if method == "session/update":
        update = (msg.get("params") or {}).get("update") or {}
        if isinstance(update, dict):
            kind = update.get("sessionUpdate")
            summary["sessionUpdate"] = kind
            for key in ("toolCallId", "tool_call_id", "id", "title", "status", "kind"):
                if key in update:
                    summary[key] = update.get(key)
            tool_input = _first_present(update, "rawInput", "raw_input")
            tool_output = _first_present(
                update, "rawOutput", "raw_output", "result", "content"
            )
            if tool_input is not None:
                summary["input"] = _compact_log_detail(tool_input, 800)
            if tool_output is not None and kind == "tool_call_update":
                summary["output"] = _compact_log_detail(tool_output, 800)
    elif method == "session/request_permission":
        params = msg.get("params") or {}
        summary["permission_options"] = len(params.get("options") or [])
        tool_call = params.get("toolCall") or params.get("tool_call")
        if isinstance(tool_call, dict):
            summary["tool_title"] = tool_call.get("title")
    return summary


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


def _is_skill_loading_tool(name: object) -> bool:
    return str(name or "").strip() in {"skill", "skill_view"}


def _turn_tool_call_limit_for_tool(name: object) -> int | None:
    if _is_freezone_tool(name):
        return FREEZONE_TURN_TOOL_CALL_LIMIT
    return TURN_TOOL_CALL_LIMIT or None


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


def _read_signature_input(event: ChatBackendEvent) -> object:
    if event.input is not None or not _is_skill_loading_tool(event.name):
        return event.input
    if isinstance(event.raw, dict):
        title = str(event.raw.get("title") or "").strip()
        if title:
            return {"resource_title": title}
    return event.input


def _tool_call_guard_reason(stop_text: object) -> str:
    """Return a machine-readable reason without coupling callers to UI copy."""
    if "重复读取" in str(stop_text or ""):
        return "repeated_read"
    return "tool_call_limit"


class _TurnToolCallGuard:
    def __init__(self) -> None:
        self.total = 0
        self._counted_call_ids: set[str] = set()
        self._read_signature_counts: dict[str, int] = {}
        self._failed_signature_counts: dict[str, int] = {}
        self._validation_signature_counts: dict[str, int] = {}

    def observe(self, event: ChatBackendEvent) -> str | None:
        if event.type not in {"tool_started", "tool_updated"}:
            return None
        if event.type == "tool_updated":
            failure_signature = _failed_tool_call_signature(event)
            if failure_signature is not None:
                failure_count = self._failed_signature_counts.get(failure_signature, 0) + 1
                self._failed_signature_counts[failure_signature] = failure_count
                if failure_count >= REPEATED_FAILED_TOOL_CALL_LIMIT:
                    return (
                        "本轮操作已停止：同一个工具以相同参数重复返回相同错误。"
                        "请检查工具参数或等待相关状态变化后再重试。"
                    )
        call_id = str(event.call_id or "").strip()
        if call_id:
            if call_id in self._counted_call_ids:
                return None
            self._counted_call_ids.add(call_id)
        elif event.type != "tool_started":
            # Anonymous updates cannot be distinguished from a matching start.
            return None

        tool_name = str(event.name or "").strip()
        # Loading the workflow instructions is mandatory setup, not a business
        # operation. Keep repeated-read detection below, but do not let the
        # loader consume the per-turn action budget.
        if not _is_skill_loading_tool(tool_name):
            self.total += 1
        if tool_name == "freezone_validate_canvas_commands":
            try:
                encoded_input = json.dumps(
                    event.input,
                    ensure_ascii=False,
                    sort_keys=True,
                    default=str,
                    separators=(",", ":"),
                )
            except (TypeError, ValueError):
                encoded_input = repr(event.input)
            signature = f"{tool_name}:{encoded_input}"
            validation_count = self._validation_signature_counts.get(signature, 0) + 1
            self._validation_signature_counts[signature] = validation_count
            if validation_count >= REPEATED_VALIDATION_TOOL_CALL_LIMIT:
                return (
                    "本轮操作已停止：虾画重复校验同一批画布命令，且没有执行新的写入。"
                    "请重新发送一条明确的继续或重试指令。"
                )
        if not _is_dramaclaw_write_tool(tool_name) and not _is_freezone_canvas_write_tool(tool_name):
            if event.input is None:
                # Hermes "polished" tools (skill_view, read_file, search_files…)
                # omit rawInput in the ACP event, and _split_tool_title reduces
                # their titles to one word — without more detail, distinct reads
                # collapse into one signature and falsely trip the repeated-read
                # stop. The title alone is not enough either: a chunked read of
                # one file titles every chunk "read: <path>", so also fold in the
                # start event's content blocks, which carry the args JSON
                # (offset/limit included).
                raw = event.raw if isinstance(event.raw, dict) else {}
                title = str(raw.get("title") or "")
                detail = _extract_tool_update_content_text(raw) if raw else ""
                encoded_input = f"{title}|{detail[:600]}"
            else:
                try:
                    encoded_input = json.dumps(
                        event.input, ensure_ascii=False, sort_keys=True, default=str
                    )
                except (TypeError, ValueError):
                    encoded_input = repr(event.input)
            signature = f"{tool_name}:{encoded_input}"
            repeat_count = self._read_signature_counts.get(signature, 0) + 1
            self._read_signature_counts[signature] = repeat_count
            if repeat_count > REPEATED_READ_TOOL_CALL_LIMIT:
                subject = "同一个画布节点" if _is_freezone_tool(tool_name) else "同一项状态"
                return (
                    f"本轮操作已停止：虾导重复读取{subject}，且没有产生新的操作。"
                    "请重新发送一条明确的继续或重试指令。"
                )

        call_limit = _turn_tool_call_limit_for_tool(tool_name)
        if call_limit is not None and self.total > call_limit:
            return _tool_call_limit_stop_message(tool_name)
        return None


def _is_terminal_tool_update(event: ChatBackendEvent) -> bool:
    return str(event.status or "").strip().lower() in {
        "completed",
        "failed",
        "error",
        "cancelled",
        "canceled",
    }


def _failed_tool_call_signature(event: ChatBackendEvent) -> str | None:
    if not _is_terminal_tool_update(event):
        return None
    failure_payload = _tool_failure_payload(event)
    if failure_payload is None:
        return None
    encoded = json.dumps(
        {
            "tool": str(event.name or "").strip(),
            "input": event.input,
            "failure": _stable_tool_failure_payload(failure_payload),
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _tool_failure_payload(event: ChatBackendEvent) -> object | None:
    status = str(event.status or "").strip().lower()
    if status in {"failed", "error"}:
        return event.error or event.structured or event.output or status
    if event.error:
        return event.error
    for candidate in (event.structured, event.output):
        payload = _coerce_tool_result(candidate)
        if not isinstance(payload, dict):
            continue
        result_status = str(
            payload.get("status")
            or payload.get("tool_call_status")
            or payload.get("canvas_context_status")
            or payload.get("canvas_apply_status")
            or ""
        ).strip().lower()
        if payload.get("ok") is False or result_status in {
            "failed",
            "error",
            "validation_failed",
            "empty_validation_payload",
        }:
            return payload
    return None


def _coerce_tool_result(value: object) -> object:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        try:
            decoded, _ = json.JSONDecoder().raw_decode(value.lstrip())
        except (TypeError, ValueError):
            return value
        return decoded


_VOLATILE_TOOL_RESULT_KEYS = {
    "bridge_key",
    "key",
    "resolved_at",
    "timestamp",
    "tool_call_id",
}


def _stable_tool_failure_payload(value: object) -> object:
    value = _coerce_tool_result(value)
    if isinstance(value, dict):
        return {
            str(key): _stable_tool_failure_payload(item)
            for key, item in value.items()
            if str(key) not in _VOLATILE_TOOL_RESULT_KEYS
        }
    if isinstance(value, list):
        return [_stable_tool_failure_payload(item) for item in value]
    return value


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
    return any(
        _is_failed_tool_payload(value.get(key))
        for key in (
            "rawOutput",
            "raw_output",
            "output",
            "content",
            "data",
            "error",
            "message",
            "result",
        )
        if key in value
    )


def _is_failed_tool_payload(value: object) -> bool:
    if isinstance(value, dict):
        if value.get("ok") is False:
            return True
        if str(value.get("status") or "").strip().lower() in {
            "failed",
            "error",
            "cancelled",
            "canceled",
        }:
            return True
        return any(_is_failed_tool_payload(item) for item in value.values())
    if isinstance(value, list):
        return any(_is_failed_tool_payload(item) for item in value)
    if isinstance(value, str):
        text = value.strip()
        if text.startswith(("{", "[")):
            try:
                return _is_failed_tool_payload(json.loads(text))
            except json.JSONDecodeError:
                return False
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


def _extract_tool_update_content_text(update: dict) -> str:
    parts: list[str] = []

    def visit(value: object) -> None:
        if value in (None, "", [], {}):
            return
        if isinstance(value, dict):
            if value.get("type") == "text" and isinstance(value.get("text"), str):
                parts.append(value["text"].strip())
                return
            if isinstance(value.get("text"), str):
                parts.append(value["text"].strip())
                return
            for key in ("content", "result", "data", "output", "message", "error"):
                if key in value:
                    visit(value.get(key))
            return
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if isinstance(value, str):
            parts.append(value.strip())
            return
        try:
            parts.append(json.dumps(value, ensure_ascii=False))
        except TypeError:
            parts.append(str(value))

    for key in ("content", "result", "data", "output"):
        if key in update:
            visit(update.get(key))
    return "\n".join(part for part in (_redact_tool_detail(part) for part in parts) if part)


def _load_recent_freezone_tool_result(
    result_dir: str | None,
    tool_name: str | None,
    *,
    max_age_seconds: float = 300.0,
) -> Any | None:
    name = str(tool_name or "").strip()
    root_text = str(result_dir or "").strip()
    if not name.startswith("freezone_") or not root_text:
        return None
    root = Path(root_text)
    if not root.exists():
        return None
    safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in name)
    try:
        candidates = sorted(
            root.glob(f"{safe_name}-*.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return None
    now = time.time()
    for path in candidates[:5]:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(raw, dict) or raw.get("tool_name") != name:
            continue
        created_at = raw.get("created_at")
        if isinstance(created_at, (int, float)) and now - float(created_at) > max_age_seconds:
            continue
        return raw.get("result")
    return None


#: Only lines that describe the worker's own failure are summarised; the rest
#: of stderr is the user's content and must not reach our logs.
#: A traceback's type line carries no level marker, and that line is usually
#: the one that names the cause — it is what identified the refused egress this
#: drain was added for. So an exception type at the start of a line counts as
#: diagnostic on its own.
_WORKER_DIAGNOSTIC = re.compile(
    r"\b(ERROR|CRITICAL|Traceback)\b"
    r"|^[A-Za-z_][\w.]*(?:Error|Exception)\b")
_WORKER_ERROR_TYPE = re.compile(r"\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b")


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


def _issue_turn_capability(
    *, trajectory_id: str | None, project_id: str | None, turn_id: str
) -> str | None:
    """Mint this turn's capability, or None when it cannot be minted.

    Never raises into the turn. Attestation is observability: a misconfigured
    key, a missing identity or an issuer failure must cost evidence, never the
    user's conversation.

    There is no runtime feature check here, and none is needed. A worker without
    the patch ignores the ``_meta`` field, the request goes out with no
    capability header, and the Gateway records that traffic as diagnostic —
    already the correct outcome. Keeping the two sides on the same build is an
    installation concern, handled where installs are.
    """
    from novelvideo.chat import evidence_metrics

    if not trajectory_id or not project_id:
        # Not a failure: a turn with no trajectory has nothing to attest. Kept
        # apart from a real issuer failure so "we never had an identity" is not
        # read as "the issuer is broken".
        evidence_metrics.observe("capability_no_identity")
        return None
    try:
        from novelvideo.brainclaw_control_capability import control_capability_issuer

        issuer = control_capability_issuer()
        if issuer is None:
            # An unconfigured issuer, which is the normal state before the keys
            # are rolled out. Distinct from a failure so a stage that has not
            # been given keys does not look like one whose keys are broken.
            evidence_metrics.observe("capability_issuer_absent")
            return None
        capability = issuer.issue(
            trajectory_id=trajectory_id, project_id=project_id, turn_id=turn_id
        )
        evidence_metrics.observe("capability_issued")
        # One greppable success line per minted turn. Names only — no key,
        # capability or prompt — so it is safe in api.log. Lets an operator
        # confirm the K1/K3 keys are live without a debugger or an endpoint.
        _log.info(
            "capability_issued turn=%s (evidence plane active)", turn_id
        )
        return capability
    except Exception:
        # Elevated from debug: a mint failure is a HALTING evidence outcome —
        # it must be visible in the normal log, not only under debug.
        _log.warning(
            "capability_issue_failure turn=%s — evidence plane HALT",
            turn_id,
            exc_info=True,
        )
        evidence_metrics.observe("capability_issue_failure")
        return None


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
        self._stderr_task: asyncio.Task | None = None
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
        # ACP multiplexes one session over one subprocess stdout stream. A
        # second prompt must not read that stream until the active turn has
        # consumed its final response, otherwise asyncio raises because two
        # coroutines are waiting on StreamReader.readline() concurrently.
        self._turn_lock = asyncio.Lock()

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
        # Consume stderr for as long as the worker lives. It was piped and never
        # read: the pipe fills, the worker blocks on its next write, and the
        # turn stalls for a reason nothing reports.
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        """Keep the pipe drained, and report only what the worker says about itself.

        Two requirements met by one loop, because both sides of this merge had
        written their own. Freezone needs the sitecustomize startup warning
        promoted so a denied tool that survived registry cleanup is visible in
        the backend console. The evidence plane needs a worker's own failure to
        be diagnosable at all — a refused egress used to reach us as an
        unexplained connection error minutes later.

        What neither may do is forward stderr verbatim at anything above debug.
        Worker stderr carries prompts, tool output and provider bodies, so a
        warning-level echo would route user content into DramaClaw's logs
        through a path no telemetry allowlist governs. The Freezone line is
        promoted because it is a fixed marker; an error is reduced to its
        exception type and the pid.
        """
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        pid = proc.pid
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                text = line.decode("utf-8", "replace").rstrip()
                if not text:
                    continue
                if "DramaClaw Freezone warning" in text:
                    _log.warning("hermes[%s] %s", self._username, text)
                elif _WORKER_DIAGNOSTIC.search(text):
                    match = _WORKER_ERROR_TYPE.search(text)
                    _log.warning(
                        "hermes worker pid=%s reported %s",
                        pid, match.group(1) if match else "an error")
                else:
                    _log.debug("hermes[%s] %s", self._username, text)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - draining must not take down the turn
            return

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
        # Record what this runtime declared it implements. It is the only signal
        # that describes the *running* process: a stock build reports the same
        # version, can pass a revision check whenever the operator forgot to
        # resync, and then silently drops the _meta extension.
        _log.debug("hermes initialized: %s", resp.get("result", {}).get("agentInfo"))

    async def _ensure_session(self) -> None:
        """Create or resume the ACP session. Updates ``self.id``."""
        if self.id and not self._is_new:
            req_id = await self._send(
                "session/load",
                {"sessionId": self.id, "cwd": str(self._cwd), "mcpServers": []},
            )
            resp, _ = await self._read_until_id(req_id, SESSION_NEW_TIMEOUT)
            if resp and "error" not in resp and resp.get("result") is not None:
                return
            _log.warning("session/load failed, falling back to session/new: %s",
                         resp.get("error") if resp and resp.get("error") else "not found")
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

    async def _stream_timeout_event(self, turn_id: str) -> ChatBackendEvent:
        """Retire a timed-out worker before returning control to the pool."""

        await self.close()
        return ChatBackendEvent(
            type="complete",
            thread_id=self.id,
            turn_id=turn_id,
            text="(hermes timed out)",
            # Carried on the event itself rather than inferred from the text: a
            # caller that matched on "(hermes timed out)" would settle the
            # ledger as a success the day that string changes.
            disposition="timeout",
        )


    async def stream(
        self,
        prompt: str,
        *,
        current_project: str | None = None,
        trajectory_id: str | None = None,
        project_id: str | None = None,
        gateway_api_key: str | None = None,
    ) -> AsyncIterator[ChatBackendEvent]:
        """Send a prompt and yield ChatBackendEvent items as hermes streams them.

        ``current_project`` is included as a prompt prefix so per-user hermes
        knows which DramaClaw project the user is talking about (see plan).

        ``trajectory_id`` and ``project_id`` are raw internal identifiers used to
        mint this turn's egress capability. They are hashed before they leave
        this process and are never sent as-is; Hermes receives only the signed
        capability. Both absent means the turn is unattested, which is a
        first-class state, not an error.
        """
        async with self._turn_lock:
            if self._closed:
                raise RuntimeError("HermesSdkThread is closed")
            async for event in self._stream_turn(
                prompt,
                current_project=current_project,
                trajectory_id=trajectory_id,
                project_id=project_id,
                gateway_api_key=gateway_api_key,
            ):
                yield event

    async def _stream_turn(
        self,
        prompt: str,
        *,
        current_project: str | None = None,
        trajectory_id: str | None = None,
        project_id: str | None = None,
        gateway_api_key: str | None = None,
    ) -> AsyncIterator[ChatBackendEvent]:
        """Run one prompt while ``_turn_lock`` owns the ACP stdout reader."""

        await self._prepare()
        turn_id = uuid.uuid4().hex
        try:
            assert self._proc is not None and self._proc.stdout is not None
            # Compose prompt blocks (ACP supports rich content; we send plain text).
            text = prompt
            if current_project:
                text = f"[CONTEXT: current_project={current_project}]\n\n{prompt}"
            yield ChatBackendEvent(type="thread_started", thread_id=self.id, turn_id=turn_id)

            prompt_params: dict[str, Any] = {
                "sessionId": self.id,
                "messageId": turn_id,
                "prompt": [{"type": "text", "text": text}],
            }
            # Per-turn egress capability. It rides in ACP _meta rather than in
            # the process environment or a session field because one Hermes
            # worker is pooled per user and serves many episodes and projects
            # concurrently; anything longer-lived than the turn would attach one
            # turn's identity to another turn's requests.
            capability = _issue_turn_capability(
                trajectory_id=trajectory_id, project_id=project_id, turn_id=turn_id
            )
            meta: dict[str, Any] = {}
            if capability:
                meta["dramaclaw.control_context_capability"] = capability
            if gateway_api_key:
                # Authentication for this turn. The worker's environment holds
                # only a placeholder, and its credential-mode latch makes that
                # placeholder unusable, so a turn that omits this key fails
                # rather than billing the platform account.
                meta["dramaclaw.gateway_api_key"] = gateway_api_key
                meta["dramaclaw.gateway_api_key_required"] = True
            if meta:
                prompt_params["_meta"] = meta
            req_id = await self._send("session/prompt", prompt_params)
            # The request has now crossed into the agent. Anything that goes
            # wrong past this line cannot prove the upstream call did not
            # happen, so the ledger may no longer say "rejected before submit".
            yield ChatBackendEvent(
                type="egress_submitted", thread_id=self.id, turn_id=turn_id)

            # Read until we see the final session/prompt response (id matches).
            # Along the way emit assistant/tool/plan/thought/usage events for any
            # session/update notifications hermes sends.
            assert self._proc.stdout is not None
            loop = asyncio.get_running_loop()
            total_deadline = loop.time() + STREAM_TOTAL_TIMEOUT
            idle_deadline = _refresh_stream_idle_deadline(
                now=loop.time(),
                total_deadline=total_deadline,
            )
            tool_call_guard = _TurnToolCallGuard()
            first_write_tool: str | None = None
            active_tool_name: str | None = None
            tool_name_by_call_id: dict[str, str] = {}
            first_write_failed = False
            failed_write_retry_count = 0
            while True:
                deadline = min(total_deadline, idle_deadline)
                now = loop.time()
                if now >= deadline:
                    yield await self._stream_timeout_event(turn_id)
                    return
                remaining = deadline - now
                try:
                    line = await asyncio.wait_for(
                        self._proc.stdout.readline(), timeout=remaining
                    )
                except asyncio.TimeoutError:
                    _log.warning(
                        "Hermes ACP stream timed out: thread=%s turn=%s req_id=%s "
                        "pending_tools=%s",
                        self.id,
                        turn_id,
                        req_id,
                        dict(self._tool_names_by_call_id),
                    )
                    yield await self._stream_timeout_event(turn_id)
                    return
                if not line:
                    _log.warning(
                        "Hermes ACP stdout closed during stream: thread=%s turn=%s req_id=%s "
                        "pending_tools=%s",
                        self.id,
                        turn_id,
                        req_id,
                        dict(self._tool_names_by_call_id),
                    )
                    break
                idle_deadline = _refresh_stream_idle_deadline(
                    now=loop.time(),
                    total_deadline=total_deadline,
                )
                try:
                    msg = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    _log.warning(
                        "non-JSON line from hermes stream: thread=%s turn=%s line=%r",
                        self.id,
                        turn_id,
                        line[:200],
                    )
                    continue

                # Final response for our session/prompt call
                if msg.get("id") == req_id:
                    _log.info(
                        "Hermes ACP session/prompt final: thread=%s turn=%s req_id=%s "
                        "pending_tools=%s message=%s",
                        self.id,
                        turn_id,
                        req_id,
                        dict(self._tool_names_by_call_id),
                        _summarize_acp_message(msg),
                    )
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
                        if _is_session_unavailable_error(err):
                            raise HermesSessionUnavailableError(
                                str(err.get("message", err)) if isinstance(err, dict) else str(err)
                            )
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
                method = msg.get("method")
                if method in {"session/update", "session/request_permission"}:
                    _log.info(
                        "Hermes ACP notification: thread=%s turn=%s req_id=%s message=%s",
                        self.id,
                        turn_id,
                        req_id,
                        _summarize_acp_message(msg),
                    )
                ev = self._translate_notification(
                    msg,
                    turn_id,
                    tool_name_by_call_id=tool_name_by_call_id,
                )
                if ev is not None:
                    stop_text = tool_call_guard.observe(ev)
                    if stop_text:
                        _log.warning(
                            "Hermes turn stopped by tool call guard: thread=%s turn=%s total=%s tool=%s",
                            self.id,
                            turn_id,
                            tool_call_guard.total,
                            ev.name or "tool",
                        )
                        await self.close()
                        yield ChatBackendEvent(
                            type="complete",
                            thread_id=self.id,
                            turn_id=turn_id,
                            text=stop_text,
                            raw={
                                "reason": "tool_call_guard",
                                "guard_reason": _tool_call_guard_reason(stop_text),
                                "tool_name": str(ev.name or "").strip() or None,
                                "had_write": first_write_tool is not None,
                            },
                        )
                        return
                    if ev.type == "tool_started":
                        tool_name = str(ev.name or "").strip()
                        active_tool_name = tool_name
                        if tool_name in _FREEZONE_CANVAS_WRITE_TOOLS:
                            idle_deadline = min(
                                total_deadline,
                                loop.time() + CANVAS_COMMAND_RESULT_TIMEOUT + 30.0,
                            )
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

    def _translate_notification(
        self,
        msg: dict,
        turn_id: str,
        *,
        tool_name_by_call_id: dict[str, str] | None = None,
    ) -> ChatBackendEvent | None:
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
            if not tool_name and call_id and tool_name_by_call_id is not None:
                tool_name = tool_name_by_call_id.get(call_id)
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
            structured_result = _load_recent_freezone_tool_result(
                self._env.get("DRAMACLAW_FREEZONE_TOOL_RESULT_DIR"),
                tool_name,
            )
            return ChatBackendEvent(
                type="tool_updated", thread_id=self.id, turn_id=turn_id,
                text=f"  {status}",
                name=tool_name,
                call_id=call_id,
                status=status,
                input=update_input if update_input is not None else tool_input,
                output=tool_output,
                error=tool_error,
                structured=structured_result,
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
        # The drain's lifetime is the worker's. Cancelled here rather than left
        # to end on EOF, so a worker killed rather than closed leaves no task
        # waiting on a dead pipe — and awaited, because cancellation only
        # requests it and returning would leave the task pending into shutdown.
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            await asyncio.gather(self._stderr_task, return_exceptions=True)
            self._stderr_task = None
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


__all__ = ["HermesSdkClient", "HermesSdkThread", "HermesSessionUnavailableError"]
