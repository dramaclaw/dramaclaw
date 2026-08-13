"""Fast graph ingest progress reporting contracts."""

from pathlib import Path

import pytest

from novelvideo.project_context import ProjectContext

pytestmark = pytest.mark.m07


def test_ingest_store_progress_milestones_are_strictly_increasing() -> None:
    from novelvideo.cognee.store import INGEST_PROGRESS_MILESTONES

    milestones = list(INGEST_PROGRESS_MILESTONES.values())
    assert milestones == sorted(set(milestones))
    assert milestones[0] > 0
    assert milestones[-1] == 1.0


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_ingest",
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
    instance: "_FakeStore | None" = None

    def __init__(self, *args, **kwargs) -> None:
        self.initialized = False
        self.closed = False
        type(self).instance = self

    async def initialize(self) -> None:
        self.initialized = True

    async def ingest_novel_fast(
        self, novel_path, rebuild=False, spine_template=None, on_progress=None, on_log=None
    ):
        on_progress(0.02, "读取并校验原文...")
        on_log("文件读取完成")
        on_progress(0.3, "构建知识图谱...")
        on_log("正在处理实体")
        on_progress(0.7, "创建向量索引...")
        on_log("正在写入索引")
        on_progress(1.0, "导入完成")
        return {"status": "graph_ready"}

    async def close(self) -> None:
        self.closed = True


async def test_ingest_logs_preserve_intermediate_progress(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ordinary Cognee logs must not send the progress bar back to zero."""
    from novelvideo import cognee
    from novelvideo.task_backend.runners import ingest

    manager = _RecordingTaskManager()
    monkeypatch.setattr(ingest, "get_task_manager", lambda: manager)
    monkeypatch.setattr(cognee, "CogneeStore", _FakeStore)

    result = await ingest._run_ingest_fast(
        {"payload": {"novel_path": str(tmp_path / "novel.txt")}}, _ctx(tmp_path)
    )

    assert result == {"status": "graph_ready"}
    assert _FakeStore.instance is not None
    assert _FakeStore.instance.initialized
    assert _FakeStore.instance.closed
    assert [update["progress"] for update in manager.updates] == [
        0.02,
        None,
        0.3,
        None,
        0.7,
        None,
        1.0,
    ]
    assert [
        update["progress"] for update in manager.updates if update["progress"] is not None
    ] == sorted(
        update["progress"]
        for update in manager.updates
        if update["progress"] is not None
    )
