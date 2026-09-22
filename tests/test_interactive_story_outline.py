"""Pending story outline contract: save/read, conflicts, idempotency and linking.

The pending outline lives in canvas-level metadata and must never disturb the
story projection, other metadata keys, or the confirmation semantics:
content changes reset confirmation while identical re-saves stay safe.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.interactive_story.models import (
    ConfirmStoryOutlineRequest,
    CreateInteractiveStoryRequest,
    PendingStoryOutline,
    SaveStoryOutlineRequest,
    StoryDraftV2,
)
from novelvideo.interactive_story.service import (
    PENDING_OUTLINE_METADATA_KEY,
    InteractiveStoryService,
    InteractiveStoryServiceError,
)

EXAMPLE_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "interactive_story"
    / "story_draft_v2.json"
)


@pytest.fixture
def story() -> StoryDraftV2:
    return StoryDraftV2.model_validate_json(EXAMPLE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def service(tmp_path: Path) -> InteractiveStoryService:
    return InteractiveStoryService(
        tmp_path / "project", project_id="project-1", actor_id="user-1"
    )


def outline_payload(**changes) -> dict:
    base = {
        "outline_id": "outline-round-1",
        "kind": "story",
        "title": "雨夜出租车",
        "premise": "改编短片：出租车司机在雨夜接到一位自称来自十年前的乘客。",
        "plot_summary": "三幕：接载—试探—抉择；两条主要分支在加油站汇合。",
        "interaction_summary": "两个选择点：是否回头、是否下车。",
        "endings_summary": "默认双结局：留下或离开。",
        "duration_budget_sec": 240,
        "open_questions": ["画风默认写实冷调，待确认"],
    }
    base.update(changes)
    return base


def save_request(service: InteractiveStoryService, *, key: str, base_revision: int, **changes):
    return SaveStoryOutlineRequest(
        canvas_id="default",
        base_revision=base_revision,
        idempotency_key=key,
        outline=PendingStoryOutline.model_validate(outline_payload(**changes)),
    )


def test_save_and_read_round_trip_sets_pending_status_and_timestamp(
    service: InteractiveStoryService,
) -> None:
    result = service.save_outline(save_request(service, key="outline-save-0001", base_revision=0))
    assert result.ok is True
    assert result.revision == 1
    assert result.status == "pending"
    assert result.refresh_canvas is True

    read = service.get_outline("default")
    assert read.outline is not None
    assert read.outline.outline_id == "outline-round-1"
    assert read.outline.status == "pending"
    assert read.outline.updated_at
    assert read.revision == 1


def test_missing_canvas_reads_as_empty_outline(service: InteractiveStoryService) -> None:
    read = service.get_outline("default")
    assert read.outline is None
    assert read.revision == 0


def test_save_preserves_nodes_edges_and_other_metadata_keys(
    service: InteractiveStoryService,
) -> None:
    canvas = canvas_store.default_canvas_payload(project_id="project-1", actor_id="user-1")
    canvas["nodes"] = [{"id": "n1", "type": "videoNode", "data": {"label": "既有节点"}}]
    canvas["edges"] = []
    canvas["metadata"] = {"preset": {"scope": "free"}, "shotMetadata": {"angle": "low"}}
    canvas_store.save_canvas(
        service.project_dir,
        "default",
        base_revision=0,
        build_payload=lambda _: canvas,
        client_save_id="outline-seed-0001",
    )

    service.save_outline(save_request(service, key="outline-save-0002", base_revision=1))

    saved = canvas_store.read_canvas(service.project_dir, "default")
    assert saved["nodes"] == canvas["nodes"]
    assert saved["metadata"]["preset"] == {"scope": "free"}
    assert saved["metadata"]["shotMetadata"] == {"angle": "low"}
    assert saved["metadata"][PENDING_OUTLINE_METADATA_KEY]["outline_id"] == "outline-round-1"


def test_revision_conflict_surfaces_current_revision(
    service: InteractiveStoryService,
) -> None:
    service.save_outline(save_request(service, key="outline-save-0003", base_revision=0))
    with pytest.raises(InteractiveStoryServiceError) as exc:
        service.save_outline(save_request(service, key="outline-save-0004", base_revision=0))
    assert exc.value.code == "revision_conflict"
    # 409 的 current_revision 可直接作为重试 base（画布冲突重试规范）。
    assert exc.value.current_revision == 1

    retried = service.save_outline(
        save_request(
            service,
            key="outline-save-0005",
            base_revision=exc.value.current_revision,
            title="雨夜出租车（改）",
        )
    )
    assert retried.revision == 2


def test_idempotent_replay_and_conflict(service: InteractiveStoryService) -> None:
    first = service.save_outline(save_request(service, key="outline-idem-0001", base_revision=0))
    replay = service.save_outline(save_request(service, key="outline-idem-0001", base_revision=0))
    assert replay.idempotent is True
    assert replay.revision == first.revision
    assert canvas_store.read_canvas(service.project_dir, "default")["revision"] == 1

    with pytest.raises(InteractiveStoryServiceError) as exc:
        service.save_outline(
            save_request(service, key="outline-idem-0001", base_revision=1, title="同键不同内容")
        )
    assert exc.value.code == "idempotency_conflict"


def test_confirmation_resets_only_on_content_change(
    service: InteractiveStoryService,
) -> None:
    service.save_outline(save_request(service, key="outline-reset-0001", base_revision=0))
    confirmed = service.confirm_outline(
        ConfirmStoryOutlineRequest(
            canvas_id="default",
            outline_id="outline-round-1",
            status="confirmed",
            base_revision=1,
            idempotency_key="outline-confirm-0001",
        )
    )
    assert confirmed.status == "confirmed"
    assert confirmed.revision == 2

    # 同内容重存（安全重试）保持已确认状态。
    kept = service.save_outline(save_request(service, key="outline-reset-0002", base_revision=2))
    assert kept.status == "confirmed"

    changed = service.save_outline(
        save_request(service, key="outline-reset-0003", base_revision=3, plot_summary="改成四幕结构。")
    )
    assert changed.status == "pending"
    read = service.get_outline("default")
    assert read.outline is not None
    assert read.outline.plot_summary == "改成四幕结构。"


def test_agent_cannot_self_confirm(service: InteractiveStoryService) -> None:
    result = service.save_outline(
        save_request(service, key="outline-forge-0001", base_revision=0, status="confirmed")
    )
    assert result.status == "pending"


def test_confirm_requires_matching_pending_outline(
    service: InteractiveStoryService,
) -> None:
    with pytest.raises(InteractiveStoryServiceError) as exc:
        service.confirm_outline(
            ConfirmStoryOutlineRequest(
                canvas_id="default",
                outline_id="outline-none",
                status="confirmed",
                base_revision=0,
                idempotency_key="outline-confirm-0002",
            )
        )
    assert exc.value.code == "outline_not_found"

    service.save_outline(save_request(service, key="outline-confirm-0003", base_revision=0))
    with pytest.raises(InteractiveStoryServiceError) as exc:
        service.confirm_outline(
            ConfirmStoryOutlineRequest(
                canvas_id="default",
                outline_id="outline-other",
                status="confirmed",
                base_revision=1,
                idempotency_key="outline-confirm-0004",
            )
        )
    assert exc.value.code == "outline_not_found"


def test_create_links_confirmed_outline_only(
    service: InteractiveStoryService, story: StoryDraftV2
) -> None:
    service.save_outline(save_request(service, key="outline-link-0001", base_revision=0))
    # 后端 create 路径硬校验确认状态（不再只靠 MCP 工具入口）：pending 大纲
    # 直接拒绝，且不产生任何画布写入。
    with pytest.raises(InteractiveStoryServiceError) as exc:
        service.create(
            CreateInteractiveStoryRequest(
                canvas_id="default", base_revision=1, idempotency_key="link-create-0001", story=story
            )
        )
    assert exc.value.code == "outline_not_confirmed"
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    assert canvas["revision"] == 1
    stored = canvas["metadata"][PENDING_OUTLINE_METADATA_KEY]
    assert stored["status"] == "pending"
    assert stored.get("story_id") is None

    service.confirm_outline(
        ConfirmStoryOutlineRequest(
            canvas_id="default",
            outline_id="outline-round-1",
            status="confirmed",
            base_revision=1,
            idempotency_key="outline-link-0002",
        )
    )
    updated = story.model_copy(update={"story_id": "story-linked-1"})
    service.create(
        CreateInteractiveStoryRequest(
            canvas_id="default",
            base_revision=2,
            idempotency_key="link-create-0002",
            story=updated,
        )
    )

    canvas = canvas_store.read_canvas(service.project_dir, "default")
    stored = canvas["metadata"][PENDING_OUTLINE_METADATA_KEY]
    assert stored["status"] == "linked"
    assert stored["story_id"] == "story-linked-1"

    # 单故事画布：大纲关联完成后不能再追加第二个故事。
    third = story.model_copy(update={"story_id": "story-third-1"})
    with pytest.raises(InteractiveStoryServiceError) as exc:
        service.create(
            CreateInteractiveStoryRequest(
                canvas_id="default",
                base_revision=3,
                idempotency_key="link-create-0003",
                story=third,
            )
        )
    assert exc.value.code == "story_already_exists"
    canvas = canvas_store.read_canvas(service.project_dir, "default")
    assert canvas["revision"] == 3
    assert canvas["metadata"][PENDING_OUTLINE_METADATA_KEY]["story_id"] == "story-linked-1"


def test_create_fails_closed_on_unreadable_outline_slot(
    service: InteractiveStoryService, story: StoryDraftV2
) -> None:
    """大纲槽存在但解析不了：无法证明已确认，create 必须拒绝而非当作无大纲。"""
    canvas = canvas_store.default_canvas_payload(project_id="project-1", actor_id="user-1")
    canvas["metadata"] = {PENDING_OUTLINE_METADATA_KEY: {"garbage": True}}
    canvas_store.save_canvas(
        service.project_dir,
        "default",
        base_revision=0,
        build_payload=lambda _: canvas,
        client_save_id="outline-corrupt-0001",
    )

    with pytest.raises(InteractiveStoryServiceError) as exc:
        service.create(
            CreateInteractiveStoryRequest(
                canvas_id="default", base_revision=1, idempotency_key="corrupt-create-01", story=story
            )
        )
    assert exc.value.code == "outline_not_confirmed"
    assert canvas_store.read_canvas(service.project_dir, "default")["revision"] == 1
