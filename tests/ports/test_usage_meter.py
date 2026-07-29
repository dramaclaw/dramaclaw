import pytest

from novelvideo.ports.local.usage import NoOpUsageMeter


@pytest.mark.asyncio
async def test_noop_usage_meter_supports_full_usage_surface() -> None:
    meter = NoOpUsageMeter()

    reservation = await meter.reserve_current_model_call_credit(model="gpt-test")
    access = await meter.require_feature_credit_balance(
        user_id="u1",
        feature_key="ai_assistant_chat",
        project_id="p1",
        resource_kind="chat",
    )
    await meter.bump_model_call(user_id="u1", model="gpt-test", credit_reservation_id=reservation)
    await meter.refund_model_call_credit_reservation(reservation)
    meter.set_llm_usage_context("u1", project_id="p1", resource_kind="script")
    meter.clear_llm_usage_context()
    await meter.set_project_llm_usage_context(username="alice", project_name="demo")
    await meter.bump_content_counter(
        user_id="u1",
        metric="beats_written",
        value=3,
        model="gpt-test",
        project_id="p1",
        resource_kind="script",
    )
    await meter.log_resource_attempts(
        user_id="u1",
        project_id="p1",
        kind="sketch",
        refs=["beat-1"],
        outcome="success",
        model="gpt-test",
    )
    await meter.record_llm_tokens(
        user_id="u1",
        input_tokens=11,
        output_tokens=7,
        model="gpt-test",
        project_id="p1",
        resource_kind="script",
    )

    assert reservation == ""
    assert access["allowed"] is True
    assert access["required_balance"] == 0
    assert await meter.get_user_credit_balance("u1") == 0
