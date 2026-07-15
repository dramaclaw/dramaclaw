"""Image-to-Video 视频生成模块。

使用 Image-to-Video API 将首帧图像转换为动态视频。
"""

import asyncio
import json
import math
import os
import random
import re
import subprocess
import tempfile
import urllib.parse
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

import aiohttp
import websockets
from dotenv import load_dotenv

from novelvideo.ports import get_usage_meter
from novelvideo.video_request_usage import (
    record_video_request,
    update_video_request_status,
)
from novelvideo.shared.billing_errors import is_insufficient_credits_error
from novelvideo.storage.media_relay import (
    IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
    upload_image_bytes,
)
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut
from novelvideo.task_backend.subprocesses import run_project_subprocess

# 确保加载 .env 环境变量
load_dotenv()

NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS = 1800.0


def _run_video_subprocess(cmd: list[str], *, timeout: int = 30 * 60) -> subprocess.CompletedProcess:
    return run_project_subprocess(cmd, capture_output=True, text=True, timeout=timeout)


def _video_credit_billing_params(*, resolution: str | None = None) -> dict[str, str]:
    clean_resolution = str(resolution or "").strip().lower()
    return {"resolution": clean_resolution} if clean_resolution else {}


async def _reserve_video_model_call(
    model: str,
    *,
    source: str,
    resolution: str | None = None,
    duration_seconds: int | float | str | None = 1,
) -> str:
    return await get_usage_meter().reserve_current_model_call_credit(
        model=model,
        billing_kind="video",
        billing_params=_video_credit_billing_params(resolution=resolution),
        billing_quantity=duration_seconds,
        metadata={"source": source},
    )


async def _refund_video_model_call(
    reservation_id: str,
    *,
    source: str,
    error: str,
    provider_request_id: str = "",
    provider_task_id: str = "",
) -> None:
    if not reservation_id:
        return
    try:
        metadata: dict[str, object] = {"source": source, "error": error[:200]}
        if provider_request_id:
            metadata["request_id"] = provider_request_id
        if provider_task_id:
            metadata["provider_task_id"] = provider_task_id
        await get_usage_meter().refund_model_call_credit_reservation(
            reservation_id,
            metadata=metadata,
        )
    except Exception:
        pass


async def _confirm_video_model_call(
    *,
    model: str,
    reservation_id: str,
    provider_request_id: str = "",
    provider_task_id: str = "",
) -> None:
    try:
        await get_usage_meter().bump_model_call(
            user_id=None,
            model=model,
            provider_request_id=provider_request_id,
            provider_task_id=provider_task_id,
            credit_reservation_id=reservation_id,
        )
    except Exception:
        pass


class VideoGenStatus(Enum):
    """视频生成状态。"""

    PENDING = "pending"
    PROCESSING = "processing"
    DONE = "done"
    FAILED = "failed"


class VideoBackend(Enum):
    """视频生成后端。"""

    SEEDANCE_FAST = "seedance_fast"  # Seedance 1.0 Pro Fast
    SEEDANCE_PRO = "seedance_pro"  # Seedance 1.5 Pro 有声
    SEEDANCE_PRO_SILENT = "seedance_pro_silent"  # Seedance 1.5 Pro 无声
    SEEDANCE_2 = "seedance_2"  # Seedance 2.0（v2.0 主力）
    COMFYUI = "comfyui"  # Claymore 1.0
    WAN26 = "wan26"  # 阿里云 DashScope Wan2.6-i2v-flash
    LTX23 = "ltx23"  # Lightricks LTX-Video 2.3 22B
    GROK_720 = "grok_720"  # xAI Grok Imagine Video 720p


@dataclass
class VideoGenResult:
    """视频生成结果。"""

    status: VideoGenStatus
    video_url: Optional[str] = None
    video_path: Optional[str] = None
    last_frame_url: Optional[str] = None
    last_frame_path: Optional[str] = None
    task_id: Optional[str] = None
    provider_task_id: Optional[str] = None
    error: Optional[str] = None
    duration_seconds: float = 0.0


class VideoGeneratorBase(ABC):
    """视频生成器基类。

    定义 Image-to-Video 生成的标准接口。
    """

    async def generate(
        self,
        image_path: Optional[str],
        prompt: str,
        output_path: str,
        aspect_ratio: str = "16:9",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 60,
    ) -> VideoGenResult:
        """完整生成流程：提交 + 轮询 + 下载。

        Args:
            image_path: 首帧图像路径
            prompt: 动作描述
            output_path: 输出视频路径
            aspect_ratio: 宽高比
            duration: 目标时长（秒）
            poll_interval: 轮询间隔（秒）
            max_polls: 最大轮询次数

        Returns:
            生成结果
        """
        # 默认实现，子类可覆盖
        raise NotImplementedError("Subclass should implement generate()")


class MockVideoGenerator(VideoGeneratorBase):
    """模拟视频生成器（测试用）。

    使用 FFmpeg 将静态图片转换为带 Ken Burns 效果的视频，
    用于开发阶段验证完整流程。

    示例:
        >>> generator = MockVideoGenerator()
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="character smiling",
        ...     output_path="output.mp4",
        ...     duration=5.0
        ... )
    """

    def __init__(self, width: int = 1920, height: int = 1080, fps: int = 30):
        """初始化模拟生成器。

        Args:
            width: 视频宽度
            height: 视频高度
            fps: 帧率
        """
        self.width = width
        self.height = height
        self.fps = fps

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "16:9",
        duration: float = 5.0,
        **kwargs,
    ) -> VideoGenResult:
        """生成测试视频：首帧图像 + Ken Burns 效果。

        Args:
            image_path: 首帧图像路径
            prompt: 动作描述（叠加到视频上作为调试信息）
            output_path: 输出视频路径
            aspect_ratio: 宽高比
            duration: 视频时长（秒）

        Returns:
            生成结果
        """
        try:
            # 确保输出目录存在
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # 计算帧数
            frames = int(duration * self.fps)

            # 清理 prompt 中的特殊字符（避免 FFmpeg 命令行问题）
            safe_prompt = prompt[:40].replace("'", "").replace('"', "").replace(":", " ")

            # 使用 FFmpeg 生成视频
            # 1. Ken Burns 缩放效果
            # 2. 叠加 prompt 文字（调试用）
            video_filter = (
                f"scale=8000:-1,"
                f"zoompan=z='min(zoom+0.0008,1.15)':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                f"s={self.width}x{self.height}:fps={self.fps},"
                f"drawtext=text='{safe_prompt}':"
                f"fontsize=20:fontcolor=white@0.7:x=20:y=20"
            )

            cmd = [
                "ffmpeg",
                "-y",
                "-loop",
                "1",
                "-i",
                image_path,
                "-vf",
                video_filter,
                "-t",
                str(duration),
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-pix_fmt",
                "yuv420p",
                "-an",  # 无音频
                output_path,
            ]

            result = _run_video_subprocess(cmd)

            if result.returncode != 0:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"FFmpeg error: {result.stderr[:500]}",
                )

            return VideoGenResult(
                status=VideoGenStatus.DONE,
                video_path=output_path,
                duration_seconds=duration,
            )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(e),
            )


class SeedanceVideoGenerator(VideoGeneratorBase):
    """火山方舟 Seedance 视频生成器。

    使用火山方舟 Seedance API 生成动态视频。
    支持 Seedance 1.0 Pro Fast 和 Seedance 1.5 Pro 模型。

    示例:
        >>> generator = SeedanceVideoGenerator(
        ...     model="doubao-seedance-1-5-pro-251215",
        ...     generate_audio=True,
        ... )
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="character smiling and waving",
        ...     output_path="output.mp4"
        ... )
    """

    def __init__(
        self,
        model: str,
        generate_audio: bool = False,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
    ):
        """初始化 Seedance 生成器。

        Args:
            model: 模型 ID（如 doubao-seedance-1-5-pro-251215）
            generate_audio: 是否生成音频（仅 Seedance 1.5 支持）
            api_key: API Key（默认从环境变量读取）
            endpoint: API 端点（默认从环境变量读取）
        """
        self.model = model
        self.generate_audio = generate_audio
        self.api_key = (
            api_key or os.environ.get("VOLCENGINE_VISUAL_API_KEY") or os.environ.get("ARK_API_KEY")
        )
        self.endpoint = endpoint or os.environ.get(
            "VOLCENGINE_VISUAL_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3"
        )

        if not self.api_key:
            raise ValueError("VOLCENGINE_VISUAL_API_KEY or ARK_API_KEY must be set")

    def _local_to_data_url(self, image_path: str) -> str:
        """将本地图片转换为 data URL（base64）。"""
        import base64

        if image_path.lower().endswith(".png"):
            mime_type = "image/png"
        elif image_path.lower().endswith((".jpg", ".jpeg")):
            mime_type = "image/jpeg"
        else:
            mime_type = "image/png"

        with open(image_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        return f"data:{mime_type};base64,{image_data}"

    async def _download_video(self, url: str, output_path: str, max_retries: int = 3) -> bool:
        """下载视频文件，失败自动重试。"""
        import httpx

        for attempt in range(1, max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    resp = await client.get(url)
                    if resp.status_code != 200:
                        print(
                            f"[download] attempt {attempt}/{max_retries} failed: HTTP {resp.status_code}"
                        )
                        if attempt < max_retries:
                            await asyncio.sleep(2 * attempt)
                            continue
                        return False

                    os.makedirs(os.path.dirname(output_path), exist_ok=True)
                    with open(output_path, "wb") as f:
                        f.write(resp.content)

                    return True
            except Exception as e:
                print(f"[download] attempt {attempt}/{max_retries} error: {e}")
                if attempt < max_retries:
                    await asyncio.sleep(2 * attempt)
        return False

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 120,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        """完整生成流程：提交 + 轮询 + 下载。

        Args:
            image_path: 首帧图像路径（本地路径或 URL）
            prompt: 动作描述
            output_path: 输出视频路径
            aspect_ratio: 宽高比（如 "9:16"）
            duration: 目标时长（秒，限制 4-12）
            poll_interval: 轮询间隔（秒）
            max_polls: 最大轮询次数
            on_log: 日志回调函数
            on_progress: 进度回调函数 (0.0 - 1.0)
            last_frame_path: 尾帧图像路径（可选，提供时启用首尾帧模式）

        Returns:
            生成结果
        """
        import httpx

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        task_id: str | None = None
        project_output_dir = kwargs.get("project_output_dir")
        tracking_episode = kwargs.get("episode")
        tracking_beat_num = kwargs.get("beat_num")
        tracking_task_type = kwargs.get("task_type", "")
        tracking_cost_estimate = kwargs.get("cost_estimate")

        def _record_request_accepted(request_id: str):
            if not project_output_dir or not request_id:
                return
            try:
                record_video_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider="seedance",
                    model_name=self.model,
                    episode=tracking_episode,
                    beat_num=tracking_beat_num,
                    task_type=tracking_task_type,
                    duration_seconds=float(duration),
                    cost_estimate=tracking_cost_estimate,
                )
            except Exception as e:
                log(f"记账失败(accepted): {e}")

        def _update_request_status(request_id: str, status: str, error_message: str | None = None):
            if not project_output_dir or not request_id:
                return
            try:
                update_video_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status=status,
                    error_message=error_message,
                )
            except Exception as e:
                log(f"记账失败({status}): {e}")

        # 限制 duration 在 4-12 范围；向上取整保证视频不短于音频
        duration = max(4, min(12, math.ceil(duration)))

        # 映射 aspect_ratio 格式
        ratio = aspect_ratio if ":" in aspect_ratio else "9:16"

        # 处理首帧
        if image_path.startswith(("http://", "https://", "data:")):
            first_frame_url = image_path
        elif os.path.exists(image_path):
            first_frame_url = self._local_to_data_url(image_path)
            log("首帧已转换为 data URL")
        else:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"First frame not found: {image_path}",
            )

        # 处理尾帧（如果有）
        last_frame_url = None
        if last_frame_path is not None:
            if last_frame_path.startswith(("http://", "https://", "data:")):
                last_frame_url = last_frame_path
            elif os.path.exists(last_frame_path):
                last_frame_url = self._local_to_data_url(last_frame_path)
                log("尾帧已转换为 data URL")
            else:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"Last frame not found: {last_frame_path}",
                )

        # 构建 content 数组
        content = [{"type": "text", "text": prompt}]

        # 首帧
        first_frame_item = {
            "type": "image_url",
            "image_url": {"url": first_frame_url},
        }
        if last_frame_url is not None:
            first_frame_item["role"] = "first_frame"
        content.append(first_frame_item)

        # 尾帧
        if last_frame_url is not None:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": last_frame_url},
                    "role": "last_frame",
                }
            )

        # 构建请求体
        request_body = {
            "model": self.model,
            "content": content,
            "resolution": "720p",
            "ratio": ratio,
            "duration": duration,
            "watermark": False,
        }
        request_body["generate_audio"] = self.generate_audio

        mode_desc = "首尾帧模式" if last_frame_url else "首帧模式"
        log(f"正在提交 Seedance 视频生成任务 ({mode_desc}, {self.model}, {duration}s)...")
        progress(0.1)

        # 1. 提交任务
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.endpoint}/contents/generations/tasks",
                    json=request_body,
                    headers=headers,
                )

                if resp.status_code != 200:
                    error_text = resp.text
                    log(f"任务提交失败: HTTP {resp.status_code} - {error_text[:500]}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"Submit failed: HTTP {resp.status_code} - {error_text[:200]}",
                    )

                data = resp.json()
                task_id = data.get("id")
                if not task_id:
                    log(f"未获取到 task_id: {data}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"No task_id in response: {data}",
                    )

                log(f"任务已提交: {task_id}")
                _record_request_accepted(task_id)

        except Exception as e:
            log(f"任务提交异常: {e}")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Submit exception: {e}",
            )

        # 2. 轮询结果
        progress(0.2)
        for poll_count in range(max_polls):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.get(
                        f"{self.endpoint}/contents/generations/tasks/{task_id}",
                        headers=headers,
                    )

                    if resp.status_code != 200:
                        log(f"查询状态失败: HTTP {resp.status_code}")
                        await asyncio.sleep(poll_interval)
                        continue

                    data = resp.json()
                    status_str = data.get("status", "")

                    # 进度从 0.2 到 0.9
                    poll_progress = 0.2 + (poll_count / max_polls) * 0.7
                    progress(poll_progress)

                    if status_str == "succeeded":
                        log("视频生成完成，正在下载...")
                        progress(0.9)
                        _update_request_status(task_id, "completed")

                        # 提取视频 URL
                        video_url = None
                        resp_content = data.get("content")
                        if isinstance(resp_content, dict):
                            video_url = resp_content.get("video_url")
                        elif isinstance(resp_content, list):
                            for item in resp_content:
                                if isinstance(item, dict) and item.get("video_url"):
                                    video_url = item["video_url"]
                                    break

                        if video_url:
                            success = await self._download_video(video_url, output_path)
                            if success:
                                log(f"视频已保存: {output_path}")
                                progress(1.0)
                                _update_request_status(task_id, "downloaded")
                                return VideoGenResult(
                                    status=VideoGenStatus.DONE,
                                    video_path=output_path,
                                    video_url=video_url,
                                    task_id=task_id,
                                    duration_seconds=float(duration),
                                )
                            else:
                                log("视频下载失败")
                                _update_request_status(task_id, "failed", "Download failed")
                                return VideoGenResult(
                                    status=VideoGenStatus.FAILED,
                                    error="Download failed",
                                    task_id=task_id,
                                )
                        else:
                            log(f"API 未返回视频 URL: {data}")
                            _update_request_status(task_id, "failed", "No video URL in response")
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error="No video URL in response",
                                task_id=task_id,
                            )

                    elif status_str == "failed":
                        error_msg = data.get("error", {}).get("message", "Unknown error")
                        log(f"视频生成失败: {error_msg}")
                        _update_request_status(task_id, "failed", error_msg)
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"Generation failed: {error_msg}",
                            task_id=task_id,
                        )

                    # queued / running → 继续轮询
                    if poll_count % 6 == 0:
                        log(f"正在生成中... ({status_str}, {poll_count}/{max_polls})")

            except Exception as e:
                log(f"查询状态异常: {e}")

            await asyncio.sleep(poll_interval)

        log("视频生成超时")
        _update_request_status(task_id, "failed", "Timeout waiting for video generation")
        return VideoGenResult(
            status=VideoGenStatus.FAILED,
            error="Timeout waiting for video generation",
            task_id=task_id,
        )


@dataclass
class ShotReference:
    """Seedance 2.0 素材引用。"""

    type: str  # "image" / "video" / "audio"
    path: str  # 本地文件路径
    role: str  # "首帧" / "角色参考" / "场景参考" / "配乐" / "音色参考"


class Seedance2VideoGenerator(VideoGeneratorBase):
    """火山方舟 Seedance 2.0 全能参考模式视频生成器。

    支持多模态输入：文本 + 最多9图 + 3视频 + 3音频。
    原生音视频同步生成（对话、BGM、音效）。
    内置智能运镜系统。

    注意：API格式需在API正式开放后确认，以下基于已知信息推断。

    示例:
        >>> generator = Seedance2VideoGenerator()
        >>> result = await generator.generate(
        ...     prompt="古老书房中，少女翻阅古籍...",
        ...     references=[
        ...         ShotReference("image", "frame.png", "首帧"),
        ...         ShotReference("image", "char_ref.png", "角色参考"),
        ...     ],
        ...     output_path="output.mp4",
        ...     duration=10,
        ...     audio=True,
        ... )
    """

    MODEL = "seedance-2.0"
    MODEL_I2V = "seedance-2.0-i2v"

    def _select_generation_model(
        self,
        *,
        image_count: int,
        video_count: int,
        audio_count: int,
    ) -> str:
        """Choose the Seedance model variant for the current reference mix.

        Mixed-reference omni generation should stay on the general Seedance 2.0
        model. The i2v variant is only used for pure single-image first-frame
        generation.
        """
        if image_count == 1 and video_count == 0 and audio_count == 0:
            return self.MODEL_I2V
        return self.MODEL

    def __init__(
        self,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
    ):
        self.model = model or self.MODEL
        self.api_key = (
            api_key or os.environ.get("VOLCENGINE_VISUAL_API_KEY") or os.environ.get("ARK_API_KEY")
        )
        self.endpoint = endpoint or os.environ.get(
            "VOLCENGINE_VISUAL_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3"
        )
        if not self.api_key:
            raise ValueError("VOLCENGINE_VISUAL_API_KEY or ARK_API_KEY must be set")

    def _file_to_data_url(self, file_path: str) -> str:
        """将本地文件转换为 data URL（base64）。"""
        import base64
        import mimetypes

        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type:
            ext = file_path.lower().rsplit(".", 1)[-1]
            mime_map = {
                "png": "image/png",
                "jpg": "image/jpeg",
                "jpeg": "image/jpeg",
                "webp": "image/webp",
                "bmp": "image/bmp",
                "gif": "image/gif",
                "mp4": "video/mp4",
                "mov": "video/quicktime",
                "mp3": "audio/mpeg",
                "wav": "audio/wav",
            }
            mime_type = mime_map.get(ext, "application/octet-stream")

        with open(file_path, "rb") as f:
            data = base64.b64encode(f.read()).decode()
        return f"data:{mime_type};base64,{data}"

    async def _download_video(self, url: str, output_path: str) -> bool:
        """下载视频文件。"""
        try:
            import httpx

            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.get(url)
                if resp.status_code != 200:
                    return False
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(resp.content)
                return True
        except Exception:
            return False

    async def submit_task(self, image_url: str, prompt: str, aspect_ratio: str = "9:16") -> str:
        return f"seedance2-{uuid.uuid4().hex[:8]}"

    async def get_result(self, task_id: str) -> VideoGenResult:
        return VideoGenResult(status=VideoGenStatus.PROCESSING, task_id=task_id)

    async def generate(
        self,
        prompt: str,
        output_path: str,
        references: Optional[list[ShotReference]] = None,
        duration: float = 10.0,
        audio: bool = True,
        aspect_ratio: str = "9:16",
        resolution: str = "2k",
        poll_interval: float = 5.0,
        max_polls: int = 120,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        # 兼容 VideoGeneratorBase 接口
        image_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        """Seedance 2.0 全能参考模式生成。

        Args:
            prompt: 中文自然语言描述（含@素材引用）
            output_path: 输出视频路径
            references: 素材引用列表（图片/视频/音频）
            duration: 目标时长（5-15秒）
            audio: 是否生成原生音频
            aspect_ratio: 宽高比
            resolution: 分辨率（720p/1080p/2k）
            poll_interval: 轮询间隔
            max_polls: 最大轮询次数
            on_log: 日志回调
            on_progress: 进度回调
            image_path: 兼容旧接口的首帧图路径
        """
        import httpx

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        refs = references or []

        # 兼容旧接口：如果传了 image_path 但没有 references，自动作为首帧
        if image_path and not refs:
            refs = [ShotReference("image", image_path, "首帧")]

        # 限制 duration 在 5-15 范围
        duration = max(5, min(15, int(duration)))

        # 映射 aspect_ratio 格式
        ratio = aspect_ratio if ":" in aspect_ratio else "9:16"

        # 构建 content 数组
        content = [{"type": "text", "text": prompt}]

        # 添加素材引用
        image_count, video_count, audio_count = 0, 0, 0
        for ref in refs:
            if not os.path.exists(ref.path):
                log(f"警告: 素材不存在: {ref.path}")
                continue

            data_url = self._file_to_data_url(ref.path)

            if ref.type == "image" and image_count < 9:
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                        "role": ref.role,
                    }
                )
                image_count += 1
            elif ref.type == "video" and video_count < 3:
                content.append(
                    {
                        "type": "video_url",
                        "video_url": {"url": data_url},
                        "role": ref.role,
                    }
                )
                video_count += 1
            elif ref.type == "audio" and audio_count < 3:
                content.append(
                    {
                        "type": "audio_url",
                        "audio_url": {"url": data_url},
                        "role": ref.role,
                    }
                )
                audio_count += 1

        model = self._select_generation_model(
            image_count=image_count,
            video_count=video_count,
            audio_count=audio_count,
        )

        # 构建请求体
        request_body = {
            "model": model,
            "content": content,
            "resolution": resolution,
            "ratio": ratio,
            "duration": duration,
            "watermark": False,
        }
        if audio:
            request_body["audio"] = True

        ref_summary = f"{image_count}图+{video_count}视频+{audio_count}音频"
        log(
            f"正在提交 Seedance 2.0 视频生成任务 "
            f"({ref_summary}, model={model}, {duration}s, audio={audio})..."
        )
        progress(0.1)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.endpoint}/contents/generations/tasks",
                    json=request_body,
                    headers=headers,
                )
                if resp.status_code != 200:
                    error_text = resp.text
                    log(f"任务提交失败: HTTP {resp.status_code} - {error_text[:500]}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"Submit failed: HTTP {resp.status_code} - {error_text[:200]}",
                    )
                data = resp.json()
                task_id = data.get("id")
                if not task_id:
                    log(f"未获取到 task_id: {data}")
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"No task_id in response: {data}",
                    )
                log(f"任务已提交: {task_id}")
        except Exception as e:
            log(f"任务提交异常: {e}")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Submit exception: {e}",
            )

        # 轮询结果
        progress(0.2)
        for poll_count in range(max_polls):
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.get(
                        f"{self.endpoint}/contents/generations/tasks/{task_id}",
                        headers=headers,
                    )
                    if resp.status_code != 200:
                        log(f"查询状态失败: HTTP {resp.status_code}")
                        await asyncio.sleep(poll_interval)
                        continue

                    data = resp.json()
                    status_str = data.get("status", "")
                    poll_progress = 0.2 + (poll_count / max_polls) * 0.7
                    progress(poll_progress)

                    if status_str == "succeeded":
                        log("视频生成完成，正在下载...")
                        progress(0.9)

                        video_url = None
                        resp_content = data.get("content")
                        if isinstance(resp_content, dict):
                            video_url = resp_content.get("video_url")
                        elif isinstance(resp_content, list):
                            for item in resp_content:
                                if isinstance(item, dict) and item.get("video_url"):
                                    video_url = item["video_url"]
                                    break

                        if video_url:
                            success = await self._download_video(video_url, output_path)
                            if success:
                                log(f"视频已保存: {output_path}")
                                progress(1.0)
                                return VideoGenResult(
                                    status=VideoGenStatus.DONE,
                                    video_path=output_path,
                                    video_url=video_url,
                                    task_id=task_id,
                                    duration_seconds=float(duration),
                                )
                            else:
                                log("视频下载失败")
                                return VideoGenResult(
                                    status=VideoGenStatus.FAILED,
                                    error="Download failed",
                                    task_id=task_id,
                                )
                        else:
                            log(f"API 未返回视频 URL: {data}")
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error="No video URL in response",
                                task_id=task_id,
                            )

                    elif status_str == "failed":
                        error_msg = data.get("error", {}).get("message", "Unknown error")
                        log(f"视频生成失败: {error_msg}")
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"Generation failed: {error_msg}",
                            task_id=task_id,
                        )

                    if poll_count % 6 == 0:
                        log(f"正在生成中... ({status_str}, {poll_count}/{max_polls})")

            except Exception as e:
                log(f"查询状态异常: {e}")

            await asyncio.sleep(poll_interval)

        log("视频生成超时")
        return VideoGenResult(
            status=VideoGenStatus.FAILED,
            error="Timeout waiting for video generation",
            task_id=task_id,
        )


class GrokVideoGenerator(VideoGeneratorBase):
    """xAI Grok 视频生成器（首帧图生视频，固定 720p）。"""

    MODEL = "grok-imagine-video"
    DEFAULT_ENDPOINT = "https://api.x.ai/v1"

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        model: str = MODEL,
        resolution: str = "720p",
    ):
        self.api_key = api_key or os.environ.get("XAI_API_KEY")
        self.endpoint = (
            endpoint or os.environ.get("XAI_BASE_URL") or self.DEFAULT_ENDPOINT
        ).rstrip("/")
        self.model = model
        self.resolution = resolution

        if not self.api_key:
            raise ValueError("XAI_API_KEY must be set for Grok video generation")

    def _local_to_data_url(self, image_path: str) -> str:
        import base64

        suffix = Path(image_path).suffix.lower()
        if suffix == ".png":
            mime_type = "image/png"
        elif suffix in {".jpg", ".jpeg"}:
            mime_type = "image/jpeg"
        else:
            mime_type = "image/png"

        with open(image_path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode()
        return f"data:{mime_type};base64,{encoded}"

    async def _download_video(self, url: str, output_path: str, max_retries: int = 3) -> bool:
        for attempt in range(1, max_retries + 1):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(url) as resp:
                        if resp.status != 200:
                            if attempt < max_retries:
                                await asyncio.sleep(2 * attempt)
                                continue
                            return False

                        os.makedirs(os.path.dirname(output_path), exist_ok=True)
                        with open(output_path, "wb") as f:
                            f.write(await resp.read())
                        return True
            except Exception:
                if attempt < max_retries:
                    await asyncio.sleep(2 * attempt)
        return False

    async def generate(
        self,
        image_path: str,
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
        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        if last_frame_path:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error="Grok 720 does not support keyframe/首尾帧模式",
            )

        duration = max(1, min(15, int(duration)))
        ratio = aspect_ratio if ":" in aspect_ratio else "9:16"

        if image_path.startswith(("http://", "https://", "data:")):
            image_url = image_path
        elif os.path.exists(image_path):
            image_url = self._local_to_data_url(image_path)
            log("首帧已转换为 data URL")
        else:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"First frame not found: {image_path}",
            )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        request_body = {
            "model": self.model,
            "prompt": prompt,
            "image_url": image_url,
            "duration": duration,
            "aspect_ratio": ratio,
            "resolution": self.resolution,
        }

        log(f"正在提交 Grok 视频生成任务 ({self.model}, {duration}s, {self.resolution})...")
        progress(0.1)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.endpoint}/videos/generations",
                    json=request_body,
                    headers=headers,
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"Submit failed: HTTP {resp.status} - {error_text[:200]}",
                        )
                    data = await resp.json()
        except Exception as e:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Submit exception: {e}",
            )

        request_id = data.get("request_id")
        if not request_id:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"No request_id in response: {data}",
            )

        log(f"任务已提交: {request_id}")
        progress(0.2)

        for poll_count in range(max_polls):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"{self.endpoint}/videos/{request_id}",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                    ) as resp:
                        if resp.status != 200:
                            await asyncio.sleep(poll_interval)
                            continue
                        data = await resp.json()
            except Exception:
                await asyncio.sleep(poll_interval)
                continue

            status_str = (data.get("status") or "").lower()
            progress(0.2 + (poll_count / max_polls) * 0.7)

            if status_str == "done":
                video_info = data.get("video") or {}
                video_url = video_info.get("url")
                if not video_url:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error="No video URL in response",
                        task_id=request_id,
                    )
                log("视频生成完成，正在下载...")
                progress(0.9)
                success = await self._download_video(video_url, output_path)
                if not success:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error="Download failed",
                        task_id=request_id,
                    )
                progress(1.0)
                return VideoGenResult(
                    status=VideoGenStatus.DONE,
                    video_url=video_url,
                    video_path=output_path,
                    task_id=request_id,
                    duration_seconds=float(video_info.get("duration") or duration),
                )

            if status_str in {"failed", "expired"}:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"Grok video generation {status_str}",
                    task_id=request_id,
                )

            if poll_count % 6 == 0:
                log(f"正在生成中... ({status_str or 'pending'}, {poll_count}/{max_polls})")
            await asyncio.sleep(poll_interval)

        return VideoGenResult(
            status=VideoGenStatus.FAILED,
            error="Generation timeout",
            task_id=request_id,
        )


async def translate_prompt_to_english(prompt: str) -> str:
    """将中文视频提示词翻译并优化为 WAN I2V 最佳格式。

    使用 Gemini 进行翻译，按照 WAN 模型最佳实践结构化输出。

    Args:
        prompt: 中文提示词

    Returns:
        优化后的英文提示词
    """
    if not prompt:
        return prompt

    # 检查是否已经是英文（简单判断：不含中文字符）
    has_chinese = any("\u4e00" <= c <= "\u9fff" for c in prompt)
    if not has_chinese:
        return prompt

    try:
        import google.genai as genai

        api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
        if not api_key:
            print("[VIDEO] 警告: 未配置 GOOGLE_API_KEY，跳过翻译")
            return prompt

        client = genai.Client(api_key=api_key)

        translation_prompt = f"""You are an expert at writing prompts for WAN 2.1 Image-to-Video AI model.

Convert this Chinese video motion description into an optimized English prompt following WAN I2V best practices.

## WAN I2V Prompt Rules:
1. Focus on MOTION and CAMERA MOVEMENT (the image already defines the subject/scene)
2. Use speed adverbs: "slowly", "gently", "dramatically", "subtly"
3. Use effective camera keywords: "push in", "pull back", "tracking shot", "static shot"
4. AVOID: "whip pan", "crash zoom", "dolly out" (these don't work well)
5. Add lighting if relevant: "soft lighting", "rim lighting", "backlit"
6. Keep it concise (under 80 words)

## Output Format:
[Lighting if relevant], [Shot type if relevant]. [Subject motion description]. [Camera movement].

## Chinese Input:
{prompt}

## English Output (ONLY the optimized prompt, nothing else):"""

        response = await asyncio.to_thread(
            client.models.generate_content,
            model="gemini-3.5-flash",
            contents=translation_prompt,
        )

        english_prompt = response.text.strip()
        # 移除可能的引号包裹
        if english_prompt.startswith('"') and english_prompt.endswith('"'):
            english_prompt = english_prompt[1:-1]
        print(f"[VIDEO] 优化提示词: {prompt} -> {english_prompt}")
        return english_prompt

    except Exception as e:
        print(f"[VIDEO] 翻译失败，使用原文: {e}")
        return prompt


def _seedance2_config_mapping(value) -> dict:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {"final_prompt": text}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _seedance2_duration_from_config(config: dict, fallback: float) -> float:
    if "duration" not in config:
        return fallback
    try:
        return int(float(config.get("duration") or fallback))
    except (TypeError, ValueError):
        return fallback


class HuimengVideoGenerator(VideoGeneratorBase):
    """HuiMeng async-task video generator."""

    DEFAULT_MODEL = "seedance-1.0-pro-fast"

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        model: Optional[str] = None,
        resolution: Optional[str] = None,
        generate_audio: Optional[bool] = None,
        client=None,
    ):
        from novelvideo.config import (
            HUIMENGI_VIDEO_GENERATE_AUDIO,
            HUIMENGI_VIDEO_RESOLUTION,
        )
        from novelvideo.generators.huimengi import HuimengiTaskClient

        self.model = model or self.DEFAULT_MODEL
        self.resolution = resolution or HUIMENGI_VIDEO_RESOLUTION
        self.generate_audio = (
            HUIMENGI_VIDEO_GENERATE_AUDIO if generate_audio is None else generate_audio
        )
        self.client = client or HuimengiTaskClient(api_key=api_key, base_url=endpoint)

    def _duration_bounds(self) -> tuple[int, int]:
        if self.model.startswith("seedance-2.0"):
            return 4, 15
        if self.model == "seedance-1.5-pro":
            return 4, 12
        return 2, 12

    def _supports_audio_param(self) -> bool:
        return self.model in {"seedance-2.0", "seedance-2.0-fast", "seedance-1.5-pro"}

    def _is_seedance2_model(self) -> bool:
        return self.model.startswith("seedance-2.0")

    def _to_upload_url(
        self,
        value: str | None,
        *,
        label: str,
        log: Callable[[str], None],
        require_http_url: bool = False,
    ) -> str | None:
        from novelvideo.generators.huimengi import local_file_to_data_url

        text = str(value or "").strip()
        if not text:
            return None
        if text.startswith(("http://", "https://")):
            return text
        if text.startswith("data:"):
            if require_http_url:
                raise ValueError(
                    "human_review requires HTTP/HTTPS media URLs; "
                    f"unsupported direct media reference for {label}: data:"
                )
            return text
        if os.path.exists(text):
            if require_http_url:
                from novelvideo.utils.oss_client import presign_or_upload_output

                oss_url = presign_or_upload_output(text)
                if not oss_url:
                    raise ValueError(
                        "human_review requires OSS presigned HTTP media URLs. "
                        f"Failed to upload or presign local file: {text}"
                    )
                log(f"{label}已上传/复用 OSS URL")
                return oss_url
            log(f"{label}已转换为 data URL")
            return local_file_to_data_url(text)
        raise FileNotFoundError(f"{label} not found: {text}")

    def _build_reference_params(
        self,
        references: list["ShotReference"] | None,
        *,
        log: Callable[[str], None],
        require_http_url: bool = False,
    ) -> tuple[dict[str, list[str]], dict[str, int]]:
        params: dict[str, list[str]] = {}
        image_urls: list[str] = []
        video_urls: list[str] = []
        audio_urls: list[str] = []

        for ref in references or []:
            path = str(getattr(ref, "path", "") or "").strip()
            if not path:
                continue
            ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
            role = str(getattr(ref, "role", "") or "").strip()
            label = f"{role or ref_type}参考"
            data_url = self._to_upload_url(
                path,
                label=label,
                log=log,
                require_http_url=require_http_url,
            )
            if not data_url:
                continue
            if ref_type == "image":
                image_urls.append(data_url)
            elif ref_type == "video":
                video_urls.append(data_url)
            elif ref_type == "audio":
                audio_urls.append(data_url)

        if image_urls:
            params["reference_images"] = image_urls[:9]
        if video_urls:
            params["reference_videos"] = video_urls[:3]
        if audio_urls:
            params["reference_audios"] = audio_urls[:3]

        return params, {
            "image_count": len(params.get("reference_images", [])),
            "video_count": len(params.get("reference_videos", [])),
            "audio_count": len(params.get("reference_audios", [])),
        }

    async def generate(
        self,
        image_path: Optional[str],
        prompt: str,
        output_path: str,
        aspect_ratio: str = "adaptive",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 120,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        project_output_dir = kwargs.get("project_output_dir")
        tracking_episode = kwargs.get("episode")
        tracking_beat_num = kwargs.get("beat_num")
        tracking_task_type = kwargs.get("task_type", "")
        tracking_cost_estimate = kwargs.get("cost_estimate")

        def record_accepted(request_id: str):
            if not project_output_dir or not request_id:
                return
            try:
                record_video_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider="huimeng",
                    model_name=self.model,
                    episode=tracking_episode,
                    beat_num=tracking_beat_num,
                    task_type=tracking_task_type,
                    duration_seconds=float(duration),
                    cost_estimate=tracking_cost_estimate,
                )
            except Exception as exc:
                log(f"记账失败(accepted): {exc}")

        def update_request_status(
            request_id: str,
            status: str,
            error_message: str | None = None,
        ):
            if not project_output_dir or not request_id:
                return
            try:
                update_video_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status=status,
                    error_message=error_message,
                )
            except Exception as exc:
                log(f"记账失败({status}): {exc}")

        is_seedance2_model = self._is_seedance2_model()
        seedance2_config = (
            _seedance2_config_mapping(kwargs.get("seedance2_config")) if is_seedance2_model else {}
        )
        duration = _seedance2_duration_from_config(seedance2_config, duration)
        min_duration, max_duration = self._duration_bounds()
        original_duration = duration
        duration = max(min_duration, min(max_duration, math.ceil(duration)))
        if duration != original_duration:
            log(f"时长已调整: {original_duration:.1f}s -> {duration:.0f}s")

        ratio = aspect_ratio if ":" in aspect_ratio else "adaptive"

        references = kwargs.get("references") or []
        require_http_media = (
            bool(seedance2_config.get("human_review"))
            if "human_review" in seedance2_config
            else bool(kwargs.get("human_review", False))
        )

        try:
            first_frame = self._to_upload_url(
                image_path,
                label="首帧",
                log=log,
                require_http_url=require_http_media,
            )
            last_frame = self._to_upload_url(
                last_frame_path,
                label="尾帧",
                log=log,
                require_http_url=require_http_media,
            )
            reference_params, ref_counts = self._build_reference_params(
                references,
                log=log,
                require_http_url=require_http_media,
            )
        except (FileNotFoundError, ValueError) as exc:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(exc),
            )

        has_multimodal_refs = any(ref_counts.values())

        if is_seedance2_model:
            from novelvideo.seedance2_i2v.models import Seedance2I2VMode
            from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

            if last_frame:
                mode = Seedance2I2VMode.FIRST_LAST_FRAME
            elif has_multimodal_refs:
                mode = Seedance2I2VMode.MULTIMODAL_REFERENCE
            elif first_frame:
                mode = Seedance2I2VMode.FIRST_FRAME
            else:
                mode = Seedance2I2VMode.TEXT_TO_VIDEO

            config = seedance2_config
            config_resolution = str(config.get("resolution") or self.resolution or "720p").strip()
            config_ratio = str(config.get("ratio") or ratio or "adaptive").strip()
            config.update(
                {
                    "mode": mode.value,
                    "final_prompt": prompt,
                    "duration": duration,
                    "resolution": config_resolution,
                    "ratio": config_ratio,
                }
            )
            if "generate_audio" not in config:
                config["generate_audio"] = bool(self.generate_audio)
                config["generate_audio_user_set"] = True
            elif "generate_audio_user_set" not in config:
                config["generate_audio_user_set"] = True
            if "return_last_frame" not in config:
                config["return_last_frame"] = False
            if "human_review" not in config:
                # Direct generator calls default to no material-review upload unless
                # the caller passes the per-beat Seedance2 config or an explicit kwarg.
                config["human_review"] = bool(kwargs.get("human_review", False))
                config["human_review_user_set"] = True
            elif "human_review_user_set" not in config:
                config["human_review_user_set"] = True
            try:
                params = build_seedance2_huimeng_params(
                    config,
                    first_frame=first_frame or "",
                    last_frame=last_frame or "",
                    reference_images=reference_params.get("reference_images"),
                    reference_videos=reference_params.get("reference_videos"),
                    reference_audios=reference_params.get("reference_audios"),
                )
            except ValueError as exc:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=str(exc),
                )
        else:
            params = {
                "prompt": prompt,
                "duration": duration,
                "resolution": self.resolution,
                "ratio": ratio,
                "return_last_frame": False,
            }

            if last_frame:
                if not first_frame:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error="First frame is required when last_frame_path is provided",
                    )
                params["first_frame_image"] = first_frame
                params["last_frame_image"] = last_frame
            elif has_multimodal_refs:
                params.update(reference_params)
            elif first_frame:
                params["image_url"] = first_frame

            if self._supports_audio_param():
                params["generate_audio"] = bool(self.generate_audio)

        task_id: str | None = None
        try:
            request_resolution = str(params.get("resolution") or self.resolution or "").strip()
            log(
                f"正在提交 HuiMeng 视频任务 "
                f"({self.model}, refs={ref_counts['image_count']}图/{ref_counts['video_count']}视频/{ref_counts['audio_count']}音频, "
                f"{duration}s, {request_resolution})..."
            )
            progress(0.1)
            submitted = await self.client.submit_task(model=self.model, params=params)
            task_id = submitted["task_id"]
            record_accepted(task_id)
            log(f"任务已提交: {task_id}")
            progress(0.2)

            task = await self.client.wait_for_completion(
                task_id,
                poll_interval=poll_interval,
                max_polls=max_polls,
                on_log=on_log,
                on_progress=on_progress,
            )

            from novelvideo.generators.huimengi import (
                extract_huimeng_result_duration,
                extract_huimeng_result_last_frame_url,
                extract_huimeng_result_url,
            )

            result = task.get("result") or {}
            task_result_payload = {**result, **task}
            video_url = extract_huimeng_result_url(result, "video_url", "video_urls")
            if not video_url:
                update_request_status(task_id, "failed", "No video_url in HuiMeng result")
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"No video_url in HuiMeng result: {result}",
                    task_id=task_id,
                )

            log("视频生成完成，正在下载...")
            await self.client.download_url(video_url, output_path)
            last_frame_url = ""
            last_frame_path = ""
            if bool(params.get("return_last_frame")):
                last_frame_url = extract_huimeng_result_last_frame_url(task_result_payload)
                if last_frame_url:
                    video_output_path = Path(output_path)
                    parsed_last_frame_url = urllib.parse.urlparse(last_frame_url)
                    last_frame_suffix = Path(parsed_last_frame_url.path).suffix.lower()
                    if last_frame_suffix not in {
                        ".png",
                        ".jpg",
                        ".jpeg",
                        ".webp",
                        ".gif",
                    }:
                        last_frame_suffix = ".png"
                    last_frame_output_path = (
                        video_output_path.parent
                        / "returned_last_frames"
                        / f"{video_output_path.stem}{last_frame_suffix}"
                    )
                    await self.client.download_image_url(
                        last_frame_url,
                        str(last_frame_output_path),
                    )
                    last_frame_path = last_frame_output_path.as_posix()
                    log("已保存 HuiMeng 返回尾帧")
            progress(1.0)
            update_request_status(task_id, "completed")
            return VideoGenResult(
                status=VideoGenStatus.DONE,
                video_url=video_url,
                video_path=output_path,
                last_frame_url=last_frame_url or None,
                last_frame_path=last_frame_path or None,
                task_id=task_id,
                provider_task_id=task_id,
                duration_seconds=extract_huimeng_result_duration(result) or float(duration),
            )

        except Exception as exc:
            if task_id:
                update_request_status(task_id, "failed", str(exc))
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(exc),
                task_id=task_id,
            )


class NewApiVideoError(RuntimeError):
    """newAPI video request failure with gateway request id when available."""

    def __init__(self, message: str, *, request_id: str = ""):
        super().__init__(message)
        self.request_id = request_id


class NewApiVideoGenerator(VideoGeneratorBase):
    """newAPI OpenAI-style async video task generator."""

    @staticmethod
    def _model_label(model: str) -> str:
        return NEWAPI_VIDEO_DISPLAY_LABELS.get(model, model)

    @staticmethod
    def _parse_duration_bounds_config(raw: str) -> dict[str, tuple[int, int]]:
        bounds: dict[str, tuple[int, int]] = {}
        for item in raw.split(","):
            entry = item.strip()
            if not entry or ":" not in entry or "-" not in entry:
                continue
            model, raw_bounds = entry.split(":", 1)
            raw_min, raw_max = raw_bounds.split("-", 1)
            try:
                min_seconds = int(raw_min.strip())
                max_seconds = int(raw_max.strip())
            except ValueError:
                continue
            if min_seconds > 0 and max_seconds >= min_seconds:
                bounds[model.strip()] = (min_seconds, max_seconds)
        return bounds

    @classmethod
    def _default_generate_audio_for_model(cls, model: str) -> bool:
        from novelvideo.config import NEWAPI_VIDEO_AUDIO_MODELS

        return model.strip() in set(NEWAPI_VIDEO_AUDIO_MODELS)

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        model: Optional[str] = None,
        resolution: Optional[str] = None,
        generate_audio: Optional[bool] = None,
    ):
        from novelvideo.config import (
            NEWAPI_VIDEO_MODEL,
            NEWAPI_VIDEO_RESOLUTION,
            get_effective_newapi_gateway_config,
        )

        gateway = get_effective_newapi_gateway_config()
        self.api_key = api_key if api_key is not None else gateway.api_key
        self.base_url = (endpoint or gateway.base_url).rstrip("/")
        self.model = model or NEWAPI_VIDEO_MODEL
        self.resolution = resolution or NEWAPI_VIDEO_RESOLUTION
        raw_generate_audio = os.environ.get("NEWAPI_VIDEO_GENERATE_AUDIO", "").strip().lower()
        if generate_audio is not None:
            self.generate_audio = generate_audio
        elif raw_generate_audio == "auto" or not raw_generate_audio:
            self.generate_audio = self._default_generate_audio_for_model(self.model)
        else:
            self.generate_audio = raw_generate_audio in {"true", "1", "yes", "on"}

        if not self.api_key:
            raise ValueError("DramaClawAPI key must be set for DramaClawAPI video generation")

    @staticmethod
    def _extract_request_id(text: str = "", headers: object | None = None) -> str:
        if headers:
            for header_name in ("x-request-id", "x-newapi-request-id", "x-oneapi-request-id"):
                value = getattr(headers, "get", lambda _name: "")(header_name)
                if value:
                    return str(value)

        if text:
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = None
            if isinstance(data, dict):
                error_obj = data.get("error") if isinstance(data.get("error"), dict) else {}
                for candidate in (
                    data.get("request_id"),
                    data.get("requestId"),
                    error_obj.get("request_id"),
                    error_obj.get("requestId"),
                ):
                    if isinstance(candidate, str) and candidate:
                        return candidate
                text = str(error_obj.get("message") or text)

            match = re.search(r"request[\s_-]*id[:：]\s*([A-Za-z0-9_-]+)", text, re.IGNORECASE)
            if match:
                return match.group(1)

        return ""

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _client_timeout() -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS)

    async def _post_json(self, url: str, payload: dict) -> dict:
        async with aiohttp.ClientSession(timeout=self._client_timeout()) as session:
            async with session.post(url, json=payload, headers=self.headers) as resp:
                text = await resp.text()
                if resp.status < 200 or resp.status >= 300:
                    request_id = self._extract_request_id(text, resp.headers)
                    raise NewApiVideoError(
                        f"DramaClawAPI submit failed: HTTP {resp.status} - {text}",
                        request_id=request_id,
                    )
                try:
                    data = json.loads(text)
                    if isinstance(data, dict):
                        data["_newapi_request_id"] = self._extract_request_id(text, resp.headers)
                    return data
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"DramaClawAPI submit returned invalid JSON: {text}") from exc

    async def _get_json(self, url: str) -> dict:
        async with aiohttp.ClientSession(timeout=self._client_timeout()) as session:
            async with session.get(url, headers=self.headers) as resp:
                text = await resp.text()
                if resp.status < 200 or resp.status >= 300:
                    request_id = self._extract_request_id(text, resp.headers)
                    raise NewApiVideoError(
                        f"DramaClawAPI task query failed: HTTP {resp.status} - {text}",
                        request_id=request_id,
                    )
                try:
                    return json.loads(text)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"DramaClawAPI task query returned invalid JSON: {text}") from exc

    async def _download_video(self, url: str, output_path: str) -> bytes:
        if url.startswith("data:"):
            header, _, encoded = url.partition(",")
            if ";base64" not in header or not encoded:
                raise RuntimeError("Unsupported data URL video response")
            import base64

            content = base64.b64decode(encoded)
        else:
            async with aiohttp.ClientSession(timeout=self._client_timeout()) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f"DramaClawAPI result download failed: HTTP {resp.status}")
                    content = await resp.read()

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return content

    @staticmethod
    def _ext_from_data_url_header(header: str, default: str = "png") -> str:
        mime_type = header.removeprefix("data:").split(";", 1)[0].strip().lower()
        return {
            "image/jpeg": "jpg",
            "image/jpg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "video/mp4": "mp4",
            "video/webm": "webm",
            "audio/mpeg": "mp3",
            "audio/mp3": "mp3",
            "audio/wav": "wav",
            "audio/x-wav": "wav",
            "audio/mp4": "m4a",
        }.get(mime_type, default)

    @classmethod
    async def _relay_frame_input(cls, image_value: str, *, default_ext: str = "png") -> str:
        return await cls._relay_media_input(
            image_value,
            default_ext=default_ext,
            image_transform=IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
        )

    @classmethod
    async def _relay_media_input(
        cls,
        media_value: str,
        *,
        default_ext: str = "png",
        image_transform: str | None = None,
    ) -> str:
        media_value = str(media_value or "").strip()
        if not media_value:
            raise ValueError("empty media input")
        if media_value.startswith(("http://", "https://")):
            return media_value

        if media_value.startswith("data:"):
            header, _, encoded = media_value.partition(",")
            if ";base64" not in header or not encoded:
                raise ValueError("unsupported data URL media input")
            import base64

            data = base64.b64decode(encoded)
            ext = cls._ext_from_data_url_header(header, default_ext)
            return await asyncio.to_thread(
                upload_image_bytes,
                data,
                ext=ext,
                image_transform=image_transform,
            )

        media_path = Path(media_value)
        ext = media_path.suffix.lstrip(".") or default_ext
        return await asyncio.to_thread(
            upload_image_bytes,
            media_path.read_bytes(),
            ext=ext,
            image_transform=image_transform,
        )

    def _duration_bounds(self) -> tuple[int, int]:
        from novelvideo.config import NEWAPI_VIDEO_DURATION_BOUNDS

        configured = self._parse_duration_bounds_config(NEWAPI_VIDEO_DURATION_BOUNDS)
        if self._is_happyhorse_model():
            return configured.get(self.model.strip(), (1, 15))
        return configured.get(self.model.strip(), (2, 12))

    def _is_seedance2_model(self) -> bool:
        return self.model.strip().startswith("seedance-2.0")

    def _is_happyhorse_model(self) -> bool:
        return self.model.strip().lower() == "happyhorse-1.0"

    def _is_grok_video_channel_model(self) -> bool:
        return self.model.strip().lower() == "grok-video-channel"

    @staticmethod
    def _happyhorse_ratio(value: str | None) -> str:
        text = str(value or "").strip()
        return text if text in {"16:9", "9:16", "1:1", "4:3", "3:4"} else "16:9"

    @staticmethod
    def _happyhorse_resolution(value: str | None) -> str:
        text = str(value or "").strip().lower()
        if "720" in text:
            return "720P"
        return "1080P"

    @staticmethod
    def _happyhorse_audio_setting(value: str | None) -> str:
        text = str(value or "").strip().lower()
        return text if text in {"auto", "origin"} else "auto"

    async def _relay_seedance2_references(
        self,
        references: list["ShotReference"] | None,
        *,
        log: Callable[[str], None],
    ) -> dict[str, list[str]]:
        reference_urls: dict[str, list[str]] = {}
        for ref in references or []:
            ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
            path = str(getattr(ref, "path", "") or "").strip()
            if not path:
                continue
            if ref_type == "image":
                key = "reference_images"
                default_ext = "png"
                label = "图片参考"
                image_transform = IMAGE_TRANSFORM_AI_REFERENCE_JPEG
            elif ref_type == "video":
                key = "reference_videos"
                default_ext = "mp4"
                label = "视频参考"
                image_transform = None
            elif ref_type == "audio":
                key = "reference_audios"
                default_ext = "mp3"
                label = "音频参考"
                image_transform = None
            else:
                continue
            url = await self._relay_media_input(
                path,
                default_ext=default_ext,
                image_transform=image_transform,
            )
            if not path.startswith(("http://", "https://")):
                log(f"{label}已上传到媒体中转")
            reference_urls.setdefault(key, []).append(url)
        return reference_urls

    @staticmethod
    def _extract_video_url(task: dict) -> str:
        metadata = task.get("metadata") if isinstance(task, dict) else None
        if isinstance(metadata, dict):
            for key in ("url", "video_url"):
                value = metadata.get(key)
                if isinstance(value, str) and value:
                    return value
        for key in ("url", "video_url"):
            value = task.get(key) if isinstance(task, dict) else None
            if isinstance(value, str) and value:
                return value
        return ""

    @staticmethod
    def _extract_returned_last_frame_url(task: dict) -> str:
        if not isinstance(task, dict):
            return ""
        from novelvideo.generators.huimengi import extract_huimeng_result_last_frame_url

        containers: list[dict] = []
        for value in (
            task.get("metadata"),
            task.get("response"),
            task.get("result"),
            task.get("output"),
            task.get("data"),
            task,
        ):
            if not isinstance(value, dict):
                continue
            containers.append(value)
            for nested_key in ("result", "output", "data", "response", "metadata"):
                nested = value.get(nested_key)
                if isinstance(nested, dict):
                    containers.append(nested)
        seen: set[int] = set()
        for container in containers:
            ident = id(container)
            if ident in seen:
                continue
            seen.add(ident)
            found = extract_huimeng_result_last_frame_url(container)
            if found:
                return found
        return ""

    @staticmethod
    def _extract_provider_task_id(task: dict, *, fallback: str = "") -> str:
        if not isinstance(task, dict):
            return fallback
        containers = [
            task.get("metadata"),
            task.get("response"),
            task.get("result"),
            task.get("output"),
            task.get("data"),
            task,
        ]
        keys = (
            "provider_task_id",
            "huimeng_task_id",
            "upstream_task_id",
            "upstream_id",
            "task_id",
        )
        for container in containers:
            if not isinstance(container, dict):
                continue
            for key in keys:
                value = container.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return fallback

    @classmethod
    def _returned_last_frame_output_path(cls, output_path: str, last_frame_url: str) -> Path:
        video_output_path = Path(output_path)
        suffix = ""
        if last_frame_url.startswith("data:"):
            header, _, _encoded = last_frame_url.partition(",")
            suffix = f".{cls._ext_from_data_url_header(header, default='png')}"
        else:
            parsed_url = urllib.parse.urlparse(last_frame_url)
            suffix = Path(parsed_url.path).suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            suffix = ".png"
        return (
            video_output_path.parent
            / "returned_last_frames"
            / f"{video_output_path.stem}{suffix}"
        )

    async def generate(
        self,
        image_path: Optional[str],
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 360,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        project_output_dir = kwargs.get("project_output_dir")
        tracking_episode = kwargs.get("episode")
        tracking_beat_num = kwargs.get("beat_num")
        tracking_task_type = kwargs.get("task_type", "")
        tracking_cost_estimate = kwargs.get("cost_estimate")

        def record_accepted(request_id: str):
            if not project_output_dir or not request_id:
                return
            try:
                record_video_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider="newapi",
                    model_name=self.model,
                    episode=tracking_episode,
                    beat_num=tracking_beat_num,
                    task_type=tracking_task_type,
                    duration_seconds=float(duration),
                    cost_estimate=tracking_cost_estimate,
                )
            except Exception as exc:
                log(f"记账失败(accepted): {exc}")

        def update_request_status(
            request_id: str,
            status: str,
            error_message: str | None = None,
        ):
            if not project_output_dir or not request_id:
                return
            try:
                update_video_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status=status,
                    error_message=error_message,
                )
            except Exception as exc:
                log(f"记账失败({status}): {exc}")

        is_seedance2_model = self._is_seedance2_model()
        seedance2_config = (
            _seedance2_config_mapping(kwargs.get("seedance2_config")) if is_seedance2_model else {}
        )
        duration = _seedance2_duration_from_config(seedance2_config, duration)
        min_duration, max_duration = self._duration_bounds()
        original_duration = duration
        duration = max(min_duration, min(max_duration, math.ceil(duration)))
        if duration != original_duration:
            log(f"时长已调整: {original_duration:.1f}s -> {duration:.0f}s")

        ratio = aspect_ratio if ":" in aspect_ratio else "9:16"
        image_path = str(image_path or "").strip()

        metadata: dict[str, object] = {
            "resolution": self.resolution,
            "ratio": ratio,
            "watermark": False,
            "generate_audio": bool(self.generate_audio),
        }
        payload: dict[str, object] = {
            "model": self.model,
            "prompt": prompt,
            "seconds": str(duration),
            "metadata": metadata,
        }

        if self._is_happyhorse_model():
            if len(prompt) > 2500:
                prompt = prompt[:2500]
                payload["prompt"] = prompt
                log("提示词已截断到 HappyHorse 1.0 上限 2500 字符")

            duration_int = int(math.ceil(duration))
            metadata.pop("generate_audio", None)
            metadata["ratio"] = self._happyhorse_ratio(ratio)
            metadata["resolution"] = self._happyhorse_resolution(self.resolution)
            payload["duration"] = duration_int
            payload["seconds"] = str(duration_int)

            first_frame_path = ""
            reference_image_paths: list[str] = []
            video_reference_paths: list[str] = []
            for ref in kwargs.get("references") or []:
                ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
                path = str(getattr(ref, "path", "") or "").strip()
                if not path:
                    continue
                if ref_type == "video":
                    video_reference_paths.append(path)
                    continue
                if ref_type != "image":
                    continue
                role = str(getattr(ref, "role", "") or "").strip()
                if "首帧" in role and not first_frame_path:
                    first_frame_path = path
                else:
                    reference_image_paths.append(path)

            if not first_frame_path and image_path:
                first_frame_path = image_path
            if last_frame_path:
                reference_image_paths.append(str(last_frame_path))

            try:
                if video_reference_paths:
                    video_url = await self._relay_media_input(
                        video_reference_paths[0],
                        default_ext="mp4",
                    )
                    if not video_reference_paths[0].startswith(("http://", "https://")):
                        log("视频参考已上传到媒体中转")
                    metadata["video_url"] = video_url
                    metadata["audio_setting"] = self._happyhorse_audio_setting(
                        kwargs.get("audio_setting")
                    )

                relayed_references: list[str] = []
                for path in reference_image_paths[: 5 if video_reference_paths else 9]:
                    url = await self._relay_frame_input(path)
                    if not path.startswith(("http://", "https://")):
                        log("图片参考已上传到媒体中转")
                    relayed_references.append(url)

                if first_frame_path:
                    first_frame_url = await self._relay_frame_input(first_frame_path)
                    if not first_frame_path.startswith(("http://", "https://")):
                        log("首帧已上传到媒体中转")
                    metadata["image_url"] = first_frame_url
                    payload["images"] = [first_frame_url]

                if relayed_references:
                    metadata["reference_images"] = relayed_references
            except Exception as exc:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"media relay upload failed: {exc}",
                )

        elif self._is_grok_video_channel_model():
            metadata.pop("generate_audio", None)
            metadata.pop("watermark", None)
            duration_int = int(math.ceil(duration))
            payload["duration"] = duration_int
            payload["seconds"] = str(duration_int)
            first_frame_path = image_path
            reference_image_paths: list[str] = []
            for ref in kwargs.get("references") or []:
                ref_type = str(getattr(ref, "type", "") or "image").strip().lower()
                path = str(getattr(ref, "path", "") or "").strip()
                if not path or ref_type != "image":
                    continue
                role = str(getattr(ref, "role", "") or "").strip()
                if not first_frame_path and "首帧" in role:
                    first_frame_path = path
                    continue
                if path != first_frame_path:
                    reference_image_paths.append(path)

            try:
                if first_frame_path:
                    first_frame_url = await self._relay_frame_input(first_frame_path)
                    if not first_frame_path.startswith(("http://", "https://")):
                        log("首帧已上传到媒体中转")
                    metadata["image_url"] = first_frame_url
                    payload["images"] = [first_frame_url]

                relayed_references: list[str] = []
                for path in reference_image_paths[:7]:
                    url = await self._relay_frame_input(path)
                    if not path.startswith(("http://", "https://")):
                        log("参考图片已上传到媒体中转")
                    relayed_references.append(url)
                if relayed_references:
                    metadata["reference_images"] = relayed_references
            except Exception as exc:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"media relay upload failed: {exc}",
                )

        elif is_seedance2_model:
            try:
                first_frame = await self._relay_frame_input(image_path) if image_path else ""
                if image_path and not image_path.startswith(("http://", "https://")):
                    log("首帧已上传到媒体中转")
                last_frame = (
                    await self._relay_frame_input(str(last_frame_path)) if last_frame_path else ""
                )
                if last_frame_path and not str(last_frame_path).startswith(("http://", "https://")):
                    log("尾帧已上传到媒体中转")
                reference_params = await self._relay_seedance2_references(
                    kwargs.get("references") or [],
                    log=log,
                )
            except Exception as exc:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"media relay upload failed: {exc}",
                )

            from novelvideo.seedance2_i2v.models import Seedance2I2VMode
            from novelvideo.seedance2_i2v.request import build_seedance2_huimeng_params

            has_references = any(reference_params.values())
            if last_frame:
                mode = Seedance2I2VMode.FIRST_LAST_FRAME
            elif has_references:
                mode = Seedance2I2VMode.MULTIMODAL_REFERENCE
            elif first_frame:
                mode = Seedance2I2VMode.FIRST_FRAME
            else:
                mode = Seedance2I2VMode.TEXT_TO_VIDEO

            config_resolution = str(
                seedance2_config.get("resolution") or self.resolution or "720p"
            ).strip()
            config_ratio = str(seedance2_config.get("ratio") or ratio or "9:16").strip()
            seedance2_config.update(
                {
                    "mode": mode.value,
                    "final_prompt": prompt,
                    "duration": duration,
                    "resolution": config_resolution,
                    "ratio": config_ratio,
                }
            )
            if "generate_audio" not in seedance2_config:
                seedance2_config["generate_audio"] = bool(self.generate_audio)
                seedance2_config["generate_audio_user_set"] = True
            elif "generate_audio_user_set" not in seedance2_config:
                seedance2_config["generate_audio_user_set"] = True
            if "return_last_frame" not in seedance2_config:
                seedance2_config["return_last_frame"] = False
            if "human_review" not in seedance2_config:
                seedance2_config["human_review"] = bool(kwargs.get("human_review", False))
                seedance2_config["human_review_user_set"] = True
            elif "human_review_user_set" not in seedance2_config:
                seedance2_config["human_review_user_set"] = True

            try:
                seedance2_params = build_seedance2_huimeng_params(
                    seedance2_config,
                    first_frame=first_frame,
                    last_frame=last_frame,
                    reference_images=reference_params.get("reference_images"),
                    reference_videos=reference_params.get("reference_videos"),
                    reference_audios=reference_params.get("reference_audios"),
                )
            except ValueError as exc:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=str(exc),
                )

            payload["prompt"] = seedance2_params.pop("prompt")
            payload["seconds"] = str(seedance2_params.pop("duration"))
            metadata.update(seedance2_params)
        else:
            if last_frame_path:
                if not image_path:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error="First frame is required when last_frame_path is provided",
                    )
                try:
                    first_frame = await self._relay_frame_input(image_path)
                    if not image_path.startswith(("http://", "https://")):
                        log("首帧已上传到媒体中转")
                except Exception as exc:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"media relay upload failed: {exc}",
                    )
                try:
                    last_frame = await self._relay_frame_input(str(last_frame_path))
                    if not str(last_frame_path).startswith(("http://", "https://")):
                        log("尾帧已上传到媒体中转")
                except Exception as exc:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"media relay upload failed: {exc}",
                    )
                metadata["content"] = [
                    {
                        "type": "image_url",
                        "image_url": {"url": first_frame},
                        "role": "first_frame",
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": last_frame},
                        "role": "last_frame",
                    },
                ]
            elif image_path:
                try:
                    first_frame = await self._relay_frame_input(image_path)
                    if not image_path.startswith(("http://", "https://")):
                        log("首帧已上传到媒体中转")
                except Exception as exc:
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"media relay upload failed: {exc}",
                    )
                payload["images"] = [first_frame]

        task_id: str | None = None
        provider_request_id = ""
        reservation_id = ""
        try:
            model_label = self._model_label(self.model)
            request_resolution = str(metadata.get("resolution") or self.resolution or "").strip()
            log(f"正在提交 DramaClawAPI 视频任务 ({model_label}, {duration}s, {request_resolution})...")
            progress(0.1)
            reservation_id = await _reserve_video_model_call(
                self.model,
                source="newapi_video_generation",
                resolution=request_resolution,
                duration_seconds=duration,
            )
            submitted = await self._post_json(f"{self.base_url}/video/generations", payload)
            task_id = str(submitted.get("id") or submitted.get("task_id") or "")
            provider_request_id = str(submitted.get("_newapi_request_id") or "").strip()
            if not task_id:
                await _refund_video_model_call(
                    reservation_id,
                    source="newapi_video_generation",
                    error="missing_task_id",
                    provider_request_id=provider_request_id,
                )
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"No task_id in DramaClawAPI response: {submitted}",
                )
            record_accepted(task_id)
            log(f"任务已提交: {task_id}")
            progress(0.2)

            for poll_count in range(max_polls):
                task = await self._get_json(f"{self.base_url}/videos/{task_id}")
                status = str(task.get("status") or "").lower()
                progress(0.2 + (poll_count / max(max_polls, 1)) * 0.7)

                if status in {"completed", "succeeded", "success", "done"}:
                    progress(0.9)
                    video_url = self._extract_video_url(task)
                    if not video_url:
                        update_request_status(task_id, "failed", "No video url in DramaClawAPI result")
                        await _refund_video_model_call(
                            reservation_id,
                            source="newapi_video_generation",
                            error="missing_video_url",
                            provider_request_id=provider_request_id,
                            provider_task_id=task_id,
                        )
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error=f"No video url in DramaClawAPI result: {task}",
                            task_id=task_id,
                        )
                    log("视频生成完成，正在下载...")
                    await self._download_video(video_url, output_path)
                    provider_task_id = self._extract_provider_task_id(
                        task,
                        fallback=task_id,
                    )
                    last_frame_url = ""
                    last_frame_path = ""
                    if bool(metadata.get("return_last_frame")):
                        last_frame_url = self._extract_returned_last_frame_url(task)
                        if last_frame_url:
                            last_frame_output_path = self._returned_last_frame_output_path(
                                output_path,
                                last_frame_url,
                            )
                            await self._download_video(
                                last_frame_url,
                                str(last_frame_output_path),
                            )
                            last_frame_path = last_frame_output_path.as_posix()
                            log("已保存 DramaClawAPI 返回尾帧")
                    progress(1.0)
                    update_request_status(task_id, "completed")
                    await _confirm_video_model_call(
                        model=self.model,
                        reservation_id=reservation_id,
                        provider_request_id=provider_request_id,
                        provider_task_id=task_id,
                    )
                    return VideoGenResult(
                        status=VideoGenStatus.DONE,
                        video_url=video_url,
                        video_path=output_path,
                        last_frame_url=last_frame_url or None,
                        last_frame_path=last_frame_path or None,
                        task_id=task_id,
                        provider_task_id=provider_task_id,
                        duration_seconds=float(duration),
                    )

                if status in {"failed", "error", "canceled", "cancelled", "expired"}:
                    error = (
                        task.get("error") or task.get("fail_reason") or "DramaClawAPI video task failed"
                    )
                    update_request_status(task_id, "failed", str(error))
                    await _refund_video_model_call(
                        reservation_id,
                        source="newapi_video_generation",
                        error=str(error),
                        provider_request_id=provider_request_id,
                        provider_task_id=task_id,
                    )
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=str(error),
                        task_id=task_id,
                    )

                if poll_count % 6 == 0:
                    log(
                        f"DramaClawAPI task {task_id} status: "
                        f"{status or 'queued'} ({poll_count}/{max_polls})"
                    )
                await asyncio.sleep(poll_interval)

            update_request_status(task_id, "failed", "Timeout waiting for DramaClawAPI video task")
            await _refund_video_model_call(
                reservation_id,
                source="newapi_video_generation",
                error="timeout",
                provider_request_id=provider_request_id,
                provider_task_id=task_id,
            )
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error="Timeout waiting for DramaClawAPI video task",
                task_id=task_id,
            )
        except NewApiVideoError as exc:
            if exc.request_id:
                log(f"DramaClawAPI request_id: {exc.request_id}")
            if task_id:
                log(f"DramaClawAPI task_id: {task_id}")
                update_request_status(task_id, "failed", str(exc))
            await _refund_video_model_call(
                reservation_id,
                source="newapi_video_generation",
                error=str(exc),
                provider_request_id=exc.request_id or provider_request_id,
                provider_task_id=task_id or "",
            )
            if is_insufficient_credits_error(exc):
                raise
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(exc),
                task_id=task_id,
            )
        except Exception as exc:
            if task_id:
                update_request_status(task_id, "failed", str(exc))
            await _refund_video_model_call(
                reservation_id,
                source="newapi_video_generation",
                error=str(exc),
                provider_request_id=provider_request_id,
                provider_task_id=task_id or "",
            )
            if is_insufficient_credits_error(exc):
                raise
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(exc),
                task_id=task_id,
            )


class ComfyUIVideoGenerator(VideoGeneratorBase):
    """ComfyUI Wan2.2 5B 视频生成器。

    直接与 ComfyUI 服务器通信进行图生视频。
    使用 WebSocket 实时监听生成进度。

    支持三种工作流模式：
    - GGUF: 低显存模式，使用 GGUF 量化模型（~8GB VRAM）
    - fp8 I2V: 标准质量模式，单帧输入生成视频（~16GB VRAM）
    - fp8 FLF: 首尾帧模式，两帧输入生成过渡视频（~16GB VRAM）

    示例:
        >>> # GGUF 模式（默认，低显存）
        >>> generator = ComfyUIVideoGenerator(workflow_type="gguf")
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="角色微笑点头",
        ...     output_path="output.mp4",
        ...     duration=5.0,
        ... )

        >>> # fp8 I2V 模式（高质量）
        >>> generator = ComfyUIVideoGenerator(workflow_type="fp8")
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="角色微笑点头",
        ...     output_path="output.mp4",
        ...     duration=5.0,
        ... )

        >>> # fp8 FLF 模式（首尾帧过渡）
        >>> generator = ComfyUIVideoGenerator(workflow_type="fp8")
        >>> result = await generator.generate(
        ...     image_path="frame_start.png",
        ...     prompt="smooth transition",
        ...     output_path="output.mp4",
        ...     last_frame_path="frame_end.png",  # 触发 FLF 模式
        ... )
    """

    # ComfyUI 服务器配置
    DEFAULT_ADDRESS = "u864639-76942a5c8e3b.westd.seetacloud.com:8443"
    LTX23_DEFAULT_ADDRESS = "u864639-7730b46a98f9.westd.seetacloud.com:8443"
    DEFAULT_USE_SSL = True  # 云服务器使用 HTTPS/WSS
    FPS = 24

    # FLF 模式固定帧数（~3.3 秒）
    FLF_FRAMES = 81

    # LTX 2.3 帧率（与 Wan 2.2 的 24fps 不同）
    LTX23_FPS = 25

    # 工作流模板路径
    GGUF_WORKFLOW_PATH = Path(__file__).parent / "wan2-2-I2V-GGUF-LightX2V.json"
    FP8_I2V_WORKFLOW_PATH = Path(__file__).parent / "wan2-2-I2V-LightX2V.json"
    FP8_FLF_WORKFLOW_PATH = Path(__file__).parent / "wan2-2-FLF-LightX2V.json"
    LTX23_I2V_WORKFLOW_PATH = Path(__file__).parent / "ltx2-3-I2V.json"

    # 节点映射配置（不同工作流的节点 ID）
    NODE_MAPPING = {
        "gguf": {
            "input_image": "62",
            "frame_count": "63",  # WanImageToVideo.length
            "positive_prompt": "6",
            "negative_prompt": "7",
            "seed": "57",
            "video_output": "61",
        },
        "fp8_i2v": {
            "input_image": "34",
            "frame_count": "20",  # Int node
            "positive_prompt": "29",
            "negative_prompt": "3",
            "seed_high": "94",
            "seed_low": "96",
            "video_output": "19",
        },
        "fp8_flf": {
            "first_image": "119",
            "last_image": "125",
            "positive_prompt": "6",
            "negative_prompt": "7",
            "seed": "57",
            "video_output": "67",
        },
        "ltx23": {
            "input_image": "98",
            "frame_count": "167:146",  # PrimitiveInt.value
            "positive_prompt": "167:164",  # TextGenerateLTX2Prompt.prompt
            "negative_prompt": "167:159",  # CLIPTextEncode.text
            "seed_high": "167:135",  # RandomNoise
            "seed_low": "167:165",  # RandomNoise
            "video_output": "75",  # SaveVideo
        },
    }

    def __init__(
        self,
        server_address: Optional[str] = None,
        timeout: float = 600.0,
        workflow_type: str = "gguf",
        use_ssl: Optional[bool] = None,
    ):
        """初始化 ComfyUI 生成器。

        Args:
            server_address: ComfyUI 服务器地址（默认从环境变量读取）
            timeout: 请求超时时间（秒）
            workflow_type: 工作流类型 ("gguf" 或 "fp8")，默认 "gguf"
            use_ssl: 是否使用 HTTPS/WSS（默认从环境变量读取）
        """
        # LTX 2.3 使用独立 ComfyUI 服务器（有 LTX 节点）
        if server_address:
            self.server_address = server_address
        elif workflow_type.lower() == "ltx23":
            self.server_address = os.environ.get(
                "COMFYUI_LTX23_ADDRESS", self.LTX23_DEFAULT_ADDRESS
            )
        else:
            self.server_address = os.environ.get("COMFYUI_ADDRESS", self.DEFAULT_ADDRESS)
        self.timeout = timeout
        self.workflow_type = workflow_type.lower()

        # SSL 配置
        if use_ssl is None:
            use_ssl_env = os.environ.get("COMFYUI_USE_SSL", "").lower()
            self.use_ssl = use_ssl_env in ("true", "1", "yes")
        else:
            self.use_ssl = use_ssl

        # 构建 URL
        http_scheme = "https" if self.use_ssl else "http"
        ws_scheme = "wss" if self.use_ssl else "ws"
        self.http_url = f"{http_scheme}://{self.server_address}"
        self.ws_url = f"{ws_scheme}://{self.server_address}"

        # 根据类型选择工作流路径
        if self.workflow_type == "fp8":
            workflow_path = self.FP8_I2V_WORKFLOW_PATH
        elif self.workflow_type == "ltx23":
            workflow_path = self.LTX23_I2V_WORKFLOW_PATH
        else:
            workflow_path = self.GGUF_WORKFLOW_PATH

        # 加载工作流模板
        self._workflow_templates = {}
        for name, path in [
            ("gguf", self.GGUF_WORKFLOW_PATH),
            ("fp8_i2v", self.FP8_I2V_WORKFLOW_PATH),
            ("fp8_flf", self.FP8_FLF_WORKFLOW_PATH),
            ("ltx23", self.LTX23_I2V_WORKFLOW_PATH),
        ]:
            if path.exists():
                with open(path, "r") as f:
                    self._workflow_templates[name] = json.load(f)

        # 兼容旧代码
        if self.workflow_type == "ltx23":
            self._workflow_template = self._workflow_templates.get("ltx23")
        else:
            self._workflow_template = self._workflow_templates.get(
                "fp8_i2v" if self.workflow_type == "fp8" else "gguf"
            )

    async def _upload_image(self, image_bytes: bytes, filename: str) -> dict:
        """上传图片到 ComfyUI input 文件夹。"""
        async with aiohttp.ClientSession() as session:
            data = aiohttp.FormData()
            data.add_field("image", image_bytes, filename=filename, content_type="image/png")
            async with session.post(f"{self.http_url}/upload/image", data=data) as response:
                if response.status != 200:
                    raise Exception(f"上传图片失败: {await response.text()}")
                return await response.json()

    async def _queue_prompt(self, workflow: dict, client_id: str) -> dict:
        """提交工作流到 ComfyUI 队列。"""
        p = {"prompt": workflow, "client_id": client_id}
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{self.http_url}/prompt", json=p) as response:
                if response.status != 200:
                    raise Exception(f"提交工作流失败: {await response.text()}")
                return await response.json()

    async def _get_history(self, prompt_id: str) -> dict:
        """获取执行历史。"""
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{self.http_url}/history/{prompt_id}") as response:
                if response.status != 200:
                    raise Exception(f"获取历史失败: {await response.text()}")
                return await response.json()

    async def _download_video(self, filename: str, subfolder: str = "") -> bytes:
        """从 ComfyUI 下载视频文件。"""
        params = {"filename": filename, "subfolder": subfolder, "type": "output"}
        url = f"{self.http_url}/view?{urllib.parse.urlencode(params)}"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                if response.status != 200:
                    raise Exception(f"下载视频失败: {await response.text()}")
                return await response.read()

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        """生成视频。

        直接与 ComfyUI 通信，通过 WebSocket 监听进度。
        自动选择工作流：
        - 有 last_frame_path → FLF 模式 (fp8_flf)
        - 无 last_frame_path → I2V 模式 (gguf 或 fp8_i2v)

        Args:
            image_path: 首帧图像路径
            prompt: 动作描述
            output_path: 输出视频路径
            aspect_ratio: 宽高比（未使用，保留兼容）
            duration: 视频时长（秒），默认 5.0，最大 10.0（FLF 模式固定 ~3.3s）
            on_log: 日志回调函数
            on_progress: 进度回调函数 (0.0 ~ 1.0)
            last_frame_path: 尾帧图像路径（可选，提供时启用 FLF 模式）

        Returns:
            生成结果
        """

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        # 判断是否使用 FLF 模式
        use_flf_mode = last_frame_path is not None

        # 选择工作流
        if use_flf_mode:
            workflow_key = "fp8_flf"
            mode_desc = "FLF (首尾帧过渡)"
        elif self.workflow_type == "ltx23":
            workflow_key = "ltx23"
            mode_desc = "LTX 2.3 I2V"
        elif self.workflow_type == "fp8":
            workflow_key = "fp8_i2v"
            mode_desc = "fp8 I2V"
        else:
            workflow_key = "gguf"
            mode_desc = "GGUF I2V"

        # 检查工作流模板
        workflow_template = self._workflow_templates.get(workflow_key)
        if workflow_template is None:
            workflow_path = {
                "gguf": self.GGUF_WORKFLOW_PATH,
                "fp8_i2v": self.FP8_I2V_WORKFLOW_PATH,
                "fp8_flf": self.FP8_FLF_WORKFLOW_PATH,
                "ltx23": self.LTX23_I2V_WORKFLOW_PATH,
            }.get(workflow_key, "unknown")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"工作流模板不存在: {workflow_path}",
            )

        # 获取节点映射
        node_map = self.NODE_MAPPING.get(workflow_key, {})

        # 检查首帧图片
        if not os.path.exists(image_path):
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"首帧图片不存在: {image_path}",
            )

        # 检查尾帧图片（FLF 模式）
        if use_flf_mode and not os.path.exists(last_frame_path):
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"尾帧图片不存在: {last_frame_path}",
            )

        client_id = str(uuid.uuid4())
        first_image_filename = f"first_{client_id}.png"
        last_image_filename = f"last_{client_id}.png" if use_flf_mode else None

        # FLF 模式固定帧数
        if use_flf_mode:
            frames = self.FLF_FRAMES
            actual_duration = frames / self.FPS
            log(f"开始生成视频 | 模式: {mode_desc} | 固定帧数: {frames} (~{actual_duration:.1f}s)")
        else:
            fps = self.LTX23_FPS if workflow_key == "ltx23" else self.FPS
            frames = int(duration * fps) + 1  # +1 确保时长足够
            log(f"开始生成视频 | 模式: {mode_desc} | 时长: {duration}s")

        try:
            # 1. 读取并上传图片
            log("上传图片到 ComfyUI...")
            with open(image_path, "rb") as f:
                first_image_bytes = f.read()
            await self._upload_image(first_image_bytes, first_image_filename)
            log(f"首帧已上传: {first_image_filename}")

            # FLF 模式：上传尾帧
            if use_flf_mode:
                with open(last_frame_path, "rb") as f:
                    last_image_bytes = f.read()
                await self._upload_image(last_image_bytes, last_image_filename)
                log(f"尾帧已上传: {last_image_filename}")

            # 2. 准备工作流
            log("准备工作流...")
            workflow = json.loads(json.dumps(workflow_template))

            # 设置输入图片（根据工作流类型）
            if workflow_key == "fp8_flf":
                # FLF 模式：设置首尾帧
                workflow[node_map["first_image"]]["inputs"]["image"] = first_image_filename
                workflow[node_map["last_image"]]["inputs"]["image"] = last_image_filename
            elif workflow_key == "ltx23":
                # LTX 2.3 I2V 模式
                workflow[node_map["input_image"]]["inputs"]["image"] = first_image_filename
                # 设置帧数（PrimitiveInt.value）
                workflow[node_map["frame_count"]]["inputs"]["value"] = frames
                log(f"帧数: {frames} (duration={duration}s, fps={self.LTX23_FPS})")
            elif workflow_key == "fp8_i2v":
                # fp8 I2V 模式
                workflow[node_map["input_image"]]["inputs"]["image"] = first_image_filename
                # 设置帧数
                workflow[node_map["frame_count"]]["inputs"]["Number"] = frames
                log(f"帧数: {frames} (duration={duration}s, fps={self.FPS})")
            else:
                # GGUF 模式
                workflow[node_map["input_image"]]["inputs"]["image"] = first_image_filename
                # 设置帧数（WanImageToVideo.length）
                workflow[node_map["frame_count"]]["inputs"]["length"] = frames
                log(f"帧数: {frames} (duration={duration}s, fps={self.FPS})")

            # 设置提示词（LTX23 用 "prompt" 字段，其余用 "text"）
            prompt_field = "prompt" if workflow_key == "ltx23" else "text"
            workflow[node_map["positive_prompt"]]["inputs"][prompt_field] = prompt or ""
            # 负向提示词保持默认（已在模板中设置）
            if prompt:
                log(f"提示词: {prompt[:80]}{'...' if len(prompt) > 80 else ''}")

            # 设置随机种子
            seed = random.randint(0, 0xFFFFFFFFFFFF)
            if workflow_key in ("fp8_i2v", "ltx23"):
                # fp8 I2V / LTX 2.3 有两个采样器
                workflow[node_map["seed_high"]]["inputs"]["noise_seed"] = seed
                workflow[node_map["seed_low"]]["inputs"]["noise_seed"] = seed
            else:
                workflow[node_map["seed"]]["inputs"]["noise_seed"] = seed
            log(f"随机种子: {seed}")

            # 3. 连接 WebSocket
            log("连接 WebSocket...")
            ws_connect_url = f"{self.ws_url}/ws?clientId={client_id}"
            ws = await websockets.connect(
                ws_connect_url,
                max_size=500 * 1024 * 1024,
                ping_interval=None,
                ping_timeout=None,
                proxy=None,  # 禁用代理检测
            )

            try:
                # 4. 提交工作流
                log("提交工作流到队列...")
                result = await self._queue_prompt(workflow, client_id)
                prompt_id = result.get("prompt_id")
                if not prompt_id:
                    raise Exception("未获取到 prompt_id")
                log(f"prompt_id: {prompt_id}")

                # 5. 监听 WebSocket 消息
                log("等待 ComfyUI 执行...")
                current_node = None
                while True:
                    out = await ws.recv()
                    if isinstance(out, str):
                        message = json.loads(out)
                        msg_type = message.get("type")

                        if msg_type == "executing":
                            data = message.get("data", {})
                            if data.get("prompt_id") == prompt_id:
                                node = data.get("node")
                                if node is None:
                                    log("推理完成!")
                                    break
                                elif node != current_node:
                                    current_node = node
                                    node_title = (
                                        workflow.get(node, {}).get("_meta", {}).get("title", node)
                                    )
                                    log(f"执行节点: {node_title}")

                        elif msg_type == "progress":
                            data = message.get("data", {})
                            value = data.get("value", 0)
                            max_val = data.get("max", 100)
                            pct = value / max_val * 100 if max_val > 0 else 0
                            log(f"进度: {value}/{max_val} ({pct:.0f}%)")
                            # 更新进度 (0.0 ~ 1.0)
                            progress(value / max_val if max_val > 0 else 0)

                        elif msg_type == "execution_error":
                            error_data = message.get("data", {})
                            raise Exception(f"执行错误: {error_data}")

            finally:
                await ws.close()

            # 6. 获取输出文件名
            log("获取输出文件...")
            await asyncio.sleep(0.5)

            # 获取输出节点 ID
            output_node_id = node_map.get("video_output", "61")

            for retry in range(3):
                history = await self._get_history(prompt_id)
                if prompt_id in history:
                    outputs = history[prompt_id].get("outputs", {})
                    # VHS_VideoCombine 的输出在 "gifs" 字段
                    video_output = outputs.get(output_node_id, {}).get("gifs", [])
                    # SaveVideo 的输出在 "images" 字段
                    if not video_output:
                        video_output = outputs.get(output_node_id, {}).get("images", [])
                    if video_output:
                        break
                log(f"重试 {retry + 1}/3: 等待历史记录...")
                await asyncio.sleep(1)
            else:
                raise Exception(f"未找到视频输出 (节点 {output_node_id})")

            video_info = video_output[0]
            video_filename = video_info.get("filename")
            video_subfolder = video_info.get("subfolder", "")
            log(
                f"输出文件: {video_subfolder}/{video_filename}"
                if video_subfolder
                else f"输出文件: {video_filename}"
            )

            if not video_filename:
                raise Exception("未找到视频文件名")

            # 7. 下载视频
            log("下载视频...")
            video_bytes = await self._download_video(video_filename, video_subfolder)

            # 8. 保存到本地
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(video_bytes)

            log(f"视频已保存: {output_path} ({len(video_bytes) / 1024 / 1024:.2f} MB)")

            return VideoGenResult(
                status=VideoGenStatus.DONE,
                video_path=output_path,
                duration_seconds=duration,
            )

        except Exception as e:
            log(f"错误: {e}")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=str(e),
            )


class Wan26VideoGenerator(VideoGeneratorBase):
    """阿里云 DashScope Wan2.6-i2v-flash 视频生成器。

    优势：
    - 时长灵活：2-15 秒，可根据 TTS 时长动态调整
    - 有声视频：audio=True，720P 约 0.3 元/秒，1080P 约 0.5 元/秒
    - 高质量：基于 Wan 2.6 模型

    支持两种模式：
    - 普通 I2V 模式（wan2.6-i2v-flash）：单帧输入，2-15 秒
    - 首尾帧模式（wan2.2-kf2v-flash）：首尾帧输入，固定 5 秒

    API 文档: https://www.alibabacloud.com/help/en/model-studio/image-to-video-api-reference

    示例:
        >>> generator = Wan26VideoGenerator()
        >>> # 普通 I2V 模式
        >>> result = await generator.generate(
        ...     image_path="frame.png",
        ...     prompt="character smiling and waving",
        ...     output_path="output.mp4",
        ...     duration=8.0,
        ... )
        >>> # 首尾帧模式
        >>> result = await generator.generate(
        ...     image_path="frame_start.png",
        ...     prompt="transition motion description",
        ...     output_path="output.mp4",
        ...     last_frame_path="frame_end.png",  # 启用首尾帧模式
        ... )
    """

    # 模型配置
    MODEL_I2V = "wan2.6-i2v-flash"  # 普通单帧模式
    MODEL_KF2V = "wan2.2-kf2v-flash"  # 首尾帧模式
    MODEL = MODEL_I2V  # 默认模型（向后兼容）
    MIN_DURATION = 2.0
    MAX_DURATION = 15.0  # API 限制 2-15 秒（仅普通模式）
    KF2V_DURATION = 5.0  # 首尾帧模式固定 5 秒
    DEFAULT_RESOLUTION = "720P"

    def __init__(
        self,
        api_key: Optional[str] = None,
        region: str = "cn",  # "cn" 或 "intl"
    ):
        """初始化 Wan2.6 生成器。

        Args:
            api_key: DashScope API Key（默认从环境变量读取）
            region: 区域，"cn" 为中国区，"intl" 为国际区（新加坡）
        """
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY")
        self.region = region

        if not self.api_key:
            raise ValueError("DASHSCOPE_API_KEY must be set for Wan2.6 video generation")

    async def _download_video(self, url: str, output_path: str, max_retries: int = 3) -> bool:
        """下载视频文件，失败自动重试。"""
        for attempt in range(1, max_retries + 1):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(url) as resp:
                        if resp.status != 200:
                            print(
                                f"[download] attempt {attempt}/{max_retries} failed: HTTP {resp.status}"
                            )
                            if attempt < max_retries:
                                await asyncio.sleep(2 * attempt)
                                continue
                            return False

                        os.makedirs(os.path.dirname(output_path), exist_ok=True)
                        with open(output_path, "wb") as f:
                            f.write(await resp.read())

                        return True
            except Exception as e:
                print(f"[download] attempt {attempt}/{max_retries} error: {e}")
                if attempt < max_retries:
                    await asyncio.sleep(2 * attempt)
        return False

    def _compress_image_for_upload(
        self,
        image_path: str,
        quality: int = 95,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> Optional[str]:
        """压缩图片为 JPEG 格式以减少上传时间。

        quality 默认 95：视频模型逐像素参考首帧，需保留足够细节。

        Args:
            image_path: 原始图片路径
            quality: JPEG 压缩质量 (1-100)
            on_log: 日志回调函数

        Returns:
            压缩后的临时文件路径，失败返回 None
        """
        try:
            from PIL import Image

            log = on_log or (lambda x: None)

            # 获取原始文件大小
            original_size = os.path.getsize(image_path)

            # 读取图片并转换为 RGB（JPEG 不支持 RGBA）
            img = Image.open(image_path)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            # 创建临时文件
            fd, temp_path = tempfile.mkstemp(suffix=".jpg")
            os.close(fd)

            # 保存为 JPEG
            img.save(temp_path, "JPEG", quality=quality, optimize=True)

            # 获取压缩后文件大小
            compressed_size = os.path.getsize(temp_path)

            # 格式化文件大小
            def format_size(size_bytes: int) -> str:
                if size_bytes >= 1024 * 1024:
                    return f"{size_bytes / (1024 * 1024):.1f}MB"
                elif size_bytes >= 1024:
                    return f"{size_bytes / 1024:.0f}KB"
                else:
                    return f"{size_bytes}B"

            log(f"图片压缩: {format_size(original_size)} → {format_size(compressed_size)}")

            return temp_path

        except Exception as e:
            if on_log:
                on_log(f"图片压缩失败，使用原图: {e}")
            return None

    async def generate(
        self,
        image_path: str,
        prompt: str,
        output_path: str,
        aspect_ratio: str = "9:16",
        duration: float = 5.0,
        poll_interval: float = 5.0,
        max_polls: int = 120,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        last_frame_path: Optional[str] = None,
        **kwargs,
    ) -> VideoGenResult:
        """完整生成流程：上传 + 提交 + 轮询 + 下载。

        Args:
            image_path: 首帧图像路径（本地路径或 URL）
            prompt: 动作描述
            output_path: 输出视频路径
            aspect_ratio: 宽高比（由输入图像决定）
            duration: 目标时长（普通模式 2-15 秒，首尾帧模式固定 5 秒）
            poll_interval: 轮询间隔（秒）
            max_polls: 最大轮询次数
            on_log: 日志回调函数
            on_progress: 进度回调函数 (0.0 - 1.0)
            last_frame_path: 尾帧图像路径（可选，提供时启用首尾帧模式）

        Returns:
            生成结果
        """

        def log(msg: str):
            if on_log:
                on_log(msg)

        def progress(value: float):
            if on_progress:
                on_progress(value)

        try:
            import dashscope
            from dashscope import VideoSynthesis
            from http import HTTPStatus
        except ImportError:
            log("错误: 请安装 dashscope SDK: pip install dashscope>=1.25.2")
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error="dashscope SDK not installed",
            )

        # 设置区域
        if self.region == "intl":
            dashscope.base_http_api_url = "https://dashscope-intl.aliyuncs.com/api/v1"

        # 判断是否使用首尾帧模式
        use_keyframe_mode = last_frame_path is not None

        if use_keyframe_mode:
            # 首尾帧模式：固定 5 秒
            duration = self.KF2V_DURATION
            model = self.MODEL_KF2V
            log(f"使用首尾帧模式 ({model})，固定时长 {duration:.0f}s")
        else:
            # 普通 I2V 模式：限制时长在有效范围内
            model = self.MODEL_I2V
            original_duration = duration
            duration = max(self.MIN_DURATION, min(duration, self.MAX_DURATION))
            if duration != original_duration:
                log(
                    f"时长已调整: {original_duration:.1f}s -> {duration:.1f}s (API 限制 {self.MIN_DURATION}-{self.MAX_DURATION}s)"
                )

        # 临时压缩文件列表，用于最后清理
        temp_files: list[str] = []

        # 1. 准备首帧图像 URL
        # DashScope 支持本地文件路径、URL 和 Base64
        if image_path.startswith(("http://", "https://")):
            image_url = image_path
        elif os.path.exists(image_path):
            # 本地文件 - 压缩后上传以节省带宽
            compressed_path = self._compress_image_for_upload(image_path, on_log=log)
            if compressed_path:
                image_url = compressed_path
                temp_files.append(compressed_path)
            else:
                image_url = image_path
            log(f"使用本地首帧: {image_path}")
        else:
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"First frame not found: {image_path}",
            )

        # 2. 如果是首尾帧模式，准备尾帧图像 URL
        last_frame_url = None
        if use_keyframe_mode:
            if last_frame_path.startswith(("http://", "https://")):
                last_frame_url = last_frame_path
            elif os.path.exists(last_frame_path):
                # 本地文件 - 压缩后上传以节省带宽
                compressed_path = self._compress_image_for_upload(last_frame_path, on_log=log)
                if compressed_path:
                    last_frame_url = compressed_path
                    temp_files.append(compressed_path)
                else:
                    last_frame_url = last_frame_path
                log(f"使用本地尾帧: {last_frame_path}")
            else:
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"Last frame not found: {last_frame_path}",
                )

        # 3. 提交任务
        mode_desc = f"首尾帧模式 ({model})" if use_keyframe_mode else f"I2V 模式 ({model})"
        log(f"正在提交视频生成任务 ({mode_desc}, {duration:.0f}s)...")
        progress(0.1)

        try:
            if use_keyframe_mode:
                # 首尾帧模式
                rsp = VideoSynthesis.async_call(
                    api_key=self.api_key,
                    model=model,
                    prompt=prompt,
                    first_frame_url=image_url,
                    last_frame_url=last_frame_url,
                    resolution=self.DEFAULT_RESOLUTION,
                    prompt_extend=True,
                    watermark=False,
                    audio=True,
                )
            else:
                # 普通 I2V 模式
                rsp = VideoSynthesis.async_call(
                    api_key=self.api_key,
                    model=model,
                    prompt=prompt,
                    img_url=image_url,
                    resolution=self.DEFAULT_RESOLUTION,
                    duration=int(duration),
                    prompt_extend=True,
                    watermark=False,
                    audio=True,
                )

            if rsp.status_code != 200:
                log(f"任务提交失败: {rsp.code} - {rsp.message}")
                for f in temp_files:
                    if os.path.exists(f):
                        os.remove(f)
                return VideoGenResult(
                    status=VideoGenStatus.FAILED,
                    error=f"Submit failed: {rsp.code} - {rsp.message}",
                )

            task_id = rsp.output.task_id
            log(f"任务已提交: {task_id}")

        except Exception as e:
            log(f"任务提交异常: {e}")
            for f in temp_files:
                if os.path.exists(f):
                    os.remove(f)
            return VideoGenResult(
                status=VideoGenStatus.FAILED,
                error=f"Submit exception: {e}",
            )

        # 3. 轮询结果
        progress(0.2)
        for poll_count in range(max_polls):
            try:
                rsp = VideoSynthesis.fetch(task=task_id, api_key=self.api_key)
            except Exception as e:
                log(f"查询状态异常: {e}")
                await asyncio.sleep(poll_interval)
                continue

            # 进度从 0.2 到 0.9
            poll_progress = 0.2 + (poll_count / max_polls) * 0.7
            progress(poll_progress)

            if rsp.status_code == HTTPStatus.OK:
                task_status = rsp.output.task_status

                if task_status == "SUCCEEDED":
                    log("视频生成完成，正在下载...")
                    progress(0.9)

                    # 4. 下载视频
                    video_url = rsp.output.video_url
                    if video_url:
                        success = await self._download_video(video_url, output_path)
                        if success:
                            log(f"视频已保存: {output_path}")
                            progress(1.0)
                            for f in temp_files:
                                if os.path.exists(f):
                                    os.remove(f)
                            return VideoGenResult(
                                status=VideoGenStatus.DONE,
                                video_path=output_path,
                                video_url=video_url,
                                task_id=task_id,
                                duration_seconds=duration,
                            )
                        else:
                            log("视频下载失败")
                            for f in temp_files:
                                if os.path.exists(f):
                                    os.remove(f)
                            return VideoGenResult(
                                status=VideoGenStatus.FAILED,
                                error="Download failed",
                                task_id=task_id,
                            )
                    else:
                        log("API 未返回视频 URL")
                        for f in temp_files:
                            if os.path.exists(f):
                                os.remove(f)
                        return VideoGenResult(
                            status=VideoGenStatus.FAILED,
                            error="No video URL in response",
                            task_id=task_id,
                        )

                elif task_status == "FAILED":
                    error_msg = getattr(rsp.output, "message", "Unknown error")
                    log(f"视频生成失败: {error_msg}")
                    for f in temp_files:
                        if os.path.exists(f):
                            os.remove(f)
                    return VideoGenResult(
                        status=VideoGenStatus.FAILED,
                        error=f"Generation failed: {error_msg}",
                        task_id=task_id,
                    )

                # PENDING, RUNNING - 继续轮询
                if poll_count % 6 == 0:  # 每 30 秒输出一次
                    log(f"正在生成中... ({task_status}, {poll_count}/{max_polls})")

            await asyncio.sleep(poll_interval)

        log("视频生成超时")
        for f in temp_files:
            if os.path.exists(f):
                os.remove(f)
        return VideoGenResult(
            status=VideoGenStatus.FAILED,
            error="Timeout waiting for video generation",
            task_id=task_id,
        )


NEWAPI_VIDEO_BACKEND_PREFIX = "newapi_"
NEWAPI_VIDEO_DISPLAY_LABELS = {
    "seedance-1.0-pro-fast": "Seedance1.0 Pro Fast",
    "seedance-1.5-pro": "Seedance1.5 Pro",
    "seedance-2.0": "Seedance2.0",
    "seedance-2.0-fast": "Seedance2.0 Fast",
    "seedance-2.0-value": "Seedance2.0 Value",
    "seedance-2.0-fast-value": "Seedance2.0 Fast Value",
    "happyhorse-1.0": "HappyHorse 1.0",
    "grok-video-channel": "Grok Video Channel",
}
NEWAPI_MAINLINE_SEEDANCE2_MODELS = (
    "seedance-2.0",
    "seedance-2.0-fast",
    "seedance-2.0-value",
    "seedance-2.0-fast-value",
)
NEWAPI_DISABLED_VIDEO_MODELS = {"grok-video-channel"}


def parse_newapi_video_backend(backend: str | None) -> str | None:
    value = str(backend or "").strip().lower()
    if value == "newapi":
        from novelvideo.config import NEWAPI_VIDEO_MODEL

        return NEWAPI_VIDEO_MODEL
    if value.startswith(NEWAPI_VIDEO_BACKEND_PREFIX):
        model = value[len(NEWAPI_VIDEO_BACKEND_PREFIX) :].strip()
        return model or None
    return None


def newapi_video_backend_options(*, include_seedance2_variants: bool = False) -> dict[str, str]:
    from novelvideo.config import NEWAPI_VIDEO_MODELS

    models = [model for model in NEWAPI_VIDEO_MODELS if model not in NEWAPI_DISABLED_VIDEO_MODELS]
    if include_seedance2_variants:
        for model in NEWAPI_MAINLINE_SEEDANCE2_MODELS:
            if model not in models:
                models.append(model)
    return {
        f"{NEWAPI_VIDEO_BACKEND_PREFIX}{model}": NEWAPI_VIDEO_DISPLAY_LABELS.get(model, model)
        for model in models
    }


def _coerce_video_backend_value(backend: VideoBackend | str | None) -> str:
    if backend is None:
        backend = os.environ.get("VIDEO_BACKEND", "comfyui")
    if isinstance(backend, VideoBackend):
        return backend.value
    value = str(backend).strip().lower()
    return "comfyui" if value == "jimeng" else value


def create_video_generator(
    backend: Optional[VideoBackend | str] = None,
    use_mock: bool = False,
    workflow_type: Optional[str] = None,
    **kwargs,
) -> VideoGeneratorBase:
    """创建视频生成器。

    Args:
        backend: 视频后端选择
            - newapi_<model>: newAPI 视频模型，如 newapi_seedance-1.0-pro-fast
            - huimeng_<model>: HuiMeng 视频模型，如 huimeng_seedance-2.0-fast
            - SEEDANCE_FAST: Seedance 1.0 Pro Fast（火山方舟）
            - SEEDANCE_PRO: Seedance 1.5 Pro 有声（火山方舟）
            - SEEDANCE_PRO_SILENT: Seedance 1.5 Pro 无声（火山方舟）
            - COMFYUI: Claymore 1.0 本地服务
            - WAN26: 阿里云 DashScope Wan2.6-i2v-flash
            - GROK_720: xAI Grok Imagine Video 720p
        use_mock: 兼容旧接口，True 时使用 MockVideoGenerator
        workflow_type: ComfyUI 工作流类型 ("gguf" 或 "fp8")，默认从环境变量读取
        **kwargs: 传递给具体生成器的参数

    Returns:
        视频生成器实例

    环境变量:
        VIDEO_BACKEND: 默认后端
            (newapi_seedance-1.0-pro-fast/huimeng_seedance-2.0-fast/comfyui/...)
        HUIMENGI_API_KEY: HuiMeng API 密钥
        COMFYUI_WORKFLOW: ComfyUI 工作流类型 (gguf/fp8)
        DASHSCOPE_API_KEY: Wan2.6 API 密钥
        VOLCENGINE_VISUAL_API_KEY: Seedance API 密钥
        COMFYUI_ADDRESS: ComfyUI 服务器地址
        XAI_API_KEY: Grok 视频生成 API 密钥
    """
    from novelvideo.config import SEEDANCE_FAST_MODEL, SEEDANCE_PRO_MODEL

    # 兼容旧接口
    if use_mock:
        return MockVideoGenerator(**kwargs)

    backend_str = _coerce_video_backend_value(backend)
    newapi_model = parse_newapi_video_backend(backend_str)
    if newapi_model:
        return NewApiVideoGenerator(model=newapi_model, **kwargs)

    from novelvideo.generators.huimengi import parse_huimeng_video_backend

    huimeng_model = parse_huimeng_video_backend(backend_str)
    if huimeng_model:
        return HuimengVideoGenerator(model=huimeng_model, **kwargs)

    try:
        backend_enum = VideoBackend(backend_str)
    except ValueError:
        if backend is None:
            backend_enum = VideoBackend.COMFYUI
        else:
            raise ValueError(f"Unknown video backend: {backend_str}") from None

    # 创建对应的生成器
    if backend_enum == VideoBackend.SEEDANCE_FAST:
        return SeedanceVideoGenerator(model=SEEDANCE_FAST_MODEL, generate_audio=False, **kwargs)
    elif backend_enum == VideoBackend.SEEDANCE_PRO:
        return SeedanceVideoGenerator(model=SEEDANCE_PRO_MODEL, generate_audio=True, **kwargs)
    elif backend_enum == VideoBackend.SEEDANCE_PRO_SILENT:
        return SeedanceVideoGenerator(model=SEEDANCE_PRO_MODEL, generate_audio=False, **kwargs)
    elif backend_enum == VideoBackend.COMFYUI:
        # 从环境变量读取工作流类型
        if workflow_type is None:
            workflow_type = os.environ.get("COMFYUI_WORKFLOW", "gguf")
        return ComfyUIVideoGenerator(workflow_type=workflow_type, **kwargs)
    elif backend_enum == VideoBackend.SEEDANCE_2:
        return Seedance2VideoGenerator(**kwargs)
    elif backend_enum == VideoBackend.LTX23:
        return ComfyUIVideoGenerator(workflow_type="ltx23", **kwargs)
    elif backend_enum == VideoBackend.WAN26:
        return Wan26VideoGenerator(**kwargs)
    elif backend_enum == VideoBackend.GROK_720:
        return GrokVideoGenerator(**kwargs)
    else:
        raise ValueError(f"Unknown video backend: {backend_str}")
