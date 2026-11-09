"""Story editing must require projects:write through real bearer authentication."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.interactive_story.models import (
    CreateInteractiveStoryRequest,
    PendingStoryOutline,
    SaveStoryOutlineRequest,
    StoryDraftV2,
)
from novelvideo.interactive_story.service import InteractiveStoryService


@pytest.fixture
def story_api(tmp_path, monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    from novelvideo.api.routes import interactive_stories
    from novelvideo.ports import registry
    from novelvideo.ports.local.auth import FileAuthPort, LocalAuthSession

    state = tmp_path / "state"
    story = StoryDraftV2.model_validate_json(
        (
            Path(__file__).resolve().parents[1]
            / "examples/interactive_story/story_draft_v2.json"
        ).read_text()
    )
    service = InteractiveStoryService(state, project_id="p", actor_id="local")
    service.create(
        CreateInteractiveStoryRequest(
            canvas_id="default",
            base_revision=0,
            idempotency_key="scope-seed-story",
            story=story,
        )
    )
    outline = PendingStoryOutline(
        outline_id="scope-outline",
        kind="story",
        title="Original outline",
        premise="Scope regression",
        plot_summary="Scope regression",
    )
    service.save_outline(
        SaveStoryOutlineRequest(
            canvas_id="outline",
            base_revision=0,
            idempotency_key="scope-seed-outline",
            outline=outline,
        )
    )
    auth = LocalAuthSession()
    monkeypatch.setitem(registry._PORTS, "auth_session", auth)
    monkeypatch.setitem(registry._PORTS, "auth", FileAuthPort())
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "false")
    roles = []

    async def resolve(project, user, *, required_role):
        if project != "p":
            raise HTTPException(403)
        roles.append(required_role)
        return SimpleNamespace(ctx=SimpleNamespace(state_dir=state, project_id="p"))

    monkeypatch.setattr(interactive_stories, "resolve_project_scope", resolve)

    def headers(scopes, project="p"):
        token = asyncio.run(
            auth.create_agent_session(
                username="local",
                scopes=scopes,
                current_scope_kind="project",
                current_project_id=project,
            )
        )
        return {"Authorization": f"Bearer {token.value}"}

    app = FastAPI()
    app.include_router(interactive_stories.router, prefix="/api/v1")
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            headers=headers,
            state=state,
            roles=roles,
            story=story,
            outline=outline,
            service=service,
        )


@pytest.fixture(
    params=["create", "patch", "save_outline", "confirm_outline", "confirm_stages"]
)
def story_write_request(story_api, request):
    api = story_api
    prefix = "/api/v1/projects/p"
    story_path = f"{prefix}/interactive-stories/{api.story.story_id}"
    outline_path = f"{prefix}/interactive-story-outline"
    operation = request.param
    common = {"base_revision": 1, "idempotency_key": f"scope-write-{operation}"}
    method, path, body = {
        "create": (
            "POST",
            f"{prefix}/interactive-stories",
            {
                **common,
                "canvas_id": "new-story",
                "base_revision": 0,
                "story": api.story.model_dump(mode="json"),
            },
        ),
        "patch": (
            "PATCH",
            story_path,
            {
                **common,
                "canvas_id": "default",
                "story_id": api.story.story_id,
                "operations": [
                    {"op": "update_story_metadata", "changes": {"title": "Edited"}}
                ],
            },
        ),
        "save_outline": (
            "PUT",
            outline_path,
            {
                **common,
                "canvas_id": "outline",
                "outline": {
                    **api.outline.model_dump(mode="json"),
                    "title": "Edited outline",
                },
            },
        ),
        "confirm_outline": (
            "POST",
            f"{outline_path}/confirm",
            {
                **common,
                "canvas_id": "outline",
                "outline_id": api.outline.outline_id,
                "status": "confirmed",
            },
        ),
        "confirm_stages": (
            "POST",
            f"{story_path}/stage-confirmations",
            {
                **common,
                "canvas_id": "default",
                "story_id": api.story.story_id,
                "stages": ["characters"],
                "action": "confirm",
            },
        ),
    }[operation]
    return method, path, body


@pytest.mark.parametrize(
    "other_scope", ["tasks:submit", "projects:lifecycle", "projects:purge"]
)
def test_other_write_scopes_cannot_edit_story(
    story_api, story_write_request, other_scope
):
    api = story_api
    method, path, body = story_write_request
    before = {
        file: file.read_bytes() for file in api.state.rglob("*") if file.is_file()
    }
    response = api.client.request(
        method,
        path,
        json=body,
        headers=api.headers(["projects:read", other_scope]),
    )
    assert response.status_code == 403, response.text
    assert "projects:write" in response.json()["detail"]
    assert api.roles == []  # Reject before project resolution or any storage access.
    assert {
        file: file.read_bytes() for file in api.state.rglob("*") if file.is_file()
    } == before


@pytest.mark.parametrize("credential", ["browser", "write_agent", "default_agent"])
def test_authorized_story_writes(story_api, story_write_request, credential):
    from novelvideo.ports.auth_contract import DEFAULT_EXTERNAL_AGENT_SCOPES

    api = story_api
    method, path, body = story_write_request
    headers = {}
    if credential != "browser":
        scopes = (
            DEFAULT_EXTERNAL_AGENT_SCOPES
            if credential == "default_agent"
            else ["projects:write"]
        )
        headers = api.headers(scopes)
    response = api.client.request(method, path, json=body, headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"] is True
    assert result["revision"] == body["base_revision"] + 1
    assert (
        canvas_store.read_canvas(api.state, body["canvas_id"])["revision"]
        == result["revision"]
    )
    assert api.roles == ["editor"]


def test_story_write_token_cannot_edit_other_project(story_api, story_write_request):
    api = story_api
    method, path, body = story_write_request
    response = api.client.request(
        method,
        path,
        json=body,
        headers=api.headers(["projects:write"], project="other"),
    )
    assert response.status_code == 403, response.text
    assert "scope mismatch" in response.json()["detail"].lower()
    assert api.roles == []


def test_read_only_agent_can_read_story_outline_and_progress(story_api):
    api = story_api
    headers = api.headers(["projects:read"])
    for path, canvas_id in (
        (f"interactive-stories/{api.story.story_id}", "default"),
        ("interactive-story-outline", "outline"),
        ("interactive-story-progress", "default"),
    ):
        response = api.client.get(
            f"/api/v1/projects/p/{path}",
            params={"canvas_id": canvas_id},
            headers=headers,
        )
        assert response.status_code == 200, response.text
    assert api.roles == ["viewer"] * 3
