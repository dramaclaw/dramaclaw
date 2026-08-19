from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from novelvideo.models import NovelScene
from novelvideo.ports.authz import AuthzError
from novelvideo.project_context import ProjectContext
from novelvideo.shared.billing_errors import (
    BillingError,
    BillingRuleNotConfiguredError,
    InsufficientCreditsError,
)
from novelvideo.task_backend.limits import ProjectUserTaskLimitExceeded


class _SceneStore:
    async def get_scene(self, name: str) -> NovelScene | None:
        if name == "中庭":
            return NovelScene(name=name)
        return None


class _GenericBillingError(BillingError):
    error_code = "GENERIC_BILLING_ERROR"
    http_status = 418
    user_message = "generic billing failure"


@pytest.fixture()
def scene_task_start_client(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from novelvideo.api.app import create_app
    from novelvideo.api.routes import scenes
    from novelvideo.director_world import stage_manifest
    from novelvideo.utils.path_resolver import canonical_scene_master_path

    project_dir = tmp_path / "output" / "alice" / "demo"
    project_dir.mkdir(parents=True)
    master_path = canonical_scene_master_path(project_dir, "中庭")
    master_path.parent.mkdir(parents=True)
    master_path.write_bytes(b"png")
    pano_path = stage_manifest.stage_dir(project_dir, "中庭") / "pano_360.png"
    pano_path.parent.mkdir(parents=True)
    pano_path.write_bytes(b"png")
    stage_manifest.update_manifest(project_dir, "中庭", pano_path=pano_path.name)
    ctx = ProjectContext(
        project_id="proj_scenes",
        project_name="demo",
        owner_type="user",
        owner_id="alice-id",
        owner_username="alice",
        requester_user_id="alice-id",
        requester_username="alice",
        requester_principals=(),
        effective_role="owner",
        home_node_id="local",
        output_dir=project_dir,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )
    store = _SceneStore()

    async def resolve_scene_project(*_args, **_kwargs):
        return ctx, "alice", "demo", project_dir, str(project_dir), store

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_scene_project)

    def build(exc: RuntimeError) -> TestClient:
        async def enqueue_project_task(*_args, **_kwargs):
            raise exc

        monkeypatch.setattr(
            scenes,
            "get_task_backend",
            lambda: SimpleNamespace(enqueue_project_task=enqueue_project_task),
        )
        app = create_app()
        app.dependency_overrides[scenes.get_api_user] = lambda: {
            "id": "alice-id",
            "username": "alice",
        }
        return TestClient(app, raise_server_exceptions=False)

    return build


def test_scene_single_face_task_start_preserves_billing_error(
    scene_task_start_client,
) -> None:
    billing = InsufficientCreditsError(user_id="alice-id", cost=40, balance=8)
    wrapper = RuntimeError("failed to enqueue stage asset")
    wrapper.__cause__ = billing
    client = scene_task_start_client(wrapper)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/3gs/master-ply/generate-async"
    )

    assert response.status_code == 402
    assert response.json()["data"] == {
        "error_code": "INSUFFICIENT_CREDITS",
        "message": "积分不足，请联系管理员充值",
        "user_id": "alice-id",
        "required": 40,
        "balance": 8,
    }


def test_scene_task_start_prefers_wrapped_insufficient_credits(
    scene_task_start_client,
) -> None:
    outer = _GenericBillingError("generic billing failure")
    outer.__cause__ = InsufficientCreditsError(
        user_id="alice-id",
        cost=40,
        balance=8,
    )
    client = scene_task_start_client(outer)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/3gs/master-ply/generate-async"
    )

    assert response.status_code == 402
    assert response.json()["data"]["error_code"] == "INSUFFICIENT_CREDITS"


def test_scene_task_start_prefers_wrapped_missing_billing_rule(
    scene_task_start_client,
) -> None:
    outer = _GenericBillingError("generic billing failure")
    outer.__cause__ = BillingRuleNotConfiguredError(
        kind="feature",
        key="scene.pano",
    )
    client = scene_task_start_client(outer)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/3gs/master-ply/generate-async"
    )

    assert response.status_code == 409
    assert response.json()["data"]["error_code"] == "BILLING_RULE_NOT_CONFIGURED"


def test_scene_pano_task_start_preserves_billing_error(scene_task_start_client) -> None:
    billing = InsufficientCreditsError(user_id="alice-id", cost=60, balance=7)
    wrapper = RuntimeError("failed to enqueue stage asset")
    wrapper.__cause__ = billing
    client = scene_task_start_client(wrapper)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/3gs/pano-ply/generate-async"
    )

    assert response.status_code == 402
    assert response.json()["data"]["required"] == 60
    assert response.json()["data"]["balance"] == 7


def test_scene_pano_generation_task_start_preserves_billing_error(
    scene_task_start_client,
) -> None:
    billing = InsufficientCreditsError(user_id="alice-id", cost=80, balance=6)
    wrapper = RuntimeError("failed to enqueue scene pano generation")
    wrapper.__cause__ = billing
    client = scene_task_start_client(wrapper)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/pano/generate-async",
        json={"source": "text"},
    )

    assert response.status_code == 402
    assert response.json()["data"]["required"] == 80
    assert response.json()["data"]["balance"] == 6


def test_scene_pano_generation_keeps_legacy_response_for_plain_runtime_error(
    scene_task_start_client,
) -> None:
    client = scene_task_start_client(RuntimeError("broker unavailable"))

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/pano/generate-async",
        json={"source": "text"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": "broker unavailable"}


def test_scene_single_face_task_start_preserves_authz_error(
    scene_task_start_client,
) -> None:
    denial = AuthzError("ORG_CREDENTIAL_MISSING")
    wrapper = RuntimeError("failed to enqueue stage asset")
    wrapper.__cause__ = denial
    client = scene_task_start_client(wrapper)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/3gs/master-ply/generate-async"
    )

    assert response.status_code == 409
    assert response.json()["data"]["error_code"] == "ORG_CREDENTIAL_MISSING"


def test_scene_pano_task_start_preserves_task_limit_error(
    scene_task_start_client,
) -> None:
    limit = ProjectUserTaskLimitExceeded(
        project_id="proj_scenes",
        requester_user_id="alice-id",
        queue_kind="world",
        limit=1,
        active=1,
    )
    client = scene_task_start_client(limit)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/3gs/pano-ply/generate-async"
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == "user"
    assert response.json()["data"]["queue_kind"] == "world"


def test_scene_task_start_preserves_wrapped_task_limit_error(
    scene_task_start_client,
) -> None:
    limit = ProjectUserTaskLimitExceeded(
        project_id="proj_scenes",
        requester_user_id="alice-id",
        queue_kind="world",
        limit=1,
        active=1,
    )
    wrapper = RuntimeError("failed to enqueue stage asset")
    wrapper.__cause__ = limit
    client = scene_task_start_client(wrapper)

    response = client.post(
        "/api/v1/projects/demo/scenes/中庭/3gs/master-ply/generate-async"
    )

    assert response.status_code == 429
    assert response.json()["data"]["limit_scope"] == "user"
    assert response.json()["data"]["queue_kind"] == "world"


@pytest.mark.parametrize(
    "endpoint",
    [
        "/api/v1/projects/demo/scenes/中庭/3gs/master-ply/generate-async",
        "/api/v1/projects/demo/scenes/中庭/3gs/pano-ply/generate-async",
    ],
)
def test_scene_task_start_keeps_legacy_response_for_plain_runtime_error(
    scene_task_start_client,
    endpoint: str,
) -> None:
    client = scene_task_start_client(RuntimeError("broker unavailable"))

    response = client.post(endpoint)

    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": "broker unavailable"}
