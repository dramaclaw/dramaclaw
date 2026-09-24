"""The public generation routes must enforce configured limits before enqueue."""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from novelvideo.api.routes import freezone


@pytest.mark.parametrize(
    "route,body",
    [
        ("keyframes", {"gen_mode": "firstLastFrame", "first_frame_url": "/bad.png"}),
        ("i2v", {"gen_mode": "imageReference", "image_urls": ["/bad.png"]}),
        (
            "omni-gen",
            {
                "gen_mode": "allReference",
                "references": [{"type": "image", "url": "/bad.png"}],
            },
        ),
    ],
)
def test_public_video_route_returns_locatable_errors(
    monkeypatch, tmp_path, route, body
):
    path = tmp_path / "bad.png"
    Image.new("RGB", (299, 300)).save(path)

    async def project(*_):
        return (
            SimpleNamespace(requester_user_id="test"),
            "test",
            "demo",
            tmp_path,
            str(tmp_path),
        )

    async def backend(*_, **__):
        return "newapi_seedance-2.5"

    async def request(*_, **__):
        return (
            {},
            {},
            {
                "supportedModes": [
                    "first_last_frame",
                    "image_reference",
                    "all_reference",
                ],
                "referenceImageMinWidth": 300,
                "referenceImageMax": 30,
            },
        )

    async def scope(*_, **__):
        return None

    def no_backend():
        pytest.fail("invalid input must not reach task backend or billing")

    monkeypatch.setattr(freezone, "_resolve_freezone_project", project)
    monkeypatch.setattr(freezone, "_resolve_catalog_video_backend", backend)
    monkeypatch.setattr(freezone, "_resolve_catalog_request", request)
    monkeypatch.setattr(freezone, "_require_scoped_media_model", scope)
    monkeypatch.setattr(
        freezone, "_resolve_url_list", lambda _root, urls: [str(path) for _ in urls]
    )
    monkeypatch.setattr(freezone, "get_task_backend", no_backend)
    app = FastAPI()
    app.include_router(freezone.router)
    app.dependency_overrides[freezone.get_api_user] = lambda: {"username": "test"}
    response = TestClient(app).post(
        f"/projects/demo/freezone/video/{route}",
        json={"model": "seedance-2.5", "prompt": "test", **body},
    )
    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "REFERENCE_MEDIA_INVALID"
    assert detail["errors"][0]["reference_key"] == "bad.png"
    assert detail["errors"][0]["actual"] == 299
