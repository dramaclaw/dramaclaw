"""Translate cloud media protocols at the local gateway boundary."""

from __future__ import annotations

import base64
import time
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from novelvideo.local_model_catalog import ARK_BASE, SF_BASE, LocalModelCatalog, read_key


async def provider_request(catalog: LocalModelCatalog, provider: str, path: str,
                           payload: dict | None = None, *, method: str = "POST") -> dict:
    try:
        key = read_key(catalog.root, provider)
    except ValueError:
        raise HTTPException(400, "provider API key is not configured") from None
    base = ARK_BASE if provider == "ark" else SF_BASE
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=15)) as client:
            response = await client.request(method, f"{base}/{path}",
                headers={"Authorization": f"Bearer {key}"}, json=payload)
    except httpx.HTTPError:
        raise HTTPException(502, "provider connection failed") from None
    if response.status_code >= 400:
        # Never relay arbitrary upstream bodies that may echo credentials or inputs.
        reason = "provider_authentication_failed" if response.status_code in {401, 403} else "provider_request_failed"
        raise HTTPException(response.status_code, reason)
    try:
        result = response.json()
    except ValueError:
        raise HTTPException(502, "provider returned invalid JSON") from None
    if not isinstance(result, dict):
        raise HTTPException(502, "provider returned invalid response")
    return result


async def cloud_image(catalog: LocalModelCatalog, payload: dict,
                      uploads: list[Any] | None = None) -> dict:
    try:
        entry = catalog.resolve(str(payload.get("model") or ""), kind="image")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    provider = entry["provider"]
    image = payload.get("image") or payload.get("images")
    if uploads:
        image = []
        for upload in uploads:
            content = await upload.read(32 * 1024 * 1024 + 1)
            if len(content) > 32 * 1024 * 1024:
                raise HTTPException(400, "reference image exceeds size limit")
            mime = upload.content_type or "image/png"
            if mime not in {"image/png", "image/jpeg", "image/webp"}:
                raise HTTPException(400, "unsupported image format")
            image.append(f"data:{mime};base64," + base64.b64encode(content).decode())
    if image:
        if not entry.get("supportsImageEdit"):
            raise HTTPException(400, "selected model does not support image references")
        image = image if isinstance(image, list) else [image]
        if len(image) > entry.get("referenceImageMax", 1):
            raise HTTPException(400, "too many reference images for this model")
    width, height = int(payload.get("width") or 1024), int(payload.get("height") or 1024)
    request = {"model": entry["upstreamModel"], "prompt": str(payload.get("prompt") or "")}
    if provider == "ark":
        request.update(size=f"{width}x{height}", response_format="url", watermark=False)
        if image:
            request["image"] = image
        result = await provider_request(catalog, provider, "images/generations", request)
        return result
    if "image-edit" not in entry["upstreamModel"].lower():
        request["image_size"] = f"{width}x{height}"
    elif not image:
        raise HTTPException(400, "selected image editing model requires a reference image")
    if image:
        for index, value in enumerate(image):
            request["image" if index == 0 else f"image{index + 1}"] = value
    result = await provider_request(catalog, provider, "images/generations", request)
    return {"created": int(time.time()), "data": result.get("images", result.get("data", []))}


async def cloud_video_submit(catalog: LocalModelCatalog, payload: dict) -> dict:
    try:
        entry = catalog.resolve(str(payload.get("model") or ""), kind="video")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    metadata = payload.get("metadata") or {}
    if metadata.get("reference_videos") or metadata.get("reference_audios"):
        raise HTTPException(400, "this video model does not support video or audio references")
    provider = entry["provider"]
    prompt = str(payload.get("prompt") or "")
    image = metadata.get("image") or metadata.get("first_frame_image") or metadata.get("first_frame") or metadata.get("image_url") or payload.get("image")
    images = metadata.get("reference_images") or []
    if not image and images:
        image = images[0]
    if len(images) > 1 or (metadata.get("last_frame") or metadata.get("last_frame_image")):
        raise HTTPException(400, "this video model accepts at most one first frame")
    if provider == "siliconflow":
        needs_image = "i2v" in entry["upstreamModel"].lower()
        if needs_image != bool(image):
            raise HTTPException(400, "selected video model and first-frame input do not match")
        if str(metadata.get("resolution") or "720p").lower() != "720p":
            raise HTTPException(400, "selected video model supports only 720p")
        ratio = metadata.get("ratio") or "16:9"
        sizes = {"16:9": "1280x720", "9:16": "720x1280", "1:1": "960x960"}
        if ratio not in sizes:
            raise HTTPException(400, "unsupported video aspect ratio")
        if float(payload.get("duration") or payload.get("seconds") or 5) != 5:
            raise HTTPException(400, "selected video model supports only 5 seconds")
        request = {"model": entry["upstreamModel"], "prompt": prompt, "image_size": sizes[ratio]}
        if image:
            request["image"] = image
        result = await provider_request(catalog, provider, "video/submit", request)
        job = result.get("requestId")
    else:
        content: list[dict] = [{"type": "text", "text": prompt}]
        if image:
            content.append({"type": "image_url", "image_url": {"url": image}, "role": "first_frame"})
        result = await provider_request(catalog, provider, "contents/generations/tasks", {
            "model": entry["upstreamModel"], "content": content,
            "duration": int(float(payload.get("duration") or payload.get("seconds") or 5)),
            "ratio": metadata.get("ratio", "16:9"), "resolution": metadata.get("resolution", "720p"),
        })
        job = result.get("id")
    if not isinstance(job, str) or not job:
        raise HTTPException(502, "provider did not return a task ID")
    return {"id": provider + "~" + job, "status": "queued"}


async def cloud_video_status(catalog: LocalModelCatalog, task_id: str) -> dict:
    provider, separator, job = task_id.partition("~")
    if not separator or provider not in {"siliconflow", "ark"} or not job:
        raise HTTPException(400, "invalid provider task ID")
    if provider == "siliconflow":
        result = await provider_request(catalog, provider, "video/status", {"requestId": job})
        status = str(result.get("status", "")).lower()
        videos = (result.get("results") or {}).get("videos") or []
        url = videos[0].get("url", "") if videos else ""
    else:
        result = await provider_request(catalog, provider, "contents/generations/tasks/" + quote(job, safe=""), method="GET")
        status = str(result.get("status", "")).lower()
        url = (result.get("content") or {}).get("video_url", "")
    status = {"succeed": "completed", "succeeded": "completed", "failed": "failed", "inprogress": "processing", "inqueue": "queued"}.get(status, status)
    return {"id": task_id, "status": status, "video_url": url, "url": url,
            **({"error": "provider video generation failed"} if status == "failed" else {})}
