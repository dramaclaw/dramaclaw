"""Tests for novelvideo.seedance2_i2v.character_voice_storage."""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.seedance2_i2v.character_voice_storage import (
    AGE_GROUP_SLOTS,
    DEFAULT_SLOT,
    character_voice_path,
    clear_character_voice_file,
    is_supported_voice_sample,
    persist_character_voice_file,
)


def test_character_voice_path_routes_default_and_age_groups(tmp_path):
    base = character_voice_path(
        project_dir=tmp_path,
        character_name="男主",
        slot=DEFAULT_SLOT,
        filename="sample.mp3",
    )
    assert base.name == "voice_default.mp3"
    assert "characters/男主/voices" in base.as_posix()

    elder = character_voice_path(
        project_dir=tmp_path,
        character_name="男主",
        slot="elder",
        filename="x.wav",
    )
    assert elder.name == "voice_elder.wav"
    assert elder.parent == base.parent


def test_character_voice_path_rejects_unknown_slot(tmp_path):
    with pytest.raises(ValueError):
        character_voice_path(
            project_dir=tmp_path,
            character_name="X",
            slot="teen",
            filename="x.wav",
        )


def test_persist_character_voice_writes_file_and_returns_metadata(tmp_path):
    rel, sha, ts = persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot=DEFAULT_SLOT,
        filename="upload.mp3",
        content=b"audio-bytes",
    )
    target = Path(tmp_path) / rel
    assert target.exists()
    assert target.read_bytes() == b"audio-bytes"
    assert len(sha) == 64
    assert ts


def test_persist_character_voice_archives_prior_file(tmp_path):
    persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="elder",
        filename="v1.mp3",
        content=b"v1",
    )
    rel2, _sha, _ts = persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="elder",
        filename="v2.wav",
        content=b"v2",
    )
    voices_dir = Path(tmp_path) / "assets" / "characters" / "男主" / "voices"
    current = Path(tmp_path) / rel2
    assert current.exists() and current.read_bytes() == b"v2"
    archived = [
        p
        for p in voices_dir.iterdir()
        if p.is_file() and p.name.startswith("voice_elder_") and p != current
    ]
    assert archived, "prior voice should be archived under a timestamped name"


def test_clear_character_voice_archives_existing(tmp_path):
    persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="youth",
        filename="v.mp3",
        content=b"v",
    )
    assert clear_character_voice_file(project_dir=tmp_path, character_name="男主", slot="youth")
    voices_dir = Path(tmp_path) / "assets" / "characters" / "男主" / "voices"
    assert not (voices_dir / "voice_youth.mp3").exists()
    assert any(p.name.startswith("voice_youth_") for p in voices_dir.iterdir())


def test_persist_rejects_unsupported_extension(tmp_path):
    with pytest.raises(ValueError):
        persist_character_voice_file(
            project_dir=tmp_path,
            character_name="X",
            slot=DEFAULT_SLOT,
            filename="bad.txt",
            content=b"x",
        )


def test_is_supported_voice_sample():
    assert is_supported_voice_sample("a.mp3")
    assert is_supported_voice_sample("a.WAV")
    assert not is_supported_voice_sample("a.txt")


def test_age_group_slots_cover_known_values():
    assert set(AGE_GROUP_SLOTS) == {"child", "youth", "middle", "elder"}


def test_probe_voice_sample_duration_times_out_as_value_error(monkeypatch, tmp_path):
    """ffprobe 卡住必须限时并转成 ValueError。

    这个函数现在挂在同步请求路径上（freezone omni-gen 的音频时长兜底），入参是用户
    上传的文件。没有 timeout 的话一个畸形容器就能吊死 HTTP 请求并占死线程池 worker；
    漏出 TimeoutExpired 则会让只 catch ValueError 的调用方变成 500 而不是「测不出」。
    """
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v import character_voice_storage

    sample = tmp_path / "hang.wav"
    sample.write_bytes(b"RIFF----WAVEfmt ")

    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/ffprobe")

    seen: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        seen.update(kwargs)
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(ValueError, match="超时"):
        character_voice_storage.probe_voice_sample_duration_seconds(sample)
    assert seen["timeout"] == character_voice_storage.PROBE_DURATION_TIMEOUT_SECONDS


def test_trim_voice_sample_content_outputs_seedance2_ready_clip(tmp_path):
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v.character_voice_storage import (
        probe_voice_sample_duration_seconds,
        trim_voice_sample_content,
    )

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg/ffprobe required for audio trimming")

    source = tmp_path / "source.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=8",
            str(source),
        ],
        check=True,
    )

    content, filename = trim_voice_sample_content(
        source.read_bytes(),
        filename="source.wav",
        start_seconds=1.0,
        duration_seconds=4.0,
    )
    assert filename == "voice_trimmed.mp3"

    trimmed = tmp_path / filename
    trimmed.write_bytes(content)
    duration = probe_voice_sample_duration_seconds(trimmed)
    assert 3.8 <= duration <= 4.2


def test_trim_existing_character_voice_file_rewrites_slot_with_short_clip(tmp_path):
    import shutil
    import subprocess

    from novelvideo.seedance2_i2v.character_voice_storage import (
        probe_voice_sample_duration_seconds,
        trim_existing_character_voice_file,
    )

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg/ffprobe required for audio trimming")

    source = tmp_path / "source.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=8",
            str(source),
        ],
        check=True,
    )

    persist_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="default",
        filename="source.wav",
        content=source.read_bytes(),
    )

    rel_path, sha, ts = trim_existing_character_voice_file(
        project_dir=tmp_path,
        character_name="男主",
        slot="default",
        source_path="assets/characters/男主/voices/voice_default.wav",
        start_seconds=2.0,
        duration_seconds=4.0,
    )

    assert rel_path == "assets/characters/男主/voices/voice_default.mp3"
    assert sha
    assert ts
    trimmed_path = tmp_path / rel_path
    assert trimmed_path.exists()
    assert 3.8 <= probe_voice_sample_duration_seconds(trimmed_path) <= 4.2
    archived = [
        path
        for path in trimmed_path.parent.iterdir()
        if path.name.startswith("voice_default_") and path.suffix == ".wav"
    ]
    assert archived
