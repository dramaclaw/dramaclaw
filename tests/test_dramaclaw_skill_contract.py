import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = REPO_ROOT / ".hermes" / "skills" / "dramaclaw"


def test_dramaclaw_skill_uses_progressive_disclosure() -> None:
    skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

    assert len(skill.encode("utf-8")) < 10_000
    assert "流程顺序以 `playbooks/` 为唯一事实源" in skill
    assert "references/step-api-reference.md" in skill
    assert "pipeline-details.md" not in skill


def test_dramaclaw_playbooks_own_current_step_order() -> None:
    init = (SKILL_DIR / "playbooks" / "init.md").read_text(encoding="utf-8")
    episode = (SKILL_DIR / "playbooks" / "episode.md").read_text(encoding="utf-8")
    run_modes = (SKILL_DIR / "references" / "run-modes.md").read_text(encoding="utf-8")
    step_api = (SKILL_DIR / "references" / "step-api-reference.md").read_text(
        encoding="utf-8"
    )

    assert "流程顺序的唯一事实源" in init
    assert "流程顺序的唯一事实源" in episode
    assert "逐集生成阶段（Steps 8-16）" in episode
    assert "Steps 8-21" not in episode
    assert "本文件只决定执行前是否再次询问用户" in run_modes
    assert "不拥有流程顺序决策权" in step_api


def test_dramaclaw_media_delivery_uses_display_tools() -> None:
    delivery = (SKILL_DIR / "references" / "delivery-boundaries.md").read_text(
        encoding="utf-8"
    )

    assert "路径和 URL 只作为工具输入，不直接输出给用户" in delivery
    assert "dramaclaw_get_character_media" in delivery
    assert "dramaclaw_get_sketches" in delivery
    assert "dramaclaw_get_first_frames" in delivery
    assert "dramaclaw_get_episode_media" in delivery
    assert "dramaclaw_get_final_video" in delivery
    assert "直接把相对路径当结果交付" not in delivery


def test_dramaclaw_evals_are_well_formed() -> None:
    payload = json.loads((SKILL_DIR / "evals" / "evals.json").read_text(encoding="utf-8"))

    assert payload["skill_name"] == "dramaclaw"
    assert len(payload["evals"]) >= 8
    assert len({case["id"] for case in payload["evals"]}) == len(payload["evals"])
    assert all(case["prompt"] and case["expectations"] for case in payload["evals"])
