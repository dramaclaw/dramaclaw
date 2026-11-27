from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.m02


def _patch_roots(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    output = tmp_path / "output"
    state = tmp_path / "state"
    runtime = tmp_path / "runtime"

    import novelvideo.api.deps as deps
    import novelvideo.api.routes.projects as project_routes
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
    monkeypatch.setattr(project_routes, "resolve_worker_id", lambda: "node_local", raising=False)
    monkeypatch.setattr(project_context, "resolve_worker_id", lambda: "node_local")


@pytest.fixture
def project_client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    from novelvideo.ports import registry
    from novelvideo.ports.local import project as local_project

    monkeypatch.setattr(registry, "_PORTS", {})
    monkeypatch.setattr(registry, "_BOOTSTRAPPED", False)
    _patch_roots(monkeypatch, tmp_path)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("DRAMACLAW_LOCAL_AGENT_TRUST", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_LOCAL_USERNAME", "alice")

    monkeypatch.setattr(local_project, "resolve_worker_id", lambda: "node_local", raising=False)
    registry.ensure_bootstrap()

    from novelvideo.api.app import create_app

    app = create_app()
    app.router.on_startup.clear()
    app.router.on_shutdown.clear()
    return TestClient(app), registry


def test_ce_project_create_list_detail_and_project_context_contract(
    tmp_path: Path,
    project_client,
) -> None:
    client, _ = project_client

    with client:
        created = client.post("/api/v1/projects", json={"name": "demo"})
        assert created.status_code == 200
        body = created.json()
        project_id = body["data"]["project_id"]
        assert body["ok"] is True
        assert body["data"]["id"] == project_id
        assert len(project_id) == 26

        too_long = client.post("/api/v1/projects", json={"name": "a" * 65})
        assert too_long.status_code == 422
        assert "64" in too_long.text
        detail = too_long.json()["detail"]
        assert isinstance(detail, list)
        assert any(
            item["loc"] == ["body", "name"]
            and item["type"] == "string_too_long"
            and item["ctx"]["max_length"] == 64
            for item in detail
        )

        listed = client.get("/api/v1/projects")
        assert listed.status_code == 200
        assert listed.json()["data"] == [
            {
                "id": project_id,
                "name": "demo",
                "owner_username": "alice",
                "owner_type": "user",
                "owner_id": "local",
                "effective_role": "owner",
                "home_node_id": "local",
                "status": "active",
            }
        ]

        detail = client.get(f"/api/v1/projects/{project_id}")
        assert detail.status_code == 200
        data = detail.json()["data"]
        assert data["project_id"] == project_id
        assert data["name"] == "demo"
        assert data["owner_username"] == "alice"
        assert data["effective_role"] == "owner"
        assert data["home_node_id"] == "local"
        assert data["status"] == "active"

    payload = tmp_path / "state" / "alice" / "demo" / "project.json"
    assert not payload.exists()
    assert (tmp_path / "state" / "local" / "projects.db").exists()


@pytest.mark.parametrize(
    "agent_session,allowed_projects,expected_ids",
    [
        (True, ("01ARZ3NDEKTSV4RRFFQ69G5FAV",), {"01ARZ3NDEKTSV4RRFFQ69G5FAV"}),
        (True, (), {"01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"}),
        (False, (), {"01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"}),
    ],
    ids=["restricted-agent", "unrestricted-agent", "browser"],
)
def test_list_projects_respects_agent_session_allowlist(
    project_client, monkeypatch, agent_session, allowed_projects, expected_ids
) -> None:
    from novelvideo.ports.auth_contract import AgentAuthenticatedUser
    from novelvideo.ports.local import project as local_project

    client, registry = project_client
    project_ids = iter(("01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"))
    monkeypatch.setattr(local_project, "ULID", lambda: next(project_ids))

    async def verify_agent_session(_token):
        return AgentAuthenticatedUser(
            id="local", username="alice", role="owner", allowed_projects=allowed_projects
        ).to_legacy_dict()

    monkeypatch.setattr(
        registry.get_port("auth_session"), "verify_agent_session", verify_agent_session
    )
    headers = (
        {"Authorization": "Bearer example"} if agent_session else {"Cookie": "st_session=browser"}
    )

    with client:
        for name in ("alpha", "beta"):
            created = client.post("/api/v1/projects", json={"name": name})
            assert created.status_code == 200, created.text

        listed = client.get("/api/v1/projects", headers=headers)
        assert listed.status_code == 200, listed.text
        assert {project["id"] for project in listed.json()["data"]} == expected_ids


def _create_project_with_status(client, registry, name, status):
    created = client.post("/api/v1/projects", json={"name": name})
    assert created.status_code == 200, created.text
    project_id = created.json()["data"]["project_id"]
    updated = asyncio.run(
        registry.get_port("project_registry").update_project_status(project_id, status)
    )
    assert updated is not None and updated.status == status and not updated.purged_at
    return project_id


def _agent_headers(monkeypatch, registry, *, project_id=None, external=True):
    from novelvideo.ports.auth_contract import AgentAuthenticatedUser

    async def verify_agent_session(_token):
        return AgentAuthenticatedUser(
            id="local",
            username="alice",
            role="owner",
            scopes=("projects:read", "projects:write"),
            current_scope_kind="project" if project_id else "home",
            current_project_id=project_id,
            external_agent_key_id="key-1" if external else None,
        ).to_legacy_dict()

    monkeypatch.setattr(
        registry.get_port("auth_session"), "verify_agent_session", verify_agent_session
    )
    return {"Authorization": "Bearer example"}


def test_project_list_hides_deleted_projects_only_from_external_agent_keys(
    project_client, monkeypatch
):
    client, registry = project_client
    with client:
        deleted_id = _create_project_with_status(client, registry, "deleted_project", "deleted")
        archived_id = _create_project_with_status(client, registry, "archived_project", "archived")
        external_headers = _agent_headers(monkeypatch, registry)
        browser = client.get("/api/v1/projects", headers={"Cookie": "st_session=browser"})
        external = client.get("/api/v1/projects", headers=external_headers)
        in_app_headers = _agent_headers(monkeypatch, registry, external=False)
        in_app = client.get("/api/v1/projects", headers=in_app_headers)

    assert browser.status_code == 200, browser.text
    assert external.status_code == 200, external.text
    assert in_app.status_code == 200, in_app.text
    visible_projects = {
        deleted_id: "deleted",
        archived_id: "archived",
    }
    for response in (browser, in_app):
        assert {
            record["id"]: record["status"] for record in response.json()["data"]
        } == visible_projects
    assert {record["id"]: record["status"] for record in external.json()["data"]} == {
        archived_id: "archived",
    }


@pytest.mark.parametrize("method", ["GET", "PATCH"], ids=["list-canvases", "update-project"])
@pytest.mark.parametrize("status,expected_status", [("deleted", 409), ("archived", 200)])
def test_external_agent_project_routes_respect_project_status(
    project_client, monkeypatch, method, status, expected_status
):
    client, registry = project_client
    with client:
        project_id = _create_project_with_status(client, registry, "demo", status)
        headers = _agent_headers(monkeypatch, registry, project_id=project_id)
        path = f"/api/v1/projects/{project_id}"
        if method == "GET":
            response = client.get(path + "/freezone/canvases", headers=headers)
        else:
            response = client.patch(path, headers=headers, json={"aspect_ratio": "16:9"})

    assert response.status_code == expected_status, response.text
    if status == "deleted":
        assert response.json()["detail"]["code"] == "agent_key_project_deleted"


@pytest.mark.parametrize("credential", ["browser", "in-app-agent", "local-trusted-agent"])
def test_deleted_project_canvases_are_readable_without_an_external_key(
    project_client, monkeypatch, credential
):
    client, registry = project_client
    with client:
        project_id = _create_project_with_status(client, registry, "demo", "deleted")

    headers = {}
    if credential == "in-app-agent":
        headers = _agent_headers(monkeypatch, registry, project_id=project_id, external=False)
    elif credential == "browser":
        headers = {"Cookie": "st_session=browser"}
    else:
        monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "1")
        client = TestClient(
            client.app, base_url="http://localhost", client=("127.0.0.1", 50000)
        )

    with client:
        if credential == "local-trusted-agent":
            identity = client.get("/api/v1/auth/me")
            assert identity.status_code == 200, identity.text
            assert identity.json()["data"]["credential_kind"] == "local_trusted_agent"
        response = client.get(
            f"/api/v1/projects/{project_id}/freezone/canvases", headers=headers
        )

    assert response.status_code == 200, response.text


def test_external_agent_scope_mismatch_takes_precedence_over_deleted_project(
    project_client, monkeypatch
):
    client, registry = project_client
    with client:
        deleted_id = _create_project_with_status(client, registry, "deleted_project", "deleted")
        other_id = _create_project_with_status(client, registry, "other_project", "active")
        headers = _agent_headers(monkeypatch, registry, project_id=other_id)
        response = client.get(
            f"/api/v1/projects/{deleted_id}/freezone/canvases", headers=headers
        )

    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "Agent session scope mismatch"
