"""Stable text-edge rules shared by plan validation and command compilation."""

from typing import Any

IO_ROLES = {
    "planning_text",
    "context_text",
    "input_text",
    "image_output",
    "audio_output",
    "video_output",
}
DEFAULT_OUTPUT_ROLES = {
    "scriptNode": "planning_text",
    "beatContextNode": "context_text",
    "imageGenNode": "image_output",
    "videoNode": "video_output",
    "audioNode": "audio_output",
    "videoComposeNode": "video_output",
}
ACCEPTED_INPUT_ROLES = {
    "textAnnotationNode": {"planning_text", "context_text"},
    "scriptNode": {"planning_text", "context_text", "input_text"},
    "imageGenNode": {"input_text", "context_text"},
    "videoNode": {"input_text", "context_text", "image_output"},
    "audioNode": {"input_text", "context_text"},
    "htmlArtifactNode": {
        "input_text",
        "context_text",
        "image_output",
        "video_output",
        "audio_output",
    },
    "videoComposeNode": {"video_output", "audio_output"},
}


def text_edge_error(
    link_type: str, source_type: str, source_data: Any, target_type: str
) -> str | None:
    """Infer only an untyped plain text node; never overwrite an explicit role."""
    expected = {
        "context_for": {"planning_text", "context_text"},
        "prompt_for": {"input_text"},
    }.get(link_type)
    if expected is None:
        return None
    data = source_data if isinstance(source_data, dict) else {}
    role = None
    for key in ("semanticOutputRole", "ioRole"):
        value = data.get(key)
        if isinstance(value, str) and value in IO_ROLES:
            role = value
            break
    role = role or DEFAULT_OUTPUT_ROLES.get(source_type)
    accepted = ACCEPTED_INPUT_ROLES.get(target_type, set())
    if role is None and source_type == "textAnnotationNode":
        role = "input_text" if link_type == "prompt_for" else "context_text"
    if link_type == "prompt_for" and source_type not in {
        "textAnnotationNode",
        "beatContextNode",
    }:
        return f"prompt_for is incompatible with source {source_type}"
    if role not in expected or role not in accepted:
        return (
            f"{link_type} rejects source role {role or 'none'} for {target_type}; "
            f"expected {', '.join(sorted(expected & accepted)) or 'no compatible role'}. "
            "Keep explicit text roles unchanged; use a separate input_text node "
            "when planning content needs an actual generation prompt."
        )
    return None
