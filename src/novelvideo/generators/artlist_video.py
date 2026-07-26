# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Artlist generative video provider (image-to-video) via the Artlist MCP gateway.

DramaClaw connects to Artlist's MCP server as a partner MCP client, uploads the
first frame, calls the ``generate_video`` tool, polls ``get_generation_status``,
and downloads the finished clip.

Server-side (non-interactive) auth — set:
  ARTLIST_MCP_URL               default https://mcp.artlist.io/mcp
  ARTLIST_MCP_TOKEN             partner bearer token for the generative gateway
  ARTLIST_VIDEO_MODEL_GROUP_ID  optional; auto-routes to an i2v-capable model

NOTE: the exact partner/server auth scheme for mcp.artlist.io must be confirmed
with Artlist — the interactive claude.ai connector is not usable from a backend.
This client sends ``Authorization: Bearer <token>``; adjust ``_headers`` if
Artlist's partner auth differs. Tool result field names (generationId, the video
URL location) follow the observed MCP contract; ``_find_video_url`` is defensive
across common shapes.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
from pathlib import Path
from typing import Any, Callable, Optional

import aiohttp

from novelvideo.generators.video_generator import (
    VideoGeneratorBase,
    VideoGenResult,
    VideoGenStatus,
)

DEFAULT_MCP_URL = "https://mcp.artlist.io/mcp"
_DONE_STATES = {"completed", "succeeded", "done", "success"}
_FAILED_STATES = {"failed", "error", "canceled", "cancelled", "nsfw", "rejected"}

# Convenience aliases so a backend string like ``artlist_seedance-2.0`` routes
# to a specific Artlist model group (mirrors the ``newapi_<model>`` pattern).
# Group ids come from Artlist's list_models (image-to-video); use
# ``artlist_<numericGroupId>`` for any model not aliased here, or the bare
# ``artlist`` backend + ARTLIST_VIDEO_MODEL_GROUP_ID for a configured default.
ARTLIST_BACKEND_PREFIX = "artlist_"
ARTLIST_VIDEO_MODEL_GROUPS: dict[str, int] = {
    # ByteDance Seedance
    "seedance-1.0-pro-fast": 309,
    "seedance-1.5": 304,
    "seedance-2.0": 358,
    "seedance-2.0-fast": 405,
    "seedance-2.0-mini": 416,
    # a few other popular families available on the gateway
    "kling-2.1": 105,
    "veo-3.1": 114,
    "sora-2": 110,
    "happyhorse-1.1": 415,
}


def parse_artlist_video_backend(backend: Optional[str]) -> Optional[int]:
    """Map an ``artlist_<model>`` backend string to an Artlist model group id.

    Returns the group id for a known alias, an explicit ``artlist_<number>``,
    or ``None`` when the string is not an ``artlist_`` backend.
    """
    raw = str(backend or "").strip()
    if not raw.lower().startswith(ARTLIST_BACKEND_PREFIX):
        return None
    model = raw[len(ARTLIST_BACKEND_PREFIX):]
    if model.isdigit():
        return int(model)
    return ARTLIST_VIDEO_MODEL_GROUPS.get(model.lower())


class ArtlistVideoGenerator(VideoGeneratorBase):
    """Image-to-video via Artlist's MCP generative gateway."""

    def __init__(
        self,
        mcp_url: Optional[str] = None,
        token: Optional[str] = None,
        model_group_id: Optional[Any] = None,
        **_ignored,
    ):
        self.mcp_url = mcp_url or os.environ.get("ARTLIST_MCP_URL") or DEFAULT_MCP_URL
        self.token = token or os.environ.get("ARTLIST_MCP_TOKEN")
        raw_group = model_group_id or os.environ.get("ARTLIST_VIDEO_MODEL_GROUP_ID")
        self.model_group_id = int(raw_group) if raw_group else None

        if not self.token:
            raise ValueError(
                "ARTLIST_MCP_TOKEN must be set for Artlist video generation"
            )

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    @staticmethod
    def _tool_json(result: Any) -> dict[str, Any]:
        """Extract a JSON payload from an MCP tool result's content blocks."""
        structured = getattr(result, "structuredContent", None)
        if isinstance(structured, dict):
            return structured
        for block in getattr(result, "content", None) or []:
            text = getattr(block, "text", None)
            if not text:
                continue
            try:
                return json.loads(text)
            except (ValueError, TypeError):
                return {"_text": text}
        return {}

    @classmethod
    def _find_video_url(cls, payload: Any) -> Optional[str]:
        """Best-effort search for a video URL across common result shapes."""
        if not isinstance(payload, dict):
            return None
        for key in ("url", "videoUrl", "fileUrl", "downloadUrl", "assetUrl"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("http"):
                return value
        for key in ("video", "output", "result", "asset", "media"):
            nested = payload.get(key)
            found = cls._find_video_url(nested)
            if found:
                return found
        for key in ("outputs", "files", "assets", "results", "media"):
            for item in payload.get(key) or []:
                if isinstance(item, str) and item.startswith("http"):
                    return item
                found = cls._find_video_url(item)
                if found:
                    return found
        return None

    async def _upload_first_frame(self, session: Any, image_path: str, log) -> str:
        """Upload the first frame and return an Artlist assetId."""
        if image_path.startswith(("http://", "https://")):
            res = self._tool_json(
                await session.call_tool("upload_image", {"imageUrl": image_path})
            )
            asset_id = res.get("assetId")
            if not asset_id:
                raise RuntimeError(f"upload_image(imageUrl) returned no assetId: {res}")
            return asset_id

        # Presigned upload for a local file: request URL -> PUT bytes -> confirm.
        mime = mimetypes.guess_type(image_path)[0] or "image/png"
        res = self._tool_json(
            await session.call_tool(
                "upload_image",
                {"mimeType": mime, "fileName": Path(image_path).name},
            )
        )
        upload_url = res.get("uploadUrl")
        upload_id = res.get("uploadId")
        if not (upload_url and upload_id):
            raise RuntimeError(
                f"upload_image(presigned) missing uploadUrl/uploadId: {res}"
            )
        with open(image_path, "rb") as fh:
            body = fh.read()
        async with aiohttp.ClientSession() as http:
            async with http.put(
                upload_url, data=body, headers={"Content-Type": mime}
            ) as put:
                if put.status not in (200, 201, 204):
                    raise RuntimeError(f"presigned PUT failed: HTTP {put.status}")
        confirmed = self._tool_json(
            await session.call_tool("confirm_upload", {"uploadId": upload_id})
        )
        asset_id = confirmed.get("assetId")
        if not asset_id:
            raise RuntimeError(f"confirm_upload returned no assetId: {confirmed}")
        log("First frame uploaded to Artlist")
        return asset_id

    async def _download(self, url: str, output_path: str) -> bool:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        async with aiohttp.ClientSession() as http:
            async with http.get(url) as resp:
                if resp.status != 200:
                    return False
                with open(output_path, "wb") as fh:
                    fh.write(await resp.read())
        return True

    async def generate(
        self,
        image_path: Optional[str],
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 180,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        def log(msg: str) -> None:
            if on_log:
                on_log(msg)

        def progress(value: float) -> None:
            if on_progress:
                on_progress(value)

        if not image_path or not (
            image_path.startswith(("http://", "https://")) or os.path.exists(image_path)
        ):
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"First frame not found: {image_path}",
            )

        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except Exception as exc:  # pragma: no cover - import guard
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"mcp client library unavailable: {exc}",
            )

        try:
            return await self._run(
                image_path=image_path,
                prompt=prompt,
                output_path=output_path,
                aspect_ratio=aspect_ratio,
                duration=duration,
                poll_interval=poll_interval,
                max_polls=max_polls,
                log=log,
                progress=progress,
                streamablehttp_client=streamablehttp_client,
                client_session_cls=ClientSession,
            )
        except Exception as exc:
            return VideoGenResult(
                status=VideoGenStatus.FAILED, error=f"Artlist error: {exc}"
            )

    async def _run(
        self,
        *,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str,
        duration: float,
        poll_interval: float,
        max_polls: int,
        log,
        progress,
        streamablehttp_client,
        client_session_cls,
    ) -> VideoGenResult:
        log("Connecting to Artlist MCP...")
        progress(0.05)
        async with streamablehttp_client(self.mcp_url, headers=self._headers()) as (
            read,
            write,
            _,
        ):
            async with client_session_cls(read, write) as session:
                await session.initialize()

                asset_id = await self._upload_first_frame(session, image_path, log)
                progress(0.2)

                args: dict[str, Any] = {"prompt": prompt, "input": {"assetId": asset_id}}
                if self.model_group_id:
                    args["modelGroupId"] = self.model_group_id
                settings: dict[str, Any] = {}
                if aspect_ratio and ":" in aspect_ratio:
                    settings["aspect_ratio"] = aspect_ratio
                if duration:
                    settings["duration"] = int(duration)
                if settings:
                    args["settings"] = settings

                log("Submitting Artlist video generation...")
                gen = self._tool_json(await session.call_tool("generate_video", args))
                status = str(gen.get("status") or "").lower()
                if status == "confirmation_required":
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=(
                            "Artlist requires cost confirmation for this generation; "
                            "pre-approve high-cost jobs on the account"
                        ),
                    )
                generation_id = gen.get("generationId") or gen.get("id")
                if not generation_id:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"generate_video returned no generationId: {str(gen)[:200]}",
                    )
                progress(0.3)
                log(f"Queued: {generation_id}")

                for poll_count in range(max_polls):
                    st = self._tool_json(
                        await session.call_tool(
                            "get_generation_status", {"generationId": generation_id}
                        )
                    )
                    status = str(st.get("status") or "").lower()
                    progress(0.3 + (poll_count / max_polls) * 0.6)

                    if status in _DONE_STATES:
                        url = self._find_video_url(st)
                        if not url:
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error=f"No video URL in completed result: {str(st)[:200]}",
                                task_id=str(generation_id),
                            )
                        log("Video ready, downloading...")
                        progress(0.95)
                        if not await self._download(url, output_path):
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error="Download failed",
                                task_id=str(generation_id),
                            )
                        progress(1.0)
                        return VideoGenResult(
                            status=VideoGenStatus.DONE,
                            video_url=url,
                            video_path=output_path,
                            task_id=str(generation_id),
                            duration_seconds=float(duration),
                        )

                    if status in _FAILED_STATES:
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"Artlist generation {status}",
                            task_id=str(generation_id),
                        )

                    if poll_count % 6 == 0:
                        log(
                            f"Generating... ({status or 'pending'}, "
                            f"{poll_count}/{max_polls})"
                        )
                    await asyncio.sleep(poll_interval)

                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error="Generation timeout",
                    task_id=str(generation_id),
                )
