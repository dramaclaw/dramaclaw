"""Project-local Depth Anything 3 video task (optional, isolated runtime)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from novelvideo.freezone.paths import outputs_dir


async def run_freezone_depth_motion_capture(
    *, project_dir: Path, job_id: str, source_path: str, resolution: str
) -> tuple[Path, dict]:
    """Run DA3 in a separate interpreter; cancel the child when the task is cancelled.

    The model location/interpreter are operator configuration, never user input.
    No model download or remote request is performed by a job.
    """
    model_dir = os.environ.get("ST_DA3_MODEL_DIR", "").strip()
    if not model_dir or not Path(model_dir).is_dir():
        raise RuntimeError("Depth Anything 3 未配置：请设置 ST_DA3_MODEL_DIR 为本地 DA3-SMALL 模型目录")
    if not all((Path(model_dir) / name).is_file()
               for name in ("config.json", "model.safetensors")):
        raise RuntimeError("ST_DA3_MODEL_DIR 必须包含 DA3-SMALL 的 config.json 与 model.safetensors")
    interpreter = os.environ.get("ST_DA3_PYTHON", sys.executable)
    if not Path(interpreter).is_file():
        raise RuntimeError("ST_DA3_PYTHON 指向的 Python 解释器不存在")
    output_dir = outputs_dir(project_dir, "freezone_depth_motion")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{job_id}.mp4"
    metadata_path = output_path.with_suffix(".json")
    package_root = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(package_root), env.get("PYTHONPATH", "")) if part
    )
    proc = await asyncio.create_subprocess_exec(
        interpreter,
        "-m",
        "novelvideo.freezone.depth_motion_worker",
        "--source", source_path,
        "--output", str(output_path),
        "--model-dir", model_dir,
        "--resolution", resolution,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
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
    if proc.returncode != 0:
        raise RuntimeError(
            "Depth Anything 3 推理失败：" + stderr.decode("utf-8", "replace")[-1200:]
        )
    if not output_path.is_file() or not metadata_path.is_file():
        raise RuntimeError("Depth Anything 3 任务未生成完整的视频和元数据")
    return output_path, json.loads(metadata_path.read_text(encoding="utf-8"))
