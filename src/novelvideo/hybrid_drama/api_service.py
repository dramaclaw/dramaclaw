"""Project-scoped API services for the durable hybrid drama runner."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from decimal import Decimal, InvalidOperation
import fcntl
import json
from pathlib import Path
import re
from typing import Any

from novelvideo.hybrid_drama.ce import build_beat_prompt
from novelvideo.hybrid_drama.runner import (
    DEFAULT_ESTIMATED_TOKENS,
    assemble_episode,
    estimate_cost,
    finalize_delivery,
    load_state,
    poll_tasks,
    review_candidate,
    submit_task,
)
from novelvideo.seedance2_i2v.assets import build_seedance2_project_assets
from novelvideo.seedance2_i2v.models import parse_seedance2_config

_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode()


def _write_new(path: Path, value: Any) -> None:
    with path.open("xb") as handle:
        handle.write(_json_bytes(value))


def _model_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return dict(vars(value))


def run_directory(output_dir: str | Path, run_id: str, *, create: bool = False) -> Path:
    """Resolve a server-owned run directory without accepting caller paths."""
    if not _RUN_ID.fullmatch(run_id):
        raise ValueError("run_id must contain only letters, digits, underscores, and hyphens")
    project_output = Path(output_dir).resolve()
    runs_root = project_output / "hybrid_drama" / "runs"
    if create:
        runs_root.mkdir(parents=True, exist_ok=True)
    runs_root = runs_root.resolve()
    try:
        runs_root.relative_to(project_output)
    except ValueError as exc:
        raise ValueError("hybrid run root escapes the project output directory") from exc
    candidate = runs_root / run_id
    if create:
        try:
            candidate.mkdir(exist_ok=False)
        except FileExistsError as exc:
            raise ValueError(f"hybrid run {run_id} already exists") from exc
    elif not candidate.is_dir():
        raise ValueError(f"hybrid run {run_id} not found")
    resolved = candidate.resolve()
    try:
        resolved.relative_to(runs_root)
    except ValueError as exc:
        raise ValueError("hybrid run directory escapes its run root") from exc
    return resolved


def _project_relative(project_output: Path, path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(project_output.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError("resolved reference escapes the project output directory") from exc


async def prepare_run(
    resolved: Any,
    store: Any,
    *,
    episode_number: int,
    beat_number: int,
    max_cost_usd: Decimal | str,
    run_id: str,
) -> dict[str, Any]:
    try:
        max_cost = Decimal(str(max_cost_usd))
    except InvalidOperation as exc:
        raise ValueError("max_cost_usd must be a finite decimal") from exc
    if not max_cost.is_finite():
        raise ValueError("max_cost_usd must be a finite decimal")
    estimated = estimate_cost(DEFAULT_ESTIMATED_TOKENS, has_video_input=False)
    if max_cost <= 0 or estimated > max_cost:
        raise ValueError("max_cost_usd must cover the pre-submit estimate")

    episode_record = store.get_episode(episode_number)
    if episode_record is None:
        raise ValueError(f"episode {episode_number} not found")
    beats = await store.get_beats_as_dicts(episode_number)
    beat = next(
        (item for item in beats if int(item.get("beat_number") or 0) == beat_number),
        None,
    )
    if beat is None:
        raise ValueError(f"beat_number {beat_number} not found")
    next_beat = next(
        (
            item
            for item in beats
            if int(item.get("beat_number") or 0) > beat_number
        ),
        None,
    )
    characters = await store.list_characters()
    cast: dict[str, dict[str, Any]] = {}
    for character in characters:
        character_data = _model_dict(character)
        name = str(character_data.get("name") or "").strip()
        if not name:
            continue
        cast[name] = character_data
        for identity in getattr(character, "identities", []) or []:
            identity_data = _model_dict(identity)
            identity_id = str(identity_data.get("identity_id") or "").strip()
            if identity_id:
                cast[identity_id] = {**identity_data, "name": name}

    project = {
        "id": resolved.ctx.project_id,
        "project_id": resolved.ctx.project_id,
        "name": resolved.ctx.project_name,
    }
    episode = _model_dict(episode_record)
    episode.setdefault("id", episode_number)
    prepared = build_beat_prompt(project, episode, beat, cast)
    prepared["identities"] = cast

    project_output = Path(resolved.output_dir)
    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    assets = build_seedance2_project_assets(
        project_output=project_output,
        episode=episode_number,
        beat=beat,
        mode=config.mode,
        state_dir=resolved.state_dir,
        next_beat=next_beat,
        characters=characters,
        prop_menu=getattr(episode_record, "prop_menu", []),
    )
    references: dict[str, str] = {}
    for identity_id in prepared["reference_ids"]:
        asset = next(
            (
                item
                for item in assets
                if item.identity_id == identity_id
                and item.selected
                and item.request_field == "reference_images"
            ),
            None,
        )
        if asset is None:
            raise ValueError(f"panel asset for identity {identity_id} is unavailable")
        references[identity_id] = _project_relative(project_output, asset.path)

    run_dir = run_directory(project_output, run_id, create=True)
    _write_new(run_dir / "prepared.json", prepared)
    _write_new(run_dir / "references.json", references)
    _write_new(
        run_dir / "state.json",
        {
            "version": 1,
            "run_id": run_id,
            "project_id": resolved.ctx.project_id,
            "max_cost_usd": str(max_cost),
            "max_attempts": 1,
            "tasks": [],
            "reviews": [],
            "assemblies": [],
        },
    )
    return {
        "run_id": run_id,
        "beat_key": prepared["beat_key"],
        "prompt": prepared["prompt"],
        "reference_ids": prepared["reference_ids"],
        "has_dialogue": prepared["has_dialogue"],
        "max_cost_usd": str(max_cost),
        "max_attempts": 1,
        "resolution": "720p",
    }


def _load_run_state(resolved: Any, run_id: str) -> tuple[Path, dict[str, Any]]:
    run_dir = run_directory(resolved.output_dir, run_id)
    state = load_state(run_dir)
    if state.get("project_id") != resolved.ctx.project_id:
        raise ValueError("hybrid run does not belong to the resolved project")
    return run_dir, state


@asynccontextmanager
async def _run_lock(resolved: Any, run_id: str):
    run_dir = run_directory(resolved.output_dir, run_id)
    lock = (run_dir / ".state.lock").open("a+")
    try:
        await asyncio.to_thread(fcntl.flock, lock.fileno(), fcntl.LOCK_EX)
        try:
            yield run_dir
        finally:
            await asyncio.to_thread(fcntl.flock, lock.fileno(), fcntl.LOCK_UN)
    finally:
        lock.close()


def _task_status(task: dict[str, Any]) -> dict[str, Any]:
    result = {
        key: task[key]
        for key in (
            "beat_key",
            "beat_number",
            "has_dialogue",
            "status",
            "task_id",
            "request_sha256",
            "estimated_tokens",
            "estimated_cost_usd",
            "actual_cost_usd",
        )
        if key in task
    }
    usage = task.get("usage")
    if isinstance(usage, dict) and "total_tokens" in usage:
        result["usage"] = {"total_tokens": usage["total_tokens"]}
    candidate = task.get("candidate")
    if isinstance(candidate, dict):
        result["candidate"] = {
            key: candidate[key]
            for key in ("sha256", "request_sha256", "reference_sha256")
            if key in candidate
        }
    return result


def get_run_status(resolved: Any, run_id: str) -> dict[str, Any]:
    run_dir, state = _load_run_state(resolved, run_id)
    delivery_path = run_dir / "delivery.json"
    delivery = (
        json.loads(delivery_path.read_text()) if delivery_path.is_file() else None
    )
    return {
        "run_id": run_id,
        "status": (
            "complete"
            if delivery and delivery.get("status") == "complete"
            else "prepared"
            if not state.get("tasks")
            else "in_progress"
        ),
        "max_cost_usd": str(state["max_cost_usd"]),
        "max_attempts": int(state.get("max_attempts") or 1),
        "tasks": [_task_status(task) for task in state.get("tasks", [])],
        "reviews": [
            {
                "candidate_sha256": entry["candidate_sha256"],
                "decision": json.loads(
                    _contained_run_path(run_dir, entry["path"]).read_text()
                )["decision"],
            }
            for entry in state.get("reviews", [])
            if entry.get("candidate_sha256")
        ],
        "assemblies": [
            {"media_sha256": entry["media_sha256"]}
            for entry in state.get("assemblies", [])
            if entry.get("media_sha256")
        ],
        "delivery": (
            {
                "status": delivery["status"],
                "media_sha256": delivery["media_sha256"],
            }
            if delivery
            else None
        ),
    }


def _reference_paths(resolved: Any, run_dir: Path) -> dict[str, Path]:
    references = json.loads((run_dir / "references.json").read_text())
    project_output = Path(resolved.output_dir).resolve()
    paths: dict[str, Path] = {}
    for identity_id, value in references.items():
        relative = Path(value)
        if relative.is_absolute():
            raise ValueError("reference paths must be project-relative")
        path = (project_output / relative).resolve()
        try:
            path.relative_to(project_output)
        except ValueError as exc:
            raise ValueError("reference path escapes the project output directory") from exc
        paths[identity_id] = path
    return paths


async def submit_prepared_run(
    resolved: Any,
    run_id: str,
    *,
    max_attempts: int = 1,
    manual_retry: bool = False,
    api_key: str,
    relay: Any = None,
    http_client: Any = None,
) -> dict[str, Any]:
    if max_attempts < 1:
        raise ValueError("max_attempts must be positive")
    async with _run_lock(resolved, run_id):
        run_dir, state = _load_run_state(resolved, run_id)
        prepared = json.loads((run_dir / "prepared.json").read_text())
        reference_paths = _reference_paths(resolved, run_dir)
        await asyncio.to_thread(
            submit_task,
            run_dir,
            prepared,
            reference_paths,
            max_cost_usd=state["max_cost_usd"],
            max_attempts=max_attempts,
            manual_retry=manual_retry,
            api_key=api_key,
            relay=relay,
            http_client=http_client,
        )
        state = load_state(run_dir)
        if int(state.get("max_attempts") or 1) != max_attempts:
            state["max_attempts"] = max_attempts
            temporary = run_dir / "state.json.tmp"
            temporary.write_bytes(_json_bytes(state))
            temporary.replace(run_dir / "state.json")
        return get_run_status(resolved, run_id)


async def poll_run(
    resolved: Any,
    run_id: str,
    *,
    api_key: str,
    http_client: Any = None,
    media_inspector: Any = None,
) -> dict[str, Any]:
    async with _run_lock(resolved, run_id):
        run_dir, _state = _load_run_state(resolved, run_id)
        await asyncio.to_thread(
            poll_tasks,
            run_dir,
            api_key=api_key,
            http_client=http_client,
            media_inspector=media_inspector,
        )
        return get_run_status(resolved, run_id)


def _contained_run_path(run_dir: Path, value: str | Path) -> Path:
    relative = Path(value)
    if relative.is_absolute():
        raise ValueError("hybrid run paths must be relative to the run directory")
    path = (run_dir / relative).resolve()
    try:
        path.relative_to(run_dir.resolve())
    except ValueError as exc:
        raise ValueError("hybrid run path escapes its run directory") from exc
    return path


async def review_run_candidate(
    resolved: Any,
    run_id: str,
    *,
    candidate_sha256: str,
    decision: str,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    if not _SHA256.fullmatch(candidate_sha256):
        raise ValueError("candidate_sha256 must be a lowercase SHA-256 digest")
    async with _run_lock(resolved, run_id):
        run_dir, state = _load_run_state(resolved, run_id)
        matching = [
            task
            for task in state.get("tasks", [])
            if task.get("candidate", {}).get("sha256") == candidate_sha256
        ]
        if len(matching) != 1:
            raise ValueError("exactly one registered candidate must match candidate_sha256")
        candidate = _contained_run_path(run_dir, matching[0]["candidate"]["path"])
        review = await asyncio.to_thread(
            review_candidate,
            run_dir,
            candidate,
            decision=decision,
            evidence=evidence,
        )
        return {
            key: review[key]
            for key in (
                "candidate_sha256",
                "beat_key",
                "request_sha256",
                "decision",
                "created_at",
            )
        }


async def assemble_run(resolved: Any, run_id: str) -> dict[str, Any]:
    async with _run_lock(resolved, run_id):
        run_dir, _state = _load_run_state(resolved, run_id)
        output = _contained_run_path(run_dir, "assembled/episode.mp4")
        assembly = await asyncio.to_thread(assemble_episode, run_dir, output)
        return {
            key: assembly[key]
            for key in (
                "media_sha256",
                "candidate_sha256",
                "request_sha256",
                "review_sha256",
                "created_at",
            )
        }


async def finalize_run(
    resolved: Any,
    run_id: str,
    *,
    media_sha256: str,
    review: dict[str, Any],
) -> dict[str, Any]:
    if not _SHA256.fullmatch(media_sha256):
        raise ValueError("media_sha256 must be a lowercase SHA-256 digest")
    async with _run_lock(resolved, run_id):
        run_dir, state = _load_run_state(resolved, run_id)
        entries = [
            entry
            for entry in state.get("assemblies", [])
            if entry.get("media_sha256") == media_sha256
        ]
        if not entries:
            raise ValueError("media_sha256 does not match an assembled output")
        assembly_path = _contained_run_path(run_dir, entries[-1]["path"])
        assembly = json.loads(assembly_path.read_text())
        if assembly.get("media_sha256") != media_sha256:
            raise ValueError("assembly metadata does not match media_sha256")
        output = Path(assembly.get("output_path") or "").resolve()
        expected_output = _contained_run_path(run_dir, "assembled/episode.mp4")
        if output != expected_output:
            raise ValueError("assembled output must use the server-owned run path")
        delivery = await asyncio.to_thread(
            finalize_delivery,
            run_dir,
            output,
            review,
        )
        return {"status": delivery["status"], "media_sha256": delivery["media_sha256"]}
