from dataclasses import FrozenInstanceError, fields

import pytest


def _spec(**overrides):
    from novelvideo.ports.egress_operations import HandleKind, OperationSpec

    values = {
        "organization_id": "org_1",
        "project_id": "project_1",
        "root_task_id": "root_1",
        "business_task_id": "episode:1:beat:2:image",
        "capability": "image.generate",
        "credential_id": "credential_1",
        "credential_version": 3,
        "request_digest": "a" * 64,
        "handle_kind": HandleKind.PROVIDER_JOB,
    }
    values.update(overrides)
    return OperationSpec(**values)


def test_operation_spec_is_frozen_and_requires_exact_non_empty_fields() -> None:
    spec = _spec()

    with pytest.raises(FrozenInstanceError):
        spec.capability = "video.generate"

    for field_name in (
        "organization_id",
        "project_id",
        "root_task_id",
        "business_task_id",
        "capability",
        "credential_id",
        "request_digest",
    ):
        with pytest.raises(ValueError, match=field_name):
            _spec(**{field_name: " \t"})
        with pytest.raises(TypeError, match=field_name):
            _spec(**{field_name: 1})

    for value in (True, 0, -1, 1.0):
        with pytest.raises((TypeError, ValueError), match="credential_version"):
            _spec(credential_version=value)


def test_operation_key_uses_only_stable_identity_fields() -> None:
    first = _spec()
    same_identity = _spec(
        credential_id="credential_2",
        credential_version=99,
        request_digest="b" * 64,
    )

    assert first.operation_key == same_identity.operation_key
    assert len(first.operation_key) == 64
    assert first.operation_key == (
        "6364e3f1e602b759bbecf2a8fccc6c119bed41c263c30b25b8b98cc6fb40b1b2"
    )

    for field_name in (
        "organization_id",
        "project_id",
        "root_task_id",
        "business_task_id",
        "capability",
    ):
        assert (
            _spec(**{field_name: f"different-{field_name}"}).operation_key
            != first.operation_key
        )


def test_request_digest_is_canonical_and_rejects_non_json_values() -> None:
    from novelvideo.ports.egress_operations import canonical_request_digest

    left = {"prompt": "雪", "options": {"width": 720, "steps": [1, 2.5, True, None]}}
    right = {"options": {"steps": [1, 2.5, True, None], "width": 720}, "prompt": "雪"}

    assert canonical_request_digest(left) == canonical_request_digest(right)
    assert canonical_request_digest(left) == (
        "3643240d37df1ac0cf4ca231a6d7051d2286f13eda93344f5120a11a9f7b3601"
    )

    for invalid in (("not", "json"), {1: "bad key"}, {"value": float("nan")}, object()):
        with pytest.raises(ValueError, match="canonical JSON"):
            canonical_request_digest(invalid)


def test_stable_states_results_and_errors_expose_no_payload_or_secret_fields() -> None:
    from novelvideo.ports.egress_operations import (
        EgressOperationError,
        OperationClaimResult,
        OperationSnapshot,
        OperationState,
    )

    assert {state.value for state in OperationState} == {
        "dispatching",
        "rejected_before_submit",
        "accepted",
        "completed",
        "unknown",
    }
    assert {field.name for field in fields(OperationSnapshot)} == {
        "operation_id",
        "operation_key",
        "state",
        "version",
    }
    assert {field.name for field in fields(OperationClaimResult)} == {
        "won",
        "operation",
        "transition_token",
    }

    unsafe = "postgresql://user:secret@db/provider-job-canary"
    for code in ("EGRESS_OPERATION_CONFLICT", "EGRESS_OPERATION_INVALID_TRANSITION"):
        error = EgressOperationError(code, unsafe)
        assert error.code == code
        assert unsafe not in str(error)
        assert unsafe not in repr(error)


def test_port_exposes_only_the_minimal_durable_transition_surface() -> None:
    from novelvideo.ports.egress_operations import EgressOperationPort

    methods = {
        name
        for name, value in EgressOperationPort.__dict__.items()
        if callable(value) and not name.startswith("_")
    }
    assert methods == {
        "claim",
        "mark_rejected_before_submit",
        "mark_accepted",
        "mark_completed",
        "mark_unknown",
    }
