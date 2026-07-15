"""Freezone 视频节点辅助逻辑。

包含：
- 文生视频运镜模板库
- 角色素材库本地持久化
- 视频提示词组装
- 全能参考输入校验
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from novelvideo.freezone.paths import freezone_root


VIDEO_CAMERA_TEMPLATES: list[dict[str, str]] = [
    {
        "id": "locked_off",
        "name": "固定镜头",
        "prompt": "镜头固定，机位稳定，不推不摇不移，由角色和环境自然完成表演。",
    },
    {
        "id": "follow_tracking",
        "name": "跟随拍摄",
        "prompt": "镜头持续跟随主体移动，保持主角始终处于视觉中心，运动自然顺滑。",
    },
    {
        "id": "orbit_up",
        "name": "盘旋抬升",
        "prompt": "镜头围绕主体盘旋，同时缓慢抬升，营造空间展开和情绪提升。",
    },
    {
        "id": "orbit_down",
        "name": "盘旋下降",
        "prompt": "镜头围绕主体盘旋，同时缓慢下降，营造压迫感和沉浸式包围。",
    },
    {
        "id": "tilt_up",
        "name": "镜头上摇",
        "prompt": "镜头从下往上平滑上摇，逐步揭示主体上方信息与空间高度。",
    },
    {
        "id": "tilt_down",
        "name": "镜头下摇",
        "prompt": "镜头从上往下平滑下摇，逐步聚焦主体动作与地面细节。",
    },
    {
        "id": "pan_left",
        "name": "镜头左摇",
        "prompt": "镜头向左平滑横摇，带出画面左侧环境与叙事信息。",
    },
    {
        "id": "pan_right",
        "name": "镜头右摇",
        "prompt": "镜头向右平滑横摇，带出画面右侧环境与叙事信息。",
    },
    {
        "id": "pedestal_up",
        "name": "镜头上升",
        "prompt": "镜头整体垂直上升，视角逐步抬高，增强空间层次和临场感。",
    },
    {
        "id": "pedestal_down",
        "name": "镜头下降",
        "prompt": "镜头整体垂直下降，视角逐步压低，强化人物压迫和沉浸感。",
    },
    {
        "id": "truck_left",
        "name": "镜头左移",
        "prompt": "镜头整体向左平移，保持运镜稳定，突出场景横向调度。",
    },
    {
        "id": "truck_right",
        "name": "镜头右移",
        "prompt": "镜头整体向右平移，保持运镜稳定，突出场景横向调度。",
    },
]

LEGACY_FREEZONE_VIDEO_BACKEND_ALIASES: dict[str, str] = {
    "huimeng_seedance20_fast": "newapi_seedance-2.0-fast",
    "huimeng_seedance-2.0-fast": "newapi_seedance-2.0-fast",
    "seedance_2": "newapi_seedance-2.0-fast",
    "huimeng_seedance10_fast": "newapi_seedance-1.0-pro-fast",
    "huimeng_seedance-1.0-pro-fast": "newapi_seedance-1.0-pro-fast",
    "seedance_fast": "newapi_seedance-1.0-pro-fast",
    "huimeng_seedance15_pro": "newapi_seedance-1.5-pro",
    "huimeng_seedance-1.5-pro": "newapi_seedance-1.5-pro",
    "seedance_pro": "newapi_seedance-1.5-pro",
    "seedance_pro_silent": "newapi_seedance-1.5-pro",
}

LEGACY_FREEZONE_VIDEO_LABEL_ALIASES: dict[str, str] = {
    "huimeng seedance 2.0 fast": "newapi_seedance-2.0-fast",
    "huimeng seedance 1.0 pro fast": "newapi_seedance-1.0-pro-fast",
    "huimeng seedance 1.5 pro": "newapi_seedance-1.5-pro",
    "seedance 1.0 fast": "newapi_seedance-1.0-pro-fast",
    "seedance 1.5 有声": "newapi_seedance-1.5-pro",
    "seedance 1.5 无声": "newapi_seedance-1.5-pro",
}

FREEZONE_DEFAULT_VIDEO_BACKEND = "newapi_seedance-2.0-fast"
FREEZONE_NEWAPI_VIDEO_BACKENDS = {
    "newapi_seedance-2.0",
    "newapi_seedance-2.0-fast",
    "newapi_seedance-2.0-value",
    "newapi_seedance-2.0-fast-value",
    "newapi_seedance-1.0-pro-fast",
    "newapi_seedance-1.5-pro",
    "newapi_happyhorse-1.0",
    "newapi_grok-video-channel",
}


def get_video_camera_templates() -> list[dict[str, str]]:
    return [dict(item) for item in VIDEO_CAMERA_TEMPLATES]


def get_video_camera_template(template_id: str | None) -> dict[str, str] | None:
    if not template_id:
        return None
    for item in VIDEO_CAMERA_TEMPLATES:
        if item["id"] == template_id:
            return dict(item)
    return None


def normalize_video_aspect_ratio(value: str | None) -> str:
    text = str(value or "").strip().lower()
    if not text or text == "auto":
        return "16:9"
    return text


def normalize_video_resolution(value: str | None) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return "720p"
    return text


FREEZONE_SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL: dict[str, tuple[str, ...]] = {
    "seedance-2.0-fast": ("480p", "720p"),
    "seedance-2.0": ("480p", "720p", "1080p"),
    "seedance-2.0-value": ("720p", "1080p"),
    "seedance-2.0-fast-value": ("720p", "1080p"),
}
FREEZONE_DEFAULT_VIDEO_RESOLUTION_OPTIONS = ("480p", "720p", "1080p")
FREEZONE_DEFAULT_SEEDANCE2_RESOLUTION_OPTIONS = ("480p", "720p")
FREEZONE_HAPPYHORSE_RESOLUTION_OPTIONS = ("720p", "1080p")
FREEZONE_GROK_VIDEO_CHANNEL_RESOLUTION_OPTIONS = ("720p", "480p")


def _freezone_video_model_from_backend(backend: str | None) -> str:
    text = str(backend or "").strip().lower()
    for prefix in ("newapi_", "huimeng_", "huimengi_"):
        if text.startswith(prefix):
            return text[len(prefix) :].strip()
    return text


def freezone_video_resolution_options(backend: str | None) -> tuple[str, ...]:
    model = _freezone_video_model_from_backend(backend)
    if model == "grok-video-channel":
        return FREEZONE_GROK_VIDEO_CHANNEL_RESOLUTION_OPTIONS
    if model == "happyhorse-1.0":
        return FREEZONE_HAPPYHORSE_RESOLUTION_OPTIONS
    if model.startswith("seedance-2.0"):
        return FREEZONE_SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL.get(
            model,
            FREEZONE_DEFAULT_SEEDANCE2_RESOLUTION_OPTIONS,
        )
    return FREEZONE_DEFAULT_VIDEO_RESOLUTION_OPTIONS


def is_freezone_seedance2_value_backend(backend: str | None) -> bool:
    model = _freezone_video_model_from_backend(backend)
    return model in {"seedance-2.0-value", "seedance-2.0-fast-value"}


def default_freezone_seedance2_scene_optimize(backend: str | None) -> str:
    model = _freezone_video_model_from_backend(backend)
    return "realistic" if model == "seedance-2.0-fast-value" else "anime"


def normalize_freezone_seedance2_scene_optimize(
    backend: str | None,
    value: str | None,
) -> str:
    if not is_freezone_seedance2_value_backend(backend):
        return ""
    text = str(value or "").strip().lower()
    if text in {"anime", "realistic"}:
        return text
    return default_freezone_seedance2_scene_optimize(backend)


def normalize_video_resolution_for_backend(backend: str | None, value: str | None) -> str:
    resolution = normalize_video_resolution(value)
    options = freezone_video_resolution_options(backend)
    if resolution in options:
        return resolution
    if "720p" in options:
        return "720p"
    return options[0]


def freezone_video_duration_bounds(backend: str | None) -> tuple[int | None, int | None]:
    from novelvideo.config import NEWAPI_VIDEO_DURATION_BOUNDS
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        parse_newapi_video_backend,
    )

    model = parse_newapi_video_backend(backend) or _freezone_video_model_from_backend(backend)
    bounds = NewApiVideoGenerator._parse_duration_bounds_config(NEWAPI_VIDEO_DURATION_BOUNDS).get(
        model
    )
    if bounds:
        return bounds
    if model == "grok-video-channel":
        return (6, 30)
    if model == "happyhorse-1.0":
        return (3, 15)
    return (None, None)


def normalize_video_duration_for_backend(backend: str | None, value: int | None) -> int:
    try:
        duration = int(value or 5)
    except (TypeError, ValueError):
        duration = 5
    duration = max(duration, 1)
    min_duration, max_duration = freezone_video_duration_bounds(backend)
    if min_duration is not None:
        duration = max(duration, min_duration)
    if max_duration is not None:
        duration = min(duration, max_duration)
    return duration


def _freezone_newapi_video_options() -> dict[str, str]:
    from novelvideo.generators.video_generator import newapi_video_backend_options

    options = {
        key: value
        for key, value in newapi_video_backend_options().items()
        if key in FREEZONE_NEWAPI_VIDEO_BACKENDS
    }
    options.setdefault("newapi_happyhorse-1.0", "HappyHorse 1.0")
    options.setdefault("newapi_grok-video-channel", "Grok Video Channel")
    if FREEZONE_DEFAULT_VIDEO_BACKEND not in options:
        return options
    ordered = {FREEZONE_DEFAULT_VIDEO_BACKEND: options[FREEZONE_DEFAULT_VIDEO_BACKEND]}
    ordered.update(
        (key, value) for key, value in options.items() if key != FREEZONE_DEFAULT_VIDEO_BACKEND
    )
    return ordered


def get_freezone_video_model_options() -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = []
    for backend, label in _freezone_newapi_video_options().items():
        duration_bounds = freezone_video_duration_bounds(backend)
        item = {
            "id": backend,
            "providerId": "newapi",
            "provider": "newapi",
            "apiModel": backend,
            "api_model": backend,
            "label": label,
            "backend": backend,
            "resolutionOptions": list(freezone_video_resolution_options(backend)),
            "resolution_options": list(freezone_video_resolution_options(backend)),
            "minDuration": duration_bounds[0],
            "min_duration": duration_bounds[0],
            "maxDuration": duration_bounds[1],
            "max_duration": duration_bounds[1],
        }
        if is_freezone_seedance2_value_backend(backend):
            item.update(
                {
                    "sceneOptimizeOptions": ["anime", "realistic"],
                    "scene_optimize_options": ["anime", "realistic"],
                    "defaultSceneOptimize": default_freezone_seedance2_scene_optimize(backend),
                    "default_scene_optimize": default_freezone_seedance2_scene_optimize(backend),
                }
            )
        data.append(item)
    return data


def get_freezone_video_model_names() -> list[str]:
    return list(_freezone_newapi_video_options().keys())


def resolve_freezone_video_backend(model: str | None) -> str:
    text = str(model or "").strip()
    options = _freezone_newapi_video_options()
    if not text:
        return (
            FREEZONE_DEFAULT_VIDEO_BACKEND
            if FREEZONE_DEFAULT_VIDEO_BACKEND in options
            else next(iter(options))
        )
    if text in options:
        return text

    folded = text.casefold()
    for backend, label in options.items():
        if label.casefold() == folded:
            return backend

    alias = LEGACY_FREEZONE_VIDEO_BACKEND_ALIASES.get(text)
    if alias:
        return alias
    label_alias = LEGACY_FREEZONE_VIDEO_LABEL_ALIASES.get(folded)
    if label_alias:
        return label_alias

    from novelvideo.generators.video_generator import parse_newapi_video_backend

    if parse_newapi_video_backend(text):
        return text
    raise ValueError(f"unknown video model: {text}")


def is_freezone_seedance2_backend(backend: str | None) -> bool:
    text = str(backend or "").strip()
    if text == "seedance_2":
        return True

    from novelvideo.generators.huimengi import parse_huimeng_video_backend
    from novelvideo.generators.video_generator import parse_newapi_video_backend

    model = parse_newapi_video_backend(text) or parse_huimeng_video_backend(text)
    return bool(model and model.startswith("seedance-2.0"))


def is_freezone_happyhorse_backend(backend: str | None) -> bool:
    from novelvideo.generators.video_generator import parse_newapi_video_backend

    model = parse_newapi_video_backend(backend) or _freezone_video_model_from_backend(backend)
    return model == "happyhorse-1.0"


def _coarse_mark_region(mark: dict[str, Any]) -> str:
    px = mark.get("point_x")
    py = mark.get("point_y")
    if not isinstance(px, (int, float)) or not isinstance(py, (int, float)):
        box_x = mark.get("box_x")
        box_y = mark.get("box_y")
        box_width = mark.get("box_width")
        box_height = mark.get("box_height")
        if all(isinstance(value, (int, float)) for value in [box_x, box_y, box_width, box_height]):
            px = float(box_x) + float(box_width) / 2.0
            py = float(box_y) + float(box_height) / 2.0
    if isinstance(px, (int, float)) and isinstance(py, (int, float)):
        horizontal = "左侧" if px < 0.33 else "右侧" if px > 0.66 else "中部"
        vertical = "上方" if py < 0.33 else "下方" if py > 0.66 else "中间"
        return f"{horizontal}{vertical}"
    return ""


def format_video_marks(marks: list[dict[str, Any]] | None) -> str:
    clean_marks = [mark for mark in (marks or []) if str(mark.get("label") or "").strip()]
    if not clean_marks:
        return ""

    lines: list[str] = []
    for mark in clean_marks:
        label = str(mark.get("label") or "").strip()
        region = _coarse_mark_region(mark)
        note = str(mark.get("note") or "").strip()
        suffix_parts = [part for part in [region, note] if part]
        suffix = f"（{'，'.join(suffix_parts)}）" if suffix_parts else ""
        lines.append(f"- {label}{suffix}")
    return "重点元素标记：\n" + "\n".join(lines)


def build_freezone_video_prompt(
    *,
    user_prompt: str,
    camera_template_id: str | None = None,
    character_names: list[str] | None = None,
    marks: list[dict[str, Any]] | None = None,
) -> str:
    parts = [str(user_prompt or "").strip()]

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"运镜模板：{template['name']}。{template['prompt']}")

    if character_names:
        joined = "、".join(name for name in character_names if name)
        if joined:
            parts.append(f"角色一致性要求：保持 {joined} 的外观、服装和身份特征稳定一致。")

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    parts.append(
        "输出要求：生成单条连贯视频镜头，动作自然，运动平滑，避免闪烁、变形、跳帧和主体身份漂移。"
    )
    return "\n".join(part for part in parts if part)


def build_freezone_image_to_video_prompt(
    *,
    user_prompt: str = "",
    camera_template_id: str | None = None,
    marks: list[dict[str, Any]] | None = None,
    reference_image_count: int = 1,
) -> str:
    parts: list[str] = []

    if user_prompt and user_prompt.strip():
        parts.append(user_prompt.strip())

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"运镜模板：{template['name']}。{template['prompt']}")

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    if int(reference_image_count or 1) > 1:
        parts.append(
            "图片参考约束：综合参考多张输入图片，优先保持主体身份、外观、服装、场景线索与整体风格一致，"
            "不要把多张图拼贴成多画面。"
        )
    else:
        parts.append(
            "首帧约束：严格继承输入图片中的主体、构图、服装、光线和场景信息，把输入图作为视频首帧参考。"
        )
    parts.append(
        "输出要求：生成单条连贯视频镜头，动作自然，运动平滑，避免闪烁、变形、跳帧、主体身份漂移和首帧偏移。"
    )
    return "\n".join(part for part in parts if part)


def build_freezone_keyframe_video_prompt(
    *,
    user_prompt: str = "",
    camera_template_id: str | None = None,
    marks: list[dict[str, Any]] | None = None,
    has_first_frame: bool = True,
    has_last_frame: bool = True,
) -> str:
    parts: list[str] = []

    if user_prompt and user_prompt.strip():
        parts.append(user_prompt.strip())

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"运镜模板：{template['name']}。{template['prompt']}")

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    if has_first_frame and has_last_frame:
        parts.append(
            "首尾帧约束：严格从首帧自然过渡到尾帧，保持主体身份、构图逻辑、光线与场景连续。"
        )
    elif has_first_frame:
        parts.append(
            "首帧约束：严格继承输入图片中的主体、构图、服装、光线和场景信息，把输入图作为视频首帧参考。"
        )
    elif has_last_frame:
        parts.append("尾帧约束：以输入图片作为目标收束画面，确保镜头最终自然落到该主体状态和构图。")

    parts.append(
        "输出要求：生成单条连贯视频镜头，动作自然，运动平滑，避免闪烁、变形、跳帧、主体身份漂移和首尾帧跳变。"
    )
    return "\n".join(part for part in parts if part)


def build_freezone_omni_video_prompt(
    *,
    user_prompt: str,
    theme: str = "",
    camera_template_id: str | None = None,
    marks: list[dict[str, Any]] | None = None,
) -> str:
    parts = [str(user_prompt or "").strip()]

    if theme and theme.strip():
        parts.append(f"主题要求：{theme.strip()}")

    template = get_video_camera_template(camera_template_id)
    if template:
        parts.append(f"运镜模板：{template['name']}。{template['prompt']}")

    marks_block = format_video_marks(marks)
    if marks_block:
        parts.append(marks_block)

    parts.append(
        "全能参考模式要求：综合文本、图像、视频和音频参考进行统一建模，优先保持主体身份、场景连续性、风格一致性和动作自然性。"
    )
    parts.append(
        "输出要求：生成单条连贯视频镜头，动作自然，运动平滑，避免闪烁、变形、跳帧和主体身份漂移。"
    )
    return "\n".join(part for part in parts if part)


def summarize_omni_reference_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    image_count = sum(1 for item in items if str(item.get("type")) == "image")
    video_count = sum(1 for item in items if str(item.get("type")) == "video")
    audio_count = sum(1 for item in items if str(item.get("type")) == "audio")
    return {
        "image_count": image_count,
        "video_count": video_count,
        "audio_count": audio_count,
        "total_count": image_count + video_count + audio_count,
    }


def validate_omni_reference_limits(items: list[dict[str, Any]]) -> None:
    counts = summarize_omni_reference_counts(items)
    if counts["total_count"] > 12:
        raise ValueError("references total count must be <= 12")
    if counts["image_count"] > 9:
        raise ValueError("image references count must be <= 9")
    if counts["video_count"] > 3:
        raise ValueError("video references count must be <= 3")
    if counts["audio_count"] > 3:
        raise ValueError("audio references count must be <= 3")


def video_character_library_path(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "video_character_library.json"


def load_video_character_library(project_dir: Path) -> list[dict[str, Any]]:
    path = video_character_library_path(project_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def save_video_character_library(project_dir: Path, items: list[dict[str, Any]]) -> None:
    path = video_character_library_path(project_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _upsert_library_item(
    items: list[dict[str, Any]],
    *,
    name: str,
    image_urls: list[str] | None,
    media: str,
    source: str,
    video_url: str | None,
    audio_url: str | None,
    item_id: str | None,
) -> dict[str, Any]:
    """纯内存 upsert：按 id 就地更新或追加 ``items``，返回写入的条目。

    不做任何磁盘 IO，供单条登记与批量同步复用（后者一次读、一次写即可）。
    """
    now = datetime.now().isoformat()
    urls = list(image_urls or [])
    if media == "video":
        cover = video_url
    elif media == "audio":
        cover = None
    else:
        cover = urls[0] if urls else None
    resolved_id = item_id or uuid.uuid4().hex[:12]
    existing_idx = next(
        (i for i, it in enumerate(items) if it.get("id") == resolved_id), None
    )
    existing = items[existing_idx] if existing_idx is not None else None
    item = {
        "id": resolved_id,
        "name": name.strip(),
        "media": media,
        "source": source,
        "image_urls": urls,
        "video_url": video_url,
        "audio_url": audio_url,
        "cover_url": cover,
        "created_at": existing.get("created_at") if existing else now,
        "updated_at": now,
    }
    if existing_idx is not None:
        items[existing_idx] = item
    else:
        items.append(item)
    return item


def add_video_character_library_item(
    project_dir: Path,
    *,
    name: str,
    image_urls: list[str] | None = None,
    media: str = "image",
    source: str = "upload",
    video_url: str | None = None,
    audio_url: str | None = None,
    item_id: str | None = None,
) -> dict[str, Any]:
    """把一条素材登记到资产库。

    图片走 ``image_urls``，视频/音频走 ``video_url`` / ``audio_url``。``item_id``
    非空时按 id upsert（主线同步用稳定合成 id，重复同步是更新而非新增）。
    """
    items = load_video_character_library(project_dir)
    item = _upsert_library_item(
        items,
        name=name,
        image_urls=image_urls,
        media=media,
        source=source,
        video_url=video_url,
        audio_url=audio_url,
        item_id=item_id,
    )
    save_video_character_library(project_dir, items)
    return item


def delete_video_character_library_item(project_dir: Path, item_id: str) -> bool:
    items = load_video_character_library(project_dir)
    kept = [item for item in items if item.get("id") != item_id]
    if len(kept) == len(items):
        return False
    save_video_character_library(project_dir, kept)
    return True


def sync_mainline_assets_into_library(
    project_dir: Path,
    *,
    assets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """把主线资产（已解析好 name/url/media/source/id）幂等写进资产库。

    ``assets`` 每项形如 ``{"id","name","media","source","url"}``。用稳定合成 id
    upsert，因此重复同步只更新 URL、不产生重复条目。返回同步后的完整库。

    整个批次只读一次、写一次库文件（内存里逐条 upsert），避免 N 条资产触发
    N 次全量 load+save 的 O(N²) IO。
    """
    items = load_video_character_library(project_dir)
    changed = False
    for asset in assets:
        media = str(asset.get("media") or "image")
        url = asset.get("url") or ""
        if not url:
            continue
        _upsert_library_item(
            items,
            name=str(asset.get("name") or ""),
            media=media,
            source=str(asset.get("source") or "upload"),
            item_id=str(asset.get("id") or "") or None,
            image_urls=[url] if media == "image" else None,
            video_url=url if media == "video" else None,
            audio_url=url if media == "audio" else None,
        )
        changed = True
    if changed:
        save_video_character_library(project_dir, items)
    return items
