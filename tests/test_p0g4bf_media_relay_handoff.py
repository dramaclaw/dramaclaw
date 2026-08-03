from __future__ import annotations

import base64
import hashlib

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential

CANARY = "secret-path-url-filename-canary"


def _context(*, kind: str = "organization") -> TrustedEgressContext:
    organization = kind == "organization"
    return TrustedEgressContext(
        envelope_id="envelope-eg21",
        project_id="project-eg21",
        task_type="image.edit",
        requester_user_id="user-eg21",
        root_task_id="root-eg21",
        admission_id="admission-eg21",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-eg21" if organization else None,
        authz_version=4,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-eg21" if organization else "platform",
        ),
        credential=CredentialReference(
            source="organization" if organization else "platform",
            credential_id="credential-eg21",
            key_version=9,
            org_id="org-eg21" if organization else None,
        ),
    )


class _Credentials:
    def __init__(self, context: TrustedEgressContext) -> None:
        self.context = context

    async def resolve(self, admission):
        assert admission.billing_principal is self.context.billing_principal
        return RequestCredential(
            reference=self.context.credential,
            api_key="request-scoped-key",
            base_url="https://gateway.invalid/v1",
        )


class _Operations:
    def __init__(self, *, won: bool = True) -> None:
        self.won = won
        self.claims = []
        self.transitions = []

    async def claim(self, *, spec):
        self.claims.append(spec)
        return OperationClaimResult(
            won=self.won,
            operation=OperationSnapshot(
                operation_id="image-operation",
                operation_key=spec.operation_key,
                state=OperationState.DISPATCHING,
                version=1,
            ),
            transition_token="image-transition" if self.won else None,
        )

    async def mark_rejected_before_submit(self, **kwargs):
        self.transitions.append(("rejected", kwargs))

    async def mark_accepted(self, **kwargs):
        self.transitions.append(("accepted", kwargs))
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key=self.claims[0].operation_key,
            state=OperationState.ACCEPTED,
            version=2,
        )

    async def mark_completed(self, **kwargs):
        self.transitions.append(("completed", kwargs))
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key=self.claims[0].operation_key,
            state=OperationState.COMPLETED,
            version=3,
        )

    async def mark_unknown(self, **kwargs):
        self.transitions.append(("unknown", kwargs))


class _Response:
    status_code = 200
    headers = {"x-newapi-request-id": "provider-request-eg21"}
    content = b""

    def raise_for_status(self):
        return None

    def json(self):
        return {
            "id": "provider-response-eg21",
            "data": [{"b64_json": base64.b64encode(b"generated-image").decode()}],
        }


def _install_boundary_spies(monkeypatch, *, context, operations, facade_effect=None):
    import httpx
    import novelvideo.ports as ports
    from novelvideo.generators import nanobanana_grid
    from novelvideo.storage import media_relay

    calls = {
        "facade": [],
        "legacy": [],
        "provider": [],
        "storage": [],
        "operation_port": [],
        "service_config": [],
        "storage_identity": [],
    }
    monkeypatch.setattr(ports, "get_model_credentials", lambda: _Credentials(context))

    def get_operations():
        calls["operation_port"].append("get")
        return operations

    monkeypatch.setattr(ports, "get_egress_operation_port", get_operations)

    async def facade(data, *, object_id, context, ext="png", ttl=1800):
        calls["facade"].append(
            {
                "data": data,
                "object_id": object_id,
                "context": context,
                "ext": ext,
                "ttl": ttl,
            }
        )
        if facade_effect is not None:
            raise facade_effect
        return f"https://relay.invalid/{len(calls['facade'])}"

    def legacy(*args, **kwargs):
        calls["legacy"].append((args, kwargs))
        return "https://legacy.invalid/reference"

    def storage():
        calls["storage"].append("storage")
        raise AssertionError("storage adapter must not be reached directly")

    def service_config(*_args, **_kwargs):
        calls["service_config"].append("config")
        raise AssertionError("organization caller must not read relay service config")

    def storage_identity(*_args, **_kwargs):
        calls["storage_identity"].append("identity")
        raise AssertionError("organization caller must not construct relay identity")

    class Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            calls["provider"].append((url, headers, json))
            return _Response()

    monkeypatch.setattr(media_relay, "relay_tenant_image_bytes_from_context", facade)
    monkeypatch.setattr(
        nanobanana_grid, "relay_tenant_image_bytes_from_context", facade
    )
    monkeypatch.setattr(nanobanana_grid, "upload_image_bytes", legacy)
    monkeypatch.setattr(nanobanana_grid, "media_relay_ttl_seconds", service_config)
    monkeypatch.setattr(media_relay, "get_media_relay", storage)
    monkeypatch.setattr(media_relay, "StorageRelayIdentity", storage_identity)
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    return calls


@pytest.mark.asyncio
async def test_c1_eg21_caller_propagates_exact_context_bytes_and_stable_object_ids(
    monkeypatch, tmp_path, caplog
):
    from novelvideo.generators import nanobanana_grid

    context = _context()
    operations = _Operations()
    calls = _install_boundary_spies(monkeypatch, context=context, operations=operations)
    references = [b"first-reference", b"second-reference", b"first-reference"]
    extensions = ["jpg", "webp", "png"]
    paths = []
    for index, (data, ext) in enumerate(zip(references, extensions)):
        path = tmp_path / f"{CANARY}-{index}.{ext}"
        path.write_bytes(data)
        paths.append(str(path))
    output = tmp_path / "output.png"
    config = {
        "provider": "newapi",
        "model": "image-model",
        "api_key": CANARY,
        "base_url": f"https://{CANARY}.invalid/v1",
        "egress_context": object(),
        "context": object(),
        "project_id": CANARY,
        "envelope_id": CANARY,
        "mode": "1x1",
        "rows": 1,
        "cols": 1,
        "total_panels": 1,
    }
    monkeypatch.setenv("PROJECT_ID", CANARY)
    monkeypatch.setenv("EGRESS_CONTEXT", CANARY)

    assert (
        nanobanana_grid._ORIGINAL_RELAY_REFERENCE_IMAGES_FOR_NEWAPI
        is nanobanana_grid._relay_reference_images_for_newapi
    )

    result = await nanobanana_grid.generate_reference_edit_image(
        prompt="relay all references",
        reference_images=paths,
        output_path=str(output),
        config=config,
        egress_context=context,
    )

    assert result == output
    assert output.read_bytes() == b"generated-image"
    assert [call["data"] for call in calls["facade"]] == references
    assert all(call["context"] is context for call in calls["facade"])
    assert [call["object_id"] for call in calls["facade"]] == [
        f"{context.envelope_id}:{context.project_id}:{index}:"
        f"{hashlib.sha256(data).hexdigest()}"
        for index, data in enumerate(references)
    ]
    assert len(set(call["object_id"] for call in calls["facade"])) == len(references)
    assert [call["ext"] for call in calls["facade"]] == extensions
    assert all(
        call["ttl"] == nanobanana_grid.NEWAPI_MEDIA_INPUT_MIN_TTL_SECONDS
        for call in calls["facade"]
    )
    assert calls["legacy"] == []
    assert calls["storage"] == []
    assert calls["service_config"] == []
    assert calls["storage_identity"] == []
    assert calls["operation_port"] == ["get"]
    assert len(calls["provider"]) == 1
    provider_observable = repr(calls["provider"])
    assert CANARY not in provider_observable
    persisted = repr(operations.claims) + repr(operations.transitions)
    observable = provider_observable + persisted + caplog.text
    assert CANARY not in observable
    assert all(CANARY not in call["object_id"] for call in calls["facade"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    ["malformed-context", "facade-denial", "relay-failure", "existing-operation"],
)
async def test_c1_eg21_caller_denials_never_forge_or_fallback(
    monkeypatch, tmp_path, caplog, case
):
    from novelvideo.generators import nanobanana_grid
    from novelvideo.storage.media_relay import (
        ServiceEgressDenied,
        ServiceInvocationFailed,
    )

    context = _context()
    operations = _Operations(won=case != "existing-operation")
    effect = None
    if case == "facade-denial":
        effect = ServiceEgressDenied()
    elif case == "relay-failure":
        effect = ServiceInvocationFailed()
    calls = _install_boundary_spies(
        monkeypatch,
        context=context,
        operations=operations,
        facade_effect=effect,
    )
    reference = tmp_path / f"{CANARY}.png"
    reference.write_bytes(b"reference")
    supplied_context = object() if case == "malformed-context" else context

    with pytest.raises(Exception) as exc_info:
        await nanobanana_grid.generate_reference_edit_image(
            prompt="denied reference relay",
            reference_images=[str(reference)],
            output_path=str(tmp_path / "denied.png"),
            config={
                "provider": "newapi",
                "model": "image-model",
                "api_key": CANARY,
                "base_url": f"https://{CANARY}.invalid/v1",
                "egress_context": context,
                "mode": "1x1",
                "rows": 1,
                "cols": 1,
                "total_panels": 1,
            },
            egress_context=supplied_context,
        )

    assert calls["legacy"] == []
    assert calls["provider"] == []
    assert calls["storage"] == []
    assert calls["service_config"] == []
    assert calls["storage_identity"] == []
    assert len(calls["operation_port"]) == (0 if case == "malformed-context" else 1)
    assert len(calls["facade"]) == (
        1 if case in {"facade-denial", "relay-failure"} else 0
    )
    observable = (
        repr(exc_info.value)
        + caplog.text
        + repr(operations.claims)
        + repr(operations.transitions)
        + repr(calls)
    )
    assert CANARY not in observable


@pytest.mark.asyncio
async def test_c1_eg21_direct_call_validates_malformed_context_before_missing_key(
    monkeypatch,
):
    import httpx
    import novelvideo.ports as ports
    from novelvideo.generators import nanobanana_grid
    from novelvideo.storage import media_relay

    calls = {
        "facade": [],
        "legacy": [],
        "provider": [],
        "storage": [],
        "operation_port": [],
        "service_config": [],
        "storage_identity": [],
    }

    def forbidden(name):
        def fail(*_args, **_kwargs):
            calls[name].append(name)
            raise AssertionError(f"{name} must stay at zero")

        return fail

    async def forbidden_facade(*_args, **_kwargs):
        calls["facade"].append("facade")
        raise AssertionError("facade must stay at zero")

    monkeypatch.setattr(nanobanana_grid, "upload_image_bytes", forbidden("legacy"))
    monkeypatch.setattr(
        nanobanana_grid, "media_relay_ttl_seconds", forbidden("service_config")
    )
    monkeypatch.setattr(
        nanobanana_grid,
        "relay_tenant_image_bytes_from_context",
        forbidden_facade,
    )
    monkeypatch.setattr(media_relay, "get_media_relay", forbidden("storage"))
    monkeypatch.setattr(
        media_relay, "StorageRelayIdentity", forbidden("storage_identity")
    )
    monkeypatch.setattr(ports, "get_egress_operation_port", forbidden("operation_port"))
    monkeypatch.setattr(httpx, "AsyncClient", forbidden("provider"))

    with pytest.raises(TypeError, match="TrustedEgressContext"):
        await nanobanana_grid._call_newapi_image_api(
            api_key="",
            model="image-model",
            prompt="malformed direct call",
            reference_images=[b"reference"],
            image_config={
                "egress_context": _context(),
                "project_id": CANARY,
                "path": CANARY,
                "url": f"https://{CANARY}.invalid",
            },
            egress_context=object(),
        )

    assert all(value == [] for value in calls.values())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "context", [None, _context(kind="platform")], ids=["none", "platform"]
)
async def test_c1_eg21_platform_and_none_keep_legacy_transform_without_facade(
    monkeypatch, context
):
    from novelvideo.generators import nanobanana_grid
    from novelvideo.storage import media_relay

    calls = {"facade": [], "legacy": []}

    async def facade(*args, **kwargs):
        calls["facade"].append((args, kwargs))
        raise AssertionError("organization facade must stay at zero")

    def legacy(data, *, ext, ttl, image_transform):
        calls["legacy"].append((data, ext, ttl, image_transform))
        return "https://legacy.invalid/reference"

    monkeypatch.setattr(media_relay, "relay_tenant_image_bytes_from_context", facade)
    monkeypatch.setattr(
        nanobanana_grid, "relay_tenant_image_bytes_from_context", facade
    )
    monkeypatch.setattr(nanobanana_grid, "upload_image_bytes", legacy)
    monkeypatch.setattr(
        nanobanana_grid, "media_relay_ttl_seconds", lambda **_kwargs: 8123
    )

    result = await nanobanana_grid._relay_reference_images_for_newapi(
        [(b"platform-reference", "image/webp")],
        egress_context=context,
    )

    assert result == ["https://legacy.invalid/reference"]
    assert calls["facade"] == []
    assert calls["legacy"] == [
        (
            b"platform-reference",
            "webp",
            8123,
            nanobanana_grid.IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
        )
    ]
