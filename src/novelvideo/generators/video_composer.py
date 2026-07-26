"""视频合成模块。

使用 FFmpeg + MoviePy 生成视频。
"""

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

from novelvideo.config import get_video_config
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut
from novelvideo.task_backend.subprocesses import run_project_subprocess


def _run_video_subprocess(cmd: list[str], *, timeout: int = 30 * 60) -> subprocess.CompletedProcess:
    return run_project_subprocess(cmd, capture_output=True, text=True, timeout=timeout)


def normalize_video_title(title: str) -> str:
    """Collapse generated titles to one line for filenames and ffmpeg drawtext."""
    normalized = re.sub(r"\s+", " ", str(title or "")).strip()
    return normalized or "untitled"


def _drawtext_fontfile_arg() -> str:
    for path in (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if os.path.exists(path):
            return f":fontfile={path}"
    return ""


class SceneAsset(BaseModel):
    """场景素材。"""

    scene_number: int
    image_path: str
    audio_path: str
    video_path: Optional[str] = None
    subtitle_path: Optional[str] = None
    duration_seconds: float = 0.0
    narration_text: str = ""


class VideoResult(BaseModel):
    """视频生成结果。"""

    success: bool
    video_path: Optional[str] = None
    duration_seconds: float = 0.0
    error: Optional[str] = None


class KenBurnsEffect:
    """Ken Burns 效果配置。"""

    ZOOM_IN = "zoom_in"
    ZOOM_OUT = "zoom_out"
    PAN_LEFT = "pan_left"
    PAN_RIGHT = "pan_right"
    PAN_UP = "pan_up"
    PAN_DOWN = "pan_down"

    @staticmethod
    def get_ffmpeg_filter(effect: str, duration: float, width: int, height: int) -> str:
        """获取 FFmpeg 滤镜字符串。

        Args:
            effect: 效果类型
            duration: 时长（秒）
            width: 输出宽度
            height: 输出高度

        Returns:
            FFmpeg 滤镜字符串
        """
        # 计算帧数
        fps = 30
        frames = int(duration * fps)

        if effect == KenBurnsEffect.ZOOM_IN:
            # 从 100% 缩放到 120%
            return (
                f"scale=8000:-1,"
                f"zoompan=z='min(zoom+0.001,1.2)':d={frames}:x='iw/2-(iw/zoom/2)':"
                f"y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        elif effect == KenBurnsEffect.ZOOM_OUT:
            # 从 120% 缩放到 100%
            return (
                f"scale=8000:-1,"
                f"zoompan=z='if(lte(zoom,1.0),1.2,max(1.001,zoom-0.001))':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        elif effect == KenBurnsEffect.PAN_LEFT:
            return (
                f"scale=8000:-1,"
                f"zoompan=z=1.1:d={frames}:x='iw/2-(iw/zoom/2)+{duration}*10':"
                f"y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        elif effect == KenBurnsEffect.PAN_RIGHT:
            return (
                f"scale=8000:-1,"
                f"zoompan=z=1.1:d={frames}:x='iw/2-(iw/zoom/2)-{duration}*10':"
                f"y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        else:
            # 默认：静态显示
            return f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"


class VideoComposer:
    """视频合成器。

    将图像、音频、字幕合成为视频。

    示例:
        >>> composer = VideoComposer()
        >>> result = await composer.compose_episode(
        ...     scenes=scenes,
        ...     output_path="output/ep01.mp4",
        ...     title="第一集"
        ... )
    """

    def __init__(
        self,
        width: Optional[int] = None,
        height: Optional[int] = None,
        fps: Optional[int] = None,
    ):
        """初始化合成器。

        Args:
            width: 视频宽度
            height: 视频高度
            fps: 帧率
        """
        config = get_video_config()
        self.width = width or config["width"]
        self.height = height or config["height"]
        self.fps = fps or config["fps"]
        self.codec = config["codec"]
        self.audio_codec = config["audio_codec"]
        self.bitrate = config["bitrate"]

    async def compose_episode(
        self,
        scenes: list[SceneAsset],
        output_path: str,
        title: Optional[str] = None,
        add_title_card: bool = True,
        add_end_card: bool = True,
        ken_burns: bool = True,
    ) -> VideoResult:
        """合成单集视频。

        Args:
            scenes: 场景素材列表
            output_path: 输出路径
            title: 标题（用于片头）
            add_title_card: 是否添加片头
            add_end_card: 是否添加片尾
            ken_burns: 是否使用 Ken Burns 效果

        Returns:
            合成结果
        """
        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # 创建临时目录
            with tempfile.TemporaryDirectory() as temp_dir:
                scene_videos = []

                # 为每个场景创建视频片段
                for i, scene in enumerate(scenes):
                    scene_video = os.path.join(temp_dir, f"scene_{i:03d}.mp4")

                    # 选择 Ken Burns 效果
                    effect = None
                    if ken_burns:
                        effects = [
                            KenBurnsEffect.ZOOM_IN,
                            KenBurnsEffect.ZOOM_OUT,
                            KenBurnsEffect.PAN_LEFT,
                            KenBurnsEffect.PAN_RIGHT,
                        ]
                        effect = effects[i % len(effects)]

                    # 创建场景视频
                    success = await self._create_scene_video(
                        scene=scene,
                        output_path=scene_video,
                        effect=effect,
                    )

                    if success:
                        scene_videos.append(scene_video)

                # 添加片头
                if add_title_card and title:
                    title_video = os.path.join(temp_dir, "title.mp4")
                    if not await self._create_title_card(normalize_video_title(title), title_video):
                        return VideoResult(success=False, error="failed to create title card")
                    scene_videos.insert(0, title_video)

                # 添加片尾
                if add_end_card:
                    end_video = os.path.join(temp_dir, "end.mp4")
                    if not await self._create_end_card(end_video):
                        return VideoResult(success=False, error="failed to create end card")
                    scene_videos.append(end_video)

                # 合并所有片段
                if not scene_videos:
                    return VideoResult(success=False, error="no scene videos were created")
                if not await self._concat_videos(scene_videos, output_path):
                    return VideoResult(success=False, error="failed to concatenate scene videos")
                if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 0:
                    return VideoResult(success=False, error="output file was not created")

                # 计算总时长
                total_duration = sum(s.duration_seconds for s in scenes)
                if add_title_card:
                    total_duration += 3.0  # 片头 3 秒
                if add_end_card:
                    total_duration += 2.0  # 片尾 2 秒

                return VideoResult(
                    success=True,
                    video_path=output_path,
                    duration_seconds=total_duration,
                )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            return VideoResult(
                success=False,
                error=str(e),
            )

    async def _create_scene_video(
        self,
        scene: SceneAsset,
        output_path: str,
        effect: Optional[str] = None,
    ) -> bool:
        """创建单个场景的视频。

        Args:
            scene: 场景素材
            output_path: 输出路径
            effect: Ken Burns 效果

        Returns:
            是否成功
        """
        try:
            # 构建 FFmpeg 命令
            if effect:
                video_filter = KenBurnsEffect.get_ffmpeg_filter(
                    effect, scene.duration_seconds, self.width, self.height
                )
            else:
                video_filter = (
                    f"scale={self.width}:{self.height}:force_original_aspect_ratio=decrease,"
                    f"pad={self.width}:{self.height}:(ow-iw)/2:(oh-ih)/2"
                )

            cmd = [
                "ffmpeg",
                "-y",
                "-loop",
                "1",
                "-i",
                scene.image_path,
                "-i",
                scene.audio_path,
                "-vf",
                video_filter,
                "-c:v",
                self.codec,
                "-c:a",
                self.audio_codec,
                "-b:v",
                self.bitrate,
                "-pix_fmt",
                "yuv420p",
                "-shortest",
                output_path,
            ]

            result = _run_video_subprocess(cmd)
            return result.returncode == 0

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            print(f"Failed to create scene video: {e}")
            return False

    async def _create_title_card(self, title: str, output_path: str) -> bool:
        """创建片头。

        Args:
            title: 标题文本
            output_path: 输出路径

        Returns:
            是否成功
        """
        try:
            # 使用 FFmpeg 创建带文字的片头
            duration = 3.0
            text_file = output_path + ".title.txt"
            Path(text_file).write_text(normalize_video_title(title), encoding="utf-8")

            cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c=black:s={self.width}x{self.height}:d={duration}",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r=44100:cl=stereo:d={duration}",
                "-vf",
                f"drawtext=textfile={text_file}:fontcolor=white:fontsize=72:"
                f"x=(w-text_w)/2:y=(h-text_h)/2{_drawtext_fontfile_arg()}",
                "-c:v",
                self.codec,
                "-c:a",
                self.audio_codec,
                "-pix_fmt",
                "yuv420p",
                output_path,
            ]

            result = _run_video_subprocess(cmd)
            if result.returncode == 0:
                return True
            return self._create_blank_card(duration, output_path)

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return False
        finally:
            try:
                os.unlink(text_file)
            except Exception:
                pass

    async def _create_end_card(self, output_path: str) -> bool:
        """创建片尾。

        Args:
            output_path: 输出路径

        Returns:
            是否成功
        """
        try:
            duration = 2.0
            text_file = output_path + ".end.txt"
            Path(text_file).write_text("敬请期待下集", encoding="utf-8")

            cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c=black:s={self.width}x{self.height}:d={duration}",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r=44100:cl=stereo:d={duration}",
                "-vf",
                f"drawtext=textfile={text_file}:fontcolor=white:fontsize=48:"
                f"x=(w-text_w)/2:y=(h-text_h)/2{_drawtext_fontfile_arg()}",
                "-c:v",
                self.codec,
                "-c:a",
                self.audio_codec,
                "-pix_fmt",
                "yuv420p",
                output_path,
            ]

            result = _run_video_subprocess(cmd)
            if result.returncode == 0:
                return True
            return self._create_blank_card(duration, output_path)

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return False
        finally:
            try:
                os.unlink(text_file)
            except Exception:
                pass

    def _create_blank_card(self, duration: float, output_path: str) -> bool:
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s={self.width}x{self.height}:d={duration}",
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r=44100:cl=stereo:d={duration}",
            "-c:v",
            self.codec,
            "-c:a",
            self.audio_codec,
            "-pix_fmt",
            "yuv420p",
            output_path,
        ]
        result = _run_video_subprocess(cmd)
        return result.returncode == 0

    async def _concat_videos(self, video_paths: list[str], output_path: str) -> bool:
        """合并多个视频。

        Args:
            video_paths: 视频路径列表
            output_path: 输出路径

        Returns:
            是否成功
        """
        try:
            # 创建文件列表
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".txt", delete=False
            ) as f:
                for path in video_paths:
                    f.write(f"file '{path}'\n")
                list_file = f.name

            try:
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    list_file,
                    "-c",
                    "copy",
                    output_path,
                ]

                result = _run_video_subprocess(cmd)
                return result.returncode == 0

            finally:
                os.unlink(list_file)

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            print(f"Failed to concatenate videos: {e}")
            return False

    async def add_subtitles(
        self,
        video_path: str,
        subtitle_path: str,
        output_path: str,
        style: str = "FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2",
    ) -> VideoResult:
        """为视频添加字幕。

        Args:
            video_path: 视频路径
            subtitle_path: 字幕路径（.srt 或 .vtt）
            output_path: 输出路径
            style: 字幕样式

        Returns:
            处理结果
        """
        try:
            # 转换 VTT 到 ASS 格式（如果需要）
            if subtitle_path.endswith(".vtt"):
                ass_path = subtitle_path.rsplit(".", 1)[0] + ".ass"
                await self._vtt_to_ass(subtitle_path, ass_path)
                subtitle_path = ass_path

            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                video_path,
                "-vf",
                f"subtitles={subtitle_path}:force_style='{style}'",
                "-c:a",
                "copy",
                output_path,
            ]

            result = _run_video_subprocess(cmd)

            if result.returncode == 0:
                return VideoResult(
                    success=True,
                    video_path=output_path,
                )
            else:
                return VideoResult(
                    success=False,
                    error=result.stderr,
                )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            return VideoResult(
                success=False,
                error=str(e),
            )

    async def _vtt_to_ass(self, vtt_path: str, ass_path: str) -> bool:
        """将 VTT 转换为 ASS 格式。"""
        try:
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                vtt_path,
                ass_path,
            ]
            result = _run_video_subprocess(cmd)
            return result.returncode == 0
        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return False


class MoviePyComposer:
    """使用 MoviePy 的视频合成器。

    提供更灵活的视频编辑能力。
    """

    def __init__(
        self,
        width: int = 1920,
        height: int = 1080,
        fps: int = 30,
    ):
        """初始化合成器。"""
        self.width = width
        self.height = height
        self.fps = fps

    async def compose_episode(
        self,
        scenes: list[SceneAsset],
        output_path: str,
        title: Optional[str] = None,
    ) -> VideoResult:
        """使用 MoviePy 合成视频。"""
        try:
            from moviepy.editor import (
                AudioFileClip,
                CompositeVideoClip,
                ImageClip,
                TextClip,
                concatenate_videoclips,
            )
        except ImportError:
            return VideoResult(
                success=False,
                error="moviepy not installed. Run: pip install moviepy",
            )

        try:
            clips = []

            # 添加片头
            if title:
                title_clip = (
                    TextClip(
                        title,
                        fontsize=72,
                        color="white",
                        bg_color="black",
                        size=(self.width, self.height),
                        method="caption",
                    )
                    .set_duration(3)
                    .set_fps(self.fps)
                )
                clips.append(title_clip)

            # 处理每个场景
            for scene in scenes:
                # 加载图片
                img_clip = (
                    ImageClip(scene.image_path)
                    .set_duration(scene.duration_seconds)
                    .resize((self.width, self.height))
                )

                # 加载音频
                audio_clip = AudioFileClip(scene.audio_path)

                # 组合
                video_clip = img_clip.set_audio(audio_clip)
                clips.append(video_clip)

            # 添加片尾
            end_clip = (
                TextClip(
                    "敬请期待下集",
                    fontsize=48,
                    color="white",
                    bg_color="black",
                    size=(self.width, self.height),
                    method="caption",
                )
                .set_duration(2)
                .set_fps(self.fps)
            )
            clips.append(end_clip)

            # 合并
            final_clip = concatenate_videoclips(clips, method="compose")

            # 导出
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            final_clip.write_videofile(
                output_path,
                fps=self.fps,
                codec="libx264",
                audio_codec="aac",
            )

            # 清理
            final_clip.close()
            for clip in clips:
                clip.close()

            return VideoResult(
                success=True,
                video_path=output_path,
                duration_seconds=final_clip.duration,
            )

        except Exception as e:
            return VideoResult(
                success=False,
                error=str(e),
            )


def create_video_composer(use_moviepy: bool = False):
    """创建视频合成器。

    Args:
        use_moviepy: 是否使用 MoviePy（否则使用 FFmpeg）

    Returns:
        视频合成器实例
    """
    if use_moviepy:
        return MoviePyComposer()

    return VideoComposer()


async def adjust_video_duration(
    video_path: str,
    target_duration: float,
    output_path: Optional[str] = None,
    method: str = "auto",
) -> str:
    """调整视频时长到目标值。

    用于首尾帧模式生成的固定 5 秒视频适配实际 TTS 时长。

    策略：
    - 目标 < 源时长：裁剪末尾
    - 目标 > 源时长：
        - 变速拉伸（最多 1.5x，避免明显失真）
        - 超过 1.5x 时冻结最后一帧填充

    Args:
        video_path: 源视频路径
        target_duration: 目标时长（秒）
        output_path: 输出路径（默认覆盖源文件）
        method: 调整方法
            - "auto": 自动选择最佳方法
            - "trim": 只裁剪（目标较短时）
            - "speed": 只变速（目标较长时）
            - "freeze": 冻结最后一帧填充（目标较长时）

    Returns:
        输出视频路径
    """
    if output_path is None:
        # 使用临时文件然后覆盖
        import tempfile
        temp_fd, temp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(temp_fd)
        output_path = temp_path
        should_replace = True
    else:
        should_replace = False

    # 获取源视频时长
    probe_cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    result = _run_video_subprocess(probe_cmd, timeout=60)
    try:
        source_duration = float(result.stdout.strip())
    except ValueError:
        source_duration = 5.0  # 默认 5 秒

    print(f"[adjust_video_duration] source duration: {source_duration:.2f}s, target: {target_duration:.2f}s")

    # 计算时长差异
    duration_diff = abs(target_duration - source_duration)
    if duration_diff < 0.1:
        # 时长足够接近，无需调整
        print("[adjust_video_duration] durations close enough, no adjustment needed")
        return video_path

    if target_duration < source_duration:
        # 目标较短：裁剪末尾
        print(f"[adjust_video_duration] Trimming video: {source_duration:.2f}s -> {target_duration:.2f}s")
        cmd = [
            "ffmpeg",
            "-y",
            "-i", video_path,
            "-t", str(target_duration),
            "-c:v", "copy",
            "-c:a", "copy",
            output_path,
        ]
    else:
        # 目标较长：需要拉伸
        stretch_ratio = target_duration / source_duration
        print(f"[adjust_video_duration] stretch ratio: {stretch_ratio:.2f}x")

        if stretch_ratio <= 1.5 or method == "speed":
            # 变速拉伸（减慢播放）
            # setpts: 视频时间戳，atempo: 音频速度
            speed_factor = 1 / stretch_ratio  # 0.5 = 慢 2 倍
            print(f"[adjust_video_duration] Speed stretch: {speed_factor:.2f}x speed")
            cmd = [
                "ffmpeg",
                "-y",
                "-i", video_path,
                "-filter_complex",
                f"[0:v]setpts={stretch_ratio}*PTS[v];[0:a]atempo={speed_factor}[a]",
                "-map", "[v]",
                "-map", "[a]",
                "-c:v", "libx264",
                "-preset", "fast",
                "-c:a", "aac",
                output_path,
            ]
        else:
            # 冻结最后一帧填充
            freeze_duration = target_duration - source_duration
            print(f"[adjust_video_duration] Freezing last frame: {freeze_duration:.2f}s")

            # 使用 tpad 滤镜冻结最后一帧
            freeze_frames = int(freeze_duration * 30)  # 假设 30fps
            cmd = [
                "ffmpeg",
                "-y",
                "-i", video_path,
                "-vf", f"tpad=stop_mode=clone:stop_duration={freeze_duration}",
                "-c:v", "libx264",
                "-preset", "fast",
                "-c:a", "aac",
                output_path,
            ]

    # 执行命令
    result = _run_video_subprocess(cmd)

    if result.returncode != 0:
        print(f"[adjust_video_duration] FFmpeg error: {result.stderr[:500]}")
        return video_path  # 失败时返回原视频

    # 如果需要覆盖源文件
    if should_replace:
        import shutil
        shutil.move(output_path, video_path)
        return video_path

    return output_path


def get_video_duration(video_path: str) -> float:
    """获取视频时长。

    Args:
        video_path: 视频文件路径

    Returns:
        时长（秒）
    """
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    result = _run_video_subprocess(cmd, timeout=60)
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0
