"""Map DramaClaw CE records to direct Seedance prompts."""

from __future__ import annotations

import re
from typing import Any


def build_beat_prompt(
    project: dict[str, Any],
    episode: dict[str, Any],
    beat: dict[str, Any],
    cast: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    project_id = str(project.get("id") or project.get("project_id") or "").strip()
    episode_id = str(episode.get("id") or episode.get("episode_id") or "").strip()
    beat_number = int(beat.get("beat_number") or 0)
    if not project_id or not episode_id or beat_number < 1:
        raise ValueError("project, episode, and positive beat_number are required")

    speaker = str(beat.get("speaker") or "").strip()
    detected = beat.get("detected_identities") or []
    if isinstance(detected, str):
        import json

        detected = json.loads(detected or "[]")
    reference_ids = list(dict.fromkeys(str(item) for item in detected if item))[:3]
    if speaker in cast and speaker not in reference_ids:
        if len(reference_ids) == 3:
            reference_ids.pop()
        reference_ids.append(speaker)

    description = str(beat.get("visual_description") or "").strip()
    description = re.sub(
        r"\{\{([^}]+)\}\}",
        lambda match: str(cast.get(match.group(1), {}).get("name") or match.group(1).split("_", 1)[0]),
        description,
    )
    description = re.sub(r"\[\[[^]]+\]\]", "", description).replace("_default", "").strip()
    narration = str(beat.get("narration_segment") or "").strip()
    has_dialogue = bool(narration)
    lines = [description]
    if narration:
        if str(beat.get("speaker_kind") or "character") == "non_character":
            lines.append(f'Narration (calm voiceover): "{narration}"')
        else:
            speaker_name = str(cast.get(speaker, {}).get("name") or speaker)
            lines.append(f'Dialogue ({speaker_name}): "{narration}"')
    lines.append("Photorealistic, dramatic cinematic lighting, 9:16")
    for index, identity_id in enumerate(reference_ids, 1):
        name = str(cast.get(identity_id, {}).get("name") or identity_id)
        lines.append(f"@Image{index} is {name} — keep every face exactly consistent")
    return {
        "beat_key": f"{project_id}:{episode_id}:{beat_number}",
        "beat_number": beat_number,
        "project": project,
        "episode": episode,
        "beat": beat,
        "prompt": "\n".join(line for line in lines if line),
        "reference_ids": reference_ids,
        "has_dialogue": has_dialogue,
    }
