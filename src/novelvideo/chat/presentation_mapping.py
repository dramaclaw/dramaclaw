"""Pure chat UI mapping and tool-result presentation transforms."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable
from typing import Any

from novelvideo.chat import presentation, presentation_text
from novelvideo.chat.tool_policy import (
    HIDDEN_TOOL_MARKERS as _HIDDEN_TOOL_MARKERS,  # noqa: F401 - compatibility export
    is_hidden_chat_tool_event,
)


def _normalize_single_ui_spec_block(
    body: str, *, log_error: Callable[[ValueError, str], None]
) -> str:
    nested_start = body.lower().rfind("<ui-spec")
    if nested_start >= 0:
        close_index = body.lower().find("</ui-spec>", nested_start)
        if close_index >= 0:
            nested_block = body[nested_start : close_index + len("</ui-spec>")]
            return _normalize_json_render_reply(nested_block, log_error=log_error)

    try:
        value = presentation.json_loads_with_trailing_repair(body)
        if isinstance(value, list):
            specs = [presentation.canonicalize_ui_spec(item) for item in value]
            return presentation.wrap_ui_spec_bundle(specs)
        spec = presentation.canonicalize_ui_spec(value)
    except ValueError as exc:
        log_error(exc, body)
        return "（json-render 格式校验失败：模型返回的 ui-spec 不是合法 canonical JSON，已阻止展示。请重新生成。）"

    spec_type = spec.get("type") if isinstance(spec.get("type"), str) else "ui_spec"
    json_text = json.dumps(spec, ensure_ascii=False, indent=2)
    return f'<ui-spec type="{spec_type}">\n{json_text}\n</ui-spec>'


def _normalize_json_render_reply(
    content: str, *, log_error: Callable[[ValueError, str], None]
) -> str:
    text = str(content or "")
    text = _wrap_embedded_ui_spec_json(text)
    if "<ui-spec" not in text.lower():
        return text
    text = presentation.UI_SPEC_FENCE_RE.sub(lambda match: match.group(1).strip(), text)
    return presentation.UI_SPEC_BLOCK_RE.sub(
        lambda match: _normalize_single_ui_spec_block(
            match.group(1), log_error=log_error
        ),
        text,
    )


def _wrap_embedded_ui_spec_json(content: str) -> str:
    text = str(content or "")
    if "<ui-spec" in text.lower():
        return text
    if '"elements"' not in text or '"root"' not in text:
        return text

    decoder = json.JSONDecoder()
    index = 0
    parts: list[str] = []
    changed = False
    while index < len(text):
        start = text.find("{", index)
        if start < 0:
            parts.append(text[index:])
            break
        parts.append(text[index:start])
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            parts.append(text[start : start + 1])
            index = start + 1
            continue
        if isinstance(value, dict):
            try:
                spec = presentation.canonicalize_ui_spec(value)
            except ValueError:
                spec = None
            if spec is not None:
                parts.append(presentation.ui_spec_block(spec))
                index = start + end
                changed = True
                continue
        parts.append(text[start : start + end])
        index = start + end

    if not changed:
        return text
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _strip_embedded_ui_spec_json_text(content: str) -> str:
    """Remove model-written media JSON from prose before appending tool specs."""
    text = str(content or "")
    pattern = re.compile(
        r'\{\s*"type"\s*:\s*"(?:character_showcase|sketch_gallery|keyframe_video|audio_list|media_bundle)"'
    )
    index = 0
    parts: list[str] = []
    decoder = json.JSONDecoder()
    changed = False

    while True:
        match = pattern.search(text, index)
        if not match:
            parts.append(text[index:])
            break
        start = match.start()
        parts.append(text[index:start])
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            next_paragraph = text.find("\n\n", start)
            index = len(text) if next_paragraph < 0 else next_paragraph
            changed = True
            continue
        if isinstance(value, dict):
            try:
                presentation.canonicalize_ui_spec(value)
                index = start + end
                changed = True
                continue
            except ValueError:
                pass
        parts.append(text[start : start + end])
        index = start + end

    if not changed:
        return text.strip()
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _extract_tool_ui_specs(
    value: Any, *, log_error: Callable[[ValueError, str], None]
) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []

    def append_spec(node: Any) -> None:
        try:
            specs.append(presentation.canonicalize_ui_spec(node))
        except ValueError as exc:
            log_error(exc, json.dumps(node, ensure_ascii=False, default=str))

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            ui_spec = node.get("ui_spec")
            if isinstance(ui_spec, dict):
                append_spec(ui_spec)
            elif {"type", "root", "elements"}.issubset(node):
                append_spec(node)
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, str):
            text = node.strip()
            if not text or len(text) > 1_000_000:
                return
            if "<ui-spec" in text.casefold():
                _, embedded_specs = presentation.split_ui_specs_from_text(
                    text, log_error=log_error
                )
                specs.extend(embedded_specs)
                return
            if "ui_spec" not in text and not {"type", "root", "elements"}.issubset(
                set(re.findall(r'"([^"]+)"\s*:', text))
            ):
                return
            try:
                decoded = json.loads(text)
            except json.JSONDecodeError:
                return
            visit(decoded)

    visit(value)
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        key = json.dumps(spec, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(spec)
    return deduped


def _extract_tool_chat_error(value: Any, *, redact: Callable[[str], str]) -> str | None:
    def normalize_error_text(text: object) -> str:
        raw = redact(str(text or "")).strip()
        raw = re.sub(r"\s+", " ", raw)
        raw = re.sub(
            r"provider_response_id[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+",
            "provider_response_id=[redacted]",
            raw,
            flags=re.IGNORECASE,
        )
        raw = re.sub(
            r"response_id[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+",
            "response_id=[redacted]",
            raw,
            flags=re.IGNORECASE,
        )
        if len(raw) > 1200:
            raw = raw[:1200].rstrip() + "..."
        return raw

    def business_chat_error_from_text(text: object) -> str | None:
        raw = normalize_error_text(text)
        if not raw:
            return None
        if "Render 模式需要草图" in raw or "未生成可用图片" in raw:
            return (
                "Render 任务没有生成可用图片：当前缺少必要草图前置。"
                "请先在「虾塘」生成或确认对应 Beat 的草图后，再重新生成 Render。"
                f"\n\n错误原因：{raw[:1200]}"
            )
        return None

    def generic_chat_error_from_text(text: object) -> str | None:
        raw = normalize_error_text(text)
        if not raw:
            return None
        lowered = raw.casefold()
        if "provider_response_id" in lowered and "content_filter" in lowered:
            return None
        return f"任务执行失败：{raw}"

    def parse_jsonish(text: str) -> Any | None:
        raw = str(text or "").strip()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
        try:
            return presentation.json_loads_with_trailing_repair(raw)
        except ValueError:
            return None

    def visit(node: Any) -> str | None:
        if isinstance(node, str):
            decoded = parse_jsonish(node)
            if decoded is not None:
                return visit(decoded)
            return None
        if isinstance(node, list):
            for child in node:
                found = visit(child)
                if found:
                    return found
            return None
        if not isinstance(node, dict):
            return None

        chat_error = node.get("chat_error")
        if isinstance(chat_error, str) and chat_error.strip():
            return chat_error.strip()

        for key in ("error", "detail", "message"):
            mapped = business_chat_error_from_text(node.get(key))
            if mapped:
                return mapped

        status = str(node.get("status") or "").strip().lower()
        failed_status = status in {"failed", "error", "cancelled", "canceled"}
        ok_false = node.get("ok") is False
        if failed_status or ok_false:
            for key in ("error", "detail", "message"):
                generic = generic_chat_error_from_text(node.get(key))
                if generic:
                    return generic
            if failed_status:
                return f"任务执行失败：当前状态为 {status}。"
            return "任务执行失败：接口返回 ok=false，但没有提供具体错误原因。"

        for key in ("result", "message", "content", "data", "output"):
            found = visit(node.get(key))
            if found:
                return found
        for child in node.values():
            found = visit(child)
            if found:
                return found
        return None

    return visit(value)


def _decode_tool_jsonish(text: str) -> Any | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    try:
        return presentation.json_loads_with_trailing_repair(raw)
    except ValueError:
        return None


def _contains_freezone_canvas_bridge_result(value: Any) -> bool:
    """Return true when a Hermes tool update contains a Freezone bridge result."""
    if isinstance(value, str):
        decoded = _decode_tool_jsonish(value)
        if decoded is None:
            return False
        return _contains_freezone_canvas_bridge_result(decoded)
    if isinstance(value, list):
        return any(_contains_freezone_canvas_bridge_result(item) for item in value)
    if not isinstance(value, dict):
        return False

    has_bridge_status = "tool_call_status" in value or "canvas_apply_status" in value
    has_bridge_body = (
        "command_results" in value
        or "applied_count" in value
        or "opened_ui_actions" in value
        or "created_node_ids" in value
        or "user_message" in value
        or "agent_instruction" in value
    )
    if has_bridge_status and has_bridge_body:
        return True

    return any(
        _contains_freezone_canvas_bridge_result(child) for child in value.values()
    )


def _suppress_freezone_tool_lifecycle_error(value: Any, *, tool_mode: str) -> bool:
    """Ignore Hermes lifecycle-only failures for Freezone canvas bridge tools.

    Freezone canvas commands are resolved by the frontend bridge result.  A
    bare Hermes ``tool_call_update.status=failed`` can be transient lifecycle
    noise and must not be surfaced as the canvas command result.
    """
    if tool_mode != "freezone_canvas" or not isinstance(value, dict):
        return False
    if value.get("sessionUpdate") != "tool_call_update":
        return False
    status = str(value.get("status") or "").strip().lower()
    if status not in {"failed", "error", "cancelled", "canceled"}:
        return False
    business_payload_keys = {
        "chat_error",
        "error",
        "detail",
        "message",
        "result",
        "content",
        "data",
        "output",
    }
    if not any(key in value for key in business_payload_keys):
        return True
    return _contains_freezone_canvas_bridge_result(value)


def _strip_freezone_tool_lifecycle_failure_text(text: str, *, tool_mode: str) -> str:
    if tool_mode != "freezone_canvas":
        return text
    return re.sub(
        r"\A\s*任务执行失败：当前状态为\s+(?:failed|error|cancelled|canceled)。\s*",
        "",
        text,
        flags=re.IGNORECASE,
    ).lstrip()


def _visible_tool_chat_error_for_mode(
    text: str | None, *, tool_mode: str
) -> str | None:
    if not text:
        return None
    visible = _strip_freezone_tool_lifecycle_failure_text(text, tool_mode=tool_mode)
    return visible or None


def _append_tool_ui_specs(
    content: str,
    specs: list[dict[str, Any]],
    *,
    log_error: Callable[[ValueError, str], None],
) -> str:
    raw_text = str(content or "").strip()
    if specs and presentation.UI_SPEC_BLOCK_RE.search(raw_text):
        return raw_text
    text = presentation_text._strip_media_rendering_leaks(raw_text)
    if not specs:
        return text
    text = _strip_embedded_ui_spec_json_text(text)
    specs = presentation.merge_tool_ui_specs_by_type(specs, log_error=log_error)
    blocks: list[str] = []
    for spec in specs:
        try:
            blocks.append(presentation.ui_spec_block(spec))
        except ValueError as exc:
            log_error(exc, json.dumps(spec, ensure_ascii=False))
    if not blocks:
        return text
    prefix = text or "已为你展示相关媒体。"
    return f"{prefix}\n\n" + "\n\n".join(blocks)


def _prompt_wants_sketch_only(prompt: str) -> bool:
    text = str(prompt or "")
    if "草图" not in text and "sketch" not in text.casefold():
        return False
    frame_terms = (
        "首帧",
        "第一帧",
        "关键帧",
        "first frame",
        "first-frame",
        "keyframe",
        "frame",
    )
    return not any(term in text.casefold() for term in frame_terms)


def _is_frame_image_element(element: Any) -> bool:
    if not isinstance(element, dict):
        return False
    props = element.get("props")
    if not isinstance(props, dict):
        return False
    fields = [
        props.get("src"),
        props.get("poster"),
        props.get("title"),
        props.get("alt"),
        props.get("description"),
        props.get("overlayTitle"),
        props.get("overlayDescription"),
    ]
    text = "\n".join(str(value or "") for value in fields).casefold()
    return (
        "首帧" in text
        or "/frames/" in text
        or "first frame" in text
        or "first-frame" in text
    )


def _filter_tool_ui_specs_for_prompt(
    prompt: str, specs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not specs:
        return specs

    if _prompt_continues_video_generation_without_display(prompt):
        specs = [spec for spec in specs if not _is_beat_video_ui_spec(spec)]

    if not specs or not _prompt_wants_sketch_only(prompt):
        return specs

    filtered_specs: list[dict[str, Any]] = []
    for spec in specs:
        if not isinstance(spec, dict) or spec.get("type") != "sketch_gallery":
            filtered_specs.append(spec)
            continue
        elements = spec.get("elements")
        root_key = spec.get("root")
        if not isinstance(elements, dict) or not isinstance(root_key, str):
            filtered_specs.append(spec)
            continue
        root = elements.get(root_key)
        if not isinstance(root, dict):
            filtered_specs.append(spec)
            continue
        children = root.get("children")
        if not isinstance(children, list):
            filtered_specs.append(spec)
            continue

        kept_children: list[str] = []
        kept_elements: dict[str, Any] = {}
        for key, element in elements.items():
            if key == root_key:
                continue
            if key in children and _is_frame_image_element(element):
                continue
            kept_elements[key] = element
            if key in children:
                kept_children.append(key)

        if not kept_children:
            continue
        new_root = copy.deepcopy(root)
        new_root["children"] = kept_children
        filtered_specs.append(
            {
                **spec,
                "elements": {
                    root_key: new_root,
                    **{key: kept_elements[key] for key in kept_elements},
                },
            }
        )
    return filtered_specs


def _prompt_continues_video_generation_without_display(prompt: str) -> bool:
    text = str(prompt or "").strip()
    lower = text.casefold()
    continue_terms = ("继续", "恢复", "接着", "下一步", "继续跑", "继续做")
    video_terms = ("视频", "beat", "镜头", "成片", "生成")
    display_terms = (
        "展示",
        "显示",
        "查看",
        "看看",
        "看一下",
        "播放",
        "预览",
        "给我看",
        "show",
        "display",
        "view",
        "preview",
        "play",
    )
    return (
        any(term in lower for term in continue_terms)
        and any(term in lower for term in video_terms)
        and not any(term in lower for term in display_terms)
    )


def _is_beat_video_ui_spec(spec: dict[str, Any]) -> bool:
    if not isinstance(spec, dict) or spec.get("type") != "keyframe_video":
        return False
    elements = spec.get("elements")
    if not isinstance(elements, dict):
        return False
    for element in elements.values():
        if not isinstance(element, dict) or element.get("type") != "Video":
            continue
        props = element.get("props")
        if not isinstance(props, dict):
            continue
        title = str(props.get("title") or "")
        src = str(props.get("src") or "")
        if re.search(r"\bbeat\s*\d+\b", title, re.IGNORECASE) or "/beats/" in src:
            return True
    return False



def _is_hidden_chat_tool_event(name: object, text: object) -> bool:
    """Compatibility entrypoint; the policy lives in ``chat.tool_policy``."""
    return is_hidden_chat_tool_event(name, text)
