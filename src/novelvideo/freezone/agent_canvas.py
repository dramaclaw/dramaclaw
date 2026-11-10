# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Compute Agent canvas reads and changes outside the store's write mutex."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import logging
from pathlib import Path
import time
import uuid

from novelvideo.api.schemas import CanvasPayload
from novelvideo.freezone import canvas_store
from novelvideo.freezone.agent_canvas_metrics import count
from novelvideo.freezone.canvas_core_pool import CanvasCoreError, get_canvas_core_pool
from novelvideo.freezone.canvas_inline_media import inline_media_fields
from novelvideo.freezone.canvas_media_scope import CanvasMediaScopeError

logger = logging.getLogger(__name__)


class CanvasInlineMediaError(RuntimeError):
    code = "canvas_inline_media"

    def __init__(self, fields: list[dict[str, str]]):
        super().__init__("Canvas media must use file addresses")
        self.fields = fields


def _agent_canvas_body(canvas: dict, output: object) -> CanvasPayload:
    if (
        not isinstance(output, dict)
        or not isinstance(output.get("nodes"), list)
        or not isinstance(output.get("edges"), list)
    ):
        raise CanvasCoreError("canvas_core_protocol", "Invalid canvas core canvas")
    fields = inline_media_fields(output["nodes"])
    if fields:
        raise CanvasInlineMediaError(fields)
    known = {key: value for key, value in canvas.items() if key in CanvasPayload.model_fields}
    known.update(
        nodes=output["nodes"],
        edges=output["edges"],
        base_revision=canvas.get("revision"),
        save_source="agent_patch",
        client_save_id=str(uuid.uuid4()),
    )
    return CanvasPayload(**known)


async def dispatch_agent_canvas(
    *,
    project: str,
    canvas_id: str,
    project_dir: Path,
    envelopes: list[dict],
    env: dict,
    build_payload: Callable[[CanvasPayload], Callable[[dict | None], dict]],
    after_save: Callable[[CanvasPayload, canvas_store.CanvasSaveResult], Awaitable[None]],
) -> dict:
    started = time.monotonic()
    node_seconds = 0.0
    recompute = 0
    revision = None
    outcome = "error"
    commands = ",".join(
        str(command.get("type", ""))
        for envelope in envelopes
        if isinstance(envelope.get("commands"), list)
        for command in envelope["commands"]
        if isinstance(command, dict)
    )
    try:
        for attempt in range(3):
            recompute = attempt
            canvas = await asyncio.to_thread(canvas_store.read_canvas, project_dir, canvas_id)
            if canvas is None:
                raise FileNotFoundError("Canvas not found")
            revision = canvas.get("revision")
            node_started = time.monotonic()
            try:
                result = await asyncio.to_thread(
                    get_canvas_core_pool().call,
                    "apply_commands",
                    {
                        "canvas": {
                            key: canvas[key]
                            for key in ("nodes", "edges", "viewport", "metadata", "revision")
                            if key in canvas
                        },
                        "envelopes": envelopes,
                        "env": env,
                    },
                )
            finally:
                node_seconds += time.monotonic() - node_started
            status = result.get("status")
            if (
                status not in {"applied", "validation_failed", "host_required"}
                or not isinstance(result.get("changes"), dict)
                or not isinstance(result.get("receipt"), dict)
            ):
                raise CanvasCoreError("canvas_core_protocol", "Invalid canvas core result")
            if status == "applied":
                body = _agent_canvas_body(canvas, result.get("canvas"))
                try:
                    saved = await canvas_store.save_canvas_async(
                        project_dir,
                        canvas_id,
                        base_revision=revision,
                        save_source="agent_patch",
                        client_save_id=body.client_save_id,
                        request_hash=canvas_store.canvas_request_hash(
                            body.model_dump(exclude={"client_save_id"}, exclude_none=True)
                        ),
                        build_payload=build_payload(body),
                    )
                except canvas_store.CanvasRevisionConflict:
                    if attempt == 2:
                        raise
                    continue
                revision = saved.payload.get("revision")
                await after_save(body, saved)
            outcome = status
            data = {
                "status": status,
                "revision": revision,
                "changes": result["changes"],
                "receipt": result["receipt"],
                "recompute_count": recompute,
            }
            if status == "host_required":
                data["host_command_types"] = result["host_command_types"]
            return data
        raise AssertionError("unreachable")
    except canvas_store.CanvasRevisionConflict as exc:
        outcome = "conflict"
        revision = exc.current_revision
        raise
    except CanvasMediaScopeError:
        outcome = "canvas_media_scope_mismatch"
        raise
    except CanvasCoreError as exc:
        outcome = "invalid_agent_canvas_request" if exc.code == "invalid_request" else exc.code
        raise
    except Exception as exc:
        detail = getattr(exc, "detail", None)
        outcome = getattr(exc, "code", None) or (
            detail.get("code", "error") if isinstance(detail, dict) else "error"
        )
        raise
    finally:
        count(f"agent_canvas_write.{outcome}")
        logger.info(
            "agent_canvas_write project=%s canvas=%s commands=%s result=%s duration_ms=%d "
            "node_ms=%d recompute=%d revision=%s",
            project,
            canvas_id,
            commands,
            outcome,
            int((time.monotonic() - started) * 1000),
            int(node_seconds * 1000),
            recompute,
            revision,
        )


def _context_need_key(need: object) -> tuple[str, str | None, int | None]:
    if not isinstance(need, dict):
        raise CanvasCoreError("canvas_core_protocol", "Invalid canvas core host need")
    kind = need.get("kind")
    if kind in ("audio_references", "project_assets", "characters"):
        return kind, None, None
    if kind in ("html_artifact", "html_versions"):
        artifact_id = need.get("artifact_id")
        version = need.get("version") if kind == "html_artifact" else None
        if (
            isinstance(artifact_id, str)
            and artifact_id
            and (version is None or (type(version) is int and version >= 1))
        ):
            return kind, artifact_id, version
    raise CanvasCoreError("canvas_core_protocol", "Invalid canvas core host need")


async def _fetch_context_host_data(
    needs: list,
    fetchers: dict[str, Callable[[dict], Awaitable[object]]],
) -> dict:
    unique = {_context_need_key(need): need for need in needs}

    async def fetch(key, need):
        try:
            return await fetchers[key[0]](need)
        except (LookupError, ValueError) as exc:
            return {"error": {"message": str(exc)}}

    values = await asyncio.gather(*(fetch(key, need) for key, need in unique.items()))
    host_data = {}
    for (kind, artifact_id, version), value in zip(unique, values):
        if kind == "html_artifact":
            key = f"{artifact_id}@{version or 'latest'}"
            host_data.setdefault("html_artifacts", {})[key] = value
        elif kind == "html_versions":
            host_data.setdefault("html_versions", {})[artifact_id] = value
        else:
            host_data[kind] = value
    return host_data


async def answer_agent_canvas_context(
    *,
    project: str,
    canvas_id: str,
    canvas: dict,
    envelopes: list[dict],
    env: dict,
    fetchers: dict[str, Callable[[dict], Awaitable[object]]],
) -> object:
    started = time.monotonic()
    node_seconds = 0.0
    passes = 0
    outcome = "error"
    requests = ",".join(
        request["type"]
        for envelope in envelopes
        for request in envelope["requests"]
        if isinstance(request.get("type"), str)
    )
    payload = {"canvas": canvas, "envelopes": envelopes, "env": dict(env)}
    try:
        for _ in range(2):
            passes += 1
            node_started = time.monotonic()
            try:
                response = await asyncio.to_thread(
                    get_canvas_core_pool().call, "answer_context", payload,
                )
            finally:
                node_seconds += time.monotonic() - node_started
            if isinstance(response, dict):
                if response.get("status") == "answered" and "result" in response:
                    outcome = "answered"
                    return response["result"]
                if (
                    response.get("status") == "needs_host_data"
                    and passes == 1
                    and isinstance(response.get("needs"), list)
                ):
                    payload["env"]["hostData"] = await _fetch_context_host_data(
                        response["needs"], fetchers,
                    )
                    continue
            raise CanvasCoreError("canvas_core_protocol", "Invalid canvas core context result")
        raise AssertionError("unreachable")
    except CanvasCoreError as exc:
        outcome = "invalid_agent_canvas_request" if exc.code == "invalid_request" else exc.code
        raise
    finally:
        count(f"agent_canvas_read.{outcome}")
        logger.info(
            "agent_canvas_read project=%s canvas=%s requests=%s result=%s duration_ms=%d "
            "node_ms=%d passes=%d",
            project,
            canvas_id,
            requests,
            outcome,
            int((time.monotonic() - started) * 1000),
            int(node_seconds * 1000),
            passes,
        )
