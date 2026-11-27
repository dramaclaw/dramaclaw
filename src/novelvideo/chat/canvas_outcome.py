"""Receipt-backed outcome for canvas turns.

The host, not the model, decides what a Freezone turn changed. Every canvas
write goes through a DramaClaw MCP tool whose result carries the receipt, so
the turn's recorded tool results are the only evidence (#862). The model's
final reply is plain text for the user; it never restates receipts or modes.
"""

from __future__ import annotations

import json
import re

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
