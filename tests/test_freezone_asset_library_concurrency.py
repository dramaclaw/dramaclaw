"""资产库并发写回归：API 多 worker 进程同时登记素材时，一条都不能丢。

早先 add_video_character_library_item 是无锁的「读整份 JSON → 追加 → 整份写回」，
一次上传 4 张图，各 worker 读到同一份旧列表，后写的把先写的冲掉，库里只剩 1~2 张。
"""

import multiprocessing
from pathlib import Path

from novelvideo.freezone.video_node import (
    add_video_character_folder,
    add_video_character_library_item,
    load_video_character_folders,
    load_video_character_library,
)

WORKERS = 8


def _add_item(project_dir: str, index: int, barrier) -> None:
    barrier.wait(timeout=30)
    add_video_character_library_item(
        Path(project_dir), name=f"img{index}", image_urls=[f"/static/img{index}.png"]
    )


def _add_folder(project_dir: str, index: int, barrier) -> None:
    barrier.wait(timeout=30)
    add_video_character_folder(Path(project_dir), name=f"folder{index}")


def _run_concurrently(target, project_dir: Path) -> None:
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(WORKERS)
    processes = [
        context.Process(target=target, args=(str(project_dir), index, barrier))
        for index in range(WORKERS)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=60)
        assert not process.is_alive()
        assert process.exitcode == 0


def test_concurrent_library_item_adds_across_processes_keep_every_item(
    tmp_path: Path,
) -> None:
    _run_concurrently(_add_item, tmp_path)

    names = sorted(item["name"] for item in load_video_character_library(tmp_path))
    assert names == sorted(f"img{index}" for index in range(WORKERS))


def test_concurrent_folder_creates_across_processes_keep_every_folder(
    tmp_path: Path,
) -> None:
    _run_concurrently(_add_folder, tmp_path)

    names = sorted(folder["name"] for folder in load_video_character_folders(tmp_path))
    assert names == sorted(f"folder{index}" for index in range(WORKERS))


def test_library_save_leaves_no_temp_files(tmp_path: Path) -> None:
    add_video_character_library_item(tmp_path, name="a", image_urls=["/static/a.png"])
    add_video_character_folder(tmp_path, name="f")

    leftovers = [
        p.name for p in (tmp_path / "freezone").iterdir() if p.suffix == ".tmp"
    ]
    assert leftovers == []
