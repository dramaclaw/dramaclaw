"""Single authoritative producer for signed TaskEnvelope v2 objects."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
import re
from types import MappingProxyType
from typing import Any

from novelvideo.ports.authz import AuthzError, AuthzPort, detach_authz_error
from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

_FORBIDDEN_PAYLOAD_FIELDS = {
    "accesstoken",
    "admission",
    "admissionid",
    "apikey",
    "authtoken",
    "authorization",
    "bearertoken",
    "billingprincipal",
    "credential",
    "credentialsecret",
    "idtoken",
    "refreshtoken",
    "requesteruserid",
    "roottaskid",
    "token",
    "xapikey",
}


def _invalid() -> InvalidTaskEnvelope:
    return InvalidTaskEnvelope()


def _validate_forbidden_payload_fields(value: Any) -> None:
    if type(value) is dict:
        for key, nested in value.items():
            if type(key) is not str:
                raise _invalid()
            normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
            if normalized in _FORBIDDEN_PAYLOAD_FIELDS:
                raise _invalid()
            _validate_forbidden_payload_fields(nested)
    elif type(value) is list:
        for nested in value:
            _validate_forbidden_payload_fields(nested)


class TaskEnvelopeProducer:
    def __init__(
        self,
        *,
        authz: AuthzPort,
        active_key_id: str,
        keyring: Mapping[str, bytes],
        clock: Callable[[], datetime],
        envelope_id_factory: Callable[[], str],
    ) -> None:
        failed = False
        try:
            copied_keyring = dict(keyring)
        except Exception:
            failed = True
            copied_keyring = {}
        if failed:
            raise _invalid() from None
        self._authz = authz
        self._active_key_id = active_key_id
        self._keyring = MappingProxyType(copied_keyring)
        self._clock = clock
        self._envelope_id_factory = envelope_id_factory

    @staticmethod
    def _window(now: datetime) -> tuple[str, str]:
        if (
            type(now) is not datetime
            or now.tzinfo is None
            or now.utcoffset() != timedelta(0)
        ):
            raise _invalid()
        issued = now.replace(microsecond=0)
        expires = issued + timedelta(hours=24)
        return (
            issued.strftime("%Y-%m-%dT%H:%M:%SZ"),
            expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )

    def _sign(
        self,
        *,
        admission,
        task_type: str,
        project_id: str,
        payload: dict[str, Any],
        now: datetime,
    ) -> SignedTaskEnvelope:
        issued_at, expires_at = self._window(now)
        return SignedTaskEnvelope.sign(
            admission=admission,
            envelope_id=self._envelope_id_factory(),
            task_type=task_type,
            project_id=project_id,
            payload=payload,
            issued_at=issued_at,
            expires_at=expires_at,
            signing_key_id=self._active_key_id,
            signing_key=self._keyring[self._active_key_id],
        )

    async def sign_top_level(
        self,
        *,
        user_id: str,
        root_task_id: str,
        task_type: str,
        project_id: str,
        payload: dict[str, Any],
    ) -> SignedTaskEnvelope:
        _validate_forbidden_payload_fields(payload)

        authz_failure: AuthzError | None = None
        ordinary_failure = False
        try:
            admission = await self._authz.admit_model_task(
                user_id=user_id,
                root_task_id=root_task_id,
            )
        except AuthzError as exc:
            authz_failure = exc
            admission = None
        except Exception:
            ordinary_failure = True
            admission = None
        if authz_failure is not None:
            raise detach_authz_error(authz_failure) from None
        if ordinary_failure:
            raise _invalid() from None

        try:
            signed = self._sign(
                admission=admission,
                task_type=task_type,
                project_id=project_id,
                payload=payload,
                now=self._clock(),
            )
        except Exception:
            signed = None
        if signed is None:
            raise _invalid() from None
        return signed

    def sign_descendant(
        self,
        *,
        parent: SignedTaskEnvelope,
        task_type: str,
        project_id: str,
        payload: dict[str, Any],
    ) -> SignedTaskEnvelope:
        _validate_forbidden_payload_fields(payload)

        try:
            now = self._clock()
            if (
                type(parent) is not SignedTaskEnvelope
                or project_id != parent.project_id
            ):
                raise _invalid()
            parent.verify(
                self._keyring,
                now=now,
                expected_task_type=parent.task_type,
                expected_project_id=parent.project_id,
                expected_root_task_id=parent.admission.root_task_id,
                expected_requester_user_id=parent.admission.requester_user_id,
            )
            signed = self._sign(
                admission=parent.admission,
                task_type=task_type,
                project_id=project_id,
                payload=payload,
                now=now,
            )
        except Exception:
            signed = None
        if signed is None:
            raise _invalid() from None
        return signed
