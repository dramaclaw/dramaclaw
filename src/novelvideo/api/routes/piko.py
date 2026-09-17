"""Single-message translation for the Piko browser-session chat preview."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from novelvideo.api.auth import get_api_user
from novelvideo.api.egress_binding import request_egress_scope
from novelvideo.piko.translation import Language, Translation, TranslationBusy, TranslationCache
from novelvideo.project_context import user_id_from_api_user
from novelvideo.ports.authz import AuthzError
from novelvideo.task_backend.subprocesses import EgressBoundaryError

router = APIRouter(prefix="/piko")
_cache = TranslationCache()


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
