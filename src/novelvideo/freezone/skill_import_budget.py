"""Per-run limits for external Skill conversion model calls."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from openai import APIConnectionError, APIStatusError
from pydantic_ai.exceptions import ModelHTTPError


MAX_MODEL_CALLS = 12
MAX_MATCHING_CALLS = 4
RUN_TIMEOUT_SECONDS = 1800


class ImportBudgetExceeded(ValueError):
    """Raised when an import run cannot make another model request."""


def is_transient_model_error(exc: BaseException) -> bool:
    """Return whether a model failure is safe to retry once at transport level."""
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None:
        if id(current) in seen:
            break
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__

    if any(isinstance(item, (asyncio.CancelledError, ImportBudgetExceeded)) for item in chain):
        return False
    for item in chain:
        if isinstance(item, (ModelHTTPError, APIStatusError)):
            status_code = item.status_code
            return status_code == 429 or 500 <= status_code < 600
        if isinstance(item, ValueError):
            return False
        if isinstance(item, (TimeoutError, APIConnectionError)):
            return True
    return False


class ImportBudget:
    """Track one conversion run from its worker start until completion."""

    def __init__(
        self,
        *,
        max_model_calls: int = MAX_MODEL_CALLS,
        max_matching_calls: int = MAX_MATCHING_CALLS,
        timeout_seconds: float = RUN_TIMEOUT_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_model_calls = max_model_calls
        self.max_matching_calls = max_matching_calls
        self.timeout_seconds = timeout_seconds
        self._clock = clock
        self._started_at = clock()
        self._model_calls = 0
        self._matching_calls = 0
        self._input_chars = 0
        self._output_chars = 0

    @property
    def matching_calls_used(self) -> int:
        """Return charged matching submits without allowing counter mutation."""
        return self._matching_calls

    @property
    def matching_calls_remaining(self) -> int:
        """Return how many matching submits can still be charged."""
        return max(0, self.max_matching_calls - self._matching_calls)

    def _remaining_seconds(self, name: str) -> float:
        remaining = self.timeout_seconds - (self._clock() - self._started_at)
        if remaining <= 0:
            raise ImportBudgetExceeded(f'Skill import run timeout exhausted before {name}')
        return remaining

    def consume(self, name: str) -> None:
        """Reserve one actual request without charging cache/checkpoint reads."""
        self._remaining_seconds(name)
        if self._model_calls >= self.max_model_calls:
            raise ImportBudgetExceeded('Skill import model-call budget exhausted')
        matching = name.startswith('inspecting:')
        if matching and self._matching_calls >= self.max_matching_calls:
            raise ImportBudgetExceeded('Skill import matching-call budget exhausted')
        self._model_calls += 1
        if matching:
            self._matching_calls += 1

    async def generate(
        self,
        name: str,
        prompt: str,
        generate: Callable[[str], Awaitable[str]],
    ) -> str:
        """Perform a charged request within the remaining run time."""
        self.consume(name)
        self._input_chars += len(prompt)
        remaining = self._remaining_seconds(name)
        timeout_context = asyncio.timeout(remaining)
        try:
            async with timeout_context:
                response = await generate(prompt)
        except TimeoutError as exc:
            if timeout_context.expired():
                raise ImportBudgetExceeded(
                    f'Skill import run timeout exhausted while waiting for {name}'
                ) from exc
            raise
        self._output_chars += len(response)
        return response

    def snapshot(self) -> dict[str, Any]:
        """Return diagnostic counters for this run without mutating them."""
        elapsed = self._clock() - self._started_at
        return {
            'model_calls': self._model_calls,
            'matching_calls': self._matching_calls,
            'input_chars': self._input_chars,
            'output_chars': self._output_chars,
            'elapsed_seconds': elapsed,
            'remaining_seconds': max(0.0, self.timeout_seconds - elapsed),
        }
