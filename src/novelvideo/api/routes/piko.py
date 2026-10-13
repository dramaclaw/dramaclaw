"""Piko character, realtime world and translation routes."""
import asyncio
import inspect
import logging
from time import monotonic
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.concurrency import run_in_threadpool

from novelvideo.api.auth import (
    AUTH_COOKIE_NAME,
    UNSUPPORTED_QUERY_CREDENTIALS,
    _verify_browser_session,
    get_api_user,
)
from novelvideo.api.egress_binding import request_egress_scope
from novelvideo.ports import get_project_access, get_project_registry
from novelvideo.piko.translation import Language, Translation, TranslationBusy, TranslationCache
from novelvideo.project_context import resolve_project_context, user_id_from_api_user
from novelvideo.ports.authz import AuthzError
from novelvideo.piko.backend import character_store, world_hub
from novelvideo.piko.protocol import parse_client_payload
from novelvideo.piko.world import normalize_character_location
from novelvideo.task_backend.subprocesses import EgressBoundaryError
from novelvideo.task_state import get_task_manager

router = APIRouter(prefix="/piko")
_cache = TranslationCache()
logger = logging.getLogger("novelvideo.api.piko")


async def _store_call(method, *args, **kwargs):
    """Allow the unchanged sync demo store and async PostgreSQL store to coexist."""
    result = method(*args, **kwargs)
    return await result if inspect.isawaitable(result) else result


class CharacterUpsertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nickname: str = Field(min_length=1, max_length=16)
    gender: Literal["male", "female"]
    bio: str = Field(default="", max_length=160)

    @field_validator("nickname")
    @classmethod
    def normalize_nickname(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Nickname must not be blank")
        return normalized


@router.get("/character")
async def get_character(user: dict = Depends(get_api_user)) -> dict[str, Any]:
    user_id = await user_id_from_api_user(user)
    character = await _store_call(character_store.get, user_id)
    return {"character": normalize_character_location(character).public_dict() if character else None}


@router.put("/character")
async def put_character(
    body: CharacterUpsertRequest, user: dict = Depends(get_api_user)
) -> dict[str, Any]:
    user_id = await user_id_from_api_user(user)
    character = await _store_call(
        character_store.create_or_update,
        user_id, nickname=body.nickname, gender=body.gender, bio=body.bio.strip()
    )
    return {"character": normalize_character_location(character).public_dict()}


async def _authenticate_piko_ws(websocket: WebSocket) -> dict[str, Any]:
    if websocket.headers.get("X-API-Key"):
        raise HTTPException(status_code=401, detail="unsupported credential")
    if any(name in websocket.query_params for name in UNSUPPORTED_QUERY_CREDENTIALS):
        raise HTTPException(status_code=401, detail="unsupported credential")
    # Browser multiplayer deliberately accepts only the HttpOnly account session.
    return await _verify_browser_session(websocket.cookies.get(AUTH_COOKIE_NAME))


# The session behind an open socket is re-checked on the server's clock, whatever
# the client sends or withholds, and immediately before events that speak for the
# account. A revoked client therefore cannot stay online by skipping its pings.
SESSION_RECHECK_SECONDS = 30.0
# While the auth backend cannot answer, retry this often and tolerate it this long.
SESSION_RETRY_SECONDS = 5.0
SESSION_MAX_UNVERIFIED_SECONDS = 120.0
_MIN_RECEIVE_WAIT_SECONDS = 0.001
_REVERIFIED_EVENTS = frozenset(
    {
        "ping",
        "chat.send",
        "chat.request",
        "chat.request.respond",
        "chat.private.send",
        "profile.refresh",
    }
)


async def _session_still_valid(websocket: WebSocket, user_id: str) -> bool:
    """Re-check the browser session behind an open socket.

    Raises when the session was revoked, expired, suspended or now belongs to
    another account. Returns False when the auth backend cannot answer, so the
    caller drops the event without disconnecting everyone during an outage.
    """
    try:
        fresh = await _authenticate_piko_ws(websocket)
    except HTTPException as exc:
        if exc.status_code == 503:
            return False
        raise
    if await user_id_from_api_user(fresh) != user_id:
        raise HTTPException(status_code=403, detail="principal changed")
    return True


async def _public_task_status(user: dict[str, Any]) -> str | None:
    """Expose only whether this account has active work in an accessible project."""
    try:
        user_id = await user_id_from_api_user(user)
        access = get_project_access()
        registry = get_project_registry()
        principals = await access.resolve_requester_principals(user_id)
        records = await registry.list_accessible_projects(
            [(principal.type, principal.id) for principal in principals]
        )
    except Exception:
        logger.warning("failed to resolve Piko public task status", exc_info=True)
        return None
    manager = get_task_manager()
    for record in records:
        if record.purged_at:
            continue
        try:
            context = await resolve_project_context(
                user=user, project_id=record.id, required_role="viewer"
            )
            active = await run_in_threadpool(
                manager.count_active_tasks_for_project_user_lane, context, None
            )
        except Exception:
            logger.debug(
                "failed to inspect Piko task status for project %s",
                record.id,
                exc_info=True,
            )
            continue
        if active > 0:
            return "running"
    return None


@router.websocket("/world/ws")
async def piko_world_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        user = await _authenticate_piko_ws(websocket)
        user_id = await user_id_from_api_user(user)
        character = await _store_call(character_store.get, user_id)
        if character is None:
            await websocket.send_json({"type": "error", "code": "character_required"})
            await websocket.close(code=1008)
            return
        player = await world_hub.join(
            websocket,
            user_id=user_id,
            character=character,
            public_task_status=await _public_task_status(user),
        )
        verified_at = monotonic()
        recheck_at = verified_at + SESSION_RECHECK_SECONDS
        while True:
            try:
                # Never a zero timeout: an overdue recheck must not starve the reads.
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=max(recheck_at - monotonic(), _MIN_RECEIVE_WAIT_SECONDS),
                )
            except asyncio.TimeoutError:
                raw = None  # nothing arrived: the recheck below still runs on time
            payload = parse_client_payload(raw) if raw is not None else None
            if payload is not None and payload.get("type") == "client.leave":
                break
            sensitive = payload is not None and payload.get("type") in _REVERIFIED_EVENTS
            if sensitive or monotonic() >= recheck_at:
                if await _session_still_valid(websocket, user_id):
                    verified_at = monotonic()
                    recheck_at = verified_at + SESSION_RECHECK_SECONDS
                else:
                    # Auth backend outage: nobody can be re-verified. Keep presence
                    # and movement for a bounded time, but let nothing speak.
                    if monotonic() - verified_at >= SESSION_MAX_UNVERIFIED_SECONDS:
                        await websocket.close(code=1013)
                        break
                    recheck_at = monotonic() + SESSION_RETRY_SECONDS
                    if sensitive:
                        continue
            if payload is not None:
                if payload.get("type") == "profile.refresh":
                    # The profile was saved over HTTP; the open connection re-reads it
                    # instead of reconnecting, which would end every private chat.
                    saved = await _store_call(character_store.get, user_id)
                    if saved is not None:
                        await world_hub.update_profile(
                            player, nickname=saved.nickname, bio=saved.bio
                        )
                    continue
                if payload.get("type") == "ping":
                    await world_hub.update_public_task_status(
                        player, await _public_task_status(user)
                    )
                await world_hub.handle(player, payload)
    except HTTPException:
        try:
            await websocket.send_json({"type": "error", "code": "unauthorized"})
            await websocket.close(code=1008)
        except Exception:  # noqa: BLE001 - the peer may already be gone
            pass
    except WebSocketDisconnect:
        pass
    finally:
        await world_hub.disconnect(websocket)


class TranslateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=80)
    target_language: Language = Field(description="Current interface language; non-English messages translate to English")
    conversation: str = Field(min_length=1, max_length=120)

    @field_validator("text")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message must not be blank")
        return value


@router.post("/chat/translate", response_model=Translation)
async def translate_chat(body: TranslateRequest, user: dict = Depends(get_api_user)) -> Translation:
    user_id = await user_id_from_api_user(user)
    # Source text is submitted explicitly: this endpoint does not fetch chat records.
    # Resolve trusted billing identity before any model call or cached response.
    async with request_egress_scope(
        requester_user_id=user_id, project_id="piko-chat",
        task_type="freezone.text.generate",
    ):
        try:
            return await _cache.get(user_id, body.conversation, body.text, body.target_language)
        except TranslationBusy:
            raise HTTPException(429, "translation_rate_limited", headers={"Retry-After": "10"}) from None
        except TimeoutError:
            raise HTTPException(504, "translation_timeout") from None
        except AuthzError:
            raise
        except EgressBoundaryError as exc:
            raise AuthzError(exc.code) from exc
        except Exception:
            # Do not disclose provider errors, credentials or private message text.
            raise HTTPException(502, "translation_unavailable") from None
