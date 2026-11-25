"""Organization reference images get the same AI-reference normalization.

Reference images handed to the gateway are relayed as URLs; the gateway
downloads each one and inlines it for the upstream model. The personal path
re-encodes references to JPEG before relaying. The organization path must do
the same, or a large PNG (for example a reused 4K output) reaches the gateway
at full size.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image
from support.egress_ledger import LedgerDouble

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference


class RelayDouble:
    def __init__(self) -> None:
        self.uploads: list[tuple[bytes, str, str]] = []

    def upload_bytes(self, data, *, ext, ttl, object_key="", **_kwargs) -> str:
        self.uploads.append((bytes(data), ext, object_key))
        return f"https://relay.example/{len(self.uploads)}"


def _org_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-normalize",
        project_id="project-normalize",
        task_type="image.edit",
        requester_user_id="user-normalize",
        root_task_id="root-normalize",
        admission_id="admission-normalize",
        admitted_at="2026-11-25T04:46:00Z",
        membership_id="membership-normalize",
        authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id="org-normalize"),
        credential=CredentialReference(
            source="organization",
            credential_id="org-gateway-key",
            key_version=1,
            org_id="org-normalize",
        ),
    )


def _png(size=(64, 48), mode="RGBA") -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, size, (200, 30, 30, 255) if mode == "RGBA" else (200, 30, 30)).save(
        buffer, format="PNG"
    )
    return buffer.getvalue()


@pytest.fixture
def relay(monkeypatch):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    double = RelayDouble()
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: LedgerDouble())
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: double)
    return double


@pytest.mark.asyncio
async def test_organization_references_are_relayed_as_normalized_jpeg(relay):
    from novelvideo.generators import nanobanana_grid

    source = _png()
    await nanobanana_grid._relay_reference_images_for_newapi(
        [("reference_1.png", source, "image/png")],
        egress_context=_org_context(),
    )

    [(data, ext, object_key)] = relay.uploads
    assert ext == "jpg"
    assert object_key.endswith(".jpg")
    with Image.open(io.BytesIO(data)) as relayed:
        assert relayed.format == "JPEG"
        assert relayed.mode == "RGB"
        assert relayed.size == (64, 48)


@pytest.mark.asyncio
async def test_organization_and_personal_paths_relay_identical_bytes(relay):
    from novelvideo.generators import nanobanana_grid

    reference = ("reference_1.png", _png(), "image/png")
    await nanobanana_grid._relay_reference_images_for_newapi([reference])
    await nanobanana_grid._relay_reference_images_for_newapi(
        [reference],
        egress_context=_org_context(),
    )

    (personal_data, personal_ext, _), (org_data, org_ext, _) = relay.uploads
    assert (org_data, org_ext) == (personal_data, personal_ext)


@pytest.mark.asyncio
async def test_undecodable_organization_reference_is_relayed_unchanged(relay):
    from novelvideo.generators import nanobanana_grid

    await nanobanana_grid._relay_reference_images_for_newapi(
        [b"not-an-image"],
        egress_context=_org_context(),
    )

    [(data, ext, _)] = relay.uploads
    assert data == b"not-an-image"
    assert ext == "png"
