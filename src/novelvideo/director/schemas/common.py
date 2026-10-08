"""Reject coercion and unknown fields before any versioned director operation.

These models validate wire structure, not user permission or model truthfulness.
Repositories must still authorize scope and compare versions inside transactions.
"""

from __future__ import annotations

from typing import Annotated, Any, Self

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Identifier = Annotated[
    str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:-]*$")
]
Sha256 = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
PositiveInt = Annotated[int, Field(ge=1)]
NonNegativeInt = Annotated[int, Field(ge=0)]
Seconds = Annotated[float, Field(gt=0, allow_inf_nan=False)]


class ContractModel(BaseModel):
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        frozen=True,
        alias_generator=to_camel,
        populate_by_name=True,
        allow_inf_nan=False,
    )

    @classmethod
    def from_wire(cls, payload: Any) -> Self:
        """Keep Python field names internal; wire spelling is part of the contract."""
        return cls.model_validate(payload, by_alias=True, by_name=False)


class DirectorContractError(ValueError):
    """Stable codes let adapters localize errors without parsing exception prose."""

    def __init__(self, code: str, *, affected_ids: list[str] | None = None) -> None:
        self.code = code
        self.affected_ids = tuple(affected_ids or ())
        super().__init__(code)


def require_unique(values: list[str], code: str) -> None:
    if len(values) != len(set(values)):
        raise ValueError(code)
