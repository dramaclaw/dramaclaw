from contextlib import asynccontextmanager
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.auth import get_api_user


def _harness(monkeypatch, tmp_path):
    from novelvideo.api.routes import hybrid_drama

    resolved = SimpleNamespace(
        ctx=SimpleNamespace(project_id="project-1", project_name="Demo"),
        project_dir=tmp_path / "output",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )
    store = object()
    resolutions = []

    async def resolve(project, user, *, required_role):
        resolutions.append(
            {"project": project, "user": user, "required_role": required_role}
        )
        return resolved

    @asynccontextmanager
    async def store_scope(ctx):
        assert ctx is resolved.ctx
        yield store

    monkeypatch.setattr(hybrid_drama, "resolve_project_scope", resolve)
    monkeypatch.setattr(hybrid_drama, "sqlite_store_for_context_scope", store_scope)
    app = FastAPI()
    app.include_router(hybrid_drama.router, prefix="/api/v1")
    user = {"id": "user-1", "username": "alice", "role": "owner"}
    app.dependency_overrides[get_api_user] = lambda: user
    return hybrid_drama, app, resolved, store, resolutions, user


def test_prepare_route_is_registered_and_uses_editor_scoped_store(monkeypatch, tmp_path):
    from novelvideo.api import api_router

    hybrid_drama, app, resolved, store, resolutions, user = _harness(
        monkeypatch, tmp_path
    )
    calls = []

    async def prepare(resolved_arg, store_arg, **kwargs):
        calls.append((resolved_arg, store_arg, kwargs))
        return {
            "run_id": "run-1",
            "beat_key": "project-1:2:3",
            "prompt": "Scene",
            "reference_ids": [],
            "has_dialogue": False,
            "max_cost_usd": "10",
            "max_attempts": 1,
            "resolution": "720p",
        }

    monkeypatch.setattr(hybrid_drama, "prepare_run", prepare)

    response = TestClient(app).post(
        "/api/v1/projects/project-1/hybrid-drama/runs/prepare",
        json={
            "episode_number": 2,
            "beat_number": 3,
            "max_cost_usd": "10",
            "run_id": "run-1",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["data"]["max_attempts"] == 1
    assert calls == [
        (
            resolved,
            store,
            {
                "episode_number": 2,
                "beat_number": 3,
                "max_cost_usd": "10",
                "run_id": "run-1",
            },
        )
    ]
    assert resolutions == [
        {"project": "project-1", "user": user, "required_role": "editor"}
    ]
    registered_app = FastAPI()
    registered_app.include_router(api_router)
    assert (
        "/api/v1/projects/{project}/hybrid-drama/runs/prepare"
        in registered_app.openapi()["paths"]
    )


def test_submit_defaults_to_one_attempt_and_status_uses_viewer_scope(
    monkeypatch, tmp_path
):
    hybrid_drama, app, resolved, _store, resolutions, user = _harness(
        monkeypatch, tmp_path
    )
    monkeypatch.setenv("BYTEPLUS_MODEL_ARK_API_KEY", '  "provider-key"  ')
    calls = []

    async def submit(resolved_arg, run_id, **kwargs):
        calls.append(("submit", resolved_arg, run_id, kwargs))
        return {"run_id": run_id, "status": "in_progress", "tasks": []}

    def status(resolved_arg, run_id):
        calls.append(("status", resolved_arg, run_id))
        return {"run_id": run_id, "status": "prepared", "tasks": []}

    monkeypatch.setattr(hybrid_drama, "submit_prepared_run", submit)
    monkeypatch.setattr(hybrid_drama, "get_run_status", status)
    client = TestClient(app)

    submitted = client.post(
        "/api/v1/projects/project-1/hybrid-drama/runs/run-1/submit", json={}
    )
    fetched = client.get(
        "/api/v1/projects/project-1/hybrid-drama/runs/run-1/status"
    )

    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["data"]["status"] == "in_progress"
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["data"]["status"] == "prepared"
    assert calls == [
        (
            "submit",
            resolved,
            "run-1",
            {
                "max_attempts": 1,
                "manual_retry": False,
                "api_key": "provider-key",
            },
        ),
        ("status", resolved, "run-1"),
    ]
    assert resolutions == [
        {"project": "project-1", "user": user, "required_role": "editor"},
        {"project": "project-1", "user": user, "required_role": "viewer"},
    ]


def test_poll_route_uses_provider_key_and_editor_scope(monkeypatch, tmp_path):
    hybrid_drama, app, resolved, _store, resolutions, user = _harness(
        monkeypatch, tmp_path
    )
    monkeypatch.delenv("BYTEPLUS_MODEL_ARK_API_KEY", raising=False)
    monkeypatch.setenv("ARK_API_KEY", "fallback-provider-key")
    calls = []

    async def poll(resolved_arg, run_id, **kwargs):
        calls.append((resolved_arg, run_id, kwargs))
        return {"run_id": run_id, "status": "in_progress", "tasks": []}

    monkeypatch.setattr(hybrid_drama, "poll_run", poll)

    response = TestClient(app).post(
        "/api/v1/projects/project-1/hybrid-drama/runs/run-1/poll"
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "in_progress"
    assert calls == [(resolved, "run-1", {"api_key": "fallback-provider-key"})]
    assert resolutions == [
        {"project": "project-1", "user": user, "required_role": "editor"}
    ]


def test_review_route_accepts_hash_and_evidence_without_candidate_paths(
    monkeypatch, tmp_path
):
    hybrid_drama, app, resolved, _store, resolutions, user = _harness(
        monkeypatch, tmp_path
    )
    calls = []

    async def review(resolved_arg, run_id, **kwargs):
        calls.append((resolved_arg, run_id, kwargs))
        return {
            "candidate_sha256": kwargs["candidate_sha256"],
            "beat_key": "project-1:2:3",
            "request_sha256": "request-hash",
            "decision": kwargs["decision"],
            "created_at": "2026-11-09T00:00:00+00:00",
        }

    monkeypatch.setattr(hybrid_drama, "review_run_candidate", review)
    evidence = {
        "contact_sheet": "every frame inspected",
        "motion_strip": "full motion inspected",
        "audio": "full audio inspected",
    }

    response = TestClient(app).post(
        "/api/v1/projects/project-1/hybrid-drama/runs/run-1/review",
        json={
            "candidate_sha256": "a" * 64,
            "decision": "adopt",
            "evidence": evidence,
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"]["decision"] == "adopt"
    assert calls == [
        (
            resolved,
            "run-1",
            {
                "candidate_sha256": "a" * 64,
                "decision": "adopt",
                "evidence": evidence,
            },
        )
    ]
    assert resolutions == [
        {"project": "project-1", "user": user, "required_role": "editor"}
    ]


def test_assemble_and_finalize_routes_use_only_server_side_media_selection(
    monkeypatch, tmp_path
):
    from novelvideo.api import api_router

    hybrid_drama, app, resolved, _store, resolutions, user = _harness(
        monkeypatch, tmp_path
    )
    calls = []

    async def assemble(resolved_arg, run_id):
        calls.append(("assemble", resolved_arg, run_id))
        return {
            "media_sha256": "b" * 64,
            "candidate_sha256": ["a" * 64],
            "request_sha256": ["request-hash"],
            "review_sha256": ["review-hash"],
            "created_at": "2026-11-09T00:00:00+00:00",
        }

    async def finalize(resolved_arg, run_id, **kwargs):
        calls.append(("finalize", resolved_arg, run_id, kwargs))
        return {"status": "complete", "media_sha256": kwargs["media_sha256"]}

    monkeypatch.setattr(hybrid_drama, "assemble_run", assemble)
    monkeypatch.setattr(hybrid_drama, "finalize_run", finalize)
    client = TestClient(app)
    review = {"passed": True, "audible_defects": [], "dialogue_present": False}

    assembled = client.post(
        "/api/v1/projects/project-1/hybrid-drama/runs/run-1/assemble"
    )
    finalized = client.post(
        "/api/v1/projects/project-1/hybrid-drama/runs/run-1/finalize",
        json={"media_sha256": "b" * 64, "review": review},
    )

    assert assembled.status_code == 200, assembled.text
    assert assembled.json()["data"]["media_sha256"] == "b" * 64
    assert finalized.status_code == 200, finalized.text
    assert finalized.json()["data"] == {
        "status": "complete",
        "media_sha256": "b" * 64,
    }
    assert calls == [
        ("assemble", resolved, "run-1"),
        (
            "finalize",
            resolved,
            "run-1",
            {"media_sha256": "b" * 64, "review": review},
        ),
    ]
    assert resolutions == [
        {"project": "project-1", "user": user, "required_role": "editor"},
        {"project": "project-1", "user": user, "required_role": "editor"},
    ]
    registered_app = FastAPI()
    registered_app.include_router(api_router)
    paths = registered_app.openapi()["paths"]
    prefix = "/api/v1/projects/{project}/hybrid-drama/runs"
    assert {
        f"{prefix}/prepare",
        f"{prefix}/{{run_id}}/submit",
        f"{prefix}/{{run_id}}/poll",
        f"{prefix}/{{run_id}}/status",
        f"{prefix}/{{run_id}}/review",
        f"{prefix}/{{run_id}}/assemble",
        f"{prefix}/{{run_id}}/finalize",
    } <= set(paths)
