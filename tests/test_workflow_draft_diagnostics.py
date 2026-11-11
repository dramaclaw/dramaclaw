"""Preparation observations must never relax validation or disclose user content."""

import json
import logging

import pytest
from jsonschema import Draft202012Validator

from novelvideo.freezone import workflow_draft_diagnostics as diagnostics
from novelvideo.freezone.workflow_planning import (
    GENERATION_PARAMETER_PLANNING_INSTRUCTIONS,
)
from novelvideo.freezone.workflow_schema import workflow_intent_json_schema
from test_freezone_plugin import _load_plugin_module
from test_freezone_plugin import _restore_tools_registry_modules as _registry_fixture

_restore_tools_registry_modules = _registry_fixture


@pytest.fixture()
def observations(monkeypatch):
    counts = []
    monkeypatch.setattr(diagnostics.evidence_metrics, "observe_batch", counts.extend)
    return counts


@pytest.mark.parametrize(
    ("result", "raised", "outcome"),
    [
        ({"ok": True, "draft_id": "draft"}, False, "success"),
        ({"ok": False, "status": "invalid_workflow_intent"}, False, "rejected"),
        (
            {"ok": False, "code": "generation_parameters_required"},
            False,
            "clarification",
        ),
        (None, True, "exception"),
        (None, False, "unknown"),
    ],
)
def test_counts_each_preparation_outcome(observations, result, raised, outcome):
    diagnostics.observe_preparation(
        "freezone_prepare_workflow_draft", {}, result, elapsed_ms=250, raised=raised
    )
    assert observations.count("workflow_draft.intent.calls") == 1
    assert f"workflow_draft.intent.outcome.{outcome}" in observations
    assert "workflow_draft.intent.latency.1000" in observations


def test_redacts_raw_errors_prompts_node_ids_and_untrusted_codes(observations, caplog):
    secret = "Bearer-private-user-story"
    operation = "agent_product_" + "a" * 32
    caplog.set_level(logging.INFO, logger=diagnostics.__name__)
    diagnostics.observe_preparation(
        "freezone_prepare_workflow_plan_draft",
        {"operation_id": operation, "user_goal": secret, "api_key": secret},
        {
            "ok": False,
            "error": secret,
            "code": secret,
            "preflight": {
                "blockers": [
                    {
                        "code": "recommended_model_unavailable",
                        "path": f"runtime.models.{secret}.model",
                        "message": secret,
                    }
                ]
            },
            "errors": [{"path": "items[15].recipe_id", "hint": secret}],
        },
        elapsed_ms=12,
    )
    visible = json.dumps(observations) + caplog.text
    assert secret not in visible
    assert operation not in visible
    assert "workflow_draft.plan.path.runtime.models.*.model" in observations
    assert "workflow_draft.plan.path.items.[].recipe_id" in observations
    assert "workflow_draft.plan.code.recommended_model_unavailable" in observations
    assert "operation_hash=" in caplog.text


def test_telemetry_storage_failure_is_nonfatal(monkeypatch):
    def unavailable(_name):
        raise OSError("private storage error")

    monkeypatch.setattr(diagnostics.evidence_metrics, "observe_batch", unavailable)
    diagnostics.observe_preparation(
        "freezone_prepare_workflow_draft", {}, {"ok": True}, elapsed_ms=1
    )


@pytest.mark.parametrize("render_json", [False, True])
def test_wrapper_preserves_result_and_records_once(observations, render_json):
    plugin = _load_plugin_module()
    result = {"ok": False, "status": "workflow_intent_required", "error": "unchanged"}
    returned = json.dumps(result) if render_json else result
    calls = []

    def handler(args):
        calls.append(args)
        return returned

    arguments = {"operation_id": "original"}
    wrapped = plugin._bind_structured_result_input(
        handler, "freezone_prepare_workflow_draft"
    )
    assert wrapped(arguments) is returned
    assert calls == [arguments]
    assert observations.count("workflow_draft.intent.calls") == 1
    assert "workflow_draft.intent.code.workflow_intent_required" in observations
    assert plugin._STRUCTURED_RESULT_INPUT_HASH.get() is None


def test_wrapper_preserves_original_exception_even_if_observer_raises(monkeypatch):
    plugin = _load_plugin_module()
    original = RuntimeError("original failure")

    def handler(_args):
        raise original

    def broken_observer(*args, **kwargs):
        raise OSError("diagnostic storage failed")

    monkeypatch.setattr(diagnostics, "observe_preparation", broken_observer)
    wrapped = plugin._bind_structured_result_input(
        handler, "freezone_prepare_workflow_draft"
    )
    with pytest.raises(RuntimeError) as caught:
        wrapped({})
    assert caught.value is original
    assert plugin._STRUCTURED_RESULT_INPUT_HASH.get() is None


def test_registered_preparation_observes_rejections_before_http(
    observations, monkeypatch
):
    plugin = _load_plugin_module()
    monkeypatch.setattr(
        plugin, "_request", lambda *a, **kw: pytest.fail("must not request HTTP")
    )
    handler = next(
        handler
        for name, _, handler in plugin.TOOLS
        if name == "freezone_prepare_workflow_draft"
    )
    result = handler({"project_id": "p", "canvas_id": "c"})
    assert result["status"] == "workflow_intent_required"
    assert "workflow_draft.intent.outcome.rejected" in observations


def test_draft_schema_rejects_missing_intent_but_accepts_existing_valid_shape():
    plugin = _load_plugin_module()
    schemas = {name: schema for name, schema, _ in plugin.TOOLS}
    schema = schemas["freezone_prepare_workflow_draft"]["parameters"]
    validator = Draft202012Validator(schema)
    assert list(validator.iter_errors({"operation_id": "operation"}))
    assert not list(
        validator.iter_errors(
            {
                "operation_id": "operation",
                "intent": {"skill_id": "text-to-image", "user_goal": "draw a cup"},
            }
        )
    )
    assert schema["properties"]["intent"] == workflow_intent_json_schema()
    assert (
        "run_after_create"
        not in schemas["freezone_confirm_workflow_draft"]["parameters"]["properties"]
    )
    assert schema["additionalProperties"] is False


def test_prepare_tools_share_parameter_contract_with_planning_package():
    plugin = _load_plugin_module()
    schemas = {name: schema for name, schema, _ in plugin.TOOLS}
    for name in diagnostics.PREPARATION_TOOLS:
        assert (
            GENERATION_PARAMETER_PLANNING_INSTRUCTIONS in schemas[name]["description"]
        )
        assert "or a recommended model id" not in schemas[name]["description"]
    from novelvideo.freezone.workflow_planning import WORKFLOW_PLANNING_INSTRUCTIONS

    assert GENERATION_PARAMETER_PLANNING_INSTRUCTIONS in WORKFLOW_PLANNING_INSTRUCTIONS


def test_prepare_schema_requires_exactly_one_source_without_changing_handler_fallback():
    plugin = _load_plugin_module()
    schema = next(
        schema
        for name, schema, _ in plugin.TOOLS
        if name == "freezone_prepare_workflow"
    )["parameters"]
    validator = Draft202012Validator(schema)
    intent = {"skill_id": "text-to-image", "user_goal": "draw a cup"}
    plan = {
        "nodes": [
            {
                "id": "source",
                "node_type": "textAnnotationNode",
                "stage": "input",
                "data": {"content": "source text"},
            }
        ],
        "edges": [],
    }
    assert list(validator.iter_errors({"operation_id": "operation"}))
    assert list(
        validator.iter_errors(
            {"operation_id": "operation", "intent": intent, "plan": plan}
        )
    )
    assert not list(
        validator.iter_errors({"operation_id": "operation", "intent": intent})
    )
    assert not list(validator.iter_errors({"operation_id": "operation", "plan": plan}))
    old_client_result = plugin._handle_prepare_workflow(
        {"project_id": "p", "canvas_id": "c"}
    )
    assert old_client_result["status"] == "workflow_source_required"
