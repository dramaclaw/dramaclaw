"""M8 步 7 · 渠道闸 / 人闸的 CE 错误面。

本文件钉三件事：

1. 两个新异常与 ``task_backend/limits.py:46-101`` 的三个现有类**同族**
   （dataclass + ``__post_init__`` 把字段原样喂给 ``RuntimeError.__init__`` + 自定义 ``__str__``），
   且**都不带** ``limit_scope`` 字段 —— 该字面量硬写在 handler 里（``api/app.py:113/138/159``）。
2. ``api/app.py`` 的两个新 handler 返 **429** 且 ``limit_scope`` 落在正确的轴上
   （M8 §2.9(d)：``scope_kind == "platform"`` → ``platform``，否则 ``channel``；人闸 → ``user``）。
3. **核心**：走 freezone 真实路由时，这些异常**不被降成 503**。
   ``freezone.py`` 的宽 ``except RuntimeError`` （如 ``:8565-8571``）会把没被
   ``_raise_if_task_limit_exception`` 认领的 ``RuntimeError`` 一律包成
   ``HTTPException(503, ...)`` —— 这正是飞书 64-171 那个 bug 的复发路径
   （M8 不变量 7：超限必须 429 且 ``limit_scope`` 正确，**绝不是 503**）。
"""

from __future__ import annotations

import logging
from dataclasses import fields, is_dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.app import create_app
from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    GlobalLaneQueueLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    UserTaskLimitExceeded,
)

# ---------------------------------------------------------------------------
# 1. 异常形状：与 limits.py:46-101 的三个现有类同族
# ---------------------------------------------------------------------------

_EXISTING_FAMILY = (
    ProjectTaskLimitExceeded(
        project_id="proj_1", queue_kind="video", limit=4, active=4
    ),
    ProjectUserTaskLimitExceeded(
        project_id="proj_1",
        requester_user_id="user_1",
        queue_kind="video",
        limit=1,
        active=1,
    ),
    GlobalLaneQueueLimitExceeded(
        project_id="proj_1", queue_kind="video", limit=2, queued=2
    ),
)

_NEW_FAMILY = (
    ChannelTaskLimitExceeded(
        scope_kind="organization",
        org_id="org_1",
        queue_kind="video",
        limit=2,
        active=2,
    ),
    UserTaskLimitExceeded(
        requester_user_id="user_1", queue_kind="video", limit=1, active=1
    ),
)


@pytest.mark.parametrize("exc", _NEW_FAMILY, ids=lambda exc: type(exc).__name__)
def test_new_limit_exceptions_share_the_existing_family_shape(exc) -> None:
    """新类逐条对齐现有三个类的 dataclass / __post_init__ / __str__ 形状。"""
    cls = type(exc)
    assert is_dataclass(cls)
    assert issubclass(cls, RuntimeError)

    field_names = [field.name for field in fields(cls)]
    # __post_init__ 把全部字段按声明序原样喂给 RuntimeError.__init__（同 :53-54 / :71-78 / :94-95）
    assert exc.args == tuple(getattr(exc, name) for name in field_names)

    # __str__ 是人话，不是 args 的 repr（同 :56-60 / :80-84 / :97-101）
    rendered = str(exc)
    assert rendered != repr(exc.args)
    assert "lane is full" in rendered
    assert f"({exc.active}/{exc.limit})" in rendered

    # 现有三个类同样满足以上四条 —— 「同族」的判据在此处闭合
    for existing in _EXISTING_FAMILY:
        existing_names = [field.name for field in fields(type(existing))]
        assert existing.args == tuple(
            getattr(existing, name) for name in existing_names
        )
        assert "lane is full" in str(existing) or "queue is full" in str(existing)


@pytest.mark.parametrize("exc", _NEW_FAMILY, ids=lambda exc: type(exc).__name__)
def test_new_limit_exceptions_do_not_carry_limit_scope(exc) -> None:
    """limit_scope 硬写在 handler 里，异常类上没有这个字段（照现有三个类）。"""
    assert "limit_scope" not in {field.name for field in fields(type(exc))}
    assert not hasattr(exc, "limit_scope")
    for existing in _EXISTING_FAMILY:
        assert "limit_scope" not in {
            field.name for field in fields(type(existing))
        }


def test_channel_task_limit_exceeded_declares_the_step7_fields() -> None:
    assert [field.name for field in fields(ChannelTaskLimitExceeded)] == [
        "scope_kind",
        "org_id",
        "queue_kind",
        "limit",
        "active",
    ]
    platform = ChannelTaskLimitExceeded(
        scope_kind="platform", org_id=None, queue_kind="world", limit=1, active=1
    )
    assert platform.org_id is None
    assert "world" in str(platform)


def test_user_task_limit_exceeded_declares_the_step7_fields() -> None:
    assert [field.name for field in fields(UserTaskLimitExceeded)] == [
        "requester_user_id",
        "queue_kind",
        "limit",
        "active",
    ]


# ---------------------------------------------------------------------------
# 2. handler：429 + 正确的 limit_scope
#    形制照 tests/contract/test_l014_inline_task_backend_concurrency.py:569-597
# ---------------------------------------------------------------------------


def _client_raising(exc: RuntimeError) -> TestClient:
    app = create_app()

    @app.get("/_test/task-limit")
    async def _raise_task_limit():  # pragma: no cover - 由 TestClient 触发
        raise exc

    return TestClient(app)


def test_channel_limit_organization_scope_maps_to_429_channel() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        )
    ).get("/_test/task-limit")

    assert response.status_code == 429
    body = response.json()
    assert body["ok"] is False
    assert body["data"]["limit_scope"] == "channel"
    assert body["data"]["scope_kind"] == "organization"
    assert body["data"]["org_id"] == "org_9"
    assert body["data"]["queue_kind"] == "video"
    assert body["data"]["limit"] == 2
    assert body["data"]["active"] == 2


def test_channel_limit_platform_scope_maps_to_429_platform() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="video",
            limit=8,
            active=8,
        )
    ).get("/_test/task-limit")

    assert response.status_code == 429
    body = response.json()
    assert body["data"]["limit_scope"] == "platform"
    assert body["data"]["scope_kind"] == "platform"
    assert body["data"]["org_id"] is None


def test_user_limit_maps_to_429_user() -> None:
    response = _client_raising(
        UserTaskLimitExceeded(
            requester_user_id="user_7", queue_kind="default", limit=1, active=1
        )
    ).get("/_test/task-limit")

    assert response.status_code == 429
    body = response.json()
    assert body["ok"] is False
    assert body["data"] == {
        "requester_user_id": "user_7",
        "queue_kind": "default",
        "limit": 1,
        "active": 1,
        "limit_scope": "user",
    }


def test_existing_three_limit_handlers_response_bodies_are_unchanged() -> None:
    """既有三个异常的响应体逐字未变（project / user / global_lane_queue）。"""
    project = _client_raising(
        ProjectTaskLimitExceeded(
            project_id="proj_1", queue_kind="video", limit=4, active=4
        )
    ).get("/_test/task-limit")
    assert project.status_code == 429
    assert project.json()["data"] == {
        "project_id": "proj_1",
        "queue_kind": "video",
        "limit": 4,
        "active": 4,
        "limit_scope": "project",
    }

    project_user = _client_raising(
        ProjectUserTaskLimitExceeded(
            project_id="proj_1",
            requester_user_id="user_1",
            queue_kind="video",
            limit=1,
            active=1,
        )
    ).get("/_test/task-limit")
    assert project_user.status_code == 429
    assert project_user.json()["data"] == {
        "project_id": "proj_1",
        "requester_user_id": "user_1",
        "queue_kind": "video",
        "limit": 1,
        "active": 1,
        "limit_scope": "user",
    }

    global_lane = _client_raising(
        GlobalLaneQueueLimitExceeded(
            project_id="proj_1", queue_kind="world", limit=1, queued=1
        )
    ).get("/_test/task-limit")
    assert global_lane.status_code == 429
    assert global_lane.json()["data"] == {
        "project_id": "proj_1",
        "queue_kind": "world",
        "limit": 1,
        "queued": 1,
        "limit_scope": "global_lane_queue",
    }


# ---------------------------------------------------------------------------
# 3. 核心：走 freezone 真实路由，不被降成 503
#    harness 照 tests/test_freezone_image_backend.py:224-253
# ---------------------------------------------------------------------------


def _project_ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_freezone",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=True,
    )


def _patch_freezone_project(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _project_ctx(tmp_path)
    project_dir = tmp_path / "project"
    output_dir = tmp_path / "output"

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "58", project_dir, str(output_dir)

    monkeypatch.setattr(
        freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project
    )


def _patch_enqueue_raising(
    monkeypatch: pytest.MonkeyPatch, exc: RuntimeError
) -> None:
    async def fake_enqueue_project_task(_ctx: ProjectContext, **_kwargs):
        raise exc

    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )


def _freezone_client() -> TestClient:
    production_app = create_app()
    # 与 test_freezone_image_backend.py 同法：只借生产 app 的 exception handlers，
    # 把路由挂在一个干净的 app 上，避开全量串行跑时累积的共享 router/port 状态。
    app = FastAPI()
    app.exception_handlers.update(production_app.exception_handlers)
    app.include_router(freezone_routes.router, prefix="/api/v1")

    async def fake_user():
        return {"id": "owner_1", "username": "admin"}

    app.dependency_overrides[freezone_routes.get_api_user] = fake_user
    return TestClient(app)


def _post_omni_gen(client: TestClient):
    return client.post(
        "/api/v1/projects/58/freezone/video/omni-gen",
        json={"prompt": "雨夜街头，人物缓慢回头。"},
    )


@pytest.mark.parametrize(
    ("exc", "expected_scope"),
    [
        (
            ChannelTaskLimitExceeded(
                scope_kind="organization",
                org_id="org_9",
                queue_kind="video",
                limit=2,
                active=2,
            ),
            "channel",
        ),
        (
            ChannelTaskLimitExceeded(
                scope_kind="platform",
                org_id=None,
                queue_kind="video",
                limit=8,
                active=8,
            ),
            "platform",
        ),
        (
            UserTaskLimitExceeded(
                requester_user_id="owner_1",
                queue_kind="video",
                limit=1,
                active=1,
            ),
            "user",
        ),
    ],
    ids=["channel", "platform", "user"],
)
def test_new_limit_exceptions_are_not_downgraded_to_503_on_real_route(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    exc: RuntimeError,
    expected_scope: str,
) -> None:
    """不加进 _raise_if_task_limit_exception，这里拿到的就是 503（飞书 64-171 的复发路径）。"""
    _patch_freezone_project(monkeypatch, tmp_path)
    _patch_enqueue_raising(monkeypatch, exc)

    response = _post_omni_gen(_freezone_client())

    assert response.status_code != 503
    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == expected_scope


@pytest.mark.parametrize(
    ("exc", "expected_scope"),
    [
        (
            ProjectTaskLimitExceeded(
                project_id="proj_freezone", queue_kind="video", limit=4, active=4
            ),
            "project",
        ),
        (
            ProjectUserTaskLimitExceeded(
                project_id="proj_freezone",
                requester_user_id="owner_1",
                queue_kind="video",
                limit=1,
                active=1,
            ),
            "user",
        ),
        (
            GlobalLaneQueueLimitExceeded(
                project_id="proj_freezone", queue_kind="video", limit=2, queued=2
            ),
            "global_lane_queue",
        ),
    ],
    ids=["project", "project_user", "global_lane_queue"],
)
def test_existing_limit_exceptions_are_not_downgraded_to_503_on_real_route(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    exc: RuntimeError,
    expected_scope: str,
) -> None:
    """既有三个异常未回归。

    ``global_lane_queue`` 那条今天是**红**的：``app.py:143-162`` 的 handler 早就在，
    但 ``_raise_if_task_limit_exception`` 不认它，宽 ``except RuntimeError`` 先把它
    吞成 503 —— M8 §4 步 7 称之为「活标本，顺手补掉」，处置见登记册 ``TCP-P44``。
    """
    _patch_freezone_project(monkeypatch, tmp_path)
    _patch_enqueue_raising(monkeypatch, exc)

    response = _post_omni_gen(_freezone_client())

    assert response.status_code != 503
    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == expected_scope


# ---------------------------------------------------------------------------
# 4. 文案按作用域分叉
#    共享池（``scope_kind == "platform"``）拦下的是不归属任何渠道的请求，
#    对他们说"渠道"没有对应概念，配套的等待指引也无从执行。
# ---------------------------------------------------------------------------


def test_platform_scope_message_avoids_channel_wording() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="default",
            limit=32,
            active=32,
        )
    ).get("/_test/task-limit")

    message = response.json()["error"]
    assert "渠道" not in message
    assert "组织" not in message
    assert "平台" in message
    assert "default" in message
    # 共享池是全平台共用的，撞闸的人自己可能一个任务都没在跑 ——
    # 让他"等待已有任务完成"是条不可行动的指引。
    assert "等待已有任务完成" not in message


def test_organization_scope_message_keeps_channel_wording() -> None:
    response = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        )
    ).get("/_test/task-limit")

    assert response.json()["error"] == (
        "当前渠道 video 队列任务已满，请等待已有任务完成后再提交"
    )


def test_message_split_leaves_channel_handler_data_untouched() -> None:
    """分叉只动 error 文案，data 两个作用域都逐字未变。"""
    platform = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="world",
            limit=8,
            active=8,
        )
    ).get("/_test/task-limit")
    assert platform.json()["data"] == {
        "scope_kind": "platform",
        "org_id": None,
        "queue_kind": "world",
        "limit": 8,
        "active": 8,
        "limit_scope": "platform",
    }

    organization = _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="world",
            limit=8,
            active=8,
        )
    ).get("/_test/task-limit")
    assert organization.json()["data"] == {
        "scope_kind": "organization",
        "org_id": "org_9",
        "queue_kind": "world",
        "limit": 8,
        "active": 8,
        "limit_scope": "channel",
    }


_LIMIT_LOGGER = "novelvideo.task_backend.limit_logging"

# ---------------------------------------------------------------------------
# 5. 限流日志
#    429 的 limit_scope 此前只活在返回体里，日志一个字不记 —— 生产上撞闸后
#    无法归因是五道闸里的哪一道。这五个 handler 覆盖「异常逃到 HTTP 层」这条出口；
#    扇出循环吞掉异常的那条出口另见 tests/test_fanout_partial_dispatch.py。
# ---------------------------------------------------------------------------

_LIMIT_LOG_CASES = (
    (
        ProjectTaskLimitExceeded(
            project_id="proj_1", queue_kind="video", limit=4, active=4
        ),
        (
            "limit_scope=project",
            "queue_kind=video",
            "limit=4",
            "active=4",
            "project_id=proj_1",
        ),
    ),
    (
        ProjectUserTaskLimitExceeded(
            project_id="proj_1",
            requester_user_id="user_1",
            queue_kind="video",
            limit=1,
            active=1,
        ),
        (
            "limit_scope=user",
            "requester_user_id=user_1",
            "project_id=proj_1",
        ),
    ),
    (
        GlobalLaneQueueLimitExceeded(
            project_id="proj_1", queue_kind="world", limit=2, queued=2
        ),
        (
            "limit_scope=global_lane_queue",
            "queued=2",
            "project_id=proj_1",
        ),
    ),
    (
        ChannelTaskLimitExceeded(
            scope_kind="platform",
            org_id=None,
            queue_kind="default",
            limit=32,
            active=32,
        ),
        (
            "limit_scope=platform",
            "scope_kind=platform",
            "org_id=-",
            "queue_kind=default",
            "limit=32",
            "active=32",
        ),
    ),
    (
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        ),
        (
            "limit_scope=channel",
            "scope_kind=organization",
            "org_id=org_9",
        ),
    ),
    (
        UserTaskLimitExceeded(
            requester_user_id="user_7", queue_kind="default", limit=1, active=1
        ),
        (
            "limit_scope=user",
            "requester_user_id=user_7",
            "queue_kind=default",
        ),
    ),
)


@pytest.mark.parametrize(
    ("exc", "expected_fragments"),
    _LIMIT_LOG_CASES,
    ids=[
        "project",
        "project_user",
        "global_lane_queue",
        "channel_platform",
        "channel_organization",
        "user",
    ],
)
def test_every_limit_handler_emits_one_attributable_warning(
    caplog: pytest.LogCaptureFixture,
    exc: RuntimeError,
    expected_fragments: tuple[str, ...],
) -> None:
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)

    _client_raising(exc).get("/_test/task-limit")

    records = [
        record
        for record in caplog.records
        if record.name == _LIMIT_LOGGER
        and "task lane limit rejected" in record.getMessage()
    ]
    assert len(records) == 1, "每次拒绝恰好一条，不多不少"

    message = records[0].getMessage()
    assert records[0].levelno == logging.WARNING
    for fragment in expected_fragments:
        assert fragment in message, f"{fragment!r} 不在 {message!r} 里"


def test_limit_log_never_carries_names_only_ids(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """可记业务 ID，不记用户名/项目名。"""
    caplog.set_level(logging.WARNING, logger=_LIMIT_LOGGER)

    _client_raising(
        ChannelTaskLimitExceeded(
            scope_kind="organization",
            org_id="org_9",
            queue_kind="video",
            limit=2,
            active=2,
        )
    ).get("/_test/task-limit")

    message = next(
        record.getMessage()
        for record in caplog.records
        if "task lane limit rejected" in record.getMessage()
    )
    assert "username" not in message
    assert "project_name" not in message
