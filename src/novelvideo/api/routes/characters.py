"""角色列表 & 肖像/身份图生成端点。"""

import io
import logging
import re
import shutil
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, UploadFile, File
from fastapi.responses import JSONResponse

logger = logging.getLogger("novelvideo.api.characters")

from novelvideo.api.asset_metadata import newest_updated_at, tree_updated_at
from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import (
    make_sqlite_store,
    make_sqlite_store_for_context,
    make_static_url_for_context,
    resolve_project_scope,
)
from novelvideo.project_context import ProjectContext
from novelvideo.ports import get_task_backend
from novelvideo.task_identity import project_task_state_key
from novelvideo.api.schemas import (
    AssetImageSourceSelectionRequest,
    PortraitGenRequest,
    CharacterCreate,
    CharacterUpdate,
    CharacterImageSelectionRequest,
    CharacterAssetRestoreRequest,
    IdentityCreate,
    IdentityUpdate,
    IdentityImageGenRequest,
    CharacterVoiceRecordRequest,
    CharacterVoiceTrimRequest,
)
from novelvideo.config import (
    image_generation_selection_options,
    character_image_selection_options,
    get_character_image_selection,
    normalize_image_generation_selection,
    normalize_character_image_selection,
)
from novelvideo.image_request_usage import get_image_usage_summary
from novelvideo.project_config import (
    load_project_config,
    load_project_config_file,
    update_project_config_file,
)
from novelvideo.utils.path_resolver import (
    compute_portrait_path,
    compute_identity_path,
    compute_identity_costume_path,
    compute_identity_portrait_path,
    canonical_portrait_path,
    canonical_identity_path,
    canonical_identity_costume_path,
    canonical_identity_portrait_path,
)
from novelvideo.seedance2_i2v.character_voice_storage import (
    AGE_GROUP_SLOTS as VOICE_AGE_GROUP_SLOTS,
    ALL_SLOTS as VOICE_SAMPLE_SLOTS,
    DEFAULT_SLOT as VOICE_DEFAULT_SLOT,
    clear_character_voice_file,
    decode_recorded_audio_data_url,
    persist_character_voice_file,
    trim_existing_character_voice_file,
)
from novelvideo.sqlite_store import SQLiteStore

router = APIRouter()

CHARACTER_IMAGE_SELECTION_CONFIG_KEY = "character_image_selection"
ASSET_IMAGE_SELECTION_CONFIG_KEYS = {
    "character": CHARACTER_IMAGE_SELECTION_CONFIG_KEY,
    "scene": "scene_image_selection",
    "prop": "prop_image_selection",
}
CHARACTER_IMAGE_USAGE_TASK_TYPES = ("character_portrait", "identity_image")
CHARACTER_ASSET_KINDS = {"portrait", "identity", "identity_costume", "identity_portrait"}

VOICE_SLOT_LABELS = {
    VOICE_DEFAULT_SLOT: "默认（兜底）",
    "child": "幼年",
    "youth": "青年",
    "middle": "中年",
    "elder": "老年",
}


async def _resolve_character_project(
    project: str,
    user: dict,
    *,
    required_role: str = "editor",
) -> tuple[ProjectContext | None, str, str, Path, str, SQLiteStore]:
    resolved = await resolve_project_scope(project, user, required_role=required_role)
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    return (
        resolved.ctx,
        resolved.username,
        resolved.project_name,
        resolved.project_dir,
        resolved.output_dir,
        store,
    )


def _character_image_selection_payload(username: str, project: str) -> dict:
    options = character_image_selection_options()
    config = load_project_config_file(username, project)
    saved_selection = str(config.get(CHARACTER_IMAGE_SELECTION_CONFIG_KEY) or "").strip()
    if saved_selection in options:
        selection = saved_selection
    else:
        selection = normalize_character_image_selection(saved_selection)
        if selection not in options:
            selection = get_character_image_selection()
    return {"character_image_selection": selection, "options": options}


def _asset_image_source_selection_payload(username: str, project: str, asset_kind: str) -> dict:
    options = image_generation_selection_options()
    config_key = ASSET_IMAGE_SELECTION_CONFIG_KEYS[asset_kind]
    if asset_kind == "character":
        selection = _character_image_selection_payload(username, project)["character_image_selection"]
    else:
        saved_selection = str(load_project_config_file(username, project).get(config_key) or "")
        selection = normalize_image_generation_selection(saved_selection)
    return {
        "asset_kind": asset_kind,
        "image_source_selection": selection,
        "options": options,
    }


def _validate_asset_image_source_kind(asset_kind: str) -> str | None:
    normalized = str(asset_kind or "").strip().lower()
    if normalized in ASSET_IMAGE_SELECTION_CONFIG_KEYS:
        return normalized
    return None


def _resolve_character_image_model(username: str, project: str, requested_model: str | None) -> str:
    model = str(requested_model or "").strip()
    if model:
        return model
    return _character_image_selection_payload(username, project)["character_image_selection"]


def _safe_asset_name(name: str) -> str:
    return re.sub(r'[/\\:*?"<>|]', "_", str(name or "").strip()) or "untitled"


def _identity_by_id(character, identity_id: str):
    for identity in character.identities or []:
        if identity.identity_id == identity_id:
            return identity
    return None


def _asset_url(ctx: ProjectContext, project_dir: Path, abs_path: str | Path) -> str:
    path = Path(abs_path)
    if not path.exists():
        return ""
    try:
        rel_path = path.relative_to(project_dir).as_posix()
    except ValueError:
        return ""
    return make_static_url_for_context(ctx, rel_path, local_path=path)


def _backup_character_asset(path: Path) -> Path | None:
    if not path.exists():
        return None
    ts = datetime.now().strftime("%Y%m%d%H%M%S%f")
    backup = path.with_name(f"{path.stem}_{ts}{path.suffix}")
    shutil.copy2(path, backup)
    return backup


def _resolve_character_asset_path(
    *,
    project_dir: Path,
    character,
    kind: str,
    identity_id: str = "",
) -> tuple[Path, object | None]:
    if kind not in CHARACTER_ASSET_KINDS:
        raise ValueError(f"Unsupported character asset kind: {kind}")
    if kind == "portrait":
        return canonical_portrait_path(project_dir, character.name), None

    identity = _identity_by_id(character, identity_id)
    if identity is None:
        raise ValueError(f"Identity '{identity_id}' not found")
    identity_name = getattr(identity, "identity_name", "") or identity_id
    if kind == "identity":
        return canonical_identity_path(project_dir, character.name, identity_name), identity
    if kind == "identity_costume":
        return canonical_identity_costume_path(project_dir, character.name, identity_name), identity
    return canonical_identity_portrait_path(project_dir, character.name, identity_name), identity


def _history_id_for_path(target: Path, path: Path) -> str:
    history_dir = target.parent / "_history"
    try:
        rel = path.relative_to(history_dir)
    except ValueError:
        return path.name
    return f"_history/{rel.as_posix()}"


def _character_asset_history_entries(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    target: Path,
) -> list[dict]:
    entries: list[dict] = []
    if target.parent.exists():
        timestamped = re.compile(
            rf"^{re.escape(target.stem)}_(?P<stamp>\d{{14,20}}){re.escape(target.suffix)}$"
        )
        for path in target.parent.glob(f"{target.stem}_*{target.suffix}"):
            if path.is_file() and timestamped.match(path.name):
                stat = path.stat()
                entries.append(
                    {
                        "history_id": _history_id_for_path(target, path),
                        "filename": path.name,
                        "url": _asset_url(ctx, project_dir, path),
                        "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "bytes": stat.st_size,
                    }
                )

    history_dir = target.parent / "_history"
    if history_dir.exists():
        for path in history_dir.glob(f"{target.name}.*.bak"):
            if not path.is_file():
                continue
            stat = path.stat()
            entries.append(
                {
                    "history_id": _history_id_for_path(target, path),
                    "filename": path.name,
                    "url": _asset_url(ctx, project_dir, path),
                    "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "bytes": stat.st_size,
                }
            )

    entries.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return entries


def _character_asset_history_path(target: Path, history_id: str) -> Path:
    raw = str(history_id or "").strip()
    if not raw:
        raise ValueError("history_id is required")
    if raw.startswith("_history/"):
        name = raw.removeprefix("_history/")
        if "/" in name or "\\" in name:
            raise ValueError("invalid history_id")
        return target.parent / "_history" / name
    if "/" in raw or "\\" in raw:
        raise ValueError("invalid history_id")
    return target.parent / raw


async def _sync_restored_identity_asset(
    store, character_name: str, identity, kind: str, target: Path
):
    if identity is None:
        return
    identity_id = getattr(identity, "identity_id", "")
    if kind == "identity_costume":
        await store.update_character_identity(
            character_name, identity_id, costume_image=str(target)
        )
    elif kind == "identity_portrait":
        await store.update_character_identity(
            character_name, identity_id, portrait_image=str(target)
        )


def _character_asset_links(
    *,
    project: str,
    character_name: str,
    kind: str,
    identity_id: str = "",
) -> dict[str, str]:
    query = {"kind": kind}
    if identity_id:
        query["identity_id"] = identity_id
    base = f"/api/v1/projects/{quote(project, safe='')}/characters/{quote(character_name, safe='')}"
    return {
        "history_url": f"{base}/asset-history?{urlencode(query)}",
        "restore_url": f"{base}/asset-history/restore",
    }


def _voice_slot_metadata(character, slot: str) -> dict[str, str]:
    if slot == VOICE_DEFAULT_SLOT:
        return {
            "path": getattr(character, "reference_audio_path", "") or "",
            "sha256": getattr(character, "reference_audio_sha256", "") or "",
            "updated_at": getattr(character, "reference_audio_updated_at", "") or "",
        }

    samples = getattr(character, "voice_samples_by_age_group", None) or {}
    entry = samples.get(slot) if isinstance(samples, dict) else None
    if not isinstance(entry, dict):
        return {"path": "", "sha256": "", "updated_at": ""}
    return {
        "path": entry.get("path", "") or "",
        "sha256": entry.get("sha256", "") or "",
        "updated_at": entry.get("updated_at", "") or "",
    }


def _voice_slot_update_fields(
    character,
    slot: str,
    *,
    path: str,
    sha256: str,
    updated_at: str,
) -> dict:
    if slot == VOICE_DEFAULT_SLOT:
        return {
            "reference_audio_path": path,
            "reference_audio_sha256": sha256,
            "reference_audio_updated_at": updated_at,
        }

    samples = dict(getattr(character, "voice_samples_by_age_group", None) or {})
    if path:
        samples[slot] = {"path": path, "sha256": sha256, "updated_at": updated_at}
    else:
        samples.pop(slot, None)
    return {"voice_samples_by_age_group": samples}


def _voice_sample_url(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    rel_path: str,
) -> str:
    if not rel_path:
        return ""
    return _asset_url(ctx, project_dir, project_dir / rel_path)


def _voice_slot_payload(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    character,
    slot: str,
) -> dict:
    meta = _voice_slot_metadata(character, slot)
    default_meta = _voice_slot_metadata(character, VOICE_DEFAULT_SLOT)
    path = meta["path"]
    return {
        "slot": slot,
        "label": VOICE_SLOT_LABELS.get(slot, slot),
        "path": path,
        "url": _voice_sample_url(
            ctx=ctx,
            project_dir=project_dir,
            rel_path=path,
        ),
        "sha256": meta["sha256"],
        "updated_at": meta["updated_at"],
        "inherited_from_default": slot != VOICE_DEFAULT_SLOT
        and not path
        and bool(default_meta["path"]),
        "required": slot == VOICE_DEFAULT_SLOT,
    }


def _voice_samples_payload(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    character,
) -> dict:
    return {
        "character": character.name,
        "slots": [
            _voice_slot_payload(
                ctx=ctx,
                project_dir=project_dir,
                character=character,
                slot=slot,
            )
            for slot in (VOICE_DEFAULT_SLOT, *VOICE_AGE_GROUP_SLOTS)
        ],
    }


def _character_voice_fields(ctx: ProjectContext, project_dir: Path, character) -> dict:
    rel_path = getattr(character, "reference_audio_path", "") or ""
    return {
        "reference_audio_path": rel_path,
        "reference_audio_url": _voice_sample_url(
            ctx=ctx,
            project_dir=project_dir,
            rel_path=rel_path,
        ),
        "reference_audio_sha256": getattr(character, "reference_audio_sha256", "") or "",
        "reference_audio_updated_at": getattr(character, "reference_audio_updated_at", "") or "",
        "voice_samples_by_age_group": getattr(character, "voice_samples_by_age_group", {}) or {},
    }


def _identity_voice_fields(ctx: ProjectContext, project_dir: Path, identity) -> dict:
    rel_path = getattr(identity, "reference_audio_path", "") or ""
    return {
        "reference_audio_path": rel_path,
        "reference_audio_url": _voice_sample_url(
            ctx=ctx,
            project_dir=project_dir,
            rel_path=rel_path,
        ),
        "reference_audio_sha256": getattr(identity, "reference_audio_sha256", "") or "",
        "reference_audio_updated_at": getattr(identity, "reference_audio_updated_at", "") or "",
    }


async def _apply_character_voice_update(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    character,
    store: SQLiteStore,
    slot: str,
    path: str,
    sha256: str,
    updated_at: str,
) -> dict:
    fields = _voice_slot_update_fields(
        character,
        slot,
        path=path,
        sha256=sha256,
        updated_at=updated_at,
    )
    await store.update_character(character.name, **fields)
    for key, value in fields.items():
        setattr(character, key, value)
    return _voice_slot_payload(
        ctx=ctx,
        project_dir=project_dir,
        character=character,
        slot=slot,
    )


async def _unset_other_main_characters(store: SQLiteStore, name: str) -> None:
    """Keep the project on the same single narrator-main semantics as NiceGUI."""
    for character in store.get_all_characters():
        if character.name != name and getattr(character, "is_main", False):
            await store.update_character(character.name, is_main=False)


async def _repair_duplicate_main_characters(store: SQLiteStore, characters: list) -> list:
    """Repair legacy data that still has multiple narrator-main characters."""
    seen_main = False
    repaired = []
    for character in characters:
        if not getattr(character, "is_main", False):
            repaired.append(character)
            continue
        if not seen_main:
            seen_main = True
            repaired.append(character)
            continue
        await store.update_character(character.name, is_main=False)
        character.is_main = False
        repaired.append(character)
    return repaired


@router.get("/projects/{project}/characters")
async def list_characters(
    project: str,
    user: dict = Depends(get_api_user),
):
    """获取项目角色列表。"""
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )

    characters = await _repair_duplicate_main_characters(store, store.get_all_characters())

    data = []
    asset_project = getattr(ctx, "project_id", "") or project
    for c in characters:
        abs_portrait = compute_portrait_path(project_dir, c.name)
        item = {
            "name": c.name,
            "aliases": c.aliases if hasattr(c, "aliases") else [],
            "description": c.description if hasattr(c, "description") else "",
            "role": getattr(c, "role", ""),
            "gender": getattr(c, "gender", ""),
            "age_group": getattr(c, "age_group", ""),
            "body_type": getattr(c, "body_type", ""),
            "face_prompt": getattr(c, "face_prompt", ""),
            "is_main": c.is_main if hasattr(c, "is_main") else False,
            "portrait_path": abs_portrait,
            "portrait_url": _asset_url(ctx, project_dir, abs_portrait) if abs_portrait else "",
            "updated_at": newest_updated_at(
                getattr(c, "updated_at", ""),
                tree_updated_at(project_dir / "assets" / "characters" / c.name),
            ),
        }
        item.update(
            _character_asset_links(
                project=asset_project,
                character_name=c.name,
                kind="portrait",
            )
        )
        item.update(_character_voice_fields(ctx, project_dir, c))
        data.append(item)

    return {"ok": True, "data": data}


@router.post("/projects/{project}/characters")
async def add_character(
    project: str,
    body: CharacterCreate,
    user: dict = Depends(get_api_user),
):
    """手动添加单个角色（当自动提取失败时使用）。"""
    logger.info("[%s] add_character: %s (main=%s)", project, body.name, body.is_main)
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )

    from novelvideo.models import NovelCharacter

    # 检查角色是否已存在
    existing = store.get_character(body.name)
    if existing is not None:
        return {"ok": False, "error": f"Character '{body.name}' already exists"}

    if body.is_main:
        await _unset_other_main_characters(store, body.name)

    char = NovelCharacter(
        name=body.name,
        role=body.role,
        is_main=body.is_main,
        gender=body.gender,
        age_group=body.age_group,
        description=body.description,
        face_prompt=body.face_prompt,
    )
    await store.add_character(char)

    return {
        "ok": True,
        "data": char.model_dump(
            include={
                "name",
                "role",
                "is_main",
                "gender",
                "age_group",
                "description",
                "face_prompt",
            }
        ),
    }


@router.post("/projects/{project}/characters/build")
async def build_characters(project: str, user: dict = Depends(get_api_user)):
    """从知识图谱补充缺失角色。"""
    logger.info("[%s] build_characters", project)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    output_dir = resolved.output_dir
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="build_characters",
            queue_kind="default",
            episode=0,
            payload={"output_dir": output_dir},
        )
        return {
            "ok": True,
            "task_type": "build_characters",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("build_characters", ctx.project_id, 0),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": "角色补充任务已进入队列",
        }

    return {"ok": False, "error": "角色补充需要 project context"}


@router.get("/projects/{project}/character-image-selection")
async def get_project_character_image_selection(
    project: str,
    user: dict = Depends(get_api_user),
):
    """获取项目级角色/身份图生成源选择。"""
    _ctx, username, project_name, _project_dir, _output_dir, _store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )
    return {"ok": True, "data": _character_image_selection_payload(username, project_name)}


@router.patch("/projects/{project}/character-image-selection")
async def update_project_character_image_selection(
    project: str,
    body: CharacterImageSelectionRequest,
    user: dict = Depends(get_api_user),
):
    """保存项目级角色/身份图生成源选择。"""
    _ctx, username, project_name, _project_dir, _output_dir, _store = (
        await _resolve_character_project(project, user)
    )
    selection = str(body.character_image_selection or "").strip()
    options = character_image_selection_options()
    if selection not in options:
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "error": f"Invalid character_image_selection: {selection}",
            },
        )

    def _apply(config: dict) -> None:
        config[CHARACTER_IMAGE_SELECTION_CONFIG_KEY] = selection

    update_project_config_file(username, project_name, _apply)
    return {"ok": True, "data": _character_image_selection_payload(username, project_name)}


@router.get("/projects/{project}/image-source-selection/{asset_kind}")
async def get_project_asset_image_source_selection(
    project: str,
    asset_kind: str,
    user: dict = Depends(get_api_user),
):
    """获取项目级素材图源选择。"""
    normalized_kind = _validate_asset_image_source_kind(asset_kind)
    if normalized_kind is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": f"Unsupported image source kind: {asset_kind}"},
        )
    _ctx, username, project_name, _project_dir, _output_dir, _store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )
    return {
        "ok": True,
        "data": _asset_image_source_selection_payload(username, project_name, normalized_kind),
    }


@router.patch("/projects/{project}/image-source-selection/{asset_kind}")
async def update_project_asset_image_source_selection(
    project: str,
    asset_kind: str,
    body: AssetImageSourceSelectionRequest,
    user: dict = Depends(get_api_user),
):
    """保存项目级素材图源选择。"""
    normalized_kind = _validate_asset_image_source_kind(asset_kind)
    if normalized_kind is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": f"Unsupported image source kind: {asset_kind}"},
        )
    _ctx, username, project_name, _project_dir, _output_dir, _store = (
        await _resolve_character_project(project, user)
    )
    selection = str(body.image_source_selection or "").strip()
    options = image_generation_selection_options()
    if selection not in options:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": f"Invalid image_source_selection: {selection}"},
        )
    config_key = ASSET_IMAGE_SELECTION_CONFIG_KEYS[normalized_kind]

    def _apply(config: dict) -> None:
        config[config_key] = selection

    update_project_config_file(username, project_name, _apply)
    return {
        "ok": True,
        "data": _asset_image_source_selection_payload(username, project_name, normalized_kind),
    }


@router.get("/projects/{project}/character-image-usage")
async def get_project_character_image_usage(
    project: str,
    user: dict = Depends(get_api_user),
):
    """获取角色/身份图请求用量统计。"""
    _ctx, _username, _project_name, project_dir, _output_dir, _store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )
    summary = get_image_usage_summary(
        project_output_dir=project_dir,
        task_types=CHARACTER_IMAGE_USAGE_TASK_TYPES,
    )
    return {"ok": True, "data": summary}


@router.get("/projects/{project}/characters/{name}/identities")
async def get_character_identities(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    """获取角色全部身份及图片。"""
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )

    characters = store.get_all_characters()

    target = None
    for c in characters:
        if c.name == name:
            target = c
            break

    if target is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    identities = []
    asset_project = getattr(ctx, "project_id", "") or project
    if hasattr(target, "identities"):
        for ident in target.identities:
            identity_name = ident.identity_name if hasattr(ident, "identity_name") else ""
            abs_image = (
                compute_identity_path(project_dir, target.name, identity_name)
                if identity_name
                else ""
            )
            abs_costume = (
                compute_identity_costume_path(project_dir, target.name, identity_name)
                if identity_name
                else ""
            )
            abs_portrait = (
                compute_identity_portrait_path(project_dir, target.name, identity_name)
                if identity_name
                else ""
            )
            item = {
                "identity_id": ident.identity_id if hasattr(ident, "identity_id") else "",
                "identity_name": identity_name,
                "appearance_details": getattr(ident, "appearance_details", ""),
                "face_prompt": getattr(ident, "face_prompt", ""),
                "age_group": getattr(ident, "age_group", ""),
                "body_type": getattr(ident, "body_type", ""),
                "image_path": abs_image,
                "image_url": _asset_url(ctx, project_dir, abs_image) if abs_image else "",
                "costume_image_path": abs_costume,
                "costume_image_url": (
                    _asset_url(ctx, project_dir, abs_costume) if abs_costume else ""
                ),
                "portrait_image_path": abs_portrait,
                "portrait_image_url": (
                    _asset_url(ctx, project_dir, abs_portrait) if abs_portrait else ""
                ),
                "updated_at": newest_updated_at(
                    getattr(ident, "updated_at", ""),
                    getattr(target, "updated_at", ""),
                    tree_updated_at(abs_image),
                    tree_updated_at(abs_costume),
                    tree_updated_at(abs_portrait),
                ),
            }
            item.update(
                _character_asset_links(
                    project=asset_project,
                    character_name=target.name,
                    kind="identity",
                    identity_id=getattr(ident, "identity_id", ""),
                )
            )
            item["costume_history_url"] = _character_asset_links(
                project=asset_project,
                character_name=target.name,
                kind="identity_costume",
                identity_id=getattr(ident, "identity_id", ""),
            )["history_url"]
            item["portrait_history_url"] = _character_asset_links(
                project=asset_project,
                character_name=target.name,
                kind="identity_portrait",
                identity_id=getattr(ident, "identity_id", ""),
            )["history_url"]
            item.update(_identity_voice_fields(ctx, project_dir, ident))
            identities.append(item)

    return {"ok": True, "data": identities}


@router.get("/projects/{project}/characters/{name}/asset-history")
async def list_character_asset_history(
    project: str,
    name: str,
    kind: str,
    identity_id: str = "",
    user: dict = Depends(get_api_user),
):
    """列出角色资产的历史备份，用于 UI 回看和恢复。"""
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    try:
        target, _identity = _resolve_character_asset_path(
            project_dir=project_dir,
            character=character,
            kind=kind,
            identity_id=identity_id,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "data": {
            "kind": kind,
            "identity_id": identity_id,
            "current_url": _asset_url(ctx, project_dir, target),
            "entries": _character_asset_history_entries(
                ctx=ctx,
                project_dir=project_dir,
                target=target,
            ),
        },
    }


@router.post("/projects/{project}/characters/{name}/asset-history/restore")
async def restore_character_asset_history(
    project: str,
    name: str,
    body: CharacterAssetRestoreRequest,
    user: dict = Depends(get_api_user),
):
    """把某个历史备份恢复到角色资产 canonical 槽位。"""
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    kind = str(getattr(body, "kind", "") or "").strip()
    identity_id = str(getattr(body, "identity_id", "") or "").strip()
    history_id = str(getattr(body, "history_id", "") or "").strip()
    try:
        target, identity = _resolve_character_asset_path(
            project_dir=project_dir,
            character=character,
            kind=kind,
            identity_id=identity_id,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    entries = _character_asset_history_entries(ctx=ctx, project_dir=project_dir, target=target)
    allowed_ids = {str(entry.get("history_id") or "") for entry in entries}
    if history_id not in allowed_ids:
        return {"ok": False, "error": "History asset not found"}

    try:
        source = _character_asset_history_path(target, history_id)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if not source.exists() or not source.is_file():
        return {"ok": False, "error": "History asset not found"}

    target.parent.mkdir(parents=True, exist_ok=True)
    backup = _backup_character_asset(target)
    shutil.copy2(source, target)
    await _sync_restored_identity_asset(store, name, identity, kind, target)

    return {
        "ok": True,
        "data": {
            "kind": kind,
            "identity_id": identity_id,
            "restored": True,
            "url": _asset_url(ctx, project_dir, target),
            "backup_history_id": backup.name if backup else "",
        },
    }


@router.patch("/projects/{project}/characters/{name}")
async def update_character(
    project: str,
    name: str,
    body: CharacterUpdate,
    user: dict = Depends(get_api_user),
):
    """编辑角色基本信息。"""
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    updates = body.model_dump(exclude_none=True)
    requested_name = None
    if "name" in updates:
        requested_name = str(updates.pop("name") or "").strip()
        if not requested_name:
            return {"ok": False, "error": "Character name cannot be empty"}

    updated_fields: list[str] = []
    renamed_from = None
    target_name = name

    if requested_name and requested_name != name:
        if store.get_character(requested_name) is not None:
            return {"ok": False, "error": f"Character '{requested_name}' already exists"}
        try:
            await store.rename_character(name, requested_name)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        target_name = requested_name
        renamed_from = name
        updated_fields.append("name")

    if not updates and not updated_fields:
        return {"ok": True, "data": {"message": "No fields to update"}}

    if updates.get("is_main") is True:
        await _unset_other_main_characters(store, target_name)

    if updates:
        await store.update_character(target_name, **updates)
        updated_fields.extend(updates.keys())

    data = {"name": target_name, "updated_fields": updated_fields}
    if renamed_from:
        data["renamed_from"] = renamed_from
    return {"ok": True, "data": data}


@router.post("/projects/{project}/characters/{name}/delete")
async def delete_character(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    """删除角色。POST 保持与 React active UI 的兼容契约。"""
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    await store.delete_character(name)
    return {"ok": True, "data": {"name": name, "deleted": True}}


@router.get("/projects/{project}/characters/{name}/voice-samples")
async def list_character_voice_samples(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    """获取角色 IndexTTS2 声线样本插槽。"""
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    return {
        "ok": True,
        "data": _voice_samples_payload(
            ctx=ctx,
            project_dir=project_dir,
            character=character,
        ),
    }


@router.post("/projects/{project}/characters/{name}/voice-samples/{slot}/upload")
async def upload_character_voice_sample(
    project: str,
    name: str,
    slot: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """上传角色 IndexTTS2 声线样本。"""
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    if slot not in VOICE_SAMPLE_SLOTS:
        return {"ok": False, "error": f"Unsupported voice slot: {slot}"}

    filename = file.filename or ""
    content = await file.read()
    try:
        rel_path, sha256, updated_at = persist_character_voice_file(
            project_dir=project_dir,
            character_name=name,
            slot=slot,
            filename=filename,
            content=content,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "data": await _apply_character_voice_update(
            ctx=ctx,
            project_dir=project_dir,
            character=character,
            store=store,
            slot=slot,
            path=rel_path,
            sha256=sha256,
            updated_at=updated_at,
        ),
    }


@router.post("/projects/{project}/characters/{name}/voice-samples/{slot}/record")
async def record_character_voice_sample(
    project: str,
    name: str,
    slot: str,
    body: CharacterVoiceRecordRequest,
    user: dict = Depends(get_api_user),
):
    """保存浏览器录音为角色 IndexTTS2 声线样本。"""
    ctx, username, project_name, project_dir, _output_dir, store = await _resolve_character_project(
        project, user
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    if slot not in VOICE_SAMPLE_SLOTS:
        return {"ok": False, "error": f"Unsupported voice slot: {slot}"}

    try:
        content, extension = decode_recorded_audio_data_url(body.data_url)
        rel_path, sha256, updated_at = persist_character_voice_file(
            project_dir=project_dir,
            character_name=name,
            slot=slot,
            filename=f"recorded{extension}",
            content=content,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "data": await _apply_character_voice_update(
            ctx=ctx,
            project_dir=project_dir,
            character=character,
            store=store,
            slot=slot,
            path=rel_path,
            sha256=sha256,
            updated_at=updated_at,
        ),
    }


@router.post("/projects/{project}/characters/{name}/voice-samples/{slot}/trim")
async def trim_character_voice_sample(
    project: str,
    name: str,
    slot: str,
    body: CharacterVoiceTrimRequest,
    user: dict = Depends(get_api_user),
):
    """裁剪角色 IndexTTS2 声线样本并写回同一插槽。"""
    ctx, username, project_name, project_dir, _output_dir, store = await _resolve_character_project(
        project, user
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    if slot not in VOICE_SAMPLE_SLOTS:
        return {"ok": False, "error": f"Unsupported voice slot: {slot}"}

    try:
        rel_path, sha256, updated_at = trim_existing_character_voice_file(
            project_dir=project_dir,
            character_name=name,
            slot=slot,
            source_path=body.source_path,
            start_seconds=body.start_seconds,
            duration_seconds=body.duration_seconds,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "data": await _apply_character_voice_update(
            ctx=ctx,
            project_dir=project_dir,
            character=character,
            store=store,
            slot=slot,
            path=rel_path,
            sha256=sha256,
            updated_at=updated_at,
        ),
    }


@router.post("/projects/{project}/characters/{name}/voice-samples/{slot}/delete")
async def delete_character_voice_sample(
    project: str,
    name: str,
    slot: str,
    user: dict = Depends(get_api_user),
):
    """清除角色 IndexTTS2 声线样本。"""
    ctx, username, project_name, project_dir, _output_dir, store = await _resolve_character_project(
        project, user
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    if slot not in VOICE_SAMPLE_SLOTS:
        return {"ok": False, "error": f"Unsupported voice slot: {slot}"}

    clear_character_voice_file(
        project_dir=project_dir,
        character_name=name,
        slot=slot,
    )
    return {
        "ok": True,
        "data": await _apply_character_voice_update(
            ctx=ctx,
            project_dir=project_dir,
            character=character,
            store=store,
            slot=slot,
            path="",
            sha256="",
            updated_at="",
        ),
    }


@router.post("/projects/{project}/characters/{name}/identities")
async def add_identity(
    project: str,
    name: str,
    body: IdentityCreate,
    user: dict = Depends(get_api_user),
):
    """为角色新增一个身份。"""
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    from novelvideo.models import CharacterIdentity

    identity_id = f"{name}_{body.identity_name}"
    identity = CharacterIdentity(
        identity_id=identity_id,
        character_name=name,
        identity_name=body.identity_name,
        age_group=body.age_group,
        appearance_details=body.appearance_details,
        source="api",
    )

    await store.add_character_identity(name, identity)

    return {
        "ok": True,
        "data": {
            "identity_id": identity_id,
            "identity_name": body.identity_name,
            "age_group": body.age_group,
            "appearance_details": body.appearance_details,
        },
    }


@router.patch("/projects/{project}/characters/{name}/identities/{identity_id}")
async def update_identity(
    project: str,
    name: str,
    identity_id: str,
    body: IdentityUpdate,
    user: dict = Depends(get_api_user),
):
    """编辑角色身份属性。"""
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"ok": True, "data": {"message": "No fields to update"}}

    await store.update_character_identity(name, identity_id, **updates)

    return {
        "ok": True,
        "data": {"identity_id": identity_id, "updated_fields": list(updates.keys())},
    }


@router.delete("/projects/{project}/characters/{name}/identities/{identity_id}")
async def delete_identity(
    project: str,
    name: str,
    identity_id: str,
    user: dict = Depends(get_api_user),
):
    """删除角色身份。"""
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    await store.delete_character_identity(name, identity_id)

    return {"ok": True, "data": {"identity_id": identity_id, "message": "身份已删除"}}


@router.post("/projects/{project}/characters/{name}/portrait-async")
async def generate_single_portrait_async(
    project: str,
    name: str,
    body: PortraitGenRequest = PortraitGenRequest(),
    user: dict = Depends(get_api_user),
):
    """启动单角色 Portrait 后台任务。"""
    ctx, username, project_name, project_dir, _output_dir, _store = (
        await _resolve_character_project(project, user)
    )

    config = load_project_config(username, project_name)
    scope = f"character:{name}:portrait"
    style = body.style or config.get("visual_style", "chinese_period_drama")
    model = _resolve_character_image_model(username, project_name, body.model)
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="character_portrait",
            queue_kind="default",
            episode=0,
            scope=scope,
            payload={
                "mode": "portrait",
                "task_type": "character_portrait",
                "character_name": name,
                "style": style,
                "model": model,
                "scope": scope,
                "output_dir": str(project_dir),
            },
        )
        return {
            "ok": True,
            "task_type": "character_portrait",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "character_portrait", ctx.project_id, 0, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"肖像生成任务已进入队列: {name}",
        }

    return {"ok": False, "error": "肖像生成需要 project context"}


@router.post("/projects/{project}/characters/{name}/portrait")
async def generate_single_portrait(
    project: str,
    name: str,
    body: PortraitGenRequest,
    user: dict = Depends(get_api_user),
):
    """为单个角色生成肖像（face close-up）。"""
    logger.info("[%s] generate_single_portrait: %s, model=%s", project, name, body.model)
    ctx, username, project_name, project_dir, output_dir, store = await _resolve_character_project(
        project, user
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    proj_config = load_project_config(username, project_name)
    style = body.style or proj_config.get("visual_style", "chinese_period_drama")

    from novelvideo.generators.image_generator import generate_character_reference_unified

    # 备份旧肖像
    portrait_path = compute_portrait_path(project_dir, name)
    if portrait_path and Path(portrait_path).exists():
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = Path(portrait_path).with_name(f"portrait_{ts}.png")
        shutil.copy(portrait_path, backup)

    paths = await generate_character_reference_unified(
        character_name=name,
        appearance_prompt=character.face_prompt if hasattr(character, "face_prompt") else "",
        style=style,
        ethnicity=body.ethnicity,
        model=_resolve_character_image_model(username, project_name, body.model),
        output_dir=output_dir,
        project_dir=str(project_dir),
    )

    if not paths:
        return {"ok": False, "error": "Portrait generation failed"}

    # 复制为标准肖像路径
    char_dir = project_dir / "assets" / "characters" / name
    char_dir.mkdir(parents=True, exist_ok=True)
    final_path = char_dir / "portrait.png"
    shutil.copy(paths[0], final_path)

    portrait_url = _asset_url(ctx, project_dir, final_path)

    return {"ok": True, "data": {"portrait_url": portrait_url}}


@router.post("/projects/{project}/characters/{name}/portrait/upload")
async def upload_portrait(
    project: str,
    name: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """上传角色肖像图片。"""
    logger.info("[%s] upload_portrait: %s", project, name)
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    from PIL import Image

    content = await file.read()
    img = Image.open(io.BytesIO(content)).convert("RGB")

    char_dir = project_dir / "assets" / "characters" / name
    char_dir.mkdir(parents=True, exist_ok=True)

    # 备份旧肖像
    portrait_path = char_dir / "portrait.png"
    if portrait_path.exists():
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = char_dir / f"portrait_{ts}.png"
        shutil.copy(portrait_path, backup)

    img.save(str(portrait_path), format="PNG")

    portrait_url = _asset_url(ctx, project_dir, portrait_path)

    return {"ok": True, "data": {"portrait_url": portrait_url}}


@router.post("/projects/{project}/characters/{name}/identities/{identity_name}/upload")
async def upload_identity_image(
    project: str,
    name: str,
    identity_name: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    """上传角色身份图片。"""
    logger.info("[%s] upload_identity_image: %s/%s", project, name, identity_name)
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    from PIL import Image

    content = await file.read()
    img = Image.open(io.BytesIO(content)).convert("RGB")

    identities_dir = project_dir / "assets" / "characters" / name / "identities"
    identities_dir.mkdir(parents=True, exist_ok=True)

    img_path = identities_dir / f"{identity_name}.png"
    _backup_character_asset(img_path)
    img.save(str(img_path), format="PNG")

    image_url = _asset_url(ctx, project_dir, img_path)

    return {"ok": True, "data": {"image_url": image_url}}


@router.post("/projects/{project}/characters/{name}/identities/{identity_id}/image/delete")
async def delete_identity_image(
    project: str,
    name: str,
    identity_id: str,
    user: dict = Depends(get_api_user),
):
    _ctx, _username, _project_name, _project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    deleted = await store.delete_identity_image(name, identity_id)
    return {"ok": True, "data": {"deleted": deleted}}


@router.post("/projects/{project}/characters/{name}/identities/{identity_id}/costume/upload")
async def upload_identity_costume(
    project: str,
    name: str,
    identity_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    identity = _identity_by_id(character, identity_id)
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}

    from PIL import Image

    content = await file.read()
    img = Image.open(io.BytesIO(content)).convert("RGB")
    safe_name = _safe_asset_name(identity.identity_name)
    identities_dir = project_dir / "assets" / "characters" / name / "identities"
    identities_dir.mkdir(parents=True, exist_ok=True)
    target = identities_dir / f"{safe_name}_costume.png"
    if target.exists():
        backup = identities_dir / f"{safe_name}_costume_{datetime.now():%Y%m%d%H%M%S}.png"
        shutil.copy(target, backup)
    img.save(str(target), format="PNG")
    await store.update_character_identity(name, identity_id, costume_image=str(target))
    return {
        "ok": True,
        "data": {"costume_image_url": _asset_url(ctx, project_dir, target)},
    }


@router.post("/projects/{project}/characters/{name}/identities/{identity_id}/costume/delete")
async def delete_identity_costume(
    project: str,
    name: str,
    identity_id: str,
    user: dict = Depends(get_api_user),
):
    ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    identity = _identity_by_id(character, identity_id)
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}

    candidate_paths: list[Path] = []
    computed = compute_identity_costume_path(project_dir, name, identity.identity_name)
    if computed:
        candidate_paths.append(Path(computed))
    saved = str(getattr(identity, "costume_image", "") or "").strip()
    if saved:
        candidate_paths.append(Path(saved))

    deleted = False
    seen: set[Path] = set()
    for path in candidate_paths:
        if path in seen:
            continue
        seen.add(path)
        if path.exists():
            path.unlink()
            deleted = True

    await store.update_character_identity(name, identity_id, costume_image="")
    if hasattr(identity, "costume_image"):
        setattr(identity, "costume_image", "")
    return {"ok": True, "data": {"deleted": deleted}}


@router.post("/projects/{project}/characters/{name}/identities/{identity_id}/portrait/upload")
async def upload_identity_portrait(
    project: str,
    name: str,
    identity_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    identity = _identity_by_id(character, identity_id)
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}

    from PIL import Image

    content = await file.read()
    img = Image.open(io.BytesIO(content)).convert("RGB")
    safe_name = _safe_asset_name(identity.identity_name)
    identities_dir = project_dir / "assets" / "characters" / name / "identities"
    identities_dir.mkdir(parents=True, exist_ok=True)
    target = identities_dir / f"{name}_{safe_name}_portrait.png"
    if target.exists():
        backup = identities_dir / f"{name}_{safe_name}_portrait_{datetime.now():%Y%m%d%H%M%S}.png"
        shutil.copy(target, backup)
    img.save(str(target), format="PNG")
    await store.update_character_identity(name, identity_id, portrait_image=str(target))
    return {
        "ok": True,
        "data": {"portrait_image_url": _asset_url(ctx, project_dir, target)},
    }


@router.post(
    "/projects/{project}/characters/{name}/identities/{identity_id}/portrait/generate-async"
)
async def generate_identity_portrait_async(
    project: str,
    name: str,
    identity_id: str,
    body: IdentityImageGenRequest = IdentityImageGenRequest(),
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = await _resolve_character_project(
        project, user
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    identity = _identity_by_id(character, identity_id)
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}

    config = load_project_config(username, project_name)
    scope = f"character:{name}:identity_portrait:{identity.identity_name}"
    style = body.style or config.get("visual_style", "chinese_period_drama")
    model = _resolve_character_image_model(username, project_name, body.model)
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="character_portrait",
            queue_kind="default",
            episode=0,
            scope=scope,
            payload={
                "mode": "identity_portrait",
                "task_type": "character_portrait",
                "character_name": name,
                "identity_id": identity_id,
                "identity_name": identity.identity_name,
                "style": style,
                "model": model,
                "scope": scope,
                "output_dir": str(project_dir),
            },
        )
        return {
            "ok": True,
            "task_type": "character_portrait",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "character_portrait", ctx.project_id, 0, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"身份 Portrait 生成任务已进入队列: {identity.identity_name}",
        }

    return {"ok": False, "error": "身份 Portrait 生成需要 project context"}


@router.post("/projects/{project}/characters/{name}/identities/{identity_id}/portrait/generate")
async def generate_identity_portrait(
    project: str,
    name: str,
    identity_id: str,
    body: IdentityImageGenRequest = IdentityImageGenRequest(),
    user: dict = Depends(get_api_user),
):
    """同步生成身份级 portrait，供旧调用保留。新 UI 应优先使用 async。"""
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    identity = _identity_by_id(character, identity_id)
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}
    if not getattr(identity, "face_prompt", ""):
        return {"ok": False, "error": "该身份无 face_prompt，无需独立 Portrait"}

    from novelvideo.generators import generate_character_reference_unified

    config = load_project_config(username, project_name)
    safe_name = _safe_asset_name(identity.identity_name)
    identities_dir = project_dir / "assets" / "characters" / name / "identities"
    identities_dir.mkdir(parents=True, exist_ok=True)
    target = identities_dir / f"{name}_{safe_name}_portrait.png"
    tmp_dir = identities_dir / f".tmp_identity_portrait_{datetime.now():%Y%m%d%H%M%S%f}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        paths = await generate_character_reference_unified(
            character_name=name,
            appearance_prompt=str(identity.face_prompt).strip(),
            output_dir=str(tmp_dir),
            count=1,
            use_mock=False,
            style=body.style or config.get("visual_style", "chinese_period_drama"),
            ethnicity=config.get("ethnicity", "Chinese"),
            model=_resolve_character_image_model(username, project_name, body.model),
            project_dir=str(project_dir),
            usage_task_type="character_portrait",
            usage_scope=f"character:{name}:identity_portrait:{identity.identity_name}",
            identity_name=identity.identity_name,
        )
        if not paths:
            return {"ok": False, "error": "身份 Portrait 生成失败"}
        if target.exists():
            backup = (
                identities_dir / f"{name}_{safe_name}_portrait_{datetime.now():%Y%m%d%H%M%S}.png"
            )
            shutil.copy(target, backup)
        shutil.copy(paths[0], target)
        await store.update_character_identity(name, identity_id, portrait_image=str(target))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        "ok": True,
        "data": {"portrait_image_url": _asset_url(ctx, project_dir, target)},
    }


@router.post("/projects/{project}/characters/{name}/identities/{identity_id}/generate-async")
async def generate_identity_image_async(
    project: str,
    name: str,
    identity_id: str,
    body: IdentityImageGenRequest = IdentityImageGenRequest(),
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user)
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    identity = _identity_by_id(character, identity_id)
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}

    config = load_project_config(username, project_name)
    scope = f"character:{name}:identity:{identity.identity_name}"
    style = body.style or config.get("visual_style", "chinese_period_drama")
    model = _resolve_character_image_model(username, project_name, body.model)
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="identity_image",
            queue_kind="default",
            episode=0,
            scope=scope,
            payload={
                "mode": "identity_image",
                "task_type": "identity_image",
                "character_name": name,
                "identity_id": identity_id,
                "identity_name": identity.identity_name,
                "style": style,
                "model": model,
                "scope": scope,
                "output_dir": str(project_dir),
            },
        )
        return {
            "ok": True,
            "task_type": "identity_image",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("identity_image", ctx.project_id, 0, scope=scope),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"身份图生成任务已进入队列: {identity.identity_name}",
        }

    return {"ok": False, "error": "身份图生成需要 project context"}


@router.get("/projects/{project}/characters/{name}/identities/{identity_id}/attempts")
async def get_identity_attempts(
    project: str,
    name: str,
    identity_id: str,
    user: dict = Depends(get_api_user),
):
    _ctx, _username, _project_name, project_dir, _output_dir, store = (
        await _resolve_character_project(project, user, required_role="viewer")
    )
    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}
    identity = _identity_by_id(character, identity_id)
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}
    safe_name = _safe_asset_name(identity.identity_name)
    identities_dir = project_dir / "assets" / "characters" / name / "identities"
    image_attempts = len(
        [
            p
            for p in identities_dir.glob(f"{safe_name}*.png")
            if not p.name.endswith("_costume.png") and "_portrait" not in p.stem
        ]
    )
    portrait_attempts = len(list(identities_dir.glob(f"*{safe_name}_portrait*.png")))
    return {
        "ok": True,
        "data": {
            "image_attempts": image_attempts,
            "portrait_attempts": portrait_attempts,
        },
    }


@router.post("/projects/{project}/characters/{name}/identities/{identity_id}/generate")
async def generate_identity_image(
    project: str,
    name: str,
    identity_id: str,
    body: IdentityImageGenRequest = IdentityImageGenRequest(),
    user: dict = Depends(get_api_user),
):
    """基于角色肖像生成身份参考图（Identity Locking）。"""
    from novelvideo.generators.image_generator import generate_identity_image_unified

    logger.info(
        "[%s] generate_identity_image: %s/%s, model=%s", project, name, identity_id, body.model
    )
    ctx, username, project_name, project_dir, _output_dir, store = await _resolve_character_project(
        project, user
    )

    character = store.get_character(name)
    if character is None:
        return {"ok": False, "error": f"Character '{name}' not found"}

    # 查找身份
    identity = None
    for id_ in character.identities or []:
        if id_.identity_id == identity_id:
            identity = id_
            break
    if identity is None:
        return {"ok": False, "error": f"Identity '{identity_id}' not found"}

    costume_image = compute_identity_costume_path(project_dir, name, identity.identity_name) or (
        getattr(identity, "costume_image", "") or ""
    )
    identity_portrait = compute_identity_portrait_path(
        project_dir, name, identity.identity_name
    ) or (getattr(identity, "portrait_image", "") or "")
    identity_age = getattr(identity, "age_group", "") or ""
    char_age = getattr(character, "age_group", "youth") or "youth"
    is_age_variant = bool(identity_age and identity_age != char_age)
    has_costume_image = bool(costume_image and Path(costume_image).exists())
    has_identity_portrait = bool(identity_portrait and Path(identity_portrait).exists())
    if (
        not identity.appearance_details
        and not getattr(identity, "face_prompt", "")
        and not has_costume_image
    ):
        return {
            "ok": False,
            "error": "Identity has no appearance_details, face_prompt, or costume_image",
        }

    # 输出路径
    identities_dir = project_dir / "assets" / "characters" / name / "identities"
    identities_dir.mkdir(parents=True, exist_ok=True)
    safe_identity_name = re.sub(r'[/\\:*?"<>|]', "_", identity.identity_name)
    output_path = identities_dir / f"{safe_identity_name}.png"

    # 备份旧文件
    if output_path.exists():
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = identities_dir / f"{safe_identity_name}_{ts}.png"
        shutil.copy(output_path, backup)

    # 读取项目配置获取默认 style/ethnicity
    proj_config = load_project_config(username, project_name)

    face_override = getattr(identity, "face_prompt", "") or ""
    identity_scope = f"character:{name}:identity:{identity.identity_name}"
    if is_age_variant:
        combined_prompt = (
            ""
            if has_identity_portrait and has_costume_image
            else (
                identity.appearance_details
                if has_identity_portrait
                else (
                    face_override
                    if has_costume_image
                    else (
                        f"{face_override}\n{identity.appearance_details}"
                        if identity.appearance_details
                        else face_override
                    )
                )
            )
        )
        result = await generate_identity_image_unified(
            character_name=name,
            identity_prompt=combined_prompt,
            reference_image_path=identity_portrait if has_identity_portrait else "",
            output_path=str(output_path),
            character_tag=getattr(identity, "character_tag", ""),
            ethnicity=proj_config.get("ethnicity", "Chinese"),
            style=body.style or proj_config.get("visual_style"),
            model=_resolve_character_image_model(username, project_name, body.model),
            project_dir=str(project_dir),
            costume_image_path=costume_image if has_costume_image else "",
            usage_task_type="identity_image",
            usage_scope=identity_scope,
            identity_name=identity.identity_name,
        )
    else:
        portrait_path = compute_portrait_path(project_dir, name)
        if not portrait_path or not Path(portrait_path).exists():
            return {
                "ok": False,
                "error": f"Character '{name}' has no portrait. Generate portrait first",
            }

        result = await generate_identity_image_unified(
            character_name=name,
            identity_prompt="" if has_costume_image else identity.appearance_details,
            reference_image_path=str(portrait_path),
            output_path=str(output_path),
            character_tag=getattr(identity, "character_tag", ""),
            ethnicity=proj_config.get("ethnicity", "Chinese"),
            style=body.style or proj_config.get("visual_style"),
            model=_resolve_character_image_model(username, project_name, body.model),
            project_dir=str(project_dir),
            costume_image_path=costume_image if has_costume_image else "",
            usage_task_type="identity_image",
            usage_scope=identity_scope,
            identity_name=identity.identity_name,
        )

    if isinstance(result, bool):
        success = result
        error_msg = "Identity image generation failed"
    else:
        success = result.get("success", False)
        error_msg = result.get("error", "Identity image generation failed")
    if not success:
        return {"ok": False, "error": error_msg}

    image_url = _asset_url(
        ctx,
        project_dir,
        project_dir / "assets" / "characters" / name / "identities" / f"{safe_identity_name}.png",
    )

    return {"ok": True, "data": {"image_url": image_url}}
