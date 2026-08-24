"""Unified asset lookup endpoints."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query

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


async def _load_beat_asset_refs(ctx):
    """Read the reference columns of every beat, and nothing else.

    Two things are deliberately skipped. ``load_graph_state=False``: this scan
    only touches the beats table, so the three full-table reads that hydrate the
    character/episode/prop caches would be pure overhead. And
    ``list_beat_asset_refs`` over ``list_visual_beats``: the scan reads six
    columns per beat, while the latter selects every column and constructs a
    validated ``NovelVisualBeat`` for each row.
    """
    store = await make_sqlite_store_for_context(ctx, load_graph_state=False)
    try:
        return await store.list_beat_asset_refs()
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.get("/projects/{project}/assets/references")
async def get_project_asset_references(
    project: str,
    ids: list[str] = Query(default=[]),
    user: dict = Depends(get_api_user),
):
    """Whole-project reverse index: which beats reference each asset.

    Two shapes, one scan, because the assets workbench needs two different
    things and paying for the second everywhere is what made this slow:

    - ``counts`` is always returned — one integer per asset. Every card in every
      grid shows a usage badge, and the panels sort/sum by it, so this has to
      cover the whole project. It stays small: one int per asset, not one entry
      per reference.
    - ``references`` (and ``scene_co_occurrence``) are returned only for the
      assets named in ``ids``, i.e. the ones whose beat list is actually on
      screen. Passing every id back would make the response grow with total
      references — the dimension that grows without bound as episodes pile up.

    Callers pass ``?ids=identity:foo&ids=scene:bar``; keys are ``"{type}:{id}"``
    throughout so a client can look one up without walking the map. Id semantics
    match the persisted beat contract: identity → ``identity_id``,
    scene → ``scene_ref.scene_id``, prop → prop name.
    """
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    beats = await _load_beat_asset_refs(resolved.ctx)

    wanted = {key for key in (str(item or "").strip() for item in ids) if key}
    wanted_scenes = {
        key.split(":", 1)[1] for key in wanted if key.startswith("scene:") and ":" in key
    }

    counts: dict[str, int] = {}
    references: dict[str, list[dict[str, int]]] = {}
    scene_co: dict[str, dict[str, set[str]]] = {}

    def _record(key: str, ref: dict[str, int]) -> None:
        counts[key] = counts.get(key, 0) + 1
        if key in wanted:
            references.setdefault(key, []).append(ref)

    for beat in beats:
        ref = {
            "episode": int(getattr(beat, "episode_number", 0) or 0),
            "beat_number": int(getattr(beat, "beat_number", 0) or 0),
        }
        identities, props, scene_id = _beat_asset_refs(beat)

        for identity_id in identities:
            _record(f"identity:{identity_id}", ref)
        for prop_id in props:
            _record(f"prop:{prop_id}", ref)
        if not scene_id:
            continue

        _record(f"scene:{scene_id}", ref)
        if scene_id not in wanted_scenes:
            continue
        bucket = scene_co.setdefault(scene_id, {"identities": set(), "props": set()})
        bucket["identities"].update(identities)
        bucket["props"].update(props)

    return {
        "ok": True,
        "data": {
            "counts": counts,
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

    beats = await _load_beat_asset_refs(resolved.ctx)
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
