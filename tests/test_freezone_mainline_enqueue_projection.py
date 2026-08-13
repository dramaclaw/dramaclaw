"""The two mainline canvas skills project their inputs at enqueue time.

Both assertions matter equally: with a projector installed the payload gains a
``projection`` envelope, and with none installed the payload is byte-for-byte
what it is today.  The second one is the rollback, so it is not enough for it
to "look the same".
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest


class _FakeScene:
    def __init__(self, name: str) -> None:
        self.name = name

    def model_dump(self) -> dict[str, Any]:
        return {"name": self.name, "aliases": []}


class _FakeStore:
    async def list_scenes(self) -> list[_FakeScene]:
        return [_FakeScene("皇宫·大殿")]


class _RealProjector:
    """Stands in for the projector an EE deployment installs."""

    async def build(self, store, config, *, task_type):
        from novelvideo.task_backend.projection import build_projection

        return await build_projection(store, config, task_type=task_type)


@pytest.fixture
def enqueue_harness(monkeypatch: pytest.MonkeyPatch, tmp_path):
    from novelvideo.api.routes import freezone

    background = tmp_path / "bg.png"
    background.write_bytes(b"x")
    payloads: list[dict] = []

    async def fake_enqueue_project_task(ctx, **kwargs):
        payloads.append(kwargs["payload"])
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task-1"), backend="inline", queue="default"
        )

    async def fake_single_beat_config(**kwargs):
        return {"beats": [{"beat_number": 1}], "style": "chinese_period_drama"}

    async def fake_store_for_context(ctx):
        return _FakeStore()

    monkeypatch.setattr(
        freezone, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task)
    )
    monkeypatch.setattr(freezone, "_mainline_single_beat_config", fake_single_beat_config)
    monkeypatch.setattr(freezone, "make_sqlite_store_for_context", fake_store_for_context)
    monkeypatch.setattr(freezone, "_resolve_url_list", lambda project_dir, urls: [str(background)])
    monkeypatch.setattr(freezone, "_project_job_response", lambda **kwargs: {"ok": True})

    return SimpleNamespace(module=freezone, payloads=payloads, project_dir=tmp_path)


async def _enqueue_sketch(harness) -> dict:
    await harness.module._start_or_enqueue_mainline_sketch_from_context_job(
        ctx=SimpleNamespace(project_id="proj"),
        username="alice",
        project_name="demo",
        project_dir=harness.project_dir,
        episode=1,
        beat=1,
        beat_payload={"beat_number": 1},
        background_url="/x/bg.png",
    )
    return harness.payloads[-1]


async def _enqueue_frame(harness) -> dict:
    await harness.module._start_or_enqueue_mainline_frame_from_context_job(
        ctx=SimpleNamespace(project_id="proj"),
        username="alice",
        project_name="demo",
        project_dir=harness.project_dir,
        episode=1,
        beat=1,
        beat_payload={"beat_number": 1},
        sketch_url="/x/bg.png",
        reference_urls=[],
    )
    return harness.payloads[-1]


@pytest.mark.asyncio
async def test_sketch_from_context_payload_gains_the_projection_when_installed(
    enqueue_harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    from novelvideo.ports.registry import register_port

    register_port("task_projection", _RealProjector())

    payload = await _enqueue_sketch(enqueue_harness)

    projection = payload["projection"]
    assert projection["task_type"] == "mainline_sketch_from_context"
    assert projection["fields"]["scenes"] == [{"name": "皇宫·大殿", "aliases": []}]


@pytest.mark.asyncio
async def test_sketch_from_context_payload_is_unchanged_when_not_installed(
    enqueue_harness,
) -> None:
    from novelvideo.ports.registry import _PORTS

    _PORTS.pop("task_projection", None)

    payload = await _enqueue_sketch(enqueue_harness)

    assert "projection" not in payload
    assert set(payload) == {
        "job_id",
        "episode",
        "beat_num",
        "output_dir",
        "config",
        "canvas_id",
        "node_id",
        "billing",
        "task_family",
        "task_label",
        "display_name",
    }


@pytest.mark.asyncio
async def test_frame_from_context_projects_an_empty_field_set(
    enqueue_harness,
) -> None:
    """Zero dependencies is a claim worth carrying, not a reason to send nothing."""
    from novelvideo.ports.registry import register_port

    register_port("task_projection", _RealProjector())

    payload = await _enqueue_frame(enqueue_harness)

    assert payload["projection"]["task_type"] == "mainline_frame_from_context"
    assert payload["projection"]["fields"] == {}


@pytest.mark.asyncio
async def test_frame_from_context_payload_is_unchanged_when_not_installed(
    enqueue_harness,
) -> None:
    from novelvideo.ports.registry import _PORTS

    _PORTS.pop("task_projection", None)

    payload = await _enqueue_frame(enqueue_harness)

    assert "projection" not in payload
