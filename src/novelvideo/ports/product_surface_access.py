"""Product-surface access contract shared by CE and EE runtimes."""

from __future__ import annotations

from typing import Any, Final

SURFACE_DEFINITIONS: Final[tuple[dict[str, Any], ...]] = (
    {
        "surface_code": "mainline",
        "label": "主线",
        "default_available": True,
        "default_unavailable_message": "主线功能暂未开放",
        "sort_order": 10,
    },
    {
        "surface_code": "freezone",
        "label": "虾画",
        "default_available": True,
        "default_unavailable_message": "虾画功能暂未开放",
        "sort_order": 20,
    },
    {
        "surface_code": "assistant",
        "label": "虾导",
        "default_available": False,
        "default_unavailable_message": "虾导功能暂未开放",
        "sort_order": 30,
    },
    {
        "surface_code": "freezone_assistant",
        "label": "虾画中的虾导",
        "default_available": False,
        "default_unavailable_message": "虾画中的虾导暂未开放",
        "sort_order": 40,
    },
)

SURFACE_DEFINITIONS_BY_CODE: Final = {
    str(item["surface_code"]): item for item in SURFACE_DEFINITIONS
}


class ProductSurfaceUnavailableError(RuntimeError):
    """Raised when the current user cannot enter a product surface."""

    def __init__(self, surface_code: str, message: str) -> None:
        super().__init__(message)
        self.surface_code = surface_code
        self.message = message


class LocalProductSurfaceAccess:
    """Safe CE defaults: core creation stays open and assistant entry points stay closed."""

    async def get_effective_access(self, user_id: str) -> list[dict[str, Any]]:
        del user_id
        return [
            {
                "surface_code": str(item["surface_code"]),
                "label": str(item["label"]),
                "available": bool(item["default_available"]),
                "unavailable_message": str(item["default_unavailable_message"]),
            }
            for item in SURFACE_DEFINITIONS
        ]

    async def require_access(self, user_id: str, surface_code: str) -> dict[str, Any]:
        clean_surface_code = str(surface_code or "").strip()
        definition = SURFACE_DEFINITIONS_BY_CODE.get(clean_surface_code)
        if definition is None:
            raise ValueError(f"unknown product surface: {clean_surface_code}")
        if not bool(definition["default_available"]):
            raise ProductSurfaceUnavailableError(
                clean_surface_code,
                str(definition["default_unavailable_message"]),
            )
        return {
            "surface_code": clean_surface_code,
            "label": str(definition["label"]),
            "available": True,
            "unavailable_message": str(definition["default_unavailable_message"]),
        }

    async def require_assistant_access(self, user_id: str) -> dict[str, Any]:
        del user_id
        definition = SURFACE_DEFINITIONS_BY_CODE["assistant"]
        raise ProductSurfaceUnavailableError(
            "assistant",
            str(definition["default_unavailable_message"]),
        )
