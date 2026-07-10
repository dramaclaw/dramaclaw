"""整集分镜总览评审。"""

import logging
import math
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image as PILImage, ImageDraw, ImageFont
from pydantic_ai import Agent, BinaryContent

from novelvideo.models import beat_scene_id
from .models import EpisodeOverviewResult
from .prompts import EPISODE_OVERVIEW_PROMPT
from .sanitize import sanitize_prompt_input
from .utils import compress_image, find_sketch_for_beat, load_all_beats, safe_resolve_under

logger = logging.getLogger(__name__)


def _build_numbered_grid(image_paths: list[tuple[int, Path]], output_path: Path) -> Path:
    n = len(image_paths)
    if n == 0:
        raise ValueError("No images to combine")

    cols = 5
    rows = math.ceil(n / cols)
    if n <= 9:
        cols = 3
        rows = math.ceil(n / cols)
    elif n <= 16:
        cols = 4
        rows = math.ceil(n / cols)

    first_img = PILImage.open(image_paths[0][1])
    cell_w, cell_h = first_img.size
    first_img.close()

    grid_img = PILImage.new("RGB", (cols * cell_w, rows * cell_h), color=(0, 0, 0))
    draw = ImageDraw.Draw(grid_img)
    font_size = max(16, cell_w // 12)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
    except (OSError, IOError):
        font = ImageFont.load_default()

    for i, (beat_num, img_path) in enumerate(image_paths):
        row = i // cols
        col = i % cols
        x = col * cell_w
        y = row * cell_h
        img = PILImage.open(img_path)
        if img.size != (cell_w, cell_h):
            img = img.resize((cell_w, cell_h), PILImage.LANCZOS)
        grid_img.paste(img, (x, y))
        img.close()

        label = str(beat_num)
        bbox = draw.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        padding = 4
        draw.rectangle(
            [x + 2, y + 2, x + 2 + text_w + padding * 2, y + 2 + text_h + padding * 2],
            fill="white",
        )
        draw.text((x + 2 + padding, y + 2 + padding), label, fill="black", font=font)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    grid_img.save(output_path)
    return output_path


class EpisodeReviewer:
    def __init__(self):
        self._agent: Agent | None = None

    def _get_agent(self) -> Agent:
        if self._agent is None:
            from novelvideo.config import get_pydantic_model

            self._agent = Agent(
                get_pydantic_model(),
                system_prompt=EPISODE_OVERVIEW_PROMPT,
                output_type=EpisodeOverviewResult,
                output_retries=2,
                name="导演分镜审片员",
            )
        return self._agent

    async def review_episode(self, project_dir: Path, episode_num: int, *, sqlite_store=None) -> dict:
        project_dir = Path(project_dir)
        beats = await load_all_beats(project_dir, episode_num, sqlite_store=sqlite_store)
        if not beats:
            raise FileNotFoundError(f"No beats found for episode {episode_num}")

        image_entries: list[tuple[int, Path, dict]] = []
        for idx, beat in enumerate(beats):
            beat_num = beat.get("beat_number") or (idx + 1)
            sketch_path = find_sketch_for_beat(project_dir, episode_num, beat_num)
            if not sketch_path:
                continue
            safe_path = safe_resolve_under(project_dir, sketch_path)
            if not safe_path:
                continue
            image_entries.append((beat_num, safe_path, beat))

        if len(image_entries) < 4:
            raise ValueError("Too few sketches for episode overview. Need at least 4.")

        reports_dir = project_dir / "verify_reports" / f"ep{episode_num:03d}"
        grid_path = reports_dir / "episode_overview_grid.png"
        _build_numbered_grid([(beat_num, path) for beat_num, path, _ in image_entries], grid_path)

        desc_lines = []
        for beat_num, _, beat_data in image_entries:
            scene_id = sanitize_prompt_input(beat_scene_id(beat_data))
            visual_desc = sanitize_prompt_input(beat_data.get("visual_description", ""))[:80]
            desc_lines.append(f"{beat_num}: [{scene_id}] {visual_desc}")
        beat_summary = "\n".join(desc_lines)

        scene_distribution: dict[str, list[int]] = defaultdict(list)
        for beat_num, _, beat_data in image_entries:
            scene_id = beat_scene_id(beat_data) or "未知"
            if scene_id:
                scene_distribution[scene_id].append(beat_num)

        task = (
            f"以下是第 {episode_num} 集的分镜板网格图（共 {len(image_entries)} 个 beat），"
            f"从左到右、从上到下按 beat 顺序排列。每个格子左上角标有 beat 编号。\n\n"
            f"## 各 beat 描述\n{beat_summary}\n\n"
            f"请评估整集分镜的整体表现。"
        )

        agent = self._get_agent()
        start = time.monotonic()
        result = await agent.run(
            [task, BinaryContent(data=compress_image(str(grid_path), quality=80), media_type="image/jpeg")]
        )
        elapsed = time.monotonic() - start

        output = result.output
        total = round(
            (
                output.visual_rhythm
                + output.composition_diversity
                + output.narrative_arc
                + output.style_unity
            )
            / 4,
            1,
        )
        has_critical = any(issue.severity == "critical" for issue in output.issues)
        overall_passed = (total >= 6.0) and (not has_critical)
        logger.info(
            "Episode overview ep=%d: total=%.1f passed=%s elapsed=%.1fs",
            episode_num,
            total,
            overall_passed,
            elapsed,
        )

        data = output.model_dump()
        data["total"] = total
        data["overall_passed"] = overall_passed
        data["scene_distribution"] = dict(scene_distribution)
        data["grid_path"] = grid_path.relative_to(project_dir).as_posix()
        data["beats_reviewed"] = [beat_num for beat_num, _, _ in image_entries]
        return data
