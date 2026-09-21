"""Read authoritative media details and build fallback display specs."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen

from novelvideo.utils.static_urls import project_static_url

logger = logging.getLogger("novelvideo.chat.service")

_DISPLAY_TOOL_NAMES = {
    "dramaclaw_get_sketches",
    "dramaclaw_get_sketch_candidates",
    "dramaclaw_get_first_frames",
    "dramaclaw_get_scene_images",
    "dramaclaw_get_character_media",
    "dramaclaw_get_episode_media",
    "dramaclaw_get_final_video",
}


def _limit_display_items(
    items: list[dict[str, Any]], args: dict[str, Any], default: int
) -> list[dict[str, Any]]:
    try:
        limit = int(args.get("limit")) if args.get("limit") is not None else default
    except (TypeError, ValueError):
        limit = default
    try:
        offset = int(args.get("offset") or 0)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, offset)
    limit = max(1, min(limit, default))
    return items[offset : offset + limit]


def _requested_display_beats(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("beat_indices") or args.get("beats")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("beat", "beat_num", "beat_number", "index"):
        if args.get(key) is not None:
            values.append(args[key])
    beats: set[int] = set()
    for value in values:
        try:
            beat = int(value)
        except (TypeError, ValueError):
            continue
        if beat > 0:
            beats.add(beat)
    return beats or None


def _requested_display_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "character"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_display_queries(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("queries") or args.get("keywords")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("query", "search", "keyword", "text", "identity_name"):
        if args.get(key) is not None:
            values.append(args[key])
    queries = {str(value).strip() for value in values if str(value or "").strip()}
    return queries or None


def _requested_display_scene_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names") or args.get("scene_names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "scene_name"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_display_scene_indices(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("scene_indices") or args.get("indices")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    if args.get("index") is not None:
        values.append(args["index"])
    indices: set[int] = set()
    for value in values:
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if index > 0:
            indices.add(index)
    return indices or None


def _matches_any_display_scene_name(
    scene_name: str, requested_names: set[str] | None
) -> bool:
    if requested_names is None:
        return True
    haystack = str(scene_name or "").casefold()
    return any(needle.casefold() in haystack for needle in requested_names if needle)


def _flatten_display_text_fields(fields: list[Any]) -> list[str]:
    values: list[str] = []
    for field in fields:
        if isinstance(field, dict):
            values.extend(_flatten_display_text_fields(list(field.values())))
        elif isinstance(field, list):
            values.extend(_flatten_display_text_fields(field))
        elif field is not None:
            text = str(field).strip()
            if text:
                values.append(text)
    return values


def _matches_any_display_text(fields: list[Any], queries: set[str] | None) -> bool:
    if queries is None:
        return True
    haystack = "\n".join(_flatten_display_text_fields(fields)).casefold()
    return any(query.casefold() in haystack for query in queries if query)


def _media_ui_spec(
    spec_type: str, component_type: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    elements: dict[str, Any] = {
        "root": {
            "type": "Stack",
            "props": {
                "direction": "row",
                "wrap": "wrap",
                "spacing": 16,
                "alignItems": "flex-start",
                "width": "100%",
            },
            "children": [],
        }
    }
    for index, item in enumerate(items, start=1):
        src = str(item.get("src") or item.get("url") or "").strip()
        if not src:
            continue
        key = f"media_{index}"
        title = str(item.get("title") or item.get("label") or f"媒体 {index}").strip()
        description = str(item.get("description") or "").strip()
        props: dict[str, Any] = {"src": src, "alt": title, "title": title}
        if description:
            props["description"] = description
        if component_type == "Image":
            props.update(
                {
                    "fit": item.get("fit") or "cover",
                    "aspectRatio": item.get("aspectRatio") or "3/4",
                    "overlayTitle": title,
                }
            )
            if description:
                props["overlayDescription"] = description
        elif component_type == "Video":
            poster = str(item.get("poster") or item.get("thumbnail") or "").strip()
            if poster:
                props["poster"] = poster
            props["controls"] = True
        elif component_type == "Audio":
            props["controls"] = True

        elements[key] = {"type": component_type, "props": props, "children": []}
        elements["root"]["children"].append(key)
    return {"type": spec_type, "root": "root", "elements": elements}


def _project_static_url_from_path(
    project_id: str, rel_path: str, local_path: Path | None = None
) -> str:
    return project_static_url(project_id, rel_path, local_path=local_path)


def _api_response_items(resp: Any, *keys: str) -> list[Any]:
    if not isinstance(resp, dict):
        return []
    for key in keys:
        value = resp.get(key)
        if isinstance(value, list):
            return value
    data = resp.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []


def _decode_tool_args(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _extract_display_tool_call(raw: Any) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    title = str(
        raw.get("title")
        or raw.get("kind")
        or raw.get("name")
        or raw.get("tool_name")
        or ""
    ).strip()
    tool_name = title.partition(":")[0].split()[0].strip()
    if tool_name not in _DISPLAY_TOOL_NAMES:
        for key in ("name", "tool", "toolName", "tool_name"):
            candidate = str(raw.get(key) or "").strip()
            if candidate in _DISPLAY_TOOL_NAMES:
                tool_name = candidate
                break
    if tool_name not in _DISPLAY_TOOL_NAMES:
        function = raw.get("function")
        if isinstance(function, dict):
            candidate = str(function.get("name") or "").strip()
            if candidate in _DISPLAY_TOOL_NAMES:
                tool_name = candidate
    if tool_name not in _DISPLAY_TOOL_NAMES:
        return None
    for key in ("arguments", "args", "input", "params"):
        args = _decode_tool_args(raw.get(key))
        if args:
            return tool_name, args
    content = raw.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            nested = item.get("content")
            if isinstance(nested, dict):
                args = _decode_tool_args(nested.get("text"))
                if args:
                    return tool_name, args
    return tool_name, {}


def _display_tool_call_key(tool_name: str, args: dict[str, Any]) -> str:
    try:
        encoded_args = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        encoded_args = repr(args)
    return f"{tool_name}:{encoded_args}"


def _infer_display_tool_call_from_text(
    prompt: str,
    assistant_text: str,
    previous_assistant: list[str],
) -> tuple[str, dict[str, Any]] | None:
    """Recover from display promises where the model forgot to call a display tool."""
    prompt_text = str(prompt or "")
    prompt_lower = prompt_text.casefold()
    recent_context = "\n".join(previous_assistant[-2:] if previous_assistant else [])
    context_text = "\n".join([prompt_text, str(assistant_text or ""), recent_context])
    context_lower = context_text.casefold()
    progress_terms = ("进度", "状态", "任务", "做到哪", "做到哪儿", "当前情况")
    if any(term in prompt_text for term in progress_terms):
        return None
    display_terms = (
        "展示",
        "显示",
        "查看",
        "看",
        "全部显示",
        "show",
        "display",
        "view",
    )
    if not any(term in prompt_lower for term in display_terms):
        return None
    prompt_mentions_sketch = "草图" in prompt_text or "sketch" in prompt_lower
    context_mentions_sketch = "草图" in context_text or "sketch" in context_lower
    short_followup = len(prompt_text.strip()) <= 20 and any(
        term in prompt_text for term in ("全部", "继续", "下一页", "更多")
    )
    if not prompt_mentions_sketch and not (short_followup and context_mentions_sketch):
        return None

    episode = 1
    episode_match = re.search(
        r"(?:第\s*(\d+)\s*集|ep(?:isode)?\s*\.?\s*(\d+))",
        context_text,
        re.IGNORECASE,
    )
    if episode_match:
        raw_episode = episode_match.group(1) or episode_match.group(2)
        try:
            episode = max(1, int(raw_episode))
        except (TypeError, ValueError):
            episode = 1
    wants_sketch_candidates = any(
        term in context_text for term in ("草图候选", "候选草图", "图池", "备选草图")
    )
    if wants_sketch_candidates:
        beat_match = re.search(
            r"(?:beat|Beat|BEAT)\s*\.?\s*(\d+)|第\s*(\d+)\s*(?:个|张)?\s*beat|Beat\s*(\d+)",
            context_text,
            re.IGNORECASE,
        )
        raw_beat = None
        if beat_match:
            raw_beat = next((group for group in beat_match.groups() if group), None)
        if raw_beat:
            try:
                beat = max(1, int(raw_beat))
            except (TypeError, ValueError):
                beat = 0
            if beat > 0:
                return "dramaclaw_get_sketch_candidates", {
                    "episode": episode,
                    "beat": beat,
                }
        return None
    return "dramaclaw_get_sketches", {"episode": episode}


def _backend_api_get(
    path: str, token: str, *, open_url: Callable[..., Any] = urlopen
) -> dict[str, Any]:
    base_url = (
        os.environ.get("DRAMACLAW_API_URL")
        or os.environ.get("NOVELVIDEO_API_URL")
        or f"http://127.0.0.1:{os.environ.get('NOVELVIDEO_API_PORT', '19080')}"
        or os.environ.get("SUPERTALE_API_URL")
    ).strip()
    url = f"{base_url.rstrip('/')}{path}"
    req = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "dramaclaw-chat-fallback/0.1.0",
        },
        method="GET",
    )
    with open_url(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {"ok": False, "error": text[:500]}
    return value if isinstance(value, dict) else {"ok": True, "data": value}


async def _fallback_display_tool_ui_specs(
    username: str,
    project: str,
    tool_name: str,
    args: dict[str, Any],
    *,
    token: str,
    _backend_api_get: Callable[[str, str], dict[str, Any]],
    project_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    if not project or tool_name not in _DISPLAY_TOOL_NAMES:
        return []

    def build() -> list[dict[str, Any]]:
        api_project = str(
            args.get("project_id") or args.get("project") or project
        ).strip()
        project_q = quote(api_project, safe="")
        if tool_name == "dramaclaw_get_final_video":
            raw_episode_indices = args.get("episode_indices")
            episode_indices: list[int] = []
            if args.get("episode") is not None and not raw_episode_indices:
                episode_indices = [int(args["episode"])]
            elif isinstance(raw_episode_indices, list):
                for value in raw_episode_indices:
                    try:
                        episode = int(value)
                    except (TypeError, ValueError):
                        continue
                    if episode > 0 and episode not in episode_indices:
                        episode_indices.append(episode)
            if not episode_indices:
                episodes_resp = _backend_api_get(
                    f"/api/v1/projects/{project_q}/episodes",
                    token,
                )
                for item in _api_response_items(episodes_resp, "episodes", "items"):
                    if not isinstance(item, dict):
                        continue
                    try:
                        episode = int(item.get("number") or 0)
                    except (TypeError, ValueError):
                        continue
                    if episode > 0 and episode not in episode_indices:
                        episode_indices.append(episode)

            media_items: list[dict[str, Any]] = []
            for episode in sorted(episode_indices):
                resp = _backend_api_get(
                    f"/api/v1/projects/{project_q}/episodes/{episode}/final",
                    token,
                )
                data = resp.get("data") if isinstance(resp, dict) else None
                video_url = (
                    str(data.get("video_url") or "").strip()
                    if isinstance(data, dict) and data.get("exists")
                    else ""
                )
                if video_url:
                    media_items.append(
                        {
                            "src": video_url,
                            "title": f"第 {episode} 集成片",
                            "description": "最终合成视频",
                        }
                    )
            if not media_items:
                return []
            page_items = _limit_display_items(media_items, args, 6)
            return [
                _media_ui_spec(
                    "keyframe_video",
                    "Video",
                    page_items,
                )
            ]
        if tool_name in {"dramaclaw_get_sketches", "dramaclaw_get_first_frames"}:
            episode = int(args.get("episode") or 1)
            media_kind = (
                "frame" if tool_name == "dramaclaw_get_first_frames" else "sketch"
            )
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats",
                token,
            )
            media_items: list[dict[str, Any]] = []
            requested_beats = _requested_display_beats(args)
            for beat in _api_response_items(resp, "beats", "items"):
                if not isinstance(beat, dict):
                    continue
                beat_number = beat.get("beat_number")
                try:
                    beat_int = int(beat_number)
                except (TypeError, ValueError):
                    beat_int = None
                if requested_beats is not None and beat_int not in requested_beats:
                    continue
                sketch_url = str(beat.get("sketch_url") or "").strip()
                frame_url = str(beat.get("frame_url") or "").strip()
                if sketch_url and media_kind == "sketch":
                    media_items.append(
                        {
                            "src": sketch_url,
                            "title": f"Beat {beat_number} 草图",
                            "description": "草图",
                            "aspectRatio": "3/4",
                        }
                    )
                if frame_url and media_kind == "frame":
                    media_items.append(
                        {
                            "src": frame_url,
                            "title": f"Beat {beat_number} 首帧",
                            "description": "首帧",
                            "aspectRatio": "3/4",
                        }
                    )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []
            )

        if tool_name == "dramaclaw_get_sketch_candidates":
            episode = int(args.get("episode") or 1)
            try:
                beat = int(
                    args.get("beat")
                    or args.get("beat_num")
                    or args.get("beat_number")
                    or 0
                )
            except (TypeError, ValueError):
                beat = 0
            if beat <= 0:
                return []
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats/{beat}/sketch-candidates",
                token,
            )
            data = resp.get("data") if isinstance(resp, dict) else None
            candidates = data.get("candidates") if isinstance(data, dict) else []
            media_items = []
            for candidate in candidates if isinstance(candidates, list) else []:
                if not isinstance(candidate, dict):
                    continue
                src = str(candidate.get("url") or "").strip()
                if not src:
                    continue
                media_items.append(
                    {
                        "src": src,
                        "title": f"Beat {beat} 草图候选",
                        "description": (
                            "过期候选" if candidate.get("stale") else "草图候选"
                        ),
                        "aspectRatio": "3/4",
                    }
                )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []
            )

        if tool_name == "dramaclaw_get_scene_images":
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/scenes?summary=false", token
            )
            media_items = []
            include_reverse = bool(args.get("include_reverse", True))
            include_pano = bool(args.get("include_pano", False))
            include_custom = bool(args.get("include_custom", False))
            requested_names = _requested_display_scene_names(args)
            requested_indices = _requested_display_scene_indices(args)
            requested_type = str(args.get("scene_type") or "").strip()
            for scene_index, scene in enumerate(
                _api_response_items(resp, "scenes", "items"), start=1
            ):
                if not isinstance(scene, dict):
                    continue
                scene_name = str(scene.get("name") or "").strip()
                scene_type = str(scene.get("scene_type") or "").strip()
                if (
                    requested_indices is not None
                    and scene_index not in requested_indices
                ):
                    continue
                if not _matches_any_display_scene_name(scene_name, requested_names):
                    continue
                if requested_type and scene_type != requested_type:
                    continue
                for kind, field, enabled in (
                    ("master", "master_url", True),
                    ("reverse_master", "reverse_master_url", include_reverse),
                    ("pano", "pano_url", include_pano),
                    ("custom_scene", "custom_scene_url", include_custom),
                ):
                    src = str(scene.get(field) or "").strip()
                    if enabled and src:
                        media_items.append(
                            {
                                "src": src,
                                "title": f"{scene_name or '场景'} · {kind}",
                                "description": scene.get("description")
                                or scene.get("environment_prompt")
                                or "",
                                "aspectRatio": "16/9" if kind == "pano" else "3/4",
                            }
                        )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []
            )

        if tool_name == "dramaclaw_get_character_media":
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/characters?summary=false", token
            )
            media_kind = (
                str(args.get("media_kind") or args.get("kind") or "all").strip().lower()
            )
            if media_kind not in {"all", "portrait", "identity"}:
                media_kind = "all"
            include_identities = (
                bool(args.get("include_identities", True)) and media_kind != "portrait"
            )
            media_items = []
            requested_names = _requested_display_names(args)
            requested_queries = _requested_display_queries(args)
            for character in _api_response_items(resp, "characters", "items"):
                if not isinstance(character, dict):
                    continue
                name = str(character.get("name") or "").strip()
                role = str(
                    character.get("role") or character.get("description") or ""
                ).strip()
                character_name_match = _matches_any_display_text(
                    [name, character.get("aliases")],
                    requested_names,
                )
                character_query_match = _matches_any_display_text(
                    [
                        name,
                        role,
                        character.get("description"),
                        character.get("appearance"),
                        character.get("profile"),
                        character.get("aliases"),
                    ],
                    requested_queries,
                )
                character_match = character_name_match and character_query_match
                portrait_url = str(character.get("portrait_url") or "").strip()
                if portrait_url and character_match:
                    if media_kind in {"all", "portrait"}:
                        media_items.append(
                            {
                                "src": portrait_url,
                                "title": name or "角色肖像",
                                "description": role,
                                "aspectRatio": "3/4",
                            }
                        )
                identities = (
                    character.get("identities")
                    or character.get("identity_images")
                    or []
                )
                if include_identities:
                    try:
                        identities_resp = _backend_api_get(
                            f"/api/v1/projects/{project_q}/characters/{quote(name, safe='')}/identities",
                            token,
                        )
                        for key in ("data", "identities", "items"):
                            value = (
                                identities_resp.get(key)
                                if isinstance(identities_resp, dict)
                                else None
                            )
                            if isinstance(value, list):
                                identities = value
                                break
                        data = (
                            identities_resp.get("data")
                            if isinstance(identities_resp, dict)
                            else None
                        )
                        if isinstance(data, dict):
                            value = data.get("identities")
                            if isinstance(value, list):
                                identities = value
                    except Exception:
                        pass
                if include_identities and isinstance(identities, list):
                    for identity in identities:
                        if not isinstance(identity, dict):
                            continue
                        src = str(
                            identity.get("image_url")
                            or identity.get("portrait_image_url")
                            or identity.get("costume_image_url")
                            or ""
                        ).strip()
                        if src:
                            title = str(
                                identity.get("identity_name")
                                or identity.get("name")
                                or identity.get("identity_id")
                                or name
                                or "身份图"
                            )
                            identity_name_match = _matches_any_display_text(
                                [
                                    name,
                                    character.get("aliases"),
                                    title,
                                    identity.get("identity_name"),
                                    identity.get("name"),
                                    identity.get("identity_id"),
                                ],
                                requested_names,
                            )
                            identity_query_match = _matches_any_display_text(
                                [
                                    title,
                                    identity.get("identity_name"),
                                    identity.get("name"),
                                    identity.get("identity_id"),
                                    identity.get("description"),
                                    identity.get("appearance_details"),
                                    identity.get("prompt"),
                                    identity.get("role"),
                                    name,
                                    role,
                                ],
                                requested_queries,
                            )
                            identity_match = (
                                identity_name_match and identity_query_match
                            )
                            if not identity_match:
                                continue
                            media_items.append(
                                {
                                    "src": src,
                                    "title": f"{name} · {title}" if name else title,
                                    "description": role,
                                    "aspectRatio": "3/4",
                                }
                            )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("character_showcase", "Image", limited)]
                if limited
                else []
            )

        if tool_name == "dramaclaw_get_episode_media":
            episode = int(args.get("episode") or 1)
            media_type = str(args.get("media_type") or "video").strip().lower()
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats",
                token,
            )
            video_items: list[dict[str, Any]] = []
            audio_items: list[dict[str, Any]] = []
            requested_beats = _requested_display_beats(args)
            requested_queries = _requested_display_queries(args)
            for beat in _api_response_items(resp, "beats", "items"):
                if not isinstance(beat, dict):
                    continue
                beat_number = beat.get("beat_number")
                try:
                    beat_int = int(beat_number)
                except (TypeError, ValueError):
                    beat_int = None
                if requested_beats is not None and beat_int not in requested_beats:
                    continue
                if not _matches_any_display_text(
                    [
                        beat.get("title"),
                        beat.get("summary"),
                        beat.get("description"),
                        beat.get("visual_description"),
                        beat.get("image_prompt"),
                        beat.get("video_prompt"),
                        beat.get("narration"),
                        beat.get("voiceover"),
                        beat.get("dialogue"),
                        beat.get("audio_text"),
                        beat.get("speaker"),
                        beat.get("character_names"),
                        beat.get("characters"),
                        beat.get("scene_name"),
                        beat.get("location"),
                    ],
                    requested_queries,
                ):
                    continue
                video_url = str(beat.get("video_url") or "").strip()
                audio_url = str(beat.get("audio_url") or "").strip()
                frame_url = str(
                    beat.get("frame_url") or beat.get("sketch_url") or ""
                ).strip()
                if video_url:
                    video_items.append(
                        {
                            "src": video_url,
                            "poster": frame_url,
                            "title": f"Beat {beat_number} 视频",
                        }
                    )
                if audio_url:
                    audio_items.append(
                        {"src": audio_url, "title": f"Beat {beat_number} 音频"}
                    )
            if media_type == "audio":
                limited = _limit_display_items(audio_items, args, 20)
                return (
                    [_media_ui_spec("audio_list", "Audio", limited)] if limited else []
                )
            limited = _limit_display_items(video_items, args, 6)
            return (
                [_media_ui_spec("keyframe_video", "Video", limited)] if limited else []
            )

        return []

    try:
        return await asyncio.to_thread(build)
    except Exception as exc:
        logger.info(
            "display fallback failed project=%s tool=%s args=%s error=%s",
            project,
            tool_name,
            json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)[:1000],
            exc,
        )
        return []
