"""Remote Studio keeps authentication, project authorization and preview origins separate."""

from __future__ import annotations

import json
import asyncio
import os
import subprocess
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from httpx import AsyncClient as HttpxAsyncClient
from starlette.websockets import WebSocketDisconnect

from novelvideo.freezone import studio_proxy as proxy
from novelvideo.freezone.studio import StudioError

EDITOR = "https://app.example.test"
PREVIEW = "https://preview.example.test"
FILM = "film_alice_01"
STATE = {
    "origin": "http://127.0.0.1:4747",
    "film_origin": "http://localhost:4748",
    "key": "private-launch-key",
}
BASE = "/api/v1/projects/alice/freezone/studio/canvas-1/node-1/editor"


@pytest.fixture(autouse=True)
def hosted_env(monkeypatch):
    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", "1")
    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_PUBLIC_ORIGIN", EDITOR)
    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_PREVIEW_ORIGIN", PREVIEW)


def test_hosted_session_never_returns_the_launch_key_or_loopback_address():
    target = (
        f"/projects/{FILM}?lang=zh-CN&hostBack={quote(EDITOR + '/canvas', safe='')}"
    )
    result = proxy.public_session(
        {
            "origin": STATE["origin"],
            "url": STATE["origin"]
            + "/open?key=private-launch-key&to="
            + quote(target, safe=""),
        },
        project="alice",
        canvas="canvas-1",
        node="node-1",
    )
    assert result == {"origin": EDITOR, "url": EDITOR + BASE + target}
    assert "private-launch-key" not in json.dumps(result)
    assert "127.0.0.1" not in json.dumps(result)


def test_local_ce_keeps_its_existing_contract_but_ee_requires_a_remote_configuration(
    monkeypatch,
):
    for name in ["PUBLIC", "PREVIEW"]:
        monkeypatch.delenv(f"SUPERTALE_OPENFILM_STUDIO_{name}_ORIGIN")
    monkeypatch.setattr(proxy.runtime_env, "is_ce_effective", lambda: True)
    session = {"url": "local", "origin": "local"}
    assert proxy.public_session(session, project="p", canvas="c", node="n") is session
    monkeypatch.setattr(proxy.runtime_env, "is_ce_effective", lambda: False)
    with pytest.raises(StudioError, match="isolated preview"):
        proxy.hosted_origins()


@pytest.mark.parametrize(
    "value",
    [
        EDITOR,
        "https://APP.example.test",
        EDITOR + ":443",
        "http://preview.example.test",
        "https://a:b@preview.example.test",
        PREVIEW + "/path",
        PREVIEW + "?key=x",
    ],
)
def test_invalid_or_same_origin_preview_fails_closed(monkeypatch, value):
    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_PREVIEW_ORIGIN", value)
    with pytest.raises(StudioError):
        proxy.hosted_origins()


@pytest.mark.parametrize(
    "path,method",
    [
        ("api/projects/bob/edit", "POST"),
        ("api/projects", "POST"),
        ("api/projects/film_alice_01", "DELETE"),
        ("api/update", "POST"),
        ("api/projects/film_alice_01/files/bring", "POST"),
        ("api/projects/film_alice_01/files/relink", "POST"),
        ("api/projects/film_alice_01/exports/job/open", "POST"),
        ("api/projects/film_alice_01/saved", "POST"),
        ("api/projects/film_alice_01/saved/take", "POST"),
        ("api/projects/film_alice_01/../bob", "GET"),
        ("api/projects/film_alice_01/%2e%2e/bob", "GET"),
    ],
)
def test_proxy_refuses_cross_project_and_host_filesystem_operations(path, method):
    assert not proxy.allowed_editor_path(path, method, FILM)


def test_json_rewrites_preview_urls_and_preserves_film_keys(tmp_path):
    value = proxy.rewrite_json(
        {
            "folder": STATE["film_origin"] + "/p/token/",
            "project": {"path": str(tmp_path)},
            "key": STATE["key"],
            "doc": {"key": "a-film-property", "caption": "/Keep/the/user/text"},
        },
        state=STATE,
        origins=proxy.HostedOrigins(EDITOR, PREVIEW),
        prefix=BASE,
        folder=tmp_path,
    )
    assert value["folder"] == PREVIEW + proxy.PREVIEW_PREFIX + "/p/token/"
    assert value["project"]["path"] == "film"
    assert value["doc"]["key"] == "a-film-property"
    assert value["doc"]["caption"] == "/Keep/the/user/text"
    assert "private-launch-key" not in json.dumps(value)


def test_vendored_router_and_assets_are_scoped_to_the_current_film():
    root = Path(__file__).resolve().parents[1]
    original = next(
        (root / "vendor/openfilm/studio/ui/dist/assets").glob("*.dramaclaw12.js")
    ).read_text()
    adapted = proxy.editor_chunk(original, BASE)
    without_scoped_calls = adapted.replace(BASE + "/api/", "scoped-api/")
    assert '"/api/' not in without_scoped_calls and "`/api/" not in without_scoped_calls
    assert "${location.host}/api/" not in without_scoped_calls
    assert f"location.pathname.slice({len(BASE)})" in adapted
    document = proxy.editor_document(
        '<head><script src="/assets/app.js"></script></head>', BASE
    )
    assert f'src="{BASE}/assets/app.js"' in document
    assert "pushState" in document and "hostBackLabel" in document
    with pytest.raises(StudioError, match="adapter update"):
        proxy.editor_chunk("new upstream bundle", BASE)


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone, openfilm

    folder = tmp_path / "freezone/studio/canvas-1/node-1"
    (folder / ".film").mkdir(parents=True)
    (folder / ".film/id").write_text(FILM)

    async def resolve(project, user):
        if project != "alice" or user["id"] != "alice":
            raise HTTPException(403, "project access denied")
        return None, "alice", "alice", tmp_path, str(tmp_path)

    async def ensure():
        return STATE

    async def register(state, film_folder):
        assert state is STATE and film_folder == folder
        return FILM

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(openfilm.studio, "_ensure_studio", ensure)
    monkeypatch.setattr(openfilm.studio, "_read_state", lambda: STATE)
    monkeypatch.setattr(openfilm.studio, "_studio_project_id", register)
    captured = []

    def upstream(request):
        captured.append(request)
        if request.url.host == "localhost":
            return httpx.Response(
                206,
                stream=httpx.ByteStream(b"video-range"),
                headers={"content-type": "video/mp4", "content-range": "bytes 0-10/20"},
            )
        if request.url.path.endswith("/exports"):
            return httpx.Response(
                200,
                json={"exports": []},
                headers={"set-cookie": "studio=private-launch-key"},
            )
        return httpx.Response(
            200,
            json={
                "project": {"id": FILM, "path": str(folder)},
                "folder": STATE["film_origin"] + "/p/token/",
            },
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        openfilm.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(upstream), **kwargs),
    )
    app = FastAPI()
    app.include_router(openfilm.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "alice",
        "credential_kind": "browser_session",
    }
    result = TestClient(app, base_url=EDITOR)
    result.captured = captured
    result.film_folder = folder
    return result


def test_http_proxy_forwards_only_the_studio_key_and_filters_the_project_list(client):
    response = client.get(
        BASE + "/api/projects",
        headers={
            "cookie": "st_session=private-browser-cookie",
            "authorization": "Bearer other-secret",
        },
    )
    assert response.status_code == 200
    assert [x["id"] for x in response.json()["projects"]] == [FILM]
    request = client.captured[-1]
    assert request.headers["x-studio-key"] == STATE["key"]
    assert "cookie" not in request.headers and "authorization" not in request.headers
    assert response.headers["cache-control"] == "private, no-store"
    assert "private" not in response.text


def test_cross_project_and_cross_origin_writes_never_reach_studio(client):
    assert (
        client.get(
            BASE.replace("/projects/alice/", "/projects/bob/") + f"/api/projects/{FILM}"
        ).status_code
        == 403
    )
    assert (
        client.post(
            BASE + f"/api/projects/{FILM}/edit",
            headers={"origin": "https://evil.example"},
            json={},
        ).status_code
        == 403
    )
    assert client.get(BASE + "/api/projects/bob").status_code == 403
    assert client.captured == []


def test_desktop_exports_cannot_bypass_the_application_task_queue(client):
    response = client.post(
        BASE + f"/api/projects/{FILM}/exports",
        headers={"origin": EDITOR},
        json={"folder": "/etc", "jobs": [{"kind": "video"}]},
    )
    assert response.status_code == 403
    assert client.captured == []


def test_preview_capability_is_read_only_and_never_served_from_the_application_origin(
    client,
):
    path = proxy.PREVIEW_PREFIX + "/p/" + "x" * 24 + "/video.mp4"
    assert client.get(path).status_code == 404
    response = client.get(
        path,
        headers={
            "host": "preview.example.test",
            "range": "bytes=0-10",
            "cookie": "st_session=secret",
        },
    )
    assert response.status_code == 206 and response.content == b"video-range"
    assert response.headers["content-range"] == "bytes 0-10/20"
    assert response.headers["access-control-allow-origin"] == EDITOR
    assert "form-action 'none'" in response.headers["content-security-policy"]
    assert "cookie" not in client.captured[-1].headers
    assert (
        client.post(path, headers={"host": "preview.example.test"}).status_code == 405
    )


@pytest.mark.parametrize(
    "value",
    [
        {"path": ".git/config"},
        {"path": ".GIT/hooks/post-commit"},
        {"ops": [{"op": "set", "field": "src", "value": "../.git/config"}]},
        {"name": "GIT~1/config"},
        {"paths": ["asset.svg", "%2egit/hooks/pre-commit"]},
    ],
)
def test_git_configuration_and_hooks_cannot_be_edited(value):
    with pytest.raises(StudioError, match="Git internals"):
        proxy.validate_browser_paths(value)


def test_repeated_query_parameters_cannot_hide_a_git_path(client):
    response = client.get(
        BASE + f"/api/projects/{FILM}/files?path=.git/config&path=asset.svg"
    )
    assert response.status_code == 403
    assert client.captured == []


def test_host_preferences_cannot_change_other_users_shortcuts_or_storage(client):
    response = client.patch(
        BASE + "/api/prefs", headers={"origin": EDITOR}, json={"projectsFolder": "/etc"}
    )
    assert response.status_code == 403
    assert client.captured == []


@pytest.mark.parametrize("content_type", ["text/plain", "application/octet-stream"])
def test_control_json_path_checks_do_not_trust_content_type(client, content_type):
    response = client.patch(
        BASE + f"/api/projects/{FILM}/files",
        headers={"origin": EDITOR, "content-type": content_type},
        content=json.dumps({"from": "assets/hook", "to": ".git/hooks/pre-commit"}),
    )
    assert response.status_code == 403
    assert client.captured == []


def test_invalid_control_json_is_a_client_error_even_with_non_json_content_type(client):
    response = client.patch(
        BASE + "/api/prefs",
        headers={"origin": EDITOR, "content-type": "text/plain"},
        content="invalid json",
    )
    assert response.status_code == 400
    assert client.captured == []


def test_media_imports_are_not_subject_to_the_small_control_body_limit(client):
    data = b"x" * (9 * 1024 * 1024)
    response = client.put(
        BASE + f"/api/projects/{FILM}/files?path=assets/clip.mp4",
        headers={"origin": EDITOR, "content-type": "video/mp4"},
        content=data,
    )
    assert response.status_code == 200
    assert client.captured[-1].content == data


def test_upload_limit_rejection_closes_the_upstream_client(client, monkeypatch):
    from novelvideo.api.routes import openfilm

    closed = []
    original_close = HttpxAsyncClient.aclose

    async def close(upstream):
        closed.append(upstream)
        await original_close(upstream)

    monkeypatch.setattr(openfilm, "_UPLOAD_LIMIT", 4)
    monkeypatch.setattr(HttpxAsyncClient, "aclose", close)
    response = client.put(
        BASE + f"/api/projects/{FILM}/files?path=assets/clip.mp4",
        headers={"origin": EDITOR, "content-type": "video/mp4"},
        content=b"larger than four bytes",
    )
    assert response.status_code == 413
    assert len(closed) == 1 and closed[0].is_closed
    assert client.captured == []


@pytest.mark.parametrize("unauthenticated", [True, False])
def test_websocket_reuses_session_and_project_authorization(
    client, monkeypatch, unauthenticated
):
    from novelvideo.api.routes import openfilm

    async def user(_request):
        if unauthenticated:
            raise HTTPException(401, "not authenticated")
        return {"id": "alice", "credential_kind": "browser_session"}

    monkeypatch.setattr(openfilm, "get_api_user", user)
    path = (
        BASE if unauthenticated else BASE.replace("/projects/alice/", "/projects/bob/")
    )
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(path + "/api/events", headers={"origin": EDITOR}):
            pytest.fail("unauthorized WebSocket was accepted")
    assert closed.value.code == 1008
    assert client.captured == []


@pytest.mark.parametrize(
    "origin,valid",
    [
        ("", True),
        ("https://preview.example.test", True),
        ("https://preview.example.test:443", True),
        ("http://preview.example.test", False),
        ("https://preview.example.test/path", False),
        ("https://preview.example.test\n", False),
        ("https://a.test https://b.test", False),
        ('https://preview.example.test"; include /tmp/x;', False),
        ("https://a.test:70000", False),
    ],
)
def test_frontend_preview_policy_accepts_only_one_explicit_https_origin(origin, valid):
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            "sh",
            "-c",
            '. "$1"',
            "sh",
            str(root / "frontend/docker/20-openfilm-preview.envsh"),
        ],
        env={**os.environ, "CSP_OPENFILM_PREVIEW_ORIGIN": origin},
        capture_output=True,
    )
    assert (result.returncode == 0) == valid


def test_pod_runtime_state_does_not_collide_with_celery(monkeypatch, tmp_path):
    from novelvideo.freezone import studio

    monkeypatch.setattr(studio, "STATE_DIR", tmp_path)
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "cluster-api")
    monkeypatch.setattr(studio.socket, "gethostname", lambda: "api-pod")
    api = studio._state_dir()
    monkeypatch.setattr(studio.socket, "gethostname", lambda: "worker-pod")
    assert studio._state_dir() != api
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST")
    assert studio._state_dir() == tmp_path / "openfilm"


@pytest.mark.asyncio
async def test_startup_lock_is_exclusive_and_waiting_cancellation_does_not_leak_it(
    monkeypatch, tmp_path
):
    from novelvideo.freezone import studio

    monkeypatch.setattr(studio, "STATE_DIR", tmp_path)
    entered = asyncio.Event()

    async def second():
        async with studio._studio_process_lock():
            entered.set()

    async with studio._studio_process_lock():
        task = asyncio.create_task(second())
        await asyncio.sleep(0.08)
        assert not entered.is_set()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with studio._studio_process_lock():
        pass


def test_hosted_render_uses_the_existing_folder_only_network_policy(tmp_path):
    from novelvideo.freezone import studio

    env = studio._studio_env(4747, "secret", tmp_path / "ready")
    assert env["OPENFILM_HOSTED_RENDER"] == "1"
    assert "ST_CONTROL_PLANE_DSN" not in env
    source = (
        Path(__file__).resolve().parents[1] / "vendor/openfilm/src/host.mjs"
    ).read_text()
    assert "process.env.OPENFILM_HOSTED_RENDER === '1'" in source


def test_worker_threads_with_independent_event_loops_share_one_startup_lock(
    monkeypatch, tmp_path
):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from novelvideo.freezone import studio

    monkeypatch.setattr(studio, "STATE_DIR", tmp_path)
    monkeypatch.setattr(studio, "_read_state", lambda: dict(STATE))
    counter = threading.Lock()
    active = 0
    maximum = 0

    async def health(_origin):
        nonlocal active, maximum
        with counter:
            active += 1
            maximum = max(maximum, active)
        try:
            await asyncio.sleep(0.02)
            return {"filmOrigin": STATE["film_origin"]}
        finally:
            with counter:
                active -= 1

    monkeypatch.setattr(studio, "_health", health)
    barrier = threading.Barrier(2)

    def run(_index):
        barrier.wait(timeout=2)

        async def bounded():
            return await asyncio.wait_for(studio._ensure_studio(), timeout=1)

        return asyncio.run(bounded())

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, range(4)))
    assert len(results) == 4 and maximum == 1


@pytest.mark.asyncio
async def test_cancelled_startup_keeps_the_lock_until_its_thread_finishes(
    monkeypatch, tmp_path
):
    import threading
    from novelvideo.freezone import studio

    monkeypatch.setattr(studio, "STATE_DIR", tmp_path)
    started = threading.Event()
    release = threading.Event()
    ready = threading.Event()
    calls = []

    def spawn():
        calls.append(1)
        started.set()
        assert release.wait(timeout=2)
        ready.set()
        return dict(STATE)

    async def health(_origin):
        return {"filmOrigin": STATE["film_origin"]}

    monkeypatch.setattr(studio, "_spawn_studio", spawn)
    monkeypatch.setattr(
        studio, "_read_state", lambda: dict(STATE) if ready.is_set() else None
    )
    monkeypatch.setattr(studio, "_health", health)
    owner = asyncio.create_task(studio._ensure_studio())
    follower = None
    try:
        assert await asyncio.to_thread(started.wait, 1)
        owner.cancel()
        await asyncio.sleep(0)
        owner.cancel()
        follower = asyncio.create_task(studio._ensure_studio())
        await asyncio.sleep(0.08)
        assert not owner.done() and not follower.done()
        assert len(calls) == 1
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await owner
        assert await follower == STATE
        assert len(calls) == 1
    finally:
        release.set()
        await asyncio.gather(
            owner, *([follower] if follower else []), return_exceptions=True
        )
