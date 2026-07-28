from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sys
from typing import Any

from pydantic import BaseModel, Field

from .paths import shape_hint_registry_path, shape_hints_dir

STAGING_PROP_MODEL = "DC-staging-prop-planner-LLM"
STAGING_PROP_THINKING_LEVEL = "low"


SYSTEM_PROMPT = """You are BuilderGPT inside SuperTale's DirectorWorld editor.

Generate exactly one temporary staging prop for blocking.

This is an ADD operation, not a rebuild operation:
- do not regenerate the world
- do not alter fixtures, actors, camera, or beat state
- only propose one prop_staging object that can be added to the live scene

A staging prop is a code-authored low-poly / voxel-style silhouette used for
director blocking. It is not final art. A horse, sedan chair, dinosaur, giant,
crowd mass, car, box pile, or doorway placeholder must map to one known
shape_hint preset; the viewer will build the readable blocky shape from code.

Return ONLY JSON. No markdown.

Schema:
{
  "prop_id": "short stable snake_case or Chinese identifier",
  "name": "human readable prop name",
  "semantic_label": "english object label, e.g. horse | cannon | airplane | giant",
  "shape_hint": "box | generic_large | quadruped_mount | wheeled_artillery | long_vehicle | sports_car | flying_craft | pile",
  "position": [x, y, z],
  "yaw": number_radians,
  "scale": [width, height, depth],
  "action_hint": "brief blocking purpose",
  "relation_intent": "mount_actor | none",
  "target_actor_hint": "actor name or identity if user asks someone to ride/mount it"
}

Rules:
- Use the crosshair target as the primary placement anchor.
- Use large but readable blocking scale; giants/monsters should be tall volumes.
- Keep position and scale in DirectorWorld units.
- Do not create characters. A giant requested here is a staging prop placeholder,
  not an actor identity.
- semantic_label says what the sketch should draw as the real object.
- shape_hint is the actual coded staging silhouette preset; choose the closest
  readable shape instead of overloading generic_large.
- If the request is about riding a mount, use shape_hint="quadruped_mount" and
  relation_intent="mount_actor" when an actor is named or implied.
"""


class StagingPropAgentOutput(BaseModel):
    """Structured staging prop proposal produced by the LLM."""

    prop_id: str = Field(default="", description="Short stable prop identifier.")
    name: str = Field(default="", description="Human-readable prop name.")
    semantic_label: str = Field(default="", description="English object label.")
    shape_hint: str = Field(default="", description="DirectorWorld shape_hint preset.")
    position: list[Any] = Field(default_factory=list, description="[x, y, z] position.")
    yaw: Any = Field(default=0.0, description="Yaw in radians.")
    scale: list[Any] = Field(default_factory=list, description="[width, height, depth] scale.")
    action_hint: str = Field(default="", description="Blocking purpose.")
    relation_intent: str = Field(default="", description="mount_actor or none.")
    target_actor_hint: str = Field(default="", description="Actor name or identity hint.")


ALLOWED_SHAPE_HINTS = {
    "box",
    "generic_large",
    "quadruped_mount",
    "wheeled_artillery",
    "long_vehicle",
    "sports_car",
    "flying_craft",
    "pile",
}

SHAPE_HINT_DEFAULT_SCALES: dict[str, list[float]] = {
    "box": [1.0, 1.0, 1.0],
    "generic_large": [2.0, 1.6, 1.2],
    "quadruped_mount": [1.4, 1.25, 2.2],
    "wheeled_artillery": [1.4, 1.0, 2.4],
    "long_vehicle": [1.2, 1.4, 3.6],
    "sports_car": [1.65, 0.65, 3.2],
    "flying_craft": [3.0, 1.0, 4.0],
    "pile": [1.2, 1.0, 1.2],
}

SHAPE_HINT_DEFAULT_ATTACHMENTS: dict[str, list[dict[str, Any]]] = {
    "quadruped_mount": [
        {
            "id": "saddle",
            "kind": "mount",
            "offset": [0, 1.15, 0],
            "facing_delta": 0,
            "actor_state": "mounted",
        }
    ],
    "wheeled_artillery": [
        {
            "id": "operator",
            "kind": "operate",
            "offset": [-1.2, 0, -0.8],
            "facing_delta": 0,
            "actor_state": "operating",
        }
    ],
    "long_vehicle": [
        {
            "id": "passenger_front",
            "kind": "seat",
            "offset": [0, 0.7, 0.8],
            "facing_delta": 0,
            "actor_state": "sitting",
        },
        {
            "id": "passenger_back",
            "kind": "seat",
            "offset": [0, 0.7, -0.8],
            "facing_delta": 0,
            "actor_state": "sitting",
        },
    ],
    "flying_craft": [
        {
            "id": "passenger",
            "kind": "seat",
            "offset": [0, 1.0, 0],
            "facing_delta": 0,
            "actor_state": "sitting",
        }
    ],
}

SHAPE_HINT_DEFAULT_AFFORDANCES: dict[str, list[str]] = {
    "box": ["blocking_mass"],
    "generic_large": ["blocking_mass"],
    "quadruped_mount": ["mountable", "blocking_mass"],
    "wheeled_artillery": ["operable", "aimable", "blocking_mass"],
    "long_vehicle": ["seatable", "blocking_mass"],
    "flying_craft": ["seatable", "blocking_mass"],
    "sports_car": ["seatable", "blocking_mass"],
    "pile": ["blocking_mass"],
}


def load_dotenv_files() -> None:
    try:
        from dotenv import load_dotenv
    except Exception:
        return
    load_dotenv(override=False)


def _load_file_backed_shape_hints() -> dict[str, dict[str, Any]]:
    """Load the shared DirectorWorld shape_hint registry.

    The constants above are only a fallback for direct script use from a partial
    checkout. In normal repo runs, src/novelvideo/director_world/shape_hints is
    the source of truth.
    """

    out: dict[str, dict[str, Any]] = {
        shape_hint: {
            "id": shape_hint,
            "default_scale": SHAPE_HINT_DEFAULT_SCALES.get(shape_hint),
            "default_affordances": SHAPE_HINT_DEFAULT_AFFORDANCES.get(shape_hint, []),
            "default_attachment_points": SHAPE_HINT_DEFAULT_ATTACHMENTS.get(shape_hint, []),
        }
        for shape_hint in ALLOWED_SHAPE_HINTS
    }
    hints_dir = shape_hints_dir()
    registry_path = shape_hint_registry_path()
    try:
        manifest = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return out
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list):
        return out
    for file_name in files:
        if not isinstance(file_name, str):
            continue
        try:
            item = json.loads((hints_dir / file_name).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        shape_hint = str(item.get("id") or "").strip()
        if shape_hint:
            out[shape_hint] = item
    return out


SHAPE_HINT_REGISTRY = _load_file_backed_shape_hints()
ALLOWED_SHAPE_HINTS = set(SHAPE_HINT_REGISTRY)
SHAPE_HINT_DEFAULT_SCALES = {
    shape_hint: list(meta.get("default_scale") or [2.0, 1.6, 1.2])
    for shape_hint, meta in SHAPE_HINT_REGISTRY.items()
}
SHAPE_HINT_DEFAULT_ATTACHMENTS = {
    shape_hint: list(meta.get("default_attachment_points") or [])
    for shape_hint, meta in SHAPE_HINT_REGISTRY.items()
}
SHAPE_HINT_DEFAULT_AFFORDANCES = {
    shape_hint: list(meta.get("default_affordances") or ["blocking_mass"])
    for shape_hint, meta in SHAPE_HINT_REGISTRY.items()
}


def resolve_model_config(request: dict[str, Any]) -> tuple[str, str, str | None]:
    from novelvideo.config import get_newapi_runtime_credentials

    model = (
        str(request.get("model") or "").strip()
        or os.environ.get("STAGING_PROP_MODEL")
        or STAGING_PROP_MODEL
    )
    api_key, base_url = get_newapi_runtime_credentials(
        api_key_override=str(request.get("api_key") or "").strip() or None,
        base_url_override=str(request.get("base_url") or "").strip() or None,
        env_api_key="MODEL_API_KEY",
        env_base_url="MODEL_BASE_URL",
    )
    return model, api_key, base_url or "http://localhost:3000/v1"


def create_staging_prop_agent(
    *,
    model: str,
    api_key: str,
    base_url: str,
):
    from pydantic_ai import Agent

    from novelvideo.config import (
        _env_float,
        _get_newapi_text_model_profile,
        _newapi_text_openai_model,
        get_newapi_text_pydantic_model_settings,
    )

    model_settings = get_newapi_text_pydantic_model_settings(
        "STAGING_PROP_THINKING_LEVEL",
        STAGING_PROP_THINKING_LEVEL,
    )
    agent_kwargs: dict[str, Any] = {}
    if model_settings is not None:
        agent_kwargs["model_settings"] = model_settings

    return Agent(
        _newapi_text_openai_model(
            model,
            api_key=api_key,
            base_url=base_url,
            timeout_seconds=_env_float("STAGING_PROP_TIMEOUT_SECONDS", 120.0),
            profile=_get_newapi_text_model_profile(model),
        ),
        system_prompt=SYSTEM_PROMPT,
        output_type=StagingPropAgentOutput,
        output_retries=2,
        name="DirectorWorld Staging Prop Planner",
        **agent_kwargs,
    )


async def run_staging_prop_agent(
    request: dict[str, Any],
    *,
    model: str,
    api_key: str,
    base_url: str,
) -> dict[str, Any]:
    agent = create_staging_prop_agent(model=model, api_key=api_key, base_url=base_url)
    response = await agent.run(build_user_prompt(request))
    return response.output.model_dump()


def read_request() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("request body must be a JSON object")
    return data


def extract_json_object(text: str) -> dict[str, Any]:
    raw = str(text or "").strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        fence = re.search(r"```(?:json)?\s*(.*?)```", raw, flags=re.DOTALL | re.IGNORECASE)
        if fence:
            try:
                data = json.loads(fence.group(1))
            except json.JSONDecodeError:
                data = None
        else:
            data = None
        if data is None:
            start = raw.index("{")
            end = raw.rindex("}")
            data = json.loads(raw[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("model response JSON must be an object")
    return data


def finite_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def vector3(value: Any, *, positive: bool = False) -> list[float] | None:
    if not isinstance(value, list | tuple) or len(value) < 3:
        return None
    out = [finite_float(value[index], math.nan) for index in range(3)]
    if any(not math.isfinite(item) for item in out):
        return None
    if positive and any(item <= 0 for item in out):
        return None
    return out


def default_position(crosshair_target: dict[str, Any]) -> list[float]:
    if not isinstance(crosshair_target, dict):
        return [0.0, 0.0, 0.0]
    position = vector3(crosshair_target.get("position"))
    if position is not None:
        return position
    seat = crosshair_target.get("seat")
    if isinstance(seat, dict):
        return [
            finite_float(seat.get("x")),
            finite_float(seat.get("y")),
            finite_float(seat.get("z")),
        ]
    item = crosshair_target.get("item")
    if isinstance(item, dict):
        item_position = vector3(item.get("position"))
        if item_position is not None:
            return item_position
    return [0.0, 0.0, 0.0]


def default_scale(user_hint: str, shape_hint: str) -> list[float]:
    hint = user_hint.lower()
    if any(token in user_hint for token in ["巨人", "怪兽", "恐龙"]) or any(
        token in hint for token in ["giant", "monster", "dinosaur"]
    ):
        return [2.2, 4.0, 1.2]
    return list(
        SHAPE_HINT_DEFAULT_SCALES.get(shape_hint, SHAPE_HINT_DEFAULT_SCALES["generic_large"])
    )


def infer_semantic_label(user_hint: str, generated: dict[str, Any]) -> str:
    raw = str(generated.get("semantic_label") or "").strip()
    if raw and re.fullmatch(r"[0-9A-Za-z_\-]+", raw):
        return raw.lower().replace("-", "_")
    text = f"{user_hint} {generated.get('name') or ''} {raw}".lower()
    mappings = [
        (["独角兽", "unicorn"], "unicorn"),
        (["马", "horse"], "horse"),
        (["鹿", "deer"], "deer"),
        (["牛", "cow"], "cow"),
        (["恐龙", "dinosaur"], "dinosaur"),
        (["大炮", "火炮", "cannon", "artillery"], "cannon"),
        (["飞机", "airplane", "plane"], "airplane"),
        (["飞船", "airship", "spaceship"], "airship"),
        (["轿子", "sedan"], "sedan_chair"),
        (["马车", "carriage"], "carriage"),
        (["法拉利", "ferrari"], "ferrari"),
        (["跑车", "sports car", "sportscar"], "sports_car"),
        (["推车", "cart"], "cart"),
        (["纸箱堆", "箱堆", "box pile"], "box_pile"),
        (["纸箱", "箱", "box"], "box"),
        (["巨人", "giant"], "giant"),
        (["怪兽", "monster"], "monster"),
    ]
    for tokens, semantic_label in mappings:
        if any(token in text for token in tokens):
            return semantic_label
    if raw:
        return stable_prop_id(raw).lower()
    return stable_prop_id(user_hint or "staging_prop").lower()


def infer_shape_hint(user_hint: str, generated: dict[str, Any], semantic_label: str) -> str:
    raw = str(generated.get("shape_hint") or "").strip().lower()
    if raw in ALLOWED_SHAPE_HINTS:
        return raw
    hint = user_hint.lower()
    text = f"{hint} {semantic_label}".lower()
    wants_mount = any(token in user_hint for token in ["骑", "骑着", "乘"]) or any(
        token in text for token in ["ride", "riding", "mount", "mounted"]
    )
    if any(
        token in text
        for token in ["马", "horse", "unicorn", "deer", "cow", "dinosaur", "quadruped"]
    ):
        return "quadruped_mount" if wants_mount or "dinosaur" not in text else "generic_large"
    if any(token in text for token in ["大炮", "火炮", "cannon", "artillery"]):
        return "wheeled_artillery"
    if any(token in text for token in ["飞机", "飞船", "airplane", "plane", "airship"]):
        return "flying_craft"
    if any(token in text for token in ["法拉利", "ferrari", "跑车", "sports_car", "sports car", "sportscar"]):
        return "sports_car"
    if any(token in text for token in ["轿子", "马车", "车", "sedan", "carriage", "cart"]):
        return "long_vehicle"
    if any(token in text for token in ["堆", "pile"]):
        return "pile"
    if any(token in text for token in ["箱", "box"]):
        return "box"
    return "generic_large"


def shape_hint_defaults(shape_hint: str) -> dict[str, Any]:
    normalized = shape_hint if shape_hint in ALLOWED_SHAPE_HINTS else "generic_large"
    return {
        "affordances": list(SHAPE_HINT_DEFAULT_AFFORDANCES.get(normalized, ["blocking_mass"])),
        "attachment_points": [
            dict(item) for item in SHAPE_HINT_DEFAULT_ATTACHMENTS.get(normalized, [])
        ],
    }


def clamp_scale_for_shape_hint(shape_hint: str, scale: list[float]) -> list[float]:
    if shape_hint != "quadruped_mount":
        return scale
    bounds = [(1.0, 1.8), (0.9, 1.6), (1.6, 2.8)]
    out: list[float] = []
    for index, value in enumerate(scale[:3]):
        lo, hi = bounds[index]
        out.append(min(hi, max(lo, float(value))))
    while len(out) < 3:
        out.append(SHAPE_HINT_DEFAULT_SCALES["quadruped_mount"][len(out)])
    return out


def list_or_default(value: Any, fallback: list[Any]) -> list[Any]:
    return list(value) if isinstance(value, list) else list(fallback)


def stable_prop_id(value: str) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff]+", "_", value.strip(), flags=re.UNICODE).strip("_")
    return cleaned or "ai_staging_prop"


def compact_state(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "actors": [
            {
                "id": actor.get("id") or actor.get("actor_id"),
                "identity_id": actor.get("identity_id"),
                "name": actor.get("name"),
                "position": actor.get("position"),
                "state": actor.get("state"),
                "attached_to": actor.get("attached_to"),
            }
            for actor in state.get("actors", [])[:20]
            if isinstance(actor, dict)
        ],
        "props": [
            {
                "id": prop.get("id") or prop.get("prop_id"),
                "prop_id": prop.get("prop_id"),
                "name": prop.get("name"),
                "type": prop.get("type"),
                "position": prop.get("position"),
                "scale": prop.get("scale"),
                "category": prop.get("category"),
            }
            for prop in state.get("props", [])[:30]
            if isinstance(prop, dict)
        ],
        "camera": state.get("camera"),
    }


def build_user_prompt(request: dict[str, Any]) -> str:
    beat_context = request.get("beat_context") or {}
    if not isinstance(beat_context, dict):
        beat_context = {}
    return json.dumps(
        {
            "scene_id": request.get("scene_id") or "director_world",
            "display_name": request.get("display_name") or request.get("scene_id") or "",
            "user_hint": request.get("user_hint") or "",
            "beat_context": {
                "beat": beat_context.get("beat") or beat_context.get("beat_number") or "",
                "visual_description": beat_context.get("visual_description") or "",
                "actors": beat_context.get("actors") or [],
                "global_props": beat_context.get("global_props") or [],
                "missing_props": beat_context.get("missing_props") or [],
            },
            "crosshair_target": request.get("crosshair_target") or {},
            "current_state": compact_state(request.get("state") or {}),
        },
        ensure_ascii=False,
        indent=2,
    )


def normalize_prop(generated: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    user_hint = str(request.get("user_hint") or "").strip()
    hint_lower = user_hint.lower()
    name = str(generated.get("name") or generated.get("prop_id") or user_hint or "staging道具")
    prop_id = stable_prop_id(str(generated.get("prop_id") or name))
    semantic_label = infer_semantic_label(user_hint, generated)
    shape_hint = infer_shape_hint(user_hint, generated, semantic_label)
    defaults = shape_hint_defaults(shape_hint)
    position = vector3(generated.get("position")) or default_position(
        request.get("crosshair_target") or {}
    )
    scale = clamp_scale_for_shape_hint(
        shape_hint,
        vector3(generated.get("scale"), positive=True) or default_scale(user_hint, shape_hint),
    )
    generated_relation = str(generated.get("relation_intent") or "").strip()
    wants_mount_relation = shape_hint == "quadruped_mount" and (
        any(token in user_hint for token in ["骑", "骑着", "乘"])
        or any(token in hint_lower for token in ["ride", "riding", "mount", "mounted"])
    )
    return {
        "prop_id": prop_id,
        "name": name.strip() or prop_id,
        "type": "prop_staging",
        "category": "staging",
        "semantic_label": semantic_label,
        "shape_hint": shape_hint,
        "affordances": list_or_default(generated.get("affordances"), defaults["affordances"]),
        "attachment_points": list_or_default(
            generated.get("attachment_points"), defaults["attachment_points"]
        ),
        "position": position,
        "yaw": finite_float(generated.get("yaw"), 0.0),
        "scale": scale,
        "action_hint": str(
            generated.get("action_hint") or user_hint or "AI staging blocking prop"
        ).strip(),
        "tracking": "ordinary_prop",
        "asset_scope": "",
        "is_global_asset": False,
        "preserve_marker_color": False,
        "relation_intent": generated_relation
        or ("mount_actor" if wants_mount_relation else "none"),
        "target_actor_hint": str(generated.get("target_actor_hint") or "").strip(),
    }


def generate_ai_staging_prop(request: dict[str, Any]) -> dict[str, Any]:
    load_dotenv_files()
    model, api_key, base_url = resolve_model_config(request)
    if not api_key:
        raise RuntimeError(
            "missing AI api key: set NEWAPI_API_KEY"
        )

    generated = asyncio.run(
        run_staging_prop_agent(
            request,
            model=model,
            api_key=api_key,
            base_url=base_url or "",
        )
    )
    prop = normalize_prop(generated, request)
    return {"ok": True, "prop": prop, "model": model}


def main() -> None:
    request = read_request()
    print(json.dumps(generate_ai_staging_prop(request), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - CLI should return JSON error.
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
