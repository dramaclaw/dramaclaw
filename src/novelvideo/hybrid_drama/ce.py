"""Map DramaClaw CE records to direct Seedance prompts."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import httpx


class CEClient:
    """Read the canonical CE REST resources used by the hybrid prompt builder."""

    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        if not self._base_url.startswith(("http://", "https://")):
            raise ValueError("CE base URL must use http or https")
        self._client = http_client or httpx.Client(timeout=30.0)
        self._headers = {"Authorization": f"Bearer {token}"} if token else {}

    def _data(self, path: str) -> Any:
        response = self._client.get(
            f"{self._base_url}{path}", headers=self._headers
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise ValueError(f"CE request failed: {path}")
        return payload.get("data")

    def fetch_beat_prompt(
        self, project_id: str, episode_number: int, beat_number: int
    ) -> dict[str, Any]:
        project_path = f"/api/v1/projects/{quote(project_id, safe='')}"
        project = self._data(project_path)
        episode = self._data(f"{project_path}/episodes/{episode_number}")
        beats = self._data(f"{project_path}/episodes/{episode_number}/beats")
        characters = self._data(f"{project_path}/characters")
        if not isinstance(project, dict) or not isinstance(episode, dict):
            raise ValueError("CE project and episode records are required")
        if not isinstance(beats, list) or not isinstance(characters, list):
            raise ValueError("CE beat and character lists are required")
        beat = next(
            (
                item
                for item in beats
                if int(item.get("beat_number") or 0) == beat_number
            ),
            None,
        )
        if beat is None:
            raise ValueError(f"beat_number {beat_number} not found in CE project")
        project = dict(project)
        project.setdefault("id", project.get("project_id") or project_id)
        episode = dict(episode)
        episode.setdefault("id", episode.get("episode_id") or episode_number)

        cast: dict[str, dict[str, Any]] = {}
        for character in characters:
            if not isinstance(character, dict):
                continue
            name = str(character.get("name") or "").strip()
            if not name:
                continue
            cast[name] = dict(character)
            identities = self._data(
                f"{project_path}/characters/{quote(name, safe='')}/identities"
            )
            for identity in identities or []:
                identity_id = str(identity.get("identity_id") or "").strip()
                if identity_id:
                    cast[identity_id] = {**identity, "name": name}
        prepared = build_beat_prompt(project, episode, beat, cast)
        prepared["identities"] = cast
        return prepared


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
