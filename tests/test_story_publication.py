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
    path = api.path + ("/prepare" if operation == "prepare" else f"/{'a' * 32}/{operation}")
    response = api.client.post(
        path, headers=headers, json=api.body if operation == "prepare" else {"listed": True, "version": "b" * 32},
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
        Path(src).write_bytes(b"changed during copy")

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
        routes.BackgroundTasks(),
        {},
    )
    assert audit.await_args.kwargs["ctx"] is ctx
    assert audit.await_args.kwargs["metadata"] == {
        "public_id": prepared["public_id"],
        "active_version": prepared["version"],
        "listed": True,
    }
    await routes.activate(
        "p", "c", "g", prepared["public_id"], routes.ActivateBody(listed=False), routes.BackgroundTasks(), {}
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
        patch.setattr(store, "_prune_best_effort", lambda *_, **__: None)
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
    def observed_lock(path, **kwargs):
        try:
            with original_lock(path, **kwargs):
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
    assert failed['media_cleanup_pending'] and observer.cleanup_requested
    assert media.exists()
    observer.prune_drafts(pending['public_id'])
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
    if interrupted:
        assert store.cleanup_requested
        store.prune_drafts(prepared["public_id"])
        release = store.version(prepared["public_id"], prepared["version"])
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


@pytest.mark.parametrize("status", ["archived", "deleted", "active"])
def test_copy_allows_polling_and_project_lifecycle(source, monkeypatch, status):
    import asyncio
    import shutil
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from types import SimpleNamespace
    from novelvideo.interactive_story.publication_storage import (
        project_store, set_project_status_and_unlist,
    )

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    first = store.prepare("owner", state, output, "p", body)
    store.finish(first)
    store.activate(first["public_id"], "owner", first["version"], True)
    pending = store.prepare("owner", state, output, "p", {**body, "request_id": "next"})
    entered, resume = Event(), Event()
    original = shutil.copyfile

    def slow_copy(src, dst):
        entered.set()
        assert resume.wait(10)
        return original(src, dst)

    class Registry:
        async def update_project_status(self, project_id, new_status):
            assert project_id == "p"
            return SimpleNamespace(status=new_status)

    monkeypatch.setattr(shutil, "copyfile", slow_copy)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(store.finish, pending)
        try:
            assert entered.wait(5)
            reader = project_store("p", state, output)
            assert reader.version(pending["public_id"], pending["version"])["status"] == "preparing"
            result = asyncio.run(set_project_status_and_unlist("p", state, Registry(), status))
            assert result.status == status
        finally:
            resume.set()
            future.result(timeout=10)
    assert store.version(pending["public_id"], pending["version"])["status"] == "ready"
    assert store.read(pending["public_id"])["listed"] is False


@pytest.mark.parametrize("phase", ["before_mkdir", "before_copy", "after_copy"])
def test_permanent_delete_waits_for_copy_without_blocking_queries(source, monkeypatch, phase):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from types import SimpleNamespace
    from novelvideo.interactive_story import publication
    from novelvideo.interactive_story.publication_storage import project_store, detach_project_publications

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    pending = store.prepare("owner", state, output, "p", body)
    entered, resume, deleting = Event(), Event(), Event()
    record = SimpleNamespace(id="p", state_dir=str(state), output_dir=str(output))
    detached = []

    def detach(record):
        for root in (state, output):
            root.rename(root.with_name(root.name + "-removed"))
        detached.append(True)
        return []

    def validate(record):
        deleting.set()

    def remove():
        return asyncio.run(detach_project_publications(record, detach, lambda _: None, validate=validate))

    original_directory = store.media_directory
    def media_directory(*args):
        result = original_directory(*args)
        if phase == "before_mkdir" and not entered.is_set():
            entered.set()
            assert resume.wait(10)
        return result

    original_copy = publication.copy_project_file
    def copy_file(src, dst, **kwargs):
        if phase == "after_copy":
            original_copy(src, dst, **kwargs)
        if phase != "before_mkdir":
            entered.set()
            assert resume.wait(10)
        if phase != "after_copy":
            return original_copy(src, dst, **kwargs)

    monkeypatch.setattr(store, "media_directory", media_directory)
    monkeypatch.setattr(publication, "copy_project_file", copy_file)
    with ThreadPoolExecutor(max_workers=2) as pool:
        copying = pool.submit(store.finish, pending)
        try:
            assert entered.wait(5)
            deletion = pool.submit(remove)
            assert deleting.wait(5)
            # Even a waiting deletion must not acquire the metadata lock.
            reader = project_store("p", state, output)
            assert reader.version(pending["public_id"], pending["version"])["status"] == "preparing"
            with pytest.raises(PublicationError, match="publication_busy"):
                deletion.result(timeout=5)
            assert not detached
            assert state.exists() and output.exists()
        finally:
            resume.set()
            copying.result(timeout=10)
    assert store.version(pending["public_id"], pending["version"])["status"] == "ready"
    remove()
    assert detached == [True]
    assert not state.exists() and not output.exists()


@pytest.mark.parametrize("oss_result", ["success", "error", "not_ready"])
def test_publication_uses_oss_copy_and_filesystem_fallback(source, monkeypatch, oss_result):
    import shutil
    from novelvideo.freezone import asset_copy

    _, output, _, _ = source
    copies, local = [], []
    class Bucket:
        bucket_name = "test-bucket"
        def copy_object(self, bucket, src, dst):
            copies.append((bucket, src, dst))
            if oss_result == "error":
                raise OSError("OSS temporarily unavailable")
            (output / dst).write_bytes((output / src).read_bytes())

    monkeypatch.setattr(asset_copy.oss_client, "get_bucket", lambda: Bucket())
    monkeypatch.setattr(asset_copy.oss_client, "local_path_to_key", lambda p: str(p.relative_to(output)))
    monkeypatch.setattr(asset_copy.oss_client, "object_matches_local", lambda *args: oss_result != "not_ready")
    original = shutil.copyfile
    def filesystem(src, dst):
        local.append(dst)
        if oss_result == "success":
            pytest.fail("ready OSS objects must use CopyObject")
        return original(src, dst)
    monkeypatch.setattr(shutil, "copyfile", filesystem)
    store, _, prepared, version = ready(source)
    assert bool(copies) == (oss_result != "not_ready")
    assert bool(local) == (oss_result != "success")
    assert next(store.media_directory(prepared["public_id"], version["version"]).iterdir()).read_bytes() == b"original media"


def publish_retention_version(source, request_id):
    store, output, _, body = source
    prepared = store.prepare("owner", Path("."), output, "p", {**body, "request_id": request_id})
    store.finish(prepared)
    store.activate(prepared["public_id"], "owner", prepared["version"], True)
    return prepared


@pytest.mark.parametrize("limit", [None, "1", "3"])
def test_published_retention_default_and_config(source, monkeypatch, limit):
    store, output, _, body = source
    if limit is None:
        monkeypatch.delenv("ST_PUBLICATION_RETENTION_LIMIT", raising=False)
    else:
        monkeypatch.setenv("ST_PUBLICATION_RETENTION_LIMIT", limit)
    store = PublicationStore(store.root, output_dir=output)
    source = (store, output, source[2], body)
    count = int(limit or 10)
    releases = [publish_retention_version(source, f"retention-{i}") for i in range(count + 2)]
    pid = releases[-1]["public_id"]
    work = store.read(pid)
    expected = [v["version"] for v in releases[-count:]]
    assert work["published_versions"] == expected
    assert work["versions"] == expected
    assert set(work["publication_details"]) == set(expected)
    assert work["active_version"] == expected[-1]
    assert work["publication_details"][expected[-1]]["number"] == count + 2
    for release in releases[:-count]:
        assert not store.media_directory(pid, release["version"]).parent.exists()
        assert not (store.directory(pid) / release["version"]).exists()
        with pytest.raises(PublicationError, match="not_found"):
            store.public(pid, release["version"])
        with pytest.raises(PublicationError, match="version_not_ready"):
            store.prepare("owner", Path("."), output, "p", {**body, "request_id": release["request_id"]})


@pytest.mark.parametrize("listed", [True, False])
def test_retention_protects_old_active_version_without_reordering(source, listed):
    store = source[0]
    releases = [publish_retention_version(source, f"active-{i}") for i in range(4)]
    pid = releases[0]["public_id"]
    store.activate(pid, "owner", releases[0]["version"], listed)
    store.retention_limit = 2
    store.prune_drafts(pid)
    expected = [releases[i]["version"] for i in (0, 2, 3)]
    assert store.read(pid)["published_versions"] == expected
    assert store.media_directory(pid, expected[0]).is_dir()
    # Moving the active pointer allows the formerly protected version to retire.
    store.activate(pid, "owner", releases[2]["version"], True)
    assert store.read(pid)["published_versions"] == expected[1:]
    assert not store.media_directory(pid, expected[0]).exists()


def test_retention_defers_while_preparation_references_old_media(source):
    store, output, _, body = source
    releases = [publish_retention_version(source, f"pending-{i}") for i in range(3)]
    pid = releases[0]["public_id"]
    old = store.version(pid, releases[0]["version"])
    url = next(n["data"]["videoUrl"] for n in old["snapshot"]["nodes"] if n["type"] == "videoNode")
    for node in source[2]["nodes"]:
        if node["type"] == "videoNode":
            node["data"]["videoUrl"] = url
            node["data"]["storyMedia"]["url"] = url
    pending = store.prepare("owner", Path("."), output, "p", {**body, "request_id": "using-old"})
    store.retention_limit = 1
    store.activate(pid, "owner", releases[-1]["version"], True)
    assert len(store.read(pid)["published_versions"]) == 3
    assert store.media_directory(pid, releases[0]["version"]).exists()
    store.finish(pending)
    assert store.version(pid, pending["version"])["status"] == "ready"
    assert store.read(pid)["published_versions"] == [releases[-1]["version"]]
    assert not store.media_directory(pid, releases[0]["version"]).exists()


def test_retention_removal_failure_retries_after_restart(source, monkeypatch):
    store, output, _, _ = source
    first = publish_retention_version(source, "delete-first")
    store.retention_limit = 1
    original = store._remove_tree

    def fail(path):
        if path.name == first["version"]:
            raise OSError("busy media")
        return original(path)

    monkeypatch.setattr(store, "_remove_tree", fail)
    second = publish_retention_version(source, "delete-second")
    work = store.read(first["public_id"])
    assert work["published_versions"] == [second["version"]]
    assert work["pending_cleanup"] == [first["version"]]
    assert store.public(first["public_id"])["version"] == second["version"]
    restarted = PublicationStore(store.root, output_dir=output)
    restarted.prune_drafts(first["public_id"])
    assert restarted.read(first["public_id"])["pending_cleanup"] == []
    assert not store.media_directory(first["public_id"], first["version"]).exists()


@pytest.mark.parametrize("value", ["0", "-1", "invalid", ""])
def test_invalid_publication_retention_falls_back_to_ten(source, monkeypatch, value):
    monkeypatch.setenv("ST_PUBLICATION_RETENTION_LIMIT", value)
    assert PublicationStore(source[0].root, output_dir=source[1]).retention_limit == 10


def test_author_presentation_exposes_configured_retention(source, monkeypatch):
    from novelvideo.api.routes.story_publications import presentation

    monkeypatch.setenv("ST_PUBLICATION_RETENTION_LIMIT", "5")
    store = PublicationStore(source[0].root, output_dir=source[1])
    result = presentation(store, store.work("owner", "p"))
    assert result["retention_limit"] == 5


@pytest.mark.parametrize("replacement", ["empty", "same_contents"])
def test_old_preparation_cannot_modify_recreated_project(source, monkeypatch, replacement):
    import asyncio
    import shutil
    from types import SimpleNamespace
    from novelvideo.interactive_story import publication
    from novelvideo.interactive_story.publication_storage import project_store, detach_project_publications

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    pending = store.prepare("owner", state, output, "p", body)
    record = SimpleNamespace(id="p", state_dir=str(state), output_dir=str(output))
    def detach(record):
        for root in (state, output):
            root.rename(root.with_name(root.name + "-removed"))
        return []
    asyncio.run(detach_project_publications(record, detach, lambda _: None, validate=lambda _: None))
    for root in (state, output):
        if replacement == "same_contents":
            shutil.copytree(root.with_name(root.name + "-removed"), root)
        else:
            root.mkdir()
        (root / "new-project-marker").write_text("new project")
    def unexpected_copy(*args, **kwargs):
        pytest.fail("stale worker must not start either OSS or filesystem copy")
    monkeypatch.setattr(publication, "copy_project_file", unexpected_copy)
    before = {str(p): p.read_bytes() for root in (state, output) for p in root.rglob("*") if p.is_file()}
    store.finish(pending)
    after = {str(p): p.read_bytes() for root in (state, output) for p in root.rglob("*") if p.is_file()}
    assert after == before


def test_queued_worker_does_not_open_job_in_rebuilt_project(source, monkeypatch):
    import shutil
    from novelvideo.interactive_story.publication_storage import project_store

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    pending = store.prepare("owner", state, output, "p", body)
    with store.locked():
        for root in (state, output):
            old = root.with_name(root.name + "-removed")
            root.rename(old)
            shutil.copytree(old, root)
    before = {str(p): p.read_bytes() for root in (state, output) for p in root.rglob("*") if p.is_file()}
    store.finish(pending)
    after = {str(p): p.read_bytes() for root in (state, output) for p in root.rglob("*") if p.is_file()}
    assert after == before


def test_project_identity_binds_output_when_first_created(tmp_path, monkeypatch):
    from novelvideo.interactive_story.publication_storage import project_store

    monkeypatch.setenv("ST_PUBLICATION_DIR", str(tmp_path / "index"))
    state, output = tmp_path / "state", tmp_path / "output"
    state.mkdir()
    store = project_store("p", state, output)
    # Metadata-only projects do not need an output directory.
    store.work("owner", "p")
    assert not output.exists()
    output.mkdir()
    with store.locked():
        pass
    output.rename(tmp_path / "old-output")
    output.mkdir()
    with pytest.raises(PublicationError) as error:
        with store.locked():
            pytest.fail("a replaced output directory must reject the old store")
    assert error.value.code == "unavailable"


def test_cleanup_defers_without_waiting_under_metadata_lock(source, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    store, output, prepared, version = ready(source)
    reader = PublicationStore(store.root, output_dir=output)
    media = reader.media_directory(prepared["public_id"], prepared["version"])
    entered, resume = Event(), Event()

    def hold_media():
        with store.media_locked():
            entered.set()
            assert resume.wait(5)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(hold_media)
        try:
            assert entered.wait(5)
            # Cleanup can be reached from version reconciliation while holding
            # the metadata lock. It must defer, not wait for the copying worker.
            with reader.locked():
                failed = {**version, "status": "failed", "media_cleanup_pending": True}
                reader._retry_media_cleanup(failed)
                reader.prune_drafts(prepared["public_id"])
                assert failed["media_cleanup_pending"]
                assert media.exists()
        finally:
            resume.set()
            future.result(timeout=5)
    with reader.locked():
        reader._retry_media_cleanup(failed)
    assert not failed.get("media_cleanup_pending")
    assert not media.exists()


@pytest.mark.parametrize("phase", ["mkdir", "copy_failure", "state_read_failure", "cleanup_retry"])
def test_slow_preparation_media_io_does_not_block_author_queries(source, monkeypatch, phase):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from novelvideo.interactive_story import publication
    from novelvideo.interactive_story.publication_storage import project_store

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    pending = store.prepare("owner", state, output, "p", body)
    pid, vid = pending["public_id"], pending["version"]
    media = store.media_directory(pid, vid)
    entered, resume = Event(), Event()
    original_mkdir = Path.mkdir
    original_remove = store._remove_tree
    original_version = store.version
    removals = 0

    def pause():
        entered.set()
        assert resume.wait(10)

    def slow_mkdir(path, *args, **kwargs):
        if path == media and not entered.is_set():
            pause()
        return original_mkdir(path, *args, **kwargs)

    def fail_copy(src, dst, **kwargs):
        dst.write_bytes(b"partial")
        raise OSError("copy interrupted")

    def slow_remove(path):
        nonlocal removals
        if path == media.parent:
            removals += 1
            if phase == "cleanup_retry" and removals == 1:
                raise OSError("temporary cleanup failure")
            pause()
        return original_remove(path)

    def fail_initial_read(*args):
        if not entered.is_set():
            raise ValueError("unexpected state read failure")
        return original_version(*args)

    if phase == "mkdir":
        monkeypatch.setattr(Path, "mkdir", slow_mkdir)
    else:
        monkeypatch.setattr(publication, "copy_project_file", fail_copy)
        monkeypatch.setattr(store, "_remove_tree", slow_remove)
        if phase == "state_read_failure":
            media.mkdir(parents=True)
            (media / "partial.mp4").write_bytes(b"partial")
            monkeypatch.setattr(store, "version", fail_initial_read)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(store.finish, pending)
        try:
            assert entered.wait(5)
            # Must complete before releasing the slow storage operation.
            reader = project_store("p", state, output)
            release = reader.version(pid, vid)
            assert release["status"] in {"preparing", "failed"}
            assert not future.done()
            if phase == "cleanup_retry":
                newer = reader.prepare(
                    "owner", state, output, "p", {**body, "request_id": "during-cleanup"}
                )
        finally:
            resume.set()
            future.result(timeout=10)
    release = original_version(pid, vid)
    assert release["status"] == ("ready" if phase == "mkdir" else "failed")
    assert not release.get("media_cleanup_pending")
    if phase != "mkdir":
        assert not media.exists()
    if phase == "cleanup_retry":
        # Cleanup must not overwrite the work index captured before this prepare.
        assert newer["version"] in reader.read(pid)["versions"]
        assert reader.version(pid, newer["version"])["status"] == "preparing"
        reader.finish(newer)


@pytest.mark.parametrize("operation", ["prune", "activate"])
@pytest.mark.parametrize("slow_path", ["media", "state"])
def test_slow_retired_version_cleanup_releases_outer_metadata_locks(
    source, monkeypatch, operation, slow_path
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    store, output, _, body = source
    first = publish_retention_version(source, "cleanup-first")
    publish_retention_version(source, "cleanup-second")
    third = store.prepare("owner", Path("."), output, "p", {**body, "request_id": "cleanup-third"})
    store.finish(third)
    pid = first["public_id"]
    store.retention_limit = 1
    target = (store.media_directory(pid, first["version"]).parent if slow_path == "media"
              else store.directory(pid) / first["version"])
    entered, resume = Event(), Event()
    original_remove = store._remove_tree

    def slow_remove(path):
        if path == target:
            entered.set()
            assert resume.wait(10)
        return original_remove(path)

    def execute():
        if operation == "prune":
            return store.prune_drafts(pid)
        return store.activate(pid, "owner", third["version"], True)

    monkeypatch.setattr(store, "_remove_tree", slow_remove)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(execute)
        try:
            assert entered.wait(5)
            reader = PublicationStore(store.root, output_dir=output)
            with reader.locked():
                work = reader.owned(pid, "owner")
                assert first["version"] not in work["versions"]
                assert first["version"] in work["pending_cleanup"]
                assert reader.version(pid, work["active_version"])["status"] == "ready"
            assert not future.done()
            # Both mutations must survive cleanup's final work.json update.
            active = work["active_version"]
            reader.activate(pid, "owner", active, False)
            newer = reader.prepare("owner", Path("."), output, "p", {**body, "request_id": "during-retired-cleanup"})
        finally:
            resume.set()
            future.result(timeout=10)
    work = store.read(pid)
    assert work["active_version"] == active
    assert work["listed"] is False
    assert newer["version"] in work["versions"]
    assert first["version"] not in work["pending_cleanup"]
    assert not target.exists()
    assert store.media_directory(pid, active).exists()
    reader.finish(newer)


def test_retired_cleanup_defers_when_explicit_caller_holds_metadata_lock(source, monkeypatch):
    store = source[0]
    first = publish_retention_version(source, "outer-first")
    publish_retention_version(source, "outer-second")
    pid = first["public_id"]
    store.retention_limit = 1
    before = store.read(pid)
    with monkeypatch.context() as patch:
        def unexpected_remove(path):
            pytest.fail("cleanup must defer while a caller holds the metadata lock")
        patch.setattr(store, "_remove_tree", unexpected_remove)
        with store.locked():
            store.prune_drafts(pid)
            assert store.read(pid) == before
    store.prune_drafts(pid)
    assert first["version"] not in store.read(pid)["versions"]
    assert not store.media_directory(pid, first["version"]).exists()


def test_pruning_abandoned_job_does_not_clean_media_under_metadata_lock(source, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from novelvideo.interactive_story import preparation_lease

    store, output, _, body = source
    pending = store.prepare("owner", Path("."), output, "p", body)
    pid, vid = pending["public_id"], pending["version"]
    directory = store.directory(pid) / vid
    media = store.media_directory(pid, vid)
    media.mkdir(parents=True)
    (media / "partial.mp4").write_bytes(b"partial")
    preparation_lease.release(directory)
    entered, resume = Event(), Event()
    original_remove = store._remove_tree

    def slow_remove(path):
        if path == media.parent:
            entered.set()
            assert resume.wait(10)
        return original_remove(path)

    monkeypatch.setattr(store, "_remove_tree", slow_remove)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(store.prune_drafts, pid)
        try:
            assert entered.wait(5)
            reader = PublicationStore(store.root, output_dir=output)
            with reader.locked():
                assert reader.owned(pid, "owner")["public_id"] == pid
                assert reader.version(pid, vid)["error"] == "publication_interrupted"
            assert not future.done()
        finally:
            resume.set()
            future.result(timeout=10)
    release = store.version(pid, vid)
    assert release["status"] == "failed"
    assert not release.get("media_cleanup_pending")
    assert not media.exists()
    assert not (directory / "job.json").exists()


def test_previously_edited_version_keeps_video_and_cover_assets_after_editor_withdrawal(source):
    store, _, prepared, release = ready(source)
    pid, vid = prepared["public_id"], prepared["version"]
    store.activate(pid, "owner", vid, True)
    cover = "legacy-edited-cover.png"
    media = store.media_directory(pid, vid)
    (media / cover).write_bytes(b"cover")
    with store.locked():
        work = store.read(pid)
        work["publication_details"][vid].update({
            "title": "Previously edited title",
            "cover": f"/api/v1/public-stories/{pid}/versions/{vid}/media/{cover}",
            "assets": {cover: cover},
        })
        store.write(store.directory(pid) / "work.json", work)
    public = store.public(pid)
    assert public["title"] == "Previously edited title"
    assert public["assets"] == {**release["assets"], cover: cover}
    assert all((media / asset).exists() for asset in public["assets"].values())


@pytest.mark.parametrize("removal_fails", [False, True])
def test_publication_http_response_precedes_slow_background_cleanup(
    publication_api, monkeypatch, removal_fails
):
    import asyncio
    from threading import Event
    from novelvideo.interactive_story.publication_storage import project_store

    api = publication_api
    auth = api.headers(["projects:read", "projects:lifecycle"])
    releases = []
    for i in range(3):
        response = api.client.post(
            api.path + "/prepare", headers=auth,
            json={**api.body, "request_id": f"background-{i}"},
        )
        assert response.status_code == 200, response.text
        release = response.json()["data"]
        releases.append(release)
        if i < 2:
            response = api.client.post(
                f"{api.path}/{release['public_id']}/activate", headers=auth,
                json={"version": release["version"], "listed": True},
            )
            assert response.status_code == 200, response.text
    monkeypatch.setenv("ST_PUBLICATION_RETENTION_LIMIT", "1")
    store = project_store("p", api.state, api.output)
    pid = releases[0]["public_id"]
    target = store.media_directory(pid, releases[0]["version"]).parent
    entered, resume = Event(), Event()
    original_remove = PublicationStore._remove_tree

    def slow_remove(path):
        if path == target:
            entered.set()
            assert resume.wait(10)
            if removal_fails:
                raise OSError("temporary media deletion failure")
        original_remove(path)

    monkeypatch.setattr(PublicationStore, "_remove_tree", staticmethod(slow_remove))
    path = f"{api.path}/{pid}/activate"
    payload = json.dumps({"version": releases[2]["version"], "listed": True}).encode()

    async def request():
        # TestClient/ASGITransport wait for background tasks as well as the
        # response. Observe actual ASGI response messages to model the browser.
        sent = asyncio.Event()
        messages = []
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": path,
            "raw_path": path.encode(), "query_string": b"", "root_path": "",
            "server": ("testserver", 80), "client": ("127.0.0.1", 1234),
            "headers": [(b"content-type", b"application/json"),
                        (b"authorization", auth["Authorization"].encode())],
        }

        async def receive():
            return {"type": "http.request", "body": payload, "more_body": False}

        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                sent.set()

        task = asyncio.create_task(api.client.app(scope, receive, send))
        try:
            await asyncio.wait_for(sent.wait(), timeout=2)
            assert await asyncio.to_thread(entered.wait, 2)
            assert not task.done(), "cleanup must still be paused after the response"
            assert next(m for m in messages if m["type"] == "http.response.start")["status"] == 200
            result = json.loads(b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body"))
            assert result["ok"] is True
            expected = releases[2]["version"]
            assert result["data"]["active_version"] == expected
            assert any(v["version"] == releases[2]["version"] and v["published"] for v in result["data"]["versions"])
            # The response's successful mutation is durable before deletion ends.
            assert store.read(pid)["active_version"] == expected
        finally:
            resume.set()
            await asyncio.wait_for(task, timeout=10)

    asyncio.run(request())
    if removal_fails:
        assert releases[0]["version"] in store.read(pid)["pending_cleanup"]
        assert target.exists()
        monkeypatch.setattr(PublicationStore, "_remove_tree", staticmethod(original_remove))
        restarted = project_store("p", api.state, api.output)
        restarted.prune_drafts(pid)
    assert not target.exists()
    assert store.read(pid)["pending_cleanup"] == []


def test_delayed_background_cleanup_cannot_touch_rebuilt_project(source, monkeypatch):
    import asyncio
    import shutil
    from types import SimpleNamespace
    from novelvideo.interactive_story.publication_storage import (
        project_store, detach_project_publications,
    )

    legacy, output, _, body = source
    monkeypatch.setenv("ST_PUBLICATION_DIR", str(legacy.root))
    state = output.parent / "state"
    state.mkdir()
    store = project_store("p", state, output)
    pending = store.prepare("owner", state, output, "p", body)
    store.finish(pending)
    pid = pending["public_id"]
    store.activate(pid, "owner", pending["version"], True, cleanup=False)
    orphan = "a" * 32
    with store.locked():
        work = store.read(pid)
        work["pending_cleanup"] = [orphan]
        store.write(store.directory(pid) / "work.json", work)
        media = store.media_directory(pid, orphan)
        media.mkdir(parents=True)
        (media / "keep.mp4").write_bytes(b"new project's media")
    record = SimpleNamespace(id="p", state_dir=str(state), output_dir=str(output))

    def detach(_record):
        for root in (state, output):
            root.rename(root.with_name(root.name + "-removed"))
        return []

    asyncio.run(detach_project_publications(record, detach, lambda _: None, validate=lambda _: None))
    for root in (state, output):
        shutil.copytree(root.with_name(root.name + "-removed"), root)
    before = {str(p): p.read_bytes() for root in (state, output) for p in root.rglob("*") if p.is_file()}
    store._prune_best_effort(pid)
    after = {str(p): p.read_bytes() for root in (state, output) for p in root.rglob("*") if p.is_file()}
    assert after == before


def test_background_cleanup_retries_after_another_story_copy(source, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from novelvideo.interactive_story import publication

    store, output, _, body = source
    first = publish_retention_version(source, "b1")
    second = publish_retention_version(source, "b2")
    pid = first["public_id"]
    story_a = store.prepare("another-story", Path("."), output, "p", {**body, "request_id": "a1"})
    assert story_a["public_id"] != pid
    store.retention_limit = 1
    copying, resume, retrying = Event(), Event(), Event()
    original_copy = publication.copy_project_file
    original_sleep = publication.time.sleep

    def slow_copy(*args, **kwargs):
        copying.set()
        assert resume.wait(10)
        return original_copy(*args, **kwargs)

    def observe_retry(seconds):
        retrying.set()
        original_sleep(seconds)

    monkeypatch.setattr(publication, "copy_project_file", slow_copy)
    monkeypatch.setattr(publication.time, "sleep", observe_retry)
    with ThreadPoolExecutor(max_workers=3) as pool:
        copy_task = pool.submit(store.finish, story_a)
        cleanup_task = None
        try:
            assert copying.wait(2)
            cleanup_task = pool.submit(store._prune_best_effort, pid, wait=True)
            assert retrying.wait(2)
            assert not cleanup_task.done()
            # Metadata queries remain available while cleanup waits for media.
            def query():
                with store.locked():
                    return store.read(pid)
            assert len(pool.submit(query).result(timeout=1)["published_versions"]) == 2
        finally:
            resume.set()
        copy_task.result(timeout=5)
        assert cleanup_task is not None
        cleanup_task.result(timeout=5)
    assert store.read(pid)["published_versions"] == [second["version"]]
    assert not store.media_directory(pid, first["version"]).exists()


def test_cleanup_retry_revalidates_rebuilt_project(source, monkeypatch):
    import shutil
    from contextlib import contextmanager
    from novelvideo.interactive_story import publication

    store, output, _, _ = source
    first = publish_retention_version(source, "retry-old")
    publish_retention_version(source, "retry-new")
    store.retention_limit = 1
    original_lock = store.media_locked
    attempts = 0
    before = {}

    @contextmanager
    def busy_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise PublicationError("publication_busy", 503)
        with original_lock(*args, **kwargs):
            yield

    def rebuild_during_wait(_seconds):
        original = output.with_name("removed-output")
        output.rename(original)
        shutil.copytree(original, output)
        before.update({str(p): p.read_bytes() for p in output.rglob("*") if p.is_file()})

    monkeypatch.setattr(store, "media_locked", busy_once)
    monkeypatch.setattr(publication.time, "sleep", rebuild_during_wait)
    with pytest.raises(PublicationError) as caught:
        store.prune_drafts(first["public_id"], wait=True)
    assert caught.value.code == "unavailable"
    assert attempts == 2
    assert before == {str(p): p.read_bytes() for p in output.rglob("*") if p.is_file()}


@pytest.mark.parametrize("query", ["version", "presentation"])
def test_interrupted_draft_query_defers_slow_cleanup(source, monkeypatch, query):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from novelvideo.api.routes.story_publications import presentation
    from novelvideo.interactive_story import preparation_lease
    from novelvideo.interactive_story.publication_storage import cleanup_publication

    store, output, _, body = source
    pending = store.prepare("owner", Path("."), output, "p", body)
    pid, vid = pending["public_id"], pending["version"]
    directory = store.directory(pid) / vid
    media = store.media_directory(pid, vid)
    media.mkdir(parents=True)
    (media / "partial.mp4").write_bytes(b"partial")
    preparation_lease.release(directory)
    entered, resume = Event(), Event()
    remove = store._remove_tree

    def slow_remove(path):
        entered.set()
        assert resume.wait(10)
        remove(path)

    monkeypatch.setattr(store, "_remove_tree", slow_remove)
    with ThreadPoolExecutor(max_workers=2) as pool:
        operation = (lambda: store.version(pid, vid)) if query == "version" else (lambda: presentation(store, store.read(pid)))
        try:
            result = pool.submit(operation).result(timeout=2)
            assert not entered.is_set()
            assert store.cleanup_requested
            release = result if query == "version" else result["versions"][0]
            assert release["error"] == "publication_interrupted"
            cleanup = pool.submit(asyncio.run, cleanup_publication(store, pid))
            assert entered.wait(2)
            reader = PublicationStore(store.root, output_dir=output)
            with reader.locked():
                assert reader.version(pid, vid)["status"] == "failed"
            assert not cleanup.done()
        finally:
            resume.set()
        cleanup.result(timeout=5)
    assert not media.exists()
    assert not store.version(pid, vid).get("media_cleanup_pending")


def test_async_cleanup_waiters_leave_shared_thread_pool_available(source, monkeypatch):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    import anyio
    from starlette.background import BackgroundTask
    from novelvideo.interactive_story.publication_storage import cleanup_publication

    store, _, _, _ = source
    first = publish_retention_version(source, "pool-one")
    second = publish_retention_version(source, "pool-two")
    store.retention_limit = 1
    entered, resume = Event(), Event()

    def other_story_copy():
        with store.media_locked():
            entered.set()
            assert resume.wait(15)

    async def check():
        limiter = anyio.to_thread.current_default_thread_limiter()
        # More waiting cleanups than the actual default pool capacity.
        count = limiter.total_tokens + 1
        attempts = 0
        attempted = asyncio.Event()
        loop = asyncio.get_running_loop()
        original = store.prune_once

        def record_attempt(pid):
            def record():
                nonlocal attempts
                attempts += 1
                if attempts >= count:
                    attempted.set()
            loop.call_soon_threadsafe(record)
            return original(pid)

        monkeypatch.setattr(store, "prune_once", record_attempt)
        tasks = [asyncio.create_task(BackgroundTask(cleanup_publication, store, first["public_id"])()) for _ in range(count)]
        try:
            await asyncio.wait_for(attempted.wait(), 3)
            assert all(not task.done() for task in tasks)
            assert await asyncio.wait_for(anyio.to_thread.run_sync(lambda: "file response"), 1) == "file response"
        finally:
            resume.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 10)

    with ThreadPoolExecutor(max_workers=1) as pool:
        copying = pool.submit(other_story_copy)
        assert entered.wait(2)
        try:
            asyncio.run(check())
        finally:
            resume.set()
        copying.result(timeout=2)
    assert store.read(first["public_id"])["published_versions"] == [second["version"]]


@pytest.mark.parametrize("endpoint", ["list", "version"])
def test_interrupted_query_schedules_background_cleanup(publication_api, monkeypatch, endpoint):
    import asyncio
    from unittest.mock import AsyncMock
    from novelvideo.api.routes import story_publications as routes
    from novelvideo.interactive_story import preparation_lease
    from novelvideo.interactive_story.publication_storage import project_store

    api = publication_api
    monkeypatch.setattr(PublicationStore, "finish", lambda *_, **__: None)
    response = api.client.post(api.path + "/prepare", json=api.body)
    assert response.status_code == 200
    pending = response.json()["data"]
    store = project_store("p", api.state, api.output)
    pid, vid = pending["public_id"], pending["version"]
    preparation_lease.release(store.directory(pid) / vid)
    cleanup = AsyncMock()
    monkeypatch.setattr(routes, "cleanup_publication", cleanup)
    path = api.path if endpoint == "list" else f"{api.path}/{pid}/versions/{vid}"
    response = api.client.get(path)
    assert response.status_code == 200
    data = response.json()["data"]
    release = data["versions"][0] if endpoint == "list" else data
    assert release["error"] == "publication_interrupted"
    cleanup.assert_awaited_once()
    assert cleanup.call_args.args[1] == pid
    # Execute the scheduled operation to verify the durable marker clears.
    from novelvideo.interactive_story.publication_storage import cleanup_publication
    asyncio.run(cleanup_publication(store, pid))
    assert not store.version(pid, vid).get("media_cleanup_pending")


def test_slow_copy_and_queued_preparations_do_not_block_other_requests(source, monkeypatch):
    import asyncio
    from threading import Event
    import anyio
    import httpx
    from starlette.applications import Starlette
    from starlette.background import BackgroundTask
    from starlette.responses import FileResponse, JSONResponse
    from starlette.routing import Route
    from novelvideo.interactive_story.publication_storage import finish_publication

    store, output, _, body = source
    copying, resume = Event(), Event()
    completed = []
    original_copy = store._finish
    original_finish = store.finish

    def slow_copy(prepared):
        if not copying.is_set():
            copying.set()
            assert resume.wait(20)
        original_copy(prepared)

    def record_finish(prepared, **kwargs):
        original_finish(prepared, **kwargs)
        completed.append(prepared["version"])

    monkeypatch.setattr(store, "_finish", slow_copy)
    monkeypatch.setattr(store, "finish", record_finish)

    async def check():
        default_limiter = anyio.to_thread.current_default_thread_limiter()
        jobs = [store.prepare("owner", Path("."), output, "p", {
            **body, "request_id": f"isolated-copy-{i}",
        }) for i in range(default_limiter.total_tokens + 1)]
        pid = jobs[0]["public_id"]

        def author_query(_request):
            with store.locked():
                statuses = [store.version(pid, job["version"])["status"] for job in jobs]
            return JSONResponse(statuses)

        app = Starlette(routes=[
            Route("/query", author_query),
            Route("/media", lambda _: FileResponse(output / "clip.mp4")),
        ])
        tasks = [asyncio.create_task(BackgroundTask(finish_publication, store, job)()) for job in jobs]
        try:
            async with asyncio.timeout(3):
                while not copying.is_set():
                    await asyncio.sleep(.01)
            # A bounded number of copy workers run; the rest await admission.
            from novelvideo.interactive_story.publication_storage import _media_limiter_var
            limiter = _media_limiter_var.get()
            async with asyncio.timeout(3):
                while limiter.statistics().tasks_waiting < len(jobs) - limiter.total_tokens:
                    await asyncio.sleep(.01)
            assert default_limiter.borrowed_tokens == 0
            assert all(not task.done() for task in tasks)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                query, media = await asyncio.wait_for(
                    asyncio.gather(client.get("/query"), client.get("/media")), timeout=2,
                )
            assert query.status_code == 200
            assert query.json() == ["preparing"] * len(jobs)
            assert media.status_code == 200
            assert media.content == b"original media"
            assert not resume.is_set()
        finally:
            resume.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 20)
        assert set(completed) == {job["version"] for job in jobs}
        assert store.version(pid, jobs[-1]["version"])["status"] == "ready"

    asyncio.run(check())


def test_prepare_route_uses_isolated_copy_worker(publication_api, monkeypatch):
    from unittest.mock import AsyncMock
    from novelvideo.api.routes import story_publications as routes

    worker = AsyncMock(wraps=routes.finish_publication)
    monkeypatch.setattr(routes, "finish_publication", worker)
    api = publication_api
    response = api.client.post(api.path + "/prepare", json=api.body)
    assert response.status_code == 200
    worker.assert_awaited_once()
    prepared = response.json()["data"]
    response = api.client.get(f"{api.path}/{prepared['public_id']}/versions/{prepared['version']}")
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "ready"


def test_queued_copy_keeps_ownership_until_completion_after_cancellation(source, monkeypatch):
    import asyncio
    from threading import Event
    from novelvideo.interactive_story.publication_storage import finish_publication, _media_limiter_var

    store, output, _, body = source
    resume = Event()
    original = store.finish

    def paused_finish(prepared, **kwargs):
        assert resume.wait(15)
        original(prepared, **kwargs)

    monkeypatch.setattr(store, "finish", paused_finish)

    async def check():
        jobs = [store.prepare("owner", Path("."), output, "p", {
            **body, "request_id": f"cancel-queue-{i}",
        }) for i in range(5)]
        running = [asyncio.create_task(finish_publication(store, job)) for job in jobs[:4]]
        queued = None
        try:
            async with asyncio.timeout(3):
                while _media_limiter_var.get(None) is None or _media_limiter_var.get().borrowed_tokens < 4:
                    await asyncio.sleep(.01)
            queued = asyncio.create_task(finish_publication(store, jobs[-1]))
            async with asyncio.timeout(3):
                while _media_limiter_var.get().statistics().tasks_waiting != 1:
                    await asyncio.sleep(.01)
            queued.cancel()
            await asyncio.sleep(.05)
            assert not queued.done()
            assert store.version(jobs[-1]["public_id"], jobs[-1]["version"])["status"] == "preparing"
        finally:
            resume.set()
            await asyncio.wait_for(asyncio.gather(*running), 10)
            if queued is not None:
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(queued, 10)
        assert store.version(jobs[-1]["public_id"], jobs[-1]["version"])["status"] == "ready"
        assert store.read(jobs[-1]["public_id"])["versions"] == [jobs[-1]["version"]]

    asyncio.run(check())


@pytest.mark.parametrize("background", [False, True])
def test_finished_draft_cleanup_survives_another_story_copy(source, monkeypatch, background):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from novelvideo.interactive_story.publication_storage import finish_publication

    store, output, _, body = source
    first = store.prepare("owner", Path("."), output, "p", body)
    store.finish(first)
    latest = store.prepare("owner", Path("."), output, "p", {**body, "request_id": "latest"})
    other = store.prepare("other-story", Path("."), output, "p", {**body, "request_id": "other"})
    copied, start_cleanup, copying, resume, retried = (Event() for _ in range(5))
    original_finish = store._finish_owned
    original_copy = store._finish
    original_prune = store.prune_once

    def pause_before_cleanup(prepared):
        original_finish(prepared)
        if prepared["version"] == latest["version"]:
            copied.set()
            assert start_cleanup.wait(10)

    def slow_other(prepared):
        if prepared["version"] == other["version"]:
            copying.set()
            assert resume.wait(10)
        original_copy(prepared)

    def observe_retry(public_id):
        try:
            return original_prune(public_id)
        except PublicationError as exc:
            if public_id == first["public_id"] and exc.code == "publication_busy":
                retried.set()
            raise

    monkeypatch.setattr(store, "_finish_owned", pause_before_cleanup)
    monkeypatch.setattr(store, "_finish", slow_other)
    monkeypatch.setattr(store, "prune_once", observe_retry)
    with ThreadPoolExecutor(max_workers=2) as pool:
        task = pool.submit(asyncio.run, finish_publication(store, latest)) if background else pool.submit(store.finish, latest)
        competitor = None
        try:
            assert copied.wait(5)
            competitor = pool.submit(store.finish, other)
            assert copying.wait(5)
            start_cleanup.set()
            assert retried.wait(5)
            assert not task.done()
        finally:
            start_cleanup.set()
            resume.set()
        task.result(timeout=10)
        if competitor is not None:
            competitor.result(timeout=10)
    assert store.read(first["public_id"])["versions"] == [latest["version"]]
    assert not store.media_directory(first["public_id"], first["version"]).parent.exists()


def test_slow_media_deletion_does_not_exhaust_request_threads(source, monkeypatch):
    import asyncio
    from threading import Event
    import anyio
    from novelvideo.interactive_story.publication_storage import cleanup_publication

    store, output, _, body = source
    stores = [store, PublicationStore(store.root.with_name("other-project"), output_dir=output)]
    public_ids = []
    for current in stores:
        current.retention_limit = 1
        for i in range(2):
            job = current.prepare("owner", Path("."), output, "p", {**body, "request_id": str(i)})
            current.finish(job)
            current.activate(job["public_id"], "owner", job["version"], True, cleanup=False)
        public_ids.append(job["public_id"])
    resume = Event()
    entered = [Event() for _ in stores]
    for i, current in enumerate(stores):
        remove = current._remove_tree

        def slow_remove(path, i=i, remove=remove):
            entered[i].set()
            assert resume.wait(10)
            remove(path)

        monkeypatch.setattr(current, "_remove_tree", slow_remove)

    async def check():
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous = limiter.total_tokens
        limiter.total_tokens = len(stores)
        tasks = [asyncio.create_task(cleanup_publication(current, pid)) for current, pid in zip(stores, public_ids)]
        try:
            async with asyncio.timeout(5):
                while not all(event.is_set() for event in entered):
                    await asyncio.sleep(.01)
            assert limiter.borrowed_tokens == 0
            assert await asyncio.wait_for(anyio.to_thread.run_sync(lambda: "file response"), 1) == "file response"
        finally:
            resume.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 10)
            limiter.total_tokens = previous
    asyncio.run(check())
    for current, pid in zip(stores, public_ids):
        assert len(current.read(pid)["published_versions"]) == 1
        assert current.read(pid)["pending_cleanup"] == []
