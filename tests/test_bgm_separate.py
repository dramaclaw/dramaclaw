"""音乐维度：人声分离，以及「没配 demucs 就诚实降级」这条路。"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from novelvideo.freezone import bgm_separate


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv(bgm_separate.DEMUCS_PYTHON_ENV, raising=False)


def test_missing_demucs_is_not_an_error_but_a_declared_downgrade(tmp_path, monkeypatch):
    """没配就降级，但 mode 必须说实话——悄悄降级比报错更糟。"""
    monkeypatch.setattr(bgm_separate.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    async def fake_extract(source_path, target):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x")

    monkeypatch.setattr(bgm_separate, "_extract_full_track", fake_extract)
    result = asyncio.run(
        bgm_separate.run_freezone_bgm_separate(
            project_dir=tmp_path, job_id="j1", source_path="/tmp/in.mp4"
        )
    )
    assert result["mode"] == bgm_separate.MODE_FULL_TRACK
    assert Path(str(result["audio_path"])).is_file()


def test_a_configured_but_missing_interpreter_is_reported_not_downgraded(monkeypatch, tmp_path):
    """配了却指向不存在的解释器是配置错误，静默降级会让运维以为分离在跑。"""
    monkeypatch.setenv(bgm_separate.DEMUCS_PYTHON_ENV, str(tmp_path / "nope"))
    monkeypatch.setattr(bgm_separate.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    with pytest.raises(RuntimeError, match=bgm_separate.DEMUCS_PYTHON_ENV):
        asyncio.run(
            bgm_separate.run_freezone_bgm_separate(
                project_dir=tmp_path, job_id="j1", source_path="/tmp/in.mp4"
            )
        )


def test_missing_ffmpeg_fails_loudly(monkeypatch, tmp_path):
    monkeypatch.setattr(bgm_separate.shutil, "which", lambda _name: None)
    with pytest.raises(RuntimeError, match="ffmpeg"):
        asyncio.run(
            bgm_separate.run_freezone_bgm_separate(
                project_dir=tmp_path, job_id="j1", source_path="/tmp/in.mp4"
            )
        )


def test_find_stem_does_not_assume_demucs_output_depth(tmp_path):
    """demucs 的落盘层级随版本/参数变化，写死路径等于赌它不变。"""
    nested = tmp_path / "htdemucs" / "clip"
    nested.mkdir(parents=True)
    (nested / "no_vocals.mp3").write_bytes(b"x")
    found = bgm_separate._find_stem(tmp_path, "no_vocals")
    assert found is not None and found.name == "no_vocals.mp3"
    assert bgm_separate._find_stem(tmp_path, "vocals") is None


def test_find_stem_prefers_a_direct_hit(tmp_path):
    (tmp_path / "vocals.mp3").write_bytes(b"x")
    (tmp_path / "deep").mkdir()
    (tmp_path / "deep" / "vocals.mp3").write_bytes(b"y")
    assert bgm_separate._find_stem(tmp_path, "vocals") == tmp_path / "vocals.mp3"
