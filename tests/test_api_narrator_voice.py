from __future__ import annotations

import base64
import asyncio
import hashlib
import io
import threading
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi import UploadFile
from fastapi.testclient import TestClient

pytestmark = pytest.mark.m04


@dataclass
class DummyStore:
    project_dir: str

    def get_all_characters(self):
        return []


def _client(monkeypatch, tmp_path):
    from novelvideo import project_config
    from novelvideo.api.routes import projects

    project_dir = tmp_path / "output" / "admin" / "demo"
    project_dir.mkdir(parents=True)
    state_root = tmp_path / "state"
    monkeypatch.setattr(project_config, "STATE_DIR", state_root)
    monkeypatch.setattr(project_config, "OUTPUT_DIR", tmp_path / "output")

    fake_ctx = SimpleNamespace(
        project_id="demo",
        project_name="demo",
        owner_username="admin",
        owner_project_label="admin/demo",
        output_dir=project_dir,
        state_dir=state_root / "admin" / "demo",
        is_home_node=True,
    )

    async def fake_resolve_project_context(*, user, project_id, required_role="viewer"):
        return fake_ctx

    store = DummyStore(str(project_dir))

    async def fake_make_sqlite_store_for_context(ctx):
        return store

    def fake_make_static_url_for_context(ctx, relative_path, local_path=None):
        return f"/static/admin/demo/{relative_path}"

    monkeypatch.setattr(projects, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(
        projects, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(projects, "make_static_url_for_context", fake_make_static_url_for_context)

    app = FastAPI()
    app.include_router(projects.router)
    app.dependency_overrides[projects.get_api_user] = lambda: {"username": "admin"}
    return TestClient(app), project_config, project_dir, fake_ctx.state_dir


def test_narrator_voice_upload_persists_project_reference(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    project_config.set_narrator_reference_audio_in_state_dir(
        state_dir,
        relative_path="",
        sha256="",
    )

    response = client.post(
        "/projects/demo/narrator-voice/upload",
        files={"file": ("voice.wav", b"voice-bytes", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"]["reference_path"] == "assets/narrator/voice.wav"
    assert payload["data"]["reference_url"].startswith(
        "/static/admin/demo/assets/narrator/voice.wav"
    )
    saved = project_config.load_narrator_reference_audio_from_state_dir(state_dir)
    assert saved["path"] == "assets/narrator/voice.wav"
    assert saved["sha256"]
    assert (project_dir / "assets/narrator/voice.wav").read_bytes() == b"voice-bytes"


def test_narrator_voice_upload_persist_and_config_run_off_event_loop(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import projects

    client, _project_config, project_dir, _state_dir = _client(monkeypatch, tmp_path)
    loop_threads: list[int] = []
    persist_threads: list[int] = []
    config_threads: list[int] = []
    real_persist = projects._persist_narrator_voice_content
    real_set = projects.set_narrator_reference_audio_in_state_dir

    async def tracking_store(_ctx):
        loop_threads.append(threading.get_ident())
        return DummyStore(str(project_dir))

    def tracking_persist(**kwargs):
        persist_threads.append(threading.get_ident())
        return real_persist(**kwargs)

    def tracking_set(*args, **kwargs):
        config_threads.append(threading.get_ident())
        return real_set(*args, **kwargs)

    monkeypatch.setattr(projects, "make_sqlite_store_for_context", tracking_store)
    monkeypatch.setattr(projects, "_persist_narrator_voice_content", tracking_persist)
    monkeypatch.setattr(
        projects, "set_narrator_reference_audio_in_state_dir", tracking_set
    )
    response = client.post(
        "/projects/demo/narrator-voice/upload",
        files={"file": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 200
    assert persist_threads == config_threads
    assert set(persist_threads).isdisjoint(loop_threads)


@pytest.mark.asyncio
async def test_narrator_voice_upload_reads_in_memory_stream_in_voice_worker(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import projects
    from novelvideo.seedance2_i2v import character_voice_storage

    project_dir = tmp_path / "output" / "admin" / "demo"
    state_dir = tmp_path / "state" / "admin" / "demo"
    ctx = SimpleNamespace(
        project_id="demo",
        project_name="demo",
        owner_username="admin",
        owner_project_label="admin/demo",
        output_dir=project_dir,
        state_dir=state_dir,
        is_home_node=True,
    )
    store = DummyStore(str(project_dir))

    async def resolve_context(**_kwargs):
        return ctx

    async def make_store(_ctx):
        return store

    monkeypatch.setattr(projects, "resolve_project_context", resolve_context)
    monkeypatch.setattr(projects, "make_sqlite_store_for_context", make_store)
    monkeypatch.setattr(
        projects,
        "make_static_url_for_context",
        lambda _ctx, relative_path, local_path=None: f"/static/{relative_path}",
    )
    loop_thread = threading.get_ident()
    read_threads: list[int] = []
    borrowed_tokens: list[int] = []
    voice_limiter = character_voice_storage._voice_media_limiter()

    class RecordingBytesIO(io.BytesIO):
        def read(self, *args, **kwargs):
            read_threads.append(threading.get_ident())
            borrowed_tokens.append(voice_limiter.borrowed_tokens)
            return super().read(*args, **kwargs)

    upload = UploadFile(
        filename="voice.wav",
        file=RecordingBytesIO(b"voice-from-memory"),
    )

    response = await projects.upload_narrator_voice(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert read_threads and loop_thread not in read_threads
    assert borrowed_tokens == [1]
    assert (project_dir / "assets/narrator/voice.wav").read_bytes() == b"voice-from-memory"


def test_narrator_voice_record_accepts_data_url(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    encoded = base64.b64encode(b"recorded-voice").decode("ascii")

    response = client.post(
        "/projects/demo/narrator-voice/record",
        json={"data_url": f"data:audio/wav;base64,{encoded}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"]["reference_path"] == "assets/narrator/voice.wav"
    assert project_config.load_narrator_reference_audio_from_state_dir(state_dir)["path"] == (
        "assets/narrator/voice.wav"
    )
    assert (project_dir / "assets/narrator/voice.wav").read_bytes() == b"recorded-voice"


def test_narrator_voice_record_decodes_off_event_loop(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    client, _project_config, _project_dir, _state_dir = _client(monkeypatch, tmp_path)
    worker_thread_ids: list[int] = []
    persist_thread_ids: list[int] = []
    real_persist = projects._persist_narrator_voice_content

    def fake_decode(_data_url):
        worker_thread_ids.append(threading.get_ident())
        return b"recorded-voice", ".wav"

    def tracking_persist(**kwargs):
        persist_thread_ids.append(threading.get_ident())
        return real_persist(**kwargs)

    monkeypatch.setattr(projects, "decode_recorded_audio_data_url", fake_decode)
    monkeypatch.setattr(projects, "_persist_narrator_voice_content", tracking_persist)

    response = client.post(
        "/projects/demo/narrator-voice/record",
        json={"data_url": "data:audio/webm;base64,eA=="},
    )

    assert response.status_code == 200
    assert worker_thread_ids
    assert persist_thread_ids == worker_thread_ids


def test_narrator_voice_trim_runs_off_event_loop(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    client, _project_config, _project_dir, _state_dir = _client(monkeypatch, tmp_path)
    ensure_thread_ids: list[int] = []
    worker_thread_ids: list[int] = []
    real_ensure = projects._ensure_third_person_narrator

    def tracking_ensure(ctx):
        ensure_thread_ids.append(threading.get_ident())
        return real_ensure(ctx)

    def fake_trim(**_kwargs):
        worker_thread_ids.append(threading.get_ident())

    monkeypatch.setattr(projects, "_ensure_third_person_narrator", tracking_ensure)
    monkeypatch.setattr(projects, "_trim_narrator_voice_content", fake_trim)

    response = client.post(
        "/projects/demo/narrator-voice/trim",
        json={"start_seconds": 0, "duration_seconds": 4},
    )

    assert response.status_code == 200
    assert worker_thread_ids
    assert worker_thread_ids == ensure_thread_ids


def test_narrator_voice_sources_and_copy(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    source = project_dir / "audio/ep001/beat_01.mp3"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source-voice")

    sources = client.get("/projects/demo/narrator-voice/sources")
    assert sources.status_code == 200
    assert sources.json()["data"]["options"] == [
        {
            "label": "已生成音频 · beat_01.mp3",
            "path": str(source),
            "rel_path": "audio/ep001/beat_01.mp3",
        }
    ]

    response = client.post(
        "/projects/demo/narrator-voice/copy",
        json={"source_path": str(source)},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert project_config.load_narrator_reference_audio_from_state_dir(state_dir)["path"] == (
        "assets/narrator/voice.mp3"
    )
    assert (project_dir / "assets/narrator/voice.mp3").read_bytes() == b"source-voice"


def test_narrator_voice_copy_stat_read_and_persist_run_off_event_loop(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import projects

    client, _project_config, project_dir, _state_dir = _client(monkeypatch, tmp_path)
    source = project_dir / "audio/source.mp3"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    loop_threads: list[int] = []
    stat_threads: list[int] = []
    read_threads: list[int] = []
    persist_threads: list[int] = []
    real_exists = Path.exists
    real_is_file = Path.is_file
    real_read_bytes = Path.read_bytes
    real_persist = projects._persist_narrator_voice_content

    async def tracking_store(_ctx):
        loop_threads.append(threading.get_ident())
        return DummyStore(str(project_dir))

    def tracking_read_bytes(path):
        if path == source:
            read_threads.append(threading.get_ident())
        return real_read_bytes(path)

    def tracking_exists(path):
        if path == source:
            stat_threads.append(threading.get_ident())
        return real_exists(path)

    def tracking_is_file(path):
        if path == source:
            stat_threads.append(threading.get_ident())
        return real_is_file(path)

    def tracking_persist(**kwargs):
        persist_threads.append(threading.get_ident())
        return real_persist(**kwargs)

    monkeypatch.setattr(projects, "make_sqlite_store_for_context", tracking_store)
    monkeypatch.setattr(Path, "exists", tracking_exists)
    monkeypatch.setattr(Path, "is_file", tracking_is_file)
    monkeypatch.setattr(Path, "read_bytes", tracking_read_bytes)
    monkeypatch.setattr(projects, "_persist_narrator_voice_content", tracking_persist)
    response = client.post(
        "/projects/demo/narrator-voice/copy", json={"source_path": str(source)}
    )

    assert response.status_code == 200
    assert stat_threads and set(stat_threads) == set(read_threads)
    assert read_threads == persist_threads
    assert set(read_threads).isdisjoint(loop_threads)


def test_narrator_voice_delete_renames_file_and_clears_metadata(monkeypatch, tmp_path):
    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    target = project_dir / "assets/narrator/voice.wav"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"voice")
    project_config.set_narrator_reference_audio_in_state_dir(
        state_dir,
        relative_path="assets/narrator/voice.wav",
        sha256="sha",
    )

    response = client.post("/projects/demo/narrator-voice/delete")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert project_config.load_narrator_reference_audio_from_state_dir(state_dir)["path"] == ""
    assert not target.exists()
    assert list((project_dir / "assets/narrator").glob("voice_*.wav"))


def test_narrator_voice_delete_config_and_archive_run_off_event_loop(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import projects

    client, project_config, project_dir, state_dir = _client(monkeypatch, tmp_path)
    target = project_dir / "assets/narrator/voice.wav"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"voice")
    project_config.set_narrator_reference_audio_in_state_dir(
        state_dir, relative_path="assets/narrator/voice.wav", sha256="sha"
    )
    loop_threads: list[int] = []
    load_threads: list[int] = []
    set_threads: list[int] = []
    real_load = projects.load_narrator_reference_audio_from_state_dir
    real_set = projects.set_narrator_reference_audio_in_state_dir

    async def tracking_store(_ctx):
        loop_threads.append(threading.get_ident())
        return DummyStore(str(project_dir))

    def tracking_load(*args, **kwargs):
        load_threads.append(threading.get_ident())
        return real_load(*args, **kwargs)

    def tracking_set(*args, **kwargs):
        set_threads.append(threading.get_ident())
        return real_set(*args, **kwargs)

    monkeypatch.setattr(projects, "make_sqlite_store_for_context", tracking_store)
    monkeypatch.setattr(
        projects, "load_narrator_reference_audio_from_state_dir", tracking_load
    )
    monkeypatch.setattr(
        projects, "set_narrator_reference_audio_in_state_dir", tracking_set
    )
    response = client.post("/projects/demo/narrator-voice/delete")

    assert response.status_code == 200
    assert set_threads
    assert load_threads[0] == set_threads[0]
    assert set(set_threads).isdisjoint(loop_threads)


@pytest.mark.asyncio
async def test_narrator_voice_same_project_updates_are_serialized_and_consistent(
    monkeypatch, tmp_path
):
    from novelvideo import project_config
    from novelvideo.api.routes import projects

    project_dir = tmp_path / "output/demo"
    state_dir = tmp_path / "state/demo"
    project_dir.mkdir(parents=True)
    ctx = SimpleNamespace(output_dir=project_dir, state_dir=state_dir)
    store = DummyStore(str(project_dir))
    first_started = threading.Event()
    first_payload_started = threading.Event()
    release_first_payload = threading.Event()
    second_started = threading.Event()
    payload_calls = 0
    real_upload = projects._upload_narrator_voice_content

    def controlled_upload(*, ctx, filename, content):
        if content == b"first":
            first_started.set()
        else:
            second_started.set()
        return real_upload(ctx=ctx, filename=filename, content=content)

    def controlled_payload(_ctx, _store):
        nonlocal payload_calls
        payload_calls += 1
        if payload_calls == 1:
            first_payload_started.set()
            release_first_payload.wait(timeout=3)
        return {}

    monkeypatch.setattr(projects, "_ensure_third_person_narrator", lambda _ctx: None)
    monkeypatch.setattr(projects, "_narrator_voice_payload", controlled_payload)
    first = asyncio.create_task(
        projects._run_narrator_voice_update(
            ctx, store, controlled_upload, ctx=ctx, filename="first.wav", content=b"first"
        )
    )
    assert await asyncio.to_thread(first_started.wait, 1)
    assert await asyncio.to_thread(first_payload_started.wait, 1)
    second = asyncio.create_task(
        projects._run_narrator_voice_update(
            ctx, store, controlled_upload, ctx=ctx, filename="second.wav", content=b"second"
        )
    )
    await asyncio.sleep(0)
    assert not second_started.is_set()
    release_first_payload.set()
    await asyncio.gather(first, second)

    target = project_dir / "assets/narrator/voice.wav"
    stored = project_config.load_narrator_reference_audio_from_state_dir(state_dir)
    assert target.read_bytes() == b"second"
    assert stored["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()
