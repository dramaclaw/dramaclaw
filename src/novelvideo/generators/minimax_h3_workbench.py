"""MiniMax H3 local-workbench adapter.

The canvas keeps its product-level modes while this adapter translates them to
the workbench's stable t2v/i2v/r2v contract.  Keeping the translation here is
important: the browser should never need to know a LAN endpoint, and no
reference may disappear silently while changing transports.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlparse

import aiohttp

from novelvideo.generators.video_generator import (
    ShotReference,
    VideoGeneratorBase,
    VideoGenResult,
    VideoGenStatus,
)
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut


class MiniMaxH3WorkbenchError(RuntimeError):
    """Stable local-workbench failure that does not expose endpoint details."""


_H3_RATIO_OPTIONS = {"auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"}
_H3_RESOLUTION_OPTIONS = {"768p", "2k"}
_H3_QUALITY_VALUES = {"high": 1, "balanced": 2, "fast": 3}
_H3_REFERENCE_MODEL_FILES = {
    "ref2va": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "fl2va": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "dual_pass": "minimax_h3_hybrid_fl2va_ref2va_b25-49-int8_r.safetensors",
}


@dataclass(frozen=True)
class MiniMaxH3SubmissionParameters:
    """One validated source of truth for both H3 transport payloads."""

    width: int
    height: int
    duration: float
    quality_mode: str
    inference_steps: int
    model_mode: str
    seed: int

    def stable_api_dict(self) -> dict[str, Any]:
        return {
            "width": self.width,
            "height": self.height,
            "duration": self.duration,
            "quality_mode": self.quality_mode,
            "inference_steps": self.inference_steps,
            "model_mode": self.model_mode,
            "seed": self.seed,
            "loras": [],
        }


def _multiple_of_32(value: float) -> int:
    return max(256, min(2048, int(round(value / 32.0)) * 32))


def minimax_h3_dimensions(
    aspect_ratio: str,
    resolution: str,
    *,
    input_size: tuple[int, int] | None = None,
) -> tuple[int, int]:
    """Return valid workbench dimensions with the selected edge policy."""

    ratio_text = str(aspect_ratio or "").strip().lower()
    if ratio_text not in _H3_RATIO_OPTIONS:
        raise MiniMaxH3WorkbenchError("Unsupported H3 aspect ratio")
    resolution_text = str(resolution or "").strip().lower()
    if resolution_text not in _H3_RESOLUTION_OPTIONS:
        raise MiniMaxH3WorkbenchError("Unsupported H3 resolution")
    if ratio_text == "auto":
        if input_size and input_size[0] > 0 and input_size[1] > 0:
            ratio = input_size[0] / input_size[1]
        else:
            ratio = 16 / 9
    else:
        left, right = ratio_text.split(":", 1)
        ratio = float(left) / float(right)

    is_2k = resolution_text == "2k"
    if is_2k:
        if ratio >= 1:
            return 2048, _multiple_of_32(2048 / ratio)
        return _multiple_of_32(2048 * ratio), 2048
    if ratio >= 1:
        return _multiple_of_32(768 * ratio), 768
    return 768, _multiple_of_32(768 / ratio)


def _integer_parameter(
    model_params: dict[str, Any],
    key: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    value = model_params[key] if key in model_params else default
    if type(value) is not int or value < minimum or value > maximum:
        raise MiniMaxH3WorkbenchError(f"Invalid H3 parameter: {key}")
    return value


def minimax_h3_submission_parameters(
    *,
    mode: str,
    aspect_ratio: str,
    resolution: str,
    duration: float,
    model_params: dict[str, Any],
    input_size: tuple[int, int] | None = None,
) -> MiniMaxH3SubmissionParameters:
    """Validate UI values once so stable and QuickUI payloads cannot drift."""

    allowed_keys = {"quality_mode", "inference_steps", "seed"}
    if mode == "all_reference":
        allowed_keys.add("model_mode")
    unknown = set(model_params) - allowed_keys
    if unknown:
        joined = ", ".join(sorted(unknown))
        raise MiniMaxH3WorkbenchError(f"Unsupported H3 parameters: {joined}")

    if (
        isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or not math.isfinite(float(duration))
        or float(duration) < 5
        or float(duration) > 15
    ):
        raise MiniMaxH3WorkbenchError("Invalid H3 duration")

    quality_mode = model_params.get("quality_mode", "fast")
    if quality_mode not in _H3_QUALITY_VALUES:
        raise MiniMaxH3WorkbenchError("Invalid H3 parameter: quality_mode")
    inference_steps = _integer_parameter(
        model_params,
        "inference_steps",
        4,
        1,
        50,
    )
    seed = _integer_parameter(
        model_params,
        "seed",
        -1,
        -1,
        2_147_483_647,
    )

    if mode == "text_to_video":
        model_mode = "high_quality"
    elif mode == "first_last_frame":
        model_mode = "fl2va"
    elif mode == "image_reference":
        model_mode = "ref2va"
    elif mode == "all_reference":
        requested_model_mode = model_params.get("model_mode", "ref2va")
        if requested_model_mode not in _H3_REFERENCE_MODEL_FILES:
            raise MiniMaxH3WorkbenchError("Invalid H3 parameter: model_mode")
        model_mode = str(requested_model_mode)
    else:
        raise MiniMaxH3WorkbenchError("Unsupported H3 generation mode")

    width, height = minimax_h3_dimensions(
        aspect_ratio,
        resolution,
        input_size=input_size,
    )
    return MiniMaxH3SubmissionParameters(
        width=width,
        height=height,
        duration=float(duration),
        quality_mode=str(quality_mode),
        inference_steps=inference_steps,
        model_mode=model_mode,
        seed=seed,
    )


def _image_size(path: str | None) -> tuple[int, int] | None:
    if not path:
        return None
    try:
        from PIL import Image

        with Image.open(path) as image:
            return image.size
    except (OSError, ValueError):
        return None


def _response_id(payload: dict[str, Any], *keys: str) -> str:
    candidates: list[object] = [payload.get(key) for key in keys]
    data = payload.get("data")
    if isinstance(data, dict):
        candidates.extend(data.get(key) for key in keys)
    for value in candidates:
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    return ""


def _output_location(payload: object) -> str:
    # The workbench returns both a browser-download URL and an internal
    # ComfyUI-relative path for the same file.  A set made this choice depend on
    # Python's per-process hash order, so one worker downloaded ``/view`` while
    # another tried ``video/...`` and got a 404.  Keep public URLs ahead of the
    # internal path deterministically.
    preferred = (
        "download_url",
        "downloadUrl",
        "video_url",
        "videoUrl",
        "url",
        "path",
    )
    if isinstance(payload, dict):
        for key in preferred:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for key in ("outputs", "files", "data", "result"):
            value = payload.get(key)
            found = _output_location(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _output_location(value)
            if found:
                return found
    return ""


class MiniMaxH3WorkbenchVideoGenerator(VideoGeneratorBase):
    """Generate H3 video through the workbench's supported HTTP contracts.

    T2V uses the stable v1 job API.  The current workbench release advertises
    v1 asset IDs for I2V/R2V but drops them before workflow submission.  Those
    modes therefore use the same slot upload and batch endpoints as its own web
    client.  The compatibility seam stays here so it can be removed when v1
    reference materialization is fixed without changing canvas behavior.
    """

    def __init__(
        self,
        *,
        base_url: str,
        resolution: str | None = None,
        model_params: dict[str, Any] | None = None,
        request_schema: dict[str, Any] | None = None,
        generate_audio: bool | None = None,
        **_: Any,
    ) -> None:
        parsed = urlparse(str(base_url or "").strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("MINIMAX_H3_WORKBENCH_URL must be an HTTP(S) URL")
        self.base_url = str(base_url).rstrip("/") + "/"
        self.resolution = str(resolution or "768p")
        self.model_params = dict(model_params or {})
        self.request_schema = dict(request_schema or {})
        self.generate_audio = bool(generate_audio)

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        timeout = aiohttp.ClientTimeout(total=120)
        url = urljoin(self.base_url, path.lstrip("/"))
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.request(
                method,
                url,
                json=json_body,
                headers=headers,
            ) as response:
                text = await response.text()
                if response.status < 200 or response.status >= 300:
                    raise MiniMaxH3WorkbenchError(
                        f"H3 workbench request failed ({response.status})"
                    )
                if not text.strip():
                    return {}
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise MiniMaxH3WorkbenchError(
                        "H3 workbench returned invalid JSON"
                    ) from exc
                if not isinstance(payload, dict):
                    raise MiniMaxH3WorkbenchError(
                        "H3 workbench returned an invalid response"
                    )
                return payload

    async def _upload_asset(self, path: str, asset_type: str) -> str:
        source = Path(path)
        if not source.is_file():
            raise MiniMaxH3WorkbenchError("H3 reference asset is unavailable")
        timeout = aiohttp.ClientTimeout(total=300)
        url = urljoin(
            self.base_url,
            f"api/v1/assets?asset_type={asset_type}",
        )
        form = aiohttp.FormData()
        with source.open("rb") as handle:
            form.add_field(
                "file",
                handle,
                filename=source.name,
                content_type="application/octet-stream",
            )
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, data=form) as response:
                    text = await response.text()
                    if response.status < 200 or response.status >= 300:
                        raise MiniMaxH3WorkbenchError(
                            f"H3 asset upload failed ({response.status})"
                        )
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise MiniMaxH3WorkbenchError(
                "H3 asset upload returned invalid JSON"
            ) from exc
        asset_id = _response_id(payload, "asset_id", "id")
        if not asset_id:
            raise MiniMaxH3WorkbenchError("H3 asset upload returned no asset id")
        return asset_id

    async def _upload_ui_asset(self, path: str, slot: str) -> str:
        source = Path(path)
        if not source.is_file():
            raise MiniMaxH3WorkbenchError("H3 reference asset is unavailable")
        timeout = aiohttp.ClientTimeout(total=300)
        url = urljoin(
            self.base_url,
            f"quickui-studio/api/upload/{slot}",
        )
        form = aiohttp.FormData()
        with source.open("rb") as handle:
            form.add_field(
                "file",
                handle,
                filename=source.name,
                content_type="application/octet-stream",
            )
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, data=form) as response:
                    text = await response.text()
                    if response.status < 200 or response.status >= 300:
                        raise MiniMaxH3WorkbenchError(
                            f"H3 reference upload failed ({response.status})"
                        )
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise MiniMaxH3WorkbenchError(
                "H3 reference upload returned invalid JSON"
            ) from exc
        filename = _response_id(payload, "name", "asset_id", "id")
        if not filename:
            raise MiniMaxH3WorkbenchError(
                "H3 reference upload returned no filename"
            )
        return filename

    async def _download_video(self, location: str, output_path: str) -> None:
        parsed = urlparse(location)
        url = location if parsed.scheme in {"http", "https"} else urljoin(
            self.base_url,
            location.lstrip("/"),
        )
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        timeout = aiohttp.ClientTimeout(total=1800)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                if response.status < 200 or response.status >= 300:
                    raise MiniMaxH3WorkbenchError(
                        f"H3 output download failed ({response.status})"
                    )
                with target.open("wb") as handle:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        handle.write(chunk)

    @staticmethod
    def _normalized_mode(gen_mode: object) -> str:
        value = str(gen_mode or "text_to_video").strip()
        return {
            "textToVideo": "text_to_video",
            "imageToVideo": "image_reference",
            "imageReference": "image_reference",
            "firstLastFrame": "first_last_frame",
            "allReference": "all_reference",
        }.get(value, value)

    @staticmethod
    def _validate_references(
        mode: str,
        references: list[ShotReference],
    ) -> tuple[str, dict[str, list[ShotReference]]]:
        grouped = {"image": [], "video": [], "audio": []}
        for reference in references:
            ref_type = str(reference.type or "").strip().lower()
            if ref_type not in grouped:
                raise MiniMaxH3WorkbenchError(
                    "H3 only accepts image, video, or audio references"
                )
            if not str(reference.path or "").strip():
                raise MiniMaxH3WorkbenchError("H3 reference asset is unavailable")
            grouped[ref_type].append(reference)

        counts = {key: len(value) for key, value in grouped.items()}
        if mode == "text_to_video":
            if sum(counts.values()) != 0:
                raise MiniMaxH3WorkbenchError(
                    "H3 text-to-video cannot consume reference assets"
                )
            return "t2v", grouped
        if mode == "image_reference":
            if counts != {"image": 1, "video": 0, "audio": 0}:
                raise MiniMaxH3WorkbenchError(
                    "H3 image-to-video requires exactly one image"
                )
            return "r2v", grouped
        if mode == "first_last_frame":
            if counts != {"image": 2, "video": 0, "audio": 0}:
                raise MiniMaxH3WorkbenchError(
                    "H3 first/last-frame mode requires exactly two images"
                )
            return "i2v", grouped
        if mode == "all_reference":
            if sum(counts.values()) == 0:
                raise MiniMaxH3WorkbenchError(
                    "H3 all-reference mode requires at least one asset"
                )
            if counts["image"] > 9 or counts["video"] > 3 or counts["audio"] > 3:
                raise MiniMaxH3WorkbenchError("H3 reference asset limit exceeded")
            return "r2v", grouped
        raise MiniMaxH3WorkbenchError("Unsupported H3 generation mode")

    @staticmethod
    def _quickui_task_id(task: object) -> str:
        if not isinstance(task, dict):
            return ""
        for key in ("job_id", "jobId", "prompt_id", "promptId", "id"):
            value = task.get(key)
            if isinstance(value, (str, int)) and str(value).strip():
                return str(value).strip()
        return ""

    @staticmethod
    def _quickui_outputs(payload: object) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            return []
        outputs = payload.get("outputs")
        return [item for item in outputs or [] if isinstance(item, dict)]

    async def _generate_reference_job(
        self,
        *,
        transport: str,
        references: list[ShotReference],
        grouped: dict[str, list[ShotReference]],
        prompt: str,
        output_path: str,
        width: int,
        height: int,
        duration: float,
        quality_mode: str,
        inference_steps: int,
        model_mode: str,
        seed: int,
        poll_interval: float,
        max_polls: int,
        on_progress: Callable[[float], None] | None,
    ) -> VideoGenResult:
        baseline = await self._request_json(
            "GET", "/quickui-studio/api/bootstrap"
        )
        prior_output_ids = {
            str(item.get("id") or "") for item in self._quickui_outputs(baseline)
        }

        uploaded: dict[str, list[str]] = {
            "image": [],
            "video": [],
            "audio": [],
        }
        type_indexes = {"image": 0, "video": 0, "audio": 0}
        upload_total = sum(len(items) for items in grouped.values())
        upload_index = 0
        for reference in references:
            ref_type = str(reference.type or "").strip().lower()
            if ref_type not in uploaded:
                continue
            type_indexes[ref_type] += 1
            if transport == "i2v":
                slot = "first-frame" if type_indexes[ref_type] == 1 else "last-frame"
            else:
                slot = f"{ref_type}-{type_indexes[ref_type]}"
            uploaded[ref_type].append(
                await self._upload_ui_asset(str(reference.path), slot)
            )
            upload_index += 1
            if on_progress and upload_total:
                on_progress(min(0.2, 0.2 * upload_index / upload_total))

        quality_value = _H3_QUALITY_VALUES[quality_mode]
        quickui_model_mode = "fl2va" if transport == "i2v" else model_mode
        main_model = _H3_REFERENCE_MODEL_FILES[quickui_model_mode]

        job: dict[str, Any] = {
            "width": width,
            "height": height,
            "duration": duration,
            "modelMode": quickui_model_mode,
            "mainModel": main_model,
            "qualityMode": quality_value,
            "inferenceSteps": inference_steps,
            "seed": seed,
            "upscaleEnabled": False,
            "upscaleMode": "tiny-long",
            "upscaleScale": 2,
            "frameInterpolationEnabled": False,
            "frameInterpolationMultiplier": 2,
            "refImageSize": "match",
            "loras": [],
            "mode": transport,
            "prompt": prompt,
            "firstFrame": uploaded["image"][0] if transport == "i2v" else None,
            "lastFrame": uploaded["image"][1] if transport == "i2v" else None,
            "referenceImages": (
                (uploaded["image"] if transport == "r2v" else []) + [None] * 9
            )[:9],
            "referenceVideos": (
                (uploaded["video"] if transport == "r2v" else []) + [None] * 3
            )[:3],
            "referenceAudios": (
                (uploaded["audio"] if transport == "r2v" else []) + [None] * 3
            )[:3],
        }
        if quickui_model_mode == "dual_pass":
            job["dualPass"] = {
                "scaleBy": 1.2,
                "shiftVideo": 12,
                "shiftAudio": 3,
                "coarseSteps": inference_steps,
                "refineSteps": 3,
            }

        submitted = await self._request_json(
            "POST",
            "/quickui-studio/api/generate/batch",
            json_body={"jobs": [job], "copies": 1},
        )
        items = submitted.get("items")
        first_item = items[0] if isinstance(items, list) and items else {}
        job_id = self._quickui_task_id(first_item)
        if submitted.get("ok") is not True or not job_id:
            raise MiniMaxH3WorkbenchError(
                "H3 workbench did not accept the reference job"
            )

        for poll_index in range(max(1, max_polls)):
            status_payload = await self._request_json(
                "GET", "/quickui-studio/api/status"
            )
            queue = status_payload.get("queue")
            tasks = queue.get("tasks") if isinstance(queue, dict) else None
            current = next(
                (
                    task
                    for task in tasks or []
                    if self._quickui_task_id(task) == job_id
                ),
                None,
            )
            if isinstance(current, dict):
                state = str(current.get("state") or current.get("status") or "").lower()
                raw_progress = current.get("progress")
                if on_progress and isinstance(raw_progress, (int, float)):
                    value = float(raw_progress)
                    on_progress(
                        max(0.2, min(0.95, value / 100 if value > 1 else value))
                    )
                if state in {"failed", "error", "cancelled", "interrupted"}:
                    raise MiniMaxH3WorkbenchError(f"H3 workbench job {state}")
                location = _output_location(current) if state == "completed" else ""
                if location:
                    await self._download_video(location, output_path)
                    if on_progress:
                        on_progress(1.0)
                    return VideoGenResult(
                        status=VideoGenStatus.DONE,
                        video_path=output_path,
                        task_id=job_id,
                        provider_task_id=job_id,
                        duration_seconds=duration,
                    )

            if current is None:
                refreshed = await self._request_json(
                    "GET", "/quickui-studio/api/bootstrap"
                )
                new_outputs = [
                    item
                    for item in self._quickui_outputs(refreshed)
                    if str(item.get("id") or "") not in prior_output_ids
                    and str(item.get("mode") or "").lower() == transport
                ]
                if new_outputs:
                    location = _output_location(new_outputs[0])
                    if location:
                        await self._download_video(location, output_path)
                        if on_progress:
                            on_progress(1.0)
                        return VideoGenResult(
                            status=VideoGenStatus.DONE,
                            video_path=output_path,
                            task_id=job_id,
                            provider_task_id=job_id,
                            duration_seconds=duration,
                        )
            if poll_index + 1 < max_polls:
                await asyncio.sleep(max(0.05, float(poll_interval)))
        raise MiniMaxH3WorkbenchError("H3 workbench job timed out")

    async def generate(
        self,
        image_path: str | None,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "16:9",
        duration: float = 5.0,
        poll_interval: float = 2.0,
        max_polls: int = 900,
        on_log: Callable[[str], None] | None = None,
        on_progress: Callable[[float], None] | None = None,
        last_frame_path: str | None = None,
        **kwargs: Any,
    ) -> VideoGenResult:
        del last_frame_path

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        try:
            clean_prompt = str(prompt or "").strip()
            if not clean_prompt:
                raise MiniMaxH3WorkbenchError("MiniMax H3 requires a prompt")
            if len(clean_prompt) > 7000:
                raise MiniMaxH3WorkbenchError(
                    "MiniMax H3 prompt exceeds 7000 characters"
                )
            if self.generate_audio:
                raise MiniMaxH3WorkbenchError(
                    "MiniMax H3 does not expose an audio-generation toggle"
                )
            mode = self._normalized_mode(kwargs.get("gen_mode"))
            references = list(kwargs.get("references") or [])
            transport, grouped = self._validate_references(mode, references)

            size_source = image_path or (
                str(grouped["image"][0].path) if grouped["image"] else None
            )
            parameters = minimax_h3_submission_parameters(
                mode=mode,
                aspect_ratio=aspect_ratio,
                resolution=self.resolution,
                duration=duration,
                model_params=self.model_params,
                input_size=_image_size(size_source),
            )
            if transport != "t2v":
                log("Submitting MiniMax H3 reference job")
                return await self._generate_reference_job(
                    transport=transport,
                    references=references,
                    grouped=grouped,
                    prompt=clean_prompt,
                    output_path=output_path,
                    width=parameters.width,
                    height=parameters.height,
                    duration=parameters.duration,
                    quality_mode=parameters.quality_mode,
                    inference_steps=parameters.inference_steps,
                    model_mode=parameters.model_mode,
                    seed=parameters.seed,
                    poll_interval=poll_interval,
                    max_polls=max_polls,
                    on_progress=on_progress,
                )

            inputs: dict[str, Any] = {"prompt": clean_prompt}
            payload = {
                "feature": "minimax-h3",
                "mode": transport,
                "inputs": inputs,
                "parameters": parameters.stable_api_dict(),
            }
            fingerprint = hashlib.sha256(
                json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()
            log("Submitting MiniMax H3 workbench job")
            submitted = await self._request_json(
                "POST",
                "/api/v1/jobs",
                json_body=payload,
                headers={"Idempotency-Key": fingerprint},
            )
            job_id = _response_id(submitted, "job_id", "id")
            if not job_id:
                raise MiniMaxH3WorkbenchError("H3 workbench returned no job id")

            for poll_index in range(max(1, max_polls)):
                job = await self._request_json("GET", f"/api/v1/jobs/{job_id}")
                data = job.get("data") if isinstance(job.get("data"), dict) else job
                status = str(data.get("status") or "").strip().lower()
                raw_progress = data.get("progress")
                if on_progress and isinstance(raw_progress, (int, float)):
                    value = float(raw_progress)
                    on_progress(max(0.2, min(0.95, value / 100 if value > 1 else value)))
                if status == "completed":
                    outputs = await self._request_json(
                        "GET", f"/api/v1/jobs/{job_id}/outputs"
                    )
                    location = _output_location(outputs)
                    if not location:
                        raise MiniMaxH3WorkbenchError(
                            "H3 workbench returned no video output"
                        )
                    await self._download_video(location, output_path)
                    if on_progress:
                        on_progress(1.0)
                    return VideoGenResult(
                        status=VideoGenStatus.DONE,
                        video_path=output_path,
                        task_id=job_id,
                        provider_task_id=job_id,
                        duration_seconds=parameters.duration,
                    )
                if status in {"failed", "cancelled"}:
                    raise MiniMaxH3WorkbenchError(
                        f"H3 workbench job {status}"
                    )
                if poll_index + 1 < max_polls:
                    await asyncio.sleep(max(0.05, float(poll_interval)))
            raise MiniMaxH3WorkbenchError("H3 workbench job timed out")
        except (TaskCancelled, TaskTimedOut):
            raise
        except MiniMaxH3WorkbenchError as exc:
            log(str(exc))
            return VideoGenResult(status=VideoGenStatus.FAILED, error=str(exc))
        except Exception:
            log("MiniMax H3 workbench request failed")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error="MiniMax H3 workbench request failed",
            )
