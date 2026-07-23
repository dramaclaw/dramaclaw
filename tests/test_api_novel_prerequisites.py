"""Novel-import prerequisites for project-level build tasks."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.schemas import EpisodePlanRequest
from novelvideo.novel_source import (
    NOVEL_IMPORT_REQUIRED_CODE,
    NOVEL_IMPORT_REQUIRED_MESSAGE,
    has_imported_novel,
    require_imported_novel,
)


class RejectEnqueueBackend:
    async def enqueue_project_task(self, *_args, **_kwargs):
        raise AssertionError("task must not be enqueued without an imported novel")


def test_imported_novel_requires_non_whitespace_content(tmp_path: Path):
    assert has_imported_novel(tmp_path) is False

    (tmp_path / "novel.txt").write_text("  \n\t", encoding="utf-8")
    assert has_imported_novel(tmp_path) is False
    with pytest.raises(ValueError, match=f"^{NOVEL_IMPORT_REQUIRED_MESSAGE}$"):
        require_imported_novel(tmp_path)

    (tmp_path / "novel.txt").write_text("小说正文", encoding="utf-8")
    assert has_imported_novel(tmp_path) is True
    assert require_imported_novel(tmp_path) == "小说正文"


@pytest.mark.asyncio
async def test_build_characters_rejects_missing_novel_before_enqueue(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    ctx = SimpleNamespace(project_id="project-1")

    async def resolve_scope(project, user, *, required_role="viewer"):
        return SimpleNamespace(ctx=ctx, project_dir=tmp_path, output_dir=str(tmp_path))

    monkeypatch.setattr(characters, "resolve_project_scope", resolve_scope)
    monkeypatch.setattr(characters, "get_task_backend", RejectEnqueueBackend)

    response = await characters.build_characters("project-1", user={"username": "alice"})

    assert response == {
        "ok": False,
        "code": NOVEL_IMPORT_REQUIRED_CODE,
        "error": NOVEL_IMPORT_REQUIRED_MESSAGE,
    }


@pytest.mark.asyncio
async def test_build_scenes_rejects_missing_novel_before_enqueue(tmp_path, monkeypatch):
    from novelvideo.api.routes import scenes

    ctx = SimpleNamespace(project_id="project-1")

    async def resolve_scene(project, user, *, required_role="editor"):
        return ctx, "alice", "demo", tmp_path, str(tmp_path), object()

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_scene)
    monkeypatch.setattr(scenes, "get_task_backend", RejectEnqueueBackend)

    response = await scenes.build_scenes("project-1", user={"username": "alice"})

    assert response == {
        "ok": False,
        "code": NOVEL_IMPORT_REQUIRED_CODE,
        "error": NOVEL_IMPORT_REQUIRED_MESSAGE,
    }


@pytest.mark.asyncio
async def test_plan_episodes_rejects_missing_novel_before_enqueue(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    ctx = SimpleNamespace(project_id="project-1")

    async def resolve_scope(project, user, *, required_role="viewer"):
        return SimpleNamespace(
            ctx=ctx,
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
        )

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_scope)
    monkeypatch.setattr(episodes, "get_task_backend", RejectEnqueueBackend)

    response = await episodes.plan_episodes(
        "project-1",
        EpisodePlanRequest(),
        user={"username": "alice"},
    )

    assert response == {
        "ok": False,
        "code": NOVEL_IMPORT_REQUIRED_CODE,
        "error": NOVEL_IMPORT_REQUIRED_MESSAGE,
    }
