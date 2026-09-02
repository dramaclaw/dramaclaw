from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone import agent_bundle_store
from novelvideo.freezone import agent_config_store


def _skill_payload(item_id: str = "community-video", **overrides) -> dict:
    payload = {
        "schema_version": "dramaclaw.workflow-skill.v1",
        "id": item_id,
        "name": "社区视频 Skill",
        "version": "1.0.0",
        "description": "根据用户素材动态生成社区视频工作流。",
        "category": "video",
        "triggers": {"keywords": ["社区视频"], "node_scopes": ["textGeneration", "imageGeneration"]},
        "input_parameters": [
            {
                "id": "aspect_ratio",
                "label": "画幅",
                "type": "single_select",
                "required": True,
                "default": "16:9",
                "options": ["16:9", "1:1"],
            }
        ],
        "allowed_recipe_ids": ["community-brief"],
        "planning": {
            "planning_notes": "动态执行路径：根据用户输入和素材决定文本规划与图片生成阶段。",
            "prompt_guide": "保持中文输出。",
            "conduct_rules": ["高成本生成前等待用户确认。"],
        },
        "evaluation": {
            "rating_bands": [{"score": 5, "description": "结果可用"}],
            "quality_threshold": 4,
            "domain_constraints": ["不得虚构用户素材事实"],
        },
    }
    payload.update(overrides)
    return payload


def _recipe_payload(item_id: str = "community-brief", **overrides) -> dict:
    payload = {
        "schema_version": "dramaclaw.recipe.v1",
        "id": item_id,
        "name": "社区简报",
        "version": "1.0.0",
        "output_kind": "text",
        "action_keys": ["community-brief"],
        "system_prompt": "根据用户输入直接生成最终视频简报。",
        "must_have_items": ["主题", "画幅"],
        "planning_prompt": "根据用户目标生成最终视频简报。",
        "result_summary": "最终视频简报。",
    }
    payload.update(overrides)
    return payload


def _bundle_payload(**overrides) -> dict:
    payload = {
        "schema_version": "dramaclaw.skill-bundle.v1",
        "id": "community-video",
        "name": "社区视频 Skill",
        "version": "1.0.0",
        "description": "社区视频动态工作流。",
        "author": "DramaClaw",
        "license": "CC-BY-4.0",
        "min_dramaclaw_version": "1.0.0",
        "tags": ["video", "community"],
        "skill": _skill_payload(),
        "recipes": [_recipe_payload()],
    }
    payload.update(overrides)
    return payload


def _legal_payload() -> dict:
    return {
        "copyright": "2026 SuperTale contributors",
        "license": {
            "id": "Elastic-2.0",
            "text": "Elastic License 2.0 terms.",
        },
        "notice": "DramaClaw trademark rights are reserved.",
    }


@pytest.fixture
def isolated_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins")
    monkeypatch.setattr(agent_bundle_store, "CURRENT_DRAMACLAW_VERSION", "2.0.0")
    return tmp_path


def test_validate_agent_bundle_accepts_skill_and_recipes(isolated_catalog: Path) -> None:
    result = agent_bundle_store.validate_agent_bundle(_bundle_payload())

    assert result["bundle"]["id"] == "community-video"
    assert result["skill_count"] == 1
    assert result["recipe_count"] == 1
    assert result["warnings"] == []


def test_validate_agent_bundle_preserves_structured_legal_metadata(isolated_catalog: Path) -> None:
    legal = _legal_payload()

    result = agent_bundle_store.validate_agent_bundle(
        _bundle_payload(license=legal["license"]["id"], legal=legal)
    )

    assert result["bundle"]["legal"] == legal


def test_validate_agent_bundle_rejects_mismatched_legal_license_id(
    isolated_catalog: Path,
) -> None:
    with pytest.raises(ValueError, match="license must match legal.license.id"):
        agent_bundle_store.validate_agent_bundle(
            _bundle_payload(license="MIT", legal=_legal_payload())
        )


def test_validate_agent_bundle_rejects_missing_recipe_reference(isolated_catalog: Path) -> None:
    bundle = _bundle_payload(recipes=[])

    with pytest.raises(ValueError, match="missing referenced Recipes"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_high_minimum_dramaclaw_version(
    isolated_catalog: Path,
) -> None:
    bundle = _bundle_payload(min_dramaclaw_version="99.0.0")

    with pytest.raises(ValueError, match="requires DramaClaw >= 99.0.0"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_dangerous_fields(isolated_catalog: Path) -> None:
    bundle = _bundle_payload(script="echo bad")

    with pytest.raises(ValueError, match="dangerous Bundle field"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_secrets(isolated_catalog: Path) -> None:
    recipe = _recipe_payload(system_prompt="请使用 sk-live-secret 生成提示词")
    bundle = _bundle_payload(recipes=[recipe])

    with pytest.raises(ValueError, match="possible secret"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_supplier_model_names(isolated_catalog: Path) -> None:
    recipe = _recipe_payload(system_prompt="请固定使用 gpt-image-2 生成")
    bundle = _bundle_payload(recipes=[recipe])

    with pytest.raises(ValueError, match="supplier model name"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_install_agent_bundle_saves_user_skill_and_recipes(isolated_catalog: Path) -> None:
    result = agent_bundle_store.install_agent_bundle(username="alice", payload=_bundle_payload())

    assert result["installed_skill"] == "community-video"
    assert result["installed_recipes"] == ["community-brief"]
    skill_path = (
        isolated_catalog
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "community-video.json"
    )
    recipe_path = (
        isolated_catalog
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "recipes"
        / "community-brief.json"
    )
    assert json.loads(skill_path.read_text(encoding="utf-8"))["id"] == "community-video"
    assert json.loads(recipe_path.read_text(encoding="utf-8"))["id"] == "community-brief"


def test_install_and_export_preserve_structured_legal_metadata(isolated_catalog: Path) -> None:
    legal = _legal_payload()
    agent_bundle_store.install_agent_bundle(
        username="alice",
        payload=_bundle_payload(license=legal["license"]["id"], legal=legal),
    )

    stored_skill_path = (
        isolated_catalog
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "community-video.json"
    )
    stored_skill = json.loads(stored_skill_path.read_text(encoding="utf-8"))
    assert stored_skill["_catalog_bundle_legal"] == legal

    exported = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={},
    )
    assert exported["legal"] == legal


def test_install_and_export_legacy_bundle_omits_legal_field(isolated_catalog: Path) -> None:
    agent_bundle_store.install_agent_bundle(username="alice", payload=_bundle_payload())

    exported = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={},
    )

    assert "legal" not in exported


def test_export_agent_bundle_preserves_imported_bundle_metadata(isolated_catalog: Path) -> None:
    bundle = _bundle_payload(
        author="Original Creator",
        license="CC-BY-NC-4.0",
        version="2.1.0",
        min_dramaclaw_version="1.0.0",
        tags=["imported", "community"],
    )
    agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    exported = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "我的本地显示名",
            "version": "9.9.9",
            "description": "本地导出默认描述",
            "author": "Local User",
            "license": "Proprietary",
            "min_dramaclaw_version": "1.0.0",
            "tags": ["local"],
        },
    )

    assert exported["name"] == "社区视频 Skill"
    assert exported["version"] == "2.1.0"
    assert exported["author"] == "Original Creator"
    assert exported["license"] == "CC-BY-NC-4.0"
    assert exported["tags"] == ["imported", "community"]


def test_export_agent_bundle_uses_default_author_and_license(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "社区视频 Skill",
            "version": "1.0.0",
            "description": "社区视频动态工作流。",
            "author": "",
            "license": "",
            "min_dramaclaw_version": "1.0.0",
        },
    )

    assert bundle["author"] == "alice"
    assert bundle["license"] == "Proprietary"


def test_export_agent_bundle_uses_current_version_when_minimum_is_missing(
    isolated_catalog: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_bundle_store, "current_dramaclaw_version", lambda: "1.1.2")
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "社区视频 Skill",
            "version": "1.0.0",
            "description": "社区视频动态工作流。",
            "author": "",
            "license": "",
        },
    )

    assert bundle["min_dramaclaw_version"] == "1.1.2"


def test_export_builtin_agent_bundle_uses_dramaclaw_author(isolated_catalog: Path) -> None:
    builtin_root = isolated_catalog / "builtins"
    skill_root = builtin_root / "skills"
    recipe_root = builtin_root / "recipes"
    skill_root.mkdir(parents=True)
    recipe_root.mkdir(parents=True)
    (skill_root / "community-video.json").write_text(
        json.dumps(_skill_payload("community-video"), ensure_ascii=False),
        encoding="utf-8",
    )
    (recipe_root / "community-brief.json").write_text(
        json.dumps(_recipe_payload("community-brief"), ensure_ascii=False),
        encoding="utf-8",
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "社区视频 Skill",
            "version": "1.0.0",
            "description": "社区视频动态工作流。",
            "author": "",
            "license": "",
            "min_dramaclaw_version": "1.0.0",
        },
    )

    assert bundle["author"] == "DramaClaw"
    assert bundle["license"] == "Proprietary"


def test_install_agent_bundle_rejects_existing_skill_id(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    with pytest.raises(ValueError, match="already exists"):
        agent_bundle_store.install_agent_bundle(username="alice", payload=_bundle_payload())


def test_install_agent_bundle_reuses_identical_existing_recipe(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_skill"] == "second-video"
    assert result["installed_recipes"] == []
    assert result["reused_recipes"] == ["community-brief"]
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief"]


def test_install_agent_bundle_renames_conflicting_recipe_and_rewrites_skill_reference(
    isolated_catalog: Path,
) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief", system_prompt="本地已有不同提示词。"),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_skill"] == "second-video"
    assert result["installed_recipes"] == ["community-brief--second-video"]
    assert result["reused_recipes"] == []
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief--second-video"]
    recipe_ids = {
        item["id"] for item in agent_config_store.list_user_agent_config_items("alice", "recipes")
    }
    assert {"community-brief", "community-brief--second-video"} <= recipe_ids


def test_install_agent_bundle_reuses_existing_renamed_recipe_when_content_matches(
    isolated_catalog: Path,
) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief", system_prompt="本地已有不同提示词。"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief--second-video"),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_recipes"] == []
    assert result["reused_recipes"] == ["community-brief--second-video"]
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief--second-video"]


def test_install_agent_bundle_increments_recipe_suffix_until_available(
    isolated_catalog: Path,
) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief", system_prompt="本地已有不同提示词。"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief--second-video", system_prompt="另一个不同提示词。"),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_recipes"] == ["community-brief--second-video-2"]
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief--second-video-2"]


def test_export_agent_bundle_includes_allowed_recipes(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "社区视频 Skill",
            "version": "1.0.0",
            "description": "社区视频动态工作流。",
            "author": "DramaClaw",
            "license": "CC-BY-4.0",
            "min_dramaclaw_version": "1.0.0",
        },
    )

    assert bundle["schema_version"] == "dramaclaw.skill-bundle.v1"
    assert bundle["skill"]["id"] == "community-video"
    assert [recipe["id"] for recipe in bundle["recipes"]] == ["community-brief"]
