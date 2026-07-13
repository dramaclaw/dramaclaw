"""道具三视图参考图生成器。

使用 Google AI Studio (Gemini) 生成道具三视图参考图：
正面 (FRONT) / 侧面 (SIDE) / 背面 (BACK)

核心概念：道具独立建模
- 产品摄影风格，白色/浅灰无缝背景
- 展示道具细节和材质纹理
- 下游分镜中出现道具时作为 reference，保持道具外观一致

参考资料:
- https://www.51cto.com/article/837277.html（纳米漫剧流水线 - 道具建模）
"""

import asyncio
import os
import time
from pathlib import Path
from typing import Optional

from novelvideo.config import (
    IMAGE_GENERATION_SELECTIONS,
    get_grid_generation_config,
    get_style_preset,
    IMAGE_DEFAULT_STYLE,
    NEWAPI_API_KEY,
    NEWAPI_BASE_URL,
    NEWAPI_IMAGE_MODEL,
    PROP_REF_IMAGE_MODEL,
    PROP_REF_IMAGE_PROVIDER,
    normalize_image_generation_selection,
)
from novelvideo.shared.billing_errors import is_insufficient_credits_error
from novelvideo.generators.nanobanana_grid import (
    _call_newapi_image_api,
    _call_openai_image_api,
    clamp_image_size,
    normalize_image_size,
    normalize_openai_quality,
)


PROP_REF_ASPECT_RATIO = "16:9"
PROP_REF_IMAGE_SIZE = "0.5K"


def resolve_prop_reference_image_model() -> str:
    """Return the model used by prop reference generation."""
    config = get_grid_generation_config()
    prop_provider = (PROP_REF_IMAGE_PROVIDER or "").strip().lower()
    provider = prop_provider or str(config.get("provider") or "google").strip().lower()
    if provider == "newapi":
        return (PROP_REF_IMAGE_MODEL or NEWAPI_IMAGE_MODEL).strip()
    return str(config.get("model") or "").strip()


def _prop_reference_image_source(selection: str | None) -> tuple[str | None, str | None]:
    selection = str(selection or "").strip()
    if not selection:
        return None, None
    normalized = normalize_image_generation_selection(selection)
    image_source = IMAGE_GENERATION_SELECTIONS[normalized]
    return image_source["provider"], image_source["model"]


def build_prop_reference_prompt(
    visual_prompt: str,
    style_keywords: str = "",
    style: str | None = None,
    project_dir: str = "",
) -> str:
    """Build the exact prompt used for prop reference-sheet generation."""
    if style is None:
        style = IMAGE_DEFAULT_STYLE

    style_preset = get_style_preset(style, project_dir=project_dir or None)
    preset_style = style_preset.get("style_instructions", "")
    preset_negative = style_preset.get("avoid_instructions", "")

    all_style = ", ".join(filter(None, [preset_style, style_keywords]))
    all_negative = preset_negative

    return f"""Generate a 3-PANEL product reference sheet for a story prop.

LAYOUT (1x3, 16:9 overall):
- Three equal unlabeled panels arranged left to right
- Left panel: front view
- Middle panel: side profile
- Right panel: back view
- Do not draw panel titles, angle labels, captions, numbers, arrows, or divider text

PROP DESCRIPTION:
{visual_prompt}

PRODUCT PHOTOGRAPHY STYLE:
- Clean white or light gray seamless background
- Soft studio lighting, no harsh shadows
- Object centered, filling approximately 70% of each panel
- High detail rendering of materials, textures, and surface finishes
- Professional product shot quality

FRONT VIEW: Straight-on frontal view of the prop, showing its face/main side
SIDE PROFILE: 90-degree side view showing the prop's profile and thickness
BACK VIEW: Straight-on rear view of the same prop, showing rear-side details, straps, seams, closures, ports, or worn backside surfaces

VISUAL STYLE:
{all_style}

STRICT REQUIREMENTS:
- NO people, hands, fingers, or living creatures
- Object only, isolated on clean background
- Each panel must be distinguishable by object angle only, never by written labels
- Consistent lighting, scale, silhouette, and material identity across all three panels
- Show fine details: gems, stitching, weathering, non-text surface marks, etc.
- No readable writing anywhere, even if the description mentions a cover title, sign, label, document text, engraving, or lettering
- If text-like markings are necessary for the prop design, render them as abstract unreadable strokes or blank surface texture

MUST AVOID:
{all_negative}
- Do NOT add text, labels, panel titles, captions, numbers, arrows, logos, watermarks, signatures, readable letters, Chinese characters, or English words
- Do NOT include any people, hands, or body parts
- Do NOT show the prop being held or worn
- Do NOT add busy or distracting backgrounds"""


async def generate_prop_reference(
    visual_prompt: str,
    output_path: str,
    style_keywords: str = "",
    style: str = None,
    project_dir: str = "",
    model: str | None = None,
) -> Optional[str]:
    """生成道具三视图参考图。

    生成一张 1x3 三面板图像，包含道具的正面、侧面、背面，
    采用产品摄影风格，用于保持道具外观一致性。

    Args:
        visual_prompt: 道具视觉 prompt
        output_path: 输出文件路径
        style_keywords: 额外的风格关键词
        style: 风格名称，默认使用全局配置

    Returns:
        生成的图片路径，失败返回 None
    """
    start_time = time.time()

    if style is None:
        style = IMAGE_DEFAULT_STYLE

    config = get_grid_generation_config()
    selected_provider, selected_model = _prop_reference_image_source(model)
    prop_provider = (PROP_REF_IMAGE_PROVIDER or "").strip().lower()
    provider = (
        selected_provider
        or prop_provider
        or str(config.get("provider") or "google").strip().lower()
    )
    if provider == "newapi":
        from novelvideo.config import get_effective_newapi_gateway_config

        gateway = get_effective_newapi_gateway_config()
        api_key = gateway.api_key
        model = selected_model or resolve_prop_reference_image_model()
        base_url = gateway.base_url
    else:
        api_key = config.get("api_key")
        model = selected_model or resolve_prop_reference_image_model()
        base_url = ""

    if not api_key:
        if provider == "openrouter":
            key_name = "OPENROUTER_API_KEY"
        elif provider == "openai":
            key_name = "OPENAI_API_KEY"
        elif provider == "newapi":
            key_name = "NEWAPI_API_KEY"
        else:
            key_name = "GOOGLE_AI_API_KEY"
        print(f"[PropRefGen] API key not set. Set {key_name} environment variable.")
        return None

    prompt = build_prop_reference_prompt(
        visual_prompt=visual_prompt,
        style_keywords=style_keywords,
        style=style,
        project_dir=project_dir,
    )

    print(f"[PropRefGen] 生成道具三视图: {visual_prompt[:60]}...")
    print(f"[PropRefGen] Provider: {provider}, Model: {model}")

    try:
        if provider == "openrouter":
            result_path = await _generate_via_openrouter(
                prompt=prompt,
                output_path=output_path,
                api_key=api_key,
                model=model,
            )
        elif provider == "openai":
            result_path = await _generate_via_openai(
                prompt=prompt,
                output_path=output_path,
                api_key=api_key,
                model=model,
                quality=config.get("openai_image_quality", "medium"),
            )
        elif provider == "newapi":
            result_path = await _generate_via_newapi(
                prompt=prompt,
                output_path=output_path,
                api_key=api_key,
                model=model,
                base_url=base_url,
                quality=config.get("openai_image_quality", "medium"),
            )
        else:
            result_path = await _generate_via_google(
                prompt=prompt,
                output_path=output_path,
                api_key=api_key,
                model=model,
            )

        elapsed = time.time() - start_time
        if result_path:
            print(f"[PropRefGen] 三视图已生成: {result_path}，耗时 {elapsed:.1f}s")
        else:
            print(f"[PropRefGen] 生成失败，耗时 {elapsed:.1f}s")
        return result_path

    except Exception as e:
        if is_insufficient_credits_error(e):
            raise
        elapsed = time.time() - start_time
        print(f"[PropRefGen] 生成异常: {e}，耗时 {elapsed:.1f}s")
        return None


async def _generate_via_google(
    prompt: str,
    output_path: str,
    api_key: str,
    model: str,
) -> Optional[str]:
    """通过 Google AI Studio 直连生成图像。"""
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        print("[PropRefGen] 请安装 google-genai: pip install google-genai")
        return None

    client = genai.Client(api_key=api_key)

    is_gemini3 = "gemini-3" in model
    if is_gemini3:
        image_config = types.ImageConfig(
            aspect_ratio=PROP_REF_ASPECT_RATIO,
            image_size=clamp_image_size(PROP_REF_IMAGE_SIZE),
        )
    else:
        image_config = types.ImageConfig(
            aspect_ratio=PROP_REF_ASPECT_RATIO,
        )

    response = await asyncio.to_thread(
        client.models.generate_content,
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            image_config=image_config,
        ),
    )

    return _extract_and_save_image(response, output_path)


async def _generate_via_openrouter(
    prompt: str,
    output_path: str,
    api_key: str,
    model: str,
) -> Optional[str]:
    """通过 OpenRouter 代理生成图像。"""
    from novelvideo.generators.nanobanana_grid import _call_openrouter_image_api

    requested_size = normalize_image_size(PROP_REF_IMAGE_SIZE, provider="openrouter")
    image_bytes, _text_content, error_text = await _call_openrouter_image_api(
        api_key=api_key,
        model=model,
        prompt=prompt,
        image_config={
            "aspect_ratio": PROP_REF_ASPECT_RATIO,
            "image_size": requested_size,
        },
    )

    if not image_bytes and requested_size == "0.5K":
        print("[PropRefGen] OpenRouter 0.5K 被 provider 拒绝，回退到 1K 重试")
        image_bytes, _text_content, error_text = await _call_openrouter_image_api(
            api_key=api_key,
            model=model,
            prompt=prompt,
            image_config={
                "aspect_ratio": PROP_REF_ASPECT_RATIO,
                "image_size": "1K",
            },
        )

    if image_bytes:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(image_bytes)
        return output_path

    print(f"[PropRefGen] OpenRouter 生成失败: {error_text or 'No response'}")
    return None


async def _generate_via_openai(
    prompt: str,
    output_path: str,
    api_key: str,
    model: str,
    quality: str = "medium",
) -> Optional[str]:
    """通过 OpenAI Image API 生成图像。"""

    image_bytes, _text_content, error_text = await _call_openai_image_api(
        api_key=api_key,
        model=model,
        prompt=prompt,
        image_config={
            "aspect_ratio": PROP_REF_ASPECT_RATIO,
            "image_size": PROP_REF_IMAGE_SIZE,
            "quality": normalize_openai_quality(quality, default="medium"),
            "output_format": "png",
        },
    )

    if image_bytes:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(image_bytes)
        return output_path

    print(f"[PropRefGen] OpenAI 生成失败: {error_text or 'No response'}")
    return None


async def _generate_via_newapi(
    prompt: str,
    output_path: str,
    api_key: str,
    model: str,
    base_url: str,
    quality: str = "medium",
) -> Optional[str]:
    """通过 newAPI 生成道具参考图。"""

    image_bytes, _text_content, error_text = await _call_newapi_image_api(
        api_key=api_key,
        model=model,
        prompt=prompt,
        image_config={
            "aspect_ratio": PROP_REF_ASPECT_RATIO,
            "image_size": normalize_image_size(PROP_REF_IMAGE_SIZE, provider="newapi"),
            "quality": normalize_openai_quality(quality, default="medium"),
            "output_format": "png",
        },
        base_url=base_url,
    )

    if image_bytes:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(image_bytes)
        return output_path

    print(f"[PropRefGen] DramaClawAPI 生成失败: {error_text or 'No response'}")
    return None


def _extract_and_save_image(response, output_path: str) -> Optional[str]:
    """从 Gemini API 响应中提取图像并保存。"""
    if not response.candidates:
        print(f"[PropRefGen] API 响应无 candidates")
        return None

    candidate = response.candidates[0]
    if not candidate.content or not candidate.content.parts:
        finish_reason = getattr(candidate, "finish_reason", "unknown")
        print(f"[PropRefGen] API 响应无 content, finish_reason={finish_reason}")
        return None

    for part in candidate.content.parts:
        if hasattr(part, "inline_data") and part.inline_data:
            image_bytes = part.inline_data.data
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(image_bytes)
            return output_path

        if hasattr(part, "text") and part.text:
            print(f"[PropRefGen] API 文本响应: {part.text[:200]}")

    print("[PropRefGen] API 未返回图像数据")
    return None
