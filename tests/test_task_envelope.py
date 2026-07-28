import json

import pytest


def _admission():
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    return AdmissionContext(
        requester_user_id="user_1",
        billing_principal=BillingPrincipal(kind="organization", id="org_1"),
        credential=CredentialReference("organization", "cred_1", 2, "org_1"),
        admission_id="adm_1",
        root_task_id="task_1",
        admitted_at="2026-07-28T00:00:00Z",
        membership_id="mem_1",
        authz_version=7,
    )


def test_task_envelope_canonical_serialization_is_stable_and_secret_free():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={"z": 1, "a": "value"},
        signing_key=b"server-signing-key",
    )

    assert envelope.canonical_payload() == envelope.canonical_payload()
    assert json.loads(envelope.payload_json) == {"a": "value", "z": 1}
    assert "server-signing-key" not in repr(envelope)
    envelope.verify(b"server-signing-key")


def test_external_or_tampered_task_envelope_fails_verification():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key=b"server-signing-key",
    )

    with pytest.raises(InvalidTaskEnvelope):
        envelope.verify(b"attacker-key")


@pytest.mark.parametrize(
    "payload",
    [
        {"api_key": "secret"},
        {"request": {"authorization": "Bearer secret"}},
        {"items": [{"access_token": "secret"}]},
    ],
)
def test_task_envelope_rejects_sensitive_payload_fields(payload):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope, match="sensitive"):
        SignedTaskEnvelope.sign(
            admission=_admission(),
            task_type="image_generation",
            project_id="project_1",
            payload=payload,
            signing_key=b"server-signing-key",
        )


def test_task_envelope_round_trips_through_transport_dict():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={"prompt": "a story"},
        signing_key=b"server-signing-key",
    )

    restored = SignedTaskEnvelope.from_dict(envelope.to_dict())

    assert restored == envelope
    restored.verify(b"server-signing-key")


def test_task_envelope_rejects_unknown_schema_version():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key=b"server-signing-key",
    )
    value = envelope.to_dict()
    value["schema_version"] = 2

    with pytest.raises(InvalidTaskEnvelope, match="schema"):
        SignedTaskEnvelope.from_dict(value).verify(b"server-signing-key")


def test_task_envelope_rejects_missing_required_field():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key=b"server-signing-key",
    )
    value = envelope.to_dict()
    del value["admission"]["membership_id"]

    with pytest.raises(InvalidTaskEnvelope, match="malformed"):
        SignedTaskEnvelope.from_dict(value)
