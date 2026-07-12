"""Sonilo video-to-music 整集配乐客户端。

成片合成完成后，把整集视频交给 Sonilo 的 ``/v1/video-to-music`` 接口，
生成一条长度与成片匹配的整集配乐（AAC，.m4a 容器）。

接口返回 NDJSON 事件流：``audio_chunk``（base64 音频分片，按 stream_index
聚合）、``title``、``complete``（成功终态）、``error``（失败终态）；
``stage_start`` 等进度事件与无法解析的行一律忽略。
"""

from __future__ import annotations

import base64
import binascii
import json
import mimetypes
from pathlib import Path
from typing import Iterable

import httpx

SONILO_VIDEO_TO_MUSIC_PATH = "/v1/video-to-music"

# 接口拒绝超过 6 分钟的视频；调用方应先本地校验，避免白传一次成片。
SONILO_MAX_VIDEO_DURATION_SECONDS = 360


class SoniloSoundtrackError(RuntimeError):
    """整集配乐生成失败。"""


def _error_detail(body: str) -> str:
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return body
    if isinstance(parsed, dict):
        detail = parsed.get("detail") or parsed.get("error") or parsed.get("message")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
    return body


def _http_error_message(status_code: int, body: str) -> str:
    detail = _error_detail(body)
    if status_code == 401:
        return "Sonilo API key 无效，请检查 SONILO_API_KEY"
    if status_code == 402:
        return detail or "Sonilo 账户额度不足"
    if status_code == 413:
        return f"上传文件过大: {detail}"
    if status_code == 429:
        return f"触发 Sonilo 限流: {detail}"
    return f"Sonilo API 错误 ({status_code}): {detail}"


class SoniloSoundtrackClient:
    """极简 video-to-music 客户端，只覆盖整集配乐这一条调用路径。"""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_seconds: float | None = None,
    ):
        from novelvideo.config import (
            SONILO_API_BASE_URL,
            SONILO_API_KEY,
            SONILO_TIMEOUT_SECONDS,
        )

        self.api_key = str(api_key if api_key is not None else SONILO_API_KEY).strip()
        self.base_url = str(base_url or SONILO_API_BASE_URL).rstrip("/")
        self.timeout_seconds = float(timeout_seconds or SONILO_TIMEOUT_SECONDS)

    def generate_soundtrack(
        self,
        video_path: Path,
        output_path: Path,
        *,
        prompt: str = "",
    ) -> Path:
        """上传成片并把生成的整集配乐写入 ``output_path``（.m4a）。"""
        if not self.api_key:
            raise SoniloSoundtrackError("未配置 SONILO_API_KEY")
        if not video_path.exists():
            raise SoniloSoundtrackError(f"成片不存在: {video_path}")

        data = {"prompt": prompt.strip()} if prompt.strip() else None
        mime, _ = mimetypes.guess_type(video_path.name)
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            with open(video_path, "rb") as fh:
                files = {"video": (video_path.name, fh, mime or "video/mp4")}
                # 生成接口非幂等（会计费），失败不重试。
                with httpx.Client(timeout=self.timeout_seconds) as client:
                    with client.stream(
                        "POST",
                        f"{self.base_url}{SONILO_VIDEO_TO_MUSIC_PATH}",
                        headers=headers,
                        data=data,
                        files=files,
                    ) as response:
                        if response.status_code >= 400:
                            body = response.read().decode("utf-8", errors="replace")
                            raise SoniloSoundtrackError(
                                _http_error_message(response.status_code, body)
                            )
                        audio = self._consume_ndjson(response.iter_lines())
        except httpx.TimeoutException as exc:
            raise SoniloSoundtrackError(
                f"配乐生成超时（{self.timeout_seconds:.0f}s）"
            ) from exc
        except httpx.RequestError as exc:
            raise SoniloSoundtrackError(f"请求 Sonilo 失败: {exc}") from exc

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(audio)
        return output_path

    @staticmethod
    def _consume_ndjson(lines: Iterable[str]) -> bytes:
        """消费 NDJSON 事件流，按 stream_index 聚合音频分片，返回第一条音轨。"""
        streams: dict[int, bytearray] = {}
        completed = False
        for line in lines:
            if not line or not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            event_type = event.get("type")
            if event_type == "audio_chunk":
                data = event.get("data")
                if not isinstance(data, str):
                    continue
                try:
                    index = int(event.get("stream_index", 0))
                except (TypeError, ValueError):
                    continue
                if index < 0:
                    continue
                try:
                    decoded = base64.b64decode(data, validate=True)
                except (binascii.Error, ValueError):
                    continue
                streams.setdefault(index, bytearray()).extend(decoded)
            elif event_type == "complete":
                completed = True
            elif event_type == "error":
                message = event.get("message") or event.get("code") or "stream error"
                raise SoniloSoundtrackError(f"配乐生成失败: {message}")
            # title / stage_start / stage_complete 等事件忽略。

        if not completed:
            raise SoniloSoundtrackError("配乐流意外中断（未收到 complete 事件）")
        if not streams:
            raise SoniloSoundtrackError("配乐流完成但未返回音频数据")
        first_index = sorted(streams)[0]
        return bytes(streams[first_index])
