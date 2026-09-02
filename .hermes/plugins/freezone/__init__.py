"""Hermes 的 Freezone 画布工具入口。

这些工具名是虾画和 Agent 的稳定集成点。Handler 保持轻量：
读上下文、预校验、写命令都尽量转交给前端画布桥接层处理。
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

from tools.registry import tool_error, tool_result


def _record_structured_tool_result(tool_name: str, value: Any) -> None:
    result_dir = os.environ.get("DRAMACLAW_FREEZONE_TOOL_RESULT_DIR", "").strip()
    if not result_dir or not tool_name:
        return
    try:
        base = Path(result_dir)
        base.mkdir(parents=True, exist_ok=True)
        safe_name = "".join(
            ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in tool_name
        )
        payload = {
            "tool_name": tool_name,
            "created_at": time.time(),
            "result": value,
        }
        target = base / f"{safe_name}-{time.time_ns()}-{os.getpid()}.json"
        target.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:
        return


def _structured_tool_result(value: Any, *, tool_name: str = "") -> Any:
    _record_structured_tool_result(tool_name, value)
    rendered = tool_result(value)
    if rendered is value:
        return rendered
    return json.dumps(value, ensure_ascii=False)


_SKILL_STUDIO_NODE_SCOPE_VALUES = [
    "textGeneration",
    "imageGeneration",
    "videoGeneration",
    "audioGeneration",
]

_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

_REPO_SRC = Path(__file__).resolve().parents[3] / "src"
if _REPO_SRC.exists() and str(_REPO_SRC) not in sys.path:
    sys.path.insert(0, str(_REPO_SRC))

_WORKFLOW_GRAPH_IMPORT_ERROR: Exception | None = None
try:
    from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
except Exception as exc:
    _WORKFLOW_GRAPH_IMPORT_ERROR = exc
    build_workflow_graph_commands = None

_WORKFLOW_DRAFT_IMPORT_ERROR: Exception | None = None
try:
    from novelvideo.freezone.agent_workflows.drafts import (
        build_workflow_draft_patch,
        public_workflow_draft,
    )
except Exception as exc:
    _WORKFLOW_DRAFT_IMPORT_ERROR = exc
    build_workflow_draft_patch = None
    public_workflow_draft = None

_JSON_WORKFLOW_CATALOG_IMPORT_ERROR: Exception | None = None
try:
    from novelvideo.freezone.agent_workflows.catalog import (
        compile_workflow_intent,
        get_workflow_skill,
        validate_agent_workflow_plan,
    )
except Exception as exc:
    _JSON_WORKFLOW_CATALOG_IMPORT_ERROR = exc
    compile_workflow_intent = None
    get_workflow_skill = None
    validate_agent_workflow_plan = None

try:
    from novelvideo.freezone.workflow_schema import (
        workflow_intent_json_schema,
        workflow_plan_json_schema,
    )
except Exception:
    workflow_intent_json_schema = None
    workflow_plan_json_schema = None


_CANVAS_COMMAND_BRIDGE_IMPORT_ERROR: Exception | None = None
try:
    from novelvideo.freezone.canvas_command_bridge import (
        canvas_command_bridge_key,
        canvas_command_idempotency_key,
        canvas_context_bridge_key,
        clarification_bridge_key,
        put_pending_clarification_event,
        put_pending_canvas_command,
        put_pending_canvas_context,
        put_pending_skill_studio_event,
        wait_clarification_result,
        skill_studio_bridge_key,
        wait_canvas_command_result,
        wait_canvas_context_result,
        wait_skill_studio_result,
    )
except Exception as exc:
    _CANVAS_COMMAND_BRIDGE_IMPORT_ERROR = exc
    canvas_command_bridge_key = None
    canvas_command_idempotency_key = None
    canvas_context_bridge_key = None
    clarification_bridge_key = None
    put_pending_clarification_event = None
    put_pending_canvas_command = None
    put_pending_canvas_context = None
    put_pending_skill_studio_event = None
    wait_clarification_result = None
    skill_studio_bridge_key = None
    wait_canvas_command_result = None
    wait_canvas_context_result = None
    wait_skill_studio_result = None

TOOLSET = "freezone"
FREEZONE_ACP_TOOLSET = "freezone-acp"
# Hermes 0.18 ACP constructs sessions with the hermes-acp toolset regardless
# of config.yaml enabled_toolsets. The Freezone plugin is only installed in the
# isolated Freezone workspace, so registering here exposes canvas tools without
# leaking them into director sessions.
REGISTER_TOOLSETS = ("hermes-acp",)
API_PREFIX = "/api/v1/"
try:
    DEFAULT_TIMEOUT_SECONDS = max(
        30, int(os.environ.get("DRAMACLAW_API_TIMEOUT_SECONDS", "120"))
    )
except ValueError:
    DEFAULT_TIMEOUT_SECONDS = 120

_PENDING_SKILL_STUDIO_DRAFTS: dict[str, dict[str, Any]] = {}
_SKILL_STUDIO_DEFAULT_SKILL_SCHEMA_VERSION = "dramaclaw.workflow-skill.v1"
_SKILL_STUDIO_DEFAULT_SKILL_VERSION = "1.0.0"

_SKILL_STUDIO_REAL_TOOL_CALL_INSTRUCTION = "不要用普通文本回复，不要把工具调用、参数块或代码块写进聊天内容；请直接调用对应工具。"


def _agent_token_configured() -> bool:
    return bool(
        os.environ.get("DRAMACLAW_AGENT_TOKEN", "").strip()
        or os.environ.get("DRAMACLAW_AGENT_TOKEN_FILE", "").strip()
    )


def _current_agent_token() -> str:
    """Read a turn token lazily without depending on the CE application venv."""

    token_file = os.environ.get("DRAMACLAW_AGENT_TOKEN_FILE", "").strip()
    if token_file:
        try:
            return Path(token_file).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return os.environ.get("DRAMACLAW_AGENT_TOKEN", "").strip()


def _skill_studio_agent_instruction(
    next_step: str, progress: str, notes: list[str] | None = None
) -> str:
    parts = [
        f"下一步必须调用 {next_step}",
        f"当前进度：{progress}",
        f"注意：{_SKILL_STUDIO_REAL_TOOL_CALL_INSTRUCTION}",
    ]
    for note in notes or []:
        clean_note = note.strip()
        if clean_note:
            parts.append(clean_note)
    return "\n".join(parts)


def _available() -> bool:
    return bool(
        os.environ.get("DRAMACLAW_API_URL")
        and (_agent_token_configured() or _local_agent_trust_enabled())
    )


def _base_url() -> str:
    value = os.environ.get("DRAMACLAW_API_URL", "").strip()
    if not value:
        raise ValueError("Freezone API URL is not configured")
    return value.rstrip("/")


def _token() -> str:
    value = _current_agent_token()
    if not value:
        raise ValueError("Freezone agent token is not configured")
    return value


def _local_agent_trust_enabled() -> bool:
    if os.environ.get("DRAMACLAW_LOCAL_AGENT_TRUST", "").strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return False
    parsed = urlparse(os.environ.get("DRAMACLAW_API_URL", "").strip())
    return (parsed.hostname or "").lower() in {"127.0.0.1", "::1", "localhost"}


def _request_headers(user_agent: str) -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "User-Agent": user_agent,
    }
    token = _current_agent_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif not _local_agent_trust_enabled():
        raise ValueError("Freezone agent token is not configured")
    return headers


def _default_project_id() -> str:
    return os.environ.get("DRAMACLAW_PROJECT_ID", "").strip()


def _default_canvas_id() -> str:
    return os.environ.get("DRAMACLAW_CANVAS_ID", "").strip()


def _surface() -> str:
    return (
        os.environ.get("DRAMACLAW_CHAT_SURFACE")
        or os.environ.get("SUPERTALE_CHAT_SURFACE")
        or ""
    ).strip()


def _project_from_args(args: dict[str, Any]) -> str:
    project = str(
        args.get("project_id") or args.get("project") or _default_project_id()
    ).strip()
    if not project:
        raise ValueError(
            "project_id is required and no current project context is configured"
        )
    return project


def _canvas_from_args(args: dict[str, Any]) -> str:
    canvas = str(
        args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
    ).strip()
    if not canvas:
        raise ValueError(
            "canvas_id is required and no current canvas context is configured"
        )
    return canvas


def _normalize_api_path(path: str) -> str:
    raw = str(path or "").strip()
    if not raw:
        raise ValueError("path is required")
    if raw.startswith("http://") or raw.startswith("https://") or raw.startswith("//"):
        raise ValueError("absolute URLs are not allowed; pass a Freezone API path")
    if not raw.startswith("/"):
        raw = f"/{raw}"
    if raw.startswith("/projects/") or raw.startswith("/freezone/"):
        raw = f"/api/v1{raw}"
    if not raw.startswith(API_PREFIX):
        raise ValueError("path must start with /api/v1/, /projects/, or /freezone/")
    if any(part == ".." for part in raw.split("/")):
        raise ValueError("path traversal is not allowed")
    return raw


def _query_string(params: Any) -> str:
    if not isinstance(params, dict) or not params:
        return ""
    cleaned = {
        str(key): value
        for key, value in params.items()
        if value is not None and value != ""
    }
    return f"?{urlencode(cleaned, doseq=True)}" if cleaned else ""


def _request(
    method: str, path: str, *, query: Any = None, body: Any = None
) -> dict[str, Any]:
    api_path = _normalize_api_path(path)
    url = f"{_base_url()}{api_path}{_query_string(query)}"
    payload = None
    headers = _request_headers("freezone-plugin/0.1.0")
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = Request(url, data=payload, headers=headers, method=method.upper())
    try:
        with urlopen(req, timeout=DEFAULT_TIMEOUT_SECONDS) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return _decode_response(resp.status, text)
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "status_code": exc.code,
            "error": _response_error_text(text) or exc.reason,
            "data": _maybe_json(text),
        }
    except URLError as exc:
        return {"ok": False, "error": f"network_error: {exc.reason}"}


def _decode_response(status_code: int, text: str) -> dict[str, Any]:
    data = _maybe_json(text)
    if isinstance(data, dict):
        return {"status_code": status_code, **data}
    return {"ok": 200 <= status_code < 300, "status_code": status_code, "data": data}


def _maybe_json(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return stripped


def _response_error_text(text: str) -> str:
    data = _maybe_json(text)
    if isinstance(data, dict):
        for key in ("error", "message", "detail"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(data, str):
        return data[:500]
    return ""


def _scope_meta(project: str, canvas: str | None = None) -> dict[str, Any]:
    return {
        "project_id": project,
        "surface": _surface() or "freezone",
        "canvas_id": canvas or _default_canvas_id() or None,
    }


def _project_candidates() -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    result = _request("GET", "/api/v1/projects")
    if not result.get("ok", True):
        return [], result
    data = result.get("data")
    return (
        (
            [item for item in data if isinstance(item, dict)]
            if isinstance(data, list)
            else []
        ),
        None,
    )


def _canvas_candidates_for_project(
    project: str,
    *,
    project_name: str = "",
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    result = _request(
        "GET", f"/api/v1/projects/{quote(project, safe='')}/freezone/canvases"
    )
    if not result.get("ok", True):
        return [], result
    data = result.get("data")
    canvases = (
        [item for item in data if isinstance(item, dict)]
        if isinstance(data, list)
        else []
    )
    candidates: list[dict[str, Any]] = []
    for item in canvases:
        canvas_id = str(item.get("id") or "").strip()
        if not canvas_id:
            continue
        metadata = (
            item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        )
        title = (
            str(metadata.get("title") or metadata.get("name") or "").strip()
            if isinstance(metadata, dict)
            else ""
        )
        candidates.append(
            {
                "project_id": project,
                **({"project_name": project_name} if project_name else {}),
                "canvas_id": canvas_id,
                "title": title or canvas_id,
                "canvas_scope": item.get("canvas_scope"),
                "episode": item.get("episode"),
                "beat": item.get("beat"),
                "modified_at": item.get("modified_at") or item.get("created_at") or "",
            }
        )
    return candidates, None


def _canvas_selection_required(candidates: list[dict[str, Any]], *, reason: str) -> str:
    return tool_result(
        {
            "ok": False,
            "code": "canvas_selection_required",
            "message": "需要选择目标画布后才能执行该画布操作。",
            "reason": reason,
            "candidate_count": len(candidates),
            "candidates": candidates[:10],
            "agent_instruction": (
                "Do not retry the canvas write tool without a canvas_id. Ask the user to choose "
                "one candidate by number/title, then call the tool again with that candidate's "
                "project_id and canvas_id."
            ),
        }
    )


def _no_canvas_candidate(reason: str) -> str:
    return tool_result(
        {
            "ok": False,
            "code": "canvas_not_found",
            "message": "没有找到可操作的虾画画布，请先在浏览器中创建或打开一个画布。",
            "reason": reason,
            "agent_instruction": (
                "Ask the user to open or create a Freezone canvas, then retry with a canvas_id."
            ),
        }
    )


def _canvas_context_unavailable(error: dict[str, Any] | None) -> str:
    return tool_result(
        {
            "ok": False,
            "code": "canvas_context_unavailable",
            "message": "无法读取本地项目或画布列表，请确认 dramaclaw-ce API 已启动并可访问。",
            "error": error,
            "agent_instruction": (
                "Do not retry the canvas write tool yet. Ask the user to start the local "
                "DramaClaw API on http://127.0.0.1:8780 or provide explicit project_id "
                "and canvas_id after the API is reachable."
            ),
        }
    )


def _resolve_canvas_scope_for_write(
    project: str | None,
    canvas: str | None,
) -> tuple[str | None, str | None, str | None]:
    if project and canvas:
        return project, canvas, None

    if project:
        projects = [project]
    else:
        project_items, project_error = _project_candidates()
        if project_error is not None:
            return project, canvas, _canvas_context_unavailable(project_error)
        project_names = {
            str(item.get("id") or "").strip(): str(item.get("name") or "").strip()
            for item in project_items
            if str(item.get("id") or "").strip()
        }
        projects = list(project_names)
    if project:
        project_names = {project: ""}
    candidates: list[dict[str, Any]] = []
    for project_id in projects:
        project_canvases, canvas_error = _canvas_candidates_for_project(
            project_id,
            project_name=project_names.get(project_id, ""),
        )
        if canvas_error is not None:
            return project, canvas, _canvas_context_unavailable(canvas_error)
        if canvas:
            project_canvases = [
                item for item in project_canvases if item.get("canvas_id") == canvas
            ]
        candidates.extend(project_canvases)

    candidates.sort(key=lambda item: str(item.get("modified_at") or ""), reverse=True)

    if len(candidates) == 1:
        item = candidates[0]
        return str(item["project_id"]), str(item["canvas_id"]), None
    if not candidates:
        return (
            project,
            canvas,
            _no_canvas_candidate(
                "no matching canvas found for the provided project/canvas context"
            ),
        )
    return (
        project,
        canvas,
        _canvas_selection_required(
            candidates,
            reason="multiple canvases matched and no explicit canvas_id was provided",
        ),
    )


def _handle_canvas_ontology(args: dict[str, Any], **_: Any) -> str:
    project = str(args.get("project_id") or _default_project_id()).strip() or None
    canvas = str(args.get("canvas_id") or _default_canvas_id()).strip() or None
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "canvas_ontology"}],
    )


def _handle_canvas_action_catalog(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "canvas_action_catalog"}],
    )


def _handle_canvas_command_catalog(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "canvas_command_catalog"}],
    )


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _emit_skill_studio_event(
    project: str | None,
    canvas: str | None,
    event: dict[str, Any],
) -> str:
    if (
        skill_studio_bridge_key is None
        or put_pending_skill_studio_event is None
        or wait_skill_studio_result is None
    ):
        return tool_error(
            "Skill Studio bridge is unavailable; cannot present the Freezone UI event. "
            f"Import error: {_CANVAS_COMMAND_BRIDGE_IMPORT_ERROR}"
        )
    key = skill_studio_bridge_key(project_id=project, canvas_id=canvas, event=event)
    put_pending_skill_studio_event(
        key=key,
        project_id=project,
        canvas_id=canvas,
        event=event,
    )
    try:
        timeout_seconds = max(
            1,
            int(os.environ.get("DRAMACLAW_SKILL_STUDIO_RESULT_TIMEOUT_SECONDS", "600")),
        )
    except ValueError:
        timeout_seconds = 600
    resolved = wait_skill_studio_result(key, timeout_seconds=timeout_seconds)
    if resolved is not None:
        return tool_result(resolved)
    return tool_result(
        {
            "ok": False,
            "status": "skill_studio_frontend_timeout",
            "tool_call_status": "completed",
            "skill_studio_status": "pending_user_input",
            "bridge_key": key,
            "project_id": project,
            "canvas_id": canvas,
            "type": event.get("type"),
            "skill_studio_session_id": event.get("skill_studio_session_id"),
            "message": "Skill Studio UI is still waiting for the user's frontend response.",
            "agent_instruction": (
                "Do not continue the Skill Studio flow or summarize the options until the "
                "frontend returns a Skill Studio tool result."
            ),
        }
    )


def _emit_skill_studio_progress_event(
    project: str | None,
    canvas: str | None,
    event: dict[str, Any],
    *,
    agent_instruction: str | None = None,
) -> str:
    if skill_studio_bridge_key is None or put_pending_skill_studio_event is None:
        return tool_error(
            "Skill Studio bridge is unavailable; cannot present the Freezone UI event. "
            f"Import error: {_CANVAS_COMMAND_BRIDGE_IMPORT_ERROR}"
        )
    frontend_event = dict(event)
    if agent_instruction:
        debug = frontend_event.get("debug")
        debug_event = dict(debug) if isinstance(debug, dict) else {}
        debug_event["agent_instruction"] = agent_instruction
        frontend_event["debug"] = debug_event
    key = skill_studio_bridge_key(
        project_id=project, canvas_id=canvas, event=frontend_event
    )
    put_pending_skill_studio_event(
        key=key,
        project_id=project,
        canvas_id=canvas,
        event=frontend_event,
    )
    return tool_result(
        {
            "ok": True,
            "status": "skill_studio_progress_event_emitted",
            "tool_call_status": "completed",
            "skill_studio_status": "draft_progress",
            "bridge_key": key,
            "project_id": project,
            "canvas_id": canvas,
            "type": frontend_event.get("type"),
            "skill_studio_session_id": frontend_event.get("skill_studio_session_id"),
            "message": frontend_event.get("message")
            or "Skill Studio draft progress updated.",
            "agent_instruction": agent_instruction
            or (
                "The Skill Studio progress event was delivered to the frontend. "
                "Do not repeat tool fields to the user. Continue the draft flow and call "
                "freezone_finish_agent_catalog_draft when the updated draft is ready."
            ),
        }
    )


def _emit_clarification_event(
    project: str | None,
    canvas: str | None,
    event: dict[str, Any],
) -> str:
    if (
        clarification_bridge_key is None
        or put_pending_clarification_event is None
        or wait_clarification_result is None
    ):
        return tool_error(
            "Clarification bridge is unavailable; cannot present the Freezone UI event. "
            f"Import error: {_CANVAS_COMMAND_BRIDGE_IMPORT_ERROR}"
        )
    key = clarification_bridge_key(project_id=project, canvas_id=canvas, event=event)
    put_pending_clarification_event(
        key=key,
        project_id=project,
        canvas_id=canvas,
        event=event,
    )
    try:
        timeout_seconds = max(
            1,
            int(
                os.environ.get("DRAMACLAW_CLARIFICATION_RESULT_TIMEOUT_SECONDS", "600")
            ),
        )
    except ValueError:
        timeout_seconds = 600
    resolved = wait_clarification_result(key, timeout_seconds=timeout_seconds)
    if resolved is not None:
        return tool_result(resolved)
    return tool_result(
        {
            "ok": False,
            "status": "clarification_frontend_timeout",
            "tool_call_status": "completed",
            "clarification_status": "pending_user_input",
            "bridge_key": key,
            "project_id": project,
            "canvas_id": canvas,
            "type": event.get("type"),
            "clarification_id": event.get("clarification_id"),
            "message": "Clarification UI is still waiting for the user's frontend response.",
            "agent_instruction": (
                "Do not continue or summarize the user's choices until the frontend returns "
                "a clarification tool result."
            ),
        }
    )


def _handle_request_user_clarification(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    clarification_id = str(
        args.get("clarification_id") or args.get("request_id") or ""
    ).strip()
    if not clarification_id:
        context_id = str(
            args.get("skill_studio_session_id") or canvas or "default"
        ).strip()
        safe_context = "".join(
            ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in context_id
        ).strip("-")
        clarification_id = f"clarify_{safe_context or 'default'}_{uuid.uuid4().hex[:8]}"
    questions = _safe_list(args.get("questions"))
    if not questions:
        return tool_result(
            {
                "ok": False,
                "type": "assistant.clarification.request",
                "status": "questions_required",
                "error": "questions must contain at least one question",
                "clarification_id": clarification_id,
            }
        )
    if _external_mcp_agent_enabled():
        composite_generation_ids = {
            "generation_settings",
            "image_settings",
            "media_settings",
            "video_settings",
        }
        bundled_question = next(
            (
                question
                for question in questions
                if isinstance(question, dict)
                and str(question.get("id") or "").strip().lower()
                in composite_generation_ids
            ),
            None,
        )
        if bundled_question is not None:
            return tool_result(
                {
                    "ok": False,
                    "status": "generation_parameter_questions_invalid",
                    "code": "generation_parameter_questions_invalid",
                    "error": (
                        "图片和视频生成参数不能合并成推荐设置；必须按缺失字段分别展示选项"
                    ),
                    "required_question_ids": {
                        "image": [
                            "image_model",
                            "image_aspect_ratio",
                            "image_resolution",
                            "image_quality",
                            "image_variants_per_node",
                        ],
                        "video": [
                            "video_model",
                            "video_aspect_ratio",
                            "video_resolution",
                            "video_duration_seconds",
                            "video_generate_audio",
                            "video_variants_per_node",
                        ],
                    },
                    "agent_instruction": (
                        "No clarification card was shown. Inspect the live node create schema for "
                        "each relevant image/video node type, then retry once with one question per "
                        "missing field. Use canonical question ids and exact option values. For "
                        "video_resolution, expose every resolution supported by the selected/live "
                        "model, including 480P when the schema lists it. Do not bundle ratio, "
                        "resolution, duration, sound, or count into a preset option."
                    ),
                }
            )
    return _emit_clarification_event(
        project,
        canvas,
        {
            "type": "assistant.clarification.request",
            "clarification_id": clarification_id,
            "title": str(args.get("title") or "").strip(),
            "description": str(args.get("description") or "").strip(),
            "questions": questions,
            "allow_recommended": bool(args.get("allow_recommended", False)),
            "allow_skip": bool(args.get("allow_skip", True)),
        },
    )


def _handle_present_agent_catalog_draft(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    session_id = str(
        args.get("skill_studio_session_id") or args.get("session_id") or ""
    ).strip()
    if not session_id:
        return tool_result(
            {
                "ok": False,
                "type": "skill_studio.draft",
                "status": "skill_studio_session_id_required",
                "error": "skill_studio_session_id is required",
            }
        )
    mode = str(args.get("mode") or "create").strip() or "create"
    if mode not in {"create", "edit"}:
        mode = "create"
    skill = args.get("skill") if isinstance(args.get("skill"), dict) else {}
    recipes = _safe_list(args.get("recipes"))
    return _emit_skill_studio_event(
        project,
        canvas,
        {
            "type": "skill_studio.draft",
            "skill_studio_session_id": session_id,
            "mode": mode,
            "skill": skill,
            "recipes": recipes,
            "summary": str(args.get("summary") or "").strip(),
            "warnings": _safe_list(args.get("warnings")),
        },
    )


def _skill_studio_scope_from_args(
    args: dict[str, Any],
) -> tuple[str | None, str | None]:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    return project, canvas


def _skill_studio_session_id_from_args(args: dict[str, Any]) -> str:
    return str(
        args.get("skill_studio_session_id") or args.get("session_id") or ""
    ).strip()


def _skill_studio_meta_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _skill_studio_collect_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "\n".join(_skill_studio_collect_text(item) for item in value.values())
    if isinstance(value, list):
        return "\n".join(_skill_studio_collect_text(item) for item in value)
    return ""


def _skill_studio_has_input_parameter(skill: dict[str, Any], parameter_id: str) -> bool:
    parameters = skill.get("input_parameters")
    if not isinstance(parameters, list):
        return False
    return any(
        isinstance(parameter, dict)
        and str(parameter.get("id") or "").strip() == parameter_id
        for parameter in parameters
    )


def _skill_studio_lint_draft(
    skill: dict[str, Any], recipes: list[dict[str, Any]]
) -> list[str]:
    warnings: list[str] = []
    has_shot_count = _skill_studio_has_input_parameter(skill, "shot_count")
    multi_output_markers = (
        "输出两条",
        "输出2条",
        "分别生成角色",
        "分别生成道具",
        "同时生成角色",
        "同时生成道具",
        "多个执行节点",
        "多个节点",
        "两个节点",
        "两个 image",
        "两个image",
        "两张图",
    )
    fixed_grid_markers = (
        "固定 9 宫格",
        "固定9宫格",
        "固定九宫格",
        "固定 9 个分镜",
        "固定9个分镜",
    )
    audio_compose_markers = (
        "最终成片",
        "最终合成",
        "合成为",
        "合成所有",
        "所有视频和音频",
        "videoCompose",
        "video compose",
    )
    for recipe in recipes:
        if not isinstance(recipe, dict):
            continue
        recipe_id = str(recipe.get("id") or "").strip() or "未命名 Recipe"
        text = _skill_studio_collect_text(recipe)
        compact_text = text.replace(" ", "")
        if (
            any(marker in text for marker in multi_output_markers)
            or "分别生成角色" in compact_text
        ):
            warnings.append(
                f"Recipe「{recipe_id}」可能一次生成多个执行节点。建议拆成单一阶段 Recipe。"
            )
        if has_shot_count and any(marker in text for marker in fixed_grid_markers):
            warnings.append(
                f"Recipe「{recipe_id}」固定了九宫格，但 Skill 已有分镜数量输入。建议让数量跟随开始前选项。"
            )
        output_kind = str(recipe.get("output_kind") or "").strip().lower()
        if output_kind == "audio" and any(
            marker in text for marker in audio_compose_markers
        ):
            warnings.append(
                f"Recipe「{recipe_id}」是音频输出，但包含最终合成说明。音频 Recipe 应只负责音频层，合成由动态计划处理。"
            )
    return warnings


def _skill_studio_stage_requires_recipe_chunk(stage: Any) -> bool:
    if not isinstance(stage, dict):
        return False
    reuse = str(stage.get("reuse") or "").strip().lower()
    return reuse != "existing"


def _skill_studio_new_recipe_craft_gap(stage: dict[str, Any]) -> str:
    value = stage.get("new_recipe_craft_gap")
    if value is None:
        value = stage.get("craft_gap")
    return str(value or "").strip()


def _skill_studio_outline_new_recipe_gap_errors(stages: list[Any]) -> list[str]:
    errors: list[str] = []
    for stage in stages:
        if not _skill_studio_stage_requires_recipe_chunk(stage):
            continue
        if not isinstance(stage, dict):
            errors.append("未命名阶段")
            continue
        recipe_id = str(
            stage.get("recipe_id") or stage.get("id") or "未命名阶段"
        ).strip()
        craft_gap = _skill_studio_new_recipe_craft_gap(stage)
        if not craft_gap:
            errors.append(recipe_id)
    return errors


def _skill_studio_missing_session_result() -> str:
    return tool_result(
        {
            "ok": False,
            "type": "skill_studio.draft",
            "status": "skill_studio_session_id_required",
            "error": "skill_studio_session_id is required",
        }
    )


def _handle_put_agent_catalog_draft_outline(args: dict[str, Any], **_: Any) -> str:
    project, canvas = _skill_studio_scope_from_args(args)
    session_id = _skill_studio_session_id_from_args(args)
    if not session_id:
        return _skill_studio_missing_session_result()
    mode = str(args.get("mode") or "create").strip() or "create"
    if mode not in {"create", "edit"}:
        mode = "create"
    try:
        expected_recipe_count = int(args.get("expected_recipe_count") or 0)
    except (TypeError, ValueError):
        expected_recipe_count = 0
    stages = _safe_list(args.get("stages"))
    recipe_chunk_count = sum(
        1 for stage in stages if _skill_studio_stage_requires_recipe_chunk(stage)
    )
    if stages:
        expected_recipe_count = recipe_chunk_count
    outline = {
        "reuse_goal": str(args.get("reuse_goal") or "").strip(),
        "skill_level_constraints": _safe_list(args.get("skill_level_constraints")),
        "stages": stages,
        "expected_recipe_count": max(0, expected_recipe_count),
        "planned_stage_count": len(stages),
        "reused_recipe_count": max(0, len(stages) - recipe_chunk_count),
        "recipe_chunk_count": max(0, recipe_chunk_count),
        "catalog_checked": bool(args.get("catalog_checked")),
        "catalog_notes": str(args.get("catalog_notes") or "").strip(),
        "warnings": _safe_list(args.get("warnings")),
    }
    if not outline["reuse_goal"]:
        return tool_result(
            {
                "ok": False,
                "status": "skill_studio_outline_reuse_goal_required",
                "error": "reuse_goal is required before creating the Skill Studio draft.",
                "skill_studio_session_id": session_id,
            }
        )
    if outline["expected_recipe_count"] > 0 and not stages:
        return tool_result(
            {
                "ok": False,
                "status": "skill_studio_outline_stages_required",
                "error": "stages must describe the planned Recipe boundaries when expected_recipe_count is greater than 0.",
                "skill_studio_session_id": session_id,
            }
        )
    if outline["expected_recipe_count"] > 0 and not outline["catalog_checked"]:
        return tool_result(
            {
                "ok": False,
                "status": "skill_studio_catalog_check_required",
                "error": "catalog_checked must be true after using injected catalog summary or freezone_list_agent_catalog.",
                "skill_studio_session_id": session_id,
                "agent_instruction": (
                    "Before drafting Recipes, check existing Recipe summaries. Use the injected catalog summary "
                    'or call freezone_list_agent_catalog(kind="recipes", query=...). Then call '
                    "freezone_put_agent_catalog_draft_outline again with catalog_checked=true."
                ),
            }
        )
    new_recipe_gap_errors = _skill_studio_outline_new_recipe_gap_errors(stages)
    if new_recipe_gap_errors:
        return tool_result(
            {
                "ok": False,
                "status": "skill_studio_outline_new_recipe_craft_gap_required",
                "error": (
                    "Every reuse=new stage must include new_recipe_craft_gap explaining why a new Recipe is needed."
                ),
                "invalid_recipe_ids": new_recipe_gap_errors,
                "skill_studio_session_id": session_id,
                "agent_instruction": (
                    "Revise the outline before beginning the draft. For each reuse=new stage, add "
                    "new_recipe_craft_gap explaining why a new Recipe is needed. Keep style, subject, brand, "
                    "visual taste, and aesthetic constraints in the Skill planning.prompt_guide/conduct_rules/evaluation."
                ),
            }
        )
    existing = _PENDING_SKILL_STUDIO_DRAFTS.get(session_id) if mode == "edit" else None
    _PENDING_SKILL_STUDIO_DRAFTS[session_id] = {
        "project_id": project or (existing or {}).get("project_id"),
        "canvas_id": canvas or (existing or {}).get("canvas_id"),
        "mode": mode,
        "summary": str(
            args.get("summary") or (existing or {}).get("summary") or ""
        ).strip(),
        "warnings": _safe_list(args.get("warnings"))
        or list(_safe_list((existing or {}).get("warnings"))),
        "expected_recipe_count": outline["expected_recipe_count"]
        or int((existing or {}).get("expected_recipe_count") or 0),
        "outline": outline,
        "skill": (existing or {}).get("skill"),
        "recipes": dict((existing or {}).get("recipes") or {}),
    }
    return _emit_skill_studio_progress_event(
        project,
        canvas,
        {
            "type": "skill_studio.status",
            "skill_studio_session_id": session_id,
            "status": "draft_outline_ready",
            "message": "已完成 Skill / Recipe 分工方案",
            "outline": outline,
        },
        agent_instruction=(
            "Skill 方案已通过。"
            "只提交本次新建的 Recipe；复用的已有 Recipe 已经写在 allowed_recipe_ids 里。"
            f"下一步必须调用 freezone_begin_agent_catalog_draft，expected_recipe_count={outline['expected_recipe_count']}，"
            f"skill_studio_session_id={session_id}。"
        ),
    )


def _handle_begin_agent_catalog_draft(args: dict[str, Any], **_: Any) -> str:
    project, canvas = _skill_studio_scope_from_args(args)
    session_id = _skill_studio_session_id_from_args(args)
    if not session_id:
        return _skill_studio_missing_session_result()
    mode = str(args.get("mode") or "create").strip() or "create"
    if mode not in {"create", "edit"}:
        mode = "create"
    try:
        expected_recipe_count = int(args.get("expected_recipe_count") or 0)
    except (TypeError, ValueError):
        expected_recipe_count = 0
    existing = _PENDING_SKILL_STUDIO_DRAFTS.get(session_id) if mode == "edit" else None
    if mode == "create":
        existing_create = _PENDING_SKILL_STUDIO_DRAFTS.get(session_id)
        outline = (
            existing_create.get("outline")
            if isinstance(existing_create, dict)
            else None
        )
        if expected_recipe_count > 0 and not isinstance(outline, dict):
            return tool_result(
                {
                    "ok": False,
                    "status": "skill_studio_outline_required",
                    "error": "Call freezone_put_agent_catalog_draft_outline before beginning a create draft with Recipes.",
                    "skill_studio_session_id": session_id,
                    "agent_instruction": (
                        "Before freezone_begin_agent_catalog_draft, call freezone_put_agent_catalog_draft_outline "
                        "with reuse_goal, skill_level_constraints, stages, expected_recipe_count, and catalog_checked=true."
                    ),
                }
            )
        if isinstance(outline, dict) and not bool(outline.get("catalog_checked")):
            return tool_result(
                {
                    "ok": False,
                    "status": "skill_studio_catalog_check_required",
                    "error": "The draft outline must confirm catalog_checked=true before creating Recipes.",
                    "skill_studio_session_id": session_id,
                    "agent_instruction": (
                        "Check existing Recipe summaries first, then call freezone_put_agent_catalog_draft_outline "
                        "again with catalog_checked=true."
                    ),
                }
            )
        if (
            isinstance(outline, dict)
            and int(outline.get("expected_recipe_count") or 0) > 0
            and not _safe_list(outline.get("stages"))
        ):
            return tool_result(
                {
                    "ok": False,
                    "status": "skill_studio_outline_stages_required",
                    "error": "The draft outline must include planned Recipe stages.",
                    "skill_studio_session_id": session_id,
                }
            )
        if isinstance(outline, dict):
            existing = existing_create
            expected_recipe_count = int(outline.get("expected_recipe_count") or 0)
    _PENDING_SKILL_STUDIO_DRAFTS[session_id] = {
        "project_id": project or (existing or {}).get("project_id"),
        "canvas_id": canvas or (existing or {}).get("canvas_id"),
        "mode": mode,
        "summary": str(
            args.get("summary") or (existing or {}).get("summary") or ""
        ).strip(),
        "warnings": _safe_list(args.get("warnings"))
        or list(_safe_list((existing or {}).get("warnings"))),
        "expected_recipe_count": max(0, expected_recipe_count)
        or int((existing or {}).get("expected_recipe_count") or 0),
        "outline": (existing or {}).get("outline"),
        "skill": (existing or {}).get("skill"),
        "recipes": dict((existing or {}).get("recipes") or {}),
    }
    return _emit_skill_studio_progress_event(
        project,
        canvas,
        {
            "type": "skill_studio.status",
            "skill_studio_session_id": session_id,
            "status": "draft_begin",
            "message": "正在创建草稿结构...",
        },
    )


def _normalize_skill_studio_skill(
    skill: dict[str, Any], *, existing: dict[str, Any] | None = None
) -> dict[str, Any]:
    normalized = dict(skill)
    normalized["schema_version"] = (
        _skill_studio_meta_text((existing or {}).get("schema_version"))
        or _SKILL_STUDIO_DEFAULT_SKILL_SCHEMA_VERSION
    )
    normalized["version"] = (
        _skill_studio_meta_text((existing or {}).get("version"))
        or _SKILL_STUDIO_DEFAULT_SKILL_VERSION
    )
    return normalized


def _handle_put_agent_catalog_skill(args: dict[str, Any], **_: Any) -> str:
    project, canvas = _skill_studio_scope_from_args(args)
    session_id = _skill_studio_session_id_from_args(args)
    if not session_id:
        return _skill_studio_missing_session_result()
    draft = _PENDING_SKILL_STUDIO_DRAFTS.setdefault(
        session_id,
        {
            "project_id": project,
            "canvas_id": canvas,
            "mode": str(args.get("mode") or "create").strip() or "create",
            "summary": "",
            "warnings": [],
            "expected_recipe_count": 0,
            "outline": None,
            "skill": None,
            "recipes": {},
        },
    )
    skill = args.get("skill") if isinstance(args.get("skill"), dict) else {}
    if not skill:
        return tool_result(
            {
                "ok": False,
                "status": "skill_required",
                "error": "skill must be a non-empty object",
                "skill_studio_session_id": session_id,
            }
        )
    draft["project_id"] = project or draft.get("project_id")
    draft["canvas_id"] = canvas or draft.get("canvas_id")
    draft["skill"] = _normalize_skill_studio_skill(skill, existing=draft.get("skill"))
    expected = int(draft.get("expected_recipe_count") or 0)
    recipes = draft.setdefault("recipes", {})
    if expected > 0:
        submitted = len(recipes)
        remaining = max(0, expected - submitted)
        if remaining > 0:
            next_missing_index = next(
                (
                    candidate
                    for candidate in range(expected)
                    if candidate not in recipes
                ),
                submitted,
            )
            agent_instruction = _skill_studio_agent_instruction(
                (
                    f"freezone_put_agent_catalog_recipe，index={next_missing_index}，"
                    f"skill_studio_session_id={session_id}。"
                ),
                f"Skill 已提交；Recipe 已提交 {submitted} / {expected}；剩余 {remaining} 个。",
                [
                    "提交新建 Recipe 时，使用 outline 里的中性工艺级 recipe_id。",
                    "不要把 Skill 的风格、题材、品牌、角色、产品或一次性案例词写进 Recipe 的 id/name/content。",
                    "现在不要调用 freezone_finish_agent_catalog_draft。",
                    "不要向用户复述工具字段；不要调用 skill_view、skills_list、tool_search 或 tool_describe；不要处理斜杠命令或内部状态名。",
                ],
            )
        else:
            agent_instruction = _skill_studio_agent_instruction(
                f"freezone_finish_agent_catalog_draft，skill_studio_session_id={session_id}。",
                f"Skill 已提交；Recipe 已提交 {submitted} / {expected}。",
                [
                    "不要向用户复述工具字段；不要调用 skill_view、skills_list、tool_search 或 tool_describe；不要处理斜杠命令或内部状态名。",
                ],
            )
    else:
        agent_instruction = _skill_studio_agent_instruction(
            f"freezone_finish_agent_catalog_draft，skill_studio_session_id={session_id}。",
            "Skill 已提交，本次不需要提交 Recipe。",
            [
                "不要向用户复述工具字段；不要调用 skill_view、skills_list、tool_search 或 tool_describe；不要处理斜杠命令或内部状态名。",
            ],
        )
    return _emit_skill_studio_progress_event(
        project or draft.get("project_id"),
        canvas or draft.get("canvas_id"),
        {
            "type": "skill_studio.status",
            "skill_studio_session_id": session_id,
            "status": "draft_skill_ready",
            "message": "已生成 Skill 基础配置",
        },
        agent_instruction=agent_instruction,
    )


def _handle_put_agent_catalog_recipe(args: dict[str, Any], **_: Any) -> str:
    project, canvas = _skill_studio_scope_from_args(args)
    session_id = _skill_studio_session_id_from_args(args)
    if not session_id:
        return _skill_studio_missing_session_result()
    draft = _PENDING_SKILL_STUDIO_DRAFTS.setdefault(
        session_id,
        {
            "project_id": project,
            "canvas_id": canvas,
            "mode": str(args.get("mode") or "create").strip() or "create",
            "summary": "",
            "warnings": [],
            "expected_recipe_count": 0,
            "outline": None,
            "skill": None,
            "recipes": {},
        },
    )
    recipe = args.get("recipe") if isinstance(args.get("recipe"), dict) else {}
    if not recipe:
        return tool_result(
            {
                "ok": False,
                "status": "recipe_required",
                "error": "recipe must be a non-empty object",
                "skill_studio_session_id": session_id,
            }
        )
    recipes = draft.setdefault("recipes", {})
    try:
        index = int(args.get("index"))
    except (TypeError, ValueError):
        index = len(recipes)
    recipes[index] = recipe
    expected = int(draft.get("expected_recipe_count") or 0)
    if expected > 0:
        message = f"已生成 Recipe {index + 1} / {expected}"
        count_payload = {"recipe_count": expected}
        remaining = max(0, expected - len(recipes))
        if remaining > 0:
            next_missing_index = next(
                (
                    candidate
                    for candidate in range(expected)
                    if candidate not in recipes
                ),
                len(recipes),
            )
            agent_instruction = _skill_studio_agent_instruction(
                (
                    f"freezone_put_agent_catalog_recipe，index={next_missing_index}，"
                    f"skill_studio_session_id={session_id}。"
                ),
                f"Recipe 已提交 {len(recipes)} / {expected}；剩余 {remaining} 个。",
                [
                    "提交新建 Recipe 时，使用 outline 里的中性工艺级 recipe_id。",
                    "不要把 Skill 的风格、题材、品牌、角色、产品或一次性案例词写进 Recipe 的 id/name/content。",
                    "现在不要调用 freezone_finish_agent_catalog_draft。",
                    "不要向用户复述工具字段；不要调用 skill_view、skills_list、tool_search 或 tool_describe；不要处理斜杠命令或内部状态名。",
                ],
            )
        else:
            agent_instruction = _skill_studio_agent_instruction(
                f"freezone_finish_agent_catalog_draft，skill_studio_session_id={session_id}。",
                f"全部预期 Recipe 已提交；Recipe 已提交 {len(recipes)} / {expected}。",
                [
                    "不要向用户复述工具字段；不要调用 skill_view、skills_list、tool_search 或 tool_describe；不要处理斜杠命令或内部状态名。",
                ],
            )
    else:
        message = f"已生成第 {index + 1} 个 Recipe"
        count_payload = {}
        agent_instruction = _skill_studio_agent_instruction(
            "freezone_put_agent_catalog_recipe 提交剩余 Recipe；全部计划 Recipe 提交完后，调用 freezone_finish_agent_catalog_draft。",
            f"Recipe 已提交 {len(recipes)} 个，未声明预期总数。",
            [
                "不要向用户复述工具字段；不要调用 skill_view、skills_list、tool_search 或 tool_describe；不要处理斜杠命令或内部状态名。",
            ],
        )
    return _emit_skill_studio_progress_event(
        project or draft.get("project_id"),
        canvas or draft.get("canvas_id"),
        {
            "type": "skill_studio.status",
            "skill_studio_session_id": session_id,
            "status": "draft_recipe_ready",
            "message": message,
            "recipe_index": index,
            **count_payload,
        },
        agent_instruction=agent_instruction,
    )


class _DraftPatchError(ValueError):
    pass


def _decode_json_pointer(path: object) -> list[str]:
    path_text = str(path or "")
    if not path_text.startswith("/"):
        raise _DraftPatchError("patch path must start with '/'")
    return [
        part.replace("~1", "/").replace("~0", "~") for part in path_text.split("/")[1:]
    ]


def _resolve_json_pointer_parent(obj: Any, tokens: list[str]) -> tuple[Any, str]:
    if not tokens:
        raise _DraftPatchError("patch path must point to a field")
    parent = obj
    for token in tokens[:-1]:
        if isinstance(parent, dict):
            if token not in parent:
                raise _DraftPatchError(f"patch parent path does not exist: {token}")
            parent = parent[token]
            continue
        if isinstance(parent, list):
            try:
                index = int(token)
            except ValueError as exc:
                raise _DraftPatchError(
                    f"list path segment must be a number: {token}"
                ) from exc
            if index < 0 or index >= len(parent):
                raise _DraftPatchError(f"list path index out of range: {token}")
            parent = parent[index]
            continue
        raise _DraftPatchError(f"patch parent is not traversable at: {token}")
    return parent, tokens[-1]


def _list_index_for_patch(
    parent: list[Any], key: str, *, allow_append: bool, allow_end: bool
) -> int:
    if key == "-":
        if allow_append:
            return len(parent)
        raise _DraftPatchError("'-' is only supported for list add")
    try:
        index = int(key)
    except ValueError as exc:
        raise _DraftPatchError(f"list path segment must be a number: {key}") from exc
    max_index = len(parent) if allow_end else len(parent) - 1
    if index < 0 or index > max_index:
        raise _DraftPatchError(f"list path index out of range: {key}")
    return index


def _apply_json_pointer_patch(
    obj: dict[str, Any], patch_ops: list[Any]
) -> dict[str, Any]:
    patched = deepcopy(obj)
    for raw_op in patch_ops:
        if not isinstance(raw_op, dict):
            raise _DraftPatchError("each patch operation must be an object")
        op = str(raw_op.get("op") or "").strip()
        path = str(raw_op.get("path") or "").strip()
        if op not in {"replace", "add", "remove"}:
            raise _DraftPatchError(f"unsupported patch op: {op}")
        tokens = _decode_json_pointer(path)
        if tokens and tokens[0] == "id":
            raise _DraftPatchError("patching id is not supported")
        parent, key = _resolve_json_pointer_parent(patched, tokens)
        if isinstance(parent, dict):
            if op in {"replace", "remove"} and key not in parent:
                raise _DraftPatchError(f"patch path does not exist: {path}")
            if op == "remove":
                parent.pop(key)
            else:
                parent[key] = deepcopy(raw_op.get("value"))
            continue
        if isinstance(parent, list):
            if op == "add":
                parent.insert(
                    _list_index_for_patch(
                        parent, key, allow_append=True, allow_end=True
                    ),
                    deepcopy(raw_op.get("value")),
                )
            elif op == "replace":
                parent[
                    _list_index_for_patch(
                        parent, key, allow_append=False, allow_end=False
                    )
                ] = deepcopy(raw_op.get("value"))
            else:
                parent.pop(
                    _list_index_for_patch(
                        parent, key, allow_append=False, allow_end=False
                    )
                )
            continue
        raise _DraftPatchError(f"patch target parent is not a dict or list: {path}")
    return patched


def _find_recipe_index_by_id(recipes: dict[Any, Any], recipe_id: str) -> Any | None:
    for index, recipe in recipes.items():
        if (
            isinstance(recipe, dict)
            and str(recipe.get("id") or "").strip() == recipe_id
        ):
            return index
    return None


def _skill_patch_message(patch_ops: list[Any]) -> str:
    first_path = ""
    for op in patch_ops:
        if isinstance(op, dict):
            first_path = str(op.get("path") or "")
            break
    if first_path.startswith("/triggers/keywords"):
        return "已更新 Skill 触发关键词"
    if first_path.startswith("/description"):
        return "已更新 Skill 说明"
    if first_path.startswith("/planning"):
        return "已更新 Skill 规划策略"
    return "已更新 Skill 草稿"


def _validate_recipe_patch_paths(recipe_id: str, patch_ops: list[Any]) -> None:
    for raw_op in patch_ops:
        if not isinstance(raw_op, dict):
            continue
        path = str(raw_op.get("path") or "").strip()
        if path.startswith("/recipes/"):
            example = path.removeprefix(f"/recipes/{recipe_id}") or "/system_prompt"
            if example == path:
                example = "/system_prompt"
            raise _DraftPatchError(
                "For target=recipe, recipe_id already selects the Recipe. "
                f"Patch paths must be relative to that Recipe object, for example {example}; "
                f"do not use {path}."
            )


def _is_remove_entire_recipe_patch(patch_ops: list[Any]) -> bool:
    if len(patch_ops) != 1 or not isinstance(patch_ops[0], dict):
        return False
    op = str(patch_ops[0].get("op") or "").strip()
    path = str(patch_ops[0].get("path") or "").strip()
    return op == "remove" and path == ""


def _handle_patch_agent_catalog_draft(args: dict[str, Any], **_: Any) -> str:
    project, canvas = _skill_studio_scope_from_args(args)
    session_id = _skill_studio_session_id_from_args(args)
    if not session_id:
        return _skill_studio_missing_session_result()
    draft = _PENDING_SKILL_STUDIO_DRAFTS.get(session_id)
    if draft is None:
        return tool_result(
            {
                "ok": False,
                "status": "skill_studio_draft_session_not_found",
                "error": "No pending Skill Studio draft exists for this skill_studio_session_id",
                "skill_studio_session_id": session_id,
            }
        )
    target = str(args.get("target") or "").strip()
    patch_ops = _safe_list(args.get("patch"))
    if target not in {"skill", "recipe"}:
        return tool_result(
            {
                "ok": False,
                "status": "draft_patch_failed",
                "error": "target must be skill or recipe",
                "skill_studio_session_id": session_id,
            }
        )
    if not patch_ops:
        return tool_result(
            {
                "ok": False,
                "status": "draft_patch_failed",
                "error": "patch must contain at least one operation",
                "skill_studio_session_id": session_id,
            }
        )
    try:
        if target == "skill":
            skill = draft.get("skill") if isinstance(draft.get("skill"), dict) else None
            if skill is None:
                raise _DraftPatchError(
                    "Cannot patch Skill before put_agent_catalog_skill"
                )
            patched_skill = _apply_json_pointer_patch(skill, patch_ops)
            draft["skill"] = patched_skill
            message = _skill_patch_message(patch_ops)
            patched_payload = {"target": "skill"}
        else:
            recipe_id = str(args.get("recipe_id") or "").strip()
            if not recipe_id:
                raise _DraftPatchError("recipe_id is required when target is recipe")
            recipes = (
                draft.get("recipes") if isinstance(draft.get("recipes"), dict) else {}
            )
            recipe_index = _find_recipe_index_by_id(recipes, recipe_id)
            if recipe_index is None:
                raise _DraftPatchError(f"Recipe not found: {recipe_id}")
            recipe = recipes[recipe_index]
            if not isinstance(recipe, dict):
                raise _DraftPatchError(f"Recipe is not an object: {recipe_id}")
            if _is_remove_entire_recipe_patch(patch_ops):
                recipes.pop(recipe_index)
                message = f"已移除 Recipe：{recipe_id}"
                patched_payload = {
                    "target": "recipe",
                    "recipe_id": recipe_id,
                    "recipe_index": recipe_index,
                    "removed": True,
                }
            else:
                _validate_recipe_patch_paths(recipe_id, patch_ops)
                recipes[recipe_index] = _apply_json_pointer_patch(recipe, patch_ops)
                message = f"已更新 Recipe：{recipe_id}"
                patched_payload = {
                    "target": "recipe",
                    "recipe_id": recipe_id,
                    "recipe_index": recipe_index,
                }
    except _DraftPatchError as exc:
        return tool_result(
            {
                "ok": False,
                "status": "draft_patch_failed",
                "error": str(exc),
                "skill_studio_session_id": session_id,
            }
        )
    progress = _emit_skill_studio_progress_event(
        project or draft.get("project_id"),
        canvas or draft.get("canvas_id"),
        {
            "type": "skill_studio.status",
            "skill_studio_session_id": session_id,
            "status": "draft_patch_applied",
            "message": message,
            **patched_payload,
        },
        agent_instruction=_skill_studio_agent_instruction(
            f"freezone_finish_agent_catalog_draft，skill_studio_session_id={session_id}。",
            f"{message}。",
            [
                "不要用普通文本解释本次修改；更新后的完整草稿必须通过 finish 工具重新展示给用户。",
                "不要向用户复述工具字段；不要调用 skill_view、skills_list、tool_search 或 tool_describe；不要处理斜杠命令或内部状态名。",
            ],
        ),
    )
    if isinstance(progress, dict):
        return tool_result(
            {
                **progress,
                "ok": progress.get("ok", True),
                "status": "draft_patch_applied",
                "skill_studio_status": "draft_progress",
                "message": message,
                **patched_payload,
            }
        )
    return progress


def _handle_finish_agent_catalog_draft(args: dict[str, Any], **_: Any) -> str:
    project, canvas = _skill_studio_scope_from_args(args)
    session_id = _skill_studio_session_id_from_args(args)
    if not session_id:
        return _skill_studio_missing_session_result()
    draft = _PENDING_SKILL_STUDIO_DRAFTS.get(session_id)
    if draft is None:
        return tool_result(
            {
                "ok": False,
                "status": "skill_studio_draft_session_not_found",
                "error": "No pending Skill Studio draft exists for this skill_studio_session_id",
                "skill_studio_session_id": session_id,
            }
        )
    skill = draft.get("skill") if isinstance(draft.get("skill"), dict) else {}
    if not skill:
        return tool_result(
            {
                "ok": False,
                "status": "skill_required",
                "error": "Cannot finish Skill Studio draft before put_agent_catalog_skill",
                "skill_studio_session_id": session_id,
            }
        )
    recipes_by_index = (
        draft.get("recipes") if isinstance(draft.get("recipes"), dict) else {}
    )
    recipes = [recipes_by_index[index] for index in sorted(recipes_by_index)]
    try:
        expected_recipe_count = int(
            args.get("expected_recipe_count") or draft.get("expected_recipe_count") or 0
        )
    except (TypeError, ValueError):
        expected_recipe_count = 0
    warnings = list(_safe_list(draft.get("warnings")))
    if expected_recipe_count and len(recipes) != expected_recipe_count:
        warnings.append(
            f"Recipe 数量为 {len(recipes)}，与预期 {expected_recipe_count} 不一致。"
        )
    seen_recipe_ids: set[str] = set()
    duplicate_recipe_ids: list[str] = []
    deduped_reversed: list[dict[str, Any]] = []
    for recipe in reversed(recipes):
        recipe_id = (
            str(recipe.get("id") or "").strip() if isinstance(recipe, dict) else ""
        )
        if recipe_id:
            if recipe_id in seen_recipe_ids:
                duplicate_recipe_ids.append(recipe_id)
                continue
            seen_recipe_ids.add(recipe_id)
        deduped_reversed.append(recipe)
    if duplicate_recipe_ids:
        duplicate_summary = "、".join(sorted(set(duplicate_recipe_ids)))
        warnings.append(
            f"检测到重复 Recipe ID，已保留最后一次提交的版本：{duplicate_summary}。"
        )
        recipes = list(reversed(deduped_reversed))
    for warning in _skill_studio_lint_draft(skill, recipes):
        if warning not in warnings:
            warnings.append(warning)
    result = _emit_skill_studio_event(
        project or draft.get("project_id"),
        canvas or draft.get("canvas_id"),
        {
            "type": "skill_studio.draft",
            "skill_studio_session_id": session_id,
            "mode": str(draft.get("mode") or "create"),
            "outline": (
                draft.get("outline") if isinstance(draft.get("outline"), dict) else None
            ),
            "skill": skill,
            "recipes": recipes,
            "summary": str(draft.get("summary") or args.get("summary") or "").strip(),
            "warnings": warnings,
        },
    )
    draft["skill"] = skill
    draft["recipes"] = {index: recipe for index, recipe in enumerate(recipes)}
    draft["warnings"] = warnings
    return result


def _handle_get_saved_agent_catalog_item(
    args: dict[str, Any],
    *,
    kind: str,
    id_keys: tuple[str, ...],
    tool_name: str,
) -> str:
    item_id = ""
    for key in id_keys:
        item_id = str(args.get(key) or "").strip()
        if item_id:
            break
    if not item_id:
        return _structured_tool_result(
            {
                "ok": False,
                "kind": kind,
                "status": "id_required",
                "error": f"{id_keys[0]} is required",
            },
            tool_name=tool_name,
        )
    response = _request("GET", f"/api/v1/freezone/agent-config/{kind}")
    if not response.get("ok", False):
        return _structured_tool_result(
            {
                "ok": False,
                "kind": kind,
                "id": item_id,
                "status": "catalog_read_failed",
                "error": response.get("error")
                or response.get("message")
                or "Failed to read saved catalog.",
                "response": response,
            },
            tool_name=tool_name,
        )
    items = response.get("data")
    if not isinstance(items, list):
        return _structured_tool_result(
            {
                "ok": False,
                "kind": kind,
                "id": item_id,
                "status": "catalog_shape_invalid",
                "error": "Saved catalog response data must be a list.",
                "response": response,
            },
            tool_name=tool_name,
        )
    for item in items:
        if isinstance(item, dict) and str(item.get("id") or "").strip() == item_id:
            return _structured_tool_result(
                {
                    "ok": True,
                    "kind": kind,
                    "id": item_id,
                    "item": item,
                },
                tool_name=tool_name,
            )
    return _structured_tool_result(
        {
            "ok": False,
            "kind": kind,
            "id": item_id,
            "status": "not_found",
            "error": f"Saved {kind[:-1]} not found: {item_id}",
            "available_ids": [
                str(item.get("id") or "")
                for item in items
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            ],
        },
        tool_name=tool_name,
    )


def _catalog_item_text(item: dict[str, Any], keys: tuple[str, ...]) -> str:
    values: list[str] = []
    for key in keys:
        value = item.get(key)
        if isinstance(value, str):
            values.append(value)
        elif isinstance(value, list):
            values.extend(str(entry) for entry in value if entry is not None)
        elif isinstance(value, dict):
            values.extend(str(entry) for entry in value.values() if entry is not None)
        elif value is not None:
            values.append(str(value))
    return "\n".join(values).lower()


def _catalog_query_tokens(query: str) -> list[str]:
    tokens = [
        token.strip()
        for token in re.split(
            r"[\s,，、/|;；:：()（）\[\]{}<>《》\"'`]+", query.lower()
        )
        if len(token.strip()) >= 2
    ]
    return list(dict.fromkeys(tokens))


def _catalog_item_match_score(
    item: dict[str, Any], keys: tuple[str, ...], query: str
) -> int:
    if not query:
        return 1
    text = _catalog_item_text(item, keys)
    if query in text:
        return max(1, len(_catalog_query_tokens(query))) + 1
    tokens = _catalog_query_tokens(query)
    return sum(1 for token in tokens if token in text)


def _summarize_agent_catalog_item(item: dict[str, Any], *, kind: str) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "description": str(item.get("description") or ""),
        "enabled": bool(item.get("enabled", False)),
        "schema_version": str(item.get("schema_version") or ""),
        "version": str(item.get("version") or ""),
    }
    if kind == "skills":
        allowed_recipe_ids = item.get("allowed_recipe_ids")
        input_parameters = item.get("input_parameters")
        summary.update(
            {
                "category": str(item.get("category") or ""),
                "allowed_recipe_ids": (
                    allowed_recipe_ids if isinstance(allowed_recipe_ids, list) else []
                ),
                "input_parameter_count": (
                    len(input_parameters) if isinstance(input_parameters, list) else 0
                ),
                "builtin": bool(item.get("builtin", False)),
                "owned": bool(item.get("owned", False)),
            }
        )
    else:
        action_keys = item.get("action_keys")
        summary.update(
            {
                "output_kind": str(item.get("output_kind") or ""),
                "action_keys": action_keys if isinstance(action_keys, list) else [],
                "result_summary": str(item.get("result_summary") or ""),
                "requires_source_media": bool(item.get("requires_source_media", False)),
                "force_enhancement": bool(item.get("force_enhancement", False)),
                "builtin": bool(item.get("builtin", False)),
                "owned": bool(item.get("owned", False)),
            }
        )
    return summary


def _handle_list_agent_catalog(args: dict[str, Any], **_: Any) -> str:
    kind = str(args.get("kind") or "").strip()
    if kind not in {"skills", "recipes"}:
        return _structured_tool_result(
            {
                "ok": False,
                "status": "kind_invalid",
                "error": "kind must be 'skills' or 'recipes'",
            },
            tool_name="freezone_list_agent_catalog",
        )
    query = str(args.get("query") or args.get("q") or "").strip().lower()
    try:
        limit = int(args.get("limit") or 12)
    except (TypeError, ValueError):
        limit = 12
    limit = min(max(limit, 1), 30)

    response = _request("GET", f"/api/v1/freezone/agent-config/{kind}")
    if not response.get("ok", False):
        return _structured_tool_result(
            {
                "ok": False,
                "kind": kind,
                "status": "catalog_read_failed",
                "error": response.get("error")
                or response.get("message")
                or "Failed to read saved catalog.",
                "response": response,
            },
            tool_name="freezone_list_agent_catalog",
        )
    raw_items = response.get("data")
    if not isinstance(raw_items, list):
        return _structured_tool_result(
            {
                "ok": False,
                "kind": kind,
                "status": "catalog_shape_invalid",
                "error": "Saved catalog response data must be a list.",
                "response": response,
            },
            tool_name="freezone_list_agent_catalog",
        )

    searchable_keys = (
        "id",
        "name",
        "description",
        "category",
        "output_kind",
        "action_keys",
        "allowed_recipe_ids",
        "result_summary",
    )
    items = [item for item in raw_items if isinstance(item, dict)]
    scored_items = [
        (_catalog_item_match_score(item, searchable_keys, query), index, item)
        for index, item in enumerate(items)
    ]
    matched = [
        item
        for score, _index, item in sorted(
            scored_items, key=lambda entry: (-entry[0], entry[1])
        )
        if score > 0
    ]
    summarized = [
        _summarize_agent_catalog_item(item, kind=kind) for item in matched[:limit]
    ]
    fallback_items = (
        [_summarize_agent_catalog_item(item, kind=kind) for item in items[:limit]]
        if query and not summarized
        else []
    )
    return _structured_tool_result(
        {
            "ok": True,
            "kind": kind,
            "query": query,
            "count": len(summarized),
            "total_count": len(items),
            "items": summarized,
            "fallback_items": fallback_items,
            "available_ids": [
                str(item.get("id") or "")
                for item in items
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            ],
        },
        tool_name="freezone_list_agent_catalog",
    )


def _handle_get_saved_skill(args: dict[str, Any], **_: Any) -> str:
    return _handle_get_saved_agent_catalog_item(
        args,
        kind="skills",
        id_keys=("skill_id", "id"),
        tool_name="freezone_get_saved_skill",
    )


def _handle_get_saved_recipe(args: dict[str, Any], **_: Any) -> str:
    return _handle_get_saved_agent_catalog_item(
        args,
        kind="recipes",
        id_keys=("recipe_id", "id"),
        tool_name="freezone_get_saved_recipe",
    )


def _handle_selection(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "selection_detail"}],
    )


def _handle_node_detail(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    node_id = str(args.get("node_id") or args.get("nodeId") or "").strip()
    if not node_id:
        return tool_result(
            {"ok": False, "status": "node_id_required", "error": "node_id is required"}
        )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "node_detail", "node_id": node_id}],
    )


def _handle_neighbor_graph(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    node_id = str(args.get("node_id") or args.get("nodeId") or "").strip()
    if not node_id:
        return tool_result(
            {"ok": False, "status": "node_id_required", "error": "node_id is required"}
        )
    request: dict[str, Any] = {"type": "neighbor_graph", "node_id": node_id}
    if isinstance(args.get("depth"), (int, float)) and args["depth"] > 0:
        request["depth"] = args["depth"]
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[request],
    )


def _handle_node_action_catalog(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    node_id = str(args.get("node_id") or args.get("nodeId") or "").strip()
    if not node_id:
        return tool_result(
            {"ok": False, "status": "node_id_required", "error": "node_id is required"}
        )
    action = str(
        args.get("action") or args.get("action_name") or args.get("actionName") or ""
    ).strip()
    request: dict[str, Any] = {"type": "node_action_catalog", "node_id": node_id}
    if action:
        request["action"] = action
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[request],
    )


def _handle_node_create_schema(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    node_type = str(args.get("node_type") or args.get("nodeType") or "").strip()
    if not node_type:
        return tool_result(
            {
                "ok": False,
                "status": "node_type_required",
                "error": "node_type is required",
            }
        )
    if node_type not in _AGENT_CREATABLE_NODE_TYPE_VALUES:
        return tool_result(
            {
                "ok": False,
                "status": "invalid_node_type",
                "error": (
                    "node_type must be a directly creatable Freezone node type. "
                    "Use freezone_group_nodes/group_nodes for grouping existing nodes; "
                    "do not directly create or request create schemas for node types outside the "
                    "creatable values exposed by the command catalog."
                ),
            }
        )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "node_create_schema", "node_type": node_type}],
    )


def _handle_audio_voice_options(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    node_id = str(args.get("node_id") or args.get("nodeId") or "").strip()
    if not node_id:
        return tool_result(
            {"ok": False, "status": "node_id_required", "error": "node_id is required"}
        )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "audio_voice_options", "node_id": node_id}],
    )


def _handle_slot_candidates(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    slot_kind = str(args.get("slot_kind") or args.get("slotKind") or "").strip()
    request: dict[str, Any] = {"type": "slot_candidates"}
    if slot_kind:
        request["slot_kind"] = slot_kind
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[request],
    )


def _handle_mainline_projection_assets(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    request: dict[str, Any] = {"type": "mainline_projection_assets"}

    def _normalize_projection_asset_kind(value: Any) -> str | None:
        text = str(value).strip()
        if not text:
            return None
        if text in {
            "identity",
            "portrait",
            "character_identity",
            "character_portrait",
            "identity_portrait",
        }:
            return "character"
        return text

    asset_kinds = args.get("asset_kinds") or args.get("assetKinds")
    if isinstance(asset_kinds, list):
        values = [
            normalized
            for item in asset_kinds
            if (normalized := _normalize_projection_asset_kind(item))
        ]
        if values:
            request["asset_kinds"] = list(dict.fromkeys(values))
    asset_kind = str(args.get("asset_kind") or args.get("assetKind") or "").strip()
    if asset_kind and "asset_kinds" not in request:
        normalized = _normalize_projection_asset_kind(asset_kind)
        if normalized:
            request["asset_kinds"] = [normalized]
    query = str(args.get("query") or args.get("q") or "").strip()
    if query:
        request["query"] = query
    limit = args.get("limit")
    if isinstance(limit, (int, float)):
        request["limit"] = int(limit)
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[request],
    )


def _validation_payload(args: dict[str, Any]) -> dict[str, Any]:
    if isinstance(args.get("commands"), list) and args["commands"]:
        return {
            "schema_version": "canvas_chat_commands.v1",
            "commands": args["commands"],
        }
    return {}


def _legacy_tool_argument_error(
    args: dict[str, Any], legacy_names: tuple[str, ...]
) -> dict[str, Any] | None:
    legacy_fields = sorted(field for field in legacy_names if field in args)
    if not legacy_fields:
        return None
    return {
        "ok": False,
        "status": "legacy_tool_argument_rejected",
        "error": (
            "unsupported legacy field(s): "
            + ", ".join(legacy_fields)
            + "; use project_id and canvas_id"
        ),
    }


def _handle_validate_commands(args: dict[str, Any], **_: Any) -> str:
    try:
        if legacy_error := _legacy_tool_argument_error(
            args, ("project", "canvasId", "body", "envelope")
        ):
            return tool_result(legacy_error)
        project = str(args.get("project_id") or _default_project_id()).strip() or None
        canvas = str(args.get("canvas_id") or _default_canvas_id()).strip() or None
        payload = _validation_payload(args)
        if not payload:
            return tool_result(
                {
                    "ok": False,
                    "status": "empty_validation_payload",
                    "error": "commands is required",
                    **(_scope_meta(project, canvas) if project and canvas else {}),
                }
            )
        commands = payload.get("commands")
        if isinstance(commands, list):
            shape_error = _validate_write_commands_shape(project, canvas, commands)
            if shape_error:
                return shape_error
        return _request_canvas_context_from_frontend(
            project=project,
            canvas=canvas,
            requests=[{"type": "validate_canvas_commands", "payload": payload}],
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_summarize_canvas(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "canvas_summary"}],
    )


_FORBIDDEN_EDGE_FIELDS = (
    "role",
    "link_kind",
    "semantic_kind",
    "semantic_reason",
    "semantic_description",
)

_COMMAND_TYPES = {
    "create_node",
    "add_next_node",
    "update_node_data",
    "delete_nodes",
    "clear_canvas",
    "delete_edges",
    "create_edge",
    "layout_nodes",
    "group_nodes",
    "move_nodes",
    "select_nodes",
    "run_node_action",
    "run_workflow",
    "open_mainline_projection",
}

_COMMAND_REQUIRED_FIELDS = {
    "create_node": ("node_type",),
    "add_next_node": ("source_node_id",),
    "update_node_data": ("node_id", "data"),
    "delete_nodes": ("node_ids",),
    "layout_nodes": ("mode",),
    "group_nodes": ("node_ids",),
    "select_nodes": ("node_ids",),
    "run_node_action": ("node_id", "action"),
    "open_mainline_projection": ("request",),
}


_WORKFLOW_LIKE_NODE_TYPES = {
    "imageGenNode",
    "videoNode",
    "audioNode",
    "videoComposeNode",
    "scriptNode",
    "storyboardGenNode",
}

_WORKFLOW_HINTS = (
    "工作流",
    "workflow",
    "广告",
    "投放",
    "产品",
    "商品",
    "短剧",
    "小说",
    "故事",
    "mv",
    "音乐视频",
    "文生",
    "图生",
    "视频",
    "音频",
)


def _emit_command_error(
    project: str | None, canvas: str | None, status: str, error: str
) -> str:
    return tool_result(
        {
            "ok": False,
            "status": status,
            "error": error,
            **_scope_meta(project or "", canvas),
        }
    )


def _command_text(command: dict[str, Any]) -> str:
    values: list[str] = []
    for key in (
        "client_id",
        "node_type",
        "label",
        "title",
        "displayName",
        "display_name",
    ):
        value = command.get(key)
        if value is not None:
            values.append(str(value))
    data = command.get("data")
    if isinstance(data, dict):
        for key in (
            "displayName",
            "display_name",
            "title",
            "label",
            "prompt",
            "text",
            "content",
        ):
            value = data.get(key)
            if value is not None:
                values.append(str(value))
    return "\n".join(values).lower()


def _looks_like_handwritten_workflow_batch(commands: list[Any]) -> bool:
    object_commands = [command for command in commands if isinstance(command, dict)]
    create_commands = [
        command
        for command in object_commands
        if command.get("type") in {"create_node", "add_next_node"}
    ]
    if len(create_commands) < 3:
        return False
    workflow_like_count = sum(
        1
        for command in create_commands
        if command.get("node_type") in _WORKFLOW_LIKE_NODE_TYPES
    )
    if workflow_like_count < 2:
        return False
    has_dependency_shape = any(
        command.get("type")
        in {"create_edge", "group_nodes", "layout_nodes", "select_nodes"}
        for command in object_commands
    )
    haystack = "\n".join(_command_text(command) for command in object_commands)
    has_workflow_hint = any(hint in haystack for hint in _WORKFLOW_HINTS)
    return (not has_dependency_shape) or has_workflow_hint


def _validate_write_commands_shape(
    project: str | None,
    canvas: str | None,
    commands: list[Any],
) -> str | None:
    for index, command in enumerate(commands):
        if not isinstance(command, dict):
            return _emit_command_error(
                project,
                canvas,
                "invalid_command",
                f"commands[{index}] must be an object",
            )
        if command.get("schema_version") == "canvas_context_request.v1":
            return _emit_command_error(
                project,
                canvas,
                "wrong_tool",
                (
                    "canvas_context_request.v1 is read-only context retrieval. "
                    "Use a specific Freezone get_* context tool or freezone_validate_canvas_commands, "
                    "not a write tool."
                ),
            )
        if "command" in command and "type" not in command:
            return _emit_command_error(
                project,
                canvas,
                "invalid_command_schema",
                (
                    f"commands[{index}] uses legacy field 'command'. Use 'type' instead, "
                    "for example {'type': 'create_node', 'node_type': 'textAnnotationNode', 'data': {...}}."
                ),
            )
        command_type = command.get("type")
        if not isinstance(command_type, str) or not command_type.strip():
            return _emit_command_error(
                project,
                canvas,
                "invalid_command_schema",
                f"commands[{index}] missing required field 'type'.",
            )
        if command_type not in _COMMAND_TYPES:
            return _emit_command_error(
                project,
                canvas,
                "invalid_command_type",
                (
                    f"commands[{index}].type must be one of: {', '.join(sorted(_COMMAND_TYPES))}; "
                    f"got {command_type!r}."
                ),
            )
        if "nodeType" in command:
            return _emit_command_error(
                project,
                canvas,
                "invalid_command_schema",
                f"commands[{index}] uses legacy field 'nodeType'. Use snake_case 'node_type'.",
            )
        data = command.get("data")
        if isinstance(data, dict) and "nodeType" in data:
            return _emit_command_error(
                project,
                canvas,
                "invalid_command_schema",
                (
                    f"commands[{index}].data.nodeType is invalid. Put the canvas node type at "
                    "commands[index].node_type."
                ),
            )
        if "imageGenerationParams" in command or (
            isinstance(data, dict) and "imageGenerationParams" in data
        ):
            return _emit_command_error(
                project,
                canvas,
                "invalid_command_schema",
                (
                    f"commands[{index}] uses legacy imageGenerationParams. Flatten supported image node "
                    "fields into data, e.g. data.prompt, data.model, data.quality, data.aspectRatio."
                ),
            )
        missing_required = [
            field
            for field in _COMMAND_REQUIRED_FIELDS.get(command_type, ())
            if command.get(field) in (None, "", [], {})
        ]
        if missing_required:
            return _emit_command_error(
                project,
                canvas,
                "invalid_command_schema",
                f"commands[{index}] {command_type} missing required field(s): {', '.join(missing_required)}",
            )
        if command_type == "run_workflow":
            node_ids = command.get("node_ids")
            scope = str(command.get("scope") or "").strip()
            if (
                not (
                    isinstance(node_ids, list)
                    and any(str(node_id).strip() for node_id in node_ids)
                )
                and scope != "canvas"
            ):
                return _emit_command_error(
                    project,
                    canvas,
                    "invalid_command_schema",
                    (
                        f"commands[{index}] run_workflow requires a non-empty node_ids "
                        "array or scope=canvas"
                    ),
                )
        if command_type == "create_node" or (
            command_type == "add_next_node"
            and command.get("node_type") not in (None, "")
        ):
            node_type = str(command.get("node_type") or "").strip()
            if node_type not in _AGENT_CREATABLE_NODE_TYPE_VALUES:
                return _emit_command_error(
                    project,
                    canvas,
                    "invalid_node_type",
                    (
                        f"commands[{index}].node_type must be a directly creatable node type; "
                        f"got {node_type!r}. Use group_nodes/freezone_group_nodes to group existing "
                        "nodes, and only use creatable node types exposed by the command catalog."
                    ),
                )
            if node_type == "textAnnotationNode":
                node_data = command.get("data")
                missing_text_fields = [
                    field
                    for field in ("title", "content")
                    if not isinstance(node_data, dict)
                    or not str(node_data.get(field) or "").strip()
                ]
                if missing_text_fields:
                    return _emit_command_error(
                        project,
                        canvas,
                        "invalid_command_schema",
                        (
                            f"commands[{index}] create_node requires textAnnotationNode "
                            f"{', '.join(missing_text_fields)} in data"
                        ),
                    )
        if command.get("type") == "create_edge":
            missing = [
                field
                for field in ("source", "target", "link_type")
                if not command.get(field)
            ]
            if missing:
                return _emit_command_error(
                    project,
                    canvas,
                    "invalid_create_edge",
                    f"commands[{index}] create_edge missing required field(s): {', '.join(missing)}",
                )
            forbidden = [field for field in _FORBIDDEN_EDGE_FIELDS if field in command]
            if forbidden:
                return _emit_command_error(
                    project,
                    canvas,
                    "invalid_create_edge",
                    (
                        f"commands[{index}] create_edge must use link_type only; "
                        f"remove legacy field(s): {', '.join(forbidden)}"
                    ),
                )
    return None


def _mcp_direct_canvas_apply_enabled() -> bool:
    return os.environ.get("DRAMACLAW_MCP_DIRECT_CANVAS_APPLY", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _external_mcp_agent_enabled() -> bool:
    return os.environ.get("DRAMACLAW_EXTERNAL_MCP", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


_GENERATION_ACTION_NODE_TYPES = {
    "generate_image": "imageGenNode",
    "generate_video": "videoNode",
}
_GENERATION_PARAMETER_FIELDS = {
    "imageGenNode": ("model", "aspectRatio", "size", "quality", "count"),
    "videoNode": (
        "model",
        "aspectRatio",
        "quality",
        "durationSec",
        "generateAudio",
        "count",
    ),
}
_RECOMMENDED_GENERATION_MODEL_VALUES = {
    "auto",
    "default",
    "recommend",
    "recommended",
    "推荐",
    "推荐模型",
    "默认",
    "自动",
}


def _generation_parameter_value_present(field: str, value: Any) -> bool:
    if field == "generateAudio":
        return isinstance(value, bool)
    if field in {"count", "durationSec"}:
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and value > 0
        )
    return isinstance(value, str) and bool(value.strip())


def _use_frontend_default_for_recommended_models(commands: list[Any]) -> None:
    """Resolve a symbolic recommendation through the frontend's live default.

    The sentinel stays present through parameter preflight to record that the
    user answered. It is removed only immediately before dispatch because it is
    a preference, not a model catalog id.
    """
    for command in commands:
        if not isinstance(command, dict):
            continue
        if str(command.get("type") or "").strip() not in {
            "create_node",
            "update_node_data",
        }:
            continue
        data = command.get("data")
        if not isinstance(data, dict):
            continue
        model = str(data.get("model") or "").strip().lower()
        if model in _RECOMMENDED_GENERATION_MODEL_VALUES:
            data.pop("model", None)


def _canvas_generation_preflight_state(
    project: str,
    canvas: str,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], dict[str, Any] | None]:
    response = _request(
        "GET",
        f"/api/v1/projects/{quote(project, safe='')}/freezone/canvases/"
        f"{quote(canvas, safe='')}",
    )
    if not response.get("ok", True):
        return (
            {},
            [],
            {
                "ok": False,
                "status": "generation_parameter_preflight_unavailable",
                "code": "generation_parameter_preflight_unavailable",
                "error": response.get("error")
                or "failed to read canvas before generation",
                "agent_instruction": (
                    "Do not write or run the canvas. Report that generation parameter "
                    "preflight could not read the current canvas, then retry only after the "
                    "canvas is available."
                ),
            },
        )
    current = response.get("data") if isinstance(response.get("data"), dict) else {}
    nodes = {
        str(node.get("id")): _clone_json(node)
        for node in current.get("nodes") or []
        if isinstance(node, dict) and str(node.get("id") or "").strip()
    }
    edges = [
        _clone_json(edge)
        for edge in current.get("edges") or []
        if isinstance(edge, dict)
    ]
    return nodes, edges, None


def _workflow_generation_target_ids(
    command: dict[str, Any],
    nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
) -> set[str]:
    scope = str(command.get("scope") or "").strip()
    if scope == "canvas":
        return set(nodes)
    starts = {
        str(node_id).strip()
        for node_id in command.get("node_ids") or []
        if str(node_id).strip()
    }
    direction = str(command.get("direction") or "connected").strip()
    if direction == "node":
        return starts
    adjacency: dict[str, set[str]] = {}
    for edge in edges:
        source = str(edge.get("source") or "").strip()
        target = str(edge.get("target") or "").strip()
        if not source or not target:
            continue
        adjacency.setdefault(source, set()).add(target)
        if direction == "connected":
            adjacency.setdefault(target, set()).add(source)
    pending = list(starts)
    visited = set(starts)
    while pending:
        current = pending.pop()
        for target in adjacency.get(current, set()):
            if target in visited:
                continue
            visited.add(target)
            pending.append(target)
    return visited


def _generation_parameters_required_result(
    missing: list[dict[str, Any]],
) -> dict[str, Any]:
    media_types = sorted(
        {
            "image" if item["node_type"] == "imageGenNode" else "video"
            for item in missing
        }
    )
    required_choices = {
        "image": ["model", "aspect_ratio", "resolution", "quality", "count"],
        "video": [
            "model",
            "aspect_ratio",
            "resolution",
            "duration_seconds",
            "generate_audio",
            "count",
        ],
    }
    return {
        "ok": False,
        "status": "clarification_required",
        "code": "generation_parameters_required",
        "error": "image/video generation parameters require user clarification",
        "media_types": media_types,
        "missing_parameters": missing,
        "required_choices": {
            media_type: required_choices[media_type] for media_type in media_types
        },
        "clarification": {
            "title": "确认图片和视频生成参数",
            "allow_recommended": True,
            "allow_skip": False,
        },
        "agent_instruction": (
            "Stop before every canvas write. Call freezone_request_user_clarification "
            "exactly once for all missing image/video choices, offering a recommended "
            "option. After the user answers, retry the same operation with the chosen "
            "values. For a WorkflowPlan, put them in each image/video node data. For a "
            "workflow draft, patch inputs with the portable image_* and video_* keys. "
            "Do not claim success and do not silently choose defaults."
        ),
    }


def _external_generation_parameter_preflight(
    project: str,
    canvas: str,
    commands: list[Any],
) -> dict[str, Any] | None:
    if not _external_mcp_agent_enabled():
        return None
    execution_commands = [
        command
        for command in commands
        if isinstance(command, dict)
        and (
            command.get("type") == "run_workflow"
            or (
                command.get("type") == "run_node_action"
                and str(command.get("action") or "") in _GENERATION_ACTION_NODE_TYPES
            )
        )
    ]
    if not execution_commands:
        return None
    created_ids = {
        str(command.get("client_id") or "").strip()
        for command in commands
        if isinstance(command, dict)
        and command.get("type") == "create_node"
        and str(command.get("client_id") or "").strip()
    }
    needs_canvas_read = any(
        command.get("type") == "run_workflow"
        and (
            str(command.get("scope") or "").strip() == "canvas"
            or not command.get("node_ids")
            or any(
                str(node_id).strip() not in created_ids
                for node_id in command.get("node_ids") or []
            )
        )
        or command.get("type") == "run_node_action"
        and str(command.get("node_id") or "").strip() not in created_ids
        for command in execution_commands
    )
    if needs_canvas_read:
        nodes, edges, read_error = _canvas_generation_preflight_state(project, canvas)
        if read_error is not None:
            return read_error
    else:
        nodes, edges = {}, []
    missing_by_node: dict[str, dict[str, Any]] = {}
    for raw_command in commands:
        if not isinstance(raw_command, dict):
            continue
        command_type = str(raw_command.get("type") or "").strip()
        if command_type == "create_node":
            node_id = str(raw_command.get("client_id") or "").strip()
            if node_id:
                nodes[node_id] = {
                    "id": node_id,
                    "type": str(raw_command.get("node_type") or "").strip(),
                    "data": _clone_json(raw_command.get("data") or {}),
                }
        elif command_type == "update_node_data":
            node_id = str(raw_command.get("node_id") or "").strip()
            node = nodes.get(node_id)
            if node is not None:
                data = node.get("data") if isinstance(node.get("data"), dict) else {}
                data.update(_clone_json(raw_command.get("data") or {}))
                node["data"] = data
        elif command_type == "create_edge":
            edges.append(
                {
                    "source": str(raw_command.get("source") or "").strip(),
                    "target": str(raw_command.get("target") or "").strip(),
                }
            )
        if command_type == "run_node_action":
            expected_type = _GENERATION_ACTION_NODE_TYPES.get(
                str(raw_command.get("action") or "")
            )
            target_ids = {str(raw_command.get("node_id") or "").strip()}
        elif command_type == "run_workflow":
            expected_type = None
            target_ids = _workflow_generation_target_ids(raw_command, nodes, edges)
        else:
            continue
        for node_id in target_ids:
            node = nodes.get(node_id)
            if node is None:
                continue
            node_type = str(node.get("type") or node.get("node_type") or "").strip()
            if expected_type is not None and node_type != expected_type:
                continue
            required_fields = _GENERATION_PARAMETER_FIELDS.get(node_type)
            if required_fields is None:
                continue
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            # Workflow graph approval is the single image/video parameter
            # confirmation point. Re-running the workflow must reuse the
            # persisted node configuration instead of opening another
            # clarification card. Runtime capability preflight still runs
            # below the write boundary and can reject unsupported values.
            if data.get("workflowConfigConfirmed") is True:
                continue
            if command_type == "run_workflow" and not raw_command.get("regenerate"):
                output_key = "imageUrl" if node_type == "imageGenNode" else "videoUrl"
                if isinstance(data.get(output_key), str) and data[output_key].strip():
                    continue
            missing_fields = [
                field
                for field in required_fields
                if not _generation_parameter_value_present(field, data.get(field))
            ]
            if missing_fields:
                missing_by_node[node_id] = {
                    "node_id": node_id,
                    "node_type": node_type,
                    "display_name": str(
                        data.get("displayName") or data.get("title") or node_id
                    )[:120],
                    "fields": missing_fields,
                }
    if not missing_by_node:
        return None
    return _generation_parameters_required_result(list(missing_by_node.values()))


def _mcp_canvas_approval_enabled() -> bool:
    value = os.environ.get("DRAMACLAW_MCP_CANVAS_APPROVAL", "").strip().lower()
    if value in {"0", "false", "no", "off"}:
        return False
    return _external_mcp_agent_enabled() or _mcp_direct_canvas_apply_enabled()


def _approval_dir() -> Path:
    root = os.environ.get("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "").strip()
    base = Path(root) if root else Path("/tmp") / "dramaclaw_canvas_command_bridge"
    return base / "mcp_canvas_approvals"


def _approval_path(approval_id: str) -> Path:
    safe = "".join(ch for ch in approval_id if ch.isalnum() or ch in {"_", "-"})
    return _approval_dir() / f"{safe}.json"


def _approval_required_for_commands(commands: list[Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    command_count = len(commands)
    command_types = [
        str(command.get("type") or "").strip()
        for command in commands
        if isinstance(command, dict)
    ]
    destructive = {"delete_nodes", "delete_edges"}
    mutating = {
        "create_node",
        "add_next_node",
        "update_node_data",
        "create_edge",
        "layout_nodes",
        "group_nodes",
        "move_nodes",
        "select_nodes",
        "clear_canvas",
    }
    costly_or_ui = {"run_node_action", "run_workflow", "open_mainline_projection"}
    if any(command_type in destructive for command_type in command_types):
        reasons.append("包含删除类画布操作")
    if any(command_type in mutating for command_type in command_types):
        reasons.append("包含画布结构或内容变更")
    if any(command_type in costly_or_ui for command_type in command_types):
        reasons.append("包含运行节点动作、生成任务或打开/映射主线内容")
    if command_count > 1:
        reasons.append(f"包含 {command_count} 个批量画布操作")
    if any(command_type == "group_nodes" for command_type in command_types):
        reasons.append("包含分组结构变更")
    return bool(reasons), reasons


def _requires_frontend_canvas_executor(commands: list[Any]) -> bool:
    frontend_types = {"run_node_action", "run_workflow", "open_mainline_projection"}
    return any(
        isinstance(command, dict)
        and str(command.get("type") or "").strip() in frontend_types
        for command in commands
    )


def _command_summary(commands: list[Any]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    created_nodes: list[dict[str, Any]] = []
    node_ids: list[str] = []
    for command in commands:
        if not isinstance(command, dict):
            continue
        command_type = str(command.get("type") or "unknown").strip() or "unknown"
        counts[command_type] = counts.get(command_type, 0) + 1
        if command_type == "create_node":
            created_nodes.append(
                {
                    "client_id": command.get("client_id"),
                    "node_type": command.get("node_type"),
                    "displayName": (
                        (command.get("data") or {}).get("displayName")
                        if isinstance(command.get("data"), dict)
                        else None
                    ),
                }
            )
        if isinstance(command.get("node_ids"), list):
            node_ids.extend(str(item) for item in command["node_ids"] if item)
        elif command.get("node_id"):
            node_ids.append(str(command.get("node_id")))
    return {
        "command_count": len(commands),
        "command_counts": counts,
        "created_nodes": created_nodes[:20],
        "node_ids": node_ids[:50],
    }


def _commands_include_type(commands: list[Any], command_type: str) -> bool:
    return any(
        isinstance(command, dict)
        and str(command.get("type") or "").strip() == command_type
        for command in commands
    )


def _commands_include_open_node_action(commands: list[Any]) -> bool:
    return any(
        isinstance(command, dict)
        and str(command.get("type") or "").strip() == "run_node_action"
        and str(command.get("action") or "").strip().startswith("open_")
        for command in commands
    )


def _create_mcp_canvas_approval(
    *,
    project: str,
    canvas: str,
    commands: list[Any],
    slim_result: bool,
    reasons: list[str],
) -> str:
    approval_id = f"mcp_canvas_{uuid.uuid4().hex}"
    now_ms = int(time.time() * 1000)
    expires_at_ms = now_ms + max(
        30_000,
        int(os.environ.get("DRAMACLAW_MCP_CANVAS_APPROVAL_TTL_MS", "300000")),
    )
    payload = {
        "approval_id": approval_id,
        "project_id": project,
        "canvas_id": canvas,
        "commands": commands,
        "slim_result": bool(slim_result),
        "reasons": reasons,
        "created_at_ms": now_ms,
        "expires_at_ms": expires_at_ms,
        "summary": _command_summary(commands),
    }
    directory = _approval_dir()
    directory.mkdir(parents=True, exist_ok=True)
    _approval_path(approval_id).write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )
    return tool_result(
        {
            "ok": False,
            "status": "approval_required",
            "code": "mcp_canvas_approval_required",
            "approval_id": approval_id,
            "project_id": project,
            "canvas_id": canvas,
            "reasons": reasons,
            "expires_at_ms": expires_at_ms,
            "summary": payload["summary"],
            "message": "该画布操作需要用户在 Codex 对话中确认后才能执行。",
            "agent_instruction": (
                "Ask the user to confirm this canvas operation in the Codex chat. "
                "If the user confirms, call freezone_confirm_canvas_action with approval_id. "
                "If the user cancels, call freezone_cancel_canvas_action."
            ),
        }
    )


def _dispatch_mcp_approved_frontend_commands(
    *,
    project: str,
    canvas: str,
    commands: list[Any],
    slim_result: bool,
) -> str:
    if (
        canvas_command_bridge_key is None
        or put_pending_canvas_command is None
        or wait_canvas_command_result is None
    ):
        return tool_error(
            "Canvas command bridge is unavailable; cannot dispatch frontend node action. "
            f"Import error: {_CANVAS_COMMAND_BRIDGE_IMPORT_ERROR}"
        )
    external_mcp = os.environ.get("DRAMACLAW_EXTERNAL_MCP", "").strip() == "1"
    profile = os.environ.get("DRAMACLAW_AGENT_PROFILE", "").strip()
    agent_id = (
        profile.removeprefix("freezone:").strip()
        if profile.startswith("freezone:")
        else "main"
    )
    envelope = {
        "schema_version": "canvas_chat_commands.v1",
        "project_id": project,
        "canvas_id": canvas,
        "commands": commands,
    }
    # Only Codex/external MCP commands need the reconnect polling fallback.
    # Hermes keeps its original websocket-only delivery path and envelope shape.
    if external_mcp:
        envelope["agent_id"] = agent_id or "main"
        envelope["external_mcp_command"] = True
    # Dynamic workflow commands carry a stable workflowInstanceId on every
    # create_node. Reuse one bridge key for identical retries so a lost MCP
    # response cannot create a second approval or duplicate the graph.
    is_workflow_batch = any(
        isinstance(command, dict)
        and command.get("type") == "create_node"
        and isinstance(command.get("data"), dict)
        and str(command["data"].get("workflowInstanceId") or "").strip()
        for command in commands
    )
    if is_workflow_batch and canvas_command_idempotency_key is not None:
        key = canvas_command_idempotency_key(
            project_id=project,
            canvas_id=canvas,
            commands=commands,
        )
    else:
        key = canvas_command_bridge_key(
            project_id=project, canvas_id=canvas, commands=commands
        )
    bridge_root = os.environ.get("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "").strip()
    # The worker launcher already gives each Hermes/Codex profile its
    # profile-scoped bridge directory (``.../freezone_freezone_main``). Do not
    # append another ``freezone_main`` here: that creates a nested directory
    # which the API's candidate-path resolver never polls, so the approval card
    # and the browser refresh both disappear.
    bridge_dir = Path(bridge_root) if bridge_root else None
    immediate_result = put_pending_canvas_command(
        key=key,
        project_id=project,
        canvas_id=canvas,
        commands=commands,
        envelope=envelope,
        bridge_dir=bridge_dir,
    )
    if immediate_result is not None:
        return tool_result(
            _summarize_canvas_command_result(
                immediate_result,
                bridge_key=key,
                commands=commands,
            )
            if slim_result
            else immediate_result
        )
    try:
        timeout_seconds = max(
            1,
            int(
                os.environ.get("DRAMACLAW_CANVAS_COMMAND_RESULT_TIMEOUT_SECONDS", "300")
            ),
        )
    except ValueError:
        timeout_seconds = 300
    timeout_result = {
        "ok": False,
        "tool_call_status": "failed",
        "canvas_apply_status": "timeout",
        "applied": False,
        "cancelled": True,
        "errors": ["Timed out waiting for frontend node action result."],
        "bridge_key": key,
        "project_id": project,
        "canvas_id": canvas,
        "message": "Frontend canvas command timed out before reporting a result.",
        "user_message": "画布操作等待超时，前端没有回写执行结果。",
        "agent_instruction": (
            "Do not claim success. Tell the user the frontend canvas command timed out and ask "
            "them to keep the Freezone page open or retry."
        ),
    }
    resolved = wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        timeout_result=timeout_result,
        bridge_dir=bridge_dir,
    )
    if resolved is not None:
        return tool_result(
            _summarize_canvas_command_result(
                resolved,
                bridge_key=key,
                commands=commands,
            )
            if slim_result
            else resolved
        )
    return tool_result(timeout_result)


def _dispatch_frontend_canvas_commands(
    *,
    project: str,
    canvas: str,
    commands: list[Any],
    slim_result: bool,
) -> str:
    if (
        canvas_command_bridge_key is None
        or put_pending_canvas_command is None
        or wait_canvas_command_result is None
    ):
        return tool_error(
            "Canvas command bridge is unavailable; cannot wait for frontend apply result. "
            f"Import error: {_CANVAS_COMMAND_BRIDGE_IMPORT_ERROR}"
        )
    envelope = {
        "schema_version": "canvas_chat_commands.v1",
        "project_id": project,
        "canvas_id": canvas,
        "commands": commands,
    }
    key = canvas_command_bridge_key(
        project_id=project, canvas_id=canvas, commands=commands
    )
    put_pending_canvas_command(
        key=key,
        project_id=project,
        canvas_id=canvas,
        commands=commands,
        envelope=envelope,
    )
    try:
        timeout_seconds = max(
            1,
            int(
                os.environ.get("DRAMACLAW_CANVAS_COMMAND_RESULT_TIMEOUT_SECONDS", "75")
            ),
        )
    except ValueError:
        timeout_seconds = 75
    timeout_result = {
        "ok": False,
        "tool_call_status": "failed",
        "canvas_apply_status": "timeout",
        "applied": False,
        "cancelled": True,
        "errors": ["Timed out waiting for frontend canvas command result."],
        "bridge_key": key,
        "project_id": project,
        "canvas_id": canvas,
        "message": "Canvas command timed out before the frontend reported a result.",
        "user_message": "画布操作等待超时，已自动取消，没有应用新的画布变更。",
        "agent_instruction": (
            "Do not claim success. Tell the user the canvas command timed out and ask "
            "them to retry after checking the canvas connection."
        ),
    }
    resolved = wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        timeout_result=timeout_result,
    )
    if resolved is not None:
        return tool_result(
            _summarize_canvas_command_result(
                resolved,
                bridge_key=key,
                commands=commands,
            )
            if slim_result
            else resolved
        )
    return tool_result(timeout_result)


def _read_mcp_canvas_approval(
    approval_id: str,
) -> tuple[dict[str, Any] | None, str | None]:
    path = _approval_path(approval_id)
    if not path.exists():
        return None, "approval not found or already handled"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, f"failed to read approval: {exc}"
    expires_at_ms = int(payload.get("expires_at_ms") or 0)
    if expires_at_ms and expires_at_ms < int(time.time() * 1000):
        try:
            path.unlink()
        except OSError:
            pass
        return None, "approval expired"
    return payload if isinstance(payload, dict) else None, None


def _handle_confirm_canvas_action(args: dict[str, Any], **_: Any) -> str:
    approval_id = str(args.get("approval_id") or args.get("approvalId") or "").strip()
    if not approval_id:
        return tool_result(
            {
                "ok": False,
                "status": "approval_id_required",
                "error": "approval_id is required",
            }
        )
    payload, error = _read_mcp_canvas_approval(approval_id)
    if error or payload is None:
        return tool_result(
            {"ok": False, "status": "approval_unavailable", "error": error}
        )
    path = _approval_path(approval_id)
    try:
        path.unlink()
    except OSError:
        pass
    project = str(payload.get("project_id") or "").strip()
    canvas = str(payload.get("canvas_id") or "").strip()
    commands = payload.get("commands")
    if not project or not canvas or not isinstance(commands, list):
        return tool_result(
            {
                "ok": False,
                "status": "invalid_approval_payload",
                "error": "approval payload is missing project_id, canvas_id, or commands",
            }
        )
    if not _mcp_direct_canvas_apply_enabled() or _requires_frontend_canvas_executor(
        commands
    ):
        return _dispatch_mcp_approved_frontend_commands(
            project=project,
            canvas=canvas,
            commands=commands,
            slim_result=bool(payload.get("slim_result", True)),
        )
    return _direct_apply_canvas_commands(
        project,
        canvas,
        commands,
        slim_result=bool(payload.get("slim_result", True)),
    )


def _handle_cancel_canvas_action(args: dict[str, Any], **_: Any) -> str:
    approval_id = str(args.get("approval_id") or args.get("approvalId") or "").strip()
    if not approval_id:
        return tool_result(
            {
                "ok": False,
                "status": "approval_id_required",
                "error": "approval_id is required",
            }
        )
    payload, error = _read_mcp_canvas_approval(approval_id)
    if error or payload is None:
        return tool_result(
            {"ok": False, "status": "approval_unavailable", "error": error}
        )
    try:
        _approval_path(approval_id).unlink()
    except OSError:
        pass
    return tool_result(
        {
            "ok": True,
            "status": "cancelled",
            "approval_id": approval_id,
            "project_id": payload.get("project_id"),
            "canvas_id": payload.get("canvas_id"),
            "message": "MCP canvas action was cancelled before apply.",
        }
    )


def _clone_json(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def _node_size(node_type: str) -> tuple[int, int]:
    if node_type in {"imageGenNode", "videoNode"}:
        return 480, 520
    if node_type == "audioNode":
        return 360, 190
    if node_type == "videoComposeNode":
        return 420, 240
    return 380, 240


def _resolve_command_node_ref(value: Any, id_map: dict[str, str]) -> str:
    text = str(value or "").strip()
    return id_map.get(text, text)


def _edge_id(source: str, target: str, link_type: str) -> str:
    return f"e-{source}-{target}-{link_type}"


def _default_link_type(source_type: str, target_type: str) -> str:
    if target_type in {"imageGenNode", "audioNode"}:
        return (
            "prompt_for"
            if source_type in {"textAnnotationNode", "scriptNode"}
            else "media_input_for"
        )
    if target_type == "videoNode":
        return (
            "media_input_for"
            if source_type in {"imageGenNode", "uploadNode"}
            else "prompt_for"
        )
    if target_type == "videoComposeNode":
        return "composition_input_for"
    return "context_for"


def _apply_layout(
    nodes_by_id: dict[str, dict[str, Any]], node_ids: list[str], mode: str
) -> None:
    targets = [nodes_by_id[node_id] for node_id in node_ids if node_id in nodes_by_id]
    if len(targets) < 2:
        return
    min_x = min(float((node.get("position") or {}).get("x") or 0) for node in targets)
    min_y = min(float((node.get("position") or {}).get("y") or 0) for node in targets)
    if mode == "vertical":
        for index, node in enumerate(targets):
            node["position"] = {"x": min_x, "y": min_y + index * 320}
    elif mode == "grid":
        cols = max(1, int(len(targets) ** 0.5 + 0.999))
        for index, node in enumerate(targets):
            node["position"] = {
                "x": min_x + (index % cols) * 520,
                "y": min_y + (index // cols) * 360,
            }
    else:
        for index, node in enumerate(targets):
            node["position"] = {"x": min_x + index * 520, "y": min_y}


def _create_group_node(
    *,
    nodes: list[dict[str, Any]],
    nodes_by_id: dict[str, dict[str, Any]],
    node_ids: list[str],
    label: str,
) -> str | None:
    members = [nodes_by_id[node_id] for node_id in node_ids if node_id in nodes_by_id]
    if len(members) < 2:
        return None
    min_x = min(float((node.get("position") or {}).get("x") or 0) for node in members)
    min_y = min(float((node.get("position") or {}).get("y") or 0) for node in members)
    max_x = max(
        float((node.get("position") or {}).get("x") or 0)
        + float(node.get("width") or (node.get("measured") or {}).get("width") or 380)
        for node in members
    )
    max_y = max(
        float((node.get("position") or {}).get("y") or 0)
        + float(node.get("height") or (node.get("measured") or {}).get("height") or 240)
        for node in members
    )
    group_x = min_x - 60
    group_y = min_y - 80
    width = int(max_x - min_x + 120)
    height = int(max_y - min_y + 160)
    group_id = str(uuid.uuid4())
    for node in members:
        position = (
            node.get("position") if isinstance(node.get("position"), dict) else {}
        )
        node["parentId"] = group_id
        node["position"] = {
            "x": float(position.get("x") or 0) - group_x,
            "y": float(position.get("y") or 0) - group_y,
        }
    group = {
        "id": group_id,
        "type": "groupNode",
        "position": {"x": group_x, "y": group_y},
        "data": {"displayName": label or "工作流", "label": label or "工作流"},
        "width": width,
        "height": height,
        "style": {"width": width, "height": height},
        "selected": False,
        "measured": {"width": width, "height": height},
    }
    nodes.append(group)
    nodes_by_id[group_id] = group
    return group_id


def _direct_apply_canvas_commands(
    project: str,
    canvas: str,
    commands: list[Any],
    *,
    slim_result: bool,
) -> str:
    response = _request(
        "GET",
        f"/api/v1/projects/{quote(project, safe='')}/freezone/canvases/{quote(canvas, safe='')}",
    )
    if not response.get("ok", True):
        return tool_result(
            {
                "ok": False,
                "tool_call_status": "failed",
                "canvas_apply_status": "read_failed",
                "project_id": project,
                "canvas_id": canvas,
                "errors": [response.get("error") or "failed to read canvas"],
            }
        )
    current = response.get("data") if isinstance(response.get("data"), dict) else {}
    nodes = _clone_json(
        current.get("nodes") if isinstance(current.get("nodes"), list) else []
    )
    edges = _clone_json(
        current.get("edges") if isinstance(current.get("edges"), list) else []
    )
    nodes_by_id = {
        str(node.get("id")): node
        for node in nodes
        if isinstance(node, dict) and str(node.get("id") or "").strip()
    }
    id_map: dict[str, str] = {}
    created_node_ids: list[str] = []
    command_results: list[dict[str, Any]] = []
    errors: list[str] = []

    for index, raw_command in enumerate(commands):
        command = raw_command if isinstance(raw_command, dict) else {}
        command_type = str(command.get("type") or "").strip()
        try:
            if command_type == "create_node":
                node_type = str(command.get("node_type") or "").strip()
                node_id = str(uuid.uuid4())
                client_id = str(command.get("client_id") or "").strip()
                if client_id:
                    id_map[client_id] = node_id
                width, height = _node_size(node_type)
                position = (
                    command.get("position")
                    if isinstance(command.get("position"), dict)
                    else {}
                )
                node = {
                    "id": node_id,
                    "type": node_type,
                    "position": {
                        "x": float(position.get("x") or 0),
                        "y": float(position.get("y") or 0),
                    },
                    "data": _clone_json(command.get("data") or {}),
                    "selected": False,
                    "measured": {"width": width, "height": height},
                }
                if node_type in {"imageGenNode", "videoNode"}:
                    node["width"] = width
                    node["height"] = height
                    node["style"] = {"width": width, "height": height}
                nodes.append(node)
                nodes_by_id[node_id] = node
                created_node_ids.append(node_id)
                command_results.append(
                    {
                        "commandIndex": index,
                        "type": command_type,
                        "status": "applied",
                        "nodeId": node_id,
                    }
                )
            elif command_type == "add_next_node":
                source = _resolve_command_node_ref(
                    command.get("source_node_id") or command.get("sourceNodeId"), id_map
                )
                source_node = nodes_by_id.get(source)
                if source_node is None:
                    raise ValueError(f"source node not found: {source}")
                node_type = str(command.get("node_type") or "").strip()
                node_id = str(uuid.uuid4())
                width, height = _node_size(node_type)
                source_position = (
                    source_node.get("position")
                    if isinstance(source_node.get("position"), dict)
                    else {}
                )
                node = {
                    "id": node_id,
                    "type": node_type,
                    "position": {
                        "x": float(source_position.get("x") or 0) + 520,
                        "y": float(source_position.get("y") or 0),
                    },
                    "data": _clone_json(command.get("data") or {}),
                    "selected": False,
                    "measured": {"width": width, "height": height},
                }
                if node_type in {"imageGenNode", "videoNode"}:
                    node["width"] = width
                    node["height"] = height
                    node["style"] = {"width": width, "height": height}
                nodes.append(node)
                nodes_by_id[node_id] = node
                created_node_ids.append(node_id)
                if command.get("connect", True):
                    link_type = _default_link_type(
                        str(source_node.get("type") or ""), node_type
                    )
                    edges.append(
                        {
                            "id": _edge_id(source, node_id, link_type),
                            "source": source,
                            "target": node_id,
                            "sourceHandle": "source",
                            "targetHandle": "target",
                            "type": "disconnectableEdge",
                            "data": {"link_type": link_type},
                        }
                    )
                command_results.append(
                    {
                        "commandIndex": index,
                        "type": command_type,
                        "status": "applied",
                        "nodeId": node_id,
                    }
                )
            elif command_type == "create_edge":
                source = _resolve_command_node_ref(command.get("source"), id_map)
                target = _resolve_command_node_ref(command.get("target"), id_map)
                link_type = str(command.get("link_type") or "context_for").strip()
                if source not in nodes_by_id or target not in nodes_by_id:
                    raise ValueError(
                        f"edge source/target not found: {source} -> {target}"
                    )
                edge = {
                    "id": _edge_id(source, target, link_type),
                    "source": source,
                    "target": target,
                    "sourceHandle": "source",
                    "targetHandle": "target",
                    "type": "disconnectableEdge",
                    "data": {"link_type": link_type},
                }
                edges = [item for item in edges if item.get("id") != edge["id"]]
                edges.append(edge)
                command_results.append(
                    {"commandIndex": index, "type": command_type, "status": "applied"}
                )
            elif command_type == "group_nodes":
                node_ids = [
                    _resolve_command_node_ref(item, id_map)
                    for item in command.get("node_ids", [])
                    if str(item or "").strip()
                ]
                group_id = _create_group_node(
                    nodes=nodes,
                    nodes_by_id=nodes_by_id,
                    node_ids=node_ids,
                    label=str(command.get("label") or "工作流"),
                )
                command_results.append(
                    {
                        "commandIndex": index,
                        "type": command_type,
                        "status": "applied" if group_id else "skipped",
                        "nodeId": group_id,
                    }
                )
            elif command_type == "layout_nodes":
                node_ids = [
                    _resolve_command_node_ref(item, id_map)
                    for item in command.get("node_ids", [])
                    if str(item or "").strip()
                ]
                _apply_layout(
                    nodes_by_id, node_ids, str(command.get("mode") or "horizontal")
                )
                command_results.append(
                    {"commandIndex": index, "type": command_type, "status": "applied"}
                )
            elif command_type == "select_nodes":
                selected_ids = {
                    _resolve_command_node_ref(item, id_map)
                    for item in command.get("node_ids", [])
                    if str(item or "").strip()
                }
                for node in nodes:
                    if isinstance(node, dict):
                        node["selected"] = str(node.get("id") or "") in selected_ids
                command_results.append(
                    {"commandIndex": index, "type": command_type, "status": "applied"}
                )
            elif command_type == "update_node_data":
                node_id = _resolve_command_node_ref(command.get("node_id"), id_map)
                node = nodes_by_id.get(node_id)
                if node is None:
                    raise ValueError(f"node not found: {node_id}")
                data = node.get("data") if isinstance(node.get("data"), dict) else {}
                data.update(_clone_json(command.get("data") or {}))
                node["data"] = data
                command_results.append(
                    {"commandIndex": index, "type": command_type, "status": "applied"}
                )
            elif command_type == "delete_nodes":
                delete_ids = {
                    _resolve_command_node_ref(item, id_map)
                    for item in command.get("node_ids", [])
                    if str(item or "").strip()
                }
                if delete_ids:
                    nodes = [
                        node
                        for node in nodes
                        if str(node.get("id") or "") not in delete_ids
                    ]
                    edges = [
                        edge
                        for edge in edges
                        if edge.get("source") not in delete_ids
                        and edge.get("target") not in delete_ids
                    ]
                    nodes_by_id = {
                        str(node.get("id")): node
                        for node in nodes
                        if isinstance(node, dict) and str(node.get("id") or "").strip()
                    }
                command_results.append(
                    {"commandIndex": index, "type": command_type, "status": "applied"}
                )
            elif command_type == "delete_edges":
                source = _resolve_command_node_ref(command.get("source"), id_map)
                target = _resolve_command_node_ref(command.get("target"), id_map)
                if source and target:
                    edges = [
                        edge
                        for edge in edges
                        if not (
                            edge.get("source") == source
                            and edge.get("target") == target
                        )
                    ]
                command_results.append(
                    {"commandIndex": index, "type": command_type, "status": "applied"}
                )
            else:
                raise ValueError(
                    f"{command_type} is not supported by direct MCP canvas apply"
                )
        except Exception as exc:
            errors.append(f"commands[{index}]: {exc}")
            command_results.append(
                {
                    "commandIndex": index,
                    "type": command_type or "unknown",
                    "status": "error",
                    "error": str(exc),
                }
            )
            break

    if errors:
        return tool_result(
            {
                "ok": False,
                "tool_call_status": "failed",
                "canvas_apply_status": "direct_apply_failed",
                "applied": False,
                "cancelled": False,
                "project_id": project,
                "canvas_id": canvas,
                "errors": errors,
                "command_results": command_results,
            }
        )

    payload = {
        "schema_version": 2,
        "canvas_id": canvas,
        "project_id": project,
        "canvas_scope": current.get("canvas_scope") or "default",
        "nodes": nodes,
        "edges": edges,
        "viewport": current.get("viewport"),
        "metadata": current.get("metadata"),
        "base_revision": current.get("revision"),
        "client_save_id": f"mcp-direct-canvas-apply:{int(time.time() * 1000)}",
        "save_source": "manual_clear" if not nodes else "manual_save",
        "allow_empty_overwrite": not nodes,
    }
    saved = _request(
        "PUT",
        f"/api/v1/projects/{quote(project, safe='')}/freezone/canvases/{quote(canvas, safe='')}",
        body=payload,
    )
    if not saved.get("ok", True):
        return tool_result(
            {
                "ok": False,
                "tool_call_status": "failed",
                "canvas_apply_status": "save_failed",
                "applied": False,
                "cancelled": False,
                "project_id": project,
                "canvas_id": canvas,
                "errors": [saved.get("error") or "failed to save canvas"],
                "command_results": command_results,
            }
        )
    resolved = {
        "ok": True,
        "tool_call_status": "completed",
        "canvas_apply_status": "direct_applied",
        "applied": True,
        "cancelled": False,
        "project_id": project,
        "canvas_id": canvas,
        "applied_count": len(command_results),
        "opened_ui_actions": 0,
        "created_node_ids": created_node_ids,
        "command_results": command_results,
        "revision": (
            (saved.get("data") or {}).get("revision")
            if isinstance(saved.get("data"), dict)
            else None
        ),
        "message": "Canvas commands were applied directly by the local MCP server.",
        "agent_instruction": "The canvas change has already been applied. Report success briefly.",
    }
    if slim_result:
        summarized = _summarize_canvas_command_result(
            resolved,
            bridge_key="mcp-direct",
            commands=commands,
        )
        summarized["canvas_apply_status"] = "direct_applied"
        summarized["revision"] = resolved.get("revision")
        return tool_result(summarized)
    return tool_result(resolved)


def _emit_canvas_commands(
    project: str | None,
    canvas: str | None,
    commands: list[Any],
    *,
    allow_dynamic_workflow_batch: bool = False,
    slim_result: bool = False,
) -> str:
    if not isinstance(commands, list) or not commands:
        return _emit_command_error(
            project, canvas, "empty_commands", "commands must be a non-empty array"
        )
    if not allow_dynamic_workflow_batch and _looks_like_handwritten_workflow_batch(
        commands
    ):
        return _emit_command_error(
            project,
            canvas,
            "wrong_tool_dynamic_workflow",
            (
                "This looks like a workflow being hand-written as canvas commands. "
                "Do not use canvas commands to bypass dynamic WorkflowPlan validation. Select "
                "one native Hermes Skill, load it with freezone_get_workflow_skill(compact=true), "
                "author a complete freezone_workflow_plan.v1 with explicit Recipe ids, then call "
                "freezone_prepare_workflow_plan_draft(plan=...)."
            ),
        )
    project, canvas, scope_error = _resolve_canvas_scope_for_write(project, canvas)
    if scope_error:
        return scope_error
    shape_error = _validate_write_commands_shape(project, canvas, commands)
    if shape_error:
        return shape_error
    generation_preflight = _external_generation_parameter_preflight(
        project,
        canvas,
        commands,
    )
    if generation_preflight is not None:
        return tool_result(generation_preflight)
    if _external_mcp_agent_enabled():
        _use_frontend_default_for_recommended_models(commands)
    if _mcp_direct_canvas_apply_enabled():
        needs_approval, approval_reasons = _approval_required_for_commands(commands)
        if _mcp_canvas_approval_enabled() and needs_approval:
            return _create_mcp_canvas_approval(
                project=project,
                canvas=canvas,
                commands=commands,
                slim_result=slim_result,
                reasons=approval_reasons,
            )
        return _direct_apply_canvas_commands(
            project,
            canvas,
            commands,
            slim_result=slim_result,
        )
    if _external_mcp_agent_enabled():
        # Codex/Claude/OpenClaw external MCP uses the same browser bridge as
        # Hermes. Do not return a second tool-level approval_id here: that
        # approval lives inside the agent conversation and never reaches the
        # Freezone chat approval card. The pending bridge frame is consumed by
        # FreezoneShell, which displays the card and applies after confirmation.
        return _dispatch_mcp_approved_frontend_commands(
            project=project,
            canvas=canvas,
            commands=commands,
            slim_result=slim_result,
        )
    return _dispatch_frontend_canvas_commands(
        project=project,
        canvas=canvas,
        commands=commands,
        slim_result=slim_result,
    )


def _summarize_canvas_command_result(
    resolved: dict[str, Any],
    *,
    bridge_key: str,
    commands: list[Any],
) -> dict[str, Any]:
    command_summary = _command_summary(commands)
    errors = resolved.get("errors") if isinstance(resolved.get("errors"), list) else []
    agent_instruction = resolved.get("agent_instruction") or (
        "Canvas command result has been summarized. Do not ask for or print the full commands."
    )
    if resolved.get("ok") and resolved.get("canvas_apply_status") == "accepted":
        if _commands_include_type(commands, "run_workflow"):
            agent_instruction = (
                "Report briefly that the workflow was accepted and is continuing on the canvas. "
                "This accepted command is the run request: do not call freezone_run_workflow again "
                "for the same operation or in the same turn. "
                "Do not claim generation is complete, do not report a timeout, and do not ask the "
                "user to run nodes manually."
            )
        else:
            agent_instruction = (
                "Report briefly that the canvas command has been submitted to the canvas. Do not "
                "claim generation is complete, do not report a timeout, do not say a tool was opened, "
                "and do not ask the user to operate it manually."
            )
    elif resolved.get("ok"):
        if _commands_include_open_node_action(commands):
            agent_instruction = (
                "Report success briefly and say the requested canvas panel has been opened. "
                "Do not say it is processing or submitted for generation. Do not ask for or print the full commands."
            )
        else:
            agent_instruction = (
                "Report success briefly. When listing created workflow nodes, copy every non-empty "
                "displayName from created_nodes in order; do not reconstruct, truncate, or add a "
                "partially filled table row. If commands include run_node_action, say the requested "
                "canvas action has been submitted to the canvas; do not say a panel was opened. "
                "Do not ask for or print the full commands."
            )
    return {
        "ok": bool(resolved.get("ok")),
        "tool_call_status": resolved.get("tool_call_status") or "completed",
        "canvas_apply_status": resolved.get("canvas_apply_status"),
        "applied": bool(resolved.get("applied")),
        "cancelled": bool(resolved.get("cancelled")),
        "bridge_key": bridge_key,
        "project_id": resolved.get("project_id"),
        "canvas_id": resolved.get("canvas_id"),
        "applied_count": resolved.get("applied_count"),
        "opened_ui_actions": resolved.get("opened_ui_actions"),
        "created_node_count": len(resolved.get("created_node_ids") or []),
        "command_count": len(commands),
        "command_counts": command_summary["command_counts"],
        "created_nodes": command_summary["created_nodes"],
        "error_count": len(errors),
        "errors": [str(item)[:240] for item in errors[:3]],
        "message": resolved.get("message") or "Canvas command finished.",
        "agent_instruction": agent_instruction,
    }


def _handle_emit_canvas_command(args: dict[str, Any], **_: Any) -> str:
    if legacy_error := _legacy_tool_argument_error(
        args, ("project", "canvasId", "body", "envelope")
    ):
        return tool_result(legacy_error)
    project = str(args.get("project_id") or _default_project_id()).strip() or None
    canvas = str(args.get("canvas_id") or _default_canvas_id()).strip() or None
    commands = args.get("commands")
    return _emit_canvas_commands(project, canvas, commands, slim_result=True)


def _handle_get_workflow_skill(args: dict[str, Any], **_: Any) -> str:
    if get_workflow_skill is None:
        return tool_error(
            "Freezone Workflow Skill catalog is unavailable. "
            f"Import error: {_JSON_WORKFLOW_CATALOG_IMPORT_ERROR}"
        )
    request = dict(args)
    request["compact"] = True
    package = get_workflow_skill(request)
    if isinstance(package, dict) and package.get("ok"):
        # 把编译期最常踩的三个坑在最新鲜的位置(编译前一步)提醒一遍;
        # SKILL.md 文档层不保证被读到,这里是必经之路。
        package.setdefault(
            "agent_instruction",
            "Next step: compile the intent from this package only (deliverable, "
            "recipes, and field enums come from here) and call "
            "freezone_prepare_workflow_draft through tool_call, writing the "
            '"name" field BEFORE "arguments". If billing is required, wait for the '
            "server-issued quote_id and confirmation_receipt before retrying. If include_audio=true, "
            "EVERY planner unit must carry narration with the literal voice-over "
            "text for that unit.",
        )
    return _structured_tool_result(
        package,
        tool_name="freezone_get_workflow_skill",
    )


def _handle_prepare_workflow_plan_draft(args: dict[str, Any], **_: Any) -> str:
    if build_workflow_graph_commands is None:
        return tool_error(
            "Freezone workflow graph builder is unavailable. "
            f"Import error: {_WORKFLOW_GRAPH_IMPORT_ERROR}"
        )
    if not isinstance(args.get("plan"), dict):
        return tool_result(
            {
                "ok": False,
                "status": "dynamic_workflow_plan_required",
                "code": "dynamic_workflow_plan_required",
                "error": "plan must be a complete freezone_workflow_plan.v1 object",
                "message": "当前仅支持动态工作流，请先基于 Skill 和 Recipe 生成完整 WorkflowPlan。",
                "agent_instruction": (
                    "Load the selected Skill with freezone_get_workflow_skill(compact=true), "
                    "author one complete freezone_workflow_plan.v1 with explicit Recipe ids, "
                    "then call freezone_prepare_workflow_plan_draft(plan=...). Do not retry with "
                    "workflow_type, count, items, or handwritten canvas commands."
                ),
            }
        )
    if validate_agent_workflow_plan is None:
        return tool_error(
            "Freezone dynamic WorkflowPlan validation is unavailable. "
            f"Import error: {_JSON_WORKFLOW_CATALOG_IMPORT_ERROR}"
        )
    validated = validate_agent_workflow_plan(args["plan"])
    if not validated.get("ok"):
        return tool_result(validated)
    project, canvas, scope_error = _workflow_draft_scope(args)
    if scope_error:
        return tool_result(scope_error)
    assert project is not None and canvas is not None
    preflight = _workflow_runtime_preflight(
        validated,
        project_id=project,
    )
    validated["preflight"] = preflight
    if preflight["blockers"]:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_preflight_failed",
                "error": preflight["blockers"][0]["message"],
                "preflight": preflight,
            }
        )
    run_after_create = _run_after_create_arg(args)
    source = {
        "schema_version": "freezone_workflow_plan_draft.v1",
        "plan": validated["plan"],
    }
    confirmation_gate = _agent_billing_confirmation_gate(
        project,
        canvas,
        args=args,
        operation_kind="workflow_planning_create",
        operation={
            "intent": source,
            "compiled": validated,
            "run_after_create": bool(run_after_create),
        },
    )
    if confirmation_gate is not None:
        return tool_result(confirmation_gate)
    payload, error = _workflow_draft_response(
        _request(
            "POST",
            _workflow_draft_api_path(project, canvas),
            body={
                "intent": source,
                "compiled": validated,
                "run_after_create": bool(run_after_create),
                "quote_id": args.get("quote_id"),
                "confirmation_receipt": args.get("confirmation_receipt"),
            },
        )
    )
    if payload is None:
        return tool_result(error)
    result = public_workflow_draft(payload)
    billing_instruction = (
        "Before asking for confirmation, state that this delivered planning turn is billed under "
        "agent_planning_charge.display, then present agent_credit_estimate.display as the "
        "additional estimated Agent credits charged only after workflow creation is confirmed. "
        "State that image, audio, and video generation credits are charged separately. "
        if result.get("agent_planning_charge") and result.get("agent_credit_estimate")
        else "Do not mention credits, billing, pricing, or editions. "
    )
    result["agent_instruction"] = (
        "Present the exact custom topology preview and its node/edge counts. "
        f"{billing_instruction}"
        "Wait for user confirmation, then call freezone_confirm_workflow_draft with the exact "
        "draft_id and revision. To change the topology, prepare a new complete Plan draft; never "
        "fall back to direct canvas commands."
    )
    return tool_result(result)


def _workflow_draft_dependencies_available() -> bool:
    return bool(
        compile_workflow_intent is not None
        and build_workflow_graph_commands is not None
        and build_workflow_draft_patch is not None
        and public_workflow_draft is not None
    )


def _workflow_draft_unavailable() -> str:
    return tool_error(
        "Freezone workflow drafts are unavailable. "
        f"Draft import error: {_WORKFLOW_DRAFT_IMPORT_ERROR}; "
        f"catalog import error: {_JSON_WORKFLOW_CATALOG_IMPORT_ERROR}; "
        f"graph import error: {_WORKFLOW_GRAPH_IMPORT_ERROR}"
    )


def _run_after_create_arg(args: dict[str, Any]) -> bool | None:
    if "run_after_create" in args:
        return bool(args.get("run_after_create"))
    return None


def _workflow_draft_scope(
    args: dict[str, Any],
) -> tuple[str | None, str | None, dict[str, Any] | None]:
    project_id = str(args.get("project_id") or _default_project_id()).strip()
    canvas_id = str(args.get("canvas_id") or _default_canvas_id()).strip()
    if not project_id or not canvas_id:
        return (
            None,
            None,
            {
                "ok": False,
                "status": "workflow_draft_scope_required",
                "error": "project_id and canvas_id are required for persisted workflow drafts",
            },
        )
    return project_id, canvas_id, None


def _workflow_draft_api_path(
    project_id: str,
    canvas_id: str,
    draft_id: str = "",
    suffix: str = "",
) -> str:
    path = (
        f"/projects/{quote(project_id, safe='')}/freezone/canvases/"
        f"{quote(canvas_id, safe='')}/workflow-drafts"
    )
    if draft_id:
        path += f"/{quote(draft_id, safe='')}"
    if suffix:
        path += f"/{suffix}"
    return path


def _agent_planning_quote_path(project_id: str) -> str:
    return f"/projects/{quote(project_id, safe='')}/freezone/agent-capability-quote"


def _normalize_workflow_intent_arg(
    args: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Normalize structured intent input and return an actionable validation error."""

    raw_intent = args.get("intent")
    if raw_intent is None:
        return None, None
    if isinstance(raw_intent, dict):
        return raw_intent, None
    return None, {
        "ok": False,
        "status": "workflow_intent_object_required",
        "code": "workflow_intent_object_required",
        "error": "intent 必须是结构化对象，不能是字符串或代码片段。",
        "expected": {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": "已选 Workflow Skill 的 id",
            "user_goal": "用户的原始工作流目标",
        },
        "agent_instruction": (
            "Do not call execute_code and do not serialize intent as a string. "
            "Call freezone_prepare_workflow_draft with intent as a JSON object, "
            "including skill_id and user_goal."
        ),
    }


def _agent_billing_confirmation_gate(
    project_id: str,
    canvas_id: str,
    *,
    args: dict[str, Any],
    operation_kind: str,
    operation: dict[str, Any],
    feature_key: str = "freezone.agent.creative_planning",
    confirmation_phrase: str = "确认规划费用",
) -> dict[str, Any] | None:
    capability_name = (
        "Agent 工作流创建" if operation_kind == "workflow_create" else "Agent 创意规划"
    )
    quote_id = str(args.get("quote_id") or "").strip()
    receipt = str(args.get("confirmation_receipt") or "").strip()
    if bool(quote_id) != bool(receipt):
        return {
            "ok": False,
            "status": "billing_confirmation_incomplete",
            "error": "quote_id and confirmation_receipt must be supplied together",
            "agent_instruction": "Do not invent or partially copy billing confirmation values.",
        }
    if quote_id and receipt:
        return None
    response = _request(
        "POST",
        _agent_planning_quote_path(project_id),
        body={
            "feature_key": feature_key,
            "canvas_id": canvas_id,
            "operation_kind": operation_kind,
            "operation": operation,
        },
    )
    if not response.get("ok"):
        return response
    quote_payload = response.get("data")
    if not isinstance(quote_payload, dict):
        return {
            "ok": False,
            "status": "agent_planning_quote_unavailable",
            "error": "Agent planning quote API returned an invalid payload",
        }
    if quote_payload.get("billing_required") is False:
        return None
    if (
        quote_payload.get("configured") is not True
        or quote_payload.get("exact") is not True
    ):
        return {
            "ok": False,
            "status": "agent_planning_price_not_configured",
            "quote": quote_payload,
            "error": f"{capability_name}价格尚未配置。",
            "message": (
                f"{capability_name}当前参考价格为 "
                f"{quote_payload.get('reference_display') or '5–40 积分'}，"
                "但尚未配置可实际扣除的价格。"
            ),
            "agent_instruction": (
                "Tell the user that Agent creative planning cannot start because its exact "
                "credit price is not configured. Show quote.reference_display only as a "
                "reference range. Do not describe the charge as zero or free, do not compile "
                "a plan, and do not invent a confirmation receipt."
            ),
        }
    if quote_payload.get("allowed") is False:
        return {
            "ok": False,
            "status": "agent_credit_insufficient",
            "code": "agent_credit_insufficient",
            "quote": quote_payload,
            "confirmation_required": False,
            "next_action": "add_credits",
            "error": f"{capability_name}所需积分超过当前可用余额。",
            "message": f"当前 Agent 积分不足，暂时无法执行{capability_name}。",
            "agent_instruction": (
                "Tell the user that the current Agent credit balance is insufficient. "
                "Show quote.display as the required charge, do not ask for confirmation, "
                "and do not retry or continue planning until credits are added."
            ),
        }
    return {
        "ok": True,
        "status": "agent_planning_confirmation_required",
        "quote": quote_payload,
        "quote_id": quote_payload.get("quote_id"),
        "confirmation_required": True,
        "next_action": "await_user_billing_confirmation",
        "message": f"本次{capability_name}操作需要先确认 Agent 积分。",
        "agent_instruction": (
            "Show quote.display as the exact Agent charge and ask the user to confirm. "
            "Stop this turn without compiling, preparing, patching, or creating a workflow. "
            f"Ask the user to reply with the exact phrase {confirmation_phrase} "
            f"{quote_payload.get('quote_id')}. Only the "
            "server can then issue a confirmation receipt. Retry the same requested workflow "
            "tool with the trusted quote_id and confirmation_receipt; never invent them."
        ),
    }


def _workflow_draft_response(
    response: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not response.get("ok"):
        return None, response
    payload = response.get("data")
    if not isinstance(payload, dict):
        return None, {
            "ok": False,
            "status": "workflow_draft_unavailable",
            "error": "workflow draft API returned an invalid payload",
        }
    return payload, None


def _finish_workflow_draft(
    project_id: str,
    canvas_id: str,
    draft_id: str,
    *,
    outcome: str,
) -> None:
    _request(
        "POST",
        _workflow_draft_api_path(
            project_id,
            canvas_id,
            draft_id,
            "finish",
        ),
        body={"outcome": outcome},
    )


def _catalog_string_options(entry: dict[str, Any], key: str) -> list[str]:
    values = entry.get(key)
    if not isinstance(values, list):
        return []
    return [str(value).strip() for value in values if str(value).strip()]


def _catalog_option_supported(
    value: Any,
    options: list[str],
    *,
    case_insensitive: bool = False,
) -> bool:
    requested = str(value or "").strip()
    if not requested:
        return True
    if case_insensitive:
        requested = requested.casefold()
        return any(requested == option.casefold() for option in options)
    return requested in options


def _workflow_node_capability_blockers(
    node: dict[str, Any],
    catalog_entry: dict[str, Any],
) -> list[dict[str, Any]]:
    node_type = str(node.get("node_type") or "").strip()
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    node_id = str(node.get("id") or node_type).strip()
    model_id = str(data.get("model") or "").strip()
    field_options = (
        {
            "aspectRatio": ("ratioOptions", False),
            "size": ("resolutionOptions", True),
            "quality": ("qualityOptions", True),
        }
        if node_type == "imageGenNode"
        else (
            {
                "aspectRatio": ("ratioOptions", False),
                "quality": ("resolutionOptions", True),
            }
            if node_type == "videoNode"
            else {}
        )
    )
    blockers: list[dict[str, Any]] = []
    for field, (catalog_key, case_insensitive) in field_options.items():
        value = data.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        options = _catalog_string_options(catalog_entry, catalog_key)
        if not options:
            # Missing ratio/resolution declarations use the canvas fallback. Quality
            # deliberately has no fallback: an absent qualityOptions means the model
            # does not accept the quality parameter.
            if catalog_key != "qualityOptions":
                continue
        if _catalog_option_supported(
            value,
            options,
            case_insensitive=case_insensitive,
        ):
            continue
        blockers.append(
            {
                "path": f"runtime.models.{node_id}.{field}",
                "message": (
                    f"{field} value {value!r} is not supported by model {model_id}"
                ),
                "code": "model_capability_unsupported",
            }
        )
    if node_type == "videoNode" and isinstance(data.get("durationSec"), (int, float)):
        duration = float(data["durationSec"])
        minimum = catalog_entry.get("minDuration")
        maximum = catalog_entry.get("maxDuration")
        if (
            isinstance(minimum, (int, float))
            and duration < float(minimum)
            or isinstance(maximum, (int, float))
            and duration > float(maximum)
        ):
            blockers.append(
                {
                    "path": f"runtime.models.{node_id}.durationSec",
                    "message": (
                        f"durationSec value {data['durationSec']!r} is not supported "
                        f"by model {model_id}"
                    ),
                    "code": "model_capability_unsupported",
                }
            )
    if (
        node_type == "videoNode"
        and data.get("generateAudio") is True
        and catalog_entry.get("supportsGenerateAudio") is False
    ):
        blockers.append(
            {
                "path": f"runtime.models.{node_id}.generateAudio",
                "message": f"generateAudio is not supported by model {model_id}",
                "code": "model_capability_unsupported",
            }
        )
    return blockers


def _workflow_runtime_preflight(
    compiled: dict[str, Any],
    *,
    project_id: str,
) -> dict[str, Any]:
    base = deepcopy(compiled.get("preflight") or {})
    blockers = list(base.get("blockers") or [])
    warnings = list(base.get("warnings") or [])
    checks: dict[str, Any] = {}
    plan = compiled.get("plan") if isinstance(compiled.get("plan"), dict) else {}
    nodes = plan.get("nodes") if isinstance(plan.get("nodes"), list) else []
    if not project_id or not _available():
        checks["runtime"] = "unavailable"
        warnings.append(
            {
                "path": "runtime",
                "message": "runtime model and queue availability could not be checked",
            }
        )
    else:
        model_endpoints = {
            "imageGenNode": f"/projects/{quote(project_id, safe='')}/freezone/image/models",
            "videoNode": f"/projects/{quote(project_id, safe='')}/freezone/video/models",
        }
        for node_type, endpoint in model_endpoints.items():
            typed_nodes = [
                node
                for node in nodes
                if isinstance(node, dict)
                and node.get("node_type") == node_type
                and isinstance(node.get("data"), dict)
                and str((node.get("data") or {}).get("model") or "").strip()
            ]
            requested = {
                str((node.get("data") or {}).get("model") or "").strip()
                for node in typed_nodes
            }
            if not requested:
                continue
            response = _request("GET", endpoint)
            if response.get("ok") is False:
                checks[f"{node_type}.models"] = "unavailable"
                blockers.append(
                    {
                        "path": "runtime.models",
                        "message": (
                            f"could not verify {node_type} capabilities because the "
                            "live model catalog is unavailable"
                        ),
                        "code": "model_catalog_unavailable",
                    }
                )
                continue
            raw_models = response.get("data")
            catalog_by_id = (
                {
                    str(
                        item.get("id")
                        or item.get("apiModel")
                        or item.get("api_model")
                        or ""
                    ).strip(): item
                    for item in raw_models
                    if isinstance(item, dict)
                    and str(
                        item.get("id")
                        or item.get("apiModel")
                        or item.get("api_model")
                        or ""
                    ).strip()
                }
                if isinstance(raw_models, list)
                else {}
            )
            missing = sorted(requested - set(catalog_by_id))
            checks[f"{node_type}.models"] = {
                "requested": sorted(requested),
                "available": not missing,
            }
            blockers.extend(
                {
                    "path": "runtime.models",
                    "message": f"configured model is unavailable: {model}",
                    "code": "model_unavailable",
                }
                for model in missing
            )
            for node in typed_nodes:
                model = str((node.get("data") or {}).get("model") or "").strip()
                catalog_entry = catalog_by_id.get(model)
                if catalog_entry is not None:
                    blockers.extend(
                        _workflow_node_capability_blockers(node, catalog_entry)
                    )
        limits = _request(
            "GET",
            f"/api/v1/projects/{quote(project_id, safe='')}/tasks/limits",
        )
        lane_demand = {
            "default": sum(
                1
                for node in nodes
                if isinstance(node, dict)
                and (
                    node.get("node_type") in {"imageGenNode", "audioNode"}
                    or (
                        node.get("node_type")
                        in {"textAnnotationNode", "scriptNode", "beatContextNode"}
                        and isinstance(
                            (node.get("data") or {}).get("workflowCatalog"), dict
                        )
                        and str(
                            ((node.get("data") or {}).get("workflowCatalog") or {}).get(
                                "recipeId"
                            )
                            or ""
                        ).strip()
                    )
                )
            ),
            "video": sum(
                1
                for node in nodes
                if isinstance(node, dict) and node.get("node_type") == "videoNode"
            ),
            "ffmpeg": sum(
                1
                for node in nodes
                if isinstance(node, dict)
                and node.get("node_type") == "videoComposeNode"
            ),
        }
        if limits.get("ok") is False or not isinstance(limits.get("data"), dict):
            checks["queue_capacity"] = "unavailable"
            warnings.append(
                {
                    "path": "runtime.queue_capacity",
                    "message": "task queue capacity could not be checked",
                }
            )
        else:
            capacity = limits["data"]
            checks["queue_capacity"] = capacity
            for lane, demand in lane_demand.items():
                if demand <= 0:
                    continue
                lane_state = capacity.get(lane)
                if not isinstance(lane_state, dict):
                    continue
                limit = lane_state.get("limit")
                remaining = lane_state.get("remaining")
                if isinstance(limit, int) and limit <= 0:
                    blockers.append(
                        {
                            "path": f"runtime.queue_capacity.{lane}",
                            "message": f"{lane} generation queue is disabled",
                            "code": "queue_disabled",
                        }
                    )
                elif isinstance(remaining, int) and remaining <= 0:
                    warnings.append(
                        {
                            "path": f"runtime.queue_capacity.{lane}",
                            "message": f"{lane} generation queue is currently full; tasks will wait",
                        }
                    )
    return {
        **base,
        "status": "blocked" if blockers else "ready",
        "blockers": blockers,
        "warnings": warnings,
        "runtime_checks": checks,
    }


def _handle_prepare_workflow_draft(args: dict[str, Any], **_: Any) -> str:
    if not _workflow_draft_dependencies_available():
        return _workflow_draft_unavailable()
    project_id, canvas_id, scope_error = _workflow_draft_scope(args)
    if scope_error:
        return tool_result(scope_error)
    assert project_id is not None and canvas_id is not None
    if str(args.get("draft_id") or "").strip():
        return tool_result(
            {
                "ok": False,
                "status": "wrong_workflow_draft_tool",
                "code": "wrong_workflow_draft_tool",
                "error": "准备草稿不接受 draft_id；请使用 freezone_patch_workflow_draft 或 freezone_confirm_workflow_draft。",
                "agent_instruction": (
                    "Do not retry freezone_prepare_workflow_draft with draft_id. "
                    "Use freezone_patch_workflow_draft for changes or "
                    "freezone_confirm_workflow_draft for the confirmed draft."
                ),
            }
        )
    intent, intent_error = _normalize_workflow_intent_arg(args)
    if intent_error is not None:
        return tool_result(intent_error)
    if intent is None:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_intent_required_for_quote",
                "code": "workflow_intent_required_for_quote",
                "error": "必须提供完整的 intent 对象，服务端才能签发绑定本次操作的报价。",
                "agent_instruction": (
                    "Read the selected Workflow Skill, then call this tool with a structured "
                    "intent object. The server must bind the billing quote to that exact intent."
                ),
            }
        )
    compiled = compile_workflow_intent(intent)
    if not compiled.get("ok"):
        return tool_result(compiled)
    preflight = _workflow_runtime_preflight(compiled, project_id=project_id)
    compiled["preflight"] = preflight
    if preflight["blockers"]:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_preflight_failed",
                "error": preflight["blockers"][0]["message"],
                "preflight": preflight,
            }
        )
    run_after_create = _run_after_create_arg(args)
    confirmation_gate = _agent_billing_confirmation_gate(
        project_id,
        canvas_id,
        args=args,
        operation_kind="workflow_planning_create",
        operation={
            "intent": intent,
            "compiled": compiled,
            "run_after_create": bool(run_after_create),
        },
    )
    if confirmation_gate is not None:
        return tool_result(confirmation_gate)
    payload, error = _workflow_draft_response(
        _request(
            "POST",
            _workflow_draft_api_path(project_id, canvas_id),
            body={
                "intent": intent,
                "compiled": compiled,
                "run_after_create": bool(run_after_create),
                "quote_id": args.get("quote_id"),
                "confirmation_receipt": args.get("confirmation_receipt"),
            },
        )
    )
    if payload is None:
        return tool_result(error)
    result = public_workflow_draft(payload)
    billing_instruction = (
        "Before asking for confirmation, state that this delivered planning turn is billed under "
        "agent_planning_charge.display, then present agent_credit_estimate.display as the "
        "additional estimated Agent credits charged only after workflow creation is confirmed. "
        "State that image, audio, and video generation credits are charged separately. "
        if result.get("agent_planning_charge") and result.get("agent_credit_estimate")
        else "Do not mention credits, billing, pricing, or editions. "
    )
    result["agent_instruction"] = (
        "Present the exact preview in product language, including each node's "
        "preview.recipe_pipelines order as 主 Recipe → 补充 Recipe. Before asking for confirmation, "
        f"{billing_instruction}"
        "Wait for user confirmation. "
        "For adjustments, patch this draft instead of rebuilding the intent. "
        "After confirmation, call freezone_confirm_workflow_draft with draft_id and revision."
    )
    return tool_result(result)


def _handle_patch_workflow_draft(args: dict[str, Any], **_: Any) -> str:
    if not _workflow_draft_dependencies_available():
        return _workflow_draft_unavailable()
    project_id, canvas_id, scope_error = _workflow_draft_scope(args)
    if scope_error:
        return tool_result(scope_error)
    assert project_id is not None and canvas_id is not None
    draft_id = str(args.get("draft_id") or "").strip()
    if not draft_id:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_id_required",
                "error": "draft_id is required",
            }
        )
    changes = args.get("changes")
    raw_revision = args.get("expected_revision")
    problems = []
    if not isinstance(changes, dict):
        problems.append(
            "changes must be an object holding only the changed intent fields"
        )
    if raw_revision is None:
        problems.append(
            "expected_revision (the current draft revision integer) is required"
        )
    expected_revision = None
    if raw_revision is not None:
        try:
            expected_revision = int(raw_revision)
        except (TypeError, ValueError):
            problems.append("expected_revision must be an integer")
    if problems:
        # 一次性报出全部参数问题并给出完整签名，避免模型逐个试错。
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_patch_args_invalid",
                "error": "; ".join(problems),
                "expected_arguments": {
                    "draft_id": "<current draft_id>",
                    "expected_revision": "<current revision integer>",
                    "changes": {"<changed intent field>": "<new value>"},
                },
                "agent_instruction": (
                    "Retry freezone_patch_workflow_draft exactly once with ALL of: "
                    "draft_id, integer expected_revision matching the current draft "
                    "revision and changes as an object holding only the changed intent "
                    "fields. Apply every "
                    "requested change in this single call."
                ),
            }
        )
    payload, error = _workflow_draft_response(
        _request(
            "GET",
            _workflow_draft_api_path(project_id, canvas_id, draft_id),
        )
    )
    if payload is None:
        return tool_result(error)
    current_revision = int(payload.get("revision") or 0)
    if expected_revision != current_revision:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_revision_conflict",
                "error": (
                    f"workflow draft revision changed: expected {expected_revision}, "
                    f"current {current_revision}"
                ),
                "current_revision": current_revision,
            }
        )
    patch_body, error = build_workflow_draft_patch(
        payload=payload,
        changes=changes,
        compile_intent=compile_workflow_intent,
        run_after_create=_run_after_create_arg(args),
    )
    if patch_body is None:
        return tool_result(error)
    confirmation_gate = _agent_billing_confirmation_gate(
        project_id,
        canvas_id,
        args=args,
        operation_kind="workflow_planning_patch",
        operation={
            "draft_id": draft_id,
            "expected_revision": expected_revision,
            "intent": patch_body.get("intent"),
            "compiled": patch_body.get("compiled"),
            "run_after_create": patch_body.get("run_after_create"),
        },
        confirmation_phrase="确认修改费用",
    )
    if confirmation_gate is not None:
        return tool_result(confirmation_gate)
    payload, error = _workflow_draft_response(
        _request(
            "PATCH",
            _workflow_draft_api_path(project_id, canvas_id, draft_id),
            body={
                "expected_revision": expected_revision,
                "quote_id": args.get("quote_id"),
                "confirmation_receipt": args.get("confirmation_receipt"),
                **patch_body,
            },
        )
    )
    if payload is None:
        return tool_result(error)
    result = public_workflow_draft(payload)
    result["status"] = "workflow_draft_updated"
    billing_instruction = (
        "State that this updated planning turn is billed under agent_planning_charge.display. "
        "Present agent_credit_estimate.display as the additional workflow creation estimate before "
        "asking for confirmation, and state that image, audio, and video generation credits are "
        "charged separately. "
        if result.get("agent_planning_charge") and result.get("agent_credit_estimate")
        else "Do not mention credits, billing, pricing, or editions. "
    )
    result["agent_instruction"] = (
        "Present only the resulting product-level changes and updated preview, including any "
        "changed 主 Recipe → 补充 Recipe order from preview.recipe_pipelines. "
        f"{billing_instruction}"
        "Keep using this draft_id and revision for further adjustments or confirmation."
    )
    return tool_result(result)


def _tool_result_payload(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _handle_confirm_workflow_draft(args: dict[str, Any], **_: Any) -> str:
    if not _workflow_draft_dependencies_available():
        return _workflow_draft_unavailable()
    project_id, canvas_id, scope_error = _workflow_draft_scope(args)
    if scope_error:
        return tool_result(scope_error)
    assert project_id is not None and canvas_id is not None
    draft_id = str(args.get("draft_id") or "").strip()
    if not draft_id:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_id_required",
                "error": "draft_id is required",
            }
        )
    raw_revision = args.get("revision")
    if raw_revision is None:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_revision_required",
                "error": "revision is required",
            }
        )
    try:
        revision = int(raw_revision)
    except (TypeError, ValueError):
        return tool_result(
            {
                "ok": False,
                "status": "invalid_workflow_draft_revision",
                "error": "revision must be an integer",
            }
        )
    current_payload, current_error = _workflow_draft_response(
        _request(
            "GET",
            _workflow_draft_api_path(project_id, canvas_id, draft_id),
        )
    )
    if current_payload is None:
        return tool_result(current_error)
    if int(current_payload.get("revision") or 0) != revision:
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_revision_conflict",
                "error": "workflow draft revision changed before billing confirmation",
                "current_revision": current_payload.get("revision"),
            }
        )
    estimate = (
        current_payload.get("agent_credit_estimate")
        if isinstance(current_payload.get("agent_credit_estimate"), dict)
        else {}
    )
    feature_key = str(estimate.get("feature_key") or "").strip()
    confirmation_gate = _agent_billing_confirmation_gate(
        project_id,
        canvas_id,
        args=args,
        operation_kind="workflow_create",
        operation={
            "draft_id": draft_id,
            "revision": revision,
            "plan_digest": current_payload.get("plan_digest"),
        },
        feature_key=feature_key or "freezone.agent.workflow_design.simple",
        confirmation_phrase="确认创建费用",
    )
    if confirmation_gate is not None:
        return tool_result(confirmation_gate)
    payload, claim_result = _workflow_draft_response(
        _request(
            "POST",
            _workflow_draft_api_path(project_id, canvas_id, draft_id, "claim"),
            body={
                "revision": revision,
                "quote_id": args.get("quote_id"),
                "confirmation_receipt": args.get("confirmation_receipt"),
            },
        )
    )
    if payload is None:
        return tool_result(claim_result)
    explicit_project = str(args.get("project_id") or "").strip()
    explicit_canvas = str(args.get("canvas_id") or "").strip()
    stored_project = str(payload.get("project_id") or "").strip()
    stored_canvas = str(payload.get("canvas_id") or "").strip()
    if explicit_project and stored_project and explicit_project != stored_project:
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome="ready")
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_scope_mismatch",
                "error": "workflow draft belongs to a different project",
            }
        )
    if explicit_canvas and stored_canvas and explicit_canvas != stored_canvas:
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome="ready")
        return tool_result(
            {
                "ok": False,
                "status": "workflow_draft_scope_mismatch",
                "error": "workflow draft belongs to a different canvas",
            }
        )
    run_after_create = _run_after_create_arg(args)
    if run_after_create is None:
        run_after_create = bool(payload.get("run_after_create"))
    compiled = (
        payload.get("compiled") if isinstance(payload.get("compiled"), dict) else {}
    )
    preflight = _workflow_runtime_preflight(
        compiled,
        project_id=explicit_project or stored_project,
    )
    if preflight["blockers"]:
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome="ready")
        return tool_result(
            {
                "ok": False,
                "status": "workflow_preflight_failed",
                "error": preflight["blockers"][0]["message"],
                "preflight": preflight,
            }
        )
    plan = compiled.get("plan")
    built = build_workflow_graph_commands(
        {
            "plan": plan,
            "run_after_create": run_after_create,
            "workflow_instance_id": draft_id,
        }
    )
    if not built.get("ok"):
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome="ready")
        return tool_result(built)
    if isinstance(built.get("skipped_edges"), list) and built["skipped_edges"]:
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome="ready")
        return tool_result(
            {
                "ok": False,
                "status": "workflow_graph_incomplete",
                "code": "workflow_edges_skipped",
                "error": "workflow graph contains invalid or unresolved edge endpoints",
                "skipped_edges": built["skipped_edges"][:12],
                "agent_instruction": (
                    "Do not submit a reduced graph or retry with empty edges. Correct the same "
                    "complete WorkflowPlan so every edge source and target matches a node id, "
                    "then submit it once."
                ),
            }
        )
    try:
        result = _emit_canvas_commands(
            explicit_project or stored_project or _default_project_id() or None,
            explicit_canvas or stored_canvas or _default_canvas_id() or None,
            built.get("commands"),
            allow_dynamic_workflow_batch=True,
            slim_result=True,
        )
    except Exception:
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome="ready")
        raise
    result_payload = _tool_result_payload(result)
    if result_payload and result_payload.get("ok"):
        outcome = (
            "submitted"
            if result_payload.get("canvas_apply_status") == "timeout"
            else "confirmed"
        )
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome=outcome)
    else:
        _finish_workflow_draft(project_id, canvas_id, draft_id, outcome="ready")
    return result


def _position_from_args(args: dict[str, Any]) -> dict[str, Any] | None:
    if isinstance(args.get("position"), dict):
        return dict(args["position"])
    x = args.get("x")
    y = args.get("y")
    if isinstance(x, (int, float)) and isinstance(y, (int, float)):
        return {"x": x, "y": y}
    return None


def _single_write_command(args: dict[str, Any], command: dict[str, Any]) -> str:
    project = str(args.get("project_id") or _default_project_id()).strip() or None
    canvas = str(args.get("canvas_id") or _default_canvas_id()).strip() or None
    return _emit_canvas_commands(project, canvas, [command], slim_result=True)


def _handle_create_node(args: dict[str, Any], **_: Any) -> str:
    node_type = str(args.get("node_type") or args.get("nodeType") or "").strip()
    if not node_type:
        return tool_result(
            {
                "ok": False,
                "status": "node_type_required",
                "error": "node_type is required",
            }
        )
    command: dict[str, Any] = {"type": "create_node", "node_type": node_type}
    if isinstance(args.get("data"), dict):
        command["data"] = args["data"]
    client_id = str(args.get("client_id") or args.get("clientId") or "").strip()
    if client_id:
        command["client_id"] = client_id
    position = _position_from_args(args)
    if position:
        command["position"] = position
    return _single_write_command(args, command)


def _handle_add_next_node(args: dict[str, Any], **_: Any) -> str:
    source_node_id = str(
        args.get("source_node_id") or args.get("sourceNodeId") or ""
    ).strip()
    node_type = str(args.get("node_type") or args.get("nodeType") or "").strip()
    if not source_node_id:
        return tool_result(
            {
                "ok": False,
                "status": "source_node_id_required",
                "error": "source_node_id is required",
            }
        )
    if not node_type:
        return tool_result(
            {
                "ok": False,
                "status": "node_type_required",
                "error": "node_type is required",
            }
        )
    command: dict[str, Any] = {
        "type": "add_next_node",
        "source_node_id": source_node_id,
        "node_type": node_type,
        "connect": bool(args.get("connect", True)),
    }
    if isinstance(args.get("data"), dict):
        command["data"] = args["data"]
    client_id = str(args.get("client_id") or args.get("clientId") or "").strip()
    if client_id:
        command["client_id"] = client_id
    return _single_write_command(args, command)


def _handle_update_node_data(args: dict[str, Any], **_: Any) -> str:
    if legacy_error := _legacy_tool_argument_error(
        args, ("project", "canvasId", "nodeId")
    ):
        return tool_result(legacy_error)
    node_id = str(args.get("node_id") or "").strip()
    if not node_id:
        return tool_result(
            {"ok": False, "status": "node_id_required", "error": "node_id is required"}
        )
    data = args.get("data")
    if not isinstance(data, dict) or not data:
        return tool_result(
            {
                "ok": False,
                "status": "data_required",
                "error": "data must be a non-empty object",
            }
        )
    return _single_write_command(
        args, {"type": "update_node_data", "node_id": node_id, "data": data}
    )


def _handle_create_edge(args: dict[str, Any], **_: Any) -> str:
    source = str(
        args.get("source")
        or args.get("source_node_id")
        or args.get("sourceNodeId")
        or ""
    ).strip()
    target = str(
        args.get("target")
        or args.get("target_node_id")
        or args.get("targetNodeId")
        or ""
    ).strip()
    link_type = str(args.get("link_type") or args.get("linkType") or "").strip()
    if not source:
        return tool_result(
            {"ok": False, "status": "source_required", "error": "source is required"}
        )
    if not target:
        return tool_result(
            {"ok": False, "status": "target_required", "error": "target is required"}
        )
    if not link_type:
        return tool_result(
            {
                "ok": False,
                "status": "link_type_required",
                "error": "link_type is required",
            }
        )
    return _single_write_command(
        args,
        {
            "type": "create_edge",
            "source": source,
            "target": target,
            "link_type": link_type,
        },
    )


def _handle_delete_nodes(args: dict[str, Any], **_: Any) -> str:
    node_ids = args.get("node_ids") or args.get("nodeIds")
    scope = str(args.get("scope") or "").strip().lower()
    if scope == "canvas":
        project = (
            str(
                args.get("project_id") or args.get("project") or _default_project_id()
            ).strip()
            or None
        )
        canvas = (
            str(
                args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
            ).strip()
            or None
        )
        project, canvas, scope_error = _resolve_canvas_scope_for_write(project, canvas)
        if scope_error:
            return scope_error
        response = _request(
            "GET",
            f"/api/v1/projects/{quote(project, safe='')}/freezone/canvases/{quote(canvas, safe='')}",
        )
        if not response.get("ok", True):
            return tool_result(
                {
                    "ok": False,
                    "status": "canvas_read_failed",
                    "error": response.get("error") or "failed to read canvas",
                }
            )
        current = response.get("data") if isinstance(response.get("data"), dict) else {}
        node_ids = [
            str(node.get("id") or "").strip()
            for node in current.get("nodes") or []
            if isinstance(node, dict) and str(node.get("id") or "").strip()
        ]
        if not node_ids:
            return tool_result(
                {
                    "ok": True,
                    "tool_call_status": "completed",
                    "canvas_apply_status": "already_empty",
                    "applied": True,
                    "project_id": project,
                    "canvas_id": canvas,
                    "deleted_node_count": 0,
                    "message": "Canvas is already empty.",
                    "agent_instruction": "Report briefly that the canvas is already empty.",
                }
            )
        return _emit_canvas_commands(
            project,
            canvas,
            [{"type": "delete_nodes", "node_ids": node_ids}],
            slim_result=True,
        )
    if not isinstance(node_ids, list) or not node_ids:
        return tool_result(
            {
                "ok": False,
                "status": "node_ids_required",
                "error": "node_ids must be a non-empty array, or scope must be canvas",
            }
        )
    return _single_write_command(args, {"type": "delete_nodes", "node_ids": node_ids})


def _handle_delete_edges(args: dict[str, Any], **_: Any) -> str:
    command: dict[str, Any] = {"type": "delete_edges"}
    edge_ids = args.get("edge_ids") or args.get("edgeIds")
    pairs = args.get("pairs")
    if isinstance(edge_ids, list) and edge_ids:
        command["edge_ids"] = edge_ids
    if isinstance(pairs, list) and pairs:
        command["pairs"] = pairs
    if "edge_ids" not in command and "pairs" not in command:
        return tool_result(
            {
                "ok": False,
                "status": "edge_refs_required",
                "error": "edge_ids or pairs is required",
            }
        )
    return _single_write_command(args, command)


def _handle_move_nodes(args: dict[str, Any], **_: Any) -> str:
    command: dict[str, Any] = {"type": "move_nodes"}
    positions = args.get("positions")
    node_ids = args.get("node_ids") or args.get("nodeIds")
    if isinstance(positions, dict) and positions:
        command["positions"] = positions
    else:
        if not isinstance(node_ids, list) or not node_ids:
            return tool_result(
                {
                    "ok": False,
                    "status": "node_ids_required",
                    "error": "node_ids is required for relative moves",
                }
            )
        command["node_ids"] = node_ids
        if isinstance(args.get("dx"), (int, float)):
            command["dx"] = args["dx"]
        if isinstance(args.get("dy"), (int, float)):
            command["dy"] = args["dy"]
        if "dx" not in command and "dy" not in command:
            return tool_result(
                {
                    "ok": False,
                    "status": "delta_required",
                    "error": "dx or dy is required for relative moves",
                }
            )
    return _single_write_command(args, command)


def _handle_layout_nodes(args: dict[str, Any], **_: Any) -> str:
    mode = str(args.get("mode") or "").strip()
    if mode not in {"horizontal", "vertical", "grid"}:
        return tool_result(
            {
                "ok": False,
                "status": "mode_required",
                "error": "mode must be horizontal, vertical, or grid",
            }
        )
    command: dict[str, Any] = {"type": "layout_nodes", "mode": mode}
    node_ids = args.get("node_ids") or args.get("nodeIds")
    if isinstance(node_ids, list):
        command["node_ids"] = node_ids
    return _single_write_command(args, command)


def _handle_group_nodes(args: dict[str, Any], **_: Any) -> str:
    node_ids = args.get("node_ids") or args.get("nodeIds")
    if not isinstance(node_ids, list) or len(node_ids) < 2:
        return tool_result(
            {
                "ok": False,
                "status": "node_ids_required",
                "error": "node_ids must contain at least two nodes",
            }
        )
    command: dict[str, Any] = {"type": "group_nodes", "node_ids": node_ids}
    label = str(args.get("label") or "").strip()
    if label:
        command["label"] = label
    return _single_write_command(args, command)


def _handle_select_nodes(args: dict[str, Any], **_: Any) -> str:
    node_ids = args.get("node_ids") or args.get("nodeIds")
    if not isinstance(node_ids, list) or not node_ids:
        return tool_result(
            {
                "ok": False,
                "status": "node_ids_required",
                "error": "node_ids must be a non-empty array",
            }
        )
    command: dict[str, Any] = {"type": "select_nodes", "node_ids": node_ids}
    if "focus" in args:
        command["focus"] = bool(args.get("focus"))
    return _single_write_command(args, command)


def _handle_run_node_action(args: dict[str, Any], **_: Any) -> str:
    node_id = str(args.get("node_id") or args.get("nodeId") or "").strip()
    action = str(args.get("action") or "").strip()
    if not node_id:
        return tool_result(
            {"ok": False, "status": "node_id_required", "error": "node_id is required"}
        )
    if not action:
        return tool_result(
            {"ok": False, "status": "action_required", "error": "action is required"}
        )
    command: dict[str, Any] = {
        "type": "run_node_action",
        "node_id": node_id,
        "action": action,
    }
    parameters = args.get("parameters") or args.get("params")
    if isinstance(parameters, dict):
        command["parameters"] = dict(parameters)
    if bool(
        args.get("regenerate")
        or args.get("force_regenerate")
        or args.get("forceRegenerate")
    ):
        command.setdefault("parameters", {})["regenerate"] = True
    return _single_write_command(args, command)


def _handle_run_workflow(args: dict[str, Any], **_: Any) -> str:
    raw_node_ids = args.get("node_ids") or args.get("nodeIds") or []
    node_ids = [
        str(node_id).strip() for node_id in raw_node_ids if str(node_id).strip()
    ]
    scope = str(args.get("scope") or "").strip()
    if not node_ids and scope != "canvas":
        return tool_result(
            {
                "ok": False,
                "status": "workflow_scope_required",
                "error": "node_ids or scope=canvas is required",
            }
        )
    direction = str(args.get("direction") or "connected").strip()
    if direction not in {"connected", "node", "downstream"}:
        return tool_result(
            {
                "ok": False,
                "status": "invalid_workflow_direction",
                "error": f"unsupported workflow direction: {direction}",
            }
        )
    command: dict[str, Any] = {
        "type": "run_workflow",
        "direction": direction,
    }
    if node_ids:
        command["node_ids"] = node_ids
    if scope:
        command["scope"] = scope
    if bool(
        args.get("regenerate")
        or args.get("force_regenerate")
        or args.get("forceRegenerate")
    ):
        command["regenerate"] = True
    return _single_write_command(args, command)


def _handle_open_mainline_projection(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    if not project:
        return tool_result(
            {
                "ok": False,
                "status": "project_id_required",
                "error": "project_id is required",
            }
        )

    raw_request = args.get("request") if isinstance(args.get("request"), dict) else args
    scope = str(raw_request.get("scope") or "").strip()
    if scope not in {"episode", "beat", "asset"}:
        return tool_result(
            {
                "ok": False,
                "status": "scope_required",
                "error": "scope must be episode, beat, or asset",
            }
        )

    request: dict[str, Any] = {"scope": scope}
    if isinstance(raw_request.get("episode"), int):
        request["episode"] = raw_request["episode"]
    if isinstance(raw_request.get("beat"), int):
        request["beat"] = raw_request["beat"]
    primary_slot = str(
        raw_request.get("primary_slot") or raw_request.get("primarySlot") or ""
    ).strip()
    if primary_slot:
        request["primary_slot"] = primary_slot
    asset_kind = str(
        raw_request.get("asset_kind") or raw_request.get("assetKind") or ""
    ).strip()
    if asset_kind:
        request["asset_kind"] = asset_kind
    for snake, camel in (
        ("character", "character"),
        ("identity_id", "identityId"),
        ("asset_id", "assetId"),
    ):
        value = str(raw_request.get(snake) or raw_request.get(camel) or "").strip()
        if value:
            request[snake] = value

    if scope == "episode" and "episode" not in request:
        return tool_result(
            {
                "ok": False,
                "status": "episode_required",
                "error": "episode is required for episode scope",
            }
        )
    if scope == "beat" and ("episode" not in request or "beat" not in request):
        return tool_result(
            {
                "ok": False,
                "status": "beat_required",
                "error": "episode and beat are required for beat scope",
            }
        )
    if scope == "asset":
        if "asset_kind" not in request:
            return tool_result(
                {
                    "ok": False,
                    "status": "asset_kind_required",
                    "error": "asset_kind is required for asset scope",
                }
            )
        if not any(key in request for key in ("character", "identity_id", "asset_id")):
            return tool_result(
                {
                    "ok": False,
                    "status": "asset_ref_required",
                    "error": "character, identity_id, or asset_id is required for asset scope",
                }
            )

    return _emit_canvas_commands(
        project,
        canvas,
        [
            {
                "type": "open_mainline_projection",
                "project_id": project,
                "request": request,
            }
        ],
    )


def _request_canvas_context_from_frontend(
    *,
    project: str | None,
    canvas: str | None,
    requests: list[Any],
) -> str:
    envelope = {
        "schema_version": "canvas_context_request.v1",
        **({"canvas_id": canvas} if canvas else {}),
        "requests": requests,
    }
    if (
        canvas_context_bridge_key is not None
        and put_pending_canvas_context is not None
        and wait_canvas_context_result is not None
    ):
        key = canvas_context_bridge_key(
            project_id=project, canvas_id=canvas, requests=requests
        )
        put_pending_canvas_context(
            key=key,
            project_id=project,
            canvas_id=canvas,
            requests=requests,
            envelope=envelope,
        )
        try:
            timeout_seconds = max(
                1,
                int(
                    os.environ.get(
                        "DRAMACLAW_CANVAS_CONTEXT_RESULT_TIMEOUT_SECONDS", "60"
                    )
                ),
            )
        except ValueError:
            timeout_seconds = 60
        timeout_result = {
            "ok": False,
            "tool_call_status": "failed",
            "canvas_context_status": "timeout",
            "errors": ["Timed out waiting for frontend canvas context response."],
            "bridge_key": key,
            **({"project_id": project} if project else {}),
            **({"canvas_id": canvas} if canvas else {}),
        }
        resolved = wait_canvas_context_result(
            key,
            timeout_seconds=timeout_seconds,
            timeout_result=timeout_result,
        )
        if resolved is not None:
            return tool_result(resolved)
        return tool_result(timeout_result)
    return tool_error(
        "Canvas context bridge is unavailable; cannot wait for frontend context result. "
        f"Import error: {_CANVAS_COMMAND_BRIDGE_IMPORT_ERROR}"
    )


def _handle_link_type_catalog(args: dict[str, Any], **_: Any) -> str:
    project = (
        str(
            args.get("project_id") or args.get("project") or _default_project_id()
        ).strip()
        or None
    )
    canvas = (
        str(
            args.get("canvas_id") or args.get("canvasId") or _default_canvas_id()
        ).strip()
        or None
    )
    return _request_canvas_context_from_frontend(
        project=project,
        canvas=canvas,
        requests=[{"type": "link_type_catalog"}],
    )


def _schema(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
    *,
    reject_unknown: bool = False,
) -> dict[str, Any]:
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "required": required or [],
    }
    if reject_unknown:
        parameters["additionalProperties"] = False
    return {
        "name": name,
        "description": description,
        "parameters": parameters,
    }


_SCOPE_PROPS = {
    "project_id": {
        "type": "string",
        "description": "Defaults to the current project context.",
    },
    "canvas_id": {
        "type": "string",
        "description": "Defaults to the current canvas context.",
    },
}

_WORKFLOW_CATALOG_SCHEMA = {
    "type": "object",
    "description": (
        "Catalog identity for this node. Executable nodes must name a Recipe allowed by "
        "the plan's single Skill."
    ),
    "properties": {
        "skillId": {"type": "string", "minLength": 1},
        "skillVersion": {
            "description": "Optional catalog Skill version, as a string or integer.",
            "oneOf": [{"type": "string"}, {"type": "integer"}],
        },
        "recipeId": {"type": "string", "minLength": 1},
        "recipeVersion": {
            "description": "Optional catalog Recipe version, as a string or integer.",
            "oneOf": [{"type": "string"}, {"type": "integer"}],
        },
        "recipePipeline": {
            "type": "array",
            "description": "Optional ordered follow-up Recipes from the same Skill.",
            "items": {
                "oneOf": [
                    {"type": "string", "minLength": 1},
                    {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "minLength": 1},
                            "version": {
                                "oneOf": [
                                    {"type": "string"},
                                    {"type": "integer"},
                                ]
                            },
                        },
                        "required": ["id"],
                    },
                ]
            },
        },
    },
}

_WORKFLOW_NODE_PROPERTIES = {
    "id": {"type": "string", "minLength": 1, "maxLength": 128},
    "title": {"type": "string"},
    "stage": {"type": "string"},
    "content": {"type": "string"},
    "prompt": {"type": "string"},
    "data": {
        "type": "object",
        "properties": {"workflowCatalog": _WORKFLOW_CATALOG_SCHEMA},
    },
}

_RECIPE_BACKED_WORKFLOW_NODE_SCHEMA = {
    "type": "object",
    "properties": {
        **_WORKFLOW_NODE_PROPERTIES,
        "node_type": {
            "type": "string",
            "enum": [
                "textAnnotationNode",
                "scriptNode",
                "beatContextNode",
                "imageGenNode",
                "videoNode",
                "audioNode",
            ],
        },
        "data": {
            "type": "object",
            "properties": {
                "workflowCatalog": {
                    **_WORKFLOW_CATALOG_SCHEMA,
                    "required": ["recipeId"],
                }
            },
            "required": ["workflowCatalog"],
        },
    },
    "required": ["id", "node_type", "data"],
}

_RESOURCE_TEXT_WORKFLOW_NODE_SCHEMA = {
    "type": "object",
    "properties": {
        **_WORKFLOW_NODE_PROPERTIES,
        "node_type": {"type": "string", "enum": ["textAnnotationNode"]},
        "stage": {"type": "string", "enum": ["input", "resource", "asset"]},
    },
    "required": ["id", "node_type", "stage"],
}

_COMPOSE_WORKFLOW_NODE_SCHEMA = {
    "type": "object",
    "properties": {
        **_WORKFLOW_NODE_PROPERTIES,
        "node_type": {"type": "string", "enum": ["videoComposeNode"]},
    },
    "required": ["id", "node_type"],
}

_WORKFLOW_PLAN_OBJECT_SCHEMA = {
    "type": "object",
    "description": (
        "Complete freezone_workflow_plan.v1 object. Send this as a JSON object, never as a "
        "JSON-encoded string. It must reference exactly one valid Skill and explicit Recipes "
        "for executable nodes."
    ),
    "properties": {
        "schema_version": {
            "type": "string",
            "enum": ["freezone_workflow_plan.v1"],
        },
        "workflow_type": {"type": "string"},
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "inputs": {"type": "object"},
        "skill": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "version": {
                    "description": "Optional catalog version, as a string or integer.",
                },
            },
            "required": ["id"],
        },
        "nodes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 200,
            "items": {
                "anyOf": [
                    _RECIPE_BACKED_WORKFLOW_NODE_SCHEMA,
                    _RESOURCE_TEXT_WORKFLOW_NODE_SCHEMA,
                    _COMPOSE_WORKFLOW_NODE_SCHEMA,
                ]
            },
        },
        "edges": {
            "type": "array",
            "description": (
                "Dependency edges for one connected workflow graph. Multi-node plans must not "
                "leave any node isolated."
            ),
            "maxItems": 400,
            "items": {
                "type": "object",
                "properties": {
                    "source": {"type": "string", "minLength": 1},
                    "target": {"type": "string", "minLength": 1},
                    "link_type": {
                        "type": "string",
                        "enum": [
                            "context_for",
                            "prompt_for",
                            "dependency_for",
                            "media_input_for",
                            "derived_from",
                            "composition_input_for",
                        ],
                    },
                },
                "required": ["source", "target", "link_type"],
            },
        },
        "layout": {"type": "object"},
    },
    "required": ["schema_version", "skill", "nodes", "edges"],
    "anyOf": [
        {"properties": {"nodes": {"maxItems": 1}}},
        {
            "properties": {
                "nodes": {"minItems": 2},
                "edges": {"minItems": 1},
            }
        },
    ],
}

_WORKFLOW_INTENT_OBJECT_SCHEMA = {
    "type": "object",
    "description": "Compact dynamic workflow decision. Do not send a full nodes/edges plan.",
    "properties": {
        "schema_version": {
            "type": "string",
            "enum": ["freezone_workflow_intent.v1"],
        },
        "skill_id": {"type": "string"},
        "user_goal": {"type": "string"},
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "inputs": {"type": "object"},
        "planner": {
            "type": "object",
            "description": (
                "Preferred for supported common Skills. The Agent supplies only count, "
                "deliverable, and content units; the tool selects Recipes and dependencies."
            ),
            "properties": {
                "mode": {"type": "string", "enum": ["standard"]},
                "deliverable": {
                    "type": "string",
                    "enum": ["images", "video", "mixed"],
                },
                "item_count": {"type": "integer", "minimum": 1, "maximum": 12},
                "total_duration_seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 600,
                    "description": (
                        "Target duration of the complete video. The compiler distributes it "
                        "across units that omit duration_seconds."
                    ),
                },
                "include_audio": {"type": "boolean"},
                "units": {
                    "type": "array",
                    "maxItems": 12,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "prompt": {"type": "string"},
                            "narration": {"type": "string"},
                            "duration_seconds": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 600,
                                "description": "Duration of this unit's generated video clip.",
                            },
                        },
                        "required": ["title"],
                    },
                },
            },
            "required": ["mode"],
        },
        "items": {
            "type": "array",
            "description": (
                "Dynamic PlanItems. Each item selects one allowed Recipe and declares only "
                "its real input dependencies; the tool creates nodes, edges, layout, and groups."
            ),
            "maxItems": 24,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "prompt": {"type": "string"},
                    "narration": {
                        "type": "string",
                        "description": (
                            "Literal words to speak. Required when audio_kind is speech; "
                            "never put generation instructions here."
                        ),
                    },
                    "audio_kind": {
                        "type": "string",
                        "enum": ["speech", "music"],
                        "description": "Required for audio items when the intent is ambiguous.",
                    },
                    "music_length_ms": {
                        "type": "integer",
                        "minimum": 3000,
                        "maximum": 600000,
                    },
                    "duration_seconds": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 600,
                        "description": (
                            "Required for video items when a target duration was requested. "
                            "The sum of visual item durations should equal the target duration."
                        ),
                    },
                    "recipe_id": {"type": "string"},
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Execution dependencies. A media dependency is not automatically "
                            "sent to the provider as a reference."
                        ),
                    },
                    "reference_inputs": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Item ids whose generated media must be consumed as actual provider "
                            "references. These also imply execution dependencies."
                        ),
                    },
                    "stage": {"type": "string"},
                    "timeline_role": {"type": "string"},
                },
                "required": ["id", "title", "recipe_id"],
            },
        },
        "include_audio": {"type": "boolean"},
        "include_compose": {"type": "boolean"},
        "assumptions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["skill_id", "user_goal"],
}

_WORKFLOW_RUN_AFTER_CREATE_PROPS = {
    "run_after_create": {
        "type": "boolean",
        "description": "Append deterministic workflow execution after graph creation.",
    },
}

# Use the same public contract advertised by the standalone MCP server. Keep the
# local definitions above as a compatibility fallback for isolated Hermes
# installations that do not yet ship the shared schema module.
if workflow_plan_json_schema is not None:
    _WORKFLOW_PLAN_OBJECT_SCHEMA = workflow_plan_json_schema()
if workflow_intent_json_schema is not None:
    _WORKFLOW_INTENT_OBJECT_SCHEMA = workflow_intent_json_schema()

_SKILL_STUDIO_OPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {
            "type": "string",
            "description": "Stable lowercase option id.",
        },
        "label": {
            "type": "string",
            "description": "Short user-facing option label.",
        },
        "description": {
            "type": "string",
            "description": "One-sentence user-facing explanation of this option.",
        },
    },
    "required": ["id", "label"],
}

_SKILL_STUDIO_QUESTION_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {
            "type": "string",
            "description": "Stable lowercase question id.",
        },
        "title": {
            "type": "string",
            "description": "User-facing question title.",
        },
        "description": {
            "type": "string",
            "description": "Optional short explanation for the question.",
        },
        "options": {
            "type": "array",
            "description": "2-4 selectable options.",
            "items": _SKILL_STUDIO_OPTION_SCHEMA,
        },
        "mode": {
            "type": "string",
            "enum": ["single", "multiple"],
            "description": "Selection mode. Use multiple when the user may choose several options.",
        },
        "selection_mode": {
            "type": "string",
            "enum": ["single", "multiple"],
            "description": "Alias of mode. Prefer mode for generic clarification.",
        },
        "allow_custom": {
            "type": "boolean",
            "description": "Whether the frontend should allow a free-form custom answer for this question.",
        },
    },
    "required": ["id", "title", "options"],
}

_SKILL_STUDIO_DRAFT_OUTLINE_STAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {
            "type": "string",
            "description": (
                "Stable planned stage id. Use a neutral craft/stage id, such as character-portrait, "
                "prop-anchor, storyboard-grid, or shot-video. Do not include the current Skill style, "
                "theme, brand, character, product, or one-off case name."
            ),
        },
        "name": {
            "type": "string",
            "description": (
                "Short user-readable stage name. Describe the operation or output shape only. "
                "Do not include the current Skill style, theme, brand, character, product, or one-off case terms."
            ),
        },
        "recipe_id": {
            "type": "string",
            "description": (
                "Catalog Recipe id used by this stage. For reuse=existing, use the existing saved Recipe id exactly. "
                "For reuse=new, propose a reusable craft-level Recipe id based on the operation and output shape, "
                "not the current Skill style, theme, brand, character, product, or case."
            ),
        },
        "output_kind": {
            "type": "string",
            "enum": ["text", "image", "video", "audio"],
            "description": "Expected Recipe output kind.",
        },
        "reuse": {
            "type": "string",
            "enum": ["existing", "new"],
            "description": (
                "Whether this stage reuses a saved Recipe or needs a new Recipe. Use existing only when the "
                "existing Recipe has the same executable craft: same input object, processing action, output shape, "
                "downstream usage, quality boundary, and workflow responsibility. Do not reuse a generic generation "
                "or enhancement Recipe only because output_kind matches when this stage output must act as a stable "
                "reference, review gate, split basis, or composition asset. Use new only when those craft dimensions "
                "do not match."
            ),
        },
        "reason": {
            "type": "string",
            "description": (
                "Short internal reason for the reuse decision. For reuse=existing, explain the craft match. "
                "For reuse=new, summarize the craft mismatch. Do not write only 'same craft', 'same role/prop/video', "
                "or 'similar Recipe'. Do not cite style/theme/brand/aesthetic difference as the reason."
            ),
        },
        "new_recipe_craft_gap": {
            "type": "string",
            "description": (
                "Required when reuse=new. Explain the reusable executable craft gap missing from existing Recipes: "
                "input object, processing action, output shape, downstream usage, workflow responsibility, quality "
                "checks, or failure boundary. Mention why a generic generation/enhancement Recipe is insufficient "
                "when the current stage output is used as a stable reference, review gate, split basis, or composition asset. "
                "Do not include the current Skill's visual style, theme, brand, character name, product name, or one-off case details."
            ),
        },
    },
    "required": ["id", "recipe_id", "reuse"],
}

_SKILL_STUDIO_RATING_BAND_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "number", "description": "Score anchor from 0 to 10."},
        "description": {
            "type": "string",
            "description": "Rubric text for this score anchor.",
        },
    },
    "required": ["score", "description"],
}

_SKILL_STUDIO_REVIEW_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "Review dimension name."},
        "weight": {"type": "number", "description": "Dimension weight from 0 to 1."},
        "description": {
            "type": "string",
            "description": "Review dimension description.",
        },
    },
    "required": ["name", "weight", "description"],
}

_SKILL_STUDIO_INPUT_PARAMETER_SCHEMA = {
    "type": "object",
    "description": (
        "One stateless planning input. Values are extracted from the user's request, completed "
        "with defaults, and confirmed before WorkflowPlan creation; no Skill Session is created."
    ),
    "properties": {
        "id": {
            "type": "string",
            "description": "Stable input id written to plan.inputs.",
        },
        "label": {"type": "string", "description": "User-facing input label."},
        "type": {
            "type": "string",
            "enum": ["single_select", "multi_select", "text", "number", "boolean"],
        },
        "required": {"type": "boolean"},
        "default": {},
        "options": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": ["id", "label", "type", "required"],
}

_SKILL_STUDIO_SKILL_SCHEMA = {
    "type": "object",
    "description": (
        "Complete 虾画 Skill catalog draft. Do not include Recipe drafts inside skill; "
        "put any Recipe drafts in the tool's top-level recipes parameter."
    ),
    "properties": {
        "id": {
            "type": "string",
            "description": "Lowercase id using letters, numbers, underscores, or hyphens.",
        },
        "name": {
            "type": "string",
            "description": "User-facing Skill name.",
        },
        "schema_version": {
            "type": "string",
            "enum": ["dramaclaw.workflow-skill.v1"],
        },
        "version": {
            "oneOf": [{"type": "string"}, {"type": "number"}],
        },
        "description": {
            "type": "string",
            "description": "User-facing skill description.",
        },
        "category": {
            "type": "string",
            "description": "Skill category.",
        },
        "triggers": {
            "type": "object",
            "description": (
                "Trigger rules such as keywords and catalog node scopes. "
                "node_scopes must choose from textGeneration, imageGeneration, "
                "videoGeneration, audioGeneration. Use an empty array when no node scope applies."
            ),
            "properties": {
                "keywords": {"type": "array", "items": {"type": "string"}},
                "node_scopes": {
                    "type": "array",
                    "description": "Catalog node scopes that activate this Skill.",
                    "items": {
                        "type": "string",
                        "enum": _SKILL_STUDIO_NODE_SCOPE_VALUES,
                    },
                },
            },
            "required": ["keywords", "node_scopes"],
        },
        "planning": {
            "type": "object",
            "description": "Planner behavior hints and rules.",
            "properties": {
                "planning_notes": {
                    "type": "string",
                    "description": (
                        "Planner-facing executable path summary for this skill. Start with ordered "
                        "steps, task types, action_keys, upstream dependencies, review/wait behavior, "
                        "and aspect ratio policy; put visual or style guidance after the execution path."
                    ),
                },
                "prompt_guide": {
                    "type": "string",
                    "description": "Prompt style and structure guidance.",
                },
                "conduct_rules": {
                    "type": "array",
                    "description": (
                        "hard execution rules the agent should follow in this domain, not only style "
                        "principles. Include step order, one-node-per-step constraints, input source "
                        "rules, review gates, input parameter usage, and forbidden premature downstream execution."
                    ),
                    "items": {"type": "string"},
                },
            },
            "required": [
                "planning_notes",
                "prompt_guide",
                "conduct_rules",
            ],
        },
        "evaluation": {
            "type": "object",
            "description": "Evaluation rubric.",
            "properties": {
                "rating_bands": {
                    "type": "array",
                    "description": "Score anchors for evaluating output quality.",
                    "items": _SKILL_STUDIO_RATING_BAND_SCHEMA,
                },
                "quality_threshold": {
                    "type": "number",
                    "description": "Passing score threshold.",
                },
                "domain_constraints": {
                    "type": "array",
                    "description": "Domain-specific constraints.",
                    "items": {"type": "string"},
                },
                "visual_review_items": {
                    "type": "array",
                    "description": "Visual review dimensions.",
                    "items": _SKILL_STUDIO_REVIEW_ITEM_SCHEMA,
                },
                "text_review_items": {
                    "type": "array",
                    "description": "Text review dimensions.",
                    "items": _SKILL_STUDIO_REVIEW_ITEM_SCHEMA,
                },
            },
            "required": [
                "rating_bands",
                "quality_threshold",
                "domain_constraints",
                "visual_review_items",
                "text_review_items",
            ],
        },
        "input_parameters": {
            "type": "array",
            "description": (
                "Optional structured inputs for deterministic planning. Keep the list short and "
                "use defaults where safe; the Agent asks only unresolved required values."
            ),
            "items": _SKILL_STUDIO_INPUT_PARAMETER_SCHEMA,
        },
        "allowed_recipe_ids": {
            "type": "array",
            "description": "Recipe ids this dynamic Skill may select at runtime.",
            "items": {"type": "string"},
            "minItems": 1,
        },
    },
    "required": [
        "id",
        "name",
        "schema_version",
        "version",
        "description",
        "category",
        "triggers",
        "planning",
        "evaluation",
        "allowed_recipe_ids",
    ],
}

_SKILL_STUDIO_RECIPE_SCHEMA = {
    "type": "object",
    "description": "Complete 虾画 Recipe catalog draft.",
    "properties": {
        "id": {
            "type": "string",
            "description": "Lowercase id using letters, numbers, underscores, or hyphens.",
        },
        "name": {"type": "string", "description": "User-facing recipe name."},
        "output_kind": {
            "type": "string",
            "enum": ["text", "image", "video", "audio"],
            "description": "Generated output kind.",
        },
        "action_keys": {
            "type": "array",
            "description": "Operation/action keys this recipe matches.",
            "items": {"type": "string"},
        },
        "system_prompt": {
            "type": "string",
            "description": (
                "Recipe 节点级 system_prompt 是 prompt/instruction generator，用来指导 Agent/LLM "
                "根据用户目标、上游输出和参考素材，写出可送入对应节点的提示词/指令或 brief。"
                "不要直接生成最终内容：text Recipe 不直接写正文成品，image/video/audio Recipe "
                "不直接写最终图片、视频或音频描述成品，而是要求当前 LLM 输出给对应 "
                "textGeneration/imageGeneration/videoGeneration/audioGeneration 节点使用的一条完整提示词/指令。"
                "A Recipe system_prompt must never be the final downstream prompt itself. It must "
                "instruct the current LLM how to transform upstream input into the downstream node "
                "prompt/instruction, and should explicitly include: “重要：你的输出是一条提示词/指令，"
                "将被送入下游 <node_type> 节点执行；不要自己生成最终内容。” "
                "必须包含【角色设定】、【输入来源】、【任务目标】、【输出结构要求】、"
                "【质量标准】和【禁止事项/约束】。输出结构要求应描述下游 prompt/brief 必须包含的模块，"
                "例如主体、场景、镜头、构图、风格、色彩、文本排版、连续性和负面约束。"
            ),
        },
        "must_have_items": {
            "type": "array",
            "description": (
                "Required modules or sections that the Recipe output must contain. Prefer structural "
                "items for the downstream prompt/brief, not only style adjectives."
            ),
            "items": {"type": "string"},
        },
        "planning_prompt": {
            "type": "string",
            "description": (
                "Non-empty short business description of what this Recipe node does. "
                "Use the style '根据 X，生成/提取/改写 Y。'. Do not describe scheduling "
                "mechanics, downstream nodes, workflow internals, or when to call the Recipe."
            ),
        },
        "result_summary": {
            "type": "string",
            "description": (
                "Non-empty short business description of this Recipe node's output, such as "
                "'3:4 竖版数码产品科技感详情图' or '家乡文化海报图片生成指令'. "
                "Do not mention downstream execution, imageGeneration handoff, planner behavior, "
                "or workflow mechanics."
            ),
        },
        "requires_source_media": {
            "type": "boolean",
            "description": "Whether the recipe needs image/video/audio input.",
        },
    },
    "required": [
        "id",
        "name",
        "output_kind",
        "action_keys",
        "system_prompt",
        "must_have_items",
        "planning_prompt",
        "result_summary",
        "requires_source_media",
    ],
}


_LINK_TYPE_VALUES = [
    "context_for",
    "prompt_for",
    "dependency_for",
    "media_input_for",
    "derived_from",
    "composition_input_for",
]

_NODE_TYPE_VALUES = [
    "uploadNode",
    "imageNode",
    "imageGenNode",
    "exportImageNode",
    "beatContextNode",
    "textAnnotationNode",
    "groupNode",
    "storyboardNode",
    "storyboardGenNode",
    "videoNode",
    "audioNode",
    "videoStoryNode",
    "videoComposeNode",
    "scriptNode",
    "pano360ViewerNode",
    "threeDWorldNode",
    "skillNode",
]

_AGENT_CREATABLE_NODE_TYPE_VALUES = [
    "uploadNode",
    "imageGenNode",
    "beatContextNode",
    "textAnnotationNode",
    "videoNode",
    "audioNode",
    "videoComposeNode",
    "scriptNode",
    "pano360ViewerNode",
    "threeDWorldNode",
    "skillNode",
]

_NODE_TYPE_DESCRIPTION = (
    "Directly creatable Freezone canvas node type. Use only these values for "
    "create_node/add_next_node. If the user asks to add a picture/image node, use "
    "imageGenNode unless they explicitly ask to upload or import an existing file. "
    "Use freezone_group_nodes/group_nodes for grouping existing nodes. "
    "Use textAnnotationNode for ordinary briefs, copy, notes, "
    "prompts, and free-form text. Use scriptNode only for explicit structured script "
    "tables or script-generation workflows. Use threeDWorldNode for 导演世界; "
    "directorWorldNode is not a valid node type."
)

_NODE_TYPE_SCHEMA = {
    "type": "string",
    "enum": _AGENT_CREATABLE_NODE_TYPE_VALUES,
    "description": _NODE_TYPE_DESCRIPTION,
}

_NODE_TYPE_ALIAS_SCHEMA = {
    "type": "string",
    "enum": _AGENT_CREATABLE_NODE_TYPE_VALUES,
    "description": "Alias of node_type. Prefer snake_case node_type.",
}

_MAINLINE_PROJECTION_SCOPE_VALUES = ["episode", "beat", "asset"]
_MAINLINE_PRIMARY_SLOT_VALUES = ["sketch", "frame", "render"]
_MAINLINE_ASSET_KIND_VALUES = [
    "character",
    "identity",
    "portrait",
    "scene",
    "scene_master",
    "scene_reverse_master",
    "scene_spatial_layout",
    "scene_360",
    "prop",
    "prop_ref",
]
_MAINLINE_PROJECTION_ASSET_KIND_VALUES = [
    "character",
    "scene",
    "scene_master",
    "scene_reverse_master",
    "scene_spatial_layout",
    "scene_360",
    "prop",
    "prop_ref",
]


def _command_variant(
    command_type: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": [command_type]},
            **properties,
        },
        "required": ["type", *(required or [])],
        "additionalProperties": False,
    }


_NON_EMPTY_STRING = {"type": "string", "minLength": 1}
_NODE_IDS_SCHEMA = {
    "type": "array",
    "items": _NON_EMPTY_STRING,
    "minItems": 1,
}
_POSITION_SCHEMA = {
    "type": "object",
    "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
    "required": ["x", "y"],
    "additionalProperties": False,
}
_POSITIONS_SCHEMA = {
    "type": "object",
    "additionalProperties": _POSITION_SCHEMA,
    "minProperties": 1,
}
_TEXT_ANNOTATION_DATA_SCHEMA = {
    "type": "object",
    "properties": {
        "title": _NON_EMPTY_STRING,
        "displayName": _NON_EMPTY_STRING,
        "content": _NON_EMPTY_STRING,
    },
    "required": ["content"],
    "anyOf": [{"required": ["title"]}, {"required": ["displayName"]}],
}
_OTHER_AGENT_CREATABLE_NODE_TYPE_VALUES = [
    value
    for value in _AGENT_CREATABLE_NODE_TYPE_VALUES
    if value != "textAnnotationNode"
]

# Keep this JSON Schema mechanically aligned with the frontend's
# CanvasChatCommand discriminated union. A single object containing every
# optional field makes some providers fill the union with zero values and omit
# the payload that actually matters. Each branch therefore exposes only the
# fields valid for that command type.
_CANVAS_COMMAND_ITEM_SCHEMA = {
    "oneOf": [
        _command_variant(
            "create_node",
            {
                "client_id": _NON_EMPTY_STRING,
                "node_type": {
                    "type": "string",
                    "enum": ["textAnnotationNode"],
                },
                "position": _POSITION_SCHEMA,
                "data": _TEXT_ANNOTATION_DATA_SCHEMA,
            },
            ["node_type", "data"],
        ),
        _command_variant(
            "create_node",
            {
                "client_id": _NON_EMPTY_STRING,
                "node_type": {
                    "type": "string",
                    "enum": _OTHER_AGENT_CREATABLE_NODE_TYPE_VALUES,
                },
                "position": _POSITION_SCHEMA,
                "data": {"type": "object"},
            },
            ["node_type"],
        ),
        _command_variant(
            "add_next_node",
            {
                "client_id": _NON_EMPTY_STRING,
                "source_node_id": _NON_EMPTY_STRING,
                "node_type": {
                    "type": "string",
                    "enum": _AGENT_CREATABLE_NODE_TYPE_VALUES,
                },
                "data": {"type": "object"},
                "connect": {"type": "boolean"},
            },
            ["source_node_id"],
        ),
        _command_variant(
            "update_node_data",
            {"node_id": _NON_EMPTY_STRING, "data": {"type": "object"}},
            ["node_id", "data"],
        ),
        _command_variant("delete_nodes", {"node_ids": _NODE_IDS_SCHEMA}, ["node_ids"]),
        _command_variant("clear_canvas", {}, []),
        _command_variant(
            "delete_edges",
            {"edge_ids": _NODE_IDS_SCHEMA},
            ["edge_ids"],
        ),
        _command_variant(
            "delete_edges",
            {
                "pairs": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source": _NON_EMPTY_STRING,
                            "target": _NON_EMPTY_STRING,
                        },
                        "required": ["source", "target"],
                        "additionalProperties": False,
                    },
                    "minItems": 1,
                }
            },
            ["pairs"],
        ),
        _command_variant(
            "create_edge",
            {
                "source": _NON_EMPTY_STRING,
                "target": _NON_EMPTY_STRING,
                "link_type": {"type": "string", "enum": _LINK_TYPE_VALUES},
            },
            ["source", "target", "link_type"],
        ),
        _command_variant(
            "layout_nodes",
            {
                "node_ids": _NODE_IDS_SCHEMA,
                "mode": {"type": "string", "enum": ["horizontal", "vertical", "grid"]},
            },
            ["mode"],
        ),
        _command_variant(
            "group_nodes",
            {"node_ids": _NODE_IDS_SCHEMA, "label": {"type": "string"}},
            ["node_ids"],
        ),
        _command_variant(
            "move_nodes",
            {"positions": _POSITIONS_SCHEMA},
            ["positions"],
        ),
        _command_variant(
            "move_nodes",
            {"deltas": _POSITIONS_SCHEMA},
            ["deltas"],
        ),
        _command_variant(
            "select_nodes",
            {"node_ids": _NODE_IDS_SCHEMA, "focus": {"type": "boolean"}},
            ["node_ids"],
        ),
        _command_variant(
            "run_node_action",
            {
                "node_id": _NON_EMPTY_STRING,
                "action": _NON_EMPTY_STRING,
                "parameters": {"type": "object"},
            },
            ["node_id", "action"],
        ),
        _command_variant(
            "open_mainline_projection",
            {"project_id": _NON_EMPTY_STRING, "request": {"type": "object"}},
            ["request"],
        ),
        {
            **_command_variant(
                "run_workflow",
                {
                    "node_ids": _NODE_IDS_SCHEMA,
                    "scope": {"type": "string", "enum": ["selection", "canvas"]},
                    "direction": {
                        "type": "string",
                        "enum": ["connected", "node", "downstream"],
                    },
                    "regenerate": {"type": "boolean"},
                },
            ),
            "anyOf": [
                {"required": ["node_ids"]},
                {
                    "properties": {"scope": {"const": "canvas"}},
                    "required": ["scope"],
                },
            ],
        },
    ]
}

_CANVAS_COMMAND_TOOL_SCOPE_PROPS = {
    "project_id": _SCOPE_PROPS["project_id"],
    "canvas_id": _SCOPE_PROPS["canvas_id"],
}


TOOLS = (
    # 读全局画布上下文。
    (
        "freezone_get_canvas_ontology",
        _schema(
            "freezone_get_canvas_ontology",
            "Request the current detailed Freezone canvas ontology context from the frontend.",
            _SCOPE_PROPS,
        ),
        _handle_canvas_ontology,
    ),
    (
        "freezone_summarize_canvas",
        _schema(
            "freezone_summarize_canvas",
            "Request the simple Freezone canvas ontology summary from the frontend.",
            _SCOPE_PROPS,
        ),
        _handle_summarize_canvas,
    ),
    (
        "freezone_get_canvas_action_catalog",
        _schema(
            "freezone_get_canvas_action_catalog",
            "Request the current canvas-level Freezone action catalog from the frontend.",
            _SCOPE_PROPS,
        ),
        _handle_canvas_action_catalog,
    ),
    (
        "freezone_get_canvas_command_catalog",
        _schema(
            "freezone_get_canvas_command_catalog",
            "Request the frontend Freezone canvas_chat_commands.v1 command catalog. Use this before freezone_emit_canvas_command when batch command fields are unclear.",
            _SCOPE_PROPS,
        ),
        _handle_canvas_command_catalog,
    ),
    (
        "freezone_request_user_clarification",
        _schema(
            "freezone_request_user_clarification",
            "Ask the user structured clarification questions in the Freezone frontend and wait for their submitted answers. Use for user choices before continuing the current chat or workflow, including Skill Studio setup questions. For image/video generation, never combine fields into a recommended-settings preset: use one question per missing field, inspect the live node schema, and expose exact resolution values such as 480P/720P when supported. The submitted answers only mean the user completed the choices; decide the next step from the current context. This tool does not write canvas nodes or save catalog files.",
            {
                "clarification_id": {
                    "type": "string",
                    "description": "Optional stable id for this clarification request. Omit this unless you already have one; Freezone will generate it automatically.",
                },
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Optional Skill Studio session id used only to generate a traceable clarification id.",
                },
                "title": {
                    "type": "string",
                    "description": "Short title shown above the question card.",
                },
                "description": {
                    "type": "string",
                    "description": "Optional one-sentence explanation shown to the user.",
                },
                "questions": {
                    "type": "array",
                    "description": "High-level user-facing questions. Ask only the questions needed for the next decision; use one focused question when the next step depends on one answer, or group closely related choices when they should be answered together. Each question should usually have 2-5 options.",
                    "items": _SKILL_STUDIO_QUESTION_SCHEMA,
                },
                "allow_recommended": {
                    "type": "boolean",
                    "description": "Whether the frontend should show a use-recommended option.",
                },
                "allow_skip": {
                    "type": "boolean",
                    "description": "Whether the frontend should allow skipping this clarification.",
                },
                **_SCOPE_PROPS,
            },
            ["questions"],
        ),
        _handle_request_user_clarification,
    ),
    (
        "freezone_present_agent_catalog_draft",
        _schema(
            "freezone_present_agent_catalog_draft",
            "Legacy small-draft path for presenting an editable Skill/Recipe catalog draft for 虾画 Skill Studio. Prefer the chunked draft tools for normal Skill Studio drafts: begin, put skill, put each recipe, then finish. Do not paste final JSON in prose and do not claim it is saved.",
            {
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Stable id shared by questions, draft, and later edits in this Skill Studio flow.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["create", "edit"],
                    "description": "Draft mode.",
                },
                "skill": _SKILL_STUDIO_SKILL_SCHEMA,
                "recipes": {
                    "type": "array",
                    "description": (
                        "Complete Recipe drafts. Pass Recipe drafts in this top-level recipes "
                        "parameter; do not nest recipes inside the skill object."
                    ),
                    "items": _SKILL_STUDIO_RECIPE_SCHEMA,
                },
                "summary": {
                    "type": "string",
                    "description": "Short user-facing summary.",
                },
                "warnings": {
                    "type": "array",
                    "description": "User-facing draft warnings.",
                    "items": {"type": "string"},
                },
            },
            ["skill_studio_session_id", "mode"],
        ),
        _handle_present_agent_catalog_draft,
    ),
    (
        "freezone_put_agent_catalog_draft_outline",
        _schema(
            "freezone_put_agent_catalog_draft_outline",
            "Submit the internal 虾画 Skill Studio capability outline before creating a chunked draft. Use this after modeling the reusable Skill goal, Skill-level constraints, planned executable stages, and existing Recipe reuse. For create drafts with Recipes, call this before freezone_begin_agent_catalog_draft.",
            {
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Stable id shared by questions, outline, draft chunks, final draft, and later edits.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["create", "edit"],
                    "description": "Draft mode.",
                },
                "reuse_goal": {
                    "type": "string",
                    "description": "Internal one-sentence reusable capability goal for the Skill.",
                },
                "skill_level_constraints": {
                    "type": "array",
                    "description": "Style, domain, behavior, material inheritance, review, and global quality rules that belong to the Skill rather than Recipes.",
                    "items": {"type": "string"},
                },
                "stages": {
                    "type": "array",
                    "description": (
                        "Planned executable Recipe stages. Include only stages that will become allowed_recipe_ids. "
                        "For reuse=new stages, include new_recipe_craft_gap with concrete craft differences; "
                        "do not create a new Recipe only because the Skill has a different style, theme, brand, or aesthetic."
                    ),
                    "items": _SKILL_STUDIO_DRAFT_OUTLINE_STAGE_SCHEMA,
                },
                "expected_recipe_count": {
                    "type": "integer",
                    "description": "Planned number of new Recipe chunks that must be submitted after the outline. Reused existing Recipes do not count; they should only appear in Skill allowed_recipe_ids.",
                },
                "catalog_checked": {
                    "type": "boolean",
                    "description": "True only after checking injected catalog summary or calling freezone_list_agent_catalog(kind='recipes', query=...).",
                },
                "catalog_notes": {
                    "type": "string",
                    "description": "Short internal note describing reused existing Recipes and new Recipe gaps.",
                },
                "summary": {
                    "type": "string",
                    "description": "Short user-facing summary for the final draft.",
                },
                "warnings": {
                    "type": "array",
                    "description": "User-facing draft warnings collected during outline modeling.",
                    "items": {"type": "string"},
                },
                **_SCOPE_PROPS,
            },
            [
                "skill_studio_session_id",
                "mode",
                "reuse_goal",
                "stages",
                "expected_recipe_count",
                "catalog_checked",
            ],
        ),
        _handle_put_agent_catalog_draft_outline,
    ),
    (
        "freezone_begin_agent_catalog_draft",
        _schema(
            "freezone_begin_agent_catalog_draft",
            "Begin a chunked 虾画 Skill Studio draft. Before calling this, decide the target number of Recipe chunks and pass expected_recipe_count, using 0 only when this draft intentionally has no Recipes. This tool only emits progress and does not wait for user confirmation.",
            {
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Stable id shared by questions, draft chunks, final draft, and later edits.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["create", "edit"],
                    "description": "Draft mode.",
                },
                "summary": {
                    "type": "string",
                    "description": "Short user-facing summary for the final draft.",
                },
                "warnings": {
                    "type": "array",
                    "description": "User-facing draft warnings collected during generation.",
                    "items": {"type": "string"},
                },
                "expected_recipe_count": {
                    "type": "integer",
                    "description": "Required planned number of Recipe chunks. Use 0 only when the draft intentionally has no Recipes; otherwise pass the total count before sending Recipe chunks.",
                },
                **_SCOPE_PROPS,
            },
            ["skill_studio_session_id", "mode", "expected_recipe_count"],
        ),
        _handle_begin_agent_catalog_draft,
    ),
    (
        "freezone_put_agent_catalog_skill",
        _schema(
            "freezone_put_agent_catalog_skill",
            "Submit the Skill chunk for the current 虾画 Skill Studio draft. Do not include Recipe drafts inside skill.",
            {
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Stable id for the current chunked Skill Studio draft.",
                },
                "skill": _SKILL_STUDIO_SKILL_SCHEMA,
                **_SCOPE_PROPS,
            },
            ["skill_studio_session_id", "skill"],
        ),
        _handle_put_agent_catalog_skill,
    ),
    (
        "freezone_put_agent_catalog_recipe",
        _schema(
            "freezone_put_agent_catalog_recipe",
            "Submit one Recipe chunk for the current 虾画 Skill Studio draft. Call once per Recipe instead of passing all recipes in one tool call.",
            {
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Stable id for the current chunked Skill Studio draft.",
                },
                "index": {
                    "type": "integer",
                    "description": "Zero-based Recipe position. The final draft orders recipes by this index.",
                },
                "recipe": _SKILL_STUDIO_RECIPE_SCHEMA,
                **_SCOPE_PROPS,
            },
            ["skill_studio_session_id", "recipe"],
        ),
        _handle_put_agent_catalog_recipe,
    ),
    (
        "freezone_patch_agent_catalog_draft",
        _schema(
            "freezone_patch_agent_catalog_draft",
            "Apply small JSON Pointer patches for local edits to the current 虾画 Skill Studio draft session. For local edits, prefer this tool over regenerating unchanged Skill/Recipe chunks. Use put_skill or put_recipe only when replacing an entire object. Always finish with freezone_finish_agent_catalog_draft after patching.",
            {
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Stable id for the current chunked Skill Studio draft.",
                },
                "target": {
                    "type": "string",
                    "enum": ["skill", "recipe"],
                    "description": "Patch the Skill object or one Recipe object.",
                },
                "recipe_id": {
                    "type": "string",
                    "description": "Required when target=recipe. Locate the Recipe by id; do not patch recipes by array index.",
                },
                "patch": {
                    "type": "array",
                    "description": (
                        "Top-level field name must be patch; do not use operation, operations, or patches. "
                        "patch is an array of JSON Pointer patch entries for local edits. "
                        "Supported entry ops: replace, add, remove. "
                        "Paths must start with '/', cannot modify /id, and must not rely on Recipe array indexes. "
                        "When target=recipe, recipe_id already selects the Recipe, so paths are relative to that "
                        "Recipe object, for example /system_prompt or /must_have_items; never use "
                        "/recipes/<recipe_id>/system_prompt. To remove the selected Recipe, use "
                        'patch=[{"op":"remove","path":""}].'
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": {
                                "type": "string",
                                "enum": ["replace", "add", "remove"],
                            },
                            "path": {
                                "type": "string",
                                "description": (
                                    "JSON Pointer path. Skill example: /triggers/keywords/0. "
                                    "Recipe example with target=recipe and recipe_id set: /system_prompt or "
                                    "/must_have_items, not /recipes/<recipe_id>/system_prompt. Use an empty string "
                                    "only with target=recipe and op=remove to delete the entire selected Recipe."
                                ),
                            },
                            "value": {"description": "Value for replace/add entries."},
                        },
                        "required": ["op", "path"],
                    },
                },
                **_SCOPE_PROPS,
            },
            ["skill_studio_session_id", "target", "patch"],
        ),
        _handle_patch_agent_catalog_draft,
    ),
    (
        "freezone_finish_agent_catalog_draft",
        _schema(
            "freezone_finish_agent_catalog_draft",
            "Finish a chunked 虾画 Skill Studio draft, assemble previously submitted chunks, and present the editable draft card. Do not pass the full Skill/Recipe catalog in this call; this schema intentionally has no skill or recipes parameters.",
            {
                "skill_studio_session_id": {
                    "type": "string",
                    "description": "Stable id for the current chunked Skill Studio draft.",
                },
                "expected_recipe_count": {
                    "type": "integer",
                    "description": "Optional final validation count. Do not use this to send Recipe data.",
                },
                "summary": {
                    "type": "string",
                    "description": "Optional final summary override. Do not use this to send catalog JSON.",
                },
                **_SCOPE_PROPS,
            },
            ["skill_studio_session_id"],
        ),
        _handle_finish_agent_catalog_draft,
    ),
    (
        "freezone_list_agent_catalog",
        _schema(
            "freezone_list_agent_catalog",
            "List compact saved 虾画 Skill or Recipe summaries for Skill Studio discovery and reuse. Read-only: does not return full Recipe system_prompt, does not save catalog files, does not execute workflows, and does not write canvas nodes. Use query to find reusable Recipes before creating new ones.",
            {
                "kind": {
                    "type": "string",
                    "enum": ["skills", "recipes"],
                    "description": "Catalog kind to list.",
                },
                "query": {
                    "type": "string",
                    "description": (
                        "Optional search text. The tool tokenizes this text and returns compact summaries ranked by "
                        "matched tokens across id, name, description, action keys, allowed Recipes, output kind, "
                        "and result summary. Use a few craft keywords rather than a full sentence."
                    ),
                },
                "q": {
                    "type": "string",
                    "description": "Alias of query.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum summaries to return. Default 12, maximum 30.",
                },
            },
            ["kind"],
        ),
        _handle_list_agent_catalog,
    ),
    (
        "freezone_get_saved_skill",
        _schema(
            "freezone_get_saved_skill",
            "Read one existing saved 虾画 Skill configuration by id for Skill Studio editing. Read-only: does not save catalog files, does not execute workflows, and does not write canvas nodes. Use this when revising a saved Skill and conversation history only has the saved id or an incomplete draft.",
            {
                "skill_id": {
                    "type": "string",
                    "description": "Saved Skill id to read from the current user's Freezone catalog.",
                },
            },
            ["skill_id"],
        ),
        _handle_get_saved_skill,
    ),
    (
        "freezone_get_saved_recipe",
        _schema(
            "freezone_get_saved_recipe",
            "Read one existing saved 虾画 Recipe configuration by id for Skill Studio editing. Read-only: does not save catalog files, does not execute workflows, and does not write canvas nodes. Use this when revising a saved Recipe and conversation history only has the saved id or an incomplete draft.",
            {
                "recipe_id": {
                    "type": "string",
                    "description": "Saved Recipe id to read from the current user's Freezone catalog.",
                },
            },
            ["recipe_id"],
        ),
        _handle_get_saved_recipe,
    ),
    (
        "freezone_get_link_type_catalog",
        _schema(
            "freezone_get_link_type_catalog",
            "Request the Freezone ordinary node link_type catalog for create_edge source/target compatibility.",
            _SCOPE_PROPS,
        ),
        _handle_link_type_catalog,
    ),
    (
        "freezone_get_selection",
        _schema(
            "freezone_get_selection",
            "Request the current Freezone canvas selection from the frontend.",
            _SCOPE_PROPS,
        ),
        _handle_selection,
    ),
    # 读节点级上下文。
    (
        "freezone_get_node_detail",
        _schema(
            "freezone_get_node_detail",
            "Request detailed context for one Freezone canvas node from the frontend. This returns node data parameters, not toolbar/action parameters.",
            {
                **_SCOPE_PROPS,
                "node_id": {"type": "string", "description": "Canvas node id."},
                "nodeId": {"type": "string", "description": "Alias of node_id."},
            },
            ["node_id"],
        ),
        _handle_node_detail,
    ),
    (
        "freezone_get_neighbor_graph",
        _schema(
            "freezone_get_neighbor_graph",
            "Request upstream/downstream neighbor graph context around one Freezone canvas node.",
            {
                **_SCOPE_PROPS,
                "node_id": {"type": "string", "description": "Canvas node id."},
                "nodeId": {"type": "string", "description": "Alias of node_id."},
                "depth": {
                    "type": "number",
                    "description": "Neighbor traversal depth. Defaults to 1.",
                },
            },
            ["node_id"],
        ),
        _handle_neighbor_graph,
    ),
    (
        "freezone_get_node_action_catalog",
        _schema(
            "freezone_get_node_action_catalog",
            "Request the action catalog for one Freezone canvas node from the frontend. Use this with action before answering questions about toolbar/action parameters or behavior; node_detail.parameters are only node data.",
            {
                **_SCOPE_PROPS,
                "node_id": {"type": "string", "description": "Canvas node id."},
                "nodeId": {"type": "string", "description": "Alias of node_id."},
                "action": {
                    "type": "string",
                    "description": "Optional action id to return one action's exact parameters and behavior. Omit only when comparing all node actions.",
                },
                "action_name": {"type": "string", "description": "Alias of action."},
                "actionName": {"type": "string", "description": "Alias of action."},
            },
            ["node_id"],
        ),
        _handle_node_action_catalog,
    ),
    (
        "freezone_get_node_create_schema",
        _schema(
            "freezone_get_node_create_schema",
            "Request allowed create_node data schema for one Freezone node type from the frontend. "
            "For ordinary text, briefs, copywriting, prompts, notes, or free-form scripts, "
            "request textAnnotationNode schema. Request scriptNode only when the user "
            "explicitly asks for structured script tables or a script-generation workflow.",
            {
                **_SCOPE_PROPS,
                "node_type": _NODE_TYPE_SCHEMA,
                "nodeType": _NODE_TYPE_ALIAS_SCHEMA,
            },
            ["node_type"],
        ),
        _handle_node_create_schema,
    ),
    (
        "freezone_get_audio_voice_options",
        _schema(
            "freezone_get_audio_voice_options",
            "Request dynamic voice options for one Freezone audio node from the frontend.",
            {
                **_SCOPE_PROPS,
                "node_id": {"type": "string", "description": "Audio canvas node id."},
                "nodeId": {"type": "string", "description": "Alias of node_id."},
            },
            ["node_id"],
        ),
        _handle_audio_voice_options,
    ),
    (
        "freezone_get_slot_candidates",
        _schema(
            "freezone_get_slot_candidates",
            "Canvas -> mainline only. Request Freezone canvas nodes that can be submitted/pushed back to a mainline slot. Use this only when the user wants to submit, sync, or set a canvas node as a mainline result; do not use it to open/map/project mainline content into Freezone.",
            {
                **_SCOPE_PROPS,
                "slot_kind": {
                    "type": "string",
                    "description": "Optional mainline slot kind filter for canvas-to-mainline submission, e.g. image, video, audio, or text.",
                },
                "slotKind": {"type": "string", "description": "Alias of slot_kind."},
            },
        ),
        _handle_slot_candidates,
    ),
    (
        "freezone_get_mainline_projection_assets",
        _schema(
            "freezone_get_mainline_projection_assets",
            "Mainline -> canvas only. Request compact mainline asset candidates that can be opened/mapped/projected into Freezone with freezone_open_mainline_projection. Use only after the user explicitly asks to map/open/project mainline characters, scenes, or props into Freezone; do not use for ordinary canvas creation/editing/linking/layout/generation, and do not use for canvas-to-mainline submission. For people/characters/identities/portraits, always request asset kind character.",
            {
                **_SCOPE_PROPS,
                "asset_kinds": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": _MAINLINE_PROJECTION_ASSET_KIND_VALUES,
                    },
                    "description": "Optional filters for mainline asset kinds to map into Freezone. Use character for all people/identity/portrait requests. Other narrow categories include prop, scene_master, scene_reverse_master, scene_360, or prop_ref.",
                },
                "assetKinds": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Alias of asset_kinds.",
                },
                "asset_kind": {
                    "type": "string",
                    "enum": _MAINLINE_PROJECTION_ASSET_KIND_VALUES,
                    "description": "Single asset kind filter alias. Prefer asset_kinds for multiple values.",
                },
                "assetKind": {"type": "string", "description": "Alias of asset_kind."},
                "query": {
                    "type": "string",
                    "description": "Optional user-facing keyword to match asset label/name.",
                },
                "q": {"type": "string", "description": "Alias of query."},
                "limit": {
                    "type": "integer",
                    "description": "Maximum candidates to return. Default 20, maximum 50.",
                },
            },
        ),
        _handle_mainline_projection_assets,
    ),
    (
        "freezone_get_workflow_skill",
        _schema(
            "freezone_get_workflow_skill",
            "Load the complete planning package for one explicitly selected native Hermes Workflow Skill, including its rules, compatible Recipes, capabilities, and strict workflow contract. This is read-only and always requires the selected skill_id.",
            {
                "skill_id": {
                    "type": "string",
                    "description": "Explicit selected Skill id.",
                },
                "user_goal": {
                    "type": "string",
                    "description": "Current user goal used as planning context; it does not route to another Skill.",
                },
                "inputs": {
                    "type": "object",
                    "description": (
                        "Structured Skill input values already stated or confirmed by the user. "
                        "The result returns defaults, missing required fields, validation errors, "
                        "and the recommended run_after_create mode without creating a session."
                    ),
                },
                "compact": {
                    "type": "boolean",
                    "description": (
                        "When true, omit full Recipe definitions and return planning summaries only. "
                        "Use this for normal WorkflowPlan generation to reduce context size."
                    ),
                },
            },
            ["skill_id"],
            reject_unknown=True,
        ),
        _handle_get_workflow_skill,
    ),
    (
        "freezone_prepare_workflow_draft",
        _schema(
            "freezone_prepare_workflow_draft",
            (
                "Compile a structured intent and request an operation-bound Agent planning quote. "
                "If billing is required, stop until the server supplies quote_id and "
                "confirmation_receipt after the user's explicit confirmation, then retry the exact "
                "same intent to persist the deterministic preview. Do not pass draft_id, do not pass intent as a string, and "
                "do not use execute_code. Use freezone_patch_workflow_draft for an existing draft."
            ),
            {
                **_SCOPE_PROPS,
                "intent": _WORKFLOW_INTENT_OBJECT_SCHEMA,
                "quote_id": {
                    "type": "string",
                    "description": "Server-issued billing quote id.",
                },
                "confirmation_receipt": {
                    "type": "string",
                    "description": "Trusted server-issued receipt bound to this exact operation.",
                },
                **_WORKFLOW_RUN_AFTER_CREATE_PROPS,
            },
            [],
            reject_unknown=True,
        ),
        _handle_prepare_workflow_draft,
    ),
    (
        "freezone_patch_workflow_draft",
        _schema(
            "freezone_patch_workflow_draft",
            (
                "Apply a small user-requested change to an existing workflow draft, recompile it, "
                "and return the exact updated preview. Keep the selected skill_id unchanged and "
                "send only changed intent fields."
            ),
            {
                **_SCOPE_PROPS,
                "draft_id": {"type": "string"},
                "expected_revision": {
                    "type": "integer",
                    "description": "Last revision shown to the user; rejects stale updates.",
                },
                "changes": {
                    "type": "object",
                    "description": (
                        "Changed compact-intent fields only. Supported fields: user_goal, title, "
                        "summary, inputs, planner, items, include_audio, include_compose, "
                        "assumptions. "
                        "Null removes an optional field; inputs are merged."
                    ),
                },
                "quote_id": {
                    "type": "string",
                    "description": "Server-issued billing quote id.",
                },
                "confirmation_receipt": {
                    "type": "string",
                    "description": "Trusted server-issued receipt bound to this exact patch.",
                },
                **_WORKFLOW_RUN_AFTER_CREATE_PROPS,
            },
            ["draft_id", "expected_revision", "changes"],
            reject_unknown=True,
        ),
        _handle_patch_workflow_draft,
    ),
    (
        "freezone_confirm_workflow_draft",
        _schema(
            "freezone_confirm_workflow_draft",
            (
                "Create the exact persisted workflow draft after the user confirms its preview. "
                "Requires the shown revision, prevents duplicate confirmation, and delegates "
                "node creation, approval, and optional execution to the deterministic canvas path."
            ),
            {
                **_SCOPE_PROPS,
                "draft_id": {"type": "string"},
                "revision": {
                    "type": "integer",
                    "description": "Exact draft revision confirmed by the user.",
                },
                "quote_id": {
                    "type": "string",
                    "description": "Server-issued billing quote id.",
                },
                "confirmation_receipt": {
                    "type": "string",
                    "description": "Trusted server-issued receipt bound to this exact creation.",
                },
                **_WORKFLOW_RUN_AFTER_CREATE_PROPS,
            },
            ["draft_id", "revision"],
            reject_unknown=True,
        ),
        _handle_confirm_workflow_draft,
    ),
    (
        "freezone_prepare_workflow_plan_draft",
        _schema(
            "freezone_prepare_workflow_plan_draft",
            "Validate and prepare one complete agent-authored freezone_workflow_plan.v1 as a "
            "persisted draft. This is the only custom-topology entry point: it first obtains an "
            "operation-bound planning quote, requires a trusted server receipt, then returns an "
            "exact preview. It never writes canvas nodes directly. After the user reviews the "
            "preview, use freezone_confirm_workflow_draft with its draft_id and revision.",
            {
                **_SCOPE_PROPS,
                "plan": _WORKFLOW_PLAN_OBJECT_SCHEMA,
                "quote_id": {
                    "type": "string",
                    "description": "Server-issued billing quote id.",
                },
                "confirmation_receipt": {
                    "type": "string",
                    "description": "Trusted server-issued receipt bound to this exact Plan.",
                },
                "run_after_create": {
                    "type": "boolean",
                    "description": (
                        "When true, append run_workflow after graph creation in the same approved "
                        "frontend batch after the user has approved the WorkflowPlan."
                    ),
                },
            },
            ["plan"],
            reject_unknown=True,
        ),
        _handle_prepare_workflow_plan_draft,
    ),
    # 写入前预校验。
    (
        "freezone_validate_canvas_commands",
        _schema(
            "freezone_validate_canvas_commands",
            "Preflight validate canvas_chat_commands.v1 against the current frontend canvas before emitting commands.",
            {
                **_CANVAS_COMMAND_TOOL_SCOPE_PROPS,
                "commands": {
                    "type": "array",
                    "description": "Commands array from a canvas_chat_commands.v1 envelope. Batch commands require snake_case fields such as type and node_type; do not use legacy command/nodeType/imageGenerationParams.",
                    "items": _CANVAS_COMMAND_ITEM_SCHEMA,
                },
            },
            ["commands"],
            reject_unknown=True,
        ),
        _handle_validate_commands,
    ),
    # 写入画布命令：默认用批量入口一次提交；只有用户明确要求单个操作时才用后面的单步工具。
    (
        "freezone_emit_canvas_command",
        _schema(
            "freezone_emit_canvas_command",
            "Default Freezone write tool for ordinary non-workflow canvas edits. Submit one complete canvas_chat_commands.v1 commands array for the user's requested canvas changes. Do not use this tool for registered or dynamic WorkflowPlans; use the appropriate persisted workflow draft tool instead. If commands[] fields are unclear, call freezone_get_canvas_command_catalog first.",
            {
                **_CANVAS_COMMAND_TOOL_SCOPE_PROPS,
                "commands": {
                    "type": "array",
                    "description": "Complete canvas_chat_commands.v1 commands array for ordinary non-workflow edits. For workflows, do not build this array manually; use a persisted workflow draft. Batch command objects require snake_case fields from freezone_get_canvas_command_catalog: type, node_type, source_node_id, node_id, node_ids, source, target, link_type, etc.",
                    "items": _CANVAS_COMMAND_ITEM_SCHEMA,
                },
            },
            ["commands"],
            reject_unknown=True,
        ),
        _handle_emit_canvas_command,
    ),
    (
        "freezone_confirm_canvas_action",
        _schema(
            "freezone_confirm_canvas_action",
            "Confirm and apply a pending MCP canvas action after the user explicitly approves it in the Codex/Claude/OpenClaw chat. This is only for external MCP approval_required results; Hermes frontend approvals use their own bridge.",
            {
                "approval_id": {
                    "type": "string",
                    "description": "approval_id returned by a previous approval_required MCP canvas write.",
                },
                "approvalId": {
                    "type": "string",
                    "description": "Alias of approval_id.",
                },
            },
            ["approval_id"],
        ),
        _handle_confirm_canvas_action,
    ),
    (
        "freezone_cancel_canvas_action",
        _schema(
            "freezone_cancel_canvas_action",
            "Cancel a pending MCP canvas action when the user rejects or abandons the approval request.",
            {
                "approval_id": {
                    "type": "string",
                    "description": "approval_id returned by a previous approval_required MCP canvas write.",
                },
                "approvalId": {
                    "type": "string",
                    "description": "Alias of approval_id.",
                },
            },
            ["approval_id"],
        ),
        _handle_cancel_canvas_action,
    ),
    # 单步写入工具：只用于用户明确要求 exactly one 的节点、连线、编辑或动作。
    (
        "freezone_create_node",
        _schema(
            "freezone_create_node",
            "Single-operation tool only: create exactly one standalone Freezone canvas node when the user explicitly asks for one node. If the user asks to create these nodes, several nodes, a workflow, storyboard, prototype, framework, page, short-video plan, or any request with more than one canvas change, do not use this repeatedly; use one freezone_emit_canvas_command batch instead. For dynamic fields, inspect freezone_get_node_create_schema first.",
            {
                **_SCOPE_PROPS,
                "node_type": _NODE_TYPE_SCHEMA,
                "nodeType": _NODE_TYPE_ALIAS_SCHEMA,
                "data": {
                    "type": "object",
                    "description": "Node data. Prefer stable fields such as prompt, title, content, text, displayName.",
                },
                "position": {
                    "type": "object",
                    "description": 'Optional canvas position, e.g. {"x": 300, "y": 120}.',
                },
                "x": {"type": "number", "description": "Optional canvas x position."},
                "y": {"type": "number", "description": "Optional canvas y position."},
            },
            ["node_type"],
        ),
        _handle_create_node,
    ),
    (
        "freezone_add_next_node",
        _schema(
            "freezone_add_next_node",
            "Single-operation tool only: create exactly one downstream node behind one existing source node. Use only when the user explicitly asks for one downstream node and the source node is a valid input source. For several downstream nodes, workflows, prototypes, storyboards, or create+link/layout requests, use one freezone_emit_canvas_command batch instead.",
            {
                **_SCOPE_PROPS,
                "source_node_id": {
                    "type": "string",
                    "description": "Existing source canvas node id.",
                },
                "sourceNodeId": {
                    "type": "string",
                    "description": "Alias of source_node_id.",
                },
                "node_type": _NODE_TYPE_SCHEMA,
                "nodeType": _NODE_TYPE_ALIAS_SCHEMA,
                "data": {"type": "object", "description": "New node data."},
                "connect": {
                    "type": "boolean",
                    "description": "Whether to auto-connect source to the new node. Defaults to true.",
                },
            },
            ["source_node_id", "node_type"],
        ),
        _handle_add_next_node,
    ),
    (
        "freezone_update_node_data",
        _schema(
            "freezone_update_node_data",
            "Single-operation tool only: update editable data fields on exactly one existing Freezone node when the user explicitly asks for one node edit. For multi-node edits or mixed edit+layout/link workflows, use one freezone_emit_canvas_command batch. Inspect freezone_get_node_detail first when editable parameters or enum options are unclear.",
            {
                **_SCOPE_PROPS,
                "node_id": {
                    "type": "string",
                    "description": "Existing canvas node id.",
                },
                "data": {
                    "type": "object",
                    "minProperties": 1,
                    "description": "Only fields to change. Do not include reserved or non-editable fields.",
                },
            },
            ["node_id", "data"],
            reject_unknown=True,
        ),
        _handle_update_node_data,
    ),
    (
        "freezone_create_edge",
        _schema(
            "freezone_create_edge",
            "Single-operation tool only: create exactly one semantic edge between two existing Freezone nodes when the user explicitly asks for one edge. For multiple edges, create+edge workflows, or newly created nodes that need same-batch client_id references, use one freezone_emit_canvas_command batch. Call freezone_get_link_type_catalog first unless the valid link_type for this source/target pair is already known. If validation says no link_type is valid, do not retry other link_type values; group related nodes instead.",
            {
                **_SCOPE_PROPS,
                "source": {"type": "string", "description": "Source node id."},
                "target": {"type": "string", "description": "Target node id."},
                "link_type": {
                    "type": "string",
                    "enum": _LINK_TYPE_VALUES,
                    "description": "Semantic relation. Required; do not use role, link_kind, semantic_kind, semantic_reason, or semantic_description.",
                },
                "linkType": {"type": "string", "description": "Alias of link_type."},
            },
            ["source", "target", "link_type"],
        ),
        _handle_create_edge,
    ),
    (
        "freezone_delete_nodes",
        _schema(
            "freezone_delete_nodes",
            "Single-operation tool only: delete nodes as one pure delete operation. When the user asks to delete every node or clear the canvas, pass scope=canvas and omit node_ids; do not inspect or read nodes first. For selected nodes, pass node_ids. For mixed delete/update/layout/link workflows, use one freezone_emit_canvas_command batch. Use this for node deletion, not for disconnecting edges.",
            {
                **_SCOPE_PROPS,
                "scope": {
                    "type": "string",
                    "enum": ["canvas"],
                    "description": "Use canvas to delete every node without listing node ids.",
                },
                "node_ids": {
                    "type": "array",
                    "description": "Existing node ids to delete.",
                    "items": {"type": "string"},
                },
                "nodeIds": {
                    "type": "array",
                    "description": "Alias of node_ids.",
                    "items": {"type": "string"},
                },
            },
            [],
        ),
        _handle_delete_nodes,
    ),
    (
        "freezone_delete_edges",
        _schema(
            "freezone_delete_edges",
            "Single-operation tool only: disconnect edges as one pure edge-delete operation. For mixed workflows, use one freezone_emit_canvas_command batch. Use edge_ids when known, or pairs when only source/target nodes are known.",
            {
                **_SCOPE_PROPS,
                "edge_ids": {
                    "type": "array",
                    "description": "Existing edge ids to delete.",
                    "items": {"type": "string"},
                },
                "edgeIds": {
                    "type": "array",
                    "description": "Alias of edge_ids.",
                    "items": {"type": "string"},
                },
                "pairs": {
                    "type": "array",
                    "description": 'Source/target pairs, e.g. [{"source":"node_a","target":"node_b"}].',
                    "items": {"type": "object"},
                },
            },
        ),
        _handle_delete_edges,
    ),
    (
        "freezone_move_nodes",
        _schema(
            "freezone_move_nodes",
            "Single-operation tool only: move Freezone canvas nodes as one pure move operation. For mixed create/link/layout/move workflows, use one freezone_emit_canvas_command batch. Use positions for absolute placement, or node_ids plus dx/dy for relative movement.",
            {
                **_SCOPE_PROPS,
                "positions": {
                    "type": "object",
                    "description": 'Absolute positions keyed by node id/client_id, e.g. {"node_a":{"x":300,"y":120}}.',
                },
                "node_ids": {
                    "type": "array",
                    "description": "Node ids for relative movement.",
                    "items": {"type": "string"},
                },
                "nodeIds": {
                    "type": "array",
                    "description": "Alias of node_ids.",
                    "items": {"type": "string"},
                },
                "dx": {"type": "number", "description": "Relative x delta."},
                "dy": {"type": "number", "description": "Relative y delta."},
            },
        ),
        _handle_move_nodes,
    ),
    (
        "freezone_layout_nodes",
        _schema(
            "freezone_layout_nodes",
            "Single-operation tool only: auto-layout selected Freezone nodes, or the whole canvas when node_ids is omitted or empty. For create/link/layout workflows, use one freezone_emit_canvas_command batch.",
            {
                **_SCOPE_PROPS,
                "mode": {
                    "type": "string",
                    "enum": ["horizontal", "vertical", "grid"],
                    "description": "Layout mode.",
                },
                "node_ids": {
                    "type": "array",
                    "description": "Optional node ids to layout.",
                    "items": {"type": "string"},
                },
                "nodeIds": {
                    "type": "array",
                    "description": "Alias of node_ids.",
                    "items": {"type": "string"},
                },
            },
            ["mode"],
        ),
        _handle_layout_nodes,
    ),
    (
        "freezone_group_nodes",
        _schema(
            "freezone_group_nodes",
            "Single-operation tool only: create a plain visual group around related nodes as one pure grouping operation. This does not replace valid semantic edges, but it is the preferred fallback when no valid link_type exists. For mixed workflows, use one freezone_emit_canvas_command batch.",
            {
                **_SCOPE_PROPS,
                "node_ids": {
                    "type": "array",
                    "description": "At least two node ids/client_ids to group.",
                    "items": {"type": "string"},
                },
                "nodeIds": {
                    "type": "array",
                    "description": "Alias of node_ids.",
                    "items": {"type": "string"},
                },
                "label": {"type": "string", "description": "Optional group label."},
            },
            ["node_ids"],
        ),
        _handle_group_nodes,
    ),
    (
        "freezone_select_nodes",
        _schema(
            "freezone_select_nodes",
            "Single-operation tool only: select or focus nodes as one pure selection operation. For mixed workflows, use one freezone_emit_canvas_command batch.",
            {
                **_SCOPE_PROPS,
                "node_ids": {
                    "type": "array",
                    "description": "Node ids/client_ids to select.",
                    "items": {"type": "string"},
                },
                "nodeIds": {
                    "type": "array",
                    "description": "Alias of node_ids.",
                    "items": {"type": "string"},
                },
                "focus": {
                    "type": "boolean",
                    "description": "Whether to focus the selected node(s).",
                },
            },
            ["node_ids"],
        ),
        _handle_select_nodes,
    ),
    (
        "freezone_open_mainline_projection",
        _schema(
            "freezone_open_mainline_projection",
            "Mainline -> canvas only. Open/map/project a mainline episode, beat, or asset into the user's personal Freezone canvas. This mirrors the frontend 虾画/虾画编辑 toolbar button: the frontend asks the user to confirm, then opens the projected canvas. Use this when the user asks to open/map mainline content into 虾画/Freezone; do not use slot-candidate tools for this direction, and do not use this tool to submit canvas nodes back to the mainline. If the user asks to map a category such as 人物/身份/肖像/场景/道具 but does not provide an exact asset name/id, first call freezone_get_mainline_projection_assets for that category, using asset_kind=character for all people/identity/portrait requests, then pass the selected candidate's projection_request to this tool.",
            {
                **_SCOPE_PROPS,
                "scope": {
                    "type": "string",
                    "enum": _MAINLINE_PROJECTION_SCOPE_VALUES,
                    "description": "Mainline projection scope: episode, beat, or asset.",
                },
                "episode": {
                    "type": "integer",
                    "description": "Episode number. Required for episode and beat scopes.",
                },
                "beat": {
                    "type": "integer",
                    "description": "Beat number. Required for beat scope.",
                },
                "primary_slot": {
                    "type": "string",
                    "enum": _MAINLINE_PRIMARY_SLOT_VALUES,
                    "description": "For beat scope: sketch for 草图, frame for 分镜, render for default/render.",
                },
                "primarySlot": {
                    "type": "string",
                    "description": "Alias of primary_slot.",
                },
                "asset_kind": {
                    "type": "string",
                    "enum": _MAINLINE_ASSET_KIND_VALUES,
                    "description": "Asset kind for asset scope.",
                },
                "assetKind": {"type": "string", "description": "Alias of asset_kind."},
                "character": {
                    "type": "string",
                    "description": "Character name for character assets.",
                },
                "identity_id": {
                    "type": "string",
                    "description": "Legacy alias accepted by older character projection requests; prefer character-only asset projections.",
                },
                "identityId": {
                    "type": "string",
                    "description": "Alias of identity_id.",
                },
                "asset_id": {
                    "type": "string",
                    "description": "Scene or prop id for scene/prop assets.",
                },
                "assetId": {"type": "string", "description": "Alias of asset_id."},
                "request": {
                    "type": "object",
                    "description": "Optional raw projection request object. Top-level fields are preferred.",
                },
            },
            ["scope"],
        ),
        _handle_open_mainline_projection,
    ),
    (
        "freezone_run_workflow",
        _schema(
            "freezone_run_workflow",
            "Run, continue, retry, or locally regenerate a canvas workflow through the deterministic DAG runner. The runner expands dependencies, skips completed outputs by default, executes independent nodes in parallel, persists status, and blocks failed descendants without Agent polling. For nodes marked workflowConfigConfirmed=true, reuse the already approved model, size, duration, quality, voice, and composition fields; do not ask the user to choose them again. Ask again only when a required field is missing, the user changed it, or the provider rejects it. Use this directly for continue/resume requests instead of reading and running nodes one by one. If it reports content_policy, stop: do not infer sensitive words, rewrite prompts, or retry unless the user explicitly requests one specific prompt edit.",
            {
                **_SCOPE_PROPS,
                "node_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional start node ids. Required unless scope=canvas.",
                },
                "scope": {
                    "type": "string",
                    "enum": ["selection", "canvas"],
                    "description": "Use canvas to continue all unfinished workflow nodes.",
                },
                "direction": {
                    "type": "string",
                    "enum": ["connected", "node", "downstream"],
                    "description": "Use downstream for local reruns, node for one-node retry, connected for a selected workflow.",
                },
                "regenerate": {
                    "type": "boolean",
                    "description": "False/omitted skips completed outputs. Set true only for explicit regeneration.",
                },
            },
        ),
        _handle_run_workflow,
    ),
    (
        "freezone_run_node_action",
        _schema(
            "freezone_run_node_action",
            "Single-operation tool only: run or open exactly one frontend node action listed by node_detail action_summary. If the node has workflowConfigConfirmed=true, reuse its persisted generation parameters and do not ask the user to choose them again unless a required field is missing or the user changed it. For non-default action parameters, inspect freezone_get_node_action_catalog with the specific action first. For multiple actions or mixed workflows, use one freezone_emit_canvas_command batch.",
            {
                **_SCOPE_PROPS,
                "node_id": {
                    "type": "string",
                    "description": "Existing canvas node id.",
                },
                "nodeId": {"type": "string", "description": "Alias of node_id."},
                "action": {
                    "type": "string",
                    "description": "Exact action id from the node action catalog.",
                },
                "parameters": {
                    "type": "object",
                    "description": "Optional parameters for actions whose action_catalog exposes parameter_schema. For generation actions, omit regenerate unless the user explicitly asks to regenerate/overwrite existing output.",
                },
                "params": {"type": "object", "description": "Alias of parameters."},
                "regenerate": {
                    "type": "boolean",
                    "description": "Set true only when the user explicitly asks to regenerate/overwrite this node. Normal continue/complete requests skip nodes that already have output.",
                },
                "force_regenerate": {
                    "type": "boolean",
                    "description": "Alias of regenerate.",
                },
            },
            ["node_id", "action"],
        ),
        _handle_run_node_action,
    ),
)


def register(ctx) -> None:
    for name, schema, handler in TOOLS:
        for toolset in REGISTER_TOOLSETS:
            ctx.register_tool(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=handler,
                check_fn=_available,
                requires_env=["DRAMACLAW_API_URL", "DRAMACLAW_AGENT_TOKEN"],
                description=schema["description"],
                emoji="",
            )
