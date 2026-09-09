from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier

import pytest

from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.workflow_transactions import (
    WorkflowOperationError,
    bind_workflow_inputs,
    prepare_workflow_source,
    update_workflow_steps,
)


def _plan():
    return {
        "nodes": [
            {
                "id": "brief",
                "node_type": "textAnnotationNode",
                "data": {"content": "Planning", "semanticOutputRole": "planning_text"},
            },
            {
                "id": "image",
                "node_type": "imageGenNode",
                "data": {"prompt": "Original"},
            },
        ],
        "edges": [],
    }


def test_binding_preserves_planning_and_is_idempotent():
    plan = _plan()
    before = deepcopy(plan)
    binding = [
        {
            "source": "brief",
            "target": "image",
            "usage": "prompt",
            "prompt": "Actual prompt",
        }
    ]
    result = bind_workflow_inputs(plan, binding)
    assert plan == before
    assert result["nodes"][0] == before["nodes"][0]
    assert result["nodes"][2]["data"]["semanticOutputRole"] == "input_text"
    assert [edge["link_type"] for edge in result["edges"]] == [
        "context_for",
        "prompt_for",
    ]
    assert bind_workflow_inputs(result, binding) == result


@pytest.mark.parametrize(
    "patch",
    [
        {"usage": []},
        {"source": "missing"},
        {"prompt": ""},
        {"semanticOutputRole": "input_text"},
        {"usage": "context", "prompt": "not a prompt"},
    ],
)
def test_invalid_binding_rejects_without_mutating(patch):
    plan = _plan()
    before = deepcopy(plan)
    with pytest.raises(WorkflowOperationError):
        bind_workflow_inputs(
            plan, [{"source": "brief", "target": "image", "usage": "prompt", **patch}]
        )
    assert plan == before


def test_step_patch_only_changes_requested_node():
    plan = _plan()
    result = update_workflow_steps(
        plan, [{"node_id": "image", "prompt": "Changed", "settings": {"variants": 2}}]
    )
    assert result["nodes"][0] == plan["nodes"][0]
    assert result["edges"] == plan["edges"]
    assert result["nodes"][1]["data"] == {"prompt": "Changed", "count": 2}
    assert plan["nodes"][1]["data"] == {"prompt": "Original"}


@pytest.mark.parametrize(
    "settings",
    [{"variants": True}, {"model": []}, {"semanticOutputRole": "input_text"}],
)
def test_step_settings_cannot_change_role_or_accept_bad_types(settings):
    with pytest.raises(WorkflowOperationError):
        update_workflow_steps(_plan(), [{"node_id": "image", "settings": settings}])


def test_authenticated_catalog_isolation_and_scope_cleanup(monkeypatch):
    barrier = Barrier(2)
    monkeypatch.setattr(
        catalog,
        "list_user_agent_config_items",
        lambda user, kind: [{"id": user, "enabled": True, "version": 1}],
    )

    def read(user):
        with catalog.workflow_catalog_scope(user):
            barrier.wait(timeout=5)
            ids = [
                item["id"]
                for item in catalog._load_agent_config_items(
                    "skills", catalog._SKILLS_DIR
                )
            ]
        assert catalog._REQUEST_CATALOG.get() is None
        return ids

    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = [pool.submit(read, user) for user in ("alice", "bob")]
        assert a.result() == ["alice"]
        assert b.result() == ["bob"]


def test_source_rejects_mixed_input_without_compiling(monkeypatch):
    monkeypatch.setattr(catalog, "list_user_agent_config_items", lambda *_: [])
    with pytest.raises(WorkflowOperationError, match="exactly one"):
        prepare_workflow_source({"intent": {}, "plan": {}}, username="alice")


def test_text_prompt_update_does_not_leave_old_recipe_prompt():
    plan = _plan()
    plan["nodes"][0]["data"]["prompt"] = "Old recipe prompt"
    result = update_workflow_steps(
        plan, [{"node_id": "brief", "prompt": "New instruction"}]
    )
    assert result["nodes"][0]["data"]["content"] == "New instruction"
    assert result["nodes"][0]["data"]["prompt"] == "New instruction"
    assert result["nodes"][0]["data"]["semanticOutputRole"] == "planning_text"


def test_compact_intent_preparation_and_revision_use_authenticated_catalog(monkeypatch):
    from novelvideo.freezone.workflow_transactions import revise_workflow_source

    calls = []

    def items(user, kind):
        calls.append((user, kind))
        if kind == "skills":
            return [
                {
                    "id": "sample",
                    "name": "Sample",
                    "version": 1,
                    "enabled": True,
                    "triggers": {"node_scopes": ["imageGeneration"]},
                    "allowed_recipe_ids": ["sample-image"],
                }
            ]
        return [
            {
                "id": "sample-image",
                "name": "Image",
                "version": 1,
                "enabled": True,
                "output_kind": "image",
                "requires_source_media": False,
            }
        ]

    monkeypatch.setattr(catalog, "list_user_agent_config_items", items)
    monkeypatch.setenv("DRAMACLAW_USERNAME", "wrong-process-user")
    intent = {
        "skill_id": "sample",
        "user_goal": "商品图",
        "include_compose": False,
        "items": [{"id": "hero", "title": "商品", "recipe_id": "sample-image"}],
    }
    prepared = prepare_workflow_source({"intent": intent}, username="alice")
    assert prepared["compiled"]["ok"]
    revised = revise_workflow_source(prepared, {"title": "新标题"}, username="alice")
    assert revised["intent"]["title"] == "新标题"
    assert all(user == "alice" for user, _ in calls)
    assert catalog._REQUEST_CATALOG.get() is None
