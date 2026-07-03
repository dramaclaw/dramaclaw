"""Release feed port."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

Attention = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class ReleaseItem:
    id: str
    kind: str
    icon: str
    title: str
    body: str


@dataclass(frozen=True)
class ReleaseFeed:
    source: Literal["local_file", "local_file+github", "none"]
    current_version: str | None = None
    current_tag: str | None = None
    current_items: list[ReleaseItem] = field(default_factory=list)
    update_available: bool = False
    latest_version: str | None = None
    latest_tag: str | None = None
    release_url: str | None = None
    update_items: list[ReleaseItem] = field(default_factory=list)
    attention: Attention = "low"
    latest_published_at: str | None = None


class ReleaseFeedPort(Protocol):
    async def current(self, *, locale: str) -> ReleaseFeed: ...
