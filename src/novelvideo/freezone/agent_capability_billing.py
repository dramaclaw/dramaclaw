"""Billing contract for high-value Freezone Agent deliverables.

Ordinary chat, canvas manipulation, and execution of existing media workflows are
intentionally outside this contract. Media generation remains billed by its existing
NewAPI-backed feature/model call paths.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from novelvideo.ports import get_usage_meter

PRODUCT_SURFACE = "freezone_assistant"
RESOURCE_KIND = "agent_capability"

WORKFLOW_SIMPLE_FEATURE_KEY = "freezone.agent.workflow_design.simple"
WORKFLOW_COMPLEX_FEATURE_KEY = "freezone.agent.workflow_design.complex"
CREATIVE_PLANNING_FEATURE_KEY = "freezone.agent.creative_planning"
SKILL_DESIGN_FEATURE_KEY = "freezone.agent.skill_design"
RECIPE_DESIGN_FEATURE_KEY = "freezone.agent.recipe_design"

CREATIVE_PLANNING_REFERENCE_CREDITS = (5, 40)
WORKFLOW_SIMPLE_REFERENCE_CREDITS = (10, 20)
WORKFLOW_COMPLEX_REFERENCE_CREDITS = (20, 50)


@dataclass(frozen=True)
class AgentCapabilityCharge:
    feature_key: str
    quantity: int = 1
    params: dict[str, Any] | None = None


AGENT_CAPABILITY_PRICE_REFERENCE = (
    {
        "key": "ordinary_chat",
        "label": "普通聊天与咨询",
        "examples": "问候、解释、查看状态和使用帮助",
        "billing": "free",
        "reference_display": "免费",
    },
    {
        "key": "ordinary_canvas",
        "label": "普通画布操作",
        "examples": "创建、连接、移动、排版或删除普通节点",
        "billing": "free",
        "reference_display": "免费",
    },
    {
        "key": CREATIVE_PLANNING_FEATURE_KEY,
        "label": "创意讨论与方案规划",
        "examples": "形成可执行的 Workflow、Skill 或 Recipe 方案草稿",
        "billing": "configured_feature_price",
        "reference_display": "5–40 积分 / 次",
        "unit": "planning_turn",
    },
    {
        "key": "existing_capability",
        "label": "运行已有 Workflow / Recipe",
        "examples": "复用已有能力；媒体生成仍由 NewAPI 单独计费",
        "billing": "free",
        "reference_display": "Agent 免费",
    },
    {
        "key": WORKFLOW_SIMPLE_FEATURE_KEY,
        "label": "创建简单 Workflow",
        "examples": "不超过 5 个节点且不超过 1 条 Recipe 流水线",
        "billing": "configured_feature_price",
        "reference_display": "10–20 积分 / 个",
        "unit": "workflow",
    },
    {
        "key": WORKFLOW_COMPLEX_FEATURE_KEY,
        "label": "创建复杂 Workflow",
        "examples": "超过 5 个节点或包含多条 Recipe 流水线",
        "billing": "configured_feature_price",
        "reference_display": "20–50 积分 / 个",
        "unit": "workflow",
    },
    {
        "key": RECIPE_DESIGN_FEATURE_KEY,
        "label": "生成或重构 Recipe",
        "examples": "按最终成功保存的 Recipe 数量计费",
        "billing": "configured_feature_price",
        "reference_display": "8–20 积分 / 个",
        "unit": "recipe",
    },
    {
        "key": SKILL_DESIGN_FEATURE_KEY,
        "label": "生成或重构 Skill",
        "examples": "按最终成功保存的 Skill 数量计费",
        "billing": "configured_feature_price",
        "reference_display": "15–35 积分 / 个",
        "unit": "skill",
    },
)


def workflow_design_charge(preview: dict[str, Any] | None) -> AgentCapabilityCharge:
    value = preview if isinstance(preview, dict) else {}
    node_count = max(int(value.get("node_count") or 0), 0)
    pipelines = value.get("recipe_pipelines")
    pipeline_count = len(pipelines) if isinstance(pipelines, list) else 0
    complex_workflow = node_count > 5 or pipeline_count > 1
    return AgentCapabilityCharge(
        feature_key=(
            WORKFLOW_COMPLEX_FEATURE_KEY
            if complex_workflow
            else WORKFLOW_SIMPLE_FEATURE_KEY
        ),
        params={
            "complexity": "complex" if complex_workflow else "simple",
            "node_count": node_count,
            "recipe_pipeline_count": pipeline_count,
        },
    )


def creative_planning_charge(preview: dict[str, Any] | None) -> AgentCapabilityCharge:
    value = preview if isinstance(preview, dict) else {}
    return AgentCapabilityCharge(
        feature_key=CREATIVE_PLANNING_FEATURE_KEY,
        params={
            "node_count": max(int(value.get("node_count") or 0), 0),
            "recipe_pipeline_count": len(value.get("recipe_pipelines") or []),
        },
    )


def creative_planning_credit_estimate() -> dict[str, Any]:
    minimum, maximum = CREATIVE_PLANNING_REFERENCE_CREDITS
    return {
        "feature_key": CREATIVE_PLANNING_FEATURE_KEY,
        "minimum": minimum,
        "maximum": maximum,
        "display": f"{minimum}–{maximum} 积分",
        "charge_timing": "planning_delivered",
    }


def workflow_design_credit_estimate(preview: dict[str, Any] | None) -> dict[str, Any]:
    """Build a safe, user-facing estimate without exposing reservation details."""
    charge = workflow_design_charge(preview)
    is_complex = charge.feature_key == WORKFLOW_COMPLEX_FEATURE_KEY
    minimum, maximum = (
        WORKFLOW_COMPLEX_REFERENCE_CREDITS
        if is_complex
        else WORKFLOW_SIMPLE_REFERENCE_CREDITS
    )
    return {
        "feature_key": charge.feature_key,
        "complexity": "complex" if is_complex else "simple",
        "minimum": minimum,
        "maximum": maximum,
        "display": f"{minimum}–{maximum} 积分",
        "charge_timing": "confirm_create",
        "media_generation_separate": True,
        "note": "仅包含 Agent 工作流设计；图片、音频、视频等节点生成积分另计。",
    }


async def reserve_agent_capability_charge(
    *,
    user_id: str,
    project_id: str,
    charge: AgentCapabilityCharge,
    idempotency_key: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Reserve a configured Agent capability price without breaking CE/unpriced installs."""
    return await get_usage_meter().reserve_feature_start_credits(
        user_id=user_id,
        feature_key=charge.feature_key,
        product_surface=PRODUCT_SURFACE,
        project_id=project_id,
        resource_kind=RESOURCE_KIND,
        task_type=charge.feature_key,
        metadata={"billing_scope": "agent_deliverable", **(metadata or {})},
        params=charge.params or {},
        quantity=max(int(charge.quantity), 1),
        idempotency_key=idempotency_key,
        # Existing deployments may not have the new price rows yet. In that case
        # the capability remains available and the adapter returns an unreserved
        # zero-cost result. Once prices are configured, the same path charges.
        require_price_rule=False,
        require_positive_cost=False,
    )


async def settle_agent_capability_charge(
    reservation_id: str,
    *,
    confirmed: bool,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not reservation_id:
        return
    meter = get_usage_meter()
    if confirmed:
        await meter.settle_feature_credit_reservation(
            reservation_id,
            action="confirm",
            metadata=metadata,
        )
    else:
        await meter.settle_cancelled_feature_credit_reservation(
            reservation_id,
            metadata=metadata,
        )
