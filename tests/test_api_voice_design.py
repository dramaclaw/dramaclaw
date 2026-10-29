"""Contract fixtures; the ASGI app below is deliberately not the production app."""

from importlib import import_module

import pytest
from pydantic import ValidationError


REQUEST_ID = "178727cd-e421-451c-87e7-68779d72a8ec"
SAVE_ID = "ca8fd0be-a220-4de4-bf4e-8d430788b698"
CREATE = {
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
