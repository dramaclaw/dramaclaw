"""图谱构建任务的进度上报语义。

图谱构建的 on_log 回调本身不带进度。早期实现用 0.0 占位调 _progress,于是
每来一行普通日志进度都被打回 0,前端进度条呈现 10% → 0% → 80% → 0% 的反复
倒退。日志行必须传 progress=None,让任务状态保留原有进度。
"""

from pathlib import Path

import pytest

from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskStateManager

pytestmark = pytest.mark.m07


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_graph_build",
        project_name="demo",
        owner_type="user",
        owner_id="owner",
        owner_username="alice",
        requester_user_id="editor",
        requester_username="bob",
        requester_principals=(("user", "editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


class _RecordingTaskManager:
    def __init__(self) -> None:
        self.updates: list[dict] = []

    def update_progress_for_project(self, ctx, task_type, episode, **kwargs):
        self.updates.append({"task_type": task_type, "episode": episode, **kwargs})


class _FakeStore:
    """按真实调用顺序交替吐进度和日志。"""

    def __init__(self) -> None:
        self.closed = False

    async def _emit(self, on_progress, on_log):
        on_progress(0.1, "读取图谱")
        on_log("命中缓存")
        on_progress(0.8, "写入数据库")
        on_log("跳过 3 条重复记录")
        return [{"name": "a"}]

    async def build_scenes_from_graph(self, on_progress, on_log):
        return await self._emit(on_progress, on_log)

    async def build_characters_from_graph(self, on_progress, on_log):
        return await self._emit(on_progress, on_log)

    async def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize(
    ("runner_name", "task_type"),
    [
        ("_run_build_scenes", "build_scenes"),
        ("_run_build_characters", "build_characters"),
    ],
)
async def test_log_updates_do_not_reset_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    runner_name: str,
    task_type: str,
) -> None:
    from novelvideo.task_backend.runners import graph_build

    manager = _RecordingTaskManager()
    store = _FakeStore()

    async def fake_load_store(_ctx):
        return store

    monkeypatch.setattr(graph_build, "get_task_manager", lambda: manager)
    monkeypatch.setattr(graph_build, "_load_store", fake_load_store)
    monkeypatch.setattr(graph_build, "require_imported_novel", lambda _dir: None)

    await getattr(graph_build, runner_name)(_ctx(tmp_path))

    assert store.closed
    assert [u["task_type"] for u in manager.updates] == [task_type] * 4
    # 关键断言:日志行传 None(保留原进度),而不是 0.0(把进度打回原点)。
    assert [u["progress"] for u in manager.updates] == [0.1, None, 0.8, None]
    # 步骤文案和日志仍照常更新。
    assert [u["current_task"] for u in manager.updates] == [
        "读取图谱",
        "命中缓存",
        "写入数据库",
        "跳过 3 条重复记录",
    ]


def test_update_progress_with_none_keeps_stored_progress(tmp_path: Path) -> None:
    """runner 依赖的 manager 侧契约:progress=None 不动已存进度。"""
    manager = TaskStateManager()
    ctx = _ctx(tmp_path)
    manager.create_task_for_project(ctx, "build_scenes", 0)
    manager.update_progress_for_project(
        ctx, "build_scenes", 0, progress=0.8, current_task="写入数据库"
    )

    manager.update_progress_for_project(
        ctx, "build_scenes", 0, progress=None, current_task="跳过 3 条重复记录"
    )

    task = manager.get_task_for_project(ctx, "build_scenes", 0)
    assert task is not None
    assert task.progress == 0.8
    assert task.current_task == "跳过 3 条重复记录"
