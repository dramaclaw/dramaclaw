from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from novelvideo.freezone.workflow_drafts import (
    claim_workflow_draft_confirmation,
    create_workflow_draft,
    finish_workflow_draft_confirmation,
    patch_workflow_draft,
    read_workflow_draft,
    set_workflow_draft_billing,
    workflow_drafts_db_path,
)


def _compiled(*, item_count: int = 1) -> dict:
    return {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": max(item_count - 1, 0),
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": ["视频"],
            "nodes": [
                {
                    "id": f"shot-{index + 1}",
                    "name": f"镜头 {index + 1}",
                    "node_type": "videoNode",
                    "stage": "video",
                }
                for index in range(item_count)
            ],
            "edges": [],
        },
    }


def test_workflow_draft_lifecycle_uses_project_database(tmp_path: Path) -> None:
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告", "items": ["开场"]},
        compiled=_compiled(),
        run_after_create=True,
    )

    patched, error = patch_workflow_draft(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        expected_revision=1,
        intent={
            "skill_id": "video-ad",
            "user_goal": "广告",
            "items": ["开场", "收尾"],
        },
        compiled=_compiled(item_count=2),
        last_changes={"items": ["开场", "收尾"]},
    )

    assert error is None
    assert patched is not None
    assert patched["revision"] == 2
    assert patched["preview"]["node_count"] == 2
    assert patched["run_after_create"] is True

    claimed, claim_error = claim_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        revision=2,
    )
    assert claim_error is None
    assert claimed is not None
    assert claimed["status"] == "confirming"

    finished = finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="confirmed",
    )
    assert finished is not None
    assert finished["status"] == "confirmed"
    assert workflow_drafts_db_path(tmp_path).is_file()
    assert not (tmp_path / "workflow_drafts").exists()


def test_workflow_draft_persists_agent_billing_reservation(tmp_path: Path) -> None:
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
    )

    updated = set_workflow_draft_billing(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        billing={"reservation_id": "reservation-1", "status": "reserved"},
    )
    stored, error = read_workflow_draft(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
    )

    assert updated is not None
    assert error is None
    assert stored is not None
    assert stored["billing"] == {
        "reservation_id": "reservation-1",
        "status": "reserved",
    }


def test_workflow_draft_rejects_stale_patch(tmp_path: Path) -> None:
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
    )

    patched, error = patch_workflow_draft(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        expected_revision=2,
        intent=draft["intent"],
        compiled=draft["compiled"],
    )

    assert patched is None
    assert error is not None
    assert error["status"] == "workflow_draft_revision_conflict"


def test_workflow_draft_confirmation_is_atomic(tmp_path: Path) -> None:
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
    )

    def claim():
        return claim_workflow_draft_confirmation(
            project_dir=tmp_path,
            canvas_id="default",
            draft_id=draft["draft_id"],
            revision=1,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: claim(), range(2)))

    claimed = [
        payload for payload, error in results if payload is not None and error is None
    ]
    rejected = [
        error for payload, error in results if payload is None and error is not None
    ]
    assert len(claimed) == 1
    assert rejected[0]["status"] == "workflow_draft_confirmation_in_progress"


def test_submitted_workflow_draft_is_not_claimed_again(tmp_path: Path) -> None:
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
    )
    claim_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        revision=1,
    )
    finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="submitted",
    )

    claimed, error = claim_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        revision=1,
    )

    assert claimed is None
    assert error is not None
    assert error["status"] == "workflow_draft_confirmation_in_progress"


def test_confirmed_workflow_draft_is_not_claimed_twice(tmp_path: Path) -> None:
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
    )
    finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="confirmed",
    )

    claimed, error = claim_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        revision=1,
    )

    assert claimed is None
    assert error is not None
    assert error["status"] == "workflow_draft_already_confirmed"
    stored, read_error = read_workflow_draft(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
    )
    assert read_error is None
    assert stored is not None
    assert stored["status"] == "confirmed"


def test_create_workflow_draft_is_idempotent_for_billing_quote(tmp_path: Path) -> None:
    first = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
        billing_quote_id="billing_quote_a",
    )
    repeated = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "广告"},
        compiled=_compiled(),
        billing_quote_id="billing_quote_a",
    )

    assert repeated["draft_id"] == first["draft_id"]
