"""Unified asset lookup endpoints."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import make_sqlite_store_for_context, resolve_project_scope
from novelvideo.models import (
    beat_scene_id,
    extract_prop_ids_from_markers,
    real_detected_identities,
    real_detected_props,
)

router = APIRouter()

VALID_REFERENCE_TYPES = {"identity", "scene", "prop"}


def _contains(values: object, target: str) -> bool:
    return target in {str(value or "").strip() for value in (values or [])}


def _json_list(value: object) -> list[str]:
    if isinstance(value, list):
        raw = value
    else:
        try:
            raw = json.loads(str(value or "[]"))
        except (TypeError, ValueError, json.JSONDecodeError):
            raw = []
    return [str(item or "").strip() for item in raw if str(item or "").strip()]


def _beat_asset_refs(beat) -> tuple[list[str], list[str], str]:
    """Assets referenced by one beat, as ``(identities, props, scene_id)``.

    Props have two carriers and both count: a prop is "in" a beat when it is
    color-bound on the sketch (``detected_props``) OR marked inline in the
    visual description as ``[[name]]``. A prop that is only ever marked inline
    would otherwise report zero references.
    """
    identities = real_detected_identities(
        _json_list(getattr(beat, "detected_identities_json", "[]"))
    )
    props = real_detected_props(_json_list(getattr(beat, "detected_props_json", "[]")))
    for prop_id in extract_prop_ids_from_markers(
        str(getattr(beat, "visual_description", "") or "")
    ):
        if prop_id not in props:
            props.append(prop_id)
    return identities, props, beat_scene_id(beat)


async def _load_visual_beats(ctx):
    store = await make_sqlite_store_for_context(ctx)
    try:
        return await store.list_visual_beats()
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.get("/projects/{project}/assets/references")
async def get_project_asset_references(
    project: str,
    user: dict = Depends(get_api_user),
):
    """Whole-project reverse index: which beats reference each asset.

    The assets workbench needs a usage count on every card at once. Fetching it
    per asset would be one request per card, and deriving it on the client means
    pulling every episode's full beat payload (sketch/frame/video URLs, audio
    durations) just to read three fields per beat. Both are answered here by a
    single pass over ``list_visual_beats()`` — one SQL read, no filesystem work.

    Reference keys are ``"{type}:{id}"`` so the client can look one up without
    walking the map. Id semantics match the persisted beat contract:
    identity → ``identity_id``, scene → ``scene_ref.scene_id``, prop → prop name.
    """
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    beats = await _load_visual_beats(resolved.ctx)

    references: dict[str, list[dict[str, int]]] = {}
    scene_co: dict[str, dict[str, set[str]]] = {}

    def _push(key: str, ref: dict[str, int]) -> None:
        references.setdefault(key, []).append(ref)

    for beat in beats:
        ref = {
            "episode": int(getattr(beat, "episode_number", 0) or 0),
            "beat_number": int(getattr(beat, "beat_number", 0) or 0),
        }
        identities, props, scene_id = _beat_asset_refs(beat)

        for identity_id in identities:
            _push(f"identity:{identity_id}", ref)
        for prop_id in props:
            _push(f"prop:{prop_id}", ref)
        if not scene_id:
            continue

        _push(f"scene:{scene_id}", ref)
        bucket = scene_co.setdefault(scene_id, {"identities": set(), "props": set()})
        bucket["identities"].update(identities)
        bucket["props"].update(props)

    return {
        "ok": True,
        "data": {
            "references": references,
            "scene_co_occurrence": {
                scene_id: {
                    "identities": sorted(bucket["identities"]),
                    "props": sorted(bucket["props"]),
                }
                for scene_id, bucket in scene_co.items()
            },
        },
    }


@router.get("/projects/{project}/assets/{asset_type}/{asset_id}/references")
async def get_asset_references(
    project: str,
    asset_type: str,
    asset_id: str,
    user: dict = Depends(get_api_user),
):
    """Return beat references for a character identity, scene, or prop asset.

    Matching follows the persisted beat contract:
    - identity: ``detected_identities`` stores ``identity_id``.
    - scene: ``scene_ref.scene_id`` stores the scene ``name``.
    - prop: ``detected_props`` stores the prop ``name`` / episode prop id.
    """
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    normalized_type = str(asset_type or "").strip().lower()
    target_id = str(asset_id or "").strip()
    if normalized_type not in VALID_REFERENCE_TYPES:
        return {"ok": False, "error": f"Unsupported asset type: {asset_type}"}
    if not target_id:
        return {"ok": False, "error": "Asset id is required"}

    beats = await _load_visual_beats(resolved.ctx)
    references: list[dict[str, int]] = []
    co_identities: set[str] = set()
    co_props: set[str] = set()

    for beat in beats:
        episode = int(getattr(beat, "episode_number", 0) or 0)
        beat_number = int(getattr(beat, "beat_number", 0) or 0)
        detected_identities, detected_props, scene_id = _beat_asset_refs(beat)

        matched = False
        if normalized_type == "identity":
            matched = _contains(detected_identities, target_id)
        elif normalized_type == "scene":
            matched = scene_id == target_id
        elif normalized_type == "prop":
            matched = _contains(detected_props, target_id)

        if not matched:
            continue

        references.append({"episode": episode, "beat_number": beat_number})
        if normalized_type == "scene":
            co_identities.update(str(item or "").strip() for item in detected_identities if item)
            co_props.update(str(item or "").strip() for item in detected_props if item)

    data: dict[str, object] = {"beats": references}
    if normalized_type == "scene":
        data["co_identities"] = sorted(co_identities)
        data["co_props"] = sorted(co_props)
    return {"ok": True, "data": data}
