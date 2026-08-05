"""连贯性评估。"""

import logging
import time
from pathlib import Path

from pydantic_ai import Agent, BinaryContent

from novelvideo.models import beat_scene_id
from .models import ContinuityResult
from .prompts import SKETCH_CONTINUITY_PROMPT
from .sanitize import sanitize_prompt_input
from .utils import compress_image, find_sketch_for_beat, load_all_beats, safe_resolve_under

logger = logging.getLogger(__name__)


class ContinuityVerifier:
    def __init__(self):
        self._agent: Agent | None = None

    def _get_agent(self) -> Agent:
        if self._agent is None:
            from novelvideo.config import (
                get_newapi_structured_output_model_settings,
                get_pydantic_model,
            )

            self._agent = Agent(
                get_pydantic_model(),
                system_prompt=SKETCH_CONTINUITY_PROMPT,
                output_type=ContinuityResult,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="分镜连贯性审核员",
            )
        return self._agent

    async def verify_continuity(
        self,
        project_dir: Path,
        episode_num: int,
        beat_range: list[int] | None = None,
        window_size: int = 2,
        sqlite_store=None,
    ) -> dict:
        project_dir = Path(project_dir)
        beats = await load_all_beats(project_dir, episode_num, sqlite_store=sqlite_store)

        start_beat = beat_range[0] if beat_range and len(beat_range) >= 1 else 1
        end_beat = beat_range[1] if beat_range and len(beat_range) >= 2 else len(beats)
        start_beat = max(1, start_beat)
        end_beat = min(len(beats), end_beat)

        valid_beats: list[tuple[int, Path, dict]] = []
        for beat_num in range(start_beat, end_beat + 1):
            sketch_path = find_sketch_for_beat(project_dir, episode_num, beat_num)
            if not sketch_path:
                continue
            safe_path = safe_resolve_under(project_dir, sketch_path)
            if not safe_path:
                continue
            valid_beats.append((beat_num, safe_path, beats[beat_num - 1]))

        if len(valid_beats) < 2:
            return {"transitions": [], "weak_transitions": [], "overall_score": 10.0}

        agent = self._get_agent()
        all_transitions = []

        for i in range(len(valid_beats) - window_size + 1):
            window = valid_beats[i : i + window_size]
            desc_lines = []
            for beat_num, _, beat_data in window:
                safe_desc = sanitize_prompt_input(beat_data.get("visual_description", ""))
                scene_id = sanitize_prompt_input(beat_scene_id(beat_data))
                desc_lines.append(
                    f"Beat {beat_num}: {safe_desc}" + (f" [场景: {scene_id}]" if scene_id else "")
                )

            task = (
                f"检查以下 {len(window)} 个连续 beat 的叙事连贯性:\n"
                + "\n".join(desc_lines)
                + "\n\n以下图片按 beat 顺序排列。"
            )
            prompt_parts: list = [task]
            for beat_num, sketch_path, _ in window:
                prompt_parts.append(f"\n--- Beat {beat_num} ---")
                prompt_parts.append(
                    BinaryContent(data=compress_image(str(sketch_path)), media_type="image/jpeg")
                )

            start = time.monotonic()
            result = await agent.run(prompt_parts)
            elapsed = time.monotonic() - start
            logger.info(
                "Continuity verify beats %s: overall=%.1f elapsed=%.1fs",
                [beat_num for beat_num, _, _ in window],
                result.output.overall_score,
                elapsed,
            )
            all_transitions.extend(result.output.transitions)

        weak = []
        totals = []
        for transition in all_transitions:
            totals.append(transition.total)
            if transition.total < 6.0:
                weak.append(transition.from_beat)

        overall = sum(totals) / len(totals) if totals else 10.0
        return {
            "transitions": [transition.model_dump() for transition in all_transitions],
            "weak_transitions": sorted(set(weak)),
            "overall_score": round(overall, 1),
        }
