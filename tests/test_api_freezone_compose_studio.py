"""HTTP contract for opening an OpenFilm Studio compose session."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def studio_client(monkeypatch, tmp_path: Path) -> TestClient:
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    ctx = SimpleNamespace(project_id="proj_demo", requester_user_id="u-alice")
    app_state = {"calls": []}

    async def fake_resolve(project: str, user: dict, **_kwargs):
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    def fake_build(**kwargs):
        del kwargs
        return tmp_path / "film"

    async def fake_session(film_dir: Path, **kwargs):
        assert film_dir == tmp_path / "film"
        app_state["calls"].append(kwargs)
        return {
            "url": "http://127.0.0.1:4747/open?key=k",
            "origin": "http://127.0.0.1:4747",
        }

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone, "build_studio_film", fake_build)
    monkeypatch.setattr(freezone, "ensure_studio_session", fake_session)

    app = FastAPI()
    app.state.studio_calls = app_state["calls"]
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app)


def test_studio_route_returns_the_canonical_envelope(studio_client: TestClient):
    response = studio_client.post(
        "/api/v1/projects/demo/freezone/video/compose/studio",
        json={
            "canvas_id": "canvas-1",
            "node_id": "node-1",
            "tracks": [
                {
                    "track_id": "video-1",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-1",
                            "source_url": "/freezone/_uploads/a.mp4",
                            "source_end": 1.0,
                        }
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"] == {
        "url": "http://127.0.0.1:4747/open?key=k",
        "origin": "http://127.0.0.1:4747",
    }


def test_studio_route_forwards_the_host_language(studio_client: TestClient):
    response = studio_client.post(
        "/api/v1/projects/demo/freezone/video/compose/studio",
        json={
            "canvas_id": "canvas-1",
            "node_id": "node-1",
            "lang": "zh",
            "tracks": [
                {
                    "track_id": "video-1",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-1",
                            "source_url": "/freezone/_uploads/a.mp4",
                            "source_end": 1.0,
                        }
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    calls = studio_client.app.state.studio_calls
    assert calls[-1]["lang"] == "zh"


def test_studio_route_lets_the_host_ask_before_replacing_an_edited_film(
    studio_client: TestClient, monkeypatch
):
    """The editor saves cuts straight into the film folder, so replacing one needs consent — the
    host shows its own confirmation on this status and retries with `rebuild`."""
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.studio import StudioError

    def refuse(**_kwargs):
        raise StudioError(
            "the film was edited in Studio; pass rebuild to replace it", 409
        )

    monkeypatch.setattr(freezone, "build_studio_film", refuse)

    response = studio_client.post(
        "/api/v1/projects/demo/freezone/video/compose/studio",
        json={
            "canvas_id": "canvas-1",
            "node_id": "node-1",
            "tracks": [
                {
                    "track_id": "video-1",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-1",
                            "source_url": "/freezone/_uploads/a.mp4",
                            "source_end": 1.0,
                        }
                    ],
                }
            ],
        },
    )

    assert response.status_code == 409
    assert "edited in Studio" in response.json()["detail"]


def test_studio_request_requires_canvas_and_node_ids():
    from pydantic import ValidationError

    from novelvideo.api.schemas import FreezoneVideoComposeStudioRequest

    with pytest.raises(ValidationError):
        FreezoneVideoComposeStudioRequest()
    with pytest.raises(ValidationError):
        FreezoneVideoComposeStudioRequest(canvas_id="canvas-1")


def test_compose_items_reject_non_finite_numbers():
    from pydantic import ValidationError

    from novelvideo.api.schemas import FreezoneVideoComposeItem

    with pytest.raises(ValidationError):
        FreezoneVideoComposeItem(
            item_id="clip",
            source_url="/freezone/_uploads/a.mp4",
            source_end=float("inf"),
        )
