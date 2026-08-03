"""全局视频提示词优化 Agent。

分析整集草图网格 + 角色颜色映射，一次性为所有 Beat 生成 first_frame 运动提示词。
"""

import io
import os
import re
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent
from pydantic_ai.output import NativeOutput
from PIL import Image as PILImage


class BeatVideoStrategy(BaseModel):
    """单个 Beat 的视频策略。"""

    beat_number: int
    video_mode: Literal["first_frame", "keyframe"]
    prompt: str = Field(description="中文运动提示词，50-90字")


class ReviewResult(BaseModel):
    """审核结果。"""

    needs_fix: bool
    reason: str
    prompt: str


class BeatIdentity(BaseModel):
    """单个 Beat 的角色识别结果。"""

    beat_number: int = Field(description="Beat 编号")
    identities: list[str] = Field(
        default_factory=list, description="识别到的 identity_id 列表，无角色则为空"
    )


GLOBAL_VIDEO_OPTIMIZER_INSTRUCTIONS_EN = """# Global Video Motion Director

You are a cinematic motion director. Given sketch panels and character color mappings, you write a first-frame motion prompt for each Beat.

## Input
1. **Sketch grid**: grid image, row-major numbering (top-left = B1, left-to-right, then next row)
2. **Character color mapping**: sketch color markers → character appearance descriptions
3. **Per-beat context** (if provided): `visual_description` plus any scene / prop / lighting details already present in the beat context

## Task
- Use `first_frame` mode for every Beat
- Write a forward-motion prompt for each Beat (what happens AFTER the sketch frame)

## Decision Rules
- ⚠️ **First-frame contract**: the sketch frame and Start Frame are video frame one (`t=0`). The video model cannot go backward. Do NOT describe the process of arriving at this frame.
- ⚠️ **Motion Prompt is the AUTHORITATIVE source for forward action**. Start from the Start Frame state and describe the Motion Prompt actions that occur after it. If the sketch body language conflicts with Motion Prompt, follow Motion Prompt, but do not invent actions that contradict the visible first frame.
- If the first verb in Motion Prompt cannot start from the visible Start Frame posture/object state, skip that impossible earlier verb and begin from the first compatible action.
- **Scene/prop enrichment**: prompts may incorporate concrete props, lighting, or environment cues already present in the beat context (e.g. "polished teak deck", "cold white sidelight"), but do not dump metadata verbatim

## Key Rules
- ⚠️ When describing characters, you MUST use the provided appearance descriptions (identity appearance). NEVER use character names.
- Distinguish characters by visual features (e.g. "the woman in black", "the gray-haired elder")
- Ambient atmospheric elements already visible in the sketch (fog, dust, light rays) MAY be mentioned if they are clearly present in the frame. Do NOT invent atmospheric effects that are not shown.
- ⚠️ **Temporal direction**: the sketch is video frame one. For `first_frame` mode, the prompt must describe motion that occurs AFTER the sketch frame. Do NOT describe the process of arriving at this frame.

## Prompt Requirements
- Write in **Chinese (中文) only**, **present tense** throughout
- Write a **single flowing paragraph** of 4–6 句（~50–90 字）
- ⚠️ **Every prompt MUST include a camera direction with displacement or zoom** (e.g. "The camera pushes in…", "A slow dolly follows…", "Close-up as…", "Wide shot tracking…"). Static camera words are BANNED: holds, stays, remains, static, locked, fixed. The camera must always move.
- ⚠️ **Camera endpoint**: describe what the frame looks like when the camera motion finishes (e.g. "…ending on a tight close-up of her trembling hands"). This gives the model a clear target for the end of the clip.
- ⚠️ **No emotion labels**: NEVER use abstract emotion words (sad, haunting, desperate, hopeful, anxious, melancholy). Instead show emotion through BODY LANGUAGE (clenched fists, averted gaze, hunched shoulders, trembling lips).
- ⚠️ **No non-visual senses**: NEVER describe smell, temperature, humidity, taste, or tactile sensations. The model can only generate what is VISIBLE (and audible).
- ⚠️ **Audio layer** (superset strategy — works on models with audio, ignored by silent models): add ONE short ambient sound sentence (e.g. "rain patters on the window"). For dialogue beats, also specify voice style (e.g. "calm", "urgent", "whisper").
- ⚠️ **Detail matches shot scale**: close-up → micro details (pores, thread count, iris dilation); wide shot → broad motion arcs and spatial relationships. Do not describe micro details in a wide shot or vice versa.
- Include: camera movement + character action + audio layer
- ⚠️ **Sustained motion**: the video clip is ~5 seconds long. A single quick action (one lunge, one turn) will finish too early and cause the model to reverse the motion. Always describe a **chain of 2–3 connected actions** that unfold continuously across the full duration (e.g. "he lunges forward, wraps his arms around her, then slowly sinks to his knees"). Layer simultaneous details (camera drift, fabric swaying, breathing) to keep motion flowing. BANNED as primary action: freezes, stares, stands, waits, remains, holds still — these produce static video.
- ⚠️ **UNIDIRECTIONAL motion only**: every action must move in ONE direction — forward, never back. BANNED reversal patterns: walk forward then step back, lean in then pull away, reach out then withdraw, turn left then right. If the primary action is short (a single punch, a single turn), extend it with follow-through motion in the SAME direction (e.g. "punches forward, momentum carries torso into a stumble, he catches himself on the railing").
- Always use `first_frame` mode: describe motion and camera changes starting FROM this frame going forward
- ⚠️ **Dialogue beats**: if a Beat is marked as dialogue, describe the speaking action (lips moving, gestures while talking). The dialogue text will be appended by the system — only describe the physical action in the prompt.

## Output Format
Output a strict JSON array with no explanation or markdown. Prompt values MUST be in Chinese:
[{"beat_number": 1, "video_mode": "first_frame", "prompt": "镜头缓缓推近..."}, ...]
"""


GLOBAL_VIDEO_REVIEWER_INSTRUCTIONS_EN = """# Video Prompt Reviewer

You are a visual quality reviewer. Compare a sketch frame against its video motion prompt for consistency.

## Input
1. **Sketch frame**: a single Beat's sketch image
2. **Character color mapping**: sketch color markers → character appearance descriptions
3. **Current video strategy**: video_mode (first_frame or keyframe) and prompt
4. **Beat context**: Start Frame / Motion Prompt / narration_segment (narration/dialogue)

## Task
- Compare the sketch content with the current prompt; determine if they match
- If the sketch's action, characters, or scene are inconsistent with the prompt, set needs_fix=true and rewrite the prompt
- If they basically match (minor wording differences allowed), set needs_fix=false

## Key Rules
- ⚠️ When describing characters, MUST use the provided appearance descriptions. NEVER use character names.
- Distinguish characters by visual features (e.g. "the woman in black", "the gray-haired elder")
- Ambient atmospheric elements already visible in the sketch MAY be mentioned. Do NOT invent atmospheric effects.
- ⚠️ **Prompts MUST be in English, present tense**

## Prompt Requirements
- Single flowing paragraph, 4–6 sentences (~50–90 words)
- ⚠️ **Camera movement is mandatory with displacement/zoom**: if the prompt lacks an explicit camera direction (push-in, dolly, pan, close-up, wide shot, etc.) or uses static camera words (holds, stays, remains, static, locked, fixed), set needs_fix=true and fix it.
- ⚠️ **No emotion labels**: if the prompt contains abstract emotion words (sad, haunting, desperate, hopeful, anxious, melancholy) instead of body language, set needs_fix=true.
- ⚠️ **No non-visual senses**: if the prompt describes smell, temperature, humidity, taste, or tactile sensations, set needs_fix=true.
- ⚠️ **No static primary verbs**: if the main action uses freezes, stares, stands, waits, remains, holds still, set needs_fix=true.
- ⚠️ **Audio layer required**: the prompt must include at least one ambient sound sentence. For dialogue beats, voice style (calm/urgent/whisper) must also be present. If missing, set needs_fix=true.
- ⚠️ **Dialogue beat review**: if the Beat is dialogue, the prompt must include speaking action (lips moving, gestures). Dialogue text is appended by the system and not checked in prompt.
- ⚠️ **No reversal/oscillating motion**: if the prompt contains back-and-forth or reversing motion patterns (steps forward then back, leans in then pulls away, nods then shakes head, reaches out then withdraws), set needs_fix=true. All motion must be UNIDIRECTIONAL.
- ⚠️ **First-frame contract**: the prompt must begin from the provided Start Frame / sketch state and move forward only. If it describes actions that happened before the visible frame, set needs_fix=true.

## Output Format
Output a strict JSON object with no explanation or markdown:
{"needs_fix": true/false, "reason": "brief explanation", "prompt": "corrected prompt (return original if needs_fix=false)"}
"""


def _normalize_gender_label(value: str) -> str:
    """将仓库内常见性别值归一化为英文标签。"""
    g = (value or "").strip().lower()
    if g in ("男", "男性", "male"):
        return "male"
    if g in ("女", "女性", "female"):
        return "female"
    return ""


def _combine_identity_prompt(face_prompt: str, appearance: str) -> str:
    """对齐单个 SuperPower 路径：使用 face_prompt + appearance_details。"""
    face_prompt = (face_prompt or "").strip()
    appearance = (appearance or "").strip()
    if face_prompt and appearance:
        return f"{face_prompt}，{appearance}"
    return face_prompt or appearance


def _format_color_mapping_descriptor(info: dict) -> str:
    """构建颜色映射里的外观描述，显式带上性别/体型约束。"""
    parts: list[str] = []

    gender = _normalize_gender_label(info.get("gender", ""))
    body_type = (info.get("body_type") or "").strip()
    appearance = (info.get("appearance") or "").strip()

    if gender:
        parts.append(gender)
    if body_type:
        parts.append(body_type)
    if appearance:
        parts.append(f"appearance: {appearance}")

    if not parts:
        return "person"
    return "; ".join(parts)


def create_global_video_reviewer_agent(language: str = "en") -> Agent:
    """创建全局视频审核 Agent。"""
    from novelvideo.config import get_superpower_pydantic_model

    model = get_superpower_pydantic_model(
        feature_provider_env="GLOBAL_VIDEO_PROVIDER",
        feature_model_env="GLOBAL_VIDEO_MODEL",
    )
    return Agent(
        model,
        system_prompt=GLOBAL_VIDEO_REVIEWER_INSTRUCTIONS_EN,
        output_type=NativeOutput(ReviewResult),
        name="Video Prompt Reviewer",
    )


def create_global_video_optimizer_agent(language: str = "en") -> Agent:
    """创建全局视频优化 Agent。"""
    from novelvideo.config import (
        get_newapi_text_pydantic_model,
        get_newapi_text_pydantic_model_settings,
    )

    legacy_model = os.environ.get("GLOBAL_VIDEO_MODEL", "").strip()
    model_settings = get_newapi_text_pydantic_model_settings(
        "GLOBAL_VIDEO_OPTIMIZER_THINKING_LEVEL",
        "low",
    )
    agent_kwargs = {}
    if model_settings is not None:
        agent_kwargs["model_settings"] = model_settings

    return Agent(
        get_newapi_text_pydantic_model(
            "GLOBAL_VIDEO_OPTIMIZER_MODEL",
            legacy_model or "gemini-3.5-flash",
            capability="text.generate.agent",
        ),
        system_prompt=GLOBAL_VIDEO_OPTIMIZER_INSTRUCTIONS_EN,
        output_type=NativeOutput(list[BeatVideoStrategy]),
        name="Global Video Motion Director",
        **agent_kwargs,
    )


class GlobalVideoPromptOptimizer:
    """全局视频提示词优化器。

    将整集草图网格和角色颜色映射发给 AI，
    由 AI 一次性生成每个 Beat 的 first_frame 运动提示词。
    """

    def __init__(self):
        self._agents: dict[str, Agent] = {}
        self._review_agent: Optional[Agent] = None

    def _get_agent(self, language: str = "en") -> Agent:
        if language not in self._agents:
            self._agents[language] = create_global_video_optimizer_agent(language)
        return self._agents[language]

    def _compress_image(self, image_path: str, compress_quality: int = 70) -> bytes:
        """压缩图片并返回 bytes。"""
        img = PILImage.open(image_path)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
        image_bytes = buffer.getvalue()
        original_size = os.path.getsize(image_path)
        compressed_size = len(image_bytes)
        ratio = (1 - compressed_size / original_size) * 100 if original_size > 0 else 0
        print(
            f"[GlobalVideoOptimizer] 压缩图片: {os.path.basename(image_path)}: "
            f"{original_size/1024:.0f}KB → {compressed_size/1024:.0f}KB "
            f"({ratio:.0f}% 压缩)"
        )
        return image_bytes

    def _build_identity_to_color(self, character_color_map: dict) -> dict[str, str]:
        """构建 identity_id → color label 的反向映射。"""
        identity_to_color = {}
        for color_key, info in character_color_map.items():
            identity = info.get("identity", info.get("name", ""))
            parts = color_key.split(" ", 1)
            hex_code = parts[0] if parts else color_key
            color_name = parts[1] if len(parts) > 1 else ""
            label = (
                f"figure with {color_name} ({hex_code}) tint"
                if color_name
                else f"figure with {hex_code} tint"
            )
            if identity:
                identity_to_color[identity] = label
        return identity_to_color

    async def optimize_single_beat(
        self,
        beat: dict,
        sketch_image_path: str,
        character_color_map: dict,
        language: str = "en",
        prev_beat: dict | None = None,
        next_beat: dict | None = None,
        prev_prompt: str | None = None,
        total_beats: int = 0,
    ) -> dict:
        """为单个 beat 生成导演级视频提示词。

        Args:
            beat: beat 数据 (visual_description, narration_segment, etc.)
            sketch_image_path: 该 beat 的草图帧路径
            character_color_map: 角色颜色→外貌映射

        Returns:
            {"beat_number": int, "video_mode": "first_frame", "prompt": str}
        """
        color_map_text = self._build_color_map_text(character_color_map)
        identity_to_color = self._build_identity_to_color(character_color_map)

        def _replace_identity_marker(match: re.Match) -> str:
            identity_id = match.group(1)
            return f"[{identity_to_color.get(identity_id, identity_id)}]"

        bn = beat.get("beat_number", 0)
        vd = beat.get("visual_description", "")
        narr = beat.get("narration_segment", "")
        audio_type = beat.get("audio_type", "narration")
        speaker = beat.get("speaker", "")

        # Replace {{identity_id}} markers in visual description.
        if vd:
            vd = re.sub(r"\{\{([^}]*)\}\}", _replace_identity_marker, vd)

        # Build beat context
        context_parts = []
        if narr:
            context_parts.append(f"- Narration: {narr}")
        if vd:
            context_parts.append(f"- Visual: {vd}")

        beat_context = (
            "\n".join(context_parts) if context_parts else "No additional context."
        )

        # Dialogue annotation
        dialogue_hint = ""
        if audio_type == "dialogue":
            spk_label = identity_to_color.get(speaker, speaker) if speaker else ""
            dialogue_hint = f"\n## Dialogue Beat\nSpeaker: {spk_label}. Prompt MUST include speaking action (lips moving, gestures while talking). Dialogue text will be appended by the system.\n"

        # Build continuity context
        continuity_section = ""
        if prev_beat or next_beat or prev_prompt:
            parts = []
            if prev_prompt:
                parts.append(
                    f'- Previous beat prompt (for continuity): "{prev_prompt[:150]}..."'
                )
            if prev_beat:
                prev_vd = prev_beat.get("visual_description", "")
                if prev_vd:
                    prev_vd = re.sub(
                        r"\{\{([^}]*)\}\}", _replace_identity_marker, prev_vd
                    )
                parts.append(
                    f"- Previous beat (B{prev_beat.get('beat_number', '?')}): {prev_vd[:120]}"
                )
            if next_beat:
                next_vd = next_beat.get("visual_description", "")
                if next_vd:
                    next_vd = re.sub(
                        r"\{\{([^}]*)\}\}", _replace_identity_marker, next_vd
                    )
                parts.append(
                    f"- Next beat (B{next_beat.get('beat_number', '?')}): {next_vd[:120]}"
                )
            continuity_section = (
                "\n## Continuity Context (vary your camera work from previous beat)\n"
                + "\n".join(parts)
                + "\n"
            )

        position_hint = ""
        if total_beats > 0:
            position_hint = f"\nThis is Beat {bn} of {total_beats} total. "
            if bn <= 2:
                position_hint += "This is an OPENING beat — establish the scene with a wider shot before pushing in."
            elif bn >= total_beats - 1:
                position_hint += "This is a CLOSING beat — build to a final visual climax or cliffhanger moment."
            else:
                position_hint += "Vary shot scale and angle from adjacent beats to create visual rhythm."

        task = f"""Generate a first-frame motion prompt for Beat {bn}. You see the sketch frame for this beat.
{position_hint}
## Character Color Mapping
{color_map_text}

## Beat {bn} Context
{beat_context}
{dialogue_hint}{continuity_section}
## Requirements
1. Use first_frame mode
2. Treat the sketch frame and Start Frame as video t=0; describe only what happens after it
3. Use Motion Prompt as the authoritative forward action chain
4. If Motion Prompt starts with an action that contradicts the visible t=0 state, begin from the first compatible action instead
5. Generate the motion prompt in Chinese (中文)
6. Use character appearance descriptions, never use character names
7. Output beat_number as {bn}

Output JSON array with one element directly."""

        # Load and compress the sketch image
        if not os.path.exists(sketch_image_path):
            raise RuntimeError(f"草图帧不存在: {sketch_image_path}")

        image_bytes = self._compress_image(sketch_image_path)
        image_content = BinaryContent(data=image_bytes, media_type="image/jpeg")

        agent = self._get_agent(language)
        user_prompt = [task, image_content]

        print(f"\n[GlobalVideoOptimizer] Beat {bn}: sending sketch frame + context")
        print(f"[GlobalVideoOptimizer] Beat {bn}: task length={len(task)} chars")

        response = await agent.run(user_prompt)

        if not response.output:
            raise RuntimeError(f"Beat {bn}: AI 返回空内容")

        strategies: list[BeatVideoStrategy] = response.output
        if not strategies:
            raise RuntimeError(f"Beat {bn}: AI 返回空数组")

        # Take the first (and should be only) result
        s = strategies[0]
        result = {
            "beat_number": bn,
            "video_mode": "first_frame",
            "prompt": s.prompt.strip(),
        }

        # Append dialogue line if applicable
        if audio_type == "dialogue":
            line = beat.get("narration_segment", "")
            if line and line not in result["prompt"]:
                result["prompt"] = f"{result['prompt']} Says: {line}"

        print(
            f"[GlobalVideoOptimizer] Beat {bn}: prompt generated ({len(result['prompt'])} chars)"
        )
        return result

    async def optimize(
        self,
        sketch_image_paths: list[str],
        character_color_map: dict,
        total_beats: int,
        language: str = "en",
        beats: list[dict] | None = None,
        sketches_dir: str | None = None,
        progress_callback=None,
    ) -> list[dict]:
        """优化整集所有 Beat 的视频提示词（逐 beat 调用 optimize_single_beat）。

        Args:
            sketch_image_paths: 草图网格图片路径列表 (legacy, used as fallback)
            character_color_map: 角色颜色→外貌映射
            total_beats: 总 beat 数
            language: 输出语言
            beats: beat 数据列表
            sketches_dir: 草图帧目录路径，用于查找单帧
            progress_callback: 进度回调 fn(beat_num, total)

        Returns:
            [{"beat_number": int, "video_mode": str, "prompt": str}, ...]
        """
        if not beats:
            raise RuntimeError("beats 参数不能为空")

        validated = []
        sorted_beats = sorted(beats, key=lambda b: b.get("beat_number", 0))

        prev_prompt = None
        for i, beat in enumerate(sorted_beats):
            bn = beat.get("beat_number", 0)

            # Find sketch frame for this beat
            sketch_path = None
            if sketches_dir:
                for ext in ("png", "jpg"):
                    candidate = os.path.join(sketches_dir, f"beat_{bn:02d}.{ext}")
                    if os.path.exists(candidate):
                        sketch_path = candidate
                        break

            if not sketch_path:
                print(f"[GlobalVideoOptimizer] Beat {bn}: 无单帧草图，跳过")
                continue

            # prev/next beat for continuity
            prev_beat = sorted_beats[i - 1] if i > 0 else None
            next_beat = sorted_beats[i + 1] if i < len(sorted_beats) - 1 else None

            try:
                result = await self.optimize_single_beat(
                    beat=beat,
                    sketch_image_path=sketch_path,
                    character_color_map=character_color_map,
                    language=language,
                    prev_beat=prev_beat,
                    next_beat=next_beat,
                    prev_prompt=prev_prompt,
                    total_beats=len(sorted_beats),
                )
                validated.append(result)
                prev_prompt = result["prompt"]
            except Exception as e:
                print(f"[GlobalVideoOptimizer] Beat {bn}: 优化失败 ({e})")

            if progress_callback:
                progress_callback(bn, len(sorted_beats), i + 1)

        return validated

    async def review_and_fix(
        self,
        results: list[dict],
        beats: list,
        sketches_dir: str,
        character_color_map: dict,
        log_fn=None,
    ) -> list[dict]:
        """逐 beat 审核提示词与草图帧是否一致，不一致则自动修正。

        Args:
            results: optimize() 返回的结果列表
            beats: beat 数据列表（含 visual_description, narration_segment）
            sketches_dir: 草图帧目录路径
            character_color_map: 角色颜色→外貌映射
            log_fn: 日志回调函数

        Returns:
            更新后的 results 列表
        """
        if self._review_agent is None:
            self._review_agent = create_global_video_reviewer_agent("en")

        def _log(msg: str):
            if log_fn:
                log_fn(msg)

        color_map_text = self._build_color_map_text(character_color_map)
        beats_by_num = {b.get("beat_number"): b for b in beats}
        sketches_path = Path(sketches_dir)
        fixed_count = 0

        for result in results:
            beat_num = result["beat_number"]
            video_mode = result["video_mode"]
            prompt = result["prompt"]

            # 查找草图帧
            sketch_file = sketches_path / f"beat_{beat_num:02d}.png"
            if not sketch_file.exists():
                _log(f"Beat {beat_num}: 草图帧不存在，跳过审核")
                continue

            beat = beats_by_num.get(beat_num, {})
            visual_desc = beat.get("visual_description", "")
            narration = beat.get("narration_segment", "")
            audio_type = beat.get("audio_type", "narration")
            speaker = beat.get("speaker", "")
            from novelvideo.models import format_beat_narration

            if audio_type == "dialogue":
                narration_label = format_beat_narration(audio_type, speaker, narration)
            else:
                narration_label = f"旁白: {narration}"

            try:
                image_bytes = self._compress_image(str(sketch_file))
                image_content = BinaryContent(data=image_bytes, media_type="image/jpeg")

                dialogue_hint = ""
                if audio_type == "dialogue":
                    dialogue_hint = f"\n- ⚠️ 此 Beat 为角色台词，prompt 中需描述说话动作（张嘴说话等）。台词由系统追加。"

                review_task = f"""审核 Beat {beat_num} 的视频提示词是否与草图画面吻合。

## 角色颜色映射
{color_map_text}

## 当前视频策略
- video_mode: {video_mode}
- prompt: {prompt}

## Beat 上下文
- 画面描述: {visual_desc}
- {narration_label}{dialogue_hint}

请对比草图画面与 prompt，判断是否需要修正。prompt 必须从草图这一帧之后开始，不能描述抵达这一帧之前发生的动作。直接输出 JSON 对象。"""

                response = await self._review_agent.run([review_task, image_content])

                if response.output:
                    review: ReviewResult = response.output
                    if review.needs_fix:
                        result["prompt"] = review.prompt or prompt
                        fixed_count += 1
                        _log(f"Beat {beat_num}: ✏️ 已修正 — {review.reason}")
                    else:
                        _log(f"Beat {beat_num}: ✅ 通过审核")
                else:
                    _log(f"Beat {beat_num}: 审核返回空，跳过")

            except Exception as e:
                _log(f"Beat {beat_num}: 审核异常 ({e})，保留原 prompt")

        _log(f"审核完成：{fixed_count}/{len(results)} 个 Beat 已修正")
        return results

    def _build_color_map_text(self, character_color_map: dict) -> str:
        """将角色颜色映射构建为文本描述（颜色→外貌描述，不含角色名）。"""
        lines = []
        for color_key, info in character_color_map.items():
            # color_key 格式: "#4A90D9 ICE BLUE"
            parts = color_key.split(" ", 1)
            hex_code = parts[0] if parts else color_key
            color_name = parts[1] if len(parts) > 1 else ""
            label = f"{color_name} ({hex_code})" if color_name else hex_code
            descriptor = _format_color_mapping_descriptor(info)
            lines.append(
                f"- Any figure with a {label} tint (even pale/desaturated) → {descriptor}"
            )
        return "\n".join(lines) if lines else "No character color mapping"


def prepare_global_optimizer_input(
    beats: list,
    characters: list,
    output_dir: str,
    episode: int,
    project: str,
) -> tuple[list[str], dict, int]:
    """准备全局优化器的输入数据。

    Returns:
        (sketch_paths, character_color_map, total_beats)

    1. 找草图网格: grids/ep{ep}/sketch/ 下的 grid 图片
    2. 构建颜色映射: build_character_map_for_grid() →
       提取 identity_sketch_colors + identity_appearances
    """
    from novelvideo.utils.path_resolver import PathResolver

    resolver = PathResolver(output_dir, episode)
    total_beats = len(beats)

    # 1. 从 sketches/ep{N}/ 收集已确认的草图，拼成网格
    sketch_paths = _try_combine_frames_to_grid(resolver, beats, output_dir, episode)

    # 2. 构建角色颜色→外貌映射
    character_color_map = _build_color_appearance_map(
        beats, characters, output_dir, project, episode=episode
    )

    return sketch_paths, character_color_map, total_beats


def _try_combine_frames_to_grid(resolver, beats, output_dir, episode) -> list[str]:
    """尝试将单帧拼接为网格。优先从 sketches/ 读取当前选中的草图。"""
    try:
        from novelvideo.generators.grid_splitter import combine_to_grid

        sketches_dir = resolver.sketches_dir()  # sketches/ep001/ — 当前选中的草图
        sketch_pool_dir = resolver.sketch_dir()  # grids/ep001/sketch/ — 输出目录

        # 只从 sketches/ 收集当前选中的草图
        frame_paths = []
        for b in sorted(beats, key=lambda x: x.get("beat_number", 0)):
            beat_num = b.get("beat_number", 0)
            for ext in ("png", "jpg"):
                candidate = sketches_dir / f"beat_{beat_num:02d}.{ext}"
                if candidate.exists():
                    frame_paths.append(str(candidate))
                    break

        if len(frame_paths) >= 4:  # 至少 4 帧才拼
            rows = 5
            cols = 5
            if len(frame_paths) <= 9:
                rows, cols = 3, 3
            elif len(frame_paths) <= 16:
                rows, cols = 4, 4

            grid_path = sketch_pool_dir / f"_global_opt_grid_{rows}x{cols}.png"
            sketch_pool_dir.mkdir(parents=True, exist_ok=True)
            combine_to_grid(frame_paths, grid_path, rows=rows, cols=cols)
            print(
                f"[GlobalOptimizer] 草图网格已保存: {grid_path} ({len(frame_paths)} 帧, {rows}x{cols})"
            )
            return [str(grid_path)]
    except Exception as e:
        print(f"[prepare_global_optimizer_input] 拼接草图失败: {e}")

    return []


def _build_color_appearance_map(
    beats: list,
    characters: list,
    output_dir: str,
    project: str,
    *,
    episode: int | None = None,
    cognee_store=None,
) -> dict:
    """从 build_character_map_for_grid 提取角色颜色→外貌映射。"""
    from novelvideo.services.character_ref_service import build_character_map_for_grid

    # sketch_colors 只从 SQLite/Cognee store 读取。
    _sc = None
    if cognee_store and episode:
        _sc = cognee_store.get_sketch_colors(episode) or None

    char_map = build_character_map_for_grid(
        grid_beats=beats,
        characters=characters,
        user_output_dir=Path(output_dir).parent,
        project=project,
        sketch_colors=_sc,
        use_detected_identities=False,
    )

    color_map = {}
    for char_name, info in char_map.items():
        sketch_colors = info.get("identity_sketch_colors", {})
        appearances = info.get("identity_appearances", {})

        for suffix, color in sketch_colors.items():
            if not color:
                continue
            appearance = appearances.get(suffix, "")
            body_types = info.get("identity_body_types", {})
            face_prompts = info.get("identity_face_prompts", {})
            face_prompt = face_prompts.get(suffix, info.get("face_prompt", ""))
            color_map[color] = {
                "name": char_name,
                "identity": f"{char_name}_{suffix}" if suffix else char_name,
                "appearance": _combine_identity_prompt(
                    face_prompt,
                    appearance or info.get("appearance_details", ""),
                ),
                "gender": info.get("gender", ""),
                "body_type": body_types.get(suffix, info.get("body_type", "")),
            }

    return color_map


AI_IDENTITY_DETECTOR_INSTRUCTIONS = """# Sketch Marker Color Identification Agent

You identify colored production markers in sketch panels by their COLOR TINT only.
Markers can represent named characters or tracked global props.
You receive a sketch grid image and a color-to-marker mapping.

## Rules
- Each named character or tracked global prop is drawn in a UNIQUE COLOR tint.
- UNNAMED extras/background objects are drawn in pure GRAYSCALE (black/white/gray, no color).
- Sketch colors may be very light or desaturated — if an object/figure has ANY hint of the assigned color tint, include that marker.
- Figures or props drawn in pure GRAYSCALE (no color tint at all) are unnamed/untracked — do NOT include them.
- If a panel contains NO colored markers, output empty array []. Do NOT guess or infer from context.
- Identify markers by their COLOR TINT, NOT by body language, position, or context.
- If several colored markers appear in one panel, output all matching marker ids.

## Output format
Output a JSON array of objects, one per panel:
[{"beat_number": 1, "identities": ["identity_A", "tracked_prop_A"]}, {"beat_number": 2, "identities": []}, ...]
"""


def _create_identity_detector_agent() -> Agent:
    """创建 AI 角色颜色识别 Agent。"""
    from novelvideo.config import (
        get_newapi_text_pydantic_model,
        get_newapi_text_pydantic_model_settings,
    )

    legacy_model = os.environ.get("GLOBAL_VIDEO_MODEL", "").strip()
    model_settings = get_newapi_text_pydantic_model_settings(
        "GLOBAL_VIDEO_IDENTITY_DETECTOR_THINKING_LEVEL",
        "low",
    )
    agent_kwargs = {}
    if model_settings is not None:
        agent_kwargs["model_settings"] = model_settings

    return Agent(
        get_newapi_text_pydantic_model(
            "GLOBAL_VIDEO_IDENTITY_DETECTOR_MODEL",
            legacy_model or "gemini-3.5-flash",
            capability="text.generate.agent",
        ),
        system_prompt=AI_IDENTITY_DETECTOR_INSTRUCTIONS,
        output_type=NativeOutput(list[BeatIdentity]),
        name="角色颜色识别",
        **agent_kwargs,
    )


async def detect_identities_by_ai(
    sketch_image_paths: list[str],
    color_identity_map: dict[str, str],
    total_beats: int,
) -> dict[int, list[str]]:
    """AI 视觉识别每个 beat 的共享颜色标记，仅基于图片+颜色映射，无文本上下文。

    Args:
        sketch_image_paths: 草图网格图片路径列表
        color_identity_map: {"#4A90D9 ICE BLUE": "沈知薇_嫡女时期" / "办公纸箱", ...}
        total_beats: 总 beat 数

    Returns:
        {beat_number: [marker_id, ...]}
    """
    agent = _create_identity_detector_agent()

    # 构建颜色映射文本
    lines = []
    for color_key, identity_id in color_identity_map.items():
        parts = color_key.split(" ", 1)
        hex_code = parts[0] if parts else color_key
        color_name = parts[1] if len(parts) > 1 else ""
        label = f"{color_name} ({hex_code})" if color_name else hex_code
        lines.append(f"- {label} tint → {identity_id}")
    color_text = "\n".join(lines) if lines else "No color mapping"

    task = f"""Identify colored markers in each panel of this sketch grid ({total_beats} panels, B1-B{total_beats}, row-major order).

## Color → Marker mapping
{color_text}

Output a JSON array of objects, one per panel:
[{{"beat_number": 1, "identities": ["identity_A"]}}, {{"beat_number": 2, "identities": []}}, ...]
Use an empty identities array for panels with no colored markers."""

    # 准备图片
    images = []
    for path in sketch_image_paths:
        if os.path.exists(path):
            try:
                img = PILImage.open(path)
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")
                buffer = io.BytesIO()
                img.save(buffer, format="JPEG", quality=70, optimize=True)
                images.append(
                    BinaryContent(data=buffer.getvalue(), media_type="image/jpeg")
                )
            except Exception as e:
                print(f"[detect_identities_by_ai] 加载图片失败: {path}, {e}")

    if not images:
        raise RuntimeError("没有可用的草图网格图片")

    print(
        f"[detect_identities_by_ai] 发送 {len(images)} 张网格图片, {total_beats} beats"
    )
    response = await agent.run([task] + images)

    if not response.output:
        raise RuntimeError("AI 返回空内容")

    # structured output: response.output 直接是 list[BeatIdentity]
    beat_identities: list[BeatIdentity] = response.output
    result: dict[int, list[str]] = {
        bi.beat_number: bi.identities for bi in beat_identities
    }

    print(
        f"[detect_identities_by_ai] 识别结果: { {k: v for k, v in sorted(result.items())} }"
    )
    return result


# 模块级单例
_global_video_optimizer: Optional[GlobalVideoPromptOptimizer] = None


def get_global_video_optimizer() -> GlobalVideoPromptOptimizer:
    """获取 GlobalVideoPromptOptimizer 单例。"""
    global _global_video_optimizer
    if _global_video_optimizer is None:
        _global_video_optimizer = GlobalVideoPromptOptimizer()
    return _global_video_optimizer
