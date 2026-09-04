from io import BytesIO
from pathlib import Path
import tempfile
import threading
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


pytestmark = pytest.mark.m09


class _FakeStore:
    async def get_beats_as_dicts(self, episode: int):
        assert episode == 3
        return [{"beat_number": 1, "narration_segment": "Hello"}]


def _client(monkeypatch, tmp_path) -> TestClient:
    from novelvideo.api.routes import generation
    from novelvideo.api.deps import ProjectResolution

    async def fake_make_sqlite_store(username, project):
        assert username == "alice"
        assert project == "demo"
        return _FakeStore()

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

    app = FastAPI()
    app.include_router(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    monkeypatch.setattr(generation, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    return TestClient(app)


def _write_export_assets(project_dir, episode: int = 3) -> None:
    ep_tag = f"ep{episode:03d}"
    (project_dir / "audio" / ep_tag).mkdir(parents=True)
    (project_dir / "audio" / ep_tag / "beat_01.mp3").write_bytes(b"mp3")
    (project_dir / "videos" / "beats" / ep_tag).mkdir(parents=True)
    (project_dir / "videos" / "beats" / ep_tag / "beat_01.mp4").write_bytes(b"beat")
    (project_dir / "videos" / "episodes").mkdir(parents=True)
    (project_dir / "videos" / "episodes" / f"{ep_tag}_final.mp4").write_bytes(b"final")


def _download_scope() -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/export.zip",
        "raw_path": b"/export.zip",
        "query_string": b"",
        "headers": [],
        "client": None,
        "server": None,
        "extensions": {},
    }


async def _unused_receive() -> dict:
    return {"type": "http.disconnect"}


def test_export_video_returns_final_video_file(monkeypatch, tmp_path):
    _write_export_assets(tmp_path)
    response = _client(monkeypatch, tmp_path).get(
        "/projects/demo/episodes/3/export/video",
    )

    assert response.status_code == 200
    assert response.content == b"final"
    assert "attachment" in response.headers["content-disposition"]
    assert "ep003_final.mp4" in response.headers["content-disposition"]


def test_export_zip_contains_beat_media_final_video_and_srt(monkeypatch, tmp_path):
    _write_export_assets(tmp_path)
    response = _client(monkeypatch, tmp_path).post(
        "/projects/demo/episodes/3/export/zip",
    )

    assert response.status_code == 200
    with zipfile.ZipFile(BytesIO(response.content)) as zf:
        names = set(zf.namelist())
        compression = {item.filename: item.compress_type for item in zf.infolist()}

    assert "audio/beat_01.mp3" in names
    assert "video/beat_01.mp4" in names
    assert "ep003_final.mp4" in names
    assert "ep003.srt" in names
    assert compression["audio/beat_01.mp3"] == zipfile.ZIP_STORED
    assert compression["video/beat_01.mp4"] == zipfile.ZIP_STORED
    assert compression["ep003_final.mp4"] == zipfile.ZIP_STORED
    assert compression["ep003.srt"] == zipfile.ZIP_DEFLATED


def test_export_zip_writes_off_loop_and_removes_temp_after_response(monkeypatch, tmp_path):
    from novelvideo.export import episode_export

    _write_export_assets(tmp_path)
    endpoint_thread_ids: list[int] = []
    writer_thread_ids: list[int] = []
    temp_paths: list[Path] = []
    real_zip_file = zipfile.ZipFile
    real_named_temporary_file = tempfile.NamedTemporaryFile

    async def fake_build_srt_content(*_args, **_kwargs):
        endpoint_thread_ids.append(threading.get_ident())
        return "1\n00:00:00,000 --> 00:00:01,000\nHello\n"

    class TrackingZipFile(real_zip_file):
        def write(self, *args, **kwargs):
            writer_thread_ids.append(threading.get_ident())
            return super().write(*args, **kwargs)

    def tracking_named_temporary_file(*args, **kwargs):
        tmp = real_named_temporary_file(*args, **kwargs)
        temp_paths.append(Path(tmp.name))
        return tmp

    monkeypatch.setattr(episode_export, "build_srt_content", fake_build_srt_content)
    monkeypatch.setattr(zipfile, "ZipFile", TrackingZipFile)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", tracking_named_temporary_file)

    response = _client(monkeypatch, tmp_path).post(
        "/projects/demo/episodes/3/export/zip",
    )

    assert response.status_code == 200
    assert writer_thread_ids
    assert endpoint_thread_ids
    assert set(writer_thread_ids).isdisjoint(endpoint_thread_ids)
    assert temp_paths and all(not path.exists() for path in temp_paths)


def test_export_zip_removes_temp_when_write_fails(monkeypatch, tmp_path):
    _write_export_assets(tmp_path)
    temp_paths: list[Path] = []
    real_zip_file = zipfile.ZipFile
    real_named_temporary_file = tempfile.NamedTemporaryFile

    class FailingZipFile(real_zip_file):
        def write(self, *_args, **_kwargs):
            raise OSError("disk full")

    def tracking_named_temporary_file(*args, **kwargs):
        tmp = real_named_temporary_file(*args, **kwargs)
        temp_paths.append(Path(tmp.name))
        return tmp

    monkeypatch.setattr(zipfile, "ZipFile", FailingZipFile)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", tracking_named_temporary_file)

    with pytest.raises(OSError, match="disk full"):
        _client(monkeypatch, tmp_path).post(
            "/projects/demo/episodes/3/export/zip",
        )

    assert temp_paths and all(not path.exists() for path in temp_paths)


@pytest.mark.asyncio
async def test_export_zip_cancellation_waits_for_writer_and_removes_temp(monkeypatch, tmp_path):
    import asyncio
    import anyio

    from novelvideo.api.routes import generation

    _write_export_assets(tmp_path)
    _client(monkeypatch, tmp_path)
    writer_started = threading.Event()
    release_writer = threading.Event()
    temp_paths: list[Path] = []
    real_zip_file = zipfile.ZipFile
    real_named_temporary_file = tempfile.NamedTemporaryFile

    class BlockingZipFile(real_zip_file):
        def write(self, *args, **kwargs):
            writer_started.set()
            release_writer.wait(timeout=5)
            return super().write(*args, **kwargs)

    def tracking_named_temporary_file(*args, **kwargs):
        tmp = real_named_temporary_file(*args, **kwargs)
        temp_paths.append(Path(tmp.name))
        return tmp

    monkeypatch.setattr(zipfile, "ZipFile", BlockingZipFile)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", tracking_named_temporary_file)

    scope_ready = asyncio.Event()
    scope_holder = {}

    async def cancel_and_release() -> None:
        await scope_ready.wait()
        assert await asyncio.to_thread(writer_started.wait, 1)
        scope_holder["scope"].cancel()
        await asyncio.sleep(0.05)
        release_writer.set()

    controller = asyncio.create_task(cancel_and_release())
    try:
        with anyio.CancelScope() as scope:
            scope_holder["scope"] = scope
            scope_ready.set()
            await generation.export_zip("demo", 3, user={"username": "alice"})
        assert scope.cancel_called
    finally:
        release_writer.set()
        await controller
    assert temp_paths and all(not path.exists() for path in temp_paths)


@pytest.mark.asyncio
async def test_export_zip_repeated_direct_cancellation_waits_and_cleans_temp(
    monkeypatch, tmp_path
):
    import asyncio

    from novelvideo.api.routes import generation
    from novelvideo.utils import async_ops

    _write_export_assets(tmp_path)
    _client(monkeypatch, tmp_path)
    writer_started = threading.Event()
    release_writer = threading.Event()
    temp_paths: list[Path] = []
    response_constructions: list[str] = []
    build_tasks: list[asyncio.Task] = []
    real_zip_file = zipfile.ZipFile
    real_named_temporary_file = tempfile.NamedTemporaryFile

    class BlockingZipFile(real_zip_file):
        def write(self, *args, **kwargs):
            writer_started.set()
            assert release_writer.wait(timeout=5)
            return super().write(*args, **kwargs)

    def tracking_named_temporary_file(*args, **kwargs):
        tmp = real_named_temporary_file(*args, **kwargs)
        temp_paths.append(Path(tmp.name))
        return tmp

    class TrackingResponse(generation._TemporaryFileResponse):
        def __init__(self, *args, **kwargs):
            response_constructions.append(str(kwargs.get("path", args[0] if args else "")))
            super().__init__(*args, **kwargs)

    real_call_blocking = async_ops.call_blocking

    async def tracking_call_blocking(*args, **kwargs):
        task = asyncio.current_task()
        assert task is not None
        build_tasks.append(task)
        return await real_call_blocking(*args, **kwargs)

    monkeypatch.setattr(zipfile, "ZipFile", BlockingZipFile)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", tracking_named_temporary_file)
    monkeypatch.setattr(generation, "_TemporaryFileResponse", TrackingResponse)
    monkeypatch.setattr(async_ops, "call_blocking", tracking_call_blocking)

    route_task = asyncio.create_task(
        generation.export_zip("demo", 3, user={"username": "alice"})
    )
    try:
        assert await asyncio.to_thread(writer_started.wait, 1)
        route_task.cancel("first-cancel")
        await asyncio.sleep(0)
        route_task.cancel("second-cancel")
        await asyncio.sleep(0)
        route_task.cancel("third-cancel")
        await asyncio.sleep(0)
        assert not route_task.done()
        assert temp_paths and any(path.exists() for path in temp_paths)
    finally:
        release_writer.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await route_task

    assert raised.value.args == ("first-cancel",)
    assert all(not path.exists() for path in temp_paths)
    assert response_constructions == []
    assert build_tasks and all(task.done() for task in build_tasks)


@pytest.mark.asyncio
async def test_export_zip_cancellation_wins_over_late_worker_error(
    monkeypatch, tmp_path
):
    import asyncio

    from novelvideo.api.routes import generation

    _write_export_assets(tmp_path)
    _client(monkeypatch, tmp_path)
    writer_started = threading.Event()
    release_writer = threading.Event()
    temp_paths: list[Path] = []
    real_zip_file = zipfile.ZipFile
    real_named_temporary_file = tempfile.NamedTemporaryFile

    class FailingBlockingZipFile(real_zip_file):
        def write(self, *_args, **_kwargs):
            writer_started.set()
            assert release_writer.wait(timeout=5)
            raise OSError("zip worker failed")

    def tracking_named_temporary_file(*args, **kwargs):
        tmp = real_named_temporary_file(*args, **kwargs)
        temp_paths.append(Path(tmp.name))
        return tmp

    monkeypatch.setattr(zipfile, "ZipFile", FailingBlockingZipFile)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", tracking_named_temporary_file)

    route_task = asyncio.create_task(
        generation.export_zip("demo", 3, user={"username": "alice"})
    )
    try:
        assert await asyncio.to_thread(writer_started.wait, 1)
        route_task.cancel("first-cancel")
        await asyncio.sleep(0)
        route_task.cancel("second-cancel")
        await asyncio.sleep(0)
        assert not route_task.done()
    finally:
        release_writer.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await route_task
    assert raised.value.args == ("first-cancel",)
    assert temp_paths and all(not path.exists() for path in temp_paths)


@pytest.mark.asyncio
async def test_export_zip_response_removes_temp_after_successful_send(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation

    _write_export_assets(tmp_path)
    _client(monkeypatch, tmp_path)
    response = await generation.export_zip("demo", 3, user={"username": "alice"})
    archive_path = Path(response.path)
    sent_messages: list[dict] = []

    async def send(message: dict) -> None:
        sent_messages.append(message)

    assert archive_path.exists()
    assert response.background is None
    await response(_download_scope(), _unused_receive, send)

    assert sent_messages[0]["type"] == "http.response.start"
    response_headers = dict(sent_messages[0]["headers"])
    assert response_headers[b"content-type"] == b"application/zip"
    assert response_headers[b"accept-ranges"] == b"bytes"
    assert b'demo_ep003.zip' in response_headers[b"content-disposition"]
    assert any(message["type"] == "http.response.body" for message in sent_messages)
    assert not archive_path.exists()


@pytest.mark.asyncio
async def test_export_zip_response_removes_temp_when_send_fails(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation

    _write_export_assets(tmp_path)
    _client(monkeypatch, tmp_path)
    response = await generation.export_zip("demo", 3, user={"username": "alice"})
    archive_path = Path(response.path)

    async def send(message: dict) -> None:
        if message["type"] == "http.response.body":
            raise RuntimeError("client disconnected")

    assert archive_path.exists()
    with pytest.raises(RuntimeError, match="client disconnected"):
        await response(_download_scope(), _unused_receive, send)
    assert not archive_path.exists()


@pytest.mark.asyncio
async def test_export_zip_response_removes_temp_when_send_is_cancelled(monkeypatch, tmp_path):
    import asyncio

    from novelvideo.api.routes import generation

    _write_export_assets(tmp_path)
    _client(monkeypatch, tmp_path)
    response = await generation.export_zip("demo", 3, user={"username": "alice"})
    archive_path = Path(response.path)

    async def send(message: dict) -> None:
        if message["type"] == "http.response.body":
            task = asyncio.current_task()
            assert task is not None
            task.cancel()
            await asyncio.sleep(0)

    assert archive_path.exists()
    with pytest.raises(asyncio.CancelledError):
        await response(_download_scope(), _unused_receive, send)
    assert not archive_path.exists()


@pytest.mark.asyncio
async def test_export_zip_removes_temp_when_response_construction_fails(monkeypatch, tmp_path):
    from novelvideo.api.routes import generation

    _write_export_assets(tmp_path)
    _client(monkeypatch, tmp_path)
    temp_paths: list[Path] = []
    real_named_temporary_file = tempfile.NamedTemporaryFile

    def tracking_named_temporary_file(*args, **kwargs):
        tmp = real_named_temporary_file(*args, **kwargs)
        temp_paths.append(Path(tmp.name))
        return tmp

    def fail_response_construction(*_args, **_kwargs):
        raise RuntimeError("response construction failed")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", tracking_named_temporary_file)
    monkeypatch.setattr(generation, "_TemporaryFileResponse", fail_response_construction)

    with pytest.raises(RuntimeError, match="response construction failed"):
        await generation.export_zip("demo", 3, user={"username": "alice"})
    assert temp_paths and all(not path.exists() for path in temp_paths)


def test_srt_export_falls_back_when_audio_duration_probe_fails(monkeypatch, tmp_path):
    from novelvideo.export import episode_export

    _write_export_assets(tmp_path)

    async def fail_duration(_audio_path):
        raise RuntimeError("ffprobe missing")

    monkeypatch.setattr(episode_export, "get_audio_duration_async", fail_duration)
    response = _client(monkeypatch, tmp_path).get(
        "/projects/demo/episodes/3/export/srt",
    )

    assert response.status_code == 200
    assert b"00:00:00,000 --> 00:00:05,000" in response.content
