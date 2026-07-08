"""Freezone 文本工具辅助逻辑。

当前包含：
- 中英文提示词互译
- 故事脚本生成
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field
from pydantic_ai import Agent

from novelvideo.official_defaults import (
    DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    DEFAULT_FREEZONE_TRANSLATION_MODEL,
)

FREEZONE_TRANSLATION_PROVIDER = "newapi"
FREEZONE_TRANSLATION_MODEL = DEFAULT_FREEZONE_TRANSLATION_MODEL
FREEZONE_STORY_SCRIPT_MODEL = {
    "id": DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    "provider": "newapi",
    "model": DEFAULT_FREEZONE_STORY_SCRIPT_MODEL,
    "label": "DramaClawAPI Story Script",
}
LEGACY_FREEZONE_STORY_SCRIPT_MODEL_IDS = {
    "newapi_gemini_flash",
    "openrouter_gemini_flash",
    "OpenRouter Gemini 2.5 Flash",
}

FREEZONE_TRANSLATION_SYSTEM_PROMPT = """# Freezone Prompt Translator

You translate prompting text between Simplified Chinese and English for creative nodes.

## Goal
- First determine the dominant natural language of the source text.
- If the dominant natural language is English, translate natural-language content into Simplified Chinese.
- If the dominant natural language is Simplified Chinese, translate natural-language content into English.
- Translate accurately while preserving prompting intent.
- Keep the output concise, directly usable as a prompt.
- Preserve cinematic, visual, audio, and motion terminology naturally.

## Rules
1. For mixed-language prompts, use the dominant natural language to decide the opposite target language.
2. Translate all natural-language content that should be user-readable into the target language.
3. Preserve line breaks, list structure, tags, and prompt segmentation when possible.
4. Keep IDs, asset markers, variable names, file names, model names, color codes, bracket tags, and technical tokens intact.
   Examples: [CM_6932], [YZSZ_974d], #00FFFF, 16:9, v2.0, fal.ai.
5. Do not add new details not present in the source.
6. For image/video/audio/text prompting, prefer natural creator-facing wording over literal textbook translation.
7. Only return the source directly when the detected source_language is exactly the same as the target_language.
8. If source_language and target_language differ, copying the original prose is a failure.
9. When translating English into Chinese, keep technical tokens intact but translate every English instruction sentence, rule sentence, heading, and description into Simplified Chinese.
10. When translating Chinese into English, keep technical tokens intact but translate every Chinese instruction sentence, rule sentence, heading, and description into English.
11. Return structured data matching the requested schema. Do not wrap with markdown.
"""

FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT = """# Freezone Story Script Generator

You generate a structured story-script table from an uploaded script excerpt.

## Goal
- Turn the source script into a complete, production-oriented story script.
- Output rows that are directly usable by downstream image and video nodes.
- Keep the result cinematic, concrete, and structured.

## Requirements
1. Break the story into clear numbered shots with sequential `shot_no`, starting from 1.
2. Each row must include all schema fields. Do not omit fields.
3. Prefer concrete visual language over vague abstraction. Every shot should feel filmable.
4. Dialogue should be short and only present when appropriate. If no dialogue is needed, output `无`.
5. If a field has no meaningful content, prefer `无` instead of vague placeholders.
6. Keep all fields in Simplified Chinese except technical tokens when naturally needed.
7. Output only structured data matching the schema. Do not wrap with markdown.

## Table style target
- The result should resemble a production storyboard table, not a prose summary.
- `visual_description` should describe one clear beat of action or state, usually in one concise sentence.
- `shot` should use concise combinations like `近景 / 特写`, `中景 / 仰视`, `全景 / 俯视远景`.
- `emotion` should be compact and specific, often 2-3 short phrases joined by `、`.
- `scene_tags`, `lighting_mood`, `sound` should all be concrete and film-facing.
- `character_1` should prefer a stable role identifier if inferable, such as `沈昭昭_现代` or `沈昭昭_古装`.
- `character_description_1` should prefer bracketed character-card format, e.g. `[沈昭昭_现代: 28岁女性，面色苍白，神情疲惫，身穿现代简约职业装……]`.

## Duration guidance
- Default to short cinematic shots.
- Most rows should fall in the 2-5 second range unless the source clearly calls for a longer beat.
- Keep the pacing readable and dramatic rather than mechanically uniform.

## Prompt formatting rules
`shot_prompt` must be image-generation friendly and must be written as a chained bracket structure using ` + ` separators.

Preferred order for `shot_prompt`:
1. `[画面构图：景别、机位、视角、构图关系]`
2. `[角色卡/主体描述：如果存在角色1，尽量直接复用或轻改 character_description_1 的角色卡格式；如果没有角色，则写主体/核心对象描述]`
3. `[主体/人物空间与互动关系：谁在前景、谁在中景、谁与什么环境或道具发生关系]`
4. `[极具体的微表情、主体状态或关键视觉信息：必须具体到眼神、嘴角、肢体紧张度、服饰状态、伤痕、汗水、血迹、视线方向等可见细节]`
5. `[明确的场景环境元素与前景/背景道具：办公室、宫殿、屏风、龙椅、电脑蓝光、飞尘、门缝光等]`
6. `[光影几何与大气效果：主光方向、冷暖色温、边缘光、雾气、逆光、顶光、体积光等]`
7. `[视觉风格/质感：写实电影感、纪实感、压抑冷感、盛唐史诗感等]`
8. `[技术参数：镜头焦段、光圈、景深、快门感、颗粒或解析度特征；这一段尽量不要省略]`

Example style for `shot_prompt`:
- `[画面构图：近景特写，平视机位] + [角色卡/主体描述：[沈昭昭_现代: 28岁女性，面色苍白，神情疲惫，身穿现代简约职业装]] + [主体/人物空间与互动关系：她独坐在办公桌前，电脑屏幕蓝光从侧前方打亮面部] + [极具体的微表情、主体状态或关键视觉信息：眼下发青，手指微颤，视线涣散，嘴唇微张] + [明确的场景环境元素与前景/背景道具：深夜办公室、电脑蓝光、散乱文件、冷掉的咖啡杯] + [光影几何与大气效果：冷蓝主调，屏幕侧光压住面部阴影，背景轻微灰雾感] + [视觉风格/质感：都市悬疑写实电影感] + [技术参数：85mm镜头，f/1.8，浅景深]`

`video_motion_prompt` must focus on motion and should also use a chained bracket structure.

Preferred order for `video_motion_prompt`:
1. `[明确的摄影机运镜轨迹与速度：必须写清推/拉/摇/移/跟/升/降/手持，以及快慢、力度和稳定性]`
2. `[主体极其具体的物理动作细节或状态变化：必须写清人物或主体具体怎么动，不要只写“情绪变化”]`
3. `[环境物理动态：风、雨、衣角、尘土、门帘、屏幕闪烁、火光、飞雪等]`
4. `[音效与氛围描述：环境声、器物声、呼吸声、脚步声、雷声等]`
5. `[对话台词与语气：有对白写具体台词与语气，没有就写无]`
6. `[时长：4.0s]`

Example style for `video_motion_prompt`:
- `[明确的摄影机运镜轨迹与速度：极慢速推进，镜头几乎贴着人物面部向前压近，稳定中带轻微呼吸感] + [主体极其具体的物理动作细节或状态变化：沈昭昭先是眼神失焦，随后瞳孔微缩，指尖在桌面轻轻抽动，喉结压抑地滚动一下] + [环境物理动态：屏幕冷光轻微闪烁，纸张边缘被空调风吹起，咖啡表面微微晃动] + [音效与氛围描述：急促的键盘声、连续的手机提示音、室内低频电流声] + [对话台词与语气：无] + [时长：4.0s]`

## Quality bar
- Avoid generic outputs like `人物站着`, `镜头推进`, `情绪复杂`.
- Prefer highly specific physical action, facial detail, scene detail, and camera-language wording.
- Preserve story logic and character-state progression across rows.
"""

FREEZONE_NODE_TYPE_LABELS: dict[str, str] = {
    "generic": "通用提示词",
    "image": "图片节点提示词",
    "video": "视频节点提示词",
    "audio": "音频节点提示词",
    "text": "文本节点提示词",
}

_translation_agent: Optional[Agent] = None
_story_script_agent: Optional[Agent] = None


class FreezoneTranslationResult(BaseModel):
    """Structured translation result produced by the LLM."""

    translated_text: str = Field(description="Translated prompt text.")
    source_language: Literal["zh", "en"] = Field(
        description="Dominant natural language detected from the source text."
    )
    target_language: Literal["zh", "en"] = Field(
        description="Opposite target language used for translation."
    )


def create_freezone_translation_agent() -> Agent:
    """创建 Freezone 中英互译 Agent。"""
    from novelvideo.config import get_newapi_text_pydantic_model

    model = get_newapi_text_pydantic_model(
        "FREEZONE_TRANSLATION_MODEL",
        FREEZONE_TRANSLATION_MODEL,
    )
    return Agent(
        model,
        system_prompt=FREEZONE_TRANSLATION_SYSTEM_PROMPT,
        output_type=FreezoneTranslationResult,
        name="Freezone Prompt Translator",
    )


def get_freezone_translation_agent() -> Agent:
    """获取翻译 Agent 单例。"""
    global _translation_agent
    if _translation_agent is None:
        _translation_agent = create_freezone_translation_agent()
    return _translation_agent


def resolve_freezone_story_script_model(model: str | None) -> dict[str, str]:
    model_text = str(model or "").strip()
    if not model_text:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text == FREEZONE_STORY_SCRIPT_MODEL["id"]:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text.casefold() == FREEZONE_STORY_SCRIPT_MODEL["label"].casefold():
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    if model_text in LEGACY_FREEZONE_STORY_SCRIPT_MODEL_IDS:
        return dict(FREEZONE_STORY_SCRIPT_MODEL)
    raise ValueError(f"unsupported story script model: {model_text}")


def create_freezone_story_script_agent(model: str | None = None) -> Agent:
    """创建故事脚本生成 Agent。"""
    from novelvideo.api.schemas import FreezoneStoryScriptGenerateData
    from novelvideo.config import get_newapi_text_pydantic_model

    resolved = resolve_freezone_story_script_model(model)
    llm_model = get_newapi_text_pydantic_model(
        "FREEZONE_STORY_SCRIPT_MODEL",
        resolved["model"],
    )
    return Agent(
        llm_model,
        system_prompt=FREEZONE_STORY_SCRIPT_SYSTEM_PROMPT,
        output_type=FreezoneStoryScriptGenerateData,
        # 结构化脚本表字段多、且 shot_no/duration 是严格 int，模型偶尔会把时长写成
        # "2-5"/"3秒" 之类而过不了校验。默认 output_retries=1 只给一次纠正机会不够，
        # 抛 "Exceeded maximum output retries (1)"。对齐本仓其它复杂结构化 agent
        # (episode_planner / content_rewriter)提到 3，让模型按回喂的校验错误自我修正。
        output_retries=3,
        name="Freezone Story Script Generator",
    )


def get_freezone_story_script_agent(model: str | None = None) -> Agent:
    """获取故事脚本生成 Agent 单例。"""
    global _story_script_agent
    resolved = resolve_freezone_story_script_model(model)
    if _story_script_agent is None:
        _story_script_agent = create_freezone_story_script_agent(resolved["id"])
    return _story_script_agent


def build_freezone_translation_task(
    *,
    text: str,
    node_type: Literal["generic", "image", "video", "audio", "text"],
) -> str:
    """构建翻译任务。"""
    node_label = FREEZONE_NODE_TYPE_LABELS[node_type]

    parts = [
        f"Translate the following {node_label}.",
        "You must decide whether the dominant natural language is Simplified Chinese or English.",
        "If dominant language is English, translate into Simplified Chinese.",
        "If dominant language is Simplified Chinese, translate into English.",
        "Do not copy the original prose when translating between different languages.",
        "Preserve IDs, file names, bracket tags, color codes, ratios, and model names exactly, but translate the surrounding natural-language instructions.",
        "Keep it directly usable as a creative prompt.",
    ]
    parts.append(f"Source text:\n{text.strip()}")
    return "\n\n".join(parts)


async def translate_freezone_text(
    *,
    text: str,
    node_type: Literal["generic", "image", "video", "audio", "text"] = "generic",
) -> tuple[str, Literal["zh", "en"], Literal["zh", "en"]]:
    """执行 Freezone 中英互译。"""
    if not text or not text.strip():
        return "", "zh", "en"

    task = build_freezone_translation_task(
        text=text,
        node_type=node_type,
    )
    response = await get_freezone_translation_agent().run(task)
    result = response.output
    target_language: Literal["zh", "en"] = result.target_language
    if target_language == result.source_language:
        target_language = "zh" if result.source_language == "en" else "en"
    return (
        result.translated_text.strip(),
        result.source_language,
        target_language,
    )


def build_freezone_story_script_task(
    *,
    source_text: str,
    prompt: str,
) -> str:
    """构建故事脚本生成任务。"""
    parts = [
        "根据以下上传剧本内容生成一个完整的故事脚本表。",
        "输出字段必须覆盖：镜号、时长、画面描述、角色1、角色描述1、角色图1、参考、景别、角色动作、情绪、场景标签、光影氛围、音效、对白、分镜提示词、视频运动提示词。",
        "如果用户给了额外要求，也必须一起遵守。",
        "请严格按照影视制片表格思路输出，不要输出散文摘要。",
        "请让分镜提示词和视频运动提示词都采用括号分段 + 号连接的格式。",
        "缺失对白时写 `无`；缺失角色图或参考时可写空字符串或 `无`，但不要发明不存在的素材。",
        "分镜提示词必须像高质量图像生成提示词，视频运动提示词必须像高质量视频运动提示词，而不是简单一句概括。",
    ]
    if prompt.strip():
        parts.append(f"用户要求：\n{prompt.strip()}")
    parts.append(
        "参考风格要点：\n"
        "- 镜号连续递增\n"
        "- 时长大多 2-5 秒\n"
        "- 景别写法类似 `近景 / 特写`、`中景 / 仰视`\n"
        "- 角色描述尽量写成 `[角色ID: ...]` 形式\n"
        "- 分镜提示词最好严格按 8 段写：构图、角色卡/主体描述、空间关系、微表情/状态、环境与道具、光影几何、视觉风格、技术参数\n"
        "- 如果存在角色1，分镜提示词第二段尽量直接使用或轻改角色描述1，不要换成模糊代称\n"
        "- 分镜提示词中的技术参数段尽量保留，不要省略\n"
        "- 视频运动提示词最好严格按 6 段写：运镜轨迹、主体动作、环境动态、音效氛围、对白语气、时长\n"
        "- 视频运动提示词里的主体动作必须是可见物理动作，不要只写情绪变化"
    )
    parts.append(f"源剧本内容：\n{source_text.strip()}")
    return "\n\n".join(parts)


async def generate_freezone_story_script(
    *,
    source_text: str,
    prompt: str = "",
    model: str | None = None,
):
    """执行故事脚本生成。"""
    if not source_text or not source_text.strip():
        raise ValueError("source_text is required")

    task = build_freezone_story_script_task(
        source_text=source_text,
        prompt=prompt,
    )
    response = await get_freezone_story_script_agent(model).run(task)
    return response.output
