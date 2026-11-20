# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Upload addresses at the HTTP, authorization, and storage boundaries."""

import base64
import json
import logging
import re
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from novelvideo.api import auth
from novelvideo.api import app as api_app
from novelvideo.api.app import MAX_UPLOAD_REQUEST_BODY_BYTES, create_app
from novelvideo.freezone import preview_media, upload_tickets
from novelvideo.ports import registry as ports
from novelvideo.ports.auth_contract import AuthError, AuthFailureReason
from novelvideo.ports.project import Principal, ProjectRecord

ORIGIN = "https://upload.example.test:8443"
PUBLIC_ORIGIN = "DRAMACLAW_PUBLIC_ORIGIN"
BASE = "/api/v1/projects/proj/freezone"
UPLOAD = BASE + "/upload"
MINT = BASE + "/upload-address"
ALICE = "test-alice-session"
BOB = "test-bob-session"
AGENT = "test-alice-agent-session"
AGENT_HEADERS = {"Authorization": f"Bearer {AGENT}"}
AGENT_SESSION_ID = "as-alice-1"
USERS = {
    ALICE: {"id": "u-alice", "username": "alice"},
    BOB: {"id": "u-bob", "username": "bob"},
}
FILE = b"fake multipart file bytes"
TEST_BODY_LIMIT = 4096
ACTIVE_KEY_ENV = "ST_TASK_ENVELOPE_ACTIVE_KEY_ID"
KEYRING_ENV = "ST_TASK_ENVELOPE_KEYRING_B64_JSON"
MULTIPART_HEADERS = {"Content-Type": "multipart/form-data; boundary=upload-test"}
EXPECTED_SUFFIXES = sorted("""
    .png .jpg .jpeg .webp .gif .bmp .avif
    .mp4 .mov .webm .mxf .mkv .avi .ts .mts .m2ts .flv .wmv .m4v .mpg .mpeg
    .mp3 .wav .m4a .aac .ogg .flac .opus
""".split())


@pytest.fixture
def api(tmp_path, monkeypatch):
    for name in (
        "SUPERTALE_OPENFILM_STUDIO_PUBLIC_ORIGIN",
        "SUPERTALE_OPENFILM_STUDIO_PREVIEW_ORIGIN",
        "DRAMACLAW_LOCAL_AGENT_TRUST",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(PUBLIC_ORIGIN, ORIGIN)
    # The server signing keyring lives beside, never inside, project directories.
    monkeypatch.delenv(ACTIVE_KEY_ENV, raising=False)
    monkeypatch.delenv(KEYRING_ENV, raising=False)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "server-state"))
    _restart_server(monkeypatch)

    records = {
        project: ProjectRecord(
            id=project, name=project, owner_type="user", owner_id="owner",
            owner_username="owner", home_node_id="local", status="active",
            output_dir=str(tmp_path / project / "output"),
            state_dir=str(tmp_path / project / "state"),
            runtime_dir=str(tmp_path / project / "runtime"),
        )
        for project in ("proj", "other")
    }
    roles = {("u-alice", project): "editor" for project in records}

    async def verify_session(cookie):
        if cookie not in USERS:
            raise AuthError(AuthFailureReason.MISSING)
        return USERS[cookie].copy()

    browser = AsyncMock(side_effect=verify_session)
    agent_user = {
        **USERS[ALICE],
        "credential_kind": "agent_session",
        "agent_session_id": AGENT_SESSION_ID,
        "current_scope_kind": "project",
        "current_project_id": "proj",
        "scopes": ["projects:write"],
    }

    async def verify_agent_session(token):
        if token != AGENT:
            raise AuthError(AuthFailureReason.MISSING)
        return agent_user.copy()

    bearer = AsyncMock(side_effect=verify_agent_session)
    check_session = AsyncMock(return_value=None)
    check_agent_session = AsyncMock(return_value=None)
    principals = AsyncMock(side_effect=lambda user: [Principal("user", user)])
    access = SimpleNamespace(
        resolve_requester_principals=principals,
        effective_project_role=AsyncMock(
            side_effect=lambda record, actors: roles.get((actors[0].id, record.id)),
        ),
    )
    projects = SimpleNamespace(get_project=AsyncMock(side_effect=records.get))
    for name, port in {
        "auth": SimpleNamespace(verify_session=browser, check_session=check_session),
        "auth_session": SimpleNamespace(
            verify_agent_session=bearer, check_agent_session=check_agent_session,
        ),
        "project_access": access,
        "project_registry": projects,
    }.items():
        monkeypatch.setitem(ports._PORTS, name, port)
    client = TestClient(create_app())
    try:
        yield SimpleNamespace(
            client=client, records=records, roles=roles, principals=principals,
            browser=browser, bearer=bearer, agent_user=agent_user,
            check_session=check_session, check_agent_session=check_agent_session,
        )
    finally:
        client.close()


def _restart_server(monkeypatch):
    """Drop the per-process key cache, as a server restart would."""
    monkeypatch.setattr(upload_tickets, "_SERVER_KEYS", None, raising=False)


def _configure_keyring(monkeypatch, active, keys):
    monkeypatch.setenv(ACTIVE_KEY_ENV, active)
    monkeypatch.setenv(KEYRING_ENV, json.dumps({
        key_id: base64.b64encode(value).decode("ascii") for key_id, value in keys.items()
    }))
    _restart_server(monkeypatch)


def _session(cookie=ALICE):
    return {"Cookie": f"{auth.AUTH_COOKIE_NAME}={cookie}"}


def _mint(api, cookie=ALICE):
    return api.client.post(MINT, headers=_session(cookie))


def _data(response):
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    return response.json()["data"]


def _ticket(api, cookie=ALICE):
    url = _data(_mint(api, cookie))["upload_url"]
    return parse_qs(urlsplit(url).query)["upload_ticket"][0]


def _upload(api, path=UPLOAD, *, ticket=None, headers=None, filename="sketch.png"):
    return api.client.post(
        path, params={"upload_ticket": ticket} if ticket is not None else None,
        headers=headers, files={"file": (filename, FILE)},
    )


def _invalid(response):
    assert response.status_code == 401, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "upload_ticket_invalid"
    assert "request a new upload address" in detail["message"]


def _stored(api, data):
    path = urlsplit(data["url"]).path
    assert path == f'/static/projects/proj/freezone/_uploads/{data["filename"]}'
    assert data["size"] == len(FILE)
    return Path(api.records["proj"].output_dir) / "freezone" / "_uploads" / data["filename"]


def test_mint_address_and_upload_without_session(api):
    baseline = _data(_upload(api, headers=_session()))
    address = _data(_mint(api))
    parts = urlsplit(address["upload_url"])
    assert f"{parts.scheme}://{parts.netloc}" == ORIGIN
    assert parts.path == UPLOAD
    params = parse_qs(parts.query)
    assert set(params) == {"upload_ticket"}
    [ticket] = params["upload_ticket"]
    segment, _ = ticket.split(".")
    identity = _decode_payload(segment)
    assert {key: identity[key] for key in ("v", "p", "u", "n", "k", "c")} == {
        "v": 2, "p": "proj", "u": "u-alice", "n": "alice", "k": "session", "c": None,
    }
    assert address["expires_in_seconds"] == 600
    assert address["method"] == "POST"
    assert address["file_field"] == "file"
    assert address["max_bytes"] == MAX_UPLOAD_REQUEST_BODY_BYTES

    response = _upload(api, parts.path + "?" + parts.query)
    assert "cookie" not in response.request.headers
    assert "authorization" not in response.request.headers
    uploaded = _data(response)
    assert uploaded.keys() == baseline.keys()
    assert _stored(api, uploaded).read_bytes() == FILE


def test_upload_ticket_is_reusable(api):
    ticket = _ticket(api)
    api.browser.reset_mock()
    for filename, headers in (
        ("first.png", None),
        ("second.png", {**_session(BOB), "Authorization": "Bearer test-conflicting-session"}),
    ):
        data = _data(_upload(api, ticket=ticket, filename=filename, headers=headers))
        assert data["filename"].endswith("_" + filename)
        assert _stored(api, data).read_bytes() == FILE
    api.browser.assert_not_awaited()
    api.bearer.assert_not_awaited()


def test_mint_address_lists_allowed_suffixes(api):
    suffixes = _data(_mint(api))["allowed_suffixes"]
    assert suffixes == EXPECTED_SUFFIXES
    from novelvideo.freezone.upload_tickets import ALLOWED_SUFFIXES

    assert suffixes == sorted(ALLOWED_SUFFIXES)


@pytest.mark.parametrize("seconds", [600, 601], ids=["at-expiry", "after-expiry"])
def test_upload_ticket_expires(api, monkeypatch, seconds):
    now = int(time.time())
    monkeypatch.setattr(time, "time", lambda: now)
    ticket = _ticket(api)
    monkeypatch.setattr(time, "time", lambda: now + 599)
    _data(_upload(api, ticket=ticket))
    monkeypatch.setattr(time, "time", lambda: now + seconds)
    _invalid(_upload(api, ticket=ticket))


def test_upload_ticket_is_bound_to_one_project(api):
    # One server key signs every project's tickets; only the payload binds the project.
    ticket = _ticket(api)
    other_upload = UPLOAD.replace("/proj/", "/other/")
    _data(_upload(api, other_upload, headers=_session()))
    _invalid(_upload(api, other_upload, ticket=ticket))


def test_html_preview_key_cannot_forge_upload_ticket(api):
    _data(_mint(api))
    preview_key = preview_media.project_key(Path(api.records["proj"].state_dir), create=True)
    now = int(time.time())
    forged = upload_tickets.issue(
        preview_key, "proj", "u-alice", "alice", now,
        credential_kind="session", credential_id=None,
    )
    _invalid(_upload(api, ticket=forged))

    # The preview key keeps signing and verifying HTML preview grants.
    expires = now + preview_media.TTL
    grant = preview_media.signature(preview_key, "proj", "artifact", "sketch.png", expires)
    assert preview_media.verify(preview_key, "proj", "artifact", "sketch.png", expires, grant)


def test_upload_ticket_key_is_kept_out_of_project_directories(api):
    _data(_upload(api, ticket=_ticket(api)))
    for record in api.records.values():
        for directory in (record.state_dir, record.runtime_dir):
            assert not [path for path in Path(directory).rglob("*") if path.is_file()]


def test_upload_ticket_follows_the_server_keyring(api, monkeypatch):
    old, new = b"o" * 32, b"n" * 32
    _configure_keyring(monkeypatch, "old", {"old": old})
    ticket = _ticket(api)
    # A retired key that is still listed keeps in-flight tickets valid.
    _configure_keyring(monkeypatch, "new", {"old": old, "new": new})
    _data(_upload(api, ticket=ticket))
    _data(_upload(api, ticket=_ticket(api)))
    # Once the key leaves the keyring its tickets stop working.
    _configure_keyring(monkeypatch, "new", {"new": new})
    _invalid(_upload(api, ticket=ticket))


def test_mint_is_unavailable_without_a_valid_server_keyring(api, monkeypatch, caplog):
    monkeypatch.setenv(ACTIVE_KEY_ENV, "broken")
    monkeypatch.setenv(KEYRING_ENV, "not-a-keyring")
    _restart_server(monkeypatch)
    response = _mint(api)
    payload = response.json()
    assert payload["ok"] is False, response.text
    assert payload["data"]["code"] == "upload_address_unavailable"
    assert "server operator" in payload["error"]
    assert "upload_url" not in response.text
    assert "not-a-keyring" not in response.text + caplog.text
    _invalid(_upload(api, ticket="A" * 8 + "." + "0" * 64))


@pytest.mark.parametrize(("method", "path"), [
    ("POST", BASE + "/reference-file-upload"),
    ("GET", BASE + "/canvases"),
    ("POST", MINT),
], ids=["reference-file-upload", "canvas-list", "mint"])
def test_ticket_query_is_refused_on_other_endpoints(api, method, path):
    # A valid session catches routes that silently ignore the ticket query.
    kwargs = {"files": {"file": ("sketch.png", FILE)}} if path.endswith("-upload") else {}
    def assert_refused(ticket):
        api.browser.reset_mock()
        response = api.client.request(
            method, path, params={"upload_ticket": ticket}, headers=_session(), **kwargs,
        )
        assert response.status_code == 401, response.text
        api.browser.assert_not_awaited()

    assert_refused("test-fake-ticket")
    assert_refused(_ticket(api))


@pytest.mark.parametrize("path", [UPLOAD, MINT], ids=["upload", "mint"])
def test_upload_ticket_is_not_an_agent_bearer(api, path):
    ticket = _ticket(api)
    response = _upload(api, path, headers={"Authorization": f"Bearer {ticket}"})
    assert response.status_code == 401, response.text
    api.bearer.assert_awaited_once_with(ticket)


def test_upload_ticket_is_not_a_browser_session(api):
    ticket = _ticket(api)
    api.browser.reset_mock()
    response = _upload(api, headers=_session(ticket))
    assert response.status_code == 401, response.text
    api.browser.assert_awaited_once_with(ticket)


def _agent_ticket(api):
    url = _data(api.client.post(MINT, headers=AGENT_HEADERS))["upload_url"]
    return parse_qs(urlsplit(url).query)["upload_ticket"][0]


def _refused(response, *expected):
    assert response.status_code == 401, response.text
    detail = response.json()["detail"]
    assert set(detail) == {"code", "message"}
    assert detail["code"] == "upload_ticket_invalid"
    for text in expected:
        assert text in detail["message"]
    return detail["message"]


def test_ticket_binds_the_minting_credential_by_id_only(api):
    api.browser.side_effect = None
    api.browser.return_value = {**USERS[ALICE], "session_id": "bs-alice-1"}
    browser_payload = _decode_payload(_ticket(api).split(".")[0])
    agent_payload = _decode_payload(_agent_ticket(api).split(".")[0])
    assert set(browser_payload) == set(agent_payload) == {"v", "p", "u", "n", "e", "k", "c"}
    assert (browser_payload["k"], browser_payload["c"]) == ("session", "bs-alice-1")
    assert (agent_payload["k"], agent_payload["c"]) == ("agent_session", AGENT_SESSION_ID)
    for raw in (ALICE, AGENT):
        assert raw not in json.dumps(browser_payload) + json.dumps(agent_payload)


def test_ticket_upload_checks_the_minting_browser_session(api):
    api.browser.side_effect = None
    api.browser.return_value = {**USERS[ALICE], "session_id": "bs-alice-1"}
    ticket = _ticket(api)
    _data(_upload(api, ticket=ticket))
    api.check_session.assert_awaited_once_with(session_id="bs-alice-1", user_id="u-alice")
    api.check_agent_session.assert_not_awaited()


def test_ticket_upload_checks_the_user_when_no_session_id_is_exposed(api):
    _data(_upload(api, ticket=_ticket(api)))
    api.check_session.assert_awaited_once_with(session_id=None, user_id="u-alice")


@pytest.mark.parametrize(("reason", "expected"), [
    (AuthFailureReason.REVOKED, ("revoked", "request a new upload address")),
    (AuthFailureReason.INVALID, ("revoked", "request a new upload address")),
    (AuthFailureReason.EXPIRED, ("expired", "request a new upload address")),
    (AuthFailureReason.USER_SUSPENDED, ("account", "disabled", "administrator")),
], ids=["revoked", "invalid", "expired", "user-disabled"])
def test_agent_minted_ticket_stops_working_with_its_session(api, reason, expected):
    ticket = _agent_ticket(api)
    api.bearer.reset_mock()
    _data(_upload(api, ticket=ticket))
    api.check_agent_session.assert_awaited_once_with(agent_session_id=AGENT_SESSION_ID)
    api.check_session.assert_not_awaited()
    api.bearer.assert_not_awaited()

    api.check_agent_session.side_effect = AuthError(reason, "internal detail")
    message = _refused(_upload(api, ticket=ticket), *expected)
    assert "internal detail" not in message
    assert len(list(Path(api.records["proj"].output_dir).rglob("*.png"))) == 1


@pytest.mark.parametrize(("reason", "expected"), [
    (AuthFailureReason.USER_SUSPENDED, ("account", "disabled", "administrator")),
    (AuthFailureReason.REVOKED, ("revoked", "request a new upload address")),
], ids=["user-disabled", "session-revoked"])
def test_browser_minted_ticket_stops_working_with_its_minter(api, reason, expected):
    ticket = _ticket(api)
    _data(_upload(api, ticket=ticket))
    api.check_session.side_effect = AuthError(reason)
    _refused(_upload(api, ticket=ticket), *expected)
    # Somebody else's live browser session does not rescue the ticket.
    _refused(_upload(api, ticket=ticket, headers=_session(BOB)), *expected)


def test_ticket_is_refused_when_access_is_denied_for_the_minter(api):
    ticket = _ticket(api)
    api.check_session.side_effect = AuthError(
        AuthFailureReason.INVALID, "effective access denied"
    )
    _refused(_upload(api, ticket=ticket), "account", "administrator")


@pytest.mark.parametrize("kind", ["session", "agent_session"])
def test_ticket_is_refused_when_the_auth_adapter_cannot_check_it(api, monkeypatch, kind):
    ticket = _ticket(api) if kind == "session" else _agent_ticket(api)
    # An adapter built against the older port contract has no id-based check.
    monkeypatch.setitem(ports._PORTS, "auth", SimpleNamespace(verify_session=api.browser))
    monkeypatch.setitem(
        ports._PORTS, "auth_session", SimpleNamespace(verify_agent_session=api.bearer),
    )
    message = _refused(_upload(api, ticket=ticket), "version", "server operator")
    assert "request a new upload address" not in message
    assert not any(path.is_file() for path in Path(api.records["proj"].output_dir).rglob("*"))


def test_ticket_check_outage_is_not_reported_as_an_invalid_ticket(api):
    ticket = _ticket(api)
    api.check_session.side_effect = RuntimeError("backend down")
    response = _upload(api, ticket=ticket)
    assert response.status_code == 503, response.text
    assert "backend down" not in response.text


def test_agent_session_without_an_id_cannot_mint(api):
    del api.agent_user["agent_session_id"]
    response = api.client.post(MINT, headers=AGENT_HEADERS)
    payload = response.json()
    assert payload["ok"] is False, response.text
    assert payload["data"]["code"] == "upload_address_unavailable"
    assert "version" in payload["error"] and "server operator" in payload["error"]
    assert "upload_url" not in response.text


def test_ticket_from_the_previous_payload_version_is_refused(api):
    key = upload_tickets.server_keys()[0]
    payload = {"v": 1, "p": "proj", "u": "u-alice", "n": "alice", "e": int(time.time()) + 600}
    segment = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    _invalid(_upload(api, ticket=f"{segment}.{upload_tickets._signature(key, segment)}"))
    api.check_session.assert_not_awaited()


@pytest.mark.parametrize(("kind", "credential_id"), [
    ("agent_session", None), ("agent_session", ""), ("api_key", "x"), ("session", 7),
    ("session", ""),
])
def test_ticket_with_malformed_credential_binding_is_refused(api, kind, credential_id):
    key = upload_tickets.server_keys()[0]
    now = int(time.time())
    ticket = upload_tickets.issue(
        key, "proj", "u-alice", "alice", now, credential_kind=kind, credential_id=credential_id,
    )
    _invalid(_upload(api, ticket=ticket))
    api.check_session.assert_not_awaited()
    api.check_agent_session.assert_not_awaited()


def test_local_install_tickets_follow_local_sessions(api, tmp_path, monkeypatch):
    import asyncio

    from novelvideo.ports.local.auth import FileAuthPort, LocalAuthSession

    sessions = LocalAuthSession(tmp_path / "agent-sessions")
    monkeypatch.setitem(ports._PORTS, "auth", FileAuthPort())
    monkeypatch.setitem(ports._PORTS, "auth_session", sessions)
    api.roles["local", "proj"] = "editor"

    # The single local user is always valid.
    _data(_upload(api, ticket=_ticket(api)))

    token = asyncio.run(sessions.create_agent_session(
        username="local", scopes=["projects:write"],
        current_scope_kind="project", current_project_id="proj",
    ))
    headers = {"Authorization": f"Bearer {token.value}"}
    url = _data(api.client.post(MINT, headers=headers))["upload_url"]
    ticket = parse_qs(urlsplit(url).query)["upload_ticket"][0]
    assert token.value not in json.dumps(_decode_payload(ticket.split(".")[0]))
    _data(_upload(api, ticket=ticket))

    asyncio.run(sessions.revoke_agent_session(token.value))
    _refused(_upload(api, ticket=ticket), "revoked", "request a new upload address")


def _decode_payload(segment):
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


def _edit_payload(segment, field, edit):
    payload = _decode_payload(segment)
    payload[field] = edit(payload[field])
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


@pytest.mark.parametrize("kind", [
    "signature", "user", "expiry", "truncated", "garbage", "over-long", "preview-grant",
])
def test_invalid_ticket_does_not_fall_back_to_session(api, monkeypatch, kind):
    if kind in {"garbage", "over-long"}:
        _invalid(_upload(api, ticket="!" if kind == "garbage" else "A" * 2049,
                         headers=_session()))
        api.browser.assert_not_awaited()
        return

    now = int(time.time())
    monkeypatch.setattr(time, "time", lambda: now)
    ticket = _ticket(api)
    segment, signature = ticket.split(".")
    if kind == "signature":
        signature = ("1" if signature[0] == "0" else "0") + signature[1:]
    elif kind == "user":
        segment = _edit_payload(segment, "u", lambda _: "u-bob")
    elif kind == "expiry":
        segment = _edit_payload(segment, "e", lambda expiry: expiry + 1)
        monkeypatch.setattr(time, "time", lambda: now + 1)
    elif kind == "truncated":
        signature = signature[:-1]
    else:
        key = preview_media.project_key(Path(api.records["proj"].state_dir), create=True)
        signature = preview_media.signature(key, "proj", "artifact", "sketch.png",
                                            int(time.time()) + 600)
    api.browser.reset_mock()
    _invalid(_upload(api, ticket=f"{segment}.{signature}", headers=_session()))
    api.browser.assert_not_awaited()


def test_invalid_ticket_does_not_fall_back_to_agent_bearer(api):
    _invalid(_upload(api, ticket="!", headers=AGENT_HEADERS))
    api.bearer.assert_not_awaited()


@pytest.mark.parametrize(
    "origin", [None, "https://invalid.example.test/with-path"], ids=["unset", "invalid"],
)
def test_mint_requires_a_configured_public_origin(api, monkeypatch, origin):
    if origin is None:
        monkeypatch.delenv(PUBLIC_ORIGIN)
    else:
        monkeypatch.setenv(PUBLIC_ORIGIN, origin)
    response = _mint(api)
    payload = response.json()
    assert payload["ok"] is False, response.text
    assert payload["data"]["code"] == "upload_address_unavailable"
    assert "upload_url" not in response.text


@pytest.mark.parametrize("role", ["viewer", None], ids=["downgraded", "removed"])
def test_ticket_rechecks_requester_editor_role_at_upload(api, role):
    ticket = _ticket(api)
    api.principals.reset_mock()
    _data(_upload(api, ticket=ticket))
    api.principals.assert_awaited_once_with("u-alice")

    api.roles["u-alice", "proj"] = role
    session_denial = _upload(api, headers=_session())
    ticket_denial = _upload(api, ticket=ticket)
    assert session_denial.status_code in {403, 404}
    assert ticket_denial.status_code == session_denial.status_code, ticket_denial.text
    assert ticket_denial.json() == session_denial.json()


def test_viewer_cannot_mint_upload_address(api):
    api.roles["u-alice", "proj"] = "viewer"
    session_denial = _upload(api, headers=_session())
    denied = _mint(api)
    assert session_denial.status_code == 403
    assert denied.status_code == session_denial.status_code, denied.text
    assert "upload_url" not in denied.text


@pytest.mark.parametrize(("project", "scopes"), [
    ("proj", ["projects:read"]),
    ("proj", ["projects:read", "tasks:submit"]),
    ("other", ["projects:write"]),
], ids=["no-write-scope", "other-write-scope-only", "different-project"])
def test_agent_session_cannot_mint_outside_its_write_scope(api, project, scopes):
    api.agent_user.update(current_project_id=project, scopes=scopes)
    response = api.client.post(MINT, headers=AGENT_HEADERS)
    assert response.status_code == 403, response.text
    assert "upload_url" not in response.text
    api.bearer.assert_awaited_once_with(AGENT)


def test_agent_session_with_project_write_scope_mints_upload_address(api):
    api.agent_user.update(scopes=["projects:read", "projects:write"])
    data = _data(api.client.post(MINT, headers=AGENT_HEADERS))
    assert data["upload_url"].startswith(ORIGIN)


def test_session_without_scopes_mints_upload_address(api):
    assert "scopes" not in USERS[ALICE]
    data = _data(_mint(api))
    assert data["upload_url"].startswith(ORIGIN)


def test_valid_ticket_for_another_user_cannot_borrow_editor_session(api):
    api.roles["u-bob", "proj"] = "editor"
    ticket = _ticket(api, BOB)
    del api.roles["u-bob", "proj"]
    api.principals.reset_mock()
    response = _upload(api, ticket=ticket, headers=_session(ALICE))
    assert response.status_code == 403, response.text
    api.principals.assert_awaited_once_with("u-bob")


def _multipart_chunks(file_bytes):
    yield (
        b'--upload-test\r\nContent-Disposition: form-data; name="file"; filename="sketch.png"\r\n'
        b"Content-Type: image/png\r\n\r\n"
    )
    yield file_bytes
    yield b"\r\n--upload-test--\r\n"


@pytest.mark.parametrize("credential", ["ticket", "browser", "agent"])
def test_chunked_upload_under_body_limit(api, monkeypatch, credential):
    monkeypatch.setattr(api_app, "MAX_UPLOAD_REQUEST_BODY_BYTES", TEST_BODY_LIMIT)
    params = {"upload_ticket": _ticket(api)} if credential == "ticket" else None
    session_headers = {"ticket": {}, "browser": _session(), "agent": AGENT_HEADERS}
    response = api.client.post(
        UPLOAD,
        params=params,
        headers={**MULTIPART_HEADERS, **session_headers[credential]},
        content=_multipart_chunks(FILE),
    )
    assert response.request.headers["transfer-encoding"] == "chunked"
    assert "content-length" not in response.request.headers
    assert _stored(api, _data(response)).read_bytes() == FILE


@pytest.mark.parametrize("credential", ["ticket", "browser", "agent"])
def test_chunked_upload_over_body_limit_is_refused(api, monkeypatch, credential):
    monkeypatch.setattr(api_app, "MAX_UPLOAD_REQUEST_BODY_BYTES", TEST_BODY_LIMIT)
    params = {"upload_ticket": _ticket(api)} if credential == "ticket" else None
    session_headers = {"ticket": {}, "browser": _session(), "agent": AGENT_HEADERS}
    response = api.client.post(
        UPLOAD,
        params=params,
        headers={**MULTIPART_HEADERS, **session_headers[credential]},
        content=_multipart_chunks(b"x" * TEST_BODY_LIMIT),
    )
    assert "content-length" not in response.request.headers
    assert response.status_code == 413, response.text
    detail = response.json()["detail"]
    assert set(detail) == {"code", "field", "limit", "got"}
    assert detail["code"] == "canvas_payload_too_large"
    assert detail["field"] == "body"
    assert detail["limit"] == TEST_BODY_LIMIT
    assert detail["got"] > TEST_BODY_LIMIT
    assert not any(path.is_file() for path in Path(api.records["proj"].output_dir).rglob("*"))


def test_upload_address_keeps_existing_body_limit(api, monkeypatch):
    monkeypatch.setattr(api_app, "MAX_UPLOAD_REQUEST_BODY_BYTES", TEST_BODY_LIMIT)
    ticket = _ticket(api)
    body = b"".join(_multipart_chunks(b"x" * TEST_BODY_LIMIT))
    size = len(body)
    response = api.client.post(
        UPLOAD, params={"upload_ticket": ticket}, headers=MULTIPART_HEADERS, content=body,
    )
    assert response.request.headers["content-length"] == str(size)
    assert response.status_code == 413, response.text
    assert response.json() == {"detail": {
        "code": "canvas_payload_too_large", "field": "body",
        "limit": TEST_BODY_LIMIT, "got": size,
    }}


@pytest.mark.parametrize("headers", [_session(), AGENT_HEADERS], ids=["browser", "agent"])
def test_non_image_keeps_existing_storage_rule_for_sessions(api, headers):
    filename = "notes draft.exe"
    session = _upload(api, headers=headers, filename=filename)
    session_data = _data(session)
    stored_name = r"\d{8}_\d{6}_\d{6}_notes_draft\.exe"
    assert re.fullmatch(stored_name, session_data["filename"])
    assert _stored(api, session_data).read_bytes() == FILE

    same_file = _data(_upload(api, headers=headers, filename="notes.exe"))
    assert re.fullmatch(r"\d{8}_\d{6}_\d{6}_notes\.exe", same_file["filename"])
    assert _stored(api, same_file).read_bytes() == FILE


@pytest.mark.parametrize("filename", ["notes.exe", "notes"], ids=["disallowed", "no-suffix"])
def test_ticket_upload_refuses_unsupported_file_type(api, filename):
    response = _upload(api, ticket=_ticket(api), filename=filename)
    assert response.status_code == 415, response.text
    detail = response.json()["detail"]
    assert set(detail) == {"code", "message", "allowed_suffixes"}
    assert detail["code"] == "upload_type_not_allowed"
    assert detail["allowed_suffixes"] == EXPECTED_SUFFIXES
    assert set(EXPECTED_SUFFIXES) <= set(re.findall(r"\.[a-z0-9]+\b", detail["message"]))
    assert not any(path.is_file() for path in Path(api.records["proj"].output_dir).rglob("*"))


def test_ticket_upload_accepts_uppercase_suffix(api):
    data = _data(_upload(api, ticket=_ticket(api), filename="photo.PNG"))
    assert _stored(api, data).read_bytes() == FILE


def test_ticket_suffixes_cover_canvas_upload_node():
    canvas = Path(__file__).resolve().parents[1] / "frontend/src/features/canvas"
    video_types = (canvas / "application/videoFileTypes.ts").read_text(encoding="utf-8")
    extra = re.search(r"EXTRA_VIDEO_EXTENSIONS\s*=\s*/\\\.\(([^)]+)\)", video_types)
    assert extra is not None
    upload_node = (canvas / "nodes/UploadNode.tsx").read_text(encoding="utf-8")
    assert '`image/*,${VIDEO_FILE_ACCEPT},audio/*`' in upload_node

    from novelvideo.freezone.upload_tickets import ALLOWED_SUFFIXES

    assert isinstance(ALLOWED_SUFFIXES, frozenset)
    assert ALLOWED_SUFFIXES == frozenset(EXPECTED_SUFFIXES)
    assert {f".{extension}" for extension in extra[1].split("|")} <= ALLOWED_SUFFIXES


def test_application_logs_omit_upload_ticket(api, caplog):
    caplog.set_level(logging.DEBUG)
    ticket = _ticket(api)
    data = _data(_upload(api, ticket=ticket))
    api.roles["u-alice", "proj"] = "viewer"
    refused = _upload(api, ticket=ticket)
    assert refused.status_code == 403
    static_path = urlsplit(data["url"]).path
    response = api.client.get(static_path, params={"upload_ticket": ticket})
    assert response.status_code == 401
    # The in-process HTTP client logs its own request URLs.
    for record in caplog.records:
        if record.name not in {"httpx", "httpx2"}:
            assert ticket not in record.getMessage()
