"""Fixture-derived Codex history client shared by history tests."""

import copy
import json
from pathlib import Path

TURNS = "thread/turns/list"
ITEMS = "thread/items/list"


def _recorded_templates():
    path = Path(__file__).parent / "fixtures/codex-0.162/05-history-reads.jsonl"
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def reply(method, **params):
        request = next(
            r for r in records
            if r["dir"] == "send" and r["msg"].get("method") == method
            and all(r["msg"]["params"].get(key) == value for key, value in params.items())
        )
        return next(
            r["msg"]["result"] for r in records
            if r["seq"] > request["seq"] and r["conn"] == request["conn"]
            and r["dir"] == "recv" and r["msg"].get("id") == request["msg"]["id"]
            and "result" in r["msg"]
        )

    return (
        reply(TURNS, itemsView="notLoaded")["data"][0],
        reply(ITEMS, turnId="01a1c513-66de-7730-9509-ffca305e55c0")["data"],
    )


class HistoryClient:
    """Generate item texts on demand; cursors anchor absolute oldest-based positions."""

    def __init__(self, count, *, text_size=None, item_repeats=1, in_progress=False):
        self.count = count
        self.text_size = text_size
        self.item_repeats = item_repeats
        self.in_progress = in_progress
        self.requests = []
        self.failures = {}
        self.turn_template, self.item_templates = _recorded_templates()

    def fail(self, method, error, times):
        self.failures[method] = [error, times]

    def request(self, method, params, *, response_model):
        self.requests.append((method, dict(params)))
        failure = self.failures.get(method)
        if failure and failure[1]:
            failure[1] -= 1
            raise failure[0]
        if method == TURNS:
            newest = (
                int(params["cursor"].removeprefix("older-than:"))
                if "cursor" in params else self.count
            )
            oldest = max(0, newest - params["limit"])
            data = []
            for index in range(newest, oldest, -1):
                turn = copy.deepcopy(self.turn_template)
                turn.update(
                    id=f"turn-{index:04d}", rootTurnId=f"turn-{index:04d}",
                    startedAt=1794307745 + index, completedAt=1794307748 + index,
                )
                if self.in_progress and index == self.count:
                    turn.update(status="inProgress", completedAt=None)
                data.append(turn)
            cursor = f"older-than:{oldest}" if oldest else None
        else:
            assert method == ITEMS
            index = int(params["turnId"].removeprefix("turn-"))
            offset = int(params.get("cursor", "items-after:0").removeprefix("items-after:"))
            total = 3 * self.item_repeats
            end = min(total, offset + params["limit"])
            data = []
            for position in range(offset, end):
                record = copy.deepcopy(self.item_templates[position % 3])
                record.update(
                    turnId=params["turnId"], startedAtMs=1794307745000 + index * 10 + position,
                    completedAtMs=1794307745001 + index * 10 + position,
                )
                item = record["item"]
                item["id"] = f"item-{index:04d}-{position:04d}"
                if item["type"] == "userMessage":
                    item["clientId"] = f"business-{index:04d}"
                elif item["type"] == "agentMessage":
                    item["text"] = (
                        "x" * self.text_size if self.text_size is not None else f"reply-{index:04d}"
                    )
                data.append(record)
            cursor = f"items-after:{end}" if end < total else None
        return response_model.model_validate({"data": data, "nextCursor": cursor})


