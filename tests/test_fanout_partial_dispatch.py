"""M8 步 9（G3）· 扇出端点的部分投递（TCP-EU-B4a）。

三个扇出循环（``api/routes/generation.py`` 的 ``:2124`` / ``:3078`` / ``:4448``）撞闸时必须
**停在撞点、如实上报已投与被拒**，而不是「前 k−1 个已扣算力、客户端只拿到一个 429」。

本文件逐循环钉死 M8 §8.2 冻结的契约：

1. **只捕两个闸异常**（``ChannelTaskLimitExceeded`` / ``UserTaskLimitExceeded``）→ 记进
   ``rejected`` 后 **``break``**；别的异常照旧穿透（宽捕 ``Exception`` 就是 ``TCP-P44``
   刚堵上的那条 503 复发路径）。
2. **k == 0 必须裸抛** —— 交 ``api/app.py`` 的 handler 渲染 429 ＋ 正确的 ``limit_scope``
   （M8 不变量 7）；循环 1 的单格分支 ``:2178`` 直接读 ``queued_tasks[0]``，k=0 时必崩。
3. 响应体加 ``rejected: [{scope, reason, limit, active}]``，并把 ``:2166`` 的
   ``dispatched`` 从**意图数**改成**实投数**（M8 不变量 17）。

``reason`` 的算法与 ``api/app.py`` 的 ``limit_scope`` **是同一组分支**
（``:183-185`` 渠道闸 / ``:209`` 人闸）—— 两侧同算法即跨 EU（``TCP-EU-B2``）漂移探测器，
故本文件三种 ``reason`` 全落到，并另有一条用例把两侧逐字对上。

真闸在 EE（``TCP-EU-B1`` 的 ``ee_reserve_task()``），故此处一律**手工注入异常**取证。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.app import create_app
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    UserTaskLimitExceeded,
)

# ---------------------------------------------------------------------------
# 共用：注入闸异常的假 task backend
# ---------------------------------------------------------------------------

_CHANNEL_GATE = ChannelTaskLimitExceeded(
    scope_kind="organization", org_id="org_9", queue_kind="default", limit=3, active=3
)
_PLATFORM_GATE = ChannelTaskLimitExceeded(
    scope_kind="platform", org_id=None, queue_kind="default", limit=8, active=8
)
_USER_GATE = UserTaskLimitExceeded(
    requester_user_id="user_7", queue_kind="default", limit=2, active=2
)

# (异常, 期望的 rejected.reason, 期望的 429 limit_scope)
_GATE_CASES = [
    (_CHANNEL_GATE, "channel", "channel"),
    (_PLATFORM_GATE, "platform", "platform"),
    (_USER_GATE, "user", "user"),
]
_GATE_IDS = ["channel", "platform", "user"]


class _GateBackend:
    """第 ``fail_from`` 次调用起抛 ``exc``；``fail_from=None`` 则永不抛。"""

    def __init__(self, exc: Exception | None = None, fail_from: int | None = None):
        self.exc = exc
        self.fail_from = fail_from
        self.calls: list[dict] = []

    async def enqueue_project_task(self, ctx, **kwargs):
        self.calls.append(kwargs)
        if self.fail_from is not None and len(self.calls) >= self.fail_from:
            assert self.exc is not None
            raise self.exc
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=f"task-{len(self.calls)}"),
            backend="celery",
            queue=kwargs.get("queue_kind") or "default",
        )


def _app_with_production_handlers(router) -> FastAPI:
    """借生产 app 的 exception handlers，把路由挂在干净 app 上。

    形制逐字照 ``tests/test_channel_task_limit_error_surface.py:307-310``
    （``TCP-EU-B2`` 落的），k==0 的裸抛要经过真 handler 才能断言 429 与 ``limit_scope``。
    """
    production_app = create_app()
    app = FastAPI()
    app.exception_handlers.update(production_app.exception_handlers)
    app.include_router(router, prefix="/api/v1")
    return app


# ---------------------------------------------------------------------------
# 循环 1：generate_sketches（:2124 for grid_index in dispatch_grid_indices）
#   harness 照 tests/test_api_generation_sketches.py:29-116
# ---------------------------------------------------------------------------

_SKETCH_BEATS = [
    {"beat_number": n, "narration_segment": chr(96 + n), "location": chr(64 + n)}
    for n in range(1, 7)
]


class _SketchStore:
    async def get_beats_as_dicts(self, episode_num: int):
        assert episode_num == 2
        return _SKETCH_BEATS

    def get_episode(self, episode_num: int):
        return SimpleNamespace(prop_menu=[])

    def get_cached_prop(self, prop_id: str):
        return None

    def get_sketch_colors(self, episode_num: int):
        return {"hero_main": "#ffffff"}


def _sketch_client(monkeypatch, tmp_path, backend: _GateBackend, grids: int):
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import generation
    from novelvideo.generators import nanobanana_grid
    from novelvideo.utils.path_resolver import PathResolver

    store = _SketchStore()

    async def fake_make_sqlite_store_for_context(ctx):
        return store

    async def fake_make_sqlite_store(username: str, project: str):
        return store

    async def fake_character_map(*args, **kwargs):
        return {"hero": {"identity_sketch_colors": {"hero_main": "#ffffff"}}}

    async def fake_prop_menu(*args, **kwargs):
        return []

    def fake_scene_split(beats, aspect_ratio="2:3"):
        return [
            {
                "rows": 1,
                "cols": 1,
                "mode_key": "1x1_2-3_sketch",
                "scene_id": chr(65 + idx),
                "beat_numbers": [beats[idx]["beat_number"]],
                "beats": [beats[idx]],
            }
            for idx in range(grids)
        ]

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=SimpleNamespace(project_id="proj", state_dir=tmp_path / "state"),
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(generation, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", fake_prop_menu)
    monkeypatch.setattr(generation, "get_task_backend", lambda: backend)
    monkeypatch.setattr(PathResolver, "clean_sketches", lambda self: [])
    monkeypatch.setattr(nanobanana_grid, "sketch_scene_grid_split", fake_scene_split)

    app = _app_with_production_handlers(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    app.dependency_overrides[generation.require_scope("tasks:submit")] = lambda: {
        "username": "alice"
    }
    return TestClient(app, raise_server_exceptions=False)


def _post_sketches(client: TestClient, grid_index: int = -1):
    return client.post(
        "/api/v1/projects/demo/episodes/2/sketches/generate",
        json={"grid_index": grid_index, "sketch_scene_grouping": True},
    )


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop1_partial_dispatch_reports_dispatched_and_rejected(
    monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    """第 4 个撞闸：前 3 个仍已投递，dispatched==3，rejected 恰一项且 reason 正确。"""
    backend = _GateBackend(exc, fail_from=4)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert len(data["tasks"]) == 3
    assert data["scopes"] == ["grid_0", "grid_1", "grid_2"]
    assert data["rejected"] == [
        {"scope": "grid_3", "reason": reason, "limit": exc.limit, "active": exc.active}
    ]


def test_loop1_stops_at_the_gate_instead_of_retrying_every_remaining_item(
    monkeypatch, tmp_path
) -> None:
    """撞点即停：循环体被调用的次数恰为 k+1（3），不是 N（6）。"""
    backend = _GateBackend(_CHANNEL_GATE, fail_from=3)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 200
    assert len(backend.calls) == 3
    data = response.json()["data"]
    assert data["dispatched"] == 2
    assert [item["scope"] for item in data["rejected"]] == ["grid_2"]


@pytest.mark.parametrize(("exc", "_reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop1_k_zero_raises_bare_and_renders_429(
    monkeypatch, tmp_path, exc, _reason, scope
) -> None:
    """一个都没投出去 → 429 ＋ 正确 limit_scope，不是 200 ＋ 空 rejected。"""
    backend = _GateBackend(exc, fail_from=1)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    assert response.status_code == 429
    body = response.json()
    assert body["ok"] is False
    assert body["data"]["limit_scope"] == scope
    assert "rejected" not in body.get("data", {})


def test_loop1_single_grid_path_still_429s_instead_of_indexerror(
    monkeypatch, tmp_path
) -> None:
    """单格分支 N=1：撞闸必落 k==0 → 429（:2178 的 queued_tasks[0] 不得 IndexError）。"""
    backend = _GateBackend(_USER_GATE, fail_from=1)
    response = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, backend, grids=4), grid_index=1
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == "user"


def test_loop1_non_gate_exception_is_not_swallowed(monkeypatch, tmp_path) -> None:
    """普通 RuntimeError 原样向上：不进 rejected、不 break 成 200。"""
    backend = _GateBackend(RuntimeError("boom"), fail_from=3)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=6))

    assert response.status_code == 500
    assert len(backend.calls) == 3


def test_loop1_dispatched_is_the_real_count_not_the_intended_one(
    monkeypatch, tmp_path
) -> None:
    """:2166 那句谎：投出 3 个、被拒 1 个 → dispatched==3（改前会是 4）。"""
    backend = _GateBackend(_CHANNEL_GATE, fail_from=4)
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert data["dispatched"] == len(data["tasks"]) == len(data["scopes"])


def test_loop1_happy_path_body_is_unchanged_plus_empty_rejected(
    monkeypatch, tmp_path
) -> None:
    """不撞闸时：既有键逐字未变，rejected 为空列表（本 EU 选「恒出现」，在此钉死）。"""
    backend = _GateBackend()
    response = _post_sketches(_sketch_client(monkeypatch, tmp_path, backend, grids=4))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"ok", "task_type", "backend", "data", "message"}
    assert body["ok"] is True
    assert body["task_type"] == "sketch_grid_generation"
    assert body["backend"] == "celery"
    assert set(body["data"]) == {"dispatched", "tasks", "scopes", "rejected"}
    assert body["data"]["dispatched"] == 4
    assert body["data"]["scopes"] == ["grid_0", "grid_1", "grid_2", "grid_3"]
    assert body["data"]["rejected"] == []
    assert len(backend.calls) == 4


def test_loop1_single_grid_happy_path_body_has_no_rejected_key(
    monkeypatch, tmp_path
) -> None:
    """单格分支的响应体逐字未变（N=1 无扇出，不挂 rejected）。"""
    backend = _GateBackend()
    response = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, backend, grids=4), grid_index=1
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "ok",
        "task_type",
        "backend",
        "task_id",
        "task_key",
        "queue",
        "message",
    }
    assert "rejected" not in body


# ---------------------------------------------------------------------------
# 循环 2：render_execute（:3078 for entry in execution_plan）
#   harness 照 tests/test_api_render_regenerate.py:32-104
# ---------------------------------------------------------------------------

_RENDER_BEATS = [
    {"beat_number": n, "narration_segment": chr(96 + n), "location": chr(64 + n)}
    for n in range(1, 7)
]


class _RenderStore:
    async def get_beats_as_dicts(self, episode_num: int):
        assert episode_num == 2
        return _RENDER_BEATS

    def get_sketch_colors(self, episode_num: int):
        return {"hero_main": "#ffffff"}

    def get_cached_prop(self, prop_id: str):
        return None


def _render_client(monkeypatch, tmp_path, backend: _GateBackend):
    from novelvideo.api.routes import generation

    async def fake_make_sqlite_store_for_context(ctx):
        return _RenderStore()

    async def fake_make_sqlite_store(username: str, project: str):
        return _RenderStore()

    async def fake_resolve_generation_project(project: str, user: dict, required_role: str):
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            ctx=SimpleNamespace(
                project_id="proj",
                state_dir=tmp_path / "state",
                runtime_dir=tmp_path / "runtime",
            ),
        )

    async def fake_character_map(store, beats, username, project, **kwargs):
        return {"hero": {"ref_path": ""}}

    async def fake_prop_menu(*args, **kwargs):
        return []

    monkeypatch.setattr(
        generation, "_resolve_generation_project", fake_resolve_generation_project
    )
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "_runtime_prop_menu_with_global_props", fake_prop_menu)
    monkeypatch.setattr(generation, "render_ai_detection_error", lambda beats: None)
    monkeypatch.setattr(generation, "get_task_backend", lambda: backend)

    app = _app_with_production_handlers(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app, raise_server_exceptions=False)


def _render_execute(client: TestClient, beat_indices: list[int]):
    """两步：/render/plan 拿指纹，再 /render/execute（force_one_by_one → 一 beat 一格）。"""
    plan_response = client.post(
        "/api/v1/projects/demo/episodes/2/render/plan",
        json={
            "beat_indices": beat_indices,
            "strategy": "naive",
            "aspect_mode": "9:16",
            "force_one_by_one": True,
        },
    )
    assert plan_response.status_code == 200, plan_response.text
    plan = plan_response.json()["data"]
    assert len(plan["plan"]) == len(beat_indices)

    return plan, client.post(
        "/api/v1/projects/demo/episodes/2/render/execute",
        json={
            "plan": plan["plan"],
            "plan_hash": plan["plan_hash"],
            "input_fingerprint": plan["input_fingerprint"],
            "strategy": plan["strategy"],
            "aspect_mode": "9:16",
            "force_one_by_one": True,
            "beat_indices": beat_indices,
        },
    )


def _expected_scopes(plan: dict) -> list[str]:
    from novelvideo.task_identity import selection_scope

    return [
        selection_scope(entry["mode_key"], [int(b) for b in entry["beat_numbers"]])
        for entry in plan["plan"]
    ]


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop2_partial_dispatch_reports_task_ids_and_rejected(
    monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    backend = _GateBackend(exc, fail_from=4)
    plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4]
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert len(data["task_ids"]) == 3
    assert data["rejected"] == [
        {
            "scope": _expected_scopes(plan)[3],
            "reason": reason,
            "limit": exc.limit,
            "active": exc.active,
        }
    ]


def test_loop2_stops_at_the_gate(monkeypatch, tmp_path) -> None:
    backend = _GateBackend(_PLATFORM_GATE, fail_from=3)
    plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    assert response.status_code == 200, response.text
    assert len(backend.calls) == 3
    data = response.json()["data"]
    assert len(data["task_ids"]) == 2
    assert [item["scope"] for item in data["rejected"]] == [_expected_scopes(plan)[2]]


@pytest.mark.parametrize(("exc", "_reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop2_k_zero_raises_bare_and_renders_429(
    monkeypatch, tmp_path, exc, _reason, scope
) -> None:
    backend = _GateBackend(exc, fail_from=1)
    _plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4]
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == scope


def test_loop2_non_gate_exception_is_not_swallowed(monkeypatch, tmp_path) -> None:
    backend = _GateBackend(RuntimeError("boom"), fail_from=3)
    _plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4, 5, 6]
    )

    assert response.status_code == 500
    assert len(backend.calls) == 3


def test_loop2_happy_path_body_is_unchanged_and_has_no_rejected_key(
    monkeypatch, tmp_path
) -> None:
    """不撞闸时逐字未变：``rejected`` 只在非空时出现（照既有 ``task_ids`` 的挂法）。"""
    backend = _GateBackend()
    plan, response = _render_execute(
        _render_client(monkeypatch, tmp_path, backend), [1, 2, 3, 4]
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"ok", "data"}
    data = body["data"]
    assert set(data) == {
        "task_type",
        "message",
        "scope",
        "resolved_grids",
        "task_ids",
    }
    assert "rejected" not in data
    assert len(data["task_ids"]) == 4
    assert [entry["beat_numbers"] for entry in data["resolved_grids"]] == [
        entry["beat_numbers"] for entry in plan["plan"]
    ]


def test_loop2_response_model_field_set_is_unchanged() -> None:
    """RenderPlanExecuteResponse 一个字段都没加（rejected 只挂在外层 dict）。"""
    from novelvideo.api.schemas import RenderPlanExecuteResponse

    assert set(RenderPlanExecuteResponse.model_fields) == {
        "task_type",
        "message",
        "scope",
        "resolved_grids",
    }


# ---------------------------------------------------------------------------
# 循环 3：generate_missing_manual_sketches（:4448 for beat_numbers in segments）
# ---------------------------------------------------------------------------


class _ManualStore:
    async def get_beats_as_dicts(self, episode_num: int):
        return _SKETCH_BEATS

    def get_sketch_colors(self, episode_num: int):
        return {"hero_main": "#ffffff"}


def _manual_client(monkeypatch, tmp_path, backend: _GateBackend, segments):
    from novelvideo import manual_shots
    from novelvideo.api.routes import generation

    async def fake_make_sqlite_store_for_context(ctx):
        return _ManualStore()

    async def fake_make_sqlite_store(username: str, project: str):
        return _ManualStore()

    async def fake_resolve_generation_project(project: str, user: dict, required_role: str):
        return SimpleNamespace(
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            ctx=SimpleNamespace(
                project_id="proj",
                state_dir=tmp_path / "state",
                runtime_dir=tmp_path / "runtime",
            ),
        )

    async def fake_character_map(*args, **kwargs):
        return {"hero": {"ref_path": ""}}

    monkeypatch.setattr(
        generation, "_resolve_generation_project", fake_resolve_generation_project
    )
    monkeypatch.setattr(generation, "load_project_config", lambda username, project: {})
    monkeypatch.setattr(generation, "make_sqlite_store", fake_make_sqlite_store)
    monkeypatch.setattr(
        generation, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(generation, "_build_character_map", fake_character_map)
    monkeypatch.setattr(generation, "get_task_backend", lambda: backend)
    monkeypatch.setattr(
        manual_shots, "storyboard_beats_for_manual_sketches", lambda beats: list(beats)
    )
    monkeypatch.setattr(
        manual_shots,
        "missing_manual_shot_segments",
        lambda beats, sketches_dir: [list(seg) for seg in segments],
    )
    monkeypatch.setattr(manual_shots, "choose_manual_sketch_mode_key", lambda n: "1x1_2-3_sketch")

    app = _app_with_production_handlers(generation.router)
    app.dependency_overrides[generation.get_api_user] = lambda: {"username": "alice"}
    return TestClient(app, raise_server_exceptions=False)


def _post_missing_manual(client: TestClient):
    return client.post(
        "/api/v1/projects/demo/episodes/2/sketches/generate-missing-manual"
    )


def _manual_scope(beat_numbers: list[int]) -> str:
    from novelvideo.task_identity import selection_scope

    return selection_scope("1x1_2-3_sketch", beat_numbers)


@pytest.mark.parametrize(("exc", "reason", "_scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop3_partial_dispatch_reports_dispatched_and_rejected(
    monkeypatch, tmp_path, exc, reason, _scope
) -> None:
    backend = _GateBackend(exc, fail_from=4)
    segments = [[1], [2], [3], [4]]
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["dispatched"] == 3
    assert data["segments"] == [[1], [2], [3]]
    assert data["scopes"] == [_manual_scope(seg) for seg in segments[:3]]
    assert data["rejected"] == [
        {
            "scope": _manual_scope([4]),
            "reason": reason,
            "limit": exc.limit,
            "active": exc.active,
        }
    ]


def test_loop3_stops_at_the_gate(monkeypatch, tmp_path) -> None:
    backend = _GateBackend(_USER_GATE, fail_from=3)
    segments = [[1], [2], [3], [4], [5], [6]]
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    assert len(backend.calls) == 3
    data = response.json()["data"]
    assert data["dispatched"] == 2
    assert [item["scope"] for item in data["rejected"]] == [_manual_scope([3])]


@pytest.mark.parametrize(("exc", "_reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_loop3_k_zero_raises_bare_and_renders_429(
    monkeypatch, tmp_path, exc, _reason, scope
) -> None:
    backend = _GateBackend(exc, fail_from=1)
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, [[1], [2], [3], [4]])
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == scope


def test_loop3_non_gate_exception_is_not_swallowed(monkeypatch, tmp_path) -> None:
    backend = _GateBackend(RuntimeError("boom"), fail_from=3)
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, [[1], [2], [3], [4], [5], [6]])
    )

    assert response.status_code == 500
    assert len(backend.calls) == 3


def test_loop3_happy_path_keeps_its_existing_shape(monkeypatch, tmp_path) -> None:
    """dispatched / scopes / segments 三键语义逐字未变，rejected 为空列表。"""
    backend = _GateBackend()
    segments = [[1], [2], [3]]
    response = _post_missing_manual(
        _manual_client(monkeypatch, tmp_path, backend, segments)
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"ok", "task_type", "data", "message"}
    assert body["task_type"] == "sketch_regen"
    assert body["message"] == "已启动 3 组新增分镜草图生成"
    assert set(body["data"]) == {"dispatched", "scopes", "segments", "rejected"}
    assert body["data"]["dispatched"] == 3
    assert body["data"]["segments"] == segments
    assert body["data"]["scopes"] == [_manual_scope(seg) for seg in segments]
    assert body["data"]["rejected"] == []


def test_loop3_empty_segments_early_return_is_untouched(monkeypatch, tmp_path) -> None:
    """空集早返回（:4426-4430）不受影响：三键逐字未变、不长出 rejected。"""
    backend = _GateBackend()
    response = _post_missing_manual(_manual_client(monkeypatch, tmp_path, backend, []))

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"] == {"dispatched": 0, "scopes": [], "segments": []}
    assert body["message"] == "没有缺草图的手工分镜"
    assert backend.calls == []


# ---------------------------------------------------------------------------
# 跨 EU 漂移探测器：rejected.reason 与 api/app.py 的 limit_scope 同算法
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("exc", "reason", "scope"), _GATE_CASES, ids=_GATE_IDS)
def test_rejected_reason_matches_the_handler_limit_scope_verbatim(
    monkeypatch, tmp_path, exc, reason, scope
) -> None:
    """同一个异常：``rejected[0]["reason"]`` 与 429 的 ``limit_scope`` 必须相等。

    两侧同算法是 ``TCP-EU-B4a`` 与 ``TCP-EU-B2`` 之间唯一的漂移探测器
    （``api/app.py:183-185`` / ``:209``）。
    """
    assert reason == scope

    partial = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, _GateBackend(exc, fail_from=4), grids=4)
    )
    assert partial.status_code == 200
    from_loop = partial.json()["data"]["rejected"][0]["reason"]

    refused = _post_sketches(
        _sketch_client(monkeypatch, tmp_path, _GateBackend(exc, fail_from=1), grids=4)
    )
    assert refused.status_code == 429
    from_handler = refused.json()["data"]["limit_scope"]

    assert from_loop == from_handler == reason
