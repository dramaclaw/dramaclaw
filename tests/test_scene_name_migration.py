import asyncio
import importlib
import json
import sqlite3
from pathlib import Path

import pytest

from novelvideo.cognee import scene_name_migration as migration_module
from novelvideo.cognee.scene_name_migration import migrate_scene_names

DIRTY = "凤鸣皇城·苏鸾寝殿 亥时"
CANONICAL = "凤鸣皇城·苏鸾寝殿"


def _create_db(project_dir: Path) -> None:
    conn = sqlite3.connect(project_dir / "data.db")
    conn.execute(
        """
        CREATE TABLE scenes (
            name TEXT PRIMARY KEY,
            aliases_json TEXT DEFAULT '[]',
            scene_type TEXT DEFAULT 'interior',
            environment_prompt TEXT DEFAULT '',
            description TEXT DEFAULT '',
            spatial_layout_image TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE beats (
            episode_number INTEGER NOT NULL,
            beat_number INTEGER NOT NULL,
            scene_ref_json TEXT DEFAULT '',
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (episode_number, beat_number)
        )
        """
    )
    conn.commit()
    conn.close()


def _insert_scene(
    project_dir: Path,
    name: str,
    *,
    aliases: list[str] | None = None,
    scene_type: str = "interior",
    environment_prompt: str = "",
    description: str = "",
    spatial_layout_image: str = "",
    notes: str = "",
) -> None:
    conn = sqlite3.connect(project_dir / "data.db")
    conn.execute(
        """
        INSERT INTO scenes (
            name, aliases_json, scene_type, environment_prompt, description,
            spatial_layout_image, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            name,
            json.dumps(aliases or [], ensure_ascii=False),
            scene_type,
            environment_prompt,
            description,
            spatial_layout_image,
            notes,
        ),
    )
    conn.commit()
    conn.close()


def _insert_beat(project_dir: Path, episode: int, beat: int, scene_ref: dict) -> None:
    conn = sqlite3.connect(project_dir / "data.db")
    conn.execute(
        "INSERT INTO beats (episode_number, beat_number, scene_ref_json) VALUES (?, ?, ?)",
        (episode, beat, json.dumps(scene_ref, ensure_ascii=False)),
    )
    conn.commit()
    conn.close()


def _fetch_scene(project_dir: Path, name: str) -> sqlite3.Row | None:
    conn = sqlite3.connect(project_dir / "data.db")
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM scenes WHERE name = ?", (name,)).fetchone()
    conn.close()
    return row


def _fetch_beat_ref(project_dir: Path, episode: int, beat: int) -> dict:
    conn = sqlite3.connect(project_dir / "data.db")
    value = conn.execute(
        "SELECT scene_ref_json FROM beats WHERE episode_number = ? AND beat_number = ?",
        (episode, beat),
    ).fetchone()[0]
    conn.close()
    return json.loads(value)


def test_dry_run_reports_changes_without_writing_db_backup_or_assets(tmp_path: Path):
    _create_db(tmp_path)
    _insert_scene(tmp_path, DIRTY, aliases=["寝殿夜"])
    _insert_scene(tmp_path, CANONICAL)
    _insert_beat(tmp_path, 1, 1, {"scene_id": DIRTY, "variant_id": "wide"})
    old_asset = tmp_path / "assets" / "scenes" / DIRTY / "layout.txt"
    old_asset.parent.mkdir(parents=True)
    old_asset.write_text("old layout", encoding="utf-8")

    report = asyncio.run(migrate_scene_names(tmp_path))

    assert report.dry_run is True
    assert report.backup_path is None
    assert report.scene_merges == [{"old": DIRTY, "canonical": CANONICAL}]
    assert report.beat_updates == [
        {"episode_number": 1, "beat_number": 1, "old": DIRTY, "canonical": CANONICAL}
    ]
    assert report.asset_copies == [
        {
            "source": str(old_asset),
            "destination": str(tmp_path / "assets" / "scenes" / CANONICAL / "layout.txt"),
        }
    ]
    assert _fetch_scene(tmp_path, DIRTY) is not None
    assert _fetch_beat_ref(tmp_path, 1, 1)["scene_id"] == DIRTY
    assert not (tmp_path / "assets" / "scenes" / CANONICAL).exists()
    assert list(tmp_path.glob("data.scene-name-migration-*.db")) == []


def test_apply_rename_updates_scene_alias_beat_and_copies_missing_assets(tmp_path: Path):
    _create_db(tmp_path)
    _insert_scene(
        tmp_path,
        DIRTY,
        aliases=["寝殿夜"],
        environment_prompt="old prompt",
        spatial_layout_image=f"assets/scenes/{DIRTY}/nested/layout.txt",
    )
    _insert_beat(tmp_path, 1, 2, {"scene_id": DIRTY, "base_id": DIRTY, "variant_id": "close"})
    old_asset = tmp_path / "assets" / "scenes" / DIRTY / "nested" / "layout.txt"
    old_asset.parent.mkdir(parents=True)
    old_asset.write_text("old layout", encoding="utf-8")

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert report.dry_run is False
    assert report.backup_path is not None
    assert Path(report.backup_path).exists()
    assert report.scene_renames == [{"old": DIRTY, "canonical": CANONICAL}]
    assert _fetch_scene(tmp_path, DIRTY) is None
    canonical = _fetch_scene(tmp_path, CANONICAL)
    assert canonical is not None
    assert json.loads(canonical["aliases_json"]) == ["寝殿夜", DIRTY]
    assert canonical["environment_prompt"] == "old prompt"
    assert canonical["spatial_layout_image"] == f"assets/scenes/{CANONICAL}/nested/layout.txt"
    assert _fetch_beat_ref(tmp_path, 1, 2) == {
        "scene_id": CANONICAL,
        "base_id": CANONICAL,
        "variant_id": "close",
    }
    assert old_asset.exists()
    assert (tmp_path / "assets" / "scenes" / CANONICAL / "nested" / "layout.txt").read_text(
        encoding="utf-8"
    ) == "old layout"
    assert report.copied_assets == [
        {
            "source": str(old_asset),
            "destination": str(
                tmp_path / "assets" / "scenes" / CANONICAL / "nested" / "layout.txt"
            ),
        }
    ]


def test_apply_rename_supports_separate_db_and_asset_project_dirs(tmp_path: Path):
    state_dir = tmp_path / "state"
    output_dir = tmp_path / "output"
    state_dir.mkdir()
    output_dir.mkdir()
    _create_db(state_dir)
    _insert_scene(state_dir, DIRTY, aliases=["寝殿夜"])
    _insert_beat(state_dir, 1, 2, {"scene_id": DIRTY})
    old_asset = output_dir / "assets" / "scenes" / DIRTY / "layout.txt"
    old_asset.parent.mkdir(parents=True)
    old_asset.write_text("old layout", encoding="utf-8")

    report = asyncio.run(
        migrate_scene_names(state_dir, asset_project_dir=output_dir, dry_run=False)
    )

    assert report.backup_path is not None
    assert _fetch_scene(state_dir, DIRTY) is None
    assert _fetch_scene(state_dir, CANONICAL) is not None
    assert _fetch_beat_ref(state_dir, 1, 2)["scene_id"] == CANONICAL
    assert old_asset.exists()
    assert (output_dir / "assets" / "scenes" / CANONICAL / "layout.txt").read_text(
        encoding="utf-8"
    ) == "old layout"


def test_apply_merge_deletes_old_scene_merges_aliases_fills_empty_fields_and_updates_beats(
    tmp_path: Path,
):
    _create_db(tmp_path)
    _insert_scene(
        tmp_path,
        CANONICAL,
        aliases=["正殿"],
        scene_type="interior",
        environment_prompt="canonical prompt",
        description="",
        spatial_layout_image="canonical-layout.png",
        notes="",
    )
    _insert_scene(
        tmp_path,
        DIRTY,
        aliases=["寝殿夜"],
        scene_type="exterior",
        environment_prompt="old prompt",
        description="old description",
        spatial_layout_image="old-layout.png",
        notes="old notes",
    )
    _insert_beat(tmp_path, 2, 1, {"scene_id": DIRTY, "base_id": DIRTY, "time_of_day": "亥时"})

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert report.scene_merges == [{"old": DIRTY, "canonical": CANONICAL}]
    assert _fetch_scene(tmp_path, DIRTY) is None
    canonical = _fetch_scene(tmp_path, CANONICAL)
    assert canonical is not None
    assert json.loads(canonical["aliases_json"]) == ["正殿", DIRTY, "寝殿夜"]
    assert canonical["environment_prompt"] == "canonical prompt"
    assert canonical["description"] == "old description"
    assert canonical["spatial_layout_image"] == "canonical-layout.png"
    assert canonical["notes"].startswith("old notes")
    assert "scene-name-migration conflict" in canonical["notes"]
    assert "environment_prompt" in canonical["notes"]
    assert "old prompt" in canonical["notes"]
    assert canonical["scene_type"] == "interior"
    assert _fetch_beat_ref(tmp_path, 2, 1) == {
        "scene_id": CANONICAL,
        "base_id": CANONICAL,
        "time_of_day": "亥时",
    }


def test_asset_copy_never_overwrites_existing_canonical_asset(tmp_path: Path):
    _create_db(tmp_path)
    _insert_scene(tmp_path, DIRTY)
    old_asset = tmp_path / "assets" / "scenes" / DIRTY / "layout.txt"
    old_asset.parent.mkdir(parents=True)
    old_asset.write_text("old layout", encoding="utf-8")
    canonical_asset = tmp_path / "assets" / "scenes" / CANONICAL / "layout.txt"
    canonical_asset.parent.mkdir(parents=True)
    canonical_asset.write_text("canonical layout", encoding="utf-8")

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert canonical_asset.read_text(encoding="utf-8") == "canonical layout"
    assert report.skipped_asset_copies == [
        {
            "source": str(old_asset),
            "destination": str(canonical_asset),
            "reason": "destination exists",
        }
    ]
    assert any("already exists" in warning for warning in report.warnings)


def test_asset_copy_conflict_between_dirty_sources_records_skipped_source(tmp_path: Path):
    dirty_late = "凤鸣皇城·苏鸾寝殿 子时"
    _create_db(tmp_path)
    _insert_scene(tmp_path, DIRTY)
    _insert_scene(tmp_path, dirty_late)
    first_asset = tmp_path / "assets" / "scenes" / DIRTY / "layout.txt"
    second_asset = tmp_path / "assets" / "scenes" / dirty_late / "layout.txt"
    first_asset.parent.mkdir(parents=True)
    second_asset.parent.mkdir(parents=True)
    first_asset.write_text("first layout", encoding="utf-8")
    second_asset.write_text("second layout", encoding="utf-8")
    canonical_asset = tmp_path / "assets" / "scenes" / CANONICAL / "layout.txt"

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert canonical_asset.read_text(encoding="utf-8") == "first layout"
    assert report.copied_assets == [
        {"source": str(first_asset), "destination": str(canonical_asset)}
    ]
    assert report.skipped_asset_copies == [
        {
            "source": str(second_asset),
            "destination": str(canonical_asset),
            "reason": "destination exists",
        }
    ]
    assert any(str(second_asset) in warning for warning in report.warnings)
    assert any(str(canonical_asset) in warning for warning in report.warnings)


def test_apply_merges_multiple_dirty_scenes_into_existing_canonical_without_losing_data(
    tmp_path: Path,
):
    dirty_late = "凤鸣皇城·苏鸾寝殿 子时"
    _create_db(tmp_path)
    _insert_scene(
        tmp_path,
        CANONICAL,
        aliases=["正殿"],
        scene_type="interior",
        environment_prompt="canonical prompt",
        description="",
        spatial_layout_image="canonical-layout.png",
        notes="",
    )
    _insert_scene(
        tmp_path,
        DIRTY,
        aliases=["亥时别名"],
        scene_type="exterior",
        environment_prompt="dirty prompt",
        description="dirty description",
        notes="",
    )
    _insert_scene(
        tmp_path,
        dirty_late,
        aliases=["子时别名"],
        scene_type="nature",
        environment_prompt="late prompt",
        description="late description",
        notes="late notes",
    )
    _insert_beat(tmp_path, 3, 1, {"scene_id": DIRTY})
    _insert_beat(tmp_path, 3, 2, {"scene_id": dirty_late, "base_id": dirty_late})

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert report.scene_renames == []
    assert {item["old"] for item in report.scene_merges} == {DIRTY, dirty_late}
    assert _fetch_scene(tmp_path, DIRTY) is None
    assert _fetch_scene(tmp_path, dirty_late) is None
    canonical = _fetch_scene(tmp_path, CANONICAL)
    assert canonical is not None
    aliases = json.loads(canonical["aliases_json"])
    assert aliases == ["正殿", DIRTY, "亥时别名", dirty_late, "子时别名"]
    assert canonical["environment_prompt"] == "canonical prompt"
    assert canonical["description"] == "dirty description"
    assert canonical["spatial_layout_image"] == "canonical-layout.png"
    assert canonical["notes"].startswith("late notes")
    assert "scene-name-migration conflict" in canonical["notes"]
    assert "late description" in canonical["notes"]
    assert canonical["scene_type"] == "interior"
    assert _fetch_beat_ref(tmp_path, 3, 1)["scene_id"] == CANONICAL
    assert _fetch_beat_ref(tmp_path, 3, 2) == {"scene_id": CANONICAL, "base_id": CANONICAL}


def test_multiple_dirty_merge_records_field_conflicts_and_preserves_notes(tmp_path: Path):
    dirty_late = "凤鸣皇城·苏鸾寝殿 子时"
    _create_db(tmp_path)
    _insert_scene(
        tmp_path,
        CANONICAL,
        environment_prompt="canonical prompt",
        description="canonical description",
        notes="canonical notes",
    )
    _insert_scene(
        tmp_path,
        DIRTY,
        environment_prompt="dirty prompt",
        description="dirty description",
        notes="dirty notes",
    )
    _insert_scene(
        tmp_path,
        dirty_late,
        environment_prompt="late prompt",
        description="late description",
        notes="late notes",
    )

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    conflict_keys = {
        (item["old"], item["field"], item["kept_value"], item["discarded_value"])
        for item in report.field_conflicts
    }
    assert (DIRTY, "description", "canonical description", "dirty description") in conflict_keys
    assert (dirty_late, "environment_prompt", "canonical prompt", "late prompt") in conflict_keys
    assert (dirty_late, "notes", "canonical notes", "late notes") in conflict_keys
    canonical = _fetch_scene(tmp_path, CANONICAL)
    assert canonical is not None
    assert canonical["description"] == "canonical description"
    assert canonical["environment_prompt"] == "canonical prompt"
    assert "canonical notes" in canonical["notes"]
    assert "scene-name-migration conflict" in canonical["notes"]
    assert DIRTY in canonical["notes"]
    assert "description" in canonical["notes"]
    assert "dirty description" in canonical["notes"]


def test_apply_multiple_dirty_scenes_to_new_canonical_renames_one_and_merges_rest(
    tmp_path: Path,
):
    dirty_late = "凤鸣皇城·苏鸾寝殿 子时"
    _create_db(tmp_path)
    _insert_scene(tmp_path, DIRTY, aliases=["亥时别名"], description="dirty description")
    _insert_scene(tmp_path, dirty_late, aliases=["子时别名"], notes="late notes")
    _insert_beat(tmp_path, 4, 1, {"scene_id": DIRTY})
    _insert_beat(tmp_path, 4, 2, {"scene_id": dirty_late, "base_id": dirty_late})

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert len(report.scene_renames) == 1
    assert report.scene_renames[0]["canonical"] == CANONICAL
    assert len(report.scene_merges) == 1
    assert report.scene_merges[0]["canonical"] == CANONICAL
    assert {report.scene_renames[0]["old"], report.scene_merges[0]["old"]} == {
        DIRTY,
        dirty_late,
    }
    assert _fetch_scene(tmp_path, DIRTY) is None
    assert _fetch_scene(tmp_path, dirty_late) is None
    canonical = _fetch_scene(tmp_path, CANONICAL)
    assert canonical is not None
    aliases = json.loads(canonical["aliases_json"])
    assert DIRTY in aliases
    assert dirty_late in aliases
    assert "亥时别名" in aliases
    assert "子时别名" in aliases
    assert canonical["description"] == "dirty description"
    assert canonical["notes"] == "late notes"
    assert _fetch_beat_ref(tmp_path, 4, 1)["scene_id"] == CANONICAL
    assert _fetch_beat_ref(tmp_path, 4, 2) == {"scene_id": CANONICAL, "base_id": CANONICAL}


def test_asset_copy_rejects_scene_names_that_escape_assets_scenes_root(tmp_path: Path):
    dirty = "../outside 亥时"
    canonical = "../outside"
    _create_db(tmp_path)
    _insert_scene(tmp_path, dirty)
    source = tmp_path / "assets" / "outside 亥时" / "layout.txt"
    source.parent.mkdir(parents=True)
    source.write_text("outside", encoding="utf-8")

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert report.backup_path is None
    assert report.scene_renames == []
    assert report.scene_merges == []
    assert report.beat_updates == []
    assert report.asset_copies == []
    assert any("unsafe scene name" in warning for warning in report.warnings)
    assert not (tmp_path / "assets" / "outside" / "layout.txt").exists()
    assert _fetch_scene(tmp_path, dirty) is not None
    assert _fetch_scene(tmp_path, canonical) is None


def test_apply_with_missing_schema_returns_warning_without_backup_or_writes(tmp_path: Path):
    conn = sqlite3.connect(tmp_path / "data.db")
    conn.execute("CREATE TABLE scenes (name TEXT PRIMARY KEY)")
    conn.execute("INSERT INTO scenes (name) VALUES (?)", (DIRTY,))
    conn.execute("CREATE TABLE beats (episode_number INTEGER, beat_number INTEGER)")
    conn.commit()
    conn.close()

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert report.backup_path is None
    assert any("schema" in warning for warning in report.warnings)
    assert list(tmp_path.glob("data.scene-name-migration-*.db")) == []
    conn = sqlite3.connect(tmp_path / "data.db")
    assert conn.execute("SELECT name FROM scenes").fetchall() == [(DIRTY,)]
    conn.close()


def test_symlink_asset_inside_root_but_outside_old_dir_warns_without_crashing(tmp_path: Path):
    _create_db(tmp_path)
    _insert_scene(tmp_path, DIRTY)
    old_dir = tmp_path / "assets" / "scenes" / DIRTY
    sibling_dir = tmp_path / "assets" / "scenes" / "shared"
    old_dir.mkdir(parents=True)
    sibling_dir.mkdir(parents=True)
    target = sibling_dir / "layout.txt"
    target.write_text("shared", encoding="utf-8")
    (old_dir / "linked.txt").symlink_to(target)

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=True))

    assert report.asset_copies == []
    assert any("outside source scene directory" in warning for warning in report.warnings)


def test_asset_copy_failure_records_failure_and_skips_backup_and_db_write(
    tmp_path: Path,
    monkeypatch,
):
    _create_db(tmp_path)
    _insert_scene(tmp_path, DIRTY)
    old_asset = tmp_path / "assets" / "scenes" / DIRTY / "layout.txt"
    old_asset.parent.mkdir(parents=True)
    old_asset.write_text("old layout", encoding="utf-8")

    def fail_copy(_source, _destination):
        raise OSError("simulated copy failure")

    monkeypatch.setattr(migration_module.shutil, "copy2", fail_copy)

    report = asyncio.run(migrate_scene_names(tmp_path, dry_run=False))

    assert report.backup_path is None
    assert report.copied_assets == []
    assert report.failed_asset_copies == [
        {
            "source": str(old_asset),
            "destination": str(tmp_path / "assets" / "scenes" / CANONICAL / "layout.txt"),
            "error": "simulated copy failure",
        }
    ]
    assert _fetch_scene(tmp_path, DIRTY) is not None
    assert _fetch_scene(tmp_path, CANONICAL) is None
    assert list(tmp_path.glob("data.scene-name-migration-*.db")) == []


def test_cli_scene_migration_report_keeps_failed_copy_count_and_detail(monkeypatch):
    from novelvideo import cli
    from novelvideo.cognee.scene_name_migration import SceneNameMigrationReport

    printed: list[str] = []
    report = SceneNameMigrationReport(
        dry_run=True,
        failed_asset_copies=[{"source": "old", "destination": "new", "error": "boom"}],
    )

    monkeypatch.setattr(cli.console, "print", lambda value: printed.append(str(value)))

    cli._print_scene_migration_report(report)

    payload = json.loads(printed[0])
    assert payload["failed_asset_copies"] == 1
    assert payload["failed_asset_copies_detail"] == [
        {"source": "old", "destination": "new", "error": "boom"}
    ]


@pytest.mark.asyncio
async def test_cli_project_id_scene_migration_ignores_legacy_project_json(
    tmp_path: Path,
    monkeypatch,
):
    output = tmp_path / "output"
    state = tmp_path / "state"
    runtime = tmp_path / "runtime"
    project_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    project_state = state / "alice" / "demo"
    project_state.mkdir(parents=True)
    (project_state / "project.json").write_text(
        json.dumps(
            {
                "id": project_id,
                "owner_type": "user",
                "owner_id": "local",
                "owner_username": "alice",
                "name": "demo",
                "home_node_id": "node_local",
                "output_dir": str(output / "alice" / "demo"),
                "state_dir": str(project_state),
                "runtime_dir": str(runtime / "alice" / "demo"),
                "status": "active",
                "created_at": "2026-06-12T00:00:00+00:00",
                "updated_at": "2026-06-12T00:00:00+00:00",
                "purged_at": None,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    import novelvideo.config as config
    import novelvideo.ports as ports
    import novelvideo.ports.registry as registry

    monkeypatch.setattr(config, "OUTPUT_DIR", str(output), raising=False)
    monkeypatch.setattr(config, "STATE_DIR", str(state), raising=False)
    monkeypatch.setattr(config, "RUNTIME_DIR", str(runtime), raising=False)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    importlib.reload(registry)
    importlib.reload(ports)

    from novelvideo import cli

    with pytest.raises(cli.typer.BadParameter, match=f"project-id not found: {project_id}"):
        await cli._resolve_scene_migration_dirs(
            project_id=project_id,
            user="",
            project="",
            state_dir="",
            output_dir="",
        )


@pytest.mark.asyncio
async def test_cli_project_id_scene_migration_uses_ee_entry_point(
    tmp_path: Path,
    monkeypatch,
):
    output = tmp_path / "output"
    state = tmp_path / "state"
    runtime = tmp_path / "runtime"
    project_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

    import novelvideo.ports as ports
    import novelvideo.ports.registry as registry
    from novelvideo.ports.project import ProjectRecord

    registry = importlib.reload(registry)
    importlib.reload(ports)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)

    class FakeProjectRegistry:
        async def get_project(self, requested_project_id: str):
            assert requested_project_id == project_id
            return ProjectRecord(
                id=project_id,
                owner_type="user",
                owner_id="u1",
                owner_username="alice",
                name="demo",
                home_node_id="node_ee",
                output_dir=str(output / "alice" / "demo"),
                state_dir=str(state / "alice" / "demo"),
                runtime_dir=str(runtime / "alice" / "demo"),
                status="active",
            )

    class EntryPoint:
        def load(self):
            def register():
                # A stand-in EE must satisfy whatever bootstrap demands today;
                # this list used to be hand-copied, and went stale the moment a
                # port was added. project_registry is re-registered afterwards
                # so the fake wins over the placeholder.
                for name in registry._EE_REQUIRED_PORTS:
                    registry.register_port(name, object())
                registry.register_port("project_registry", FakeProjectRegistry())

            return register

    monkeypatch.setattr(registry, "entry_points", lambda *, group: [EntryPoint()], raising=False)

    from novelvideo import cli

    try:
        db_dir, asset_dir, label = await cli._resolve_scene_migration_dirs(
            project_id=project_id,
            user="",
            project="",
            state_dir="",
            output_dir="",
        )
    finally:
        importlib.reload(registry)
        importlib.reload(ports)

    assert db_dir == state / "alice" / "demo"
    assert asset_dir == output / "alice" / "demo"
    assert label == f"alice/demo ({project_id})"
