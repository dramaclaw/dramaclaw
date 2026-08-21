"""The DramaClaw side of the capability: minting and ACP injection."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from novelvideo import brainclaw_control_capability as cap

SIGNING_KEY = b"c" * 32
GROUPING_KEY = b"g" * 32
KEY_ID = "dc-capability-test"


@pytest.fixture
def issuer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> cap.ControlCapabilityIssuer:
    keyring = tmp_path / "capability-keyring.json"
    keyring.write_text(json.dumps({
        "schema_version": "brainclaw.control-context-keyring/v1",
        "keys": {KEY_ID: base64.b64encode(SIGNING_KEY).decode()},
    }))
    keyring.chmod(0o600)
    grouping = tmp_path / "grouping.key"
    grouping.write_bytes(GROUPING_KEY)
    grouping.chmod(0o600)
    monkeypatch.setenv("BRAINCLAW_CAPABILITY_KEYRING_FILE", str(keyring))
    monkeypatch.setenv("BRAINCLAW_CAPABILITY_SIGNING_KEY_ID", KEY_ID)
    monkeypatch.setenv("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_FILE", str(grouping))
    monkeypatch.setenv("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_EPOCH", "2")
    cap.reset_control_capability_issuer()
    built = cap.control_capability_issuer()
    assert built is not None
    yield built
    cap.reset_control_capability_issuer()


def _claims(header: str) -> dict:
    parts = header.split(".")
    payload = parts[1] if parts[0] == cap.TRUSTED_ENVELOPE_VERSION else parts[2]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def test_a_minted_capability_carries_only_pseudonymised_identity(issuer) -> None:
    header = issuer.issue(trajectory_id="tr-77", project_id="proj-4", turn_id="turn-a")
    claims = _claims(header)
    # Raw identifiers must never leave this process.
    assert "tr-77" not in header and "proj-4" not in header
    assert claims["trajectory_group_id"].startswith("hmac-sha256:")
    assert claims["project_group_id"] != claims["trajectory_group_id"]
    assert claims["grouping_key_epoch"] == 2
    assert claims["audience"] == cap.AUDIENCE
    assert claims["issuer"] == cap.ISSUER
    assert claims["turn_id"] == "turn-a"


def test_the_same_episode_is_stable_and_projects_group_across_episodes(issuer) -> None:
    """The three statistical layers have to survive minting."""
    a1 = _claims(issuer.issue(trajectory_id="tr-1", project_id="proj-x", turn_id="t1"))
    a2 = _claims(issuer.issue(trajectory_id="tr-1", project_id="proj-x", turn_id="t2"))
    b = _claims(issuer.issue(trajectory_id="tr-2", project_id="proj-x", turn_id="t3"))
    c = _claims(issuer.issue(trajectory_id="tr-3", project_id="proj-y", turn_id="t4"))

    assert a1["trajectory_group_id"] == a2["trajectory_group_id"], "one trajectory, one id"
    assert b["trajectory_group_id"] != a1["trajectory_group_id"], "different episodes differ"
    assert b["project_group_id"] == a1["project_group_id"], "same project groups them"
    assert c["project_group_id"] != a1["project_group_id"], "different projects separate"


def test_every_capability_is_unique_even_for_one_episode(issuer) -> None:
    """The nonce is what stops two turns producing an identical bearer token."""
    headers = {issuer.issue(trajectory_id="tr-1", project_id="proj-x", turn_id=f"t{i}")
               for i in range(20)}
    assert len(headers) == 20


def test_the_ttl_is_bounded(issuer) -> None:
    claims = _claims(issuer.issue(trajectory_id="tr-1", project_id="proj-x", turn_id="t"))
    lifetime = claims["expires_at"] - claims["issued_at"]
    assert 0 < lifetime <= cap.MAX_TTL_SECONDS
    assert lifetime == cap.DEFAULT_TTL_SECONDS


def test_one_secret_may_not_serve_both_roles(tmp_path: Path) -> None:
    """Sharing them would tie trajectory identity to signing-key rotation."""
    keyring = tmp_path / "k.json"
    keyring.write_text(json.dumps({
        "schema_version": "brainclaw.control-context-keyring/v1",
        "keys": {KEY_ID: base64.b64encode(SIGNING_KEY).decode()},
    }))
    keyring.chmod(0o600)
    grouping = tmp_path / "g.key"
    grouping.write_bytes(SIGNING_KEY)
    grouping.chmod(0o600)
    with pytest.raises(ValueError):
        cap.ControlCapabilityIssuer(
            keyring_path=keyring, signing_key_id=KEY_ID,
            grouping_key_path=grouping, grouping_key_epoch=1,
        )


def test_an_unconfigured_deployment_issues_trusted_identity_without_shared_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("BRAINCLAW_CAPABILITY_KEYRING_FILE", "BRAINCLAW_CAPABILITY_SIGNING_KEY_ID",
                 "BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_FILE"):
        monkeypatch.delenv(name, raising=False)
    cap.reset_control_capability_issuer()

    grouping = tmp_path / "state" / "brainclaw" / "grouping.key"
    monkeypatch.setattr(cap, "_default_grouping_key_path", lambda: grouping)
    built = cap.control_capability_issuer()
    assert built is not None
    header = built.issue(trajectory_id="tr-1", project_id="proj-1", turn_id="turn-1")
    assert header.startswith("t1.")
    assert len(header.split(".")) == 2
    assert grouping.stat().st_mode & 0o777 == 0o600
    assert len(grouping.read_bytes()) == 32
    claims = _claims(header)
    assert claims["key_id"] == cap.TRUSTED_KEY_ID
    assert "tr-1" not in header and "proj-1" not in header
    cap.reset_control_capability_issuer()


def test_trusted_capability_matches_the_claymore_contract_exactly() -> None:
    capability = cap.ControlCapability(
        key_id=cap.TRUSTED_KEY_ID,
        turn_id="turn-vector",
        trajectory_group_id="hmac-sha256:9f2b7c1e4a6d8035",
        project_group_id="hmac-sha256:03e5a1d9b7c20468",
        grouping_key_epoch=1,
        issued_at=2_000_000_000,
        expires_at=2_000_000_300,
        nonce="AAAAAAAAAAAAAAAAAAAAAA",
    )
    assert cap.encode_trusted_capability(capability) == (
        "t1.eyJhdWRpZW5jZSI6ImRyYW1hY2xhdy1nYXRld2F5IiwiZXhwaXJlc19hdCI6"
        "MjAwMDAwMDMwMCwiZ3JvdXBpbmdfa2V5X2Vwb2NoIjoxLCJpc3N1ZWRfYXQiOjIw"
        "MDAwMDAwMDAsImlzc3VlciI6ImRyYW1hY2xhdyIsImtleV9pZCI6InRydXN0ZWQt"
        "bG9jYWwiLCJub25jZSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLCJwcm9qZWN0"
        "X2dyb3VwX2lkIjoiaG1hYy1zaGEyNTY6MDNlNWExZDliN2MyMDQ2OCIsInJlcGxh"
        "eV9zY29wZV9saW1pdCI6Im1vZGVsX291dHB1dF9vbmx5Iiwic2NoZW1hX3ZlcnNp"
        "b24iOiJkcmFtYWNsYXcuY29udHJvbC1jYXBhYmlsaXR5L3YxIiwidHJhamVjdG9y"
        "eV9ncm91cF9pZCI6ImhtYWMtc2hhMjU2OjlmMmI3YzFlNGE2ZDgwMzUiLCJ0dXJu"
        "X2lkIjoidHVybi12ZWN0b3IiLCJ0dXJuX2tpbmQiOiJmb3JlZ3JvdW5kX3VzZXIifQ"
    )


def test_local_grouping_key_is_reused_across_process_restarts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("BRAINCLAW_CAPABILITY_KEYRING_FILE", "BRAINCLAW_CAPABILITY_SIGNING_KEY_ID",
                 "BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_FILE"):
        monkeypatch.delenv(name, raising=False)
    grouping = tmp_path / "state" / "brainclaw" / "grouping.key"
    monkeypatch.setattr(cap, "_default_grouping_key_path", lambda: grouping)
    cap.reset_control_capability_issuer()
    first = cap.control_capability_issuer()
    assert first is not None
    first_id = _claims(first.issue(
        trajectory_id="tr-1", project_id="proj-1", turn_id="turn-1"
    ))["trajectory_group_id"]
    original_key = grouping.read_bytes()

    cap.reset_control_capability_issuer()
    second = cap.control_capability_issuer()
    assert second is not None
    second_id = _claims(second.issue(
        trajectory_id="tr-1", project_id="proj-1", turn_id="turn-2"
    ))["trajectory_group_id"]
    assert grouping.read_bytes() == original_key
    assert second_id == first_id
    cap.reset_control_capability_issuer()


def test_a_transient_initialisation_failure_is_not_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("BRAINCLAW_CAPABILITY_KEYRING_FILE", "BRAINCLAW_CAPABILITY_SIGNING_KEY_ID",
                 "BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_FILE"):
        monkeypatch.delenv(name, raising=False)
    grouping = tmp_path / "brainclaw" / "grouping.key"
    monkeypatch.setattr(cap, "_default_grouping_key_path", lambda: grouping)
    original = cap._ensure_local_grouping_key
    attempts = 0

    def fail_once(path: Path) -> Path:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("transient filesystem failure")
        return original(path)

    monkeypatch.setattr(cap, "_ensure_local_grouping_key", fail_once)
    cap.reset_control_capability_issuer()
    with pytest.raises(OSError, match="transient filesystem failure"):
        cap.control_capability_issuer()
    assert cap.control_capability_issuer() is not None
    assert attempts == 2
    cap.reset_control_capability_issuer()


# --- ACP injection --------------------------------------------------------

def test_the_turn_helper_never_raises_into_the_conversation(monkeypatch) -> None:
    """Attestation is observability; it must not be able to fail a turn."""
    from novelvideo.chat import hermes_sdk

    # No identity at all.
    assert hermes_sdk._issue_turn_capability(
        trajectory_id=None, project_id=None, turn_id="t") is None
    assert hermes_sdk._issue_turn_capability(
        trajectory_id="ep", project_id=None, turn_id="t") is None

    # A broken issuer.
    def explode() -> None:
        raise RuntimeError("keyring on fire")

    monkeypatch.setattr(
        "novelvideo.brainclaw_control_capability.control_capability_issuer", explode
    )
    assert hermes_sdk._issue_turn_capability(
        trajectory_id="ep", project_id="proj", turn_id="t") is None


def test_the_helper_mints_whenever_an_identity_and_issuer_exist(issuer) -> None:
    """No runtime gate here on purpose — see the startup check instead."""
    from novelvideo.chat import hermes_sdk

    header = hermes_sdk._issue_turn_capability(
        trajectory_id="tr-9", project_id="proj-9", turn_id="turn-9")
    assert header is not None
    assert _claims(header)["turn_id"] == "turn-9"


def test_a_binary_grouping_key_is_used_byte_for_byte(tmp_path: Path) -> None:
    """Nothing may be trimmed from a raw binary key. Nothing at all.

    ``bytes.strip()`` was the original bug: a random 32-byte key begins or ends
    with an ASCII whitespace byte about 5% of the time, and the canary hit it on
    its second run. Trimming only a trailing newline was the same mistake in a
    smaller size — a raw key ends in 0x0a once every 256 files, and that byte is
    key material, not an editor artefact.

    The quiet failure is what makes this worth a test: a key that stays long
    enough while its two ends derive different opaque ids from one file, in a
    protocol whose whole purpose is that both sides agree on an identity.
    """
    from novelvideo.brainclaw_control_capability import _binary_key_bytes

    for key in (
        b"k" * 31 + b"\n",            # a raw key really can end in 0x0a
        b"k" * 30 + b"\r\n",
        b"\n" + b"k" * 30 + b"\t",     # whitespace at both ends
        b" " + b"k" * 31,
        bytes(range(32)),             # includes 0x09-0x0d and 0x20
        b"k" * 32,
    ):
        assert _binary_key_bytes(key) == key, "a binary key must survive verbatim"

    # Short keys are rejected by the length gate, not silently repaired here.
    assert _binary_key_bytes(b"short") == b"short"


def test_a_whitespace_edged_key_still_produces_stable_ids(tmp_path: Path) -> None:
    """The failure mode that matters: two ends deriving different ids."""
    keyring = tmp_path / "k.json"
    keyring.write_text(json.dumps({
        "schema_version": "brainclaw.control-context-keyring/v1",
        "keys": {KEY_ID: base64.b64encode(SIGNING_KEY).decode()}}))
    keyring.chmod(0o600)
    grouping = tmp_path / "g.key"
    grouping.write_bytes(b"\n" + b"g" * 30 + b" ")   # 32 bytes, whitespace at both ends
    grouping.chmod(0o600)

    issuer = cap.ControlCapabilityIssuer(
        keyring_path=keyring, signing_key_id=KEY_ID,
        grouping_key_path=grouping, grouping_key_epoch=1)
    assert len(issuer.grouping_key) == 32
    first, _ = issuer.group_ids("tr-1", "proj-1")
    second, _ = issuer.group_ids("tr-1", "proj-1")
    assert first == second
