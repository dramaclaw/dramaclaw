#!/usr/bin/env python3
"""Analyze Hermes per-call token consumption from request_dump files.

Enable tracing first: set ``HERMES_DUMP_REQUESTS=1`` in the backend .env and
restart. Each model call then writes its full (redacted) request payload to
``<worker-home>/logs/request_dump_<session>_<ts>.json``. This script breaks
those payloads down per call — tool schemas vs system prompt vs accumulated
history — and shows what grew between consecutive calls of one session.

Usage:
    python scripts/analyze_hermes_requests.py [workspace] [--session PREFIX] [--calls]

    workspace   worker home dir (default: state/local/.hermes-freezone)
    --session   only sessions whose id starts with PREFIX
    --calls     also print the per-call breakdown (default: session summaries)

Token estimate: CJK chars count as 1 token each, everything else ~3.5 chars
per token. Good enough to rank contributors; not a billing number.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

_CJK = re.compile(r"[　-鿿豈-﫿＀-￯]")


def est_tokens(text: str) -> int:
    cjk = len(_CJK.findall(text))
    return cjk + max(0, round((len(text) - cjk) / 3.5))


def _msg_text(message: dict) -> str:
    parts: list[str] = []
    content = message.get("content")
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
    for call in message.get("tool_calls") or []:
        function = call.get("function") if isinstance(call, dict) else None
        if isinstance(function, dict):
            parts.append(str(function.get("name") or ""))
            parts.append(str(function.get("arguments") or ""))
    return "".join(parts)


def _msg_label(message: dict) -> str:
    role = str(message.get("role") or "?")
    if role == "tool":
        return f"tool:{message.get('name') or message.get('tool_call_id') or '?'}"
    return role


def analyze_dump(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    body = ((data.get("request") or {}).get("body")) or {}
    messages = body.get("messages")
    if not isinstance(messages, list):
        return None
    tools_json = json.dumps(body.get("tools") or [], ensure_ascii=False)
    rows = [
        (_msg_label(message), est_tokens(_msg_text(message)))
        for message in messages
        if isinstance(message, dict)
    ]
    return {
        "path": path,
        "timestamp": str(data.get("timestamp") or ""),
        "session_id": str(data.get("session_id") or "?"),
        "reason": str(data.get("reason") or ""),
        "model": str(body.get("model") or "?"),
        "n_tools": len(body.get("tools") or []),
        "tools_tokens": est_tokens(tools_json),
        "rows": rows,
        "messages_tokens": sum(tokens for _, tokens in rows),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("workspace", nargs="?", default="state/local/.hermes-freezone")
    parser.add_argument("--session", default="")
    parser.add_argument("--calls", action="store_true")
    args = parser.parse_args()

    home = Path(args.workspace)
    dumps = sorted(
        [*home.glob("logs/request_dump_*.json"), *home.glob("sessions/request_dump_*.json")],
        key=lambda p: p.name.rsplit("_", 2)[-2:],
    )
    calls = [c for c in (analyze_dump(p) for p in dumps) if c]
    if args.session:
        calls = [c for c in calls if c["session_id"].startswith(args.session)]
    if not calls:
        print("no request_dump files found — is HERMES_DUMP_REQUESTS=1 set and the backend restarted?")
        return 1

    by_session: dict[str, list[dict]] = defaultdict(list)
    for call in calls:
        by_session[call["session_id"]].append(call)

    for session_id, session_calls in by_session.items():
        total = sum(c["tools_tokens"] + c["messages_tokens"] for c in session_calls)
        print(f"\n=== session {session_id[:8]}  calls={len(session_calls)}  "
              f"est input total≈{total:,} tok ===")
        previous_rows: list[tuple[str, int]] = []
        for index, call in enumerate(session_calls, 1):
            call_total = call["tools_tokens"] + call["messages_tokens"]
            grew = call["rows"][len(previous_rows):]
            grew_note = ", ".join(f"{label}+{tokens}" for label, tokens in grew[:6]) or "-"
            print(f"  #{index:<2} {call['timestamp'][11:19]}  ≈{call_total:>7,} tok  "
                  f"(tools[{call['n_tools']}]≈{call['tools_tokens']:,} + msgs≈{call['messages_tokens']:,})"
                  f"  new: {grew_note}"
                  + (f"  [{call['reason']}]" if call["reason"] not in {"", "preflight"} else ""))
            if args.calls:
                for label, tokens in sorted(call["rows"], key=lambda r: -r[1])[:8]:
                    print(f"        {tokens:>7,}  {label}")
            previous_rows = call["rows"]
    return 0


if __name__ == "__main__":
    sys.exit(main())
