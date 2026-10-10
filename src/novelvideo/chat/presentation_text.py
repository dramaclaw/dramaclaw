"""Provider-neutral chat text presentation transforms."""

from __future__ import annotations

import re

_USER_TURN_LABEL_RE = re.compile(r"(?im)^\s*(?:user|human|用户|我)\s*[:：]\s*")
_ASSISTANT_TURN_LABEL_RE = re.compile(
    r"(?i)^\s*(?:assistant|ai|助手|助理|模型)\s*[:：]\s*"
)
_LOCAL_FILESYSTEM_PATH_RE = re.compile(
    r"(?<![\w./-])(?:~|/Users/[^\s`'\"<>)]+)(?:/[^\s`'\"<>)]+)+"
)
_HERMES_REPLAY_HISTORY_MESSAGES = 1
_HERMES_REPLAY_HISTORY_MAX_CHARS = 64_000


def _completion_text_or_existing(event_text: object, existing: str) -> str:
    """ACP may finish with metadata like ``stop=end_turn`` after text deltas."""
    final_text = str(event_text or "").strip()
    if not final_text or final_text.startswith("stop="):
        return existing
    if final_text.lower() == "(hermes timed out)" and existing.strip():
        return existing
    if existing.strip() and _is_completion_notice(final_text):
        if final_text in existing:
            return existing
        return f"{existing.rstrip()}\n\n{final_text}"
    return final_text


def _is_completion_notice(text: str) -> bool:
    return text in {
        "当前任务已开始处理。请稍后让我查看当前任务进度，或在任务完成后再继续下一步。",
        "刚才这一步没有成功启动任务。请先根据返回的错误补齐前置条件；如果是配音缺少声线，可以到「虾塘」上传或录制缺失声线后再继续。",
    }


def _merge_stream_text(existing: str, incoming: object) -> str:
    """Support providers that emit either cumulative text or delta chunks."""
    chunk = str(incoming or "")
    if not chunk:
        return existing
    if chunk.startswith(existing):
        return chunk
    return existing + chunk


def _assistant_prefix_candidates(previous_assistant: object) -> list[str]:
    if isinstance(previous_assistant, (list, tuple)):
        items = [
            str(item or "").strip()
            for item in previous_assistant
            if str(item or "").strip()
        ]
        candidates = []
        for index in range(len(items)):
            suffix = items[index:]
            candidates.append("".join(suffix))
            candidates.append("\n".join(suffix))
            candidates.append("\n\n".join(suffix))
        candidates.extend(items)
        return sorted(set(candidates), key=len, reverse=True)
    prefix = str(previous_assistant or "").strip()
    return [prefix] if prefix else []


def _bounded_replay_history(contents: list[str]) -> list[str]:
    """Keep only a small display-dedup window; this history never becomes agent context."""

    bounded = [
        str(content or "") for content in contents[-_HERMES_REPLAY_HISTORY_MESSAGES:]
    ]
    return [
        content[:_HERMES_REPLAY_HISTORY_MAX_CHARS] for content in bounded if content
    ]


def _is_truncated_assistant_replay(content: str, candidates: list[str]) -> bool:
    """Detect a sufficiently long strict prefix of previously emitted assistant text."""
    compact_content = "".join(str(content or "").split())
    if len(compact_content) < 16:
        return False

    compact_candidates = {"".join(candidate.split()) for candidate in candidates}
    if compact_content in compact_candidates:
        return False
    return any(
        candidate.startswith(compact_content) for candidate in compact_candidates
    )


def _strip_replayed_assistant_prefix(
    content: str,
    previous_assistant: object,
    *,
    suppress_partial_replay: bool = False,
    candidates: list[str] | None = None,
) -> str:
    """Hermes ACP can replay prior assistant text at the start of a new turn."""
    text = str(content or "")
    original_text = text
    prefixes = (
        candidates
        if candidates is not None
        else _assistant_prefix_candidates(previous_assistant)
    )
    if _is_truncated_assistant_replay(text, prefixes):
        return ""
    while text and prefixes:
        original = text
        for prefix in prefixes:
            if text.startswith(prefix):
                text = text[len(prefix) :].lstrip()
                break
            compact_prefix = "".join(prefix.split())
            if not compact_prefix:
                continue
            matched = 0
            end_index = 0
            for index, char in enumerate(text):
                if char.isspace():
                    continue
                if matched >= len(compact_prefix) or char != compact_prefix[matched]:
                    break
                matched += 1
                end_index = index + 1
                if matched == len(compact_prefix):
                    text = text[end_index:].lstrip()
                    break
            if text != original:
                break
        if text == original:
            break
    if suppress_partial_replay and not text.strip() and str(content or "").strip():
        return ""
    if not suppress_partial_replay and not text.strip() and original_text.strip():
        return original_text
    return text


def _compact_chat_text(content: object) -> str:
    return "".join(str(content or "").split())


def _strip_leading_assistant_label(content: str) -> str:
    return _ASSISTANT_TURN_LABEL_RE.sub("", str(content or ""), count=1).lstrip()


def _looks_like_labeled_transcript_replay(content: str) -> bool:
    text = str(content or "").lstrip()
    if not text:
        return False
    if _USER_TURN_LABEL_RE.match(text):
        return True
    return bool(
        _USER_TURN_LABEL_RE.search(text) and _ASSISTANT_TURN_LABEL_RE.search(text)
    )


def _strip_replayed_turn_transcript(
    content: str,
    current_prompt: object,
    *,
    suppress_partial_replay: bool = False,
) -> str:
    """Remove a replayed labeled transcript while keeping normal short replies intact."""
    text = str(content or "")
    prompt = str(current_prompt or "").strip()
    if not text or not prompt:
        return text

    compact_prompt = _compact_chat_text(prompt)
    best_end = -1
    for match in _USER_TURN_LABEL_RE.finditer(text):
        start = match.end()
        line_end = text.find("\n", start)
        if line_end < 0:
            line_end = len(text)
        line = text[start:line_end]

        prompt_index = line.rfind(prompt)
        if prompt_index >= 0:
            best_end = max(best_end, start + prompt_index + len(prompt))
            continue

        if len(compact_prompt) >= 4 and compact_prompt in _compact_chat_text(line):
            best_end = max(best_end, line_end)

    if best_end < 0:
        if suppress_partial_replay and _looks_like_labeled_transcript_replay(text):
            return ""
        return text
    remainder = _strip_leading_assistant_label(text[best_end:])
    if suppress_partial_replay and not remainder.strip():
        return ""
    return remainder


def _strip_replayed_chat_response(
    content: str,
    previous_assistant: object,
    current_prompt: object,
    *,
    suppress_partial_replay: bool = False,
    assistant_prefix_candidates: list[str] | None = None,
) -> str:
    text = _strip_replayed_turn_transcript(
        content,
        current_prompt,
        suppress_partial_replay=suppress_partial_replay,
    )
    return _strip_replayed_assistant_prefix(
        text,
        previous_assistant,
        suppress_partial_replay=suppress_partial_replay,
        candidates=assistant_prefix_candidates,
    )


def _redact_local_filesystem_paths(content: str) -> str:
    """Hide local developer paths before text is shown or persisted in chat."""
    text = str(content or "")
    if not text:
        return ""
    return _LOCAL_FILESYSTEM_PATH_RE.sub("[本地路径]", text)


def _strip_media_rendering_leaks(content: str) -> str:
    """Remove internal rendering/tool chatter that models sometimes echo."""
    lines: list[str] = []
    for line in str(content or "").splitlines():
        stripped = line.strip()
        lower = stripped.lower()
        if not stripped:
            lines.append(line)
            continue
        if "<ui-spec" in lower or "ui-spec" in lower or "ui_spec" in lower:
            continue
        if (
            "json-render" in lower
            or "automatically rendered" in lower
            or "backend" in lower
        ):
            continue
        if "dramaclaw_" in lower:
            continue
        if "按规范渲染" in stripped or "UI画廊" in stripped:
            continue
        lines.append(line)
    text = _redact_local_filesystem_paths("\n".join(lines).strip())
    return re.sub(r"\n{3,}", "\n\n", text)
