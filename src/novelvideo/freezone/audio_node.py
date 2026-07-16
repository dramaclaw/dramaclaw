"""Freezone audio-node helpers backed by the project's IndexTTS2 flow."""

from __future__ import annotations

import json
import re
import subprocess
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from novelvideo.config import INDEXTTS2_RECORD_MODEL, OUTPUT_DIR
from novelvideo.generators.indextts2_fal import IndexTTS2FalClient
from novelvideo.project_config import (
    load_effective_narration_style_for_voice,
    load_narrator_reference_audio,
)
from novelvideo.seedance2_i2v.voice_clone import (
    build_reference_audio_url,
    file_sha256,
    narration_style_prompt,
    resolve_character_voice,
    resolve_narrator_source,
)
from novelvideo.freezone.paths import outputs_dir


USER_VOICE_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm"}
USER_VOICE_SCOPE = "user_custom"


@dataclass
class FreezoneAudioSpeechResult:
    audio_path: Path
    duration_ms: int
    mime_type: str
    model: str
    voice_source: str
    voice_sha256: str


@dataclass
class FreezoneVoiceRefResolution:
    audio_path: Path
    sha256: str
    source: str


def freezone_audio_speech_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_audio_speech") / f"{job_id}.mp3"


def freezone_audio_eleven_music_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_audio_eleven_music") / f"{job_id}.mp3"


def freezone_audio_music_billing_seconds(music_length_ms: int) -> int:
    try:
        value = int(music_length_ms or 0)
    except (TypeError, ValueError):
        value = 0
    return max((max(value, 0) + 999) // 1000, 1)


async def _reserve_music_model_call(
    model: str,
    *,
    music_length_ms: int,
    source: str,
) -> str:
    from novelvideo.ports import get_usage_meter

    billing_seconds = freezone_audio_music_billing_seconds(music_length_ms)
    return await get_usage_meter().reserve_current_model_call_credit(
        model=model,
        billing_kind="audio",
        billing_quantity=billing_seconds,
        metadata={
            "source": source,
            "music_length_ms": int(music_length_ms or 0),
            "billing_seconds": billing_seconds,
        },
    )


async def _refund_music_model_call(
    reservation_id: str,
    *,
    source: str,
    error: str,
) -> None:
    if not reservation_id:
        return
    try:
        from novelvideo.ports import get_usage_meter

        await get_usage_meter().refund_model_call_credit_reservation(
            reservation_id,
            metadata={"source": source, "error": error[:200]},
        )
    except Exception:
        pass


async def _confirm_music_model_call(
    *,
    model: str,
    reservation_id: str,
) -> None:
    if not reservation_id:
        return
    try:
        from novelvideo.ports import get_usage_meter

        await get_usage_meter().bump_model_call(
            user_id=None,
            model=model,
            credit_reservation_id=reservation_id,
        )
    except Exception:
        pass


def user_audio_voices_dir(username: str) -> Path:
    return Path(OUTPUT_DIR) / username / "_account" / "freezone" / "audio" / "voices"


def user_audio_voices_index_path(username: str) -> Path:
    return user_audio_voices_dir(username) / "voices.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_voice_name(value: str) -> str:
    return re.sub(r"[\x00-\x1f]", "", str(value or "").strip())[:80] or "未命名音色"


def _safe_extension(filename: str | None) -> str:
    suffix = Path(str(filename or "")).suffix.lower()
    if suffix not in USER_VOICE_EXTENSIONS:
        raise ValueError("unsupported voice audio format; use mp3/wav/m4a/aac/ogg/webm")
    return suffix


def _load_user_voice_records(username: str) -> list[dict]:
    path = user_audio_voices_index_path(username)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(data, dict):
        records = data.get("voices", [])
    else:
        records = data
    if not isinstance(records, list):
        return []
    return [item for item in records if isinstance(item, dict)]


def _write_user_voice_records(username: str, records: list[dict]) -> None:
    path = user_audio_voices_index_path(username)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"voices": records}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _user_voice_abs_path(username: str, record: dict) -> Path:
    return Path(OUTPUT_DIR) / username / str(record.get("path") or "")


def public_user_voice_payload(username: str, record: dict) -> dict:
    voice_id = str(record.get("voice_id") or "")
    label = str(record.get("name") or record.get("label") or voice_id or "未命名音色")
    path = str(record.get("path") or "")
    abs_path = _user_voice_abs_path(username, record)
    exists = bool(path and abs_path.exists())
    return {
        "scope": USER_VOICE_SCOPE,
        "voice_id": voice_id,
        "label": label,
        "name": label,
        "path": path,
        "url": "",
        "exists": exists,
        "sha256": str(record.get("sha256") or ""),
        "duration_ms": int(record.get("duration_ms") or 0),
        "mime_type": str(record.get("mime_type") or ""),
        "created_at": str(record.get("created_at") or ""),
        "updated_at": str(record.get("updated_at") or ""),
        "source_filename": str(record.get("source_filename") or ""),
    }


def list_user_audio_voices(username: str) -> list[dict]:
    return [
        public_user_voice_payload(username, record) for record in _load_user_voice_records(username)
    ]


def create_user_audio_voice(
    *,
    username: str,
    name: str,
    filename: str | None,
    content: bytes,
    mime_type: str = "",
) -> dict:
    if not content:
        raise ValueError("voice audio file is empty")
    extension = _safe_extension(filename)
    voice_id = f"fv_{uuid.uuid4().hex[:16]}"
    rel_path = f"_account/freezone/audio/voices/{voice_id}/reference{extension}"
    abs_path = Path(OUTPUT_DIR) / username / rel_path
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(content)

    now = _utc_now()
    record = {
        "voice_id": voice_id,
        "name": _safe_voice_name(name),
        "path": rel_path,
        "sha256": file_sha256(abs_path),
        "duration_ms": _duration_ms(abs_path),
        "mime_type": mime_type or "application/octet-stream",
        "source_filename": Path(str(filename or "reference")).name,
        "created_at": now,
        "updated_at": now,
    }
    records = _load_user_voice_records(username)
    records.append(record)
    _write_user_voice_records(username, records)
    return public_user_voice_payload(username, record)


def resolve_user_audio_voice(username: str, voice_id: str) -> FreezoneVoiceRefResolution:
    target = str(voice_id or "").strip()
    if not target:
        raise RuntimeError("user_custom voice_id is required")
    for record in _load_user_voice_records(username):
        if str(record.get("voice_id") or "") != target:
            continue
        path = _user_voice_abs_path(username, record)
        if not path.exists():
            raise RuntimeError(f"用户音色文件不存在: {target}")
        sha = str(record.get("sha256") or "") or file_sha256(path)
        return FreezoneVoiceRefResolution(path, sha, USER_VOICE_SCOPE)
    raise RuntimeError(f"用户音色不存在: {target}")


def _duration_ms(audio_path: Path) -> int:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(audio_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return int(float(result.stdout.strip()) * 1000)
    except Exception:
        return 0


def _project_path(project_dir: Path, stored_path: str) -> Path | None:
    value = str(stored_path or "").strip()
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute():
        path = project_dir / path
    return path if path.exists() else None


async def _resolve_voice_ref(
    *,
    store,
    username: str,
    account_voice_username: str | None = None,
    project_dir: Path,
    voice_ref: dict | None,
) -> FreezoneVoiceRefResolution | None:
    if not isinstance(voice_ref, dict):
        return None

    scope = str(voice_ref.get("scope") or "").strip()
    character_name = str(voice_ref.get("character_name") or "").strip()
    identity_id = str(voice_ref.get("identity_id") or "").strip()
    slot = str(voice_ref.get("slot") or "").strip()

    if scope == USER_VOICE_SCOPE:
        return resolve_user_audio_voice(
            account_voice_username or username,
            str(voice_ref.get("voice_id") or ""),
        )

    characters = list(await store.list_characters())

    def _find_character():
        return next(
            (item for item in characters if str(getattr(item, "name", "") or "") == character_name),
            None,
        )

    if scope == "character_default":
        character = _find_character()
        path = _project_path(
            project_dir, getattr(character, "reference_audio_path", "") if character else ""
        )
        if path is None:
            raise RuntimeError(f"角色默认声线不可用: {character_name or '<空>'}")
        sha = str(getattr(character, "reference_audio_sha256", "") or "") or file_sha256(path)
        return FreezoneVoiceRefResolution(path, sha, "character_default")

    if scope == "character_age_group":
        character = _find_character()
        samples = getattr(character, "voice_samples_by_age_group", None) or {} if character else {}
        entry = samples.get(slot) if isinstance(samples, dict) else None
        path = _project_path(project_dir, entry.get("path", "") if isinstance(entry, dict) else "")
        if path is None:
            raise RuntimeError(f"角色年龄段声线不可用: {character_name or '<空>'}/{slot or '<空>'}")
        sha = str(entry.get("sha256", "") or "") if isinstance(entry, dict) else ""
        return FreezoneVoiceRefResolution(path, sha or file_sha256(path), "character_age_group")

    if scope in {"identity", "identity_resolved"}:
        character = _find_character()
        identity = None
        if character is not None:
            identity = next(
                (
                    item
                    for item in list(getattr(character, "identities", None) or [])
                    if str(getattr(item, "identity_id", "") or "") == identity_id
                ),
                None,
            )
        if character is None or identity is None:
            raise RuntimeError(
                f"身份声线不可用: {character_name or '<空>'}/{identity_id or '<空>'}"
            )
        if scope == "identity":
            path = _project_path(project_dir, getattr(identity, "reference_audio_path", ""))
            if path is None:
                raise RuntimeError(f"身份声线未配置: {identity_id}")
            sha = str(getattr(identity, "reference_audio_sha256", "") or "") or file_sha256(path)
            return FreezoneVoiceRefResolution(path, sha, "identity")
        resolved = resolve_character_voice(
            project_dir=project_dir,
            character=character,
            identity=identity,
        )
        if resolved.audio_path is None:
            raise RuntimeError(f"身份实际声线不可用: {identity_id}")
        return FreezoneVoiceRefResolution(
            resolved.audio_path,
            resolved.sha256 or file_sha256(resolved.audio_path),
            f"identity_resolved:{resolved.tier or 'unknown'}",
        )

    return None


async def generate_freezone_audio_speech(
    *,
    store,
    username: str,
    project: str,
    account_voice_username: str | None = None,
    project_dir: Path,
    job_id: str,
    text: str,
    emotion_prompt: str = "",
    voice_ref: dict | None = None,
) -> FreezoneAudioSpeechResult:
    """Generate standalone Freezone speech using the project narrator reference."""
    clean_text = str(text or "").strip()
    if not clean_text:
        raise ValueError("text is required")

    narration_style = load_effective_narration_style_for_voice(username, project)
    selected_voice = await _resolve_voice_ref(
        store=store,
        username=username,
        account_voice_username=account_voice_username,
        project_dir=project_dir,
        voice_ref=voice_ref,
    )
    if selected_voice is None:
        descriptor = load_narrator_reference_audio(username, project)
        characters = await store.list_characters() if narration_style == "first_person" else None
        voice = resolve_narrator_source(
            store=store,
            narration_style=narration_style,
            project_narrator_stored_path=descriptor.get("path", ""),
            characters=characters,
        )
        if voice.audio_path is None:
            raise RuntimeError(voice.error or "解说声线缺失")
        selected_voice = FreezoneVoiceRefResolution(
            voice.audio_path,
            voice.sha256,
            voice.source or "project_narrator",
        )

    output_path = freezone_audio_speech_output_path(project_dir, job_id)
    generator = IndexTTS2FalClient()
    result = await generator.generate(
        prompt=clean_text,
        audio_url=build_reference_audio_url(selected_voice.audio_path),
        output_path=output_path,
        emotion_prompt=str(emotion_prompt or "").strip() or narration_style_prompt(narration_style),
    )
    if not result.success:
        raise RuntimeError(result.error or "IndexTTS2 generation failed")

    duration_ms = int((result.duration_seconds or 0) * 1000) or _duration_ms(output_path)
    return FreezoneAudioSpeechResult(
        audio_path=output_path,
        duration_ms=duration_ms,
        mime_type="audio/mpeg",
        model=INDEXTTS2_RECORD_MODEL,
        voice_source=selected_voice.source,
        voice_sha256=selected_voice.sha256,
    )


def _newapi_audio_endpoint(base_url: str | None = None) -> str:
    from novelvideo.config import get_newapi_runtime_credentials

    _api_key, resolved_base_url = get_newapi_runtime_credentials(base_url_override=base_url)
    endpoint = str(resolved_base_url or "http://localhost:3000/v1").rstrip("/")
    if not endpoint.endswith("/audio/speech"):
        endpoint = f"{endpoint}/audio/speech"
    return endpoint


def _audio_mime_type(response_format: str) -> str:
    fmt = str(response_format or "mp3").strip().lower()
    return {
        "mp3": "audio/mpeg",
        "opus": "audio/opus",
        "pcm": "audio/L16",
        "ulaw": "audio/basic",
        "alaw": "audio/x-alaw-basic",
    }.get(fmt, "audio/mpeg")


def _audio_suffix(response_format: str) -> str:
    fmt = str(response_format or "mp3").strip().lower()
    return {
        "mp3": ".mp3",
        "opus": ".opus",
        "pcm": ".pcm",
        "ulaw": ".ulaw",
        "alaw": ".alaw",
    }.get(fmt, ".mp3")


async def _write_newapi_audio_speech(
    *,
    output_path: Path,
    model: str,
    input_text: str,
    response_format: str = "mp3",
    voice: str | None = None,
    metadata: dict[str, Any] | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    timeout_seconds: float = 600.0,
) -> None:
    import base64

    import httpx

    from novelvideo.config import get_newapi_runtime_credentials

    key, resolved_base_url = get_newapi_runtime_credentials(
        api_key_override=api_key,
        base_url_override=base_url,
    )
    key = str(key or "").strip()
    if not key:
        raise RuntimeError("NEWAPI_API_KEY is required for NewAPI audio generation")

    body: dict[str, Any] = {
        "model": str(model or "").strip(),
        "input": str(input_text or ""),
        "response_format": str(response_format or "mp3").strip() or "mp3",
    }
    clean_voice = str(voice or "").strip()
    if clean_voice:
        body["voice"] = clean_voice
    if metadata:
        body["metadata"] = metadata

    output_path.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=True) as client:
        endpoint = _newapi_audio_endpoint(resolved_base_url)
        response = await client.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            response_headers = getattr(exc.response, "headers", {}) or {}
            request_id = (
                response_headers.get("x-request-id")
                or response_headers.get("x-newapi-request-id")
                or response_headers.get("x-oneapi-request-id")
                or ""
            )
            safe_context = {
                "endpoint": endpoint,
                "model": body.get("model"),
                "response_format": body.get("response_format"),
                "voice": body.get("voice", ""),
                "input_chars": len(str(body.get("input") or "")),
                "metadata_keys": sorted((body.get("metadata") or {}).keys()),
                "request_id": request_id,
            }
            response_body = str(getattr(exc.response, "text", "") or "")[:2000]
            raise RuntimeError(
                "NewAPI audio request failed: "
                f"HTTP {exc.response.status_code}; "
                f"context={json.dumps(safe_context, ensure_ascii=False)}; "
                f"body={response_body}"
            ) from exc
        content_type = str(response.headers.get("content-type") or "").lower()
        if "application/json" not in content_type:
            output_path.write_bytes(response.content)
            return

        payload = response.json()
        audio = payload.get("audio") if isinstance(payload.get("audio"), dict) else {}
        result_url = str(
            payload.get("url")
            or payload.get("audio_url")
            or payload.get("audioUrl")
            or audio.get("url")
            or ""
        ).strip()
        if not result_url:
            data = payload.get("data")
            if isinstance(data, list) and data and isinstance(data[0], dict):
                first = data[0]
                result_url = str(
                    first.get("url") or first.get("audio_url") or first.get("audioUrl") or ""
                ).strip()
                audio_b64 = str(first.get("b64_json") or first.get("audio") or "").strip()
            else:
                audio_b64 = str(payload.get("b64_json") or payload.get("audio") or "").strip()
            if audio_b64:
                if audio_b64.startswith("data:") and "," in audio_b64:
                    audio_b64 = audio_b64.split(",", 1)[1]
                output_path.write_bytes(base64.b64decode(audio_b64))
                return
        if not result_url:
            raise RuntimeError("NewAPI audio response missing audio bytes or URL")

        audio_response = await client.get(result_url)
        audio_response.raise_for_status()
        output_path.write_bytes(audio_response.content)


async def generate_freezone_audio_eleven_music(
    *,
    project_dir: Path,
    job_id: str,
    prompt: str,
    music_length_ms: int = 30_000,
    force_instrumental: bool = True,
    respect_sections_durations: bool = True,
    output_format: str = "mp3_44100_128",
    response_format: str = "mp3",
    model: str = "LingShan-MU-11",
) -> FreezoneAudioSpeechResult:
    """Generate standalone Freezone music through NewAPI's audio/speech endpoint."""
    clean_prompt = str(prompt or "").strip()
    if not clean_prompt:
        raise ValueError("prompt is required")
    length = int(music_length_ms or 0)
    if length < 3_000 or length > 600_000:
        raise ValueError("music_length_ms must be between 3000 and 600000")

    fmt = str(response_format or "mp3").strip() or "mp3"
    output_path = freezone_audio_eleven_music_output_path(project_dir, job_id)
    if _audio_suffix(fmt) != ".mp3":
        output_path = output_path.with_suffix(_audio_suffix(fmt))

    metadata: dict[str, Any] = {
        "music_length_ms": length,
        "force_instrumental": bool(force_instrumental),
        "respect_sections_durations": bool(respect_sections_durations),
        "output_format": str(output_format or "mp3_44100_128").strip() or "mp3_44100_128",
    }

    model_name = str(model or "LingShan-MU-11").strip() or "LingShan-MU-11"
    reservation_id = ""
    try:
        reservation_id = await _reserve_music_model_call(
            model_name,
            music_length_ms=length,
            source="freezone_audio_music",
        )
        await _write_newapi_audio_speech(
            output_path=output_path,
            model=model_name,
            input_text=clean_prompt,
            response_format=fmt,
            metadata=metadata,
            timeout_seconds=900.0,
        )
        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise RuntimeError("NewAPI music audio file was not created")
        await _confirm_music_model_call(model=model_name, reservation_id=reservation_id)
    except Exception as exc:
        await _refund_music_model_call(
            reservation_id,
            source="freezone_audio_music",
            error=type(exc).__name__,
        )
        raise
    return FreezoneAudioSpeechResult(
        audio_path=output_path,
        duration_ms=_duration_ms(output_path) or length,
        mime_type=_audio_mime_type(fmt),
        model=model_name,
        voice_source=model_name,
        voice_sha256="",
    )
