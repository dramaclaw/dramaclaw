import importlib.util
from pathlib import Path


def _load_catalog():
    path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "novelvideo"
        / "freezone"
        / "agent_workflows"
        / "catalog.py"
    )
    spec = importlib.util.spec_from_file_location("confirmed_inputs_catalog", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_short_drama_visual_style_is_structured_and_reaches_all_standard_nodes(monkeypatch):
    catalog = _load_catalog()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)
    result = catalog.compile_workflow_intent(
        {
            "skill_id": "short-drama-quick",
            "user_goal": "制作一段悬疑短剧",
            "inputs": {"visual_style": "写实"},
            "planner": {
                "mode": "standard",
                "item_count": 2,
                "include_audio": False,
            },
        }
    )

    assert result["ok"] is True, result
    plan = result["plan"]
    assert plan["inputs"]["visual_style"] == "写实"
    executable_nodes = [
        node
        for node in plan["nodes"]
        if node["id"] != "workflow_input"
        and node["node_type"] != "videoComposeNode"
    ]
    assert executable_nodes
    assert all("写实" in node["data"]["prompt"] for node in executable_nodes)
    assert all(
        node["data"]["workflowCatalog"]["confirmedInputs"]["visual_style"] == "写实"
        for node in executable_nodes
    )


def test_pixar_character_input_method_is_preserved_in_custom_anchor_prompt(monkeypatch):
    catalog = _load_catalog()
    monkeypatch.setattr(catalog, "list_user_agent_config_items", None)
    result = catalog.compile_workflow_intent(
        {
            "skill_id": "pixar-ip-ad-video",
            "user_goal": "制作品牌角色广告",
            "inputs": {"character_input_method": "自定义角色"},
            "items": [
                {
                    "id": "character_anchor",
                    "title": "角色锚点",
                    "prompt": "生成角色锚点",
                    "recipe_id": "ad-ip-character-anchor",
                    "stage": "characters",
                }
            ],
        }
    )

    assert result["ok"] is True, result
    node = next(node for node in result["plan"]["nodes"] if node["id"] == "character_anchor")
    assert result["plan"]["inputs"]["character_input_method"] == "自定义角色"
    assert "自定义角色" in node["data"]["prompt"]
    assert (
        node["data"]["workflowCatalog"]["confirmedInputs"]["character_input_method"]
        == "自定义角色"
    )
