from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import UploadFile

from novelvideo.api.schemas import CharacterUpdate
from novelvideo.models import CharacterIdentity, NovelCharacter


class _CharacterStore:
    def __init__(self, characters: list[NovelCharacter]):
        self.characters = {character.name: character for character in characters}
        self.updates: list[tuple[str, dict]] = []

    def get_character(self, name: str):
        return self.characters.get(name)

    def get_all_characters(self):
        return list(self.characters.values())

    async def list_characters(self):
        return list(self.characters.values())

    async def update_character(self, name: str, **updates):
        self.updates.append((name, updates))
        character = self.characters[name]
        for key, value in updates.items():
            setattr(character, key, value)
        return True

    async def repair_path_unsafe_asset_names(self, kind: str, move_assets=None):
        # 这里的名字都是干净的，list 接口上那道存量自愈是空跑。
        return {}


def _patch_project(
    monkeypatch: pytest.MonkeyPatch,
    module,
    project_dir: Path,
    store: _CharacterStore,
) -> None:
    # 函数内 import：``tests/contract/test_m01_auth.py`` 会把 ``novelvideo.api.*``
    # 整片从 ``sys.modules`` 里弹掉重建 app，模块级绑定到那时是死对象，patch 会落空。
    from novelvideo.api import deps

    ctx = SimpleNamespace(project_id="proj_demo", output_dir=project_dir, is_home_node=True)

    # 打在解析层，不打 ``_resolve_character_project``：角色列表和 identities 两条读取
    # 路径走的是 ``_character_project_scope``，只打裸版本会打空。塞在这一层，两条路上
    # 的 ``async with`` / ``try/finally`` 跑的都是真代码。
    async def fake_resolve_project_scope(project: str, user: dict, *, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir),
            runtime_dir=str(project_dir),
        )

    async def fake_make_store_for_context(_ctx, *, load_graph_state: bool = True):
        return store

    monkeypatch.setattr(module, "resolve_project_scope", fake_resolve_project_scope)
    # 裸 helper 用 ``characters`` 上 import 进来的名字；scope 里的
    # ``sqlite_store_for_context_scope`` 是在 ``deps`` 上按模块全局解析工厂的。两处都要打。
    monkeypatch.setattr(module, "make_sqlite_store_for_context", fake_make_store_for_context)
    monkeypatch.setattr(deps, "make_sqlite_store_for_context", fake_make_store_for_context)
    monkeypatch.setattr(
        module,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )


@pytest.mark.asyncio
async def test_update_character_accepts_age_group(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦", age_group="youth")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)

    response = await characters.update_character(
        project="demo",
        name="秦",
        body=CharacterUpdate(age_group="elder"),
        user={"username": "admin"},
    )

    assert response == {
        "ok": True,
        "data": {"name": "秦", "updated_fields": ["age_group"]},
    }
    assert store.updates == [("秦", {"age_group": "elder"})]
    assert character.age_group == "elder"


@pytest.mark.asyncio
async def test_list_characters_returns_indextts2_voice_fields(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    voice_path = tmp_path / "assets" / "characters" / "秦" / "voices" / "voice_default.wav"
    voice_path.parent.mkdir(parents=True)
    voice_path.write_bytes(b"default voice")
    character = NovelCharacter(
        name="秦",
        fish_voice_id="legacy-fish-id",
        reference_audio_path="assets/characters/秦/voices/voice_default.wav",
        reference_audio_sha256="default-sha",
        reference_audio_updated_at="2026-05-13T00:00:00+00:00",
        voice_samples_by_age_group={
            "child": {
                "path": "assets/characters/秦/voices/voice_child.wav",
                "sha256": "child-sha",
                "updated_at": "2026-05-13T00:00:01+00:00",
            }
        },
    )
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)

    response = await characters.list_characters(
        project="demo",
        summary=True,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    asset = response["data"][0]
    assert "fish_voice_id" not in asset
    assert asset["reference_audio_path"] == "assets/characters/秦/voices/voice_default.wav"
    assert asset["reference_audio_url"] == (
        "/static/projects/proj_demo/assets/characters/%E7%A7%A6/voices/voice_default.wav"
    )
    assert asset["reference_audio_sha256"] == "default-sha"
    assert asset["reference_audio_updated_at"] == "2026-05-13T00:00:00+00:00"
    assert asset["voice_samples_by_age_group"]["child"]["sha256"] == "child-sha"


@pytest.mark.asyncio
async def test_list_identities_returns_indextts2_voice_fields(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    voice_path = tmp_path / "assets" / "characters" / "秦" / "identities" / "幼年_voice.wav"
    voice_path.parent.mkdir(parents=True)
    voice_path.write_bytes(b"identity voice")
    identity = CharacterIdentity(
        identity_id="秦_幼年",
        character_name="秦",
        identity_name="幼年",
        fish_voice_id="legacy-fish-id",
        reference_audio_path="assets/characters/秦/identities/幼年_voice.wav",
        reference_audio_sha256="identity-sha",
        reference_audio_updated_at="2026-05-13T00:00:02+00:00",
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)

    response = await characters.get_character_identities(
        project="demo",
        name="秦",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    asset = response["data"][0]
    assert "fish_voice_id" not in asset
    assert asset["reference_audio_path"] == "assets/characters/秦/identities/幼年_voice.wav"
    assert asset["reference_audio_url"] == (
        "/static/projects/proj_demo/assets/characters/秦/identities/幼年_voice.wav"
    )
    assert asset["reference_audio_sha256"] == "identity-sha"
    assert asset["reference_audio_updated_at"] == "2026-05-13T00:00:02+00:00"


@pytest.mark.asyncio
async def test_list_character_voice_samples_returns_default_and_age_slots(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    default_path = tmp_path / "assets" / "characters" / "秦" / "voices" / "voice_default.wav"
    child_path = tmp_path / "assets" / "characters" / "秦" / "voices" / "voice_child.wav"
    default_path.parent.mkdir(parents=True)
    default_path.write_bytes(b"default voice")
    child_path.write_bytes(b"child voice")
    character = NovelCharacter(
        name="秦",
        reference_audio_path="assets/characters/秦/voices/voice_default.wav",
        reference_audio_sha256="default-sha",
        reference_audio_updated_at="2026-05-13T00:00:00+00:00",
        voice_samples_by_age_group={
            "child": {
                "path": "assets/characters/秦/voices/voice_child.wav",
                "sha256": "child-sha",
                "updated_at": "2026-05-13T00:00:01+00:00",
            }
        },
    )
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)

    response = await characters.list_character_voice_samples(
        project="demo",
        name="秦",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    slots = {slot["slot"]: slot for slot in response["data"]["slots"]}
    assert list(slots) == ["default", "child", "youth", "middle", "elder"]
    assert slots["default"]["path"] == "assets/characters/秦/voices/voice_default.wav"
    assert slots["default"]["url"] == (
        "/static/projects/proj_demo/assets/characters/秦/voices/voice_default.wav"
    )
    assert slots["default"]["sha256"] == "default-sha"
    assert slots["default"]["required"] is True
    assert slots["default"]["inherited_from_default"] is False
    assert slots["child"]["path"] == "assets/characters/秦/voices/voice_child.wav"
    assert slots["child"]["url"] == (
        "/static/projects/proj_demo/assets/characters/秦/voices/voice_child.wav"
    )
    assert slots["child"]["sha256"] == "child-sha"
    assert slots["child"]["inherited_from_default"] is False
    assert slots["youth"]["path"] == ""
    assert slots["youth"]["inherited_from_default"] is True


@pytest.mark.asyncio
async def test_upload_character_voice_sample_persists_default_slot(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    upload = UploadFile(file=io.BytesIO(b"default voice"), filename="voice.wav")

    response = await characters.upload_character_voice_sample(
        project="demo",
        name="秦",
        slot="default",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["slot"] == "default"
    assert data["path"].endswith("voice_default.wav")
    assert data["sha256"]
    assert (tmp_path / data["path"]).exists()
    assert store.updates[-1][1]["reference_audio_path"] == data["path"]
    assert store.updates[-1][1]["reference_audio_sha256"] == data["sha256"]
    assert store.updates[-1][1]["reference_audio_updated_at"] == data["updated_at"]


@pytest.mark.asyncio
async def test_upload_character_voice_sample_reads_and_writes_off_event_loop(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    event_loop_thread = threading.get_ident()
    worker_threads: list[int] = []
    original_persist = characters.persist_character_voice_file

    def recording_persist(**kwargs):
        worker_threads.append(threading.get_ident())
        return original_persist(**kwargs)

    monkeypatch.setattr(characters, "persist_character_voice_file", recording_persist)

    response = await characters.upload_character_voice_sample(
        project="demo",
        name="秦",
        slot="default",
        file=UploadFile(file=io.BytesIO(b"default voice"), filename="voice.wav"),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert worker_threads and worker_threads[0] != event_loop_thread


@pytest.mark.asyncio
async def test_upload_character_voice_sample_rejects_unsupported_format(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    upload = UploadFile(file=io.BytesIO(b"not audio"), filename="voice.txt")

    response = await characters.upload_character_voice_sample(
        project="demo",
        name="秦",
        slot="default",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "mp3 / wav / m4a / aac / ogg" in response["error"]
    assert store.updates == []


@pytest.mark.asyncio
async def test_record_character_voice_sample_persists_age_slot(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    event_loop_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []
    payload = base64.b64encode(b"recorded voice").decode("ascii")
    body = SimpleNamespace(data_url=f"data:audio/wav;base64,{payload}")

    def fake_decode(_data_url):
        worker_thread_ids.append(threading.get_ident())
        return b"recorded voice", ".wav"

    original_persist = characters.persist_character_voice_file

    def recording_persist(**kwargs):
        worker_thread_ids.append(threading.get_ident())
        return original_persist(**kwargs)

    monkeypatch.setattr(characters, "decode_recorded_audio_data_url", fake_decode)
    monkeypatch.setattr(characters, "persist_character_voice_file", recording_persist)

    response = await characters.record_character_voice_sample(
        project="demo",
        name="秦",
        slot="youth",
        body=body,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["slot"] == "youth"
    assert data["path"].endswith("voice_youth.wav")
    assert data["sha256"]
    assert (tmp_path / data["path"]).exists()
    assert len(worker_thread_ids) == 2
    assert len(set(worker_thread_ids)) == 1
    assert event_loop_thread_id not in worker_thread_ids
    assert store.updates[-1][1]["voice_samples_by_age_group"]["youth"]["path"] == data["path"]
    assert store.updates[-1][1]["voice_samples_by_age_group"]["youth"]["sha256"] == data["sha256"]


@pytest.mark.asyncio
async def test_trim_character_voice_sample_updates_default_slot(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    source = tmp_path / "assets" / "characters" / "秦" / "voices" / "voice_default.wav"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source voice")
    character = NovelCharacter(
        name="秦",
        reference_audio_path="assets/characters/秦/voices/voice_default.wav",
        reference_audio_sha256="old-sha",
        reference_audio_updated_at="2026-05-13T00:00:00+00:00",
    )
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    event_loop_thread_id = threading.get_ident()
    calls: list[dict] = []
    worker_thread_ids: list[int] = []

    def fake_trim_existing_character_voice_file(**kwargs):
        worker_thread_ids.append(threading.get_ident())
        calls.append(kwargs)
        rel_path = "assets/characters/秦/voices/voice_default.wav"
        (tmp_path / rel_path).write_bytes(b"trimmed voice")
        return rel_path, "trimmed-sha", "2026-05-13T00:00:03+00:00"

    monkeypatch.setattr(
        characters,
        "trim_existing_character_voice_file",
        fake_trim_existing_character_voice_file,
        raising=False,
    )
    body = SimpleNamespace(
        source_path="assets/characters/秦/voices/voice_default.wav",
        start_seconds=1.0,
        duration_seconds=4.0,
    )

    response = await characters.trim_character_voice_sample(
        project="demo",
        name="秦",
        slot="default",
        body=body,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["slot"] == "default"
    assert data["path"] == "assets/characters/秦/voices/voice_default.wav"
    assert data["sha256"] == "trimmed-sha"
    assert data["updated_at"] == "2026-05-13T00:00:03+00:00"
    assert calls == [
        {
            "project_dir": tmp_path,
            "character_name": "秦",
            "slot": "default",
            "source_path": "assets/characters/秦/voices/voice_default.wav",
            "start_seconds": 1.0,
            "duration_seconds": 4.0,
        }
    ]
    assert worker_thread_ids
    assert event_loop_thread_id not in worker_thread_ids
    assert store.updates[-1][1]["reference_audio_sha256"] == "trimmed-sha"
    assert store.updates[-1][1]["reference_audio_updated_at"] == "2026-05-13T00:00:03+00:00"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["upload", "record", "trim"])
async def test_cancelled_voice_publish_finishes_sqlite_metadata(
    tmp_path, monkeypatch, operation
):
    import asyncio

    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    loop = asyncio.get_running_loop()
    published = asyncio.Event()
    release = threading.Event()
    rel_path = "assets/characters/秦/voices/voice_default.wav"

    def publish(*_args, **_kwargs):
        target = tmp_path / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"voice")
        loop.call_soon_threadsafe(published.set)
        assert release.wait(timeout=5)
        return rel_path, "voice-sha", "2026-08-28T00:00:00+00:00"

    if operation == "upload":
        monkeypatch.setattr(characters, "_persist_uploaded_character_voice", publish)
        route_call = characters.upload_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            file=UploadFile(file=io.BytesIO(b"voice"), filename="voice.wav"),
            user={"username": "admin"},
        )
    elif operation == "record":
        monkeypatch.setattr(characters, "_persist_recorded_character_voice", publish)
        route_call = characters.record_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            body=SimpleNamespace(data_url="data:audio/wav;base64,dm9pY2U="),
            user={"username": "admin"},
        )
    else:
        monkeypatch.setattr(
            characters, "trim_existing_character_voice_file", publish
        )
        route_call = characters.trim_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            body=SimpleNamespace(
                source_path=rel_path,
                start_seconds=0.0,
                duration_seconds=1.0,
            ),
            user={"username": "admin"},
        )

    task = asyncio.create_task(route_call)
    try:
        await asyncio.wait_for(published.wait(), timeout=1)
        task.cancel(f"cancel-voice-{operation}")
        await asyncio.sleep(0)
    finally:
        release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == (f"cancel-voice-{operation}",)
    assert (tmp_path / rel_path).exists()
    assert store.updates[-1][1]["reference_audio_path"] == rel_path
    assert store.updates[-1][1]["reference_audio_sha256"] == "voice-sha"


@pytest.mark.asyncio
async def test_delete_character_voice_sample_clears_age_slot(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    child_path = tmp_path / "assets" / "characters" / "秦" / "voices" / "voice_child.wav"
    child_path.parent.mkdir(parents=True)
    child_path.write_bytes(b"child voice")
    character = NovelCharacter(
        name="秦",
        reference_audio_path="assets/characters/秦/voices/voice_default.wav",
        reference_audio_sha256="default-sha",
        reference_audio_updated_at="2026-05-13T00:00:00+00:00",
        voice_samples_by_age_group={
            "child": {
                "path": "assets/characters/秦/voices/voice_child.wav",
                "sha256": "child-sha",
                "updated_at": "2026-05-13T00:00:01+00:00",
            }
        },
    )
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)

    response = await characters.delete_character_voice_sample(
        project="demo",
        name="秦",
        slot="child",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["slot"] == "child"
    assert response["data"]["path"] == ""
    assert "child" not in store.updates[-1][1]["voice_samples_by_age_group"]


@pytest.mark.asyncio
async def test_upload_then_delete_same_voice_slot_cannot_resurrect_file(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    upload_started = threading.Event()
    release_upload = threading.Event()
    delete_started = threading.Event()
    real_upload = characters._persist_uploaded_character_voice
    real_clear = characters.clear_character_voice_file

    def blocking_upload(*args, **kwargs):
        upload_started.set()
        assert release_upload.wait(timeout=3)
        return real_upload(*args, **kwargs)

    def tracking_clear(**kwargs):
        delete_started.set()
        return real_clear(**kwargs)

    monkeypatch.setattr(characters, "_persist_uploaded_character_voice", blocking_upload)
    monkeypatch.setattr(characters, "clear_character_voice_file", tracking_clear)
    upload = asyncio.create_task(
        characters.upload_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            file=UploadFile(file=io.BytesIO(b"new voice"), filename="voice.wav"),
            user={"username": "admin"},
        )
    )
    assert await asyncio.to_thread(upload_started.wait, 1)
    delete = asyncio.create_task(
        characters.delete_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            user={"username": "admin"},
        )
    )
    await asyncio.sleep(0)
    assert not delete_started.is_set()

    release_upload.set()
    upload_response, delete_response = await asyncio.gather(upload, delete)

    assert upload_response["ok"] is True
    assert delete_response["ok"] is True
    assert delete_started.is_set()
    assert character.reference_audio_path == ""
    assert character.reference_audio_sha256 == ""
    assert not (tmp_path / "assets/characters/秦/voices/voice_default.wav").exists()


@pytest.mark.asyncio
async def test_cancelled_character_voice_delete_finishes_file_and_metadata(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    rel_path = "assets/characters/秦/voices/voice_default.wav"
    target = tmp_path / rel_path
    target.parent.mkdir(parents=True)
    target.write_bytes(b"voice")
    character = NovelCharacter(
        name="秦",
        reference_audio_path=rel_path,
        reference_audio_sha256="old-sha",
        reference_audio_updated_at="2026-08-28T00:00:00+00:00",
    )
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    clear_started = threading.Event()
    release_clear = threading.Event()
    real_clear = characters.clear_character_voice_file

    def blocking_clear(**kwargs):
        clear_started.set()
        assert release_clear.wait(timeout=3)
        return real_clear(**kwargs)

    monkeypatch.setattr(characters, "clear_character_voice_file", blocking_clear)
    task = asyncio.create_task(
        characters.delete_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            user={"username": "admin"},
        )
    )
    assert await asyncio.to_thread(clear_started.wait, 1)
    task.cancel("cancel-delete")
    release_clear.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task

    assert raised.value.args == ("cancel-delete",)
    assert not target.exists()
    assert character.reference_audio_path == ""
    assert character.reference_audio_sha256 == ""


@pytest.mark.asyncio
async def test_two_uploads_same_voice_slot_publish_in_request_order(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()
    real_upload = characters._persist_uploaded_character_voice
    calls = 0
    calls_guard = threading.Lock()

    def ordered_upload(*args, **kwargs):
        nonlocal calls
        with calls_guard:
            calls += 1
            call_number = calls
        if call_number == 1:
            first_started.set()
            assert release_first.wait(timeout=3)
        else:
            second_started.set()
        return real_upload(*args, **kwargs)

    monkeypatch.setattr(characters, "_persist_uploaded_character_voice", ordered_upload)
    first = asyncio.create_task(
        characters.upload_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            file=UploadFile(file=io.BytesIO(b"first"), filename="voice.wav"),
            user={"username": "admin"},
        )
    )
    assert await asyncio.to_thread(first_started.wait, 1)
    second = asyncio.create_task(
        characters.upload_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            file=UploadFile(file=io.BytesIO(b"second"), filename="voice.wav"),
            user={"username": "admin"},
        )
    )
    await asyncio.sleep(0)
    assert not second_started.is_set()

    release_first.set()
    await asyncio.gather(first, second)

    target = tmp_path / "assets/characters/秦/voices/voice_default.wav"
    assert second_started.is_set()
    assert target.read_bytes() == b"second"
    assert character.reference_audio_sha256 == hashlib.sha256(b"second").hexdigest()


@pytest.mark.asyncio
async def test_upload_then_trim_same_voice_slot_uses_uploaded_file(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    rel_path = "assets/characters/秦/voices/voice_default.wav"
    character = NovelCharacter(name="秦")
    store = _CharacterStore([character])
    _patch_project(monkeypatch, characters, tmp_path, store)
    upload_started = threading.Event()
    release_upload = threading.Event()
    trim_started = threading.Event()
    real_upload = characters._persist_uploaded_character_voice

    def blocking_upload(*args, **kwargs):
        upload_started.set()
        assert release_upload.wait(timeout=3)
        return real_upload(*args, **kwargs)

    def trim_uploaded(**kwargs):
        trim_started.set()
        source = tmp_path / kwargs["source_path"]
        assert source.read_bytes() == b"uploaded"
        content = b"trimmed-uploaded"
        source.write_bytes(content)
        return (
            rel_path,
            hashlib.sha256(content).hexdigest(),
            "2026-08-28T00:00:00+00:00",
        )

    monkeypatch.setattr(characters, "_persist_uploaded_character_voice", blocking_upload)
    monkeypatch.setattr(characters, "trim_existing_character_voice_file", trim_uploaded)
    upload = asyncio.create_task(
        characters.upload_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            file=UploadFile(file=io.BytesIO(b"uploaded"), filename="voice.wav"),
            user={"username": "admin"},
        )
    )
    assert await asyncio.to_thread(upload_started.wait, 1)
    trim = asyncio.create_task(
        characters.trim_character_voice_sample(
            project="demo",
            name="秦",
            slot="default",
            body=SimpleNamespace(
                source_path=rel_path,
                start_seconds=0.0,
                duration_seconds=1.0,
            ),
            user={"username": "admin"},
        )
    )
    await asyncio.sleep(0)
    assert not trim_started.is_set()

    release_upload.set()
    await asyncio.gather(upload, trim)

    assert trim_started.is_set()
    assert (tmp_path / rel_path).read_bytes() == b"trimmed-uploaded"
    assert character.reference_audio_sha256 == hashlib.sha256(
        b"trimmed-uploaded"
    ).hexdigest()
