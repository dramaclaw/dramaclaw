from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from novelvideo.api.schemas import LiblibProjectPreview, ProjectCreate
from novelvideo.ports.local.project import SQLiteProjectRegistry
from novelvideo.shared.project_dirs import project_directory_name


@pytest.fixture
def registry(monkeypatch, tmp_path):
    from novelvideo import config

    for kind in ("OUTPUT", "STATE", "RUNTIME"):
        monkeypatch.setattr(config, f"{kind}_DIR", str(tmp_path / kind.lower()))
    return SQLiteProjectRegistry()


async def create(registry, name):
    return await registry.create_project(owner_user_id="local", owner_username="local", name=name)


async def test_rename_preserves_id_paths_status_and_contents(registry):
    original = await create(registry, "legacy_project")
    for key in ("output_dir", "state_dir", "runtime_dir"):
        path = Path(getattr(original, key))
        path.mkdir(parents=True)
        (path / "keep.txt").write_text(key, encoding="utf-8")
    await registry.update_project_status(original.id, "archived")
    renamed = await registry.rename_project(original.id, "《弥寿计划》Ⅱ- 副本")
    assert renamed.id == original.id
    assert renamed.name == "《弥寿计划》Ⅱ- 副本"
    assert renamed.status == "archived"
    for key in ("output_dir", "state_dir", "runtime_dir"):
        assert getattr(renamed, key) == getattr(original, key)
        assert (Path(getattr(renamed, key)) / "keep.txt").read_text(encoding="utf-8") == key
    assert await registry.get_project_by_owner_name("local", original.name) is None
    assert await SQLiteProjectRegistry().get_project_by_owner_name("local", renamed.name) == renamed
    reused_name = await create(registry, "legacy_project")
    assert Path(reused_name.output_dir).name == "legacy_project_2"


async def test_duplicate_rename_rolls_back_and_same_name_succeeds(registry):
    first = await create(registry, "第一部")
    second = await create(registry, "第二部")
    with pytest.raises(ValueError, match="already exists"):
        await registry.rename_project(second.id, first.name)
    assert await registry.get_project(second.id) == second
    same = await registry.rename_project(first.id, first.name)
    assert same.name == first.name and same.output_dir == first.output_dir
    assert await registry.rename_project("missing", "名称") is None


async def test_rename_endpoint_requires_owner_and_returns_409(registry, monkeypatch):
    from novelvideo.api.routes import projects

    first = await create(registry, "旧名称")
    await create(registry, "已存在")
    roles = []
    audits = []

    async def resolve(**kwargs):
        roles.append(kwargs["required_role"])
        return SimpleNamespace(project_id=first.id, project_name=first.name)

    async def audit(**kwargs):
        audits.append(kwargs)

    monkeypatch.setattr(projects, "resolve_project_context", resolve)
    monkeypatch.setattr(projects, "get_project_registry", lambda: registry)
    monkeypatch.setattr(projects, "emit_project_audit", audit)
    with pytest.raises(HTTPException) as exc:
        await projects.rename_project(first.id, ProjectCreate(name="已存在"), user={})
    assert exc.value.status_code == 409
    result = await projects.rename_project(first.id, ProjectCreate(name="胡来万事屋- 副本"), user={})
    assert result["data"] == {"id": first.id, "name": "胡来万事屋- 副本"}
    assert roles == ["owner", "owner"]
    assert audits[0]["action"] == "project.rename"
    assert audits[0]["metadata"]["previous_name"] == "旧名称"


async def test_preview_returns_title_before_project_exists(monkeypatch):
    from novelvideo.api.routes import projects

    async def fetch(share):
        assert share.project_id == "a" * 32
        return {"projectMeta": {"name": "《弥寿计划》Ⅱ- 副本"}}

    monkeypatch.setattr(projects, "fetch_liblib_canvas_detail", fetch)
    url = "https://www.liblib.tv/canvas/share?spaceId=123&projectId=" + "a" * 32
    result = await projects.preview_liblib_project(LiblibProjectPreview(share_url=url), user={})
    assert result["data"] == {"name": "《弥寿计划》Ⅱ- 副本", "source_url": url}


async def test_preview_rejects_non_liblib_url_without_fetch(monkeypatch):
    from novelvideo.api.routes import projects

    async def fetch(_share):
        pytest.fail("Invalid URL must not be fetched")

    monkeypatch.setattr(projects, "fetch_liblib_canvas_detail", fetch)
    with pytest.raises(HTTPException) as exc:
        await projects.preview_liblib_project(LiblibProjectPreview(share_url="http://localhost:1"), user={})
    assert exc.value.status_code == 400


def test_directory_discards_title_punctuation_and_normalizes_roman_numerals():
    name = project_directory_name("《弥寿计划》Ⅱ- 副本")
    assert name.isascii()
    assert name == "mi_shou_ji_hua_II_fu_ben"
