"""局部验证：单 beat 草图/首帧事实核查。"""

import logging
from pathlib import Path
import time
from typing import Any

from pydantic_ai import Agent, BinaryContent

from novelvideo.models import beat_scene_id
from novelvideo.utils.asset_resolver import AssetResolver

from .models import VerificationResult
from .prompts import SKETCH_VERIFY_PROMPT
from .sanitize import sanitize_prompt_input
from .utils import compress_image

logger = logging.getLogger(__name__)


def resolve_verification_scene_context(
    project_dir: str | Path,
    beat: dict[str, Any],
    *,
    episode_number: int | None = None,
    scenes: list[Any] | tuple[Any, ...] | None = None,
) -> dict[str, Any]:
    """Resolve scene context for verification without making the verifier parse assets."""

    refs = AssetResolver(
        Path(project_dir),
        episode_number=episode_number,
        scenes=scenes or [],
    ).resolve_scenes_for_beat(beat)
    primary_ref = refs[0] if refs else None
    return {
        "scene_id": beat_scene_id(beat) or str(beat.get("location", "") or "").strip(),
        "resolved_scene_name": str(getattr(primary_ref, "base_id", "") or "").strip(),
        "time_baked": bool(getattr(primary_ref, "time_baked", False)),
        "prompt_time_of_day": str(beat.get("time_of_day", "") or "").strip(),
    }


class ImageVerifier:
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
                system_prompt=SKETCH_VERIFY_PROMPT,
                output_type=VerificationResult,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="草图验证员",
            )
        return self._agent

    async def verify_sketch(
        self,
        image_path: str,
        visual_prompt: str,
        named_characters: list[str],
        scene_id: str,
        time_of_day: str = "",
        camera_context: str = "",
        color_mapping: dict[str, str] | None = None,
        resolved_scene_name: str = "",
        time_baked: bool = False,
        prompt_time_of_day: str = "",
    ) -> VerificationResult:
        """验证草图是否匹配描述。

        Args:
            image_path: 草图文件路径
            visual_prompt: beat 的 visual_description 字段
            named_characters: {{}} 标记中提取的角色名列表
            scene_id: beat 的基础场景 ID
            time_of_day: beat 的目标时间信息，用于光线矛盾检查
            camera_context: 镜头参考信息（来自 keyframe_prompt 或 video_prompt）
            resolved_scene_name: 实际解析到的场景/plate 名称
            time_baked: True 表示命中的是已烘焙时间版场景图，应该锁图光
            prompt_time_of_day: 实际用于提示/验证的目标时间；为空时回退 time_of_day
        """
        safe_visual = sanitize_prompt_input(visual_prompt)
        safe_scene_id = sanitize_prompt_input(scene_id)
        safe_resolved_scene = sanitize_prompt_input(resolved_scene_name)
        safe_time = sanitize_prompt_input(prompt_time_of_day or time_of_day)
        resolved_scene_line = (
            f"\n解析场景: {safe_resolved_scene}" if safe_resolved_scene else ""
        )
        if safe_time and time_baked:
            time_line = (
                f"\n时间: {safe_time}"
                f"\n时间/光线验证: 已命中烘焙时间版场景图，锁定该图自带的{safe_time}光照；"
                "不要要求额外 relight，只在画面明显不是该时间光照时报告矛盾。"
            )
        elif safe_time:
            time_line = (
                f"\n时间: {safe_time}"
                f"\n时间/光线验证: 当前场景图不是烘焙时间版，画面应通过生成/relight 呈现{safe_time}。"
            )
        else:
            time_line = "\n时间/光线验证: 未指定 time_of_day，跳过时间/光线矛盾检查。"
        chars_text = f"已知命名角色: {', '.join(named_characters)}（共{len(named_characters)}人）" if named_characters else "已知命名角色: 无"
        camera_line = f"\n镜头参考: {sanitize_prompt_input(camera_context)}" if camera_context else ""
        color_line = ""
        if color_mapping:
            lines = []
            for identity_id, color_str in sorted(color_mapping.items()):
                parts = color_str.split(" ", 1)
                hex_code = parts[0]
                color_name = parts[1] if len(parts) > 1 else ""
                lines.append(f"- {color_name} ({hex_code}) = {identity_id}")
            if lines:
                color_line = "\n角色颜色标记:\n" + "\n".join(lines)
        task = (
            f"验证草图是否匹配以下描述:\n"
            f"画面描述: {safe_visual}\n"
            f"{chars_text}\n"
            f"请根据画面描述自行判断应该出现多少人物（可能多于已知命名角色数）。\n"
            f"场景: {safe_scene_id}{resolved_scene_line}{time_line}{camera_line}{color_line}\n"
            f"注意：描述中提到的'对方'、'他'、'她'可能是画外角色，不要求出现在画面中。"
        )
        image_bytes = compress_image(image_path)
        agent = self._get_agent()
        start = time.monotonic()
        result = await agent.run(
            [task, BinaryContent(data=image_bytes, media_type="image/jpeg")]
        )
        elapsed = time.monotonic() - start
        logger.info(
            "Sketch verify: score=%.1f passed=%s elapsed=%.1fs",
            result.output.score, result.output.passed, elapsed,
        )
        return result.output
