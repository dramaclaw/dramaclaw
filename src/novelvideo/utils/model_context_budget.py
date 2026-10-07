"""Conservative, deployment-configured budgets for text model requests.

Gateway aliases do not advertise a context window. A file character limit
therefore cannot establish that an individual model request will fit. Count
the UTF-8 bytes of the mapped text and schemas as a conservative upper bound
for byte-tokenized text, leaving room for protocol framing and the response.
This deliberately overestimates Chinese text and requires no tokenizer download.
It never truncates the input. Deployments should set a budget no larger than
the verified window of every text model behind their gateway aliases.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class TextContextBudget:
    context_tokens: int
    default_output_tokens: int = 8192
    framing_tokens: int = 1024

    @classmethod
    def from_env(cls) -> TextContextBudget | None:
        raw = os.environ.get("NEWAPI_TEXT_CONTEXT_TOKENS", "").strip()
        if not raw:
            # Preserve the contract of deployments whose gateway is unknown.
            return None
        context = int(raw)
        output = int(os.environ.get("NEWAPI_TEXT_OUTPUT_TOKENS", "8192"))
        if context <= output + 1024 or output <= 0:
            raise ValueError(
                "Invalid NEWAPI_TEXT_CONTEXT_TOKENS / NEWAPI_TEXT_OUTPUT_TOKENS"
            )
        return cls(context_tokens=context, default_output_tokens=output)

    def checked_settings(self, payload: dict[str, Any], settings: dict | None) -> dict:
        checked = dict(settings or {})
        requested_output = checked.get("max_tokens")
        output_tokens = (
            self.default_output_tokens if requested_output is None else requested_output
        )
        if not isinstance(output_tokens, int) or output_tokens <= 0:
            raise ValueError("max_tokens must be a positive integer")
        extra_body = checked.get("extra_body") or {}
        for key in ("max_tokens", "max_completion_tokens"):
            if key in extra_body:
                requested = extra_body[key]
                if not isinstance(requested, int) or requested <= 0:
                    raise ValueError(f"extra_body.{key} must be a positive integer")
                output_tokens = max(output_tokens, requested)
        input_upper_bound = (
            len(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
                    "utf-8"
                )
            )
            + self.framing_tokens
        )
        if input_upper_bound + output_tokens > self.context_tokens:
            raise ValueError(
                "MODEL_CONTEXT_BUDGET_EXCEEDED: "
                f"输入 token 保守上界 {input_upper_bound:,} + 输出预算 {output_tokens:,} "
                f"> 请求上下文预算 {self.context_tokens:,}。"
                "请分批处理，或核实网关模型窗口后调整请求预算；原文未截断。"
            )
        checked["max_tokens"] = output_tokens
        return checked
