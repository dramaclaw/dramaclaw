"""全局验证：跨 beat 角色/服装一致性检查。"""

import logging
import time
from collections import defaultdict
from pathlib import Path

from pydantic_ai import Agent, BinaryContent

logger = logging.getLogger(__name__)

from .models import CharacterConsistencyReport, ConsistencyResult
from .prompts import CONSISTENCY_VERIFY_PROMPT
from .sanitize import sanitize_prompt_input
from .utils import (
    compress_image,
    find_frame_for_beat,
    find_sketch_for_beat,
    load_all_beats,
    safe_resolve_under,
)


class ConsistencyVerifier:
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
                system_prompt=CONSISTENCY_VERIFY_PROMPT,
                output_type=ConsistencyResult,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="角色一致性审核员",
            )
        return self._agent

    def _load_identity_appearances(
        self, project_dir: Path,
    ) -> dict[str, str]:
        """从项目配置中加载 Identity 的 appearance_details。

        Returns:
            {identity_id: appearance_details} 映射
        """
        import json

        identity_appearances: dict[str, str] = {}
        characters_dir = project_dir / "characters"
        if not characters_dir.exists():
            return identity_appearances

        for char_file in characters_dir.glob("*.json"):
            # 路径安全检查：确保文件在 project_dir 内
            if not char_file.resolve().is_relative_to(project_dir.resolve()):
                logger.warning("Skipping file outside project dir: %s", char_file)
                continue
            try:
                char_data = json.loads(char_file.read_text(encoding="utf-8"))
                for identity in char_data.get("identities", []):
                    iid = identity.get("identity_id", "")
                    appearance = identity.get("appearance_details", "")
                    if iid and appearance:
                        identity_appearances[iid] = appearance
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning("Skipping %s: %s", char_file, e)
                continue
        return identity_appearances

    async def verify_consistency(
        self,
        project_dir,
        episode_num: int,
        verify_type: str = "sketch",
        sqlite_store=None,
    ) -> dict:
        """检查整集角色/服装一致性。

        按角色 identity 分组，将同一角色的多张图片一起发给 LLM。
        返回增强版结果：分维度评分，face/clothing 分离。
        """
        project_dir = Path(project_dir)
        beats = await load_all_beats(project_dir, episode_num, sqlite_store=sqlite_store)

        # 加载 Identity 外观设定
        identity_appearances = self._load_identity_appearances(project_dir)

        # 按 identity_id 分组：{identity_id: [(beat_num, image_path, char_name)]}
        identity_beats: dict[str, list[tuple[int, str, str]]] = defaultdict(list)
        for beat in beats:
            beat_num = beat["beat_number"]
            identities = beat.get("character_identities", {})
            find_fn = find_sketch_for_beat if verify_type == "sketch" else find_frame_for_beat
            img = find_fn(project_dir, episode_num, beat_num)
            if not img:
                continue
            # 路径安全检查：确保图片在 project_dir 内
            safe_img = safe_resolve_under(project_dir, img)
            if not safe_img:
                logger.warning("Skipping image outside project dir: %s", img)
                continue
            for char_name, identity_id in identities.items():
                identity_beats[identity_id].append((beat_num, str(safe_img), char_name))

        # 只检查出现在 2+ beat 中的角色
        agent = self._get_agent()
        all_reports: list[CharacterConsistencyReport] = []

        for identity_id, appearances in identity_beats.items():
            if len(appearances) < 2:
                continue

            # 最多取 6 张图避免 token 过多
            sampled = appearances if len(appearances) <= 6 else [
                appearances[0],
                appearances[len(appearances) // 4],
                appearances[len(appearances) // 2],
                appearances[3 * len(appearances) // 4],
                appearances[-1],
                appearances[len(appearances) // 3],
            ]

            char_name = sampled[0][2]
            beat_nums = [s[0] for s in sampled]

            # 构建任务文本，包含 Identity 外观设定
            appearance_ref = ""
            if identity_id in identity_appearances:
                safe_appearance = sanitize_prompt_input(identity_appearances[identity_id])
                appearance_ref = f"\n\nIdentity 外观设定参考：\n{safe_appearance}"

            safe_char_name = sanitize_prompt_input(char_name)
            safe_identity_id = sanitize_prompt_input(identity_id)
            task = (
                f"检查角色「{safe_char_name}」（身份: {safe_identity_id}）在以下 beat 中的外观一致性：\n"
                f"Beat 编号: {beat_nums}\n"
                f"以下图片按 beat 顺序排列，请对比同一角色在不同画面中是否一致。\n"
                f"请按维度（face, hair, skin_tone, gender, clothing_style, clothing_color, accessories, body_type）逐一评分。"
                f"{appearance_ref}"
            )

            prompt_parts: list = [task]
            for beat_num, img_path, _ in sampled:
                img_bytes = compress_image(img_path)
                prompt_parts.append(
                    BinaryContent(data=img_bytes, media_type="image/jpeg")
                )

            start = time.monotonic()
            result = await agent.run(prompt_parts)
            elapsed = time.monotonic() - start
            output = result.output
            logger.info(
                "Consistency verify [%s]: characters=%d passed=%s elapsed=%.1fs",
                identity_id, len(output.characters),
                all(r.passed for r in output.characters), elapsed,
            )

            # 收集各角色报告
            for report in output.characters:
                all_reports.append(report)

        overall_passed = all(r.passed for r in all_reports) if all_reports else True

        # 构建返回字典
        summary = "未发现角色一致性问题"
        if all_reports:
            summary = getattr(output, "summary", "角色一致性检查完成")
        return {
            "total_beats": len(beats),
            "characters": [r.model_dump() for r in all_reports],
            "summary": summary,
            "overall_passed": overall_passed,
            "needs_human_review": not overall_passed,
        }
