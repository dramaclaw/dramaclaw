from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass


@dataclass(frozen=True)
class TaskIdentitySpec:
    actor_prefix: str
    include_episode: bool = False
    include_beat: bool = False
    scope_mode: str = "none"  # none | raw | grid_index


TASK_IDENTITY_SPECS: dict[str, TaskIdentitySpec] = {
    "ingest_fast": TaskIdentitySpec("ingest_fast"),
    "build_characters": TaskIdentitySpec("build_chars"),
    "character_portrait": TaskIdentitySpec("character_portrait", scope_mode="raw"),
    "build_episodes": TaskIdentitySpec("build_eps"),
    "identity_planner": TaskIdentitySpec("identity_planner", include_episode=True),
    "script_writer": TaskIdentitySpec("script_writer", include_episode=True),
    "literal_script_writer": TaskIdentitySpec("literal_script_writer", include_episode=True),
    "director_notes": TaskIdentitySpec("director_notes", include_episode=True),
    "compose_episode": TaskIdentitySpec("compose_episode", include_episode=True),
    "audio_generation": TaskIdentitySpec("audio_gen", include_episode=True),
    "grid_regenerate": TaskIdentitySpec("grid_regen", include_episode=True, scope_mode="raw"),
    "single_video": TaskIdentitySpec("single_video", include_episode=True, include_beat=True),
    "global_optimize_video": TaskIdentitySpec("global_optimize_video", include_episode=True),
    "sketch_generation": TaskIdentitySpec("sketch_gen", include_episode=True, scope_mode="raw"),
    "director_control_to_sketch": TaskIdentitySpec(
        "director_control_to_sketch", include_episode=True, include_beat=True, scope_mode="raw"
    ),
    "sketch_grid_generation": TaskIdentitySpec("sketch_grid_gen", include_episode=True, scope_mode="raw"),
    "selected_regen": TaskIdentitySpec("selected_regen", include_episode=True, scope_mode="raw"),
    "sketch_regen": TaskIdentitySpec("sketch_regen", include_episode=True, scope_mode="raw"),
    "sketch_edit_execute": TaskIdentitySpec(
        "sketch_edit_execute", include_episode=True, scope_mode="raw"
    ),
    "identity_image": TaskIdentitySpec("identity_image", scope_mode="raw"),
    "scene_reference_asset": TaskIdentitySpec("scene_ref_asset", scope_mode="raw"),
}


def task_state_key(
    task_type: str,
    username: str,
    project: str,
    episode: int,
    beat_num: int | None = None,
    scope: str | None = None,
) -> str:
    key = f"task:{task_type}:{username}:{project}:{episode}"
    if beat_num is not None:
        key += f":{beat_num}"
    if scope:
        key += f":{scope}"
    return key


def project_task_state_key(
    task_type: str,
    project_id: str,
    episode: int,
    beat_num: int | None = None,
    scope: str | None = None,
) -> str:
    """Canonical task key for project_id based task routing."""
    key = f"task:{task_type}:project:{project_id}:{episode}"
    if beat_num is not None:
        key += f":{beat_num}"
    if scope:
        key += f":{scope}"
    return key


def task_scope_from_key(
    task_key: str,
    *,
    task_type: str,
    username: str,
    project: str,
    episode: int,
    beat_num: int | None = None,
) -> str | None:
    base = task_state_key(task_type, username, project, episode, beat_num=beat_num)
    if task_key == base:
        return None
    prefix = f"{base}:"
    if task_key.startswith(prefix):
        return task_key[len(prefix) :] or None
    return None


def project_task_scope_from_key(
    task_key: str,
    *,
    task_type: str,
    project_id: str,
    episode: int,
    beat_num: int | None = None,
) -> str | None:
    base = project_task_state_key(task_type, project_id, episode, beat_num=beat_num)
    if task_key == base:
        return None
    prefix = f"{base}:"
    if task_key.startswith(prefix):
        return task_key[len(prefix) :] or None
    return None


def actor_name_for_task(
    task_type: str,
    username: str,
    project: str,
    episode: int = 0,
    beat_num: int | None = None,
    scope: str | None = None,
) -> str:
    spec = TASK_IDENTITY_SPECS.get(task_type)
    if spec is None:
        parts = [task_type, username, project]
        if episode > 0:
            parts.append(str(episode))
        if beat_num is not None:
            parts.append(str(beat_num))
        if scope:
            parts.append(scope)
        return "_".join(parts)

    parts = [spec.actor_prefix, username, project]
    if spec.include_episode:
        parts.append(str(episode))
    if spec.include_beat and beat_num is not None:
        parts.append(str(beat_num))
    if spec.scope_mode == "raw" and scope:
        parts.append(scope)
    elif spec.scope_mode == "grid_index" and scope:
        parts.append(scope.removeprefix("grid_"))
    return "_".join(parts)


def actor_name_for_project_task(
    task_type: str,
    project_id: str,
    episode: int = 0,
    beat_num: int | None = None,
    scope: str | None = None,
) -> str:
    """Actor/worker identity for new project_id based execution paths."""
    spec = TASK_IDENTITY_SPECS.get(task_type)
    if spec is None:
        parts = [task_type, "project", project_id]
        if episode > 0:
            parts.append(str(episode))
        if beat_num is not None:
            parts.append(str(beat_num))
        if scope:
            parts.append(scope)
        return "_".join(parts)

    parts = [spec.actor_prefix, "project", project_id]
    if spec.include_episode:
        parts.append(str(episode))
    if spec.include_beat and beat_num is not None:
        parts.append(str(beat_num))
    if spec.scope_mode == "raw" and scope:
        parts.append(scope)
    elif spec.scope_mode == "grid_index" and scope:
        parts.append(scope.removeprefix("grid_"))
    return "_".join(parts)


def selection_scope(mode_key: str, beat_numbers: list[int] | tuple[int, ...]) -> str:
    seen: set[int] = set()
    ordered: list[int] = []
    for beat in beat_numbers:
        bn = int(beat)
        if bn in seen:
            continue
        seen.add(bn)
        ordered.append(bn)
    beats_key = ",".join(str(beat) for beat in ordered)
    beats_hash = hashlib.sha1(beats_key.encode("utf-8")).hexdigest()[:12]
    return f"{mode_key}__{beats_hash}"


def hashed_scope(label: str, payload: str | bytes) -> str:
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    digest = hashlib.sha1(payload).hexdigest()[:12]
    return f"{label}__{digest}"


def task_config_scope(label: str, config: dict) -> str:
    normalized = json.dumps(config, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashed_scope(label, normalized)
