from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

EXAMPLE_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "interactive_story"
    / "story_draft_v2.json"
)


@pytest.fixture()
def interactive_story_client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import interactive_stories

    state_dir = tmp_path / "state-project"
    roles: list[str] = []
    ctx = SimpleNamespace(project_id="proj_demo", state_dir=state_dir)

    async def fake_resolve_project_scope(
        project: str, user: dict, *, required_role: str
    ):
        assert project == "proj_demo"
        assert user["id"] == "u-alice"
        roles.append(required_role)
        return SimpleNamespace(ctx=ctx)

    monkeypatch.setattr(
        interactive_stories, "resolve_project_scope", fake_resolve_project_scope
    )
    app = FastAPI()
    app.include_router(interactive_stories.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app), state_dir, roles


def _story_payload() -> dict:
    return json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))


def test_freezone_mcp_story_tools_persist_and_validate_real_story(
    interactive_story_client, monkeypatch,
) -> None:
    from novelvideo.chat import dramaclaw_mcp
    from novelvideo.chat.service import _codex_freezone_write_result_succeeded
    from novelvideo.freezone import canvas_store

    client, state_dir, _roles = interactive_story_client
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "proj_demo")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "default")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    plugin = dramaclaw_mcp._plugin("freezone")

    def request(method, path, *, query=None, body=None):
        response = client.request(method, path, params=query, json=body)
        assert response.status_code == 200, response.text
        return response.json()

    monkeypatch.setattr(plugin, "_request", request)

    def call(name, args):
        result = asyncio.run(dramaclaw_mcp.call_tool(name, args))
        assert result.isError is False, result
        return result.structuredContent

    story = _story_payload()
    created = call("dramaclaw_create_interactive_story", {
        "base_revision": 0, "idempotency_key": "mcp-story-create-01", "story": story,
    })
    assert created["revision"] == 1
    assert created["refresh_canvas"] is True
    assert _codex_freezone_write_result_succeeded(SimpleNamespace(
        name="dramaclaw.dramaclaw_create_interactive_story", status="completed",
        error=None, structured=created, output=None,
    ))
    read = call("dramaclaw_get_interactive_story", {"story_id": story["story_id"]})
    assert len(read["story"]["choices"]) == len(story["choices"])
    patched = call("dramaclaw_patch_interactive_story", {
        "story_id": story["story_id"], "base_revision": 1,
        "idempotency_key": "mcp-story-patch-01",
        "operations": [{"op": "update_story_metadata", "changes": {"title": "互动短剧修订"}}],
    })
    assert patched["revision"] == 2
    validated = call("dramaclaw_validate_interactive_story", {"story_id": story["story_id"]})
    assert validated["valid"] is True
    saved = canvas_store.read_canvas(state_dir, "default")
    assert saved["revision"] == 2
    assert sum(edge["type"] == "storyChoiceEdge" for edge in saved["edges"]) == len(story["choices"])


def test_interactive_story_api_create_get_patch_validate_round_trip(
    interactive_story_client,
) -> None:
    client, state_dir, roles = interactive_story_client
    story = _story_payload()
    create = client.post(
        "/api/v1/projects/proj_demo/interactive-stories",
        json={
            "canvas_id": "default",
            "base_revision": 0,
            "idempotency_key": "api-create-0001",
            "story": story,
        },
    )
    assert create.status_code == 200, create.text
    assert create.json()["revision"] == 1
    assert create.json()["canvas_id"] == "default"
    assert create.json()["refresh_canvas"] is True

    read = client.get(
        "/api/v1/projects/proj_demo/interactive-stories/fizz_choice_ad",
        params={"canvas_id": "default"},
    )
    assert read.status_code == 200, read.text
    assert read.json()["story"]["title"] == "这一口，听你的"
    assert read.json()["story"]["revision"] == 1

    patch_payload = {
        "canvas_id": "default",
        "story_id": "fizz_choice_ad",
        "base_revision": 1,
        "idempotency_key": "api-patch-0001",
        "operations": [
            {
                "op": "update_story_metadata",
                "changes": {"title": "这一口，听你的：互动版"},
            }
        ],
    }
    patch_path = "/api/v1/projects/proj_demo/interactive-stories/fizz_choice_ad"
    patch = client.patch(patch_path, json=patch_payload)
    assert patch.status_code == 200, patch.text
    assert patch.json()["revision"] == 2
    assert patch.json()["refresh_canvas"] is True
    repeated = client.patch(patch_path, json=patch_payload)
    assert repeated.status_code == 200
    assert repeated.json()["idempotent"] is True

    events_path = state_dir / "freezone" / "_canvas_events" / "default.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()]
    assert [(event["event_type"], event["payload"]["revision"],
             event["payload"]["save_source"]) for event in events] == [
        ("canvas.saved", 1, "agent_create"),
        ("canvas.saved", 2, "agent_patch"),
    ]

    validate = client.post(
        "/api/v1/projects/proj_demo/interactive-stories/fizz_choice_ad/validate",
        json={"canvas_id": "default", "story_id": "fizz_choice_ad"},
    )
    assert validate.status_code == 200, validate.text
    assert validate.json()["valid"] is True
    assert {issue["code"] for issue in validate.json()["issues"]} == {"missing_video"}
    assert roles == ["editor", "viewer", "editor", "editor", "viewer"]
    assert (state_dir / "freezone" / "canvases" / "default.json").exists()


def test_interactive_story_api_returns_structured_revision_conflict(
    interactive_story_client,
) -> None:
    client, _state_dir, _roles = interactive_story_client
    story = _story_payload()
    response = client.post(
        "/api/v1/projects/proj_demo/interactive-stories",
        json={
            "canvas_id": "default",
            "base_revision": 0,
            "idempotency_key": "api-create-0002",
            "story": story,
        },
    )
    assert response.status_code == 200

    stale = client.patch(
        "/api/v1/projects/proj_demo/interactive-stories/fizz_choice_ad",
        json={
            "canvas_id": "default",
            "story_id": "fizz_choice_ad",
            "base_revision": 0,
            "idempotency_key": "api-patch-stale",
            "operations": [
                {"op": "update_story_metadata", "changes": {"title": "不会保存"}}
            ],
        },
    )

    assert stale.status_code == 409
    assert stale.json() == {
        "ok": False,
        "code": "revision_conflict",
        "message": "canvas revision conflict",
        "story_id": "fizz_choice_ad",
        "current_revision": 1,
        "issues": [],
    }


def test_interactive_story_api_rejects_a_second_story_on_one_canvas(
    interactive_story_client,
) -> None:
    client, state_dir, _roles = interactive_story_client
    story = _story_payload()
    first = client.post(
        "/api/v1/projects/proj_demo/interactive-stories",
        json={
            "canvas_id": "default",
            "base_revision": 0,
            "idempotency_key": "api-single-story-first",
            "story": story,
        },
    )
    assert first.status_code == 200, first.text

    second_story = {**story, "story_id": "another-story"}
    second = client.post(
        "/api/v1/projects/proj_demo/interactive-stories",
        json={
            "canvas_id": "default",
            "base_revision": 1,
            "idempotency_key": "api-single-story-second",
            "story": second_story,
        },
    )

    assert second.status_code == 409
    assert second.json()["code"] == "story_already_exists"
    assert second.json()["story_id"] == story["story_id"]
    saved = json.loads(
        (state_dir / "freezone" / "canvases" / "default.json").read_text()
    )
    assert saved["revision"] == 1
    assert sum(
        (node.get("data") or {}).get("storyGroup") is True
        for node in saved["nodes"]
    ) == 1


def test_interactive_story_api_persists_explicit_stage_confirmation(
    interactive_story_client,
) -> None:
    client, state_dir, roles = interactive_story_client
    story = _story_payload()
    created = client.post(
        "/api/v1/projects/proj_demo/interactive-stories",
        json={
            "canvas_id": "default",
            "base_revision": 0,
            "idempotency_key": "api-stage-create",
            "story": story,
        },
    )
    assert created.status_code == 200, created.text

    confirmed = client.post(
        "/api/v1/projects/proj_demo/interactive-stories/"
        "fizz_choice_ad/stage-confirmations",
        json={
            "canvas_id": "default",
            "story_id": "fizz_choice_ad",
            "stages": ["characters", "scenes"],
            "action": "confirm",
            "base_revision": 1,
            "idempotency_key": "api-stage-confirm",
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["confirmed_stages"] == ["characters", "scenes"]
    assert confirmed.json()["refresh_canvas"] is True

    progress = client.get(
        "/api/v1/projects/proj_demo/interactive-story-progress",
        params={"canvas_id": "default"},
    )
    assert progress.status_code == 200, progress.text
    status = {item["id"]: item["status"] for item in progress.json()["stages"]}
    assert status["characters"] == "done"
    assert status["scenes"] == "done"
    assert progress.json()["evidence"]["confirmed_stages"] == [
        "characters",
        "scenes",
    ]

    saved = json.loads(
        (state_dir / "freezone" / "canvases" / "default.json").read_text()
    )
    group = next(node for node in saved["nodes"] if node["data"].get("storyGroup"))
    assert group["data"]["storyStageConfirmations"]["characters"]["confirmedBy"] == (
        "u-alice"
    )
    assert roles == ["editor", "editor", "viewer"]


def test_story_event_failure_does_not_hide_saved_result(
    interactive_story_client, monkeypatch,
) -> None:
    from novelvideo.api.routes import interactive_stories
    from novelvideo.freezone import canvas_store

    client, state_dir, _roles = interactive_story_client

    def fail_event(**_kwargs):
        raise OSError("event log unavailable")

    monkeypatch.setattr(interactive_stories, "append_canvas_event", fail_event)
    response = client.post(
        "/api/v1/projects/proj_demo/interactive-stories",
        json={"canvas_id": "default", "base_revision": 0,
              "idempotency_key": "api-create-event-failure", "story": _story_payload()},
    )
    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert canvas_store.read_canvas(state_dir, "default")["revision"] == 1


def test_interactive_story_api_rejects_path_body_story_id_mismatch(
    interactive_story_client,
) -> None:
    client, _state_dir, roles = interactive_story_client
    response = client.patch(
        "/api/v1/projects/proj_demo/interactive-stories/path_story",
        json={
            "canvas_id": "default",
            "story_id": "body_story",
            "base_revision": 0,
            "idempotency_key": "api-patch-mismatch",
            "operations": [
                {"op": "update_story_metadata", "changes": {"title": "不会保存"}}
            ],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "story_id_mismatch"
    assert roles == []


@pytest.mark.asyncio
async def test_interactive_story_route_moves_blocking_service_work_off_event_loop(
    monkeypatch,
) -> None:
    from novelvideo.api.routes import interactive_stories
    from novelvideo.interactive_story.models import CreateInteractiveStoryRequest

    started = threading.Event()
    release = threading.Event()
    expected = {"ok": True}

    class BlockingService:
        def create(self, _body):
            started.set()
            release.wait(timeout=0.5)
            return expected

    async def fake_service(*_args, **_kwargs):
        return BlockingService()

    monkeypatch.setattr(interactive_stories, "_service", fake_service)
    async def fake_record_story_save(*_args):
        return None

    monkeypatch.setattr(interactive_stories, "_record_story_save", fake_record_story_save)
    body = CreateInteractiveStoryRequest.model_validate(
        {
            "canvas_id": "default",
            "base_revision": 0,
            "idempotency_key": "api-threaded-create",
            "story": _story_payload(),
        }
    )

    task = asyncio.create_task(
        interactive_stories.create_interactive_story(
            "proj_demo",
            body,
            {"id": "u-alice"},
        )
    )
    await asyncio.wait_for(asyncio.to_thread(started.wait), timeout=0.2)
    assert not task.done()

    release.set()
    assert await task == expected


def test_create_tool_hard_gates_unconfirmed_outline(
    interactive_story_client, monkeypatch,
) -> None:
    """Agent 的 Create 工具入口硬校验大纲确认状态；底层 service 保持宽松。"""
    from novelvideo.chat import dramaclaw_mcp

    client, _state_dir, _roles = interactive_story_client
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "proj_demo")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "default")
    plugin = dramaclaw_mcp._plugin("freezone")

    def request(method, path, *, query=None, body=None):
        response = client.request(method, path, params=query, json=body)
        return {"status_code": response.status_code, **response.json()}

    monkeypatch.setattr(plugin, "_request", request)
    create = dramaclaw_mcp._plugin_tools("freezone")[
        "dramaclaw_create_interactive_story"
    ][1]

    saved = client.put(
        "/api/v1/projects/proj_demo/interactive-story-outline",
        json={
            "canvas_id": "default",
            "base_revision": 0,
            "idempotency_key": "gate-outline-0001",
            "outline": {
                "outline_id": "outline-round-1",
                "kind": "story",
                "title": "雨夜出租车",
                "premise": "司机在雨夜接到自称来自十年前的乘客。",
                "plot_summary": "三幕：接载—试探—抉择。",
            },
        },
    )
    assert saved.status_code == 200, saved.text

    story = _story_payload()
    blocked = json.loads(create({
        "project_id": "proj_demo",
        "canvas_id": "default",
        "base_revision": 1,
        "idempotency_key": "gate-create-blocked",
        "story": story,
    }))
    assert blocked["ok"] is False
    assert "outline_not_confirmed" in blocked["error"]
    # 被拦下的请求不得碰画布：revision 仍为 1。
    read = client.get(
        "/api/v1/projects/proj_demo/interactive-story-outline",
        params={"canvas_id": "default"},
    )
    assert read.json()["revision"] == 1

    confirmed = client.post(
        "/api/v1/projects/proj_demo/interactive-story-outline/confirm",
        json={
            "canvas_id": "default",
            "outline_id": "outline-round-1",
            "status": "confirmed",
            "base_revision": 1,
            "idempotency_key": "gate-confirm-0001",
        },
    )
    assert confirmed.status_code == 200, confirmed.text

    created = json.loads(create({
        "project_id": "proj_demo",
        "canvas_id": "default",
        "base_revision": 2,
        "idempotency_key": "gate-create-allowed",
        "story": story,
    }))
    assert created.get("ok") is True, created
    assert created["revision"] == 3
    after = client.get(
        "/api/v1/projects/proj_demo/interactive-story-outline",
        params={"canvas_id": "default"},
    )
    assert after.json()["outline"]["status"] == "linked"


def test_create_route_rejects_unconfirmed_outline(
    interactive_story_client,
) -> None:
    """绕过 MCP 工具直接打 REST Create：后端同样拒绝未确认大纲。"""
    client, _state_dir, _roles = interactive_story_client
    saved = client.put(
        "/api/v1/projects/proj_demo/interactive-story-outline",
        json={
            "canvas_id": "default",
            "base_revision": 0,
            "idempotency_key": "route-gate-outline",
            "outline": {
                "outline_id": "outline-round-9",
                "kind": "story",
                "title": "雨夜出租车",
                "premise": "司机在雨夜接到自称来自十年前的乘客。",
                "plot_summary": "三幕：接载—试探—抉择。",
            },
        },
    )
    assert saved.status_code == 200, saved.text

    response = client.post(
        "/api/v1/projects/proj_demo/interactive-stories",
        json={
            "canvas_id": "default",
            "base_revision": 1,
            "idempotency_key": "route-gate-create",
            "story": _story_payload(),
        },
    )
    assert response.status_code == 409
    body = response.json()
    assert body["ok"] is False
    assert body["code"] == "outline_not_confirmed"
    # 被拒的请求不写画布：大纲读回 revision 仍为 1。
    read = client.get(
        "/api/v1/projects/proj_demo/interactive-story-outline",
        params={"canvas_id": "default"},
    )
    assert read.json()["revision"] == 1
