"""Product-surface discovery and backend admission guards."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from novelvideo.api.auth import get_api_user
from novelvideo.ports import get_product_surface_access
from novelvideo.ports.product_surface_access import ProductSurfaceUnavailableError

router = APIRouter(prefix="/product-surfaces")


def current_user_id(user: dict[str, Any]) -> str:
    user_id = str(user.get("user_id") or user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="no user id on session")
    return user_id


def unavailable_detail(exc: ProductSurfaceUnavailableError) -> dict[str, str]:
    return {
        "error_code": "PRODUCT_SURFACE_UNAVAILABLE",
        "surface_code": exc.surface_code,
        "message": exc.message,
    }


def require_product_surface(surface_code: str) -> Callable[..., Any]:
    async def _require(user: dict = Depends(get_api_user)) -> dict:
        try:
            await get_product_surface_access().require_access(
                current_user_id(user),
                surface_code,
            )
        except ProductSurfaceUnavailableError as exc:
            raise HTTPException(status_code=403, detail=unavailable_detail(exc)) from exc
        return user

    return _require


require_freezone_surface = require_product_surface("freezone")
require_mainline_surface = require_product_surface("mainline")


@router.get("/me")
async def current_product_surface_access(user: dict = Depends(get_api_user)) -> dict:
    items = await get_product_surface_access().get_effective_access(current_user_id(user))
    return {"ok": True, "data": {"items": items}}
