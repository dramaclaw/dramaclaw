"""Freezone 标记识别辅助逻辑。"""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from novelvideo.freezone.vision_gateway import (
    VisionInput,
    call_freezone_vision_model,
    image_media_type,
)


FREEZONE_MARK_PROVIDER = "newapi"


def build_mark_detection_task(
    *,
    point_x: float | None = None,
    point_y: float | None = None,
    box_x: float | None = None,
    box_y: float | None = None,
    box_width: float | None = None,
    box_height: float | None = None,
) -> str:
    lines = [
        "你是一个画布节点局部元素识别助手。",
        "我会给你一张完整图片，以及一张局部裁剪图。",
        "请识别被点击或框选区域中最重要的可命名视觉元素。",
        '只输出 JSON 对象，不要 markdown，不要解释，例如：{"label":"老人","note":"主体人物"}',
        "规则：",
        '- label 使用简短中文名词，优先 2-6 个字，例如 "老人"、"氧气管"、"病床"、"眼镜"。',
        '- note 可为空；如有必要，只写极短补充，例如 "主体人物"、"重点保持"。',
        "- 如果是人物，优先返回人物类别或身份外观称呼，不要写完整长句。",
    ]
    if point_x is not None and point_y is not None:
        lines.append(f"点击点归一化坐标：x={point_x:.4f}, y={point_y:.4f}")
    if all(v is not None for v in [box_x, box_y, box_width, box_height]):
        lines.append(
            "框选区域归一化坐标："
            f"x={float(box_x):.4f}, y={float(box_y):.4f}, "
            f"w={float(box_width):.4f}, h={float(box_height):.4f}"
        )
    return "\n".join(lines)


def crop_mark_focus_image(
    image_path: Path,
    *,
    point_x: float | None = None,
    point_y: float | None = None,
    box_x: float | None = None,
    box_y: float | None = None,
    box_width: float | None = None,
    box_height: float | None = None,
) -> bytes:
    image = Image.open(image_path).convert("RGB")
    width, height = image.size

    if all(v is not None for v in [box_x, box_y, box_width, box_height]):
        x1 = max(0, int(float(box_x) * width))
        y1 = max(0, int(float(box_y) * height))
        x2 = min(width, int((float(box_x) + float(box_width)) * width))
        y2 = min(height, int((float(box_y) + float(box_height)) * height))
        pad_x = max(16, int((x2 - x1) * 0.25))
        pad_y = max(16, int((y2 - y1) * 0.25))
        x1 = max(0, x1 - pad_x)
        y1 = max(0, y1 - pad_y)
        x2 = min(width, x2 + pad_x)
        y2 = min(height, y2 + pad_y)
    elif point_x is not None and point_y is not None:
        cx = int(float(point_x) * width)
        cy = int(float(point_y) * height)
        radius = max(64, int(min(width, height) * 0.18))
        x1 = max(0, cx - radius)
        y1 = max(0, cy - radius)
        x2 = min(width, cx + radius)
        y2 = min(height, cy + radius)
    else:
        x1, y1, x2, y2 = 0, 0, width, height

    cropped = image.crop((x1, y1, x2, y2))
    buf = BytesIO()
    cropped.save(buf, format="PNG")
    return buf.getvalue()


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(
            line for line in cleaned.splitlines() if not line.strip().startswith("```")
        ).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        cleaned = cleaned[start : end + 1]
    payload = json.loads(cleaned)
    if not isinstance(payload, dict):
        raise ValueError("response is not a JSON object")
    return payload


async def detect_freezone_mark(
    *,
    image_path: Path,
    point_x: float | None = None,
    point_y: float | None = None,
    box_x: float | None = None,
    box_y: float | None = None,
    box_width: float | None = None,
    box_height: float | None = None,
    provider: str = FREEZONE_MARK_PROVIDER,
    model: str | None = None,
) -> dict[str, Any]:
    prompt = build_mark_detection_task(
        point_x=point_x,
        point_y=point_y,
        box_x=box_x,
        box_y=box_y,
        box_width=box_width,
        box_height=box_height,
    )
    crop_bytes = crop_mark_focus_image(
        image_path,
        point_x=point_x,
        point_y=point_y,
        box_x=box_x,
        box_y=box_y,
        box_width=box_width,
        box_height=box_height,
    )
    chosen = (provider or FREEZONE_MARK_PROVIDER).lower()
    if chosen != "newapi":
        raise ValueError("Freezone mark detection only supports the NewAPI gateway")
    used_model, text = await call_freezone_vision_model(
        prompt=prompt,
        images=[
            VisionInput(
                data=image_path.read_bytes(),
                media_type=image_media_type(image_path.name),
            ),
            VisionInput(data=crop_bytes, media_type="image/png"),
        ],
        model_override=model or None,
        timeout_seconds=90.0,
    )
    payload = _extract_json_object(text)
    label = str(payload.get("label") or "").strip()
    note = str(payload.get("note") or "").strip()
    if not label:
        raise RuntimeError("mark detector returned empty label")
    return {"label": label, "note": note, "provider": chosen, "model": used_model}
