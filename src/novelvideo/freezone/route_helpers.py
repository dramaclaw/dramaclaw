"""Freezone 路由辅助函数。

把 `src/novelvideo/api/routes/freezone.py` 里的纯辅助逻辑抽离出来，
让路由文件更聚焦于接口本身。
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from novelvideo.api.schemas import (
    FreezoneCharacterMultiViewRequest,
    FreezoneImageCameraConfig,
    FreezoneImageStyleConfig,
    FreezoneRelightRequest,
    FreezoneTemplateEditRequest,
)
from novelvideo.config import IMAGE_GENERATION_SELECTIONS
from novelvideo.freezone.paths import resolve_static_url_to_path, safe_upload_filename, uploads_dir
from novelvideo.freezone.video_node import load_video_character_library
from novelvideo.task_identity import task_state_key

FREEZONE_DEFAULT_IMAGE_SELECTION = "newapi_gpt_image2"
FREEZONE_DEFAULT_IMAGE_MODEL = FREEZONE_DEFAULT_IMAGE_SELECTION
SUPPORTED_FREEZONE_IMAGE_PROVIDERS = {"huimeng", "newapi", "openrouter", "openai"}
FREEZONE_IMAGE_CAMERA_OPTIONS = {
    "camera_bodies": [
        {"id": "panavision_dxl2", "label": "Panavision DXL2"},
        {"id": "arri_alexa_65", "label": "ARRI ALEXA 65"},
        {"id": "red_vraptor_xl", "label": "RED V-Raptor XL"},
        {"id": "sony_venice_2", "label": "Sony Venice 2"},
    ],
    "lenses": [
        {"id": "arri_signature_prime", "label": "Arri Signature Prime"},
        {"id": "cooke_s4i", "label": "Cooke S4/i"},
        {"id": "zeiss_supreme_prime", "label": "Zeiss Supreme Prime"},
        {"id": "panavision_primo_70", "label": "Panavision Primo 70"},
    ],
    "focal_lengths_mm": [8, 14, 24, 35, 50, 75, 125],
    "apertures": ["f/1.4", "f/2", "f/2.8", "f/4", "f/5.6", "f/8"],
}
FREEZONE_IMAGE_STYLE_TEMPLATES = [
    {
        "id": "three_oclock_2300",
        "label": "新古典插画 + 美式漫画黄金时代 + 新装饰线条",
        "author": "Three_o_clock",
        "category": "插画",
        "style_prompt": "neo-classical illustration, American golden-age comic influence, decorative linear design, elegant architecture, refined linework, ornamental contour rhythm, polished editorial illustration finish",
    },
    {
        "id": "three_oclock_1800",
        "label": "工笔风现代插画 + 新装饰主义特征",
        "author": "Three_o_clock",
        "category": "插画",
        "style_prompt": "gongbi-inspired modern illustration, delicate contour lines, decorative modernist pattern language, controlled flat color fields, graceful detailing, refined eastern editorial illustration",
    },
    {
        "id": "storybook_watercolor",
        "label": "欧式故事书水彩",
        "author": "builtin",
        "category": "插画",
        "style_prompt": "European storybook watercolor illustration, soft pigment bleeding, delicate paper texture, lyrical composition, gentle edges, warm narrative atmosphere",
    },
    {
        "id": "cinematic_realism",
        "label": "电影感写实",
        "author": "builtin",
        "category": "写实",
        "style_prompt": "cinematic realism, natural skin texture, controlled highlights, subtle film grain, dramatic but grounded lighting, premium production still quality",
    },
    {
        "id": "fashion_editorial",
        "label": "高定时尚大片",
        "author": "builtin",
        "category": "摄影",
        "style_prompt": "high-end fashion editorial photography, luxury styling, clean visual hierarchy, premium magazine finish, elegant dramatic lighting, polished cinematic portraiture",
    },
    {
        "id": "minimalist_ecommerce",
        "label": "极简电商棚拍",
        "author": "builtin",
        "category": "电商",
        "style_prompt": "minimalist e-commerce studio photography, clean backdrop, precise product separation, refined soft-box lighting, premium commercial clarity, neat modern brand presentation",
    },
    {
        "id": "wabi_sabi_product",
        "label": "侘寂风场景摄影",
        "author": "builtin",
        "category": "电商",
        "style_prompt": "wabi-sabi scene photography, restrained earthy palette, quiet texture emphasis, natural imperfections, soft window light, calm premium spatial styling",
    },
    {
        "id": "retro_hk_poster",
        "label": "复古港风电影海报",
        "author": "builtin",
        "category": "海报",
        "style_prompt": "retro Hong Kong movie poster aesthetic, saturated practical lights, moody urban nostalgia, dramatic cinematic contrast, vintage print texture, expressive composition",
    },
    {
        "id": "noir_monochrome",
        "label": "黑白黑色电影",
        "author": "builtin",
        "category": "摄影",
        "style_prompt": "film noir black-and-white photography, high contrast chiaroscuro, deep blacks, smoky atmosphere, hard rim lighting, classic silver-gelatin cinematic mood",
    },
    {
        "id": "cyberpunk_neon",
        "label": "赛博朋克霓虹电影感",
        "author": "builtin",
        "category": "概念",
        "style_prompt": "cyberpunk cinematic atmosphere, neon reflections, humid night surfaces, dense urban depth, futuristic signage glow, high-detail sci-fi production frame",
    },
    {
        "id": "anime_cel_shading",
        "label": "日系动画赛璐璐",
        "author": "builtin",
        "category": "动漫",
        "style_prompt": "anime cel-shaded illustration, clean line art, controlled color blocking, expressive face design, polished 2D production quality, crisp silhouette readability",
    },
    {
        "id": "shoujo_pastel",
        "label": "梦幻少女漫粉彩",
        "author": "builtin",
        "category": "动漫",
        "style_prompt": "dreamy shoujo pastel illustration, airy palette, glowing bloom, soft eyelashes, romantic floral atmosphere, delicate modern manga finish",
    },
    {
        "id": "guochao_ink_poster",
        "label": "国潮水墨海报",
        "author": "builtin",
        "category": "国风",
        "style_prompt": "guochao ink poster design, Chinese ink diffusion, calligraphic energy, layered red-black-gold palette, dramatic negative space, premium modern eastern poster style",
    },
    {
        "id": "tang_dynasty_epic",
        "label": "盛唐史诗美术",
        "author": "builtin",
        "category": "国风",
        "style_prompt": "Tang dynasty epic visual style, sumptuous costume detailing, monumental court atmosphere, ceremonial composition, rich gold-red-blue palette, historical cinematic grandeur",
    },
    {
        "id": "ukiyoe_modern",
        "label": "浮世绘现代重构",
        "author": "builtin",
        "category": "插画",
        "style_prompt": "modern ukiyo-e reinterpretation, elegant contour flow, flat yet sophisticated color planes, graphic wave and textile rhythm, vintage Japanese print sensibility",
    },
    {
        "id": "paper_cut_folk",
        "label": "剪纸民艺图形",
        "author": "builtin",
        "category": "平面",
        "style_prompt": "paper-cut folk art graphic style, bold silhouette layering, decorative symmetry, handcrafted edge rhythm, festive but refined flat design language",
    },
    {
        "id": "oil_painting_classical",
        "label": "古典油画质感",
        "author": "builtin",
        "category": "绘画",
        "style_prompt": "classical oil painting texture, layered brushwork, controlled varnish glow, museum-grade portrait lighting, painterly depth, rich tonal transitions",
    },
    {
        "id": "toy_render_premium",
        "label": "高端潮玩 3D 渲染",
        "author": "builtin",
        "category": "3D",
        "style_prompt": "premium collectible toy 3D render, smooth material fidelity, designer-toy proportion control, crisp studio highlights, polished commercial rendering finish",
    },
    {
        "id": "mecha_concept_art",
        "label": "机甲概念艺术",
        "author": "builtin",
        "category": "概念",
        "style_prompt": "high-detail mecha concept art, industrial surface breakup, cinematic scale cues, technical panel complexity, atmospheric perspective, premium entertainment design sheet quality",
    },
    {
        "id": "children_crayon",
        "label": "稚趣蜡笔绘本",
        "author": "builtin",
        "category": "儿童",
        "style_prompt": "children's crayon picture-book illustration, playful shape simplification, warm handmade texture, colorful wax stroke feel, friendly storytelling composition",
    },
    {
        "id": "sci_fi_brutalism",
        "label": "科幻粗野主义场景",
        "author": "builtin",
        "category": "概念",
        "style_prompt": "sci-fi brutalist environment design, monumental concrete geometry, austere futuristic scale, severe atmospheric lighting, hard-edged spatial rhythm, premium cinematic concept frame",
    },
    {
        "id": "japanese_street_snapshot",
        "label": "日系街拍胶片",
        "author": "builtin",
        "category": "摄影",
        "style_prompt": "Japanese street snapshot photography, soft film grain, natural candid framing, everyday city poetry, slightly faded color response, intimate documentary atmosphere",
    },
    {
        "id": "luxury_jewelry_macro",
        "label": "高级珠宝微距",
        "author": "builtin",
        "category": "电商",
        "style_prompt": "luxury jewelry macro photography, razor-sharp gem facets, elegant specular highlights, premium black-box lighting, ultra-clean metal finish, prestigious commercial beauty shot",
    },
    {
        "id": "game_card_splash",
        "label": "卡牌游戏立绘",
        "author": "builtin",
        "category": "游戏",
        "style_prompt": "heroic card-game splash art, dynamic silhouette hierarchy, dramatic color separation, polished fantasy rendering, collectible-grade character presentation, high-impact promotional composition",
    },
    {
        "id": "indie_film_16mm",
        "label": "独立电影 16mm",
        "author": "builtin",
        "category": "摄影",
        "style_prompt": "indie film 16mm aesthetic, tactile grain structure, natural available light, imperfect handheld intimacy, muted organic palette, emotionally grounded cinematic realism",
    },
    {
        "id": "nordic_home_lifestyle",
        "label": "北欧家居生活方式",
        "author": "builtin",
        "category": "家居",
        "style_prompt": "Nordic home lifestyle photography, bright but soft daylight, breathable negative space, warm neutral palette, natural wood and fabric texture, tasteful editorial domestic calm",
    },
    {
        "id": "dark_fantasy_painterly",
        "label": "暗黑奇幻厚涂",
        "author": "builtin",
        "category": "绘画",
        "style_prompt": "dark fantasy painterly illustration, heavy textured brushwork, ominous atmosphere, rich shadow masses, dramatic magical contrast, premium concept-painting finish",
    },
    {
        "id": "isometric_city_diagram",
        "label": "等距城市图解",
        "author": "builtin",
        "category": "平面",
        "style_prompt": "isometric city diagram illustration, clean architectural logic, compact urban layering, readable infographics structure, crisp vector-like detailing, polished editorial map aesthetic",
    },
    {
        "id": "vintage_food_ad",
        "label": "复古食品广告",
        "author": "builtin",
        "category": "广告",
        "style_prompt": "vintage food advertisement aesthetic, appetizing warm tones, cheerful retro styling, print-era graphic layout sensibility, nostalgic commercial polish, inviting tabletop hero shot",
    },
    {
        "id": "future_ui_blueprint",
        "label": "未来 UI 蓝图",
        "author": "builtin",
        "category": "科技",
        "style_prompt": "futuristic UI blueprint aesthetic, luminous interface geometry, technical line precision, holographic system layering, clean sci-fi information design, premium product vision presentation",
    },
]


def resolve_freezone_image_provider(provider: Optional[str], *, strict: bool = True) -> str:
    """把 Freezone 图片 provider 归一化到当前支持的 SuperTale 范围内。"""
    if provider and provider.strip():
        normalized = provider.strip().lower()
        if normalized not in SUPPORTED_FREEZONE_IMAGE_PROVIDERS:
            if not strict:
                return "newapi"
            raise HTTPException(
                400,
                "unsupported freezone image provider: "
                f"{provider}; expected one of {sorted(SUPPORTED_FREEZONE_IMAGE_PROVIDERS)}",
            )
        return normalized

    return "newapi"


def new_freezone_job_id() -> str:
    return uuid.uuid4().hex[:16]


def resolve_url_list(project_dir: Path, urls: list[str]) -> list[str]:
    out: list[str] = []
    for u in urls:
        if not u:
            continue
        try:
            out.append(resolve_static_url_to_path(u, project_dir).as_posix())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    return out


def ensure_existing_paths(paths: list[str], *, field_name: str) -> None:
    """Fail fast when request URLs resolve but files do not exist on disk."""
    for path_text in paths:
        path = Path(path_text)
        if not path.exists():
            raise HTTPException(404, f"{field_name} file not found: {path}")


def accepted_job_response(
    *,
    task_type: str,
    username: str,
    project: str,
    job_id: str,
) -> dict:
    return {
        "ok": True,
        "data": {
            "task_type": task_type,
            "job_id": job_id,
            "task_key": task_state_key(task_type, username, project, episode=0, scope=job_id),
        },
    }


def get_freezone_image_camera_options() -> dict:
    return FREEZONE_IMAGE_CAMERA_OPTIONS


def get_freezone_image_style_templates() -> list[dict]:
    return list(FREEZONE_IMAGE_STYLE_TEMPLATES)


def build_camera_prompt(camera: Optional[FreezoneImageCameraConfig]) -> str:
    if camera is None:
        return ""

    parts: list[str] = []
    if str(camera.camera_body or "").strip():
        parts.append(str(camera.camera_body).strip())
    if str(camera.lens or "").strip():
        parts.append(str(camera.lens).strip())
    if camera.focal_length_mm:
        parts.append(f"{int(camera.focal_length_mm)}mm")
    if str(camera.aperture or "").strip():
        parts.append(str(camera.aperture).strip())
    if not parts:
        return ""

    return (
        "Camera setup:\n"
        f"- {' | '.join(parts)}\n"
        "- Preserve this camera language in framing, lens feel, depth rendition, and overall optical character where applicable."
    )


def merge_prompt_with_camera(prompt: str, camera: Optional[FreezoneImageCameraConfig]) -> str:
    camera_block = build_camera_prompt(camera)
    base = (prompt or "").strip()
    if base and camera_block:
        return f"{base}\n\n{camera_block}"
    if camera_block:
        return camera_block
    return base


def resolve_freezone_image_style_template(style: Optional[FreezoneImageStyleConfig]) -> Optional[dict]:
    if style is None:
        return None
    template_id = str(style.template_id or "").strip()
    if not template_id:
        return None
    for item in FREEZONE_IMAGE_STYLE_TEMPLATES:
        if item["id"] == template_id:
            return item
    raise HTTPException(400, f"unknown image style template: {template_id}")


def build_style_prompt(style: Optional[FreezoneImageStyleConfig]) -> str:
    template = resolve_freezone_image_style_template(style)
    if template is None:
        return ""
    return (
        "Style template:\n"
        f"- {template['label']} ({template['author']})\n"
        f"- {template['style_prompt']}"
    )


def merge_prompt_with_style_and_camera(
    prompt: str,
    style: Optional[FreezoneImageStyleConfig],
    camera: Optional[FreezoneImageCameraConfig],
) -> str:
    base = (prompt or "").strip()
    style_block = build_style_prompt(style)
    camera_block = build_camera_prompt(camera)
    parts = [part for part in [base, style_block, camera_block] if part]
    return "\n\n".join(parts)


def load_video_character_items_by_ids(project_dir: Path, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    items = load_video_character_library(project_dir)
    mapping = {str(item.get("id")): item for item in items}
    missing = [item_id for item_id in ids if item_id not in mapping]
    if missing:
        raise HTTPException(404, f"video character library item not found: {missing[0]}")
    return [mapping[item_id] for item_id in ids]


def split_provider_and_model(
    provider: Optional[str],
    model: Optional[str],
    *,
    fallback_model: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """解析 Freezone 图片模型。"""
    model_text = str(model or "").strip()
    if model_text:
        if model_text in IMAGE_GENERATION_SELECTIONS:
            entry = IMAGE_GENERATION_SELECTIONS[model_text]
            return entry["provider"], entry["model"]

    if provider:
        return provider, model_text or fallback_model
    if model_text and "/" in model_text:
        provider_token, model_token = model_text.split("/", 1)
        if provider_token in SUPPORTED_FREEZONE_IMAGE_PROVIDERS:
            return provider_token, model_token or fallback_model
    return provider, model_text or fallback_model


def start_freezone_gen_job(
    *,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: Path,
    prompt: str,
    aspect_ratio: str,
    image_size: str,
    reference_urls: list[str],
    camera: Optional[FreezoneImageCameraConfig],
    style: Optional[FreezoneImageStyleConfig],
    provider: Optional[str],
    model: Optional[str],
    quality: Optional[str],
    canvas_id: Optional[str] = None,
    node_id: Optional[str] = None,
) -> dict:
    reference_paths = resolve_url_list(project_dir, reference_urls)
    ensure_existing_paths(reference_paths, field_name="reference")

    raise HTTPException(503, "freezone gen task requires project task backend（当前 runner: Celery）")


def start_freezone_edit_job(
    *,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: Path,
    prompt: str,
    base_url: str,
    extra_reference_urls: list[str],
    aspect_ratio: str,
    image_size: str,
    camera: Optional[FreezoneImageCameraConfig],
    style: Optional[FreezoneImageStyleConfig],
    provider: Optional[str],
    model: Optional[str],
    quality: Optional[str],
    canvas_id: Optional[str] = None,
    node_id: Optional[str] = None,
) -> dict:
    base_paths = resolve_url_list(project_dir, [base_url])
    if not base_paths:
        raise HTTPException(400, "base_url is required")
    ensure_existing_paths(base_paths, field_name="base")
    extra_paths = resolve_url_list(project_dir, extra_reference_urls)
    ensure_existing_paths(extra_paths, field_name="reference")

    raise HTTPException(503, "freezone edit task requires project task backend（当前 runner: Celery）")


def notes_suffix(*, style: str, notes: str, user_prompt: str) -> str:
    lines = [f"Style: {style}."]
    if notes.strip():
        lines.append(f"Extra notes: {notes.strip()}.")
    if user_prompt.strip():
        lines.append(f"User prompt:\n{user_prompt.strip()}")
    lines.extend(
        [
            "",
            "Hard requirements:",
            "- Production-ready SuperTale asset candidate.",
            "- No text, watermark, UI frame, contact sheet, or collage unless explicitly requested.",
            "- Preserve useful identity / scene / prop cues from references.",
        ]
    )
    return "\n".join(lines)


def infer_scene_id_from_master_path(path: Path, project_dir: Path) -> str:
    try:
        rel_parts = path.relative_to(project_dir).parts
    except ValueError:
        rel_parts = path.parts
    for index in range(len(rel_parts) - 1):
        if rel_parts[index] == "scenes" and index + 1 < len(rel_parts):
            return rel_parts[index + 1]
    return path.parent.name or "the target scene"


def build_scene_360_prompt(scene_id: str) -> str:
    normalized_scene_id = (scene_id or "").strip() or "the target scene"
    return (
        f"Generate a 360-degree equirectangular panorama image in exact 2:1 "
        f"aspect ratio for scene `{normalized_scene_id}`.\n\n"
        "INPUT IMAGE ROLE:\n"
        "- Reference image 1 = MASTER VISUAL BIBLE.\n"
        "- It controls art style, material style, linework, color palette, lighting mood, and fixed scene design.\n"
        "- Reference image 1 is NOT the final camera view.\n"
        "- Do NOT copy its single frontal composition. Use it only as visual/style/material evidence while constructing a full 360-degree continuous environment.\n\n"
        "LAYER MODE: FULL ENVIRONMENT\n"
        "- Generate the complete environment and fixed fixtures only.\n"
        "- No people, no characters, no story action, and no temporary story props.\n\n"
        "PROJECTION REQUIREMENTS:\n"
        "- Correct equirectangular spherical panorama projection.\n"
        "- Output must be one continuous 2:1 panorama, suitable for a VR/360 panorama viewer.\n"
        "- Camera is fixed at the center of the scene at normal human eye height.\n"
        "- Full 360-degree environment around the camera.\n"
        "- Left and right edges must connect seamlessly with no visible seam.\n"
        "- Horizon must be level and centered.\n"
        "- Use normal VR panorama projection: no single flat wide shot, no cubemap atlas, no borders, no multi-panel sheet.\n"
        "- Geometry must remain stable after spherical wrapping.\n"
        "- Ceiling and floor poles must be clean continuous surfaces, with no black holes, labels, mirrors, sliced objects, or heavy stretching.\n\n"
        "NEGATIVE REQUIREMENTS:\n"
        "- Not a normal wide-angle illustration.\n"
        "- Not fisheye lens.\n"
        "- Not cubemap faces.\n"
        "- No labels, no UI, no watermark.\n"
        "- No broken seam, no duplicated doorway at seam, no mirrored left/right halves.\n"
        "- No photorealism drift if the reference is stylized."
    )


def build_multi_view_prompt(body: FreezoneCharacterMultiViewRequest) -> str:
    preset_map = {
        "custom": "custom camera reposition",
        "fisheye": "fisheye angle",
        "oblique": "oblique angle",
        "front": "front-facing shot",
        "front_up": "front low-angle shot",
        "full_body": "full-body shot",
        "back": "back view shot",
    }
    shot_size_map = {
        "extreme_close_up": "extreme close-up",
        "close_up": "close-up",
        "medium_close": "medium close-up",
        "medium": "medium shot",
        "full_body": "full-body shot",
        "wide": "wide shot",
        "extreme_wide": "extreme wide shot",
    }
    preset_text = preset_map.get(body.preset, "custom camera reposition")
    shot_size_text = shot_size_map.get(body.shot_size, "medium shot")
    user_block = f"\nUser prompt:\n{body.prompt.strip()}" if body.prompt.strip() else ""
    return (
        "Reframe the provided source image into a new camera angle while preserving the same scene, "
        "same characters, same identities, same costume continuity, and same lighting logic unless explicitly changed.\n\n"
        f"Preset target: {preset_text}.\n"
        f"Horizontal rotation: {body.yaw_degrees:.1f} degrees.\n"
        f"Vertical tilt: {body.pitch_degrees:.1f} degrees.\n"
        f"Shot size: {shot_size_text}.\n"
        f"{user_block}\n\n"
        "Output requirements:\n"
        "- Keep the image as one single final frame, not a contact sheet.\n"
        "- Preserve facial identity and scene continuity.\n"
        "- Infer plausible unseen content when the requested angle reveals new areas.\n"
        "- Do not add text, UI, borders, watermark, or collage layout.\n"
        "- Keep the result production-ready and visually coherent."
    )


def _describe_color_temperature(kelvin: int | None) -> str | None:
    if kelvin is None:
        return None
    if kelvin < 2400:
        tone = "very warm candlelight / firelight"
    elif kelvin < 3500:
        tone = "warm tungsten / amber practical light"
    elif kelvin < 5000:
        tone = "soft warm white light"
    elif kelvin < 6200:
        tone = "neutral daylight-balanced white light"
    elif kelvin < 8000:
        tone = "cool white daylight"
    else:
        tone = "very cool blue-hour / overcast light"
    return f"{kelvin}K ({tone})"


def build_relight_prompt(body: FreezoneRelightRequest) -> str:
    base = (body.prompt or "").strip()
    reference_block = (
        "- Reference image 2 = lighting reference image.\n"
        "- Use it to transfer the lighting mood, contrast, exposure logic, shadow behavior, and color temperature.\n"
        if body.lighting_reference_url
        else "- No lighting reference image is attached. Infer the lighting design from the requested controls.\n"
    )
    smart_block = "enabled" if body.smart_mode else "disabled"
    rim_block = "enabled" if body.rim_light else "disabled"
    color_temperature = _describe_color_temperature(body.color_temperature_kelvin)
    color_temperature_control = (
        f"\n- Color temperature: {color_temperature}." if color_temperature else ""
    )
    prefix = f"""Relight the provided source image.

INPUT IMAGE ROLES:
- Reference image 1 = source image to be relit.
{reference_block}

RELIGHT CONTROLS:
- Scope: {body.scope}.
- Smart mode: {smart_block}.
- Brightness: {body.brightness}/100.
- Key light color / overall color tone: {body.color_hex}.{color_temperature_control}
- Key light direction: {body.key_light_direction}.
- Rim light: {rim_block}.

RELIGHTING CONTRACT:
- Keep the same scene, same subjects, same camera framing, and same composition.
- Preserve facial identity, costume continuity, and environment layout.
- Transfer or infer only the lighting characteristics: light direction, softness/hardness, contrast ratio, color temperature, shadow density, highlight behavior, and overall mood.
- Do not turn the image into a different scene.
- Do not add text, watermark, UI, borders, or collage layout.
- Keep the result production-ready and visually coherent."""
    return f"{prefix}\n\n{base}" if base else prefix


def build_template_edit_prompt(body: FreezoneTemplateEditRequest) -> str:
    user_block = f"\n\nUser prompt:\n{body.prompt.strip()}" if body.prompt.strip() else ""
    templates: dict[str, tuple[str, str]] = {
        "multi_camera_nine_grid": (
            "original",
            "Generate a libtv-style 3x3 director multi-camera contact sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Final output must be one readable 3x3 grid contact sheet, not nine separate images.\n"
            "- Keep the same primary subject, same costume, same scene, same time moment, and same action.\n"
            "- Do not add new characters, new dialogue, new story events, or unrelated props.\n"
            "- Each cell must preserve the source image aspect ratio and orientation.\n"
            "- Do not crop each camera view into a different ratio.\n"
            "- Vary only camera coverage: shot size, camera height, lens distance, and angle.\n"
            "- Each panel must look like a usable director coverage frame from the same shot setup.\n"
            "- Add a small white label in the upper-left corner of every cell.\n"
            "- Use exactly these nine labels and shot types in reading order:\n"
            "  [KF1 | 3s | ELS] extreme long shot / full environment,\n"
            "  [KF2 | 2s | LS] long shot / full body,\n"
            "  [KF3 | 2s | MLS] medium long shot,\n"
            "  [KF4 | 2s | MS] medium shot,\n"
            "  [KF5 | 2s | MCU] medium close-up,\n"
            "  [KF6 | 2s | CU] close-up,\n"
            "  [KF7 | 1s | ECU] extreme close-up of the key hand/object/detail,\n"
            "  [KF8 | 2s | High-Angle] high-angle view,\n"
            "  [KF9 | 2s | Low-Angle] low-angle view.\n"
            "- Use thin dark grid lines between cells; no large white gutters, no decorative border.\n"
            "- Fill the whole output canvas; do not add black bars, letterboxing, UI, or watermark.\n"
            "- Preserve identity, costume, lighting mood, color tone, and scene continuity across all cells.",
        ),
        "story_pitch_four_grid": (
            "original",
            "Generate a 2x2 story pitch board from the source image.\n\n"
            "Output requirements:\n"
            "- Create four consecutive pitch frames that expand the current story moment.\n"
            "- Keep the same characters, scene, and dramatic context.\n"
            "- Emphasize clear story progression and emotional beats.\n"
            "- Each cell must preserve the source image aspect ratio and orientation.\n"
            "- Do not crop each story frame into a different ratio.\n"
            "- Arrange the four same-ratio frames in a clean 2x2 grid with thin dividers.\n"
            "- Fill the whole output canvas; do not add black bars, letterboxing, UI, or watermark.",
        ),
        "character_face_three_view": (
            "3:2",
            "Generate a clean three-view face sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Show front view, three-quarter view, and side view of the same face.\n"
            "- Preserve facial identity, age, hairstyle, skin tone, and expression logic.\n"
            "- Use a clean reference-sheet style.\n"
            "- Final output must be a compact three-view face layout.",
        ),
        "product_three_view": (
            "3:2",
            "Generate a clean three-view product reference sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Show front, side, and back/alternate view of the same product.\n"
            "- Preserve materials, silhouette, proportions, and key details.\n"
            "- Use a clean product reference layout with neutral presentation.\n"
            "- Final output must be a three-view sheet.",
        ),
        "storyboard_25_grid": (
            "original",
            "Generate a libtv-style 5x5 cinematic storyboard shot sequence from the source image.\n\n"
            "Output requirements:\n"
            "- Final output must be one readable 5x5 storyboard contact sheet, not 25 separate images.\n"
            "- Build a coherent shot progression around the same core event in the source image.\n"
            "- Do not create random variants, unrelated future scenes, or a new ending.\n"
            "- Preserve the visible subjects, identities, costumes/materials, environment, lighting mood, "
            "and key objects from the source image.\n"
            "- Adapt the sequence to the actual source content. Do not invent dialogue, extra characters, "
            "paper, weapons, vehicles, or props that are not visible or strongly implied.\n"
            "- Organize the 25 cells like an editable film sequence:\n"
            "  1-3 establishing coverage of the location, subject placement, and spatial relationship,\n"
            "  4-6 primary subject close-ups, detail views, or reaction shots when characters exist,\n"
            "  7-10 alternate angles, over-the-shoulder or eye-line coverage only when applicable,\n"
            "  11-15 step-by-step progression of the visible key action or the most plausible next micro-action,\n"
            "  16-19 inserts and extreme close-ups of visible key details: hands, face, eyes, object, "
            "texture, signage, machinery, landscape feature, or environment clue,\n"
            "  20-22 pause, reaction, consequence, or atmospheric detail beats,\n"
            "  23-25 restrained resolution frames that stay in the same scene and subject context.\n"
            "- Mix shot types deliberately: wide, medium, close-up, extreme close-up, insert, reaction/detail. "
            "Use OTS only when the source contains a valid over-shoulder relationship.\n"
            "- Avoid repeating the same two-shot or portrait composition across many cells.\n"
            "- Number each cell unobtrusively in the upper-left corner from 1 to 25.\n"
            "- Each cell must preserve the source image aspect ratio and orientation.\n"
            "- Do not crop each storyboard frame into a different ratio.\n"
            "- Arrange the twenty-five same-ratio frames in a clean 5x5 grid with thin dividers.\n"
            "- Fill the whole output canvas; do not add black bars, letterboxing, UI, or watermark.",
        ),
        "cinematic_light_correction": (
            "original",
            "Cinematically refine the source image lighting.\n\n"
            "Output requirements:\n"
            "- Improve light hierarchy, shadow structure, exposure balance, and atmosphere.\n"
            "- Preserve the source image aspect ratio, canvas dimensions, and orientation exactly.\n"
            "- Keep the same scene, same characters, and same camera framing.\n"
            "- Do not turn the image into a different composition.\n"
            "- Fill the whole existing canvas; do not add black bars, borders, or letterboxing.\n"
            "- Final output must remain a single frame with no collage, UI, watermark, or text.",
        ),
        "character_three_view_generation": (
            "16:9",
            "Generate a clean character three-view sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Show front, side, and back/full-figure view of the same character.\n"
            "- Preserve face identity, body proportions, costume details, and style.\n"
            "- Keep the presentation clean and reference-friendly.\n"
            "- Final output must be a three-view character sheet.",
        ),
        "image_projection_after_3s": (
            "original",
            "Create a future keyframe from the source image, as if this is a libtv-style "
            "frame projection 3 seconds later in a video.\n\n"
            "Output requirements:\n"
            "- Preserve character identity, costume, environment, art style, and story continuity.\n"
            "- Preserve the source image aspect ratio, canvas dimensions, and orientation exactly.\n"
            "- Fill the whole existing canvas; do not add black bars, borders, or letterboxing.\n"
            "- Do not make a near-duplicate or simple retouch of the source image.\n"
            "- Create a clear time jump: the subject must be in a different action phase, "
            "body pose, walking position, hand position, gaze, and object placement.\n"
            "- Within the same frame size, use plausible camera pan, tilt, push, pull, or subject "
            "relocation to make the temporal change obvious.\n"
            "- Allow doors, props, cloth, hair, shadows, and nearby environment details to change "
            "according to the action, while keeping spatial continuity coherent.\n"
            "- The projected moment should feel like a real adjacent video frame, not a retouched still.\n"
            "- Final output must be one single frame with no collage, UI, watermark, or text.",
        ),
        "image_projection_before_5s": (
            "original",
            "Create a past keyframe from the source image, as if this is a libtv-style "
            "frame projection 5 seconds before in a video.\n\n"
            "Output requirements:\n"
            "- Preserve character identity, costume, environment, art style, and story continuity.\n"
            "- Preserve the source image aspect ratio, canvas dimensions, and orientation exactly.\n"
            "- Fill the whole existing canvas; do not add black bars, borders, or letterboxing.\n"
            "- Do not make a near-duplicate or simple retouch of the source image.\n"
            "- Create a clear earlier setup: the subject must be in a different action phase, "
            "body pose, walking position, hand position, gaze, and object placement.\n"
            "- Within the same frame size, use plausible camera pan, tilt, push, pull, or subject "
            "relocation to make the earlier moment obvious.\n"
            "- Allow doors, props, cloth, hair, shadows, and nearby environment details to change "
            "according to the preceding action, while keeping spatial continuity coherent.\n"
            "- The projected moment should feel like a real adjacent video frame, not a retouched still.\n"
            "- Final output must be one single frame with no collage, UI, watermark, or text.",
        ),
    }
    template = templates.get(body.mode)
    if not template:
        raise HTTPException(400, f"unsupported template edit mode: {body.mode}")
    _, prompt = template
    return f"{prompt}{user_block}"


def template_edit_aspect_ratio(mode: str) -> str:
    ratios: dict[str, str] = {
        "multi_camera_nine_grid": "original",
        "story_pitch_four_grid": "original",
        "character_face_three_view": "3:2",
        "product_three_view": "3:2",
        "storyboard_25_grid": "original",
        "cinematic_light_correction": "original",
        "character_three_view_generation": "16:9",
        "image_projection_after_3s": "original",
        "image_projection_before_5s": "original",
    }
    return ratios.get(mode, "16:9")


def parse_aspect_ratio(value: str) -> tuple[int, int]:
    text = str(value or "").strip().replace("-", ":").replace(" ", "")
    try:
        w_text, h_text = text.split(":", 1)
        w = int(w_text)
        h = int(h_text)
    except (AttributeError, TypeError, ValueError) as exc:
        raise HTTPException(400, f"invalid aspect_ratio: {value!r}") from exc
    if w <= 0 or h <= 0:
        raise HTTPException(400, f"invalid aspect_ratio: {value!r}")
    return w, h


def prepare_padded_outpaint_base(
    *,
    source_path: Path,
    project_dir: Path,
    target_aspect_ratio: str,
) -> Path:
    """先给原图补白到更大的画布，再让基于 edit 的 outpaint 能向外扩展。"""
    from PIL import Image

    src = source_path
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")

    target_w_ratio, target_h_ratio = parse_aspect_ratio(target_aspect_ratio)
    with Image.open(src) as image:
        image_rgba = image.convert("RGBA")
        width, height = image_rgba.size
        if width <= 0 or height <= 0:
            raise HTTPException(400, f"invalid source image size: {src}")

        current_ratio = width / height
        target_ratio = target_w_ratio / target_h_ratio
        if abs(current_ratio - target_ratio) < 1e-4:
            return src

        if current_ratio > target_ratio:
            canvas_width = width
            canvas_height = max(height, round(width / target_ratio))
        else:
            canvas_height = height
            canvas_width = max(width, round(height * target_ratio))

        canvas = Image.new("RGBA", (canvas_width, canvas_height), (255, 255, 255, 0))
        offset_x = (canvas_width - width) // 2
        offset_y = (canvas_height - height) // 2
        canvas.alpha_composite(image_rgba, (offset_x, offset_y))

        padded_name = safe_upload_filename(f"outpaint_base_{src.stem}.png")
        padded_path = uploads_dir(project_dir) / padded_name
        padded_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(padded_path, format="PNG")
        return padded_path


def resolve_outpaint_aspect_ratio(source_path: Path, target_aspect_ratio: str) -> str:
    if str(target_aspect_ratio or "").strip().lower() != "original":
        return target_aspect_ratio
    from math import gcd

    from PIL import Image

    with Image.open(source_path) as image:
        width, height = image.size
    if width <= 0 or height <= 0:
        raise HTTPException(400, f"invalid source image size: {source_path}")

    normalized_gcd = gcd(width, height)
    normalized_ratio = f"{width // normalized_gcd}:{height // normalized_gcd}"
    supported_ratios = {
        "1:1",
        "3:2",
        "2:3",
        "16:9",
        "9:16",
        "5:4",
        "4:5",
        "4:3",
        "3:4",
        "21:9",
        "9:21",
        "1:3",
        "3:1",
        "2:1",
        "1:2",
    }
    if normalized_ratio in supported_ratios:
        return normalized_ratio

    current_ratio = width / height
    closest_ratio = min(
        supported_ratios,
        key=lambda ratio: abs((parse_aspect_ratio(ratio)[0] / parse_aspect_ratio(ratio)[1]) - current_ratio),
    )
    return closest_ratio


def build_outpaint_prompt() -> str:
    return (
        "Extend the existing image outward beyond its current borders. "
        "Preserve the original composition, subject identity, style, and camera framing in the center. "
        "Fill only the newly added outer canvas areas naturally and seamlessly. "
        "Do not crop, stretch, or replace the original visible content."
    )


def build_redraw_prompt(prompt: str) -> str:
    base = (prompt or "").strip()
    prefix = (
        "Redraw and refine the provided image while preserving the core composition, subject identity, "
        "camera angle, and scene intent unless the prompt explicitly asks for changes."
    )
    return f"{prefix}\n\n{base}" if base else prefix


def build_erase_prompt() -> str:
    return (
        "Remove the content inside the masked region and fill it in naturally. "
        "Preserve the surrounding composition, subject identity, lighting, perspective, and image style. "
        "The regenerated area must blend seamlessly with nearby pixels and should not leave obvious "
        "repair traces, repeated textures, or artifacts."
    )


def build_upscale_prompt() -> str:
    return (
        "Upscale and restore the image while preserving the original composition, subject identity, "
        "lighting, perspective, and style. Improve sharpness, edge definition, material detail, "
        "skin and fabric texture fidelity, and overall clarity naturally. Do not redesign the image, "
        "change the framing, alter the subject, or introduce extra objects, text, watermark, or artifacts."
    )


def resolve_upscale_dimensions(source_path: Path, scale_factor: int) -> tuple[int, int]:
    from PIL import Image

    with Image.open(source_path) as image:
        width, height = image.size
    if width <= 0 or height <= 0:
        raise HTTPException(400, f"invalid source image size: {source_path}")
    return width * scale_factor, height * scale_factor
