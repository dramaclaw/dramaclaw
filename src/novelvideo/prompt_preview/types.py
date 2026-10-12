"""Wire types for the prompt preview API."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

PartRole = Literal["system", "user", "image", "negative"]
ModelKind = Literal["llm", "image", "video", "tts", "none"]


@dataclass
class PromptPart:
    role: PartRole
    label: str
    text: str


@dataclass
class LastSent:
    text: str
    path: str
    mtime: float


@dataclass
class PreviewTarget:
    id: str
    label: str


@dataclass
class PromptPreview:
    step: str
    model_kind: ModelKind
    supported: bool = True
    target_label: str = ""
    parts: list[PromptPart] = field(default_factory=list)
    inputs: dict[str, Any] = field(default_factory=dict)
    last_sent: LastSent | None = None
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
