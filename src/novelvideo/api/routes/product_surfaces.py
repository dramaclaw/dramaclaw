"""Product-surface visibility discovery for the current user."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from novelvideo.api.auth import get_api_user
from novelvideo.ports import get_product_surface_access

router = APIRouter(prefix="/product-surfaces")


def current_user_id(user: dict[str, Any]) -> str:
    user_id = str(user.get("user_id") or user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="no user id on session")
    return user_id


@router.get("/me")
async def current_product_surface_access(user: dict = Depends(get_api_user)) -> dict:
    items = await get_product_surface_access().get_effective_access(current_user_id(user))
    return {"ok": True, "data": {"items": items}}
