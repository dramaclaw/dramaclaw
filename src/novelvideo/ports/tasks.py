"""Task backend and cancellation ports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class QueuedTask:
    task_state: Any
    backend: str
    queue: str | None = None
    celery_id: str | None = None


def _selected_beat_numbers(payload: dict[str, Any]) -> list[int]:
    """把入队 payload 里的选中 beat 号挖出来，去重保序。

    选中 Beats 再生（``sketch_regen`` / ``selected_regen``）把 beat 列表放在
    ``payload["config"]["selected_beat_numbers"]``，个别调用方放在顶层，两处都认。
    """
    for container in (payload, payload.get("config")):
        if not isinstance(container, dict):
            continue
        raw = container.get("selected_beat_numbers")
        if not isinstance(raw, (list, tuple)):
            continue
        seen: set[int] = set()
        beats: list[int] = []
        for value in raw:
            try:
                beat = int(value)
            except (TypeError, ValueError):
                continue
            if beat in seen:
                continue
            seen.add(beat)
            beats.append(beat)
        if beats:
            return beats
    return []


def display_metadata_for_task(task_type: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    if not payload:
        return {}
    metadata: dict[str, Any] = {}

    for key in (
        "display_name",
        "task_label",
        "task_family",
        "source_label",
        "target_label",
        "canvas_id",
        "node_id",
        "skill_id",
        "batch_id",
        "batch_size",
    ):
        value = str(payload.get(key) or "").strip()
        if value:
            metadata[key] = value

    # 布尔标记不能进上面那个字符串循环：str(False) == "False" 是真值，
    # 一路 strip 下来会变成字符串 "False" 存进 metadata，_serialize_task 再
    # bool() 一下就成了 True——用户自定义名反而被判成可本地化，正好搞反。
    if payload.get("display_name_user_content") is True:
        metadata["display_name_user_content"] = True

    if task_type == "stage_asset":
        for key in ("scene_name", "step"):
            value = str(payload.get(key) or "").strip()
            if value:
                metadata[key] = value

    # 选中 Beats 再生的任务行 beat_num 是 None，scope 又是 mode_key + beats 的
    # sha1，前端反推不出来。不留下这份名单的话，每个 beat 的草图 / 渲染图面板都会
    # 认领同一条任务，一个 beat 在跑、整集都在转圈。
    beat_numbers = _selected_beat_numbers(payload)
    if beat_numbers:
        metadata["beat_numbers"] = beat_numbers
    return metadata


def cancel_key(
    *,
    project_id: str,
    task_type: str,
    episode: int,
    task_id: str,
    beat_num: int | None = None,
    scope: str | None = None,
) -> str:
    parts = ["task", "cancel", project_id, task_type, str(episode)]
    if beat_num is not None:
        parts.append(str(beat_num))
    if scope:
        parts.append(str(scope))
    parts.append(str(task_id))
    return ":".join(parts)


class TaskBackend(Protocol):
    async def enqueue_project_task(
        self,
        ctx,
        *,
        task_type: str,
        product_surface: str,
        queue_kind: str = "default",
        episode: int = 0,
        beat_num: int | None = None,
        scope: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> QueuedTask: ...

    async def cancel_project_task(
        self,
        ctx,
        task_state,
        *,
        force: bool = False,
        acknowledge_no_refund: bool = False,
    ) -> dict[str, Any]: ...


class CancellationStore(Protocol):
    async def request_cancel(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
        ttl_seconds: int = 86_400,
    ) -> None: ...

    async def is_cancel_requested(
        self,
        *,
        project_id: str,
        task_type: str,
        episode: int,
        task_id: str,
        beat_num: int | None = None,
        scope: str | None = None,
    ) -> bool: ...
