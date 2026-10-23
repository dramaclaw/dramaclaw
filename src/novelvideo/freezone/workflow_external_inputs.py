"""Resolve declared Workflow inputs against an authenticated canvas snapshot."""

from __future__ import annotations

from typing import Any

from novelvideo.freezone.canvas_media_scope import scan_foreign_media_refs

_IMAGE_NODE_TYPES = {"uploadNode", "imageGenNode", "imageNode", "exportImageNode"}


def _node_media_kind(node_type: Any, data: dict[str, Any]) -> str | None:
    """Media a downstream reference reads from this node (frontend extractUpstreamContent)."""
    if data.get("media_kind") == "audio":
        return None
    has_video = isinstance(data.get("videoUrl"), str) and bool(data["videoUrl"].strip())
    if node_type == "videoNode" or (node_type == "uploadNode" and has_video):
        return "video"
    if node_type in _IMAGE_NODE_TYPES and not has_video and data.get("media_kind") != "video":
        return "image"
    return None


def resolve_external_inputs(
    plan: dict[str, Any],
    canvas: dict[str, Any] | None,
    *,
    project_id: str,
    canvas_id: str | None = None,
    expected: dict[str, dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    declarations = plan.get("external_inputs") or []
    if not declarations:
        return {}
    if (
        not isinstance(canvas, dict)
        or str(canvas.get("project_id") or "") != project_id
    ):
        raise ValueError(
            "workflow external input canvas is unavailable in this project"
        )
    if canvas_id is not None and str(canvas.get("canvas_id") or "") != canvas_id:
        raise ValueError("workflow external input belongs to another canvas")
    revision = canvas.get("revision")
    if type(revision) is not int or revision < 1:
        raise ValueError("workflow external input canvas revision is invalid")
    nodes = {
        str(node.get("id")): node
        for node in canvas.get("nodes") or []
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    resolved: dict[str, dict[str, Any]] = {}
    for source in declarations:
        alias, node_id = source["id"], source["node_id"]
        media_kind = source.get("media_kind")
        node = nodes.get(node_id)
        if node is None:
            raise ValueError(f"workflow external {media_kind} node is unavailable: {node_id}")
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        actual_kind = _node_media_kind(node.get("type"), data)
        if actual_kind is None:
            raise ValueError(f"workflow external node has no image or video: {node_id}")
        if actual_kind != media_kind:
            raise ValueError(
                f"workflow external node {node_id} holds a {actual_kind}, "
                f"declare it with media_kind \"{actual_kind}\""
            )
        if media_kind == "video":
            media_url = data.get("videoUrl")
        else:
            media_url = data.get("imageUrl") or data.get("previewImageUrl")
            if not media_url and node.get("type") == "imageGenNode":
                media_url = data.get("referenceImageUrl")
            if not media_url and node.get("type") == "uploadNode":
                media_url = data.get("source_url")
        if (
            not isinstance(media_url, str)
            or not media_url.strip()
            or data.get("assetMigration")
        ):
            raise ValueError(
                f"workflow external {media_kind} has no persistent media: {node_id}"
            )
        if scan_foreign_media_refs({"nodes": [node]}, project_id=project_id):
            raise ValueError(
                f"workflow external {media_kind} belongs to another project: {node_id}"
            )
        resolved[alias] = {
            "node_id": node_id,
            "media_url": media_url,
            "canvas_revision": revision,
            "display_name": str(
                data.get("displayName") or data.get("title") or node_id
            ),
        }
    if expected is not None and resolved != expected:
        raise ValueError(
            "workflow external input or canvas changed; prepare a new draft"
        )
    return resolved
