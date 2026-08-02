from __future__ import annotations

import asyncio
from collections.abc import Iterator, Mapping
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import logging
import traceback

import pytest

KEY_CURRENT = b"c" * 32
KEY_RETIRED = b"r" * 32
ISSUED_AT = "2026-08-02T00:00:00Z"
EXPIRES_AT = "2026-08-02T01:00:00Z"
NOW = datetime(2026, 8, 2, 0, 30, tzinfo=timezone.utc)


class _ExplodingKeyring(Mapping[str, bytes]):
    def __init__(self, error_type: type[BaseException]) -> None:
        self._error_type = error_type

    def __getitem__(self, key: str) -> bytes:
        raise self._error_type("KEYRING-LOOKUP-CANARY")

    def __iter__(self) -> Iterator[str]:
        return iter(("current",))

    def __len__(self) -> int:
        return 1


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


def _sign(**overrides):
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    values = {
        "admission": _admission(),
        "envelope_id": "env_1",
        "task_type": "image_generation",
        "project_id": "project_1",
        "payload": {"prompt": "a story"},
        "issued_at": ISSUED_AT,
        "expires_at": EXPIRES_AT,
        "signing_key_id": "current",
        "signing_key": KEY_CURRENT,
    }
    values.update(overrides)
    return SignedTaskEnvelope.sign(**values)


def _verify(envelope, **overrides):
    values = {
        "signing_keys": {"current": KEY_CURRENT, "retired": KEY_RETIRED},
        "now": NOW,
        "expected_task_type": "image_generation",
        "expected_project_id": "project_1",
        "expected_root_task_id": "task_1",
        "expected_requester_user_id": "user_1",
    }
    values.update(overrides)
    return envelope.verify(**values)


def _resign_transport(transport, *, key=KEY_CURRENT):
    import hashlib
    import hmac

    unsigned = {name: value for name, value in transport.items() if name != "signature"}
    canonical = json.dumps(
        unsigned,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )
    transport["signature"] = hmac.new(
        key, canonical.encode(), hashlib.sha256
    ).hexdigest()
    return transport


def test_task_envelope_v2_round_trip_rotation_and_canonical_stability():
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    current = _sign(payload={"z": 1, "a": "value"})
    retired = _sign(signing_key_id="retired", signing_key=KEY_RETIRED)

    assert current.schema_version == 2
    assert current.canonical_payload() == current.canonical_payload()
    assert current.to_dict()["payload"] == {"a": "value", "z": 1}
    assert SignedTaskEnvelope.from_dict(current.to_dict()) == current
    _verify(current)
    _verify(retired)


def test_task_envelope_accepts_exact_24_hour_lifetime_and_clock_skew_boundaries():
    envelope = _sign(
        issued_at="2026-08-02T00:00:00Z",
        expires_at="2026-08-03T00:00:00Z",
    )

    _verify(envelope, now=datetime(2026, 8, 1, 23, 59, 30, tzinfo=timezone.utc))
    _verify(envelope, now=datetime(2026, 8, 3, 0, 0, 30, tzinfo=timezone.utc))


@pytest.mark.parametrize("schema_version", [1, 3, 0, -1])
def test_task_envelope_rejects_v1_and_unknown_schema_versions(schema_version):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    transport["schema_version"] = schema_version

    with pytest.raises(InvalidTaskEnvelope) as captured:
        SignedTaskEnvelope.from_dict(transport)
    assert captured.value.code == "TASK_ENVELOPE_INVALID"


@pytest.mark.parametrize(
    "field_name",
    [
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
    ],
)
def test_task_envelope_rejects_every_missing_v2_field(field_name):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    del transport[field_name]

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("schema_version", "2"),
        ("schema_version", True),
        ("envelope_id", 1),
        ("task_type", 1),
        ("project_id", 1),
        ("payload", []),
        ("issued_at", 1),
        ("expires_at", 1),
        ("signing_key_id", 1),
        ("signature", 1),
    ],
)
def test_task_envelope_rejects_coerced_transport_types(field_name, value):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    transport[field_name] = value

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize("transport", [None, [], "json", b"json"])
def test_task_envelope_rejects_non_object_transport(transport):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["admission"].update({"authz_version": True}),
        lambda value: value["admission"]["credential"].update({"key_version": True}),
    ],
)
def test_task_envelope_rejects_nested_bool_as_integer(mutate):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    mutate(transport)

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update({"unexpected": "value"}),
        lambda value: value["admission"].update({"unexpected": "value"}),
        lambda value: value["admission"]["credential"].update({"unexpected": "value"}),
        lambda value: value["admission"]["billing_principal"].update(
            {"unexpected": "value"}
        ),
    ],
)
def test_task_envelope_rejects_unknown_fields_at_every_schema_level(mutation):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    mutation(transport)

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize("payload", [{"value": float("nan")}, {"value": float("inf")}])
def test_task_envelope_rejects_non_finite_json_numbers(payload):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope):
        _sign(payload=payload)


@pytest.mark.parametrize("payload", [{"value": {1, 2}}, {"value": b"bytes"}, None, []])
def test_task_envelope_rejects_non_json_or_non_object_payload(payload):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope):
        _sign(payload=payload)


@pytest.mark.parametrize(
    ("issued_at", "expires_at"),
    [
        ("2026-02-30T00:00:00Z", EXPIRES_AT),
        ("2026-08-02T24:00:00Z", EXPIRES_AT),
        ("2026-08-02T00:00:00+00:00", EXPIRES_AT),
        ("2026-08-02T00:00:00.000Z", EXPIRES_AT),
        (ISSUED_AT, "2026-08-02T00:00:00Z"),
        (ISSUED_AT, "2026-08-01T23:59:59Z"),
        (ISSUED_AT, "2026-08-03T00:00:01Z"),
    ],
)
def test_task_envelope_rejects_invalid_time_windows_as_stale(issued_at, expires_at):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope) as captured:
        _sign(issued_at=issued_at, expires_at=expires_at)
    assert captured.value.code == "TASK_ENVELOPE_STALE"


@pytest.mark.parametrize(
    "now",
    [
        datetime(2026, 8, 1, 23, 59, 29, tzinfo=timezone.utc),
        datetime(2026, 8, 2, 1, 0, 31, tzinfo=timezone.utc),
    ],
)
def test_task_envelope_rejects_future_and_expired_envelopes(now):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope) as captured:
        _verify(_sign(), now=now)
    assert captured.value.code == "TASK_ENVELOPE_STALE"


def test_task_envelope_rejects_non_utc_or_naive_verification_now():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    for now in (
        datetime(2026, 8, 2, 0, 30),
        datetime(2026, 8, 2, 8, 30, tzinfo=timezone(timedelta(hours=8))),
    ):
        with pytest.raises(InvalidTaskEnvelope):
            _verify(_sign(), now=now)


@pytest.mark.parametrize("envelope_id", ["", 1, None])
def test_task_envelope_rejects_empty_or_wrong_type_envelope_id(envelope_id):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope):
        _sign(envelope_id=envelope_id)


@pytest.mark.parametrize(
    "key_id",
    ["", "-leading", "contains space", "slash/key", "a" * 65],
)
def test_task_envelope_rejects_invalid_signing_key_id(key_id):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope):
        _sign(signing_key_id=key_id)


@pytest.mark.parametrize("signing_key", [b"", b"short", "x" * 32, bytearray(b"x" * 32)])
def test_task_envelope_rejects_empty_weak_or_wrong_type_signing_key(signing_key):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope):
        _sign(signing_key=signing_key)


@pytest.mark.parametrize(
    "signature",
    ["", "0" * 63, "0" * 65, "G" * 64, "A" * 64, 1],
)
def test_task_envelope_rejects_invalid_signature_shape(signature):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    transport["signature"] = signature

    with pytest.raises(InvalidTaskEnvelope):
        SignedTaskEnvelope.from_dict(transport)


@pytest.mark.parametrize(
    "signing_keys",
    [
        {},
        {"current": b"short"},
        {"current": "x" * 32},
        {"current": bytearray(b"x" * 32)},
        KEY_CURRENT,
    ],
)
def test_task_envelope_rejects_unknown_weak_or_wrong_type_keyring_values(signing_keys):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope):
        _verify(_sign(), signing_keys=signing_keys)


@pytest.mark.parametrize("error_type", [RuntimeError, ValueError])
def test_task_envelope_normalizes_keyring_lookup_exceptions_without_leaking(
    error_type, caplog, capsys
):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    caplog.set_level(logging.DEBUG)

    with pytest.raises(InvalidTaskEnvelope) as captured:
        _verify(_sign(), signing_keys=_ExplodingKeyring(error_type))

    stdout, stderr = capsys.readouterr()
    error = captured.value
    sinks = " ".join(
        (
            str(error),
            repr(error),
            "".join(traceback.format_exception(captured.type, error, captured.tb)),
            caplog.text,
            stdout,
            stderr,
        )
    )

    assert error.code == "TASK_ENVELOPE_INVALID"
    assert error.__cause__ is None
    assert error.__context__ is None
    assert "KEYRING-LOOKUP-CANARY" not in sinks


@pytest.mark.parametrize(
    "error_type",
    [KeyboardInterrupt, GeneratorExit, asyncio.CancelledError],
)
def test_task_envelope_propagates_keyring_lookup_base_exceptions(error_type):
    with pytest.raises(error_type):
        _verify(_sign(), signing_keys=_ExplodingKeyring(error_type))


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("envelope_id", "env_2"),
        ("task_type", "video_generation"),
        ("project_id", "project_2"),
        ("payload", {"prompt": "tampered"}),
        ("issued_at", "2026-08-02T00:00:01Z"),
        ("expires_at", "2026-08-02T01:00:01Z"),
        ("signing_key_id", "retired"),
    ],
)
def test_task_envelope_rejects_tampering_of_every_new_signed_field(field_name, value):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    transport[field_name] = value
    tampered = SignedTaskEnvelope.from_dict(transport)

    with pytest.raises(InvalidTaskEnvelope):
        _verify(tampered)


@pytest.mark.parametrize(
    ("expected_name", "expected_value"),
    [
        ("expected_task_type", "video_generation"),
        ("expected_project_id", "project_2"),
        ("expected_root_task_id", "task_2"),
        ("expected_requester_user_id", "user_2"),
    ],
)
def test_task_envelope_rejects_borrowed_consumer_binding(expected_name, expected_value):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope) as captured:
        _verify(_sign(), **{expected_name: expected_value})
    assert captured.value.code == "TASK_ENVELOPE_INVALID"


@pytest.mark.parametrize(
    "admission_field",
    ["requester_user_id", "root_task_id", "admission_id", "authz_version"],
)
def test_task_envelope_rejects_signed_admission_tampering(admission_field):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    transport["admission"][admission_field] = (
        8 if admission_field == "authz_version" else "tampered"
    )
    tampered = SignedTaskEnvelope.from_dict(transport)

    with pytest.raises(InvalidTaskEnvelope):
        _verify(tampered)


@pytest.mark.parametrize(
    "payload",
    [
        {"ApiKey": "CANARY"},
        {"nested": {"api-key": "CANARY"}},
        {"nested": [{"API Key": "CANARY"}]},
        {"nested": {"accessToken": "CANARY"}},
        {"nested": {"refresh_token": "CANARY"}},
        {"nested": {"credentialSecret": "CANARY"}},
        {"nested": {"Authorization": "CANARY"}},
        {"nested": {"X-API-Key": "CANARY"}},
        {"nested": {"bearerToken": "CANARY"}},
        {"nested": {"auth_token": "CANARY"}},
        {"nested": {"idToken": "CANARY"}},
    ],
)
def test_task_envelope_rejects_sensitive_field_variants_without_leaking(payload):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    with pytest.raises(InvalidTaskEnvelope) as captured:
        _sign(payload=payload)
    rendered = f"{captured.value!s} {captured.value!r}"
    assert "CANARY" not in rendered
    assert all(
        secret_name not in rendered.casefold() for secret_name in ("api", "token")
    )


def test_task_envelope_error_sinks_do_not_leak_sensitive_values(caplog):
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope

    canaries = [
        "PAYLOAD-CANARY-7f91",
        "SIGNATURE-CANARY-7f91",
        "KEY-ID-CANARY-7f91",
        "KEY-CANARY-7f91",
        "TIME-CANARY-7f91",
    ]
    caplog.set_level(logging.DEBUG)
    envelope = _sign(
        payload={"prompt": canaries[0]},
        signing_key_id="KEY-ID-CANARY-7f91",
        signing_key=(canaries[3].encode() + b"x" * 32)[:32],
    )
    transport = envelope.to_dict()
    transport["signature"] = canaries[1]
    traces = []

    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    for action in (
        lambda: SignedTaskEnvelope.from_dict(transport),
        lambda: _sign(issued_at=canaries[4]),
    ):
        try:
            action()
        except InvalidTaskEnvelope as exc:
            traces.extend([str(exc), repr(exc), traceback.format_exc()])
        else:
            pytest.fail("malformed sensitive input was accepted")

    sinks = " ".join([*traces, repr(envelope), caplog.text])

    for canary in canaries:
        assert canary not in sinks
    assert envelope.signature not in sinks
    assert KEY_CURRENT.hex() not in sinks


def test_task_envelope_error_messages_and_codes_are_stable():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    malformed = _sign().to_dict()
    malformed["signature"] = "bad"
    with pytest.raises(InvalidTaskEnvelope) as invalid:
        SignedTaskEnvelope.from_dict(malformed)
    with pytest.raises(InvalidTaskEnvelope) as stale:
        _verify(_sign(), now=datetime(2026, 8, 3, tzinfo=timezone.utc))

    assert (invalid.value.code, str(invalid.value)) == (
        "TASK_ENVELOPE_INVALID",
        "invalid task envelope",
    )
    assert (stale.value.code, str(stale.value)) == (
        "TASK_ENVELOPE_STALE",
        "stale task envelope",
    )


def test_task_envelope_allows_non_secret_token_business_fields():
    payload = {
        "token_count": 12,
        "max_tokens": 100,
        "tokenizer": "example",
        "tokenized_text": "ordinary text",
        "authorization_status": "pending",
        "id_token_count": 3,
    }
    envelope = _sign(payload=payload)

    _verify(envelope)
    assert envelope.to_dict()["payload"] == payload


def test_task_envelope_payload_tampering_fails_even_after_strict_parse():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = deepcopy(_sign(payload={"billing": {"mode": "existing"}}).to_dict())
    transport["payload"]["billing"]["mode"] = "tampered"
    tampered = SignedTaskEnvelope.from_dict(transport)

    with pytest.raises(InvalidTaskEnvelope):
        _verify(tampered)


def test_task_envelope_valid_signature_cannot_bypass_binding_checks():
    from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope

    transport = _sign().to_dict()
    transport["project_id"] = "borrowed_project"
    _resign_transport(transport)
    borrowed = SignedTaskEnvelope.from_dict(transport)

    with pytest.raises(InvalidTaskEnvelope):
        _verify(borrowed)
