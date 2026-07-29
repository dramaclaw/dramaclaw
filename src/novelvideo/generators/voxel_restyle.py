"""Voxel screenshot → restyled image using project visual_style preset.

Architecture (after experimentation):
    voxel_shot.png          ← single image input: defines composition + camera
    project.visual_style    ← text: defines visual style (guoman_fantasy / anime / 写实 / etc.)
        ↓ HuiMeng image-2 (1K, low) — cheap + supports single-image edit
    <ts>_styled.png

Why NOT use master.png as a second image ref:
    HuiMeng image-2 rejects array `params.image` (despite docs); image-2-official
    accepts arrays but multi-image fusion makes the model treat master as primary
    and ignore the voxel's composition. Sending voxel ALONE + style as TEXT is
    the only path where composition reliably locks.

Inputs are deliberately minimal:
    - voxel screenshot (required, the camera anchor)
    - project visual_style id (optional, loaded from project_config.json)
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from novelvideo.config import get_grid_generation_config
from novelvideo.generators.nanobanana_grid import generate_reference_edit_image

_log = logging.getLogger(__name__)

# Cheap defaults. Each restyle = 1 call to image-2 @ 1K low.
# image-2-official supports multi-image (up to 10). image-2 rejects array.
# Default = official so we can send voxel + master pair as "repair" task.
_DEFAULT_SELECTION = os.environ.get("VOXEL_RESTYLE_SELECTION", "huimeng_image2_official")
_DEFAULT_IMAGE_QUALITY = os.environ.get("VOXEL_RESTYLE_QUALITY", "low")
_DEFAULT_IMAGE_SIZE = os.environ.get("VOXEL_RESTYLE_SIZE", "1K")

_PRESETS_DIR = Path(__file__).parent.parent / "styles" / "presets"


def _load_visual_style_preset(style_id: str) -> dict:
    """Read a preset .json from src/novelvideo/styles/presets/."""
    if not style_id:
        return {}
    p = _PRESETS_DIR / f"{style_id}.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _build_prompt(scene_id: str, preset: dict, extra_context: str = "", has_master: bool = False) -> str:
    """Build a Chinese-language "image repair" prompt.

    Empirically validated: HuiMeng image-2-official responds best to a
    repair / inpainting framing — it treats image 1 as the structural source
    to preserve and image 2 as the material reference to match 1:1.

    `has_master`=True means the call site is sending master.png as image 2.
    `has_master`=False falls back to preset style text.
    """
    # 不回退到 label：label 含时代词（写实古装剧/民国年代剧）会把题材内容塞回重绘 prompt。
    style_tag = preset.get("style_tag") or "PHOTOREALISTIC"
    style_instructions = preset.get("style_instructions") or ""

    scene_line = f"场景: {scene_id} 室内。" if scene_id else ""

    if has_master:
        return f"""【图像修复任务】用图 2（master 参考图）的材质质感来修复图 1（一张低分辨率体素渲染图）。

▸ 这是 image inpainting / image restoration，不是重新生成、不是换镜头、不是 fusion。

▸ 图 1 = 损坏的图：构图、镜头、画面比例、所有物体的位置和大小都是正确的，但表面被粗糙的体素块占据，需要被"修复"成真实材质。
▸ 图 2 = 高质量参考：告诉你"修复后"应该长什么样的——材质、纹理、颜色、光照、prop 细节、wear/grime。

▸ 修复硬规则（严格遵守，不得违反）：
  1. **保留图 1 的镜头/构图/物体位置——一个像素都不许动。**
  2. **修复后的所有材质必须和图 2 一模一样**：
     - 图 2 是什么瓷砖、什么木纹、什么不锈钢、什么菜单牌纸张、什么红色饭名块、什么调色板——你的输出必须和图 2 在这些维度上 1:1 完全相同。
     - 不是"风格相近"，不是"取材自"，是"和 master 完全一致"。
     - 不要发明任何图 2 里没有的材质或颜色。
     - 不要改变图 2 的材质饱和度、对比度、纹理粗细。
     - 把图 2 的每个表面想象成贴图，按照图 1 的几何"贴"上去。

▸ 像素级 mapping（图 1 体素 → 图 2 材质）：
   · 图 1 青色/深蓝的墙 → 用图 2 的瓷砖纹理 + 勾缝
   · 图 1 木色的桌子、橱柜、长椅 → 用图 2 的木纹
   · 图 1 灰色的厨房工作台 → 用图 2 的不锈钢
   · 图 1 红色/蓝色的小凳子 → 用图 2 的凳子色和材质
   · 图 1 米黄/红色的菜单牌 → 用图 2 的菜单牌纸张+字体+红块
   · 图 1 顶部白色长条 → 用图 2 的荧光灯/灯管

▸ 禁止：
   · 不要采用图 2 的镜头角度（图 2 只提供材质，不提供构图）
   · 不要新增、删除、移动任何物体
   · 不要漂移材质细节（图 2 的菜单牌是几个红块就是几个红块）

▸ {scene_line}

▸ 输出：一张图。图 1 的精确构图 + 图 2 的精确材质。"""

    # No-master fallback: use preset style instructions instead.
    return f"""【图像修复任务】把图 1（体素渲染）修复成 {style_tag} 风格的写实图。

▸ 保留图 1 的构图、镜头、所有物体位置和大小——一个像素都不动。
▸ 把图 1 中粗糙的体素块表面替换成真实材质（木、金属、瓷砖、布料、玻璃），按以下风格指南：

STYLE TAG: {style_tag}
{style_instructions}

{scene_line}

▸ 不要改变镜头，不要新增/删除/移动任何物体。
▸ 输出：图 1 的精确构图，{style_tag} 风格的精细材质。"""


async def render_voxel_shot_styled(
    voxel_shot_path: Path,
    master_path: Path | None = None,
    reverse_path: Path | None = None,
    *,
    output_path: Path,
    scene_id: str = "",
    visual_style: str = "",
    project_config_path: Path | None = None,
    extra_context: str = "",
    aspect_ratio: str = "16:9",
    image_size: str | None = None,
    selection: str | None = None,
) -> Path:
    """Restyle a voxel screenshot using the project's preset visual style.

    `master_path` / `reverse_path` are accepted for compat with the previous
    signature but are NOT sent as image refs (see module docstring for why).

    Resolution order for `visual_style`:
        1. explicit `visual_style` param
        2. `project_config_path` JSON's `visual_style` field
        3. environment VOXEL_RESTYLE_STYLE
        4. fallback "realistic"
    """
    voxel_shot_path = Path(voxel_shot_path)
    output_path = Path(output_path)
    if not voxel_shot_path.exists():
        raise FileNotFoundError(f"voxel_shot_path 不存在: {voxel_shot_path}")

    # Resolve style id
    style_id = (visual_style or "").strip()
    if not style_id and project_config_path:
        try:
            cfg = json.loads(Path(project_config_path).read_text(encoding="utf-8"))
            style_id = (cfg.get("visual_style") or cfg.get("style") or "").strip()
        except Exception:
            pass
    if not style_id:
        style_id = os.environ.get("VOXEL_RESTYLE_STYLE", "").strip() or "realistic"

    preset = _load_visual_style_preset(style_id)

    # Build image-ref list. Default: voxel + master (repair task).
    # Falls back to single-image (voxel only) when master is unavailable.
    refs = [str(voxel_shot_path)]
    has_master = False
    if master_path and Path(master_path).exists():
        refs.append(str(master_path))
        has_master = True

    prompt = _build_prompt(scene_id, preset, extra_context, has_master=has_master)

    sel = selection or _DEFAULT_SELECTION
    size = image_size or _DEFAULT_IMAGE_SIZE
    quality = _DEFAULT_IMAGE_QUALITY
    config = get_grid_generation_config(
        selection_override=sel,
        image_size_override=size,
    )
    config["openai_image_quality"] = quality
    config["openai_sketch_image_quality"] = quality
    config["huimeng_image_quality"] = quality
    config["image_size"] = size

    _log.info(
        "voxel restyle: voxel=%s master=%s style=%s selection=%s size=%s quality=%s → %s",
        voxel_shot_path.name,
        Path(master_path).name if has_master else "—",
        style_id,
        sel,
        size,
        quality,
        output_path,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    await generate_reference_edit_image(
        prompt=prompt,
        reference_images=refs,
        output_path=str(output_path),
        aspect_ratio=aspect_ratio,
        image_size=size,
        config=config,
    )
    return output_path


__all__ = ["render_voxel_shot_styled"]
