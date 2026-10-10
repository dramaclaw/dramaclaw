"""API-first helpers for sketch-correction-worker scripts."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from novelvideo.task_jobs import (
    load_project_skill_env,
    resolve_project_name_from_context,
)

_DEFAULT_HTTP_TIMEOUT_SECONDS = 30.0


def _api_settings(project_dir: Path | None = None) -> tuple[str, str] | None:
    fallback_env: dict[str, str] = {}
    if project_dir is not None:
        fallback_env = load_project_skill_env(project_dir)
    base_url = (
        (os.environ.get("SUPERTALE_API_URL") or fallback_env.get("SUPERTALE_API_URL") or "")
        .strip()
        .rstrip("/")
    )
    api_key = (
        os.environ.get("SUPERTALE_API_KEY")
        or fallback_env.get("SUPERTALE_API_KEY")
        or ""
    ).strip()
    if not base_url or not api_key:
        return None
    return base_url, api_key


def api_enabled(project_dir: Path | None = None) -> bool:
    return _api_settings(project_dir) is not None


def _api_request(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    project_dir: Path | None = None,
) -> dict[str, Any]:
    settings = _api_settings(project_dir)
    if settings is None:
        raise RuntimeError(
            "SUPERTALE_API_URL / SUPERTALE_API_KEY is not configured in env or .claude/settings.local.json"
        )
    base_url, api_key = settings
    data = None
    headers = {
        "X-API-Key": api_key,
        "Accept": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(f"{base_url}/api/v1{path}", data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=_DEFAULT_HTTP_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"API {method} {path} failed ({exc.code}): {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"API {method} {path} failed: {exc.reason}") from exc


def _project_name(project_dir: Path) -> str:
    return resolve_project_name_from_context(project_dir)


def start_edit_execute_via_api(project_dir: Path, episode_num: int, payload: dict[str, Any]) -> dict[str, Any]:
    project = _project_name(project_dir)
    return _api_request(
        "POST",
        f"/projects/{project}/episodes/{episode_num}/verify/sketch-edit-execute/start",
        payload,
        project_dir=project_dir,
    )


def read_task_result_via_api(
    project_dir: Path,
    *,
    task_type: str,
    episode_num: int,
    scope: str | None = None,
    beat_num: int | None = None,
    require_terminal: bool = False,
) -> dict[str, Any]:
    project = _project_name(project_dir)
    query: dict[str, Any] = {}
    if scope is not None:
        query["scope"] = scope
    if beat_num is not None:
        query["beat_num"] = beat_num
    path = f"/tasks/{task_type}/{project}/{episode_num}"
    if query:
        path += f"?{urlencode(query)}"
    payload = _api_request("GET", path, project_dir=project_dir)
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error") or f"Task lookup failed: {task_type}")
    snapshot = payload.get("data")
    if snapshot is None:
        raise FileNotFoundError(
            f"Task not found: {task_type}/{project}/ep{episode_num} scope={scope or '-'}"
        )
    if require_terminal and snapshot.get("status") not in {"completed", "failed"}:
        raise RuntimeError(
            f"Task not finished yet: {task_type}/{project}/ep{episode_num} "
            f"status={snapshot.get('status') or '-'}"
        )
    return snapshot


def wait_for_task_result_via_api(
    project_dir: Path,
    *,
    task_type: str,
    episode_num: int,
    scope: str | None = None,
    beat_num: int | None = None,
    timeout_seconds: float = 900.0,
    poll_interval: float = 2.0,
) -> dict[str, Any]:
    if timeout_seconds < 0:
        raise ValueError(f"timeout_seconds must be >= 0, got {timeout_seconds}")
    if poll_interval <= 0:
        raise ValueError(f"poll_interval must be > 0, got {poll_interval}")
    deadline = time.monotonic() + timeout_seconds
    while True:
        snapshot = read_task_result_via_api(
            project_dir,
            task_type=task_type,
            episode_num=episode_num,
            scope=scope,
            beat_num=beat_num,
            require_terminal=False,
        )
        if snapshot.get("status") in {"completed", "failed"}:
            return snapshot
        if time.monotonic() >= deadline:
            project = _project_name(project_dir)
            raise TimeoutError(
                f"Timed out waiting for {task_type}/{project}/ep{episode_num} scope={scope or '-'}"
            )
        time.sleep(poll_interval)
