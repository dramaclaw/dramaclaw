from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from novelvideo.freezone import agent_config_store


def _skill_payload(
    item_id: str,
    *,
    description: str | None = None,
    category: str = "general",
    enabled: bool = True,
) -> dict:
    return {
        "schema_version": "dramaclaw.workflow-skill.v1",
        "id": item_id,
        "name": item_id,
        "version": "1.0.0",
        "enabled": enabled,
        "description": description or item_id,
        "category": category,
        "triggers": {"keywords": [item_id], "node_scopes": ["textGeneration"]},
        "allowed_recipe_ids": ["test-recipe"],
        "planning": {
            "planning_notes": "根据用户目标动态规划。",
            "prompt_guide": "",
            "conduct_rules": ["仅创建本次计划需要的节点。"],
        },
        "evaluation": {
            "rating_bands": [{"score": 10, "description": "结果完整可用"}],
            "quality_threshold": 7,
            "domain_constraints": ["遵循用户目标"],
        },
    }


def _recipe_payload(item_id: str, *, name: str | None = None) -> dict:
    return {
        "schema_version": "dramaclaw.recipe.v1",
        "id": item_id,
        "name": name or item_id,
        "version": "1.0.0",
        "output_kind": "text",
        "action_keys": [item_id],
        "system_prompt": "根据输入直接生成最终文本结果。",
        "planning_prompt": "根据用户目标生成最终文本结果。",
        "result_summary": "最终文本结果。",
    }


def _save_test_recipe(username: str = "alice") -> None:
    agent_config_store.save_user_agent_config_item(
        username=username,
        kind="recipes",
        payload=_recipe_payload("test-recipe"),
    )


@pytest.fixture(autouse=True)
def isolated_project_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        agent_config_store,
        "PROJECT_AGENT_CATALOG_DIR",
        tmp_path / "project-catalog",
    )
    agent_config_store._CATALOG_CACHE.clear()
    yield
    agent_config_store._CATALOG_CACHE.clear()


def test_user_agent_config_items_are_account_scoped(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )
    _save_test_recipe()

    saved = agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("story-skill", description="故事类规则"),
    )

    assert saved["id"] == "story-skill"
    target = (
        tmp_path
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "story-skill.json"
    )
    assert target.exists()
    assert json.loads(target.read_text(encoding="utf-8"))["description"] == "故事类规则"

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")
    assert [item["id"] for item in listed] == ["story-skill"]
    assert agent_config_store.list_user_agent_config_items("bob", "skills") == []


def test_agent_config_items_include_builtin_catalog_with_user_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    (skill_root / "story-skill.json").write_text(
        json.dumps(
            _skill_payload("story-skill", description="内置故事规则"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (skill_root / "image-skill.json").write_text(
        json.dumps(
            _skill_payload("image-skill", description="内置图像规则", category="image"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    _save_test_recipe()
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload(
            "story-skill",
            description="用户故事规则",
            category="custom",
        ),
    )

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")

    assert [item["id"] for item in listed] == ["story-skill", "image-skill"]
    assert listed[0]["description"] == "用户故事规则"
    assert listed[0]["_catalog_source"] == "user"
    assert listed[0]["_catalog_base_source"] == "builtin"
    assert listed[1]["_catalog_source"] == "builtin"


def test_project_catalog_overrides_builtin_and_supports_array_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    project_root = tmp_path / "project-catalog"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    monkeypatch.setattr(agent_config_store, "PROJECT_AGENT_CATALOG_DIR", project_root)
    (builtin_root / "skills").mkdir(parents=True)
    (project_root / "skills").mkdir(parents=True)
    (project_root / "recipes").mkdir(parents=True)
    (builtin_root / "skills" / "video-skill.json").write_text(
        json.dumps(_skill_payload("video-skill", description="旧名称")),
        encoding="utf-8",
    )
    (project_root / "skills" / "video-skill.json").write_text(
        json.dumps(
            {
                **_skill_payload("video-skill", description="项目名称"),
                "name": "项目名称",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (project_root / "recipes" / "bundle.json").write_text(
        json.dumps([_recipe_payload("recipe-a"), _recipe_payload("recipe-b")]),
        encoding="utf-8",
    )

    skills = agent_config_store.list_user_agent_config_items("alice", "skills")
    recipes = agent_config_store.list_user_agent_config_items("alice", "recipes")

    assert skills[0]["name"] == "项目名称"
    assert [item["id"] for item in recipes] == ["recipe-a", "recipe-b"]


def test_agent_config_cache_invalidates_when_catalog_file_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    target = skill_root / "story-skill.json"
    target.write_text(
        json.dumps(
            _skill_payload("story-skill", description="第一版"), ensure_ascii=False
        ),
        encoding="utf-8",
    )

    first = agent_config_store.list_user_agent_config_items("alice", "skills")
    assert first[0]["description"] == "第一版"
    first[0]["description"] = "调用方不应污染缓存"

    target.write_text(
        json.dumps(
            _skill_payload("story-skill", description="第二版更长"), ensure_ascii=False
        ),
        encoding="utf-8",
    )

    second = agent_config_store.list_user_agent_config_items("alice", "skills")
    assert second[0]["description"] == "第二版更长"


def test_builtin_agent_config_item_can_be_hidden_by_user_overlay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    (skill_root / "story-skill.json").write_text(
        json.dumps(
            _skill_payload("story-skill", description="内置故事规则"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    deleted = agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="skills",
        item_id="story-skill",
    )

    assert deleted is True
    assert agent_config_store.list_user_agent_config_items("alice", "skills") == []
    overlay_path = (
        tmp_path
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "story-skill.json"
    )
    assert json.loads(overlay_path.read_text(encoding="utf-8")) == {
        "id": "story-skill",
        "hidden": True,
    }


def test_builtin_agent_config_item_merges_partial_user_overlay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    (skill_root / "story-skill.json").write_text(
        json.dumps(
            _skill_payload("story-skill", description="内置故事规则"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload(
            "story-skill",
            description="内置故事规则",
            enabled=False,
        ),
    )

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")

    assert len(listed) == 1
    assert listed[0]["id"] == "story-skill"
    assert listed[0]["description"] == "内置故事规则"
    assert listed[0]["enabled"] is False
    assert listed[0]["_catalog_source"] == "user"
    assert listed[0]["_catalog_base_source"] == "builtin"


def test_agent_config_items_sort_user_then_customized_then_builtin_by_mtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    for item_id in ["builtin-a", "custom-a", "custom-b"]:
        (skill_root / f"{item_id}.json").write_text(
            json.dumps(_skill_payload(item_id), ensure_ascii=False),
            encoding="utf-8",
        )

    _save_test_recipe()
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("custom-a", description="定制旧"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("user-old", description="用户旧"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("custom-b", description="定制新"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("user-new", description="用户新"),
    )
    user_root = agent_config_store.user_agent_config_dir("alice", "skills")
    mtimes = {
        "custom-a": 10,
        "user-old": 20,
        "custom-b": 30,
        "user-new": 40,
    }
    for item_id, mtime in mtimes.items():
        os.utime(user_root / f"{item_id}.json", (mtime, mtime))

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")

    assert [item["id"] for item in listed] == [
        "user-new",
        "user-old",
        "custom-b",
        "custom-a",
        "builtin-a",
    ]
    assert listed[0]["_catalog_source"] == "user"
    assert "_catalog_base_source" not in listed[0]
    assert listed[2]["_catalog_base_source"] == "builtin"
    assert listed[-1]["_catalog_source"] == "builtin"


def test_invalid_builtin_catalog_files_are_ignored(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    recipe_root = builtin_root / "recipes"
    recipe_root.mkdir(parents=True)
    (recipe_root / "bad.json").write_text('{"id": "../bad"}', encoding="utf-8")
    (recipe_root / "not-json.json").write_text("{", encoding="utf-8")
    (recipe_root / "valid-recipe.json").write_text(
        json.dumps(
            _recipe_payload("valid-recipe", name="内置 Recipe"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    listed = agent_config_store.list_user_agent_config_items("alice", "recipes")

    assert [item["id"] for item in listed] == ["valid-recipe"]
    assert listed[0]["_catalog_source"] == "builtin"


def test_user_agent_config_item_rejects_unsafe_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )

    with pytest.raises(ValueError, match="invalid agent config id"):
        agent_config_store.save_user_agent_config_item(
            username="alice",
            kind="recipes",
            payload={"id": "../escape", "name": "bad"},
        )


def test_user_agent_config_item_can_be_deleted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("ad-recipe", name="广告 Recipe"),
    )

    deleted = agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="recipes",
        item_id="ad-recipe",
    )

    assert deleted is True
    assert agent_config_store.list_user_agent_config_items("alice", "recipes") == []


def test_enabled_skill_rejects_unavailable_recipe_reference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )

    with pytest.raises(ValueError, match="references unavailable recipe"):
        agent_config_store.save_user_agent_config_item(
            username="alice",
            kind="skills",
            payload=_skill_payload("broken-skill"),
        )


def test_referenced_recipe_requires_disabling_skill_before_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )
    _save_test_recipe()
    skill = _skill_payload("story-skill")
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=skill,
    )

    with pytest.raises(ValueError, match="referenced by skill"):
        agent_config_store.delete_user_agent_config_item(
            username="alice",
            kind="recipes",
            item_id="test-recipe",
        )

    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload={**skill, "enabled": False},
    )
    assert agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="recipes",
        item_id="test-recipe",
    )


def test_user_agent_config_delete_missing_item_is_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )

    deleted = agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="skills",
        item_id="missing-skill",
    )

    assert deleted is False
