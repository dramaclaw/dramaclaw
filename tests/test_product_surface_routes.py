from __future__ import annotations

import pytest

from novelvideo.api.routes.product_surfaces import current_product_surface_access
from novelvideo.ports import registry


class VisibleSurfaceAccess:
    async def get_effective_access(self, user_id: str) -> list[dict]:
        assert user_id == "usr_1"
        return [
            {
                "surface_code": "freezone",
                "label": "虾画",
                "available": False,
                "unavailable_message": "入口维护中",
            }
        ]


@pytest.mark.asyncio
async def test_surface_route_returns_visibility_without_enforcing_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        registry._PORTS,
        "product_surface_access",
        VisibleSurfaceAccess(),
    )
    result = await current_product_surface_access({"id": "usr_1"})

    assert result == {
        "ok": True,
        "data": {
            "items": [
                {
                    "surface_code": "freezone",
                    "label": "虾画",
                    "available": False,
                    "unavailable_message": "入口维护中",
                }
            ]
        },
    }
