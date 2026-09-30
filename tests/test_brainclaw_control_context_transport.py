"""The signer must cover the bytes that actually go on the wire."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path

import httpx
import pytest

from novelvideo import brainclaw_control_context_transport as transport
from novelvideo.brainclaw_control_context import HEADER

SIGNING_KEY = b"s" * 32
GROUPING_KEY = b"g" * 32
KEY_ID = "dramaclaw-test"


@pytest.fixture
def configured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    keyring = tmp_path / "keyring.json"
    keyring.write_text(
        json.dumps(
            {
                "schema_version": transport.KEYRING_SCHEMA,
                "keys": {KEY_ID: base64.b64encode(SIGNING_KEY).decode()},
            }
        )
    )
    keyring.chmod(0o600)
    grouping = tmp_path / "grouping.key"
    grouping.write_bytes(GROUPING_KEY)
    grouping.chmod(0o600)
    monkeypatch.setenv("BRAINCLAW_CONTROL_CONTEXT_KEYRING_FILE", str(keyring))
    monkeypatch.setenv("BRAINCLAW_CONTROL_CONTEXT_SIGNING_KEY_ID", KEY_ID)
    monkeypatch.setenv("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_FILE", str(grouping))
    monkeypatch.setenv("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_EPOCH", "3")
    transport.reset_control_context_runtime()
    yield keyring
    transport.reset_control_context_runtime()


async def _post(body: dict, *, scope: transport.ControlContextScope | None, extra_headers=None):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = request.headers
        seen["content"] = request.content
        return httpx.Response(200, json={})

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        event_hooks={"request": [transport.sign_brainclaw_control_context]},
        base_url="http://127.0.0.1:18788",
    )
    token = transport.begin_control_context(scope) if scope is not None else None
    try:
        async with client:
            await client.post("/v1/chat/completions", json=body, headers=extra_headers or {})
    finally:
        if token is not None:
            transport.reset_control_context(token)
    return seen


def _verify(header: str, method: str, path: str, body: bytes) -> dict:
    """Independent re-implementation of the frozen envelope check."""
    version, key_id, payload_b64, signature = header.split(".")
    parts = [
        method.encode(),
        path.encode(),
        version.encode(),
        key_id.encode(),
        payload_b64.encode(),
        hashlib.sha256(body).hexdigest().encode(),
    ]
    expected = base64.urlsafe_b64encode(
        hmac.new(SIGNING_KEY, b"\x00".join(parts), hashlib.sha256).digest()
    ).decode().rstrip("=")
    assert hmac.compare_digest(expected, signature), "signature does not cover this request"
    return json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))


async def test_hook_signs_the_serialised_body_and_path(configured: Path) -> None:
    scope = transport.ControlContextScope(trajectory_id="tr-77", project_id="proj-4")
    seen = await _post({"model": "brainclaw", "messages": []}, scope=scope)
    header = seen["headers"][HEADER]
    payload = _verify(header, "POST", "/v1/chat/completions", seen["content"])
    assert payload["grouping_key_epoch"] == 3
    assert payload["checkpoint_ordinal"] == 0
    assert payload["turn_kind"] == "foreground_user"
    # Raw identifiers must never appear anywhere in the envelope.
    assert "tr-77" not in header and "proj-4" not in header
    assert payload["trajectory_group_id"].startswith("hmac-sha256:")
    assert payload["trajectory_group_id"] != payload["project_group_id"]


async def test_signature_is_bound_to_the_exact_body(configured: Path) -> None:
    scope = transport.ControlContextScope(trajectory_id="tr-77", project_id="proj-4")
    seen = await _post({"model": "brainclaw", "messages": [{"role": "user", "content": "a"}]}, scope=scope)
    with pytest.raises(AssertionError):
        _verify(seen["headers"][HEADER], "POST", "/v1/chat/completions", b'{"model":"other"}')


async def test_caller_supplied_header_is_replaced_not_appended(configured: Path) -> None:
    scope = transport.ControlContextScope(trajectory_id="tr-77", project_id="proj-4")
    seen = await _post({"model": "brainclaw"}, scope=scope, extra_headers={HEADER: "v1.forged.x.y"})
    values = seen["headers"].get_list(HEADER)
    assert len(values) == 1 and "forged" not in values[0]


async def test_no_scope_and_no_configuration_send_no_header(
    configured: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = await _post({"model": "brainclaw"}, scope=None)
    assert HEADER not in seen["headers"]

    monkeypatch.delenv("BRAINCLAW_CONTROL_CONTEXT_KEYRING_FILE")
    transport.reset_control_context_runtime()
    scope = transport.ControlContextScope(trajectory_id="tr-77", project_id="proj-4")
    seen = await _post({"model": "brainclaw"}, scope=scope)
    assert HEADER not in seen["headers"], "unconfigured deployment must stay diagnostic"


async def test_ordinals_advance_per_episode(configured: Path) -> None:
    runtime = transport.control_context_runtime()
    assert [runtime.next_ordinal("a"), runtime.next_ordinal("b"), runtime.next_ordinal("a")] == [0, 0, 1]


def test_grouping_key_may_not_equal_the_signing_key(tmp_path: Path) -> None:
    keyring = tmp_path / "keyring.json"
    keyring.write_text(
        json.dumps(
            {
                "schema_version": transport.KEYRING_SCHEMA,
                "keys": {KEY_ID: base64.b64encode(SIGNING_KEY).decode()},
            }
        )
    )
    keyring.chmod(0o600)
    grouping = tmp_path / "grouping.key"
    grouping.write_bytes(SIGNING_KEY)
    grouping.chmod(0o600)
    with pytest.raises(ValueError):
        transport.ControlContextRuntime(
            keyring_path=keyring,
            signing_key_id=KEY_ID,
            grouping_key_path=grouping,
            grouping_key_epoch=1,
        )


def test_world_readable_keys_are_refused(tmp_path: Path) -> None:
    grouping = tmp_path / "grouping.key"
    grouping.write_bytes(GROUPING_KEY)
    grouping.chmod(0o644)
    with pytest.raises(ValueError):
        transport._read_owner_only(grouping)


def test_the_real_client_factory_installs_the_hook() -> None:
    from novelvideo.config import _newapi_text_http_client_factory

    os.environ.setdefault("NEWAPI_TEXT_TRUST_ENV", "1")
    client = _newapi_text_http_client_factory(timeout_seconds=5.0)()
    assert transport.sign_brainclaw_control_context in client._event_hooks["request"]


def test_opaque_scope_signs_without_the_grouping_key(tmp_path: Path) -> None:
    """A signer outside DramaClaw must never need the grouping key.

    Holding it would let that process derive or correlate group ids, which is
    exactly the separation the two-key design exists to keep.
    """
    keyring = tmp_path / "keyring.json"
    keyring.write_text(json.dumps({
        "schema_version": transport.KEYRING_SCHEMA,
        "keys": {KEY_ID: base64.b64encode(SIGNING_KEY).decode()},
    }))
    keyring.chmod(0o600)
    runtime = transport.ControlContextRuntime(
        keyring_path=keyring, signing_key_id=KEY_ID
    )
    assert runtime.derives_group_ids is False

    scope = transport.OpaqueControlContextScope(
        trajectory_group_id="hmac-sha256:" + "a" * 16,
        project_group_id="hmac-sha256:" + "b" * 16,
        grouping_key_epoch=7,
    )
    header = runtime.header_for(scope, "POST", "/v1/chat/completions", b'{"model":"brainclaw"}')
    payload = _verify(header, "POST", "/v1/chat/completions", b'{"model":"brainclaw"}')
    assert payload["trajectory_group_id"] == scope.trajectory_group_id
    assert payload["project_group_id"] == scope.project_group_id
    # The epoch travels with the ids, because the deriving side knows it and
    # the signing side does not.
    assert payload["grouping_key_epoch"] == 7

    # The same signer must refuse a raw scope rather than mishandle it.
    with pytest.raises(ValueError):
        runtime.header_for(
            transport.ControlContextScope(trajectory_id="ep", project_id="pr"),
            "POST", "/v1/chat/completions", b"{}",
        )


def test_a_raw_identifier_cannot_enter_through_the_opaque_path() -> None:
    """Without the format check a raw project name would be signed as a group id."""
    for trajectory, project in (
        ("proj-one", "hmac-sha256:" + "b" * 16),
        ("hmac-sha256:" + "a" * 16, "proj-two"),
        ("hmac-sha256:NOTHEX0123456789", "hmac-sha256:" + "b" * 16),
        ("hmac-sha1:" + "a" * 16, "hmac-sha256:" + "b" * 16),
    ):
        with pytest.raises(ValueError):
            transport.OpaqueControlContextScope(
                trajectory_group_id=trajectory, project_group_id=project, grouping_key_epoch=1
            )


def test_the_dramaclaw_side_still_derives_from_raw_identifiers(configured: Path) -> None:
    """The grouping-key-holding path is unchanged."""
    runtime = transport.control_context_runtime()
    assert runtime.derives_group_ids is True
    header = runtime.header_for(
        transport.ControlContextScope(trajectory_id="tr-77", project_id="proj-4"),
        "POST", "/v1/chat/completions", b'{"model":"brainclaw"}',
    )
    payload = _verify(header, "POST", "/v1/chat/completions", b'{"model":"brainclaw"}')
    assert payload["trajectory_group_id"].startswith("hmac-sha256:")
    assert "tr-77" not in header
