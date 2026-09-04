from types import SimpleNamespace

import pytest

from novelvideo.freezone.workflow_drafts import (
    bind_workflow_draft_task,
    claim_workflow_draft_confirmation,
    create_workflow_draft,
    finish_workflow_draft_confirmation,
    read_workflow_draft,
)
from novelvideo.task_backend.runners import freezone as freezone_runner


def _compiled() -> dict:
    return {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {"summary": "广告", "nodes": [], "edges": [], "phases": []},
    }


def _claimed_task(tmp_path, *, started_at: float = 1_000) -> tuple[dict, dict]:
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
    )
    claimed, error = claim_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        revision=1,
        now=started_at,
    )
    assert error is None
    assert claimed is not None
    bound = bind_workflow_draft_task(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        task_id="task-1",
        root_task_id="task-1",
    )
    assert bound is not None
    envelope = {
        "task_type": "freezone_workflow_confirm",
        "__run_task_id": "task-1",
        "payload": {
            "canvas_id": "default",
            "draft_id": draft["draft_id"],
            "revision": 1,
            "plan_digest": draft["plan_digest"],
        },
    }
    return draft, envelope


@pytest.mark.asyncio
async def test_workflow_confirmation_task_accepts_late_canvas_success(
    tmp_path,
    monkeypatch,
) -> None:
    draft, envelope = _claimed_task(tmp_path, started_at=1_000)
    sleep_calls = 0

    async def resolve_after_wait(_seconds: float) -> None:
        nonlocal sleep_calls
        sleep_calls += 1
        finish_workflow_draft_confirmation(
            project_dir=tmp_path,
            canvas_id="default",
            draft_id=draft["draft_id"],
            outcome="confirmed",
            expected_task_id="task-1",
        )

    monkeypatch.setattr(freezone_runner.asyncio, "sleep", resolve_after_wait)

    result = await freezone_runner._run_freezone_workflow_confirm_async(
        envelope,
        SimpleNamespace(state_dir=tmp_path),
    )

    assert sleep_calls == 1
    assert result["delivery_status"] == "canvas_applied"


@pytest.mark.asyncio
async def test_workflow_confirmation_task_fails_only_from_canvas_outcome(
    tmp_path,
) -> None:
    draft, envelope = _claimed_task(tmp_path)
    finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="ready",
        expected_task_id="task-1",
    )

    with pytest.raises(RuntimeError, match="not delivered"):
        await freezone_runner._run_freezone_workflow_confirm_async(
            envelope,
            SimpleNamespace(state_dir=tmp_path),
        )


@pytest.mark.asyncio
async def test_workflow_confirmation_task_recovers_confirmed_result_after_restart(
    tmp_path,
) -> None:
    draft, envelope = _claimed_task(tmp_path)
    finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="confirmed",
        expected_task_id="task-1",
    )

    result = await freezone_runner._run_freezone_workflow_confirm_async(
        envelope,
        SimpleNamespace(state_dir=tmp_path),
    )
    stored, error = read_workflow_draft(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
    )

    assert error is None
    assert stored is not None
    assert stored["status"] == "confirmed"
    assert result["draft_id"] == draft["draft_id"]
