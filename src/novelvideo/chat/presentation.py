"""Provider-neutral UI-spec presentation mapping.

Pure transforms only: no runtime, session, filesystem or API dependencies.
The application supplies diagnostic logging where malformed specs are skipped.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any


def json_loads_with_trailing_repair(raw: str) -> Any:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("empty ui-spec")
    first_object = text.find("{")
    first_array = text.find("[")
    starts = [index for index in (first_object, first_array) if index >= 0]
    if not starts:
        raise ValueError("ui-spec does not contain JSON")
    start = min(starts)
    text = text[start:].strip()

    candidates = [text]
    stack: list[str] = []
    in_string = False
    escaped = False
    for char in text:
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            stack.append("}")
        elif char == "[":
            stack.append("]")
        elif char in {"}", "]"} and stack and stack[-1] == char:
            stack.pop()
    if 0 < len(stack) <= 4:
        candidates.append(text + "".join(reversed(stack)))

    last_object = text.rfind("}")
    last_array = text.rfind("]")
    end = max(last_object, last_array)
    if end >= 0:
        candidates.append(text[: end + 1])

    errors: list[str] = []
    for candidate in dict.fromkeys(candidates):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as exc:
            errors.append(str(exc))
    raise ValueError("; ".join(errors) or "invalid ui-spec JSON")


def canonicalize_ui_spec(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("ui-spec root must be an object")
    spec = dict(value)
    spec_type = spec.get("type")
    root = spec.get("root")
    elements = spec.get("elements")
    if not isinstance(spec_type, str) or not spec_type.strip():
        raise ValueError("ui-spec.type is required")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("ui-spec.root is required")
    if not isinstance(elements, dict) or not elements:
        raise ValueError("ui-spec.elements is required")
    if root not in elements:
        raise ValueError("ui-spec.root must point to an element")

    canonical_elements: dict[str, Any] = {}
    for key, element in elements.items():
        if not isinstance(key, str) or not key:
            raise ValueError("ui-spec element keys must be strings")
        if not isinstance(element, dict):
            raise ValueError(f"ui-spec element {key} must be an object")
        element_type = element.get("type")
        if not isinstance(element_type, str) or not element_type.strip():
            raise ValueError(f"ui-spec element {key}.type is required")
        props = element.get("props")
        children = element.get("children")
        if props is None:
            props = {}
        if children is None:
            children = []
        if not isinstance(props, dict):
            raise ValueError(f"ui-spec element {key}.props must be an object")
        if not isinstance(children, list) or not all(
            isinstance(child, str) for child in children
        ):
            raise ValueError(f"ui-spec element {key}.children must be a string array")
        normalized_props = dict(props)
        legacy_text = normalized_props.get("children")
        if isinstance(legacy_text, str):
            if (
                element_type in {"Text", "Heading"}
                and "content" not in normalized_props
            ):
                normalized_props["content"] = legacy_text
                normalized_props.pop("children", None)
            elif element_type == "Badge" and "label" not in normalized_props:
                normalized_props["label"] = legacy_text
                normalized_props.pop("children", None)

        if element_type == "Stack" and "direction" not in normalized_props:
            if normalized_props.get("row") is True:
                normalized_props["direction"] = "row"
            elif normalized_props.get("row") is False:
                normalized_props["direction"] = "column"

        canonical_elements[key] = {
            **element,
            "type": element_type,
            "props": normalized_props,
            "children": children,
        }

    reachable: set[str] = set()
    pending = [root]
    while pending:
        key = pending.pop()
        if key in reachable:
            continue
        element = canonical_elements.get(key)
        if element is None:
            raise ValueError(f"ui-spec references missing child {key}")
        reachable.add(key)
        pending.extend(element["children"])

    spec["type"] = spec_type
    spec["root"] = root
    spec["elements"] = canonical_elements
    return spec


def ui_spec_json(spec: dict[str, Any]) -> tuple[str, str]:
    canonical = canonicalize_ui_spec(spec)
    spec_type = (
        canonical.get("type") if isinstance(canonical.get("type"), str) else "ui_spec"
    )
    return spec_type, json.dumps(canonical, ensure_ascii=False, indent=2)


def wrap_ui_spec_json(spec_type: str, json_text: str) -> str:
    return f'<ui-spec type="{spec_type}">\n' f"{json_text}\n" "</ui-spec>"


def wrap_ui_spec_bundle(specs: list[dict[str, Any]]) -> str:
    canonical_specs = [canonicalize_ui_spec(spec) for spec in specs]
    if len(canonical_specs) == 1:
        spec_type = canonical_specs[0].get("type")
        return wrap_ui_spec_json(
            spec_type if isinstance(spec_type, str) and spec_type else "ui_spec",
            json.dumps(canonical_specs[0], ensure_ascii=False, indent=2),
        )
    return wrap_ui_spec_json(
        "media_bundle",
        json.dumps(canonical_specs, ensure_ascii=False, indent=2),
    )


def ui_spec_block(spec: dict[str, Any]) -> str:
    spec_type, json_text = ui_spec_json(spec)
    return wrap_ui_spec_json(spec_type, json_text)


def can_merge_ui_specs(left: dict[str, Any], right: dict[str, Any]) -> bool:
    spec_type = left.get("type")
    if spec_type != right.get("type") or spec_type not in MERGEABLE_MEDIA_SPEC_TYPES:
        return False
    left_elements = left.get("elements")
    right_elements = right.get("elements")
    left_root_id = left.get("root")
    right_root_id = right.get("root")
    if not (
        isinstance(left_elements, dict)
        and isinstance(right_elements, dict)
        and isinstance(left_root_id, str)
        and isinstance(right_root_id, str)
    ):
        return False
    left_root = left_elements.get(left_root_id)
    right_root = right_elements.get(right_root_id)
    if not isinstance(left_root, dict) or not isinstance(right_root, dict):
        return False
    return left_root.get("type") == right_root.get("type") == "Stack"


def merge_ui_specs(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    left = canonicalize_ui_spec(left)
    right = canonicalize_ui_spec(right)
    left_elements = dict(left["elements"])
    right_elements = right["elements"]
    left_root_id = left["root"]
    right_root_id = right["root"]
    left_root = dict(left_elements[left_root_id])
    right_root = right_elements[right_root_id]
    left_children = list(left_root.get("children") or [])
    right_children = list(right_root.get("children") or [])

    def unique_key(key: str) -> str:
        if key not in left_elements:
            return key
        index = 2
        while f"{key}_{index}" in left_elements:
            index += 1
        return f"{key}_{index}"

    key_map: dict[str, str] = {}
    for key, element in right_elements.items():
        if key == right_root_id:
            continue
        next_key = unique_key(key)
        key_map[key] = next_key
        left_elements[next_key] = element

    left_root["children"] = [
        *left_children,
        *[
            key_map.get(child, child)
            for child in right_children
            if isinstance(child, str)
        ],
    ]
    left_elements[left_root_id] = left_root
    return {**left, "elements": left_elements}


def merge_tool_ui_specs_by_type(
    specs: list[dict[str, Any]], *, log_error: Callable[[ValueError, str], None]
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    merge_indexes: dict[str, int] = {}
    for spec in specs:
        spec_type = spec.get("type")
        merge_index = (
            merge_indexes.get(spec_type) if isinstance(spec_type, str) else None
        )
        if merge_index is not None and can_merge_ui_specs(merged[merge_index], spec):
            try:
                merged[merge_index] = merge_ui_specs(merged[merge_index], spec)
                continue
            except ValueError as exc:
                log_error(exc, json.dumps(spec, ensure_ascii=False))
        merged.append(spec)
        if isinstance(spec_type, str) and spec_type in MERGEABLE_MEDIA_SPEC_TYPES:
            merge_indexes.setdefault(spec_type, len(merged) - 1)
    return merged


def split_ui_specs_from_text(
    content: str, *, log_error: Callable[[ValueError, str], None]
) -> tuple[str, list[dict[str, Any]]]:
    text = str(content or "")
    if "<ui-spec" not in text.lower():
        return text, []

    text = UI_SPEC_FENCE_RE.sub(lambda match: match.group(1).strip(), text)
    specs: list[dict[str, Any]] = []

    def replace_block(match: re.Match[str]) -> str:
        body = match.group(1)
        try:
            value = json_loads_with_trailing_repair(body)
            if isinstance(value, list):
                specs.extend(canonicalize_ui_spec(item) for item in value)
            else:
                specs.append(canonicalize_ui_spec(value))
        except ValueError as exc:
            log_error(exc, body)
            return "（json-render 格式校验失败：模型返回的 ui-spec 不是合法 canonical JSON，已阻止展示。请重新生成。）"
        return ""

    display_text = UI_SPEC_BLOCK_RE.sub(replace_block, text)
    display_text = re.sub(r"\n{3,}", "\n\n", display_text).strip()
    return display_text, specs


def dedupe_tool_ui_specs(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        key = json.dumps(spec, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(spec)
    return deduped


MERGEABLE_MEDIA_SPEC_TYPES = {
    "character_showcase",
    "sketch_gallery",
    "keyframe_video",
    "audio_list",
}


UI_SPEC_BLOCK_RE = re.compile(
    r"<ui-spec\b[^>]*>(.*?)</ui-spec>", re.IGNORECASE | re.DOTALL
)


UI_SPEC_FENCE_RE = re.compile(
    r"```(?:json-render|ui-spec|json)?\s*(<ui-spec\b[\s\S]*?</ui-spec>)\s*```",
    re.IGNORECASE,
)
