"""Structured final-response contract for receipt-backed canvas operations."""

from __future__ import annotations

import json
from typing import Any

CANVAS_REPLY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "message": {"type": "string"},
        "mode": {"type": "string", "enum": ["read_only", "mutation", "blocked"]},
        "canvas_receipts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "bridge_key": {"type": ["string", "null"]},
                    "revision": {"type": ["integer", "null"]},
                },
                "required": ["bridge_key", "revision"],
            },
        },
    },
    "required": ["message", "mode", "canvas_receipts"],
}


def receipt_reference(payload: dict[str, Any]) -> tuple[str, int | None]:
    """Identify a browser receipt or a direct saved revision, never tool status."""
    key = str(payload.get("bridge_key") or "").strip()
    revision = payload.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool):
        revision = None
    if payload.get("canvas_apply_status") == "direct_applied":
        return "", revision
    return (key, None) if key else ("", revision)


def _claim_reference(value: Any) -> tuple[str, int | None] | None:
    if not isinstance(value, dict) or set(value) != {"bridge_key", "revision"}:
        return None
    key, revision = value["bridge_key"], value["revision"]
    if isinstance(key, str) and key.strip() and revision is None:
        return key.strip(), None
    if (
        key is None
        and isinstance(revision, int)
        and not isinstance(revision, bool)
        and revision >= 0
    ):
        return "", revision
    return None


def finalize_canvas_reply(
    text: str,
    *,
    attempts: dict[str, str],
    receipts: set[tuple[str, int | None]],
    failure: str = "",
    draft_ready: bool = False,
) -> str:
    """Validate claims against same-turn evidence without interpreting user prose.

    Every attempted write must succeed; one successful operation cannot mask
    another failed operation. Catalog-only and read-only answers need no canvas
    receipt. A prepared workflow remains a pending user approval, not a write.
    """
    states = set(attempts.values())
    if "failed" in states:
        return "画布操作未完成：" + (
            failure or "没有收到所有操作的成功画布写入回执，请重试。"
        )
    if "timeout" in states:
        return "画布操作等待超时：未收到执行回执，请确认画布连接后重试。"
    if "cancelled" in states:
        return "画布操作已取消，未完成全部操作。"
    if states - {"succeeded"}:
        return "画布操作等待确认或执行回执，尚未完成。"
    if draft_ready and not attempts:
        return "工作流草稿已准备完成，等待你确认后创建画布节点；尚未执行生成。"
    try:
        reply = json.loads(text)
    except (TypeError, ValueError):
        return "回复未通过操作结果校验：未返回结构化结果，请重试。"
    if not isinstance(reply, dict):
        return "回复未通过操作结果校验：结果格式无效，请重试。"
    message = reply.get("message")
    mode = reply.get("mode")
    claims = reply.get("canvas_receipts")
    if (
        set(reply) != {"message", "mode", "canvas_receipts"}
        or not isinstance(message, str)
        or not message.strip()
        or not isinstance(mode, str)
        or mode not in {"read_only", "mutation", "blocked"}
        or not isinstance(claims, list)
    ):
        return "回复未通过操作结果校验：结果格式无效，请重试。"
    if mode == "mutation":
        if not attempts or not claims:
            return "画布操作未完成：本轮没有可验证的画布写入回执，请重试。"
        references = set()
        for claim in claims:
            reference = _claim_reference(claim)
            if reference is None or reference not in receipts:
                return "画布操作未完成：成功声明与本轮写入回执不匹配，请重试。"
            references.add(reference)
        if references != receipts:
            return "画布操作未完成：成功声明未覆盖本轮全部写入回执，请重试。"
    elif claims or attempts:
        return "回复未通过操作结果校验：操作声明与工具结果不一致，请重试。"
    return message.strip()
