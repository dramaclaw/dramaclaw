from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path


def _load_migration_module():
    script_path = Path(__file__).parents[1] / "scripts" / "migrate_docker_output.py"
    spec = importlib.util.spec_from_file_location("migrate_docker_output", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _create_registry(path: Path, *, legacy_root: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, output_dir TEXT NOT NULL)"
        )
        connection.executemany(
            "INSERT INTO projects(id, output_dir) VALUES (?, ?)",
            [
                ("legacy", f"{legacy_root.as_posix()}/local/demo"),
                ("persistent", "/data/output/local/other"),
            ],
        )
        connection.commit()
    finally:
        connection.close()


def test_migrate_docker_output_copies_without_overwrite_and_rebases_registry(
    tmp_path: Path,
) -> None:
    module = _load_migration_module()
    legacy_root = tmp_path / "app-output"
    target_root = tmp_path / "data-output"
    registry_db = tmp_path / "projects.db"
    (legacy_root / "local" / "demo").mkdir(parents=True)
    (target_root / "local" / "demo").mkdir(parents=True)
    (legacy_root / "local" / "demo" / "missing.png").write_bytes(b"legacy")
    (legacy_root / "local" / "demo" / "existing.png").write_bytes(b"old")
    (target_root / "local" / "demo" / "existing.png").write_bytes(b"new")
    _create_registry(registry_db, legacy_root=legacy_root)

    result = module.migrate_docker_output(
        legacy_root=legacy_root,
        target_root=target_root,
        registry_db=registry_db,
    )

    assert result.copied_files == 1
    assert result.skipped_files == 1
    assert result.migrated_projects == 1
    assert result.backup_path is not None and result.backup_path.is_file()
    assert (target_root / "local" / "demo" / "missing.png").read_bytes() == b"legacy"
    assert (target_root / "local" / "demo" / "existing.png").read_bytes() == b"new"
    assert (legacy_root / "local" / "demo" / "missing.png").is_file()

    connection = sqlite3.connect(registry_db)
    try:
        rows = dict(connection.execute("SELECT id, output_dir FROM projects"))
    finally:
        connection.close()
    assert rows == {
        "legacy": f"{target_root.as_posix()}/local/demo",
        "persistent": "/data/output/local/other",
    }

    second_result = module.migrate_docker_output(
        legacy_root=legacy_root,
        target_root=target_root,
        registry_db=registry_db,
    )

    assert second_result.copied_files == 0
    assert second_result.skipped_files == 2
    assert second_result.migrated_projects == 0
    assert second_result.backup_path is None
    assert len(list(tmp_path.glob("projects.db.backup-*"))) == 1
