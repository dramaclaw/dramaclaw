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

    store.state_dir = str(project_dir / "state")
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


@pytest.fixture
async def generated_api(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from novelvideo.api.routes import characters
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage
    from novelvideo.project_context import ProjectContext
    from novelvideo.sqlite_store import SQLiteStore
    from uuid import uuid4

    ctx = ProjectContext(
        "project",
        "demo",
        "user",
        "owner",
        "owner",
        "user",
        "user",
        (),
        "editor",
        "local",
        tmp_path / "output",
        tmp_path / "state",
        tmp_path / "runtime",
        True,
    )
    store = SQLiteStore(
        "demo", output_dir=str(ctx.output_dir), state_dir=str(ctx.state_dir)
    )
    await store.initialize()
    await store.add_character(NovelCharacter(name="hero"))
    await store.add_character(NovelCharacter(name="other"))

    async def resolve(*args, **kwargs):
        return ctx, "user", "demo", ctx.output_dir, str(ctx.output_dir), store

    monkeypatch.setattr(characters, "_resolve_character_project", resolve)
    monkeypatch.setattr(
        characters,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: "/static/" + rel,
    )
    monkeypatch.setattr(
        "novelvideo.audio.voice_design_storage.STATE_DIR", str(tmp_path / "quota")
    )
    storage = VoiceDesignStorage(ctx)

    def candidate(content=b"generated audio"):
        cid = str(uuid4())
        storage.reserve(
            cid,
            description="voice",
            preview_text="preview",
            language="zh",
            surface="supertale",
        )
        storage.claim(cid)
        path = storage.output_path(cid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        storage.complete(
            cid, duration_seconds=4, sha256=hashlib.sha256(content).hexdigest()
        )
        return cid

    app = FastAPI()
    app.include_router(characters.router, prefix="/api/v1")
    app.dependency_overrides[characters.get_api_user] = lambda: {"username": "user"}
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield SimpleNamespace(
            client=client,
            ctx=ctx,
            store=store,
            storage=storage,
            candidate=candidate,
            characters=characters,
        )
    await store.close()


def save_body(candidate_id, **kwargs):
    from uuid import uuid4

    return {
        "save_request_id": str(uuid4()),
        "candidate_id": candidate_id,
        "expected_slot": {"path": "", "sha256": "", "updated_at": ""},
        **kwargs,
    }


def voice_url(slot="default", name="hero", action="save-generated"):
    return f"/api/v1/projects/demo/characters/{name}/voice-samples/{slot}/{action}"


@pytest.mark.parametrize("slot", ["default", "child", "youth", "middle", "elder"])
async def test_generated_and_uploaded_voice_share_binding_flow(generated_api, slot):
    from novelvideo.seedance2_i2v.voice_clone import resolve_character_voice

    env = generated_api
    cid = env.candidate()
    response = await env.client.post(voice_url(slot), json=save_body(cid))
    assert response.status_code == 200, response.text
    saved = response.json()["data"]
    uploaded = await env.client.post(
        voice_url(slot, "other", "upload"),
        files={"file": ("audio.mp3", b"generated audio", "audio/mpeg")},
    )
    assert uploaded.status_code == 200
    assert saved.keys() == uploaded.json()["data"].keys()
    assert (env.ctx.output_dir / saved["path"]).read_bytes() == env.storage.output_path(
        cid
    ).read_bytes()
    assert saved["sha256"] == hashlib.sha256(b"generated audio").hexdigest()
    identity = None if slot == "default" else SimpleNamespace(age_group=slot)
    resolutions = [
        resolve_character_voice(
            project_dir=env.ctx.output_dir,
            character=env.store.get_character(name),
            identity=identity,
        )
        for name in ("hero", "other")
    ]
    assert resolutions[0].tier == resolutions[1].tier
    assert resolutions[0].sha256 == resolutions[1].sha256


async def test_save_is_idempotent(generated_api):
    env = generated_api
    body = save_body(env.candidate())
    first = await env.client.post(voice_url(), json=body)
    assert first.status_code == 200
    path = env.ctx.output_dir / first.json()["data"]["path"]
    mtime = path.stat().st_mtime_ns
    assert (await env.client.post(voice_url(), json=body)).json() == first.json()
    assert path.stat().st_mtime_ns == mtime
    conflict = await env.client.post(voice_url("child"), json=body)
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "idempotency_conflict"
    await env.client.post(
        voice_url(action="upload"), files={"file": ("new.mp3", b"new")}
    )
    conflict = await env.client.post(voice_url(), json=body)
    assert conflict.json()["code"] == "slot_changed"


async def test_replace_existing_archives_previous_voice(generated_api):
    env = generated_api
    old = (
        await env.client.post(
            voice_url(action="upload"), files={"file": ("old.mp3", b"old")}
        )
    ).json()["data"]
    expected = {k: old[k] for k in ("path", "sha256", "updated_at")}
    body = save_body(env.candidate(), expected_slot=expected)
    denied = await env.client.post(voice_url(), json=body)
    assert denied.status_code == 409 and denied.json()["code"] == "slot_occupied"
    assert (env.ctx.output_dir / old["path"]).read_bytes() == b"old"
    success = await env.client.post(
        voice_url(), json={**body, "replace_existing": True}
    )
    assert success.status_code == 200, success.text
    assert any(
        p.read_bytes() == b"old"
        for p in (env.ctx.output_dir / old["path"]).parent.glob("voice_default_*.mp3")
    )
    stale = await env.client.post(
        voice_url(),
        json=save_body(env.candidate(), expected_slot=expected, replace_existing=True),
    )
    assert stale.status_code == 409 and stale.json()["code"] == "slot_changed"


async def test_save_failure_recovers_file_and_metadata(generated_api, monkeypatch):
    import sqlite3

    env = generated_api
    await env.client.post(voice_url("child", action="upload"), files={"file": ("child.mp3", b"child")})
    await env.store.update_character("hero", identities=[CharacterIdentity(
        identity_id="legacy", identity_name="legacy", character_name="hero",
        reference_audio_path="legacy-identity.mp3", reference_audio_sha256="identity-sha",
    )])
    old = (
        await env.client.post(
            voice_url(action="upload"), files={"file": ("old.mp3", b"old")}
        )
    ).json()["data"]
    expected = {k: old[k] for k in ("path", "sha256", "updated_at")}
    before = (await env.store.get_character_from_graph("hero")).model_dump()
    real_update = env.store.update_character

    async def fail(*args, **kwargs):
        raise sqlite3.OperationalError("injected DB failure")

    monkeypatch.setattr(env.store, "update_character", fail)
    body = save_body(env.candidate(), expected_slot=expected, replace_existing=True)
    result = await env.client.post(voice_url(), json=body)
    assert result.status_code == 500, result.text
    assert (env.ctx.output_dir / old["path"]).read_bytes() == b"old"
    assert (await env.store.get_character_from_graph("hero")).model_dump() == before
    monkeypatch.setattr(env.store, "update_character", real_update)
    retry = await env.client.post(voice_url(), json=body)
    assert retry.status_code == 200, retry.text
    after = (await env.store.get_character_from_graph("hero")).model_dump()
    for field in ("identities_json", "voice_samples_by_age_group_json"):
        assert after[field] == before[field]
    child = env.store.get_character("hero").voice_samples_by_age_group["child"]
    assert (env.ctx.output_dir / child["path"]).read_bytes() == b"child"


async def test_save_disabled_generation_and_candidate_errors(
    generated_api, monkeypatch
):
    env = generated_api
    cid = env.candidate()
    def disabled():
        raise AssertionError("saving must not call generation configuration or provider")
    monkeypatch.setattr("novelvideo.audio.voice_design_service.ensure_voice_design_enabled", disabled)
    assert (await env.client.post(voice_url(), json=save_body(cid))).status_code == 200
    from uuid import uuid4

    missing = await env.client.post(voice_url("child"), json=save_body(str(uuid4())))
    assert missing.status_code == 404
    invalid = await env.client.post(voice_url("bad"), json=save_body(cid))
    assert invalid.status_code == 422 and invalid.json()["code"] == "invalid_input"
    env.storage.output_path(cid).unlink()
    missing_audio = await env.client.post(voice_url("child"), json=save_body(cid))
    assert missing_audio.json()["code"] == "candidate_audio_missing"


def _voice_worker(
    ctx, body, slot, barrier_dir=None, crash=None, action="save-generated"
):
    import os
    import time
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from novelvideo.api.routes import characters
    from novelvideo.audio import voice_design_storage
    from novelvideo.sqlite_store import SQLiteStore

    voice_design_storage.STATE_DIR = str(ctx.state_dir.parent / "quota")

    async def run():
        store = SQLiteStore(
            "demo", output_dir=str(ctx.output_dir), state_dir=str(ctx.state_dir)
        )
        await store.initialize()
        await store.load_graph_state()

        async def resolve(*args, **kwargs):
            return ctx, "user", "demo", ctx.output_dir, str(ctx.output_dir), store

        characters._resolve_character_project = resolve
        characters.make_static_url_for_context = lambda ctx, rel, local_path=None: (
            "/static/" + rel
        )
        if crash == "published":
            original = characters.persist_character_voice_file

            def terminate(**kwargs):
                original(**kwargs)
                os._exit(17)

            characters.persist_character_voice_file = terminate
        elif crash == "committed":
            original_update = characters._apply_character_voice_update

            async def terminate(**kwargs):
                await original_update(**kwargs)
                os._exit(18)

            characters._apply_character_voice_update = terminate
        if barrier_dir:
            (barrier_dir / str(os.getpid())).touch()
            deadline = time.monotonic() + 30
            while len(list(barrier_dir.iterdir())) < 2:
                assert time.monotonic() < deadline
                await asyncio.sleep(0.01)
        app = FastAPI()
        app.include_router(characters.router, prefix="/api/v1")
        app.dependency_overrides[characters.get_api_user] = lambda: {"username": "user"}
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                if action == "upload":
                    result = await client.post(
                        voice_url(slot, action=action),
                        files={"file": ("upload.mp3", b"uploaded")},
                    )
                else:
                    result = await client.post(voice_url(slot), json=body)
                return result.status_code, result.json()
        finally:
            await store.close()

    return asyncio.run(run())


@pytest.mark.parametrize(
    "slots,actions",
    [
        (("child", "elder"), ("save-generated", "save-generated")),
        (("child", "child"), ("save-generated", "save-generated")),
        (("child", "child"), ("upload", "save-generated")),
    ],
)
async def test_save_compare_and_set_preserves_concurrent_updates(
    generated_api, tmp_path, slots, actions
):
    from concurrent.futures import ProcessPoolExecutor
    import multiprocessing

    env = generated_api
    bodies = [save_body(env.candidate(b"first")), save_body(env.candidate(b"second"))]
    barrier = tmp_path / "barrier"
    barrier.mkdir()

    def compete():
        with ProcessPoolExecutor(
            2, mp_context=multiprocessing.get_context("spawn")
        ) as pool:
            futures = [
                pool.submit(_voice_worker, env.ctx, body, slot, barrier, None, action)
                for body, slot, action in zip(bodies, slots, actions)
            ]
            return [f.result(timeout=90) for f in futures]

    results = await asyncio.to_thread(compete)
    character = await env.store.get_character_from_graph("hero")
    if slots[0] != slots[1]:
        assert [r[0] for r in results] == [200, 200], results
        assert set(character.voice_samples_by_age_group) == {"child", "elder"}
    elif actions[0] == "save-generated":
        assert sorted(r[0] for r in results) == [200, 409], results
        assert next(r[1]["code"] for r in results if r[0] == 409) == "slot_changed"
    else:
        assert results[0][0] == 200
        assert results[1][0] in (200, 409)
        if results[1][0] == 409:
            assert results[1][1]["code"] == "slot_changed"
    for meta in character.voice_samples_by_age_group.values():
        assert (
            hashlib.sha256((env.ctx.output_dir / meta["path"]).read_bytes()).hexdigest()
            == meta["sha256"]
        )


@pytest.mark.parametrize("crash,exitcode", [("published", 17), ("committed", 18)])
async def test_save_failure_recovers_file_and_metadata_after_process_restart(
    generated_api, crash, exitcode
):
    import multiprocessing

    env = generated_api
    old = (
        await env.client.post(
            voice_url(action="upload"), files={"file": ("old.mp3", b"old")}
        )
    ).json()["data"]
    expected = {k: old[k] for k in ("path", "sha256", "updated_at")}
    body = save_body(env.candidate(), expected_slot=expected, replace_existing=True)
    process = multiprocessing.get_context("spawn").Process(
        target=_voice_worker, args=(env.ctx, body, "default", None, crash)
    )
    process.start()
    await asyncio.to_thread(process.join, 60)
    assert process.exitcode == exitcode
    # Restarted access recovers before reads; replay never republishes a committed save.
    recovered = await env.client.get("/api/v1/projects/demo/characters/hero/voice-samples")
    assert recovered.status_code == 200
    current = env.characters._voice_slot_metadata(
        env.store.get_character("hero"), "default"
    )
    if crash == "published":
        assert current == expected
        assert (env.ctx.output_dir / current["path"]).read_bytes() == b"old"
    else:
        assert current["sha256"] == hashlib.sha256(b"generated audio").hexdigest()
    result = await env.client.post(voice_url(), json=body)
    assert result.status_code == 200, result.text
    if crash == "committed":
        assert result.json()["data"]["updated_at"] == current["updated_at"]
    assert not list((env.ctx.state_dir / "character-voice-publications").glob("*.json"))


async def test_cancelled_generated_save_finishes_file_and_metadata(
    generated_api, monkeypatch
):
    env = generated_api
    body = save_body(env.candidate())
    started, release = threading.Event(), threading.Event()
    original = env.characters.persist_character_voice_file

    def blocked(**kwargs):
        started.set()
        assert release.wait(3)
        return original(**kwargs)

    monkeypatch.setattr(env.characters, "persist_character_voice_file", blocked)
    task = asyncio.create_task(env.client.post(voice_url(), json=body))
    assert await asyncio.to_thread(started.wait, 2)
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await env.client.post(voice_url(), json=body)
    assert result.status_code == 200
    data = result.json()["data"]
    assert (
        hashlib.sha256((env.ctx.output_dir / data["path"]).read_bytes()).hexdigest()
        == data["sha256"]
    )


async def test_save_database_commit_failure_rolls_back_pending_sql(
    generated_api, monkeypatch
):
    import sqlite3

    env = generated_api
    body = save_body(env.candidate())
    db = await env.store._ensure_db()
    original = db.commit

    async def fail():
        raise sqlite3.OperationalError("commit failure")

    monkeypatch.setattr(db, "commit", fail)
    result = await env.client.post(voice_url(), json=body)
    assert result.status_code == 500
    assert (await env.store.get_character_from_graph("hero")).reference_audio_path == ""
    assert not list(env.ctx.output_dir.glob("assets/characters/hero/voices/voice_*"))
    monkeypatch.setattr(db, "commit", original)
    assert (await env.client.post(voice_url(), json=body)).status_code == 200


async def test_generated_save_scopes_permissions_and_candidate_owner(
    generated_api, monkeypatch
):
    from dataclasses import replace
    from fastapi import HTTPException

    env = generated_api
    body = save_body(env.candidate())
    original = env.characters._resolve_character_project
    for status, expected in [
        (403, "voice_design_forbidden"),
        (404, "project_not_found"),
    ]:

        async def denied(project, user, *, required_role="editor"):
            assert required_role == "editor"
            raise HTTPException(status, "private details")

        monkeypatch.setattr(env.characters, "_resolve_character_project", denied)
        response = await env.client.post(voice_url(), json=body)
        assert response.status_code == status and response.json()["code"] == expected
        assert "private details" not in response.text

    async def foreign(*args, **kwargs):
        result = list(await original(*args, **kwargs))
        result[0] = replace(env.ctx, requester_user_id="someone-else")
        return tuple(result)

    monkeypatch.setattr(env.characters, "_resolve_character_project", foreign)
    response = await env.client.post(voice_url(), json=body)
    assert (
        response.status_code == 404 and response.json()["code"] == "candidate_not_found"
    )
