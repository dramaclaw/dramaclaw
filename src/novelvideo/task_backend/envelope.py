"""Canonical, server-signed task envelope."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import hmac
import json
from typing import Any

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference


class InvalidTaskEnvelope(ValueError):
    pass


_SENSITIVE_PAYLOAD_FIELDS = {
    "access_token",
    "api_key",
    "authorization",
    "credential_secret",
    "refresh_token",
}


def _reject_sensitive_fields(value: Any) -> None:
    if isinstance(value, dict):
        for key, nested_value in value.items():
            if str(key).lower() in _SENSITIVE_PAYLOAD_FIELDS:
                raise InvalidTaskEnvelope(
                    f"sensitive field {key!r} is not allowed in a task envelope"
                )
            _reject_sensitive_fields(nested_value)
    elif isinstance(value, (list, tuple)):
        for nested_value in value:
            _reject_sensitive_fields(nested_value)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


@dataclass(frozen=True)
class SignedTaskEnvelope:
    schema_version: int
    admission: AdmissionContext
    task_type: str
    project_id: str
    payload_json: str
    signature: str = field(repr=False)

    def unsigned_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "admission": asdict(self.admission),
            "task_type": self.task_type,
            "project_id": self.project_id,
            "payload": json.loads(self.payload_json),
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
        signing_key: bytes,
    ) -> "SignedTaskEnvelope":
        if not signing_key:
            raise ValueError("signing_key is required")
        if not task_type or not project_id:
            raise ValueError("task_type and project_id are required")
        _reject_sensitive_fields(payload)
        envelope = cls(
            schema_version=1,
            admission=admission,
            task_type=task_type,
            project_id=project_id,
            payload_json=_canonical_json(payload),
            signature="",
        )
        signature = hmac.new(
            signing_key,
            envelope.canonical_payload().encode(),
            hashlib.sha256,
        ).hexdigest()
        return cls(**{**envelope.__dict__, "signature": signature})

    def verify(self, signing_key: bytes) -> None:
        if self.schema_version != 1:
            raise InvalidTaskEnvelope("unsupported task envelope schema")
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
            admission_value = value["admission"]
            payload = value["payload"]
            _reject_sensitive_fields(payload)
            credential = CredentialReference(**admission_value["credential"])
            principal = BillingPrincipal(**admission_value["billing_principal"])
            admission = AdmissionContext(
                **{
                    **admission_value,
                    "credential": credential,
                    "billing_principal": principal,
                }
            )
            return cls(
                schema_version=int(value["schema_version"]),
                admission=admission,
                task_type=str(value["task_type"]),
                project_id=str(value["project_id"]),
                payload_json=_canonical_json(payload),
                signature=str(value["signature"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidTaskEnvelope("malformed task envelope") from exc
