from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.project_context import ProjectContext


class _StoreOpened(Exception):
    """Stop a runner immediately after it constructs the store under test."""


class _Manager:
    def update_progress_for_project(self, *args, **kwargs) -> None:
        pass


def _legacy_project_paths(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> tuple[Path, Path]:
    from novelvideo.utils import project_paths

    output_root = tmp_path / "legacy-output"
    state_root = tmp_path / "state"
    monkeypatch.setattr(project_paths, "OUTPUT_DIR", output_root)
    monkeypatch.setattr(project_paths, "STATE_DIR", state_root)
    monkeypatch.setattr(project_paths, "RUNTIME_DIR", tmp_path / "runtime")
    legacy_project_dir = output_root / "alice" / "demo"
    legacy_project_dir.mkdir(parents=True)
    (legacy_project_dir / "project_config.json").write_text(
        '{"spine_template":"narrated"}',
        encoding="utf-8",
    )
    return legacy_project_dir, state_root / "alice" / "demo"


def test_sqlite_store_explicit_personal_state_dir_migrates_legacy_config(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.sqlite_store import SQLiteStore

    output_dir, state_dir = _legacy_project_paths(monkeypatch, tmp_path)

    SQLiteStore(
        "alice/demo",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )

    assert (state_dir / "project_config.json").read_text(encoding="utf-8") == (
        '{"spine_template":"narrated"}'
    )


def test_cognee_store_explicit_personal_state_dir_migrates_legacy_config(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.cognee import CogneeStore
    from novelvideo.cognee import store as cognee_store_module

    output_dir, state_dir = _legacy_project_paths(monkeypatch, tmp_path)

    class FakeSQLiteStore:
        def __init__(self, *args, **kwargs) -> None:
            pass

    monkeypatch.setattr(cognee_store_module, "SQLiteStore", FakeSQLiteStore)

    CogneeStore(
        "alice/demo",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
    )

    assert (state_dir / "project_config.json").read_text(encoding="utf-8") == (
        '{"spine_template":"narrated"}'
    )


def test_explicit_state_dir_does_not_create_derived_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.cognee import CogneeStore
    from novelvideo.utils import project_paths

    state_root = tmp_path / "state"
    scoped_state_dir = state_root / "_scopes" / "scope_123" / "alice" / "demo"
    monkeypatch.setattr(project_paths, "STATE_DIR", state_root)
    monkeypatch.setattr(project_paths, "OUTPUT_DIR", tmp_path / "legacy-output")

    store = CogneeStore(
        "alice/demo",
        output_dir=str(tmp_path / "output" / "alice" / "demo"),
        state_dir=str(scoped_state_dir),
    )

    assert Path(store.state_dir) == scoped_state_dir
    assert not (state_root / "alice" / "demo").exists()


def test_style_preset_reads_custom_style_from_explicit_state_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo import project_config
    from novelvideo.config import get_style_preset

    state_dir = tmp_path / "state" / "_scopes" / "scope_123" / "alice" / "demo"
    state_dir.mkdir(parents=True)
    (state_dir / "project_config.json").write_text(
        json.dumps(
            {
                "custom_styles": {
                    "scope_style": {
                        "id": "scope_style",
                        "name": "Scope Style",
                        "style_instructions": "scope-owned lighting",
                        "avoid_instructions": "avoid flat lighting",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(project_config, "OUTPUT_DIR", tmp_path / "fallback-state")

    preset = get_style_preset(
        "scope_style",
        username="alice",
        project="demo",
        project_dir=str(tmp_path / "output"),
        state_dir=state_dir,
    )

    assert preset["style_instructions"] == "scope-owned lighting"


@pytest.mark.asyncio
async def test_scene_reference_passes_context_state_dir_to_style_lookup(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import novelvideo.cognee as cognee
    from novelvideo import config
    from novelvideo.task_backend.runners import scene_reference

    ctx = _scoped_ctx(tmp_path)
    captured: dict[str, object] = {}

    class StyleRead(Exception):
        pass

    class FakeSQLiteStore:
        async def get_scene(self, name: str):
            return SimpleNamespace(name=name, base_scene_id="")

    class FakeStore:
        def __init__(self, *args, **kwargs) -> None:
            self.sqlite_store = FakeSQLiteStore()

        async def initialize(self) -> None:
            pass

        async def close(self) -> None:
            pass

    def capture_style(*args, **kwargs):
        captured.update(kwargs)
        raise StyleRead

    monkeypatch.setattr(cognee, "CogneeStore", FakeStore)
    monkeypatch.setattr(config, "get_style_preset", capture_style)
    monkeypatch.setattr(scene_reference, "get_task_manager", lambda: _Manager())

    with pytest.raises(StyleRead):
        await scene_reference._run_scene_reference_asset(
            {
                "payload": {
                    "scene_name": "Rooftop",
                    "kind": "master",
                    "style": "scope_style",
                }
            },
            ctx,
        )

    assert captured["state_dir"] == str(ctx.state_dir)


def _scoped_ctx(tmp_path: Path) -> ProjectContext:
    owner_suffix = Path("_scopes") / "scope_123" / "alice" / "demo"
    return ProjectContext(
        project_id="project_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_123",
        owner_username="alice",
        requester_user_id="user_123",
        requester_username="alice",
        requester_principals=(("user", "user_123"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path / "output" / owner_suffix,
        state_dir=tmp_path / "state" / owner_suffix,
        runtime_dir=tmp_path / "runtime" / owner_suffix,
        is_home_node=True,
    )


async def _invoke_runner(name: str, ctx: ProjectContext) -> None:
    if name == "character_image":
        from novelvideo.task_backend.runners import character_image

        await character_image._run_character_image(
            {
                "task_type": "character_portrait",
                "payload": {"mode": "portrait", "character_name": "林小满"},
            },
            ctx,
        )
        return
    if name == "script":
        from novelvideo.task_backend.runners import script

        await script._run_script_writer_scoped({"episode": 1, "payload": {}}, ctx)
        return
    if name == "scene_reference":
        from novelvideo.task_backend.runners import scene_reference

        await scene_reference._run_scene_reference_asset(
            {"payload": {"scene_name": "学校天台", "kind": "master"}}, ctx
        )
        return
    if name == "prop_reference":
        from novelvideo.task_backend.runners import prop_reference

        await prop_reference._run_prop_reference_asset(
            {"payload": {"prop_name": "旧手机"}}, ctx
        )
        return
    if name == "sketch":
        from novelvideo.task_backend.runners import sketch

        await sketch._ensure_scene_refs_for_beats(
            ctx=ctx,
            output_dir=str(ctx.output_dir),
            beats=[{"beat_number": 1, "scene_id": "学校天台"}],
            episode=1,
            director_ref_mode="off",
            director_ref_beat_numbers=None,
            log=lambda _message: None,
            projection=None,
        )
        return
    raise AssertionError(f"unknown runner case: {name}")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runner_name",
    ["character_image", "script", "scene_reference", "prop_reference", "sketch"],
)
async def test_store_backed_runner_uses_context_state_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    runner_name: str,
) -> None:
    import novelvideo.cognee as cognee
    from novelvideo.task_backend.runners import (
        character_image,
        prop_reference,
        scene_reference,
        script,
    )

    ctx = _scoped_ctx(tmp_path)
    opened: list[tuple[tuple, dict]] = []

    def capture_store(*args, **kwargs):
        opened.append((args, kwargs))
        raise _StoreOpened

    manager = _Manager()
    for module in (character_image, prop_reference, scene_reference, script):
        monkeypatch.setattr(module, "get_task_manager", lambda: manager)
    monkeypatch.setattr(cognee, "CogneeStore", capture_store)

    with pytest.raises(_StoreOpened):
        await _invoke_runner(runner_name, ctx)

    assert len(opened) == 1
    args, kwargs = opened[0]
    assert args[0] == ctx.owner_project_label
    assert kwargs["state_dir"] == str(ctx.state_dir)


@pytest.mark.asyncio
async def test_character_image_reads_ethnicity_from_context_state_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import novelvideo.cognee as cognee
    from novelvideo import project_config
    from novelvideo.task_backend.runners import character_image

    ctx = _scoped_ctx(tmp_path)
    ctx.state_dir.mkdir(parents=True)
    (ctx.state_dir / "project_config.json").write_text(
        json.dumps({"ethnicity": "configured-ethnicity"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(project_config, "OUTPUT_DIR", tmp_path / "fallback-state")
    monkeypatch.setattr(character_image, "get_task_manager", lambda: _Manager())

    class FakeStore:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def initialize(self) -> None:
            pass

        async def load_graph_state(self) -> None:
            pass

        async def get_character_from_graph(self, name: str):
            return SimpleNamespace(name=name)

        async def close(self) -> None:
            pass

    captured: dict[str, str] = {}

    async def capture_portrait(**kwargs) -> Path:
        captured["ethnicity"] = kwargs["ethnicity"]
        return tmp_path / "portrait.png"

    monkeypatch.setattr(cognee, "CogneeStore", FakeStore)
    monkeypatch.setattr(character_image, "_generate_character_portrait", capture_portrait)

    await character_image._run_character_image(
        {
            "task_type": "character_portrait",
            "payload": {"mode": "portrait", "character_name": "Lin"},
        },
        ctx,
    )

    assert captured["ethnicity"] == "configured-ethnicity"
