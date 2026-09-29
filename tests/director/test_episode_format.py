"""The display contract checks presence, not literary quality or fixed scene counts."""

from novelvideo.director.episode_format import FIELDS, inspect_episode
from novelvideo.director.skills.runtime import load_package


def test_complete_structure_is_not_a_quality_pass():
    value = "# 第2集：门\n\n" + "\n".join(f"- **{aliases[0]}**：已确认内容" for aliases in FIELDS.values())
    value += "\n\n### 2-1｜门口 夜 / 外\n\n△ 她把钥匙交给他。"
    result = inspect_episode(value)
    assert result["missing"] == []
    assert result["sceneCount"] == 1
    assert result["qualityVerified"] is False


def test_legacy_revision_warns_without_rewriting():
    value = "# Legacy\n\nSilent action only."
    assert len(inspect_episode(value)["missing"]) == 10
    assert value == "# Legacy\n\nSilent action only."


def test_episode_method_keeps_short_drama_and_adds_delivery_contract():
    package = load_package("M11")
    assert package["manifest"].version == "2.2.0"
    assert len(package["manifest"].required_references) == 6
    assert "SKILL.md" in package["files"]
    assert "目标时长" in package["files"]["method.md"]
    assert "keep untouched content exactly unchanged" in package["files"]["method.md"]
