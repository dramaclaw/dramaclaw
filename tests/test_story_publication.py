import copy
import json
from pathlib import Path

import pytest

from novelvideo.interactive_story.publication import PublicationStore, PublicationError
from novelvideo.interactive_story.canvas_mapper import project_story_to_canvas
from novelvideo.interactive_story.models import StoryDraftV2


@pytest.fixture
def source(tmp_path, monkeypatch):
    story = StoryDraftV2.model_validate(
        json.loads(Path("examples/interactive_story/story_draft_v2.json").read_text())
    )
    canvas = {
        "nodes": project_story_to_canvas(story).nodes,
        "edges": project_story_to_canvas(story).edges,
        "revision": 1,
    }
    output = tmp_path / "output"
    output.mkdir()
    (output / "clip.mp4").write_bytes(b"original media")
    for node in canvas["nodes"]:
        if node["type"] == "videoNode":
            node["data"]["videoUrl"] = "/api/v1/projects/p/media/clip.mp4"
            node["data"]["storyMedia"] = {
                "status": "ready",
                "url": node["data"]["videoUrl"],
            }
            node["data"].pop("choiceLoopVideoUrl", None)
            node["data"].pop("storyChoiceLoop", None)
    monkeypatch.setattr(
        "novelvideo.interactive_story.publication.canvas_store.read_canvas",
        lambda *args: copy.deepcopy(canvas),
    )
    body = {
        "canvas_id": "c",
        "group_id": next(n["id"] for n in canvas["nodes"] if n["type"] == "groupNode"),
        "revision": 1,
        "request_id": "r1",
        "title": "Story",
        "description": "",
        "cover": None,
    }
    return PublicationStore(tmp_path / "publications", output_dir=output), output, canvas, body


def ready(source):
    store, output, canvas, body = source
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store.finish(prepared)
    version = store.version(prepared["public_id"], prepared["version"])
    assert version["status"] == "ready", version
    return store, output, prepared, version


def test_snapshot_media_and_lifecycle(source):
    store, output, prepared, version = ready(source)
    with pytest.raises(PublicationError):
        store.public(prepared["public_id"])
    store.activate(prepared["public_id"], "owner", prepared["version"], True)
    snapshot = store.public(prepared["public_id"])["snapshot"]
    assert "prompt" not in json.dumps(snapshot)
    (output / "clip.mp4").unlink()
    asset = next(iter(version["assets"]))
    assert (
        store.media_directory(prepared["public_id"], prepared["version"]) / asset
    ).read_bytes() == b"original media"
    store.activate(prepared["public_id"], "owner", None, False)
    with pytest.raises(PublicationError) as exc:
        store.public(prepared["public_id"], prepared["version"])
    assert exc.value.status == 410
    store.activate(prepared["public_id"], "owner", None, True)
    assert store.public(prepared["public_id"])["version"] == prepared["version"]


def test_revision_idempotency_and_owner(source):
    store, output, _, body = source
    with pytest.raises(PublicationError):
        store.prepare("owner", Path("."), output, "p", {**body, "revision": 2})
    first = store.prepare("owner", Path("."), output, "p", body)
    second = store.prepare("owner", Path("."), output, "p", body)
    assert first["version"] == second["version"]
    with pytest.raises(PublicationError):
        store.prepare("owner", Path("."), output, "p", {**body, "title": "changed"})
    with pytest.raises(PublicationError):
        store.owned(first["public_id"], "other")
    with pytest.raises(PublicationError):
        store.directory("../escape")


def test_failed_copy_does_not_replace_online(source):
    store, output, prepared, _ = ready(source)
    store.activate(prepared["public_id"], "owner", prepared["version"], True)
    body = {**source[3], "request_id": "r2"}
    (output / "clip.mp4").unlink()
    failed = store.prepare("owner", Path("."), output, "p", body)
    store.finish(failed)
    assert store.version(failed["public_id"], failed["version"])["status"] == "failed"
    assert store.public(prepared["public_id"])["version"] == prepared["version"]


def test_symlink_media_escape(source, tmp_path):
    store, output, _, body = source
    (output / "clip.mp4").unlink()
    external = tmp_path / "private.mp4"
    external.write_bytes(b"private")
    (output / "clip.mp4").symlink_to(external)
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store.finish(prepared)
    assert (
        store.version(prepared["public_id"], prepared["version"])["status"] == "failed"
    )


def test_recovery_and_captured_source(source):
    store, output, canvas, body = source
    prepared = store.prepare("owner", Path("."), output, "p", body)
    canvas["nodes"] = []
    store.recover()
    assert (
        store.version(prepared["public_id"], prepared["version"])["status"] == "ready"
    )
    assert not list(store.root.glob("*/*/job.json"))
    store.recover()


def test_anonymous_api_manifest_range_and_take_down(source, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from novelvideo.api.routes import story_publications

    index_store, output, canvas, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(index_store.root))
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.interactive_story import publication_storage as storage

    state = output.parent / "state"
    state.mkdir()
    store = storage.project_store("p", state, output)
    store, output, prepared, version = ready((store, output, canvas, body))
    record = SimpleNamespace(
        id="p",
        state_dir=str(state),
        output_dir=str(output),
        status="active",
        purged_at=None,
        home_node_id="local",
    )
    monkeypatch.setattr(
        storage,
        "get_project_registry",
        lambda: SimpleNamespace(get_project=AsyncMock(return_value=record)),
    )
    app = FastAPI()
    app.include_router(story_publications.router, prefix="/api/v1")
    client = TestClient(app)
    path = f"/api/v1/public-stories/{prepared['public_id']}"
    assert client.get(path).status_code == 410
    store.activate(prepared["public_id"], "owner", prepared["version"], True)
    assert client.get(path).status_code == 200
    assert (
        not {"request", "revision", "issues", "error", "progress", "created_at"}
        & client.get(path).json().keys()
    )
    asset = next(iter(version["assets"]))
    media = f"{path}/versions/{prepared['version']}/media/{asset}"
    response = client.get(media, headers={"Range": "bytes=0-3"})
    assert response.status_code == 206
    assert response.content == b"orig"
    assert response.headers["cache-control"] == "no-store"
    assert client.get(media.rsplit("/", 1)[0] + "/private.mp4").status_code == 404
    store.activate(prepared["public_id"], "owner", None, False)
    assert client.get(media).status_code == 410
    assert client.get(f"{path}/versions/{prepared['version']}").status_code == 410


def test_author_scope(source, monkeypatch):
    from types import SimpleNamespace
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import story_publications

    store, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(store.root))
    (output.parent / "state").mkdir()
    roles = []

    async def resolve(project, user, required_role):
        roles.append(required_role)
        if project != "p":
            raise HTTPException(403)
        return SimpleNamespace(
            ctx=SimpleNamespace(state_dir=output.parent / "state"), project_dir=output
        )

    monkeypatch.setattr(story_publications, "resolve_project_scope", resolve)
    from unittest.mock import AsyncMock
    from novelvideo.interactive_story import publication_storage as storage
    record = SimpleNamespace(status="active", purged_at=None, home_node_id="local")
    monkeypatch.setattr(storage, "get_project_registry", lambda: SimpleNamespace(get_project=AsyncMock(return_value=record)))
    app = FastAPI()
    app.include_router(story_publications.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"id": "author"}
    client = TestClient(app)
    path = f"/api/v1/projects/p/canvases/c/stories/{body['group_id']}/publication"
    work = client.get(path).json()["data"]
    assert (
        client.get(path.replace("/projects/p/", "/projects/other/")).status_code == 403
    )
    result = client.post(path + "/prepare", json=body)
    assert result.status_code == 200, result.text
    version = result.json()["data"]["version"]
    assert (
        client.get(f"{path}/{work['public_id']}/versions/{version}").json()["data"][
            "status"
        ]
        == "ready"
    )
    response = client.post(
        f"{path}/{work['public_id']}/activate", json={"version": version}
    )
    assert response.status_code == 200
    assert "share_url" not in response.json()["data"]
    store = PublicationStore(output.parent / "state" / "publications", output_dir=output)
    record_path = store.directory(work["public_id"]) / "work.json"
    original_record = json.loads(record_path.read_text())
    invalid_record = {
        k: v for k, v in original_record.items() if k != "publication_details"
    }
    store.write(record_path, invalid_record)
    failure = client.get(path)
    assert failure.status_code == 500
    assert failure.json()["detail"]["code"] == "publication_data_invalid"
    store.write(record_path, original_record)
    assert set(roles) == {"editor"}
    assert (
        client.get(
            path.replace("/canvases/c/", "/canvases/other/")
            + f"/{work['public_id']}/versions/{version}"
        ).status_code
        == 404
    )


@pytest.fixture
def publication_api(source, monkeypatch):
    """Real bearer authentication and publication storage in an isolated project."""
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from novelvideo.api.routes import story_publications
    from novelvideo.interactive_story import publication_storage as storage
    from novelvideo.ports import registry
    from novelvideo.ports.auth_contract import DEFAULT_EXTERNAL_AGENT_SCOPES
    from novelvideo.ports.local.auth import FileAuthPort, LocalAuthSession

    index_store, output, _, body = source
    state = output.parent / "state"
    state.mkdir()
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(index_store.root))
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "false")
    auth = LocalAuthSession()
    monkeypatch.setitem(registry._PORTS, "auth_session", auth)
    monkeypatch.setitem(registry._PORTS, "auth", FileAuthPort())

    async def resolve(project, user, required_role):
        assert required_role == "editor"
        if project != "p":
            raise HTTPException(403)
        return SimpleNamespace(
            ctx=SimpleNamespace(state_dir=state, project_id="p"), project_dir=output
        )

    monkeypatch.setattr(story_publications, "resolve_project_scope", resolve)
    record = SimpleNamespace(
        id="p", state_dir=str(state), output_dir=str(output), status="active", purged_at=None,
        home_node_id="local",
    )
    monkeypatch.setattr(
        storage, "get_project_registry",
        lambda: SimpleNamespace(get_project=AsyncMock(return_value=record)),
    )

    def headers(scopes=DEFAULT_EXTERNAL_AGENT_SCOPES, project="p"):
        token = asyncio.run(auth.create_agent_session(
            username="local", scopes=scopes,
            current_scope_kind="project", current_project_id=project,
        ))
        return {"Authorization": f"Bearer {token.value}"}

    app = FastAPI()
    app.include_router(story_publications.router, prefix="/api/v1")
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client, headers=headers, body=body,
            path=f"/api/v1/projects/p/canvases/c/stories/{body['group_id']}/publication",
            state=state, output=output, index_root=index_store.root, record=record,
        )


@pytest.mark.parametrize("operation", ["prepare", "publish", "unlist", "relist", "rollback"])
def test_default_agent_cannot_mutate_publication(publication_api, operation):
    api = publication_api
    # A precise lifecycle token creates two real releases for the denied actions.
    authorized = api.headers(["projects:read", "projects:lifecycle"])
    versions = []
    for request_id in ("first", "second"):
        response = api.client.post(
            api.path + "/prepare", headers=authorized,
            json={**api.body, "request_id": request_id},
        )
        assert response.status_code == 200, response.text
        versions.append(response.json()["data"])
        if request_id == "first":
            # Keep the first version online so preparing an update retains it.
            first = versions[0]
            published = api.client.post(
                f"{api.path}/{first['public_id']}/activate", headers=authorized,
                json={"version": first["version"], "listed": True},
            )
            assert published.status_code == 200, published.text
    public_id = versions[0]["public_id"]
    activate_path = f"{api.path}/{public_id}/activate"
    response = api.client.post(
        activate_path, headers=authorized,
        json={"version": versions[1]["version"], "listed": operation != "relist"},
    )
    assert response.status_code == 200, response.text
    before = {
        path: path.read_bytes()
        for root in (api.state, api.index_root) for path in root.rglob("*.json")
    }
    headers = api.headers()
    payload = {
        "publish": {"version": versions[1]["version"], "listed": True},
        "unlist": {"listed": False},
        "relist": {"listed": True},
        "rollback": {"version": versions[0]["version"], "listed": True},
    }
    response = api.client.post(
        api.path + "/prepare" if operation == "prepare" else activate_path,
        headers=headers,
        json={**api.body, "request_id": "denied"} if operation == "prepare" else payload[operation],
    )
    assert response.status_code == 403, response.text
    assert "projects:lifecycle" in response.json()["detail"]
    after = {
        path: path.read_bytes()
        for root in (api.state, api.index_root) for path in root.rglob("*.json")
    }
    assert after == before
    # Read/preview remains available to the default agent after the denied mutation.
    response = api.client.get(api.path, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["active_version"] == versions[1]["version"]
    preview = api.client.get(
        f"{api.path}/{public_id}/versions/{versions[0]['version']}", headers=headers,
    )
    assert preview.status_code == 200, preview.text


@pytest.mark.parametrize("credential", ["browser", "lifecycle_agent"])
def test_authorized_publication_lifecycle(publication_api, credential):
    api = publication_api
    headers = {} if credential == "browser" else api.headers(["projects:read", "projects:lifecycle"])
    releases = []
    for request_id in ("first", "second"):
        response = api.client.post(
            api.path + "/prepare", headers=headers,
            json={**api.body, "request_id": request_id},
        )
        assert response.status_code == 200, response.text
        release = response.json()["data"]
        preview = api.client.get(
            f"{api.path}/{release['public_id']}/versions/{release['version']}", headers=headers,
        )
        assert preview.json()["data"]["status"] == "ready", preview.text
        releases.append(release)
        if request_id == "first":
            published = api.client.post(
                f"{api.path}/{release['public_id']}/activate", headers=headers,
                json={"version": release["version"], "listed": True},
            )
            assert published.status_code == 200, published.text
    public_id = releases[0]["public_id"]
    first, second = (release["version"] for release in releases)
    for version, listed, expected in (
        (first, True, first),
        (None, False, first),
        (None, True, first),
        (second, True, second),
        (first, True, first),  # Roll back to an older release.
    ):
        response = api.client.post(
            f"{api.path}/{public_id}/activate", headers=headers,
            json={"version": version, "listed": listed},
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["active_version"] == expected
        assert response.json()["data"]["listed"] is listed
        public = api.client.get(f"/api/v1/public-stories/{public_id}")
        assert public.status_code == (200 if listed else 410), public.text
        if listed:
            assert public.json()["version"] == expected


@pytest.mark.parametrize("operation", ["prepare", "activate"])
def test_publication_lifecycle_token_cannot_write_other_project(publication_api, operation):
    api = publication_api
    headers = api.headers(["projects:read", "projects:lifecycle"], project="other")
    path = api.path + ("/prepare" if operation == "prepare" else f"/{'a' * 32}/activate")
    response = api.client.post(
        path, headers=headers, json=api.body if operation == "prepare" else {"listed": True},
    )
    assert response.status_code == 403, response.text
    assert "scope mismatch" in response.json()["detail"].lower()
    assert not (api.state / "publications").exists()


def test_update_keeps_old_version_and_rollback(source):
    store, output, first, _ = ready(source)
    store.activate(first["public_id"], "owner", first["version"], True)
    body = {**source[3], "request_id": "update", "title": "Updated"}
    second = store.prepare("owner", Path("."), output, "p", body)
    store.finish(second)
    store.activate(second["public_id"], "owner", second["version"], True)
    assert store.public(first["public_id"])["title"] == "Updated"
    assert store.public(first["public_id"], first["version"])["title"] == "Story"
    store.activate(first["public_id"], "owner", first["version"], True)
    assert store.public(first["public_id"])["title"] == "Story"


def test_unpublished_version_stays_private(source):
    store, output, first, _ = ready(source)
    store.activate(first["public_id"], "owner", first["version"], True)
    pending = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "pending"}
    )
    store.finish(pending)
    with pytest.raises(PublicationError) as exc:
        store.public(first["public_id"], pending["version"])
    assert exc.value.status == 404


def test_concurrent_requests_prepare_once(source):
    from concurrent.futures import ThreadPoolExecutor

    store, output, _, body = source
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda _: store.prepare("owner", Path("."), output, "p", body), range(2)
            )
        )
    assert results[0]["version"] == results[1]["version"]
    assert len(store.read(results[0]["public_id"])["versions"]) == 1


def test_two_branch_two_ending_publication(source):
    store, output, canvas, body = source
    story = StoryDraftV2.model_validate(
        {
            "story_id": "two_endings",
            "title": "Two roads",
            "start_segment_id": "start",
            "segments": [
                {"id": "start", "title": "Start", "script": "Choose a road."},
                {
                    "id": "left",
                    "title": "Left",
                    "script": "Left ending",
                    "kind": "ending",
                    "ending_label": "GE",
                },
                {
                    "id": "right",
                    "title": "Right",
                    "script": "Right ending",
                    "kind": "ending",
                    "ending_label": "BE",
                },
            ],
            "choices": [
                {
                    "id": "left_choice",
                    "source_segment_id": "start",
                    "target_segment_id": "left",
                    "text": "Left",
                    "order": 0,
                },
                {
                    "id": "right_choice",
                    "source_segment_id": "start",
                    "target_segment_id": "right",
                    "text": "Right",
                    "order": 1,
                },
            ],
        }
    )
    projection = project_story_to_canvas(story)
    canvas.update(nodes=projection.nodes, edges=projection.edges)
    for node in canvas["nodes"]:
        if node["type"] == "videoNode":
            node["data"]["videoUrl"] = "/api/v1/projects/p/media/clip.mp4"
    body["group_id"] = projection.group_id
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store.finish(prepared)
    store.activate(prepared["public_id"], "owner", prepared["version"], True)
    snapshot = store.public(prepared["public_id"])["snapshot"]
    assert len(snapshot["edges"]) == 2
    assert sum(bool(n["data"].get("endingLabel")) for n in snapshot["nodes"]) == 2
    assert len(list((output / "publications").glob("*/*/media/*.mp4"))) == 1


def test_preparation_persists_only_playback_inputs(source):
    store, output, canvas, body = source
    canvas["nodes"].append(
        {
            "id": "unrelated",
            "type": "imageNode",
            "data": {"private_editor_note": "not-public"},
            "position": {"x": 0, "y": 0},
        }
    )
    prepared = store.prepare("owner", Path("."), output, "p", body)
    job = (
        store.directory(prepared["public_id"]) / prepared["version"] / "job.json"
    ).read_text()
    assert "private_editor_note" not in job
    assert "video_prompt" not in job
    assert '"prompt"' not in job


def test_wrong_project_media_url_is_rejected(source):
    store, output, canvas, body = source
    node = next(n for n in canvas["nodes"] if n["type"] == "videoNode")
    node["data"]["videoUrl"] = "/api/v1/projects/other/media/clip.mp4"
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store.finish(prepared)
    assert (
        store.version(prepared["public_id"], prepared["version"])["status"] == "failed"
    )


def test_signed_url_is_rejected_before_persistence(source):
    store, output, canvas, body = source
    node = next(n for n in canvas["nodes"] if n["type"] == "videoNode")
    node["data"]["videoUrl"] = "/api/v1/projects/p/media/clip.mp4?signature=example"
    with pytest.raises(PublicationError):
        store.prepare("owner", Path("."), output, "p", body)
    assert not list(store.root.glob("*/*/job.json"))


def test_cover_cache_buster_is_stripped_before_archival(source):
    store, output, _, body = source
    (output / "cover.jpg").write_bytes(b"cover")
    prepared = store.prepare(
        "owner",
        Path("."),
        output,
        "p",
        {
            **body,
            "cover": "/static/projects/p/cover.jpg?v=123",
        },
    )
    assert prepared["request"]["cover"] == "/static/projects/p/cover.jpg"
    store.finish(prepared)
    version = store.version(prepared["public_id"], prepared["version"])
    assert version["status"] == "ready"
    assert version["cover"].endswith(".jpg")


def test_media_changed_before_background_copy_requires_new_preparation(source):
    store, output, first, _ = ready(source)
    store.activate(first["public_id"], "owner", first["version"], True)
    pending = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "changed"}
    )
    (output / "clip.mp4").write_bytes(b"replaced before worker starts")
    store.recover()
    failed = store.version(pending["public_id"], pending["version"])
    assert failed["status"] == "failed"
    assert failed["error"] == "media_changed_retry"
    assert not (
        store.media_directory(pending["public_id"], pending["version"])
    ).exists()
    assert store.public(first["public_id"])["version"] == first["version"]
    retried = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "retry"}
    )
    store.finish(retried)
    assert store.version(retried["public_id"], retried["version"])["status"] == "ready"


def test_failed_activation_never_exposes_new_version(source, monkeypatch):
    store, output, first, _ = ready(source)
    store.activate(first["public_id"], "owner", first["version"], True)
    pending = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "second"}
    )
    store.finish(pending)
    version_path = (
        store.directory(pending["public_id"]) / pending["version"] / "version.json"
    )
    original_version = version_path.read_bytes()
    write = store.write

    def fail_commit(path, value):
        if path.name == "work.json":
            with pytest.raises(PublicationError) as exc:
                store.public(pending["public_id"], pending["version"])
            assert exc.value.status == 404
            raise OSError("injected failure before commit")
        write(path, value)

    with monkeypatch.context() as patch:
        patch.setattr(store, "write", fail_commit)
        with pytest.raises(OSError):
            store.activate(pending["public_id"], "owner", pending["version"], True)
    assert store.public(first["public_id"])["version"] == first["version"]
    with pytest.raises(PublicationError):
        store.public(pending["public_id"], pending["version"])
    store.activate(pending["public_id"], "owner", pending["version"], True)
    store.activate(pending["public_id"], "owner", pending["version"], True)
    assert version_path.read_bytes() == original_version
    assert len(store.read(first["public_id"])["published_versions"]) == 2
    assert store.public(first["public_id"], first["version"])["published"]


def test_accepted_retry_survives_draft_changes(source):
    store, output, canvas, body = source
    first = store.prepare("owner", Path("."), output, "p", body)
    canvas["revision"] += 1
    canvas["nodes"] = []
    retry = store.prepare("owner", Path("."), output, "p", body)
    assert retry["version"] == first["version"]
    assert len(store.read(first["public_id"])["versions"]) == 1
    store.recover()
    assert store.version(first["public_id"], first["version"])["status"] == "ready"


def test_concurrent_activations_preserve_both_committed_versions(source):
    from concurrent.futures import ThreadPoolExecutor

    store, output, first, _ = ready(source)
    store.activate(first["public_id"], "owner", first["version"], True)
    second = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "second"}
    )
    store.finish(second)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(store.activate, p["public_id"], "owner", p["version"], True)
            for p in (first, second)
        ]
        for future in futures:
            future.result()
    work = store.read(first["public_id"])
    assert set(work["published_versions"]) == {first["version"], second["version"]}
    for pending in (first, second):
        assert store.public(pending["public_id"], pending["version"])["published"]


def test_media_changed_during_copy_is_rejected(source, monkeypatch):
    import shutil

    store, output, _, body = source
    pending = store.prepare("owner", Path("."), output, "p", body)
    copyfile = shutil.copyfile

    def change_after_copy(src, dst):
        copyfile(src, dst)
        src.write_bytes(b"changed during copy")

    monkeypatch.setattr(shutil, "copyfile", change_after_copy)
    store.finish(pending)
    version = store.version(pending["public_id"], pending["version"])
    assert version["status"] == "failed"
    assert version["error"] == "media_changed_retry"
    assert not (
        store.media_directory(pending["public_id"], pending["version"])
    ).exists()


def test_release_numbers_follow_successful_publications_and_rollback_keeps_date(source):
    store, output, _, body = source
    abandoned = store.prepare("owner", Path("."), output, "p", body)
    store.finish(abandoned)
    first = store.prepare(
        "owner", Path("."), output, "p", {**body, "request_id": "first"}
    )
    store.finish(first)
    assert "number" not in store.version(first["public_id"], first["version"])
    store.activate(first["public_id"], "owner", first["version"], True)
    v1 = store.public(first["public_id"])
    assert v1["number"] == 1
    assert v1["published_at"]
    # The abandoned check is now retired; only actual publications get numbers.
    assert abandoned["version"] not in store.read(first["public_id"])["versions"]
    second = store.prepare(
        "owner", Path("."), output, "p", {**body, "request_id": "second"}
    )
    store.finish(second)
    store.activate(first["public_id"], "owner", second["version"], True)
    assert store.public(first["public_id"])["number"] == 2
    store.activate(first["public_id"], "owner", None, False)
    store.activate(first["public_id"], "owner", first["version"], False)
    assert not store.read(first["public_id"])["listed"]
    restored = store.version(first["public_id"], first["version"])
    assert (restored["number"], restored["published_at"]) == (1, v1["published_at"])


def test_cover_framing_is_versioned_and_public(source):
    from novelvideo.interactive_story.publication import public_version
    from novelvideo.api.routes.story_publications import PrepareBody
    from pydantic import ValidationError

    store, output, _, body = source
    (output / "poster.png").write_bytes(b"poster")
    body = {
        **body,
        "cover": "/api/v1/projects/p/media/poster.png",
        "cover_mode": "portrait",
        "cover_position_x": 25,
        "cover_position_y": 75,
    }
    PrepareBody.model_validate(body)
    with pytest.raises(ValidationError):
        PrepareBody.model_validate({**body, "cover_position_x": 101})
    pending = store.prepare("owner", Path("."), output, "p", body)
    store.finish(pending)
    store.activate(pending["public_id"], "owner", pending["version"], True)
    body["cover_mode"] = "landscape"
    (output / "poster.png").unlink()
    published = public_version(store.public(pending["public_id"]))
    assert published["cover_mode"] == "portrait"
    assert published["cover_position_x"] == 25
    assert published["cover_position_y"] == 75
    assert "/versions/" in published["cover"]


@pytest.mark.parametrize("query", ["foo=bar", "token=", "signature", "%74oken=x"])
def test_media_query_policy_is_shared(source, query):
    from novelvideo.interactive_story.publication import local_media_path

    store, output, _, body = source
    url = f"/api/v1/projects/p/media/clip.mp4?{query}"
    for action in (
        lambda: local_media_path(url),
        lambda: store.media_source("a" * 32, "p", output, url, True),
        lambda: store.prepare("owner", Path("."), output, "p", {**body, "cover": url}),
    ):
        with pytest.raises(PublicationError, match="media_requires_local_archive"):
            action()


def test_cache_busters_are_allowed():
    from novelvideo.interactive_story.publication import local_media_path

    assert local_media_path("/clip.mp4?st_v=123&v=&st_thumb=1") == "/clip.mp4"


def test_publication_lock_busy_has_retryable_error(source, monkeypatch):
    import portalocker

    store = source[0]

    def busy(*args, **kwargs):
        raise portalocker.exceptions.LockException("busy")

    monkeypatch.setattr(portalocker.Lock, "acquire", busy)
    with pytest.raises(PublicationError) as exc:
        with store.locked():
            pytest.fail("must not enter a busy lock")
    assert (exc.value.code, exc.value.status) == ("publication_busy", 503)


def test_player_manifest_excludes_author_diagnostics(source):
    from novelvideo.interactive_story.publication import player_version

    store, _, prepared, _ = ready(source)
    store.activate(prepared["public_id"], "owner", prepared["version"], True)
    version = store.public(prepared["public_id"])
    result = player_version({**version, "error": "internal", "progress": {"total": 5}})
    assert result["snapshot"] == version["snapshot"]
    assert (
        not {
            "revision",
            "issues",
            "error",
            "progress",
            "created_at",
            "request",
            "assets",
            "status",
        }
        & result.keys()
    )


@pytest.mark.asyncio
async def test_activation_emits_project_audit(source, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.api.routes import story_publications as routes

    store, _, prepared, _ = ready(source)
    ctx = SimpleNamespace(requester_user_id="author", project_id="p", state_dir=".")
    monkeypatch.setattr(
        routes, "scope", AsyncMock(return_value=(SimpleNamespace(ctx=ctx, project_dir=source[1]), "owner"))
    )
    monkeypatch.setattr(routes, "project_store", lambda *_: store)
    from novelvideo.interactive_story import publication_storage as storage
    record = SimpleNamespace(status="active", purged_at=None, home_node_id="local")
    monkeypatch.setattr(storage, "get_project_registry", lambda: SimpleNamespace(get_project=AsyncMock(return_value=record)))
    audit = AsyncMock()
    monkeypatch.setattr(routes, "emit_project_audit", audit)
    await routes.activate(
        "p",
        "c",
        "g",
        prepared["public_id"],
        routes.ActivateBody(version=prepared["version"]),
        {},
    )
    assert audit.await_args.kwargs["ctx"] is ctx
    assert audit.await_args.kwargs["metadata"] == {
        "public_id": prepared["public_id"],
        "active_version": prepared["version"],
        "listed": True,
    }
    await routes.activate(
        "p", "c", "g", prepared["public_id"], routes.ActivateBody(listed=False), {}
    )
    assert audit.await_args.kwargs["metadata"]["listed"] is False


def test_out_of_bounds_choice_has_actionable_issue(source):
    store, output, canvas, body = source
    edge = canvas["edges"][0]
    edge["data"]["interaction"] = {
        "presentation": "object-anchor",
        "anchor": {"x": 0.1, "y": 0.5, "width": 0.24, "height": 0.14},
    }
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store.finish(prepared)
    release = store.version(prepared["public_id"], prepared["version"])
    assert release["status"] == "failed"
    issue = next(
        i for i in release["issues"] if i["code"] == "choice_area_outside_left"
    )
    assert issue["entity_id"] == edge["id"]
    assert issue["node_id"] == edge["source"]
    assert issue["entity_label"]


@pytest.mark.parametrize("defect", ["missing_start", "unknown_variable", "invalid_cta"])
def test_author_validation_failure_preserves_online_version(source, defect):
    store, output, first, _ = ready(source)
    store.activate(first["public_id"], "owner", first["version"], True)
    canvas, body = source[2:]
    if defect == "missing_start":
        for node in canvas["nodes"]:
            node["data"].pop("storyRole", None)
        canvas["edges"] = []
    elif defect == "unknown_variable":
        canvas["edges"][0]["data"]["condition"] = {
            "var": "missing_variable",
            "op": ">",
            "value": 0,
        }
    else:
        next(n for n in canvas["nodes"] if n["type"] == "videoNode")["data"][
            "storyCta"
        ] = {"label": "Visit", "url": "not-a-url"}
    prepared = store.prepare(
        "owner", Path("."), output, "p", {**body, "request_id": defect}
    )
    store.finish(prepared)
    release = store.version(prepared["public_id"], prepared["version"])
    assert release["status"] == "failed"
    assert release["error"] == "invalid_story"
    assert store.public(first["public_id"])["version"] == first["version"]
    assert not (
        store.media_directory(prepared["public_id"], prepared["version"])
    ).exists()


def test_unexpected_mapping_failure_remains_system_error(source, monkeypatch):
    store, output, _, body = source

    def fail(*args):
        raise ValueError("unexpected internal failure")

    monkeypatch.setattr(
        "novelvideo.interactive_story.publication.story_from_canvas", fail
    )
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store.finish(prepared)
    assert (
        store.version(prepared["public_id"], prepared["version"])["error"]
        == "publication_check_failed"
    )


def test_unexpected_task_error_is_persisted_and_not_left_preparing(source, monkeypatch):
    store, output, _, body = source
    prepared = store.prepare("owner", Path("."), output, "p", body)

    def fail(*args):
        raise KeyError("internal field")

    monkeypatch.setattr(store, "version", fail)
    store.finish(prepared)
    directory = store.directory(prepared["public_id"]) / prepared["version"]
    result = json.loads((directory / "version.json").read_text())
    assert result["status"] == "failed"
    assert result["error"] == "publication_check_failed"
    assert not (directory / "job.json").exists()


def test_superseded_drafts_remove_media_and_do_not_reappear_on_retry(source):
    store, output, first, _ = ready(source)
    second = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "second"}
    )
    store.finish(second)
    directory = store.directory(first["public_id"])
    assert not (directory / first["version"]).exists()
    assert not store.media_directory(first["public_id"], first["version"]).exists()
    assert store.read(first["public_id"])["versions"] == [second["version"]]
    with pytest.raises(PublicationError, match="version_not_ready"):
        store.prepare("owner", Path("."), output, "p", source[3])
    with pytest.raises(PublicationError, match="idempotency_conflict"):
        store.prepare(
            "owner", Path("."), output, "p", {**source[3], "title": "Changed"}
        )
    store.finish(first)  # Late duplicate worker invocation is harmless.
    assert not (directory / first["version"]).exists()


def test_failed_new_draft_preserves_last_ready_and_bounds_failed_history(source):
    store, output, first, _ = ready(source)
    (output / "clip.mp4").unlink()
    for request_id in ("failed1", "failed2"):
        failed = store.prepare(
            "owner", Path("."), output, "p", {**source[3], "request_id": request_id}
        )
        store.finish(failed)
    assert store.read(first["public_id"])["versions"] == [
        first["version"],
        failed["version"],
    ]
    assert (store.media_directory(first["public_id"], first["version"])).is_dir()
    (output / "clip.mp4").write_bytes(b"fixed")
    newest = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "fixed"}
    )
    store.finish(newest)
    assert store.read(first["public_id"])["versions"] == [newest["version"]]


def test_pending_jobs_protect_archived_sources_and_finish_order(source):
    store, output, first, first_version = ready(source)
    # Use an archived image as the next draft's cover.
    image = output / "cover.png"
    image.write_bytes(b"cover")
    body = {
        **source[3],
        "request_id": "cover",
        "cover": "/api/v1/projects/p/media/cover.png",
    }
    covered = store.prepare("owner", Path("."), output, "p", body)
    store.finish(covered)
    archived_cover = store.version(covered["public_id"], covered["version"])["cover"]
    older = store.prepare(
        "owner",
        Path("."),
        output,
        "p",
        {**body, "request_id": "older", "cover": archived_cover},
    )
    newer = store.prepare(
        "owner",
        Path("."),
        output,
        "p",
        {**body, "request_id": "newer", "cover": archived_cover},
    )
    store.finish(newer)
    assert (
        store.media_directory(covered["public_id"], covered["version"])
    ).exists()
    store.finish(older)
    # Creation order, not completion order, decides which draft survives.
    assert store.read(newer["public_id"])["versions"] == [newer["version"]]
    assert store.version(newer["public_id"], newer["version"])["status"] == "ready"


def test_cleanup_retries_disk_failure_without_breaking_index(source, monkeypatch):
    import shutil

    store, output, first, _ = ready(source)
    second = store.prepare(
        "owner", Path("."), output, "p", {**source[3], "request_id": "second"}
    )
    original = shutil.rmtree

    def fail_removal(path, *args, **kwargs):
        if Path(path).name == first["version"]:
            raise OSError("disk busy")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", fail_removal)
    store.finish(second)
    work = store.read(first["public_id"])
    assert work["versions"] == [second["version"]]
    assert work["pending_cleanup"] == [first["version"]]
    assert store.media_directory(first["public_id"], first["version"]).is_dir()
    monkeypatch.setattr(shutil, "rmtree", original)
    store.recover()
    assert not (store.directory(first["public_id"]) / first["version"]).exists()
    assert not store.media_directory(first["public_id"], first["version"]).exists()
    assert store.read(first["public_id"])["pending_cleanup"] == []


def test_startup_prunes_legacy_drafts_but_preserves_published_history(
    source, monkeypatch
):
    store, output, first, _ = ready(source)
    store.activate(first["public_id"], "owner", first["version"], True)
    with monkeypatch.context() as patch:
        patch.setattr(store, "_prune_best_effort", lambda *_: None)
        for i in range(3):
            pending = store.prepare(
                "owner",
                Path("."),
                output,
                "p",
                {**source[3], "request_id": f"legacy{i}"},
            )
            store.finish(pending)
    store.recover()
    assert store.read(first["public_id"])["versions"] == [
        first["version"],
        pending["version"],
    ]
    assert store.public(first["public_id"])["version"] == first["version"]


def test_repeated_video_and_loop_share_one_archived_file(source):
    store, output, canvas, body = source
    for node in canvas["nodes"]:
        if node["type"] == "videoNode":
            node["data"]["choiceLoopVideoUrl"] = node["data"]["videoUrl"]
    store, _, prepared, version = ready(source)
    files = list(
        (
            store.media_directory(prepared["public_id"], prepared["version"])
        ).iterdir()
    )
    assert len(files) == 1
    assert files[0].read_bytes() == b"original media"
    for node in version["snapshot"]["nodes"]:
        if node["type"] == "videoNode":
            assert node["data"]["choiceLoopVideoUrl"] == node["data"]["videoUrl"]
    assert version["progress"]["completed"] == version["progress"]["total"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["deleted", "archived"])
async def test_project_delete_blocks_prepare_and_republication_restore_stays_offline(source, monkeypatch, status):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.interactive_story import publication_storage as storage

    store, output, first, _ = ready(source)
    record = SimpleNamespace(status="active", purged_at=None, home_node_id="local")
    monkeypatch.setattr(storage, "get_project_registry", lambda: SimpleNamespace(get_project=AsyncMock(return_value=record)))
    store.activate(first["public_id"], "owner", first["version"], True)
    with store.locked():
        store.unlist_all()
    record.status = status
    with pytest.raises(PublicationError, match="unavailable"):
        await storage.invoke_active(store, store.activate, first["public_id"], "owner", first["version"], True)
    with pytest.raises(PublicationError, match="unavailable"):
        await storage.invoke_active(store, store.prepare, "owner", Path("."), output, "p", {**source[3], "request_id": "late"})
    record.status = "active"
    with pytest.raises(PublicationError, match="unavailable"):
        store.public(first["public_id"])
    await storage.invoke_active(store, store.activate, first["public_id"], "owner", first["version"], True)
    assert store.public(first["public_id"])["version"] == first["version"]


@pytest.mark.asyncio
async def test_global_publication_data_is_ignored(source, monkeypatch):
    from novelvideo.interactive_story import publication_storage as storage

    old_store, output, first, _ = ready(source)
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(old_store.root))
    state = output.parent / "state"
    state.mkdir()
    store = storage.project_store("p", state, output)
    assert store.root == state / "publications"
    assert not list(store.root.glob("*/work.json"))
    assert old_store.directory(first["public_id"]).is_dir()
    with pytest.raises(PublicationError, match="not_found"):
        await storage.public_store(first["public_id"])
    work = store.work("owner", "p")
    assert work["public_id"] != first["public_id"]
    assert json.loads(
        (old_store.root / "index" / f"{work['public_id']}.json").read_text()
    ) == {"project_id": "p"}


def test_project_move_includes_pending_job_and_late_worker_cannot_recreate_files(
    source, monkeypatch
):
    from novelvideo.interactive_story.publication_storage import project_store

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    pending = store.prepare("owner", state, output, "p", body)
    detached = state.with_name("state-purging")
    with store.locked():
        state.rename(detached)
    assert (
        detached
        / "publications"
        / pending["public_id"]
        / pending["version"]
        / "job.json"
    ).exists()
    store.finish(pending)
    assert not state.exists()
    detached.rename(state)
    store.recover()
    interrupted = store.version(pending["public_id"], pending["version"])
    assert interrupted["status"] == "failed"
    assert interrupted["error"] == "publication_interrupted"
    retry = store.prepare("owner", state, output, "p", {**body, "request_id": "retry-after-restore"})
    store.finish(retry)
    assert store.version(retry["public_id"], retry["version"])["status"] == "ready"


@pytest.mark.parametrize("contention", ["project", "job", "project_detached"])
def test_background_finish_retries_lock_timeout(source, monkeypatch, contention):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Event

    from novelvideo.interactive_story.publication_storage import project_store

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    pending = store.prepare("owner", state, output, "p", body)
    directory = store.directory(pending["public_id"]) / pending["version"]
    timed_out = Event()
    original_lock = store.file_lock

    @contextmanager
    def observed_lock(path):
        try:
            with original_lock(path):
                yield
        except PublicationError as exc:
            if exc.code == "publication_busy":
                timed_out.set()
            raise

    monkeypatch.setattr(store, "file_lock", observed_lock)
    held_lock = (
        store.file_lock(directory / ".job-lock")
        if contention == "job"
        else store.locked()
    )
    # Observe a real lock timeout, then release it before joining the worker.
    with ThreadPoolExecutor(max_workers=1) as executor:
        with held_lock:
            future = executor.submit(store.finish, pending)
            assert timed_out.wait(timeout=10)
            if contention == "project_detached":
                state.rename(state.with_name("state-purging"))
        future.result(timeout=10)

    if contention == "project_detached":
        assert not state.exists()
    else:
        assert store.version(pending["public_id"], pending["version"])["status"] == "ready"
        assert not (directory / "job.json").exists()
        assert list(store.media_directory(pending["public_id"], pending["version"]).iterdir())


def test_project_lock_blocks_cleanup_during_copy(source, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from novelvideo.interactive_story.publication_storage import project_store

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)

    def competing_operation():
        with store.locked():
            raise AssertionError("must not acquire the copying worker's lock")

    with store.locked(), ThreadPoolExecutor(max_workers=1) as executor:
        with pytest.raises(PublicationError, match="publication_busy"):
            executor.submit(competing_operation).result()
    assert state.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,purged,exists",
    [("deleted", None, True), ("archived", None, True), ("active", "now", True), ("active", None, False)],
)
async def test_public_index_never_bypasses_project_lifecycle(
    source, monkeypatch, status, purged, exists
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.interactive_story import publication_storage as storage

    index_store, output, canvas, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(index_store.root))
    state = output.parent / "state"
    state.mkdir()
    store = storage.project_store("p", state, output)
    store, output, first, _ = ready((store, output, canvas, body))
    store.activate(first["public_id"], "owner", first["version"], True)
    record = SimpleNamespace(
        id="p",
        state_dir=str(state),
        output_dir=str(output),
        status=status,
        purged_at=purged,
        home_node_id="local",
    )
    monkeypatch.setattr(
        storage,
        "get_project_registry",
        lambda: SimpleNamespace(
            get_project=AsyncMock(return_value=record if exists else None)
        ),
    )
    assert store.read(first["public_id"])[
        "listed"
    ]  # Even a stale public flag cannot bypass registry checks.
    with pytest.raises(PublicationError, match="unavailable"):
        await storage.public_store(first["public_id"])


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["active", "archived"])
async def test_ce_restart_rebuilds_index_from_project_owned_data(source, monkeypatch, status):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.interactive_story import publication_storage as storage
    from novelvideo.shared import runtime_env

    index_store, output, canvas, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(index_store.root))
    state = output.parent / "state"
    state.mkdir()
    store = storage.project_store("p", state, output)
    store, output, first, _ = ready((store, output, canvas, body))
    store.activate(first["public_id"], "owner", first["version"], True)
    index = index_store.root / "index" / f"{first['public_id']}.json"
    index.unlink()
    record = SimpleNamespace(
        id="p",
        state_dir=str(state),
        output_dir=str(output),
        status=status,
        purged_at=None,
        home_node_id="local",
    )
    monkeypatch.setattr(
        storage,
        "get_project_registry",
        lambda: SimpleNamespace(
            get_project=AsyncMock(return_value=record),
            list_accessible_projects=AsyncMock(return_value=[record]),
        ),
    )
    monkeypatch.setattr(runtime_env, "is_ce_effective", lambda: True)
    await storage.recover_project_publications()
    assert index.is_file()
    if status == "active":
        assert (await storage.public_store(first["public_id"])).public(first["public_id"])[
            "version"
        ] == first["version"]
    else:
        assert not store.read(first["public_id"])["listed"]
        with pytest.raises(PublicationError, match="unavailable"):
            await storage.public_store(first["public_id"])


def test_interrupted_preparation_is_retryable_without_changing_online_version(source):
    from novelvideo.interactive_story import preparation_lease

    store, output, published, _ = ready(source)
    store.activate(published['public_id'], 'owner', published['version'], True)
    (output / 'cover.png').write_bytes(b'cover')
    body = {**source[3], 'request_id': 'interrupted', 'cover': '/api/v1/projects/p/media/cover.png'}
    pending = store.prepare('owner', Path('.'), output, 'p', body)
    directory = store.directory(pending['public_id']) / pending['version']
    media = store.media_directory(pending['public_id'], pending['version'])
    media.mkdir(parents=True)
    (media / 'partial.mp4').write_bytes(b'partial')
    # A queued job is alive even before finish() acquires its execution lock.
    observer = PublicationStore(store.root, output_dir=output)
    assert observer.version(pending['public_id'], pending['version'])['status'] == 'preparing'
    preparation_lease.release(directory)  # Same OS effect as the owning process exiting.
    failed = observer.version(pending['public_id'], pending['version'])
    assert failed['status'] == 'failed'
    assert failed['error'] == 'publication_interrupted'
    assert failed['cover'] == body['cover']
    assert not media.exists()
    assert not (directory / 'job.json').exists()
    assert store.public(published['public_id'])['version'] == published['version']
    # A lost-response retry stays idempotent; an explicit retry gets a new request ID.
    assert store.prepare('owner', Path('.'), output, 'p', body)['error'] == 'publication_interrupted'
    retry = store.prepare('owner', Path('.'), output, 'p', {**body, 'request_id': 'retry'})
    store.finish(retry)
    assert store.version(retry['public_id'], retry['version'])['status'] == 'ready'
    assert store.public(published['public_id'])['version'] == published['version']


def test_preparation_owner_process_exit_is_detected(source):
    import subprocess
    import sys

    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    pending = store.prepare('owner', Path('.'), output, 'p', body)
    directory = store.directory(pending['public_id']) / pending['version']
    preparation_lease.release(directory)
    worker = subprocess.Popen(
        [sys.executable, '-c',
         'import portalocker, sys; '
         'lock = portalocker.Lock(sys.argv[1], mode="a", timeout=0); '
         'lock.acquire(); print("ready", flush=True); sys.stdin.read()',
         str(directory / '.owner-lock')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert worker.stdout.readline().strip() == 'ready'
        assert store.version(pending['public_id'], pending['version'])['status'] == 'preparing'
        worker.kill()
        worker.wait(timeout=5)
        assert store.version(pending['public_id'], pending['version'])['error'] == 'publication_interrupted'
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait(timeout=5)
        worker.stdin.close()
        worker.stdout.close()


def test_interruption_write_holds_project_lock(source, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    store.index_root = output.parent / "index"
    pending = store.prepare("owner", Path("."), output, "p", body)
    directory = store.directory(pending["public_id"]) / pending["version"]
    preparation_lease.release(directory)
    original_write = store.write
    checked = []

    def competing_lifecycle_operation():
        # Even the same store on another thread must acquire the project lock.
        with pytest.raises(PublicationError, match="publication_busy"):
            with store.locked():
                pytest.fail("lifecycle operation entered during interruption write")

    def observed_write(path, value):
        if value.get("error") == "publication_interrupted":
            with ThreadPoolExecutor(max_workers=1) as executor:
                executor.submit(competing_lifecycle_operation).result(timeout=5)
            checked.append(True)
        original_write(path, value)

    monkeypatch.setattr(store, "write", observed_write)
    assert store.version(pending["public_id"], pending["version"])["error"] == "publication_interrupted"
    assert checked and all(checked)


@pytest.mark.parametrize("change", ["detach", "retire"])
def test_interruption_rechecks_project_and_membership_under_lock(source, monkeypatch, change):
    import shutil

    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    state = output.parent / "state"
    state.mkdir()
    store = PublicationStore(state / "publications", index_root=output.parent / "index", output_dir=output)
    pending = store.prepare("owner", state, output, "p", body)
    directory = store.directory(pending["public_id"]) / pending["version"]
    preparation_lease.release(directory)
    original_read = store.read
    changed = False

    def read_then_change(public_id):
        nonlocal changed
        work = original_read(public_id)
        if not changed:
            changed = True
            # A lifecycle operation finishes between the optimistic read and
            # acquisition of the project lock.
            other = PublicationStore(store.root, index_root=store.index_root, output_dir=output)
            with other.locked():
                if change == "detach":
                    state.rename(state.with_name("detached"))
                else:
                    other.write(directory.parent / "work.json", {**work, "versions": []})
                    shutil.rmtree(directory)
        return work

    monkeypatch.setattr(store, "read", read_then_change)
    with pytest.raises(PublicationError, match="unavailable" if change == "detach" else "not_found"):
        store.version(pending["public_id"], pending["version"])
    assert not directory.exists()
    if change == "detach":
        assert not state.exists()


@pytest.mark.parametrize("operation", ["prepare", "prune"])
def test_interruption_reconciles_inside_existing_project_lock(source, operation):
    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    store.index_root = output.parent / "index"
    pending = store.prepare("owner", Path("."), output, "p", body)
    preparation_lease.release(store.directory(pending["public_id"]) / pending["version"])
    if operation == "prepare":
        result = store.prepare("owner", Path("."), output, "p", body)
        assert result["version"] == pending["version"]
        assert result["error"] == "publication_interrupted"
    else:
        store.prune_drafts(pending["public_id"])
    assert store.version(pending["public_id"], pending["version"])["error"] == "publication_interrupted"


@pytest.mark.parametrize("partial", [False, True])
def test_publication_rejects_reachable_conditional_dead_end(source, partial):
    store, output, canvas, body = source
    case = "state-dependent-dead-end" if partial else "visible-conditional-dead-end"
    story = StoryDraftV2.model_validate(
        json.loads(Path(f"tests/fixtures/interactive_story/cases/{case}.json").read_text())["story"]
    )
    projection = project_story_to_canvas(story)
    canvas.update(nodes=projection.nodes, edges=projection.edges)
    body["group_id"] = projection.group_id
    for node in canvas["nodes"]:
        if node["type"] == "videoNode":
            node["data"]["videoUrl"] = "/api/v1/projects/p/media/clip.mp4"
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store.finish(prepared)
    version = store.version(prepared["public_id"], prepared["version"])
    assert version["status"] == "failed"
    assert version["error"] == "invalid_story"
    assert any(i["code"] == "runtime_dead_end" and i["severity"] == "error" for i in version["issues"])
    with pytest.raises(PublicationError, match="version_not_ready"):
        store.activate(prepared["public_id"], "owner", prepared["version"], True)


def test_publication_separates_media_from_state(source):
    store, output, _, body = source
    prepared = store.prepare("owner", Path("."), output, "p", body)
    directory = store.directory(prepared["public_id"]) / prepared["version"]
    assert (directory / "job.json").is_file()
    store.finish(prepared)
    media = store.media_directory(prepared["public_id"], prepared["version"])
    assert media == output / "publications" / prepared["public_id"] / prepared["version"] / "media"
    assert list(media.glob("*.mp4"))
    assert (directory / "version.json").is_file()
    assert not list(store.root.rglob("*.mp4"))
    assert not list((output / "publications").rglob("*.json"))
    assert not list((output / "publications").rglob(".*lock"))


@pytest.mark.parametrize("legacy_archive", [False, True])
def test_archive_unlists_all_works_and_unarchive_requires_manual_listing(
    publication_api, monkeypatch, legacy_archive
):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.api.routes import projects

    api = publication_api
    prepared = api.client.post(api.path + "/prepare", json=api.body).json()["data"]
    public_id, version = prepared["public_id"], prepared["version"]
    activate = f"{api.path}/{public_id}/activate"
    assert api.client.post(activate, json={"version": version, "listed": True}).status_code == 200
    store = PublicationStore(api.state / "publications", output_dir=api.output)
    other = store.work("another-owner", "p")
    other["listed"] = True
    store.write(store.directory(other["public_id"]) / "work.json", other)
    asset = next(iter(store.version(public_id, version)["assets"]))
    public = f"/api/v1/public-stories/{public_id}"
    urls = [public, f"{public}/versions/{version}", f"{public}/versions/{version}/media/{asset}"]
    ctx = SimpleNamespace(
        project_id="p", state_dir=api.state, is_home_node=True, effective_role="owner"
    )

    async def update(project_id, status):
        api.record.status = status
        return api.record

    registry = SimpleNamespace(get_project=AsyncMock(return_value=api.record), update_project_status=update)
    monkeypatch.setattr(projects, "get_project_registry", lambda: registry)
    monkeypatch.setattr(projects, "resolve_project_context", AsyncMock(return_value=ctx))
    monkeypatch.setattr(projects, "_summary_for_record", AsyncMock(return_value=SimpleNamespace(model_dump=lambda: {})))
    monkeypatch.setattr(projects, "emit_project_audit", AsyncMock())
    if legacy_archive:
        # Old releases archived projects without clearing their public flags.
        api.record.status = "archived"
        assert store.read(public_id)["listed"]
    else:
        asyncio.run(projects.archive_project("p", user={}))
        assert not store.read(public_id)["listed"]
        assert not store.read(other["public_id"])["listed"]
    assert api.record.status == "archived"
    for url in urls:
        assert api.client.get(url, follow_redirects=False).status_code == 410
    assert api.client.post(activate, json={"version": version, "listed": True}).status_code == 410
    assert api.client.post(api.path + "/prepare", json={**api.body, "request_id": "while-archived"}).status_code == 410
    asyncio.run(projects.unarchive_project("p", user={}))
    assert api.record.status == "active"
    assert not store.read(public_id)["listed"]
    assert not store.read(other["public_id"])["listed"]
    for url in urls:
        assert api.client.get(url, follow_redirects=False).status_code == 410
    assert api.client.post(activate, json={"version": version, "listed": True}).status_code == 200
    for url in urls:
        assert api.client.get(url, follow_redirects=False).status_code == 200
    assert not store.read(other["public_id"])["listed"]


@pytest.mark.parametrize("delivery", ["oss", "not_ready", "disabled", "error"])
def test_publication_media_reuses_oss_delivery_after_authorization(publication_api, monkeypatch, delivery):
    from types import SimpleNamespace
    from novelvideo import config
    from novelvideo.utils import oss_client

    api = publication_api
    prepared = api.client.post(api.path + "/prepare", json=api.body).json()["data"]
    public_id, version = prepared["public_id"], prepared["version"]
    store = PublicationStore(api.state / "publications", output_dir=api.output)
    release = store.version(public_id, version)
    asset = next(iter(release["assets"]))
    media_path = store.media_directory(public_id, version) / asset
    expected_key = f"output/publications/{public_id}/{version}/media/{asset}"
    signed = []
    probes = []

    class Bucket:
        def head_object(self, key):
            probes.append(key)
            if delivery in {"not_ready", "error"}:
                raise OSError("object not readable")
            return SimpleNamespace(content_length=media_path.stat().st_size, last_modified=media_path.stat().st_mtime)

        def sign_url(self, method, key, expires, **kwargs):
            signed.append(key)
            return "https://media.example.test/signed-video"

    monkeypatch.setattr(config, "OUTPUT_DIR", api.output)
    monkeypatch.setattr(config, "OSS_OBJECT_PREFIX", "output")
    monkeypatch.setattr(config, "STATIC_VIA_OSS", delivery != "disabled")
    monkeypatch.setattr(config, "OSS_STATIC_REQUIRE_READY", True)
    monkeypatch.setattr(config, "OSS_STATIC_READY_PROBE_ATTEMPTS", 1)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: Bucket())
    monkeypatch.setattr(oss_client, "_static_ready_cache", set())
    monkeypatch.setattr(oss_client, "_presign_cache", {})
    if delivery == "error":
        def unavailable():
            raise OSError("OSS unavailable")
        monkeypatch.setattr(oss_client, "get_bucket", unavailable)

    public = f"/api/v1/public-stories/{public_id}/versions/{version}/media/{asset}"
    preview = f"{api.path}/{public_id}/versions/{version}/media/{asset}"
    assert api.client.get(public, follow_redirects=False).status_code == 410
    assert not probes and not signed
    for url in (preview, public):
        if url == public:
            result = api.client.post(f"{api.path}/{public_id}/activate", json={"version": version})
            assert result.status_code == 200
        response = api.client.get(url, headers={"Range": "bytes=0-3"}, follow_redirects=False)
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        if delivery == "oss":
            assert response.status_code == 302
            assert response.headers["location"] == "https://media.example.test/signed-video"
            assert signed == [expected_key]  # Existing signature cache is shared.
        else:
            assert response.status_code == 206
            assert response.content == b"orig"
    before = (len(probes), len(signed))
    assert api.client.get(public.rsplit("/", 1)[0] + "/unknown.mp4", follow_redirects=False).status_code == 404
    api.client.post(f"{api.path}/{public_id}/activate", json={"listed": False})
    assert api.client.get(public, follow_redirects=False).status_code == 410
    assert (len(probes), len(signed)) == before


def test_terminal_job_after_crash_does_not_block_future_draft_cleanup(source):
    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    first = store.prepare("owner", Path("."), output, "p", body)
    directory = store.directory(first["public_id"]) / first["version"]
    store._finish(first)  # Process exits after saving ready, before removing job.json.
    preparation_lease.release(directory)
    restarted = PublicationStore(store.root, output_dir=output)
    restarted.recover()
    assert not (directory / "job.json").exists()
    assert restarted.version(first["public_id"], first["version"])["status"] == "ready"
    for i in range(3):
        latest = restarted.prepare("owner", Path("."), output, "p", {**body, "request_id": f"next-{i}"})
        restarted.finish(latest)
    assert restarted.read(first["public_id"])["versions"] == [latest["version"]]
    assert len(list((output / "publications").glob("*/*/media/*.mp4"))) == 1


def test_uncommitted_job_is_collected_without_blocking_other_drafts(source, monkeypatch):
    import errno

    store, output, _, body = source
    original = store.write
    def fail_commit(path, value):
        if path.name == "work.json" and value["versions"]:
            raise OSError(errno.ENOSPC, "index write failed")
        original(path, value)
    with monkeypatch.context() as patch:
        patch.setattr(store, "write", fail_commit)
        with pytest.raises(OSError):
            store.prepare("owner", Path("."), output, "p", body)
    orphan = next(store.root.glob("*/*/job.json")).parent
    store.recover()
    assert not orphan.exists()
    # The failed request was never committed; its request ID remains retryable.
    first = store.prepare("owner", Path("."), output, "p", body)
    store.finish(first)
    second = store.prepare("owner", Path("."), output, "p", {**body, "request_id": "second"})
    store.finish(second)
    assert store.read(second["public_id"])["versions"] == [second["version"]]
    assert not store.media_directory(first["public_id"], first["version"]).exists()


@pytest.mark.parametrize("interrupted", [False, True])
def test_failed_media_cleanup_retries_after_restart(source, monkeypatch, interrupted):
    import shutil
    from novelvideo.interactive_story import preparation_lease

    store, output, published, _ = ready(source)
    store.activate(published["public_id"], "owner", published["version"], True)
    pending = store.prepare("owner", Path("."), output, "p", {**source[3], "request_id": "fail"})
    directory = store.directory(pending["public_id"]) / pending["version"]
    media = store.media_directory(pending["public_id"], pending["version"])
    original = shutil.rmtree
    def fail_removal(path, *args, **kwargs):
        if Path(path) == media.parent:
            raise OSError("temporary storage error")
        return original(path, *args, **kwargs)
    def fail_copy(src, dst):
        Path(dst).write_bytes(b"partial")
        raise OSError("interrupted copy")
    with monkeypatch.context() as patch:
        patch.setattr(shutil, "rmtree", fail_removal)
        if interrupted:
            media.mkdir(parents=True)
            (media / "partial.mp4").write_bytes(b"partial")
            preparation_lease.release(directory)
            store.version(pending["public_id"], pending["version"])
        else:
            patch.setattr(shutil, "copyfile", fail_copy)
            store.finish(pending)
        release = store.version(pending["public_id"], pending["version"])
        assert release["status"] == "failed"
        assert release["media_cleanup_pending"] is True
        assert media.exists()
    restarted = PublicationStore(store.root, output_dir=output)
    restarted.recover()
    release = restarted.version(pending["public_id"], pending["version"])
    assert release["status"] == "failed"
    assert not release.get("media_cleanup_pending")
    assert not media.exists()
    assert restarted.public(published["public_id"])["version"] == published["version"]
    assert restarted.media_directory(published["public_id"], published["version"]).exists()


@pytest.mark.parametrize("interrupted", [False, True])
def test_disk_full_reclaims_partial_media_before_writing_failure(source, monkeypatch, interrupted):
    import errno
    import shutil
    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    prepared = store.prepare("owner", Path("."), output, "p", body)
    directory = store.directory(prepared["public_id"]) / prepared["version"]
    media = store.media_directory(prepared["public_id"], prepared["version"])
    original_write = store.write

    def disk_full_write(path, value):
        # CE state and output may share a full filesystem. Removing the partial
        # copy must free space before the atomic metadata write can succeed.
        if media.exists():
            raise OSError(errno.ENOSPC, "no space for metadata")
        original_write(path, value)

    def disk_full_copy(src, dst):
        Path(dst).write_bytes(b"partial")
        raise OSError(errno.ENOSPC, "no space for media")

    monkeypatch.setattr(store, "write", disk_full_write)
    if interrupted:
        media.mkdir(parents=True)
        (media / "partial.mp4").write_bytes(b"partial")
        preparation_lease.release(directory)
    else:
        monkeypatch.setattr(shutil, "copyfile", disk_full_copy)
        store.finish(prepared)
    release = store.version(prepared["public_id"], prepared["version"])
    assert release["status"] == "failed"
    assert not release.get("media_cleanup_pending")
    assert not media.exists()
    assert not (directory / "job.json").exists()
    assert json.loads((directory / "version.json").read_text())["status"] == "failed"


def test_terminal_job_unlink_failure_is_retried_without_losing_media(source, monkeypatch):
    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    prepared = store.prepare("owner", Path("."), output, "p", body)
    store._finish(prepared)
    directory = store.directory(prepared["public_id"]) / prepared["version"]
    preparation_lease.release(directory)
    job = directory / "job.json"
    original = Path.unlink

    def fail_unlink(path, *args, **kwargs):
        if path == job:
            raise OSError("temporary unlink error")
        return original(path, *args, **kwargs)

    restarted = PublicationStore(store.root, output_dir=output)
    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", fail_unlink)
        restarted.recover()
        assert job.exists()
        assert restarted.version(prepared["public_id"], prepared["version"])["status"] == "ready"
    restarted.recover()
    assert not job.exists()
    assert restarted.media_directory(prepared["public_id"], prepared["version"]).is_dir()
