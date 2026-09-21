from __future__ import annotations

import asyncio
import stat
import threading
from datetime import datetime
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from novelvideo.api.routes import freezone
from novelvideo.api.routes.freezone import _read_upload_contents
from novelvideo.freezone import paths as freezone_paths


def _stub_freezone_upload_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    safe_filename: str | None = "asset.bin",
) -> None:
    async def resolve_project(*_args, **_kwargs):
        return (
            SimpleNamespace(project_id="proj-demo"),
            "admin",
            "demo",
            tmp_path,
            str(tmp_path),
        )

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve_project)
    if safe_filename is not None:
        monkeypatch.setattr(
            freezone,
            "safe_upload_filename",
            lambda _filename: safe_filename,
        )
    monkeypatch.setattr(
        freezone,
        "make_static_url_for_context",
        lambda _ctx, rel, *, local_path: f"/media/{rel}",
    )


@pytest.mark.asyncio
async def test_read_reference_file_accepts_exact_limit() -> None:
    upload = UploadFile(filename="reference.pdf", file=BytesIO(b"1234"))

    assert await _read_upload_contents(upload, max_bytes=4) == b"1234"


@pytest.mark.asyncio
async def test_read_reference_file_rejects_over_limit() -> None:
    upload = UploadFile(filename="reference.pdf", file=BytesIO(b"12345"))

    with pytest.raises(HTTPException) as exc_info:
        await _read_upload_contents(upload, max_bytes=4)

    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == "reference file must be 100 MB or smaller"


@pytest.mark.asyncio
async def test_freezone_upload_writes_off_event_loop_and_preserves_response(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_freezone_upload_context(tmp_path, monkeypatch)
    event_loop_thread = threading.get_ident()
    operation_threads: dict[str, list[int]] = {
        "mkdir": [],
        "stage": [],
        "write": [],
        "replace": [],
    }
    original_mkdir = Path.mkdir
    original_create_staged_upload_file = freezone.create_staged_upload_file
    original_write_bytes = Path.write_bytes
    original_replace = Path.replace

    def record_mkdir(path: Path, *args, **kwargs) -> None:
        operation_threads["mkdir"].append(threading.get_ident())
        original_mkdir(path, *args, **kwargs)

    def record_staging(*args, **kwargs) -> Path:
        operation_threads["stage"].append(threading.get_ident())
        return original_create_staged_upload_file(*args, **kwargs)

    def record_write_thread(path: Path, contents: bytes) -> int:
        operation_threads["write"].append(threading.get_ident())
        return original_write_bytes(path, contents)

    def record_replace(path: Path, target: Path) -> Path:
        operation_threads["replace"].append(threading.get_ident())
        return original_replace(path, target)

    monkeypatch.setattr(Path, "mkdir", record_mkdir)
    monkeypatch.setattr(freezone, "create_staged_upload_file", record_staging)
    monkeypatch.setattr(Path, "write_bytes", record_write_thread)
    monkeypatch.setattr(Path, "replace", record_replace)

    result = await freezone._save_freezone_upload(
        "demo",
        UploadFile(filename="asset.bin", file=BytesIO(b"payload")),
        {"username": "admin"},
    )

    assert result == {
        "ok": True,
        "data": {
            "url": "/media/freezone/_uploads/asset.bin",
            "filename": "asset.bin",
            "size": 7,
        },
    }
    assert all(operation_threads.values())
    assert all(
        thread_id != event_loop_thread
        for threads in operation_threads.values()
        for thread_id in threads
    )
    assert (tmp_path / "freezone" / "_uploads" / "asset.bin").read_bytes() == b"payload"


@pytest.mark.asyncio
async def test_freezone_upload_keeps_event_loop_schedulable_during_slow_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_freezone_upload_context(tmp_path, monkeypatch)
    write_started = threading.Event()
    event_loop_resumed = threading.Event()
    release_write = threading.Event()
    coordinator_errors: list[str] = []
    original_write_bytes = Path.write_bytes

    def slow_write(path: Path, contents: bytes) -> int:
        write_started.set()
        assert release_write.wait(timeout=2)
        return original_write_bytes(path, contents)

    def release_after_event_loop_progress() -> None:
        if not event_loop_resumed.wait(timeout=1):
            coordinator_errors.append(
                "event loop did not resume while disk write was blocked"
            )
        release_write.set()

    monkeypatch.setattr(Path, "write_bytes", slow_write)
    coordinator = threading.Thread(
        target=release_after_event_loop_progress, daemon=True
    )
    coordinator.start()
    task = asyncio.create_task(
        freezone._save_freezone_upload(
            "demo",
            UploadFile(filename="asset.bin", file=BytesIO(b"payload")),
            {"username": "admin"},
        )
    )
    try:
        assert await asyncio.to_thread(write_started.wait, 2)
        event_loop_resumed.set()
        assert (await task)["ok"] is True
    finally:
        release_write.set()
        await asyncio.gather(task, return_exceptions=True)
        coordinator.join(timeout=2)

    assert coordinator_errors == []


@pytest.mark.asyncio
async def test_freezone_upload_failure_removes_partial_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_freezone_upload_context(tmp_path, monkeypatch)
    upload_dir = tmp_path / "freezone" / "_uploads"
    upload_dir.mkdir(parents=True)
    target = upload_dir / "asset.bin"
    target.write_bytes(b"original")
    target.chmod(0o640)
    original_mode = stat.S_IMODE(target.stat().st_mode)
    original_write_bytes = Path.write_bytes

    def fail_after_partial_write(path: Path, _contents: bytes) -> int:
        original_write_bytes(path, b"partial")
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_bytes", fail_after_partial_write)

    with pytest.raises(OSError, match="disk full"):
        await freezone._save_freezone_upload(
            "demo",
            UploadFile(filename="asset.bin", file=BytesIO(b"payload")),
            {"username": "admin"},
        )

    assert target.read_bytes() == b"original"
    assert stat.S_IMODE(target.stat().st_mode) == original_mode
    assert list(upload_dir.iterdir()) == [target]


@pytest.mark.asyncio
async def test_freezone_upload_accepts_long_legal_filename_without_staging_overflow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 16, 12, 34, 56, 123456, tzinfo=tz)

    _stub_freezone_upload_context(tmp_path, monkeypatch, safe_filename=None)
    monkeypatch.setattr(freezone_paths, "datetime", FixedDatetime)
    original_name = f"{'a' * 200}.png"
    expected_filename = f"20260916_123456_123456_{'a' * 200}.png"
    assert len(expected_filename.encode()) == 227
    upload_dir = tmp_path / "freezone" / "_uploads"
    upload_dir.mkdir(parents=True)
    target = upload_dir / expected_filename
    target.write_bytes(b"original")
    target.chmod(0o640)
    original_mode = stat.S_IMODE(target.stat().st_mode)

    result = await freezone.freezone_upload(
        project="demo",
        file=UploadFile(filename=original_name, file=BytesIO(b"payload")),
        user={"username": "admin"},
    )

    assert result == {
        "ok": True,
        "data": {
            "url": f"/media/freezone/_uploads/{expected_filename}",
            "filename": expected_filename,
            "size": 7,
        },
    }
    assert target.read_bytes() == b"payload"
    assert stat.S_IMODE(target.stat().st_mode) == original_mode
    assert list(upload_dir.iterdir()) == [target]


@pytest.mark.asyncio
async def test_cancelled_freezone_upload_finishes_cleanup_before_reraising(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_freezone_upload_context(tmp_path, monkeypatch)
    write_started = threading.Event()
    release_write = threading.Event()
    original_write_bytes = Path.write_bytes

    def held_write(path: Path, contents: bytes) -> int:
        write_started.set()
        assert release_write.wait(timeout=2)
        return original_write_bytes(path, contents)

    monkeypatch.setattr(Path, "write_bytes", held_write)
    task = asyncio.create_task(
        freezone._save_freezone_upload(
            "demo",
            UploadFile(filename="asset.bin", file=BytesIO(b"payload")),
            {"username": "admin"},
        )
    )
    try:
        assert await asyncio.to_thread(write_started.wait, 2)
        task.cancel("client-disconnected")
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release_write.set()

    with pytest.raises(asyncio.CancelledError) as exc_info:
        await task

    assert exc_info.value.args == ("client-disconnected",)
    upload_dir = tmp_path / "freezone" / "_uploads"
    assert (upload_dir / "asset.bin").read_bytes() == b"payload"
    assert list(upload_dir.iterdir()) == [upload_dir / "asset.bin"]
