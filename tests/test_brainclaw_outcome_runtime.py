from types import SimpleNamespace

import pytest

from novelvideo import brainclaw_outcome_runtime as runtime


@pytest.mark.asyncio
async def test_receipt_is_scoped_and_reported(monkeypatch):
    recorded = []
    monkeypatch.setattr(runtime, "outcome_runtime", lambda: SimpleNamespace(enqueue=lambda receipt, passed: recorded.append((receipt, passed))))
    token = runtime.begin_request_outcomes()
    try:
        await runtime.capture_brainclaw_receipt(SimpleNamespace(headers={"x-brainclaw-outcome-receipt": "v1.d.sig"}))
        runtime.report_request_outcomes(passed=True)
    finally:
        runtime.reset_request_outcomes(token)
    assert recorded == [("v1.d.sig", True)]


def test_runtime_is_disabled_without_configuration(monkeypatch):
    monkeypatch.delenv("BRAINCLAW_OUTCOME_URL", raising=False)
    monkeypatch.delenv("BRAINCLAW_OUTCOME_KEY_FILE", raising=False)
    monkeypatch.setattr(runtime, "_runtime", None)
    assert runtime.outcome_runtime() is None
