"""Paged Codex history projection with bounded pages and an LRU cache."""

import json
import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any, TypeVar

from openai_codex.errors import CodexError, InvalidRequestError, is_retryable_error
from pydantic import BaseModel

from novelvideo.chat.backend_sdk import (
    _is_archived_codex_thread_error,
    _is_missing_codex_thread_error,
)
from novelvideo.chat.codex_projection import project_turn
from novelvideo.chat.codex_protocol import (
    THREAD_ITEMS_LIST,
    THREAD_TURNS_LIST,
    CodexTurn,
    ThreadItemsPage,
    ThreadTurnsPage,
    newest_turns_params,
    turn_items_params,
)

TURNS_PAGE_LIMIT = 20
ITEMS_PAGE_LIMIT = 200
CODEX_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
HISTORY_PAGE_MAX_BYTES = 3 * 1024 * 1024
HISTORY_PAGE_MAX_TURNS = 100
READ_RETRIES = 3
READ_RETRY_SECONDS = 0.2
CACHE_MAX_BYTES = 64 * 1024 * 1024

logger = logging.getLogger(__name__)
Response = TypeVar("Response", bound=BaseModel)


class CodexHistoryUnavailable(RuntimeError):
    """The server could not supply paginated history."""


class _MissingThread(Exception):
    """A missing thread remained missing after all read retries."""


@dataclass(frozen=True)
class CodexHistoryPage:
    messages: list[dict]
    before: str | None
    byte_size: int
    stats: dict


def _new_stats() -> dict:
    return {"requests": 0, "turns": 0, "items_limit_halvings": 0, "retries": 0, "capped": None}


def _request(
    client: Any,
    method: str,
    params: dict,
    response_model: type[Response],
    stats: dict,
    sleep: Callable[[float], Any],
) -> Response:
    for attempt in range(READ_RETRIES + 1):
        stats["requests"] += 1
        try:
            return client.request(method, params, response_model=response_model)
        except CodexError as exc:
            missing = isinstance(exc, InvalidRequestError) and _is_missing_codex_thread_error(exc)
            retryable = is_retryable_error(exc) or (
                isinstance(exc, InvalidRequestError)
                and (missing or _is_archived_codex_thread_error(exc))
            )
            if retryable and attempt < READ_RETRIES:
                stats["retries"] += 1
                sleep(READ_RETRY_SECONDS)
                continue
            if missing:
                raise _MissingThread from exc
            raise CodexHistoryUnavailable("Codex history read failed") from exc


def _decode_before(before: str | None) -> tuple[str | None, str | None]:
    if before is None:
        return None, None
    try:
        value = json.loads(before)
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid history cursor") from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"cursor", "turn"}
        or (value["cursor"] is not None and not isinstance(value["cursor"], str))
        or not isinstance(value["turn"], str)
        or not value["turn"]
    ):
        raise ValueError("Invalid history cursor")
    return value["cursor"], value["turn"]


def _turns(
    client: Any,
    thread_id: str,
    cursor: str | None,
    resume_turn: str | None,
    stats: dict,
    sleep: Callable[[float], Any],
) -> Iterator[tuple[CodexTurn, str | None]]:
    while True:
        page = _request(
            client, THREAD_TURNS_LIST,
            newest_turns_params(thread_id, limit=TURNS_PAGE_LIMIT, cursor=cursor),
            ThreadTurnsPage, stats, sleep,
        )
        for turn in page.data:
            if resume_turn is not None:
                if turn.id != resume_turn:
                    continue
                resume_turn = None
            yield turn, cursor
        if page.next_cursor is None:
            if resume_turn is not None:
                raise ValueError("History cursor turn was not found")
            return
        cursor = page.next_cursor


def _read_turn(
    client: Any,
    thread_id: str,
    turn: CodexTurn,
    items_limit: int,
    stats: dict,
    sleep: Callable[[float], Any],
) -> tuple[dict | None, int]:
    records = []
    cursor = None
    while True:
        response = _request(
            client, THREAD_ITEMS_LIST,
            turn_items_params(thread_id, turn.id, limit=items_limit, cursor=cursor),
            ThreadItemsPage, stats, sleep,
        )
        response_bytes = len(json.dumps(
            response.model_dump(mode="json", by_alias=True), ensure_ascii=False
        ).encode("utf-8"))
        if response_bytes > CODEX_RESPONSE_MAX_BYTES and items_limit > 1:
            items_limit = max(1, items_limit // 2)
            stats["items_limit_halvings"] += 1
        records.extend(response.data)
        cursor = response.next_cursor
        del response
        if cursor is None:
            return project_turn(turn, records), items_limit


def read_codex_history_page(
    client: Any,
    thread_id: str,
    *,
    before: str | None = None,
    max_bytes: int = HISTORY_PAGE_MAX_BYTES,
    max_turns: int = HISTORY_PAGE_MAX_TURNS,
    sleep: Callable[[float], Any] = time.sleep,
) -> CodexHistoryPage:
    """Read complete turns newest first, returning their projected messages oldest first."""
    started = time.monotonic()
    stats = _new_stats()
    messages: list[dict] = []
    byte_size = 0
    next_before = None
    try:
        cursor, resume_turn = _decode_before(before)
        items_limit = ITEMS_PAGE_LIMIT
        for turn, turns_cursor in _turns(client, thread_id, cursor, resume_turn, stats, sleep):
            capped = None
            if stats["turns"] >= max_turns:
                capped = "turns"
            else:
                message, items_limit = _read_turn(
                    client, thread_id, turn, items_limit, stats, sleep
                )
                message_bytes = (
                    len(json.dumps(message, ensure_ascii=False).encode("utf-8"))
                    if message is not None else 0
                )
                if message is not None and messages and byte_size + message_bytes > max_bytes:
                    capped = "bytes"
                else:
                    stats["turns"] += 1
                    if message is not None:
                        messages.append(message)
                        byte_size += message_bytes
            if capped is not None:
                stats["capped"] = capped
                next_before = json.dumps(
                    {"cursor": turns_cursor, "turn": turn.id}, separators=(",", ":")
                )
                break
        messages.reverse()
        return CodexHistoryPage(messages, next_before, byte_size, stats)
    except _MissingThread:
        messages = []
        byte_size = 0
        return CodexHistoryPage([], None, 0, stats)
    finally:
        logger.info(
            "Codex history thread=%s requests=%s turns=%s messages=%s byte_size=%s "
            "items_limit_halvings=%s retries=%s capped=%s elapsed_ms=%.1f",
            thread_id, stats["requests"], stats["turns"], len(messages), byte_size,
            stats["items_limit_halvings"], stats["retries"], stats["capped"],
            (time.monotonic() - started) * 1000,
        )


class CodexHistoryCache:
    """Cache completed history pages, validating the newest turn on every read."""

    def __init__(self, max_bytes: int = CACHE_MAX_BYTES):
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._pages: OrderedDict[tuple, CodexHistoryPage] = OrderedDict()
        self._byte_size = 0

    def read_page(
        self, client: Any, thread_id: str, *, before: str | None = None,
        sleep: Callable[[float], Any] = time.sleep,
    ) -> CodexHistoryPage:
        stats = _new_stats()
        try:
            probe = _request(
                client, THREAD_TURNS_LIST, newest_turns_params(thread_id, limit=1),
                ThreadTurnsPage, stats, sleep,
            )
        except _MissingThread:
            return CodexHistoryPage([], None, 0, stats)
        if not probe.data:
            return CodexHistoryPage([], None, 0, stats)
        newest = probe.data[0]
        key = (thread_id, before, newest.id, newest.status, newest.completed_at)
        with self._lock:
            if key in self._pages:
                self._pages.move_to_end(key)
                return self._pages[key]
        page = read_codex_history_page(client, thread_id, before=before, sleep=sleep)
        if newest.status != "inProgress" and page.byte_size <= self._max_bytes:
            with self._lock:
                previous = self._pages.pop(key, None)
                if previous is not None:
                    self._byte_size -= previous.byte_size
                self._pages[key] = page
                self._byte_size += page.byte_size
                while self._byte_size > self._max_bytes:
                    _, evicted = self._pages.popitem(last=False)
                    self._byte_size -= evicted.byte_size
        return page

    def invalidate(self, thread_id: str) -> None:
        with self._lock:
            for key in [key for key in self._pages if key[0] == thread_id]:
                self._byte_size -= self._pages.pop(key).byte_size


HISTORY_CACHE = CodexHistoryCache()
