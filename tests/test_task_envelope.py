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


def test_task_envelope_includes_signing_key_id_for_rotation():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    assert envelope.signing_key_id == "task-key-v1"
    assert envelope.to_dict()["signing_key_id"] == "task-key-v1"


def test_task_envelope_canonical_serialization_is_stable_and_secret_free():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={"z": 1, "a": "value"},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    assert envelope.canonical_payload() == envelope.canonical_payload()
    assert json.loads(envelope.payload_json) == {"a": "value", "z": 1}
    assert "server-signing-key" not in repr(envelope)
    envelope.verify({"task-key-v1": b"server-signing-key"})


def test_external_or_tampered_task_envelope_fails_verification():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    with pytest.raises(InvalidTaskEnvelope):
        envelope.verify({"task-key-v1": b"attacker-key"})


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
            signing_key_id="task-key-v1",
            signing_key=b"server-signing-key",
        )


def test_task_envelope_round_trips_through_transport_dict():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={"prompt": "a story"},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    restored = SignedTaskEnvelope.from_dict(envelope.to_dict())

    assert restored == envelope
    restored.verify({"task-key-v1": b"server-signing-key"})


def test_task_envelope_rejects_unknown_schema_version():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )
    value = envelope.to_dict()
    value["schema_version"] = 2

    with pytest.raises(InvalidTaskEnvelope, match="schema"):
        SignedTaskEnvelope.from_dict(value)


def test_task_envelope_rejects_missing_required_field():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )
    value = envelope.to_dict()
    del value["admission"]["membership_id"]

    with pytest.raises(InvalidTaskEnvelope, match="malformed"):
        SignedTaskEnvelope.from_dict(value)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value.update({"api_key": "secret-value"}),
        lambda value: value.update({"unexpected": "value"}),
        lambda value: value["admission"].update({"authorization": "Bearer secret-value"}),
        lambda value: value["admission"]["credential"].update({"unexpected": "value"}),
    ],
)
def test_task_envelope_rejects_extra_fields(mutate):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )
    value = envelope.to_dict()
    mutate(value)

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(value)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", "1"),
        ("task_type", 1),
        ("project_id", 1),
        ("payload", []),
        ("signature", 1),
    ],
)
def test_task_envelope_rejects_coerced_transport_types(field, value):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )
    transport = envelope.to_dict()
    transport[field] = value

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize(
    "payload",
    [
        {"ApiKey": "secret"},
        {"nested": {"api-key": "secret"}},
        {"nested": [{"API Key": "secret"}]},
        {"nested": {"accessToken": "secret"}},
        {"nested": {"refreshToken": "secret"}},
        {"nested": {"credentialSecret": "secret"}},
        {"nested": {"Authorization": "Bearer secret"}},
        {"nested": [{"deeper": {"token": "secret"}}]},
    ],
)
def test_task_envelope_rejects_normalized_sensitive_field_variants(payload):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope, match="sensitive"):
        SignedTaskEnvelope.sign(
            admission=_admission(),
            task_type="image_generation",
            project_id="project_1",
            payload=payload,
            signing_key_id="task-key-v1",
            signing_key=b"server-signing-key",
        )


@pytest.mark.parametrize(
    "payload",
    [
        {"X-API-Key": "secret"},
        {"nested": {"x_api_key": "secret"}},
        {"nested": [{"deeper": {"bearerToken": "secret"}}]},
        {"nested": {"bearer-token": "secret"}},
        {"auth_token": "secret"},
        {"nested": {"authToken": "secret"}},
        {"id_token": "secret"},
        {"nested": [{"deeper": {"idToken": "secret"}}]},
    ],
)
def test_task_envelope_rejects_additional_credential_field_variants(payload):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope, match="sensitive"):
        SignedTaskEnvelope.sign(
            admission=_admission(),
            task_type="image_generation",
            project_id="project_1",
            payload=payload,
            signing_key_id="task-key-v1",
            signing_key=b"server-signing-key",
        )


def test_task_envelope_allows_non_secret_token_business_fields():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    payload = {
        "token_count": 12,
        "max_tokens": 100,
        "tokenizer": "example",
        "tokenized_text": "ordinary text",
        "authorization_status": "pending",
        "id_token_count": 3,
    }
    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="text_generation",
        project_id="project_1",
        payload=payload,
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    envelope.verify({"task-key-v1": b"server-signing-key"})
    assert envelope.to_dict()["payload"] == payload


def test_task_envelope_repr_hides_payload_and_signature():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    canary = "BT1-CANARY-SECRET-7f91"
    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={"prompt": canary},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    rendered = repr(envelope)
    assert canary not in rendered
    assert envelope.signature not in rendered
    assert "server-signing-key" not in rendered


def test_task_envelope_rejects_unknown_signing_key_id():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="unknown-key-id",
        signing_key=b"same-key-bytes",
    )

    with pytest.raises(InvalidTaskEnvelope, match="signing key"):
        envelope.verify({"task-key-v1": b"same-key-bytes"})


def test_task_envelope_rejects_tampered_key_id_even_when_key_bytes_match():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="current",
        signing_key=b"same-key-bytes",
    )
    transport = envelope.to_dict()
    transport["signing_key_id"] = "previous"
    tampered = SignedTaskEnvelope.from_dict(transport)

    with pytest.raises(InvalidTaskEnvelope, match="signature"):
        tampered.verify(
            {
                "current": b"same-key-bytes",
                "previous": b"same-key-bytes",
            }
        )


@pytest.mark.parametrize(
    ("signing_key_id", "signing_key"),
    [
        ("current", b"current-key"),
        ("previous", b"previous-key"),
    ],
)
def test_task_envelope_verifies_current_and_previous_rotation_keys(
    signing_key_id, signing_key
):
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id=signing_key_id,
        signing_key=signing_key,
    )

    envelope.verify(
        {
            "current": b"current-key",
            "previous": b"previous-key",
        }
    )


def test_task_envelope_rejects_empty_keyring_value():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    with pytest.raises(InvalidTaskEnvelope, match="signing key"):
        envelope.verify({"task-key-v1": b""})


def test_task_envelope_rejects_direct_key_bytes_during_verification():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )

    with pytest.raises(InvalidTaskEnvelope, match="signing key"):
        envelope.verify(b"server-signing-key")


@pytest.mark.parametrize("mutation", ["missing", "empty"])
def test_task_envelope_rejects_missing_or_empty_signing_key_id(mutation):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )
    transport = envelope.to_dict()
    if mutation == "missing":
        del transport["signing_key_id"]
    else:
        transport["signing_key_id"] = ""

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize(
    "field_name",
    ["billing", "reservation_id", "credit_reservation_id", "refund_id"],
)
def test_task_envelope_rejects_billing_fields_at_protocol_top_level(field_name):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="image_generation",
        project_id="project_1",
        payload={},
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )
    transport = envelope.to_dict()
    transport[field_name] = "not-part-of-v1"

    with pytest.raises(InvalidTaskEnvelope, match="malformed"):
        SignedTaskEnvelope.from_dict(transport)


def test_task_envelope_allows_signed_billing_fields_inside_payload_and_detects_tampering():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    payload = {
        "billing": {"mode": "existing-business-metadata"},
        "reservation_id": "reservation-1",
        "credit_reservation_id": "credit-reservation-1",
        "refund_id": "refund-1",
    }
    envelope = SignedTaskEnvelope.sign(
        admission=_admission(),
        task_type="existing_business_task",
        project_id="project_1",
        payload=payload,
        signing_key_id="task-key-v1",
        signing_key=b"server-signing-key",
    )
    signing_keys = {"task-key-v1": b"server-signing-key"}
    envelope.verify(signing_keys)

    transport = envelope.to_dict()
    transport["payload"]["credit_reservation_id"] = "tampered"
    tampered = SignedTaskEnvelope.from_dict(transport)

    with pytest.raises(InvalidTaskEnvelope, match="signature"):
        tampered.verify(signing_keys)
