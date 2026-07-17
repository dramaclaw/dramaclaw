"""Freezone 图片节点辅助逻辑。"""

from __future__ import annotations

from pathlib import Path

from novelvideo.freezone.vision_gateway import (
    VisionInput,
    call_freezone_vision_model,
    image_media_type,
)


def build_image_reverse_prompt_task() -> str:
    return "\n".join(
        [
            "你是一个图片节点提示词反推助手。",
            "我会给你一张图片，请根据图片内容反推出一段直接可用于文生图或图生图的中文提示词。",
            "要求：",
            "- 只输出最终提示词，不要解释，不要 markdown，不要引号。",
            "- 提示词应包含：主体、场景、构图/景别、光线、色调、材质/细节、氛围、风格。",
            "- 用创作者写提示词的自然表达，不要写成分析报告。",
            "- 不要编造图片里没有的关键主体或剧情动作。",
            "- 保持精炼但信息密度高，适合直接粘贴给图片模型。",
        ]
    )


async def reverse_prompt_from_image(
    *,
    image_path: Path,
) -> str:
    prompt = build_image_reverse_prompt_task()
    _model, prompt_text = await call_freezone_vision_model(
        prompt=prompt,
        images=[
            VisionInput(
                data=image_path.read_bytes(),
                media_type=image_media_type(image_path.name),
            )
        ],
    )
    prompt_text = prompt_text.strip()
    if prompt_text.startswith("```"):
        prompt_text = "\n".join(
            line for line in prompt_text.splitlines() if not line.strip().startswith("```")
        ).strip()
    if not prompt_text:
        raise RuntimeError("reverse prompt model returned empty prompt")
    return prompt_text
