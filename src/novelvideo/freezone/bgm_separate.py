"""逐帧拉片的音乐维度：从参考视频里取出「只剩伴奏」的那一轨。

## 为什么不是直接抽音轨

抽整条音轨拿到的是「对白 + 音效 + 配乐」。作为配乐参考它是废的——铺到新片上
会把原片的台词一起铺过去。LibTV 那边实测出来的参数是 `mode: bgm_only`，
即人声分离后只留伴奏。

## 为什么允许降级，而不是没装就报错

分离要跑 demucs（torch 起步几个 G），而拉片的另外两个维度（分镜、动态）只要
ffmpeg。没配 demucs 就整个维度不可用，等于逼所有人为一个可选维度装 torch。
所以这里降级成整轨提取，**并把降级如实写进返回值**（`mode`）——调用方据此改
节点名，用户一眼看得出手里这条是伴奏还是原声，不会拿错。

悄悄降级比报错更糟，所以 `mode` 是必返字段，不是可选的。
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

from novelvideo.freezone.paths import outputs_dir

#: demucs 所在的解释器。和 `ST_DA3_PYTHON` 同样是运维配置，永远不来自用户输入。
DEMUCS_PYTHON_ENV = "ST_DEMUCS_PYTHON"
#: 分离模型名。htdemucs 是 demucs v4 的默认模型，两轨模式够用且最快。
DEMUCS_MODEL = "htdemucs"

MODE_BGM_ONLY = "bgm_only"
MODE_FULL_TRACK = "full_track"


def _demucs_interpreter() -> str | None:
    configured = os.environ.get(DEMUCS_PYTHON_ENV, "").strip()
    if not configured:
        return None
    if not Path(configured).is_file():
        # 配了但指向不存在的解释器是配置错误，不是「没装」——这种要说出来，
        # 否则运维会以为分离在跑，其实一直在降级。
        raise RuntimeError(f"{DEMUCS_PYTHON_ENV} 指向的 Python 解释器不存在：{configured}")
    return configured


def _find_stem(root: Path, stem: str) -> Path | None:
    """在 demucs 的输出目录里找某一轨，不假设它落在哪一层。"""
    for suffix in (".mp3", ".wav", ".flac"):
        direct = root / f"{stem}{suffix}"
        if direct.is_file():
            return direct
    matches = sorted(
        path
        for suffix in (".mp3", ".wav", ".flac")
        for path in root.rglob(f"{stem}{suffix}")
        if path.is_file()
    )
    return matches[0] if matches else None


async def _extract_full_track(source_path: str, target: Path) -> None:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", source_path, "-vn", "-c:a", "aac", "-b:a", "192k", str(target),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _out, err = await proc.communicate()
    if proc.returncode != 0 or not target.exists():
        raise RuntimeError((err or b"").decode("utf-8", "replace")[-500:] or "音轨提取失败")


async def run_freezone_bgm_separate(
    *, project_dir: Path, job_id: str, source_path: str
) -> dict[str, object]:
    """返回 `{"audio_path": Path, "mode": "bgm_only" | "full_track"}`。"""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH; install via brew/apt")

    output_dir = outputs_dir(project_dir, "freezone_bgm_separate") / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    interpreter = _demucs_interpreter()
    if interpreter is None:
        target = output_dir / "full_track.m4a"
        await _extract_full_track(source_path, target)
        return {"audio_path": target, "mode": MODE_FULL_TRACK}

    # `--two-stems=vocals` 只分人声/其余两轨，比四轨快一倍多，而我们只要 `no_vocals`。
    proc = await asyncio.create_subprocess_exec(
        interpreter,
        "-m", "demucs",
        "--two-stems=vocals",
        "-n", DEMUCS_MODEL,
        "--mp3",
        "-o", str(output_dir),
        "--filename", "{stem}.{ext}",
        source_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _stdout, stderr = await proc.communicate()
    except asyncio.CancelledError:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        raise

    # 用递归查找而不是拼死路径：demucs 的落盘位置随 `-o` / `--filename` / 模型名
    # 组合变化（有的版本会多一层 `<模型名>/` 目录），写死一个路径等于赌它不变。
    separated = _find_stem(output_dir, "no_vocals")
    vocals = _find_stem(output_dir, "vocals")
    if proc.returncode != 0 or separated is None:
        # 分离失败不该让整个拉片任务挂掉——分镜和动态两个维度已经产出来了。
        # 降级并如实上报，理由同模块头。
        target = output_dir / "full_track.m4a"
        await _extract_full_track(source_path, target)
        return {
            "audio_path": target,
            "mode": MODE_FULL_TRACK,
            "fallback_reason": (stderr or b"").decode("utf-8", "replace")[-300:],
        }
    result: dict[str, object] = {"audio_path": separated, "mode": MODE_BGM_ONLY}
    # 人声轨是同一次分离的副产物，文件本来就已经写出来了——不返回等于白跑一遍。
    if vocals is not None:
        result["vocals_path"] = vocals
    return result
