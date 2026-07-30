from pathlib import Path

import pytest

from novelvideo.project_context import ProjectContext


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="alice",
        requester_user_id="user_editor",
        requester_username="bob",
        requester_principals=(("user", "user_editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=True,
    )


@pytest.mark.asyncio
async def test_director_control_to_sketch_runner_logs_to_dedicated_task(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.director_world import control_frame_to_sketch
    from novelvideo.task_backend.runners import sketch as sketch_runner

    ctx = _ctx(tmp_path)
    control_frame = (
        ctx.output_dir / "director_control_frames" / "ep002" / "beat_03" / "combined.png"
    )
    control_frame.parent.mkdir(parents=True, exist_ok=True)
    control_frame.write_bytes(b"fake png")
    promoted_sketch = ctx.output_dir / "sketches" / "ep002" / "beat_03.png"

    class FakeTaskManager:
        def __init__(self) -> None:
            self.updates: list[dict] = []

        def update_progress_for_project(self, ctx_arg, task_type, episode, **kwargs):
            self.updates.append(
                {
                    "ctx": ctx_arg,
                    "task_type": task_type,
                    "episode": episode,
                    **kwargs,
                }
            )

    manager = FakeTaskManager()

    async def fake_convert_control_frame_to_sketch(**_kwargs):
        return {"promoted_sketch": str(promoted_sketch)}

    monkeypatch.setattr(sketch_runner, "get_task_manager", lambda: manager)
    monkeypatch.setattr(
        control_frame_to_sketch,
        "convert_control_frame_to_sketch",
        fake_convert_control_frame_to_sketch,
    )

    result = await sketch_runner._run_control_frame_to_sketch_async(
        {
            "task_type": "director_control_to_sketch",
            "episode": 2,
            "beat_num": 3,
            "scope": "director_control_to_sketch:ep002:beat_03",
            "payload": {"output_dir": str(ctx.output_dir), "state_dir": str(ctx.state_dir)},
        },
        ctx,
    )

    assert result["sketch_path"] == str(promoted_sketch)
    assert result["beat_numbers"] == [3]
    assert [update["task_type"] for update in manager.updates] == [
        "director_control_to_sketch",
        "director_control_to_sketch",
        "director_control_to_sketch",
    ]
    assert [update["current_task"] for update in manager.updates] == [
        "开始 Beat 3 Direct Render 转草图...",
        "提交图像模型生成草图...",
        f"草图已写入: {promoted_sketch}",
    ]
