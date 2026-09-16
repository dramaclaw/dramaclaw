"""Backup scope: deprecated project Cognee stores are left out of new backups."""

import shutil
import subprocess

import pytest

from novelvideo.backup.files_sync import LIVE_SYNC_FILTER, RCLONE_FILTER, build_sync_cmd
from novelvideo.backup.scope import is_deprecated_cognee_path

_TREE = (
    "u/p/data.db",
    "u/p/project_config.json",
    "u/p/graph-preview.json",
    "u/p/freezone/canvases/c1.json",
    "u/p/freezone/assets/a.txt",
    "u/p/cognee_system/databases/cognee_db",
    "u/p/cognee_system/lancedb/x.lance",
    "u/p/cognee_data/raw.txt",
    "u/p/nested/cognee_system/keep.txt",
    "u/p/cognee_systemx/keep.txt",
    "u/p/cognee/keep.txt",
    "u/p/databases/keep.txt",
    "_orgs/o/u/p/project_config.json",
    "_orgs/o/u/p/cognee_system/lancedb/x.lance",
    "_orgs/o/u/p/cognee_data/raw.txt",
)

needs_rclone = pytest.mark.skipif(shutil.which("rclone") is None, reason="rclone not installed")


def _make_tree(root):
    for rel in _TREE:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x", encoding="utf-8")


def _listed(root, filter_text, tmp_path):
    filter_file = tmp_path / "filter.txt"
    filter_file.write_text(filter_text, encoding="utf-8")
    out = subprocess.run(
        ["rclone", "lsf", "-R", "--files-only", "--filter-from", str(filter_file), str(root)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return set(out.split())


@pytest.mark.parametrize(
    ("rel", "expected"),
    [
        ("u/p/cognee_system/databases/cognee_db", True),
        ("u/p/cognee_data/raw.txt", True),
        ("_orgs/o/u/p/cognee_system/databases/cognee_db", True),
        ("_orgs/o/u/p/cognee_data/raw.txt", True),
        ("u/p/data.db", False),
        ("u/p/project_config.json", False),
        ("u/p/graph-preview.json", False),
        ("u/p/freezone/canvases/c1.json", False),
        ("u/p/nested/cognee_system/keep.txt", False),
        ("u/cognee_system/keep.txt", False),
        ("u/p/cognee_systemx/keep.txt", False),
        ("u/p/cognee/keep.txt", False),
        ("u/p/databases/keep.txt", False),
        ("_orgs/o/u/p/data.db", False),
    ],
)
def test_is_deprecated_cognee_path(rel, expected):
    assert is_deprecated_cognee_path(rel) is expected


@needs_rclone
def test_live_sync_filter_skips_project_cognee_stores_only(tmp_path):
    root = tmp_path / "state"
    _make_tree(root)

    assert _listed(root, LIVE_SYNC_FILTER, tmp_path) == {
        "u/p/project_config.json",
        "u/p/graph-preview.json",
        "u/p/freezone/assets/a.txt",
        "u/p/nested/cognee_system/keep.txt",
        "u/p/cognee_systemx/keep.txt",
        "u/p/cognee/keep.txt",
        "u/p/databases/keep.txt",
        "_orgs/o/u/p/project_config.json",
    }


@needs_rclone
def test_restore_filter_still_reaches_existing_cognee_backups(tmp_path):
    # Existing OSS copies are kept on purpose; restore must still be able to fetch them.
    root = tmp_path / "state"
    _make_tree(root)

    listed = _listed(root, RCLONE_FILTER, tmp_path)

    assert {"u/p/cognee_system/lancedb/x.lance", "_orgs/o/u/p/cognee_data/raw.txt"} <= listed


@needs_rclone
def test_sync_command_keeps_existing_copies_of_excluded_cognee_files(tmp_path):
    src = tmp_path / "state"
    _make_tree(src)
    dst = tmp_path / "mirror"
    kept = dst / "u/p/cognee_data/raw.txt"
    kept.parent.mkdir(parents=True)
    kept.write_text("old", encoding="utf-8")
    filter_file = tmp_path / "live.filter"
    filter_file.write_text(LIVE_SYNC_FILTER, encoding="utf-8")

    cmd = build_sync_cmd(
        src=str(src),
        dst=str(dst),
        history_dst=str(tmp_path / "history"),
        filter_file=filter_file,
    )
    subprocess.run(cmd, check=True, capture_output=True)

    assert kept.read_text(encoding="utf-8") == "old"
    assert (dst / "u/p/project_config.json").exists()
    assert not (dst / "u/p/cognee_system/lancedb/x.lance").exists()
