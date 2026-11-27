# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Inspect upstream media for generation guard diagnostics."""

from novelvideo.freezone.canvas_confirmations import node_title

MISSING_INPUT_CODES = frozenset({
    "missing_media", "missing_references", "missing_source_video", "missing_upscale_source",
})
_MEDIA_FIELDS = {
    "imageGenNode": ("imageUrl", "referenceImageUrl"),
    "uploadNode": ("imageUrl", "videoUrl", "audioUrl"),
    "imageEditNode": ("imageUrl",),
    "exportImageNode": ("imageUrl",),
    "storyboardGenNode": ("imageUrl",),
    "videoNode": ("videoUrl",),
    "audioNode": ("audioUrl",),
}


def upstream_ids(canvas: dict, node_id: str) -> dict[str, None]:
    return dict.fromkeys(
        edge["source"] for edge in canvas.get("edges", []) if edge.get("target") == node_id
    )


def empty_generation_inputs(canvas: dict, node_id: str) -> list[dict]:
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    inputs = []
    for source_id in upstream_ids(canvas, node_id):
        node = nodes.get(source_id, {})
        node_type = node.get("type")
        fields = _MEDIA_FIELDS.get(node_type)
        data = node.get("data") or {}
        if fields and not any(data.get(field) for field in fields):
            inputs.append({
                "node_id": source_id,
                "title": node_title(data) or source_id,
                "node_type": node_type,
                "state": "uploading" if data.get("isUploading") is True else "empty",
            })
    return inputs


def generation_guard_error(request: dict, canvas: dict, node_id: str) -> str:
    message = request["message"]
    code = request.get("code")
    if code not in MISSING_INPUT_CODES:
        return message
    error = f"generation_input_missing[{code}]: {message}"
    inputs = empty_generation_inputs(canvas, node_id)
    if inputs:
        details = "; ".join(
            f'"{item["title"]}" ({item["node_type"]} {item["node_id"]}, {item["state"]})'
            for item in inputs
        )
        error += f" Empty inputs: {details}"
    return error
