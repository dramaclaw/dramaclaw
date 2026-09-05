"""Product-surface visibility contract shared by CE and EE runtimes."""

from __future__ import annotations

import os
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
PRODUCT_SURFACE_CODES: Final[frozenset[str]] = frozenset(
    str(item["surface_code"]) for item in SURFACE_DEFINITIONS
)

_ASSISTANT_SURFACE_CODES: Final[frozenset[str]] = frozenset(
    {"assistant", "freezone_assistant"}
)
_TRUE_ENV_VALUES: Final[frozenset[str]] = frozenset({"1", "true", "yes", "on"})


def _local_assistant_surfaces_enabled() -> bool:
    return (
        os.environ.get("ST_CE_ENABLE_ASSISTANT_SURFACES", "").strip().casefold()
        in _TRUE_ENV_VALUES
    )


class LocalProductSurfaceAccess:
    """CE defaults keep assistant surfaces hidden until explicitly enabled."""

    async def get_effective_access(self, user_id: str) -> list[dict[str, Any]]:
        del user_id
        assistant_surfaces_enabled = _local_assistant_surfaces_enabled()
        return [
            {
                "surface_code": str(item["surface_code"]),
                "label": str(item["label"]),
                "available": bool(item["default_available"])
                or (
                    assistant_surfaces_enabled
                    and item["surface_code"] in _ASSISTANT_SURFACE_CODES
                ),
                "unavailable_message": str(item["default_unavailable_message"]),
            }
            for item in SURFACE_DEFINITIONS
        ]
