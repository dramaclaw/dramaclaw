"""Pure, per-item live projection of a Codex turn."""

from dataclasses import dataclass, field
from typing import Any

from novelvideo.chat.codex_projection import REASONING_TEXT_MAX_BYTES, _truncate, project_item
from novelvideo.chat.presentation_text import _redact_local_filesystem_paths
from novelvideo.chat.stream_delta import AssistantDeltaEncoder


@dataclass
class _OpenItem:
    item: dict[str, Any]
    started_at_ms: int | None
    text: str
    summary_index: int | None = None
    encoder: AssistantDeltaEncoder = field(default_factory=AssistantDeltaEncoder)


class LiveTurnProjector:
    def __init__(self, *, turn_id: str) -> None:
        self.turn_id = turn_id
        self.message_id: str | None = None
        self._open: dict[str, _OpenItem] = {}
        self._item_ids: dict[str, None] = {}

    def bind(self, codex_turn_id: str) -> None:
        self.message_id = f"assistant:{codex_turn_id}"

    @property
    def item_ids(self) -> list[str]:
        return list(self._item_ids)

    def _frame(self, item_id: str, card: dict[str, Any] | None) -> dict[str, Any]:
        if card is not None:
            self._item_ids.setdefault(item_id, None)
        return {
            "type": "item", "message_id": self.message_id, "item_id": item_id, "card": card,
        }

    def started(
        self, item: dict[str, Any], started_at_ms: int | None
    ) -> dict[str, Any] | None:
        if self.message_id is None:
            return None
        card = project_item(
            item, turn_id=self.turn_id, started_at_ms=started_at_ms, completed=False
        )
        item_type = item["type"]
        if card is None:
            if item_type not in {"agentMessage", "reasoning"}:
                return None
            card = {"id": item["id"]}
            if started_at_ms is not None:
                card["seq"] = started_at_ms
            if item_type == "agentMessage":
                card.update(type="text", text="")
            else:
                card.update(type="agent_thought", event={
                    "type": "agent.thought", "turn_id": self.turn_id, "text": "",
                    "status": "running", "truncated": False,
                })
        text = (
            "\n\n".join(part for part in item.get("summary", []) if part.strip())
            if item_type == "reasoning" else item.get("text", "")
        )
        # Keep only the bounded summary; private reasoning content is never needed.
        remembered = dict(item)
        if item_type == "reasoning":
            text = _truncate(text, REASONING_TEXT_MAX_BYTES + 4096)
            remembered["summary"] = []
            remembered["content"] = []
        state = _OpenItem(remembered, started_at_ms, text)
        if item_type in {"agentMessage", "reasoning"}:
            state.encoder.encode(
                card["text"] if item_type == "agentMessage" else card["event"]["text"]
            )
        self._open[item["id"]] = state
        return self._frame(item["id"], card)

    def delta(
        self, item_id: str, kind: str, text: str, summary_index: int | None = None
    ) -> dict[str, Any] | None:
        if self.message_id is None or item_id not in self._open:
            return None
        state = self._open[item_id]
        if kind == "reasoning":
            limit = REASONING_TEXT_MAX_BYTES + 4096
            remaining = limit - len(state.text.encode("utf-8"))
            if remaining <= 0:
                return None
            separator = "\n\n" if state.text and summary_index != state.summary_index else ""
            state.text += _truncate(separator + text, remaining)
            state.summary_index = summary_index
        else:
            state.text += text
        view = _redact_local_filesystem_paths(state.text)
        if kind == "reasoning":
            view = _truncate(view, REASONING_TEXT_MAX_BYTES)
        patch = state.encoder.encode(view)
        if patch is None:
            return None
        return {
            "type": "item_delta", "message_id": self.message_id, "item_id": item_id,
            "kind": kind, **patch,
        }

    def completed(self, item: dict[str, Any]) -> dict[str, Any] | None:
        if self.message_id is None:
            return None
        state = self._open.pop(item["id"], None)
        card = project_item(
            item, turn_id=self.turn_id,
            started_at_ms=state.started_at_ms if state else None, completed=True,
        )
        if card is None and state is None:
            return None
        return self._frame(item["id"], card)

    def finish(self) -> list[dict[str, Any]]:
        if self.message_id is None:
            return []
        frames = []
        for item_id, state in list(self._open.items()):
            item = dict(state.item)
            if item["type"] == "agentMessage":
                item["text"] = state.text
            elif item["type"] == "reasoning":
                item["summary"] = [state.text]
            frame = self.completed(item)
            if frame is not None:
                card = frame["card"]
                if card is not None and card["type"] == "tool_status":
                    card["event"]["raw"].update(status="cancelled", error=None)
                frames.append(frame)
        return frames
