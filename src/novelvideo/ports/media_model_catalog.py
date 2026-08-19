"""Media-model catalog port shared by CE request handling and EE policy."""

from __future__ import annotations

from typing import Any, Protocol


class MediaModelCatalogPort(Protocol):
    async def list_models(self, media_type: str) -> list[dict[str, Any]]: ...

    async def list_models_for_user(
        self,
        media_type: str,
        *,
        user_id: str,
    ) -> list[dict[str, Any]]: ...

