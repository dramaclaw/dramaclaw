from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient


class DummyUsageMeter:
    def __init__(self) -> None:
        self.reserve_calls: list[dict] = []
        self.confirm_calls: list[tuple[str, dict | None]] = []
        self.refund_calls: list[tuple[str, dict | None]] = []
        self.interrupted_calls: list[tuple[str, dict | None]] = []
        self.contexts: list[dict] = []
        self.clear_count = 0

    async def reserve_feature_start_credits(self, **kwargs):
        self.reserve_calls.append(kwargs)
        return {"id": "style-analysis-reservation", "cost": 7}

    async def settle_feature_credit_reservation(
        self, reservation_id: str, *, action: str, metadata=None
    ):
        target = self.confirm_calls if action == "confirm" else self.refund_calls
        target.append((reservation_id, metadata))

    async def settle_cancelled_feature_credit_reservation(
        self, reservation_id: str, *, metadata=None
    ):
        self.interrupted_calls.append((reservation_id, metadata))

    def set_llm_usage_context(
        self,
        user_id: str,
        project_id: str = "",
        resource_kind: str = "",
        billing_metadata: dict | None = None,
    ) -> None:
        self.contexts.append(
            {
                "user_id": user_id,
                "project_id": project_id,
                "resource_kind": resource_kind,
                "billing_metadata": billing_metadata or {},
            }
        )

    def clear_llm_usage_context(self) -> None:
        self.clear_count += 1


def _client(
    monkeypatch, tmp_path, usage_meter: DummyUsageMeter, analyzer_type
) -> TestClient:
    from novelvideo import ports
    from novelvideo.api.routes import styles
    from novelvideo.generators import style_analyzer

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return SimpleNamespace(
            ctx=SimpleNamespace(
                project_id="project-1",
                requester_user_id="user-1",
            ),
            username="admin",
            project_name="demo",
            project_dir=tmp_path,
        )

    monkeypatch.setattr(styles, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(ports, "get_usage_meter", lambda: usage_meter)
    monkeypatch.setattr(style_analyzer, "StyleAnalyzer", analyzer_type)
    monkeypatch.setenv("STYLE_ANALYZER_MODEL", "style-analysis-model")

    app = FastAPI()
    app.include_router(styles.router)
    app.dependency_overrides[styles.get_api_user] = lambda: {
        "id": "user-1",
        "username": "admin",
    }
    return TestClient(app)


def test_style_analysis_reserves_and_confirms_feature_credit(monkeypatch, tmp_path):
    class SuccessfulAnalyzer:
        async def analyze(self, content: bytes, *, mime_type: str):
            return {
                "style_tag": "CINEMATIC",
                "size": len(content),
                "mime_type": mime_type,
            }

    usage_meter = DummyUsageMeter()
    client = _client(monkeypatch, tmp_path, usage_meter, SuccessfulAnalyzer)

    response = client.post(
        "/projects/demo/styles/analyze",
        files={"file": ("style.png", b"image-content", "image/png")},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert usage_meter.reserve_calls == [
        {
            "user_id": "user-1",
            "feature_key": "mainline.style_analysis",
            "product_surface": "mainline",
            "project_id": "project-1",
            "resource_kind": "script",
            "task_type": "style_analysis",
            "metadata": {
                "source": "sync_api",
                "endpoint": "analyze_style",
                "mime_type": "image/png",
            },
            "params": {
                "pricing_kind": "text",
                "pricing_model": "style-analysis-model",
                "pricing_params": {},
                "pricing_quantity": 1,
            },
            "require_price_rule": True,
            "require_positive_cost": True,
        }
    ]
    assert usage_meter.contexts[0]["billing_metadata"] == {
        "model_call_credit_policy": "feature_included",
        "feature_key": "mainline.style_analysis",
        "source": "sync_api",
        "feature_credit_reservation_id": "style-analysis-reservation",
        "feature_credit_charge_id": "style-analysis-reservation",
        "feature_credit_cost": "7",
    }
    assert usage_meter.confirm_calls[0][0] == "style-analysis-reservation"
    assert usage_meter.refund_calls == []
    assert usage_meter.clear_count == 1


def test_style_analysis_uses_evidence_settlement_on_failure(monkeypatch, tmp_path):
    class FailingAnalyzer:
        async def analyze(self, content: bytes, *, mime_type: str):
            raise RuntimeError("upstream failed")

    usage_meter = DummyUsageMeter()
    client = _client(monkeypatch, tmp_path, usage_meter, FailingAnalyzer)

    response = client.post(
        "/projects/demo/styles/analyze",
        files={"file": ("style.png", b"image-content", "image/png")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "error": "Style analysis failed: upstream failed",
    }
    assert usage_meter.confirm_calls == []
    assert usage_meter.refund_calls == []
    assert usage_meter.interrupted_calls[0][0] == "style-analysis-reservation"
    assert usage_meter.clear_count == 1
