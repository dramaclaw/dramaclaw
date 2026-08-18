"""Strict consumer for signed TaskEnvelope delivery objects."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Any

from novelvideo.ports.authz import (
    AdmissionContext,
    AuthzError,
    AuthzPort,
    AuthzServiceFault,
    AuthzServiceUnavailable,
)
from novelvideo.task_backend.envelope import (
    InvalidTaskEnvelope,
    RejectedTaskSettlement,
    SignedTaskEnvelope,
    StaleTaskEnvelope,
    TaskAuthorityUnavailable,
)

_DELIVERY_FIELDS = {
    "project_id",
    "requester_user_id",
    "task_type",
    "episode",
    "beat_num",
    "scope",
    "queue_kind",
    "payload",
    "task_envelope_v2",
}
_SIGNED_PAYLOAD_FIELDS = {"episode", "beat_num", "scope", "queue_kind", "payload"}


def _allow_execution() -> None:
    return None


def _rejected_settlement(
    signed: SignedTaskEnvelope,
    signed_payload: dict[str, Any],
) -> RejectedTaskSettlement:
    """Build the settlement identity for a refusal raised after verification."""
    return RejectedTaskSettlement(
        project_id=signed.project_id,
        requester_user_id=signed.admission.requester_user_id,
        root_task_id=signed.admission.root_task_id,
        task_type=signed.task_type,
        episode=signed_payload["episode"],
        beat_num=signed_payload["beat_num"],
        scope=signed_payload["scope"],
    )


def _refuse_verified(
    error: InvalidTaskEnvelope,
    signed: SignedTaskEnvelope,
    signed_payload: dict[str, Any],
) -> InvalidTaskEnvelope:
    error.settlement = _rejected_settlement(signed, signed_payload)
    return error


class _PreExecutionPolicyError(AuthzError, InvalidTaskEnvelope):
    """Stable authz denial compatible with existing inline failure projection."""


@dataclass(frozen=True)
class VerifiedTaskDelivery:
    """Delivery values derived from a verified signed envelope."""

    envelope_id: str
    admission: AdmissionContext
    task_type: str
    project_id: str
    requester_user_id: str
    episode: Any
    beat_num: Any
    scope: Any
    queue_kind: Any
    payload: Any
    billing_metadata: dict[str, Any] | None = None


def _strictly_equal(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return set(left) == set(right) and all(
            _strictly_equal(left[key], right[key]) for key in left
        )
    if type(left) is list:
        return len(left) == len(right) and all(
            _strictly_equal(left_item, right_item)
            for left_item, right_item in zip(left, right, strict=True)
        )
    return left == right


def _authority_tuple(admission: AdmissionContext) -> tuple[Any, ...]:
    return (
        admission.requester_user_id,
        admission.billing_principal.kind,
        admission.billing_principal.id,
        admission.credential.source,
        admission.credential.credential_id,
        admission.credential.key_version,
        admission.credential.org_id,
        admission.membership_id,
        admission.authz_version,
        admission.root_task_id,
    )


class TaskEnvelopeConsumer:
    """Turn an untrusted delivery object into a verified task delivery."""

    def __init__(
        self,
        *,
        keyring: Mapping[str, bytes],
        authz: AuthzPort,
        clock: Callable[[], datetime],
        pre_execution_policy: Callable[[], None] | None = None,
    ) -> None:
        keyring_failed = False
        try:
            copied_keyring = dict(keyring)
        except Exception:
            keyring_failed = True
            copied_keyring = {}
        if keyring_failed:
            raise InvalidTaskEnvelope() from None
        self._keyring = MappingProxyType(copied_keyring)
        self._authz = authz
        self._clock = clock
        self._pre_execution_policy = (
            pre_execution_policy
            if pre_execution_policy is not None
            else _allow_execution
        )

    async def consume(
        self,
        raw_delivery: dict[str, Any],
        *,
        expected_root_task_id: str,
    ) -> VerifiedTaskDelivery:
        parse_failure: type[InvalidTaskEnvelope] | None = None
        signed: SignedTaskEnvelope | None = None
        signed_payload: dict[str, Any] | None = None
        try:
            if type(raw_delivery) is not dict:
                raise InvalidTaskEnvelope()
            fields = set(raw_delivery)
            if fields not in (
                _DELIVERY_FIELDS,
                _DELIVERY_FIELDS | {"billing_metadata"},
            ):
                raise InvalidTaskEnvelope()
            billing_metadata = raw_delivery.get("billing_metadata")
            if billing_metadata is not None and type(billing_metadata) is not dict:
                raise InvalidTaskEnvelope()

            signed = SignedTaskEnvelope.from_dict(raw_delivery["task_envelope_v2"])
            signed.verify(
                self._keyring,
                now=self._clock(),
                expected_task_type=raw_delivery["task_type"],
                expected_project_id=raw_delivery["project_id"],
                expected_root_task_id=expected_root_task_id,
                expected_requester_user_id=raw_delivery["requester_user_id"],
            )
            signed_payload = signed.to_dict()["payload"]
            flat_payload = {
                field_name: raw_delivery[field_name]
                for field_name in _SIGNED_PAYLOAD_FIELDS
            }
            if set(signed_payload) != _SIGNED_PAYLOAD_FIELDS or not _strictly_equal(
                signed_payload, flat_payload
            ):
                raise InvalidTaskEnvelope()
        except StaleTaskEnvelope:
            parse_failure = StaleTaskEnvelope
        except InvalidTaskEnvelope:
            parse_failure = InvalidTaskEnvelope
        except Exception:
            parse_failure = InvalidTaskEnvelope
        if parse_failure is not None:
            raise parse_failure() from None

        policy_failed = False
        try:
            self._pre_execution_policy()
        except Exception:
            policy_failed = True
        if policy_failed:
            raise _refuse_verified(
                _PreExecutionPolicyError("P0_GRAY_DISABLED"),
                signed,
                signed_payload,
            ) from None

        authority_failed = False
        authority_failure_kind: str | None = None
        current_admission: AdmissionContext | None = None
        try:
            current_admission = await self._authz.admit_model_task(
                user_id=signed.admission.requester_user_id,
                root_task_id=signed.admission.root_task_id,
            )
            if _authority_tuple(current_admission) != _authority_tuple(
                signed.admission
            ):
                authority_failed = True
        except AuthzServiceUnavailable:
            authority_failure_kind = "unavailable"
        except AuthzServiceFault:
            authority_failure_kind = "fault"
        except AuthzError:
            authority_failed = True
        except Exception:
            authority_failure_kind = "fault"
        if authority_failure_kind is not None:
            raise TaskAuthorityUnavailable(
                failure_kind=authority_failure_kind,
                settlement=_rejected_settlement(signed, signed_payload),
            ) from None
        if authority_failed:
            raise _refuse_verified(
                StaleTaskEnvelope(),
                signed,
                signed_payload,
            ) from None

        return VerifiedTaskDelivery(
            envelope_id=signed.envelope_id,
            admission=signed.admission,
            task_type=signed.task_type,
            project_id=signed.project_id,
            requester_user_id=signed.admission.requester_user_id,
            episode=signed_payload["episode"],
            beat_num=signed_payload["beat_num"],
            scope=signed_payload["scope"],
            queue_kind=signed_payload["queue_kind"],
            payload=signed_payload["payload"],
            billing_metadata=(
                dict(raw_delivery["billing_metadata"])
                if "billing_metadata" in raw_delivery
                else None
            ),
        )
