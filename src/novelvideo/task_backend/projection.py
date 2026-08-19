"""Payload projection: pin a task's project-state inputs at enqueue time.

Some task runners read project state (database rows, project config values)
while they execute.  That makes the result depend on whatever the state happens
to be when the worker gets around to the task, and it requires the worker to be
able to reach that state at all.  Both properties are fine for the default
inline backend, where enqueue and execution happen in the same process on the
same machine, and neither is guaranteed for a non-inline task backend.

This module moves those reads forward: the enqueue side collects the values a
task will need and stores them inside the task payload, so the payload is a
self-contained description of the work.  Byte-sized inputs (images, audio,
canvas JSON) are *not* projected -- they live under ``OUTPUT_DIR`` and travel by
path.  Only database rows and project-config scalars are projected.

Shape -- a nested envelope inside ``payload``, never a new top-level field::

    payload["projection"] = {
        "projection_version": 1,
        "task_type": "...",
        "fields": {...},
    }

``payload``内部没有 schema：签名只覆盖实际内容（``envelope.py:149-160``
``_canonical_json``），不覆盖期望字段集，所以往 ``payload`` 里加嵌套字段天生不破坏
签名验证。

Evolution rules (keep these; they are what makes rolling upgrades possible):

* **Add a field** -- do not bump ``projection_version``.  Producer ships first,
  consumer reads later with ``.get()``.  Never validate the projection with an
  exact field set (``envelope.py:110-113`` ``_require_exact_fields`` is for the
  envelope, not for this); unknown fields must be ignored.
* **Remove a field** -- consumer stops reading first, and only the *next*
  release lets the producer stop sending it.  The other order breaks.
* **Change a field's meaning** -- never in place.  Either use a new key, or bump
  ``projection_version`` and let the consumer accept ``{N, N+1}`` for one
  release before narrowing back.

A missing required field always raises.  There is deliberately no "fall back to
reading the database" branch: that would hide the very defect this projection
exists to make visible.  Rolling back means not installing a projector at all
(see ``novelvideo.ports.projection``), which leaves the payload byte-for-byte
identical to one built without this module.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping

#: Accepted ``projection_version`` values -- a **tolerance window**, not a
#: lockstep equality check.
#:
#: ⚠️ Do not copy ``envelope.py:344`` / ``credentials/crypto.py:175``
#: (``if version != N: raise``) here.  Those guard a *security* boundary, where
#: refusing anything but the exact expected version is the point.  The
#: projection is not a security boundary -- it already sits inside the signed
#: envelope, so it cannot be tampered with.  It is a *data contract*, and a data
#: contract that demands exact equality cannot be rolled out gradually: producer
#: and consumer would have to be restarted at the same instant, turning "add a
#: field" into "take downtime".  The window makes a mixed-version fleet legal in
#: both directions.
SUPPORTED_PROJECTION_VERSIONS: frozenset[int] = frozenset({1, 2})

#: Version stamped on newly built projections.
CURRENT_PROJECTION_VERSION: int = 1

#: Upper bound on the canonical JSON length of one projection.
#:
#: Measured worst case today is ~52 KiB (characters ~28 KiB + scenes ~24 KiB),
#: against a ``beats`` block that already travels in ``payload`` at up to
#: ~113 KiB.  256 KiB leaves ~5x headroom over the worst case while staying
#: below 2.3x the largest block payloads already carry -- a cap an order of
#: magnitude above current reality would not be a cap.
MAX_PROJECTION_BYTES: int = 256 * 1024

#: Which task type needs which projected fields.  The single definition point:
#: the enqueue side builds against it and the worker side is validated against
#: it, so a field can never be required in one place and unknown in the other.
#:
#: An entry with an empty set means "this task type is projected, but needs
#: nothing from project state" -- that is a claim worth recording, not an
#: omission.  A task type absent from this mapping is not projected at all.
PROJECTION_REQUIREMENTS: dict[str, frozenset[str]] = {
    # director_world/control_frame_to_sketch.py:454 (beats), :469 (sketch_colors),
    # :479 -> :37 (characters), :478 and :500 (the two project-config scalars).
    "mainline_director_control_sketch": frozenset(
        {
            "beats",
            "sketch_colors",
            "characters",
            "visual_style",
            "sketch_image_selection",
        }
    ),
    # freezone/audio_node.py:434 (narration style), :443 (narrator reference audio
    # descriptor), :329 and :445 (the one or two character rows actually consulted --
    # the whole character table is never needed here).
    "freezone_audio_speech": frozenset(
        {
            "voice_character",
            "narrator_main_character",
            "narration_style",
            "narrator_reference_audio",
        }
    ),
    # task_backend/runners/sketch.py:144, reached through :405.  Projected
    # unconditionally: whether the scene rows get used is derived on the worker
    # side across four branches (:340-403), and re-deriving that on the enqueue
    # side would be a second copy of the same logic, free to drift.
    "mainline_sketch_from_context": frozenset({"scenes"}),
    # task_backend/runners/render.py reads no project state at all.
    "mainline_frame_from_context": frozenset(),
}


@dataclass(frozen=True)
class ProjectProjection:
    """A projection read back out of a payload.

    ``fields`` is intentionally an open mapping: consumers read what they know
    and ignore the rest, which is what lets a producer ship a new field before
    any consumer reads it.
    """

    task_type: str
    projection_version: int
    fields: Mapping[str, Any] = field(default_factory=dict)

    def get(self, name: str, default: Any = None) -> Any:
        """Read an optional field.  Use for fields not in the requirements."""
        return self.fields.get(name, default)

    def require(self, name: str) -> Any:
        """Read a required field, raising if the producer did not send it.

        No fallback to reading project state: a projection that is present but
        incomplete is a defect, and it has to surface as one.
        """
        if name not in self.fields:
            raise ValueError(
                f"投射缺少字段 {name!r}（task_type={self.task_type}）；"
                "入队侧未投射该字段，执行侧不回落读项目数据"
            )
        return self.fields[name]


def _normalize_field_name(key: str) -> str:
    """Same normalization the envelope applies (``envelope.py:141``)."""
    return re.sub(r"[^a-z0-9]", "", key.casefold())


def _assert_no_sensitive_field_names(value: Any, path: str = "projection") -> None:
    from novelvideo.task_backend.envelope import _SENSITIVE_PAYLOAD_FIELDS

    if isinstance(value, Mapping):
        for key, nested in value.items():
            if isinstance(key, str) and _normalize_field_name(key) in _SENSITIVE_PAYLOAD_FIELDS:
                raise ValueError(
                    f"投射含敏感字段名 {key!r}（位置 {path}）；"
                    "该名字会让整个信封被拒，换一个字段名"
                )
            _assert_no_sensitive_field_names(nested, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, nested in enumerate(value):
            _assert_no_sensitive_field_names(nested, f"{path}[{index}]")


def assert_projection_is_deliverable(projection: Mapping[str, Any]) -> None:
    """Check a projection before it is handed to the envelope.  Enqueue side only.

    Both checks belong here rather than on the worker: this still runs on the
    machine that built the projection, so a failure names the thing that
    produced it.  Discovering either problem after the task has been handed off
    tells you only that something, somewhere, sent too much.
    """
    from novelvideo.task_backend.envelope import _canonical_json

    _assert_no_sensitive_field_names(projection)

    size = len(_canonical_json(projection).encode("utf-8"))
    if size > MAX_PROJECTION_BYTES:
        raise ValueError(
            f"投射超出体积上限：{size} 字节 > {MAX_PROJECTION_BYTES} 字节。"
            "只投射执行时真正读的字段，整表/整份配置不要进 payload"
        )


def _character_to_dict(character: Any) -> dict[str, Any]:
    """Project a character row.

    Same shape as ``director_world/control_frame_to_sketch.py:35-45`` minus
    ``portrait_path``: that one is derived from the project directory, which is
    under ``OUTPUT_DIR`` and therefore reachable by path on any machine.
    """
    item = dict(character.model_dump())
    item["identities"] = [identity.model_dump() for identity in (character.identities or [])]
    return item


def _find_named_character(characters: list[Any], name: str) -> Any | None:
    return next(
        (item for item in characters if str(getattr(item, "name", "") or "") == name),
        None,
    )


async def _build_director_control_sketch_fields(
    store: Any, config: Mapping[str, Any]
) -> dict[str, Any]:
    from novelvideo.project_config import load_project_config_file

    episode = int(config["episode"])
    script = await store.get_script_as_dict(episode) or {}
    # One read serves four fields; ``scene_menu`` / ``prop_menu`` are consumed at
    # control_frame_to_sketch.py:495-496 and cost nothing extra to carry.
    sketch_colors = dict(script.get("sketch_colors") or store.get_sketch_colors(episode) or {})
    project_config = load_project_config_file(config["username"], config["project_name"])
    return {
        "beats": list(script.get("beats") or []),
        "scene_menu": list(script.get("scene_menu") or []),
        "prop_menu": list(script.get("prop_menu") or []),
        "sketch_colors": sketch_colors,
        "characters": [_character_to_dict(item) for item in store.get_all_characters()],
        "visual_style": project_config.get("visual_style", "chinese_period_drama"),
        "sketch_image_selection": project_config.get("sketch_image_selection"),
    }


async def _build_audio_speech_fields(store: Any, config: Mapping[str, Any]) -> dict[str, Any]:
    from novelvideo.project_config import (
        load_effective_narration_style_for_voice,
        load_effective_narration_style_for_voice_from_state_dir,
        load_narrator_reference_audio,
        load_narrator_reference_audio_from_state_dir,
    )

    username = config["username"]
    project_name = config["project_name"]
    state_dir = str(getattr(store, "state_dir", "") or "")
    if state_dir:
        narration_style = load_effective_narration_style_for_voice_from_state_dir(state_dir)
        narrator_reference_audio = load_narrator_reference_audio_from_state_dir(state_dir)
    else:
        narration_style = load_effective_narration_style_for_voice(username, project_name)
        narrator_reference_audio = load_narrator_reference_audio(username, project_name)

    voice_ref = config.get("voice_ref")
    wanted_name = ""
    if isinstance(voice_ref, dict):
        wanted_name = str(voice_ref.get("character_name") or "").strip()

    # Only one or two character rows are ever consulted here (audio_node.py:331
    # matches a single name, voice_clone.py:284-285 wants the main character), so
    # the whole table is not projected.
    characters = list(await store.list_characters())
    voice_character = _find_named_character(characters, wanted_name) if wanted_name else None
    main_character = next(
        (item for item in characters if bool(getattr(item, "is_main", False))), None
    )
    return {
        "voice_character": _character_to_dict(voice_character) if voice_character else None,
        "narrator_main_character": (
            _character_to_dict(main_character) if main_character else None
        ),
        "narration_style": narration_style,
        "narrator_reference_audio": narrator_reference_audio,
    }


async def _build_sketch_from_context_fields(
    store: Any, config: Mapping[str, Any]
) -> dict[str, Any]:
    return {"scenes": [scene.model_dump() for scene in await store.list_scenes()]}


_FIELD_BUILDERS = {
    "mainline_director_control_sketch": _build_director_control_sketch_fields,
    "freezone_audio_speech": _build_audio_speech_fields,
    "mainline_sketch_from_context": _build_sketch_from_context_fields,
    "mainline_frame_from_context": None,
}


async def build_projection(
    store: Any, config: Mapping[str, Any], *, task_type: str
) -> dict[str, Any] | None:
    """Collect a task's project-state inputs.  Enqueue side only.

    Returns ``None`` for task types that declare no requirements, so callers
    write no ``projection`` key at all and the payload stays exactly as it was.
    """
    if task_type not in PROJECTION_REQUIREMENTS:
        return None

    builder = _FIELD_BUILDERS.get(task_type)
    fields: dict[str, Any] = await builder(store, config) if builder is not None else {}

    missing = set(PROJECTION_REQUIREMENTS[task_type]) - set(fields)
    if missing:
        raise ValueError(f"投射未覆盖 {task_type} 的必需字段: {sorted(missing)}")

    projection = {
        "projection_version": CURRENT_PROJECTION_VERSION,
        "task_type": task_type,
        "fields": fields,
    }
    assert_projection_is_deliverable(projection)
    return projection


def read_projection(payload: Mapping[str, Any] | None) -> ProjectProjection | None:
    """Read the projection back out of a payload.  Worker side, pure function.

    ``None`` means "no projection in this payload" -- the caller reads project
    state the way it always has.  A projection that is present but incomplete
    raises instead.
    """
    if not isinstance(payload, Mapping):
        return None
    raw = payload.get("projection")
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ValueError("payload['projection'] 必须是对象")

    version = raw.get("projection_version")
    if version not in SUPPORTED_PROJECTION_VERSIONS:
        raise ValueError(
            f"不支持的投射版本 {version!r}；本进程接受 "
            f"{sorted(SUPPORTED_PROJECTION_VERSIONS)}"
        )

    task_type = str(raw.get("task_type") or "")
    fields = raw.get("fields")
    if not isinstance(fields, Mapping):
        raise ValueError("payload['projection']['fields'] 必须是对象")

    projection = ProjectProjection(
        task_type=task_type,
        projection_version=int(version),
        fields=dict(fields),
    )

    required = PROJECTION_REQUIREMENTS.get(task_type)
    if required is None:
        raise ValueError(f"投射声明了未知的 task_type: {task_type!r}")
    missing = set(required) - set(projection.fields)
    if missing:
        raise ValueError(
            f"投射缺少 {task_type} 的必需字段: {sorted(missing)}；执行侧不回落读项目数据"
        )
    return projection
