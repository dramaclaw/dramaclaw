"""Storage helpers for character-level IndexTTS2 reference audio.

Writes voice sample files under ``assets/characters/{char}/voices/`` and returns
the metadata required by ``NovelCharacter.reference_audio_*`` /
``voice_samples_by_age_group``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

VOICE_SAMPLE_EXTENSIONS = (".mp3", ".wav", ".m4a", ".aac", ".ogg")
DEFAULT_SLOT = "default"
AGE_GROUP_SLOTS = ("child", "youth", "middle", "elder")
ALL_SLOTS = (DEFAULT_SLOT, *AGE_GROUP_SLOTS)

RECORDED_AUDIO_EXTENSION_BY_MIME = {
    "audio/webm": ".webm",
    "audio/webm;codecs=opus": ".webm",
    "audio/ogg": ".ogg",
    "audio/ogg;codecs=opus": ".ogg",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}


def decode_recorded_audio_data_url(data_url: str) -> tuple[bytes, str]:
    """Decode a browser MediaRecorder data URL into (content, extension).

    Outputs are always re-encoded into a fal-compatible format. Browser
    MediaRecorder defaults to webm/opus which IndexTTS2 (fal) rejects, so
    anything not already in :data:`VOICE_SAMPLE_EXTENSIONS` is transcoded to
    mp3 via ffmpeg.
    """
    prefix, separator, payload = str(data_url or "").partition(",")
    if not separator or not prefix.startswith("data:") or ";base64" not in prefix:
        raise ValueError("录音数据格式不正确")
    mime_type = prefix[5:].split(";", 1)[0].lower()
    extension = RECORDED_AUDIO_EXTENSION_BY_MIME.get(mime_type, ".webm")
    try:
        content = base64.b64decode(payload, validate=True)
    except binascii.Error as exc:
        raise ValueError("录音数据不是有效的 base64") from exc
    if not content:
        raise ValueError("录音数据为空")
    if extension not in VOICE_SAMPLE_EXTENSIONS:
        content = _transcode_to_mp3(content)
        extension = ".mp3"
    return content, extension


def _transcode_to_mp3(content: bytes) -> bytes:
    """Pipe *content* through ffmpeg and return mp3 bytes."""
    if not shutil.which("ffmpeg"):
        raise ValueError("系统未安装 ffmpeg，无法转码录音为 mp3")
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-vn",
                "-acodec",
                "libmp3lame",
                "-b:a",
                "128k",
                "-f",
                "mp3",
                "pipe:1",
            ],
            input=content,
            capture_output=True,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", "ignore").strip()
        raise ValueError(f"ffmpeg 转码失败：{stderr or exc}") from exc
    if not result.stdout:
        raise ValueError("ffmpeg 转码后输出为空")
    return result.stdout


def probe_voice_sample_duration_seconds(path: str | Path) -> float:
    """Return audio duration in seconds using ffprobe."""

    if not shutil.which("ffprobe"):
        raise ValueError("系统未安装 ffprobe，无法读取音频时长")
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        duration = float((result.stdout or "").strip())
    except (TypeError, ValueError) as exc:
        stderr = (result.stderr or "").strip()
        raise ValueError(f"无法读取音频时长：{stderr or path}") from exc
    if duration <= 0:
        raise ValueError("音频时长无效")
    return duration


def trim_voice_sample_content(
    content: bytes,
    *,
    filename: str,
    start_seconds: float = 0.0,
    duration_seconds: float = 4.0,
) -> tuple[bytes, str]:
    """Trim uploaded/recorded voice content to a Seedance2-friendly MP3 clip."""

    if not content:
        raise ValueError("音频内容为空")
    if not is_supported_voice_sample(filename):
        raise ValueError("仅支持 mp3 / wav / m4a / aac / ogg")
    if not shutil.which("ffmpeg"):
        raise ValueError("系统未安装 ffmpeg，无法裁剪声线")
    try:
        start = max(0.0, float(start_seconds))
        duration = float(duration_seconds)
    except (TypeError, ValueError) as exc:
        raise ValueError("裁剪时间参数无效") from exc
    if duration <= 0:
        raise ValueError("裁剪时长必须大于 0 秒")
    if duration > 15:
        raise ValueError("Seedance2 参考声线单段最长 15 秒")

    suffix = voice_sample_extension(filename)
    with tempfile.TemporaryDirectory() as tmp:
        input_path = Path(tmp) / f"input{suffix}"
        output_path = Path(tmp) / "voice_trimmed.mp3"
        input_path.write_bytes(content)
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{start:.3f}",
                    "-t",
                    f"{duration:.3f}",
                    "-i",
                    str(input_path),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-acodec",
                    "libmp3lame",
                    "-b:a",
                    "64k",
                    str(output_path),
                ],
                capture_output=True,
                check=True,
            )
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or b"").decode("utf-8", "ignore").strip()
            raise ValueError(f"ffmpeg 裁剪失败：{stderr or exc}") from exc
        output = output_path.read_bytes() if output_path.exists() else b""
        if not output:
            raise ValueError("ffmpeg 裁剪后输出为空")
        return output, "voice_trimmed.mp3"


def voice_recorder_bootstrap_js(recorder_key: str) -> str:
    """Return the JS payload that primes a MediaRecorder under ``recorder_key``."""
    key = json.dumps(recorder_key)
    return f"""
    (() => {{
      window.__characterVoiceRecorders = window.__characterVoiceRecorders || {{}};
      window.__characterVoiceRecorders[{key}] = {{
        stream: null,
        recorder: null,
        chunks: [],
        startedAt: 0,
        async start() {{
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {{
            throw new Error('当前浏览器不支持麦克风录音');
          }}
          if (typeof MediaRecorder === 'undefined') {{
            throw new Error('当前浏览器不支持 MediaRecorder');
          }}
          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
          this.stream = await navigator.mediaDevices.getUserMedia({{ audio: true }});
          this.chunks = [];
          this.recorder = new MediaRecorder(
            this.stream,
            mimeType ? {{ mimeType }} : undefined
          );
          this.recorder.ondataavailable = event => {{
            if (event.data && event.data.size > 0) this.chunks.push(event.data);
          }};
          this.recorder.start();
          this.startedAt = Date.now();
          return true;
        }},
        async stop() {{
          const recorder = this.recorder;
          if (!recorder) throw new Error('尚未开始录音');
          const chunks = this.chunks;
          const mimeType = recorder.mimeType || 'audio/webm';
          const durationMs = Date.now() - this.startedAt;
          const result = await new Promise((resolve, reject) => {{
            recorder.onstop = () => {{
              const blob = new Blob(chunks, {{ type: mimeType }});
              const reader = new FileReader();
              reader.onload = () => resolve({{
                dataUrl: reader.result,
                durationMs,
                mimeType,
              }});
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            }};
            recorder.stop();
          }});
          if (this.stream) this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
          this.recorder = null;
          this.chunks = [];
          return result;
        }},
        cancel() {{
          if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
          if (this.stream) this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
          this.recorder = null;
          this.chunks = [];
        }},
      }};
    }})()
    """


def _safe_asset_name(value: str) -> str:
    return re.sub(r'[/\\:*?"<>|]', "_", str(value or "").strip())


def voice_sample_extension(filename: str) -> str:
    ext = Path(str(filename or "")).suffix.lower()
    return ext if ext in VOICE_SAMPLE_EXTENSIONS else ".wav"


def is_supported_voice_sample(filename: str) -> bool:
    return Path(str(filename or "")).suffix.lower() in VOICE_SAMPLE_EXTENSIONS


def character_voice_path(
    *,
    project_dir: str | Path,
    character_name: str,
    slot: str,
    filename: str,
) -> Path:
    """Return the on-disk path for a character voice slot.

    ``slot="default"`` → ``voice_default{ext}``; age-group slot → ``voice_{slot}{ext}``.
    """
    if slot not in ALL_SLOTS:
        raise ValueError(f"Unsupported voice slot: {slot}")
    safe_char = _safe_asset_name(character_name)
    if not safe_char:
        raise ValueError("character_name cannot be empty")
    ext = voice_sample_extension(filename)
    voices_dir = Path(project_dir) / "assets" / "characters" / safe_char / "voices"
    stem = "voice_default" if slot == DEFAULT_SLOT else f"voice_{slot}"
    return voices_dir / f"{stem}{ext}"


def voice_content_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def project_relative_path(project_dir: str | Path, path: str | Path) -> str:
    return Path(path).resolve().relative_to(Path(project_dir).resolve()).as_posix()


def persist_character_voice_file(
    *,
    project_dir: str | Path,
    character_name: str,
    slot: str,
    filename: str,
    content: bytes,
) -> tuple[str, str, str]:
    """Write *content* to the slot and return (rel_path, sha256, updated_at).

    Existing files in any of the supported extensions for the same slot are
    archived (renamed with a timestamp suffix) so the resolver only ever sees
    the freshly written file.
    """
    if not is_supported_voice_sample(filename):
        raise ValueError("仅支持 mp3 / wav / m4a / aac / ogg")
    if not content:
        raise ValueError("音频文件为空")

    target = character_voice_path(
        project_dir=project_dir,
        character_name=character_name,
        slot=slot,
        filename=filename,
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    ts = int(datetime.now(timezone.utc).timestamp())
    for ext in VOICE_SAMPLE_EXTENSIONS:
        sibling = target.with_suffix(ext)
        if sibling.exists():
            backup_name = f"{sibling.stem}_{ts}{sibling.suffix}"
            sibling.replace(sibling.with_name(backup_name))
    target.write_bytes(content)

    rel_path = project_relative_path(project_dir, target)
    return rel_path, voice_content_sha256(content), utc_now_iso()


def trim_existing_character_voice_file(
    *,
    project_dir: str | Path,
    character_name: str,
    slot: str,
    source_path: str | Path,
    start_seconds: float = 0.0,
    duration_seconds: float = 4.0,
) -> tuple[str, str, str]:
    """Trim an already configured voice file and write it back to the same slot."""

    source = Path(source_path)
    if not source.is_absolute():
        source = Path(project_dir) / source
    if not source.exists():
        raise ValueError(f"声线文件不存在：{source_path}")

    content, filename = trim_voice_sample_content(
        source.read_bytes(),
        filename=source.name,
        start_seconds=start_seconds,
        duration_seconds=duration_seconds,
    )
    return persist_character_voice_file(
        project_dir=project_dir,
        character_name=character_name,
        slot=slot,
        filename=filename,
        content=content,
    )


def clear_character_voice_file(
    *,
    project_dir: str | Path,
    character_name: str,
    slot: str,
) -> bool:
    """Archive any existing voice file for the slot. Returns True if anything was removed."""
    safe_char = _safe_asset_name(character_name)
    if not safe_char:
        return False
    voices_dir = Path(project_dir) / "assets" / "characters" / safe_char / "voices"
    if not voices_dir.exists():
        return False
    stem = "voice_default" if slot == DEFAULT_SLOT else f"voice_{slot}"
    ts = int(datetime.now(timezone.utc).timestamp())
    removed = False
    for ext in VOICE_SAMPLE_EXTENSIONS:
        candidate = voices_dir / f"{stem}{ext}"
        if candidate.exists():
            candidate.replace(candidate.with_name(f"{candidate.stem}_{ts}{candidate.suffix}"))
            removed = True
    return removed
