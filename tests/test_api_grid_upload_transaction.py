import asyncio
import threading
from tempfile import SpooledTemporaryFile
from types import SimpleNamespace

import pytest
from starlette.datastructures import UploadFile

from novelvideo.api.routes import generation
from novelvideo.generators import pool_indexer


@pytest.fixture
def upload(monkeypatch, tmp_path):
    async def resolve(*args, **kwargs):
        assert kwargs["required_role"] == "editor"
        return SimpleNamespace(
            project_dir=tmp_path,
            ctx=SimpleNamespace(project_id="demo", output_dir=tmp_path),
        )

    monkeypatch.setattr(generation, "_resolve_generation_project", resolve)

    async def invoke(beats="1", content=b"new"):
        buffer = SpooledTemporaryFile(max_size=1024)
        buffer.write(content)
        buffer.seek(0)
        return await generation.upload_grid(
            "demo",
            1,
            1,
            UploadFile(buffer, filename="grid.png"),
            "render",
            "upload",
            beats,
            {"username": "admin"},
        )

    return invoke


async def test_upload_disk_operations_run_off_loop(upload, monkeypatch):
    loop_thread = threading.get_ident()
    original = pool_indexer._load_pool_index_unlocked

    def checked(*args, **kwargs):
        assert threading.get_ident() != loop_thread
        return original(*args, **kwargs)

    monkeypatch.setattr(pool_indexer, "_load_pool_index_unlocked", checked)
    assert (await upload())["ok"]


async def test_upload_failure_restores_existing_file(upload, tmp_path, monkeypatch):
    result = await upload(content=b"old")
    path = tmp_path / "grids/ep001" / result["data"]["grid_path"]
    original_index = pool_indexer.load_pool_index(path.parent.parent).model_dump()

    def fail(*args, **kwargs):
        raise OSError("index failure")

    monkeypatch.setattr(pool_indexer, "_save_pool_index_unlocked", fail)
    with pytest.raises(OSError, match="index failure"):
        await upload()
    assert path.read_bytes() == b"old"
    assert (
        pool_indexer.load_pool_index(path.parent.parent).model_dump() == original_index
    )


async def test_upload_concurrent_scopes_preserved(upload, tmp_path):
    await asyncio.gather(*(upload(str(n)) for n in range(1, 9)))
    pool = pool_indexer.load_pool_index(tmp_path / "grids/ep001")
    assert {tuple(grid.beat_nums) for grid in pool.grids} == {(n,) for n in range(1, 9)}


async def test_upload_cancellation_waits_for_commit(upload, tmp_path, monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    original = pool_indexer._save_pool_index_unlocked

    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    monkeypatch.setattr(pool_indexer, "_save_pool_index_unlocked", slow)
    task = asyncio.create_task(upload())
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
    pool = pool_indexer.load_pool_index(tmp_path / "grids/ep001")
    assert len(pool.grids) == 1
    assert (tmp_path / "grids/ep001" / pool.grids[0].grid_path).read_bytes() == b"new"


@pytest.mark.parametrize(
    "operation", ["write_bytes", "build_pool_index", "_save_pool_index_unlocked"]
)
async def test_upload_all_disk_operations_off_loop(upload, monkeypatch, operation):
    from pathlib import Path

    target = Path if operation == "write_bytes" else pool_indexer
    original = getattr(target, operation)
    loop_thread = threading.get_ident()
    calls = []

    def checked(*args, **kwargs):
        assert threading.get_ident() != loop_thread
        calls.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(target, operation, checked)
    assert (await upload())["ok"]
    assert calls


async def test_upload_first_save_failure_removes_file(upload, tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("index failure")

    monkeypatch.setattr(pool_indexer, "_save_pool_index_unlocked", fail)
    with pytest.raises(OSError, match="index failure"):
        await upload()
    grids_dir = tmp_path / "grids/ep001"
    assert list((grids_dir / "custom").iterdir()) == []
    assert pool_indexer.load_pool_index(grids_dir) is None


async def test_upload_staging_failure_keeps_previous_file(
    upload, tmp_path, monkeypatch
):
    from pathlib import Path

    result = await upload(content=b"old")
    path = tmp_path / "grids/ep001" / result["data"]["grid_path"]

    def fail(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_bytes", fail)
    with pytest.raises(OSError, match="disk full"):
        await upload()
    assert path.read_bytes() == b"old"
    assert list(path.parent.iterdir()) == [path]


async def test_upload_waiting_for_lock_can_cancel(upload, tmp_path):
    from novelvideo.api.upload_workers import asset_resource_lock

    lock = asset_resource_lock(("grid-upload", str(tmp_path / "grids/ep001")))
    async with lock:
        task = asyncio.create_task(upload())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert not (tmp_path / "grids").exists()


async def test_upload_waiting_for_capacity_can_cancel(upload, tmp_path):
    from novelvideo.api.upload_workers import asset_upload_limiter

    limiter = asset_upload_limiter()
    borrowers = [object() for _ in range(limiter.total_tokens)]
    for borrower in borrowers:
        limiter.acquire_on_behalf_of_nowait(borrower)
    try:
        task = asyncio.create_task(upload())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not (tmp_path / "grids").exists()
    finally:
        for borrower in borrowers:
            limiter.release_on_behalf_of(borrower)


async def test_upload_transaction_serializes_worker_threads(tmp_path, monkeypatch):
    import time

    original = pool_indexer._load_pool_index_for_update

    def slow(*args):
        result = original(*args)
        time.sleep(0.01)
        return result

    monkeypatch.setattr(pool_indexer, "_load_pool_index_for_update", slow)
    grids_dir = tmp_path / "grids/ep001"
    await asyncio.gather(
        *(
            asyncio.to_thread(
                pool_indexer.persist_uploaded_grid,
                grids_dir,
                1,
                n,
                "render",
                "upload",
                [n],
                f"{n}.png",
                str(n).encode(),
            )
            for n in range(1, 9)
        )
    )
    pool = pool_indexer.load_pool_index(grids_dir)
    assert {tuple(grid.beat_nums) for grid in pool.grids} == {(n,) for n in range(1, 9)}
    for grid in pool.grids:
        assert (grids_dir / grid.grid_path).read_bytes() == str(
            grid.beat_nums[0]
        ).encode()


async def test_committed_upload_survives_logging_failure(upload, tmp_path, monkeypatch):
    import builtins

    original = builtins.print

    def broken_log(*args, **kwargs):
        if args and str(args[0]).startswith("[PoolIndexer] 索引已保存:"):
            raise BrokenPipeError("closed stdout")
        return original(*args, **kwargs)

    monkeypatch.setattr(builtins, "print", broken_log)
    assert (await upload())["ok"]
    pool = pool_indexer.load_pool_index(tmp_path / "grids/ep001")
    assert (tmp_path / "grids/ep001" / pool.grids[0].grid_path).read_bytes() == b"new"


async def test_cell_upload_cannot_overwrite_grid_upload(upload, tmp_path, monkeypatch):
    from PIL import Image
    from pathlib import Path

    await upload("1")
    entered = threading.Event()
    release = threading.Event()
    staged = threading.Event()
    image = Image.new("RGB", (8, 8))
    original_save = image.save
    original_write = Path.write_bytes

    def slow_save(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original_save(*args, **kwargs)

    def track_write(path, data):
        result = original_write(path, data)
        if data == b"grid2":
            staged.set()
        return result

    monkeypatch.setattr(image, "save", slow_save)
    monkeypatch.setattr(Path, "write_bytes", track_write)
    cell_task = asyncio.create_task(
        asyncio.to_thread(
            generation._register_uploaded_pool_image,
            project_dir=tmp_path,
            episode_num=1,
            beat_num=3,
            image=image,
            image_type="render",
        )
    )
    grid_task = None
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        grid_task = asyncio.create_task(upload("2", b"grid2"))
        assert await asyncio.to_thread(staged.wait, 2)
        # With the full transaction lock the grid must wait for the cell upload.
        await asyncio.sleep(0.05)
        release.set()
        await asyncio.gather(cell_task, grid_task)
    finally:
        release.set()
        await asyncio.gather(
            cell_task, *([grid_task] if grid_task else []), return_exceptions=True
        )
    pool = pool_indexer.load_pool_index(tmp_path / "grids/ep001")
    assert {tuple(grid.beat_nums) for grid in pool.grids} == {(1,), (2,)}
    assert len(pool.images) == 1


@pytest.mark.parametrize("kind", ["render", "sketch"])
async def test_beat_upload_capacity_cancel_does_not_publish(upload, tmp_path, kind):
    from PIL import Image
    from novelvideo.api.upload_workers import asset_upload_limiter

    image_bytes = SpooledTemporaryFile(max_size=1024)
    Image.new("RGB", (8, 8)).save(image_bytes, format="PNG")
    image_bytes.seek(0)
    limiter = asset_upload_limiter()
    borrowers = [object() for _ in range(limiter.total_tokens)]
    for borrower in borrowers:
        limiter.acquire_on_behalf_of_nowait(borrower)
    try:
        route = getattr(generation, f"upload_beat_{kind}")
        task = asyncio.create_task(
            route(
                "demo",
                1,
                1,
                UploadFile(image_bytes, filename="cell.png"),
                {"username": "admin"},
            )
        )
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert list(tmp_path.iterdir()) == []
    finally:
        for borrower in borrowers:
            limiter.release_on_behalf_of(borrower)
