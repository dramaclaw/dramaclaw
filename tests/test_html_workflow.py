from novelvideo.freezone.workflow_plan import validate_workflow_plan
from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands


def html_plan():
    return {"schema_version": "freezone_workflow_plan.v1", "skill": {"id": "page"}, "nodes": [
        {"id": "image", "node_type": "imageGenNode", "data": {"workflowCatalog": {"recipeId": "image"}}},
        {"id": "html", "node_type": "htmlArtifactNode", "prompt": "Create page", "data": {"workflowCatalog": {"recipeId": "html"}}},
    ], "edges": [{"source": "image", "target": "html", "link_type": "media_input_for"}]}


def test_html_workflow_accepts_text_recipe_and_media_dependency():
    result = validate_workflow_plan(html_plan(), recipes_by_id={"image": {"output_kind": "image"}, "html": {"output_kind": "text"}})
    assert result["ok"], result
    assert result["preflight"]["counts"]["html"] == 1


def test_html_workflow_rejects_inline_source_and_artifact_identity():
    for field in ("html", "content", "artifactId", "artifactVersion"):
        plan = html_plan()
        plan["nodes"][1]["data"][field] = "untrusted"
        assert not validate_workflow_plan(plan)["ok"], field


def test_html_workflow_compiles_dedicated_pending_step():
    result = build_workflow_graph_commands({"plan": html_plan()})
    commands = result["commands"]
    command = next(command for command in commands if command.get("type") == "html_artifact")
    assert command["action"] == "prepare"
    assert command["workflow_data"]["workflowCatalog"]["recipeId"] == "html"
    assert "html" not in command
