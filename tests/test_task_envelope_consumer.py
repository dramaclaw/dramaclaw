from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from importlib import import_module

import pytest

from novelvideo.ports.authz import (
    AdmissionContext,
    AuthzServiceFault,
    AuthzServiceUnavailable,
    BillingPrincipal,
)
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.task_backend.envelope import SignedTaskEnvelope

NOW = datetime(2026, 8, 3, 4, 5, 6, tzinfo=timezone.utc)
KEYRING = {"active-v1": b"a" * 32, "retired-v1": b"r" * 32}


def _admission(
    *,
    admission_id: str = "admission-1",
    admitted_at: str = "2026-08-03T04:05:00Z",
    key_version: int = 7,
) -> AdmissionContext:
    return AdmissionContext(
        requester_user_id="user-1",
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=key_version,
            org_id="org-1",
        ),
        admission_id=admission_id,
        root_task_id="task-root",
        admitted_at=admitted_at,
        membership_id="membership-1",
        authz_version=9,
    )


def _delivery() -> dict:
    payload = {
        "episode": 3,
        "beat_num": 2,
        "scope": "selected",
        "queue_kind": "video",
        "payload": {"prompt": "safe business input"},
    }
    signed = SignedTaskEnvelope.sign(
        admission=_admission(),
        envelope_id="envelope-1",
        task_type="single_video",
        project_id="project-1",
        payload=payload,
        issued_at="2026-08-03T04:00:00Z",
        expires_at="2026-08-04T04:00:00Z",
        signing_key_id="active-v1",
        signing_key=KEYRING["active-v1"],
    )
    return {
        "project_id": "project-1",
        "requester_user_id": "user-1",
        "task_type": "single_video",
        **payload,
        "task_envelope_v2": signed.to_dict(),
    }


BILLING_METADATA = {
    "feature_credit_reservation_id": "reservation-1",
    "feature_credit_charge_id": "reservation-1",
    "feature_credit_cost": "12",
}


def _billed_delivery() -> dict:
    delivery = _delivery()
    delivery["billing_metadata"] = dict(BILLING_METADATA)
    return delivery


def _expired_delivery() -> dict:
    payload = {
        "episode": 3,
        "beat_num": 2,
        "scope": "selected",
        "queue_kind": "video",
        "payload": {"prompt": "safe business input"},
    }
    signed = SignedTaskEnvelope.sign(
        admission=_admission(),
        envelope_id="envelope-1",
        task_type="single_video",
        project_id="project-1",
        payload=payload,
        issued_at="2026-08-01T04:00:00Z",
        expires_at="2026-08-02T04:00:00Z",
        signing_key_id="active-v1",
        signing_key=KEYRING["active-v1"],
    )
    return {
        "project_id": "project-1",
        "requester_user_id": "user-1",
        "task_type": "single_video",
        **payload,
        "task_envelope_v2": signed.to_dict(),
        "billing_metadata": dict(BILLING_METADATA),
    }


class FakeAuthz:
    def __init__(self, admission: AdmissionContext | None = None) -> None:
        self.admission = admission or _admission(
            admission_id="fresh-admission",
            admitted_at="2026-08-03T04:05:05Z",
        )
        self.calls: list[dict[str, str]] = []

    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        self.calls.append({"user_id": user_id, "root_task_id": root_task_id})
        return self.admission


class RaisingAuthz:
    def __init__(self, failure: BaseException) -> None:
        self.failure = failure
        self.calls: list[dict[str, str]] = []

    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        self.calls.append({"user_id": user_id, "root_task_id": root_task_id})
        raise self.failure


@pytest.mark.asyncio
async def test_consumer_accepts_valid_delivery_after_authoritative_recheck(monkeypatch):
    try:
        consumer_module = import_module("novelvideo.task_backend.consumer")
    except ModuleNotFoundError:
        pytest.fail("TaskEnvelopeConsumer behavior contract is missing", pytrace=False)
    authz = FakeAuthz()
    consumer = consumer_module.TaskEnvelopeConsumer(
        keyring=KEYRING,
        authz=authz,
        clock=lambda: NOW,
    )
    from novelvideo import ports
    from novelvideo.ports import registry

    assert "task_envelope_consumer" in registry._EE_REQUIRED_PORTS
    accessor = getattr(ports, "get_task_envelope_consumer", None)
    assert accessor is not None
    monkeypatch.setitem(registry._PORTS, "task_envelope_consumer", consumer)
    assert accessor() is consumer

    verified = await consumer.consume(
        _delivery(),
        expected_root_task_id="task-root",
    )

    assert authz.calls == [{"user_id": "user-1", "root_task_id": "task-root"}]
    assert verified.envelope_id == "envelope-1"
    assert verified.admission == _admission()
    assert verified.task_type == "single_video"
    assert verified.project_id == "project-1"
    assert verified.requester_user_id == "user-1"
    assert verified.episode == 3
    assert verified.beat_num == 2
    assert verified.scope == "selected"
    assert verified.queue_kind == "video"
    assert verified.payload == {"prompt": "safe business input"}


@pytest.mark.asyncio
async def test_consumer_rejects_signed_flat_payload_mismatch_before_authority_read():
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    authz = FakeAuthz()
    consumer = TaskEnvelopeConsumer(keyring=KEYRING, authz=authz, clock=lambda: NOW)
    delivery = _delivery()
    delivery["episode"] = True

    with pytest.raises(InvalidTaskEnvelope) as captured:
        await consumer.consume(delivery, expected_root_task_id="task-root")

    assert type(captured.value) is InvalidTaskEnvelope
    assert captured.value.code == "TASK_ENVELOPE_INVALID"
    assert str(captured.value) == "invalid task envelope"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert authz.calls == []


@pytest.mark.asyncio
async def test_consumer_rejects_tampered_signature_with_stable_invalid():
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    authz = FakeAuthz()
    consumer = TaskEnvelopeConsumer(keyring=KEYRING, authz=authz, clock=lambda: NOW)
    delivery = _delivery()
    delivery["task_envelope_v2"]["signature"] = "0" * 64

    with pytest.raises(InvalidTaskEnvelope) as captured:
        await consumer.consume(delivery, expected_root_task_id="task-root")

    assert type(captured.value) is InvalidTaskEnvelope
    assert captured.value.code == "TASK_ENVELOPE_INVALID"
    assert str(captured.value) == "invalid task envelope"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert authz.calls == []


@pytest.mark.asyncio
async def test_consumer_rejects_changed_credential_version_as_stale():
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
    from novelvideo.task_backend.envelope import StaleTaskEnvelope

    authz = FakeAuthz(
        _admission(
            admission_id="fresh-admission",
            admitted_at="2026-08-03T04:05:05Z",
            key_version=8,
        )
    )
    consumer = TaskEnvelopeConsumer(keyring=KEYRING, authz=authz, clock=lambda: NOW)

    with pytest.raises(StaleTaskEnvelope) as captured:
        await consumer.consume(_delivery(), expected_root_task_id="task-root")

    assert captured.value.code == "TASK_ENVELOPE_STALE"
    assert str(captured.value) == "stale task envelope"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert authz.calls == [{"user_id": "user-1", "root_task_id": "task-root"}]


@pytest.mark.asyncio
async def test_consumer_runs_policy_after_verification_before_authority_read():
    from novelvideo.ports.authz import AuthzError
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer

    authz = FakeAuthz()
    policy_calls: list[str] = []

    def reject_execution() -> None:
        policy_calls.append("called")
        raise RuntimeError("policy-secret-canary")

    consumer = TaskEnvelopeConsumer(
        keyring=KEYRING,
        authz=authz,
        clock=lambda: NOW,
        pre_execution_policy=reject_execution,
    )

    with pytest.raises(AuthzError) as captured:
        await consumer.consume(_delivery(), expected_root_task_id="task-root")

    assert captured.value.code == "P0_GRAY_DISABLED"
    assert "policy-secret-canary" not in str(captured.value)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert policy_calls == ["called"]
    assert authz.calls == []


@pytest.mark.asyncio
async def test_consumer_preserves_explicit_falsey_policy_callback():
    from novelvideo.ports.authz import AuthzError
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer

    authz = FakeAuthz()

    class FalseyRejectPolicy:
        def __bool__(self) -> bool:
            return False

        def __call__(self) -> None:
            raise RuntimeError("must not be replaced by the default policy")

    consumer = TaskEnvelopeConsumer(
        keyring=KEYRING,
        authz=authz,
        clock=lambda: NOW,
        pre_execution_policy=FalseyRejectPolicy(),
    )

    with pytest.raises(AuthzError) as captured:
        await consumer.consume(_delivery(), expected_root_task_id="task-root")

    assert captured.value.code == "P0_GRAY_DISABLED"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert authz.calls == []


@pytest.mark.asyncio
async def test_consumer_verifies_envelope_before_running_policy():
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    authz = FakeAuthz()
    policy_calls: list[str] = []
    consumer = TaskEnvelopeConsumer(
        keyring=KEYRING,
        authz=authz,
        clock=lambda: NOW,
        pre_execution_policy=lambda: policy_calls.append("called"),
    )
    delivery = _delivery()
    delivery["task_envelope_v2"]["signature"] = "0" * 64

    with pytest.raises(InvalidTaskEnvelope):
        await consumer.consume(delivery, expected_root_task_id="task-root")

    assert policy_calls == []
    assert authz.calls == []


@pytest.mark.asyncio
async def test_policy_rejection_carries_verified_settlement_identity():
    """灰度关闭发生在 verify 成功之后，所以身份是可信的，允许驱动退款。"""
    from novelvideo.ports.authz import AuthzError
    from novelvideo.task_backend.consumer import (
        TaskEnvelopeConsumer,
        VerifiedTaskDelivery,
    )

    authz = FakeAuthz()

    def reject_execution() -> None:
        raise RuntimeError("policy-secret-canary")

    consumer = TaskEnvelopeConsumer(
        keyring=KEYRING,
        authz=authz,
        clock=lambda: NOW,
        pre_execution_policy=reject_execution,
    )

    with pytest.raises(AuthzError) as captured:
        await consumer.consume(_billed_delivery(), expected_root_task_id="task-root")

    settlement = captured.value.settlement
    assert settlement is not None
    # 刻意不是 VerifiedTaskDelivery：那个类型是「可以进 runner」的凭证。
    assert not isinstance(settlement, VerifiedTaskDelivery)
    assert settlement.project_id == "project-1"
    assert settlement.requester_user_id == "user-1"
    assert settlement.task_type == "single_video"
    assert settlement.episode == 3
    assert settlement.beat_num == 2
    assert settlement.scope == "selected"
    assert settlement.root_task_id == "task-root"
    assert not hasattr(settlement, "billing_metadata")
    assert "policy-secret-canary" not in str(captured.value)
    assert captured.value.code == "P0_GRAY_DISABLED"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


@pytest.mark.asyncio
async def test_stale_authority_rejection_carries_verified_settlement_identity():
    """authz 漂移同样发生在 verify 之后——这是本条最高频的触发源。"""
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
    from novelvideo.task_backend.envelope import StaleTaskEnvelope

    authz = FakeAuthz(
        _admission(
            admission_id="fresh-admission",
            admitted_at="2026-08-03T04:05:05Z",
            key_version=8,
        )
    )
    consumer = TaskEnvelopeConsumer(keyring=KEYRING, authz=authz, clock=lambda: NOW)

    with pytest.raises(StaleTaskEnvelope) as captured:
        await consumer.consume(_billed_delivery(), expected_root_task_id="task-root")

    settlement = captured.value.settlement
    assert settlement is not None
    assert settlement.project_id == "project-1"
    assert settlement.task_type == "single_video"
    assert settlement.root_task_id == "task-root"
    assert not hasattr(settlement, "billing_metadata")
    assert captured.value.code == "TASK_ENVELOPE_STALE"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "failure_kind"),
    [
        (AuthzServiceUnavailable(), "unavailable"),
        (AuthzServiceFault(), "fault"),
    ],
)
async def test_authz_service_failure_is_not_misclassified_as_stale(
    failure, failure_kind
):
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
    from novelvideo.task_backend.envelope import (
        InvalidTaskEnvelope,
        TaskAuthorityUnavailable,
    )

    authz = RaisingAuthz(failure)
    consumer = TaskEnvelopeConsumer(keyring=KEYRING, authz=authz, clock=lambda: NOW)
    delivery = _billed_delivery()
    delivery["billing_metadata"] = {
        "feature_credit_reservation_id": "attacker-controlled-reservation"
    }

    with pytest.raises(TaskAuthorityUnavailable) as captured:
        await consumer.consume(delivery, expected_root_task_id="task-root")

    assert not isinstance(captured.value, InvalidTaskEnvelope)
    assert captured.value.failure_kind == failure_kind
    assert captured.value.settlement.root_task_id == "task-root"
    assert captured.value.settlement.project_id == "project-1"
    assert not hasattr(captured.value.settlement, "billing_metadata")
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert authz.calls == [{"user_id": "user-1", "root_task_id": "task-root"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["flat_mismatch", "tampered_signature", "expired"])
async def test_unverified_rejection_withholds_settlement_identity(case):
    """签名没通过就没有可信身份，绝不能拿它驱动资金动作。"""
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    authz = FakeAuthz()
    consumer = TaskEnvelopeConsumer(keyring=KEYRING, authz=authz, clock=lambda: NOW)
    if case == "expired":
        delivery = _expired_delivery()
    else:
        delivery = _billed_delivery()
        if case == "flat_mismatch":
            delivery["episode"] = True
        else:
            delivery["task_envelope_v2"]["signature"] = "0" * 64

    with pytest.raises(InvalidTaskEnvelope) as captured:
        await consumer.consume(delivery, expected_root_task_id="task-root")

    assert captured.value.settlement is None
    assert authz.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exit_type",
    [asyncio.CancelledError, GeneratorExit, KeyboardInterrupt, SystemExit],
)
async def test_consumer_policy_propagates_exit_exceptions(exit_type):
    from novelvideo.task_backend.consumer import TaskEnvelopeConsumer

    authz = FakeAuthz()

    def exit_policy() -> None:
        raise exit_type()

    consumer = TaskEnvelopeConsumer(
        keyring=KEYRING,
        authz=authz,
        clock=lambda: NOW,
        pre_execution_policy=exit_policy,
    )

    with pytest.raises(exit_type):
        await consumer.consume(_delivery(), expected_root_task_id="task-root")

    assert authz.calls == []
