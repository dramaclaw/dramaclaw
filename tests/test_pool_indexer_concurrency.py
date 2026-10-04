from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest
from PIL import Image


def test_save_grid_and_split_isolates_temporary_paths(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import grid_splitter, pool_indexer
    from novelvideo.models import PoolIndex

    prefixes: list[str] = []

    def fake_split_grid(**kwargs):
        prefixes.append(kwargs["prefix"])
        return []

    monkeypatch.setattr(grid_splitter, "split_grid", fake_split_grid)

    grids_dir = tmp_path / "grids" / "ep001"
    source = tmp_path / "grid.png"
    source.write_bytes(b"grid")
    kwargs = {
        "grid_image_path": source,
        "episode_grids_dir": grids_dir,
        "grid_type": "sketch",
        "mode_key": "1x1_16-9",
        "preset": "custom",
        "rows": 1,
        "cols": 1,
        "ts": "20260101010101",
        "pool": PoolIndex(episode=1),
    }

    pool_indexer.save_grid_and_split(beat_nums=[1], **kwargs)
    pool_indexer.save_grid_and_split(beat_nums=[2], **kwargs)

    assert len(set(prefixes)) == 2
    assert all(prefix.startswith("tmp_20260101010101_") for prefix in prefixes)


@pytest.mark.parametrize("initial_index", [False, True])
def test_concurrent_splits_keep_both_beats_in_pool(
    monkeypatch, tmp_path: Path, initial_index: bool
) -> None:
    from novelvideo.generators import grid_splitter, pool_indexer
    from novelvideo.models import PoolIndex

    grids_dir = tmp_path / "grids" / "ep001"
    grids_dir.mkdir(parents=True)
    if initial_index:
        pool_indexer.save_pool_index(PoolIndex(episode=1), grids_dir)

    sources = []
    for beat_num, color in ((1, "red"), (2, "blue")):
        source = tmp_path / f"source_{beat_num}.png"
        Image.new("RGB", (32, 32), color).save(source)
        sources.append((beat_num, source))

    split_barrier = Barrier(2)
    real_split_grid = grid_splitter.split_grid

    def synchronized_split(**kwargs):
        paths = real_split_grid(**kwargs)
        split_barrier.wait(timeout=10)
        return paths

    monkeypatch.setattr(grid_splitter, "split_grid", synchronized_split)

    def save(item):
        beat_num, source = item
        return pool_indexer.save_grid_and_split(
            grid_image_path=source,
            episode_grids_dir=grids_dir,
            grid_type="sketch",
            mode_key="1x1_16-9",
            beat_nums=[beat_num],
            preset="custom",
            rows=1,
            cols=1,
            ts="20260101010101",
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(save, sources))

    assert [result["added"] for result in results] == [1, 1]
    pool = pool_indexer.load_pool_index(grids_dir)
    assert pool is not None
    assert {image.original_beat for image in pool.images} == {1, 2}
    assert {tuple(grid.beat_nums) for grid in pool.grids} == {(1,), (2,)}
    for beat_num, color in ((1, "red"), (2, "blue")):
        cell = grids_dir / "sketch" / f"beat_{beat_num:02d}_t20260101010101.png"
        assert Image.open(cell).getpixel((0, 0)) == Image.new(
            "RGB", (1, 1), color
        ).getpixel((0, 0))
