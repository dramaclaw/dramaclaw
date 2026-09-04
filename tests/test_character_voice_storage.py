"""Tests for novelvideo.seedance2_i2v.character_voice_storage."""

from __future__ import annotations

import asyncio
import gc
import threading
import weakref
from pathlib import Path

import pytest

from novelvideo.seedance2_i2v.character_voice_storage import (
    AGE_GROUP_SLOTS,
    DEFAULT_SLOT,
    character_voice_path,
    clear_character_voice_file,
    is_supported_voice_sample,
    persist_character_voice_file,
)


def test_character_voice_path_routes_default_and_age_groups(tmp_path):
    base = character_voice_path(
        project_dir=tmp_path,
        character_name="男主",
        slot=DEFAULT_SLOT,
        filename="sample.mp3",
    )
    assert base.name == "voice_default.mp3"
    assert "characters/男主/voices" in base.as_posix()

    elder = character_voice_path(
        project_dir=tmp_path,
        character_name="男主",
        slot="elder",
        filename="x.wav",
    )
    assert elder.name == "voice_elder.wav"
    assert elder.parent == base.parent


def test_character_voice_path_rejects_unknown_slot(tmp_path):
    with pytest.raises(ValueError):
        character_voice_path(
            project_dir=tmp_path,
            character_name="X",
            slot="teen",
            filename="x.wav",
        )


def test_persist_character_voice_writes_file_and_returns_metadata(tmp_path):
    rel, sha, ts = persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot=DEFAULT_SLOT,
        filename="upload.mp3",
        content=b"audio-bytes",
    )
    target = Path(tmp_path) / rel
    assert target.exists()
    assert target.read_bytes() == b"audio-bytes"
    assert len(sha) == 64
    assert ts


def test_persist_character_voice_archives_prior_file(tmp_path):
    persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="elder",
        filename="v1.mp3",
        content=b"v1",
    )
    rel2, _sha, _ts = persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="elder",
        filename="v2.wav",
        content=b"v2",
    )
    voices_dir = Path(tmp_path) / "assets" / "characters" / "男主" / "voices"
    current = Path(tmp_path) / rel2
    assert current.exists() and current.read_bytes() == b"v2"
    archived = [
        p
        for p in voices_dir.iterdir()
        if p.is_file() and p.name.startswith("voice_elder_") and p != current
    ]
    assert archived, "prior voice should be archived under a timestamped name"


def test_clear_character_voice_archives_existing(tmp_path):
    persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="youth",
        filename="v.mp3",
        content=b"v",
    )
    assert clear_character_voice_file(project_dir=tmp_path, character_name="男主", slot="youth")
    voices_dir = Path(tmp_path) / "assets" / "characters" / "男主" / "voices"
    assert not (voices_dir / "voice_youth.mp3").exists()
    assert any(p.name.startswith("voice_youth_") for p in voices_dir.iterdir())


def test_persist_rejects_unsupported_extension(tmp_path):
    with pytest.raises(ValueError):
        persist_character_voice_file(
            project_dir=tmp_path,
            character_name="X",
            slot=DEFAULT_SLOT,
            filename="bad.txt",
            content=b"x",
        )


def test_is_supported_voice_sample():
    assert is_supported_voice_sample("a.mp3")
    assert is_supported_voice_sample("a.WAV")
    assert not is_supported_voice_sample("a.txt")


def test_age_group_slots_cover_known_values():
    assert set(AGE_GROUP_SLOTS) == {"child", "youth", "middle", "elder"}


@pytest.mark.asyncio
async def test_voice_media_capacity_is_held_until_cancelled_worker_finishes():
    from novelvideo.seedance2_i2v import character_voice_storage

    release_workers = threading.Event()
    capacity_started = threading.Event()
    lock = threading.Lock()
    started_count = 0

    def blocking_operation() -> None:
        nonlocal started_count
        with lock:
            started_count += 1
            if started_count == character_voice_storage._VOICE_MEDIA_CONCURRENCY:
                capacity_started.set()
        release_workers.wait(timeout=5)

    tasks = [
        asyncio.create_task(
            character_voice_storage.run_voice_media_operation(blocking_operation)
        )
        for _ in range(character_voice_storage._VOICE_MEDIA_CONCURRENCY)
    ]
    third_task = None
    try:
        assert await asyncio.to_thread(capacity_started.wait, 1)
        for task in tasks:
            task.cancel()
        await asyncio.sleep(0)
        limiter = character_voice_storage._voice_media_limiter()
        assert limiter.borrowed_tokens == character_voice_storage._VOICE_MEDIA_CONCURRENCY

        third_task = asyncio.create_task(
            character_voice_storage.run_voice_media_operation(blocking_operation)
        )
        for _ in range(20):
            if limiter.statistics().tasks_waiting:
                break
            await asyncio.sleep(0)
        assert limiter.statistics().tasks_waiting == 1
        assert started_count == character_voice_storage._VOICE_MEDIA_CONCURRENCY
    finally:
        release_workers.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        if third_task is not None:
            await asyncio.gather(third_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_voice_media_operation_accepts_an_independent_worker_limiter():
    import anyio

    from novelvideo.seedance2_i2v import character_voice_storage

    release_workers = threading.Event()
    capacity_started = threading.Event()
    started = 0
    started_lock = threading.Lock()

    def blocking_operation() -> None:
        nonlocal started
        with started_lock:
            started += 1
            if started == character_voice_storage._VOICE_MEDIA_CONCURRENCY:
                capacity_started.set()
        release_workers.wait(timeout=5)

    blockers = [
        asyncio.create_task(
            character_voice_storage.run_voice_media_operation(blocking_operation)
        )
        for _ in range(character_voice_storage._VOICE_MEDIA_CONCURRENCY)
    ]
    try:
        assert await asyncio.to_thread(capacity_started.wait, 1)
        result = await asyncio.wait_for(
            character_voice_storage.run_voice_media_operation(
                lambda: "metadata",
                worker_limiter=anyio.CapacityLimiter(1),
            ),
            timeout=1,
        )
        assert result == "metadata"
    finally:
        release_workers.set()
        await asyncio.gather(*blockers, return_exceptions=True)


@pytest.mark.asyncio
async def test_voice_media_operation_preserves_anyio_cancel_scope_cancellation():
    import anyio

    from novelvideo.seedance2_i2v import character_voice_storage

    worker_started = threading.Event()
    release_worker = threading.Event()

    def blocking_operation() -> None:
        worker_started.set()
        release_worker.wait(timeout=5)

    async def release_after_cancel() -> None:
        assert await asyncio.to_thread(worker_started.wait, 1)
        await asyncio.sleep(0.05)
        release_worker.set()

    releaser = asyncio.create_task(release_after_cancel())
    try:
        with anyio.move_on_after(0.01) as scope:
            await character_voice_storage.run_voice_media_operation(blocking_operation)
        assert scope.cancel_called
    finally:
        release_worker.set()
        await releaser


@pytest.mark.asyncio
async def test_cancelled_voice_worker_preserves_cancellation_precedence():
    from novelvideo.seedance2_i2v import character_voice_storage

    started = threading.Event()
    release = threading.Event()

    def failing_worker() -> None:
        started.set()
        release.wait(timeout=3)
        raise RuntimeError("worker failed after cancellation")

    task = asyncio.create_task(
        character_voice_storage.run_voice_media_operation(failing_worker)
    )
    assert await asyncio.to_thread(started.wait, 1)
    task.cancel("cancel-worker")
    release.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task
    assert raised.value.args == ("cancel-worker",)


@pytest.mark.asyncio
async def test_cancelled_voice_finalizer_preserves_cancellation_precedence():
    from novelvideo.seedance2_i2v import character_voice_storage

    finalize_started = asyncio.Event()
    release_finalize = asyncio.Event()

    async def failing_finalize(_result):
        finalize_started.set()
        await release_finalize.wait()
        raise RuntimeError("finalize failed after cancellation")

    task = asyncio.create_task(
        character_voice_storage.run_voice_media_operation(
            lambda: "published",
            finalize=failing_finalize,
        )
    )
    await asyncio.wait_for(finalize_started.wait(), 1)
    task.cancel("cancel-finalize")
    release_finalize.set()

    with pytest.raises(asyncio.CancelledError) as raised:
        await task
    assert raised.value.args == ("cancel-finalize",)


@pytest.mark.asyncio
async def test_voice_resource_lock_registry_releases_unused_locks():
    from novelvideo.seedance2_i2v import character_voice_storage

    key = ("gc-test", object())
    lock = character_voice_storage.voice_resource_lock(key)
    lock_ref = weakref.ref(lock)
    registry = character_voice_storage._voice_resource_locks_var.get()
    assert registry[key] is lock

    del lock
    gc.collect()

    assert lock_ref() is None
    assert key not in registry


def test_voice_resource_lock_registry_is_isolated_between_async_runs():
    from novelvideo.seedance2_i2v import character_voice_storage

    async def registry_identity():
        lock = character_voice_storage.voice_resource_lock(("loop", "isolated"))
        assert lock is character_voice_storage.voice_resource_lock(("loop", "isolated"))
        return character_voice_storage._voice_resource_locks_var.get()

    first = asyncio.run(registry_identity())
    second = asyncio.run(registry_identity())

    assert first is not second


@pytest.mark.asyncio
async def test_cancelled_voice_resource_lock_waiter_never_starts_worker():
    from novelvideo.seedance2_i2v import character_voice_storage

    key = ("test-resource", "same")
    worker_started = threading.Event()
    lock = character_voice_storage.voice_resource_lock(key)

    async def waiting_update() -> None:
        async with character_voice_storage.voice_resource_lock(key):
            await character_voice_storage.run_voice_media_operation(worker_started.set)

    async with lock:
        task = asyncio.create_task(waiting_update())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert not worker_started.is_set()


@pytest.mark.asyncio
async def test_distinct_character_voice_resources_can_run_in_parallel(tmp_path):
    from novelvideo.seedance2_i2v import character_voice_storage

    both_started = threading.Event()
    release = threading.Event()
    guard = threading.Lock()
    started = 0

    def blocking_worker() -> None:
        nonlocal started
        with guard:
            started += 1
            if started == 2:
                both_started.set()
        release.wait(timeout=3)

    async def update(key: tuple[object, ...]) -> None:
        async with character_voice_storage.voice_resource_lock(key):
            await character_voice_storage.run_voice_media_operation(blocking_worker)

    keys = [
        character_voice_storage.character_voice_resource_key(
            project_dir=tmp_path, character_name="秦", slot="default"
        ),
        character_voice_storage.character_voice_resource_key(
            project_dir=tmp_path, character_name="楚", slot="youth"
        ),
    ]
    tasks = [
        asyncio.create_task(update(key))
        for key in keys
    ]
    try:
        assert await asyncio.to_thread(both_started.wait, 1)
    finally:
        release.set()
        await asyncio.gather(*tasks)


@pytest.mark.asyncio
async def test_character_voice_resource_key_normalizes_path_name_and_slot(tmp_path):
    from novelvideo.seedance2_i2v import character_voice_storage

    first = character_voice_storage.character_voice_resource_key(
        project_dir=tmp_path / ".",
        character_name=" 王:小明 ",
        slot=" YOUTH ",
    )
    second = character_voice_storage.character_voice_resource_key(
        project_dir=tmp_path.resolve(),
        character_name="王_小明",
        slot="youth",
    )

    assert first == second
    assert character_voice_storage.voice_resource_lock(
        first
    ) is character_voice_storage.voice_resource_lock(second)


def test_probe_voice_sample_duration_times_out_as_value_error(monkeypatch, tmp_path):
    """ffprobe 卡住必须限时并转成 ValueError。

    这个函数现在挂在同步请求路径上（freezone omni-gen 的音频时长兜底），入参是用户
    上传的文件。没有 timeout 的话一个畸形容器就能吊死 HTTP 请求并占死线程池 worker；
    漏出 TimeoutExpired 则会让只 catch ValueError 的调用方变成 500 而不是「测不出」。
    """
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v import character_voice_storage

    sample = tmp_path / "hang.wav"
    sample.write_bytes(b"RIFF----WAVEfmt ")

    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/ffprobe")

    seen: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        seen.update(kwargs)
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(ValueError, match="超时"):
        character_voice_storage.probe_voice_sample_duration_seconds(sample)
    assert seen["timeout"] == character_voice_storage.PROBE_DURATION_TIMEOUT_SECONDS


def test_trim_voice_sample_content_times_out_as_value_error(monkeypatch):
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v import character_voice_storage

    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    seen: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        seen.update(kwargs)
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(ValueError, match="裁剪超时"):
        character_voice_storage.trim_voice_sample_content(
            b"audio",
            filename="sample.wav",
        )
    assert seen["timeout"] == character_voice_storage.FFMPEG_TIMEOUT_SECONDS


def test_recording_transcode_times_out_as_value_error(monkeypatch):
    import base64
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v import character_voice_storage

    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    seen: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        seen.update(kwargs)
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)
    payload = base64.b64encode(b"webm-audio").decode("ascii")

    with pytest.raises(ValueError, match="转码超时"):
        character_voice_storage.decode_recorded_audio_data_url(
            f"data:audio/webm;base64,{payload}"
        )
    assert seen["timeout"] == character_voice_storage.FFMPEG_TIMEOUT_SECONDS


def test_trim_voice_sample_content_outputs_seedance2_ready_clip(tmp_path):
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v.character_voice_storage import (
        probe_voice_sample_duration_seconds,
        trim_voice_sample_content,
    )

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg/ffprobe required for audio trimming")

    source = tmp_path / "source.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=8",
            str(source),
        ],
        check=True,
    )

    content, filename = trim_voice_sample_content(
        source.read_bytes(),
        filename="source.wav",
        start_seconds=1.0,
        duration_seconds=4.0,
    )
    assert filename == "voice_trimmed.mp3"

    trimmed = tmp_path / filename
    trimmed.write_bytes(content)
    duration = probe_voice_sample_duration_seconds(trimmed)
    assert 3.8 <= duration <= 4.2


def test_trim_existing_character_voice_file_rewrites_slot_with_short_clip(tmp_path):
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v.character_voice_storage import (
        probe_voice_sample_duration_seconds,
        trim_existing_character_voice_file,
    )

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg/ffprobe required for audio trimming")

    source = tmp_path / "source.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=8",
            str(source),
        ],
        check=True,
    )

    persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="default",
        filename="source.wav",
        content=source.read_bytes(),
    )

    rel_path, sha, ts = trim_existing_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="default",
        source_path="assets/characters/男主/voices/voice_default.wav",
        start_seconds=2.0,
        duration_seconds=4.0,
    )

    assert rel_path == "assets/characters/男主/voices/voice_default.mp3"
    assert sha
    assert ts
    trimmed_path = tmp_path / rel_path
    assert trimmed_path.exists()
    assert 3.8 <= probe_voice_sample_duration_seconds(trimmed_path) <= 4.2
    archived = [
        path
        for path in trimmed_path.parent.iterdir()
        if path.name.startswith("voice_default_") and path.suffix == ".wav"
    ]
    assert archived


@pytest.mark.parametrize("state_dir", ["", Path("")])
def test_narrator_voice_resource_key_rejects_empty_state_dir(tmp_path, state_dir):
    from novelvideo.seedance2_i2v.character_voice_storage import (
        narrator_voice_resource_key,
    )

    with pytest.raises(ValueError, match="state_dir"):
        narrator_voice_resource_key(project_dir=tmp_path, state_dir=state_dir)
