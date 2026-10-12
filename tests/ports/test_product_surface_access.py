from __future__ import annotations

import pytest

from novelvideo.ports.product_surface_access import (
    LocalProductSurfaceAccess,
)


@pytest.mark.asyncio
async def test_ce_surface_defaults_keep_assistants_hidden(monkeypatch) -> None:
    monkeypatch.delenv("ST_CE_ENABLE_ASSISTANT_SURFACES", raising=False)
    access = LocalProductSurfaceAccess()
    items = await access.get_effective_access("local-user")
    by_code = {item["surface_code"]: item for item in items}

    assert by_code["mainline"]["available"] is True
    assert by_code["freezone"]["available"] is True
    assert by_code["assistant"]["available"] is False
    assert by_code["freezone_assistant"]["available"] is False


@pytest.mark.asyncio
async def test_ce_surface_local_override_enables_assistants(monkeypatch) -> None:
    monkeypatch.setenv("ST_CE_ENABLE_ASSISTANT_SURFACES", "true")
    access = LocalProductSurfaceAccess()
    items = await access.get_effective_access("local-user")
    by_code = {item["surface_code"]: item for item in items}

    assert by_code["mainline"]["available"] is True
    assert by_code["freezone"]["available"] is True
    assert by_code["assistant"]["available"] is True
    assert by_code["freezone_assistant"]["available"] is True
