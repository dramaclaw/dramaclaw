"""Portrait and identity-image previews, built from the real generator prompt builders."""

from __future__ import annotations

from pathlib import Path

from novelvideo.config import IMAGE_DEFAULT_STYLE, get_style_preset
from novelvideo.prompt_preview.registry import (
    PreviewScope,
    StepSpec,
    empty,
    read_last_sent,
    register,
)
from novelvideo.prompt_preview.types import PreviewTarget, PromptPart, PromptPreview
from novelvideo.task_backend.runners.character_image import _strip_known_style_prefix


def _builder():
    """The prompt builders only need class helpers, not an API-keyed generator."""
    from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

    return object.__new__(NanoBananaCharacterGenerator)


def _style_inputs(scope: PreviewScope) -> tuple[str, str, str, str]:
    style = scope.config.get("visual_style") or IMAGE_DEFAULT_STYLE
    preset = get_style_preset(
        style, project_dir=str(scope.project_dir), state_dir=scope.state_dir or None
    )
    return (
        style,
        preset.get("style_instructions", ""),
        preset.get("avoid_instructions", ""),
        scope.config.get("ethnicity", "Chinese"),
    )


async def _characters(scope: PreviewScope):
    return await scope.store.list_characters()


async def _portrait_targets(scope: PreviewScope) -> list[PreviewTarget]:
    return [PreviewTarget(c.name, c.name) for c in await _characters(scope)]


async def _portrait_build(scope: PreviewScope, target: str) -> PromptPreview:
    character = next((c for c in await _characters(scope) if c.name == target), None)
    if character is None:
        return empty("portraits", "image", f"找不到角色 / Character not found: {target}")
    face_prompt = str(getattr(character, "face_prompt", "") or "").strip()
    audit = scope.project_dir / "prompts" / "characters" / f"{character.name}_portrait.prompt.txt"
    last = read_last_sent(audit)
    if not face_prompt:
        out = empty("portraits", "image", "请先设置面部特征 face_prompt / Set face_prompt first")
        out.target_label, out.last_sent = character.name, last
        return out
    style, style_kw, avoid_kw, ethnicity = _style_inputs(scope)
    builder = _builder()
    tag = builder._generate_character_tag(character.name)
    text = builder._build_character_prompt(
        character_name=character.name,
        character_prompt=_strip_known_style_prefix(face_prompt),
        character_tag=tag,
        style_name=style,
        project_dir=str(scope.project_dir),
        style_keywords=style_kw,
        negative_keywords=avoid_kw,
        state_dir=scope.state_dir,
        ethnicity=ethnicity,
    )
    return PromptPreview(
        step="portraits",
        model_kind="image",
        target_label=character.name,
        parts=[PromptPart("user", "prompt", text)],
        inputs={
            "face_prompt": face_prompt,
            "style": style,
            "ethnicity": ethnicity,
            "character_tag": tag,
        },
        last_sent=last,
    )


def _identity_prompt(scope: PreviewScope, character, identity) -> tuple[str, bool, bool]:
    """Mirror run_character_image._generate_identity_image's choice of identity_prompt."""
    from novelvideo.utils.path_resolver import (
        compute_identity_costume_path,
        compute_identity_portrait_path,
    )

    name = character.name
    costume = compute_identity_costume_path(scope.project_dir, name, identity.identity_name) or str(
        getattr(identity, "costume_image", "") or ""
    )
    portrait = compute_identity_portrait_path(
        scope.project_dir, name, identity.identity_name
    ) or str(getattr(identity, "portrait_image", "") or "")
    has_costume = bool(costume and Path(costume).exists())
    has_portrait = bool(portrait and Path(portrait).exists())
    details = str(identity.appearance_details or "").strip()
    face = str(getattr(identity, "face_prompt", "") or "").strip()
    identity_age = str(getattr(identity, "age_group", "") or "").strip()
    char_age = str(getattr(character, "age_group", "youth") or "youth").strip() or "youth"
    if identity_age and identity_age != char_age:
        if has_portrait:
            text = "" if has_costume else details
        else:
            text = face if has_costume else "\n".join(p for p in [face, details] if p)
    else:
        text = "" if has_costume else details
    return _strip_known_style_prefix(text), has_costume, has_portrait


async def _identity_targets(scope: PreviewScope) -> list[PreviewTarget]:
    targets = []
    for c in await _characters(scope):
        for ident in c.identities or []:
            targets.append(
                PreviewTarget(f"{c.name}::{ident.identity_id}", f"{c.name} / {ident.identity_name}")
            )
    return targets


async def _identity_build(scope: PreviewScope, target: str) -> PromptPreview:
    cname, _, iid = target.partition("::")
    character = next((c for c in await _characters(scope) if c.name == cname), None)
    identity = next(
        (i for i in (character.identities or []) if i.identity_id == iid) if character else [],
        None,
    )
    if character is None or identity is None:
        return empty("identity_images", "image", f"找不到身份 / Identity not found: {target}")
    audit = (
        scope.project_dir
        / "prompts"
        / "characters"
        / f"{character.name}_identity_{identity.identity_name}.prompt.txt"
    )
    last = read_last_sent(audit)
    prompt, has_costume, has_portrait = _identity_prompt(scope, character, identity)
    label = f"{character.name} / {identity.identity_name}"
    if not prompt and not has_costume:
        out = empty("identity_images", "image", "请先设置身份服装描述或上传服装参考图 / Set appearance_details or costume image")
        out.target_label, out.last_sent = label, last
        return out
    style, style_kw, avoid_kw, ethnicity = _style_inputs(scope)
    builder = _builder()
    tag = str(getattr(identity, "character_tag", "") or "") or builder._generate_character_tag(
        character.name
    )
    text = builder._build_identity_locked_prompt(
        character_name=character.name,
        character_prompt=prompt,
        character_tag=tag,
        target_view="front",
        style_name=style,
        project_dir=str(scope.project_dir),
        style_keywords=style_kw,
        negative_keywords=avoid_kw,
        state_dir=scope.state_dir,
        ethnicity=ethnicity,
        has_costume_reference=has_costume,
    )
    return PromptPreview(
        step="identity_images",
        model_kind="image",
        target_label=label,
        parts=[PromptPart("user", "prompt", text)],
        inputs={
            "identity_prompt": prompt,
            "style": style,
            "ethnicity": ethnicity,
            "has_costume_image": has_costume,
            "has_identity_portrait": has_portrait,
        },
        last_sent=last,
    )


register(StepSpec("portraits", "肖像生成 / Portraits", "image",
                  targets_fn=_portrait_targets, build_fn=_portrait_build))
register(StepSpec("identity_images", "身份图生成 / Identity images", "image",
                  targets_fn=_identity_targets, build_fn=_identity_build))
