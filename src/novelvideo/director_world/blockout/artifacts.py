"""What one blockout generation run produces, and how it is written to disk.

Kept apart from `generation_agent`, which is the network leaf: the task runner
imports the writers and the error type from here, so nothing but the leaf itself
comes out of the leaf module.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from novelvideo.director_world.blockout.prompts import BLOCKOUT_PROMPT_VERSION
from novelvideo.director_world.blockout.scene_ir import (
    BLOCKOUT_COMPILER_VERSION,
    SceneIR,
)

# 不用 `.py`：失败的任务会把模型写的东西原样留在这里，里面可能有 import。
# 这份文本只给解析器读，扩展名不该暗示它可以被运行。
PROGRAM_FILENAME = "scene.blockout.dsl"
SCENE_IR_FILENAME = "scene_ir.json"
GENERATION_FILENAME = "generation.json"
RESULT_FILENAME = "result.json"


@dataclass(frozen=True)
class BlockoutAttempt:
    program: str
    errors: tuple[str, ...]
    seconds: float


@dataclass(frozen=True)
class BlockoutGeneration:
    model: str
    program: str
    scene: SceneIR
    compiled: dict[str, Any]
    warnings: tuple[str, ...]
    attempts: tuple[BlockoutAttempt, ...]
    image_sha256: str
    image_size: tuple[int, int]
    picture_check: bool = False


class BlockoutGenerationError(RuntimeError):
    """No usable scene came out. Carries what was tried, for the artifacts."""

    def __init__(
        self,
        message: str,
        *,
        model: str,
        attempts: tuple[BlockoutAttempt, ...],
        image_sha256: str,
        image_size: tuple[int, int],
    ) -> None:
        super().__init__(message)
        self.model = model
        self.attempts = attempts
        self.image_sha256 = image_sha256
        self.image_size = image_size


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _generation_record(
    *,
    model: str,
    attempts: tuple[BlockoutAttempt, ...],
    image_sha256: str,
    image_size: tuple[int, int],
    error: str | None,
    picture_check: bool = False,
) -> dict[str, Any]:
    return {
        "model": model,
        "prompt_version": BLOCKOUT_PROMPT_VERSION,
        "picture_check": picture_check,
        "compiler_version": BLOCKOUT_COMPILER_VERSION,
        "image": {
            "sha256": image_sha256,
            "sent_width": image_size[0],
            "sent_height": image_size[1],
        },
        "retries": max(len(attempts) - 1, 0),
        "seconds": round(sum(attempt.seconds for attempt in attempts), 3),
        "attempts": [
            {
                "program": attempt.program,
                "errors": list(attempt.errors),
                "seconds": attempt.seconds,
            }
            for attempt in attempts
        ],
        "error": error,
    }


def write_blockout_artifacts(
    out_dir: Path, generation: BlockoutGeneration
) -> dict[str, Any]:
    """Write the four files of a finished job and return the result payload."""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / PROGRAM_FILENAME).write_text(
        generation.program + "\n", encoding="utf-8"
    )
    _write_json(out_dir / SCENE_IR_FILENAME, generation.scene.model_dump(mode="json"))
    _write_json(
        out_dir / GENERATION_FILENAME,
        _generation_record(
            model=generation.model,
            attempts=generation.attempts,
            image_sha256=generation.image_sha256,
            image_size=generation.image_size,
            error=None,
            picture_check=generation.picture_check,
        ),
    )
    result = {
        "objects": generation.compiled["objects"],
        "reference_camera_id": generation.compiled["reference_camera_id"],
        "counts": generation.compiled["counts"],
        "warnings": list(generation.warnings),
        "compiler_version": BLOCKOUT_COMPILER_VERSION,
    }
    _write_json(out_dir / RESULT_FILENAME, result)
    return result


def write_blockout_failure_artifacts(
    out_dir: Path, error: BlockoutGenerationError
) -> None:
    """Keep the last program and every error so a failed job can be diagnosed."""
    out_dir.mkdir(parents=True, exist_ok=True)
    if error.attempts:
        (out_dir / PROGRAM_FILENAME).write_text(
            error.attempts[-1].program + "\n", encoding="utf-8"
        )
    _write_json(
        out_dir / GENERATION_FILENAME,
        _generation_record(
            model=error.model,
            attempts=error.attempts,
            image_sha256=error.image_sha256,
            image_size=error.image_size,
            error=str(error),
        ),
    )
