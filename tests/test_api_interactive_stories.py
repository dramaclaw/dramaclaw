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

    patch = client.patch(
        "/api/v1/projects/proj_demo/interactive-stories/fizz_choice_ad",
        json={
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
        },
    )
    assert patch.status_code == 200, patch.text
    assert patch.json()["revision"] == 2
    assert patch.json()["refresh_canvas"] is True

    validate = client.post(
        "/api/v1/projects/proj_demo/interactive-stories/fizz_choice_ad/validate",
        json={"canvas_id": "default", "story_id": "fizz_choice_ad"},
    )
    assert validate.status_code == 200, validate.text
    assert validate.json()["valid"] is True
    assert {issue["code"] for issue in validate.json()["issues"]} == {"missing_video"}
    assert roles == ["editor", "viewer", "editor", "viewer"]
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
