"""Delivery contract for gateway-archived video results."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class VideoDeliveryError(RuntimeError):
    """The generated video exists, but its project copy is not ready yet."""

    def __init__(self, code: str, *, retryable: bool = True) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class ArchivedVideoSource:
    asset_id: str
    storage_provider: str
    bucket: str
    object_key: str
    url: str
    content_type: str
    size: int
    sha256: str


@dataclass(frozen=True)
class VideoDeliveryReceipt:
    method: str
    size: int
    sha256: str


class VideoResultDeliveryPort(Protocol):
    async def deliver(
        self,
        *,
        source: ArchivedVideoSource,
        output_path: str,
    ) -> VideoDeliveryReceipt: ...
