from __future__ import annotations

import pytest

from novelvideo.ports.product_surface_access import (
    LocalProductSurfaceAccess,
    ProductSurfaceUnavailableError,
)


@pytest.mark.asyncio
async def test_ce_surface_defaults_keep_core_open_and_assistants_closed() -> None:
    access = LocalProductSurfaceAccess()
    items = await access.get_effective_access("local-user")
    by_code = {item["surface_code"]: item for item in items}

    assert by_code["mainline"]["available"] is True
    assert by_code["freezone"]["available"] is True
    assert by_code["assistant"]["available"] is False
    assert by_code["freezone_assistant"]["available"] is False


@pytest.mark.asyncio
async def test_ce_rejects_assistant_service() -> None:
    access = LocalProductSurfaceAccess()

    with pytest.raises(ProductSurfaceUnavailableError, match="虾导功能暂未开放"):
        await access.require_assistant_access("local-user", "assistant")
