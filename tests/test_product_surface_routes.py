from __future__ import annotations

import pytest
from fastapi import HTTPException

from novelvideo.api.routes.product_surfaces import require_product_surface
from novelvideo.ports import registry
from novelvideo.ports.product_surface_access import ProductSurfaceUnavailableError


class DeniedSurfaceAccess:
    async def require_access(self, _user_id: str, surface_code: str) -> None:
        raise ProductSurfaceUnavailableError(surface_code, "功能维护中")


@pytest.mark.asyncio
async def test_surface_dependency_returns_structured_403(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        registry._PORTS,
        "product_surface_access",
        DeniedSurfaceAccess(),
    )
    dependency = require_product_surface("freezone")

    with pytest.raises(HTTPException) as raised:
        await dependency({"id": "usr_1"})

    assert raised.value.status_code == 403
    assert raised.value.detail == {
        "error_code": "PRODUCT_SURFACE_UNAVAILABLE",
        "surface_code": "freezone",
        "message": "功能维护中",
    }
