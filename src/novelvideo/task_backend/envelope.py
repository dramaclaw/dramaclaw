"""Canonical, server-signed task envelope."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import math
import re
from typing import Any, Mapping

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference


@dataclass(frozen=True)
class RejectedTaskSettlement:
    """The signature-verified identity of an envelope refused before execution.

    Rejections raised *after* ``SignedTaskEnvelope.verify`` succeeded still carry
    a trustworthy identity, so the caller may settle the money the enqueue side
    already reserved.  Rejections raised while verifying carry none — attaching
    one there would let an unverified envelope drive a refund.

    Deliberately not a ``VerifiedTaskDelivery``: that type is the token saying
    "this may enter a runner", and ``run_project_task_core_sync`` gates on it by
    exact type.  A refused envelope must not be able to impersonate it.
    """

    project_id: str
    requester_user_id: str
    root_task_id: str
    task_type: str
    episode: int
    beat_num: Any
    scope: Any


class InvalidTaskEnvelope(ValueError):
    """A fail-closed task envelope error with a stable public code."""

    code = "TASK_ENVELOPE_INVALID"
    _message = "invalid task envelope"
    settlement: RejectedTaskSettlement | None = None

    def __init__(self) -> None:
        super().__init__(self._message)


class StaleTaskEnvelope(InvalidTaskEnvelope):
    """A task envelope whose signed time window cannot be accepted."""

    code = "TASK_ENVELOPE_STALE"
    _message = "stale task envelope"


class TaskAuthorityUnavailable(RuntimeError):
    """A verified task whose execution-time authority could not be read."""

    _CODE_BY_FAILURE_KIND = {
        "unavailable": "TASK_AUTHZ_UNAVAILABLE",
        "unknown": "TASK_AUTHZ_UNAVAILABLE",
    }
    _MESSAGE_BY_FAILURE_KIND = {
        "unavailable": "task authorization service is unavailable",
        "unknown": "task authorization service is unavailable",
    }

    def __init__(
        self,
        *,
        failure_kind: str,
        settlement: RejectedTaskSettlement,
    ) -> None:
        if failure_kind not in self._CODE_BY_FAILURE_KIND:
            raise ValueError("unsupported task authority failure kind")
        super().__init__(self._MESSAGE_BY_FAILURE_KIND[failure_kind])
        self.failure_kind = failure_kind
        self.code = self._CODE_BY_FAILURE_KIND[failure_kind]
        self.settlement = settlement


class TaskAuthorityFault(RuntimeError):
    """A verified task whose authority check failed unexpectedly."""

    code = "TASK_AUTHZ_CHECK_FAILED"
    failure_kind = "fault"

    def __init__(self, *, settlement: RejectedTaskSettlement) -> None:
        super().__init__("task authorization check failed")
        self.settlement = settlement


class RunningTaskAuthorityIndeterminate(RuntimeError):
    """Authority could not be safely established after provider acceptance."""

    code = "TASK_AUTHZ_REVALIDATION_INDETERMINATE"
    _message = "task authorization revalidation is indeterminate"

    def __init__(self, *, failure_kind: str) -> None:
        if failure_kind not in {"drift", "unavailable", "fault"}:
            raise ValueError("unsupported running authority failure kind")
        super().__init__(self._message)
        self.failure_kind = failure_kind


_SENSITIVE_PAYLOAD_FIELDS = {
    "accesstoken",
    "apikey",
    "authtoken",
    "authorization",
    "bearertoken",
    "credentialsecret",
    "idtoken",
    "refreshtoken",
    "token",
    "xapikey",
}
_ENVELOPE_FIELDS = {
    "schema_version",
    "envelope_id",
    "admission",
    "task_type",
    "project_id",
    "payload",
    "issued_at",
    "expires_at",
    "signing_key_id",
    "signature",
}
_ADMISSION_FIELDS = {
    "requester_user_id",
    "billing_principal",
    "credential",
    "admission_id",
    "root_task_id",
    "admitted_at",
    "membership_id",
    "authz_version",
}
_PRINCIPAL_FIELDS = {"kind", "id"}
_CREDENTIAL_FIELDS = {"source", "credential_id", "key_version", "org_id"}
_KEY_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_SIGNATURE_RE = re.compile(r"[0-9a-f]{64}\Z")
_UTC_TIMESTAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")
_MAX_LIFETIME = timedelta(hours=24)
_CLOCK_SKEW = timedelta(seconds=30)


def _invalid() -> InvalidTaskEnvelope:
    return InvalidTaskEnvelope()


def _stale() -> StaleTaskEnvelope:
    return StaleTaskEnvelope()


def _require_exact_fields(value: Any, expected: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != expected:
        raise _invalid()
    return value


def _require_exact_type(value: Any, expected_type: type) -> None:
    if type(value) is not expected_type:
        raise _invalid()


def _require_non_empty_string(value: Any) -> None:
    _require_exact_type(value, str)
    if not value:
        raise _invalid()


def _validate_json_value(value: Any) -> None:
    if value is None or type(value) in {str, bool, int}:
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise _invalid()
        return
    if type(value) is list:
        for nested_value in value:
            _validate_json_value(nested_value)
        return
    if type(value) is dict:
        for key, nested_value in value.items():
            _require_exact_type(key, str)
            normalized_key = re.sub(r"[^a-z0-9]", "", key.casefold())
            if normalized_key in _SENSITIVE_PAYLOAD_FIELDS:
                raise _invalid()
            _validate_json_value(nested_value)
        return
    raise _invalid()


def _canonical_json(value: Any) -> str:
    _validate_json_value(value)
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
    except (TypeError, ValueError):
        raise _invalid() from None


def _parse_utc_timestamp(value: Any) -> datetime:
    _require_exact_type(value, str)
    if _UTC_TIMESTAMP_RE.fullmatch(value) is None:
        raise _stale()
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise _stale() from None
    return parsed.replace(tzinfo=timezone.utc)


def _validate_time_window(issued_at: Any, expires_at: Any) -> tuple[datetime, datetime]:
    issued = _parse_utc_timestamp(issued_at)
    expires = _parse_utc_timestamp(expires_at)
    lifetime = expires - issued
    if lifetime <= timedelta(0) or lifetime > _MAX_LIFETIME:
        raise _stale()
    return issued, expires


def _validate_signing_key(signing_key: Any) -> bytes:
    if type(signing_key) is not bytes or len(signing_key) < 32:
        raise _invalid()
    return signing_key


def _validate_key_id(signing_key_id: Any) -> None:
    _require_exact_type(signing_key_id, str)
    if _KEY_ID_RE.fullmatch(signing_key_id) is None:
        raise _invalid()


def _validate_signature(signature: Any) -> None:
    _require_exact_type(signature, str)
    if _SIGNATURE_RE.fullmatch(signature) is None:
        raise _invalid()


def _parse_admission(value: Any) -> AdmissionContext:
    admission_value = _require_exact_fields(value, _ADMISSION_FIELDS)
    for field_name in (
        "requester_user_id",
        "admission_id",
        "root_task_id",
        "admitted_at",
    ):
        _require_non_empty_string(admission_value[field_name])
    if admission_value["membership_id"] is not None:
        _require_non_empty_string(admission_value["membership_id"])
    _require_exact_type(admission_value["authz_version"], int)

    credential_value = _require_exact_fields(
        admission_value["credential"],
        _CREDENTIAL_FIELDS,
    )
    principal_value = _require_exact_fields(
        admission_value["billing_principal"],
        _PRINCIPAL_FIELDS,
    )
    for field_name in ("source", "credential_id"):
        _require_non_empty_string(credential_value[field_name])
    _require_exact_type(credential_value["key_version"], int)
    if credential_value["org_id"] is not None:
        _require_non_empty_string(credential_value["org_id"])
    for field_name in ("kind", "id"):
        _require_non_empty_string(principal_value[field_name])

    try:
        credential = CredentialReference(**credential_value)
        principal = BillingPrincipal(**principal_value)
        return AdmissionContext(
            **{
                **admission_value,
                "credential": credential,
                "billing_principal": principal,
            }
        )
    except (TypeError, ValueError):
        raise _invalid() from None


def _serialize_admission(admission: Any) -> dict[str, Any]:
    if type(admission) is not AdmissionContext:
        raise _invalid()
    try:
        value = asdict(admission)
    except (TypeError, ValueError):
        raise _invalid() from None
    _parse_admission(value)
    return value


@dataclass(frozen=True)
class SignedTaskEnvelope:
    schema_version: int
    envelope_id: str = field(repr=False)
    admission: AdmissionContext
    task_type: str
    project_id: str
    payload_json: str = field(repr=False)
    issued_at: str = field(repr=False)
    expires_at: str = field(repr=False)
    signing_key_id: str = field(repr=False)
    signature: str = field(repr=False)

    def unsigned_dict(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.payload_json)
        except (TypeError, ValueError, json.JSONDecodeError):
            raise _invalid() from None
        return {
            "schema_version": self.schema_version,
            "envelope_id": self.envelope_id,
            "admission": _serialize_admission(self.admission),
            "task_type": self.task_type,
            "project_id": self.project_id,
            "payload": payload,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "signing_key_id": self.signing_key_id,
        }

    def canonical_payload(self) -> str:
        return _canonical_json(self.unsigned_dict())

    def to_dict(self) -> dict[str, Any]:
        return {**self.unsigned_dict(), "signature": self.signature}

    @classmethod
    def sign(
        cls,
        *,
        admission: AdmissionContext,
        envelope_id: str,
        task_type: str,
        project_id: str,
        payload: dict[str, Any],
        issued_at: str,
        expires_at: str,
        signing_key_id: str,
        signing_key: bytes,
    ) -> "SignedTaskEnvelope":
        _require_non_empty_string(envelope_id)
        _require_non_empty_string(task_type)
        _require_non_empty_string(project_id)
        _validate_key_id(signing_key_id)
        key = _validate_signing_key(signing_key)
        _validate_time_window(issued_at, expires_at)
        _require_exact_type(payload, dict)
        payload_json = _canonical_json(payload)
        _serialize_admission(admission)

        envelope = cls(
            schema_version=2,
            envelope_id=envelope_id,
            admission=admission,
            task_type=task_type,
            project_id=project_id,
            payload_json=payload_json,
            issued_at=issued_at,
            expires_at=expires_at,
            signing_key_id=signing_key_id,
            signature="",
        )
        signature = hmac.new(
            key,
            envelope.canonical_payload().encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return cls(**{**envelope.__dict__, "signature": signature})

    def verify(
        self,
        signing_keys: Mapping[str, bytes],
        *,
        now: datetime,
        expected_task_type: str,
        expected_project_id: str,
        expected_root_task_id: str,
        expected_requester_user_id: str,
    ) -> None:
        if self.schema_version != 2:
            raise _invalid()
        _require_non_empty_string(self.envelope_id)
        _require_non_empty_string(self.task_type)
        _require_non_empty_string(self.project_id)
        _validate_key_id(self.signing_key_id)
        _validate_signature(self.signature)

        try:
            signing_key = signing_keys[self.signing_key_id]
        except Exception:
            signing_key = None
        key = _validate_signing_key(signing_key)
        expected_signature = hmac.new(
            key,
            self.canonical_payload().encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(self.signature, expected_signature):
            raise _invalid()

        issued, expires = _validate_time_window(self.issued_at, self.expires_at)
        if (
            type(now) is not datetime
            or now.tzinfo is None
            or now.utcoffset() != timedelta(0)
        ):
            raise _invalid()
        if now < issued - _CLOCK_SKEW or now > expires + _CLOCK_SKEW:
            raise _stale()

        for expected in (
            expected_task_type,
            expected_project_id,
            expected_root_task_id,
            expected_requester_user_id,
        ):
            _require_non_empty_string(expected)
        if (
            self.task_type != expected_task_type
            or self.project_id != expected_project_id
            or self.admission.root_task_id != expected_root_task_id
            or self.admission.requester_user_id != expected_requester_user_id
        ):
            raise _invalid()

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SignedTaskEnvelope":
        try:
            envelope_value = _require_exact_fields(value, _ENVELOPE_FIELDS)
            _require_exact_type(envelope_value["schema_version"], int)
            if envelope_value["schema_version"] != 2:
                raise _invalid()
            _require_non_empty_string(envelope_value["envelope_id"])
            _require_non_empty_string(envelope_value["task_type"])
            _require_non_empty_string(envelope_value["project_id"])
            _validate_key_id(envelope_value["signing_key_id"])
            _validate_signature(envelope_value["signature"])
            _validate_time_window(
                envelope_value["issued_at"], envelope_value["expires_at"]
            )
            _require_exact_type(envelope_value["payload"], dict)
            payload_json = _canonical_json(envelope_value["payload"])
            admission = _parse_admission(envelope_value["admission"])
            return cls(
                schema_version=envelope_value["schema_version"],
                envelope_id=envelope_value["envelope_id"],
                admission=admission,
                task_type=envelope_value["task_type"],
                project_id=envelope_value["project_id"],
                payload_json=payload_json,
                issued_at=envelope_value["issued_at"],
                expires_at=envelope_value["expires_at"],
                signing_key_id=envelope_value["signing_key_id"],
                signature=envelope_value["signature"],
            )
        except InvalidTaskEnvelope:
            raise
        except (KeyError, TypeError, ValueError):
            raise _invalid() from None
