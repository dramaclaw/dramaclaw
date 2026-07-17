"""首尾帧过渡提示词生成 Agent。

分析两帧之间的差异，生成描述过渡动作的提示词。
用于 wan2.2-kf2v-flash 首尾帧视频生成模型。
"""

import io
import os
from typing import Optional

from pydantic_ai import Agent, BinaryContent
from PIL import Image as PILImage

from novelvideo.utils.logging import log_agent_start, log_agent_end


# 首尾帧过渡提示词生成器指令（英文版 SuperPower）
KEYFRAME_PROMPT_BUILDER_INSTRUCTIONS_EN = """# Cinematic Transition Director (SuperPower)

You craft 5-second transitions between two keyframes. The AI video model interpolates between them; your prompt guides the cinematic journey.

## Input
- Image 1: first frame (starting point)
- Image 2: last frame (ending point)
- Narration: story context and intent

## Prompt Formula
[Camera Movement with displacement] + [Character/Object Transition] + [Audio Layer]

## MUST
✓ Write in **Chinese (中文) only**, **present tense** throughout
✓ 4–6 句（~50–90 字）
✓ Describe the *journey* between frames, not just start/end
✓ Use visible elements from both frames as anchors

## Camera
- Every prompt MUST include a camera direction with displacement or zoom (push-in, dolly, pan, tilt, track, crane, orbit, zoom)
- **BANNED static camera**: holds, stays, remains, static, locked, fixed
- Describe the camera endpoint: what the frame looks like when camera motion finishes

## BANNED
❌ Character names → use visual features ("the woman in black", "the older man")
❌ Abstract emotion labels (sad, haunting, desperate, hopeful, anxious, melancholy) → show via body language
❌ Non-visual senses (smell, temperature, humidity, taste, tactile)
❌ Static primary verbs (freezes, stares, stands, waits, remains, holds still) as main action
❌ Reversing or oscillating motion (steps forward then back, leans in then pulls away, nods then shakes head)
❌ Inventing elements absent from both frames
❌ Multiple conflicting camera movements simultaneously

## Audio Layer (superset — works on audio-capable models, ignored by others)
- Add ONE short ambient sound sentence
- For dialogue beats, also specify voice style (calm, urgent, whisper, etc.)

## Detail ↔ Shot Scale
- Close-up → micro details (pores, thread count, iris dilation)
- Wide shot → broad motion arcs and spatial relationships

## Sustained Motion
The clip is ~5 seconds. Describe a **chain of 2–3 connected actions** that bridge first frame to last frame continuously.
⚠️ **UNIDIRECTIONAL motion only**: every action must move in ONE direction — forward, never back. If the primary action is short, extend it with follow-through motion in the SAME direction.

## Output
Output ONLY the transition prompt in Chinese. 4–6 句, ~50–90 字.
"""

def create_keyframe_prompt_builder_agent(language: str = "en") -> Agent:
    """创建首尾帧过渡提示词生成 Agent。"""
    from novelvideo.config import get_newapi_text_pydantic_model
    from novelvideo.official_defaults import DEFAULT_VIDEO_PROMPT_OPTIMIZER_MODEL

    model = get_newapi_text_pydantic_model(
        "KEYFRAME_PROMPT_MODEL",
        DEFAULT_VIDEO_PROMPT_OPTIMIZER_MODEL,
    )
    return Agent(model, system_prompt=KEYFRAME_PROMPT_BUILDER_INSTRUCTIONS_EN, output_type=str, name="Keyframe Prompt Builder")


class KeyframePromptBuilder:
    """首尾帧过渡提示词构建器。

    分析两帧之间的差异，生成描述过渡动作的提示词。
    支持多模态输入：同时分析首帧和尾帧图片。

    示例:
        >>> builder = KeyframePromptBuilder()
        >>> prompt = await builder.build(
        ...     first_frame_path="beat_04.png",
        ...     last_frame_path="beat_05.png",
        ...     narration="那熟悉的侧颜，让我的心猛地一颤",
        ... )
    """

    def __init__(self):
        self._agents: dict[str, Agent] = {}  # 按语言缓存 agent
        self._last_context: str = ""  # 存储上一次生成的上下文

    @property
    def last_context(self) -> str:
        """返回上一次生成提示词时使用的上下文。"""
        return self._last_context

    def _get_agent(self, language: str = "en") -> Agent:
        """获取指定语言的 Agent（懒加载）。"""
        if language not in self._agents:
            self._agents[language] = create_keyframe_prompt_builder_agent(language)
        return self._agents[language]

    def _compress_image(self, image_path: str, compress_quality: int = 60) -> bytes:
        """压缩图片并返回 bytes。

        Args:
            image_path: 图片文件路径
            compress_quality: JPEG 压缩质量 (1-100)

        Returns:
            压缩后的图片字节
        """
        img = PILImage.open(image_path)
        original_size = os.path.getsize(image_path)

        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')

        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=compress_quality, optimize=True)
        image_bytes = buffer.getvalue()

        compressed_size = len(image_bytes)
        ratio = (1 - compressed_size / original_size) * 100
        print(
            f"[KeyframePromptBuilder] 压缩图片: {os.path.basename(image_path)}: "
            f"{original_size/1024:.0f}KB → {compressed_size/1024:.0f}KB "
            f"({ratio:.0f}% 压缩)"
        )

        return image_bytes

    async def build(
        self,
        first_frame_path: str,
        last_frame_path: str,
        narration: str,
        next_narration: str = "",
        language: str = "en",
        color_map_text: str = "",
        visual_description: str = "",
        next_visual_description: str = "",
        audio_type: str = "narration",
        dialogue_line: str = "",
    ) -> str:
        """生成首尾帧过渡提示词。

        Args:
            first_frame_path: 当前 beat 首帧路径
            last_frame_path: 下一个 beat 首帧路径
            narration: 当前 beat 解说词
            next_narration: 下一个 beat 解说词（可选，提供更多上下文）
            language: 输出语言，"en" 英文，"zh" 中文
        Returns:
            首尾帧过渡提示词
        """
        # 验证图片存在
        if not os.path.exists(first_frame_path):
            raise FileNotFoundError(f"First frame not found: {first_frame_path}")
        if not os.path.exists(last_frame_path):
            raise FileNotFoundError(f"Last frame not found: {last_frame_path}")

        # 压缩首尾帧图片
        first_frame_bytes = self._compress_image(first_frame_path)
        last_frame_bytes = self._compress_image(last_frame_path)

        first_frame_image = BinaryContent(data=first_frame_bytes, media_type='image/jpeg')  # 首帧
        last_frame_image = BinaryContent(data=last_frame_bytes, media_type='image/jpeg')   # 尾帧

        # 构建 dialogue 提示
        dialogue_hint = ""
        if audio_type == "dialogue" and dialogue_line:
            dialogue_hint = f'\n⚠️ This Beat is DIALOGUE — speaking is the primary motion. Describe lips moving, gestures while talking. Dialogue text is appended by the system; only describe physical action.\n'

        # 构建任务提示
        if color_map_text:
            # English + color map mode (SuperPower)
            task = f"""Craft a 5-second transition between these two sketches in Chinese (4-6 句, ~50-90 字).

## Images
- Image 1: First sketch (starting point)
- Image 2: Last sketch (ending point)

## Character Color Map (sketch color marks → character appearance)
{color_map_text}

## First Frame Visual Description
{visual_description if visual_description else "N/A"}
## Last Frame Visual Description
{next_visual_description if next_visual_description else "N/A"}

## Narration (Story Intent)
{narration}
"""
            if next_narration:
                task += f"\n## Next Narration (Emotional Direction)\n{next_narration}\n"
            task += f"""{dialogue_hint}
## Rules
- Identify characters by color marks, NEVER use character names
- Camera must have displacement/zoom, describe camera endpoint
- NO emotion labels → use body language
- Include ambient audio layer
- 4-6 句, ~50-90 字

Output the transition prompt in Chinese directly."""
        else:
            task = f"""Craft an imaginative 5-second transition between these two frames in Chinese (4-6 句, ~50-90 字).

## Images
- Image 1: First frame (starting point)
- Image 2: Last frame (ending point)

## Narration (Story Intent)
{narration}
"""
            if next_narration:
                task += f"\n## Next Narration (Emotional Direction)\n{next_narration}\n"
            task += f"""{dialogue_hint}
## Rules
- Describe visible element transitions from the frames
- Camera must have displacement/zoom, describe camera endpoint
- NO character names → use visual features
- NO emotion labels → use body language
- Include ambient audio layer
- 4-6 句, ~50-90 字

Output the transition prompt in Chinese directly."""

        lang_hint = "中文"
        log_agent_start(
            "首尾帧过渡提示词生成师",
            f"生成过渡描述 ({lang_hint})"
        )

        # 存储上下文供调试
        self._last_context = task

        try:
            agent = self._get_agent(language)
            response = await agent.run([task, first_frame_image, last_frame_image])

            # 提取过渡描述
            result = response.output.strip() if response.output else str(response).strip()

            # 检测错误响应
            error_indicators = [
                "ClientResponse",
                "Service Unavailable",
                "503",
                "500",
                "UNAVAILABLE",
                "overloaded",
            ]
            if any(indicator in result for indicator in error_indicators):
                raise RuntimeError(f"API 返回错误响应: {result[:200]}")

            log_agent_end("首尾帧过渡提示词生成师", success=True, result=f"{len(result)}字")
            # dialogue beat：追加台词内容
            if audio_type == "dialogue" and dialogue_line:
                result = f"{result}，说：{dialogue_line}"
            return result

        except Exception as e:
            log_agent_end("首尾帧过渡提示词生成师", success=False, result=str(e))
            # 失败时回退到默认提示词
            return self._fallback_build(language)

    def _fallback_build(
        self,
        language: str = "en",
    ) -> str:
        """回退方案：生成默认过渡提示词。"""
        return "角色姿态自然调整，身体轻微移动，镜头平稳跟随，场景渐变过渡。"


# 模块级单例
_keyframe_prompt_builder: Optional[KeyframePromptBuilder] = None


def get_keyframe_prompt_builder() -> KeyframePromptBuilder:
    """获取 KeyframePromptBuilder 单例。"""
    global _keyframe_prompt_builder
    if _keyframe_prompt_builder is None:
        _keyframe_prompt_builder = KeyframePromptBuilder()
    return _keyframe_prompt_builder
