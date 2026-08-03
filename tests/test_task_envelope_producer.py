import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from novelvideo.ports.authz import (
    AdmissionContext,
    AuthzError,
    BillingPrincipal,
)
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

NOW = datetime(2026, 8, 3, 4, 5, 6, 987654, tzinfo=timezone.utc)
KEYRING = {"active-v1": b"a" * 32, "retired-v1": b"r" * 32}


def _admission(*, user_id="user-1", root_task_id="task-root"):
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=7,
            org_id="org-1",
        ),
        admission_id="admission-1",
        root_task_id=root_task_id,
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-1",
        authz_version=9,
    )


class FakeAuthz:
    def __init__(self, *, failure=None):
        self.calls = []
        self.failure = failure

    async def admit_model_task(self, *, user_id, root_task_id):
        self.calls.append({"user_id": user_id, "root_task_id": root_task_id})
        if self.failure is not None:
            raise self.failure
        return _admission(user_id=user_id, root_task_id=root_task_id)


def _producer(authz=None, ids=None, clock=lambda: NOW):
    from novelvideo.task_backend.producer import TaskEnvelopeProducer

    generated = iter(ids or ["envelope-1", "envelope-2", "envelope-3", "envelope-4"])
    return TaskEnvelopeProducer(
        authz=authz or FakeAuthz(),
        active_key_id="active-v1",
        keyring=KEYRING,
        clock=clock,
        envelope_id_factory=lambda: next(generated),
    )


@pytest.mark.asyncio
async def test_sign_top_level_admits_once_and_produces_verifiable_envelope():
    authz = FakeAuthz()
    producer = _producer(authz)

    signed = await producer.sign_top_level(
        user_id="user-1",
        root_task_id="reserved-task-1",
        task_type="single_video",
        project_id="project-1",
        payload={"episode": 1},
    )

    assert authz.calls == [{"user_id": "user-1", "root_task_id": "reserved-task-1"}]
    assert signed.envelope_id == "envelope-1"
    assert signed.envelope_id != signed.admission.root_task_id
    assert signed.issued_at == "2026-08-03T04:05:06Z"
    assert signed.expires_at == "2026-08-04T04:05:06Z"
    roundtrip = SignedTaskEnvelope.from_dict(signed.to_dict())
    roundtrip.verify(
        KEYRING,
        now=NOW,
        expected_task_type="single_video",
        expected_project_id="project-1",
        expected_root_task_id="reserved-task-1",
        expected_requester_user_id="user-1",
    )


@pytest.mark.asyncio
async def test_descendants_inherit_admission_without_reauthorization():
    authz = FakeAuthz()
    producer = _producer(authz)
    parent = await producer.sign_top_level(
        user_id="user-1",
        root_task_id="reserved-task-1",
        task_type="parent",
        project_id="project-1",
        payload={},
    )

    child = producer.sign_descendant(
        parent=parent,
        task_type="child",
        project_id="project-1",
        payload={"generation": 2},
    )
    grandchild = producer.sign_descendant(
        parent=child,
        task_type="grandchild",
        project_id="project-1",
        payload={"generation": 3},
    )

    assert len(authz.calls) == 1
    assert child.admission is parent.admission
    assert grandchild.admission is parent.admission
    assert {parent.envelope_id, child.envelope_id, grandchild.envelope_id} == {
        "envelope-1",
        "envelope-2",
        "envelope-3",
    }


@pytest.mark.asyncio
async def test_descendant_rejects_cross_project_and_forged_parent():
    producer = _producer()
    parent = await producer.sign_top_level(
        user_id="user-1",
        root_task_id="reserved-task-1",
        task_type="parent",
        project_id="project-1",
        payload={},
    )

    with pytest.raises(InvalidTaskEnvelope):
        producer.sign_descendant(
            parent=parent,
            task_type="child",
            project_id="project-2",
            payload={},
        )

    forged = SignedTaskEnvelope(**{**parent.__dict__, "signature": "0" * 64})
    with pytest.raises(InvalidTaskEnvelope):
        producer.sign_descendant(
            parent=forged,
            task_type="child",
            project_id="project-1",
            payload={},
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "forged_key",
    [
        "admission",
        "Admission-ID",
        "ROOT_TASK_ID",
        "requester-user-id",
        "Billing Principal",
        "credential",
        "api-key",
        "Authorization",
    ],
)
async def test_lineage_and_secret_injection_is_rejected_before_admission(
    forged_key,
):
    authz = FakeAuthz()
    producer = _producer(authz)

    with pytest.raises(InvalidTaskEnvelope) as captured:
        await producer.sign_top_level(
            user_id="user-1",
            root_task_id="reserved-task-1",
            task_type="single_video",
            project_id="project-1",
            payload={"nested": [{"deeper": {forged_key: "canary-secret"}}]},
        )

    assert authz.calls == []
    assert str(captured.value) == "invalid task envelope"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert "canary-secret" not in repr(captured.value)


@pytest.mark.asyncio
async def test_authz_error_preserves_safe_code_and_message_without_chain():
    producer = _producer(FakeAuthz(failure=AuthzError("ORG_MEMBERSHIP_INACTIVE")))

    with pytest.raises(AuthzError) as captured:
        await producer.sign_top_level(
            user_id="user-1",
            root_task_id="reserved-task-1",
            task_type="single_video",
            project_id="project-1",
            payload={},
        )

    assert captured.value.code == "ORG_MEMBERSHIP_INACTIVE"
    assert str(captured.value) == "organization membership is inactive"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


@pytest.mark.asyncio
async def test_ordinary_errors_normalize_but_base_exceptions_propagate():
    ordinary = _producer(FakeAuthz(failure=RuntimeError("ordinary-canary")))
    with pytest.raises(InvalidTaskEnvelope) as captured:
        await ordinary.sign_top_level(
            user_id="user-1",
            root_task_id="reserved-task-1",
            task_type="single_video",
            project_id="project-1",
            payload={},
        )
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert "ordinary-canary" not in repr(captured.value)

    for failure in (
        asyncio.CancelledError(),
        KeyboardInterrupt(),
        SystemExit(),
        GeneratorExit(),
    ):
        producer = _producer(FakeAuthz(failure=failure))
        with pytest.raises(type(failure)):
            await producer.sign_top_level(
                user_id="user-1",
                root_task_id="reserved-task-1",
                task_type="single_video",
                project_id="project-1",
                payload={},
            )


@pytest.mark.asyncio
async def test_descendant_rejects_expired_parent_as_invalid():
    producer = _producer(clock=lambda: NOW)
    parent = await producer.sign_top_level(
        user_id="user-1",
        root_task_id="reserved-task-1",
        task_type="parent",
        project_id="project-1",
        payload={},
    )
    later = NOW + timedelta(days=2)
    validating_producer = _producer(clock=lambda: later)

    with pytest.raises(InvalidTaskEnvelope) as captured:
        validating_producer.sign_descendant(
            parent=parent,
            task_type="child",
            project_id="project-1",
            payload={},
        )

    assert type(captured.value) is InvalidTaskEnvelope
