"""One bounded browser history page from Codex turns and server-written rows."""

import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from novelvideo.chat.codex_history import CodexHistoryPage, CodexHistoryUnavailable
from novelvideo.chat.store import ChatScope, ChatStore, chat_store

STORE_ROWS_PAGE_MAX = 500
# Codex (3 MiB) + rows + events = 4 MiB; a single oversized row or turn stays whole.
BROWSER_PAGE_MAX_BYTES = 4 * 1024 * 1024
STORE_ROWS_PAGE_MAX_BYTES = 512 * 1024
UI_EVENTS_PAGE_MAX_BYTES = 512 * 1024

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HistoryPage:
    history: list[dict]
    before: str | None
    has_more: bool


def _decode_before(before: str | None) -> tuple[str | None, int | None, bool]:
    if before is None:
        return None, None, False
    try:
        value = json.loads(before)
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid history cursor") from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"codex", "row", "codex_done"}
        or (value["codex"] is not None and not isinstance(value["codex"], str))
        or (value["row"] is not None and type(value["row"]) is not int)
        or type(value["codex_done"]) is not bool
    ):
        raise ValueError("Invalid history cursor")
    return value["codex"], value["row"], value["codex_done"]


def _merge_messages(rows: list[dict], messages: list[dict]) -> list[dict]:
    # Slots are boundaries before each row (including the boundary after the last).
    users = {row["turn_id"]: index + 1 for index, row in enumerate(rows)
             if row["role"] == "user" and row.get("turn_id")}
    slots: dict[int, list[dict]] = {}
    previous_slot = 0
    for message in messages:
        slot = users.get(message["turn_id"])
        if slot is None:
            slot = next((index for index, row in enumerate(rows)
                         if row["created_at"] >= message["created_at"]), len(rows))
        slot = max(previous_slot, slot)
        slots.setdefault(slot, []).append(message)
        previous_slot = slot
    history = []
    for index, row in enumerate(rows):
        history.extend(slots.get(index, []))
        history.append(row)
    history.extend(slots.get(len(rows), []))
    return history


async def read_history_page(
    *,
    username: str,
    store_scope: ChatScope,
    before: str | None,
    read_codex: Callable[[str | None], Awaitable[CodexHistoryPage | None]],
    extract_media: Callable[[str], list[dict]],
    store: ChatStore = chat_store,
) -> HistoryPage:
    started = time.monotonic()
    codex_before, upper_id, codex_done = _decode_before(before)
    page = None
    if not codex_done:
        try:
            page = await read_codex(codex_before)
        except CodexHistoryUnavailable:
            logger.warning("Codex history unavailable scope=%s", store_scope.kind)
    messages = [dict(message, media=extract_media(message["content"]))
                for message in page.messages] if page is not None else []
    codex_more = page is not None and page.before is not None
    lower_id = None
    if codex_more and messages:
        lower_id = await store.history_anchor_id_async(
            username, store_scope, turn_id=messages[0]["turn_id"],
            created_at=messages[0]["created_at"],
        )
    rows, overflow = [], False
    if not codex_more or lower_id is not None:
        rows, overflow = await store.history_rows_async(
            username, store_scope, lower_id=lower_id, upper_id=upper_id,
            limit=STORE_ROWS_PAGE_MAX, max_bytes=STORE_ROWS_PAGE_MAX_BYTES,
        )
    next_before = None
    if overflow or codex_more:
        next_before = json.dumps({
            "codex": page.before if codex_more else None,
            "row": rows[0]["id"] if overflow else (
                lower_id if lower_id is not None else upper_id
            ),
            "codex_done": not codex_more,
        }, separators=(",", ":"))
    turn_ids = {message["turn_id"] for message in messages}
    kept_rows = []
    for row in rows:
        key = row.pop("idempotency_key")
        if (row["role"] == "assistant" and row.get("turn_id") in turn_ids
                and key == "assistant:" + row["turn_id"]):
            continue
        kept_rows.append(row)
    history = _merge_messages(kept_rows, messages)
    events = await store.turn_ui_events_async(
        username, store_scope, [m["turn_id"] for m in reversed(history) if m.get("turn_id")],
        max_bytes=UI_EVENTS_PAGE_MAX_BYTES,
    )
    ChatStore._attach_ui_events_to_messages(history, events)
    result = HistoryPage(history, next_before, next_before is not None)
    logger.info(
        "History page scope=%s codex=%s store=%s overflow=%s has_more=%s elapsed_ms=%.1f",
        store_scope.kind, len(messages), len(kept_rows), overflow, result.has_more,
        (time.monotonic() - started) * 1000,
    )
    return result
