from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from novelvideo.api.schemas import IngestStart, ProjectUpdate

pytestmark = pytest.mark.m03


def test_project_update_accepts_spine_template_values():
    assert ProjectUpdate(spine_template="narrated").spine_template == "narrated"
    assert ProjectUpdate(spine_template="drama").spine_template == "drama"
    assert IngestStart(filename="novel.txt", spine_template="narrated").spine_template == "narrated"


def test_project_update_accepts_aspect_ratio_values():
    assert ProjectUpdate(aspect_ratio="2:3").aspect_ratio == "2:3"
    assert ProjectUpdate(aspect_ratio="16:9").aspect_ratio == "16:9"
    assert ProjectUpdate(aspect_ratio="9:16").aspect_ratio == "9:16"


def test_project_config_defaults_to_drama(tmp_path, monkeypatch):
    monkeypatch.setenv("NOVELVIDEO_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    import importlib

    import novelvideo.config as cfg
    import novelvideo.project_config as pc
    import novelvideo.services.style_service as style_service
    import novelvideo.utils.project_paths as pp

    importlib.reload(cfg)
    importlib.reload(pp)
    importlib.reload(pc)

    monkeypatch.setattr(
        style_service.StyleService,
        "get_style_labels",
        lambda username=None, project=None: {"chinese_period_drama": "古装"},
    )

    assert pc.load_project_config("alice", "demo")["spine_template"] == "drama"
    assert pc.load_project_config("alice", "demo")["aspect_ratio"] == "2:3"


class _EpisodeStore:
    def __init__(self, episodes):
        self._episodes = episodes
        self.closed = False

    def get_all_episodes(self):
        return self._episodes

    async def close(self):
        self.closed = True


def _ctx(tmp_path, *, username: str = "alice", project: str = "demo"):
    return SimpleNamespace(
        project_id="project_123",
        owner_username=username,
        project_name=project,
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
    )


def _ctx_resolver(tmp_path):
    async def resolve(**kwargs):
        return _ctx(tmp_path)

    return resolve


def _legacy_resolution(tmp_path, *, username: str = "alice", project: str = "demo"):
    return SimpleNamespace(
        ctx=None,
        username=username,
        project_name=project,
        project_dir=tmp_path,
        output_dir=str(tmp_path / "out"),
        state_dir=str(tmp_path / "state"),
        runtime_dir=str(tmp_path / "run"),
    )


def _project_scope_resolver(tmp_path):
    async def resolve(*args, **kwargs):
        return _legacy_resolution(tmp_path)

    return resolve


@pytest.mark.asyncio
async def test_update_project_saves_spine_template_before_import(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    saved: dict = {}

    monkeypatch.setattr(projects, "resolve_project_context", _ctx_resolver(tmp_path))
    monkeypatch.setattr(projects, "require_project_home_node", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        projects,
        "load_project_config_from_state_dir",
        lambda state_dir, **_kwargs: {"visual_style": "chinese_period_drama", **saved},
    )
    monkeypatch.setattr(
        projects,
        "save_project_config_in_state_dir",
        lambda state_dir, config=None, **kwargs: saved.update(config or {}),
    )

    async def make_empty_store(ctx):
        return _EpisodeStore([])

    monkeypatch.setattr(projects, "make_sqlite_store_for_context", make_empty_store)

    response = await projects.update_project(
        "demo",
        ProjectUpdate(spine_template="narrated"),
        {"username": "alice"},
    )

    assert response["ok"] is True
    assert saved["spine_template"] == "narrated"
    assert saved["aspect_ratio"] == "16:9"
    assert response["data"]["spine_template"] == "narrated"
    assert response["data"]["aspect_ratio"] == "16:9"


@pytest.mark.asyncio
async def test_update_project_keeps_explicit_aspect_ratio_when_spine_template_changes(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import projects

    saved = {"spine_template": "drama", "aspect_ratio": "9:16"}

    monkeypatch.setattr(projects, "resolve_project_context", _ctx_resolver(tmp_path))
    monkeypatch.setattr(projects, "require_project_home_node", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        projects,
        "load_project_config_from_state_dir",
        lambda state_dir, **_kwargs: {"visual_style": "chinese_period_drama", **saved},
    )
    monkeypatch.setattr(
        projects,
        "save_project_config_in_state_dir",
        lambda state_dir, config=None, **kwargs: saved.update(config or {}),
    )

    async def make_empty_store(ctx):
        return _EpisodeStore([])

    monkeypatch.setattr(projects, "make_sqlite_store_for_context", make_empty_store)

    response = await projects.update_project(
        "demo",
        ProjectUpdate(spine_template="narrated", aspect_ratio="9:16"),
        {"username": "alice"},
    )

    assert response["ok"] is True
    assert saved["spine_template"] == "narrated"
    assert saved["aspect_ratio"] == "9:16"


@pytest.mark.asyncio
async def test_update_project_accepts_frontend_portrait_aspect_ratio(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    saved = {"spine_template": "drama", "aspect_ratio": "9:16"}

    monkeypatch.setattr(projects, "resolve_project_context", _ctx_resolver(tmp_path))
    monkeypatch.setattr(projects, "require_project_home_node", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        projects,
        "load_project_config_from_state_dir",
        lambda state_dir, **_kwargs: {"visual_style": "chinese_period_drama", **saved},
    )
    monkeypatch.setattr(
        projects,
        "save_project_config_in_state_dir",
        lambda state_dir, config=None, **kwargs: saved.update(config or {}),
    )

    async def make_empty_store(ctx):
        return _EpisodeStore([])

    monkeypatch.setattr(projects, "make_sqlite_store_for_context", make_empty_store)

    response = await projects.update_project(
        "demo",
        ProjectUpdate(aspect_ratio="2:3"),
        {"username": "alice"},
    )

    assert response["ok"] is True
    assert saved["aspect_ratio"] == "2:3"
    assert response["data"]["aspect_ratio"] == "2:3"


@pytest.mark.asyncio
async def test_update_project_rejects_spine_template_change_after_import(
    monkeypatch, tmp_path
):
    from fastapi.responses import JSONResponse

    from novelvideo.api.routes import projects

    saved = {"spine_template": "drama"}

    monkeypatch.setattr(projects, "resolve_project_context", _ctx_resolver(tmp_path))
    monkeypatch.setattr(projects, "require_project_home_node", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        projects,
        "load_project_config_from_state_dir",
        lambda state_dir, **_kwargs: {"visual_style": "chinese_period_drama", **saved},
    )
    monkeypatch.setattr(
        projects,
        "save_project_config_in_state_dir",
        lambda state_dir, config=None, **kwargs: saved.update(config or {}),
    )

    # Imported means the source text is on disk, not that episodes exist.
    # Structured ingest writes novel.txt and records a chunk plan but creates
    # no episodes, so an episode check left the template switchable in between —
    # and the analysis run, which is keyed on the template, was silently
    # orphaned by the switch.
    monkeypatch.setattr(projects, "has_imported_novel", lambda _output_dir: True)

    response = await projects.update_project(
        "demo",
        ProjectUpdate(spine_template="narrated"),
        {"username": "alice"},
    )

    assert isinstance(response, JSONResponse)
    assert response.status_code == 400
    assert saved["spine_template"] == "drama"


@pytest.mark.asyncio
async def test_update_project_rejects_the_switch_before_any_episode_exists(
    monkeypatch, tmp_path
):
    """The window the old check left open.

    Structured ingest creates no episodes, so between import and episode
    planning the type could still be changed. Afterwards the character build
    finds no analysis run for the new template: it still runs, but with no chunk
    persistence, no resume, no final artifact and no evidence rows.
    """
    from fastapi.responses import JSONResponse

    from novelvideo.api.routes import projects

    saved = {"spine_template": "drama"}

    monkeypatch.setattr(projects, "resolve_project_context", _ctx_resolver(tmp_path))
    monkeypatch.setattr(projects, "require_project_home_node", lambda *a, **k: None)
    monkeypatch.setattr(
        projects,
        "load_project_config_from_state_dir",
        lambda state_dir, **_kwargs: {"visual_style": "chinese_period_drama", **saved},
    )
    monkeypatch.setattr(
        projects,
        "save_project_config_in_state_dir",
        lambda state_dir, config=None, **kwargs: saved.update(config or {}),
    )

    async def make_empty_store(ctx):
        return _EpisodeStore([])

    monkeypatch.setattr(projects, "make_sqlite_store_for_context", make_empty_store)
    monkeypatch.setattr(projects, "has_imported_novel", lambda _output_dir: True)

    response = await projects.update_project(
        "demo",
        ProjectUpdate(spine_template="narrated"),
        {"username": "alice"},
    )

    assert isinstance(response, JSONResponse)
    assert response.status_code == 400
    assert saved["spine_template"] == "drama"


@pytest.mark.asyncio
async def test_start_ingest_allows_spine_template_change_during_rebuild(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import ingest

    saved = {"spine_template": "drama"}
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "novel.txt").write_text("正文", encoding="utf-8")

    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))

    def save_in_state_dir(state_dir, config=None, **kwargs):
        assert state_dir == str(tmp_path / "state")
        saved.update(config or {})
        saved.update(kwargs)

    monkeypatch.setattr(
        ingest,
        "save_project_config_in_state_dir",
        save_in_state_dir,
    )

    response = await ingest.start_ingest(
        "demo",
        IngestStart(filename="novel.txt", rebuild=True, spine_template="narrated"),
        {"username": "alice"},
    )

    assert response["ok"] is False
    assert "project context" in response["error"]
    assert saved["spine_template"] == "narrated"
    assert saved["aspect_ratio"] == "16:9"


@pytest.mark.asyncio
async def test_start_ingest_rejects_spine_template_change_without_rebuild(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import ingest

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "novel.txt").write_text("正文", encoding="utf-8")

    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))

    response = await ingest.start_ingest(
        "demo",
        IngestStart(filename="novel.txt", rebuild=False, spine_template="narrated"),
        {"username": "alice"},
    )

    assert response["ok"] is False
    assert "重新导入" in response["error"]


@pytest.mark.asyncio
async def test_start_ingest_rejects_headerless_premium_drama_before_saving(
    monkeypatch, tmp_path, caplog
):
    from novelvideo.api.routes import ingest

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    source_canary = "PRIVATE-SCREENPLAY-CONTENT-CANARY"
    (uploads / "novel.txt").write_text(
        f"第一集\n孙悟空走进寝房，看见师父正在休息。{source_canary}",
        encoding="utf-8",
    )
    saved: dict = {}
    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))
    monkeypatch.setattr(
        ingest,
        "save_project_config_in_state_dir",
        lambda state_dir, config=None, **kwargs: saved.update(config or {}),
    )

    with caplog.at_level(logging.WARNING, logger="novelvideo.api.ingest"):
        response = await ingest.start_ingest(
            "demo",
            IngestStart(filename="novel.txt", rebuild=True, spine_template="drama"),
            {"username": "alice"},
        )

    assert response["ok"] is False
    assert response["error_type"] == "screenplay_format"
    assert response["format_check"]["scene_header_status"] == "missing"
    assert saved == {}
    assert "screenplay_format_blocked" in caplog.text
    assert "project=demo" in caplog.text
    assert "filename=novel.txt" in caplog.text
    assert "missing_scene_headers" in caplog.text
    assert "scene_header_status=missing" in caplog.text
    assert source_canary not in caplog.text


@pytest.mark.asyncio
async def test_start_ingest_rejects_prose_ending_in_outside_as_headerless_drama(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import ingest

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "novel.txt").write_text(
        "第一集\n孙悟空快步走到门外\n他发现师父已经离开。",
        encoding="utf-8",
    )
    saved: dict = {}
    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))
    monkeypatch.setattr(
        ingest,
        "save_project_config_in_state_dir",
        lambda state_dir, config=None, **kwargs: saved.update(config or {}),
    )

    response = await ingest.start_ingest(
        "demo",
        IngestStart(filename="novel.txt", rebuild=True, spine_template="drama"),
        {"username": "alice"},
    )

    assert response["ok"] is False
    assert response["error_type"] == "screenplay_format"
    assert response["format_check"]["scene_header_status"] == "missing"
    assert saved == {}


@pytest.mark.asyncio
async def test_start_ingest_accepts_standard_premium_drama(monkeypatch, tmp_path):
    from novelvideo.api.routes import ingest

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "script.txt").write_text(
        "第一集\n1-1 菩提寝房 夜 内\n孙悟空：师父。",
        encoding="utf-8",
    )
    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))

    response = await ingest.start_ingest(
        "demo",
        IngestStart(filename="script.txt", rebuild=True, spine_template="drama"),
        {"username": "alice"},
    )

    assert response["ok"] is False
    assert "project context" in response["error"]


@pytest.mark.asyncio
async def test_start_ingest_accepts_repairable_premium_drama(monkeypatch, tmp_path):
    from novelvideo.api.routes import ingest

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "script.txt").write_text(
        "\n".join(
            [
                "第一集",
                "场次：1",
                "地点：菩提寝房",
                "时间：夜",
                "内外景：内",
                "人物：孙悟空",
                "孙悟空：师父。",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))

    response = await ingest.start_ingest(
        "demo",
        IngestStart(filename="script.txt", rebuild=True, spine_template="drama"),
        {"username": "alice"},
    )

    assert response["ok"] is False
    assert "project context" in response["error"]


@pytest.mark.asyncio
async def test_project_config_reports_whether_a_scene_build_applies(
    monkeypatch, tmp_path
):
    """The UI asks one question; answer it here rather than on the client.

    Rebuilding the rule from spine_template plus the knowledge pipeline in the
    frontend would put it in two places and leak the track name into the API.
    """
    import json

    from novelvideo.api.routes import projects
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY,
        KNOWLEDGE_PIPELINE_STRUCTURED,
    )

    state_dir = tmp_path / "alice" / "demo"
    state_dir.mkdir(parents=True)

    async def _read(config: dict) -> bool:
        (state_dir / "project_config.json").write_text(
            json.dumps(config, ensure_ascii=False), encoding="utf-8"
        )
        ctx = SimpleNamespace(
            project_id="project_123",
            owner_username="alice",
            project_name="demo",
            effective_role="owner",
            home_node_id="node",
            output_dir=tmp_path,
            state_dir=state_dir,
            runtime_dir=tmp_path / "runtime",
        )

        async def _resolve(**_kwargs):
            return ctx

        monkeypatch.setattr(projects, "resolve_project_context", _resolve)
        monkeypatch.setattr(projects, "require_project_home_node", lambda *a, **k: None)
        monkeypatch.setattr(
            projects,
            "load_project_config_from_state_dir",
            lambda _state_dir, **_kwargs: dict(config),
        )

        async def _registry_get(_project_id):
            return None

        monkeypatch.setattr(
            projects,
            "get_project_registry",
            lambda: SimpleNamespace(get_project=_registry_get),
        )
        response = await projects.get_project("demo", {"username": "alice"})
        return response["data"]["scene_build_supported"]

    structured = {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED}
    assert await _read({**structured, "spine_template": "drama"}) is True
    assert await _read({**structured, "spine_template": "narrated"}) is False
    # Legacy keeps its build whatever the template.
    assert await _read({"spine_template": "narrated"}) is True
