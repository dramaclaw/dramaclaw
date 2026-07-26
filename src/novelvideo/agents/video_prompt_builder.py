"""Wan2.2 视频提示词生成 Agent。

将 Beat 信息转换为 Wan I2V 优化的运动描述提示词。
支持多模态输入：可直接分析首帧图片理解实际构图。
"""

import io
import os
from typing import Optional

from pydantic_ai import Agent, BinaryContent
from PIL import Image as PILImage

from novelvideo.utils.logging import log_agent_start, log_agent_end
from novelvideo.utils.debug_context import (
    create_debug_context,
    validate_episode_consistency,
)


VIDEO_PROMPT_BUILDER_INSTRUCTIONS_EN = """# I2V Motion Director (SuperPower)

⚠️ **I2V Golden Rule**: The first frame already defines scene/characters/composition.
You only describe **temporal changes**: character and object motion, plus camera movement.
The first frame is video time `t=0`; the model cannot go backward to show actions that happened before this frame.

## Field Contract
- `visual_description` describes the beat painting. Use it as the visual anchor for first frame composition and as a strong hint for the action that should follow.

## Sentence & Character Target
- 4–6 句（~50–90 字）, scaled by duration:
  - ≤4s → 50–60字 (tight, punchy)
  - 5–6s → 60–75字 (full motion chain)
  - ≥7s → 75–90字 (layered continuous motion)

## MUST
✓ Write in **Chinese (中文) only**, **present tense** throughout
✓ Start motion from the first-frame state and continue forward only
✓ Use simple, direct verbs
✓ When image is provided: use the image for composition/layout; the sketch's body language may be inaccurate, prefer the `visual_description` text for action direction
✓ Dialogue beats: speaking is the primary motion — describe lips moving, gestures while talking. Dialogue text is appended by the system; only describe physical action.

## BANNED
❌ Character names (narrator, father, mother, etc.) → use visual features: "the woman in black", "the older man"
❌ Repeating static content already in the first frame
❌ Describing how the subject arrived at the first frame
❌ Starting with an action that contradicts the first-frame posture or object state
❌ Inventing environmental dynamics (dust, fog, particles, wind-blown leaves) not visible in the frame
❌ Abstract emotion labels (sad, haunting, desperate, hopeful, anxious, melancholy) → show via body language (clenched fists, averted gaze, hunched shoulders)
❌ Non-visual senses (smell, temperature, humidity, taste, tactile) — the model generates only what is visible (and audible)
❌ Static camera words (holds, stays, remains, static, locked, fixed) — camera must always move
❌ Static primary verbs (freezes, stares, stands, waits, remains, holds still) as the main action — these produce frozen video
❌ Reversing or oscillating motion (steps forward then back, leans in then pulls away, nods then shakes head)

## Camera
- Every prompt MUST include a camera direction with displacement or zoom (push-in, dolly, pan, tilt, track, crane, zoom)
- Describe the camera endpoint: what the frame looks like when camera motion finishes
- Match detail to shot scale: close-up → micro details; wide shot → broad arcs

## Audio Layer (superset — works on audio-capable models, silently ignored by others)
- Add ONE short ambient sound sentence (e.g. "rain patters softly on the glass")
- For dialogue beats, also specify voice style (calm, urgent, whisper, etc.)

## Sustained Motion
The clip is ~5 seconds. One quick action finishes too early and the model reverses it.
Always describe a **chain of 2–3 connected actions** across the full duration.
Layer simultaneous details (camera drift, fabric swaying, breathing) to keep motion flowing.
⚠️ **UNIDIRECTIONAL motion only**: every action must move in ONE direction — forward, never back. If the primary action is short (a single punch, a single turn), extend it with follow-through motion in the SAME direction.

## Continuity Check
Before writing, verify the first verb of motion can naturally start from the visible first frame.
If the textual visual_description implies an action moment that the first frame has not yet reached, skip the impossible earlier action and begin from the first action that matches the visible t=0 state.

## Output
Output the motion prompt directly. No explanation. No markdown.
"""


def create_video_prompt_builder_agent(language: str = "en") -> Agent:
    """创建视频提示词生成 Agent。"""
    from novelvideo.config import get_superpower_pydantic_model

    model = get_superpower_pydantic_model(
        feature_provider_env="VIDEO_PROMPT_PROVIDER",
        feature_model_env="VIDEO_PROMPT_MODEL",
    )
    return Agent(model, system_prompt=VIDEO_PROMPT_BUILDER_INSTRUCTIONS_EN, output_type=str, name="Video Prompt Builder")


class VideoPromptBuilder:
    """视频提示词构建器。

    使用 AI Agent 将 Beat 信息转换为视频运动描述提示词。

    示例:
        >>> builder = VideoPromptBuilder()
        >>> prompt = await builder.build(
        ...     frame_prompt="女孩缓缓转身，月光洒在她的侧颜上",
        ...     duration=5.0,
        ... )
    """

    def __init__(self):
        self._agents: dict[str, Agent] = {}  # 按语言缓存 agent
        self._last_context: str = ""  # 存储上一次生成的上下文

    @property
    def last_context(self) -> str:
        """返回上一次生成视频提示词时使用的上下文。"""
        return self._last_context

    def _get_agent(self, language: str = "en") -> Agent:
        """获取指定语言的 Agent（懒加载）。"""
        if language not in self._agents:
            self._agents[language] = create_video_prompt_builder_agent(language)
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
        print(f"[VideoPromptBuilder] Compressing image: {os.path.basename(image_path)}: "
              f"{original_size/1024:.0f}KB → {compressed_size/1024:.0f}KB "
              f"({ratio:.0f}% smaller)")

        return image_bytes

    async def build(
        self,
        duration: float = 5.0,
        frame_prompt: str = "",
        language: str = "en",
        frame_image_path: Optional[str] = None,
        beat_number: int | None = None,
        episode_number: int | None = None,
        # 预留参数（不影响当前 prompt 构建）
        narration: str = "",
        character_appearances: dict[str, str] | None = None,
        color_map_text: str = "",
        audio_type: str = "narration",
        dialogue_line: str = "",
    ) -> str:
        """构建视频运动提示词。

        Args:
            duration: 视频时长（秒），用于调整动作丰富度
            frame_prompt: 首帧提示词（已包含完整视觉描述：场景、光影、角色外貌等）
            language: 输出语言（预留参数，当前统一使用中文）
            frame_image_path: 首帧图片路径（可选），用于多模态分析实际构图
            beat_number: beat 编号（用于调试验证）
            episode_number: episode 编号（用于调试验证）

        Returns:
            运动描述提示词
        """
        # 创建调试上下文
        debug = create_debug_context("video_prompt_builder")

        # 记录输入参数
        debug.add_section("input_params", {
            "episode_number": episode_number,
            "beat_number": beat_number,
            "frame_image_path": frame_image_path,
            "has_image": bool(frame_image_path and os.path.exists(frame_image_path)),
            "language": language,
            "duration": duration,
        })

        debug.add_section("content", {
            "frame_prompt": frame_prompt[:200] + "..." if len(frame_prompt) > 200 else frame_prompt,
        })

        # 验证 episode 号一致性
        if frame_image_path and episode_number:
            is_valid, warning = validate_episode_consistency(
                frame_image_path, episode_number, "VideoPromptBuilder"
            )
            if not is_valid and warning:
                debug.add_warning(warning)

        # 检测是否有首帧图片
        has_image = frame_image_path and os.path.exists(frame_image_path)

        task = self._build_task_en(
            duration=duration,
            frame_prompt=frame_prompt,
            has_image=has_image,
            color_map_text=color_map_text,
            narration=narration,
            audio_type=audio_type,
            dialogue_line=dialogue_line,
        )

        log_agent_start("Video Prompt Builder", f"Generating motion description ({duration:.1f}s, Chinese)")

        # 存储上下文供调试和优化
        self._last_context = task

        # 使用 DebugContext 保存完整上下文（新机制）
        debug.add("task_prompt", task)
        debug.save()
        debug.print_summary()

        # 准备图片用于多模态分析（如果提供了首帧图片）
        images = None
        if frame_image_path and os.path.exists(frame_image_path):
            try:
                image_bytes = self._compress_image(frame_image_path)
                images = [BinaryContent(data=image_bytes, media_type='image/jpeg')]
                label = "sketch" if color_map_text else "first frame"
                print(f"[VideoPromptBuilder] Running multimodal analysis on {label}: {os.path.basename(frame_image_path)}")
            except Exception as e:
                print(f"[VideoPromptBuilder] Failed to load first-frame image, falling back to text-only mode: {e}")
                images = None

        try:
            agent = self._get_agent(language)
            if images:
                user_prompt = [task] + images
                response = await agent.run(user_prompt)
            else:
                response = await agent.run(task)

            # 提取运动描述
            if response.output:
                result = response.output.strip()
            else:
                raise RuntimeError("AI returned empty content")

            # 长度校验：英文更长，放宽到 500 字符
            max_len = 500 if language == "en" else 200
            if len(result) > max_len:
                raise RuntimeError(f"AI returned content that is too long ({len(result)} chars), likely a parse error")

            # 检测错误响应（API 失败时可能返回错误对象而非抛出异常）
            error_indicators = [
                "ClientResponse",
                "Service Unavailable",
                "503",
                "500",
                "UNAVAILABLE",
                "overloaded",
            ]
            if any(indicator in result for indicator in error_indicators):
                raise RuntimeError(f"API returned an error response: {result[:200]}")

            log_agent_end("Video Prompt Builder", success=True, result=f"{len(result)} chars")
            # dialogue beat：追加台词内容
            if audio_type == "dialogue" and dialogue_line:
                result = f"{result}，说：{dialogue_line}"
            return result

        except Exception as e:
            log_agent_end("Video Prompt Builder", success=False, result=str(e))
            # 失败时回退到规则映射
            return self._fallback_build(duration, language)

    def _build_task_en(
        self, *, duration, frame_prompt, has_image, color_map_text, narration, audio_type, dialogue_line,
    ) -> str:
        """构建英文 task 模板 (SuperPower)。"""
        if duration <= 4:
            word_target = "50-60字"
        elif duration <= 6:
            word_target = "60-75字"
        else:
            word_target = "75-90字"

        dialogue_hint = ""
        if audio_type == "dialogue" and dialogue_line:
            dialogue_hint = f'\n⚠️ This Beat is DIALOGUE — speaking is the primary motion. Describe lips moving, gestures while talking. Dialogue text is appended by the system; only describe physical action.\n'

        if has_image and color_map_text:
            return f"""Generate I2V motion prompt in Chinese (target: {word_target}, 4-6 句):

## Context
- Duration: {duration:.1f}s
## Character Color Mapping (sketch color markers → character appearance)
{color_map_text}
## Visual Description
{frame_prompt if frame_prompt else "N/A"}
## Narration
{narration if narration else "N/A"}

{dialogue_hint}## Rules
⚠️ **First-frame contract**: the sketch is video frame one (t=0). Describe only what happens AFTER this frame.
1. Use the visual_description as a strong hint for the forward action chain; do not describe actions that must have happened before the visible first frame.
2. Only describe motion of characters and objects **actually visible** in the sketch — no invented environmental dynamics.
3. ⚠️ **Motion must fill {duration:.1f}s** — chain of 2-3 connected forward actions.
4. Target: {word_target}
5. If the textual visual_description implies an action moment the first frame has not yet reached, start from the next compatible action.
6. NO character names → use appearance descriptions from the color mapping

Output the motion prompt in Chinese (中文) directly.
"""
        elif has_image:
            return f"""Generate I2V motion prompt in Chinese (target: {word_target}, 4-6 句):

## Context
- Duration: {duration:.1f}s
## Visual Description
{frame_prompt if frame_prompt else "N/A"}

{dialogue_hint}## Rules
⚠️ **First-frame contract**: the image is video frame one (t=0). Describe only what happens AFTER this frame.
1. Use the visual_description as a strong hint for the forward action chain; do not describe actions that must have happened before the visible first frame.
2. Only describe motion of characters and objects **actually visible** in the image — no invented environmental dynamics.
3. ⚠️ **Motion must fill {duration:.1f}s** — describe continuous, progressive motion to avoid finishing too early.
4. Target: {word_target}
5. If the textual visual_description implies an action moment the first frame has not yet reached, start from the next compatible action.
6. NO character names → use visual descriptions ("the woman in gray"); distinguish multiple characters by visual features

Output the motion prompt in Chinese (中文) directly.
"""
        else:
            return f"""Generate I2V motion prompt in Chinese (target: {word_target}, 4-6 句):

## Context
- Duration: {duration:.1f}s
## Visual Description
{frame_prompt if frame_prompt else "N/A"}

{dialogue_hint}## Rules
1. Treat the visual_description as video frame one (t=0); describe only forward motion after it.
2. Extract action verbs from the visual_description directly.
3. Only describe character and object motion — no invented environmental dynamics.
4. ⚠️ **Motion must fill {duration:.1f}s** — describe continuous, progressive motion to avoid finishing too early.
5. Target: {word_target}
6. If the textual visual_description implies an action moment the first frame has not yet reached, start from the next compatible action.
7. NO character names → use visual descriptions ("the woman in black"); distinguish multiple characters by visual features

Output the motion prompt in Chinese (中文) directly. No explanation.
"""

    def _fallback_build(
        self,
        duration: float,
        language: str = "en",
    ) -> str:
        """回退方案：根据规则生成默认运动提示词。"""
        return "角色自然动作，姿态变化，自然镜头运动"


# 模块级单例
_video_prompt_builder: Optional[VideoPromptBuilder] = None


def get_video_prompt_builder() -> VideoPromptBuilder:
    """获取 VideoPromptBuilder 单例。"""
    global _video_prompt_builder
    if _video_prompt_builder is None:
        _video_prompt_builder = VideoPromptBuilder()
    return _video_prompt_builder


# =============================================================================
# v2.0 Shot Prompt Builder — Seedance 2.0 @素材引用模式
# =============================================================================
