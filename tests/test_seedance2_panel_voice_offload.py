from __future__ import annotations

import asyncio
import io
import json
import threading
from pathlib import Path

import pytest
from fastapi import UploadFile


class RecordingStore:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.thread_ids: list[int] = []

    async def update_beat_asset(self, **kwargs) -> None:
        self.thread_ids.append(threading.get_ident())
        self.calls.append(kwargs)


@pytest.mark.asyncio
async def test_seedance2_route_reads_in_memory_upload_in_asset_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.api.routes import generation
    from novelvideo.seedance2_i2v import character_voice_storage, panel_service

    loop_thread = threading.get_ident()
    read_threads: list[int] = []
    borrowed_tokens: list[tuple[int, int]] = []
    voice_limiter = character_voice_storage._voice_media_limiter()
    asset_limiter = panel_service._seedance2_asset_limiter()

    class RecordingBytesIO(io.BytesIO):
        def read(self, *args, **kwargs):
            read_threads.append(threading.get_ident())
            borrowed_tokens.append(
                (voice_limiter.borrowed_tokens, asset_limiter.borrowed_tokens)
            )
            return super().read(*args, **kwargs)

    store = RecordingStore()
    beat = {"beat_number": 2, "seedance2_config_json": "{}"}

    async def panel_context(**_kwargs):
        return {"store": store, "beat": beat, "output_dir": tmp_path}

    monkeypatch.setattr(generation, "_seedance2_panel_context", panel_context)
    monkeypatch.setattr(
        generation,
        "_seedance2_status_response",
        lambda **_kwargs: {"ok": True},
    )
    upload = UploadFile(
        filename="voice.wav",
        file=RecordingBytesIO(b"seedance-voice"),
        headers={"content-type": "audio/wav"},
    )

    response = await generation.upload_seedance2_asset(
        project="demo",
        episode_num=1,
        beat_num=2,
        file=upload,
        user={"username": "admin"},
    )

    assert response == {"ok": True}
    assert read_threads and loop_thread not in read_threads
    assert borrowed_tokens == [(0, 1)]
    targets = list((tmp_path / "seedance2_uploads").rglob("voice.wav"))
    assert len(targets) == 1 and targets[0].read_bytes() == b"seedance-voice"


@pytest.mark.asyncio
async def test_seedance2_upload_file_and_config_prepare_run_in_voice_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    loop_thread = threading.get_ident()
    worker_threads: list[int] = []
    helper_threads: list[int] = []
    real_prepare = panel_service._prepare_seedance2_uploaded_asset
    real_mkdir = Path.mkdir
    real_write = Path.write_bytes
    real_read = Path.read_bytes
    real_parse = panel_service.parse_seedance2_config
    real_dump = panel_service.dump_seedance2_config

    def tracking_prepare(**kwargs):
        worker_threads.append(threading.get_ident())
        return real_prepare(**kwargs)

    def tracking_mkdir(path, *args, **kwargs):
        if str(path).startswith(str(tmp_path)):
            helper_threads.append(threading.get_ident())
        return real_mkdir(path, *args, **kwargs)

    def tracking_write(path, content):
        if str(path).startswith(str(tmp_path)):
            helper_threads.append(threading.get_ident())
        return real_write(path, content)

    def tracking_parse(value):
        helper_threads.append(threading.get_ident())
        return real_parse(value)

    def tracking_dump(value):
        helper_threads.append(threading.get_ident())
        return real_dump(value)

    monkeypatch.setattr(
        panel_service, "_prepare_seedance2_uploaded_asset", tracking_prepare
    )
    monkeypatch.setattr(Path, "mkdir", tracking_mkdir)
    monkeypatch.setattr(Path, "write_bytes", tracking_write)
    monkeypatch.setattr(panel_service, "parse_seedance2_config", tracking_parse)
    monkeypatch.setattr(panel_service, "dump_seedance2_config", tracking_dump)
    store = RecordingStore()
    beat = {"beat_number": 2, "seedance2_config_json": "{}"}

    target = await panel_service.save_seedance2_uploaded_asset(
        store=store,
        episode=1,
        beat=beat,
        project_dir=tmp_path,
        filename="voice.wav",
        content=b"voice",
        content_type="audio/wav",
    )

    assert target is not None and real_read(target) == b"voice"
    assert worker_threads and loop_thread not in worker_threads
    assert helper_threads and set(helper_threads) == set(worker_threads)
    assert store.thread_ids == [loop_thread]
    assert store.calls[0]["seedance2_config_json"] == beat["seedance2_config_json"]


@pytest.mark.asyncio
async def test_seedance2_trim_read_publish_and_config_prepare_run_in_voice_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    source = tmp_path / "audio" / "source.wav"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []
    helper_threads: list[int] = []
    real_prepare = panel_service._prepare_trimmed_seedance2_audio
    real_exists = Path.exists
    real_is_file = Path.is_file
    real_read = Path.read_bytes
    real_mkdir = Path.mkdir
    real_write = Path.write_bytes
    real_parse = panel_service.parse_seedance2_config
    real_dump = panel_service.dump_seedance2_config

    def tracking_prepare(**kwargs):
        worker_threads.append(threading.get_ident())
        return real_prepare(**kwargs)

    def track_call(operation):
        def tracking(path, *args, **kwargs):
            if str(path).startswith(str(tmp_path)):
                helper_threads.append(threading.get_ident())
            return operation(path, *args, **kwargs)

        return tracking

    def tracking_parse(value):
        helper_threads.append(threading.get_ident())
        return real_parse(value)

    def tracking_dump(value):
        helper_threads.append(threading.get_ident())
        return real_dump(value)

    monkeypatch.setattr(
        panel_service, "_prepare_trimmed_seedance2_audio", tracking_prepare
    )
    monkeypatch.setattr(Path, "exists", track_call(real_exists))
    monkeypatch.setattr(Path, "is_file", track_call(real_is_file))
    monkeypatch.setattr(Path, "read_bytes", track_call(real_read))
    monkeypatch.setattr(Path, "mkdir", track_call(real_mkdir))
    monkeypatch.setattr(Path, "write_bytes", track_call(real_write))
    monkeypatch.setattr(panel_service, "parse_seedance2_config", tracking_parse)
    monkeypatch.setattr(panel_service, "dump_seedance2_config", tracking_dump)
    monkeypatch.setattr(
        panel_service,
        "trim_voice_sample_content",
        lambda content, **_kwargs: (content + b"-trimmed", "voice.mp3"),
    )
    store = RecordingStore()
    beat = {"beat_number": 3, "seedance2_config_json": "{}"}

    target = await panel_service.trim_seedance2_audio_to_reference(
        store=store,
        episode=1,
        beat=beat,
        project_dir=tmp_path,
        asset_key="reference:audio",
        source_path=source,
    )

    assert target is not None and real_read(target) == b"source-trimmed"
    assert worker_threads and loop_thread not in worker_threads
    assert helper_threads and set(helper_threads) == set(worker_threads)
    assert store.thread_ids == [loop_thread]
    assert store.calls[0]["seedance2_config_json"] == beat["seedance2_config_json"]


@pytest.mark.asyncio
async def test_seedance2_upload_cancellation_finishes_file_and_metadata(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    metadata_started = asyncio.Event()
    release_metadata = asyncio.Event()

    class BlockingStore(RecordingStore):
        async def update_beat_asset(self, **kwargs) -> None:
            metadata_started.set()
            await release_metadata.wait()
            await super().update_beat_asset(**kwargs)

    store = BlockingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}
    task = asyncio.create_task(
        panel_service.save_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            filename="voice.wav",
            content=b"voice",
            content_type="audio/wav",
        )
    )
    await asyncio.wait_for(metadata_started.wait(), 1)
    task.cancel()
    task.cancel()
    release_metadata.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    targets = list((tmp_path / "seedance2_uploads").rglob("voice.wav"))
    assert len(targets) == 1 and targets[0].read_bytes() == b"voice"
    assert store.calls
    assert beat["seedance2_config_json"] == store.calls[0]["seedance2_config_json"]


@pytest.mark.asyncio
async def test_seedance2_upload_preserves_anyio_cancel_marker_through_finalize(
    tmp_path: Path,
) -> None:
    import anyio

    from novelvideo.seedance2_i2v import panel_service

    metadata_started = asyncio.Event()
    release_metadata = threading.Event()

    class BlockingStore(RecordingStore):
        async def update_beat_asset(self, **kwargs) -> None:
            metadata_started.set()
            await asyncio.to_thread(release_metadata.wait, 2)
            await super().update_beat_asset(**kwargs)

    store = BlockingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}

    async def release_after_finalize_starts() -> None:
        await metadata_started.wait()
        await asyncio.sleep(0.03)
        release_metadata.set()

    releaser = asyncio.create_task(release_after_finalize_starts())
    try:
        with anyio.move_on_after(0.01) as scope:
            await panel_service.save_seedance2_uploaded_asset(
                store=store,
                episode=1,
                beat=beat,
                project_dir=tmp_path,
                filename="voice.wav",
                content=b"voice",
                content_type="audio/wav",
            )
        assert scope.cancel_called
        assert store.calls
        assert beat["seedance2_config_json"] == store.calls[0]["seedance2_config_json"]
    finally:
        release_metadata.set()
        await releaser


@pytest.mark.asyncio
async def test_seedance2_same_name_uploads_are_serialized_without_lost_metadata(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    first_write_started = threading.Event()
    release_first_write = threading.Event()
    selected_names: list[str] = []
    real_next = panel_service._next_available_upload_path
    real_write = Path.write_bytes

    def tracking_next(upload_dir, filename):
        target = real_next(upload_dir, filename)
        selected_names.append(target.name)
        return target

    def controlled_write(path, content):
        if path.name == "voice.wav" and not first_write_started.is_set():
            first_write_started.set()
            release_first_write.wait(timeout=3)
        return real_write(path, content)

    monkeypatch.setattr(panel_service, "_next_available_upload_path", tracking_next)
    monkeypatch.setattr(Path, "write_bytes", controlled_write)
    store = RecordingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}

    first = asyncio.create_task(
        panel_service.save_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            filename="voice.wav",
            content=b"first",
            content_type="audio/wav",
        )
    )
    assert await asyncio.to_thread(first_write_started.wait, 1)
    second = asyncio.create_task(
        panel_service.save_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            filename="voice.wav",
            content=b"second",
            content_type="audio/wav",
        )
    )
    await asyncio.sleep(0)
    assert selected_names == ["voice.wav"]
    release_first_write.set()
    first_target, second_target = await asyncio.gather(first, second)

    assert first_target is not None and first_target.read_bytes() == b"first"
    assert second_target is not None and second_target.read_bytes() == b"second"
    assert selected_names == ["voice.wav", "voice_1.wav"]
    paths = json.loads(beat["seedance2_config_json"])["reference_audio_paths"]
    assert paths == [str(first_target), str(second_target)]
    assert len(store.calls) == 2
    assert store.calls[-1]["seedance2_config_json"] == beat["seedance2_config_json"]


@pytest.mark.asyncio
async def test_seedance2_upload_then_delete_share_lock_without_resurrection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    write_started = threading.Event()
    release_write = threading.Event()
    real_write = Path.write_bytes

    def blocking_write(path, content):
        if path.name == "voice.wav":
            write_started.set()
            release_write.wait(timeout=3)
        return real_write(path, content)

    monkeypatch.setattr(Path, "write_bytes", blocking_write)
    store = RecordingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}
    target = tmp_path / "seedance2_uploads/ep001/beat_01/audios/voice.wav"
    upload = asyncio.create_task(
        panel_service.save_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            filename="voice.wav",
            content=b"voice",
            content_type="audio/wav",
        )
    )
    assert await asyncio.to_thread(write_started.wait, 1)
    delete = asyncio.create_task(
        panel_service.remove_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            media_kind="audios",
            path=str(target),
        )
    )
    await asyncio.sleep(0)
    assert not delete.done()
    release_write.set()

    _, removed = await asyncio.gather(upload, delete)
    assert removed is True
    assert not target.exists()
    paths = json.loads(beat["seedance2_config_json"])["reference_audio_paths"]
    assert str(target) not in paths


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["config", "template"])
async def test_seedance2_panel_mutations_wait_for_media_and_preserve_both_changes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mutation: str
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    write_started = threading.Event()
    release_write = threading.Event()
    mutation_parse_started = threading.Event()
    real_write = Path.write_bytes
    real_parse = panel_service.parse_seedance2_config

    def blocking_write(path, content):
        if path.name == "reference.png":
            write_started.set()
            release_write.wait(timeout=3)
        return real_write(path, content)

    def tracking_parse(value):
        if write_started.is_set() and not release_write.is_set():
            mutation_parse_started.set()
        return real_parse(value)

    monkeypatch.setattr(Path, "write_bytes", blocking_write)
    monkeypatch.setattr(panel_service, "parse_seedance2_config", tracking_parse)
    store = RecordingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}
    upload = asyncio.create_task(
        panel_service.save_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            filename="reference.png",
            content=b"image",
            content_type="image/png",
        )
    )
    assert await asyncio.to_thread(write_started.wait, 1)

    if mutation == "config":
        update = asyncio.create_task(
            panel_service.save_seedance2_video_panel_config(
                store=store,
                state_dir=tmp_path / "state",
                episode=1,
                beat=beat,
                project_dir=tmp_path,
                duration=8,
            )
        )
    else:
        update = asyncio.create_task(
            panel_service.append_seedance2_prompt_guidance_template(
                store=store,
                episode=1,
                beat=beat,
                project_dir=tmp_path,
                label="无字幕",
            )
        )
    await asyncio.sleep(0)
    assert not mutation_parse_started.is_set()
    assert not update.done()
    release_write.set()
    upload_target, _ = await asyncio.gather(upload, update)

    assert upload_target is not None
    config = json.loads(beat["seedance2_config_json"])
    assert config["reference_image_paths"] == [str(upload_target)]
    if mutation == "config":
        assert config["duration"] == 8
    else:
        assert "无字幕：" in config["prompt_guidance"]
    assert store.calls[-1]["seedance2_config_json"] == beat["seedance2_config_json"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["config", "template"])
async def test_cancelled_seedance2_panel_mutation_waiter_does_not_write(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mutation: str
) -> None:
    from novelvideo.seedance2_i2v import panel_service
    from novelvideo.seedance2_i2v.character_voice_storage import (
        seedance2_asset_resource_key,
        voice_resource_lock,
    )

    parse_started = threading.Event()
    real_parse = panel_service.parse_seedance2_config

    def tracking_parse(value):
        parse_started.set()
        return real_parse(value)

    monkeypatch.setattr(panel_service, "parse_seedance2_config", tracking_parse)
    store = RecordingStore()
    initial = json.dumps({"duration": 4})
    beat = {"beat_number": 1, "seedance2_config_json": initial}
    key = seedance2_asset_resource_key(
        project_dir=tmp_path, episode=1, beat_number=1
    )
    async with voice_resource_lock(key):
        if mutation == "config":
            task = asyncio.create_task(
                panel_service.save_seedance2_video_panel_config(
                    store=store,
                    state_dir=tmp_path / "state",
                    episode=1,
                    beat=beat,
                    project_dir=tmp_path,
                    duration=8,
                )
            )
        else:
            task = asyncio.create_task(
                panel_service.append_seedance2_prompt_guidance_template(
                    store=store,
                    episode=1,
                    beat=beat,
                    project_dir=tmp_path,
                    label="无字幕",
                )
            )
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert not parse_started.is_set()
    assert beat["seedance2_config_json"] == initial
    assert store.calls == []


@pytest.mark.asyncio
async def test_seedance2_panel_config_different_beats_do_not_share_resource_lock(
    tmp_path: Path,
) -> None:
    from novelvideo.seedance2_i2v import panel_service
    from novelvideo.seedance2_i2v.character_voice_storage import (
        seedance2_asset_resource_key,
        voice_resource_lock,
    )

    store = RecordingStore()
    beat = {"beat_number": 2, "seedance2_config_json": "{}"}
    held_key = seedance2_asset_resource_key(
        project_dir=tmp_path, episode=1, beat_number=1
    )
    async with voice_resource_lock(held_key):
        await asyncio.wait_for(
            panel_service.save_seedance2_video_panel_config(
                store=store,
                state_dir=tmp_path / "state",
                episode=1,
                beat=beat,
                project_dir=tmp_path,
                duration=8,
            ),
            timeout=1,
        )

    assert json.loads(beat["seedance2_config_json"])["duration"] == 8


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["config", "template"])
async def test_seedance2_panel_mutation_parse_and_dump_run_in_voice_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mutation: str
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    loop_thread = threading.get_ident()
    helper_threads: list[int] = []
    real_parse = panel_service.parse_seedance2_config
    real_dump = panel_service.dump_seedance2_config

    def tracking_parse(value):
        helper_threads.append(threading.get_ident())
        return real_parse(value)

    def tracking_dump(value):
        helper_threads.append(threading.get_ident())
        return real_dump(value)

    monkeypatch.setattr(panel_service, "parse_seedance2_config", tracking_parse)
    monkeypatch.setattr(panel_service, "dump_seedance2_config", tracking_dump)
    store = RecordingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}

    if mutation == "config":
        await panel_service.save_seedance2_video_panel_config(
            store=store,
            state_dir=tmp_path / "state",
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            duration=8,
        )
    else:
        await panel_service.append_seedance2_prompt_guidance_template(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            label="无字幕",
        )

    assert helper_threads
    assert loop_thread not in helper_threads


@pytest.mark.asyncio
async def test_seedance2_trim_then_delete_share_lock_without_resurrection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    source = tmp_path / "audio/source.wav"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    trim_started = threading.Event()
    release_trim = threading.Event()

    def blocking_trim(content, **_kwargs):
        trim_started.set()
        release_trim.wait(timeout=3)
        return content + b"-trimmed", "voice.mp3"

    monkeypatch.setattr(panel_service, "trim_voice_sample_content", blocking_trim)
    store = RecordingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}
    target = tmp_path / "seedance2_crops/ep001/beat_01/reference_audio_trimmed.mp3"
    trim = asyncio.create_task(
        panel_service.trim_seedance2_audio_to_reference(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            asset_key="reference:audio",
            source_path=source,
        )
    )
    assert await asyncio.to_thread(trim_started.wait, 1)
    delete = asyncio.create_task(
        panel_service.remove_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            media_kind="audios",
            path=str(target),
        )
    )
    await asyncio.sleep(0)
    assert not delete.done()
    release_trim.set()

    _, removed = await asyncio.gather(trim, delete)
    assert removed is True
    assert not target.exists()
    paths = json.loads(beat["seedance2_config_json"])["reference_audio_paths"]
    assert str(target) not in paths


@pytest.mark.asyncio
async def test_seedance2_crop_then_upload_share_lock_without_lost_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from PIL import Image

    from novelvideo.seedance2_i2v import panel_service

    source = tmp_path / "source.png"
    Image.new("RGB", (8, 8), "red").save(source)
    crop_started = threading.Event()
    release_crop = threading.Event()
    upload_worker_started = threading.Event()
    real_crop = panel_service._crop_image_to_path_sync
    real_prepare_upload = panel_service._prepare_seedance2_uploaded_asset

    def blocking_crop(*args, **kwargs):
        crop_started.set()
        release_crop.wait(timeout=3)
        return real_crop(*args, **kwargs)

    def tracking_upload(**kwargs):
        upload_worker_started.set()
        return real_prepare_upload(**kwargs)

    monkeypatch.setattr(panel_service, "_crop_image_to_path_sync", blocking_crop)
    monkeypatch.setattr(
        panel_service, "validate_seedance2_reference_image", lambda _path: ""
    )
    monkeypatch.setattr(
        panel_service, "_prepare_seedance2_uploaded_asset", tracking_upload
    )
    store = RecordingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}
    crop = asyncio.create_task(
        panel_service.crop_seedance2_asset_to_reference(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            asset_key="manual:crop",
            source_path=source,
            crop_data={"x": 0, "y": 0, "width": 4, "height": 4},
        )
    )
    assert await asyncio.to_thread(crop_started.wait, 1)
    upload = asyncio.create_task(
        panel_service.save_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            filename="upload.png",
            content=source.read_bytes(),
            content_type="image/png",
        )
    )
    await asyncio.sleep(0)
    assert not upload_worker_started.is_set()
    release_crop.set()
    crop_target, upload_target = await asyncio.gather(crop, upload)

    assert crop_target is not None and upload_target is not None
    paths = json.loads(beat["seedance2_config_json"])["reference_image_paths"]
    assert paths == [str(crop_target), str(upload_target)]
    assert len(store.calls) == 2


@pytest.mark.asyncio
async def test_seedance2_remove_double_cancel_finishes_file_and_metadata(
    tmp_path: Path,
) -> None:
    from novelvideo.seedance2_i2v import panel_service

    target = tmp_path / "seedance2_uploads/ep001/beat_01/audios/voice.wav"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"voice")
    initial = json.dumps({"reference_audio_paths": [str(target)]})
    beat = {"beat_number": 1, "seedance2_config_json": initial}
    metadata_started = asyncio.Event()
    release_metadata = asyncio.Event()

    class BlockingStore(RecordingStore):
        async def update_beat_asset(self, **kwargs) -> None:
            metadata_started.set()
            await release_metadata.wait()
            await super().update_beat_asset(**kwargs)

    store = BlockingStore()
    task = asyncio.create_task(
        panel_service.remove_seedance2_uploaded_asset(
            store=store,
            episode=1,
            beat=beat,
            project_dir=tmp_path,
            media_kind="audios",
            path=str(target),
        )
    )
    await asyncio.wait_for(metadata_started.wait(), 1)
    task.cancel()
    task.cancel()
    release_metadata.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert not target.exists()
    assert str(target) not in json.loads(beat["seedance2_config_json"])[
        "reference_audio_paths"
    ]
    assert store.calls[-1]["seedance2_config_json"] == beat["seedance2_config_json"]


@pytest.mark.asyncio
async def test_seedance2_crop_anyio_cancel_finishes_file_and_metadata(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import anyio
    from PIL import Image

    from novelvideo.seedance2_i2v import panel_service

    source = tmp_path / "source.png"
    Image.new("RGB", (8, 8), "red").save(source)
    monkeypatch.setattr(
        panel_service, "validate_seedance2_reference_image", lambda _path: ""
    )
    metadata_started = asyncio.Event()
    release_metadata = threading.Event()

    class BlockingStore(RecordingStore):
        async def update_beat_asset(self, **kwargs) -> None:
            metadata_started.set()
            await asyncio.to_thread(release_metadata.wait, 2)
            await super().update_beat_asset(**kwargs)

    store = BlockingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}

    async def release_after_metadata() -> None:
        await metadata_started.wait()
        await asyncio.sleep(0.03)
        release_metadata.set()

    releaser = asyncio.create_task(release_after_metadata())
    try:
        with anyio.move_on_after(0.01) as scope:
            await panel_service.crop_seedance2_asset_to_reference(
                store=store,
                episode=1,
                beat=beat,
                project_dir=tmp_path,
                asset_key="manual:crop",
                source_path=source,
                crop_data={"x": 0, "y": 0, "width": 4, "height": 4},
            )
        assert scope.cancel_called
        paths = json.loads(beat["seedance2_config_json"])["reference_image_paths"]
        assert len(paths) == 1 and Path(paths[0]).exists()
        assert store.calls[-1]["seedance2_config_json"] == beat["seedance2_config_json"]
    finally:
        release_metadata.set()
        await releaser


@pytest.mark.asyncio
async def test_cancelled_crop_lock_waiter_does_not_touch_source(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.seedance2_i2v import panel_service
    from novelvideo.seedance2_i2v.character_voice_storage import (
        seedance2_asset_resource_key,
        voice_resource_lock,
    )

    prepare_started = threading.Event()
    monkeypatch.setattr(
        panel_service,
        "_prepare_cropped_seedance2_asset",
        lambda **_kwargs: prepare_started.set(),
    )
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}
    key = seedance2_asset_resource_key(
        project_dir=tmp_path, episode=1, beat_number=1
    )
    async with voice_resource_lock(key):
        task = asyncio.create_task(
            panel_service.crop_seedance2_asset_to_reference(
                store=RecordingStore(),
                episode=1,
                beat=beat,
                project_dir=tmp_path,
                asset_key="manual:crop",
                source_path=tmp_path / "missing.png",
                crop_data={"x": 0, "y": 0, "width": 4, "height": 4},
            )
        )
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert not prepare_started.is_set()


@pytest.mark.asyncio
async def test_seedance2_crop_and_remove_blocking_helpers_run_in_voice_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from PIL import Image

    from novelvideo.seedance2_i2v import panel_service

    source = tmp_path / "source.png"
    Image.new("RGB", (8, 8), "red").save(source)
    loop_thread = threading.get_ident()
    crop_helper_threads: list[int] = []
    remove_helper_threads: list[int] = []
    real_open = Image.open
    real_parse = panel_service.parse_seedance2_config
    real_dump = panel_service.dump_seedance2_config
    real_unlink = panel_service._seedance2_unlink_user_reference_file

    def tracking_open(*args, **kwargs):
        crop_helper_threads.append(threading.get_ident())
        return real_open(*args, **kwargs)

    def tracking_parse(value):
        target = crop_helper_threads if not crop_helper_threads else remove_helper_threads
        target.append(threading.get_ident())
        return real_parse(value)

    def tracking_dump(value):
        target = crop_helper_threads if not remove_helper_threads else remove_helper_threads
        target.append(threading.get_ident())
        return real_dump(value)

    monkeypatch.setattr(Image, "open", tracking_open)
    monkeypatch.setattr(panel_service, "parse_seedance2_config", tracking_parse)
    monkeypatch.setattr(panel_service, "dump_seedance2_config", tracking_dump)
    monkeypatch.setattr(
        panel_service, "validate_seedance2_reference_image", lambda _path: ""
    )
    store = RecordingStore()
    beat = {"beat_number": 1, "seedance2_config_json": "{}"}
    crop_target = await panel_service.crop_seedance2_asset_to_reference(
        store=store,
        episode=1,
        beat=beat,
        project_dir=tmp_path,
        asset_key="manual:crop",
        source_path=source,
        crop_data={"x": 0, "y": 0, "width": 4, "height": 4},
    )
    assert crop_target is not None

    def tracking_unlink(path):
        remove_helper_threads.append(threading.get_ident())
        return real_unlink(path)

    monkeypatch.setattr(
        panel_service, "_seedance2_unlink_user_reference_file", tracking_unlink
    )
    removed = await panel_service.remove_seedance2_uploaded_asset(
        store=store,
        episode=1,
        beat=beat,
        project_dir=tmp_path,
        media_kind="images",
        path=str(crop_target),
    )

    assert removed
    assert crop_helper_threads and loop_thread not in crop_helper_threads
    assert remove_helper_threads and loop_thread not in remove_helper_threads
