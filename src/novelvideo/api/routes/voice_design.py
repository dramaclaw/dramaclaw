"""Voice design contracts and private candidate endpoints."""

from typing import Annotated, Generic, Literal, TypeVar
from uuid import UUID, uuid4
from datetime import datetime, timezone
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse, Response

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes.model_credits import (
    GenerationCreditSurface,
    _credit_product_surface,
)
from novelvideo.audio.voice_design_storage import (
    CandidateStorageError,
    VoiceDesignStorage,
)
from novelvideo.project_context import (
    resolve_project_context,
    require_project_home_node,
)
from novelvideo.task_backend.client import enqueue_project_task

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    StringConstraints,
    field_validator,
    model_validator,
)


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


Description = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=500),
]
PreviewText = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=15, max_length=60),
]
Language = Literal["zh", "en"]
VoiceSlot = Literal["default", "child", "youth", "middle", "elder"]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class VoiceDesignCreateRequest(ContractModel):
    request_id: UUID
    surface: GenerationCreditSurface
    description: Description
    preview_text: PreviewText
    language: Language = "zh"


ErrorCode = Literal[
    "unauthenticated",
    "voice_design_forbidden",
    "project_not_found",
    "character_not_found",
    "candidate_not_found",
    "candidate_audio_missing",
    "idempotency_conflict",
    "candidate_not_ready",
    "slot_changed",
    "slot_occupied",
    "candidate_expired",
    "invalid_input",
    "content_rejected",
    "candidate_duration_exceeded",
    "insufficient_credits",
    "rate_limited",
    "voice_design_quota_exceeded",
    "provider_unavailable",
    "provider_bad_audio",
    "generation_unknown",
    "voice_design_unavailable",
    "candidate_persist_failed",
    "save_failed",
]
ERROR_POLICY: dict[ErrorCode, tuple[int, bool]] = {
    "unauthenticated": (401, False),
    "voice_design_forbidden": (403, False),
    "project_not_found": (404, False),
    "character_not_found": (404, False),
    "candidate_not_found": (404, False),
    "candidate_audio_missing": (404, False),
    "idempotency_conflict": (409, False),
    "candidate_not_ready": (409, True),
    "slot_changed": (409, False),
    "slot_occupied": (409, False),
    "candidate_expired": (410, False),
    "invalid_input": (422, False),
    "content_rejected": (422, False),
    "candidate_duration_exceeded": (422, False),
    "insufficient_credits": (402, False),
    "rate_limited": (429, True),
    "voice_design_quota_exceeded": (429, True),
    "provider_unavailable": (502, True),
    "provider_bad_audio": (502, True),
    "generation_unknown": (504, True),
    "voice_design_unavailable": (503, False),
    "candidate_persist_failed": (500, True),
    "save_failed": (500, True),
}


class Failure(ContractModel):
    code: ErrorCode
    message: StrictStr
    retryable: StrictBool

    @model_validator(mode="after")
    def validate_retryable(self):
        if self.retryable != ERROR_POLICY[self.code][1]:
            raise ValueError("retryable does not match error code")
        return self


class ErrorDetails(ContractModel):
    field: (
        Literal[
            "request_id",
            "surface",
            "description",
            "preview_text",
            "language",
            "candidate_id",
            "save_request_id",
            "expected_slot",
            "replace_existing",
            "name",
            "slot",
        ]
        | None
    ) = None
    duration_seconds: Annotated[float, Field(gt=0, allow_inf_nan=False)] | None = None
    retry_after_seconds: Annotated[int, Field(strict=True, ge=0)] | None = None


class VoiceDesignError(ContractModel):
    ok: Literal[False] = False
    error: StrictStr
    code: ErrorCode
    retryable: StrictBool
    request_id: UUID
    details: ErrorDetails | None = None

    @model_validator(mode="after")
    def validate_retryable(self):
        if self.retryable != ERROR_POLICY[self.code][1]:
            raise ValueError("retryable does not match error code")
        return self


class CandidateGenerating(ContractModel):
    candidate_id: UUID
    status: Literal["generating"]


class CandidateReady(ContractModel):
    candidate_id: UUID
    status: Literal["ready"]
    description: Description
    preview_text: PreviewText
    language: Language
    preview_url: Annotated[
        str,
        StringConstraints(
            pattern=r"^/api/v1/projects/[^/]+/voice-design/candidates/[0-9a-f-]+/audio$"
        ),
    ]
    mime_type: Literal["audio/mpeg"]
    duration_seconds: Annotated[float, Field(gt=0, le=15, allow_inf_nan=False)]
    sha256: Sha256
    created_at: AwareDatetime
    expires_at: AwareDatetime

    @model_validator(mode="after")
    def validate_media_metadata(self):
        if not self.preview_url.endswith(f"/{self.candidate_id}/audio"):
            raise ValueError("preview URL must address this candidate")
        if (
            self.created_at.utcoffset().total_seconds()
            or self.expires_at.utcoffset().total_seconds()
        ):
            raise ValueError("timestamps must be UTC")
        if self.expires_at <= self.created_at:
            raise ValueError("expiry must follow creation")
        return self


class CandidateFailed(ContractModel):
    candidate_id: UUID
    status: Literal["failed"]
    failure: Failure


class CandidateUnknown(ContractModel):
    candidate_id: UUID
    status: Literal["unknown"]
    failure: Failure


class CandidateExpired(ContractModel):
    candidate_id: UUID
    status: Literal["expired"]


Candidate = Annotated[
    CandidateGenerating
    | CandidateReady
    | CandidateFailed
    | CandidateUnknown
    | CandidateExpired,
    Field(discriminator="status"),
]
QueryableCandidate = Annotated[
    CandidateGenerating | CandidateReady | CandidateFailed | CandidateUnknown,
    Field(discriminator="status"),
]
T = TypeVar("T")


class Success(ContractModel, Generic[T]):
    ok: Literal[True] = True
    data: T


CandidateResponse = Success[QueryableCandidate]
CandidateAcceptedResponse = Success[CandidateGenerating]


class ExpectedSlot(ContractModel):
    path: StrictStr
    sha256: Annotated[str, StringConstraints(pattern=r"^(?:[0-9a-f]{64})?$")]
    updated_at: StrictStr


class SaveCharacterVoiceRequest(ContractModel):
    save_request_id: UUID
    candidate_id: UUID
    expected_slot: ExpectedSlot
    replace_existing: StrictBool = False


class SaveUserVoiceRequest(ContractModel):
    save_request_id: UUID
    candidate_id: UUID
    name: StrictStr

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        from novelvideo.freezone.audio_node import _safe_voice_name

        return _safe_voice_name(value)


class CharacterVoiceSlot(ContractModel):
    slot: VoiceSlot
    label: StrictStr
    path: StrictStr
    url: StrictStr
    sha256: StrictStr
    updated_at: StrictStr
    inherited_from_default: StrictBool
    required: StrictBool


class UserCustomVoice(ContractModel):
    voice_id: Annotated[str, StringConstraints(pattern=r"^fv_[A-Za-z0-9_-]+$")]
    scope: Literal["user_custom"]
    label: StrictStr
    name: StrictStr
    path: StrictStr
    url: StrictStr
    exists: StrictBool
    sha256: StrictStr
    duration_ms: Annotated[int, Field(ge=0, strict=True)]
    mime_type: StrictStr
    created_at: StrictStr
    updated_at: StrictStr
    source_filename: StrictStr


CharacterVoiceResponse = Success[CharacterVoiceSlot]
UserVoiceResponse = Success[UserCustomVoice]


_PUBLIC_MESSAGES = {
    "unauthenticated": "请先登录",
    "voice_design_forbidden": "没有执行此操作的权限",
    "project_not_found": "项目不存在",
    "candidate_not_found": "生成结果不存在",
    "candidate_audio_missing": "试听文件不存在",
    "candidate_expired": "生成结果已过期，请重新生成",
    "candidate_not_ready": "生成结果尚不可用",
    "idempotency_conflict": "请求标识已用于不同内容",
    "invalid_input": "请检查输入内容",
    "generation_unknown": "生成结果未知，请查询原请求后再决定是否重新生成",
    "voice_design_unavailable": "声音设计暂不可用",
    "voice_design_quota_exceeded": "今日生成额度已用完",
    "rate_limited": "请求过于频繁，请稍后重试",
}


def _message(code):
    return _PUBLIC_MESSAGES.get(code, "声音设计操作失败，请稍后重试")


def _error(code, request_id):
    return JSONResponse(
        status_code=ERROR_POLICY[code][0],
        content=VoiceDesignError(
            code=code,
            error=_message(code),
            retryable=ERROR_POLICY[code][1],
            request_id=request_id,
        ).model_dump(mode="json", exclude_none=True),
    )


class VoiceDesignRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def safe_handler(request: Request):
            request_id = uuid4()
            try:
                candidate_id = request.path_params.get("candidate_id")
                if candidate_id:
                    request_id = UUID(candidate_id)
                elif request.method == "POST":
                    body = await request.json()
                    if isinstance(body, dict):
                        request_id = UUID(str(body.get("request_id")))
            except (ValueError, TypeError):
                pass
            try:
                return await handler(request)
            except RequestValidationError:
                return _error("invalid_input", request_id)
            except CandidateStorageError as exc:
                return _error(exc.code, request_id)
            except HTTPException as exc:
                code = {
                    401: "unauthenticated",
                    402: "insufficient_credits",
                    422: "invalid_input",
                    429: "rate_limited",
                    502: "provider_unavailable",
                    504: "generation_unknown",
                    403: "voice_design_forbidden",
                    404: "project_not_found",
                }.get(exc.status_code, "voice_design_unavailable")
                return _error(code, request_id)
            except (OSError, sqlite3.Error):
                return _error("candidate_persist_failed", request_id)

        return safe_handler


router = APIRouter(
    prefix="/projects/{project}/voice-design", route_class=VoiceDesignRoute
)


async def _context(project, user, role):
    ctx = await resolve_project_context(
        user=user, project_id=project, required_role=role
    )
    require_project_home_node(ctx, operation="voice design")
    return ctx


def _candidate(record, project):
    candidate_id = record["candidate_id"]
    status = record["status"]
    if status == "expired":
        raise CandidateStorageError("candidate_expired")
    data = {"candidate_id": candidate_id, "status": status}
    if status == "ready":
        data.update(
            {
                key: record[key]
                for key in (
                    "description",
                    "preview_text",
                    "language",
                    "duration_seconds",
                    "sha256",
                )
            }
        )
        data.update(
            preview_url=f"/api/v1/projects/{project}/voice-design/candidates/{candidate_id}/audio",
            mime_type="audio/mpeg",
            created_at=datetime.fromtimestamp(
                record["created_at"], timezone.utc
            ).isoformat(),
            expires_at=datetime.fromtimestamp(
                record["expires_at"], timezone.utc
            ).isoformat(),
        )
    elif status in {"failed", "unknown"}:
        code = record["error_code"]
        if code not in ERROR_POLICY:
            code = "provider_unavailable"
        data["failure"] = {
            "code": code,
            "message": _message(code),
            "retryable": ERROR_POLICY[code][1],
        }
    return {"ok": True, "data": data}


def _required_candidate(storage, candidate_id):
    record = storage.get(candidate_id)
    if record is None:
        raise CandidateStorageError("candidate_not_found")
    if record["status"] == "expired":
        raise CandidateStorageError("candidate_expired")
    return record


@router.get("/quote")
async def quote_candidate(
    project: str, surface: GenerationCreditSurface, user: dict = Depends(get_api_user)
):
    ctx = await _context(project, user, "editor")
    from novelvideo.audio.voice_design_service import (
        VoiceDesignError as ServiceError,
        quote_voice_design,
    )

    try:
        return await quote_voice_design(ctx=ctx, surface=surface)
    except ServiceError as exc:
        raise CandidateStorageError(exc.code) from None


@router.post("/candidates", response_model=CandidateResponse, status_code=202)
async def create_candidate(
    project: str, body: VoiceDesignCreateRequest, user: dict = Depends(get_api_user)
):
    ctx = await _context(project, user, "editor")
    storage = VoiceDesignStorage(ctx)
    candidate_id = str(body.request_id)
    existing = storage.get(candidate_id)
    if existing:
        record, _ = storage.reserve(
            candidate_id,
            description=body.description,
            preview_text=body.preview_text,
            language=body.language,
            surface=body.surface,
        )
        if record["status"] != "generating" or record["queued"] or record["claimed"]:
            return JSONResponse(
                _candidate(record, project),
                status_code=202 if record["status"] == "generating" else 200,
            )
    from novelvideo.audio.voice_design_service import (
        VoiceDesignError as ServiceError,
        ensure_voice_design_enabled,
        resolve_voice_design_config,
    )

    try:
        ensure_voice_design_enabled()
        config = await resolve_voice_design_config(
            user_id=ctx.requester_user_id, project_id=ctx.project_id
        )
    except ServiceError as exc:
        raise CandidateStorageError(exc.code) from None
    if body.language != "zh":
        raise CandidateStorageError("invalid_input")
    record, _ = storage.reserve(
        candidate_id,
        description=body.description,
        preview_text=body.preview_text,
        language=body.language,
        surface=body.surface,
    )
    try:
        await enqueue_project_task(
            ctx,
            task_type="voice_design",
            product_surface=_credit_product_surface(record["surface"]),
            queue_kind="default",
            episode=0,
            scope=candidate_id,
            payload={"candidate_id": candidate_id, "billing": config.billing_params()},
        )
    except HTTPException:
        raise
    except Exception:
        # An uncertain submission is retried only with the same persistent candidate.
        raise CandidateStorageError("voice_design_unavailable") from None
    storage.mark_queued(candidate_id)
    return JSONResponse(_candidate(record, project), status_code=202)


@router.get("/candidates/{candidate_id}", response_model=CandidateResponse)
async def get_candidate(
    project: str, candidate_id: UUID, user: dict = Depends(get_api_user)
):
    ctx = await _context(project, user, "viewer")
    return _candidate(
        _required_candidate(VoiceDesignStorage(ctx), str(candidate_id)), project
    )


@router.get("/candidates/{candidate_id}/audio")
async def candidate_audio(
    project: str,
    candidate_id: UUID,
    request: Request,
    user: dict = Depends(get_api_user),
):
    ctx = await _context(project, user, "viewer")
    storage = VoiceDesignStorage(ctx)
    record = _required_candidate(storage, str(candidate_id))
    if record["status"] != "ready":
        raise CandidateStorageError("candidate_not_ready")
    path = storage.output_path(str(candidate_id))
    try:
        if path.is_symlink():
            raise FileNotFoundError
        content = path.read_bytes()
    except OSError:
        raise CandidateStorageError("candidate_audio_missing") from None
    headers = {
        "Cache-Control": "private, no-store",
        "ETag": f'"{record["sha256"]}"',
        "Accept-Ranges": "bytes",
    }
    length = len(content)
    range_header = request.headers.get("range")
    if (
        range_header
        and request.headers.get("if-range", headers["ETag"]) == headers["ETag"]
    ):
        try:
            unit, value = range_header.split("=", 1)
            start, end = value.split("-", 1)
            if unit != "bytes" or not length:
                raise ValueError
            if not start:
                suffix = int(end)
                if suffix <= 0:
                    raise ValueError
                start, end = max(0, length - suffix), length - 1
            else:
                start, end = (
                    int(start),
                    min(int(end), length - 1) if end else length - 1,
                )
            if start < 0 or start >= length or end < start:
                raise ValueError
        except ValueError:
            return JSONResponse(
                {
                    "ok": False,
                    "error": "无效的音频范围",
                    "code": "invalid_input",
                    "retryable": False,
                    "request_id": str(candidate_id),
                },
                status_code=416,
                headers={**headers, "Content-Range": f"bytes */{length}"},
            )
        headers["Content-Range"] = f"bytes {start}-{end}/{length}"
        return Response(
            content[start : end + 1],
            status_code=206,
            media_type="audio/mpeg",
            headers=headers,
        )
    return Response(content, media_type="audio/mpeg", headers=headers)
