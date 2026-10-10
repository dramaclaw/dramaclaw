"""Piko character, realtime world and translation routes."""
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, field_validator

from novelvideo.api.auth import (
    AUTH_COOKIE_NAME,
    UNSUPPORTED_QUERY_CREDENTIALS,
    _verify_browser_session,
    get_api_user,
)
from novelvideo.api.egress_binding import request_egress_scope
from novelvideo.piko.translation import Language, Translation, TranslationBusy, TranslationCache
from novelvideo.project_context import user_id_from_api_user
from novelvideo.ports.authz import AuthzError
from novelvideo.piko.world import character_store, parse_client_payload, world_hub
from novelvideo.task_backend.subprocesses import EgressBoundaryError

router = APIRouter(prefix="/piko")
_cache = TranslationCache()


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
    character = character_store.get(user_id)
    return {"character": character.public_dict() if character else None}


@router.put("/character")
async def put_character(
    body: CharacterUpsertRequest, user: dict = Depends(get_api_user)
) -> dict[str, Any]:
    user_id = await user_id_from_api_user(user)
    character = character_store.create_or_update(
        user_id, nickname=body.nickname, gender=body.gender, bio=body.bio.strip()
    )
    return {"character": character.public_dict()}


async def _authenticate_piko_ws(websocket: WebSocket) -> dict[str, Any]:
    if websocket.headers.get("X-API-Key"):
        raise HTTPException(status_code=401, detail="unsupported credential")
    if any(name in websocket.query_params for name in UNSUPPORTED_QUERY_CREDENTIALS):
        raise HTTPException(status_code=401, detail="unsupported credential")
    # Browser multiplayer deliberately accepts only the HttpOnly account session.
    return await _verify_browser_session(websocket.cookies.get(AUTH_COOKIE_NAME))


@router.websocket("/world/ws")
async def piko_world_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        user = await _authenticate_piko_ws(websocket)
        user_id = await user_id_from_api_user(user)
        character = character_store.get(user_id)
        if character is None:
            await websocket.send_json({"type": "error", "code": "character_required"})
            await websocket.close(code=1008)
            return
        player = await world_hub.join(websocket, user_id=user_id, character=character)
        while True:
            payload = parse_client_payload(await websocket.receive_text())
            if payload is not None:
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
    target_language: Language
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
