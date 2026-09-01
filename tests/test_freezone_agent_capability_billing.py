from __future__ import annotations

import pytest

from novelvideo.freezone import agent_capability_billing as billing


def test_workflow_design_charge_is_deterministic() -> None:
    simple = billing.workflow_design_charge(
        {"node_count": 5, "recipe_pipelines": [{"node_id": "one"}]}
    )
    complex_by_nodes = billing.workflow_design_charge(
        {"node_count": 6, "recipe_pipelines": [{"node_id": "one"}]}
    )
    complex_by_recipes = billing.workflow_design_charge(
        {
            "node_count": 3,
            "recipe_pipelines": [{"node_id": "one"}, {"node_id": "two"}],
        }
    )

    assert simple.feature_key == billing.WORKFLOW_SIMPLE_FEATURE_KEY
    assert complex_by_nodes.feature_key == billing.WORKFLOW_COMPLEX_FEATURE_KEY
    assert complex_by_recipes.feature_key == billing.WORKFLOW_COMPLEX_FEATURE_KEY


def test_workflow_design_credit_estimate_separates_agent_and_media_costs() -> None:
    estimate = billing.workflow_design_credit_estimate(
        {"node_count": 13, "recipe_pipelines": []}
    )

    assert estimate == {
        "feature_key": billing.WORKFLOW_COMPLEX_FEATURE_KEY,
        "complexity": "complex",
        "minimum": 20,
        "maximum": 50,
        "display": "20–50 积分",
        "charge_timing": "confirm_create",
        "media_generation_separate": True,
        "note": "仅包含 Agent 工作流设计；图片、音频、视频等节点生成积分另计。",
    }


def test_creative_planning_is_billed_only_for_substantive_draft_delivery() -> None:
    charge = billing.creative_planning_charge(
        {"node_count": 13, "recipe_pipelines": [{"node_id": "video"}]}
    )

    assert charge.feature_key == billing.CREATIVE_PLANNING_FEATURE_KEY
    assert charge.params == {"node_count": 13, "recipe_pipeline_count": 1}
    assert billing.creative_planning_credit_estimate()["display"] == "5–40 积分"


@pytest.mark.anyio
async def test_reserve_agent_capability_is_optional_until_price_is_configured(
    monkeypatch,
) -> None:
    calls: list[dict] = []

    class Meter:
        async def reserve_feature_start_credits(self, **kwargs):
            calls.append(kwargs)
            return {"id": "reservation-1", "cost": 12}

    monkeypatch.setattr(billing, "get_usage_meter", lambda: Meter())

    result = await billing.reserve_agent_capability_charge(
        user_id="user-1",
        project_id="project-1",
        charge=billing.AgentCapabilityCharge(
            billing.RECIPE_DESIGN_FEATURE_KEY,
            quantity=2,
        ),
        idempotency_key="catalog:bridge-1:recipes",
    )

    assert result["id"] == "reservation-1"
    assert calls[0]["product_surface"] == "freezone_assistant"
    assert calls[0]["resource_kind"] == "agent_capability"
    assert calls[0]["quantity"] == 2
    assert calls[0]["require_price_rule"] is False
    assert calls[0]["require_positive_cost"] is False


@pytest.mark.anyio
async def test_skill_studio_charges_only_successful_catalog_delivery(monkeypatch) -> None:
    from novelvideo.api.routes import chat as chat_route

    reserved: list[tuple[str, int, str]] = []
    settled: list[tuple[str, bool]] = []

    async def fake_user_id(*_args, **_kwargs):
        return "user-1"

    async def fake_reserve(*, charge, idempotency_key, **_kwargs):
        reserved.append((charge.feature_key, charge.quantity, idempotency_key))
        return {"id": f"reservation-{len(reserved)}"}

    async def fake_settle(reservation_id, *, confirmed, metadata=None):
        del metadata
        settled.append((reservation_id, confirmed))

    monkeypatch.setattr(chat_route, "_requester_user_id_for_chat", fake_user_id)
    monkeypatch.setattr(chat_route, "reserve_agent_capability_charge", fake_reserve)
    monkeypatch.setattr(chat_route, "settle_agent_capability_charge", fake_settle)
    monkeypatch.setattr(
        chat_route,
        "_resolve_skill_studio_tool_result_payload",
        lambda *_args, **_kwargs: {
            "ok": True,
            "saved_to_catalog": True,
            "skill_studio_status": "catalog_saved",
            "saved_skill_ids": ["skill-1"],
            "saved_recipe_ids": ["recipe-1", "recipe-2"],
        },
    )

    response = await chat_route.resolve_skill_studio_tool_result(
        chat_route.SkillStudioToolResultIn(
            bridge_key="bridge-1",
            project_id="project-1",
            canvas_id="default",
            saved_to_catalog=True,
            skill_studio_status="catalog_saved",
            draft={
                "skill": {"id": "skill-1"},
                "recipes": [{"id": "recipe-1"}, {"id": "recipe-2"}],
            },
        ),
        user={"id": "user-1", "username": "alice"},
    )

    assert response["data"]["saved_to_catalog"] is True
    assert [(item[0], item[1]) for item in reserved] == [
        (billing.SKILL_DESIGN_FEATURE_KEY, 1),
        (billing.RECIPE_DESIGN_FEATURE_KEY, 1),
        (billing.RECIPE_DESIGN_FEATURE_KEY, 1),
    ]
    assert settled == [
        ("reservation-1", True),
        ("reservation-2", True),
        ("reservation-3", True),
    ]


@pytest.mark.anyio
async def test_skill_studio_cancel_does_not_charge(monkeypatch) -> None:
    from novelvideo.api.routes import chat as chat_route

    charged = False

    async def fake_reserve(**_kwargs):
        nonlocal charged
        charged = True
        return {"id": "unexpected"}

    monkeypatch.setattr(chat_route, "reserve_agent_capability_charge", fake_reserve)
    monkeypatch.setattr(
        chat_route,
        "_resolve_skill_studio_tool_result_payload",
        lambda *_args, **_kwargs: {
            "ok": True,
            "saved_to_catalog": False,
            "skill_studio_status": "catalog_cancelled",
        },
    )

    await chat_route.resolve_skill_studio_tool_result(
        chat_route.SkillStudioToolResultIn(
            bridge_key="bridge-cancel",
            action="cancel",
            skill_studio_status="catalog_cancelled",
            draft={"skill": {"id": "skill-1"}, "recipes": []},
        ),
        user={"id": "user-1", "username": "alice"},
    )

    assert charged is False


def test_direct_workflow_detection_skips_billed_draft_path(monkeypatch, tmp_path) -> None:
    from novelvideo.api.routes import chat as chat_route
    from novelvideo.freezone.canvas_command_bridge import put_pending_canvas_command

    monkeypatch.setattr(chat_route, "_canvas_bridge_dir", lambda *_args, **_kwargs: tmp_path)

    def preview_for(key: str, workflow_instance_id: str):
        commands = [
            {
                "type": "create_node",
                "node_type": "videoNode",
                "data": {"workflowInstanceId": workflow_instance_id},
            }
        ]
        put_pending_canvas_command(
            key=key,
            project_id="project-1",
            canvas_id="default",
            commands=commands,
            envelope={
                "schema_version": "canvas_chat_commands.v1",
                "canvas_id": "default",
                "commands": commands,
            },
            bridge_dir=tmp_path,
        )
        return chat_route._pending_direct_workflow_preview(
            "alice",
            chat_route.CanvasCommandToolResultIn(
                bridge_key=key,
                project_id="project-1",
                canvas_id="default",
                canvas_apply_status="applied",
            ),
        )

    assert preview_for("direct-key", "workflow_legacy_1") == {
        "workflow_instance_id": "workflow_legacy_1",
        "node_count": 1,
        "recipe_pipelines": [],
    }
    assert preview_for("draft-key", "workflow_draft_1") is None
