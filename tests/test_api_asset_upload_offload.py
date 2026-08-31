from __future__ import annotations

import asyncio
import gc
import io
import os
import stat
import threading
import weakref
from pathlib import Path
from types import SimpleNamespace

import pytest
import anyio
from fastapi import UploadFile

from novelvideo.models import CharacterIdentity, NovelCharacter, NovelScene


def _png_upload(size: tuple[int, int] = (4, 4)) -> UploadFile:
    from PIL import Image

    payload = io.BytesIO()
    Image.new("RGB", size, color=(120, 80, 40)).save(payload, format="PNG")
    payload.seek(0)
    return UploadFile(filename="upload.png", file=payload)


@pytest.mark.parametrize("publisher", ["character", "scene"])
def test_published_images_respect_umask_for_new_targets(tmp_path, publisher):
    from PIL import Image

    from novelvideo.api.routes import characters, scenes

    target = tmp_path / "portrait.png"
    previous_umask = os.umask(0o022)
    try:
        if publisher == "character":
            characters._persist_uploaded_character_image(_png_upload(), target)
        else:
            scenes._publish_scene_image(
                Image.new("RGB", (4, 4), color="red"), target, "master"
            )
    finally:
        os.umask(previous_umask)

    assert stat.S_IMODE(target.stat().st_mode) == 0o644


@pytest.mark.parametrize("publisher", ["character", "scene"])
def test_published_images_preserve_existing_target_mode(tmp_path, publisher):
    from PIL import Image

    from novelvideo.api.routes import characters, scenes

    target = tmp_path / "portrait.png"
    Image.new("RGB", (2, 2), color="blue").save(target)
    target.chmod(0o640)

    if publisher == "character":
        characters._persist_uploaded_character_image(_png_upload(), target)
    else:
        scenes._publish_scene_image(
            Image.new("RGB", (4, 4), color="red"), target, "master"
        )

    assert stat.S_IMODE(target.stat().st_mode) == 0o640


def test_scene_image_archives_do_not_collide_within_one_second(tmp_path, monkeypatch):
    from PIL import Image

    from novelvideo.api.routes import scenes

    target = tmp_path / "master.png"
    monkeypatch.setattr(scenes.time, "time", lambda: 1_700_000_000.0)
    stamps = iter((1_700_000_000_000_000_001, 1_700_000_000_000_000_002))
    monkeypatch.setattr(scenes.time, "time_ns", lambda: next(stamps))

    for color in ("red", "green", "blue"):
        scenes._publish_scene_image(
            Image.new("RGB", (4, 4), color=color), target, "master"
        )

    assert len(list(tmp_path.glob("master_*.png"))) == 2


class _CharacterStore:
    def __init__(self) -> None:
        self.character = NovelCharacter(name="秦")
        self.character.identities = [
            CharacterIdentity(
                identity_id="秦_少年",
                character_name="秦",
                identity_name="少年",
            )
        ]
        self.touched: list[str] = []
        self.identity_updates: list[tuple[str, str, dict]] = []

    def get_character(self, name: str):
        return self.character if name == self.character.name else None

    async def touch_character_asset(self, _name: str) -> bool:
        self.touched.append(_name)
        return True

    async def update_character_identity(self, name: str, identity_id: str, **updates):
        self.identity_updates.append((name, identity_id, updates))
        return True


class _SceneStore:
    def __init__(self, names: tuple[str, ...] = ("Hall",)) -> None:
        self.scenes = {name: NovelScene(name=name) for name in names}
        self.touched: list[str] = []

    async def get_scene(self, name: str):
        return self.scenes.get(name)

    async def touch_scene_asset(self, _name: str) -> bool:
        self.touched.append(_name)
        return True


@pytest.mark.asyncio
async def test_identity_attempts_ignore_hidden_staging_files(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    store = _CharacterStore()

    async def resolve_project(*_args, **_kwargs):
        return (
            SimpleNamespace(project_id="proj_demo"),
            "admin",
            "demo",
            tmp_path,
            str(tmp_path),
            store,
        )

    monkeypatch.setattr(characters, "_resolve_character_project", resolve_project)
    identities_dir = tmp_path / "assets" / "characters" / "秦" / "identities"
    identities_dir.mkdir(parents=True)
    for filename in (
        "秦_少年_portrait.png",
        "秦_少年_portrait_20260831.png",
        ".秦_少年_portrait_deadbeef.png",
    ):
        (identities_dir / filename).write_bytes(b"png")

    response = await characters.get_identity_attempts(
        project="demo",
        name="秦",
        identity_id="秦_少年",
        user={"username": "admin"},
    )

    assert response["data"]["portrait_attempts"] == 2


@pytest.mark.asyncio
async def test_character_image_upload_encodes_off_event_loop(tmp_path, monkeypatch):
    from PIL import Image

    from novelvideo.api.routes import characters

    store = _CharacterStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(characters, "_resolve_character_project", resolve_project)
    monkeypatch.setattr(
        characters,
        "make_static_url_for_context",
        lambda _ctx, rel, local_path=None: f"/static/{rel}",
    )
    upload = _png_upload()
    event_loop_thread = threading.get_ident()
    encoder_threads: list[int] = []
    original_save = Image.Image.save

    def recording_save(self, fp, format=None, **params):
        encoder_threads.append(threading.get_ident())
        return original_save(self, fp, format=format, **params)

    monkeypatch.setattr(Image.Image, "save", recording_save)

    response = await characters.upload_portrait(
        project="demo",
        name="秦",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert encoder_threads
    assert all(thread_id != event_loop_thread for thread_id in encoder_threads)
    assert (tmp_path / "assets" / "characters" / "秦" / "portrait.png").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("route_name", "route_kwargs", "expected_metadata"),
    [
        ("upload_portrait", {}, ("touch", "秦")),
        ("upload_identity_image", {"identity_name": "少年"}, None),
        (
            "upload_identity_costume",
            {"identity_id": "秦_少年"},
            ("identity", "costume_image"),
        ),
        (
            "upload_identity_portrait",
            {"identity_id": "秦_少年"},
            ("identity", "portrait_image"),
        ),
    ],
)
async def test_cancelled_character_image_upload_finishes_required_metadata(
    tmp_path, monkeypatch, route_name, route_kwargs, expected_metadata
):
    from novelvideo.api.routes import characters

    store = _CharacterStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(characters, "_resolve_character_project", resolve_project)
    monkeypatch.setattr(
        characters,
        "make_static_url_for_context",
        lambda _ctx, rel, local_path=None: f"/static/{rel}",
    )
    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release = threading.Event()
    worker_threads: list[int] = []
    published_paths: list[Path] = []

    def publish(_file: UploadFile, target: Path) -> None:
        worker_threads.append(threading.get_ident())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"image")
        published_paths.append(target)
        loop.call_soon_threadsafe(published.set)
        assert release.wait(timeout=5)

    monkeypatch.setattr(characters, "_persist_uploaded_character_image", publish)
    route = getattr(characters, route_name)
    task = asyncio.create_task(
        route(
            project="demo",
            name="秦",
            file=_png_upload(),
            user={"username": "admin"},
            **route_kwargs,
        )
    )
    try:
        await asyncio.wait_for(published.wait(), timeout=1)
        task.cancel(f"cancel-{route_name}")
        await asyncio.sleep(0)
    finally:
        release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == (f"cancel-{route_name}",)
    assert worker_threads[0] != threading.get_ident()
    assert published_paths[0].exists()
    if expected_metadata is None:
        assert store.touched == []
        assert store.identity_updates == []
    elif expected_metadata[0] == "touch":
        assert store.touched == [expected_metadata[1]]
    else:
        assert len(store.identity_updates) == 1
        assert expected_metadata[1] in store.identity_updates[0][2]


@pytest.mark.asyncio
async def test_scene_image_upload_encodes_off_event_loop(tmp_path, monkeypatch):
    from PIL import Image

    from novelvideo.api.routes import scenes

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    monkeypatch.setattr(
        scenes,
        "make_static_url_for_context",
        lambda _ctx, rel, local_path=None: f"/static/{rel}",
    )
    upload = _png_upload()
    event_loop_thread = threading.get_ident()
    encoder_threads: list[int] = []
    original_save = Image.Image.save

    def recording_save(self, fp, format=None, **params):
        encoder_threads.append(threading.get_ident())
        return original_save(self, fp, format=format, **params)

    monkeypatch.setattr(Image.Image, "save", recording_save)

    response = await scenes.upload_scene_master(
        project="demo",
        name="Hall",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert encoder_threads
    assert all(thread_id != event_loop_thread for thread_id in encoder_threads)


@pytest.mark.asyncio
async def test_cancelled_scene_master_finishes_asset_version_metadata(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release = threading.Event()

    def publish(_file: UploadFile, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"image")
        loop.call_soon_threadsafe(published.set)
        assert release.wait(timeout=5)

    monkeypatch.setattr(scenes, "_persist_scene_master_upload", publish)
    task = asyncio.create_task(
        scenes.upload_scene_master(
            project="demo",
            name="Hall",
            file=_png_upload(),
            user={"username": "admin"},
        )
    )
    try:
        await asyncio.wait_for(published.wait(), timeout=1)
        task.cancel("cancel-scene-master")
        await asyncio.sleep(0)
    finally:
        release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == ("cancel-scene-master",)
    assert store.touched == ["Hall"]


@pytest.mark.asyncio
async def test_cancelled_scene_pano_keeps_published_manifest(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release = threading.Event()
    worker_threads: list[int] = []
    original_update = stage_manifest.update_manifest

    def update_manifest(*args, **kwargs):
        result = original_update(*args, **kwargs)
        worker_threads.append(threading.get_ident())
        loop.call_soon_threadsafe(published.set)
        assert release.wait(timeout=5)
        return result

    monkeypatch.setattr(stage_manifest, "update_manifest", update_manifest)
    task = asyncio.create_task(
        scenes.upload_scene_pano(
            project="demo",
            name="Hall",
            file=_png_upload((4, 2)),
            user={"username": "admin"},
        )
    )
    try:
        await asyncio.wait_for(published.wait(), timeout=1)
        task.cancel("cancel-scene-pano")
        await asyncio.sleep(0)
    finally:
        release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    assert raised.value.args == ("cancel-scene-pano",)
    assert worker_threads[0] != threading.get_ident()
    assert manifest["pano_path"] == "pano_360.png"
    assert manifest["source"] == "uploaded_360"


@pytest.mark.asyncio
async def test_same_scene_pano_and_custom_uploads_serialize_manifest_transaction(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    pano_manifest_written = asyncio.Event()
    custom_entered = asyncio.Event()
    release_pano = threading.Event()
    original_update = stage_manifest.update_manifest
    original_custom = scenes._persist_custom_scene_upload

    def update_manifest(*args, **kwargs):
        result = original_update(*args, **kwargs)
        if kwargs.get("source") == "uploaded_360":
            loop.call_soon_threadsafe(pano_manifest_written.set)
            assert release_pano.wait(timeout=5)
        return result

    def custom_upload(*args, **kwargs):
        loop.call_soon_threadsafe(custom_entered.set)
        return original_custom(*args, **kwargs)

    monkeypatch.setattr(stage_manifest, "update_manifest", update_manifest)
    monkeypatch.setattr(scenes, "_persist_custom_scene_upload", custom_upload)
    stage_dir = stage_manifest.stage_dir(tmp_path, "Hall")
    stage_dir.mkdir(parents=True, exist_ok=True)
    (stage_dir / "pano_360.png").write_bytes(b"old pano")

    pano_task = asyncio.create_task(
        scenes.upload_scene_pano(
            project="demo",
            name="Hall",
            file=_png_upload((4, 2)),
            user={"username": "admin"},
        )
    )
    await asyncio.wait_for(pano_manifest_written.wait(), timeout=1)
    custom_task = asyncio.create_task(
        scenes.upload_scene_custom_package(
            project="demo",
            name="Hall",
            file=UploadFile(file=io.BytesIO(b"sog"), filename="scene.sog"),
            user={"username": "admin"},
        )
    )
    try:
        await asyncio.sleep(0)
        assert not custom_entered.is_set()
    finally:
        release_pano.set()

    pano_response, custom_response = await asyncio.gather(pano_task, custom_task)
    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    backups = list(stage_dir.glob("pano_360_*.png"))
    assert pano_response["ok"] is True
    assert custom_response["ok"] is True
    assert custom_entered.is_set()
    assert manifest["pano_path"] == "pano_360.png"
    assert manifest["custom_scene_path"] == "custom.sog"
    assert (stage_dir / "custom.sog").read_bytes() == b"sog"
    assert len(backups) == 1
    assert backups[0].read_bytes() == b"old pano"


@pytest.mark.asyncio
async def test_different_scene_upload_locks_allow_parallel_pano_work(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore(("Hall", "Yard"))
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    started: asyncio.Queue[str] = asyncio.Queue()
    release = threading.Event()

    def pano_upload(_file, *, project_dir, scene_name):
        loop.call_soon_threadsafe(started.put_nowait, scene_name)
        assert release.wait(timeout=5)

    monkeypatch.setattr(scenes, "_persist_scene_pano_upload", pano_upload)
    tasks = [
        asyncio.create_task(
            scenes.upload_scene_pano(
                project="demo",
                name=name,
                file=_png_upload((4, 2)),
                user={"username": "admin"},
            )
        )
        for name in ("Hall", "Yard")
    ]
    try:
        entered = {
            await asyncio.wait_for(started.get(), timeout=1),
            await asyncio.wait_for(started.get(), timeout=1),
        }
        assert entered == {"Hall", "Yard"}
    finally:
        release.set()

    assert all(response["ok"] for response in await asyncio.gather(*tasks))


@pytest.mark.asyncio
async def test_cancellation_while_waiting_for_scene_lock_does_not_start_upload(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    custom_started = asyncio.Event()
    release_custom = threading.Event()
    pano_calls: list[str] = []

    def custom_upload(*_args, **_kwargs):
        loop.call_soon_threadsafe(custom_started.set)
        assert release_custom.wait(timeout=5)

    def pano_upload(_file, *, project_dir, scene_name):
        pano_calls.append(scene_name)

    monkeypatch.setattr(scenes, "_persist_custom_scene_upload", custom_upload)
    monkeypatch.setattr(scenes, "_persist_scene_pano_upload", pano_upload)
    custom_task = asyncio.create_task(
        scenes.upload_scene_custom_package(
            project="demo",
            name="Hall",
            file=UploadFile(file=io.BytesIO(b"sog"), filename="scene.sog"),
            user={"username": "admin"},
        )
    )
    await asyncio.wait_for(custom_started.wait(), timeout=1)
    pano_task = asyncio.create_task(
        scenes.upload_scene_pano(
            project="demo",
            name="Hall",
            file=_png_upload((4, 2)),
            user={"username": "admin"},
        )
    )
    try:
        await asyncio.sleep(0)
        pano_task.cancel("waiting-lock-cancel")
        with pytest.raises(asyncio.CancelledError) as raised:
            await pano_task
        assert raised.value.args == ("waiting-lock-cancel",)
        assert pano_calls == []
    finally:
        release_custom.set()

    assert (await custom_task)["ok"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["pano", "custom"])
async def test_scene_delete_waits_for_matching_upload_transaction(
    tmp_path, monkeypatch, kind
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release_upload = threading.Event()
    event_loop_thread = threading.get_ident()
    delete_threads: list[int] = []

    if kind == "pano":
        original_upload = scenes._persist_scene_pano_upload

        def held_upload(*args, **kwargs):
            original_upload(*args, **kwargs)
            loop.call_soon_threadsafe(published.set)
            assert release_upload.wait(timeout=5)

        monkeypatch.setattr(scenes, "_persist_scene_pano_upload", held_upload)
        upload_call = scenes.upload_scene_pano(
            project="demo",
            name="Hall",
            file=_png_upload((4, 2)),
            user={"username": "admin"},
        )
        delete_call = scenes.delete_scene_pano(
            project="demo", name="Hall", user={"username": "admin"}
        )
    else:
        original_upload = scenes._persist_custom_scene_upload

        def held_upload(*args, **kwargs):
            original_upload(*args, **kwargs)
            loop.call_soon_threadsafe(published.set)
            assert release_upload.wait(timeout=5)

        monkeypatch.setattr(scenes, "_persist_custom_scene_upload", held_upload)
        upload_call = scenes.upload_scene_custom_package(
            project="demo",
            name="Hall",
            file=UploadFile(file=io.BytesIO(b"sog"), filename="scene.sog"),
            user={"username": "admin"},
        )
        delete_call = scenes.delete_scene_custom_package(
            project="demo", name="Hall", user={"username": "admin"}
        )

    original_update = stage_manifest.update_manifest

    def record_delete_update(*args, **kwargs):
        clear_fields = set(kwargs.get("clear_fields") or [])
        if (kind == "pano" and "pano_path" in clear_fields) or (
            kind == "custom" and "custom_scene_path" in clear_fields
        ):
            delete_threads.append(threading.get_ident())
        return original_update(*args, **kwargs)

    monkeypatch.setattr(stage_manifest, "update_manifest", record_delete_update)
    upload_task = asyncio.create_task(upload_call)
    await asyncio.wait_for(published.wait(), timeout=1)
    delete_task = asyncio.create_task(delete_call)
    try:
        await asyncio.sleep(0)
        assert not delete_task.done()
        assert delete_threads == []
    finally:
        release_upload.set()

    upload_response, delete_response = await asyncio.gather(upload_task, delete_task)
    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    assert upload_response["ok"] is True
    assert delete_response == {"ok": True, "data": {"deleted": True}}
    assert delete_threads and delete_threads[0] != event_loop_thread
    if kind == "pano":
        assert not manifest.get("pano_path")
        assert stage_manifest.resolve_pano_path(tmp_path, "Hall") is None
    else:
        assert not manifest.get("custom_scene_path")
        assert (
            stage_manifest.resolve_ply_path(tmp_path, "Hall", ply_kind="custom")
            is None
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["pano", "custom"])
async def test_scene_metadata_delete_does_not_wait_for_upload_capacity(
    tmp_path, monkeypatch, kind
):
    from novelvideo.api.routes import scenes
    from novelvideo.api.upload_workers import run_asset_upload_operation

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    upload_capacity_full = threading.Event()
    release_uploads = threading.Event()
    started_count = 0
    started_lock = threading.Lock()

    def blocking_upload() -> None:
        nonlocal started_count
        with started_lock:
            started_count += 1
            if started_count == 2:
                upload_capacity_full.set()
        assert release_uploads.wait(timeout=5)

    delete_started = threading.Event()

    def delete_files(*_args) -> bool:
        delete_started.set()
        return True

    if kind == "pano":
        monkeypatch.setattr(scenes, "_delete_scene_pano_files", delete_files)
        delete_call = scenes.delete_scene_pano(
            project="demo", name="Hall", user={"username": "admin"}
        )
    else:
        monkeypatch.setattr(scenes, "_delete_scene_custom_files", delete_files)
        delete_call = scenes.delete_scene_custom_package(
            project="demo", name="Hall", user={"username": "admin"}
        )

    blockers = [
        asyncio.create_task(run_asset_upload_operation(blocking_upload))
        for _ in range(2)
    ]
    delete_task = None
    try:
        assert await asyncio.to_thread(upload_capacity_full.wait, 1)
        delete_task = asyncio.create_task(delete_call)
        assert await asyncio.to_thread(delete_started.wait, 1)
        assert (await delete_task)["ok"] is True
    finally:
        release_uploads.set()
        await asyncio.gather(*blockers, return_exceptions=True)
        if delete_task is not None and not delete_task.done():
            await asyncio.gather(delete_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_cancelled_scene_delete_waiting_for_upload_lock_does_not_delete(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release_upload = threading.Event()
    original_upload = scenes._persist_custom_scene_upload

    def held_upload(*args, **kwargs):
        original_upload(*args, **kwargs)
        loop.call_soon_threadsafe(published.set)
        assert release_upload.wait(timeout=5)

    monkeypatch.setattr(scenes, "_persist_custom_scene_upload", held_upload)
    upload_task = asyncio.create_task(
        scenes.upload_scene_custom_package(
            project="demo",
            name="Hall",
            file=UploadFile(file=io.BytesIO(b"sog"), filename="scene.sog"),
            user={"username": "admin"},
        )
    )
    await asyncio.wait_for(published.wait(), timeout=1)
    delete_task = asyncio.create_task(
        scenes.delete_scene_custom_package(
            project="demo", name="Hall", user={"username": "admin"}
        )
    )
    try:
        await asyncio.sleep(0)
        delete_task.cancel("delete-lock-cancel")
        with pytest.raises(asyncio.CancelledError) as raised:
            await delete_task
        assert raised.value.args == ("delete-lock-cancel",)
    finally:
        release_upload.set()

    assert (await upload_task)["ok"] is True
    custom_path = stage_manifest.resolve_ply_path(
        tmp_path, "Hall", ply_kind="custom"
    )
    assert custom_path is not None and custom_path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["pano", "custom"])
async def test_scene_upload_waits_for_matching_delete_transaction(
    tmp_path, monkeypatch, kind
):
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    delete_applied = asyncio.Event()
    upload_entered = asyncio.Event()
    release_delete = threading.Event()

    if kind == "pano":
        scenes._persist_scene_pano_upload(
            _png_upload((4, 2)), project_dir=tmp_path, scene_name="Hall"
        )
        original_delete = scenes._delete_scene_pano_files
        original_upload = scenes._persist_scene_pano_upload

        def held_delete(*args, **kwargs):
            result = original_delete(*args, **kwargs)
            loop.call_soon_threadsafe(delete_applied.set)
            assert release_delete.wait(timeout=5)
            return result

        def tracked_upload(*args, **kwargs):
            loop.call_soon_threadsafe(upload_entered.set)
            return original_upload(*args, **kwargs)

        monkeypatch.setattr(scenes, "_delete_scene_pano_files", held_delete)
        monkeypatch.setattr(scenes, "_persist_scene_pano_upload", tracked_upload)
        delete_call = scenes.delete_scene_pano(
            project="demo", name="Hall", user={"username": "admin"}
        )
        upload_call = scenes.upload_scene_pano(
            project="demo",
            name="Hall",
            file=_png_upload((4, 2)),
            user={"username": "admin"},
        )
    else:
        scenes._persist_custom_scene_upload(
            UploadFile(file=io.BytesIO(b"old sog"), filename="scene.sog"),
            suffix=".sog",
            project_dir=tmp_path,
            scene_name="Hall",
        )
        original_delete = scenes._delete_scene_custom_files
        original_upload = scenes._persist_custom_scene_upload

        def held_delete(*args, **kwargs):
            result = original_delete(*args, **kwargs)
            loop.call_soon_threadsafe(delete_applied.set)
            assert release_delete.wait(timeout=5)
            return result

        def tracked_upload(*args, **kwargs):
            loop.call_soon_threadsafe(upload_entered.set)
            return original_upload(*args, **kwargs)

        monkeypatch.setattr(scenes, "_delete_scene_custom_files", held_delete)
        monkeypatch.setattr(scenes, "_persist_custom_scene_upload", tracked_upload)
        delete_call = scenes.delete_scene_custom_package(
            project="demo", name="Hall", user={"username": "admin"}
        )
        upload_call = scenes.upload_scene_custom_package(
            project="demo",
            name="Hall",
            file=UploadFile(file=io.BytesIO(b"new sog"), filename="scene.sog"),
            user={"username": "admin"},
        )

    delete_task = asyncio.create_task(delete_call)
    await asyncio.wait_for(delete_applied.wait(), timeout=1)
    upload_task = asyncio.create_task(upload_call)
    try:
        await asyncio.sleep(0)
        assert not upload_entered.is_set()
    finally:
        release_delete.set()

    delete_response, upload_response = await asyncio.gather(delete_task, upload_task)
    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    assert delete_response == {"ok": True, "data": {"deleted": True}}
    assert upload_response["ok"] is True
    assert upload_entered.is_set()
    if kind == "pano":
        pano_path = stage_manifest.resolve_pano_path(tmp_path, "Hall")
        assert pano_path is not None and pano_path.exists()
        assert manifest["pano_path"] == "pano_360.png"
    else:
        custom_path = stage_manifest.resolve_ply_path(
            tmp_path, "Hall", ply_kind="custom"
        )
        assert custom_path is not None and custom_path.read_bytes() == b"new sog"
        assert manifest["custom_scene_path"] == "custom.sog"


def test_scene_upload_lock_key_uses_canonical_stage_path(tmp_path):
    from novelvideo.api.routes import scenes

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    alias_dir = tmp_path / "project-alias"
    alias_dir.symlink_to(project_dir, target_is_directory=True)

    assert scenes._scene_upload_lock_key(
        project_dir, "Hall/Room"
    ) == scenes._scene_upload_lock_key(alias_dir, "Hall:Room")


@pytest.mark.asyncio
async def test_scene_upload_lock_is_stable_while_held_and_waited_on():
    from novelvideo.api import upload_workers

    key = ("project", "Hall")
    holder_lock = upload_workers.scene_upload_lock(key)
    waiter_ready = asyncio.Event()
    waiter_release = asyncio.Event()
    waiter_locks: list[asyncio.Lock] = []

    async def waiter() -> None:
        lock = upload_workers.scene_upload_lock(key)
        waiter_locks.append(lock)
        waiter_ready.set()
        async with lock:
            await waiter_release.wait()

    async with holder_lock:
        task = asyncio.create_task(waiter())
        await waiter_ready.wait()
        await asyncio.sleep(0)
        assert waiter_locks == [holder_lock]
        assert upload_workers.scene_upload_lock(key) is holder_lock

    await asyncio.sleep(0)
    assert not task.done()
    waiter_release.set()
    await task


@pytest.mark.asyncio
async def test_scene_upload_lock_registry_releases_unused_locks():
    from novelvideo.api import upload_workers

    key = ("gc-project", "Hall")
    lock = upload_workers.scene_upload_lock(key)
    lock_ref = weakref.ref(lock)
    registry = upload_workers._scene_upload_locks_var.get()
    assert registry[key] is lock

    del lock
    gc.collect()

    assert lock_ref() is None
    assert key not in registry


def test_scene_upload_lock_registry_is_isolated_between_async_runs():
    from novelvideo.api import upload_workers

    async def registry_identity():
        lock = upload_workers.scene_upload_lock(("loop", "isolated"))
        assert lock is upload_workers.scene_upload_lock(("loop", "isolated"))
        return upload_workers._scene_upload_locks_var.get()

    first = asyncio.run(registry_identity())
    second = asyncio.run(registry_identity())

    assert first is not second


@pytest.mark.asyncio
@pytest.mark.parametrize("suffix", [".sog", ".splat", ".ksplat"])
async def test_custom_scene_package_staging_and_publish_run_off_event_loop(
    tmp_path, monkeypatch, suffix
):
    from novelvideo import stage_asset_tasks
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    monkeypatch.setattr(
        scenes,
        "make_static_url_for_context",
        lambda _ctx, rel, local_path=None: f"/static/{rel}",
    )
    event_loop_thread = threading.get_ident()
    copy_threads: list[int] = []
    original_copy = stage_asset_tasks.shutil.copy2

    def copy_in_worker(source, target, *args, **kwargs):
        copy_threads.append(threading.get_ident())
        assert Path(source).read_bytes() == b"sog package"
        return original_copy(source, target, *args, **kwargs)

    monkeypatch.setattr(stage_asset_tasks.shutil, "copy2", copy_in_worker)

    response = await scenes.upload_scene_custom_package(
        project="demo",
        name="Hall",
        file=UploadFile(
            file=io.BytesIO(b"sog package"), filename=f"scene{suffix}"
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    custom_path = stage_manifest.stage_dir(tmp_path, "Hall") / f"custom{suffix}"
    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    assert copy_threads and copy_threads[0] != event_loop_thread
    assert custom_path.read_bytes() == b"sog package"
    assert manifest["custom_scene_path"] == f"custom{suffix}"


@pytest.mark.asyncio
async def test_custom_ply_copy_and_compression_run_in_worker(tmp_path, monkeypatch):
    from novelvideo import stage_asset_tasks
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    monkeypatch.setattr(
        scenes,
        "make_static_url_for_context",
        lambda _ctx, rel, local_path=None: f"/static/{rel}",
    )
    event_loop_thread = threading.get_ident()
    compression_threads: list[int] = []

    def compress(ply_path: Path, sog_path: Path, **_kwargs) -> Path:
        compression_threads.append(threading.get_ident())
        assert ply_path.read_bytes() == b"ply package"
        sog_path.write_bytes(b"compressed sog")
        return sog_path

    monkeypatch.setattr(stage_asset_tasks, "_compress_ply_to_sog", compress)

    response = await scenes.upload_scene_custom_package(
        project="demo",
        name="Hall",
        file=UploadFile(file=io.BytesIO(b"ply package"), filename="scene.ply"),
        user={"username": "admin"},
    )

    manifest = stage_manifest.load_manifest(tmp_path, "Hall")
    custom_path = stage_manifest.stage_dir(tmp_path, "Hall") / "custom.sog"
    assert response["ok"] is True
    assert len(compression_threads) == 1
    assert compression_threads[0] != event_loop_thread
    assert custom_path.read_bytes() == b"compressed sog"
    assert manifest["custom_scene_path"] == "custom.sog"


@pytest.mark.asyncio
async def test_concurrent_ply_uploads_use_single_conversion_slot(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes
    from novelvideo.api.upload_workers import scene_ply_upload_limiter

    store = _SceneStore(("Hall", "Yard"))
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    started: asyncio.Queue[str] = asyncio.Queue()
    releases = {name: threading.Event() for name in ("Hall", "Yard")}
    state_lock = threading.Lock()
    active = 0
    peak = 0

    def convert(_file, *, suffix, project_dir, scene_name):
        nonlocal active, peak
        assert suffix == ".ply"
        with state_lock:
            active += 1
            peak = max(peak, active)
        loop.call_soon_threadsafe(started.put_nowait, scene_name)
        try:
            assert releases[scene_name].wait(timeout=5)
        finally:
            with state_lock:
                active -= 1

    monkeypatch.setattr(scenes, "_persist_custom_scene_upload", convert)
    tasks = [
        asyncio.create_task(
            scenes.upload_scene_custom_package(
                project="demo",
                name=name,
                file=UploadFile(file=io.BytesIO(b"ply"), filename="scene.ply"),
                user={"username": "admin"},
            )
        )
        for name in ("Hall", "Yard")
    ]
    first = await asyncio.wait_for(started.get(), timeout=1)
    try:
        await asyncio.sleep(0)
        assert started.empty()
        assert scene_ply_upload_limiter().borrowed_tokens == 1
        releases[first].set()
        second = await asyncio.wait_for(started.get(), timeout=1)
        assert second != first
    finally:
        for release in releases.values():
            release.set()

    responses = await asyncio.gather(*tasks)
    assert all(response["ok"] for response in responses)
    assert peak == 1
    assert scene_ply_upload_limiter().borrowed_tokens == 0


@pytest.mark.asyncio
async def test_cancelled_ply_upload_keeps_single_slot_until_worker_finishes(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.api.upload_workers import scene_ply_upload_limiter

    store = _SceneStore(("Hall", "Yard"))
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    loop = asyncio.get_running_loop()
    started: asyncio.Queue[str] = asyncio.Queue()
    releases = {name: threading.Event() for name in ("Hall", "Yard")}

    def convert(_file, *, suffix, project_dir, scene_name):
        assert suffix == ".ply"
        loop.call_soon_threadsafe(started.put_nowait, scene_name)
        assert releases[scene_name].wait(timeout=5)

    monkeypatch.setattr(scenes, "_persist_custom_scene_upload", convert)
    first_task = asyncio.create_task(
        scenes.upload_scene_custom_package(
            project="demo",
            name="Hall",
            file=UploadFile(file=io.BytesIO(b"ply"), filename="scene.ply"),
            user={"username": "admin"},
        )
    )
    assert await asyncio.wait_for(started.get(), timeout=1) == "Hall"
    first_task.cancel("first-ply-cancel")
    await asyncio.sleep(0)
    first_task.cancel("second-ply-cancel")
    second_task = asyncio.create_task(
        scenes.upload_scene_custom_package(
            project="demo",
            name="Yard",
            file=UploadFile(file=io.BytesIO(b"ply"), filename="scene.ply"),
            user={"username": "admin"},
        )
    )
    try:
        await asyncio.sleep(0)
        assert started.empty()
        assert scene_ply_upload_limiter().borrowed_tokens == 1
        releases["Hall"].set()
        assert await asyncio.wait_for(started.get(), timeout=1) == "Yard"
    finally:
        releases["Hall"].set()
        releases["Yard"].set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await first_task
    assert raised.value.args == ("first-ply-cancel",)
    assert (await second_task)["ok"] is True
    assert scene_ply_upload_limiter().borrowed_tokens == 0


@pytest.mark.asyncio
async def test_asset_upload_workers_are_bounded_to_two():
    from novelvideo.api.upload_workers import (
        asset_upload_limiter,
        run_asset_upload_operation,
    )

    loop = asyncio.get_running_loop()
    started: asyncio.Queue[int] = asyncio.Queue()
    release = threading.Event()

    def blocking_upload(index: int) -> int:
        loop.call_soon_threadsafe(started.put_nowait, index)
        assert release.wait(timeout=5)
        return index

    tasks = [
        asyncio.create_task(run_asset_upload_operation(blocking_upload, index))
        for index in range(3)
    ]
    try:
        first_two = {await started.get(), await started.get()}

        assert len(first_two) == 2
        assert asset_upload_limiter().borrowed_tokens == 2
        assert started.empty()
    finally:
        release.set()
    assert sorted(await asyncio.gather(*tasks)) == [0, 1, 2]


@pytest.mark.asyncio
async def test_asset_upload_cancellation_waits_for_cleanup_and_preserves_error(
    tmp_path,
):
    from novelvideo.api.upload_workers import (
        asset_upload_limiter,
        run_asset_upload_operation,
    )

    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    staged_path = tmp_path / "staged-upload.sog"

    def blocking_upload() -> None:
        staged_path.write_bytes(b"staged")
        loop.call_soon_threadsafe(started.set)
        try:
            assert release.wait(timeout=5)
        finally:
            staged_path.unlink(missing_ok=True)

    task = asyncio.create_task(run_asset_upload_operation(blocking_upload))
    try:
        await started.wait()
        task.cancel("asset-upload-cancel")
        await asyncio.sleep(0)

        assert not task.done()
        assert asset_upload_limiter().borrowed_tokens == 1
        assert staged_path.exists()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == ("asset-upload-cancel",)
    assert not staged_path.exists()
    assert asset_upload_limiter().borrowed_tokens == 0


@pytest.mark.asyncio
async def test_cancelled_upload_finishes_metadata_before_reraising(tmp_path):
    from novelvideo.api.upload_workers import run_asset_upload_operation

    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release = threading.Event()
    target = tmp_path / "portrait.png"
    metadata: list[Path] = []

    def publish() -> Path:
        target.write_bytes(b"image")
        loop.call_soon_threadsafe(published.set)
        assert release.wait(timeout=5)
        return target

    async def finalize(path: Path) -> Path:
        metadata.append(path)
        return path

    task = asyncio.create_task(
        run_asset_upload_operation(publish, finalize=finalize)
    )
    try:
        await asyncio.wait_for(published.wait(), timeout=1)
        task.cancel("publish-cancel")
        await asyncio.sleep(0)
        assert not metadata
    finally:
        release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == ("publish-cancel",)
    assert target.exists()
    assert metadata == [target]


@pytest.mark.asyncio
async def test_cancelled_asset_worker_preserves_cancellation_precedence():
    from novelvideo.api.upload_workers import run_asset_upload_operation

    started = threading.Event()
    release = threading.Event()

    def failing_worker() -> None:
        started.set()
        release.wait(timeout=3)
        raise RuntimeError("asset worker failed after cancellation")

    task = asyncio.create_task(run_asset_upload_operation(failing_worker))
    assert await asyncio.to_thread(started.wait, 1)
    task.cancel("cancel-asset-worker")
    release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task
    assert raised.value.args == ("cancel-asset-worker",)


@pytest.mark.asyncio
async def test_unshielded_bounded_worker_cancels_while_waiting_for_capacity():
    from novelvideo.utils.async_ops import run_sync_bounded

    limiter = anyio.CapacityLimiter(1)
    holder_started = threading.Event()
    release_holder = threading.Event()
    queued_started = threading.Event()

    def hold_capacity() -> None:
        holder_started.set()
        assert release_holder.wait(timeout=5)

    holder = asyncio.create_task(
        run_sync_bounded(hold_capacity, limiter=limiter, shield=False)
    )
    queued = None
    try:
        assert await asyncio.to_thread(holder_started.wait, 1)
        queued = asyncio.create_task(
            run_sync_bounded(
                queued_started.set,
                limiter=limiter,
                shield=False,
            )
        )
        while limiter.statistics().tasks_waiting != 1:
            await asyncio.sleep(0)

        queued.cancel("drop-queued-work")
        done, _pending = await asyncio.wait({queued}, timeout=1)
        assert queued in done
        with pytest.raises(asyncio.CancelledError) as raised:
            await queued
        assert raised.value.args == ("drop-queued-work",)
        assert not queued_started.is_set()
        assert limiter.statistics().tasks_waiting == 0
    finally:
        release_holder.set()
        await asyncio.gather(holder, return_exceptions=True)
        if queued is not None and not queued.done():
            await asyncio.gather(queued, return_exceptions=True)


@pytest.mark.asyncio
async def test_unshielded_bounded_worker_keeps_capacity_after_admission():
    from novelvideo.utils.async_ops import run_sync_bounded

    limiter = anyio.CapacityLimiter(1)
    worker_started = threading.Event()
    release_worker = threading.Event()

    def hold_capacity() -> str:
        worker_started.set()
        assert release_worker.wait(timeout=5)
        return "worker-result"

    task = asyncio.create_task(
        run_sync_bounded(hold_capacity, limiter=limiter, shield=False)
    )
    try:
        assert await asyncio.to_thread(worker_started.wait, 1)
        task.cancel("cancel-admitted-work")
        await asyncio.sleep(0)

        assert not task.done()
        assert limiter.borrowed_tokens == 1
    finally:
        release_worker.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task
    assert raised.value.args == ("cancel-admitted-work",)
    assert limiter.borrowed_tokens == 0


@pytest.mark.asyncio
async def test_bounded_worker_returns_finalizer_result():
    from novelvideo.utils.async_ops import run_sync_bounded

    async def finalize(worker_result: str) -> str:
        assert worker_result == "worker-result"
        return "finalizer-result"

    result = await run_sync_bounded(
        lambda: "worker-result",
        limiter=anyio.CapacityLimiter(1),
        finalize=finalize,
    )

    assert result == "finalizer-result"


@pytest.mark.asyncio
async def test_repeated_cancellation_waits_for_worker_then_finishes_route_metadata(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters
    from novelvideo.api.upload_workers import asset_upload_limiter

    store = _CharacterStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(characters, "_resolve_character_project", resolve_project)
    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release = threading.Event()

    def publish(_file: UploadFile, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"image")
        loop.call_soon_threadsafe(published.set)
        assert release.wait(timeout=5)

    monkeypatch.setattr(characters, "_persist_uploaded_character_image", publish)
    task = asyncio.create_task(
        characters.upload_portrait(
            project="demo",
            name="秦",
            file=_png_upload(),
            user={"username": "admin"},
        )
    )
    try:
        await asyncio.wait_for(published.wait(), timeout=1)
        task.cancel("first-worker-cancel")
        await asyncio.sleep(0)
        task.cancel("second-worker-cancel")
        await asyncio.sleep(0)
        assert not task.done()
        assert asset_upload_limiter().borrowed_tokens == 1
        assert store.touched == []
    finally:
        release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == ("first-worker-cancel",)
    assert store.touched == ["秦"]
    assert asset_upload_limiter().borrowed_tokens == 0


@pytest.mark.asyncio
async def test_repeated_cancellation_waits_for_route_metadata_finalize(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    store = _CharacterStore()
    ctx = SimpleNamespace(project_id="proj_demo")
    finalize_started = asyncio.Event()
    finalize_release = asyncio.Event()

    async def touch_character_asset(name: str) -> bool:
        finalize_started.set()
        await finalize_release.wait()
        store.touched.append(name)
        return True

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    def publish(_file: UploadFile, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"image")

    monkeypatch.setattr(store, "touch_character_asset", touch_character_asset)
    monkeypatch.setattr(characters, "_resolve_character_project", resolve_project)
    monkeypatch.setattr(characters, "_persist_uploaded_character_image", publish)
    task = asyncio.create_task(
        characters.upload_portrait(
            project="demo",
            name="秦",
            file=_png_upload(),
            user={"username": "admin"},
        )
    )
    try:
        await asyncio.wait_for(finalize_started.wait(), timeout=1)
        task.cancel("first-finalize-cancel")
        await asyncio.sleep(0)
        task.cancel("second-finalize-cancel")
        await asyncio.sleep(0)
        assert not task.done()
        assert store.touched == []
    finally:
        finalize_release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == ("first-finalize-cancel",)
    assert store.touched == ["秦"]


@pytest.mark.asyncio
async def test_asset_upload_preserves_anyio_cancel_scope_marker():
    from novelvideo.api.upload_workers import (
        asset_upload_limiter,
        run_asset_upload_operation,
    )

    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    scope = anyio.CancelScope()
    outcome: dict[str, bool] = {}

    def blocking_upload() -> None:
        loop.call_soon_threadsafe(started.set)
        assert release.wait(timeout=5)

    async def run_in_scope() -> None:
        with scope:
            await run_asset_upload_operation(blocking_upload)
        outcome["cancelled_caught"] = scope.cancelled_caught

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(run_in_scope)
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            scope.cancel()
            await anyio.sleep(0)
            assert asset_upload_limiter().borrowed_tokens == 1
        finally:
            release.set()

    assert outcome == {"cancelled_caught": True}


def test_custom_scene_package_size_guard_removes_partial_temp(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes
    from novelvideo.utils.upload_safety import UploadTooLargeError

    monkeypatch.setattr(scenes.tempfile, "tempdir", str(tmp_path))
    upload = UploadFile(file=io.BytesIO(b"12345"), filename="scene.sog")

    with pytest.raises(UploadTooLargeError):
        scenes._copy_upload_to_temp_file(upload, suffix=".sog", max_bytes=4)

    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_custom_scene_route_enforces_stream_limit_without_content_length(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import scenes
    from novelvideo.utils.upload_safety import UploadTooLargeError

    store = _SceneStore()
    ctx = SimpleNamespace(project_id="proj_demo")

    async def resolve_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_project)
    monkeypatch.setattr(scenes.tempfile, "tempdir", str(tmp_path))
    seen_limits: list[int] = []

    def reject_oversize(_file, *, suffix, max_bytes):
        assert suffix == ".sog"
        seen_limits.append(max_bytes)
        raise UploadTooLargeError("oversize")

    monkeypatch.setattr(scenes, "_copy_upload_to_temp_file", reject_oversize)

    response = await scenes.upload_scene_custom_package(
        project="demo",
        name="Hall",
        file=UploadFile(file=io.BytesIO(b"12345"), filename="scene.sog"),
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "error": "Custom scene package exceeds 200MB limit",
    }
    assert seen_limits == [200 * 1024 * 1024]
    assert list(tmp_path.iterdir()) == []
