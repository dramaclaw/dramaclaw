"""统一提示词模板构建器。

所有网格生成模式共享核心组件，通过模式参数调整差异。

模式:
- RENDER: Sketch + Render 模式，基于草图渲染
- SKETCH: 草图模式，专业分镜线稿风格，简化面部与服装轮廓

共同组件:
- 比例指令: Generate a {aspect_ratio} aspect ratio image.
- 网格声明: ASCII 布局 + panel 尺寸
- 角色定义: Character names + reference mode
- Identity Lock: 同一角色 = 同一人
- 风格约束: style_keywords + avoid_keywords
- Panel 描述: 视觉描述 + temporal framing
"""

import hashlib
import json
import os
import re
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Dict, List, Optional, TypeAlias

from pypinyin import pinyin, Style

from novelvideo.config import get_style_preset, IMAGE_DEFAULT_STYLE
from novelvideo.models import beat_scene_id, real_detected_identities, real_detected_props
from novelvideo.services.style_service import StyleService


StyleRef: TypeAlias = "StyleConfig | str | None"


def _style_family(style_ref: StyleRef) -> str:
    direct = getattr(style_ref, "style_family", "")
    if direct:
        return direct
    style_name = getattr(style_ref, "style_name", style_ref)
    return StyleService.get_style_family(style_name or IMAGE_DEFAULT_STYLE)


def _is_animation_style(style_ref: StyleRef) -> bool:
    return _style_family(style_ref) == "animation"


def _animation_subtype(style_ref: StyleRef) -> str:
    direct = getattr(style_ref, "animation_subtype", "")
    if direct:
        return direct
    style_name = getattr(style_ref, "style_name", style_ref)
    return StyleService.get_animation_subtype(style_name or IMAGE_DEFAULT_STYLE)


def _animation_medium_label(style_ref: StyleRef) -> str:
    subtype = _animation_subtype(style_ref)
    if subtype == "3d":
        return "stylized 3D animation"
    if subtype == "hybrid":
        return "stylized hybrid mixed-media animation"
    return "stylized 2D animation"


def _resolve_prop_marker_tags(text: str) -> str:
    """将 [[prop_id]] 道具锚点替换为“语义名 + 可见 tag”。

    只输出 tag 会丢掉“纸箱/马/车”等物体语义，模型容易把彩色块误读成
    平板、屏幕或任意几何体。草图里需要同时保留 prop 名和 marker tag。
    """
    if not text:
        return text

    def replace_match(m: re.Match) -> str:
        prop_id = str(m.group(1) or "").strip()
        return f"{prop_id} {PromptComponents.compute_prop_tag(prop_id)}" if prop_id else m.group(0)

    return re.sub(r"\[\[([^\]]+)\]\]", replace_match, text)


class PromptMode(Enum):
    """提示词模式。"""

    RENDER = "render"  # Sketch + Render 模式
    SKETCH = "sketch"  # 草图模式
    ACTION_STORYBOARD = "action_storyboard"  # Action beat 分镜草图（5×5 连续动作序列）


@dataclass
class GridConfig:
    """网格配置。"""

    rows: int
    cols: int
    aspect_ratio: str = "1:1"  # "9:16", "1:1", "21:9"
    image_aspect_ratio: str = ""  # 实际图片比例（two-pass 时与 aspect_ratio 不同）
    is_portrait_panel: bool = False  # panel 是否为竖屏

    @property
    def total_panels(self) -> int:
        return self.rows * self.cols

    @property
    def panel_dimensions(self) -> tuple:
        """根据 aspect_ratio 和网格尺寸估算 panel 尺寸。"""
        # 基于常用配置
        if self.aspect_ratio == "9:16":
            if self.rows >= 4:
                total_width, total_height = 3072, 5504  # 4K
            else:
                total_width, total_height = 768, 1376  # 1K
        elif self.aspect_ratio == "21:9":
            total_width, total_height = 2560, 1097  # 2K
        elif self.aspect_ratio == "16:9":
            total_width, total_height = 3840, 2160  # 4K Sketch
        else:  # 1:1
            if self.rows >= 4:
                total_width, total_height = 4096, 4096  # 4K
            else:
                total_width, total_height = 2048, 2048  # 2K

        panel_width = total_width // self.cols
        panel_height = total_height // self.rows
        return panel_width, panel_height


@dataclass
class CharacterConfig:
    """角色配置。"""

    name: str
    face_prompt: str = ""
    base_prompt: str = ""
    appearance_details: str = ""
    gender: str = ""
    body_type: str = ""
    reference_path: Optional[str] = None
    reference_mode: str = "prompt_only"  # composite, portrait_only, prompt_only
    identity_appearances: dict = field(
        default_factory=dict
    )  # {"婚后时期": "灰粉色...", "少女时期": "白色校服..."}
    sketch_color: str = ""
    identity_sketch_colors: dict = field(
        default_factory=dict
    )  # {"婚后时期": "#4A90D9 ICE BLUE", ...}
    identity_ref_images: dict = field(default_factory=dict)  # {"幼年时期": "/path/to/portrait.png"}
    identity_face_prompts: dict = field(
        default_factory=dict
    )  # {"幼年时期": "六七岁幼童，圆润小脸..."}
    identity_body_types: dict = field(default_factory=dict)  # {"幼年时期": "petite child build"}


@dataclass
class StyleConfig:
    """风格配置。"""

    style_name: str = IMAGE_DEFAULT_STYLE
    project_dir: str = ""
    style_family: str = ""
    animation_subtype: str = ""
    style_keywords: str = ""
    avoid_keywords: str = ""
    color_palette: str = ""
    panel_tag: str = ""

    def __post_init__(self):
        if not self.style_keywords:
            preset = get_style_preset(self.style_name, project_dir=self.project_dir or None)
            self.style_keywords = preset.get("style_instructions", "")
            self.avoid_keywords = preset.get("avoid_instructions", "")
            self.panel_tag = preset.get("style_tag", self.panel_tag)
            # 移除与多角色 grid 冲突的指令
            if self.avoid_keywords:
                self.avoid_keywords = self.avoid_keywords.replace(
                    "Ensure only one character unless explicitly requested.", ""
                ).strip()
            if not self.style_family:
                self.style_family = preset.get("style_family", "")
            if not self.animation_subtype:
                self.animation_subtype = preset.get("animation_subtype", "")


@dataclass
class PromptContext:
    """提示词上下文。"""

    grid: GridConfig
    characters: Dict[str, CharacterConfig]
    style: StyleConfig
    beats: List[dict]
    mode: PromptMode
    ethnicity: str = "Chinese"
    sketch_path: Optional[str] = None
    panel_detected_keys: Optional[Dict[int, set]] = (
        None  # {panel_index(0-based): detected identity keys}
    )
    resolved_render_chars: List[str] = field(default_factory=list)  # Render 模式最终参考图顺序
    scene_refs: Dict[int, List[Any]] = field(
        default_factory=dict
    )  # {panel_index(1-based): [ResolvedAssetRef]}
    prop_asset_refs: Dict[int, List[Any]] = field(
        default_factory=dict
    )  # {panel_index(1-based): [ResolvedAssetRef]}
    sketch_colors: Dict[str, str] = field(default_factory=dict)  # 共享调色盘：identity_id → color
    prop_marker_colors: Dict[str, str] = field(
        default_factory=dict
    )  # global prop_id -> marker color
    registry_negative_clause: str = ""  # registry-driven negative prompt clauses
    image_provider: str = ""
    image_model: str = ""


def default_ethnicity_instruction(ethnicity: str) -> str:
    value = (ethnicity or "").strip()
    if not value:
        return ""
    return (
        f"For people without identity references and without explicit ethnicity, nationality, "
        f"or regional description in the character, beat, scene, or reference image, default to {value}. "
        f"If any explicit source specifies another ethnicity or nationality, follow that explicit source."
    )


# =============================================================================
# 组件构建器
# =============================================================================


class PromptComponents:
    """提示词组件构建器（所有模式共享）。"""

    _SPATIAL_ENVIRONMENT_HINTS = (
        "台阶上",
        "台阶下",
        "栏杆后",
        "栏杆前",
        "远处",
        "近处",
        "前景",
        "后景",
        "背景中央",
        "左右两侧",
        "左侧",
        "右侧",
        "一上一下",
        "高处",
        "低处",
        "尽头",
        "对面",
        "包围",
        "围住",
    )
    _SHOT_CUE_VARIANTS = {
        "特写": ("【特写】", "[特写]", "特写"),
        "近景": ("【近景】", "[近景]", "近景"),
        "中景": ("【中景】", "[中景]", "中景"),
        "远景": ("【远景】", "[远景]", "远景"),
        "全景": ("【全景】", "[全景]", "全景"),
        "俯拍": ("【俯拍】", "[俯拍]", "俯拍"),
        "仰拍": ("【仰拍】", "[仰拍]", "仰拍"),
        "平视": ("【平视】", "[平视]", "平视"),
        "过肩": ("【过肩】", "[过肩]", "过肩", "过肩镜头"),
        "第一人称画面": ("【第一人称画面】", "[第一人称画面]", "第一人称画面"),
        "空镜": ("【空镜】", "[空镜]", "空镜"),
        "黑屏": ("【黑屏】", "[黑屏]", "黑屏"),
        "监控视角": ("【监控视角】", "[监控视角]", "监控视角", "监控画面"),
        "屏幕画面": ("【屏幕画面】", "[屏幕画面]", "屏幕画面"),
    }

    @staticmethod
    def compute_prop_tag(prop_id: str) -> str:
        prop_id = str(prop_id or "").strip()
        if not prop_id:
            return "[]"

        initials = []
        for char in prop_id:
            if re.match(r"[a-zA-Z0-9]", char):
                initials.append(char.upper())
            elif re.match(r"[\u4e00-\u9fff]", char):
                py = pinyin(char, style=Style.FIRST_LETTER)
                if py and py[0]:
                    initials.append(py[0][0].upper())

        pinyin_initials = "".join(initials) if initials else "PROP"
        prop_hash = hashlib.md5(prop_id.encode("utf-8")).hexdigest()[:4]
        return f"[{pinyin_initials}_{prop_hash}]"

    @staticmethod
    def _collect_char_identity_ids(
        beats: List[dict],
        use_detected_identities: bool = False,
    ) -> dict[str, set[str]]:
        """从 beats 收集 char_name → identity_id 映射。

        Returns:
            {角色名: {identity_id_1, identity_id_2, ...}}
        """
        result: dict[str, set[str]] = {}
        for beat in beats:
            if use_detected_identities:
                for marker in real_detected_identities(beat.get("detected_identities") or []):
                    name = marker.split("_", 1)[0] if "_" in marker else marker
                    result.setdefault(name, set()).add(marker)
            else:
                from novelvideo.models import extract_char_identities_from_markers

                for name, identity_id in extract_char_identities_from_markers(
                    beat.get("visual_description", ""), strict=False
                ).items():
                    result.setdefault(name, set()).add(identity_id)
        return result

    @staticmethod
    def _collect_prop_marker_ids(
        beats: List[dict],
    ) -> list[str]:
        from novelvideo.models import collect_prop_marker_ids_from_beat

        result: list[str] = []
        seen: set[str] = set()
        for beat in beats:
            candidates = collect_prop_marker_ids_from_beat(beat)
            for prop_id in candidates:
                if not prop_id or prop_id in seen:
                    continue
                seen.add(prop_id)
                result.append(prop_id)
        return result

    @staticmethod
    def _filter_panel_prop_asset_refs(ctx: PromptContext, panel_idx: int) -> list[Any]:
        refs = list(ctx.prop_asset_refs.get(panel_idx, []) or [])
        if ctx.mode == PromptMode.SKETCH:
            # Sketch generation uses prop names and marker colors only. Prop reference
            # sheets are reserved for Render/colorization so sketch blocking is not
            # biased by final prop material or detailed shape.
            return []
        if ctx.mode != PromptMode.RENDER:
            return refs
        try:
            beat = ctx.beats[panel_idx - 1]
        except IndexError:
            return refs
        detected_props = {
            str(prop_id or "").strip()
            for prop_id in real_detected_props(beat.get("detected_props") or [])
            if str(prop_id or "").strip()
        }
        if not detected_props:
            return []
        return [
            ref
            for ref in refs
            if str(
                getattr(ref, "asset_id", "")
                or getattr(ref, "prop_id", "")
                or getattr(ref, "base_id", "")
                or ""
            ).strip()
            in detected_props
        ]

    @staticmethod
    def _is_director_scene_ref(ref: Any) -> bool:
        return str(getattr(ref, "source_level", "") or "").strip() in {
            "director_image",
            "director_sheet",
        }

    @staticmethod
    def _is_director_image_ref(ref: Any) -> bool:
        return str(getattr(ref, "source_level", "") or "").strip() == "director_image"

    @staticmethod
    def _asset_anchor_text(ref: Any) -> str:
        if PromptComponents._is_director_scene_ref(ref):
            return ""
        return str(getattr(ref, "text_description", "") or "").strip()

    @staticmethod
    def _format_scene_anchor_line(ref: Any) -> str:
        base_id = str(getattr(ref, "base_id", "") or "").strip()
        anchor = PromptComponents._asset_anchor_text(ref)
        if base_id and anchor:
            return f"Scene: {base_id} — {anchor}"
        if anchor:
            return f"Scene: {anchor}"
        if base_id:
            return f"Scene: {base_id}"
        return "Scene: (unspecified)"

    @staticmethod
    def _format_render_scene_anchor_line(ref: Any) -> str:
        if getattr(ref, "image_paths", None):
            base_id = str(getattr(ref, "base_id", "") or "").strip()
            return f"Scene: {base_id}" if base_id else "Scene: (anchor image attached)"
        return PromptComponents._format_scene_anchor_line(ref)

    @staticmethod
    def _is_rough_render_scene_ref(ref: Any) -> bool:
        source_level = str(getattr(ref, "source_level", "") or "").strip()
        variant_id = str(getattr(ref, "variant_id", "") or "").strip().lower()
        image_paths = [str(path or "").lower() for path in (getattr(ref, "image_paths", []) or [])]
        if source_level in {"director_image", "selected_background_image"}:
            return (
                "director" in variant_id
                or "env_only" in variant_id
                or any("director_control_frames" in path or "env_only" in path for path in image_paths)
            )
        return False

    @staticmethod
    def _is_material_only_scene_ref(ref: Any) -> bool:
        return str(getattr(ref, "reference_mode", "") or "").strip() == "material_only"

    @staticmethod
    def _has_rough_render_scene_ref(ctx: PromptContext | None) -> bool:
        if not ctx:
            return False
        for refs in ctx.scene_refs.values():
            if any(PromptComponents._is_rough_render_scene_ref(ref) for ref in refs):
                return True
        return False

    @staticmethod
    def _has_material_only_scene_ref(ctx: PromptContext | None) -> bool:
        if not ctx:
            return False
        for refs in ctx.scene_refs.values():
            if any(PromptComponents._is_material_only_scene_ref(ref) for ref in refs):
                return True
        return False

    @staticmethod
    def _format_prop_anchor_line(ref: Any) -> str:
        base_id = str(getattr(ref, "base_id", "") or "").strip()
        anchor = PromptComponents._asset_anchor_text(ref)
        marker = str(getattr(ref, "marker_color", "") or "").strip()
        marker_suffix = f" (marker={marker})" if marker else ""
        if base_id and anchor:
            return f"Prop: {base_id} — {anchor}{marker_suffix}"
        if anchor:
            return f"Prop: {anchor}{marker_suffix}"
        if base_id:
            return f"Prop: {base_id}{marker_suffix}"
        return "Prop: (unspecified)"

    @staticmethod
    def _char_name_for_identity(
        identity_id: str,
        characters: Dict[str, CharacterConfig],
    ) -> str:
        """Resolve an identity id like 角色_时期 back to the base character name."""

        text = str(identity_id or "").strip()
        if not text:
            return ""
        if text in characters:
            return text
        for char_name in sorted(characters.keys(), key=len, reverse=True):
            if text == char_name or text.startswith(char_name + "_"):
                return char_name
        return ""

    @staticmethod
    def derive_body_descriptor(char_cfg: CharacterConfig) -> str:
        """从 body_type/gender 推断体型描述（Sketch 用）。"""
        if char_cfg.body_type.strip():
            gender = char_cfg.gender.strip()
            if gender in ("女", "女性", "female"):
                return f"FEMALE, {char_cfg.body_type.strip()}"
            elif gender in ("男", "男性", "male"):
                return f"MALE, {char_cfg.body_type.strip()}"
            return char_cfg.body_type.strip()
        gender = char_cfg.gender.strip()
        if gender in ("女", "女性", "female"):
            return "FEMALE, slender build"
        elif gender in ("男", "男性", "male"):
            return "MALE, athletic build"
        fp = char_cfg.face_prompt
        if fp:
            if "女性" in fp[:10]:
                return "FEMALE, slender build"
            elif "男性" in fp[:10]:
                return "MALE, athletic build"
        return "person"

    @staticmethod
    def compute_char_tag(char_name: str, identity_id: str | None = None) -> str:
        """计算角色标签（拼音首字母大写 + hash 后缀）。

        当提供 identity_id 时，hash 基于 identity_id，
        使同一角色的不同身份产生不同 tag。
        """
        from novelvideo.utils.identity_resolver import compute_char_tag as _compute

        return _compute(char_name, identity_id=identity_id)

    @staticmethod
    def format_environment_reference(set_desc: str) -> str:
        """将置景描述重写为单段环境参考，避免强化空间关系。"""
        if not set_desc.strip():
            return "(environment only)"

        phrases = [
            part.strip(" ，,、；;。") for part in re.split(r"[，,、；;]", set_desc) if part.strip()
        ]
        filtered = [
            part
            for part in phrases
            if not any(hint in part for hint in PromptComponents._SPATIAL_ENVIRONMENT_HINTS)
        ]
        kept = filtered or phrases

        desc = "，".join(kept)
        return (
            f"环境参考：{desc}\n"
            "⚠️ 空间关系以草图为准；环境元素只能适配既有构图，不得新增层级、景深或站位信息。"
        )

    @staticmethod
    def collect_scene_image_refs(ctx: PromptContext, limit: int | None = 8) -> List[Any]:
        refs = []
        seen = set()
        for panel_idx in sorted(ctx.scene_refs.keys()):
            for ref in ctx.scene_refs.get(panel_idx, []):
                if not getattr(ref, "image_paths", None):
                    continue
                key = PromptComponents._scene_ref_key(ref)
                if key in seen:
                    continue
                seen.add(key)
                refs.append(ref)
                if limit is not None and len(refs) >= limit:
                    return refs
        return refs

    @staticmethod
    def _scene_ref_key(ref: Any) -> tuple:
        image_paths = tuple(str(p) for p in (getattr(ref, "image_paths", []) or []))
        if image_paths:
            return ("paths", image_paths)
        return (
            "meta",
            getattr(ref, "base_id", ""),
            getattr(ref, "variant_id", ""),
            getattr(ref, "source_level", ""),
            getattr(ref, "text_description", ""),
        )

    @staticmethod
    def collect_scene_image_entries(ctx: PromptContext, limit: int | None = 8) -> list[dict]:
        entries: list[dict] = []
        by_key: dict[tuple, dict] = {}
        for panel_idx in sorted(ctx.scene_refs.keys()):
            for ref in ctx.scene_refs.get(panel_idx, []):
                if not getattr(ref, "image_paths", None):
                    continue
                key = PromptComponents._scene_ref_key(ref)
                entry = by_key.get(key)
                if not entry:
                    if limit is not None and len(entries) >= limit:
                        return entries
                    entry = {"kind": "scene", "ref": ref, "panels": []}
                    by_key[key] = entry
                    entries.append(entry)
                entry["panels"].append(panel_idx)
        return entries

    @staticmethod
    def collect_prop_image_refs(ctx: PromptContext, limit: int | None = 6) -> List[Any]:
        refs = []
        seen = set()
        for panel_idx in sorted(ctx.prop_asset_refs.keys()):
            for ref in PromptComponents._filter_panel_prop_asset_refs(ctx, panel_idx):
                if not getattr(ref, "image_paths", None):
                    continue
                key = str(getattr(ref, "base_id", "") or "").strip()
                if key in seen:
                    continue
                seen.add(key)
                refs.append(ref)
                if limit is not None and len(refs) >= limit:
                    return refs
        return refs

    @staticmethod
    def infer_sketch_blocking_hints(
        beat: dict,
        *,
        has_scene_refs: bool = False,
        has_director_scene_refs: bool = False,
    ) -> list[str]:
        visual_desc = str((beat or {}).get("visual_description", "") or "")
        if not visual_desc.strip():
            return []

        text = visual_desc.lower()
        hints: list[str] = []

        sit_keywords = ("坐", "坐在", "seat", "seated", "sit", "sitting", "bench")
        table_keywords = ("桌", "桌上", "桌面", "餐桌", "table", "desk", "booth", "counter")
        dining_keywords = (
            "面",
            "面条",
            "吃",
            "喝",
            "筷子",
            "碗",
            "eat",
            "eating",
            "drink",
            "noodle",
            "bowl",
            "chopsticks",
            "can",
            "易拉罐",
        )
        across_keywords = ("相对而坐", "对坐", "对面", "面对面", "互相看向", "看向对方")
        background_keywords = ("背景中", "身后", "后方", "侧后方", "远处", "背后")
        stand_keywords = ("起身", "站起身", "准备起身", "站了起来", "stand up", "rise")
        exit_keywords = ("走出", "走出了", "离开", "门外", "转身走出", "walk out", "exit")
        prop_markers = PromptComponents._collect_prop_marker_ids([beat])
        speaker_keywords = ("广播", "喇叭", "speaker", "announcement", "广播器")
        has_table_zone = any(keyword in visual_desc for keyword in table_keywords) or any(
            keyword in text for keyword in table_keywords if keyword.isascii()
        )
        has_dining_action = any(keyword in visual_desc for keyword in dining_keywords) or any(
            keyword in text for keyword in dining_keywords if keyword.isascii()
        )
        has_across_relation = any(keyword in visual_desc for keyword in across_keywords) or any(
            keyword in text for keyword in across_keywords if keyword.isascii()
        )
        has_background_relation = any(
            keyword in visual_desc for keyword in background_keywords
        ) or any(keyword in text for keyword in background_keywords if keyword.isascii())
        has_stand_action = any(keyword in visual_desc for keyword in stand_keywords) or any(
            keyword in text for keyword in stand_keywords if keyword.isascii()
        )
        has_exit_action = any(keyword in visual_desc for keyword in exit_keywords) or any(
            keyword in text for keyword in exit_keywords if keyword.isascii()
        )
        scene_detail_mode = PromptComponents.infer_sketch_scene_detail_mode(beat)

        if has_scene_refs:
            if has_director_scene_refs:
                hints.append(
                    "Keep character and prop blocking believable inside this exact chosen camera zone. "
                    "Do NOT use blocking changes as an excuse to swing to a different side or redesign the shot."
                )
            else:
                hints.append(
                    "Treat tighter shots as CAMERA MOVES inside the same environment, not as a relocation of the scene. "
                    "First identify the beat's LOCAL ACTION ZONE, then move the camera closer to that same zone instead of pulling characters, tables, seats, or fixtures into a new foreground setup."
                )
            if scene_detail_mode == "close_local":
                hints.append(
                    "This beat reads as a CLOSE LOCAL SHOT. Keep only the nearest support geometry from the same local action zone "
                    "(for example one tabletop edge, one bench back, one window frame, one doorway edge, or one speaker corner). "
                    "Do NOT redraw the whole room, and do NOT invent extra tables, seats, counters, or wall segments just to ground the close-up."
                )
            elif scene_detail_mode == "medium_local":
                hints.append(
                    "This beat reads as a MEDIUM LOCAL SHOT. Keep enough nearby environment to orient the action within the same local zone, "
                    "but do NOT expand into a new room-wide layout or switch to a different furniture cluster."
                )
            else:
                hints.append(
                    "This beat reads as a WIDE / LAYOUT SHOT. Preserve the broader room or street geometry and the spatial relationships between characters and fixed fixtures."
                )

        if any(keyword in visual_desc for keyword in sit_keywords) or any(
            keyword in text for keyword in sit_keywords if keyword.isascii()
        ):
            hints.append(
                "If a character is seated, place them on a believable seat or bench segment. "
                "Do NOT let them float in the aisle or drift into an unrelated part of the space."
            )
            hints.append(
                "For tighter seated shots, keep the character attached to the SAME local seat/table zone already implied by the scene. "
                "Move the camera in toward that zone instead of inventing a new foreground table, bench, or platform."
            )

        if has_table_zone or has_dining_action:
            hints.append(
                "LOCAL ACTION ZONE: keep the shot anchored to the same table/seat/counter zone already implied by the beat. "
                "A closer view should come from camera movement into that zone, not from spawning a different foreground table or relocating the subject to another furniture cluster."
            )
            hints.append(
                "Keep the fixed furniture identity and count of that local zone stable. "
                "Do NOT add, remove, duplicate, or replace tables, benches, counters, or seat clusters unless the beat explicitly describes that change."
            )
            hints.append(
                "If the action happens at one table pair or one booth, preserve that SAME table pair and SAME seating orientation when moving to a closer shot. "
                "Do NOT rebuild the beat as a new generic front-table composition."
            )

        if has_across_relation:
            hints.append(
                "If the beat implies two people facing each other across a table, keep them in the SAME table zone on opposite sides of that one table relationship. "
                "Do NOT split them into unrelated seats or move one of them to a different foreground furniture zone."
            )
            hints.append(
                "Preserve the same across-table axis from the chosen local action zone. "
                "A closer shot may crop tighter, but should still feel like the same two seats around the same table, not a newly staged conversation setup."
            )

        if has_background_relation:
            hints.append(
                "If a character is described as behind, in the background, or side-rear of another action, keep that character in a secondary depth layer of the SAME room. "
                "Do NOT promote that background figure into the main foreground unless the beat explicitly changes focus."
            )

        if has_stand_action:
            hints.append(
                "If a character is standing up, begin from the SAME seat/stool zone they were already occupying. "
                "Show the rise as local motion from that seat area, not as a teleport to another part of the room."
            )

        if has_exit_action:
            hints.append(
                "If a character exits, stage the motion as a believable path from the current local zone toward the doorway/aisle. "
                "Do NOT jump the character from one unrelated furniture cluster directly to the exit."
            )

        if prop_markers:
            hints.append(
                "Keep named props spatially attached to the interaction described in the beat. "
                "They may shift slightly for framing, but must stay in a believable local relationship "
                "to the character and furniture they interact with."
            )
            if any(keyword in visual_desc for keyword in sit_keywords) or any(
                keyword in text for keyword in sit_keywords if keyword.isascii()
            ):
                hints.append(
                    "If a seated character has a named prop beside them, keep the prop in the same "
                    "local seat zone or immediately adjacent floor/seat area, not separated into a distant zone."
                )
            if has_table_zone or has_dining_action:
                hints.append(
                    "If a named prop is part of a table or dining interaction, keep it inside that SAME local action zone. "
                    "Do NOT move the prop to a newly invented foreground table or a different seat cluster."
                )

        if any(keyword in visual_desc for keyword in speaker_keywords) or any(
            keyword in text for keyword in speaker_keywords if keyword.isascii()
        ):
            hints.append(
                "If an overhead speaker/announcement fixture is story-relevant, compose the shot so "
                "that the character and that fixture still feel like part of the same local carriage/room zone."
            )

        hints.append(
            "Any signage, menus, posters, labels, clocks, screens, or wall notices must remain abstract and unreadable. "
            "Use simple shapes or illegible marks only; do NOT render real words, letters, or numbers."
        )

        return hints

    @staticmethod
    def infer_sketch_scene_detail_mode(beat: dict) -> str:
        """Infer how much environment geometry this beat actually needs.

        Returns:
            - close_local: close-up / reaction / insert style beat; keep only local support geometry
            - medium_local: medium shot; keep local zone readable, not the whole room
            - wide_layout: wide / establishing / moving beat; preserve broader layout
        """
        beat = beat or {}
        visual_desc = str(beat.get("visual_description", "") or "")
        combined = visual_desc.lower()

        close_keywords = (
            "特写",
            "近景",
            "半身",
            "脸部",
            "面部",
            "表情",
            "手部",
            "手上",
            "局部",
            "细节",
            "close-up",
            "close up",
            "tight",
            "reaction",
            "insert",
            "detail",
            "portrait",
        )
        wide_keywords = (
            "全景",
            "远景",
            "空镜",
            "建立镜头",
            "环境全景",
            "街景",
            "内景全貌",
            "外景全貌",
            "wide",
            "wide-shot",
            "wide shot",
            "establishing",
            "full shot",
            "long shot",
        )
        move_keywords = (
            "走",
            "走向",
            "走出",
            "走进",
            "进入",
            "离开",
            "穿过",
            "穿行",
            "跑",
            "奔跑",
            "起身",
            "站起",
            "站起来",
            "从",
            "到",
            "toward",
            "through",
            "across",
            "walk",
            "walking",
            "run",
            "running",
            "enter",
            "exit",
            "cross",
        )

        if any(keyword in combined for keyword in wide_keywords):
            return "wide_layout"

        if any(keyword in combined for keyword in close_keywords):
            return "close_local"

        if any(keyword in visual_desc for keyword in move_keywords) or any(
            keyword in combined for keyword in move_keywords if keyword.isascii()
        ):
            return "wide_layout"

        return "medium_local"

    @staticmethod
    def _count_visible_identities(beat: dict) -> int:
        visual_desc = str((beat or {}).get("visual_description", "") or "")
        return len(set(re.findall(r"\{\{(.+?)\}\}", visual_desc)))

    @staticmethod
    def build_asset_identity_lock(ctx: PromptContext) -> str:
        scene_seen: set[tuple[str, str]] = set()
        prop_seen: set[str] = set()
        scene_lines: list[str] = []
        prop_lines: list[str] = []

        if ctx.mode != PromptMode.RENDER:
            for panel_idx in sorted(ctx.scene_refs.keys()):
                for ref in ctx.scene_refs.get(panel_idx, []):
                    key = (
                        str(getattr(ref, "base_id", "") or "").strip(),
                        str(getattr(ref, "variant_id", "") or "").strip(),
                    )
                    if key in scene_seen:
                        continue
                    scene_seen.add(key)
                    scene_lines.append(f"- {PromptComponents._format_scene_anchor_line(ref)}")

        for panel_idx in sorted(ctx.prop_asset_refs.keys()):
            for ref in PromptComponents._filter_panel_prop_asset_refs(ctx, panel_idx):
                key = str(getattr(ref, "base_id", "") or "").strip()
                if key in prop_seen:
                    continue
                prop_seen.add(key)
                prop_lines.append(f"- {PromptComponents._format_prop_anchor_line(ref)}")

        if not scene_lines and not prop_lines:
            return ""

        if ctx.mode == PromptMode.RENDER:
            lines = ["PROP IDENTITY LOCK:"]
            lines.append(
                "- Prop references lock the exact object identity: silhouette, proportions, material, "
                "surface wear, and key details. Beat-level wording may add temporary state, but must not "
                "replace the base object with a different generic object."
            )
        else:
            lines = ["SCENE / PROP IDENTITY LOCK:"]
            lines.append(
                "- Preserve every referenced scene and prop as the SAME canonical environment/object identity across all panels where it appears."
            )
            lines.append(
                "- Scene references lock architecture, materials, built-in fixtures, and environment identity. Time-of-day may change lighting only; it must not redesign the location."
            )
            lines.append(
                "- Prop references lock the exact object identity: silhouette, proportions, material, surface wear, and key details. Beat-level wording may add temporary state, but must not replace the base object with a different generic object."
            )
        lines.append(
            "- Tracked prop marker colors are continuity controls like character colors: preserve them in sketch/control stages, but do not treat them as final material colors."
        )
        if scene_lines:
            lines.append("SCENE ANCHORS:")
            lines.extend(scene_lines)
        if prop_lines:
            lines.append("PROP ANCHORS:")
            lines.extend(prop_lines)
        return "\n".join(lines)

    @staticmethod
    def build_aspect_ratio_instruction(ctx: PromptContext) -> str:
        """构建比例指令（所有模式开头）。

        使用 image_aspect_ratio（实际输出比例），two-pass Pass 1 时为 1:1。
        """
        ar = ctx.grid.image_aspect_ratio or ctx.grid.aspect_ratio
        return f"Generate a {ar} aspect ratio image."

    @staticmethod
    def build_grid_ascii(rows: int, cols: int, is_portrait_panel: bool = False) -> str:
        """生成无边框的网格位置标记图。

        使用 [N] 标记代替 box-drawing 字符，避免引导模型画出视觉分隔线。
        """
        lines = []
        for row in range(rows):
            panel_start = row * cols + 1
            cells = "  ".join([f"[{panel_start + col}]" for col in range(cols)])
            lines.append(f" {cells}    <- Row {row + 1}")
        return "\n".join(lines)

    @staticmethod
    def build_grid_declaration(
        ctx: PromptContext, prefix: str = "", skip_intro: bool = False
    ) -> str:
        """构建网格声明。

        Args:
            ctx: 提示词上下文
            prefix: 前缀文本（可选）
            skip_intro: 是否跳过 "Make a ..." 开头（当 prefix 已包含网格声明时使用）
        """
        rows, cols = ctx.grid.rows, ctx.grid.cols
        total_panels = ctx.grid.total_panels
        is_portrait = ctx.grid.is_portrait_panel
        ascii_layout = PromptComponents.build_grid_ascii(rows, cols, is_portrait)

        if prefix:
            intro = f"{prefix}\n\n"
        else:
            intro = ""

        # 当 skip_intro=True 时，不生成 "Make a ..." 开头（避免与 prefix 重复）
        if skip_intro:
            grid_intro = ""
        elif rows == 1 and cols == 1:
            grid_intro = "Generate a single portrait panel."
        elif rows == 1 and cols > 1:
            grid_intro = f"Make a {cols} panel horizontal comic strip. Each panel is PORTRAIT (taller than wide)."
        elif cols == 1 and rows > 1:
            grid_intro = f"Make a {rows} panel vertical comic strip, panels stacked top to bottom."
        elif is_portrait:
            panel_w, panel_h = ctx.grid.panel_dimensions
            panel_ratio = panel_w / panel_h if panel_h > 0 else 0.5
            grid_intro = f"""Make a {rows}x{cols} comic grid ({total_panels} panels, {rows} rows × {cols} columns).

CRITICAL PANEL ORIENTATION:
- Each panel is VERTICAL/PORTRAIT (height > width)
- Panel dimensions: approximately {panel_w}×{panel_h} pixels (width × height)
- Panel aspect ratio: {panel_ratio:.2f} (width/height < 1.0 means TALL panels)
- Think of each panel as a smartphone screenshot (9:16 ratio)
- NEVER create landscape/horizontal panels
- NEVER create square panels"""
        else:
            grid_intro = f"Make a {rows}x{cols} panel grid comic ({total_panels} panels total, {rows} rows × {cols} columns)."

        layout_guide = f"""
Layout (ONE CONTINUOUS IMAGE, regions blend seamlessly with ZERO visible boundaries):
{ascii_layout}
"""
        if is_portrait:
            layout_guide += f"""
PANEL SHAPE CONSTRAINT (CRITICAL):
- Each cell above represents a TALL VERTICAL panel (like a phone screen)
- Panel width < Panel height (portrait orientation)
- All {total_panels} panels must have IDENTICAL dimensions
- NO landscape panels, NO square panels allowed
"""

        return intro + grid_intro + layout_guide

    @staticmethod
    def extract_panel_characters(
        beats: List[dict], characters: Dict[str, CharacterConfig]
    ) -> List[str]:
        """按 panel 出场顺序返回角色名列表（去重）。

        支持 {{角色名}} 和 {{identity_id}}（如 {{苏清晏_少女}}）两种格式。
        """
        ordered_chars = []
        sorted_char_names = sorted(characters.keys(), key=len, reverse=True)

        for beat in beats:
            visual_description = beat.get("visual_description", "")
            markers = re.findall(r"\{\{([^}]+)\}\}", visual_description)
            for marker in markers:
                for char_name in sorted_char_names:
                    if marker == char_name or marker.startswith(char_name + "_"):
                        if char_name not in ordered_chars:
                            ordered_chars.append(char_name)
                        break
        return ordered_chars

    @staticmethod
    def extract_panel_characters_from_detected(
        beats: List[dict], characters: Dict[str, "CharacterConfig"]
    ) -> List[str]:
        """Render 模式：按 detected_identities 出场顺序返回角色名列表（去重）。

        与 extract_panel_characters 对称，但读取 beat["detected_identities"]
        而非 visual_description 中的 {{}} 标记。
        """
        ordered_chars: List[str] = []
        sorted_char_names = sorted(characters.keys(), key=len, reverse=True)

        for beat in beats:
            detected = real_detected_identities(beat.get("detected_identities") or [])
            for marker in detected:
                for char_name in sorted_char_names:
                    if marker == char_name or marker.startswith(char_name + "_"):
                        if char_name not in ordered_chars:
                            ordered_chars.append(char_name)
                        break
        return ordered_chars

    @staticmethod
    def build_identity_lock(
        ctx: PromptContext, ordered_chars: List[str] = None, compact: bool = False
    ) -> str:
        """构建身份锁定规则。

        Args:
            ctx: 提示词上下文
            ordered_chars: 排序后的角色列表
            compact: True 时输出精简 3 行版本（Render 模式用，避免脸部约束重复）
        """
        if not ctx.characters:
            return ""

        if ordered_chars is None:
            ordered_chars = PromptComponents.extract_panel_characters(ctx.beats, ctx.characters)

        # 检查是否有参考图角色
        has_ref = any(
            ctx.characters.get(c) and ctx.characters[c].reference_path for c in ordered_chars
        )
        if not has_ref:
            return ""

        total = ctx.grid.total_panels

        if compact:
            return (
                f"CHARACTER IDENTITY LOCK:\n"
                f"Whenever a colored identity-locked character appears, that character must maintain IDENTICAL facial geometry (bone structure, eyes, nose,\n"
                f"jawline, skin tone) as its reference image in every panel where that character appears.\n"
                f"Emotions change expressions only, NOT underlying face structure."
            )

        char_identity_ids = PromptComponents._collect_char_identity_ids(
            ctx.beats,
            use_detected_identities=(ctx.mode == PromptMode.RENDER),
        )

        lines = ["CHARACTER IDENTITY LOCK (CRITICAL — HIGHEST PRIORITY):"]

        img_idx = 1
        for char_name in ordered_chars:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg or not char_cfg.reference_path:
                continue
            identity_ids = char_identity_ids.get(char_name, set())
            if identity_ids:
                sorted_ids = sorted(identity_ids)
                if len(sorted_ids) > 1:
                    all_tags = [
                        PromptComponents.compute_char_tag(char_name, identity_id=iid)
                        for iid in sorted_ids
                    ]
                    label = "/".join(all_tags)
                else:
                    label = PromptComponents.compute_char_tag(char_name, identity_id=sorted_ids[0])
            else:
                label = PromptComponents.compute_char_tag(char_name)
            lines.append(
                f"- Keep {label}'s facial features EXACTLY the same as Image {img_idx}. "
                f"Do NOT alter face shape, eyes, nose, jawline, or skin tone."
            )
            img_idx += 1

        if len(lines) == 1:
            return ""

        lines.append("")
        lines.append(f"MUST MATCH across ALL {total} panels:")
        lines.append("- Face: bone structure, eyes, nose, lips, ears (IDENTICAL, not similar)")
        lines.append("- Skin: tone, texture")
        lines.append("- Hair: color, style, length")
        lines.append("")
        lines.append(
            "When showing emotions, preserve the SAME underlying facial geometry from reference — do NOT change face structure."
        )

        return "\n".join(lines)

    @staticmethod
    def build_task_declaration(ctx: PromptContext, skip_ascii: bool = False) -> str:
        """构建任务声明（合并比例、网格、风格、panel 数量约束）。

        Args:
            ctx: 提示词上下文
            skip_ascii: 跳过 ASCII 布局图（Render 模式有草图作为布局参考）
        """
        rows, cols = ctx.grid.rows, ctx.grid.cols
        total = ctx.grid.total_panels

        if skip_ascii:
            layout_section = f"LAYOUT: {total} regions ({rows}×{cols}). The SKETCH (first attached image) IS the base drawing — preserve ALL composition, poses, and camera angles exactly."
        else:
            ascii_layout = PromptComponents.build_grid_ascii(rows, cols, ctx.grid.is_portrait_panel)
            layout_section = f"""LAYOUT ({total} regions EXACTLY, {rows} rows x {cols} cols):
{ascii_layout}"""

        panel_hint = (
            _panel_ar_hint(ctx.grid.aspect_ratio, rows, cols)
            if ctx.grid.aspect_ratio
            else "SQUARE (1:1)"
        )
        return f"""Generate a {rows}×{cols} storyboard grid. Each panel MUST be {panel_hint}. Full-color continuous image with {total} seamless regions.

STYLE: {ctx.style.style_keywords}

{layout_section}

⚠️ HARD CONSTRAINT: {total-1} regions = FAIL. {total+1} regions = FAIL. Only {total} = PASS.
ONE continuous image. ZERO visible boundaries between regions."""

    @staticmethod
    def build_reference_map(
        ctx: PromptContext,
        ordered_chars: List[str],
        include_sketch: bool = True,
        include_face_desc: bool = True,
        include_silhouette: bool = False,
    ) -> str:
        """构建图片-角色映射（含角色描述）。

        在角色名后添加 face_prompt 或 base_prompt 描述，
        帮助模型更好地理解角色特征。

        Args:
            ctx: 提示词上下文
            ordered_chars: 排序后的角色列表
            include_sketch: 是否包含 SKETCH 行（Normal 模式无草图，设为 False）
            include_face_desc: 是否包含脸部文字描述
            include_silhouette: 是否在 Image 行前加服装轮廓锚点（Render 模式用，帮助模型在灰度草图中识别角色）
        """
        lines = ["REFERENCE IMAGES:"]
        img_idx = 1
        plan = PromptComponents.build_reference_image_plan(ctx, ordered_chars)
        sketch_first = include_sketch and ctx.mode == PromptMode.RENDER
        if sketch_first:
            lines.append(
                "  Image 1 = SKETCH TO COLORIZE (FIRST attached image; this is the base "
                "drawing and the ONLY spatial/composition authority — keep all composition, "
                "camera angle, crop, character placement, prop placement, and poses)"
            )
            img_idx = 2
        has_director_blocking_base_in_plan = any(
            entry.get("kind") == "scene"
            and str(getattr(entry.get("ref"), "source_level", "") or "") == "director_image"
            for entry in plan
        )

        for entry in plan:
            kind = entry.get("kind")
            if kind == "combined_composite":
                lines.append(
                    f"  Image {img_idx} = Combined multi-character full-sheet reference board: "
                    f"{entry['combined_desc']}. Each group is one character's full uploaded "
                    "multi-view sheet. Use ALL visible views in each group together to lock "
                    "that character's face, hair, body build, outfit, silhouette, and "
                    "proportions. Do not assume a fixed panel count or order inside any "
                    "group, and do not require a face-closeup panel. Do not copy the board "
                    "layout, sheet layout, panel grid, labels, camera, crop, or pose into "
                    "the render."
                )
            elif kind == "composite":
                silhouette_anchor = ""
                if include_silhouette and entry.get("silhouette_desc"):
                    silhouette_anchor = f"In sketch — {entry['silhouette_desc']}. "
                face_desc = (
                    f" FACE: {entry['face_prompt']}"
                    if (entry.get("face_prompt") and include_face_desc)
                    else ""
                )
                lines.append(
                    f"  Image {img_idx} = {entry['tag']}: {silhouette_anchor}"
                    "multi-view character reference sheet. Use ALL visible views together "
                    "to lock this person's identity: face, hair, body build, outfit, "
                    "silhouette, and proportions. Do not assume a fixed panel count or "
                    "order, and do not require a face-closeup panel. "
                    f"COPY facial features, hairstyle, outfit, and body proportions EXACTLY.{face_desc}"
                )
            elif kind == "portrait_only":
                silhouette_anchor = ""
                if include_silhouette and entry.get("silhouette_desc"):
                    silhouette_anchor = f"In sketch — {entry['silhouette_desc']}. "
                face_desc = (
                    f" FACE: {entry['face_prompt']}"
                    if (entry.get("face_prompt") and include_face_desc)
                    else ""
                )
                wear_str = entry.get("wear_str") or ""
                if wear_str:
                    lines.append(
                        f"  Image {img_idx} = {entry['tag']}: {silhouette_anchor}"
                        f"COPY facial features EXACTLY. {wear_str}.{face_desc}"
                    )
                else:
                    lines.append(
                        f"  Image {img_idx} = {entry['tag']}: {silhouette_anchor}"
                        f"COPY face EXACTLY.{face_desc}"
                    )
            elif kind == "identity_portrait":
                face_desc = (
                    f" FACE: {entry['face_prompt']}"
                    if (entry.get("face_prompt") and include_face_desc)
                    else ""
                )
                lines.append(
                    f"  Image {img_idx} = {entry['tag']}: face portrait (age variant).{face_desc}"
                )
            elif kind == "scene":
                ref = entry["ref"]
                source_level = str(getattr(ref, "source_level", "") or "").strip()
                panels = entry.get("panels") or []
                panel_suffix = ""
                if panels:
                    panel_suffix = f" Used for Panel(s): {', '.join(str(p) for p in panels)}."
                reference_label = (
                    ""
                    if source_level in {"director_image", "director_sheet"}
                    else (getattr(ref, "variant_id", "") or "")
                )
                reference_label_suffix = (
                    f" Reference label: {reference_label}." if reference_label else ""
                )
                if ctx.mode == PromptMode.RENDER:
                    if PromptComponents._is_material_only_scene_ref(ref):
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\": "
                            "background visual appearance reference. Use it only for material, texture, "
                            "color palette, surface finish, age/wear, and overall visual mood. It is NOT a "
                            "geometry, layout, camera, or spatial topology reference. Image 1 / SKETCH "
                            "remains the only geometry source: camera, perspective, crop, lens distance, "
                            "vanishing points, edge directions, wall/counter/shelf outlines, object positions, "
                            "scene depth, character blocking, and prop placement must come from Image 1."
                            f"{panel_suffix}"
                        )
                        img_idx += 1
                        continue
                    repair_clause = ""
                    if PromptComponents._is_rough_render_scene_ref(ref):
                        repair_clause = (
                            " This is a rough same-angle 3D Gaussian Splatting (3DGS) / director environment plate: preserve only its "
                            "viewpoint, visible local object placement, material cues, and lighting cues. "
                            "Clean up Gaussian-splat blur, floating speckles/floaters, projection seams, smeared "
                            "textures, broken edges, warped surface noise, and low-resolution artifacts. Use the "
                            "already-corrected sketch geometry as the perspective/layout authority; do not copy "
                            "the plate's distortion."
                        )
                    lines.append(
                        f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\": "
                        "environment reference asset. Use it only to match that location's architecture, "
                        "materials, set dressing, and major props. It does NOT define time-of-day lighting, "
                        "shadow direction, color grade, weather, or atmosphere; those follow the current "
                        "beat's time_of_day and scene context. It also does NOT override the sketch's "
                        "framing, lens distance, blocking, camera height, perspective, or character placement. "
                        "Do NOT copy this scene image's camera, crop, full-frame composition, viewpoint, "
                        "or character/prop placement; fit its material/location cues into Image 1's drawn crop."
                        f"{repair_clause}"
                        f"{panel_suffix}"
                    )
                    img_idx += 1
                    continue
                if source_level == "director_sheet":
                    lines.append(
                        f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" director reference sheet aligned to the output grid ({ctx.grid.rows} rows x {ctx.grid.cols} columns). "
                        "Each cell in this sheet corresponds to the SAME panel position in the output grid: top-left is Panel 1, then left-to-right and top-to-bottom. "
                        "Use the matching sheet cell as that panel's local environment topology lock: preserve visible local furniture order, partial table edges, seats, windows, counters, and fixture relationships. "
                        "Do NOT copy the sheet as a collage and do NOT borrow one panel's anchor for another panel. "
                        "Choose the storyboard action and camera directly from the panel visual_description."
                    )
                elif source_level == "director_image":
                    lines.append(
                        f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" beat-specific 3GS scene sketch background. "
                        "Use it like a normal sketch reference with an existing background: keep the visible camera intent, crop, composition, local furniture, actor screen regions, and prop/staging marker positions stable. "
                        "Treat any 3GS / 360 panorama fisheye, wide-angle stretching, curved walls, bowed counters, warped floors, bent verticals, broken seams, or discontinuous surfaces as capture/projection distortion: straighten architectural lines and rebuild them into a coherent flat storyboard perspective while preserving the same screen positions and scale. "
                        "Do not redraw the scene from scratch, do not beautify the background, and do not restage characters into a different furniture setup. "
                        "Only adapt the simple stick-figure action and named prop interaction according to the panel visual_description."
                    )
                else:
                    if source_level == "space_map":
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" legacy Space Map reference. "
                            "Use it only as a soft note about rough scene geography. "
                            "Do not treat it as a hard coordinate system, and do not let it override the beat text, current accepted sketch, or 360/cubemap scene references."
                        )
                        img_idx += 1
                        continue
                    if source_level == "previous_space_map":
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" previous legacy Space Map reference. "
                            "Use it only as optional continuity context. Do not create a new Space Map panel from it."
                        )
                        img_idx += 1
                        continue
                    if source_level == "scene_spatial_layout":
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" spatial_layout reference. "
                            "This is a soft scene-level layout/debug reference. "
                            "Use it only to understand rough fixed geography; do not convert it into a story panel and do not let it override the beat text, current accepted sketch, or 360/cubemap scene references."
                        )
                        img_idx += 1
                        continue
                    if source_level == "scene_master_detail":
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" master/detail reference. "
                            "Use it only to repair scene identity, material, fixture, signage-shape, wall/floor/counter/shelf/door details, and smeared 3GS artifacts. "
                            "It must NOT override the 3GS combined background camera, crop, perspective, furniture screen positions, actor regions, prop/staging marker positions, scale, or composition."
                        )
                        img_idx += 1
                        continue
                    if source_level == "scene_master_weak_detail":
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" weak master appearance reference. "
                            "Use it only to clarify scene identity, material, signage, fixture style, and object design if the Space Map is visually too abstract. "
                            "It must NOT override beat text, accepted sketch continuity, or 360/cubemap scene references."
                        )
                        img_idx += 1
                        continue
                    if source_level == "scene_reverse_master":
                        if ctx.mode == PromptMode.SKETCH:
                            lines.append(
                                f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" reverse/back-facing scene reference for sketch mode. "
                                "SCENE PAIR RULE: this reverse image and the master scene image are complementary views of the SAME physical location, not two different locations, not two style options, and not two candidate backgrounds. "
                                "Use both together to build one coherent mental map of the room: entrances, walls, counters, shelves, furniture, fixtures, and side-wall continuity. "
                                "Do NOT copy either image's camera angle; the panel visual_description controls shot angle, framing, and blocking. "
                                "Do NOT copy realistic lighting, colors, texture, or rendered detail. Convert the inferred background into sparse black/gray storyboard line art only."
                                f"{panel_suffix}"
                            )
                        else:
                            lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" reverse/back-facing scene reference. "
                            "Use it together with the master scene reference to understand the same physical space, back-side fixtures, side-wall continuity, entrances, counters, shelves, and major furniture. "
                            "It does NOT override the sketch's framing, camera, blocking, character placement, time-of-day lighting, color grade, or atmosphere. "
                            "Do NOT recreate this reference view or expand the output to match its camera."
                            f"{panel_suffix}"
                        )
                        img_idx += 1
                        continue
                    if source_level in {"pano_voxel_ref", "pano_cubemap_face"}:
                        if ctx.mode == PromptMode.SKETCH and not has_director_blocking_base_in_plan:
                            lines.append(
                                f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" 360-derived {getattr(ref, 'variant_id', '')} environment view. "
                                "Use it as a scene consistency and line-work reference for the free sketch: room identity, wall/floor/counter/shelf/door relationships, fixture shapes, texture direction, and spatial vocabulary. "
                                "It is NOT a camera lock. Do not copy this exact view unless the panel description naturally calls for it; choose the storyboard camera from visual_description."
                            )
                        else:
                            lines.append(
                                f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" 360-derived environment sanity-check view ({getattr(ref, 'variant_id', '')}). "
                                "Use it only when the 3GS plate is too smeared or ambiguous to understand wall/floor/counter/shelf/door relationships, fixture shapes, or room identity. "
                                "Do not beautify or fully repair the background from this view. It is NOT the shot camera and must NOT override the Director Render composition, actor regions, prop/staging marker positions, scale, crop, or perspective."
                            )
                        img_idx += 1
                        continue
                    if ctx.mode == PromptMode.SKETCH:
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" master scene reference for sketch mode. "
                            "Use it with the reverse scene reference when provided as complementary views of the SAME physical location to understand fixed architecture, entrances, counters, shelves, major furniture, and scene identity. "
                            "Do NOT treat master/reverse as two different locations, two style options, or two candidate backgrounds. "
                            "Draw a simplified black/gray storyboard background line art for panels in this scene; do NOT leave the background blank when a scene reference is attached. "
                            "Do NOT copy realistic lighting, colors, texture, material finish, or rendered detail. Do NOT mirror its camera angle, framing, or shot size unless the panel description asks for that view."
                            f"{reference_label_suffix}"
                        )
                    else:
                        lines.append(
                            f"  Image {img_idx} = Scene \"{getattr(ref, 'base_id', '')}\" environment reference asset. "
                            "Use it only to match that location's architecture, materials, set dressing, and major props. "
                            "It does NOT define time-of-day lighting, shadow direction, color grade, weather, or atmosphere. "
                            "It also does NOT override the sketch's framing, lens distance, blocking, camera height, perspective, or character placement. "
                            "Do NOT copy this scene image's camera, crop, full-frame composition, viewpoint, "
                            "or character/prop placement; fit its material/location cues into Image 1's drawn crop."
                            f"{reference_label_suffix}"
                        )
            elif kind == "prop":
                ref = entry["ref"]
                anchor_suffix = ""
                anchor_text = PromptComponents._asset_anchor_text(ref)
                if anchor_text:
                    anchor_suffix = f" Anchor description: {anchor_text}."
                lines.append(
                    f"  Image {img_idx} = Prop \"{getattr(ref, 'base_id', '')}\" prop identity reference (front/side/back 3-view reference sheet). "
                    "Use it to lock the prop identity exactly: overall proportions, silhouette, material, surface texture, color, wear, and key details. "
                    "Do not redesign, simplify, or substitute it with another object."
                    f"{anchor_suffix}"
                )
            else:
                continue
            img_idx += 1

        if include_sketch and not sketch_first:
            # img_idx == 1 意味着没有角色参考图，只有草图
            if img_idx == 1:
                sketch_hint = "this is the base drawing — keep all composition and poses, apply character details from descriptions below"
            else:
                sketch_hint = "this is the base drawing — keep all composition and poses, add color and character details from references above"
            lines.append(
                f"  Image {img_idx} (LAST attached image) = SKETCH TO COLORIZE ({sketch_hint})"
            )

        # 为 prompt_only 角色添加纯文字描述段落
        char_identity_ids = PromptComponents._collect_char_identity_ids(
            ctx.beats,
            use_detected_identities=(ctx.mode == PromptMode.RENDER),
        )
        text_only_lines = []
        for char_name in ordered_chars:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg:
                continue
            # 跳过已在 REFERENCE IMAGES 中出现的角色（有图的）
            if char_cfg.reference_mode != "prompt_only" and char_cfg.reference_path:
                continue
            desc_parts = []
            if char_cfg.face_prompt:
                desc_parts.append(char_cfg.face_prompt)
            elif char_cfg.base_prompt and char_cfg.base_prompt != char_name:
                desc_parts.append(char_cfg.base_prompt)
            if char_cfg.appearance_details:
                desc_parts.append(f"WEAR: {char_cfg.appearance_details}")
            identity_ids = char_identity_ids.get(char_name, set())
            if identity_ids:
                sorted_ids = sorted(identity_ids)
                if len(sorted_ids) > 1:
                    all_tags = [
                        PromptComponents.compute_char_tag(char_name, identity_id=iid)
                        for iid in sorted_ids
                    ]
                    label = "/".join(all_tags)
                else:
                    label = PromptComponents.compute_char_tag(char_name, identity_id=sorted_ids[0])
            else:
                label = PromptComponents.compute_char_tag(char_name)
            if desc_parts:
                text_only_lines.append(f"  {label}: {'. '.join(desc_parts)}")
            else:
                text_only_lines.append(f"  {label}: (no visual description available)")

        if text_only_lines:
            lines.append("")
            lines.append("CHARACTER DESCRIPTIONS (no reference image — use text only):")
            lines.extend(text_only_lines)

        return "\n".join(lines)

    @staticmethod
    def build_reference_image_plan(ctx: PromptContext, ordered_chars: List[str]) -> list[dict]:
        """Build one shared plan for prompt numbering and actual attached images."""
        plan: list[dict] = []
        char_identity_ids = PromptComponents._collect_char_identity_ids(
            ctx.beats,
            use_detected_identities=(ctx.mode == PromptMode.RENDER),
        )

        def _get_char_label(char_name: str) -> str:
            identity_ids = char_identity_ids.get(char_name, set())
            if identity_ids:
                sorted_ids = sorted(identity_ids)
                if len(sorted_ids) > 1:
                    all_tags = [
                        PromptComponents.compute_char_tag(char_name, identity_id=iid)
                        for iid in sorted_ids
                    ]
                    return "/".join(all_tags)
                return PromptComponents.compute_char_tag(char_name, identity_id=sorted_ids[0])
            return PromptComponents.compute_char_tag(char_name)

        def _get_wear_str(char_cfg: CharacterConfig) -> str:
            if len(char_cfg.identity_appearances) > 1:
                wear_parts = []
                for suffix, details in char_cfg.identity_appearances.items():
                    if details:
                        wear_parts.append(f"{suffix}={details}")
                return f"WEAR varies by scene: {' | '.join(wear_parts)}" if wear_parts else ""
            if char_cfg.appearance_details:
                return f"WEAR: {char_cfg.appearance_details}"
            return ""

        composite_chars: list[str] = []
        other_chars: list[str] = []
        for char_name in ordered_chars:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg or not char_cfg.reference_path:
                continue
            if char_cfg.reference_mode == "composite":
                composite_chars.append(char_name)
            else:
                other_chars.append(char_name)

        if len(composite_chars) >= 4:
            combined_parts = []
            items = []
            for char_name in composite_chars:
                char_cfg = ctx.characters.get(char_name)
                if not char_cfg or not char_cfg.reference_path:
                    continue
                wear_str = _get_wear_str(char_cfg)
                wear_suffix = f" {wear_str}" if wear_str else ""
                combined_parts.append(
                    f"[{_get_char_label(char_name)}] full uploaded multi-view sheet{wear_suffix}"
                )
                items.append(
                    {
                        "char_name": char_name,
                        "path": char_cfg.reference_path,
                        "tag": _get_char_label(char_name),
                    }
                )
            if items:
                plan.append(
                    {
                        "kind": "combined_composite",
                        "combined_desc": ", ".join(combined_parts),
                        "items": items,
                    }
                )
        else:
            for char_name in composite_chars:
                char_cfg = ctx.characters.get(char_name)
                if not char_cfg or not char_cfg.reference_path:
                    continue
                silhouette_desc = char_cfg.appearance_details
                if not silhouette_desc and char_cfg.identity_appearances:
                    silhouette_desc = next(
                        (v for v in char_cfg.identity_appearances.values() if v),
                        "",
                    )
                plan.append(
                    {
                        "kind": "composite",
                        "char_name": char_name,
                        "tag": _get_char_label(char_name),
                        "path": char_cfg.reference_path,
                        "face_prompt": char_cfg.face_prompt or char_cfg.base_prompt or "",
                        "silhouette_desc": silhouette_desc,
                    }
                )

        for char_name in other_chars:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg or not char_cfg.reference_path:
                continue
            silhouette_desc = char_cfg.appearance_details
            if not silhouette_desc and char_cfg.identity_appearances:
                silhouette_desc = next(
                    (v for v in char_cfg.identity_appearances.values() if v),
                    "",
                )
            plan.append(
                {
                    "kind": "portrait_only",
                    "char_name": char_name,
                    "tag": _get_char_label(char_name),
                    "path": char_cfg.reference_path,
                    "face_prompt": char_cfg.face_prompt or char_cfg.base_prompt or "",
                    "wear_str": _get_wear_str(char_cfg),
                    "silhouette_desc": silhouette_desc,
                }
            )

        for char_name in ordered_chars:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg or not char_cfg.identity_ref_images:
                continue
            suffixes = sorted(char_cfg.identity_ref_images.keys())
            if ctx.mode == PromptMode.RENDER:
                active_identity_ids = char_identity_ids.get(char_name, set())
                if not active_identity_ids:
                    continue
                suffixes = [
                    suffix
                    for suffix in suffixes
                    if f"{char_name}_{suffix}" in active_identity_ids
                ]
            for suffix in suffixes:
                identity_id = f"{char_name}_{suffix}"
                plan.append(
                    {
                        "kind": "identity_portrait",
                        "char_name": char_name,
                        "tag": PromptComponents.compute_char_tag(
                            char_name,
                            identity_id=identity_id,
                        ),
                        "path": char_cfg.identity_ref_images[suffix],
                        "face_prompt": char_cfg.identity_face_prompts.get(suffix, ""),
                    }
                )

        plan.extend(PromptComponents.collect_scene_image_entries(ctx))

        # Sketch generation keeps named props as marker-colored simple shapes in text only.
        # Prop identity sheets are for render/colorization; attaching them during sketch
        # makes the blocking pass too visually heavy and diverges from the actual submit path.
        if ctx.mode != PromptMode.SKETCH:
            for ref in PromptComponents.collect_prop_image_refs(ctx):
                plan.append({"kind": "prop", "ref": ref})

        return plan

    @staticmethod
    def build_references_json(
        ctx: PromptContext,
        ordered_chars: List[str],
        char_names: List[str],
        include_sketch: bool = True,
    ) -> str:
        """构建合并的 JSON 格式 references + hard_constraints 块。

        采用 slot 编号 + purpose 字段的结构化格式，提高角色一致性。

        Args:
            ctx: 提示词上下文
            ordered_chars: 按 visual_description 中 {{角色名}} 出场顺序排列的角色列表
            char_names: 角色名列表（用于 hard_constraints）
            include_sketch: 是否包含 SKETCH 条目（Render 模式为 True）
        """
        references = {}

        # 分类角色：composite vs 其他
        composite_chars = []
        other_chars_json = []
        for char_name in ordered_chars:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg or not char_cfg.reference_path:
                continue
            if char_cfg.reference_mode == "composite":
                composite_chars.append(char_name)
            else:
                other_chars_json.append(char_name)

        slot = 1

        if len(composite_chars) >= 4:
            # 多人模式：合并为 1 个 slot，保留每个角色完整上传 sheet。
            char_entries = []
            for char_name in composite_chars:
                char_cfg = ctx.characters.get(char_name)
                entry = {"name": char_name, "panel": "full uploaded multi-view sheet"}
                if char_cfg.appearance_details:
                    entry["outfit"] = char_cfg.appearance_details
                char_entries.append(entry)
            references["COMBINED_CHARACTERS"] = {
                "slot": slot,
                "purpose": "MULTI_IDENTITY_LOCK",
                "layout": "full-sheet board: one uploaded multi-view sheet per character",
                "characters": char_entries,
                "strict_identity_lock": True,
                "face_similarity_priority": "MAX",
                "body_proportions": "exact_match",
                "copy_from": (
                    "all visible views for each character's face, hairstyle, outfit, "
                    "silhouette, and proportions"
                ),
            }
            slot += 1
        else:
            # 单人模式：完整上传多视图 sheet，不假设固定 panel 数或顺序。
            for char_name in composite_chars:
                char_cfg = ctx.characters.get(char_name)
                ref_obj = {
                    "slot": slot,
                    "name": char_name,
                    "purpose": "IDENTITY_LOCK",
                    "strict_identity_lock": True,
                    "face_similarity_priority": "MAX",
                    "body_proportions": "exact_match",
                }
                ref_obj["layout"] = "uploaded multi-view sheet with variable panel count/order"
                ref_obj["copy_from"] = (
                    "all visible views (face, hairstyle, outfit, silhouette, proportions)"
                )
                references[char_name] = ref_obj
                slot += 1

        # portrait_only 角色照常
        for char_name in other_chars_json:
            char_cfg = ctx.characters.get(char_name)
            ref_obj = {
                "slot": slot,
                "name": char_name,
                "purpose": "FACE_IDENTITY_LOCK",
                "strict_identity_lock": True,
                "face_similarity_priority": "MAX",
                "gender": char_cfg.gender,
                "body_type": char_cfg.body_type,
            }
            if char_cfg.appearance_details:
                ref_obj["outfit_override"] = char_cfg.appearance_details
            references[char_name] = ref_obj
            slot += 1

        # SKETCH 作为 composition 参考（仅 Render 模式）
        if include_sketch:
            references["SKETCH"] = {
                "slot": slot,
                "purpose": "COMPOSITION_LOCK",
                "preserve_framing": True,
                "preserve_pose_logic": True,
                "preserve_panel_spacing": True,
                "preserve_expression_cues": True,
                "ignore_face_identity": True,
                "note": "Sketch contains storyboard faces for expression/pose reference — use CHARACTER references for facial IDENTITY, not sketch",
            }

        # 为 prompt_only 角色添加纯文字描述
        text_only_characters = {}
        for char_name in ordered_chars:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg:
                continue
            if char_cfg.reference_mode != "prompt_only" and char_cfg.reference_path:
                continue
            desc = {}
            desc["name"] = char_name
            desc["purpose"] = "TEXT_DESCRIPTION_ONLY"
            if char_cfg.face_prompt:
                desc["visual_description"] = char_cfg.face_prompt
            elif char_cfg.base_prompt and char_cfg.base_prompt != char_name:
                desc["visual_description"] = char_cfg.base_prompt
            if char_cfg.appearance_details:
                desc["outfit"] = char_cfg.appearance_details
            if desc.get("visual_description") or desc.get("outfit"):
                text_only_characters[char_name] = desc

        # 构建 hard_constraints
        panel_count = ctx.grid.total_panels
        hard_constraints = [
            f"Exactly {panel_count} panels required.",
            "Faces must match the uploaded references with maximum similarity (no identity drift).",
            f"Faces must be clearly visible and recognizable in ALL {panel_count} panels.",
            f"Character identity consistency across ALL panels is PARAMOUNT: {', '.join(char_names)}",
        ]

        # 合并为单个 JSON
        result = {"references": references, "hard_constraints": hard_constraints}
        if text_only_characters:
            result["text_only_characters"] = text_only_characters

        return json.dumps(result, indent=2, ensure_ascii=False)

    @staticmethod
    def build_fusion_rules(ctx: PromptContext = None, ordered_chars: List[str] = None) -> str:
        """融合规则（强化否定，防止 Sketch 风格泄漏）。"""
        # 收集当前 grid 中出现的参考模式
        has_composite = False
        has_portrait = False
        has_prompt_only = False
        if ctx and ordered_chars:
            for char_name in ordered_chars:
                char_cfg = ctx.characters.get(char_name)
                if not char_cfg:
                    continue
                if char_cfg.reference_mode == "composite" and char_cfg.reference_path:
                    has_composite = True
                elif char_cfg.reference_mode == "prompt_only" or not char_cfg.reference_path:
                    has_prompt_only = True
                else:
                    # portrait (有参考图但只有脸)
                    has_portrait = True

        has_any_ref = has_composite or has_portrait
        ref_parts = []
        if has_any_ref:
            ref_parts.append("FROM REFERENCES: Face identity (EXACT match)")
        if has_composite:
            ref_parts.append("hairstyle and clothing/outfit (match reference image)")
        if has_portrait:
            ref_parts.append(
                "clothing/outfit (match WEAR text description — reference image is face only)"
            )
        if has_prompt_only:
            ref_parts.append(
                "for characters WITHOUT reference images: face and clothing from CHARACTER DESCRIPTIONS text"
            )
        has_prop_ref = bool(ctx and any(ctx.prop_asset_refs.get(k) for k in ctx.prop_asset_refs))
        if has_prop_ref:
            ref_parts.append(
                "for named props: prop identity, material, color, silhouette, and surface wear from the attached prop reference image when provided, otherwise from the prop text description"
            )
        has_material_only_scene_ref = PromptComponents._has_material_only_scene_ref(ctx)
        has_structural_scene_ref = bool(
            ctx
            and any(
                ref
                for refs in ctx.scene_refs.values()
                for ref in refs
                if not PromptComponents._is_material_only_scene_ref(ref)
            )
        )
        has_scene_ref = has_material_only_scene_ref or has_structural_scene_ref
        if has_structural_scene_ref:
            ref_parts.append(
                "for matching locations with scene anchor images: environment architecture, materials, major props, and stable set dressing from the scene anchor only"
            )
        if has_material_only_scene_ref:
            ref_parts.append(
                "for background visual appearance references: material, texture, color palette, surface finish, age/wear, and overall visual mood from the attached background image; no geometry, layout, camera, or spatial topology information from that image"
            )
        ref_parts.append(
            "for scene integration: lighting, environment materials, and color grading around the character"
        )
        ref_line = ", ".join(ref_parts)

        marker_scope = "characters and prop references" if has_prop_ref else "characters"
        prop_colorization_rule = (
            "🎨 PROP COLORIZATION: For every attached prop reference, the sketch's marker color is identification-only — it is NOT the prop's final material color. COMPLETELY DISCARD the marker tint and replace it with the prop's TRUE material color, surface texture, and material identity from the attached prop reference image when one is provided; if no prop image is attached, use the prop text description plus the global scene preset. Preserve the sketch's prop placement, scale, framing, and the character's interaction with the prop, but render the prop with its true material as if photographed in the same scene/lighting as the rest of the panel. Do NOT add, remove, duplicate, or reposition any prop beyond what is drawn.\n"
            if has_prop_ref else ""
        )
        scene_anchor_rule = (
            "🏠 SCENE ANCHOR RULE: If a scene anchor image is attached for a location, use it only to match that location's architecture, materials, set dressing, and major props. Scene anchors do NOT define time-of-day lighting, shadow direction, color grade, weather, or atmosphere. Those must follow the current beat's time_of_day and scene context. Scene anchors also do NOT override the sketch's framing, lens distance, blocking, camera height, perspective, or character placement. Do NOT use a scene anchor as the base image, do NOT copy its camera/crop/full-room composition, and do NOT expand or restage the sketch to match the scene anchor view.\n"
            if has_structural_scene_ref
            else ""
        )
        material_only_scene_rule = (
            "🧱 BACKGROUND APPEARANCE REFERENCE RULE: If a background image is marked material-only, treat it as a visual appearance reference, not as a spatial reference. It supplies material, texture, color palette, surface finish, age/wear, and overall visual mood only. Image 1 / SKETCH remains the only geometry source for perspective, crop, camera/lens distance, vanishing points, edge directions, wall/counter/shelf outlines, object positions, scene depth, character blocking, and prop placement. Do NOT use a background appearance reference as the base image, and do NOT copy its layout, object placement, camera, or spatial topology.\n"
            if has_material_only_scene_ref
            else ""
        )
        rough_scene_repair_rule = (
            "🧹 ROUGH 3DGS ENV REPAIR: If the attached scene anchor is a same-angle director/env_only/3D Gaussian Splatting environment plate, treat it as a rough material and viewpoint reference only. Remove Gaussian-splat noise, blur, floating speckles/floaters, projection seams, smeared textures, jagged/broken edges, warped surface artifacts, ghosting, and low-resolution mush. Reconstruct clean wall, floor, counter, table, stool, door, window, shelf, menu/sign, and fixture surfaces in the project style, while keeping the sketch's corrected perspective, object screen positions, and character blocking unchanged.\n"
            if PromptComponents._has_rough_render_scene_ref(ctx)
            else ""
        )

        return f"""COLORIZATION RULES:
🔒 THIS IS A COLORIZATION TASK — the sketch is the BASE DRAWING, NOT just a reference.
🧱 BASE SKETCH LOCK: Image 1 / SKETCH is the ONLY spatial source of truth. The output must preserve Image 1's crop, camera angle, lens distance, character placement, prop placement, object scale, and pose relationships. All other reference images are identity/material/location swatches only. If any scene, character, or prop reference implies a different camera or layout, ignore that spatial implication and keep Image 1.
🎨 Keep the sketch's composition, camera angle, character placement, and action pose EXACTLY as drawn — but NOT the sketch's raw anatomy. Do NOT move the character, change the camera distance, or alter the scene layout. For colored identity-locked figures, keep the same drawn figure and apply the character's TRUE facial identity, gender, body build, and silhouette from reference images or text descriptions. Do NOT reinterpret the drawn figure as a different gender or body type.
🧍 REALISTIC PROPORTIONS: Treat rough sketch anatomy as guidance only, not literal anatomy. Keep the same pose and layout, but normalize crude stick-figure anatomy into realistic human proportions. Do NOT copy exaggerated sketch head size, simplified neck thickness, limb thickness, hand size, or torso shortcuts unless caricature is explicitly requested.
🎯 CHARACTER IDENTIFICATION: Colored figures in the sketch are the identity-locked characters.
   Use the COLOR IDENTIFICATION section to match those colored figures to character references.
   ⚠️ Sketch colors (on {marker_scope}) are ONLY for identification — they are NOT final visible colors.
{ref_line}
🎨 CHARACTER COLORIZATION: You are COLORIZING the figures already drawn in the sketch — NOT rendering new characters. The sketch colors are fluorescent ID markers only, not final visible colors. For COLORED figures, COMPLETELY DISCARD the sketch's color tint. Replace 100% of every marker color with the character's true appearance colors. No marker color may remain visible on skin, hair, clothing, shadows, or highlights. All exposed skin (face, neck, ears, hands, fingers) must use natural human skin tone from the reference image or text description, never the sketch marker color. Keep the sketch's drawn figure, placement, pose, and framing, but apply the identity-locked character's true face identity, gender, body build, and silhouette within that figure. If the sketch uses crude stick-figure anatomy, convert it to natural adult human anatomy rather than copying the sketch's exact head-to-body ratio or simplified body construction. For COMPOSITE / IDENTITY-SHEET characters, use the reference image to lock identity only: face identity, skin tone, hair color, clothing colors/textures, body build, and silhouette. Do NOT copy or preserve the reference image's rendering medium, retouching level, CGI feel, illustration style, or beauty-filter look. Final rendering realism, skin texture, lighting behavior, and image finish must follow the global scene preset. For PORTRAIT-ONLY characters, use the reference image EXACTLY for face identity, skin tone, hair identity, and head/hair silhouette, but use WEAR / text description for costume, accessories, and body styling. Portrait-only references lock who the character is, not the portrait's rendering medium or retouching style. For text-only characters without reference images, use the text description for identity/body/clothing while following the global scene preset for rendering style and overall treatment. Do NOT add, remove, merge, or reposition any colored figure beyond what is drawn.
{prop_colorization_rule}🚫 NO COMIC EFFECT LINES: Do NOT draw manga/comic motion lines, speed lines, trembling lines, impact lines, emphasis rays, stress marks, or symbolic action streaks anywhere in the image.
🏗️ COMPOSITION HIERARCHY: The sketch's spatial layout is the ABSOLUTE GROUND TRUTH. Environment descriptions and scene anchors provide MATERIAL, LOCATION IDENTITY, and ATMOSPHERE only — they must NOT override the sketch's camera angle, character distance, spatial relationships, crop, or scene depth. If an environment detail implies a different spatial arrangement than what the sketch shows, IGNORE the spatial implication and keep only the material/texture/lighting information.
{scene_anchor_rule}{material_only_scene_rule}{rough_scene_repair_rule}🎭 STYLE SCOPING: The global STYLE preset and AVOID rules apply to the environment, background, architecture, props, lighting, camera treatment, overall image finish, AND the final rendering treatment of all characters. Reference images lock character identity and appearance details, but they do NOT lock rendering medium. If a user-uploaded portrait is over-retouched, beautified, illustrated, or CG-like, keep the same person and appearance details while re-rendering that character in the project's scene preset. Scene realism rules govern the final skin texture, material response, lighting, and image finish for the whole scene.
✅ OUTPUT: The sketch rendered in full color with high-fidelity detail. Composite / identity-sheet and portrait-only references preserve the referenced person's identity, hair, costume details, and silhouette, while the final rendering treatment follows the global scene preset. Named props preserve their referenced material identity exactly. All text-only characters, extras, and the surrounding world follow the global scene preset."""

    @staticmethod
    def build_constraints(ctx: PromptContext, include_face_reminder: bool = True) -> str:
        """约束部分。

        Args:
            ctx: 提示词上下文
            include_face_reminder: 是否包含脸部身份提醒行（Render 模式设为 False 避免重复）
        """
        lines = [
            "CONSTRAINTS:",
            "- No overlay text, subtitles, labels, or watermarks on image",
        ]
        if ctx.style.avoid_keywords:
            avoid_text = ctx.style.avoid_keywords
            avoid_text = (
                re.sub(
                    r"No text,?\s*watermarks,?\s*(or\s+)?labels\s+on\s+image\.?\s*", "", avoid_text
                )
                .strip()
                .rstrip(".")
            )
            if avoid_text:
                lines.append(
                    f"- AVOID in environment/background/props/non-locked characters/overall scene treatment: {avoid_text}"
                )
                if ctx.mode != PromptMode.RENDER and _is_animation_style(ctx.style):
                    lines.append(
                        "- Do NOT use the AVOID list to override referenced face identity, hair identity, silhouette, or costume details. The AVOID list and scene preset still control final linework treatment, shading logic, texture overlays, lighting response, and overall animated image finish."
                    )
                else:
                    lines.append(
                        "- Do NOT use the AVOID list to override referenced face identity, hair identity, silhouette, or costume details. The AVOID list and scene preset still control final rendering realism, skin texture treatment, lighting response, and overall image finish."
                    )
        if include_face_reminder:
            if ctx.mode != PromptMode.RENDER and _is_animation_style(ctx.style):
                lines.append(
                    "- Character identity: MUST match reference image EXACTLY in every panel (face shape, hair, silhouette, palette cues)."
                )
            else:
                lines.append(
                    "- Face identity: MUST match reference image EXACTLY in every panel (face, skin, hair)."
                )
        ethnicity_instruction = default_ethnicity_instruction(ctx.ethnicity)
        if ethnicity_instruction:
            lines.append(f"- Default ethnicity: {ethnicity_instruction}")
        lines.append(
            "- COLORIZATION: Preserve the sketch's composition, camera angle, character placement, and pose. Do NOT rearrange, add, remove, or reposition any elements."
        )
        lines.append(
            "- HUMAN PROPORTIONS: Keep the same layout and pose, but normalize crude stick-figure anatomy into realistic human proportions. Do NOT copy exaggerated head size or simplified body construction from the sketch."
        )
        lines.append(
            "- NO comic/manga effect lines: no motion lines, speed lines, trembling lines, impact strokes, emphasis rays, or symbolic action marks anywhere in the image."
        )
        return "\n".join(lines)

    @staticmethod
    def build_time_of_day_rules(ctx: PromptContext) -> str:
        """Render-only lighting rule for scene anchor images."""
        if ctx.mode != PromptMode.RENDER:
            return ""
        has_scene_ref = bool(ctx and any(ctx.scene_refs.get(k) for k in ctx.scene_refs))
        if not has_scene_ref:
            return ""
        baked_panels: list[str] = []
        relight_panels: list[str] = []
        for index, beat in enumerate(ctx.beats, start=1):
            time_of_day = str(beat.get("time_of_day", "") or "").strip()
            if not time_of_day:
                continue
            refs = ctx.scene_refs.get(index, []) or []
            if refs and any(bool(getattr(ref, "time_baked", False)) for ref in refs):
                baked_panels.append(str(index))
            else:
                relight_panels.append(str(index))
        if not baked_panels and not relight_panels:
            return (
                "TIME-OF-DAY RULE: No panel time_of_day is specified. "
                "preserve the scene anchor image's existing lighting and do not relight the location."
            )
        lines = ["TIME-OF-DAY RULE:"]
        if baked_panels:
            lines.append(
                "For Panel(s) "
                + ", ".join(baked_panels)
                + ", the time-of-day lighting is already baked into its scene anchor image; "
                "preserve that anchor lighting and do not relight the location."
            )
        if relight_panels:
            lines.append(
                "For Panel(s) "
                + ", ".join(relight_panels)
                + ", lighting follows its own [time_of_day] tag, not the scene anchor image's lighting."
            )
            lines.append(
                "If the same location has different time_of_day across panels, keep architecture identical but change lighting accordingly."
            )
        return "\n".join(lines)

    @staticmethod
    def build_temporal_framing() -> str:
        """构建时间帧约束（视频首帧）。"""
        return """TEMPORAL FRAMING (CRITICAL FOR VIDEO):
Each panel is the FIRST FRAME of a video clip. For dynamic actions:
- "turns around" (转身) → show character's BACK (before turning)
- "stands up" (站起) → show character SEATED (before standing)
- "looks up" (抬头) → show character looking DOWN (before looking up)
- "opens door" (开门) → show door CLOSED (before opening)
- "walks in" (走进) → show character at the DOORWAY (before entering)
Show the STARTING pose, NOT the ending result."""

    @staticmethod
    def _group_beats_by_scene(
        beats: List[dict],
        total_panels: int,
    ) -> dict:
        """将 beats 按 scene_id 归组，返回 {scene_id: {panels, time_of_day}}。

        只处理前 total_panels 个 beat，避免越界 region。
        """
        actual_beats = beats[:total_panels]
        scene_panels: dict = {}
        prev_scene = None
        for i, beat in enumerate(actual_beats):
            scene_id = beat_scene_id(beat)
            if not scene_id and prev_scene:
                scene_id = prev_scene
            elif not scene_id:
                scene_id = "unknown"
            prev_scene = scene_id
            if scene_id not in scene_panels:
                scene_panels[scene_id] = {"panels": [], "time_of_day": ""}
            tod = beat.get("time_of_day", "")
            if not scene_panels[scene_id]["time_of_day"] and tod:
                scene_panels[scene_id]["time_of_day"] = tod
            scene_panels[scene_id]["panels"].append(i + 1)
        return scene_panels

    @staticmethod
    def _format_panel_list(panels: list) -> str:
        """将 panel 列表格式化为紧凑的 range 表达式。

        少于等于 5 个用 & 连接，多于 5 个用 range 表达。
        如 [1,2,3,5,6,8] → '1-3, 5-6, 8 (6 panels)'
        """
        if len(panels) <= 5:
            return " & ".join(str(p) for p in panels)
        # 构建 ranges
        ranges = []
        start = panels[0]
        end = panels[0]
        for p in panels[1:]:
            if p == end + 1:
                end = p
            else:
                ranges.append(f"{start}-{end}" if start != end else str(start))
                start = end = p
        ranges.append(f"{start}-{end}" if start != end else str(start))
        return f"{', '.join(ranges)} ({len(panels)} panels)"

    @staticmethod
    def build_scene_continuity(beats: List[dict], total_panels: int) -> str:
        """动态生成场景连续性指令。"""
        scene_panels = PromptComponents._group_beats_by_scene(beats, total_panels)

        lines = ["SCENE CONTINUITY (CRITICAL):"]
        group_id = "A"
        continuity_pairs = []

        for loc, info in scene_panels.items():
            panels = info["panels"]
            if len(panels) > 1:
                lines.append(f'SCENE GROUP {group_id}: "{loc}"')
                lines.append(f"  Regions: {', '.join(str(p) for p in panels)}")
                lines.append("  RULE: Same background across all regions in this group.")
                continuity_pairs.append(panels)
            else:
                lines.append(f'SCENE GROUP {group_id}: "{loc}"')
                lines.append(f"  Region: {panels[0]} (Unique scene)")
            group_id = chr(ord(group_id) + 1)

        if continuity_pairs:
            lines.append("")
            lines.append("ENFORCEMENT:")
            for panels in continuity_pairs:
                panel_str = PromptComponents._format_panel_list(panels)
                lines.append(
                    f"- Panels {panel_str}: COPY-PASTE identical background, only characters differ."
                )

        lines.append("")
        lines.append("BACKGROUND CONTINUITY RULES:")
        lines.append("1. Same scene_id = IDENTICAL background (copy-paste level)")
        lines.append("2. Only CHARACTER POSE/EXPRESSION changes between same-scene panels")
        lines.append("3. Camera angle may change, but architectural elements stay in same position")
        lines.append("4. Lighting source and color temperature stay consistent within a scene")

        return "\n".join(lines)

    @staticmethod
    def build_scene_continuity_for_sketch(beats: List[dict], total_panels: int) -> str:
        """场景连续性指令（草图专用版本）。

        相比 build_scene_continuity：
        - "COPY-PASTE identical" → "SAME layout and structure"
        - 移除 color temperature 规则（灰度无色温）
        - 新增线条一致性规则
        - 保留场景分组和环境描述
        """
        scene_panels = PromptComponents._group_beats_by_scene(beats, total_panels)

        lines = ["SCENE CONTINUITY (CRITICAL):"]
        group_id = "A"
        continuity_pairs = []

        for loc, info in scene_panels.items():
            panels = info["panels"]
            if len(panels) > 1:
                lines.append(f'SCENE GROUP {group_id}: "{loc}"')
                lines.append(f"  Regions: {', '.join(str(p) for p in panels)}")
                lines.append("  RULE: Same background across all regions in this group.")
                continuity_pairs.append(panels)
            else:
                lines.append(f'SCENE GROUP {group_id}: "{loc}"')
                lines.append(f"  Region: {panels[0]} (Unique scene)")
            group_id = chr(ord(group_id) + 1)

        if continuity_pairs:
            lines.append("")
            lines.append("ENFORCEMENT:")
            for panels in continuity_pairs:
                panel_str = PromptComponents._format_panel_list(panels)
                lines.append(
                    f"- Panels {panel_str}: IDENTICAL background environment — same layout, structures, and objects in same positions. Only character poses and camera angles change."
                )

        # 补充 placeholder panels
        actual_count = min(len(beats), total_panels)
        if actual_count < total_panels:
            placeholder_panels = list(range(actual_count + 1, total_panels + 1))
            lines.append(f'SCENE GROUP {group_id}: "PLACEHOLDER"')
            lines.append(f"  Regions: {', '.join(str(p) for p in placeholder_panels)}")
            lines.append("  RULE: Simple solid gray fill. No scenery or characters.")

        lines.append("")
        lines.append("BACKGROUND CONTINUITY RULES:")
        lines.append(
            "- Maintain consistent line weight, shading density, and perspective depth within same scene"
        )

        return "\n".join(lines)

    @staticmethod
    def build_scene_environment_hints(beats: List[dict], total_panels: int) -> str:
        """生成精简的场景环境提示（Render 模式用，不含冗余规则）。

        Render 模式已有草图作为构图参考，只需环境描述辅助渲染风格。
        """
        # location_description 已移除，环境描述不再可用
        return ""

    @staticmethod
    def build_color_identification_map(
        ctx: PromptContext,
        ordered_chars: Optional[List[str]] = None,
    ) -> str:
        """基于颜色的角色识别映射（替代 staging 文字识别）。"""
        lines = ["CHARACTER COLOR IDENTIFICATION (match sketch colors to character references):"]

        # 收集 beats 中的 identity_ids（与 build_reference_map 相同逻辑）
        char_identity_ids = PromptComponents._collect_char_identity_ids(
            ctx.beats,
            use_detected_identities=(ctx.mode == PromptMode.RENDER),
        )
        ordered_names = list(ordered_chars or [])
        reference_slots: dict[str, int] = {}
        reference_tag_slots: dict[str, int] = {}
        combined_reference_chars: set[str] = set()
        next_image_slot = 2 if ctx.mode == PromptMode.RENDER else 1
        for entry in PromptComponents.build_reference_image_plan(ctx, ordered_names):
            kind = entry.get("kind")
            if kind == "combined_composite":
                for item in entry.get("items", []):
                    item_name = str(item.get("char_name", "") or "")
                    item_tag = str(item.get("tag", "") or "")
                    if item_name:
                        reference_slots[item_name] = next_image_slot
                        combined_reference_chars.add(item_name)
                    if item_tag:
                        reference_tag_slots[item_tag] = next_image_slot
                next_image_slot += 1
                continue
            if kind in {"composite", "portrait_only", "identity_portrait"}:
                char_name = str(entry.get("char_name", "") or "")
                tag = str(entry.get("tag", "") or "")
                if char_name:
                    reference_slots.setdefault(char_name, next_image_slot)
                if tag:
                    reference_tag_slots[tag] = next_image_slot
                next_image_slot += 1
                continue
            if kind in {"scene", "prop"}:
                next_image_slot += 1

        def _gender_label(value: str) -> str:
            g = (value or "").strip().lower()
            if g in ("男", "男性", "male"):
                return "MALE"
            if g in ("女", "女性", "female"):
                return "FEMALE"
            return ""

        def _appearance_source(cfg, suffix: str = "") -> str:
            """根据参考模式返回外观来源提示。"""
            identity_ref = cfg.identity_ref_images.get(suffix, "") if suffix else ""
            if identity_ref or (cfg.reference_mode == "composite" and cfg.reference_path):
                return "Apply face, body build, and costume from reference image."
            elif cfg.reference_mode != "prompt_only" and cfg.reference_path:
                # portrait: 脸从图来，衣服从 WEAR 文字来
                return (
                    "Apply face from reference image, body build from character identity, "
                    "costume from WEAR text description."
                )
            else:
                # prompt_only: 全靠文字
                return "Apply face, body build, and costume from CHARACTER DESCRIPTIONS text."

        def _reference_binding(color_name: str, char_name: str, tag: str) -> str:
            slot = reference_tag_slots.get(tag) or reference_slots.get(char_name)
            if not slot:
                return ""
            if char_name in combined_reference_chars:
                return (
                    f" {color_name} sketch figure must use Image {slot}, the full uploaded "
                    f"multi-view sheet in that combined reference board for {tag}. "
                    "Marker color is only an identity key, not clothing color."
                )
            return (
                f" {color_name} sketch figure must use Image {slot} for {tag}'s identity, "
                "hair, outfit, body build, and proportions. Marker color is only an "
                "identity key, not clothing color."
            )

        for char_name in ordered_names:
            char_cfg = ctx.characters.get(char_name)
            if not char_cfg:
                continue
            identity_ids = char_identity_ids.get(char_name, set())
            gender_label = _gender_label(char_cfg.gender)
            base_lock = "Gender and body type are LOCKED — do NOT change."

            if identity_ids and char_cfg.identity_sketch_colors:
                # 有身份级颜色：每个身份一行
                for iid in sorted(identity_ids):
                    suffix = iid.split("_", 1)[1] if "_" in iid else iid
                    color = char_cfg.identity_sketch_colors.get(suffix, "")
                    if not color:
                        continue
                    parts = color.split(" ", 1)
                    _, color_name = parts[0], parts[1] if len(parts) > 1 else parts[0]
                    tag = PromptComponents.compute_char_tag(char_name, identity_id=iid)
                    identity_label = f"{tag}, {gender_label}" if gender_label else tag
                    source = _appearance_source(char_cfg, suffix)
                    binding = _reference_binding(color_name, char_name, tag)
                    lines.append(
                        f"- Any figure with a {color_name} tint (even pale/desaturated) = "
                        f"{identity_label}. {source}{binding} {base_lock}"
                    )
                    body_type = (char_cfg.identity_body_types.get(suffix) or char_cfg.body_type).strip()
                    if body_type:
                        lines.append(f"  Body build: {body_type}.")
            else:
                # 无身份级颜色：用角色级颜色
                color = char_cfg.sketch_color
                if not color:
                    continue
                parts = color.split(" ", 1)
                _, color_name = parts[0], parts[1] if len(parts) > 1 else parts[0]
                tag = PromptComponents.compute_char_tag(char_name)
                identity_label = f"{tag}, {gender_label}" if gender_label else tag
                source = _appearance_source(char_cfg)
                binding = _reference_binding(color_name, char_name, tag)
                lines.append(
                    f"- Any figure with a {color_name} tint (even pale/desaturated) = "
                    f"{identity_label}. {source}{binding} {base_lock}"
                )
                body_type = (char_cfg.body_type or "").strip()
                if body_type:
                    lines.append(f"  Body build: {body_type}.")

        prop_ids: list[str] = []
        seen_prop_ids: set[str] = set()
        for beat in ctx.beats:
            for prop_id in real_detected_props(beat.get("detected_props") or []):
                prop_id = str(prop_id or "").strip()
                if prop_id and prop_id not in seen_prop_ids:
                    seen_prop_ids.add(prop_id)
                    prop_ids.append(prop_id)
        for prop_id in PromptComponents._collect_prop_marker_ids(ctx.beats):
            prop_id = str(prop_id or "").strip()
            if prop_id and prop_id not in seen_prop_ids:
                seen_prop_ids.add(prop_id)
                prop_ids.append(prop_id)
        for refs in ctx.prop_asset_refs.values():
            for ref in refs or []:
                prop_id = str(getattr(ref, "base_id", "") or "").strip()
                if prop_id and prop_id not in seen_prop_ids:
                    seen_prop_ids.add(prop_id)
                    prop_ids.append(prop_id)

        prop_color_lines = []
        for prop_id in prop_ids:
            marker_color = str(ctx.prop_marker_colors.get(prop_id, "") or "").strip()
            if not marker_color:
                continue
            parts = marker_color.split(" ", 1)
            hex_code, color_name = parts[0], parts[1] if len(parts) > 1 else parts[0]
            prop_tag = PromptComponents.compute_prop_tag(prop_id)
            color_tag = f"{color_name} ({hex_code})" if hex_code else color_name
            prop_color_lines.append(
                f"- Any object/shape with a {color_tag} tint = named prop {prop_tag} ({prop_id}). "
                "Use the attached prop reference if present. Marker color is identification-only, "
                "not the prop's final material."
            )

        if prop_color_lines:
            lines.append("")
            lines.append("PROP COLOR IDENTIFICATION (match sketch colors to prop references):")
            lines.extend(prop_color_lines)

        if len(lines) <= 1:
            return ""
        lines.append("")
        lines.append(
            "RULE: Identify characters by their COLOR TINT in the sketch, NOT by body language or position. "
            "Sketch colors may be very light or washed-out — if a figure has ANY hint of the assigned color, it IS that character."
        )
        lines.append(
            "Do NOT infer gender, age, or body type from pose, kneeling posture, weakness, camera angle, or scene context. "
            "Color identity overrides pose-based assumptions."
        )
        lines.append(
            "⚠️ CRITICAL: Sketch colors are ONLY identification markers — they carry NO information about the character's actual appearance. "
            "The sketch colors are fluorescent ID markers only, not final colors. "
            "The real clothing/skin/hair colors come EXCLUSIVELY from the reference image (if provided) or the text description. "
            "You MUST completely replace the sketch tint with the true colors. No marker color may remain visible on exposed skin, hair, costume, shadows, or highlights. "
            "For example, a GREEN-marked figure wearing white clothes in the reference MUST be rendered in white, with ZERO green residue."
        )
        return "\n".join(lines)

    @staticmethod
    def build_panel_roster(ctx: PromptContext) -> str:
        """构建极简 Panel 角色名单（替代完整的 visual_description）。

        Sketch 已包含所有视觉内容，render 只需知道每个 panel 有哪些角色
        以便映射 identity lock。同时提供全局或 per-panel 的 time_of_day 作为光照提示。
        """
        lines = []
        total_panels = ctx.grid.total_panels
        actual_beats = ctx.beats[:total_panels]

        # 收集 per-panel time_of_day
        panel_tods = []
        for beat in actual_beats:
            tod = beat.get("time_of_day", "")
            panel_tods.append(tod)

        # 收集 scene_id：继承前一个 panel 的 scene_id（与 build_panel_flow 相同逻辑）
        panel_scenes = []
        prev_scene = None
        for beat in actual_beats:
            scene_id = beat_scene_id(beat)
            if not scene_id and prev_scene:
                scene_id = prev_scene
            prev_scene = scene_id if scene_id else prev_scene
            panel_scenes.append(scene_id)

        for i, beat in enumerate(actual_beats, start=1):
            # per-panel 出场角色：直接用 detected_identities（草图工作台颜色检测结果）
            markers = real_detected_identities(beat.get("detected_identities") or [])
            char_color_lines = []
            for marker in markers:
                for char_name in ctx.characters or {}:
                    if marker == char_name or marker.startswith(char_name + "_"):
                        char_cfg = ctx.characters[char_name]

                        identity_id = marker if "_" in marker else None
                        tag = PromptComponents.compute_char_tag(char_name, identity_id=identity_id)

                        # 解析颜色
                        color = ""
                        if identity_id:
                            suffix = (
                                identity_id.split("_", 1)[1] if "_" in identity_id else identity_id
                            )
                            color = char_cfg.identity_sketch_colors.get(
                                suffix, char_cfg.sketch_color
                            )
                        else:
                            color = char_cfg.sketch_color
                        if color:
                            parts = color.split(" ", 1)
                            hex_code, color_name = parts[0], (
                                parts[1] if len(parts) > 1 else parts[0]
                            )
                        else:
                            hex_code, color_name = "", "?"

                        # 性别标签
                        g = char_cfg.gender.strip()
                        if g in ("女", "女性", "female"):
                            gender_label = "FEMALE"
                        elif g in ("男", "男性", "male"):
                            gender_label = "MALE"
                        else:
                            gender_label = g.upper() if g else ""

                        color_tag = f"{color_name} ({hex_code})" if hex_code else color_name
                        gender_suffix = f", {gender_label}" if gender_label else ""
                        char_color_lines.append(f"  {color_tag} = {tag}{gender_suffix}")
                        break

            scene_lines = []
            for ref in ctx.scene_refs.get(i, []):
                scene_lines.append(PromptComponents._format_render_scene_anchor_line(ref))
                if panel_tods[i - 1]:
                    scene_lines.append(f"Time of day: {panel_tods[i - 1]}")
                    if bool(getattr(ref, "time_baked", False)):
                        scene_lines.append(
                            "This scene anchor already has the panel's time-of-day lighting baked in; preserve the anchor lighting and do not relight."
                        )
                    else:
                        scene_lines.append(
                            "Apply the panel's time-of-day lighting state to the locked environment identity."
                        )

            prop_lines = []
            for ref in PromptComponents._filter_panel_prop_asset_refs(ctx, i):
                prop_id = str(getattr(ref, "base_id", "") or "").strip()
                prop_lines.append(PromptComponents._format_prop_anchor_line(ref))
                marker_color = str(ctx.prop_marker_colors.get(prop_id, "") or "").strip()
                if marker_color:
                    prop_tag = PromptComponents.compute_prop_tag(prop_id)
                    prop_lines.append(
                        f"{marker_color} marker = {prop_tag} ({prop_id}); marker color is identification-only."
                    )
                prop_lines.append(
                    "Use the prop reference to preserve the same object identity, not just a similar generic object."
                )

            panel_desc_lines = scene_lines + prop_lines
            if not panel_desc_lines and panel_scenes[i - 1]:
                panel_desc_lines = [f"Scene: {panel_scenes[i - 1]}"]
            if ctx.scene_refs.get(i):
                panel_desc_lines.append(
                    "⚠️ 静态环境以场景锚图为准；角色位置和姿态以草图为准；道具只能适配既有构图，不得重建或改写场景。"
                )
                if any(
                    PromptComponents._is_rough_render_scene_ref(ref)
                    for ref in ctx.scene_refs.get(i, [])
                ):
                    panel_desc_lines.append(
                        "⚠️ 当前场景锚图是粗糙 3D Gaussian Splatting/env_only 参考：只保留同机位关系和材质线索，必须清理 Gaussian-splat 噪声、浮点杂点、模糊、破边、投影接缝和扭曲纹理。"
                    )
            else:
                panel_desc_lines.append(
                    "⚠️ 无场景锚图时才使用场景文字；空间关系以草图为准；环境元素只能适配既有构图，不得新增层级、景深或站位信息。"
                )
            panel_desc = "\n".join(panel_desc_lines)

            loc_tag = f" [{panel_scenes[i-1]}]" if panel_scenes[i - 1] else ""
            tod_tag = f" [{panel_tods[i-1]}]" if panel_tods[i - 1] else ""
            style_tag = f" [{ctx.style.panel_tag}]" if ctx.style.panel_tag else ""
            header = f"- **Panel {i}**{loc_tag}{tod_tag}{style_tag}:"
            if char_color_lines:
                lines.append(header)
                lines.extend(char_color_lines)
                lines.extend(f"  {line}" for line in panel_desc.splitlines())
            else:
                lines.append(header)
                lines.extend(f"  {line}" for line in panel_desc.splitlines())

        # 填充不足的 panels
        if len(actual_beats) < total_panels:
            for i in range(len(actual_beats) + 1, total_panels + 1):
                lines.append(
                    f"- **Panel {i}** [BLANK PLACEHOLDER]: A simple solid gray background "
                    f'with a large white "X" drawn diagonally across the panel. '
                    f"No scenery, no characters, no details. This panel is intentionally empty."
                )

        return "\n".join(lines)

    @staticmethod
    def build_single_beat_render_visual_reference(ctx: PromptContext) -> str:
        """Add the beat text back for 1x1 render as semantic guidance only."""
        if ctx.mode != PromptMode.RENDER or ctx.grid.total_panels != 1 or not ctx.beats:
            return ""
        beat = ctx.beats[0] or {}
        visual_desc = str(beat.get("visual_description", "") or "").strip()
        if not visual_desc:
            return ""

        visual_desc = _resolve_prop_marker_tags(visual_desc)
        if ctx.characters:
            from novelvideo.utils.identity_resolver import (
                build_identity_to_char_map,
                resolve_visual_description_markers,
            )

            id_to_char = build_identity_to_char_map(ctx.characters)
            visual_desc = resolve_visual_description_markers(
                visual_desc,
                ctx.characters,
                id_to_char,
                use_identity_id=True,
            )

        lines = [
            "SINGLE-BEAT VISUAL DESCRIPTION REFERENCE:",
            f"- Visual description: {visual_desc}",
        ]
        scene_id = beat_scene_id(beat)
        if scene_id:
            lines.append(f"- Scene: {scene_id}")
        time_of_day = str(beat.get("time_of_day", "") or "").strip()
        if time_of_day:
            lines.append(f"- Time of day: {time_of_day}")
        lines.extend(
            [
                "- Use this text only to understand action intent, object identity, and ambiguous marker meaning in the existing sketch.",
                "- Do NOT use this text to redraw, reframe, move, add, remove, or restage elements beyond what is already present in Image 1 / SKETCH.",
                "- If this text contains color words or sketch marker colors, they are semantic/ID hints only; final character and prop material colors still come from identity/prop references.",
            ]
        )
        return "\n".join(lines)

    @staticmethod
    def build_panel_flow(beats: List[dict]) -> str:
        """生成面板过渡关系。"""
        if len(beats) < 2:
            return ""

        lines = ["PANEL TRANSITIONS:"]
        resolved_locations = []
        prev_loc = None
        for beat in beats:
            loc = beat_scene_id(beat)
            if not loc and prev_loc:
                loc = prev_loc
            prev_loc = loc if loc else prev_loc
            resolved_locations.append(loc)

        for i in range(len(beats) - 1):
            curr_loc = resolved_locations[i]
            next_loc = resolved_locations[i + 1]

            if curr_loc == next_loc and curr_loc:
                lines.append(f"- Panel {i+1} → {i+2}: SAME SCENE (keep identical background)")
            elif not curr_loc or not next_loc:
                lines.append(f"- Panel {i+1} → {i+2}: SAME SCENE (continuation)")
            else:
                lines.append(f"- Panel {i+1} → {i+2}: SCENE CHANGE ({curr_loc} → {next_loc})")

        return "\n".join(lines)

    @staticmethod
    def build_seamless_constraint(total: int) -> str:
        """构建无缝图像约束块。"""
        return f"""SEAMLESS GRID REQUIREMENT:
All {total} regions form ONE image with NO drawn grid lines, borders, or gutters.
Different scenes may have different backgrounds — transitions between scenes should be natural, not separated by lines.
Regions must touch edge-to-edge with ZERO borders, frames, or dividing lines."""

    @staticmethod
    def build_style_section(ctx: PromptContext) -> str:
        """构建风格约束。"""
        avoid_section = f"AVOID: {ctx.style.avoid_keywords}" if ctx.style.avoid_keywords else ""
        finish_line = (
            "Dynamic cinematic lighting, consistent animation finish."
            if _is_animation_style(ctx.style)
            else "Cinematic lighting, consistent color grading."
        )
        return f"""
STYLE: {ctx.style.style_keywords}
{finish_line}
LAYOUT: ONE CONTINUOUS IMAGE. ZERO visible boundaries between regions. No borders, no frames, no gutters, no lines.
⛔ NEVER RENDER: text, labels, captions, subtitles, watermarks, scene names, or any written content on the image. OUTPUT PURE VISUAL ONLY.
{avoid_section}"""


# =============================================================================
# 模式策略
# =============================================================================


class RenderModeStrategy:
    """Render 模式：基于草图渲染（使用文本格式，效果更稳定）。"""

    def build(self, ctx: PromptContext, components: PromptComponents) -> str:
        rows, cols = ctx.grid.rows, ctx.grid.cols
        total = ctx.grid.total_panels
        panel_hint = (
            _panel_ar_hint(ctx.grid.aspect_ratio, rows, cols)
            if ctx.grid.aspect_ratio
            else "SQUARE (1:1)"
        )
        preset_scope = (
            "Scene preset controls the final rendering style of the whole image: environment, lighting, skin texture, material response, and overall image finish. "
            "Composite / identity-sheet and portrait-only references lock character identity and appearance details only: face identity, facial geometry, hair identity, silhouette, and costume details. "
            "Do NOT inherit or preserve a reference image's CG, beauty-filter, illustrated, or over-retouched rendering look; re-render the same person in the project's scene preset."
        )

        # Render 专用开头：一句话讲清任务 + 对象 + 比例
        render_opening = f"""Colorize this {rows}×{cols} storyboard SKETCH (first attached image / Image 1) into a full-color continuous image with {total} seamless regions. Each panel MUST be {panel_hint}.

STYLE: {ctx.style.style_keywords}
{preset_scope}

!!! MANDATORY GRID FORMAT: {rows} ROWS × {cols} COLUMNS !!!
(This means {rows} horizontal rows stacked vertically, each row containing {cols} panels side by side)

Image 1 / SKETCH IS the base drawing — preserve ALL composition, crop, poses, and camera angles exactly. Other reference images must not change the sketch layout.
⚠️ HARD CONSTRAINT: {total-1} regions = FAIL. {total+1} regions = FAIL. Only {total} = PASS.
ONE continuous image. ZERO visible boundaries between regions."""

        # Render 模式：严格按 detected_identities 出场顺序，不回退 visual_description 标记
        ordered_chars = components.extract_panel_characters_from_detected(ctx.beats, ctx.characters)
        ctx.resolved_render_chars = list(ordered_chars)
        constraints = components.build_constraints(ctx, include_face_reminder=False)

        parts = [
            render_opening,  # Section 0+1: 合并的任务声明
            components.build_reference_map(
                ctx, ordered_chars, include_face_desc=False, include_silhouette=False
            ),
            components.build_identity_lock(ctx, ordered_chars, compact=True),
            components.build_asset_identity_lock(ctx),
            components.build_fusion_rules(ctx, ordered_chars),
            components.build_time_of_day_rules(ctx),
            components.build_color_identification_map(ctx, ordered_chars),
            components.build_single_beat_render_visual_reference(ctx),
            components.build_panel_roster(ctx),
            constraints,
        ]
        return "\n\n".join(p for p in parts if p)


def _panel_ar_hint(aspect_ratio: str, rows: int, cols: int) -> str:
    """根据整图比例和网格几何，推算单面板的朝向提示。

    对于 NxN 网格，每个 panel 的比例 = 整图比例。
    """
    from math import gcd

    w_ratio, h_ratio = map(int, aspect_ratio.split(":"))
    # NxN 网格时 panel 比例 = 整图比例
    panel_w, panel_h = w_ratio, h_ratio
    if rows != cols:
        panel_w = w_ratio * rows
        panel_h = h_ratio * cols
    g = gcd(panel_w, panel_h)
    panel_w, panel_h = panel_w // g, panel_h // g
    panel_ar = panel_w / panel_h
    if panel_ar < 0.9:
        return f"{panel_w}:{panel_h} PORTRAIT - much taller than wide"
    elif panel_ar > 1.1:
        return f"{panel_w}:{panel_h} LANDSCAPE - wider than tall"
    return "SQUARE (1:1)"


class SketchModeStrategy:
    """Sketch 模式：伯里曼构造解剖风格 + 颜色编码。"""

    def build(self, ctx: PromptContext, components: PromptComponents) -> str:
        rows, cols = ctx.grid.rows, ctx.grid.cols
        total_panels = ctx.grid.total_panels

        # ASCII 布局（Sketch 模式使用竖屏 panel）
        ascii_layout = components.build_grid_ascii(rows, cols, ctx.grid.is_portrait_panel)

        panel_hint = (
            _panel_ar_hint(ctx.grid.aspect_ratio, rows, cols)
            if ctx.grid.aspect_ratio
            else "SQUARE (1:1)"
        )

        # ----- 先构建角色颜色信息（COLOR LAW 和 intro 都需要） -----
        char_lines = []
        char_names_for_color_law = []  # 用于 COLOR LAW 点名
        prop_lines = []
        local_prop_lines = []
        tag_color_map: dict[str, str] = {}  # tag → color_name（仅角色）
        prop_tag_color_map: dict[str, str] = {}  # prop tag -> marker color
        prop_color_lines: list[str] = []
        identity_tag_map: dict[str, str] = {}  # identity_id → tag
        prop_label_map: dict[str, str] = {}
        director_staging_lines: list[str] = []
        actual_beats_for_chars = ctx.beats[:total_panels]
        prop_tag_panel_map: dict[str, list[int]] = {}
        for panel_idx, beat in enumerate(actual_beats_for_chars, start=1):
            for prop_id in components._collect_prop_marker_ids([beat]):
                prop_tag = components.compute_prop_tag(prop_id)
                prop_tag_panel_map.setdefault(prop_tag, []).append(panel_idx)
        scene_image_refs = PromptComponents.collect_scene_image_refs(ctx)
        has_director_scene_ref_inputs = any(
            PromptComponents._is_director_scene_ref(ref) for ref in scene_image_refs
        )

        def _director_frame_prop_colors() -> dict[str, str]:
            colors: dict[str, str] = {}
            for ref in scene_image_refs:
                if not PromptComponents._is_director_scene_ref(ref):
                    continue
                image_paths = getattr(ref, "image_paths", []) or []
                if not image_paths:
                    continue
                meta_path = os.path.join(os.path.dirname(str(image_paths[0])), "frame_meta.json")
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                except Exception:
                    continue
                for prop in meta.get("props") or []:
                    if not isinstance(prop, dict):
                        continue
                    prop_id = str(
                        prop.get("prop_id") or prop.get("name") or prop.get("id") or ""
                    ).strip()
                    marker_color = str(prop.get("marker_color") or "").strip()
                    if prop_id and marker_color:
                        colors.setdefault(prop_id, marker_color)
            return colors

        director_frame_prop_colors = _director_frame_prop_colors()

        ordered_char_names: list[str] = []
        if ctx.characters:
            from novelvideo.utils.identity_resolver import compute_char_tag as _compute_tag

            panel_chars = components._collect_char_identity_ids(
                actual_beats_for_chars,
                use_detected_identities=False,
            )
            ordered_char_names = [name for name in panel_chars if name in ctx.characters]
            for char_name in panel_chars:
                char_cfg = ctx.characters.get(char_name)
                if not char_cfg:
                    continue
                body_desc = components.derive_body_descriptor(char_cfg)

                def _format_color_line(tag, body_desc, color_str, char_name="", appearance=""):
                    """Format a color-coded character line."""
                    name_suffix = f" {char_name}" if char_name else ""
                    if color_str:
                        parts = color_str.split(" ", 1)
                        hex_code = parts[0]
                        color_name = parts[1] if len(parts) > 1 else parts[0]
                        color_label = f"**{color_name} ({hex_code})**"
                    else:
                        color_label = ""
                    if color_label:
                        return f"- {tag}{name_suffix} — {color_label} featureless identity proxy."
                    return f"- {tag}{name_suffix} — featureless identity proxy."

                def _extract_color_name(color_str):
                    if not color_str:
                        return ""
                    parts = color_str.split(" ", 1)
                    return parts[1] if len(parts) > 1 else parts[0]

                def _identity_body_desc(suffix):
                    """获取身份级 body_desc（优先使用身份级 body_type）。"""
                    override = char_cfg.identity_body_types.get(suffix, "")
                    if override:
                        gender = char_cfg.gender.strip()
                        if gender in ("女", "女性", "female"):
                            return f"FEMALE, {override}"
                        elif gender in ("男", "男性", "male"):
                            return f"MALE, {override}"
                        return override
                    return body_desc

                active_identity_ids = set(panel_chars.get(char_name) or set())

                def _active_suffixes() -> list[str]:
                    suffixes: list[str] = []
                    if not char_cfg.identity_appearances:
                        return suffixes
                    for suffix in char_cfg.identity_appearances:
                        identity_id = f"{char_name}_{suffix}"
                        if not active_identity_ids or identity_id in active_identity_ids:
                            suffixes.append(suffix)
                    return suffixes or list(char_cfg.identity_appearances.keys())

                if len(char_cfg.identity_appearances) > 1:
                    for suffix in _active_suffixes():
                        details = char_cfg.identity_appearances.get(suffix, "")
                        identity_id = f"{char_name}_{suffix}"
                        tag = _compute_tag(char_name, identity_id=identity_id)
                        color = char_cfg.identity_sketch_colors.get(suffix, char_cfg.sketch_color)
                        char_lines.append(
                            _format_color_line(
                                tag, _identity_body_desc(suffix), color, appearance=details
                            )
                        )
                        char_names_for_color_law.append(tag)
                        tag_color_map[tag] = _extract_color_name(color)
                        identity_tag_map[identity_id] = tag
                elif char_cfg.identity_appearances:
                    suffix = _active_suffixes()[0]
                    details = char_cfg.identity_appearances[suffix]
                    identity_id = f"{char_name}_{suffix}"
                    tag = _compute_tag(char_name, identity_id=identity_id)
                    color = char_cfg.identity_sketch_colors.get(suffix, char_cfg.sketch_color)
                    char_lines.append(
                        _format_color_line(
                            tag, _identity_body_desc(suffix), color, appearance=details
                        )
                    )
                    char_names_for_color_law.append(tag)
                    tag_color_map[tag] = _extract_color_name(color)
                    identity_tag_map[identity_id] = tag
                else:
                    tag = _compute_tag(char_name)
                    color = char_cfg.sketch_color
                    char_lines.append(
                        _format_color_line(
                            tag, body_desc, color, appearance=char_cfg.appearance_details
                        )
                    )
                    char_names_for_color_law.append(tag)
                    tag_color_map[tag] = _extract_color_name(color)
                    identity_tag_map[char_name] = tag

        for prop_id in components._collect_prop_marker_ids(actual_beats_for_chars):
            prop_tag = components.compute_prop_tag(prop_id)
            marker_color = str(
                ctx.prop_marker_colors.get(prop_id, "")
                or director_frame_prop_colors.get(prop_id, "")
                or ""
            ).strip()
            if marker_color:
                parts = marker_color.split(" ", 1)
                hex_code = parts[0]
                color_name = parts[1] if len(parts) > 1 else parts[0]
                color_label = f"**{color_name} ({hex_code})**" if hex_code else color_name
                scoped_panels = prop_tag_panel_map.get(prop_tag, [])
                scoped_panel_text = ", ".join(str(p) for p in scoped_panels) or "tagged panels only"
                prop_label_map[prop_tag] = f"{prop_id} {prop_tag} {marker_color}"
                prop_tag_color_map[prop_tag] = marker_color
                prop_color_lines.append(
                    f"- {prop_tag} — {color_label} global prop marker for \"{prop_id}\". "
                    f"PANEL SCOPE: color this prop ONLY in Panel(s): {scoped_panel_text}. "
                    "EXACT COLOR LOCK: every visible part of this global prop marker MUST "
                    f"use {marker_color} only. Do not use any real material color. "
                    "Only the exact tagged prop instance gets this color. In the same panel "
                    "or any other panel, visually similar objects such as tissue boxes, "
                    "cardboard boxes, packages, crates, or box-like furniture are NOT this "
                    "global prop unless their own object is explicitly marked with this tag; "
                    "draw them as black/gray line art only."
                )
                prop_lines.append(
                    f"- {prop_tag} — GLOBAL TABLE PROP \"{prop_id}\". It MUST be entirely "
                    f"{marker_color} ONLY in Panel(s): {scoped_panel_text}. Every visible part of "
                    "this global prop marker must use this exact marker "
                    "color only. Do not use any other hue, material tint, texture, shading, "
                    "or real-object surface color. Draw it as a flat solid "
                    "simple prop marker with ZERO internal detail. Like a mannequin stands "
                    "in for a person, this colored shape stands in for the prop. Any visually "
                    "similar untagged object in the same panel or outside those panel(s) remains "
                    "ordinary black/gray line art."
                )
            else:
                prop_label_map[prop_tag] = f"{prop_id} {prop_tag}"
                local_prop_lines.append(
                    f"- {prop_tag} — LOCAL / EPISODE PROP \"{prop_id}\". No color fill. "
                    "Draw only as black/gray line art if visible."
                )

        if has_director_scene_ref_inputs:
            seen_staging: set[tuple[str, str]] = set()
            for beat in actual_beats_for_chars:
                for raw_item in beat.get("director_staging_items") or []:
                    if not isinstance(raw_item, dict):
                        continue
                    label = str(raw_item.get("label") or "").strip()
                    if not label:
                        continue
                    marker_color = str(raw_item.get("marker_color") or "").strip()
                    key = (label, marker_color)
                    if key in seen_staging:
                        continue
                    seen_staging.add(key)
                    if marker_color:
                        director_staging_lines.append(f"- marker={marker_color} -> draw user object: {label}")
                    else:
                        director_staging_lines.append(f"- draw user object: {label}")

        # COLOR LAW 区块（点名角色/道具）
        colored_targets = [*char_names_for_color_law, *prop_tag_color_map.keys()]
        prop_block = ""
        if local_prop_lines:
            sections = []
            sections.append(
                "LOCAL / EPISODE PROPS (never color-coded in sketch):\n"
                + "\n".join(local_prop_lines)
            )
            prop_block = f"""
{chr(10).join(sections)}
"""
        staging_block = ""
        if director_staging_lines:
            staging_block = f"""
DIRECTOR STAGING OBJECTS (draw the user's listed object; marker color is locator only, never output color):
{chr(10).join(director_staging_lines)}
"""
        if colored_targets:
            color_law = f"""⚠️ COLOR LAW (NON-NEGOTIABLE):
These {len(colored_targets)} named characters / panel-scoped global props have assigned color fills: {', '.join(colored_targets)}
Character color applies regardless of pose — sitting, crouching, lying on floor, being held down = STILL colored.
Global prop color applies ONLY to the exact tagged prop instance in the panel(s) listed for that prop. Do NOT propagate a global prop color to similar-looking untagged objects in the same panel or any other panel.
Unnamed people and extras must be gray directional mannequins only, NO color fill.
Do not add arbitrary new color fills to furniture/background/staging. Only named characters and listed-panel global props keep marker colors.
Only GLOBAL TABLE PROPS can keep prop marker color. Local / episode props are black/gray line art only, even when written with [[prop]] markers.
For global props, the assigned marker color wins over the object's real-world material color inside its listed panel(s). Use the listed marker color only; do not render the object's normal material color.
DIRECTOR STAGING OBJECTS are NOT global props and MUST NOT keep marker color; draw staging as black/gray line art only.

COLOR-CODED CHARACTERS:
{chr(10).join(char_lines)}
{("COLOR-CODED GLOBAL PROPS:" + chr(10) + chr(10).join(prop_color_lines)) if prop_color_lines else ""}
"""
        else:
            color_law = ""

        has_scene_refs = bool(scene_image_refs)
        has_director_scene_refs = has_director_scene_ref_inputs
        has_director_blocking_refs = any(
            PromptComponents._is_director_image_ref(ref) for ref in scene_image_refs
        )
        # Space Map / scene_spatial_layout references are legacy/advisory for
        # storyboard now. Keep them in the generic scene-ref path rather than
        # switching to the old hard-locked map prompt.
        scene_geometry_block = ""
        if has_scene_refs:
            if has_director_scene_refs and has_director_blocking_refs:
                scene_geometry_block = """
SCENE GEOMETRY REFERENCE:
The attached scene reference is a 3GS DIRECTOR CONTROL FRAME, not a final sketch and
not a loose style reference. It contains the chosen camera view, rough background,
visible actor/mannequin placeholders, prop markers, and staging placeholders.

DIRECTOR CONTROL FRAME LOCK:
- Use the 3GS DIRECTOR CONTROL FRAME as a spatial/camera control input, not as pixels
  to keep. Translate it into the normal production sketch style.
- Preserve the same camera intent, crop, FOV, horizon, lens distance, object screen
  positions, actor screen regions, table edges, stool positions, window/fan/wall
  relation, counter side, condiment/object placement, and local furniture topology.
- Furniture contact is part of the blocking: tables, counters, stools, chairs,
  benches, beds, desks, and similar set pieces are solid support/occlusion objects.
  A seated mannequin must sit ON a visible or minimally implied seat and stay
  beside/behind the table edge, never inside the tabletop/counter/bench/table
  volume. Legs may go under a table, but hips/torso/head must remain outside the
  furniture body with a readable table-edge occlusion relationship.
- If the exported 3GS mannequin/marker intersects furniture because of projection,
  depth sorting, or marker scale, treat that as a control-frame artifact. Repair it
  with the smallest physically plausible adjustment inside the same actor screen
  region; do not move the actor to a different seat, table, side of the room, or
  new camera setup.
- Do NOT preserve projection errors literally. If the 3GS/360 capture creates fisheye
  bending, extreme wide-angle stretching, curved walls, bowed counters, warped floors,
  bent verticals, broken seam cuts, or discontinuous wall/floor surfaces, repair them
  into one coherent storyboard perspective with straight architectural construction.
  This correction must keep the same screen regions and staging; it is not permission
  to change camera, crop, scale, object order, or furniture placement.
- Door/window/opening topology is locked, but surface condition is NOT. If the source
  shows a walkable doorway, door panel, side jamb, threshold, window, or partition,
  keep the same passable-vs-blocking relationship, open/closed state, side angle,
  depth cue, and screen region. Do NOT turn an oblique doorway into a generic
  front-facing double door, do NOT fill an opening as a wall/cabinet, and do NOT
  invent a cleaner symmetrical door system. Do NOT copy dirt, damage, decay,
  material texture, reflections, or surface wear into the sketch; those belong to
  the later render/color stage.
- Redraw the environment as simplified storyboard line art / light gray construction
  lines. Do NOT keep the blurred 3GS rendering, texture, shading, lighting, noise, or
  photographic/game-render look.
- The visible 3GS actor/mannequin is only an actor placement placeholder. Replace it
  in the same approximate screen region with a color-coded directional mannequin. Its original
  pose is only a hint; the final mannequin pose, facing direction, held-object relation, and
  action must come from the panel visual_description.
- Visible colored prop/staging blocks are source placeholders. If the action uses a named prop with that marker color, transform that visible marker into the action prop; do NOT leave the original marker and create a duplicate marker elsewhere.
- Unrelated staging markers are production placeholders. Keep them visible as flat
  black/gray rough silhouettes in the same screen position; do not move, delete,
  color-fill, materialize, or beautify them.
- Ignore any older camera plan, exit-path plan, or door-framing plan. The attached image is the current human-approved camera.
- Do NOT push in, pull out, rotate, pan, reframe, or choose a cleaner alternate camera.
- Do NOT reconstruct the scene from imagination. Use the attached blocking frame only
  to decide the sketch camera and object placement.

OVERLAY OUTPUT CONTRACT:
- Replace every blocky 3GS actor/mannequin with simple directional storyboard mannequins that perform the action described in the panel's visual_description.
- Characters named by {{identity}} markers receive their assigned flat marker color.
- Unnamed background people / customers / crowd figures become gray directional mannequins only.
- If the visual_description says a character holds/carries/lifts a [[prop]], the scene sketch MUST show the mannequin doing that action around the visible actor placeholder: arms/hands wrapped around the prop at the hands, just like the free sketch workflow. If a visible GLOBAL prop marker block exists in the input for this same listed panel, reuse/transform that marker into the held prop; do not duplicate it. If it is a global prop with an assigned marker color in this panel, fill the held prop itself with that assigned prop color, not realistic brown/cardboard/material color. Local/episode props and similar untagged objects are black/gray line art only. Do not omit the held object relationship.
- Draw global props as simple storyboard prop silhouettes only when they are tagged/listed as part of the action for that panel; only the exact tagged prop instance keeps its assigned marker color. Local/episode props and similar untagged objects in the same panel or any other panel are black/gray line art only. Never create a second copy of an already-visible prop marker unless the story explicitly says there are two.
- Do not turn colored directional mannequins into realistic people during sketch generation.
- Do not turn colored global prop markers into final realistic objects during sketch generation.
- Do translate staging markers into black/gray rough line-art silhouettes by semantic label.
- The later render stage will replace mannequins and prop markers with real identities/materials.

ALLOWED CHANGES:
- Convert the original 3GS scene plate into clean production sketch line art.
- Replace blocky 3GS mannequins with simple colored directional mannequins in the same screen regions.
- Add only the beat action details around the existing colored mannequins, especially facing direction, arm pose, feet direction, and held props.
- Keep all characters as simple color-coded directional mannequins over the simplified line-art
  version of the chosen background.

FORBIDDEN CHANGES:
- No new camera angle.
- No blank white-paper redraw that loses the chosen 3GS camera/background topology.
- No generic line-art redraw that ignores the chosen 3GS camera/background topology.
- No realistic repaint, no new background painting from scratch, and no keeping the
  original blurred 3GS pixels as the visible background.
- No background repair pass unless a pixel artifact makes the actor/prop relation unreadable.
- No final cinematic lighting, depth of field, motion blur, material polish, or full environment beautification.
- No new furniture cluster.
- No changed table shape or table position.
- No different wall/window/fan arrangement.
- No extra named characters.
- Any signage, menus, posters, labels, clock faces, screens, and wall notices must stay unreadable.

This is a staging/marker scene sketch over an existing 3GS blocking base, not a final render or new scene generation task.
""".strip()
            elif has_director_scene_refs:
                scene_geometry_block = """
SCENE GEOMETRY REFERENCE:
The attached scene reference is a 3GS/director background sketch reference.
It may be a single beat-specific anchor or a director reference sheet aligned to this output grid.
It is a normal scene sketch reference with an existing background, not a separate camera plan.

GEOMETRY (STRICTLY INHERITED):
- The visible walls, ceiling, floor, windows, doors, counters, road edges, poles, seats, and major fixed fixtures must stay consistent with this environment anchor.
- You MAY NOT invent new walls, new windows, new architectural zones, new fixtures, or rearrange the existing layout.
- Preserve the same local left/right ordering of fixed fixtures that is visible in the environment anchor.
- Preserve the table/chair/stool orientation from the matching sheet cell. Do NOT rotate or rebuild a table cluster into a new diagonal foreground composition unless the contract explicitly asks for it.

LOCAL FURNITURE LOCK (CRITICAL):
- The visible furniture cluster in the director reference is the actual action zone for this beat. Do NOT treat it as a loose background texture.
- Preserve the exact relative order, scale, and partial visibility of local furniture: long table vs square table, table edge vs full tabletop, stool positions, window/fan/wall relation, counter side, and condiment/object placement.
- If the reference shows only a partial table edge or one corner of a square table, keep it partial in the same side of the frame. Do NOT move it to the center, enlarge it into a new foreground table, or redraw it as a different full dining setup.
- If a required seated/over-shoulder character needs support geometry that is not fully visible, attach the character to the existing visible table/seat edge with a minimal implied stool or shoulder cue. Do NOT spawn a second foreground table, bench, booth, platform, or unrelated furniture cluster.
- Foreground shoulders and bodies may occlude the inherited geometry, but they must not replace it with a new table layout.
- If you cannot confidently infer hidden furniture from the anchor, omit the hidden furniture rather than inventing a cleaner generic restaurant table.

COMPOSITION (CONTROLLED):
- Character placement, pose, and crop should come from the panel visual_description while respecting the visible background.
- For close-up or reaction beats, keep only the nearest support geometry that would naturally stay in frame after moving closer within the same anchored space.
- Do NOT expand a close-up into a fuller room layout or add extra local furniture just to make the frame feel filled.
- Place the directional mannequin characters on top of this inherited geometry.
- Scale mannequins to the furniture and shot scale. For medium and wide shots, no colored head should dominate the panel unless the contract explicitly says close-up.

HARD CONSTRAINTS:
- Do NOT average this anchor with an alternative scene layout.
- Do NOT silently rotate to a different scene side.
- Do NOT duplicate major fixtures on both sides of the room/street/carriage.
- Any signage, menus, posters, labels, clock faces, screens, and wall notices must stay unreadable. Replace them with abstract shapes or illegible marks only.
- Panels explicitly marked as BLANK PLACEHOLDER are exempt from scene geometry inheritance and should remain empty placeholders.

This environment anchor defines the visible background. The panel visual_description defines the action.
Keep scene lines minimal and clean — this is still a storyboard sketch, not a rendered scene.
""".strip()
            elif ctx.mode == PromptMode.SKETCH:
                # Sketch 模式：scene 参考只作为 STYLE ANCHOR（线条/材质/光照/调色风格），
                # 不锁几何也不锁机位。每个 panel 的相机和构图完全由 visual_description 驱动。
                scene_geometry_block = """
SCENE STYLE ANCHOR (NOT a geometry constraint):
The attached scene reference image is a STYLE ANCHOR for sketch generation, NOT a camera or layout constraint.

USE THE SCENE REFERENCE FOR:
- Linework density, brush feel, and overall hand-drawn finish
- Material language and surface texture vocabulary (wood / tile / metal / concrete etc.)
- General scene identity (so the panel reads as "this location" rather than a generic interior)

DO NOT USE THE SCENE REFERENCE FOR:
- Camera angle, framing, or shot size — these come from each panel's visual_description and your director's judgement
- Specific furniture count or exact wall positions — sketches don't need pixel-level geometry, they need readable blocking
- Forcing every panel to mirror the reference's FRONT-FACING establishing view

DIRECTING FREEDOM:
- You are the storyboard director: choose the best shot size (wide / medium / close-up / OTS / insert / reaction) and camera angle (eye-level / high / low / three-quarter / side / over-shoulder / first-person) for each panel based on the beat's emotional and narrative needs.
- Vary shot sizes and camera angles aggressively across the 16 panels to build cinematic rhythm. Avoid using the same medium eye-level shot for multiple consecutive panels.
- Each panel should feel like a different camera setup, not the same camera mirrored.

LIGHT GEOMETRY HYGIENE (soft, not enforced):
- Stay roughly inside the same location identity across consecutive panels in the same scene; do not switch venues mid-conversation.
- Major fixed fixtures (counter side / entry direction / window wall) should stay consistent across closely-related panels so shot/reverse-shot reads coherently. Minor furniture count may shift between shots.
- Any signage, menus, posters, labels, clock faces, screens, and wall notices must stay unreadable. Replace them with abstract shapes or illegible marks only.
- Panels explicitly marked as BLANK PLACEHOLDER remain empty placeholders.
""".strip()
            else:
                scene_geometry_block = """
SCENE GEOMETRY REFERENCE:
The attached scene reference assets describe the SAME environment.
In the 2.0 scene asset pipeline they are normally:
- MASTER / FRONT: real scene look, materials, lighting, and the primary view
- TOP_DOWN / FLOOR PLAN: room layout and object placement from above
- REVERSE / BACK: missing rear-side fixtures and surfaces

GEOMETRY (STRICTLY INHERITED):
- The scene's walls, ceiling, floor, windows, doors, counters, road edges, poles, seats, and major fixed fixtures come from the scene reference assets.
- You MAY NOT invent new walls, new windows, new architectural zones, new fixtures, or rearrange the existing layout.
- For each storyboard panel, use MASTER/FRONT for look and visible details, TOP_DOWN for spatial placement, and REVERSE/BACK only when the shot faces the rear side or needs missing back-wall evidence.
- If only a subset of assets is provided, use the available assets as constraints and keep uncertain hidden areas minimal.

COMPOSITION (STILL FREE):
- You MAY choose shot size freely (wide / medium / close-up) based on the beat.
- You MAY choose camera angle within the scene (eye-level / high / low / over-shoulder / three-quarter / side-view) as long as the visible geometry remains consistent with the chosen PRIMARY region.
- If no region matches exactly, compose a new shot that is geometrically consistent with the nearest region, while using the other regions only to verify continuity of fixed fixtures and surface layout.
- For each panel, first identify the beat's LOCAL ACTION ZONE inside the inherited scene geometry: for example one table pair, one booth, one counter segment, one doorway zone, or one seat row.
- Adapt environment density to shot scale:
  close-up / reaction / insert -> keep the SAME local action zone, but only draw the nearest support geometry that would naturally remain in frame
  medium shot -> keep the local action zone readable without expanding to the whole room
  wide / establishing / walking shot -> preserve the broader room or street layout
- The environment geometry is fixed. Prefer CAMERA REPOSITIONING over restaging the room. When turning a wide shot into a medium or close-up, move closer to the existing local action zone instead of teleporting the subject to a different table, seat, doorway, or foreground platform.
- If a beat is a tighter shot of someone already seated or interacting at a table/seat zone, preserve that SAME local furniture zone and crop closer into it rather than inventing a second foreground table or bench.
- When a beat describes dining, conversation at a table, or seated interaction, preserve the same local table/seat relationship implied by the scene. Do NOT turn a background table into a different front-table setup.
- Keep the fixed furniture inventory of the visible local zone stable across shots. If the chosen zone has one table, one bench pair, or one counter segment, do NOT silently turn it into two tables, a new bench, or a different furniture cluster.
- Place the stick-figure characters on top of this inherited geometry.

HARD CONSTRAINTS:
- Do NOT duplicate the same major fixture on both sides of the room/street/carriage.
- Do NOT average all reference regions together into a vague blended layout.
- Do NOT invent a third architectural layout different from the provided reference regions.
- Do NOT invent a new foreground table, bench, counter, doorway, or wall segment just to support a close-up.
- Do NOT merely restage the action into a different furniture zone when a tighter camera move within the same zone would satisfy the beat.
- Do NOT swap the subject from one local action zone to another unless the beat explicitly describes that movement.
- Do NOT add, remove, duplicate, or replace fixed furniture units inside the chosen local action zone unless the beat explicitly shows that physical change.
- If the beat is built around one table pair, one booth, or one seat pair, preserve that SAME pair and SAME seating orientation when moving closer. Do NOT restage it as a different generic front-table setup.
- Keep MASTER / TOP_DOWN / REVERSE as complementary evidence for one fixed space, not as alternative redesigns.
- In highly symmetrical spaces such as train cars, hallways, and corridors, keep doors, windows, seats, poles, signage blocks, and ceiling fixtures consistent with the chosen camera direction, using other references only to confirm continuity.
- Any signage, menus, posters, labels, clock faces, screens, and wall notices must stay unreadable. Replace them with abstract shapes or illegible marks only.
- Panels explicitly marked as BLANK PLACEHOLDER are exempt from scene geometry inheritance and should remain empty placeholders.

The scene reference defines WHERE the environment is. Your job is to add WHO is there and WHAT they do.
Keep scene lines minimal and clean — this is still a storyboard sketch, not a rendered scene.
""".strip()

        rough_gpt_sketch = _uses_gpt_image_sketch_profile(ctx) and not (
            has_director_scene_refs and has_director_blocking_refs
        )
        if has_director_scene_refs and has_director_blocking_refs:
            style_block = """STYLE: **DIRECTOR CONTROL TO PRODUCTION STORYBOARD SKETCH**.
Convert the attached 3GS director control frame into a director-control production sketch: simplified background line art + color-coded actor proxies with readable facing cues + flat listed-panel global prop markers. The 3GS frame locks camera and placement only; it must not remain as a blurred rendered background. This is NOT final rendering."""
            role_line = "ROLE: You are a pragmatic production storyboard cleanup artist."
            task_line = f"TASK: Translate the attached 3GS director control frame into a {rows}x{cols} production storyboard sketch ({total_panels} panel). Preserve the approved camera intent, crop, composition, object placement, and actor/prop screen regions, but correct 3GS/360 projection distortion and redraw the background as simplified line art while replacing/posing visible actors and named action props according to visual_description."
            panel_rule_block = """DIRECTOR CONTROL TRANSLATION RULE:
- The first 3GS director frame is a control input, not a pixel base. Preserve camera intent, crop, room side, furniture screen positions, and prop/staging marker positions.
- Keep character/furniture contact physically readable in the sketch: seated mannequins sit on stools/chairs/benches beside the table edge, not inside the table/counter volume. If the control marker crosses a tabletop or counter, interpret the crossing as a rough placement artifact and make the smallest local correction while keeping the same screen region and action.
- Repair projection artifacts during translation: straighten bowed walls, counters, door frames, table edges, floor seams, shelves, screens, and vertical fixtures; merge broken 360 seam fragments into one readable surface; normalize impossible fisheye/wide-angle bending into a coherent storyboard perspective.
- Projection cleanup must not move actors, props, furniture, or the camera. Keep their screen regions, ordering, and scale stable.
- Door/opening rule: preserve topology, not material finish. A visible doorway remains a doorway, a blocking door panel remains a blocking panel, an open passage stays open, a closed barrier stays closed, and an angled side doorway stays angled in the same screen region. Do not replace it with a generic centered double-door icon. Do not copy dirt, decay, glass reflections, surface texture, or damaged detail into the sketch.
- Redraw the scene into the normal sketch vocabulary: clean black/gray environment lines on light paper, no 3GS blur, no rendered texture, no cinematic lighting.
- For each panel, change only what the visual_description requires: actor mannequin pose/facing/action and held named prop relation.
- Translate DIRECTOR STAGING OBJECTS from the listed user object label and visual_description: if the label says horse, draw a horse-like rough storyboard silhouette in the same screen position, not an anonymous box.
- STAGING COLOR BAN: if a DIRECTOR STAGING OBJECT lists marker=#RRGGBB, use that marker color ONLY to find the colored control shape in the Director frame. The output staging object MUST be black/gray line art only. It must NOT have colored fill, colored outline, colored tint, or any marker-colored pixels."""
            rendering_preface = """- OUTPUT MUST LOOK LIKE A NORMAL PRODUCTION SKETCH, not a 3GS screenshot with markers.
- Redraw the chosen 3GS background as simplified line art / light gray construction lines while preserving its camera and topology.
- Attached scene master/detail references are only for material/fixture recognition; they must not override the 3GS control frame composition.
- Do not add final cinematic lighting, depth of field, motion blur, realistic materials, or final environment polish.
- Do not preserve the original 3GS blur, texture, shading, noisy pixels, or game-render look.
"""
            environment_rules = """- Existing environment/furniture/staging stays in the same screen position but becomes simplified line art.
- Staging objects with semantic labels must remain recognizable as that object class in sketch form (horse, vehicle, sedan chair, pile of boxes, etc.).
- Staging marker colors are input locators only. All staging output must be black/gray line art only, with no marker color preserved.
- Global prop markers remain flat marker-color shapes only in their listed panel(s) when they are part of the action.
- Only named actors and listed-panel global props can be colored. Unnamed background people, local/episode props, and all staging objects are black/gray only."""
        else:
            style_block = """STYLE: **COLOR-CODED DIRECTIONAL STORYBOARD MANNEQUIN** on pure white background.
Speed and clarity over artistic quality. Focus on CHARACTER PLACEMENT, POSE, and CAMERA ANGLE.
SYMBOLIC STORYBOARD PEOPLE ONLY: all humans are featureless identity proxies, not character designs. Use only oval head, one body-axis/spine line, single-stroke arms/legs, short shoulder/hip direction ticks, tiny facing tick, and tiny ground-contact direction ticks. These ticks show facing direction only; they are not shoes or feet details. NO clothing of any kind, no hair, no facial features, no skin, no gendered body shape, no realistic anatomy.
Global props are flat solid color markers/silhouettes only in their listed panel(s) (real material rendered later in the render stage). Local/episode props are black/gray line art only.
Backgrounds are minimal contextual black/gray line art based on attached scene references when present; characters and listed-panel global props are the visual priority."""
            role_line = "ROLE: You are a MASTER FILM DIRECTOR and storyboard artist."
            task_line = f"TASK: Create a {rows}x{cols} storyboard grid ({total_panels} panels) for a dramatic short film sequence. Read each panel's scene description and make the written action visually readable. Choose angle/framing only where the description leaves room; do not sacrifice blocking clarity for cinematic variety."
            panel_rule_block = """SINGLE-MOMENT RULE:
- Each panel must depict exactly ONE camera setup and ONE frozen story moment.
- Do NOT combine multiple sub-shots, multiple time slices, or multiple sequential actions inside one panel.
- Do NOT create split-screen, collage, comic-strip subdivisions, montage inserts, before/after composites, or flashback overlays inside a panel.
- If a panel description mentions a short sequence, memory, or several actions in a row, collapse it into the single dominant visual moment instead of showing all of them at once."""
            rendering_preface = """- WHITE PAPER BACKGROUND ONLY. No cinematic grayscale rendering, no dark fills, no gradients, no shadows, no lighting effects, no material shading.
- If scene master/reverse references are attached, draw a simple black/gray background line-art version of that scene; do NOT leave the background blank.
- The scene reference controls scene identity and fixed-space cues only. Redraw it as clean black/gray outline art; do NOT copy its darkness, blur, texture, color, material finish, or lighting mood.
- If the beat is dark/night/interior dim, suggest darkness with sparse line density or simple hatching only; do NOT fill the panel with black/gray shadow.
"""
            environment_rules = """- Unnamed props/environment → black line art, no fill
- Background → simplified architectural black/gray lines based on attached master/reverse scene references when provided; omit decorative detail."""
        if rough_gpt_sketch:
            style_block = """STYLE: in the style of a **rushed film director's storyboard scribble**, **rough hand-drawn sketch on cheap white paper**, **completely uninterested in artistic finish**, loose pencil/marker doodle scribbled in 30 seconds, deliberately unpolished, raw thumbnail-grade draft.
- Imperfect strokes; uneven line weight; visible "thinking on paper" feel
- This is a DRAFT / THUMBNAIL / BLOCKING SKETCH — NOT a finished illustration, NOT digital art, NOT vector graphics, NOT a children's book illustration, NOT clean line art
- Named characters get a single flat color fill in their assigned marker color. Global props get marker color fill ONLY in the panel(s) listed for that prop; local/episode props, visually similar untagged objects, and every DIRECTOR STAGING OBJECT are loose black/gray pencil/marker line work on pure white paper
- Characters are COLOR-CODED DIRECTIONAL MANNEQUINS; listed-panel global props are COLOR-CODED simple silhouettes filled with their marker color; local/episode props are black/gray line art only
- Speed and clarity over artistic quality; treat this as a 30-second blocking sketch, not a final piece"""
            role_line = "ROLE: You are a MASTER FILM DIRECTOR and storyboard artist."
            task_line = f"TASK: Create a {rows}x{cols} storyboard grid ({total_panels} panels) for a dramatic short film sequence. Read each panel's scene description and make the written action visually readable. Choose angle/framing only where the description leaves room; do not sacrifice blocking clarity for cinematic variety."
            panel_rule_block = """SINGLE-MOMENT RULE:
- Each panel must depict exactly ONE camera setup and ONE frozen story moment.
- Do NOT combine multiple sub-shots, multiple time slices, or multiple sequential actions inside one panel.
- Do NOT create split-screen, collage, comic-strip subdivisions, montage inserts, before/after composites, or flashback overlays inside a panel.
- If a panel description mentions a short sequence, memory, or several actions in a row, collapse it into the single dominant visual moment instead of showing all of them at once."""
            rendering_preface = """- Line work is loose and sketchy: imperfect strokes, slightly wobbly lines, occasional double-stroke or messy ends — like a fast pencil/marker draft, NOT clean vector lines
- Do NOT clean up, polish, smooth, or vectorize the lines; rough is correct
- Backgrounds must stay ultra-simplified: only a few major shapes and blocking lines, never a fully rendered scene
- Suggest the location with 3-8 essential strokes/shapes only; leave generous white space instead of filling the frame with detail
- NO texture rendering, NO debris scatter, NO surface patterning, NO dense perspective construction, NO cinematic atmosphere rendering
"""
            environment_rules = """- Unnamed props/environment → sparse, thin, light-gray line art only, no fill (this rule does NOT apply to global props in their explicitly listed panel(s) — those keep their assigned marker color fill)
- Background canvas → pure white
- Keep backgrounds extremely simple: only the minimum lines needed to show location, depth, and blocking
- Background details must never compete with colored characters/listed-panel colored global props or make the panel feel busy"""

        action_pose_block = """ACTION BLOCKING RULE:
- Treat the panel visual_description as the action source of truth.
- If the panel description contains physical action verbs (walk, leave, enter, turn, stand up, sit down, lift, carry, push, pull, open, cross, step, run, fall, reach; or Chinese equivalents like 走出/离开/进入/转身/站起/坐下/抱起/搬起/推/拉/打开/跨出/跑/摔倒), draw the figure in an action pose instead of a neutral standing icon.
- If the visual_description explicitly specifies shot size, framing, close-up, upper body, camera angle, POV, empty shot, or blackout, obey that framing first. Do not add extra body parts, thresholds, or environmental cues that the written framing excludes.
- If the visual_description explicitly says a character holds/carries/lifts a named prop, show the prop contact clearly inside the written framing.
- Do not use arrows, text labels, speed lines, or comic motion effects to explain movement."""

        # ----- 主体 intro -----
        if has_director_scene_refs and has_director_blocking_refs:
            intro_action = (
                f"Edit the attached 3GS combined background in place into a {rows}x{cols} scene sketch. "
                f"Each panel MUST be {panel_hint}. Do not create a new camera view. "
                "Lock the approved composition and staging, but correct 3GS/360 projection artifacts: fisheye bending, wide-angle stretching, broken seams, warped floors, curved walls, bowed counters, skewed tables, screens, door frames, floor seams, and vertical fixtures must become straight/coherent storyboard construction. Preserve door/window/opening topology, passable-vs-blocking relationship, and open/closed/angled state; do not replace them with cleaner generic doors, and do not copy material dirt/decay/detail into the sketch."
            )
        else:
            intro_action = (
                f"Generate a {rows}x{cols} storyboard grid. Each panel MUST be {panel_hint}."
            )

        intro = f"""{intro_action}

⚠️ 100% CANVAS COVERAGE — artwork fills ENTIRE canvas edge-to-edge, NO margins/padding/borders.

!!! MANDATORY GRID FORMAT: {rows} ROWS × {cols} COLUMNS !!!
(This means {rows} horizontal rows stacked vertically, each row containing {cols} panels side by side)

{role_line}

{task_line}

{panel_rule_block}

{action_pose_block}

VISUAL DESCRIPTION AUTHORITY:
- Treat every non-empty panel description as the hard visual brief for that panel.
- If a panel description explicitly names shot type, camera angle, POV, framing, composition, empty shot, or blackout, obey that written direction exactly.
- If a panel description does NOT specify shot/camera/framing, then choose the best shot yourself using the directing guidelines below.
- Never override explicit panel wording with a generic directing rule; use directing freedom only where the panel description leaves room.

{style_block}

{color_law}{prop_block}{staging_block}RENDERING RULES:
{rendering_preface}- Named characters → very simple COLOR-CODED DIRECTIONAL MANNEQUINS / featureless identity proxies with marker color fill/outline. Marker color identifies the character; it is not final character art.
- Global props (listed in COLOR-CODED GLOBAL PROPS) → ONLY in the listed panel(s), REPLACE the exact tagged prop instance with a flat solid marker shape entirely filled in its exact assigned marker color, with ZERO internal detail (no edges, no flaps, no logos, no shading). The marker color is mandatory and overrides real material color only for that tagged prop instance in those panel(s). Similar boxes/tissue boxes/packages in the same panel or any other panel are NOT color-coded unless they are explicitly tagged as this global prop; draw them as black/gray line art only.
- Unnamed people → gray directional mannequins only, no fill
{environment_rules}
- Anchor scale lock: identity proxies must fit the nearby support surface / seat / fixture scale. Do NOT draw giant foreground heads or oversized identity markers in any panel.
- Close-up rule: for close-ups, show only the necessary head oval, facing tick, shoulder direction line, and nearby support-surface / wall / fixture cues. Do NOT crop into a giant colored head or poster-like portrait.
- Keep identity proxies thin, simple, and map-like. Color marks identify characters; proxy shape only identifies blocking/facing direction.
- Focus on POSE, POSITION, FACING DIRECTION, and prop contact only, not anatomy.
- Directional mannequin allowed elements: round/oval head; optional tiny 5-15px nose/facing tick with NO facial features; one body-axis/spine line; short shoulder line and hip line to show body facing; one spine center line ONLY for back-to-camera; tiny ground-contact direction ticks to show front/back direction (not shoes or feet details); single-stroke arms and legs.
- Shot-size adaptation: wide/full shots may show full proxy with head direction, shoulder/hip line, and ground-contact direction ticks; medium shots use head direction, body-axis line, and shoulder line; close-ups/extreme close-ups use only head/shoulder orientation and omit lower body unless the visual_description explicitly asks for it; back-to-camera figures use head oval + spine line + shoulder line.
- Directional mannequin forbidden elements: facial features (eyes, mouth, detailed nose), hair, clothing/costume/outfit of any kind, clothing patterns/materials/folds, collars, sleeves, belts, shoes, accessories, fingers/toes, muscles, body volume, realistic anatomy, shading, gradients, lighting effects.
- NO facial features, NO hair detail, NO hands or fingers, NO shoes, NO feet detail beyond tiny ground-contact direction ticks
- NO clothing of any kind, NO clothing folds, NO costume ornament, NO fabric detail, NO body volume
- NO muscles, NO realistic anatomy, NO shading, NO semi-realistic human forms
- Keep all human figures as minimal directional mannequins only
- NO comic/manga effect lines: no motion lines, speed lines, trembling lines, impact strokes, emphasis rays, or symbolic action marks
- Do not turn an ordinary panel into a poster-like summary collage or a panel-within-panel layout unless the description explicitly demands that visual device

LAYOUT (CRITICAL - MUST BE EXACT):
- EXACTLY {rows} rows × {cols} columns = {total_panels} panels total
- Each row MUST have EXACTLY {cols} panels (no more, no less)
- Each column MUST have EXACTLY {rows} panels (no more, no less)
- ⚠️ Each individual panel MUST be {_panel_ar_hint(ctx.grid.aspect_ratio, rows, cols)}
- Panels numbered left-to-right, top-to-bottom (1, 2, 3... {total_panels})
- ⚠️ ONE CONTINUOUS IMAGE. NO drawn borders, gutters, or dividing lines between regions
- Adjacent regions from different scenes may have natural background transitions
- All {total_panels} panels MUST be EQUAL SIZE and ALIGNED in a perfect grid

⚠️⚠️⚠️ ABSOLUTELY NO TEXT ON IMAGE ⚠️⚠️⚠️
- DO NOT render ANY text, labels, numbers, or captions on the image
- DO NOT add panel numbers (1, 2, 3...) visually on the image
- Scene signage, menus, posters, clocks, screens, and wall notices must use abstract or illegible marks only
- The final image must contain ONLY artwork, ZERO text

{ascii_layout}
"""

        # Panel 描述
        lines = []
        actual_beats = ctx.beats[:total_panels]

        for i, beat in enumerate(actual_beats, start=1):
            visual_desc = beat.get("visual_description", "")
            visual_desc = _resolve_prop_marker_tags(visual_desc)

            # 草图路径：剥离颜色词（颜色由标记系统控制，避免污染调色盘）
            from novelvideo.utils.text_utils import strip_color_words

            visual_desc = strip_color_words(visual_desc)

            # 替换 {{}} 标记为 identity_id（兼容 {{identity_id}} 和 {{角色名}}）
            from novelvideo.utils.identity_resolver import (
                resolve_visual_description_markers,
                build_identity_to_char_map,
            )

            id_to_char = build_identity_to_char_map(ctx.characters)
            visual_desc = resolve_visual_description_markers(
                visual_desc, ctx.characters, id_to_char, use_identity_id=True
            )

            visual_desc = visual_desc.rstrip("。！？，、；：")

            # Sketch 模式：Nanobanana 自主构图（Master Director），不注入导演手册的镜头语言
            panel_desc = visual_desc
            # 默认 sketch 不再注入大段 BLOCKING 约束；仅在 render 模式或 3GS director 修图模式下保留几何约束
            blocking_hints = (
                []
                if ctx.mode == PromptMode.SKETCH
                or rough_gpt_sketch
                or (has_director_scene_refs and has_director_blocking_refs)
                else components.infer_sketch_blocking_hints(
                    beat,
                    has_scene_refs=has_scene_refs,
                    has_director_scene_refs=has_director_scene_refs,
                )
            )

            # 兜底扫描 ctx.characters，替换残余的裸角色名
            if ctx.characters:
                from novelvideo.models import extract_char_identities_from_markers

                char_identities = extract_char_identities_from_markers(
                    beat.get("visual_description", ""), strict=False
                )
                for char_name, char_cfg in ctx.characters.items():
                    if char_name in panel_desc:
                        safe_pattern = r"(?<![{\[])" + re.escape(char_name) + r"(?![_}\]])"
                        if char_name in char_identities:
                            identity_id = char_identities[char_name]
                            if identity_id:
                                tag = _compute_tag(char_name, identity_id=identity_id)
                                panel_desc = re.sub(safe_pattern, tag, panel_desc)
                        else:
                            panel_desc = re.sub(safe_pattern, "", panel_desc)

            # 在 tag 后注入颜色名，强化命名角色可见性
            for tag, color_name in tag_color_map.items():
                if tag in panel_desc:
                    panel_desc = panel_desc.replace(tag, f"{tag} ({color_name})")
            for tag, marker_color in prop_tag_color_map.items():
                if tag in panel_desc:
                    panel_desc = panel_desc.replace(
                        tag,
                        f"{tag} ({marker_color} ONLY; no other colors) [THIS PANEL ONLY]",
                    )
            if blocking_hints:
                panel_desc = f"{panel_desc} | BLOCKING: {' '.join(blocking_hints)}"
            lines.append(f"- **Panel {i}**: {panel_desc}")

        # 填充不足的 panels（使用明确的占位符，避免模型自作主张）
        if len(actual_beats) < total_panels:
            for i in range(len(actual_beats) + 1, total_panels + 1):
                if rough_gpt_sketch:
                    lines.append(
                        f"- **Panel {i}** [BLANK PLACEHOLDER]: A completely blank unused panel. "
                        "Pure white background only. No scenery, no characters, no symbols, no marks, no text."
                    )
                else:
                    lines.append(
                        f"- **Panel {i}** [BLANK PLACEHOLDER]: A completely blank unused panel. "
                        "Pure white background only. No scenery, no characters, no symbols, no marks, no text."
                    )

        shots = "\n".join(lines)

        if has_director_scene_refs and has_director_blocking_refs:
            compact_registry = (
                f"\n\nNEGATIVE CONSTRAINTS:\n{ctx.registry_negative_clause}"
                if ctx.registry_negative_clause
                else ""
            )
            compact_prop_block = prop_block.strip()
            compact_staging_block = staging_block.strip()
            compact_color_law = color_law.strip()
            compact_sections = [
                (
                    f"Convert the attached 3GS director control frame into a {rows}x{cols} "
                    f"production storyboard sketch. Each panel must be {panel_hint}. "
                    "Use the attached image as camera/topology/staging control only, not as pixels to keep."
                ),
                (
                    "OUTPUT STYLE: clean director-control production sketch on light paper. Redraw background as simplified "
                    "black/light-gray line art. Named characters are simple color-coded actor proxies with readable facing cues; named "
                    "props are flat solid marker shapes. No realistic rendering, no blur, no texture, no "
                    "cinematic lighting."
                ),
                (
                    f"LAYOUT: exactly {rows} rows x {cols} columns = {total_panels} panel(s). "
                    "No borders/gutters/panel numbers. No text, captions, labels, readable signage, or watermarks."
                ),
                compact_color_law,
                compact_prop_block,
                compact_staging_block,
                (
                    "CONTROL LOCK: preserve the approved camera intent, crop, horizon/lens distance, actor "
                    "screen regions, prop/staging marker positions, local furniture screen geometry, table edges, "
                    "stools/chairs, counters, doors/windows/openings, and wall/floor relationships. Do not reframe, "
                    "push in, pull out, rotate, pan, zoom, choose a cleaner camera, or invent a new furniture cluster."
                ),
                (
                    "PROJECTION CLEANUP: repair only capture artifacts from 3GS/360: fisheye bending, wide-angle "
                    "stretching, broken seams, warped floors, bowed counters/walls, tilted verticals, and skewed "
                    "door/table lines. Keep the same screen regions, topology, scale, and object order."
                ),
                (
                    "FURNITURE CONTACT: tables/counters/stools/chairs/benches/desks are solid support and occlusion "
                    "objects. A seated mannequin sits on a visible or minimally implied seat beside/behind the "
                    "table edge, never inside a tabletop/counter/bench/table volume. If a 3GS marker intersects "
                    "furniture, treat it as projection/depth error and make the smallest local correction inside "
                    "the same actor screen region."
                ),
                (
                    "ACTORS/PROPS: replace visible mannequins with simple color-coded actor proxies in the same approximate "
                    "screen regions. The final pose/facing/action comes from visual_description. You may make the smallest "
                    "local position/pose adjustment required to make that action readable; do not teleport the actor "
                    "across the room or change the camera. Reuse "
                    "visible global prop markers for held/carried/lifted props only in that prop's listed "
                    "panel(s); do not duplicate them or color visually similar untagged objects "
                    "in the same panel or other panels. Local/episode props and similar "
                    "untagged props are black/gray line art only."
                ),
                (
                    "FACING CUE RULE: keep humans minimal, but make front/back/side facing readable with "
                    "only these cues: oval head plus tiny facing tick, simple capsule/trapezoid torso for full/medium "
                    "shots, shoulder/hip lines, optional spine line only for back-to-camera, and tiny "
                    "ground-contact direction ticks that are not shoes or feet details. "
                    "No facial features, clothing detail, fingers, shoes, realistic anatomy, shading, or rendered body volume."
                ),
                (
                    "STAGING SEMANTICS: draw DIRECTOR STAGING OBJECTS from the user's listed object label and "
                    "visual_description; if the label says horse, draw a horse-like rough storyboard silhouette "
                    "in the same screen position, not an anonymous box. STAGING COLOR BAN: if marker=#RRGGBB "
                    "is listed, use that marker color ONLY to find the colored control shape; the output staging "
                    "object MUST be black/gray line art only. It must NOT have colored fill, colored outline, colored tint, "
                    "or marker-colored pixels. Only named actors and listed-panel global props can be colored. "
                    "The same rule applies to vehicles, sedan chairs, box piles, and "
                    "other labeled staging objects."
                    if director_staging_lines
                    else ""
                ),
                (
                    "SCENE DESCRIPTIONS (do not render this text):\n"
                    f"{shots}"
                    "\n\nFINAL CHECK: all humans remain simple directional mannequins; background is line art; no 3GS pixels; "
                    "no text; no extra named characters; one clear frozen story moment per panel."
                ),
            ]
            return "\n\n".join(section for section in compact_sections if section) + compact_registry

        seamless = components.build_seamless_constraint(total_panels)

        # 构建角色/道具 → 出现 panel 编号映射
        tag_panels: dict[str, list[int]] = {}
        prop_panels: dict[str, list[int]] = {}
        if ctx.characters or prop_label_map:
            from novelvideo.models import extract_char_identities_from_markers

            for i, beat in enumerate(ctx.beats[:total_panels], start=1):
                vd = beat.get("visual_description", "")
                char_ids = extract_char_identities_from_markers(vd, strict=False)
                for char_name, identity_id in char_ids.items():
                    if char_name in ctx.characters:
                        tag = (
                            _compute_tag(char_name, identity_id=identity_id)
                            if identity_id
                            else _compute_tag(char_name)
                        )
                        tag_panels.setdefault(tag, []).append(i)
                for prop_id in components._collect_prop_marker_ids([beat]):
                    prop_tag = components.compute_prop_tag(prop_id)
                    if prop_tag in prop_label_map:
                        prop_panels.setdefault(prop_tag, []).append(i)

        # 计算角色数量用于 checklist
        num_chars = len(char_lines)
        if char_names_for_color_law:
            color_check = (
                f"- {num_chars} colored directional mannequins: {', '.join(char_names_for_color_law)}; "
                "unnamed people are gray directional mannequins"
            )
        else:
            color_check = ""
        if prop_tag_color_map:
            prop_tail = (
                "unrelated staging markers, furniture, visually similar untagged props in the same panel or other panels, and background stay black/gray line art"
                if has_director_scene_refs
                else "episode-local props, visually similar untagged props in the same panel or other panels, furniture, and background stay black/gray line art"
            )
            prop_scope_parts = []
            for tag, color in prop_tag_color_map.items():
                panels = prop_tag_panel_map.get(tag, [])
                panel_text = ", ".join(str(p) for p in panels) or "tagged panels only"
                prop_scope_parts.append(f"{tag} {color} only in panels {panel_text}")
            prop_color_check = (
                f"- {len(prop_tag_color_map)} colored global prop markers: "
                f"{'; '.join(prop_scope_parts)}; "
                "each global prop marker must use its exact listed color only, with no "
                "non-assigned hue or material-color override; "
                f"{prop_tail}"
            )
            color_check = f"{color_check}\n{prop_color_check}" if color_check else prop_color_check

        # 角色出现 panel 对照表
        panel_map_lines = []
        for tag, color_name in tag_color_map.items():
            panels = tag_panels.get(tag, [])
            if panels:
                panel_map_lines.append(
                    f"- {tag} {color_name} must appear in panels: {', '.join(str(p) for p in panels)}"
                )
        for prop_tag, _prop_label in prop_label_map.items():
            panels = prop_panels.get(prop_tag, [])
            if panels:
                color_only = prop_tag_color_map.get(prop_tag, "")
                panel_text = ", ".join(str(p) for p in panels)
                if color_only:
                    panel_map_lines.append(
                        f"- {prop_tag} {color_only} must appear colored ONLY in panels: {panel_text}; "
                        "same/similar untagged objects in the same panel or every other panel must remain black/gray line art"
                    )
                else:
                    panel_map_lines.append(f"- {prop_tag} must appear in panels: {panel_text}")
        panel_map_str = "\n".join(panel_map_lines)

        # 动态取第一个实际 tag 作为 checklist 示例
        example_tag = "[TRY_2ec7]"
        if char_lines:
            import re as _re

            _tag_match = _re.search(r"\[(\w+)\]", char_lines[0])
            if _tag_match:
                example_tag = _tag_match.group(0)

        if has_director_scene_refs and has_director_blocking_refs:
            background_check = (
                "- Background is the chosen 3GS camera translated into simplified line-art sketch\n"
                "- No blurred 3GS pixels, no rendered texture, no cinematic lighting, no screenshot look"
            )
        elif rough_gpt_sketch:
            background_check = (
                "- Background canvas is PURE WHITE\n"
                "- Backgrounds are sparse light-gray context only; characters and action must dominate every panel"
            )
        else:
            background_check = "- Background uses inherited scene geometry when available; otherwise keep it minimal and neutral"
        final_checklist = f"""⚠️ FINAL CHECKLIST:
- ZERO text/labels/numbers on image
- DO NOT draw character tags {example_tag} etc. on the image — these are script references only
- Location tags like [场景名] and time tags like [时间] are for YOUR reference only — NEVER render them as text overlays on the image
- EXACTLY {rows}x{cols} = {total_panels} panels, all EQUAL SIZE
- ONE continuous image, NO borders between panels
{color_check}
{panel_map_str}
- Each panel should read as one clear, coherent visual unit with one dominant viewpoint
- Use split-screen, collage, repeated time slices, or multi-stage action only when explicitly implied by the panel description
- ALL human figures are simple DIRECTIONAL STORYBOARD MANNEQUINS, not realistic people
{background_check}""".strip()

        if has_director_scene_refs and has_director_blocking_refs:
            directing = """DIRECTING GUIDELINES:
This pass translates a 3GS director control frame into a normal production sketch.
- Treat the attached scene reference as a camera/topology control input, not a pixel base.
- Ignore older camera plans, exit-path plans, and door-framing plans. The attached image is the current approved camera.
- Do NOT reconstruct, reframe, push in, pull out, rotate, pan, zoom, crop, or choose a cleaner alternate camera.
- Preserve the original camera intent, lens distance, crop, horizon, rough actor screen regions, foreground scale, prop/staging marker positions, and all local furniture screen geometry.
- Preserve physically readable furniture contact: seated mannequins must sit on a visible or implied seat beside/behind the table edge, never inside a table/counter/bench volume. If a 3GS marker intersects furniture, treat it as projection/depth artifact and make the smallest local correction inside the same screen region.
- Projection cleanup is required: convert 3GS/360 fisheye bending, wide-angle stretching, seam cuts, warped floors, curved walls, bowed counters, and tilted verticals into a coherent hand-drawn perspective. Keep the same screen positions and topology; only repair the projection artifact.
- Doors, windows, thresholds, and walkable openings are topology anchors. Repair their lines, but keep their passable-vs-blocking relationship, side angle, open/closed state, depth cue, and screen region. Do not simplify an oblique doorway into a generic front-facing double door or a decorative window. Keep these as clean construction lines only; no dirt, decay, texture, reflections, or material detail in the sketch.
- Replace visible 3GS mannequins in their current approximate screen regions, but the final pose must obey the panel's visual_description action. Make that action readable from pose, facing direction, feet placement, and prop contact.
- Keep the approved 3GS camera, scene topology, door/window/threshold positions, and local furniture geometry. You may make the smallest local adjustment to a mannequin or held prop when required to show the described action clearly; do not reframe the camera or teleport the actor across the room.
- Collapse multi-step beat text into ONE current production pose around the visible placeholder. Do not draw repeated time slices, ghost figures, future exit silhouettes, or a second copy of the same character.
- Reuse visible global prop marker blocks as the action props only when that prop is tagged/listed for this panel. If a visible listed-panel global prop marker becomes held/carried, transform it into the held prop instead of leaving one copy behind and adding another copy.
- Leave unrelated staging marker blocks visible in their original screen position.
- Redraw the original 3GS environment as simplified sketch line art while preserving the approved camera/topology. Do not keep the blurred rendered background.
- Do not do beautification, cinematic lighting, depth of field, motion blur, rendered texture, or material polish here. Only structural projection cleanup is allowed/required.
- Draw the mannequin physical action from visual_description, including facing direction, feet direction, arms/hands holding/carrying/lifting a prop when the beat says so; listed-panel global props use their assigned prop marker color even when the real object would normally be brown/gray/etc.; local/episode props and similar untagged objects stay black/gray line art.
- Add only minimal beat action detail needed for readability, inside the same screen regions.
- Keep each panel legible as a production-usable storyboard image, not a generic summary poster""".format(
                total_panels=total_panels
            )
        elif rough_gpt_sketch:
            directing = """DIRECTING GUIDELINES:
- Use directing freedom only where the panel description leaves camera/framing unspecified.
- Prioritize the written visual_description over generic shot variety.
- Vary shot size/angle only when it does not override explicit visual_description wording.
- Each panel must still depict ONE single frozen moment.""".format(
                total_panels=total_panels
            )
        elif ctx.mode == PromptMode.SKETCH:
            directing = """DIRECTING GUIDELINES:
- Use directing freedom only where the panel description leaves camera/framing unspecified.
- Prioritize the written visual_description over generic shot variety.
- Vary shot size/angle only when it does not override explicit visual_description wording.
- The scene STYLE ANCHOR (if attached) is not a camera lock; design each panel's camera independently unless the panel description asks for that view.""".format(
                total_panels=total_panels
            )
        else:
            directing = """DIRECTING GUIDELINES:
As the director, you have strong creative freedom over shot size, angle, framing, blocking, and composition across the sequence.
- If a scene reference sketch is provided, all directing freedom must remain consistent with the chosen PRIMARY geometry region for that panel. Do NOT invent a new architectural layout.
- Scene geometry is fixed; character blocking may vary shot-to-shot for storytelling, but must remain locally believable inside that fixed geometry.
- For close or reaction shots, change CAMERA DISTANCE before changing ROOM COMPOSITION. Move closer to the same local action zone instead of rebuilding the room around the subject.
- Vary your shot sizes, angles, and framing to create rhythm across the {total_panels} panels
- Use composition and camera language to maximize emotional impact
- Build visual momentum toward climactic moments
- Maintain spatial continuity when characters stay in the same scene
- Avoid repetitive eye-level medium shots when a more intentional camera choice would sharpen the beat
- When neighboring panels describe one continuous action, make them feel editorially connected through contrast, progression, and staging
- Keep each panel legible as a production-usable storyboard image, not a generic summary poster""".format(
                total_panels=total_panels
            )

        scene_geometry_section = f"\n\n{scene_geometry_block}" if scene_geometry_block else ""
        reference_map_section = ""
        if PromptComponents.collect_scene_image_refs(
            ctx
        ) or PromptComponents.collect_prop_image_refs(ctx):
            scene_prop_only_ctx = replace(
                ctx,
                characters={},
            )
            reference_map_section = "\n\n" + components.build_reference_map(
                scene_prop_only_ctx,
                [],
                include_sketch=False,
                include_face_desc=False,
                include_silhouette=False,
            )
        registry_section = (
            f"\n\n{ctx.registry_negative_clause}" if ctx.registry_negative_clause else ""
        )

        return f"{intro}{reference_map_section}{scene_geometry_section}\n{seamless}\n\n{directing}\n\nSCENE DESCRIPTIONS (for your reference only — do NOT render any of this text on the image):\n{shots}\n\n{final_checklist}{registry_section}"


# =============================================================================
# Action Storyboard 模式
# =============================================================================


class ActionStoryboardStrategy:
    """Action Storyboard 模式：将一段动作描述拆解为 25 格连续分镜序列。

    与普通 SKETCH 模式的区别：
    - 所有 25 个 panel 是同一段动作的**连续分镜序列**（不是不同 beat）
    - 从左到右、从上到下展现动作从起始到结束的完整过程
    """

    def build(self, ctx: PromptContext, components: PromptComponents) -> str:
        rows, cols = ctx.grid.rows, ctx.grid.cols
        total_panels = ctx.grid.total_panels

        ascii_layout = components.build_grid_ascii(rows, cols, ctx.grid.is_portrait_panel)
        panel_hint = (
            _panel_ar_hint(ctx.grid.aspect_ratio, rows, cols)
            if ctx.grid.aspect_ratio
            else "SQUARE (1:1)"
        )

        # 从 beats[0] 中获取 action_description（由调用方注入）
        action_description = ""
        if ctx.beats:
            action_description = ctx.beats[0].get("visual_description", "")

        # 构建角色颜色信息（复用 Sketch 的颜色编码逻辑）
        char_lines = []
        char_names_for_color_law = []
        prop_lines = []
        if ctx.characters:
            from novelvideo.utils.identity_resolver import compute_char_tag as _compute_tag

            for char_name, char_cfg in ctx.characters.items():
                body_desc = components.derive_body_descriptor(char_cfg)

                def _format_color_line(tag, body_desc, color_str):
                    if color_str:
                        parts = color_str.split(" ", 1)
                        hex_code = parts[0]
                        color_name = parts[1] if len(parts) > 1 else parts[0]
                        return f"- {tag} — **{color_name} ({hex_code})** figure. {body_desc}."
                    return f"- {tag} — {body_desc}."

                if char_cfg.identity_appearances:
                    for suffix, details in char_cfg.identity_appearances.items():
                        identity_id = f"{char_name}_{suffix}"
                        tag = _compute_tag(char_name, identity_id=identity_id)
                        color = char_cfg.identity_sketch_colors.get(suffix, char_cfg.sketch_color)
                        char_lines.append(_format_color_line(tag, body_desc, color))
                        char_names_for_color_law.append(tag)
                else:
                    tag = _compute_tag(char_name)
                    color = char_cfg.sketch_color
                    char_lines.append(_format_color_line(tag, body_desc, color))
                    char_names_for_color_law.append(tag)

        color_law = ""
        prop_block = ""
        for prop_id in components._collect_prop_marker_ids(ctx.beats):
            prop_tag = components.compute_prop_tag(prop_id)
            prop_lines.append(
                f"- {prop_tag} — LOCAL / EPISODE PROP \"{prop_id}\". "
                "Draw only as black/gray line art if visible; no color fill."
            )

        colored_targets = char_names_for_color_law
        if colored_targets:
            color_law = f"""⚠️ COLOR LAW (NON-NEGOTIABLE):
ONLY these {len(colored_targets)} named elements receive color fill: {', '.join(colored_targets)}
Every other element is black/gray line art only, NO color fill.

COLOR-CODED CHARACTERS:
{chr(10).join(char_lines)}
"""
        if prop_lines:
            prop_block = (
                "\nLOCAL / EPISODE PROPS (never color-coded in sketch):\n"
                f"{chr(10).join(prop_lines)}\n"
            )

        # 替换 action_description 中的 {{}} 为 tag
        resolved_action = action_description
        if ctx.characters:
            from novelvideo.utils.identity_resolver import (
                resolve_visual_description_markers,
                build_identity_to_char_map,
            )

            id_to_char = build_identity_to_char_map(ctx.characters)
            resolved_action = resolve_visual_description_markers(
                resolved_action, ctx.characters, id_to_char, use_identity_id=True
            )

        prompt = f"""Generate a {rows}x{cols} ACTION STORYBOARD grid. Each panel MUST be {panel_hint}.

⚠️ 100% CANVAS COVERAGE — artwork fills ENTIRE canvas edge-to-edge, NO margins/padding/borders.

!!! MANDATORY GRID FORMAT: {rows} ROWS × {cols} COLUMNS !!!

ROLE: You are a MASTER ACTION CHOREOGRAPHER and storyboard artist.

TASK: Decompose the following action sequence into {total_panels} CONTINUOUS FRAMES arranged in a {rows}x{cols} grid. Read left-to-right, top-to-bottom, panels 1→{total_panels} form a SINGLE continuous action sequence from start to finish.

STYLE: **COLOR-CODED STORYBOARD SKETCH** with a minimal neutral background.
Speed and clarity over artistic quality. Focus on CHARACTER PLACEMENT, POSE, and ACTION FLOW.

{color_law}{prop_block}RENDERING RULES:
- Named characters → SOLID FILL in their assigned color
- Unnamed people → gray outline only, no fill
- Unnamed props/environment → black line art, no fill
- Background → minimal and neutral line treatment only
- Focus on POSE, MOVEMENT, and SPATIAL RELATIONS
- Keep figures simple: basic head, torso, limbs

LAYOUT (CRITICAL):
- EXACTLY {rows} rows × {cols} columns = {total_panels} panels total
- Each panel MUST be {panel_hint}
- Panels read LEFT to RIGHT, TOP to BOTTOM (1→{total_panels})
- ONE CONTINUOUS IMAGE, NO borders between panels
- All {total_panels} panels MUST be EQUAL SIZE

⚠️⚠️⚠️ ABSOLUTELY NO TEXT ON IMAGE ⚠️⚠️⚠️

{ascii_layout}

ACTION SEQUENCE TO DECOMPOSE INTO {total_panels} FRAMES:
{resolved_action}

CHOREOGRAPHY GUIDELINES:
- Panel 1: Starting position / setup
- Panels 2-{total_panels - 1}: Progressive action breakdown — each panel advances the action by one beat
- Panel {total_panels}: Final position / resolution
- Maintain consistent character coloring across ALL panels
- Show clear movement progression — each frame should be visually distinct from the previous
- Vary camera angles to emphasize impact moments
- Key strikes/impacts should get dedicated panels

⚠️ FINAL CHECKLIST:
- ZERO text/labels/numbers on image
- EXACTLY {rows}x{cols} = {total_panels} panels, all EQUAL SIZE
- ONE continuous action from panel 1 to panel {total_panels}
- Background stays minimal and neutral"""

        return prompt


# =============================================================================
# 统一入口
# =============================================================================


class UnifiedPromptBuilder:
    """统一提示词构建器。"""

    def __init__(self, ctx: PromptContext):
        self.ctx = ctx
        self.components = PromptComponents()
        self._strategies = {
            PromptMode.RENDER: RenderModeStrategy(),
            PromptMode.SKETCH: SketchModeStrategy(),
            PromptMode.ACTION_STORYBOARD: ActionStoryboardStrategy(),
        }

    def build(self) -> str:
        """构建完整提示词（根据模式选择策略）。"""
        strategy = self._strategies[self.ctx.mode]
        return strategy.build(self.ctx, self.components)


# =============================================================================
# 辅助函数
# =============================================================================


def _uses_gpt_image_sketch_profile(ctx: PromptContext) -> bool:
    """Whether this sketch should use the rough GPT-image prompt profile."""
    provider = (ctx.image_provider or "").strip().lower()
    model = (ctx.image_model or "").strip().lower()
    if not provider or not model:
        return False
    if provider in {"openai", "huimeng"} and model == "image-2":
        return True
    return provider == "openrouter" and "gpt" in model and "image" in model


def build_qwen_edit_render_prompt(
    beats: List[dict], stage: str = "full"
) -> str:
    """Short, Qwen-Image-Edit-2511-specific render prompt — deliberately NOT
    the shared UnifiedPromptBuilder/RenderModeStrategy output.

    That shared prompt is written for Gemini-family models and uses
    storyboard-grid wording ("!!! MANDATORY GRID FORMAT !!!", "regions",
    "panels") even for a 1x1 render — Qwen-Image-Edit-2511 reads this far
    more literally and was observed (2026-10-13/14) producing an unrelated
    multi-panel collage when given that prompt. This also keeps the
    character's physical description out of the text entirely — per
    Qwen-Image-Edit-2511's own prompt-enhancer guidance, identity should
    come from pointing at the reference image, not from describing features
    in words (verbal descriptions make the model regenerate the face and
    degrade the likeness the image reference would otherwise lock in).

    `stage="full"` (default) is the single-character case: image1 is the
    sketch/crop canvas, image2 is the identity portrait, output keeps the
    pose/framing and swaps in that one person. This is the exact prompt
    verified end-to-end 2026-10-14 for beat 4.

    `stage="scene_only"` is pass 1 of the multi-character render (see
    `_qwen_edit_multi_character_render` in nanobanana_grid.py): turn the
    WHOLE sketch into a photorealistic photograph with no identity
    reference at all, so every figure becomes a generic period-appropriate
    person. Pass 2 then reruns `stage="inpaint"` on the WHOLE pass-1 image
    (not a crop), with `SetLatentNoiseMask` constraining the edit to one
    detected identity's own sketch-color region.

    `stage="inpaint"` is pass 2's prompt. It replaced an earlier
    crop-and-paste design (2026-10-14) that cropped a small region around
    each identity, ran a full `TextEncodeQwenImageEditPlus` call on just
    that crop, and pasted the result back by hand. That crop design failed
    twice in real testing on beat 5 — once with wording that called
    image1 "the mannequin figure" (wrong: a sketch mannequin isn't what's
    in the crop, pass 1 already made it a photo) and once with wording
    that called image1 "a photograph of a person" instead — both times
    the model rendered a small, wrongly-scaled "picture in picture" inset
    instead of replacing the crop in place. The common factor wasn't the
    wording: it was that BOTH input images (the small person-crop and the
    identity portrait) were equally photorealistic, so the model lost
    whatever cue normally tells it which image is the editable canvas and
    which is the reference — collage-like behavior followed in both
    attempts. `stage="inpaint"` avoids this by never building a separate
    crop at all: image1 stays the WHOLE pass-1 photo (matching what the
    model's vision/text conditioning actually sees, consistent with the
    single-character case that works), and `SetLatentNoiseMask` — a
    sampler-level mechanism, not a prompt instruction — is what actually
    restricts which pixels can change. Even if the text below doesn't
    perfectly single out which person to replace, pixels outside the mask
    are mechanically preserved by the sampler, not by the model
    understanding the sentence.

    Two earlier single-pass (no masking at all) attempts to handle
    multi-character beats by naming the sketch's per-character mannequin
    color in the text prompt (e.g. "the magenta-colored mannequin figure")
    both failed in real testing on beat 6 (teacher + Tesla): the model
    kept assigning Tesla's face to the visually-dominant standing teacher,
    and in the second attempt it additionally painted a literal magenta
    T-shirt onto an unrelated student — it read the color as a clothing
    instruction, not a locator. That approach was removed; see CLAUDE.md
    for the two failures.
    """
    beat = beats[0] if beats else {}
    action = re.sub(r"\{\{[^}]*\}\}", "", str(beat.get("visual_description") or "")).strip()
    if stage == "scene_only":
        parts = [
            "Image 1 is the canvas: keep its exact pose, camera framing, and "
            "background composition unchanged. Render every figure in image 1 "
            "as an ordinary, period-appropriate person — do not give any of "
            "them a specific, recognizable identity.",
            "Render the entire result as a photorealistic photograph, not "
            "line art, not a sketch, not an illustration.",
        ]
    elif stage == "inpaint":
        parts = [
            "Image 1 is a photograph with one or more people. Replace one "
            "of the people in image 1 with the person from image 2, "
            "matching that person's exact pose and position, preserving "
            "image 2's identity exactly. Keep every other person, the "
            "background, and the framing of image 1 unchanged.",
            "Keep the result a photorealistic photograph, matching image "
            "1's lighting and style.",
        ]
    else:
        parts = [
            "Image 1 is the canvas: keep its exact pose, camera framing, and "
            "background composition unchanged. Replace the mannequin figure in "
            "image 1 with the person from image 2, preserving their identity "
            "exactly.",
            "Render the entire result as a photorealistic photograph, not "
            "line art, not a sketch, not an illustration.",
        ]
    if action:
        parts.append(f"Scene: {action}")
    return " ".join(parts)


def create_prompt_context(
    mode: PromptMode,
    beats: List[dict],
    rows: int,
    cols: int,
    character_map: Dict[str, dict] = None,
    style: str = None,
    ethnicity: str = "Chinese",
    aspect_ratio: str = None,
    is_portrait_panel: bool = None,
    image_aspect_ratio: str = "",
    panel_detected_keys: Dict[int, set] = None,
    scene_refs: Dict[int, List[Any]] = None,
    prop_asset_refs: Dict[int, List[Any]] = None,
    sketch_colors: Dict[str, str] = None,
    prop_marker_colors: Dict[str, str] = None,
    style_family: str = "",
    animation_subtype: str = "",
    project_dir: str = "",
    image_provider: str = "",
    image_model: str = "",
) -> PromptContext:
    """创建提示词上下文的便捷函数。

    Args:
        mode: 提示词模式
        beats: Beat 数据列表
        rows: 网格行数
        cols: 网格列数
        character_map: 角色映射 {角色名: {...}}
        style: 风格名称
        ethnicity: 种族
        aspect_ratio: 宽高比（可选，自动推断）
        is_portrait_panel: 是否竖屏 panel（可选，自动推断）

    Returns:
        PromptContext 实例
    """
    # 自动推断 aspect_ratio 和 is_portrait_panel
    from novelvideo.generators.nanobanana_grid import REGEN_MODE_CONFIGS, SKETCH_GRID_CONFIG

    # Sketch 模式：使用独立配置
    if mode == PromptMode.SKETCH:
        if aspect_ratio is None:
            aspect_ratio = SKETCH_GRID_CONFIG["aspect_ratio"]
        if is_portrait_panel is None:
            w_ratio, h_ratio = map(int, aspect_ratio.split(":"))
            panel_ar = (w_ratio / cols) / (h_ratio / rows)
            is_portrait_panel = panel_ar < 0.9
    else:
        if aspect_ratio is None:
            # 从 REGEN_MODE_CONFIGS 查找匹配 (rows, cols) 的配置
            for _mk, _cfg in REGEN_MODE_CONFIGS.items():
                if _cfg["rows"] == rows and _cfg["cols"] == cols:
                    aspect_ratio = _cfg["aspect_ratio"]
                    break
            else:
                aspect_ratio = "1:1"

        if is_portrait_panel is None:
            w_ratio, h_ratio = map(int, aspect_ratio.split(":"))
            panel_ar = (w_ratio / cols) / (h_ratio / rows)
            is_portrait_panel = panel_ar < 0.9

    grid_config = GridConfig(
        rows=rows,
        cols=cols,
        aspect_ratio=aspect_ratio,
        image_aspect_ratio=image_aspect_ratio,
        is_portrait_panel=is_portrait_panel,
    )

    # 转换 character_map 为 CharacterConfig
    characters = {}
    if character_map:
        for char_name, info in character_map.items():
            input_mode = info.get("reference_mode", "prompt_only")
            characters[char_name] = CharacterConfig(
                name=char_name,
                face_prompt=info.get("face_prompt", ""),
                base_prompt=info.get("base_prompt", char_name),
                appearance_details=info.get("appearance_details", ""),
                gender=info.get("gender", ""),
                body_type=info.get("body_type", ""),
                reference_path=info.get("reference_path")
                or info.get("portrait_path")
                or info.get("ref_path"),
                reference_mode=input_mode,
                identity_appearances=info.get("identity_appearances", {}),
                sketch_color=info.get("sketch_color", ""),
                identity_sketch_colors=info.get("identity_sketch_colors", {}),
                identity_ref_images=info.get("identity_ref_images", {}),
                identity_face_prompts=info.get("identity_face_prompts", {}),
                identity_body_types=info.get("identity_body_types", {}),
            )

    # 创建风格配置
    style_config = StyleConfig(
        style_name=style or IMAGE_DEFAULT_STYLE,
        project_dir=project_dir,
        style_family=style_family,
        animation_subtype=animation_subtype,
    )

    return PromptContext(
        grid=grid_config,
        characters=characters,
        style=style_config,
        beats=beats,
        mode=mode,
        ethnicity=ethnicity,
        panel_detected_keys=panel_detected_keys,
        scene_refs=scene_refs or {},
        prop_asset_refs=prop_asset_refs or {},
        sketch_colors=sketch_colors or {},
        prop_marker_colors=prop_marker_colors or {},
        image_provider=image_provider,
        image_model=image_model,
    )
