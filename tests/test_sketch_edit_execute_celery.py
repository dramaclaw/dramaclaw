from __future__ import annotations

import json
from types import SimpleNamespace

import pytest


def _write_valid_labels(project_dir, episode_num: int = 1) -> None:
    reports_dir = project_dir / "verify_reports" / f"ep{episode_num:03d}"
    reports_dir.mkdir(parents=True)
    row = {
        "project_dir": str(project_dir),
        "episode_num": episode_num,
        "beat_number": 1,
        "execution_mode": "polish",
        "sketch_path": str(project_dir / "sketches" / "ep001" / "beat_01.png"),
        "beat": {"beat_number": 1},
        "sketch_colors": [],
        "result": {
            "decision": "revise",
            "main_problem": "composition_weak",
            "reasoning": "构图需要更清楚。",
            "edit_instruction": "调整构图，让主体动作更清楚。",
            "confidence": 0.9,
        },
        "raw_text": "",
    }
    (reports_dir / "labels.jsonl").write_text(
        json.dumps(row, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_start_sketch_edit_execute_enqueues_project_task(tmp_path, monkeypatch):
    from novelvideo.verification import routes
    from novelvideo.verification.schemas import SketchEditExecuteRequest

    _write_valid_labels(tmp_path)
    ctx = SimpleNamespace(
        project_id="proj",
        owner_username="alice",
        project_name="demo",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
    )
    calls: list[dict] = []

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert project == "proj"
        assert required_role == "editor"
        assert user == {"username": "alice"}
        return SimpleNamespace(
            ctx=ctx,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    async def fake_enqueue_project_task(ctx_arg, **kwargs):
        assert ctx_arg is ctx
        calls.append(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-1"),
            backend="celery",
            queue=kwargs.get("queue_kind") or "default",
        )

    monkeypatch.setattr(routes, "resolve_project_scope", fake_resolve_project_scope, raising=False)
    monkeypatch.setattr(
        routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    result = await routes.start_sketch_edit_execute(
        "proj",
        1,
        SketchEditExecuteRequest(),
        {"username": "alice"},
    )

    assert result["ok"] is True
    assert result["task_type"] == "sketch_edit_execute"
    assert result["task_id"] == "task-1"
    assert result["backend"] == "celery"
    assert calls[0]["task_type"] == "sketch_edit_execute"
    # TCP-P55: "sketch" was never a lane in QUEUE_KINDS; this assertion mirrored
    # the literal at verification/routes.py:210 and kept it invisible because the
    # backend is mocked here. "default" is the lane this endpoint actually used.
    assert calls[0]["queue_kind"] == "default"
    assert calls[0]["episode"] == 1
    assert calls[0]["payload"] == {
        "episode": 1,
        "project_dir": str(tmp_path),
        "labels_name": "labels.jsonl",
    }


def test_sketch_edit_execute_runner_calls_existing_executor(tmp_path, monkeypatch):
    from novelvideo.task_backend.registry import get_project_task_runner
    import novelvideo.task_backend.runners.sketch_edit_execute as runner_module

    _write_valid_labels(tmp_path)
    calls: list[dict] = []

    def fake_execute_sketch_edit_batches(**kwargs):
        calls.append(kwargs)
        kwargs["progress_callback"](0.5, "执行中")
        kwargs["log_callback"]("完成")
        return {"updated_beats": [1], "summary_path": "summary.json"}

    monkeypatch.setattr(
        runner_module,
        "execute_sketch_edit_batches",
        fake_execute_sketch_edit_batches,
    )
    progress_updates: list[dict] = []
    monkeypatch.setattr(
        runner_module,
        "get_task_manager",
        lambda: SimpleNamespace(
            update_progress_for_project=lambda *_args, **kwargs: progress_updates.append(kwargs)
        ),
    )
    ctx = SimpleNamespace(project_id="proj", output_dir=tmp_path)
    task_runner = get_project_task_runner("sketch_edit_execute")

    result = task_runner(
        {
            "payload": {
                "project_dir": str(tmp_path),
                "episode": 1,
                "labels_name": "labels.jsonl",
            },
            "scope": "edit_execute__abc",
        },
        ctx,
    )

    assert result == {"updated_beats": [1], "summary_path": "summary.json"}
    assert calls[0]["project_dir"] == tmp_path
    assert calls[0]["episode_num"] == 1
    assert calls[0]["labels_path"] == (tmp_path / "verify_reports" / "ep001" / "labels.jsonl")
    assert [update["progress"] for update in progress_updates] == [0.01, 0.5, None]
