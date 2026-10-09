"""The frozen vectors are the contract between this signer and BrainClaw's Go
verifier. Both reproduce them independently, so neither side debugs against the
other and encoding details cannot silently diverge across languages."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.brainclaw_control_context import (
    MAX_CHECKPOINT_ORDINAL,
    ControlContext,
    group_id,
    sign_control_context,
)

VECTORS = Path(__file__).resolve().parents[1] / "tests" / "data" / "control-context-vectors.json"


def _vectors() -> dict:
    if not VECTORS.is_file():
        pytest.skip(f"frozen vectors not vendored at {VECTORS}")
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def _context(payload: dict) -> ControlContext:
    return ControlContext(
        trajectory_group_id=payload["trajectory_group_id"],
        project_group_id=payload["project_group_id"],
        grouping_key_epoch=payload["grouping_key_epoch"],
        checkpoint_ordinal=payload["checkpoint_ordinal"],
        turn_kind=payload["turn_kind"],
        replay_scope_limit=payload["replay_scope_limit"],
    )


def test_signer_reproduces_the_frozen_vector_byte_for_byte() -> None:
    vectors = _vectors()
    header = sign_control_context(
        _context(vectors["payload"]),
        signing_key=bytes.fromhex(vectors["signing_key_hex"]),
        signing_key_id=vectors["signing_key_id"],
        method=vectors["request"]["method"],
        endpoint_path=vectors["request"]["endpoint_path"],
        body=vectors["request"]["body_utf8"].encode(),
    )
    assert header == vectors["header_value"]


def test_signature_is_bound_to_the_request() -> None:
    """A different body or path must produce a different signature.

    Without this an envelope captured from one request could be replayed onto
    another to relabel arbitrary traffic into someone else's family.
    """
    vectors = _vectors()
    common = {
        "signing_key": bytes.fromhex(vectors["signing_key_hex"]),
        "signing_key_id": vectors["signing_key_id"],
    }
    context = _context(vectors["payload"])
    base = sign_control_context(
        context, method="POST", endpoint_path="/v1/chat/completions", body=b"{}", **common
    )
    other_body = sign_control_context(
        context, method="POST", endpoint_path="/v1/chat/completions", body=b'{"a":1}', **common
    )
    other_path = sign_control_context(
        context, method="POST", endpoint_path="/v1/responses", body=b"{}", **common
    )
    assert base != other_body
    assert base != other_path


def test_group_ids_are_stable_and_namespaced() -> None:
    key = b"g" * 32
    assert group_id(key, "trajectory", "tr-1") == group_id(key, "trajectory", "tr-1")
    # The same raw identifier must not collide across the two namespaces.
    assert group_id(key, "trajectory", "tr-1") != group_id(key, "project", "tr-1")
    assert group_id(key, "trajectory", "tr-1").startswith("hmac-sha256:")
    # Rotating the grouping key splits the trajectory, which is why the payload
    # carries grouping_key_epoch for BrainClaw to see the split.
    assert group_id(b"h" * 32, "trajectory", "tr-1") != group_id(key, "trajectory", "tr-1")


def test_out_of_range_values_are_refused_before_signing() -> None:
    for field, value in (
        ("checkpoint_ordinal", MAX_CHECKPOINT_ORDINAL + 1),
        ("checkpoint_ordinal", -1),
        ("grouping_key_epoch", -1),
    ):
        payload = {
            "trajectory_group_id": "hmac-sha256:ep",
            "project_group_id": "hmac-sha256:proj",
            "grouping_key_epoch": 1,
            "checkpoint_ordinal": 4,
            "turn_kind": "foreground_user",
            "replay_scope_limit": "model_output_only",
            field: value,
        }
        with pytest.raises(ValueError):
            _context(payload).payload()
