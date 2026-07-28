"""Canonical, server-signed task envelope."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import hmac
import json
import re
from typing import Any, Mapping

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference


class InvalidTaskEnvelope(ValueError):
    pass


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
    "admission",
    "task_type",
    "project_id",
    "payload",
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


def _reject_sensitive_fields(value: Any) -> None:
    if isinstance(value, dict):
        for key, nested_value in value.items():
            normalized_key = re.sub(r"[^a-z0-9]", "", str(key).casefold())
            if normalized_key in _SENSITIVE_PAYLOAD_FIELDS:
                raise InvalidTaskEnvelope(
                    f"sensitive field {key!r} is not allowed in a task envelope"
                )
            _reject_sensitive_fields(nested_value)
    elif isinstance(value, (list, tuple)):
        for nested_value in value:
            _reject_sensitive_fields(nested_value)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _require_exact_fields(value: Any, expected: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise InvalidTaskEnvelope("malformed task envelope")
    return value


def _require_exact_type(value: Any, expected_type: type) -> None:
    if type(value) is not expected_type:
        raise InvalidTaskEnvelope("malformed task envelope")


@dataclass(frozen=True)
class SignedTaskEnvelope:
    schema_version: int
    admission: AdmissionContext
    task_type: str
    project_id: str
    payload_json: str = field(repr=False)
    signing_key_id: str
    signature: str = field(repr=False)

    def unsigned_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "admission": asdict(self.admission),
            "task_type": self.task_type,
            "project_id": self.project_id,
            "payload": json.loads(self.payload_json),
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
        task_type: str,
        project_id: str,
        payload: dict[str, Any],
        signing_key_id: str,
        signing_key: bytes,
    ) -> "SignedTaskEnvelope":
        if not signing_key:
            raise ValueError("signing_key is required")
        if not signing_key_id:
            raise ValueError("signing_key_id is required")
        if not task_type or not project_id:
            raise ValueError("task_type and project_id are required")
        _reject_sensitive_fields(payload)
        envelope = cls(
            schema_version=1,
            admission=admission,
            task_type=task_type,
            project_id=project_id,
            payload_json=_canonical_json(payload),
            signing_key_id=signing_key_id,
            signature="",
        )
        signature = hmac.new(
            signing_key,
            envelope.canonical_payload().encode(),
            hashlib.sha256,
        ).hexdigest()
        return cls(**{**envelope.__dict__, "signature": signature})

    def verify(self, signing_keys: Mapping[str, bytes]) -> None:
        if self.schema_version != 1:
            raise InvalidTaskEnvelope("unsupported task envelope schema")
        if not self.signing_key_id:
            raise InvalidTaskEnvelope("task envelope signing key is unavailable")
        try:
            signing_key = signing_keys[self.signing_key_id]
        except (KeyError, TypeError):
            raise InvalidTaskEnvelope("task envelope signing key is unavailable") from None
        if type(signing_key) is not bytes or not signing_key:
            raise InvalidTaskEnvelope("task envelope signing key is unavailable")
        expected = hmac.new(
            signing_key,
            self.canonical_payload().encode(),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(self.signature, expected):
            raise InvalidTaskEnvelope("invalid task envelope signature")

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SignedTaskEnvelope":
        try:
            _reject_sensitive_fields(value)
            _require_exact_fields(value, _ENVELOPE_FIELDS)
            _require_exact_type(value["schema_version"], int)
            if value["schema_version"] != 1:
                raise InvalidTaskEnvelope("unsupported task envelope schema")
            for field_name in ("task_type", "project_id", "signing_key_id", "signature"):
                _require_exact_type(value[field_name], str)
                if not value[field_name]:
                    raise InvalidTaskEnvelope("malformed task envelope")
            _require_exact_type(value["payload"], dict)
            admission_value = value["admission"]
            _require_exact_fields(admission_value, _ADMISSION_FIELDS)
            for field_name in (
                "requester_user_id",
                "admission_id",
                "root_task_id",
                "admitted_at",
            ):
                _require_exact_type(admission_value[field_name], str)
            if admission_value["membership_id"] is not None:
                _require_exact_type(admission_value["membership_id"], str)
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
                _require_exact_type(credential_value[field_name], str)
            _require_exact_type(credential_value["key_version"], int)
            if credential_value["org_id"] is not None:
                _require_exact_type(credential_value["org_id"], str)
            for field_name in ("kind", "id"):
                _require_exact_type(principal_value[field_name], str)

            payload = value["payload"]
            credential = CredentialReference(**credential_value)
            principal = BillingPrincipal(**principal_value)
            admission = AdmissionContext(
                **{
                    **admission_value,
                    "credential": credential,
                    "billing_principal": principal,
                }
            )
            return cls(
                schema_version=value["schema_version"],
                admission=admission,
                task_type=value["task_type"],
                project_id=value["project_id"],
                payload_json=_canonical_json(payload),
                signing_key_id=value["signing_key_id"],
                signature=value["signature"],
            )
        except InvalidTaskEnvelope:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidTaskEnvelope("malformed task envelope") from exc
