"""Share request state through a process-wide holder, even across bundled module copies."""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
import os
import sys
from types import MappingProxyType, ModuleType
from typing import TypeVar, overload

_holder = ModuleType("_dramaclaw_request_context_state")
_holder.values = ContextVar("dramaclaw_request_context", default=None)
_values: ContextVar[Mapping[str, str] | None] = sys.modules.setdefault(
    _holder.__name__, _holder
).values


_Default = TypeVar("_Default")


@overload
def get(name: str, default: _Default) -> str | _Default: ...


@overload
def get(name: str) -> str | None: ...


def get(name: str, default: _Default | None = None) -> str | _Default | None:
    values = _values.get()
    if values is None:
        return os.environ.get(name, default)
    return values.get(name, default)


@contextmanager
def scope(values: Mapping[str, str]) -> Iterator[None]:
    token = _values.set(MappingProxyType(dict(values)))
    try:
        yield
    finally:
        _values.reset(token)


def active() -> bool:
    return _values.get() is not None
