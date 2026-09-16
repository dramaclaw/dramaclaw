from pathlib import Path
from types import SimpleNamespace


def test_save_grid_and_split_isolates_temporary_paths(monkeypatch, tmp_path: Path) -> None:
    from novelvideo.generators import grid_splitter, pool_indexer

    prefixes: list[str] = []

    def fake_split_grid(**kwargs):
        prefixes.append(kwargs["prefix"])
        return []

    monkeypatch.setattr(grid_splitter, "split_grid", fake_split_grid)
    monkeypatch.setattr(pool_indexer, "register_grid_entry", lambda **_kwargs: None)
    monkeypatch.setattr(pool_indexer, "save_pool_index", lambda *_args: None)

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
        "pool": SimpleNamespace(),
    }

    pool_indexer.save_grid_and_split(beat_nums=[1], **kwargs)
    pool_indexer.save_grid_and_split(beat_nums=[2], **kwargs)

    assert len(set(prefixes)) == 2
    assert all(prefix.startswith("tmp_20260101010101_") for prefix in prefixes)
