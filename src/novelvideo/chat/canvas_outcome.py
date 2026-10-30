"""Receipt-backed outcome for canvas turns.

The host, not the model, decides what a Freezone turn changed. Every canvas
write goes through a DramaClaw MCP tool whose result carries the receipt, so
the turn's recorded tool results are the only evidence (#862). The model's
final reply is plain text for the user; it never restates receipts or modes.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

CANVAS_FINAL_RESPONSE_INSTRUCTIONS = (
    "Your final response is plain text or Markdown for the user, not a JSON object: "
    "no message, mode, or canvas_receipts fields, and no receipt identifiers. DramaClaw "
    "records every canvas write from its own tool results and reports the real outcome "
    "itself. Describe only what this turn's tool results show. Never say that a node, "
    "edge, parameter, story, outline, stage confirmation, or run was created, changed, "
    "saved, or started unless a write tool returned a successful receipt in this turn; "
    "when nothing was written, say so. A creation receipt proves apply/submission, not "
    "generated-media completion or parameter persistence. A prepared workflow draft is "
    "pending user approval, not a canvas change. Saving a story outline and confirming "
    "story stages are canvas writes even when no visible nodes are created. For an "
    "interactive-story or interactive-ad proposal with no write tools called, write the "
    "complete natural-language outline directly in your answer."
)

_LEGACY_ENVELOPE_KEYS = {"message", "mode", "canvas_receipts"}

_UNVERIFIED_WRITE_REQUEST = "画布操作未完成：本轮没有可验证的画布写入回执，请重试。"
_UNVERIFIED_WRITE_REQUEST_WITH_REPLY = (
    "画布操作未完成：本轮没有可验证的画布写入回执。"
    "以下是助手的说明，其中的完成表述不代表实际操作结果：\n\n"
)


def receipt_reference(payload: dict[str, Any]) -> tuple[str, int | None]:
    """Identify a browser receipt or a direct saved revision, never tool status."""
    key = str(payload.get("bridge_key") or "").strip()
    revision = payload.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool):
        revision = None
    if payload.get("canvas_apply_status") == "direct_applied":
        return "", revision
    return (key, None) if key else ("", revision)


def unwrap_legacy_canvas_envelope(text: str) -> str:
    """Return the user-facing message of a pre-#862 JSON envelope, else the text.

    Threads opened before the plain-text contract carry envelope-shaped
    assistant history, and a model may keep imitating it for a while. Only a
    complete object whose keys are exactly the legacy envelope keys, or a
    truncated object that still starts with a complete ``message`` string, is
    unwrapped; any other JSON is the model's actual answer.
    """
    candidate = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", candidate, re.I | re.S)
    if fenced is not None:
        candidate = fenced.group(1).strip()
    if not candidate.startswith("{"):
        return text
    try:
        reply = json.loads(candidate)
    except ValueError:
        reply = None
    if isinstance(reply, dict):
        if set(reply) == _LEGACY_ENVELOPE_KEYS and isinstance(reply["message"], str):
            return reply["message"]
        return text
    match = re.match(r'\{\s*"message"\s*:\s*', candidate)
    if match is None:
        return text
    try:
        message, _ = json.JSONDecoder().raw_decode(candidate, match.end())
    except ValueError:
        return text
    return message if isinstance(message, str) else text


def finalize_canvas_reply(
    text: str,
    *,
    attempts: dict[str, str],
    receipts: set[tuple[str, int | None]],
    failure: str = "",
    draft_ready: bool = False,
    write_requested: bool = False,
) -> str:
    """Report the turn's outcome from recorded write attempts and receipts.

    Every attempted write must succeed; one successful operation cannot mask
    another failed operation. Catalog-only and read-only answers need no canvas
    receipt unless the caller identified an explicit write request. A prepared
    workflow remains a pending user approval, not a write. The model's prose is
    never scanned for success claims: when a requested write produced no
    attempt, the host states that first and keeps the reply only as unverified
    explanation.
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

    message = unwrap_legacy_canvas_envelope(text).strip()
    if write_requested and not attempts:
        if not message:
            return _UNVERIFIED_WRITE_REQUEST
        return _UNVERIFIED_WRITE_REQUEST_WITH_REPLY + message
    if attempts and receipts and not message:
        # Writes verifiably succeeded but the model sent nothing to show for
        # them. Report host evidence; a bridge receipt proves admission, not
        # completion of background generation.
        logger.warning(
            "canvas reply missing after verified writes: reporting status writes=%d receipts=%d",
            len(attempts),
            len(receipts),
        )
        parts = []
        if any(not key for key, _ in receipts):
            parts.append("本轮画布修改已保存。")
        if any(key for key, _ in receipts):
            parts.append("本轮画布执行请求已受理，生成进度请以画布任务状态为准。")
        return "".join(parts) + "请查看画布结果，无需重复提交已成功的操作。"
    return message
