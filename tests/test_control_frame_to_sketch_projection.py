"""Control-frame conversion runs off the task payload, not off project data.

This is the task with the widest read set -- beats, sketch colours, characters,
the visual style and the image selection all came from a store and a config file
opened inside the worker. The test that matters is therefore the negative one:
all three project-data entry points are patched to raise, and the conversion
still completes.

The entry points are patched individually rather than by making a directory
unreachable, because task state lives in the same SQLite file as project data --
an unreachable directory would fail the run for a reason that has nothing to do
with projection.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


@pytest.fixture
def forbid_project_data(monkeypatch: pytest.MonkeyPatch):
    """Every way this task used to reach project data, wired to explode."""
    from novelvideo import project_config
    from novelvideo.cognee import CogneeStore
    from novelvideo.director_world import control_frame_to_sketch as module
    from novelvideo.sqlite_store import SQLiteStore

    calls: list[str] = []

    def refuse_sqlite(self, *args, **kwargs):
        calls.append("SQLiteStore.__init__")
        raise AssertionError("worker opened a project store")

    def refuse_cognee(self, *args, **kwargs):
        calls.append("CogneeStore.__init__")
        raise AssertionError("worker opened a project store")

    def refuse_config(*args, **kwargs):
        calls.append("load_project_config_file")
        raise AssertionError("worker read the project config file")

    monkeypatch.setattr(SQLiteStore, "__init__", refuse_sqlite)
    monkeypatch.setattr(CogneeStore, "__init__", refuse_cognee)
    monkeypatch.setattr(project_config, "load_project_config_file", refuse_config)
    monkeypatch.setattr(module, "load_project_config_file", refuse_config)
    monkeypatch.setattr(module, "SQLiteStore", refuse_sqlite)
    return calls


@pytest.fixture
def stub_generation(monkeypatch: pytest.MonkeyPatch):
    """Replace image generation only. Everything else runs for real."""
    from novelvideo.director_world import control_frame_to_sketch as module

    seen: dict[str, Any] = {}

    class _Generator:
        provider = "openai"

        def __init__(self, config=None):
            seen["generator_config"] = config

        async def generate_grid(self, **kwargs):
            seen.update(kwargs)
            Path(kwargs["output_path"]).write_bytes(b"x")
            return SimpleNamespace(success=True, error="", generation_time=0.1)

    monkeypatch.setattr(module, "NanoBananaGridGenerator", _Generator)
    monkeypatch.setattr(module, "get_sketch_generation_config", lambda **kw: dict(kw))
    return seen


def _projection(**overrides) -> Any:
    from novelvideo.task_backend.projection import ProjectProjection

    fields: dict[str, Any] = {
        "beats": [{"beat_number": 1, "visual_description": "殿前"}],
        "scene_menu": [{"name": "皇宫·大殿"}],
        "prop_menu": [{"name": "玉玺"}],
        "sketch_colors": {"1": "#ff0000"},
        "characters": [{"name": "阿离", "identities": []}],
        "visual_style": "ink_wash",
        "sketch_image_selection": "some-model",
    }
    fields.update(overrides)
    return ProjectProjection(
        task_type="mainline_director_control_sketch", projection_version=1, fields=fields
    )


def _control_frame(tmp_path: Path) -> Path:
    frame = tmp_path / "director_control_frames" / "ep001" / "beat_01" / "combined.png"
    frame.parent.mkdir(parents=True, exist_ok=True)
    frame.write_bytes(b"x")
    return frame


async def _convert(tmp_path: Path, projection, **overrides):
    from novelvideo.director_world.control_frame_to_sketch import convert_control_frame_to_sketch

    frame = _control_frame(tmp_path)
    kwargs: dict[str, Any] = dict(
        user="alice",
        project="demo",
        episode=1,
        beat=1,
        mode_key="1x1_2-3_sketch",
        output_dir=str(tmp_path),
        state_dir=str(tmp_path / "state"),
        control_frame_path=str(frame),
        promote=False,
        projection=projection,
    )
    kwargs.update(overrides)
    return await convert_control_frame_to_sketch(**kwargs)


@pytest.mark.asyncio
async def test_conversion_reads_no_project_data_when_projected(
    tmp_path, forbid_project_data, stub_generation
) -> None:
    result = await _convert(tmp_path, _projection())

    assert result["episode"] == 1
    assert forbid_project_data == []


@pytest.mark.asyncio
async def test_projected_values_are_the_ones_actually_used(
    tmp_path, forbid_project_data, stub_generation
) -> None:
    """Not reading the store is only half of it; the projected values have to be
    what the generation actually runs on."""
    await _convert(tmp_path, _projection())

    assert stub_generation["style"] == "ink_wash"
    assert stub_generation["sketch_colors"] == {"1": "#ff0000"}
    assert stub_generation["scene_menu"] == [{"name": "皇宫·大殿"}]
    assert stub_generation["prop_menu"] == [{"name": "玉玺"}]
    assert stub_generation["beats"][0]["beat_number"] == 1
    assert stub_generation["generator_config"]["selection_override"] == "some-model"


@pytest.mark.asyncio
async def test_character_portrait_paths_are_rebuilt_from_the_project_dir(
    tmp_path, forbid_project_data, stub_generation, monkeypatch
) -> None:
    """Files travel by path, not by payload: the projection carries no portrait
    path, and the worker derives it from the directory it already has."""
    from novelvideo.director_world import control_frame_to_sketch as module

    captured: list[Any] = []
    monkeypatch.setattr(
        module,
        "build_character_map_for_grid",
        lambda beats, characters, *a, **k: captured.append(characters) or {},
    )

    await _convert(tmp_path, _projection())

    assert captured[0][0]["portrait_path"] == str(
        tmp_path / "assets" / "characters" / "阿离" / "portrait.png"
    )


@pytest.mark.asyncio
async def test_missing_projected_field_raises(tmp_path, forbid_project_data, stub_generation):
    """Never a silent return to the store: a projection that promised a field
    and did not send it is an error."""
    from novelvideo.task_backend.projection import ProjectProjection

    thin = ProjectProjection(
        task_type="mainline_director_control_sketch",
        projection_version=1,
        fields={"beats": [{"beat_number": 1}]},
    )

    with pytest.raises(ValueError, match="sketch_colors"):
        await _convert(tmp_path, thin)


@pytest.mark.asyncio
async def test_enqueue_attaches_the_projection_for_the_control_sketch(monkeypatch, tmp_path):
    """The producer half: the payload gains the envelope when a projector is
    installed, and is untouched when none is."""
    from novelvideo.api.routes import freezone

    payloads: list[dict] = []

    async def fake_enqueue(ctx, **kwargs):
        payloads.append(kwargs["payload"])
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="t"), backend="inline", queue="default"
        )

    source = tmp_path / "combined.png"
    source.write_bytes(b"x")

    monkeypatch.setattr(
        freezone, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue)
    )
    monkeypatch.setattr(freezone, "_resolve_url_list", lambda project_dir, urls: [str(source)])
    monkeypatch.setattr(freezone, "_project_job_response", lambda **kwargs: {"ok": True})

    class _Projector:
        async def build(self, store, config, *, task_type):
            return {
                "task_type": task_type,
                "projection_version": 1,
                "fields": {"beats": [], "visual_style": "ink_wash"},
            }

    async def fake_store(ctx):
        return object()

    monkeypatch.setattr(freezone, "make_sqlite_store_for_context", fake_store)

    ctx = SimpleNamespace(
        project_id="p", state_dir=str(tmp_path), owner_username="alice", project_name="demo"
    )

    from novelvideo.ports.registry import _PORTS, register_port

    _PORTS.pop("task_projection", None)
    await freezone._start_or_enqueue_mainline_director_control_sketch_job(
        ctx=ctx,
        project_dir=tmp_path,
        episode=1,
        beat=1,
        director_combined_url="/x/combined.png",
        canvas_id=None,
        node_id=None,
    )
    assert "projection" not in payloads[-1]

    register_port("task_projection", _Projector())
    await freezone._start_or_enqueue_mainline_director_control_sketch_job(
        ctx=ctx,
        project_dir=tmp_path,
        episode=1,
        beat=1,
        director_combined_url="/x/combined.png",
        canvas_id=None,
        node_id=None,
    )
    assert payloads[-1]["projection"]["fields"]["visual_style"] == "ink_wash"
