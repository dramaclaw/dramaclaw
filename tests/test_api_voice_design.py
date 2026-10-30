"""Contract fixtures; the ASGI app below is deliberately not the production app."""

from importlib import import_module

import pytest
from pydantic import ValidationError


REQUEST_ID = "178727cd-e421-451c-87e7-68779d72a8ec"
SAVE_ID = "ca8fd0be-a220-4de4-bf4e-8d430788b698"
CREATE = {
    "surface": "supertale",
    "request_id": REQUEST_ID,
    "description": " 六十岁左右的男人 ",
    "preview_text": " 今天的天气很好，我们沿着河边慢慢走回家。 ",
}


def contract():
    return import_module("novelvideo.api.routes.voice_design")


def test_create_normalizes_unicode_and_defaults():
    model = contract().VoiceDesignCreateRequest.model_validate(CREATE)
    assert model.description == "六十岁左右的男人"
    assert model.preview_text == CREATE["preview_text"].strip()
    assert model.language == "zh"
    assert model.model_dump(mode="json")["request_id"] == REQUEST_ID


@pytest.mark.parametrize(
    "field,value",
    [
        ("request_id", "../bad"),
        ("description", "  "),
        ("description", "声" * 501),
        ("preview_text", "字" * 14),
        ("preview_text", "字" * 61),
        ("language", "fr"),
        ("model", "voice-enrollment"),
        ("description", 123),
    ],
)
def test_create_rejects_invalid_input(field, value):
    with pytest.raises(ValidationError):
        contract().VoiceDesignCreateRequest.model_validate({**CREATE, field: value})


READY = {
    "candidate_id": REQUEST_ID,
    "status": "ready",
    "description": "沙哑男声",
    "preview_text": CREATE["preview_text"].strip(),
    "language": "zh",
    "preview_url": f"/api/v1/projects/demo/voice-design/candidates/{REQUEST_ID}/audio",
    "mime_type": "audio/mpeg",
    "duration_seconds": 8.4,
    "sha256": "a" * 64,
    "created_at": "2026-10-30T00:00:00Z",
    "expires_at": "2026-10-30T01:00:00Z",
}
FAILURE = {
    "code": "provider_unavailable",
    "message": "服务暂时不可用",
    "retryable": True,
}
CANDIDATES = {
    "generating": {"candidate_id": REQUEST_ID, "status": "generating"},
    "ready": READY,
    "failed": {"candidate_id": REQUEST_ID, "status": "failed", "failure": FAILURE},
    "unknown": {
        "candidate_id": REQUEST_ID,
        "status": "unknown",
        "failure": {
            "code": "generation_unknown",
            "message": "请先查询原请求",
            "retryable": True,
        },
    },
    "expired": {"candidate_id": REQUEST_ID, "status": "expired"},
}
SAVE_CHARACTER = {
    "save_request_id": SAVE_ID,
    "candidate_id": REQUEST_ID,
    "expected_slot": {"path": "", "sha256": "", "updated_at": ""},
}
SAVE_USER = {"save_request_id": SAVE_ID, "candidate_id": REQUEST_ID, "name": "沙哑男声"}
SLOT = {
    "slot": "default",
    "label": "默认",
    "path": "voices/default.mp3",
    "url": "/audio",
    "sha256": "a" * 64,
    "updated_at": "2026-10-30T00:00:00Z",
    "inherited_from_default": False,
    "required": True,
}
USER_VOICE = {
    "voice_id": "fv_0123456789abcdef",
    "scope": "user_custom",
    "label": "沙哑男声",
    "name": "沙哑男声",
    "path": "_account/freezone/audio/voices/fv_0123456789abcdef/reference.mp3",
    "url": "",
    "exists": True,
    "sha256": "a" * 64,
    "duration_ms": 8400,
    "mime_type": "audio/mpeg",
    "created_at": "2026-10-30T00:00:00Z",
    "updated_at": "2026-10-30T00:00:00Z",
    "source_filename": "reference.mp3",
}
# Independent expectations also freeze the HTTP/retry policy for all public errors.
ERRORS = [
    (401, "unauthenticated", False),
    (403, "voice_design_forbidden", False),
    (404, "project_not_found", False),
    (404, "character_not_found", False),
    (404, "candidate_not_found", False),
    (404, "candidate_audio_missing", False),
    (409, "idempotency_conflict", False),
    (409, "candidate_not_ready", True),
    (409, "slot_changed", False),
    (409, "slot_occupied", False),
    (410, "candidate_expired", False),
    (422, "invalid_input", False),
    (422, "content_rejected", False),
    (422, "candidate_duration_exceeded", False),
    (402, "insufficient_credits", False),
    (429, "rate_limited", True),
    (429, "voice_design_quota_exceeded", True),
    (502, "provider_unavailable", True),
    (502, "provider_bad_audio", True),
    (504, "generation_unknown", True),
    (503, "voice_design_unavailable", False),
    (500, "candidate_persist_failed", True),
    (500, "save_failed", True),
]


def error_fixture(code, retryable):
    return {
        "ok": False,
        "error": "可向用户展示的原因",
        "code": code,
        "retryable": retryable,
        "request_id": REQUEST_ID,
    }


@pytest.mark.parametrize("length", [15, 60])
def test_unicode_counts_codepoints_after_trim(length):
    value = contract().VoiceDesignCreateRequest.model_validate(
        {
            **CREATE,
            "description": "声" * 500,
            "preview_text": "  " + "😀" * length + "  ",
        }
    )
    assert len(value.preview_text) == length
    assert len(value.description) == 500


@pytest.mark.parametrize("state", CANDIDATES)
def test_candidate_states_and_http_expiry_boundary(state):
    from pydantic import TypeAdapter

    model = contract()
    parsed = TypeAdapter(model.Candidate).validate_python(CANDIDATES[state])
    assert parsed.status == state
    if state == "expired":
        with pytest.raises(ValidationError):
            model.CandidateResponse.model_validate(
                {"ok": True, "data": CANDIDATES[state]}
            )
    else:
        response = model.CandidateResponse.model_validate(
            {"ok": True, "data": CANDIDATES[state]}
        )
        assert response.model_dump(mode="json")["data"]["candidate_id"] == REQUEST_ID


@pytest.mark.parametrize(
    "state,missing",
    [("ready", key) for key in READY] + [("failed", "failure"), ("unknown", "failure")],
)
def test_state_required_fields(state, missing):
    value = {k: v for k, v in CANDIDATES[state].items() if k != missing}
    with pytest.raises(ValidationError):
        contract().CandidateResponse.model_validate({"ok": True, "data": value})


@pytest.mark.parametrize(
    "field,value",
    [
        ("duration_seconds", 15.1),
        ("duration_seconds", 0),
        ("duration_seconds", float("nan")),
        ("sha256", "A" * 64),
        ("mime_type", "text/plain"),
        ("preview_url", "https://provider.example/secret"),
        (
            "preview_url",
            f"/api/v1/projects/demo/voice-design/candidates/{SAVE_ID}/audio",
        ),
        ("created_at", "2026-10-30T00:00:00"),
        ("created_at", "2026-10-30T00:00:00+08:00"),
        ("expires_at", "2026-10-29T00:00:00Z"),
        ("voice", "provider-handle"),
    ],
)
def test_ready_rejects_invalid_media_metadata(field, value):
    with pytest.raises(ValidationError):
        contract().CandidateReady.model_validate({**READY, field: value})


def test_save_requests_and_existing_payloads():
    model = contract()
    assert (
        model.SaveCharacterVoiceRequest.model_validate(SAVE_CHARACTER).replace_existing
        is False
    )
    assert model.SaveCharacterVoiceRequest.model_validate(
        {**SAVE_CHARACTER, "replace_existing": True}
    ).replace_existing
    for cls, payload in [
        (model.CharacterVoiceResponse, SLOT),
        (model.UserVoiceResponse, USER_VOICE),
    ]:
        assert (
            cls.model_validate({"ok": True, "data": payload}).model_dump(mode="json")[
                "data"
            ]
            == payload
        )
    assert (
        model.SaveUserVoiceRequest.model_validate(
            {**SAVE_USER, "name": "  a\x00b  "}
        ).name
        == "ab"
    )
    assert (
        model.SaveUserVoiceRequest.model_validate({**SAVE_USER, "name": " "}).name
        == "未命名音色"
    )
    assert (
        len(
            model.SaveUserVoiceRequest.model_validate(
                {**SAVE_USER, "name": "声" * 90}
            ).name
        )
        == 80
    )


@pytest.mark.parametrize(
    "model_name,payload,field,value",
    [
        ("SaveCharacterVoiceRequest", SAVE_CHARACTER, "replace_existing", "true"),
        ("SaveCharacterVoiceRequest", SAVE_CHARACTER, "expected_slot", {"sha256": ""}),
        ("SaveCharacterVoiceRequest", SAVE_CHARACTER, "candidate_id", "../bad"),
        ("SaveUserVoiceRequest", SAVE_USER, "save_request_id", "../bad"),
        ("SaveUserVoiceRequest", SAVE_USER, "username", "other"),
        ("SaveUserVoiceRequest", SAVE_USER, "owner", "other"),
        ("SaveUserVoiceRequest", SAVE_USER, "name", 17),
    ],
)
def test_save_rejects_invalid_inputs(model_name, payload, field, value):
    with pytest.raises(ValidationError):
        getattr(contract(), model_name).model_validate({**payload, field: value})


@pytest.mark.parametrize("status,code,retryable", ERRORS)
def test_error_policy_and_retryability(status, code, retryable):
    model = contract()
    assert model.ERROR_POLICY[code] == (status, retryable)
    assert (
        model.VoiceDesignError.model_validate(error_fixture(code, retryable)).code
        == code
    )
    with pytest.raises(ValidationError):
        model.VoiceDesignError.model_validate(error_fixture(code, not retryable))
    with pytest.raises(ValidationError):
        model.Failure.model_validate(
            {"code": code, "message": "失败", "retryable": not retryable}
        )


@pytest.mark.parametrize(
    "details",
    [
        {"api_key": "secret"},
        {"path": "/internal/audio"},
        {"voice": "handle"},
        {"field": "api_key"},
        {"retry_after_seconds": -1},
        {"duration_seconds": float("inf")},
    ],
)
def test_error_details_reject_non_whitelisted_fields(details):
    with pytest.raises(ValidationError):
        contract().VoiceDesignError.model_validate(
            {**error_fixture("invalid_input", False), "details": details}
        )


@pytest.fixture
def client():
    from fastapi import FastAPI
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse
    from fastapi.testclient import TestClient

    model = contract()
    app = FastAPI()

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Do not echo Pydantic input, ctx or a raw exception in a public error.
        error = model.VoiceDesignError.model_validate(
            error_fixture("invalid_input", False)
        )
        return JSONResponse(
            status_code=422, content=error.model_dump(mode="json", exclude_none=True)
        )

    @app.post(
        "/candidates",
        response_model=model.CandidateAcceptedResponse,
        status_code=202,
        responses={422: {"model": model.VoiceDesignError}},
    )
    def create(body: model.VoiceDesignCreateRequest):
        return {
            "ok": True,
            "data": {"candidate_id": body.request_id, "status": "generating"},
        }

    @app.get(
        "/candidates/{state}",
        response_model=model.CandidateResponse,
        responses={410: {"model": model.VoiceDesignError}},
    )
    def query(state: str):
        if state == "expired":
            return JSONResponse(
                status_code=410, content=error_fixture("candidate_expired", False)
            )
        return {"ok": True, "data": CANDIDATES[state]}

    @app.post(
        "/save-character",
        response_model=model.CharacterVoiceResponse,
        responses={409: {"model": model.VoiceDesignError}},
    )
    def save_character(body: model.SaveCharacterVoiceRequest):
        if body.expected_slot.path and not body.replace_existing:
            return JSONResponse(
                status_code=409, content=error_fixture("slot_occupied", False)
            )
        return {"ok": True, "data": SLOT}

    @app.post("/save-user", response_model=model.UserVoiceResponse)
    def save_user(body: model.SaveUserVoiceRequest):
        return {
            "ok": True,
            "data": {**USER_VOICE, "name": body.name, "label": body.name},
        }

    return TestClient(app)


def test_asgi_envelopes_and_replacement(client):
    created = client.post("/candidates", json=CREATE)
    assert created.status_code == 202
    assert created.json() == {"ok": True, "data": CANDIDATES["generating"]}
    for state in ("ready", "failed", "unknown"):
        result = client.get(f"/candidates/{state}")
        assert result.status_code == 200
        assert result.json()["data"]["status"] == state
    expired = client.get("/candidates/expired")
    assert expired.status_code == 410
    assert expired.json()["code"] == "candidate_expired"
    invalid = client.post("/candidates", json={**CREATE, "api_key": "must-not-echo"})
    assert invalid.status_code == 422
    assert invalid.json() == error_fixture("invalid_input", False)
    assert "must-not-echo" not in invalid.text
    assert client.post("/save-character", json=SAVE_CHARACTER).json()["data"] == SLOT
    occupied = {
        **SAVE_CHARACTER,
        "expected_slot": {k: SLOT[k] for k in ("path", "sha256", "updated_at")},
    }
    denied = client.post("/save-character", json=occupied)
    assert denied.status_code == 409
    assert denied.json()["code"] == "slot_occupied"
    assert (
        client.post(
            "/save-character", json={**occupied, "replace_existing": True}
        ).status_code
        == 200
    )
    assert client.post("/save-user", json=SAVE_USER).json()["data"] == USER_VOICE


def test_openapi_exports_input_limits_discriminators_and_errors(client):
    schema = client.get("/openapi.json").json()
    components = schema["components"]["schemas"]
    create = components["VoiceDesignCreateRequest"]
    assert create["additionalProperties"] is False
    assert create["properties"]["preview_text"]["minLength"] == 15
    assert create["properties"]["preview_text"]["maxLength"] == 60
    assert create["properties"]["request_id"]["format"] == "uuid"
    query = schema["paths"]["/candidates/{state}"]["get"]["responses"]
    assert "410" in query
    ref = query["200"]["content"]["application/json"]["schema"]["$ref"].split("/")[-1]
    mapping = components[ref]["properties"]["data"]["discriminator"]["mapping"]
    assert set(mapping) == {"generating", "ready", "failed", "unknown"}
    assert set(components["ExpectedSlot"]["required"]) == {
        "path",
        "sha256",
        "updated_at",
    }
    assert (
        components["SaveCharacterVoiceRequest"]["properties"]["replace_existing"][
            "default"
        ]
        is False
    )
    assert components["ErrorDetails"]["additionalProperties"] is False


@pytest.fixture
def production_api(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from novelvideo.api.auth import get_api_user
    from novelvideo.project_context import ProjectContext
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    module = contract()
    ctx = ProjectContext(
        "project",
        "demo",
        "user",
        "owner",
        "owner",
        "user",
        "user",
        (),
        "editor",
        "local",
        tmp_path / "out",
        tmp_path / "state",
        tmp_path / "runtime",
        True,
    )
    state = SimpleNamespace(
        ctx=ctx,
        calls=[],
        enabled=True,
        queue_error=False,
        store=VoiceDesignStorage(ctx, quota_path=tmp_path / "quota.sqlite3"),
    )

    async def resolve(**kwargs):
        from fastapi import HTTPException

        if state.ctx.effective_role == "viewer" and kwargs["required_role"] == "editor":
            raise HTTPException(403, "secret path /private/config")
        return state.ctx

    class ServiceError(Exception):
        def __init__(self, code):
            self.code = code

    def enabled():
        if not state.enabled:
            raise ServiceError("voice_design_unavailable")
        return 20

    async def config(**kwargs):
        return SimpleNamespace(
            billing_params=lambda: {
                "feature_key": "audio.voice_design",
                "item_count": 1,
            }
        )

    async def enqueue(*args, **kwargs):
        state.calls.append(kwargs)
        if state.queue_error:
            raise RuntimeError("secret provider key")

    monkeypatch.setitem(
        sys.modules,
        "novelvideo.audio.voice_design_service",
        SimpleNamespace(
            ensure_voice_design_enabled=enabled,
            resolve_voice_design_config=config,
            VoiceDesignError=ServiceError,
        ),
    )
    monkeypatch.setattr(module, "resolve_project_context", resolve)
    monkeypatch.setattr(
        module,
        "VoiceDesignStorage",
        lambda ctx: VoiceDesignStorage(ctx, quota_path=tmp_path / "quota.sqlite3"),
    )
    monkeypatch.setattr(module, "enqueue_project_task", enqueue)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"user_id": "user"}
    state.client = TestClient(app)
    state.url = "/api/v1/projects/project/voice-design/candidates"
    return state


def test_real_create_replay_and_conflict(production_api):
    s = production_api
    first = s.client.post(s.url, json=CREATE)
    assert first.status_code == 202
    assert s.client.post(s.url, json=CREATE).json() == first.json()
    assert len(s.calls) == 1
    assert s.calls[0]["scope"] == s.store.task_scope(REQUEST_ID)
    assert s.calls[0]["payload"]["candidate_id"] == REQUEST_ID
    changed = s.client.post(s.url, json={**CREATE, "description": "different"})
    assert changed.status_code == 409
    assert changed.json()["code"] == "idempotency_conflict"


def test_real_queue_failure_recovers_same_candidate(production_api):
    s = production_api
    s.queue_error = True
    failed = s.client.post(s.url, json=CREATE)
    assert failed.status_code == 503
    assert "secret" not in failed.text
    assert s.store.get(REQUEST_ID)["status"] == "generating"
    s.queue_error = False
    assert s.client.post(s.url, json=CREATE).status_code == 202
    assert s.calls[0]["scope"] == s.calls[1]["scope"]
    s.store.claim(REQUEST_ID)
    s.store.mark_unknown(REQUEST_ID)
    assert s.client.post(s.url, json=CREATE).json()["data"]["status"] == "unknown"
    assert len(s.calls) == 2


def make_ready(s):
    from hashlib import sha256

    assert s.client.post(s.url, json=CREATE).status_code == 202
    s.store.claim(REQUEST_ID)
    path = s.store.output_path(REQUEST_ID)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"0123456789")
    s.store.complete(
        REQUEST_ID, duration_seconds=3, sha256=sha256(path.read_bytes()).hexdigest()
    )
    return path


def test_real_audio_range_etag_and_disabled_existing_access(production_api):
    from dataclasses import replace

    s = production_api
    make_ready(s)
    s.enabled = False
    s.ctx = replace(s.ctx, effective_role="viewer")
    assert s.client.get(s.url + "/" + REQUEST_ID).json()["data"]["status"] == "ready"
    audio = s.client.get(s.url + "/" + REQUEST_ID + "/audio")
    assert audio.content == b"0123456789"
    assert audio.headers["cache-control"] == "private, no-store"
    assert audio.headers["etag"].startswith('"')
    partial = s.client.get(
        s.url + "/" + REQUEST_ID + "/audio", headers={"range": "bytes=2-4"}
    )
    assert partial.status_code == 206 and partial.content == b"234"
    assert partial.headers["content-range"] == "bytes 2-4/10"
    assert (
        s.client.get(
            s.url + "/" + REQUEST_ID + "/audio", headers={"range": "bytes=20-30"}
        ).status_code
        == 416
    )
    assert (
        s.client.get(
            s.url + "/" + REQUEST_ID + "/audio", headers={"range": "bytes=0-1,3-4"}
        ).status_code
        == 416
    )
    assert len(s.calls) == 1
    assert s.client.post(s.url, json=CREATE).status_code == 403


def test_real_isolation_validation_and_missing_audio(production_api):
    from dataclasses import replace

    s = production_api
    path = make_ready(s)
    s.ctx = replace(s.ctx, requester_user_id="other")
    assert s.client.get(s.url + "/" + REQUEST_ID).status_code == 404
    assert s.client.get(s.url + "/" + REQUEST_ID + "/audio").status_code == 404
    s.ctx = replace(s.ctx, requester_user_id="user")
    path.unlink()
    assert (
        s.client.get(s.url + "/" + REQUEST_ID + "/audio").json()["code"]
        == "candidate_audio_missing"
    )
    invalid = s.client.post(s.url, json={**CREATE, "token": "top-secret"})
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "invalid_input"
    assert "top-secret" not in invalid.text
    s.enabled = False
    from uuid import uuid4

    assert (
        s.client.post(s.url, json={**CREATE, "request_id": str(uuid4())}).status_code
        == 503
    )


def test_real_pending_and_expired(production_api):
    s = production_api
    s.client.post(s.url, json=CREATE)
    assert s.client.get(s.url + "/" + REQUEST_ID + "/audio").status_code == 409
    s.store.claim(REQUEST_ID)
    s.store.mark_unknown(REQUEST_ID)
    assert (
        s.client.get(s.url + "/" + REQUEST_ID).json()["data"]["failure"]["code"]
        == "generation_unknown"
    )


def test_real_expired_candidate_returns_410(production_api):
    s = production_api
    make_ready(s)
    import sqlite3

    with sqlite3.connect(s.store.db_path) as db:
        db.execute("UPDATE candidates SET expires_at=0")
    for suffix in ["", "/audio"]:
        response = s.client.get(s.url + "/" + REQUEST_ID + suffix)
        assert response.status_code == 410
        assert response.json()["code"] == "candidate_expired"
    assert s.client.post(s.url, json=CREATE).status_code == 410


def test_real_authentication_failure_is_safe_envelope(production_api):
    from fastapi import HTTPException
    from novelvideo.api.auth import get_api_user

    s = production_api

    def denied():
        raise HTTPException(401, "secret authentication details")

    s.client.app.dependency_overrides[get_api_user] = denied
    response = s.client.get(s.url + "/" + REQUEST_ID)
    assert response.status_code == 401
    assert response.json()["code"] == "unauthenticated"
    assert "secret" not in response.text


def test_real_registration():
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from novelvideo.api import api_router
    from novelvideo.api.auth import get_api_user

    app = FastAPI()
    app.include_router(api_router)

    def denied():
        raise HTTPException(401)

    app.dependency_overrides[get_api_user] = denied
    client = TestClient(app)
    for suffix in ["", "/audio"]:
        response = client.get(
            f"/api/v1/projects/project/voice-design/candidates/{REQUEST_ID}{suffix}"
        )
        assert response.status_code == 401
        assert response.json()["code"] == "unauthenticated"


@pytest.mark.parametrize(
    "status,code",
    [
        (402, "insufficient_credits"),
        (429, "rate_limited"),
        (403, "voice_design_forbidden"),
    ],
)
def test_real_admission_failure_keeps_status_and_sanitizes(
    production_api, monkeypatch, status, code
):
    from fastapi import HTTPException

    s = production_api

    async def reject(*args, **kwargs):
        raise HTTPException(status, "secret credentials and paths")

    monkeypatch.setattr(contract(), "enqueue_project_task", reject)
    response = s.client.post(s.url, json=CREATE)
    assert response.status_code == status
    assert response.json()["code"] == code
    assert "secret" not in response.text


def test_surface_required_and_existing_categories_only():
    with pytest.raises(ValidationError):
        contract().VoiceDesignCreateRequest.model_validate(
            {k: v for k, v in CREATE.items() if k != "surface"}
        )
    with pytest.raises(ValidationError):
        contract().VoiceDesignCreateRequest.model_validate(
            {**CREATE, "surface": "audio"}
        )


@pytest.mark.parametrize(
    "surface,product_surface", [("supertale", "mainline"), ("canvas", "freezone")]
)
def test_source_persists_across_queue_recovery(
    production_api, surface, product_surface
):
    s = production_api
    body = {**CREATE, "surface": surface}
    s.queue_error = True
    assert s.client.post(s.url, json=body).status_code == 503
    s.queue_error = False
    assert s.client.post(s.url, json=body).status_code == 202
    assert s.store.get(REQUEST_ID)["surface"] == surface
    assert [call["product_surface"] for call in s.calls] == [
        product_surface,
        product_surface,
    ]
    changed = {**body, "surface": "canvas" if surface == "supertale" else "supertale"}
    response = s.client.post(s.url, json=changed)
    assert response.status_code == 409
    assert response.json()["code"] == "idempotency_conflict"
    assert len(s.calls) == 2


@pytest.mark.parametrize("surface", ["supertale", "canvas"])
def test_project_quote_uses_authorized_context(production_api, monkeypatch, surface):
    import sys
    from dataclasses import replace

    s = production_api
    seen = []

    async def quote(*, ctx, surface):
        seen.append((ctx, surface))
        return {
            "ok": True,
            "data": {"cost": 1, "display": "1", "unit": "call", "quantity": 1},
        }

    monkeypatch.setattr(
        sys.modules["novelvideo.audio.voice_design_service"],
        "quote_voice_design",
        quote,
        raising=False,
    )
    url = s.url.removesuffix("/candidates") + "/quote"
    response = s.client.get(url, params={"surface": surface})
    assert response.status_code == 200
    assert response.json()["data"]["cost"] == 1
    assert seen == [(s.ctx, surface)]
    assert s.client.get(url).status_code == 422
    assert s.client.get(url, params={"surface": "audio"}).status_code == 422
    s.ctx = replace(s.ctx, effective_role="viewer")
    assert s.client.get(url, params={"surface": surface}).status_code == 403
    assert len(seen) == 1


def test_actual_task_manager_isolates_requester_with_same_uuid(
    production_api, monkeypatch
):
    from dataclasses import replace
    from novelvideo.task_state import TaskStateManager

    manager = TaskStateManager()
    results = []

    async def enqueue(ctx, **kwargs):
        task, reserved = manager.reserve_task_for_project(
            ctx, kwargs["task_type"], 0, scope=kwargs["scope"], metadata={}
        )
        results.append((task.task_id, reserved))

    monkeypatch.setattr(contract(), "enqueue_project_task", enqueue)
    s = production_api
    assert s.client.post(s.url, json=CREATE).status_code == 202
    s.ctx = replace(s.ctx, requester_user_id="second-user")
    assert s.client.post(s.url, json=CREATE).status_code == 202
    assert [r[1] for r in results] == [True, True]
    assert results[0][0] != results[1][0]


def test_audio_rejects_symlink_parent(production_api):
    s = production_api
    path = make_ready(s)
    parent = path.parent
    moved = parent.with_name("formal")
    parent.rename(moved)
    parent.symlink_to(moved, target_is_directory=True)
    response = s.client.get(s.url + "/" + REQUEST_ID + "/audio")
    assert response.status_code == 500
    assert response.json()["code"] == "candidate_persist_failed"
    assert (moved / path.name).read_bytes() == b"0123456789"


def test_final_app_lifespan_cleans_old_users_without_requests(
    production_api, monkeypatch
):
    from importlib import import_module
    from types import SimpleNamespace
    from threading import Event
    from fastapi.testclient import TestClient
    from novelvideo.audio.voice_design_storage import sweep_candidates
    from novelvideo.ports import registry
    from novelvideo import sqlite_pragmas
    from novelvideo.shared import runtime_env
    from novelvideo.chat.director_auto import coordinator

    s = production_api
    path = make_ready(s)
    import sqlite3

    with sqlite3.connect(s.store.db_path) as db:
        db.execute("UPDATE candidates SET expires_at=1")

    async def noop(*args, **kwargs):
        pass

    original_get = registry.get_port
    monkeypatch.setattr(registry, "ensure_bootstrap", lambda: None)
    monkeypatch.setattr(
        registry,
        "get_port",
        lambda name: (
            SimpleNamespace(on_startup=noop, on_shutdown=noop)
            if name == "lifecycle"
            else original_get(name)
        ),
    )
    monkeypatch.setattr(sqlite_pragmas, "litestream_enabled", lambda: False)
    monkeypatch.setattr(runtime_env, "is_ce_effective", lambda: False)
    monkeypatch.setattr(coordinator, "resume", noop)
    monkeypatch.setattr(coordinator, "shutdown", noop)
    completed = Event()

    def sweep():
        sweep_candidates(quota_path=s.store.quota_path)
        completed.set()

    monkeypatch.setattr(contract(), "sweep_candidates", sweep)
    app = import_module("novelvideo.api.app").create_app()
    with TestClient(app):
        assert completed.wait(3)
        assert not path.exists()
        task = app.state.voice_design_cleanup
        assert not task.done()
    assert task.cancelled()
