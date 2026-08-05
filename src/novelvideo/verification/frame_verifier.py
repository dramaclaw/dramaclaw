"""首帧渲染质量验证：对比草图与高清首帧，检测畸变/丢失/风格偏移。"""

import logging
import time

from pydantic_ai import Agent, BinaryContent

from .models import VerificationResult
from .prompts import FRAME_VERIFY_PROMPT
from .sanitize import sanitize_prompt_input
from .utils import compress_image

logger = logging.getLogger(__name__)


class FrameVerifier:
    """首帧渲染质量验证。"""

    def __init__(self):
        self._agent: Agent | None = None

    def _get_agent(self) -> Agent:
        if self._agent is None:
            from novelvideo.config import (
                get_newapi_structured_output_model_settings,
                get_pydantic_model,
            )

            self._agent = Agent(
                get_pydantic_model(),
                system_prompt=FRAME_VERIFY_PROMPT,
                output_type=VerificationResult,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="首帧质量审核员",
            )
        return self._agent

    async def verify_frame(
        self,
        frame_path: str,
        sketch_path: str,
        visual_description: str,
        project_style: str = "",
    ) -> VerificationResult:
        """验证首帧渲染质量。

        Args:
            frame_path: 首帧（高清渲染）文件路径
            sketch_path: 对应草图（线稿）文件路径，用于对比
            visual_description: beat 的 visual_description 字段
            project_style: 项目视觉风格（如 realistic, anime 等）
        """
        safe_desc = sanitize_prompt_input(visual_description)
        safe_style = sanitize_prompt_input(project_style)
        style_line = f"\n项目视觉风格: {safe_style}" if safe_style else ""
        task = (
            f"验证首帧渲染质量。\n"
            f"画面描述: {safe_desc}{style_line}\n\n"
            f"以下两张图：第一张是草图（内容参考），第二张是首帧（检查目标）。"
        )

        try:
            sketch_bytes = compress_image(sketch_path)
            frame_bytes = compress_image(frame_path)
        except (FileNotFoundError, OSError) as e:
            raise FileNotFoundError(f"Image file error: {e}") from e
        except Exception as e:
            raise ValueError(f"Image compression failed: {e}") from e

        agent = self._get_agent()
        start = time.monotonic()
        result = await agent.run([
            task,
            BinaryContent(data=sketch_bytes, media_type="image/jpeg"),
            BinaryContent(data=frame_bytes, media_type="image/jpeg"),
        ])
        elapsed = time.monotonic() - start
        logger.info(
            "Frame verify: score=%.1f passed=%s elapsed=%.1fs",
            result.output.score, result.output.passed, elapsed,
        )
        return result.output
