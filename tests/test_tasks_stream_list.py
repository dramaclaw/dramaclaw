from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from novelvideo.project_context import ProjectContext

pytestmark = pytest.mark.m07


def _ctx(tmp_path: Path, *, role: str = "viewer") -> ProjectContext:
    return ProjectContext(
        project_id="proj_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="admin",
        requester_user_id="user_viewer",
        requester_username="admin",
        requester_principals=(("user", "user_viewer"),),
        effective_role=role,
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=True,
    )


def _install_fake_project_context(monkeypatch, ctx: ProjectContext) -> None:
    from novelvideo.api.routes import tasks as tasks_routes

    async def fake_resolve_project_context(**kwargs):
        assert kwargs["project_id"] == ctx.project_id
        return ctx

    monkeypatch.setattr(tasks_routes, "resolve_project_context", fake_resolve_project_context)


def _install_fake_task_manager(monkeypatch, tasks=None, task=None) -> None:
    from novelvideo.api.routes import tasks as tasks_routes

    class _FakeTaskManager:
        def __init__(self, payload, single):
            self._payload = payload or []
            self._single = single

        def list_tasks_for_project(self, ctx):
            return list(self._payload)

        def get_task_for_project(self, ctx, task_type, episode, beat_num=None, scope=None):
            return self._single

    monkeypatch.setattr(tasks_routes, "get_task_manager", lambda: _FakeTaskManager(tasks, task))


def test_stage_asset_task_display_name_includes_scene_and_step():
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    task = TaskState(
        task_id="task-1",
        task_type="stage_asset",
        project_id="proj_123",
        episode=0,
        scope="stage_asset__hash",
        status="queued",
        metadata={"scene_name": "咖啡馆", "step": "pano_from_master"},
    )

    payload = _serialize_task(task)

    assert payload["task_type_label"] == "场景资产"
    assert payload["display_name"] == "场景资产 · 咖啡馆 · Master 生成全景"


def test_backend_authored_display_name_stays_localizable():
    """freezone / scripts 传的 display_name 是系统写死的中文，不是业务内容。

    review #447：这里一度写成「metadata 里有 display_name 就 localizable=False」，
    于是 "生成草图 · EP1 / Beat 3" 被当成用户自定义名，前端 displayLabel 原样透出，
    英文界面的任务中心、完成通知和伙伴气泡继续显示中文。
    """
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    task = TaskState(
        task_id="task-1",
        task_type="sketch_regen",
        project_id="proj_123",
        episode=1,
        beat_num=3,
        status="queued",
        # freezone.py:2053 的真实形状
        metadata={
            "task_family": "mainline_skill",
            "task_label": "生成草图",
            "display_name": "生成草图 · EP1 / Beat 3",
        },
    )

    payload = _serialize_task(task)

    assert payload["display_name"] == "生成草图 · EP1 / Beat 3"
    assert payload["display_name_localizable"] is True


def test_user_authored_display_name_opts_out_of_localization():
    """真正的用户自定义名称由生产者显式标记退出本地化，翻译它反而是错的。"""
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    task = TaskState(
        task_id="task-2",
        task_type="freezone_gen",
        project_id="proj_123",
        episode=0,
        status="queued",
        metadata={"display_name": "雨夜巷口 · 第二版", "display_name_user_content": True},
    )

    payload = _serialize_task(task)

    assert payload["display_name"] == "雨夜巷口 · 第二版"
    assert payload["display_name_localizable"] is False


def test_user_content_flag_survives_the_real_enqueue_projection():
    """走真实链路：display_metadata_for_task → TaskState → _serialize_task。

    review #447 复审：opt-out 标记只在 _serialize_task 里读是不够的，入队时
    display_metadata_for_task 的投影白名单会把它丢掉，标记等于形同虚设。
    """
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.ports.tasks import display_metadata_for_task
    from novelvideo.task_state import TaskState

    payload = {
        "display_name": "雨夜巷口 · 第二版",
        "display_name_user_content": True,
        "task_label": "自由生成图片",
    }
    metadata = display_metadata_for_task("freezone_gen", payload)

    assert metadata["display_name_user_content"] is True

    payload_out = _serialize_task(
        TaskState(
            task_id="task-3",
            task_type="freezone_gen",
            project_id="proj_123",
            episode=0,
            status="queued",
            metadata=metadata,
        )
    )
    assert payload_out["display_name_localizable"] is False


def test_user_content_flag_is_not_coerced_through_the_string_loop():
    """标记必须是布尔投影：str(False) == "False" 是真值，会把判断整个反过来。"""
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.ports.tasks import display_metadata_for_task
    from novelvideo.task_state import TaskState

    for falsy in (False, None, "", 0):
        metadata = display_metadata_for_task(
            "freezone_gen",
            {"display_name": "生成草图 · EP1 / Beat 3", "display_name_user_content": falsy},
        )
        assert "display_name_user_content" not in metadata, falsy
        payload = _serialize_task(
            TaskState(
                task_id="task-4",
                task_type="freezone_gen",
                project_id="proj_123",
                episode=1,
                status="queued",
                metadata=metadata,
            )
        )
        assert payload["display_name_localizable"] is True, falsy


def test_serialize_task_rewrites_internal_result_paths_to_project_static_urls(tmp_path):
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    output_path = project_dir / "freezone" / "_outputs" / "freezone_gen" / "job.png"
    frame_path = project_dir / "freezone" / "_outputs" / "freezone_extract" / "frame_001.png"
    last_frame_path = project_dir / "videos" / "beats" / "ep001" / "last.png"
    for path in (output_path, frame_path, last_frame_path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"asset")

    task = TaskState(
        task_id="task-1",
        task_type="freezone_gen",
        project_id=ctx.project_id,
        episode=0,
        scope="job",
        status="completed",
        result={
            "output_path": str(output_path),
            "frame_paths": [str(frame_path)],
            "nested": {"last_frame_path": str(last_frame_path)},
            "target_path": "director_control_frames/ep001/beat_01/combined.png",
            "public_path": "/static/projects/proj_123/freezone/_outputs/public.png",
        },
    )

    payload = _serialize_task(task, ctx=ctx)
    result = payload["result"]

    assert "output_path" not in result
    assert "frame_paths" not in result
    assert "last_frame_path" not in result["nested"]
    assert result["target_path"] == "director_control_frames/ep001/beat_01/combined.png"
    assert result["output_url"].startswith("/static/projects/proj_123/freezone/_outputs/")
    assert result["frame_urls"][0].startswith("/static/projects/proj_123/freezone/_outputs/")
    assert result["nested"]["last_frame_url"].startswith("/static/projects/proj_123/videos/")
    assert result["public_path"] == "/static/projects/proj_123/freezone/_outputs/public.png"
    assert "/admin/demo/" not in str(result)


@pytest.mark.asyncio
async def test_project_stream_emits_heartbeat_immediately(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    _install_fake_project_context(monkeypatch, ctx)
    _install_fake_task_manager(monkeypatch, tasks=[])

    from novelvideo.api.routes.tasks import stream_project_tasks

    resp = await stream_project_tasks(
        project=ctx.project_id,
        request=None,  # type: ignore[arg-type]
        interval=0.5,
        heartbeat_sec=1.0,
        snapshot=False,
        user={"username": "admin", "role": "admin"},
    )

    gen = resp.body_iterator
    try:
        first = await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    finally:
        aclose = getattr(gen, "aclose", None)
        if aclose is not None:
            await aclose()

    assert isinstance(first, dict)
    assert first.get("event") == "heartbeat"
    assert "ts" in json.loads(first["data"])


@pytest.mark.asyncio
async def test_project_stream_rejects_missing_auth():
    from novelvideo.api import api_router
    from novelvideo.ports import registry

    old_ports = dict(registry._PORTS)
    old_bootstrapped = registry._BOOTSTRAPPED
    registry._PORTS.clear()
    registry._BOOTSTRAPPED = False

    app = FastAPI()
    app.include_router(api_router)
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/projects/proj_123/tasks/stream")
    finally:
        registry._PORTS.clear()
        registry._PORTS.update(old_ports)
        registry._BOOTSTRAPPED = old_bootstrapped

    assert response.status_code in (401, 403, 422, 503)
    if response.status_code == 503:
        assert response.json()["detail"] == "auth backend not initialised"


@pytest.mark.asyncio
async def test_project_task_stream_includes_logs(tmp_path, monkeypatch):
    from novelvideo.task_state import TaskState

    ctx = _ctx(tmp_path)
    _install_fake_project_context(monkeypatch, ctx)
    _install_fake_task_manager(
        monkeypatch,
        task=TaskState(
            task_id="t1",
            task_type="sketch_regen",
            username="admin",
            project="demo",
            project_id=ctx.project_id,
            episode=1,
            scope="scope-a",
            status="running",
            progress=0.5,
            current_task="生成草图中",
            logs=["start", "step"],
        ),
    )

    from novelvideo.api.routes.tasks import stream_project_task

    resp = await stream_project_task(
        project=ctx.project_id,
        task_type="sketch_regen",
        episode=1,
        request=None,  # type: ignore[arg-type]
        scope="scope-a",
        interval=0.5,
        user={"username": "admin", "role": "admin"},
    )

    gen = resp.body_iterator
    try:
        first = await asyncio.wait_for(gen.__anext__(), timeout=3.0)
    finally:
        aclose = getattr(gen, "aclose", None)
        if aclose is not None:
            await aclose()

    payload = json.loads(first["data"])
    assert payload["logs"] == ["start", "step"]
