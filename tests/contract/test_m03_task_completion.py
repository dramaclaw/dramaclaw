from __future__ import annotations

import asyncio
import importlib
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

pytestmark = pytest.mark.m03


def _reset_port_modules():
    import novelvideo.ports as ports
    import novelvideo.ports.local as local_ports
    import novelvideo.ports.registry as registry

    registry = importlib.reload(registry)
    ports = importlib.reload(ports)
    local_ports = importlib.reload(local_ports)
    return registry, ports, local_ports


def _patch_roots(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    output = tmp_path / "output"
    state = tmp_path / "state"
    runtime = tmp_path / "runtime"

    import novelvideo.api.deps as deps
    import novelvideo.config as config
    import novelvideo.project_config as project_config
    import novelvideo.project_context as project_context
    import novelvideo.utils.project_paths as project_paths

    for module in (config, deps, project_paths):
        monkeypatch.setattr(module, "OUTPUT_DIR", str(output), raising=False)
        monkeypatch.setattr(module, "STATE_DIR", str(state), raising=False)
        monkeypatch.setattr(module, "RUNTIME_DIR", str(runtime), raising=False)
    monkeypatch.setattr(project_config, "OUTPUT_DIR", str(state), raising=False)
    monkeypatch.setattr(project_config, "STATE_DIR", str(state), raising=False)
    monkeypatch.setattr(project_context, "resolve_worker_id", lambda: "local")


def _completion_context(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _reset_port_modules()
    _patch_roots(monkeypatch, tmp_path)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_LOCAL_USERNAME", "alice")

    from novelvideo.ports import registry
    from novelvideo.project_context import ProjectContext

    registry.ensure_bootstrap()

    output_dir = tmp_path / "output" / "alice" / "m03_completion"
    state_dir = tmp_path / "state" / "alice" / "m03_completion"
    runtime_dir = tmp_path / "runtime" / "alice" / "m03_completion"
    for path in (output_dir, state_dir, runtime_dir):
        path.mkdir(parents=True, exist_ok=True)
    (output_dir / "novel.txt").write_text("测试原文", encoding="utf-8")
    return ProjectContext(
        project_id="proj_m03_completion",
        project_name="m03_completion",
        owner_type="user",
        owner_id="local",
        owner_username="alice",
        requester_user_id="local",
        requester_username="alice",
        requester_principals=(("user", "local"),),
        effective_role="owner",
        home_node_id="local",
        output_dir=output_dir,
        state_dir=state_dir,
        runtime_dir=runtime_dir,
        is_home_node=True,
    )


@pytest.fixture()
def m03_completion_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    ctx = _completion_context(tmp_path, monkeypatch)

    from novelvideo.api import auth as api_auth
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import episodes, scripts, tasks
    from novelvideo.task_backend.runners import graph_build as _graph_build  # noqa: F401
    from novelvideo.task_backend.runners import script as _script  # noqa: F401
    from novelvideo.task_backend.registry import register_project_task_runner

    async def resolve_project_scope(project: str, user: dict, *, required_role: str = "viewer"):
        return ProjectResolution(
            ctx=ctx,
            username="alice",
            project_name=ctx.project_name,
            project_dir=ctx.output_dir,
            output_dir=str(ctx.output_dir),
            state_dir=str(ctx.state_dir),
            runtime_dir=str(ctx.runtime_dir),
        )

    async def resolve_project_context(user: dict, project_id: str, required_role: str = "viewer"):
        return ctx

    async def write_episode() -> int:
        from novelvideo.api.deps import make_sqlite_store_for_context
        from novelvideo.models import NovelEpisode

        store = await make_sqlite_store_for_context(ctx)
        try:
            await store.add_episode(
                NovelEpisode(
                    number=1,
                    title="第一集",
                    raw_content="第一章 启程\n秦王入宫。",
                    beat_source_text="第一章 启程\n秦王入宫。",
                    content_summary="确定性规划",
                    identity_ids=["秦_青年"],
                    key_events=["入宫"],
                    character_names=["秦"],
                )
            )
            return len(store.get_all_episodes())
        finally:
            await store.close()

    async def write_beats() -> int:
        from novelvideo.api.deps import make_sqlite_store_for_context
        from novelvideo.models import NovelVisualBeat

        store = await make_sqlite_store_for_context(ctx)
        try:
            await store.add_visual_beats(
                [
                    NovelVisualBeat(
                        episode_number=1,
                        beat_number=3,
                        shot_order=20,
                        narration="旁白三",
                        visual_description="画面三",
                    ),
                    NovelVisualBeat(
                        episode_number=1,
                        beat_number=1,
                        shot_order=10,
                        narration="旁白一",
                        visual_description="画面一",
                    ),
                    NovelVisualBeat(
                        episode_number=1,
                        beat_number=2,
                        shot_order=20,
                        narration="旁白二",
                        visual_description="画面二",
                    ),
                ]
            )
            return len(await store.get_beats_as_dicts(1))
        finally:
            await store.close()

    async def write_video_prompt() -> dict:
        from novelvideo.api.deps import make_sqlite_store_for_context

        store = await make_sqlite_store_for_context(ctx)
        try:
            await store.update_beat_asset(
                1,
                1,
                video_prompt="fixed video prompt",
                keyframe_prompt="fixed keyframe prompt",
            )
            return (await store.get_beats_as_dicts(1))[0]
        finally:
            await store.close()

    def fake_build_episodes(envelope, task_ctx):
        return {"episodes": asyncio.run(write_episode())}

    def fake_script_writer(envelope, task_ctx):
        return {"episode": 1, "beats": asyncio.run(write_beats()), "review_passed": True}

    def fake_beat_video_prompt(envelope, task_ctx):
        beat = asyncio.run(write_video_prompt())
        return {
            "episode": 1,
            "beat_num": 1,
            "field": "video_prompt",
            "prompt": beat["video_prompt"],
        }

    async def fake_seedance2_prompt_for_panel(**kwargs):
        from novelvideo.seedance2_i2v.models import dump_seedance2_config

        return dump_seedance2_config(
            {
                "final_prompt": "fixed seedance final prompt",
                "prompt_source": "generated",
            }
        )

    register_project_task_runner("build_episodes", fake_build_episodes)
    register_project_task_runner("script_writer", fake_script_writer)
    register_project_task_runner("beat_video_prompt", fake_beat_video_prompt)
    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(scripts, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(tasks, "resolve_project_context", resolve_project_context)
    monkeypatch.setattr(
        "novelvideo.seedance2_i2v.panel_service.generate_seedance2_prompt_for_panel",
        fake_seedance2_prompt_for_panel,
    )

    app = FastAPI()
    app.include_router(episodes.router, prefix="/api/v1")
    app.include_router(scripts.router, prefix="/api/v1")
    app.include_router(tasks.router, prefix="/api/v1")
    app.dependency_overrides[api_auth.get_api_user] = lambda: {
        "id": "local",
        "user_id": "local",
        "username": "alice",
        "role": "owner",
    }
    # Context-manage the client so one anyio portal event loop stays alive for the whole
    # test. InlineTaskBackend runs each job as a fire-and-forget asyncio.create_task on the
    # request loop; with a fresh per-request loop, that loop tears down before the job's
    # executor work and lane-drain done-callback complete, leaving tasks stuck in "queued"
    # (observed only under load on the Linux CI runner). A persistent loop lets background
    # jobs finish while the test polls _wait_for_task from the main thread.
    with TestClient(app) as client:
        yield client, ctx


def _wait_for_task(
    ctx,
    task_type: str,
    episode: int = 0,
    *,
    beat_num: int | None = None,
    timeout_s: float = 5.0,
):
    from novelvideo.task_state import get_task_manager

    manager = get_task_manager()
    deadline = time.monotonic() + timeout_s
    state = None
    while time.monotonic() < deadline:
        state = manager.get_task_for_project(ctx, task_type, episode, beat_num=beat_num)
        if state and state.status in {"completed", "failed", "cancelled"}:
            return state
        time.sleep(0.05)
    raise AssertionError(f"{task_type} did not reach terminal state; last={state}")


async def _load_episodes(ctx):
    from novelvideo.api.deps import make_sqlite_store_for_context

    store = await make_sqlite_store_for_context(ctx)
    try:
        return store.get_all_episodes()
    finally:
        await store.close()


async def _load_beats(ctx):
    from novelvideo.api.deps import make_sqlite_store_for_context

    store = await make_sqlite_store_for_context(ctx)
    try:
        return await store.get_beats_as_dicts(1)
    finally:
        await store.close()


def _task_payload(
    client: TestClient,
    task_type: str,
    episode: int,
    *,
    beat_num: int | None = None,
):
    path = f"/api/v1/projects/proj_m03_completion/tasks/{task_type}/{episode}"
    if beat_num is not None:
        path = f"{path}?beat_num={beat_num}"
    response = client.get(path)
    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload is not None
    return payload


def test_plan_task_completion_writes_episodes_and_task_envelope(m03_completion_client):
    client, ctx = m03_completion_client
    response = client.post(
        "/api/v1/projects/proj_m03_completion/episodes/plan",
        json={"planning_mode": "chapters", "target_episodes": 1},
    )
    assert response.status_code == 200
    assert response.json()["task_type"] == "build_episodes"

    state = _wait_for_task(ctx, "build_episodes")
    assert state.status == "completed"
    assert state.result["episodes"] > 0
    assert state.logs
    assert state.metadata["backend"] == "inline"

    episodes = asyncio.run(_load_episodes(ctx))
    assert [episode.number for episode in episodes] == [1]

    payload = _task_payload(client, "build_episodes", 0)
    assert {
        "task_type",
        "task_key",
        "project_id",
        "episode",
        "beat_num",
        "scope",
        "status",
        "progress",
        "current_task",
        "result",
        "error",
        "logs",
        "metadata",
    } <= set(payload)
    assert payload["status"] == "completed"
    assert payload["result"]["episodes"] > 0
    assert payload["logs"]
    assert payload["metadata"]["backend"] == "inline"


def test_script_and_video_prompt_tasks_complete_with_sorted_persisted_beats(m03_completion_client):
    client, ctx = m03_completion_client
    client.post(
        "/api/v1/projects/proj_m03_completion/episodes/plan",
        json={"planning_mode": "chapters", "target_episodes": 1},
    )
    assert _wait_for_task(ctx, "build_episodes").status == "completed"

    script_response = client.post(
        "/api/v1/projects/proj_m03_completion/episodes/1/script/generate",
        json={},
    )
    assert script_response.status_code == 200
    assert script_response.json()["task_type"] == "script_writer"
    script_state = _wait_for_task(ctx, "script_writer", 1)
    assert script_state.status == "completed"
    assert script_state.result["beats"] > 0
    assert script_state.logs
    assert script_state.metadata["backend"] == "inline"

    beats = asyncio.run(_load_beats(ctx))
    assert [beat["beat_number"] for beat in beats] == [1, 2, 3]
    assert [(beat["shot_order"], beat["beat_number"]) for beat in beats] == [
        (10, 1),
        (20, 2),
        (20, 3),
    ]

    video_prompt_response = client.post(
        "/api/v1/projects/proj_m03_completion/episodes/1/beats/1/video-prompt/generate",
        json={},
    )
    assert video_prompt_response.status_code == 200
    assert video_prompt_response.json()["task_type"] == "beat_video_prompt"
    prompt_state = _wait_for_task(ctx, "beat_video_prompt", 1, beat_num=1)
    assert prompt_state.status == "completed"
    assert prompt_state.result["prompt"] == "fixed video prompt"
    assert prompt_state.logs
    assert prompt_state.metadata["backend"] == "inline"

    beats = asyncio.run(_load_beats(ctx))
    assert beats[0]["video_prompt"] == "fixed video prompt"
    assert beats[0]["keyframe_prompt"] == "fixed keyframe prompt"


def test_negative_manual_shot_delete_rejects_regular_beat(m03_completion_client):
    client, ctx = m03_completion_client
    client.post(
        "/api/v1/projects/proj_m03_completion/episodes/plan",
        json={"planning_mode": "chapters", "target_episodes": 1},
    )
    assert _wait_for_task(ctx, "build_episodes").status == "completed"
    client.post("/api/v1/projects/proj_m03_completion/episodes/1/script/generate", json={})
    assert _wait_for_task(ctx, "script_writer", 1).status == "completed"

    response = client.delete(
        "/api/v1/projects/proj_m03_completion/episodes/1/beats/1/manual-shot"
    )
    assert response.status_code == 200
    assert response.json()["ok"] is False

    beats = asyncio.run(_load_beats(ctx))
    assert [beat["beat_number"] for beat in beats] == [1, 2, 3]
    assert beats[0]["is_manual_shot"] is False


def test_seedance2_prompt_does_not_create_media_side_effects(m03_completion_client):
    client, ctx = m03_completion_client
    client.post(
        "/api/v1/projects/proj_m03_completion/episodes/plan",
        json={"planning_mode": "chapters", "target_episodes": 1},
    )
    assert _wait_for_task(ctx, "build_episodes").status == "completed"
    client.post("/api/v1/projects/proj_m03_completion/episodes/1/script/generate", json={})
    assert _wait_for_task(ctx, "script_writer", 1).status == "completed"

    before_media = {
        path.relative_to(ctx.output_dir)
        for path in ctx.output_dir.rglob("*")
        if path.suffix.lower() in {".mp4", ".mov", ".png", ".jpg", ".jpeg", ".webp"}
    }
    response = client.post(
        "/api/v1/projects/proj_m03_completion/episodes/1/beats/1/seedance2-prompt/generate",
        json={"prompt_guidance": "固定提示"},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["data"]["final_prompt"] == "fixed seedance final prompt"
    assert "seedance2_config_json" in response.json()["data"]

    after_media = {
        path.relative_to(ctx.output_dir)
        for path in ctx.output_dir.rglob("*")
        if path.suffix.lower() in {".mp4", ".mov", ".png", ".jpg", ".jpeg", ".webp"}
    }
    assert after_media == before_media
    beats = asyncio.run(_load_beats(ctx))
    assert beats[0]["video_prompt"] == ""
    assert beats[0]["keyframe_prompt"] == ""


def test_chapters_without_novel_returns_ok_false(m03_completion_client):
    client, ctx = m03_completion_client
    novel_path = ctx.output_dir / "novel.txt"
    novel_path.unlink()
    assert not novel_path.exists()

    response = client.get("/api/v1/projects/proj_m03_completion/chapters")
    assert response.status_code == 200
    assert response.json()["ok"] is False
