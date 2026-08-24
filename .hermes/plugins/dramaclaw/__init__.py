"""DramaClaw API toolset for Hermes.

This plugin intentionally avoids terminal/shell/subprocess access. It uses
Python's stdlib HTTP client and the DramaClaw agent environment injected by
``novelvideo.chat.hermes_pool``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

from tools.registry import tool_error, tool_result

TOOLSET = "dramaclaw"
ACP_TOOLSET = "hermes-acp"
REGISTER_TOOLSETS = (ACP_TOOLSET,)
API_PREFIX = "/api/v1/"
try:
    DEFAULT_TIMEOUT_SECONDS = max(30, int(os.environ.get("DRAMACLAW_API_TIMEOUT_SECONDS", "120")))
except ValueError:
    DEFAULT_TIMEOUT_SECONDS = 120
SCRIPT_UPLOAD_EXTENSIONS = {".txt", ".md", ".doc", ".docx"}
INGEST_PATH_ERROR = (
    "invalid ingest API path: use /projects/{project}/ingest/upload or "
    "/projects/{project}/ingest/start; ingest_fast is a task_type, not an endpoint; "
    "do not infer /ingest/init, /ingest/setup, /ingest_script, or /ingest_fast."
)
TEXT_CONTENT_FILTER_CHAT_ERROR = (
    "模型内容安全过滤拦截了本次文本生成，请调整原文或改写稿中的敏感描述后重试。"
)
VOICE_PREREQ_CHAT_PREFIX = (
    "配音任务没有成功启动：当前缺少声线前置。请到「虾塘」上传或录制缺失的"
    "项目解说人声线/角色声线后，再回来继续生成配音。"
)
RENDER_PREREQ_CHAT_PREFIX = (
    "Render 任务没有生成可用图片：当前缺少必要草图前置。请先在「虾塘」生成或确认对应 "
    "Beat 的草图后，再重新生成 Render。"
)


def _has_text_content_filter(value: Any) -> bool:
    if isinstance(value, str):
        lowered = value.lower()
        return "content_filter" in lowered or "content filter triggered" in lowered
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() == "finish_reason" and str(item).lower() == "content_filter":
                return True
            if _has_text_content_filter(item):
                return True
        return False
    if isinstance(value, list):
        return any(_has_text_content_filter(item) for item in value)
    return False


def _voice_prereq_error_text(value: Any) -> str:
    if isinstance(value, str):
        text = value.strip()
        if "voice_prereq_required" in text or "声线缺失" in text:
            return text[:1200]
        return ""
    if isinstance(value, dict):
        code = str(value.get("code") or "").strip()
        error = str(value.get("error") or value.get("detail") or value.get("message") or "").strip()
        if code == "voice_prereq_required":
            return error[:1200] if error else "voice_prereq_required"
        if "声线缺失" in error:
            return error[:1200]
        for item in value.values():
            found = _voice_prereq_error_text(item)
            if found:
                return found
        return ""
    if isinstance(value, list):
        for item in value:
            found = _voice_prereq_error_text(item)
            if found:
                return found
    return ""


def _render_prereq_error_text(value: Any) -> str:
    if isinstance(value, str):
        text = value.strip()
        if "Render 模式需要草图" in text or "未生成可用图片" in text:
            return text[:1200]
        return ""
    if isinstance(value, dict):
        error = str(value.get("error") or value.get("detail") or value.get("message") or "").strip()
        if "Render 模式需要草图" in error or "未生成可用图片" in error:
            return error[:1200]
        for item in value.values():
            found = _render_prereq_error_text(item)
            if found:
                return found
        return ""
    if isinstance(value, list):
        for item in value:
            found = _render_prereq_error_text(item)
            if found:
                return found
    return ""


def _with_chat_error_hints(value: Any) -> Any:
    if isinstance(value, list):
        return [_with_chat_error_hints(item) for item in value]
    if not isinstance(value, dict):
        return value

    result = {key: _with_chat_error_hints(item) for key, item in value.items()}
    voice_error = _voice_prereq_error_text(value)
    if voice_error:
        result.setdefault(
            "chat_error",
            f"{VOICE_PREREQ_CHAT_PREFIX}\n\n缺失项：{voice_error}",
        )
        result.setdefault(
            "agent_instruction",
            (
                "Reply to the user with chat_error in the user's UI language "
                "(default English). Make clear the audio task "
                "was not started. Tell the user they can go to Freezone (虾塘) to upload or record the missing "
                "voice lines, then continue. Do not start another tool in this turn."
            ),
        )
    render_error = _render_prereq_error_text(value)
    if render_error:
        result.setdefault(
            "chat_error",
            f"{RENDER_PREREQ_CHAT_PREFIX}\n\n错误原因：{render_error}",
        )
        result.setdefault(
            "agent_instruction",
            (
                "Reply to the user with chat_error in the user's UI language "
                "(default English). Make clear the render "
                "task did not produce usable images because sketches are missing. Tell the user "
                "to generate or verify sketches in Freezone (虾塘) before retrying render. Do not start "
                "another tool in this turn."
            ),
        )
    if _has_text_content_filter(value):
        result.setdefault("chat_error", TEXT_CONTENT_FILTER_CHAT_ERROR)
        result.setdefault(
            "agent_instruction",
            (
                "Reply to the user with chat_error in the user's UI language "
                "(default English). Do not quote the raw "
                "provider JSON or provider_response_id."
            ),
        )
    return result


def _ce_owner_mode() -> bool:
    """CE single-user mode: authenticate as the local owner without a token.

    A DramaClaw CE instance trusts local requests as the owner (no
    ``Authorization`` header required), so an external MCP client such as
    Claude Code can call the API on the same machine without minting an
    agent-session token. This is opt-in via ``DRAMACLAW_CE_OWNER`` so it can
    never silently drop auth against an EE deployment.
    """
    raw = os.environ.get("DRAMACLAW_CE_OWNER", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


# Hosts trusted as the local CE owner in tokenless owner mode. ``urlparse``
# lowercases the hostname and strips the brackets from ``[::1]``, so the bare
# forms below cover the bracketed IPv6 literal too.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _ce_owner_allow_remote() -> bool:
    """Explicit, separately-named unsafe override for CE-owner mode.

    Tokenless CE-owner mode drops the ``Authorization`` header entirely, so it
    must only target a local CE the caller controls. Pointing it at a remote
    host would send owner-level, unauthenticated requests across the network;
    that is refused unless the operator opts in via
    ``DRAMACLAW_CE_OWNER_ALLOW_REMOTE`` (deliberately a different variable from
    ``DRAMACLAW_CE_OWNER`` so it cannot be enabled by accident).
    """
    raw = os.environ.get("DRAMACLAW_CE_OWNER_ALLOW_REMOTE", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _enforce_ce_owner_target(url: str) -> None:
    """Require a loopback ``DRAMACLAW_API_URL`` in tokenless CE-owner mode.

    Called only when owner mode is active and no bearer token is present. The
    host must be a loopback address (``localhost``/``127.0.0.1``/``::1``/
    ``[::1]``) unless the operator has set the explicit unsafe override
    ``DRAMACLAW_CE_OWNER_ALLOW_REMOTE=1``.
    """
    if _ce_owner_allow_remote():
        return
    host = (urlparse(url).hostname or "").strip().lower()
    if host in _LOOPBACK_HOSTS:
        return
    raise ValueError(
        "DRAMACLAW_CE_OWNER=1 refuses non-loopback DRAMACLAW_API_URL "
        f"(host {host!r}): tokenless owner mode sends unauthenticated, "
        "owner-level requests and must point at a local CE "
        "(localhost, 127.0.0.1, ::1). Set DRAMACLAW_CE_OWNER_ALLOW_REMOTE=1 "
        "to override (unsafe), or provide DRAMACLAW_AGENT_TOKEN."
    )


def _available() -> bool:
    if not os.environ.get("DRAMACLAW_API_URL"):
        return False
    return bool(os.environ.get("DRAMACLAW_AGENT_TOKEN")) or _ce_owner_mode()


def _base_url() -> str:
    value = os.environ.get("DRAMACLAW_API_URL", "").strip()
    if not value:
        raise ValueError("DRAMACLAW_API_URL is not set")
    return value.rstrip("/")


def _token() -> str:
    value = os.environ.get("DRAMACLAW_AGENT_TOKEN", "").strip()
    if not value:
        raise ValueError("DRAMACLAW_AGENT_TOKEN is not set")
    return value


def _default_project_id() -> str:
    return os.environ.get("DRAMACLAW_PROJECT_ID", "").strip()


def _project_output_dir() -> Path | None:
    value = (
        os.environ.get("DRAMACLAW_PROJECT_OUTPUT_DIR")
        or os.environ.get("SUPERTALE_PROJECT_OUTPUT_DIR")
        or ""
    ).strip()
    return Path(value) if value else None


def _project_static_url(project: str, rel_path: str, local_path: Path | None = None) -> str:
    rel = quote(str(rel_path).lstrip("/"), safe="/")
    base = f"/static/projects/{quote(str(project), safe='')}/{rel}"
    if local_path is not None and local_path.exists():
        return f"{base}?v={local_path.stat().st_mtime_ns}"
    return base


def _normalize_api_path(path: str) -> str:
    raw = str(path or "").strip()
    if not raw:
        raise ValueError("path is required")
    if raw.startswith("http://") or raw.startswith("https://") or raw.startswith("//"):
        raise ValueError("absolute URLs are not allowed; pass a DramaClaw API path")
    if not raw.startswith("/"):
        raw = f"/{raw}"
    if raw.startswith("/projects/"):
        raw = f"/api/v1{raw}"
    if not raw.startswith(API_PREFIX):
        raise ValueError("path must start with /api/v1/ or /projects/")
    if any(part == ".." for part in raw.split("/")):
        raise ValueError("path traversal is not allowed")
    _validate_ingest_api_path(raw)
    return raw


def _validate_ingest_api_path(path: str) -> None:
    parts = [part for part in path.strip("/").split("/") if part]
    if len(parts) < 3 or parts[:2] != ["api", "v1"]:
        return

    route = parts[2:]
    if route and route[0] in {"ingest", "ingest_fast", "ingest_script"}:
        raise ValueError(INGEST_PATH_ERROR)

    if len(route) < 3 or route[0] != "projects":
        return

    project_route = route[2:]
    if not project_route:
        return

    first = project_route[0]
    if first in {"ingest_fast", "ingest_script"}:
        raise ValueError(INGEST_PATH_ERROR)
    if first != "ingest":
        return
    if project_route not in (["ingest", "upload"], ["ingest", "start"]):
        raise ValueError(INGEST_PATH_ERROR)


def _query_string(params: Any) -> str:
    if not isinstance(params, dict) or not params:
        return ""
    cleaned: dict[str, Any] = {}
    for key, value in params.items():
        if value is None or value == "":
            continue
        cleaned[str(key)] = value
    return f"?{urlencode(cleaned, doseq=True)}" if cleaned else ""


def _request(method: str, path: str, *, query: Any = None, body: Any = None) -> dict[str, Any]:
    api_path = _normalize_api_path(path)
    url = f"{_base_url()}{api_path}{_query_string(query)}"
    payload = None
    headers = {
        "Accept": "application/json",
        "User-Agent": "dramaclaw-plugin/0.1.0",
    }
    token = os.environ.get("DRAMACLAW_AGENT_TOKEN", "").strip()
    if not token:
        if not _ce_owner_mode():
            _token()  # raise the standard "DRAMACLAW_AGENT_TOKEN is not set" error
        # Tokenless owner mode drops Authorization entirely, so it must only
        # ever target a loopback CE unless explicitly overridden.
        _enforce_ce_owner_target(_base_url())
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = Request(url, data=payload, headers=headers, method=method.upper())
    try:
        with urlopen(req, timeout=DEFAULT_TIMEOUT_SECONDS) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            return _with_chat_error_hints(_decode_response(resp.status, text))
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return _with_chat_error_hints({
            "ok": False,
            "status_code": exc.code,
            "error": _response_error_text(text) or exc.reason,
            "data": _maybe_json(text),
        })
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


def _project_from_args(args: dict[str, Any]) -> str:
    project = str(args.get("project_id") or args.get("project") or _default_project_id()).strip()
    if not project:
        raise ValueError("project_id is required and DRAMACLAW_PROJECT_ID is not set")
    return project


def _limit_items(items: list[dict[str, Any]], args: dict[str, Any], default: int) -> list[dict[str, Any]]:
    raw = args.get("limit")
    try:
        limit = int(raw) if raw is not None else default
    except (TypeError, ValueError):
        limit = default
    limit = max(1, min(limit, default))
    try:
        offset = int(args.get("offset") or 0)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, offset)
    return items[offset : offset + limit]


def _requested_beats(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("beat_indices") or args.get("beats")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("beat", "beat_num", "beat_number", "index"):
        if args.get(key) is not None:
            values.append(args[key])
    beats: set[int] = set()
    for value in values:
        try:
            beat = int(value)
        except (TypeError, ValueError):
            continue
        if beat > 0:
            beats.add(beat)
    return beats or None


def _requested_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "character"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_queries(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("queries") or args.get("keywords")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("query", "search", "keyword", "text", "identity_name"):
        if args.get(key) is not None:
            values.append(args[key])
    queries = {str(value).strip() for value in values if str(value or "").strip()}
    return queries or None


def _requested_scene_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names") or args.get("scene_names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "scene_name"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_scene_indices(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("scene_indices") or args.get("indices")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    if args.get("index") is not None:
        values.append(args["index"])
    indices: set[int] = set()
    for value in values:
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if index > 0:
            indices.add(index)
    return indices or None


def _matches_any_scene_name(scene_name: str, requested_names: set[str] | None) -> bool:
    if requested_names is None:
        return True
    haystack = str(scene_name or "").casefold()
    return any(needle.casefold() in haystack for needle in requested_names if needle)


def _matches_any_text(fields: list[Any], queries: set[str] | None) -> bool:
    if queries is None:
        return True
    haystack = "\n".join(_flatten_text_fields(fields)).casefold()
    return any(query.casefold() in haystack for query in queries if query)


def _flatten_text_fields(fields: list[Any]) -> list[str]:
    values: list[str] = []
    for field in fields:
        if isinstance(field, dict):
            values.extend(_flatten_text_fields(list(field.values())))
        elif isinstance(field, list):
            values.extend(_flatten_text_fields(field))
        elif field is not None:
            text = str(field).strip()
            if text:
                values.append(text)
    return values


def _media_ui_spec(spec_type: str, component_type: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    elements: dict[str, Any] = {
        "root": {
            "type": "Stack",
            "props": {
                "direction": "row",
                "wrap": "wrap",
                "spacing": 16,
                "alignItems": "flex-start",
                "width": "100%",
            },
            "children": [],
        }
    }
    for index, item in enumerate(items, start=1):
        src = str(item.get("src") or item.get("url") or "").strip()
        if not src:
            continue
        key = f"media_{index}"
        title = str(item.get("title") or item.get("label") or f"媒体 {index}").strip()
        description = str(item.get("description") or "").strip()
        props: dict[str, Any] = {
            "src": src,
            "alt": title,
            "title": title,
        }
        if description:
            props["description"] = description
        if component_type == "Image":
            props.update(
                {
                    "fit": item.get("fit") or "cover",
                    "aspectRatio": item.get("aspectRatio") or "3/4",
                    "overlayTitle": title,
                }
            )
            if description:
                props["overlayDescription"] = description
        elif component_type == "Video":
            props["poster"] = str(item.get("poster") or item.get("thumbnail") or "").strip()
            props["controls"] = True
        elif component_type == "Audio":
            props["controls"] = True

        elements[key] = {"type": component_type, "props": props, "children": []}
        elements["root"]["children"].append(key)
    return {"type": spec_type, "root": "root", "elements": elements}


def _image_ui_spec(spec_type: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    return _media_ui_spec(spec_type, "Image", items)


def _video_ui_spec(items: list[dict[str, Any]]) -> dict[str, Any]:
    return _media_ui_spec("keyframe_video", "Video", items)


def _audio_ui_spec(items: list[dict[str, Any]]) -> dict[str, Any]:
    return _media_ui_spec("audio_list", "Audio", items)


def _handle_get(args: dict[str, Any], **_: Any) -> str:
    try:
        return tool_result(_request("GET", str(args.get("path") or ""), query=args.get("query")))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_post(args: dict[str, Any], **_: Any) -> str:
    try:
        return tool_result(_request("POST", str(args.get("path") or ""), query=args.get("query"), body=args.get("body")))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_patch(args: dict[str, Any], **_: Any) -> str:
    try:
        return tool_result(_request("PATCH", str(args.get("path") or ""), query=args.get("query"), body=args.get("body")))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_delete(args: dict[str, Any], **_: Any) -> str:
    try:
        return tool_result(_request("DELETE", str(args.get("path") or ""), query=args.get("query"), body=args.get("body")))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_pipeline_status(args: dict[str, Any], **_: Any) -> str:
    try:
        project = _project_from_args(args)
        query = {"episode": args.get("episode")}
        return tool_result(_request("GET", f"/api/v1/projects/{project}/pipeline/status", query=query))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_list_tasks(args: dict[str, Any], **_: Any) -> str:
    try:
        project = _project_from_args(args)
        query = {
            "episode": args.get("episode"),
            "task_type": args.get("task_type"),
            "status": args.get("status"),
        }
        return tool_result(_request("GET", f"/api/v1/projects/{project}/tasks", query=query))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_get_task(args: dict[str, Any], **_: Any) -> str:
    try:
        project = _project_from_args(args)
        task_type = str(args.get("task_type") or "").strip()
        episode = int(args.get("episode") or 0)
        if not task_type:
            raise ValueError("task_type is required")
        query = {
            "beat_num": args.get("beat_num") or args.get("beat"),
            "scope": args.get("scope"),
        }
        return tool_result(_request("GET", f"/api/v1/projects/{project}/tasks/{task_type}/{episode}", query=query))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_get_episode_script(args: dict[str, Any], **_: Any) -> str:
    try:
        project = _project_from_args(args)
        episode = int(args.get("episode") or 1)
        return tool_result(_request("GET", f"/api/v1/projects/{project}/episodes/{episode}/script"))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_list_ingest_uploads(args: dict[str, Any], **_: Any) -> str:
    """List project files already uploaded to the local ingest script directory."""
    try:
        project = _project_from_args(args)
        current_project = _default_project_id()
        if current_project and project != current_project:
            raise ValueError("can only list uploads for the current Hermes project scope")

        project_dir_raw = os.environ.get("DRAMACLAW_PROJECT_OUTPUT_DIR", "").strip()
        if not project_dir_raw:
            project_dir_raw = os.environ.get("SUPERTALE_PROJECT_OUTPUT_DIR", "").strip()
        if not project_dir_raw:
            return tool_result(
                {
                    "ok": True,
                    "data": {
                        "project_id": project,
                        "count": 0,
                        "files": [],
                        "upload_dir_available": False,
                        "message": "project upload directory is not available in this Hermes session",
                    },
                }
            )

        project_dir = Path(project_dir_raw).expanduser().resolve()
        upload_dir = (project_dir / "uploads").resolve()
        if not upload_dir.is_relative_to(project_dir):
            raise ValueError("invalid upload directory")
        if not upload_dir.exists():
            return tool_result(
                {
                    "ok": True,
                    "data": {
                        "project_id": project,
                        "count": 0,
                        "files": [],
                        "upload_dir_available": True,
                    },
                }
            )

        files = []
        for path in upload_dir.iterdir():
            if not path.is_file() or path.name.startswith("."):
                continue
            suffix = path.suffix.lower()
            if suffix not in SCRIPT_UPLOAD_EXTENSIONS:
                continue
            stat = path.stat()
            files.append(
                {
                    "filename": path.name,
                    "size": stat.st_size,
                    "modified_at": int(stat.st_mtime),
                    "extension": suffix,
                }
            )
        files.sort(key=lambda item: (item["modified_at"], item["filename"]), reverse=True)
        return tool_result(
            {
                "ok": True,
                "data": {
                    "project_id": project,
                    "count": len(files),
                    "files": files,
                    "upload_dir_available": True,
                },
            }
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_build_characters(args: dict[str, Any], **_: Any) -> str:
    """Trigger character extraction from the project's knowledge graph.

    Wraps POST /projects/{project}/characters/build (the async ``build_characters``
    task at episode 0) so the agent never has to guess the path. Requires ingest
    to be complete. Poll progress with
    ``dramaclaw_get_task(task_type="build_characters", episode=0)`` and read
    results with ``dramaclaw_get(path="/projects/{project}/characters")``.
    """
    try:
        project = _project_from_args(args)
        return tool_result(
            _request("POST", f"/api/v1/projects/{project}/characters/build")
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_plan_episodes(args: dict[str, Any], **_: Any) -> str:
    """Plan/generate episodes (分集规划) from the ingested story + characters.

    Wraps POST /projects/{project}/episodes/plan (the async ``build_episodes``
    task at episode 0) so the agent never has to guess the path. Requires ingest
    + character extraction to be complete. Poll with
    ``dramaclaw_get_task(task_type="build_episodes", episode=0)`` and read results
    with ``dramaclaw_get(path="/projects/{project}/episodes")``.
    """
    try:
        project = _project_from_args(args)
        body: dict[str, Any] = {}
        if args.get("target_episodes") is not None:
            body["target_episodes"] = int(args["target_episodes"])
        if args.get("planning_mode"):
            body["planning_mode"] = str(args["planning_mode"])
        return tool_result(
            _request("POST", f"/api/v1/projects/{project}/episodes/plan", body=body)
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_generate_script(args: dict[str, Any], **_: Any) -> str:
    """Generate the screenplay for one episode (脚本生成, script_writer task).

    Wraps POST /projects/{project}/episodes/{episode}/script/generate. Requires
    the episode's character identities to be planned first; if not, the API
    returns {"ok": false, "code": "identity_plan_required"} — plan identities
    before retrying. Poll with dramaclaw_get_task(task_type="script_writer",
    episode=N); read with dramaclaw_get_episode_script(episode=N).
    """
    try:
        project = _project_from_args(args)
        episode = int(args.get("episode") or 0)
        if episode <= 0:
            raise ValueError("episode is required and must be a positive integer")
        return tool_result(
            _request(
                "POST",
                f"/api/v1/projects/{project}/episodes/{episode}/script/generate",
            )
        )
    except Exception as exc:
        return tool_error(str(exc))


def _require_episode(args: dict[str, Any]) -> int:
    episode = int(args.get("episode") or 0)
    if episode <= 0:
        raise ValueError("episode is required and must be a positive integer")
    return episode


def _require_name(args: dict[str, Any]) -> str:
    name = str(args.get("name") or args.get("character") or "").strip()
    if not name:
        raise ValueError("name (character name) is required")
    return name


def _handle_update_character_face_prompt(args: dict[str, Any], **_: Any) -> str:
    """Update a character's face_prompt before portrait generation."""
    try:
        project = _project_from_args(args)
        name = _require_name(args)
        face_prompt = str(args.get("face_prompt") or "").strip()
        if not face_prompt:
            raise ValueError("face_prompt is required")
        return tool_result(
            _request(
                "PATCH",
                f"/api/v1/projects/{project}/characters/{quote(name, safe='')}",
                body={"face_prompt": face_prompt},
            )
        )
    except Exception as exc:
        return tool_error(str(exc))


def _episode_post(args: dict[str, Any], suffix: str, *, body: Any = None) -> dict[str, Any]:
    project = _project_from_args(args)
    episode = _require_episode(args)
    return _request("POST", f"/api/v1/projects/{project}/episodes/{episode}/{suffix}", body=body)


def _handle_plan_identities(args: dict[str, Any], **_: Any) -> str:
    """Plan character identities for one episode (身份规划, identity_planner task).

    POST /projects/{project}/episodes/{episode}/identities/plan-async. Prerequisite
    for dramaclaw_generate_script. Poll task_type="identity_planner", episode=N.
    """
    try:
        return tool_result(_episode_post(args, "identities/plan-async"))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_plan_scenes(args: dict[str, Any], **_: Any) -> str:
    """Plan an episode scene menu before sketch generation."""
    try:
        return tool_result(_episode_post(args, "scenes/plan"))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_plan_props(args: dict[str, Any], **_: Any) -> str:
    """Plan an episode prop menu before sketch generation."""
    try:
        return tool_result(_episode_post(args, "props/plan"))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_generate_scene_master(args: dict[str, Any], **_: Any) -> str:
    """Generate one scene's canonical master reference image."""
    try:
        project = _project_from_args(args)
        name = str(args.get("name") or args.get("scene_name") or "").strip()
        if not name:
            raise ValueError("name (scene name) is required")
        return tool_result(
            _request(
                "POST",
                f"/api/v1/projects/{project}/scenes/{quote(name, safe='')}/master/generate-async",
            )
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_generate_scene_reverse(args: dict[str, Any], **_: Any) -> str:
    """Generate one scene's reverse master reference image."""
    try:
        project = _project_from_args(args)
        name = str(args.get("name") or args.get("scene_name") or "").strip()
        if not name:
            raise ValueError("name (scene name) is required")
        return tool_result(
            _request(
                "POST",
                f"/api/v1/projects/{project}/scenes/{quote(name, safe='')}/reverse/generate-async",
            )
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_generate_sketches(args: dict[str, Any], **_: Any) -> str:
    """Generate beat sketches for one episode (草图生成, sketch_generation task).

    POST /projects/{project}/episodes/{episode}/sketches/assign-colors, then
    POST /projects/{project}/episodes/{episode}/sketches/generate with the
    canonical request body. Runs after the script exists. Poll
    task_type="sketch_generation", episode=N.
    """
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        body = {
            "model": "nanobanana",
            "grid_index": -1,
            "sketch_scene_grouping": True,
            "aspect_ratio": "2:3",
        }
        if isinstance(args.get("body"), dict):
            body.update({key: value for key, value in args["body"].items() if value is not None})
        for key in (
            "style",
            "model",
            "grid_index",
            "sketch_scene_grouping",
            "aspect_ratio",
            "image_generation_selection",
        ):
            if key in args and args[key] is not None:
                body[key] = args[key]

        if args.get("auto_assign_colors", True):
            colors = _request(
                "POST",
                f"/api/v1/projects/{project}/episodes/{episode}/sketches/assign-colors",
            )
            if not colors.get("ok"):
                return tool_result(
                    {
                        "ok": False,
                        "stage": "assign-colors",
                        "error": colors.get("error") or "assign-colors failed",
                        "data": colors,
                    }
                )

        result = _request(
            "POST",
            f"/api/v1/projects/{project}/episodes/{episode}/sketches/generate",
            body=body,
        )
        if isinstance(result, dict):
            result.setdefault("request_body", body)
        return tool_result(result)
    except Exception as exc:
        return tool_error(str(exc))


def _handle_detect_sketch_identities(args: dict[str, Any], **_: Any) -> str:
    """Run episode-wide sketch AI detection for identities and props."""
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        result = _request(
            "POST",
            f"/api/v1/projects/{project}/episodes/{episode}/sketches/detect-identities",
        )
        if isinstance(result, dict) and not result.get("ok"):
            error_text = str(result.get("error") or "").casefold()
            if "timed out" in error_text or "timeout" in error_text:
                result.setdefault("retryable", False)
                result.setdefault(
                    "agent_instruction",
                    "Stop retrying this tool in the same turn. Report that AI detection timed "
                    "out and ask the user to retry later or run it from the frontend.",
                )
        return tool_result(result)
    except Exception as exc:
        return tool_error(str(exc))


def _handle_optimize_video_global(args: dict[str, Any], **_: Any) -> str:
    """Run global video optimization for one episode (全局视频优化, global_optimize_video).

    POST /projects/{project}/episodes/{episode}/optimize/video-global.
    Poll task_type="global_optimize_video", episode=N.
    """
    try:
        return tool_result(_episode_post(args, "optimize/video-global"))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_generate_audio(args: dict[str, Any], **_: Any) -> str:
    """Generate episode audio via the current IndexTTS2 audio pipeline."""
    try:
        body: dict[str, Any] = {}
        for key in ("provider", "voice", "model", "rate", "mode", "beat_numbers"):
            if args.get(key) is not None:
                body[key] = args[key]
        return tool_result(_episode_post(args, "audio/generate", body=body))
    except Exception as exc:
        return tool_error(str(exc))


def _resolve_episode_beats(project: str, episode: int) -> list[int]:
    """Fetch the episode's beat numbers via GET /episodes/{ep}/beats."""
    resp = _request("GET", f"/api/v1/projects/{project}/episodes/{episode}/beats")
    items: Any = None
    if isinstance(resp, dict):
        for key in ("data", "beats", "items"):
            value = resp.get(key)
            if isinstance(value, list):
                items = value
                break
        if items is None and isinstance(resp.get("data"), dict):
            items = resp["data"].get("beats")
    return [
        int(b["beat_number"])
        for b in (items or [])
        if isinstance(b, dict) and b.get("beat_number") is not None
    ]


def _handle_get_sketches(args: dict[str, Any], **_: Any) -> str:
    """Get display-ready sketch URLs for an episode (to SHOW the user).

    Wraps GET /projects/{project}/episodes/{episode}/beats and returns, per beat,
    the servable ``sketch_url``. Use ``dramaclaw_get_first_frames`` for first frames.
    Do NOT read
    the local ``sketch_path`` from a task result, and do NOT use vision_analyze —
    that only lets the agent look at the image, it does NOT show it to the user.
    """
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        media_kind = "sketch"
        resp = _request("GET", f"/api/v1/projects/{project}/episodes/{episode}/beats")
        items: Any = None
        if isinstance(resp, dict):
            for key in ("data", "beats", "items"):
                value = resp.get(key)
                if isinstance(value, list):
                    items = value
                    break
            if items is None and isinstance(resp.get("data"), dict):
                items = resp["data"].get("beats")
        sketches = []
        media_items = []
        requested_beats = _requested_beats(args)
        for b in items or []:
            if not isinstance(b, dict):
                continue
            beat_number = b.get("beat_number")
            try:
                beat_int = int(beat_number)
            except (TypeError, ValueError):
                beat_int = None
            if requested_beats is not None and beat_int not in requested_beats:
                continue
            sketch_url = b.get("sketch_url") or ""
            video_url = b.get("video_url") or ""
            sketches.append(
                {
                    "beat_number": beat_number,
                    "sketch_url": sketch_url,
                    "sketch_source": "sketch" if sketch_url else "",
                    "video_url": video_url,
                    "characters": b.get("character_names") or b.get("characters"),
                }
            )
            if sketch_url:
                media_items.append(
                    {
                        "src": sketch_url,
                        "title": f"Beat {beat_number} 草图",
                        "description": "草图",
                        "aspectRatio": "3/4",
                    }
                )
        limited_media = _limit_items(media_items, args, 12)
        return tool_result(
            {
                "ok": True,
                "episode": episode,
                "media_kind": media_kind,
                "count": len(sketches),
                "sketches": sketches,
                "ui_spec": _image_ui_spec("sketch_gallery", limited_media) if limited_media else None,
            }
        )
    except Exception as exc:
        return tool_result({"ok": False, "error": str(exc)})


def _handle_get_first_frames(args: dict[str, Any], **_: Any) -> str:
    """Get display-ready first-frame URLs for an episode (to SHOW the user).

    Wraps GET /projects/{project}/episodes/{episode}/beats and returns, per beat,
    the servable ``frame_url``. Use ``dramaclaw_get_sketches`` for sketches.
    """
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        resp = _request("GET", f"/api/v1/projects/{project}/episodes/{episode}/beats")
        items: Any = None
        if isinstance(resp, dict):
            for key in ("data", "beats", "items"):
                value = resp.get(key)
                if isinstance(value, list):
                    items = value
                    break
            if items is None and isinstance(resp.get("data"), dict):
                items = resp["data"].get("beats")
        frames = []
        media_items = []
        requested_beats = _requested_beats(args)
        for b in items or []:
            if not isinstance(b, dict):
                continue
            beat_number = b.get("beat_number")
            try:
                beat_int = int(beat_number)
            except (TypeError, ValueError):
                beat_int = None
            if requested_beats is not None and beat_int not in requested_beats:
                continue
            frame_url = b.get("frame_url") or ""
            frames.append(
                {
                    "beat_number": beat_number,
                    "frame_url": frame_url,
                    "video_url": b.get("video_url") or "",
                    "characters": b.get("character_names") or b.get("characters"),
                }
            )
            if frame_url:
                media_items.append(
                    {
                        "src": frame_url,
                        "title": f"Beat {beat_number} 首帧",
                        "description": "首帧",
                        "aspectRatio": "3/4",
                    }
                )
        limited_media = _limit_items(media_items, args, 12)
        return tool_result(
            {
                "ok": True,
                "episode": episode,
                "media_kind": "frame",
                "count": len(frames),
                "frames": frames,
                "ui_spec": _image_ui_spec("sketch_gallery", limited_media) if limited_media else None,
            }
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_get_sketch_candidates(args: dict[str, Any], **_: Any) -> str:
    """Get display-ready sketch pool candidates for one beat."""
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        beat = int(args.get("beat") or args.get("beat_num") or args.get("beat_number") or 0)
        if beat <= 0:
            raise ValueError("beat is required")
        resp = _request(
            "GET",
            f"/api/v1/projects/{project}/episodes/{episode}/beats/{beat}/sketch-candidates",
        )
        data = resp.get("data") if isinstance(resp, dict) else None
        if not isinstance(data, dict):
            data = {}
        candidates = data.get("candidates") if isinstance(data.get("candidates"), list) else []
        media_items = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            src = str(candidate.get("url") or "").strip()
            if not src:
                continue
            stale = bool(candidate.get("stale"))
            media_items.append(
                {
                    "src": src,
                    "title": f"Beat {beat} 草图候选",
                    "description": "过期候选" if stale else "草图候选",
                    "aspectRatio": "3/4",
                }
            )
        limited_media = _limit_items(media_items, args, 12)
        return tool_result(
            {
                "ok": bool(resp.get("ok", True)) if isinstance(resp, dict) else True,
                "episode": episode,
                "beat": beat,
                "media_kind": "sketch_candidate",
                "current_sketch_url": data.get("current_sketch_url", ""),
                "candidate_count": int(data.get("candidate_count") or len(candidates)),
                "candidates": candidates,
                "ui_spec": _image_ui_spec("sketch_gallery", limited_media) if limited_media else None,
            }
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_get_scene_images(args: dict[str, Any], **_: Any) -> str:
    """Get display-ready scene image URLs for a project (to SHOW the user).

    Wraps GET /projects/{project}/scenes and returns only servable scene asset
    URLs. Do NOT use local ``*_path`` fields and do NOT synthesize URLs.
    """
    try:
        project = _project_from_args(args)
        include_reverse = bool(args.get("include_reverse", True))
        include_pano = bool(args.get("include_pano", False))
        include_custom = bool(args.get("include_custom", False))
        resp = _request("GET", f"/api/v1/projects/{project}/scenes")
        items: Any = None
        if isinstance(resp, dict):
            for key in ("data", "scenes", "items"):
                value = resp.get(key)
                if isinstance(value, list):
                    items = value
                    break
            if items is None and isinstance(resp.get("data"), dict):
                items = resp["data"].get("scenes")

        scenes = []
        media_items = []
        image_count = 0
        requested_names = _requested_scene_names(args)
        requested_indices = _requested_scene_indices(args)
        requested_type = str(args.get("scene_type") or "").strip()
        for scene_index, scene in enumerate(items or [], start=1):
            if not isinstance(scene, dict):
                continue
            scene_name = str(scene.get("name") or "").strip()
            scene_type = str(scene.get("scene_type") or "").strip()
            if requested_indices is not None and scene_index not in requested_indices:
                continue
            if not _matches_any_scene_name(scene_name, requested_names):
                continue
            if requested_type and scene_type != requested_type:
                continue
            images = []
            for kind, field, enabled in (
                ("master", "master_url", True),
                ("reverse_master", "reverse_master_url", include_reverse),
                ("pano", "pano_url", include_pano),
                ("custom_scene", "custom_scene_url", include_custom),
            ):
                url = str(scene.get(field) or "").strip()
                if enabled and url:
                    images.append({"kind": kind, "url": url})
                    media_items.append(
                        {
                            "src": url,
                            "title": f"{scene_name or '场景'} · {kind}",
                            "description": scene.get("description") or scene.get("environment_prompt") or "",
                            "aspectRatio": "16/9" if kind == "pano" else "3/4",
                        }
                    )
            image_count += len(images)
            scenes.append(
                {
                    "index": scene_index,
                    "name": scene_name,
                    "scene_type": scene_type,
                    "description": scene.get("description") or "",
                    "environment_prompt": scene.get("environment_prompt") or "",
                    "master_url": scene.get("master_url") or "",
                    "reverse_master_url": scene.get("reverse_master_url") or "",
                    "pano_url": scene.get("pano_url") or "",
                    "custom_scene_url": scene.get("custom_scene_url") or "",
                    "images": images,
                }
            )
        limited_media = _limit_items(media_items, args, 12)
        return tool_result(
            {
                "ok": True,
                "project_id": project,
                "count": len(scenes),
                "image_count": image_count,
                "scenes": scenes,
                "ui_spec": _image_ui_spec("sketch_gallery", limited_media) if limited_media else None,
            }
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_get_character_media(args: dict[str, Any], **_: Any) -> str:
    """Get display-ready character portrait/identity image URLs."""
    try:
        project = _project_from_args(args)
        media_kind = str(args.get("media_kind") or args.get("kind") or "all").strip().lower()
        if media_kind not in {"all", "portrait", "identity"}:
            media_kind = "all"
        include_identities = bool(args.get("include_identities", True)) and media_kind != "portrait"
        resp = _request("GET", f"/api/v1/projects/{project}/characters")
        items: Any = None
        if isinstance(resp, dict):
            for key in ("data", "characters", "items"):
                value = resp.get(key)
                if isinstance(value, list):
                    items = value
                    break
            if items is None and isinstance(resp.get("data"), dict):
                items = resp["data"].get("characters")

        characters = []
        media_items = []
        requested_names = _requested_names(args)
        requested_queries = _requested_queries(args)
        for character in items or []:
            if not isinstance(character, dict):
                continue
            name = str(character.get("name") or "").strip()
            role = str(character.get("role") or character.get("description") or "").strip()
            character_name_match = _matches_any_text(
                [name, character.get("aliases")],
                requested_names,
            )
            character_query_match = _matches_any_text(
                [
                    name,
                    role,
                    character.get("description"),
                    character.get("appearance"),
                    character.get("profile"),
                    character.get("aliases"),
                ],
                requested_queries,
            )
            character_match = character_name_match and character_query_match
            portrait_url = str(character.get("portrait_url") or "").strip()
            if portrait_url and character_match:
                if media_kind in {"all", "portrait"}:
                    media_items.append(
                        {
                            "src": portrait_url,
                            "title": name or "角色肖像",
                            "description": role,
                            "aspectRatio": "3/4",
                        }
                    )
            identity_items = []
            identities = character.get("identities") or character.get("identity_images") or []
            if include_identities:
                try:
                    identities_resp = _request(
                        "GET",
                        f"/api/v1/projects/{project}/characters/{quote(name, safe='')}/identities",
                    )
                    if isinstance(identities_resp, dict):
                        for key in ("data", "identities", "items"):
                            value = identities_resp.get(key)
                            if isinstance(value, list):
                                identities = value
                                break
                        if isinstance(identities_resp.get("data"), dict):
                            value = identities_resp["data"].get("identities")
                            if isinstance(value, list):
                                identities = value
                except Exception:
                    pass
            if include_identities and isinstance(identities, list):
                for identity in identities:
                    if not isinstance(identity, dict):
                        continue
                    image_url = str(
                        identity.get("image_url")
                        or identity.get("portrait_image_url")
                        or identity.get("costume_image_url")
                        or ""
                    ).strip()
                    if not image_url:
                        continue
                    title = str(
                        identity.get("identity_name")
                        or identity.get("name")
                        or identity.get("identity_id")
                        or name
                        or "身份图"
                    )
                    identity_name_match = _matches_any_text(
                        [
                            name,
                            character.get("aliases"),
                            title,
                            identity.get("identity_name"),
                            identity.get("name"),
                            identity.get("identity_id"),
                        ],
                        requested_names,
                    )
                    identity_query_match = _matches_any_text(
                        [
                            title,
                            identity.get("identity_name"),
                            identity.get("name"),
                            identity.get("identity_id"),
                            identity.get("description"),
                            identity.get("appearance_details"),
                            identity.get("prompt"),
                            identity.get("role"),
                            name,
                            role,
                        ],
                        requested_queries,
                    )
                    identity_match = identity_name_match and identity_query_match
                    if not identity_match:
                        continue
                    identity_items.append({"title": title, "image_url": image_url})
                    media_items.append(
                        {
                            "src": image_url,
                            "title": f"{name} · {title}" if name else title,
                            "description": role,
                            "aspectRatio": "3/4",
                        }
                    )
            if (requested_names is not None or requested_queries is not None) and not character_match and not identity_items:
                continue
            characters.append(
                {
                    "name": name,
                    "role": role,
                    "portrait_url": portrait_url,
                    "identities": identity_items,
                }
            )

        limited_media = _limit_items(media_items, args, 12)
        return tool_result(
            {
                "ok": True,
                "project_id": project,
                "count": len(characters),
                "media_count": len(media_items),
                "characters": characters,
                "ui_spec": _image_ui_spec("character_showcase", limited_media) if limited_media else None,
            }
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_get_episode_media(args: dict[str, Any], **_: Any) -> str:
    """Get display-ready episode video/audio URLs."""
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        media_type = str(args.get("media_type") or "video").strip().lower()
        resp = _request("GET", f"/api/v1/projects/{project}/episodes/{episode}/beats")
        items: Any = None
        if isinstance(resp, dict):
            for key in ("data", "beats", "items"):
                value = resp.get(key)
                if isinstance(value, list):
                    items = value
                    break
            if items is None and isinstance(resp.get("data"), dict):
                items = resp["data"].get("beats")

        video_items = []
        audio_items = []
        beats = []
        requested_beats = _requested_beats(args)
        requested_queries = _requested_queries(args)
        for beat in items or []:
            if not isinstance(beat, dict):
                continue
            beat_number = beat.get("beat_number")
            try:
                beat_int = int(beat_number)
            except (TypeError, ValueError):
                beat_int = None
            if requested_beats is not None and beat_int not in requested_beats:
                continue
            if not _matches_any_text(
                [
                    beat.get("title"),
                    beat.get("summary"),
                    beat.get("description"),
                    beat.get("visual_description"),
                    beat.get("image_prompt"),
                    beat.get("video_prompt"),
                    beat.get("narration"),
                    beat.get("voiceover"),
                    beat.get("dialogue"),
                    beat.get("audio_text"),
                    beat.get("speaker"),
                    beat.get("character_names"),
                    beat.get("characters"),
                    beat.get("scene_name"),
                    beat.get("location"),
                ],
                requested_queries,
            ):
                continue
            video_url = str(beat.get("video_url") or "").strip()
            audio_url = str(beat.get("audio_url") or "").strip()
            frame_url = str(beat.get("frame_url") or beat.get("sketch_url") or "").strip()
            beats.append({"beat_number": beat_number, "video_url": video_url, "audio_url": audio_url})
            if video_url:
                video_items.append(
                    {
                        "src": video_url,
                        "poster": frame_url,
                        "title": f"Beat {beat_number} 视频",
                    }
                )
            if audio_url:
                audio_items.append({"src": audio_url, "title": f"Beat {beat_number} 音频"})

        if media_type == "audio":
            limited = _limit_items(audio_items, args, 20)
            ui_spec = _audio_ui_spec(limited) if limited else None
        else:
            limited = _limit_items(video_items, args, 6)
            ui_spec = _video_ui_spec(limited) if limited else None
        return tool_result(
            {
                "ok": True,
                "project_id": project,
                "episode": episode,
                "media_type": media_type,
                "video_count": len(video_items),
                "audio_count": len(audio_items),
                "beats": beats,
                "ui_spec": ui_spec,
            }
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_render_first_frames(args: dict[str, Any], **_: Any) -> str:
    """Generate first frames for an episode (首帧生成, selected_regen task).

    Wraps POST /projects/{project}/episodes/{episode}/beats/regenerate with
    ``{"beat_indices": [...]}``. If ``beat_indices`` is omitted, ALL beats of the
    episode are resolved automatically (GET /episodes/{ep}/beats). Requires sketches
    to exist first. Poll dramaclaw_get_task(task_type="selected_regen", episode=N).
    """
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        beats = args.get("beat_indices") or args.get("beats")
        if not isinstance(beats, list) or not beats:
            beats = _resolve_episode_beats(project, episode)
            if not beats:
                raise ValueError(
                    "could not resolve beats for this episode; generate sketches first "
                    "or pass beat_indices explicitly"
                )
        body: dict[str, Any] = {"beat_indices": [int(b) for b in beats]}
        if args.get("style"):
            body["style"] = str(args["style"])
        if args.get("model"):
            body["model"] = str(args["model"])
        return tool_result(
            _request(
                "POST",
                f"/api/v1/projects/{project}/episodes/{episode}/beats/regenerate",
                body=body,
            )
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_compose_episode(args: dict[str, Any], **_: Any) -> str:
    """Compose/export the final video for one episode (合成导出, compose_episode task).

    POST /projects/{project}/episodes/{episode}/videos/compose.
    Poll task_type="compose_episode", episode=N.
    """
    try:
        return tool_result(_episode_post(args, "videos/compose"))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_get_final_video(args: dict[str, Any], **_: Any) -> str:
    """Get and display the composed final episode video when it exists."""
    try:
        project = _project_from_args(args)
        episode = _require_episode(args)
        result = _request("GET", f"/api/v1/projects/{project}/episodes/{episode}/final")
        data = result.get("data") if isinstance(result, dict) else None
        video_url = ""
        if isinstance(data, dict) and data.get("exists"):
            video_url = str(data.get("video_url") or "").strip()
        if video_url and isinstance(result, dict):
            result["ui_spec"] = _video_ui_spec(
                [
                    {
                        "src": video_url,
                        "title": f"第 {episode} 集成片",
                        "description": "最终合成视频",
                    }
                ]
            )
        return tool_result(result)
    except Exception as exc:
        return tool_error(str(exc))


def _handle_generate_portrait(args: dict[str, Any], **_: Any) -> str:
    """Generate one character's portrait (肖像生成, character_portrait task).

    POST /projects/{project}/characters/{name}/portrait-async. Poll
    task_type="character_portrait" (per character). Read via
    dramaclaw_get('/projects/{project}/characters').
    """
    try:
        project = _project_from_args(args)
        name = _require_name(args)
        return tool_result(
            _request("POST", f"/api/v1/projects/{project}/characters/{quote(name, safe='')}/portrait-async")
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_generate_identity_image(args: dict[str, Any], **_: Any) -> str:
    """Generate a character identity image (身份图生成, identity_image task).

    POST /projects/{project}/characters/{name}/identities/{identity_id}/generate-async.
    Needs both the character name and the identity_id (from the character's identity
    list). Poll task_type="identity_image".
    """
    try:
        project = _project_from_args(args)
        name = _require_name(args)
        identity_id = str(args.get("identity_id") or "").strip()
        if not identity_id:
            raise ValueError("identity_id is required")
        path = (
            f"/api/v1/projects/{project}/characters/{quote(name, safe='')}"
            f"/identities/{quote(identity_id, safe='')}/generate-async"
        )
        return tool_result(_request("POST", path))
    except Exception as exc:
        return tool_error(str(exc))


def _handle_start_single_video(args: dict[str, Any], **_: Any) -> str:
    """Generate one beat's video (单 beat 视频, single_video task).

    POST /projects/{project}/episodes/{episode}/beats/{beat}/video. The beat's
    prompt is taken from its stored ``video_prompt`` (set by the script step) —
    you do NOT pass a prompt. Requires the beat's first frame to exist already
    (otherwise the API returns "首帧不存在") and the beat to have a non-empty
    video_prompt (otherwise the backend returns "prompt is required"). Only
    video_backend / duration / resolution / mode are accepted request fields.
    """
    try:
        project = _project_from_args(args)
        episode = int(args.get("episode") or 1)
        beat = int(args.get("beat") or args.get("beat_number") or 0)
        if beat <= 0:
            raise ValueError("beat must be a positive integer")
        body: dict[str, Any] = {}
        for key in ("video_backend", "duration", "resolution", "mode"):
            if args.get(key) is not None:
                body[key] = args[key]
        return tool_result(_request("POST", f"/api/v1/projects/{project}/episodes/{episode}/beats/{beat}/video", body=body))
    except Exception as exc:
        return tool_error(str(exc))


_PATH_PROPS = {
    "path": {
        "type": "string",
        "description": (
            "DramaClaw relative API path. Must start with /api/v1/ or /projects/. "
            "Absolute URLs are rejected. Ingest routes are only "
            "/projects/{project}/ingest/upload and /projects/{project}/ingest/start; "
            "ingest_fast is a task_type, not an endpoint."
        ),
    },
    "query": {"type": "object", "description": "Optional query parameters."},
}


def _schema(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required or [],
        },
    }


TOOLS = (
    (
        "dramaclaw_get",
        _schema("dramaclaw_get", "Call a DramaClaw GET API path without using curl.", _PATH_PROPS, ["path"]),
        _handle_get,
    ),
    (
        "dramaclaw_post",
        _schema("dramaclaw_post", "Call a DramaClaw POST API path without using curl.", {**_PATH_PROPS, "body": {"type": "object"}}, ["path"]),
        _handle_post,
    ),
    (
        "dramaclaw_patch",
        _schema("dramaclaw_patch", "Call a DramaClaw PATCH API path without using curl.", {**_PATH_PROPS, "body": {"type": "object"}}, ["path"]),
        _handle_patch,
    ),
    (
        "dramaclaw_delete",
        _schema("dramaclaw_delete", "Call a DramaClaw DELETE API path without using curl.", {**_PATH_PROPS, "body": {"type": "object"}}, ["path"]),
        _handle_delete,
    ),
    (
        "dramaclaw_pipeline_status",
        _schema(
            "dramaclaw_pipeline_status",
            "Get the current DramaClaw project pipeline status.",
            {
                "project_id": {"type": "string", "description": "Project id. Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Optional episode number."},
            },
        ),
        _handle_pipeline_status,
    ),
    (
        "dramaclaw_list_tasks",
        _schema(
            "dramaclaw_list_tasks",
            "List DramaClaw tasks for the current or specified project.",
            {
                "project_id": {"type": "string"},
                "episode": {"type": "integer"},
                "task_type": {"type": "string"},
                "status": {"type": "string"},
            },
        ),
        _handle_list_tasks,
    ),
    (
        "dramaclaw_get_task",
        _schema(
            "dramaclaw_get_task",
            "Get one DramaClaw task status by task type, episode, and optional beat/scope.",
            {
                "project_id": {"type": "string"},
                "task_type": {"type": "string"},
                "episode": {"type": "integer"},
                "beat": {"type": "integer"},
                "beat_num": {"type": "integer"},
                "scope": {"type": "string"},
            },
            ["task_type", "episode"],
        ),
        _handle_get_task,
    ),
    (
        "dramaclaw_get_episode_script",
        _schema(
            "dramaclaw_get_episode_script",
            "Get one episode script for the current or specified project.",
            {
                "project_id": {"type": "string"},
                "episode": {"type": "integer"},
            },
            ["episode"],
        ),
        _handle_get_episode_script,
    ),
    (
        "dramaclaw_list_ingest_uploads",
        _schema(
            "dramaclaw_list_ingest_uploads",
            "List files already uploaded to the current project's ingest script directory. Use this when "
            "the user asks which files are currently uploaded, or before starting video/short-drama "
            "ingest from a previously uploaded script.",
            {
                "project_id": {"type": "string", "description": "Project id. Defaults to DRAMACLAW_PROJECT_ID."},
            },
        ),
        _handle_list_ingest_uploads,
    ),
    (
        "dramaclaw_build_characters",
        _schema(
            "dramaclaw_build_characters",
            "Extract characters from the project's knowledge graph (async build_characters "
            "task, episode 0). Requires ingest to be complete first. Use THIS instead of "
            "guessing a path. Poll with dramaclaw_get_task(task_type='build_characters', "
            "episode=0); read results with dramaclaw_get('/projects/{project}/characters').",
            {
                "project_id": {
                    "type": "string",
                    "description": "Project id. Defaults to DRAMACLAW_PROJECT_ID.",
                },
            },
        ),
        _handle_build_characters,
    ),
    (
        "dramaclaw_plan_episodes",
        _schema(
            "dramaclaw_plan_episodes",
            "Plan/generate episodes (分集规划, async build_episodes task, episode 0). Requires "
            "ingest + character extraction done first. Use THIS instead of guessing a path — the "
            "real endpoint is POST /projects/{project}/episodes/plan (NOT /episodes, /tasks/..., "
            "/build_episodes or /start_pipeline). Poll with dramaclaw_get_task("
            "task_type='build_episodes', episode=0); read with dramaclaw_get('/projects/{project}/episodes').",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "target_episodes": {"type": "integer", "description": "How many episodes to plan (default 10)."},
                "planning_mode": {"type": "string", "description": "Planning mode (default 'chapters')."},
            },
        ),
        _handle_plan_episodes,
    ),
    (
        "dramaclaw_generate_script",
        _schema(
            "dramaclaw_generate_script",
            "Generate the screenplay for one episode (脚本生成, script_writer task). Use THIS "
            "instead of guessing — the real endpoint is POST /projects/{project}/episodes/{episode}/"
            "script/generate. Requires the episode's character identities planned first (else returns "
            "code 'identity_plan_required'). Poll with dramaclaw_get_task(task_type='script_writer', "
            "episode=N); read with dramaclaw_get_episode_script(episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (1-based, required)."},
            },
            ["episode"],
        ),
        _handle_generate_script,
    ),
    (
        "dramaclaw_update_character_face_prompt",
        _schema(
            "dramaclaw_update_character_face_prompt",
            "Set or repair one character's face_prompt (面部特征) before portrait generation. "
            "Use this after character extraction if a core character has an empty face_prompt, "
            "or when character_portrait fails with '请先设置面部特征 (face_prompt)'. Real endpoint "
            "PATCH /projects/{project}/characters/{name} with {face_prompt: ...}. After this "
            "succeeds, retry dramaclaw_generate_portrait for that character.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "name": {"type": "string", "description": "Character name (required)."},
                "character": {"type": "string", "description": "Alias of name."},
                "face_prompt": {
                    "type": "string",
                    "description": "Concrete facial features: hairstyle, face shape, eyes, skin tone, age cues; no clothing.",
                },
            },
            ["name", "face_prompt"],
        ),
        _handle_update_character_face_prompt,
    ),
    (
        "dramaclaw_plan_identities",
        _schema(
            "dramaclaw_plan_identities",
            "Plan character identities for one episode (身份规划, identity_planner task). Use THIS "
            "instead of guessing — real endpoint POST /projects/{project}/episodes/{episode}/identities/"
            "plan-async. This is a PREREQUISITE for dramaclaw_generate_script. Poll dramaclaw_get_task("
            "task_type='identity_planner', episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
            },
            ["episode"],
        ),
        _handle_plan_identities,
    ),
    (
        "dramaclaw_plan_scenes",
        _schema(
            "dramaclaw_plan_scenes",
            "Plan the scene menu for one episode (场景规划, episode_scene_planner task). Use THIS "
            "after script generation and before sketch generation when the pipeline needs scene "
            "context. Real endpoint POST /projects/{project}/episodes/{episode}/scenes/plan. Poll "
            "with dramaclaw_get_task(task_type='episode_scene_planner', episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
            },
            ["episode"],
        ),
        _handle_plan_scenes,
    ),
    (
        "dramaclaw_plan_props",
        _schema(
            "dramaclaw_plan_props",
            "Plan the prop menu for one episode (道具规划, episode_prop_planner task). Use THIS "
            "after script generation and before sketch generation when the pipeline needs prop "
            "context. Real endpoint POST /projects/{project}/episodes/{episode}/props/plan. Poll "
            "with dramaclaw_get_task(task_type='episode_prop_planner', episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
            },
            ["episode"],
        ),
        _handle_plan_props,
    ),
    (
        "dramaclaw_generate_scene_master",
        _schema(
            "dramaclaw_generate_scene_master",
            "Generate one scene's canonical master reference image (场景正向参考图, "
            "scene_reference_asset task). Real endpoint POST /projects/{project}/scenes/{name}/"
            "master/generate-async. Use scene names from dramaclaw_get(path='/projects/{project}/"
            "scenes') or the episode scene menu. Poll with dramaclaw_get_task(task_type="
            "'scene_reference_asset', episode=0, scope=<returned scope>).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "name": {"type": "string", "description": "Scene name (required)."},
                "scene_name": {"type": "string", "description": "Alias of name."},
            },
            ["name"],
        ),
        _handle_generate_scene_master,
    ),
    (
        "dramaclaw_generate_scene_reverse",
        _schema(
            "dramaclaw_generate_scene_reverse",
            "Generate one scene's reverse master reference image (场景反向参考图, "
            "scene_reference_asset task). Real endpoint POST /projects/{project}/scenes/{name}/"
            "reverse/generate-async. Poll with dramaclaw_get_task(task_type='scene_reference_asset', "
            "episode=0, scope=<returned scope>).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "name": {"type": "string", "description": "Scene name (required)."},
                "scene_name": {"type": "string", "description": "Alias of name."},
            },
            ["name"],
        ),
        _handle_generate_scene_reverse,
    ),
    (
        "dramaclaw_generate_portrait",
        _schema(
            "dramaclaw_generate_portrait",
            "Generate one character's portrait (肖像生成, character_portrait task). Real endpoint "
            "POST /projects/{project}/characters/{name}/portrait-async. Call once per character. Poll "
            "dramaclaw_get_task(task_type='character_portrait').",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "name": {"type": "string", "description": "Character name (required; from the character list)."},
            },
            ["name"],
        ),
        _handle_generate_portrait,
    ),
    (
        "dramaclaw_generate_identity_image",
        _schema(
            "dramaclaw_generate_identity_image",
            "Generate a character identity image (身份图生成, identity_image task). Real endpoint POST "
            "/projects/{project}/characters/{name}/identities/{identity_id}/generate-async. Poll "
            "dramaclaw_get_task(task_type='identity_image').",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "name": {"type": "string", "description": "Character name (required)."},
                "identity_id": {"type": "string", "description": "Identity id from the character's identity list (required)."},
            },
            ["name", "identity_id"],
        ),
        _handle_generate_identity_image,
    ),
    (
        "dramaclaw_generate_sketches",
        _schema(
            "dramaclaw_generate_sketches",
            "Generate beat sketches for one episode (草图生成, sketch_generation task). Real endpoint "
            "POST /projects/{project}/episodes/{episode}/sketches/generate with a canonical body. "
            "This tool automatically runs assign-colors first by default and fills safe defaults: "
            "model='nanobanana', grid_index=-1 (all grids), sketch_scene_grouping=true, "
            "aspect_ratio='2:3'. Use THIS instead of dramaclaw_post or guessing the body. Runs "
            "after the script exists. Poll dramaclaw_get_task(task_type='sketch_generation', episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
                "style": {"type": "string", "description": "Optional visual style override."},
                "model": {"type": "string", "description": "Sketch model. Default: nanobanana."},
                "grid_index": {
                    "type": "integer",
                    "description": "Grid index to generate. Use -1 to generate all grids. Default: -1.",
                },
                "sketch_scene_grouping": {
                    "type": "boolean",
                    "description": "Group sketch grids by scene. Default: true.",
                },
                "aspect_ratio": {
                    "type": "string",
                    "enum": ["2:3", "16:9"],
                    "description": "Sketch aspect ratio. Default: 2:3.",
                },
                "image_generation_selection": {
                    "type": "string",
                    "description": "Optional backend/provider selection from sketch settings.",
                },
                "auto_assign_colors": {
                    "type": "boolean",
                    "description": "Run /sketches/assign-colors before generation. Default: true.",
                },
                "body": {
                    "type": "object",
                    "description": "Advanced override merged into the canonical generate body.",
                },
            },
            ["episode"],
        ),
        _handle_generate_sketches,
    ),
    (
        "dramaclaw_detect_sketch_identities",
        _schema(
            "dramaclaw_detect_sketch_identities",
            "Run AI detection on one episode's generated sketches and persist detected identities "
            "and props to each beat. Real endpoint POST /projects/{project}/episodes/{episode}/"
            "sketches/detect-identities. Requires sketches to exist and sketch colors to be assigned; "
            "if colors are missing, run dramaclaw_generate_sketches or POST assign-colors first. Use "
            "THIS when the user asks to run AI 检测 / identity detection for sketches. If the tool "
            "returns a timeout or retryable=false, do not call it again in the same turn; report the "
            "timeout and stop.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
            },
            ["episode"],
        ),
        _handle_detect_sketch_identities,
    ),
    (
        "dramaclaw_get_sketches",
        _schema(
            "dramaclaw_get_sketches",
            "Get display-ready official sketch URLs for an episode, to SHOW the user. This tool "
            "returns only current sketch_url media. It does not fall back to "
            "grids/epNNN/sketch/beat_XX_t* pool candidates and never substitutes first frames. "
            "Use dramaclaw_get_first_frames only when the user explicitly "
            "asks for 首帧/first frames. Do NOT read "
            "sketch_path from a task result, and do NOT use vision_analyze to 'show' images. "
            "After calling this tool, do not write markdown images, raw URLs, http/static paths, "
            "or HTML media tags.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
                "beat": {"type": "integer", "description": "Show only one beat's sketch."},
                "beat_indices": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Show only these beat numbers, in episode order.",
                },
                "offset": {
                    "type": "integer",
                    "description": "Zero-based media offset after beat filtering. Use with limit for paging.",
                },
                "limit": {"type": "integer", "description": "Maximum media items to return. Default/max: 12."},
            },
            ["episode"],
        ),
        _handle_get_sketches,
    ),
    (
        "dramaclaw_get_first_frames",
        _schema(
            "dramaclaw_get_first_frames",
            "Get display-ready first-frame URLs for an episode, to SHOW the user. This tool returns "
            "only frame_url media. Use this only when the user explicitly asks for 首帧/first frames. "
            "Use dramaclaw_get_sketches for sketches. After calling this tool, do not write markdown "
            "images, raw URLs, http/static paths, or HTML media tags.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
                "beat": {"type": "integer", "description": "Show only one beat's first frame."},
                "beat_indices": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Show only these beat numbers, in episode order.",
                },
                "offset": {
                    "type": "integer",
                    "description": "Zero-based media offset after beat filtering. Use with limit for paging.",
                },
                "limit": {"type": "integer", "description": "Maximum media items to return. Default/max: 12."},
            },
            ["episode"],
        ),
        _handle_get_first_frames,
    ),
    (
        "dramaclaw_get_sketch_candidates",
        _schema(
            "dramaclaw_get_sketch_candidates",
            "Get display-ready sketch pool candidates for one beat. This tool shows "
            "grids/epNNN/sketch/beat_XX_t* candidates and is separate from current sketch_url. "
            "Use dramaclaw_get_sketches when the user asks for the official/current sketch.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
                "beat": {"type": "integer", "description": "Beat number (required)."},
                "offset": {
                    "type": "integer",
                    "description": "Zero-based candidate offset. Use with limit for paging.",
                },
                "limit": {"type": "integer", "description": "Maximum media items to return. Default/max: 12."},
            },
            ["episode", "beat"],
        ),
        _handle_get_sketch_candidates,
    ),
    (
        "dramaclaw_get_scene_images",
        _schema(
            "dramaclaw_get_scene_images",
            "Get display-ready scene image URLs for a project, to SHOW the user. Returns per-scene "
            "servable master_url/reverse_master_url/pano_url/custom_scene_url and prepared media data. "
            "Do NOT use local *_path fields, task result paths, or synthesized download URLs. "
            "After calling this tool, do not write markdown images, raw URLs, http/static paths, "
            "or HTML media tags.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "include_reverse": {
                    "type": "boolean",
                    "description": "Include reverse_master_url entries. Default: true.",
                },
                "include_pano": {
                    "type": "boolean",
                    "description": "Include pano_url entries. Default: false.",
                },
                "include_custom": {
                    "type": "boolean",
                    "description": "Include custom_scene_url entries. Default: false.",
                },
                "name": {"type": "string", "description": "Show scenes whose name contains this text."},
                "names": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Show scenes whose name contains any of these texts.",
                },
                "scene_name": {"type": "string", "description": "Alias of name; fuzzy contains match."},
                "scene_type": {"type": "string", "description": "Show only scenes with this scene_type."},
                "index": {
                    "type": "integer",
                    "description": "Show only the Nth scene from the API scene list, 1-based.",
                },
                "scene_indices": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Show only these 1-based scene indexes from the API scene list.",
                },
                "offset": {
                    "type": "integer",
                    "description": "Zero-based media offset after scene filtering. Use with limit for paging.",
                },
                "limit": {"type": "integer", "description": "Maximum media items to return. Default/max: 12."},
            },
        ),
        _handle_get_scene_images,
    ),
    (
        "dramaclaw_get_character_media",
        _schema(
            "dramaclaw_get_character_media",
            "Get display-ready character portrait/identity image URLs and prepared media data. "
            "After calling this tool, do not write markdown images, raw URLs, http/static paths, "
            "or HTML media tags; "
            "the backend renders the returned media automatically.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "include_identities": {"type": "boolean", "description": "Include identity images. Default: true."},
                "media_kind": {
                    "type": "string",
                    "enum": ["all", "portrait", "identity"],
                    "description": "all=portraits plus identity images; portrait=only character portraits; identity=only identity images.",
                },
                "name": {
                    "type": "string",
                    "description": "Show character media whose character name, aliases, or identity name/id contains this text.",
                },
                "names": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Show character media whose character name, aliases, or identity name/id contains any of these texts.",
                },
                "query": {
                    "type": "string",
                    "description": "Broad fuzzy text query over character name, role/description, identity names, and identity descriptions.",
                },
                "identity_name": {
                    "type": "string",
                    "description": "Fuzzy text query over identity image names/ids.",
                },
                "offset": {
                    "type": "integer",
                    "description": "Zero-based media offset after character filtering. Use with limit for paging.",
                },
                "limit": {"type": "integer", "description": "Maximum media items to return. Default/max: 12."},
            },
        ),
        _handle_get_character_media,
    ),
    (
        "dramaclaw_get_episode_media",
        _schema(
            "dramaclaw_get_episode_media",
            "Get display-ready episode beat video/audio URLs and prepared media data. "
            "media_type='video' returns video previews; media_type='audio' returns audio items. "
            "After calling this tool, do not write markdown images, raw URLs, http/static paths, "
            "or HTML media tags; "
            "the backend renders the returned media automatically.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
                "media_type": {"type": "string", "enum": ["video", "audio"], "description": "Default: video."},
                "beat": {"type": "integer", "description": "Show only one beat's video/audio."},
                "beat_indices": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Show only these beat numbers, in episode order.",
                },
                "query": {
                    "type": "string",
                    "description": "Fuzzy text query over beat title, description, narration/dialogue, speaker, characters, and scene.",
                },
                "search": {
                    "type": "string",
                    "description": "Alias of query.",
                },
                "offset": {
                    "type": "integer",
                    "description": "Zero-based media offset after beat filtering. Use with limit for paging.",
                },
                "limit": {"type": "integer", "description": "Maximum media items to return. Video max 6; audio max 20."},
            },
            ["episode"],
        ),
        _handle_get_episode_media,
    ),
    (
        "dramaclaw_render_first_frames",
        _schema(
            "dramaclaw_render_first_frames",
            "Generate first frames for an episode (首帧生成, selected_regen task). Real endpoint POST "
            "/projects/{project}/episodes/{episode}/beats/regenerate with {beat_indices:[...]}. Omit "
            "beat_indices to render ALL beats of the episode (resolved automatically). Requires sketches "
            "first. Poll dramaclaw_get_task(task_type='selected_regen', episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
                "beat_indices": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Beat numbers to render. Omit to render all beats of the episode.",
                },
                "style": {"type": "string", "description": "Optional visual style override."},
            },
            ["episode"],
        ),
        _handle_render_first_frames,
    ),
    (
        "dramaclaw_generate_audio",
        _schema(
            "dramaclaw_generate_audio",
            "Generate episode audio/voiceover using the current IndexTTS2 audio pipeline "
            "(音频生成, audio_generation_indextts2 task). Real endpoint POST /projects/{project}/"
            "episodes/{episode}/audio/generate. Use THIS instead of legacy /tts/generate, which "
            "has been removed. Poll dramaclaw_get_task(task_type='audio_generation_indextts2', "
            "episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
                "mode": {
                    "type": "string",
                    "description": "Audio generation mode. Backend default is sync_changed.",
                },
                "beat_numbers": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Optional beat numbers for partial audio generation.",
                },
                "provider": {"type": "string", "description": "Optional provider override."},
                "voice": {"type": "string", "description": "Optional voice override."},
                "model": {"type": "string", "description": "Optional model override."},
                "rate": {"type": "string", "description": "Optional speech rate override."},
            },
            ["episode"],
        ),
        _handle_generate_audio,
    ),
    (
        "dramaclaw_optimize_video_global",
        _schema(
            "dramaclaw_optimize_video_global",
            "Run global video optimization for one episode (全局视频优化, global_optimize_video task). "
            "Real endpoint POST /projects/{project}/episodes/{episode}/optimize/video-global. Poll "
            "dramaclaw_get_task(task_type='global_optimize_video', episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
            },
            ["episode"],
        ),
        _handle_optimize_video_global,
    ),
    (
        "dramaclaw_compose_episode",
        _schema(
            "dramaclaw_compose_episode",
            "Compose/export the final video for one episode (合成导出, compose_episode task). Real "
            "endpoint POST /projects/{project}/episodes/{episode}/videos/compose. Poll dramaclaw_get_task("
            "task_type='compose_episode', episode=N).",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
            },
            ["episode"],
        ),
        _handle_compose_episode,
    ),
    (
        "dramaclaw_get_final_video",
        _schema(
            "dramaclaw_get_final_video",
            "Get and display the composed final episode video (最终成片展示). Real endpoint GET "
            "/projects/{project}/episodes/{episode}/final. Use this after compose_episode completes "
            "or when the user asks for the final video. If no final video exists, report that state; "
            "do not synthesize file URLs.",
            {
                "project_id": {"type": "string", "description": "Defaults to DRAMACLAW_PROJECT_ID."},
                "episode": {"type": "integer", "description": "Episode number (required)."},
            },
            ["episode"],
        ),
        _handle_get_final_video,
    ),
    (
        "dramaclaw_start_single_video",
        _schema(
            "dramaclaw_start_single_video",
            "Generate one beat's video (单 beat 视频, single_video task), POST /episodes/{ep}/beats/"
            "{beat}/video. You do NOT pass a prompt — the beat's stored video_prompt is used. "
            "Prerequisites: the beat's first frame must exist AND the beat must have a non-empty "
            "video_prompt; if the API returns '首帧不存在' or 'prompt is required', that prerequisite "
            "is missing — report it, do NOT invent fixes. Compose only works after all beat videos exist.",
            {
                "project_id": {"type": "string"},
                "episode": {"type": "integer"},
                "beat": {"type": "integer", "description": "Beat number (required)."},
                "beat_number": {"type": "integer"},
                "video_backend": {"type": "string", "description": "Optional backend override."},
                "duration": {"type": "number", "description": "Optional seconds."},
            },
            ["episode", "beat"],
        ),
        _handle_start_single_video,
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
