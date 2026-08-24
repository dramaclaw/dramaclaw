from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

pytestmark = pytest.mark.m03


def _client(monkeypatch, tmp_path):
    from novelvideo.api import deps
    from novelvideo.api.routes import episodes
    from novelvideo.api.deps import ProjectResolution

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(episodes, "resolve_project_scope", fake_resolve_project_scope)

    def fake_make_static_url_for_context(ctx, relative_path, local_path=None):
        return f"/static/alice/demo/{relative_path}"

    monkeypatch.setattr(
        episodes, "make_static_url_for_context", fake_make_static_url_for_context
    )

    class FakeStore:
        async def get_beats_as_dicts(self, episode_num: int):
            return [
                {
                    "beat_number": 3,
                    "narration_segment": "n",
                    "visual_description": "v",
                }
            ]

    async def fake_make_sqlite_store(username: str, project: str):
        return FakeStore()

    # On ``deps``, not on the route module: ``/beats`` opens the store through
    # ``sqlite_store_scope``, which looks the factory up as a ``deps`` global.
    monkeypatch.setattr(deps, "make_sqlite_store", fake_make_sqlite_store)

    app = FastAPI()
    app.include_router(episodes.router, prefix="/api/v1")
    app.dependency_overrides[episodes.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app)


def test_get_beats_exposes_canonical_sketch_url_separately_from_frame_url(
    monkeypatch, tmp_path
):
    client = _client(monkeypatch, tmp_path)
    sketch_path = tmp_path / "sketches" / "ep002" / "beat_03.png"
    frame_path = tmp_path / "frames" / "ep002" / "beat_03.png"
    sketch_path.parent.mkdir(parents=True, exist_ok=True)
    frame_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), "white").save(sketch_path, format="PNG")
    Image.new("RGB", (8, 8), "blue").save(frame_path, format="PNG")

    response = client.get("/api/v1/projects/demo/episodes/2/beats")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    beat = body["data"][0]
    assert beat["sketch_url"].endswith("/alice/demo/sketches/ep002/beat_03.png")
    assert beat["frame_url"].endswith("/alice/demo/frames/ep002/beat_03.png")


def test_get_beats_returns_empty_sketch_url_when_canonical_sketch_is_missing(
    monkeypatch, tmp_path
):
    client = _client(monkeypatch, tmp_path)

    response = client.get("/api/v1/projects/demo/episodes/2/beats")

    assert response.status_code == 200
    body = response.json()
    assert body["data"][0]["sketch_url"] == ""
