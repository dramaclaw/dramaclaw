"""Stage-progress readback: the Agent-facing mirror of the frontend stage-D nav.

Statuses must be derived from canvas evidence on every call (never persisted),
with the same gating rules as ``storyStages.ts``: outline confirmation,
per-segment narration/prompt/video counts and structural lint errors.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.interactive_story.models import (
    ConfirmInteractiveStoryStagesRequest,
    ConfirmStoryOutlineRequest,
    CreateInteractiveStoryRequest,
    PendingStoryOutline,
    SaveStoryOutlineRequest,
    StoryDraftV2,
    StoryMediaRef,
    StoryPatchV2,
    StorySegmentChanges,
    UpdateStorySegment,
)
from novelvideo.interactive_story.service import InteractiveStoryService
from novelvideo.interactive_story.stage_progress import (
    STORY_STAGE_ORDER,
    collect_stage_evidence,
    derive_stages,
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


def outline_payload(kind: str = "story", **changes) -> dict:
    base = {
        "outline_id": "outline-round-1",
        "kind": kind,
        "title": "雨夜出租车",
        "premise": "出租车司机在雨夜接到一位自称来自十年前的乘客。",
        "plot_summary": "三幕：接载—试探—抉择。",
    }
    base.update(changes)
    return base


def _status_of(result, stage_id: str) -> str:
    return next(stage.status for stage in result.stages if stage.id == stage_id)


# --- pure derivation (frontend decision-table parity) ---------------------


def test_empty_canvas_is_all_todo_with_proposal_current(service) -> None:
    result = service.progress("default")
    assert result.ok is True
    assert result.revision == 0
    assert result.kind == "story"
    automatic = [
        stage
        for stage in result.stages
        if stage.id not in {"scenes", "storyboard", "complete"}
    ]
    assert all(stage.status == "todo" for stage in automatic)
    assert result.current_stage_id == "proposal"


def test_pending_outline_keeps_proposal_active(service) -> None:
    service.save_outline(
        SaveStoryOutlineRequest(
            canvas_id="default",
            base_revision=0,
            idempotency_key="progress-outline-01",
            outline=PendingStoryOutline.model_validate(outline_payload()),
        )
    )
    result = service.progress("default")
    assert _status_of(result, "proposal") == "active"
    assert _status_of(result, "outline") == "active"
    assert result.current_stage_id == "proposal"


def test_ad_kind_shares_the_canonical_stage_order(service) -> None:
    service.save_outline(
        SaveStoryOutlineRequest(
            canvas_id="default",
            base_revision=0,
            idempotency_key="progress-outline-ad",
            outline=PendingStoryOutline.model_validate(outline_payload(kind="ad")),
        )
    )
    result = service.progress("default")
    # 广告与影游共用同一套创作流水线，不再单独维护短流程。
    assert result.kind == "ad"
    assert [stage.id for stage in result.stages] == list(STORY_STAGE_ORDER)
    # 「完成」与前端一致：无自动判据，不假装完成。
    assert _status_of(result, "complete") == "manual"


def test_dangling_choice_edge_counts_as_lint_error() -> None:
    canvas = {
        "nodes": [
            {
                "id": "story-s1",
                "type": "groupNode",
                "data": {"storyGroup": True, "interactiveStoryId": "s1"},
            },
            {
                "id": "story-s1-segment-a",
                "type": "videoNode",
                "parentId": "story-s1",
                "data": {"narration": "A", "storySegmentId": "a"},
            },
            {
                "id": "story-s1-segment-b",
                "type": "videoNode",
                "parentId": "story-s1",
                "data": {"narration": "B", "storySegmentId": "b"},
            },
        ],
        "edges": [
            {
                "id": "e-dangling",
                "type": "storyChoiceEdge",
                "source": "story-s1-segment-a",
                "target": "node-outside-group",
            }
        ],
    }
    evidence = collect_stage_evidence(
        canvas, None, lint_error_count=0, story_group=canvas["nodes"][0]
    )
    assert evidence.segment_count == 2
    assert evidence.script_ready_count == 2
    assert evidence.lint_error_count == 1
    stages = derive_stages(evidence, None)
    script = next(stage for stage in stages if stage.id == "script")
    assert script.status == "active"


# --- service integration over the real projection -------------------------


def test_created_story_advances_script_and_video_follows_media(
    service, story
) -> None:
    service.create(
        CreateInteractiveStoryRequest(
            canvas_id="default",
            base_revision=0,
            idempotency_key="progress-create-01",
            story=story,
        )
    )
    before = service.progress("default")
    assert before.evidence.segment_count == len(story.segments)
    assert _status_of(before, "script") == "done"
    # 角色名单只是剧本 metadata，不能冒充已创建的角色资产。
    assert before.evidence.character_count > 0
    assert _status_of(before, "characters") == "manual"
    assert _status_of(before, "video") == "todo"
    # 大纲从未保存：proposal 仍是当前阶段，制作产出不该被视作已解锁。
    assert before.current_stage_id == "proposal"

    # 全部片段视频就绪前，video 阶段不得点亮。
    first = story.segments[0]
    service.patch(
        StoryPatchV2(
            canvas_id="default",
            story_id=story.story_id,
            base_revision=before.revision,
            idempotency_key="progress-partial-media",
            operations=[
                UpdateStorySegment(
                    segment_id=first.id,
                    changes=StorySegmentChanges(
                        media=StoryMediaRef(
                            source="imported", status="ready", url="/f/clip.mp4"
                        )
                    ),
                )
            ],
        )
    )
    partial = service.progress("default")
    assert partial.evidence.video_ready_count == 1
    assert _status_of(partial, "video") == "active"


def test_confirmed_and_linked_outline_marks_proposal_and_outline_done(
    service, story
) -> None:
    created = service.create(
        CreateInteractiveStoryRequest(
            canvas_id="default",
            base_revision=0,
            idempotency_key="progress-link-create",
            story=story,
        )
    )
    service.save_outline(
        SaveStoryOutlineRequest(
            canvas_id="default",
            base_revision=created.revision,
            idempotency_key="progress-link-outline",
            outline=PendingStoryOutline.model_validate(outline_payload()),
        )
    )
    service.confirm_outline(
        ConfirmStoryOutlineRequest(
            canvas_id="default",
            outline_id="outline-round-1",
            status="confirmed",
            base_revision=created.revision + 1,
            idempotency_key="progress-confirm-outline",
        )
    )
    result = service.progress("default")
    assert _status_of(result, "proposal") == "done"
    assert _status_of(result, "outline") == "done"
    # 剧本完成后，最早一个无法由真实资产自动证明的阶段是角色；不得跳过
    # 角色/场景/分镜而直接把视频标成当前阶段。
    assert result.current_stage_id == "characters"


def test_explicit_stage_confirmation_advances_and_can_be_reopened(
    service, story
) -> None:
    created = service.create(
        CreateInteractiveStoryRequest(
            canvas_id="default",
            base_revision=0,
            idempotency_key="progress-confirm-create",
            story=story,
        )
    )
    confirmed = service.confirm_stages(
        ConfirmInteractiveStoryStagesRequest(
            canvas_id="default",
            story_id=story.story_id,
            stages=["characters", "scenes"],
            action="confirm",
            base_revision=created.revision,
            idempotency_key="progress-confirm-stages",
        )
    )
    assert confirmed.confirmed_stages == ["characters", "scenes"]
    progress = service.progress("default")
    assert progress.evidence.confirmed_stages == ["characters", "scenes"]
    assert _status_of(progress, "characters") == "done"
    assert _status_of(progress, "scenes") == "done"
    assert _status_of(progress, "storyboard") == "manual"

    patched = service.patch(
        StoryPatchV2(
            canvas_id="default",
            story_id=story.story_id,
            base_revision=confirmed.revision,
            idempotency_key="progress-after-confirm-patch",
            operations=[
                UpdateStorySegment(
                    segment_id=story.segments[0].id,
                    changes=StorySegmentChanges(production_notes="确认后继续细化"),
                )
            ],
        )
    )
    assert service.progress("default").evidence.confirmed_stages == [
        "characters",
        "scenes",
    ]

    reopened = service.confirm_stages(
        ConfirmInteractiveStoryStagesRequest(
            canvas_id="default",
            story_id=story.story_id,
            stages=["scenes"],
            action="reopen",
            base_revision=patched.revision,
            idempotency_key="progress-reopen-scene",
        )
    )
    assert reopened.confirmed_stages == ["characters"]
    assert _status_of(service.progress("default"), "scenes") == "manual"


# --- REST surface & MCP wiring ---------------------------------------------


@pytest.fixture()
def progress_client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import interactive_stories

    state_dir = tmp_path / "state-project"
    roles: list[str] = []
    ctx = SimpleNamespace(project_id="proj_demo", state_dir=state_dir, roles=roles)

    async def fake_resolve_project_scope(project, user, *, required_role):
        assert project == "proj_demo"
        roles.append(required_role)
        return SimpleNamespace(ctx=ctx)

    monkeypatch.setattr(
        interactive_stories, "resolve_project_scope", fake_resolve_project_scope
    )
    app = FastAPI()
    app.include_router(interactive_stories.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"id": "u-1", "username": "alice"}
    return TestClient(app), ctx


def test_progress_route_is_read_only_viewer(progress_client, story) -> None:
    client, ctx = progress_client
    response = client.get(
        "/api/v1/projects/proj_demo/interactive-story-progress",
        params={"canvas_id": "default"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["evidence"]["segment_count"] == 0
    assert ctx.roles == ["viewer"]
    # 不产生任何写入：revision 保持 0。
    again = client.get(
        "/api/v1/projects/proj_demo/interactive-story-progress",
        params={"canvas_id": "default"},
    )
    assert again.json()["revision"] == 0


def test_progress_tool_hits_progress_route(monkeypatch) -> None:
    from novelvideo.chat import dramaclaw_mcp

    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    plugin = dramaclaw_mcp._plugin("freezone")
    calls: list = []

    def fake_request(method, path, *, query=None, body=None):
        calls.append((method, path, query, body))
        return {"ok": True}

    monkeypatch.setattr(plugin, "_request", fake_request)

    dramaclaw_mcp._plugin_tools("freezone")[
        "dramaclaw_get_interactive_story_progress"
    ][1]({"project_id": "project-a", "canvas_id": "canvas-a"})

    method, path, query, body = calls[0]
    assert method == "GET"
    assert path.endswith("/projects/project-a/interactive-story-progress")
    assert query == {"canvas_id": "canvas-a"}
    assert body is None


def test_stage_confirmation_tool_hits_write_route(monkeypatch) -> None:
    from novelvideo.chat import dramaclaw_mcp

    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    plugin = dramaclaw_mcp._plugin("freezone")
    calls: list = []

    def fake_request(method, path, *, query=None, body=None):
        calls.append((method, path, query, body))
        return {
            "ok": True,
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "story_id": "story-a",
            "revision": 4,
            "confirmed_stages": ["characters", "scenes"],
            "idempotent": False,
            "refresh_canvas": True,
        }

    monkeypatch.setattr(plugin, "_request", fake_request)
    dramaclaw_mcp._plugin_tools("freezone")[
        "dramaclaw_confirm_interactive_story_stages"
    ][1](
        {
            "project_id": "project-a",
            "canvas_id": "canvas-a",
            "story_id": "story-a",
            "stages": ["characters", "scenes"],
            "action": "confirm",
            "base_revision": 3,
            "idempotency_key": "confirm-stages-01",
        }
    )

    method, path, query, body = calls[0]
    assert method == "POST"
    assert path.endswith(
        "/projects/project-a/interactive-stories/story-a/stage-confirmations"
    )
    assert query is None
    assert body["stages"] == ["characters", "scenes"]
