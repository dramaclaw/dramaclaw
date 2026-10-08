from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.ports.local.project import SQLiteProjectRegistry
from novelvideo.shared.project_dirs import project_directory_name


@pytest.fixture
def registry(monkeypatch, tmp_path):
    from novelvideo import config

    for kind in ("OUTPUT", "STATE", "RUNTIME"):
        monkeypatch.setattr(config, f"{kind}_DIR", str(tmp_path / kind.lower()))
    return SQLiteProjectRegistry()


async def create(registry, name, **kwargs):
    return await registry.create_project(
        owner_user_id="local", owner_username="local", name=name, **kwargs
    )


@pytest.mark.parametrize(
    ("name", "directory"),
    [
        ("万事屋", "wan_shi_wu"),
        ("万世屋", "wan_shi_wu"),
        ("中文项目_2026", "zhong_wen_xiang_mu_2026"),
        ("Drama中文", "Drama_zhong_wen"),
        ("project__01", "project__01"),
        ("CON", "project_CON"),
        ("nul", "project_nul"),
    ],
)
def test_directory_name_is_portable(name, directory):
    assert project_directory_name(name) == directory


async def test_homophones_and_ascii_aliases_have_independent_persistent_paths(registry):
    names = ["万事屋", "万世屋", "wan_shi_wu", "WAN_SHI_WU"]
    records = [await create(registry, name) for name in names]
    assert [record.name for record in records] == names
    assert [Path(record.output_dir).name for record in records] == [
        "wan_shi_wu", "wan_shi_wu_2", "wan_shi_wu_3", "WAN_SHI_WU_4"
    ]
    reopened = SQLiteProjectRegistry()
    for record in records:
        assert await reopened.get_project(record.id) == record
        assert await reopened.get_project_by_owner_name("local", record.name) == record
        assert Path(record.state_dir).name == Path(record.output_dir).name
        assert Path(record.runtime_dir).name == Path(record.output_dir).name
    assert len({record.id for record in records}) == 4
    assert len({record.state_dir.casefold() for record in records}) == 4


async def test_duplicate_display_name_is_rejected_without_creating_record(registry):
    first = await create(registry, "万事屋")
    with pytest.raises(ValueError, match="already exists"):
        await create(registry, "万事屋")
    assert await registry.list_accessible_projects([("user", "local")]) == [first]


@pytest.mark.parametrize("kind", ["output", "state", "runtime"])
async def test_unregistered_directory_is_not_reused(registry, tmp_path, kind):
    existing = tmp_path / kind / "local" / "wan_shi_wu"
    existing.mkdir(parents=True)
    marker = existing / "keep.txt"
    marker.write_text("existing data", encoding="utf-8")
    record = await create(registry, "万事屋")
    assert Path(record.output_dir).name == "wan_shi_wu_2"
    assert marker.read_text(encoding="utf-8") == "existing data"


@pytest.mark.parametrize("status", ["archived", "deleted"])
async def test_inactive_project_still_reserves_its_directory(registry, status):
    first = await create(registry, "万事屋")
    await registry.update_project_status(first.id, status)
    second = await create(registry, "万世屋")
    restored = await registry.update_project_status(first.id, "active")
    assert restored.output_dir == first.output_dir
    assert Path(second.output_dir).name == "wan_shi_wu_2"


async def test_truncated_names_do_not_share_a_directory(registry):
    first = await create(registry, "啊" * 63 + "哈")
    second = await create(registry, "啊" * 63 + "呵")
    assert first.output_dir != second.output_dir
    assert len(Path(first.output_dir).name) == 64
    assert len(Path(second.output_dir).name) == 64
    assert Path(second.output_dir).name.endswith("_2")


async def test_parallel_registries_allocate_distinct_paths(registry):
    await create(registry, "初始化")
    records = await asyncio.gather(
        *[create(SQLiteProjectRegistry(), name) for name in ("万事屋", "万世屋", "wan_shi_wu")]
    )
    assert {Path(record.output_dir).name for record in records} == {
        "wan_shi_wu", "wan_shi_wu_2", "wan_shi_wu_3"
    }


async def test_explicit_legacy_directories_are_preserved(registry, tmp_path):
    custom = {f"{kind}_dir": str(tmp_path / "legacy" / kind) for kind in ("output", "state", "runtime")}
    first = await create(registry, "旧项目", **custom)
    reopened = await SQLiteProjectRegistry().get_project(first.id)
    for field, path in custom.items():
        assert getattr(reopened, field) == path


async def test_partial_directory_override_preserves_only_explicit_path(registry, tmp_path):
    custom = str(tmp_path / "custom-output")
    record = await create(registry, "万事屋", output_dir=custom)
    assert record.output_dir == custom
    assert Path(record.state_dir).name == "wan_shi_wu"
    assert Path(record.runtime_dir).name == "wan_shi_wu"


async def test_custom_style_update_uses_the_registered_pinyin_directory(registry, monkeypatch):
    from novelvideo.api.routes import projects
    from novelvideo.api.schemas import ProjectUpdate
    from novelvideo.models import StyleConfig
    from novelvideo.services.style_service import StyleService

    record = await create(registry, "万事屋")
    ctx = SimpleNamespace(
        project_id=record.id, project_name=record.name, owner_username=record.owner_username,
        state_dir=Path(record.state_dir), output_dir=Path(record.output_dir),
    )
    assert StyleService.save_custom_style(
        "test_custom_style", StyleConfig(id="test_custom_style", name="Chinese project style"),
        username=ctx.owner_username, project=ctx.project_name, state_dir=ctx.state_dir,
    )
    assert "test_custom_style" in StyleService.get_style_labels(
        username=ctx.owner_username, project=ctx.project_name, state_dir=ctx.state_dir,
    )

    async def resolve_context(**_kwargs):
        return ctx

    monkeypatch.setattr(projects, "resolve_project_context", resolve_context)
    monkeypatch.setattr(projects, "require_project_home_node", lambda *_args, **_kwargs: None)
    result = await projects.update_project(
        record.id, ProjectUpdate(visual_style="test_custom_style"), user={"id": "local"},
    )
    assert result["ok"] is True
    assert result["data"]["visual_style"] == "test_custom_style"
    assert not (ctx.state_dir.parent / record.name).exists()
