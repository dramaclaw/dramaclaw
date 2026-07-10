"""Generate canonical scene reference images."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Literal

from novelvideo.config import (
    HUIMENGI_API_KEY,
    HUIMENG_IMAGE_MODEL,
    NEWAPI_API_KEY,
    NEWAPI_BASE_URL,
    NEWAPI_IMAGE_MODEL,
    NEWAPI_NANOBANANA2_MODEL,
    OPENAI_API_KEY,
    OPENAI_IMAGE_MODEL,
    OPENROUTER_API_KEY,
    OPENROUTER_GPT_IMAGE2_MODEL,
    SCENE_ASSET_MODEL,
    SCENE_ASSET_PROVIDER,
    SCENE_MASTER_IMAGE_MODEL,
    SCENE_MASTER_IMAGE_PROVIDER,
    SCENE_REVERSE_MASTER_IMAGE_MODEL,
    SCENE_REVERSE_MASTER_IMAGE_PROVIDER,
)
from novelvideo.generators.nanobanana_grid import (
    _call_huimeng_image_api,
    _call_newapi_image_api,
    _call_openai_image_api,
    _call_openrouter_image_api,
)
from novelvideo.director_world.paths import safe_name
from novelvideo.models import NovelScene, build_scene_effective_prompt

SceneReferenceKind = Literal["master", "spatial_layout", "reverse_master"]


def _scene_dir(project_dir: Path, scene_name: str) -> Path:
    return project_dir / "assets" / "scenes" / scene_name


def _archive_existing(path: Path) -> None:
    if not path.exists():
        return
    ts = int(time.time())
    path.replace(path.with_name(f"{path.stem}_{ts}{path.suffix}"))


def _scene_context(scene: NovelScene, base_scene: NovelScene | None = None) -> str:
    scene_type = str(scene.scene_type or "").strip() or "interior"
    variant_prompt = str(getattr(scene, "variant_prompt", "") or "").strip()
    base_scene_id = str(getattr(scene, "base_scene_id", "") or "").strip()
    variant_id = str(getattr(scene, "variant_id", "") or "").strip()
    time_of_day = str(getattr(scene, "time_of_day", "") or "").strip()
    own_prompt = str(
        getattr(scene, "environment_prompt", "")
        or getattr(scene, "description", "")
        or ""
    ).strip()
    base_prompt = ""
    if base_scene is not None:
        base_prompt = str(
            getattr(base_scene, "environment_prompt", "")
            or getattr(base_scene, "description", "")
            or ""
        ).strip()
    if base_scene_id and (variant_prompt or time_of_day):
        description = base_prompt or own_prompt or base_scene_id
    else:
        description = build_scene_effective_prompt(scene, base_scene)
    structured: list[str] = []
    if base_scene_id:
        structured.append(f"BASE SCENE: {base_scene_id}")
    if variant_id:
        structured.append(f"SCENE PLATE VARIANT: {variant_id}")
    if variant_prompt:
        structured.append(f"VARIANT DELTA PROMPT:\n{variant_prompt}")
    if time_of_day:
        structured.append(
            f"""TARGET TIME-OF-DAY PLATE: {time_of_day}
- The generated image is a baked {time_of_day} plate for this scene.
- The overall lighting must read as {time_of_day}; bake the time-of-day into the scene master.
- Keep the same architecture, layout, fixed fixtures, material identity, and camera coverage as the base scene.
- Change only lighting/time atmosphere and the explicitly requested plate state."""
        )
    structured_block = "\n".join(structured).strip()
    return f"""SCENE NAME: {scene.name}
SCENE TYPE: {scene_type}
{structured_block}
SCENE DESCRIPTION:
{description}""".strip()


def _reference_tuple_from_path(path: Path) -> tuple[str, bytes, str] | None:
    if not path.exists() or not path.is_file():
        return None
    suffix = path.suffix.lower()
    mime_type = "image/jpeg" if suffix in {".jpg", ".jpeg"} else "image/png"
    return (path.name, path.read_bytes(), mime_type)


def _spatial_layout_references(
    *,
    project_dir: Path,
    scene_name: str,
) -> list[tuple[str, bytes, str]]:
    master_path = _scene_dir(project_dir, scene_name) / "master.png"
    ref = _reference_tuple_from_path(master_path)
    if ref is None:
        return []
    return [(f"scene_master_{ref[0]}", ref[1], ref[2])]


def _master_references(
    *,
    project_dir: Path,
    scene: NovelScene,
) -> list[tuple[str, bytes, str]]:
    """Refs for derived/time plate master generation: base scene master if present."""

    base_scene_id = str(getattr(scene, "base_scene_id", "") or "").strip()
    if not base_scene_id:
        return []
    base_ref = _reference_tuple_from_path(_scene_dir(project_dir, base_scene_id) / "master.png")
    if base_ref is None:
        return []
    return [(f"base_scene_master_{base_ref[0]}", base_ref[1], base_ref[2])]


def _reverse_master_references(
    *,
    project_dir: Path,
    scene_name: str,
) -> list[tuple[str, bytes, str]]:
    """Refs for reverse_master generation: master ONLY (sole style/identity/lighting anchor).

    Intentionally NOT using spatial_layout: its black-line orthographic style would
    pollute the panorama's visual coherence with master.
    """
    scene_dir = _scene_dir(project_dir, scene_name)
    refs: list[tuple[str, bytes, str]] = []
    master_ref = _reference_tuple_from_path(scene_dir / "master.png")
    if master_ref is not None:
        refs.append((f"scene_master_{master_ref[0]}", master_ref[1], master_ref[2]))
    return refs


def _style_context(
    *,
    style_name: str = "",
    style_prompt: str = "",
    avoid_instructions: str = "",
) -> str:
    style_prompt = str(style_prompt or "").strip()
    avoid_instructions = str(avoid_instructions or "").strip()
    style_name = str(style_name or "").strip()
    if not style_prompt and not avoid_instructions and not style_name:
        return ""

    parts = ["PROJECT STYLE PRESET:"]
    if style_name:
        parts.append(f"- Style id/name: {style_name}")
    if style_prompt:
        parts.append("- Positive style directives:")
        parts.append(style_prompt)
    if avoid_instructions:
        parts.append("- Negative / avoid directives:")
        parts.append(avoid_instructions)
    parts.append("- Apply this style preset consistently to the scene master asset.")
    return "\n".join(parts)


def _master_prompt(
    scene: NovelScene,
    *,
    style_name: str = "",
    style_prompt: str = "",
    avoid_instructions: str = "",
    base_scene: NovelScene | None = None,
) -> str:
    style_block = _style_context(
        style_name=style_name,
        style_prompt=style_prompt,
        avoid_instructions=avoid_instructions,
    )
    scene_block = _scene_context(scene, base_scene)
    purpose_geometry = """- This image is the primary visual master for the stable default scene workflow:
  storyboard sketch, render, and video first-frame production.
- It establishes the real environment identity, material language, color palette,
  lighting mood, and main visible fixtures.
- Spatial coverage convention: master represents the front-facing 180-degree half
  of the scene: front center + roughly half of the left side + roughly half of the right side.
- Advanced/freeform tools may derive other assets from it later, but this image itself
  must remain a clean canonical front-facing wide scene reference."""
    composition_geometry = """- MANDATORY: Show the scene from its canonical FRONT-FACING establishing angle.
- The camera looks straight at the scene's primary entry / main wall / featured backdrop.
- Eye-level horizon. No back view, no rear angle, no aerial, no fisheye, no VR.
- Wide establishing framing with about 160-180 degrees of horizontal coverage:
  front center plus visible left-side half and right-side half.
- The room/street/stage reads as the "default cover shot" a director would pick to introduce this location.
- Keep enough fixed objects visible to reconstruct the space later from this single image."""
    time_of_day = str(getattr(scene, "time_of_day", "") or "").strip()
    variant_id = str(getattr(scene, "variant_id", "") or "").strip()
    if time_of_day:
        time_instruction = f"""- STRUCTURED TIME PLATE OVERRIDE:
  - This scene has time_of_day={time_of_day}. Do NOT neutralize it.
  - Generate the master as the {time_of_day} version of the same physical scene.
  - If a base-scene reference image is attached, preserve its architecture and fixtures while changing lighting to {time_of_day}."""
    elif variant_id:
        time_instruction = f"""- STRUCTURED VARIANT PLATE:
  - This is a state/appearance variant plate (variant_id={variant_id}). The VARIANT DELTA PROMPT is the target change.
  - Follow the delta's lighting, weather, damage, dressing, and atmosphere faithfully — do NOT neutralize them.
  - The delta wins over the base reference for every change it explicitly declares, including structural damage.
  - If a base-scene reference image is attached, use it as the before-state and identity anchor; preserve only the architecture, fixtures, materials, and camera orientation that the delta does not change."""
    else:
        time_instruction = """- IGNORE mood/time-of-day phrases in the text (深夜/昏暗/光晕/街灯/萧瑟/暖色荧光 etc.) when picking lighting;
  use a neutral, eye-level establishing exposure unless the text explicitly says the location IS literally outdoors at night."""
    front_anchor = f"""- ANCHOR THE FRONT WALL FROM THE TEXT:
  - Read the SCENE DESCRIPTION carefully for the keyword "正面" / "front side" / "主面" / "主入口" / "正前方".
  - Whatever the text describes as the FRONT side (正面) IS the wall the camera looks at in this image.
  - If the text says "正面是 X" (e.g. "正面是明档厨房"), then X is the main feature visible across the back of the frame.
  - Do NOT swap front and back: do not put 正面 content behind the camera and 背面 content in front.
  - The text labels "背面" / "后面" describe what is BEHIND the camera and must NOT appear in this image at all.
  - The text labels "左侧" / "右侧" describe side walls/zones visible as partial left/right coverage.
{time_instruction}"""

    return f"""Generate ONE master reference image for this scene.

{scene_block}

{style_block}

PURPOSE:
{purpose_geometry}
{front_anchor}

COMPOSITION:
{composition_geometry}

HARD REQUIREMENTS:
- FRONT-FACING HALF ONLY. Show front center plus left/right half-side coverage.
- Do not output the back side, rear angle, aerial, fisheye, or 360 panorama.
- No people, no characters, no temporary story props.
- Preserve only fixed environment objects: walls, floor, ceiling, doors, windows,
  counters, tables, seats, signs as abstract shapes, shelves, lamps, appliances,
  architectural trim, exterior fixtures.
- Do not add readable text, subtitles, labels, UI, watermarks, panel titles, or diagrams.
- Do not make a collage, floor plan, blueprint, fisheye image, or VR image.
- Output one finished scene reference image only.
""".strip()


def _spatial_layout_prompt(
    scene: NovelScene,
    *,
    has_master_reference: bool = False,
    base_scene: NovelScene | None = None,
) -> str:
    input_block = (
        """INPUT IMAGES:
- The attached image is the scene's canonical front-facing master establishing view.
- It depicts the FRONT-FACING HALF: front center plus roughly half of the left side
  and half of the right side.
- The back-facing half is NOT visible in the master.
- You MUST infer that off-frame back half from the SCENE CONTEXT text below.

INPUT PRIORITIES (this is the geometry contract):
1. Front half + visible side-half fixtures: take directly from the master image.
2. Back half + remaining side zones + entrances + windows + exits + off-frame fixtures:
   take from the SCENE CONTEXT text. Read every positional cue
   (前/后/左/右/back/front/side/通往/出入口/门/窗/玻璃门/街道/巷子/通道/角落).
3. Style/material is irrelevant for this top-down floorplan — only the master's geometry matters.
4. On conflict, the master overrides text only for visible front-half regions; for off-frame
   regions, the text is the only ground truth."""
        if has_master_reference
        else """INPUT:
- No master reference was attached. Do not generate a spatial layout without the scene master."""
    )
    scene_block = _scene_context(scene, base_scene)
    return f"""Create ONE scene-level empty spatial layout reference map.

{input_block}

SCENE CONTEXT:
{scene_block}

PURPOSE:
- This is a director/debug reference map for optional spatial reasoning and hidden
  experimental voxel tools. It is NOT a required input for the default master/reverse
  scene workflow, and 360 panorama generation must not depend on it.
- It must clarify fixed scene geography for the ENTIRE 360 degrees around the camera,
  not just what the master image shows.
- It must clarify fixed scene geography only: walls, doors, windows, entrances, counters,
  work surfaces, furniture groups, seat/standing blocks, aisles, fixed fixtures, and reusable
  prop/action zones.
- For each wall (front / back / left / right), explicitly draw the openings, doors, windows,
  and adjacent fixtures stated in the SCENE CONTEXT, even if not visible in the master.
- Do not create a generic busy version of the location type. Reconstruct only what is visible
  in the master OR explicitly stated in the SCENE CONTEXT text.
- Do not place story characters, identity markers, actor circles, gaze arrows, or beat-specific
  movement paths in this scene-level map. Character blocking belongs in a later episode/beat
  blocking map derived from this empty scene map.
- Do not use screenplay beat text or genre expectations to invent extra furniture not stated
  in the SCENE CONTEXT.

STYLE:
- Clean top-down orthographic floorplan.
- White background, black room outlines, neutral gray tables/chairs/counter/door.
- Use only rectangles, outlines, straight lines, and simple icons for furniture groups,
  seat/standing blocks, counters, work surfaces, doors, windows, shelves, fixtures, and reusable
  action zones.
- Avoid circular dots, head-like circles, torso-like triangles, stick figures, silhouettes, or
  any symbol that could be mistaken for a person.
- Sparse large labels only when needed for reference readability.

LAYOUT REQUIREMENTS:
- Infer one top-down map covering all four cardinal directions around the camera; do not render a panorama, collage, or camera view.
- Camera/viewer convention: the camera sits at the center of the floorplan. The wall at the top
  of the floorplan = FRONT wall (the one visible in the master). The wall at the bottom = BACK wall.
  The wall on the left = LEFT wall. The wall on the right = RIGHT wall.
- Place every named opening/fixture from SCENE CONTEXT on its correct wall using that convention.
- Show fixed object positions and aisle/depth relation between zones.
- Mark reusable zones generically when needed, such as "foreground furniture zone",
  "right-back action zone", "aisle", "door", "counter", or the scene-specific zone ids.
- Do not use character names or identity colors.
- Do not draw seat zones as circles; draw chairs/stools as small rectangles or square blocks.

HARD NEGATIVES:
- No realistic people.
- No people.
- No human silhouettes.
- No head-like circles.
- No body-like icons.
- No stick figures.
- No character markers.
- No colored identity circles.
- No actor labels.
- No gaze arrows.
- No beat-specific movement arrows.
- No perspective camera shot.
- No decorative illustration.
- No collage.
- No dense text.
- No subtitles, UI, watermark, or comic panel titles.
- Do not use this as a story beat; it is a reusable scene spatial contract.
""".strip()


def _reverse_master_prompt(
    scene: NovelScene,
    *,
    style_name: str = "",
    style_prompt: str = "",
    avoid_instructions: str = "",
    has_master_reference: bool = False,
    base_scene: NovelScene | None = None,
) -> str:
    # 有 master 参考图时不注入 PROJECT STYLE PRESET 文本：master 已经按项目风格生成，
    # reverse 直接 match master 的实际像素（STRICT STYLE LOCK 段）。两个风格通道
    # 同时存在会让模型在"项目风格文本"和"master pixels"之间摇摆。
    # 仅在没有 master 参考图（fallback 纯文本驱动）时才需要文字描述项目风格。
    if has_master_reference:
        style_block = (
            "STYLE SOURCE:\n"
            "- The visual style (art style, materials, color palette, lighting, surface "
            "treatment, finish) comes ENTIRELY from REFERENCE 1's pixels — match the master "
            "image exactly. Do NOT re-derive style from any text description; the master is "
            "the only style anchor."
        )
    else:
        style_block = _style_context(
            style_name=style_name,
            style_prompt=style_prompt,
            avoid_instructions=avoid_instructions,
        )
    scene_block = _scene_context(scene, base_scene)

    scene_type = (getattr(scene, "scene_type", "") or "").strip().lower()
    is_exterior = scene_type in {"exterior", "outdoor", "outside", "nature", "street"}
    location_word = "outdoor location" if is_exterior else "interior space"
    space_word = "location" if is_exterior else "room"
    back_word = "back side / opposite side of the location" if is_exterior else "back wall"
    side_word = "flanking environment" if is_exterior else "side walls"

    if has_master_reference:
        input_block = f"""INPUT IMAGE:
- REFERENCE 1 = the scene's FRONT-FACING master establishing view of this {space_word}.
- REFERENCE 1 covers the front-facing half: front center + roughly half of the left side
  + roughly half of the right side. It does NOT show the back-facing half.
- REFERENCE 1 is the SOLE source of truth for art style, materials, color palette,
  linework, texture quality, lighting mood, lighting color temperature, exposure,
  surface treatment, ground/floor finish, and the {space_word}'s overall visual identity.
- The reverse view you generate is the SAME physical {space_word} photographed at the
  SAME MOMENT IN TIME, from the SAME camera position, just yaw-rotated 180 degrees.
- DO NOT copy REFERENCE 1's composition / camera angle / front-center content into the
  output — you are showing what is BEHIND REFERENCE 1's camera, which is NOT visible
  in REFERENCE 1 except for side overlap zones."""
    else:
        input_block = """INPUT:
- No reference attached. Build the scene from the SCENE DESCRIPTION text only."""

    return f"""Generate ONE reverse-angle establishing image of the SAME {location_word}.

This is the reverse view of REFERENCE 1: stand where REFERENCE 1's camera stood, then
yaw-rotate 180 degrees to face the {back_word}. The two views are the SAME {space_word}
at the SAME moment, sharing identical light, identical materials, identical fixtures.

{input_block}

{style_block}

{scene_block}

COMPOSITION:
- Eye-level horizon, wide ~160-180° horizontal coverage matching the master coverage model:
  back center plus roughly half of the left side and half of the right side.
- Camera position = same as REFERENCE 1's camera, facing the {back_word} (the side the
  SCENE DESCRIPTION labels as 背面 / back / 后).
- The {back_word} is the dominant feature filling the central area of the frame.
- The front-facing focal subject of REFERENCE 1 is now BEHIND the camera, so it does not
  need to be in this image. Show the back-facing content instead.
- If the SCENE DESCRIPTION text describes specific items on the back side (e.g. "背面是 X"),
  those items should be the focal content of this image.

REVERSE COVERAGE:
- This reverse view covers the back-facing half of the same scene: back center plus
  the remaining visible halves of the left and right sides.
- Together, master + reverse should describe the full 360-degree space:
  master = front + left-half + right-half; reverse = back + left-half + right-half.
- Mild wide-angle edge distortion is acceptable, but do not create a fisheye or panorama unwrap.

REQUIRED EDGE OVERLAP (HARD RULE):
- The LEFT edge of this reverse view MUST connect to the same physical side-wall / side-environment
  family visible on REFERENCE 1's RIGHT edge (they are the same physical {side_word}
  section seen from opposite directions — same materials, same props, same lighting).
- The RIGHT edge of this reverse view MUST connect to the same physical side-wall /
  side-environment family visible on REFERENCE 1's LEFT edge.
- Treat these overlap zones as material / lighting / fixture alignment anchors. Make them
  visually continuous with master so the two views can be mentally stitched into one space.
- This overlap is NOT optional and NOT decorative — it is what makes the two views
  co-registerable for downstream geometry reconstruction.

CENTER REGION — NEW CONTENT:
- The central region of this reverse shows what is BEHIND master's camera (the {back_word}
  and surrounding back-side environment). This content is NOT visible in REFERENCE 1.
- Fill the center from the SCENE DESCRIPTION's 背面 / back-side notes, while keeping
  master's exact style / lighting / material vocabulary.
- Do NOT invent objects absent from both master and the SCENE DESCRIPTION just to "make
  the reverse different". If the back side has nothing notable, show a quiet open
  back-facing view consistent with master's style.

STRICT STYLE LOCK — REFERENCE 1 IS THE ONLY VISUAL ANCHOR:
- Match REFERENCE 1's art style EXACTLY: same linework density, same texture quality,
  same color palette, same finish.
- Match REFERENCE 1's lighting EXACTLY: same warmth/coolness, same brightness, same
  shadow direction, same exposure, same color temperature. If REFERENCE 1 is warm/amber,
  the reverse MUST be warm/amber too — do NOT drift into cool/blue/dark.
- Match REFERENCE 1's surface materials exactly (wall/floor/ground/ceiling/exterior trim).
  The reverse view is the SAME {space_word}, so the same surface treatment MUST appear
  at the meets of {side_word} and ground.
- Do NOT shift the time of day. If REFERENCE 1 looks like day, reverse must look like day.

IGNORE TEXT DESCRIPTORS THAT WOULD BREAK STYLE LOCK:
- IGNORE any mood / time-of-day descriptors in the SCENE DESCRIPTION (深夜 / 昏暗 / 光晕 /
  街灯 / 萧瑟 / 局促 / 暖色荧光 / 营业 etc.). These are story notes, not visual ground truth.
- The only visual ground truth for lighting & style is REFERENCE 1's pixels.

CLOSED-WORLD CONSTRAINT:
- Fixture identity MUST match REFERENCE 1's vocabulary (if master shows wooden furniture,
  reverse stays with wooden furniture; if master shows urban architecture, reverse stays
  with urban architecture; etc.). Do not invent fixture styles that don't appear anywhere
  in master's visual vocabulary or the SCENE DESCRIPTION.
- Use the SCENE DESCRIPTION ONLY to know what objects/fixtures sit on the back side.
  Do NOT use it to override REFERENCE 1's style or lighting.
- No people, no characters, no temporary story props.
- No readable text, subtitles, labels, watermarks, panel titles.

HARD REQUIREMENTS:
- Eye-level wide rectilinear perspective. Mild edge barrel distortion is
  expected. NO extreme fisheye (>180° FOV), NO equirectangular panorama, NO 360 unwrap,
  NO top-down floorplan, NO collage, NO multi-panel sheet.
- 16:9 aspect ratio (same as REFERENCE 1).
- One single finished establishing image.
""".strip()


def build_scene_reference_prompt(
    kind: SceneReferenceKind,
    scene: NovelScene,
    *,
    style_name: str = "",
    style_prompt: str = "",
    avoid_instructions: str = "",
    has_master_reference: bool = False,
    base_scene: NovelScene | None = None,
) -> str:
    if kind == "master":
        return _master_prompt(
            scene,
            style_name=style_name,
            style_prompt=style_prompt,
            avoid_instructions=avoid_instructions,
            base_scene=base_scene,
        )
    if kind == "spatial_layout":
        return _spatial_layout_prompt(
            scene,
            has_master_reference=has_master_reference,
            base_scene=base_scene,
        )
    if kind == "reverse_master":
        return _reverse_master_prompt(
            scene,
            style_name=style_name,
            style_prompt=style_prompt,
            avoid_instructions=avoid_instructions,
            has_master_reference=has_master_reference,
            base_scene=base_scene,
        )
    raise ValueError(f"Unsupported scene reference kind: {kind}")


def _output_path(project_dir: Path, scene_name: str, kind: SceneReferenceKind) -> Path:
    scene_dir = _scene_dir(project_dir, scene_name)
    if kind == "master":
        return scene_dir / "master.png"
    if kind == "spatial_layout":
        return scene_dir / "spatial_layout.png"
    if kind == "reverse_master":
        return scene_dir / "reverse_master.png"
    raise ValueError(f"Unsupported scene reference kind: {kind}")


def _scene_image_provider(kind: SceneReferenceKind, provider: str | None) -> str:
    if provider:
        return provider.strip().lower()
    if kind == "master" and SCENE_MASTER_IMAGE_PROVIDER:
        return SCENE_MASTER_IMAGE_PROVIDER.strip().lower()
    if kind == "reverse_master" and SCENE_REVERSE_MASTER_IMAGE_PROVIDER:
        return SCENE_REVERSE_MASTER_IMAGE_PROVIDER.strip().lower()
    return (
        (os.environ.get("SCENE_ASSET_PROVIDER") or SCENE_ASSET_PROVIDER or "newapi")
        .strip()
        .lower()
    )


def _scene_image_model(
    kind: SceneReferenceKind,
    provider: str,
    model: str | None,
) -> str:
    if model:
        return model
    if kind == "master" and SCENE_MASTER_IMAGE_MODEL:
        return SCENE_MASTER_IMAGE_MODEL
    if kind == "reverse_master" and SCENE_REVERSE_MASTER_IMAGE_MODEL:
        return SCENE_REVERSE_MASTER_IMAGE_MODEL
    if provider == "newapi":
        if kind in {"master", "reverse_master"}:
            return NEWAPI_NANOBANANA2_MODEL
        return SCENE_ASSET_MODEL or NEWAPI_IMAGE_MODEL
    if provider == "openai":
        return SCENE_ASSET_MODEL or os.environ.get("SCENE_ASSET_OPENAI_MODEL") or OPENAI_IMAGE_MODEL
    if provider in {"huimeng", "huimengi"}:
        return SCENE_ASSET_MODEL or HUIMENG_IMAGE_MODEL
    return (
        SCENE_ASSET_MODEL
        or os.environ.get("SCENE_ASSET_OPENROUTER_MODEL")
        or OPENROUTER_GPT_IMAGE2_MODEL
    )


def resolve_scene_reference_image_model(
    kind: SceneReferenceKind,
    *,
    provider: str | None = None,
    model: str | None = None,
) -> str:
    """Return the model used by canonical scene reference generation."""
    selected_provider = _scene_image_provider(kind, provider)
    return _scene_image_model(kind, selected_provider, model)


def _scene_image_config(model: str) -> dict[str, str]:
    image_config = {
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "output_format": "png",
    }
    if str(model or "").strip().lower() in {"gpt-image-2", "image-2", "image-2-official"}:
        image_config["quality"] = "low"
    return image_config


async def generate_scene_reference_image(
    *,
    project_dir: Path,
    scene: NovelScene,
    kind: SceneReferenceKind,
    provider: str | None = None,
    model: str | None = None,
    style_name: str = "",
    style_prompt: str = "",
    avoid_instructions: str = "",
    base_scene: NovelScene | None = None,
) -> Path:
    """Generate one canonical scene reference image and return its path."""

    project_dir = Path(project_dir)
    output_path = _output_path(project_dir, scene.name, kind)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    references: list[tuple[str, bytes, str]] = []
    has_master_reference = False
    if kind == "spatial_layout":
        references = _spatial_layout_references(
            project_dir=project_dir,
            scene_name=scene.name,
        )
        if not references:
            raise RuntimeError(
                f"场景「{scene.name}」缺少 master 参考图，无法生成 spatial_layout。请先生成 master。"
            )
        has_master_reference = True
    elif kind == "reverse_master":
        references = _reverse_master_references(
            project_dir=project_dir,
            scene_name=scene.name,
        )
        if not references:
            raise RuntimeError(
                f"场景「{scene.name}」缺少 master 参考图，无法生成 reverse_master。"
                "请先生成 master。"
            )
        has_master_reference = True
    elif kind == "master":
        references = _master_references(
            project_dir=project_dir,
            scene=scene,
        )

    prompt = build_scene_reference_prompt(
        kind,
        scene,
        style_name=style_name,
        style_prompt=style_prompt,
        avoid_instructions=avoid_instructions,
        has_master_reference=has_master_reference,
        base_scene=base_scene,
    )
    provider = _scene_image_provider(kind, provider)

    if provider == "openai":
        api_key = OPENAI_API_KEY or ""
        selected_model = _scene_image_model(kind, provider, model)
        image_bytes, _text, error = await _call_openai_image_api(
            api_key=api_key,
            model=selected_model,
            prompt=prompt,
            reference_images=references or None,
            image_config=_scene_image_config(selected_model),
        )
    elif provider == "newapi":
        from novelvideo.config import get_newapi_runtime_credentials

        api_key, base_url = get_newapi_runtime_credentials(
            api_key_override=NEWAPI_API_KEY,
            base_url_override=NEWAPI_BASE_URL,
        )
        selected_model = _scene_image_model(kind, provider, model)
        image_bytes, _text, error = await _call_newapi_image_api(
            api_key=api_key,
            model=selected_model,
            prompt=prompt,
            reference_images=references or None,
            image_config=_scene_image_config(selected_model),
            base_url=base_url,
        )
    elif provider in {"huimeng", "huimengi"}:
        api_key = HUIMENGI_API_KEY or ""
        selected_model = _scene_image_model(kind, provider, model)
        image_bytes, _text, error = await _call_huimeng_image_api(
            api_key=api_key,
            model=selected_model,
            prompt=prompt,
            reference_images=references or None,
            image_config={
                "aspect_ratio": "16:9",
                "image_size": "1K",
                "quality": "low",
                "huimeng_image_quality": "low",
            },
        )
    else:
        api_key = OPENROUTER_API_KEY or ""
        selected_model = _scene_image_model(kind, provider, model)
        image_bytes, _text, error = await _call_openrouter_image_api(
            api_key=api_key,
            model=selected_model,
            prompt=prompt,
            reference_images=[item[1] for item in references] or None,
            image_config={
                "aspect_ratio": "16:9",
                "image_size": "1K",
                "quality": "low",
            },
        )

    if error or not image_bytes:
        raise RuntimeError(error or "Image API returned no image bytes")

    _archive_existing(output_path)
    output_path.write_bytes(image_bytes)
    output_path.with_suffix(".prompt.txt").write_text(prompt, encoding="utf-8")
    return output_path
