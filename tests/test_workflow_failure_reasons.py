"""A failed canvas run tells the agent what happened, who can fix it and what to do now."""

import base64
import json
from types import SimpleNamespace

import httpx
import pytest

from novelvideo.freezone.workflow_observation import summarize_workflow_run
from novelvideo.freezone.workflow_runs import workflow_error_diagnostics
from test_freezone_workflow_runs import MISSING_INPUT_ERROR
from test_workflow_observation import FIX_CAUSE_INSTRUCTION

TASK_KEY = "task:freezone_video_generate:project:proj_demo:0:video"
GENERIC_STORED_MESSAGE = "节点生成失败，原因未知。"
UPSTREAM_403 = (
    "Client error '403 Forbidden' for url "
    "'https://gateway.internal.example:8443/v1/video?X-Amz-Signature=0123abcd&sig=zz9'"
)


def _problem(error, *, status="failed", task=None, with_task_ref=True):
    action = {
        "node_id": "video",
        "action": "generate_video",
        "status": status,
        "error": error,
        **({"task_key": TASK_KEY, "job_id": "job_1"} if with_task_ref else {}),
    }
    summary = summarize_workflow_run(
        {"run_id": "run_1", "status": "failed", "actions": [action]},
        tasks_by_key={TASK_KEY: task} if task else None,
    )
    return summary["problems"][0]


def _configuration_problem():
    return _problem(
        "视频生成失败",
        task={
            "error": "unsupported MEDIA_RELAY_PROVIDER: -",
            "metadata": {
                "failure_kind": "configuration",
                "failure_exception": "MediaRelayConfigError",
            },
        },
    )


def _upstream_refusal_problem():
    return _problem(
        "视频生成失败",
        task={
            "error": UPSTREAM_403,
            "metadata": {"upstream_status": 403, "failure_exception": "HTTPStatusError"},
        },
    )


def test_configuration_failure_is_not_the_users_input_and_names_the_operator():
    problem = _configuration_problem()
    assert problem["error_category"] == "configuration"
    assert problem["fixable_by"] == "operator"
    assert problem["retryable"] is False
    assert problem["next_action"] == "contact_operator"
    assert problem["message"] == (
        "服务端配置或部署问题导致生成失败，不是节点输入的问题；"
        "重试或修改画布都无法解决，需要管理员或部署方处理。"
    )
    assert problem["detail"] == "unsupported MEDIA_RELAY_PROVIDER: -"
    assert problem["diagnostics"] == {
        "run_id": "run_1",
        "task_key": TASK_KEY,
        "job_id": "job_1",
        "exception": "MediaRelayConfigError",
    }


def test_upstream_refusal_reports_the_status_without_the_address():
    problem = _upstream_refusal_problem()
    assert problem["error_category"] == "upstream_rejected"
    assert problem["fixable_by"] == "operator"
    assert problem["retryable"] is False
    assert problem["message"] == "上游服务拒绝了本次请求（HTTP 403）。"
    assert problem["diagnostics"]["upstream_status"] == 403
    assert "403 Forbidden" in problem["detail"]
    rendered = json.dumps(problem, ensure_ascii=False)
    for leaked in ("gateway.internal.example", "8443", "0123abcd", "zz9"):
        assert leaked not in rendered


@pytest.mark.parametrize("status", [403, 401])
def test_typed_upstream_refusal_matches_for_image_and_video_errors(status):
    image_error = (
        f"DramaClawAPI image generation failed: HTTP {status}: request_id=; "
        'headers={}; model=demo; body={"error": {"message": '
        '"request refused by upstream policy", "type": "forbidden"}}'
    )
    image = _problem(
        image_error,
        task={
            "error": image_error,
            "metadata": {"upstream_status": status, "failure_exception": "ValueError"},
        },
    )
    video = _problem(
        "request refused by upstream policy",
        task={
            "error": f"freezone video generation failed: DramaClawAPI submit failed: "
            f"HTTP {status} - {{...}}",
            "metadata": {"upstream_status": status, "failure_exception": "RuntimeError"},
        },
    )
    expected = {
        "error_category": "upstream_rejected",
        "message": f"上游服务拒绝了本次请求（HTTP {status}）。",
        "retryable": False,
        "next_action": "review_failure",
        "fixable_by": "operator",
        "automatic_retry": False,
    }
    assert {key: image[key] for key in expected} == {key: video[key] for key in expected}
    assert {key: video[key] for key in expected} == expected
    assert ("agent_instruction" in image) == ("agent_instruction" in video)
    assert image["diagnostics"]["upstream_status"] == video["diagnostics"]["upstream_status"]
    assert video["diagnostics"]["upstream_status"] == status


@pytest.mark.parametrize(
    "error,status,category,fixable_by,retryable,next_action,message",
    [
        (
            "HTTP 401 invalid token", 401, "upstream_rejected", "operator", False,
            "review_failure", "上游服务拒绝了本次请求（HTTP 401）。",
        ),
        (
            "provider failed: HTTP 403 forbidden", 503, "transient_upstream",
            "retry_later",
            True, "retry_after_confirmation",
            "上游模型服务暂时不可用，系统可稍后重试。",
        ),
        (
            "provider failed: HTTP 429 slow down", 400, "upstream_rejected", "unknown",
            False, "review_failure", "上游服务拒绝了本次请求（HTTP 400）。",
        ),
        (
            "provider failed: HTTP 429 slow down", 429, "transient_upstream", "retry_later",
            True, "retry_after_confirmation",
            "上游模型服务暂时不可用，系统可稍后重试。",
        ),
        (
            "provider failed: HTTP 404 not found", 404, "upstream_rejected", "unknown",
            False, "review_failure", "上游服务拒绝了本次请求（HTTP 404）。",
        ),
    ],
    ids=["invalid-token", "typed-503", "typed-400", "typed-429", "typed-404"],
)
def test_typed_upstream_status_decides_status_class_verdict(
    error, status, category, fixable_by, retryable, next_action, message
):
    problem = _problem(error, task={"error": error, "metadata": {"upstream_status": status}})
    assert problem["error_category"] == category
    assert problem["fixable_by"] == fixable_by
    assert problem["retryable"] is retryable
    assert problem["next_action"] == next_action
    assert problem["message"] == message


@pytest.mark.parametrize(
    "error,metadata,category,message,next_action,fixable_by",
    [
        (
            error, {"failure_exception": "ValueError", **status_metadata}, "authentication",
            "模型服务认证失败，请检查渠道地址和密钥后重试。",
            "resolve_access_or_quota", "operator",
        )
        for error, status_metadata in [
            ("HTTP 401 invalid token", {}),
            ("HTTP 403 forbidden", {}),
            ("HTTP 403 forbidden", {"upstream_status": "403"}),
            ("HTTP 403 forbidden", {"upstream_status": True}),
            ("HTTP 403 forbidden", {"upstream_status": 200}),
        ]
    ] + [
        (
            "HTTP 503 unavailable", {"failure_exception": "ValueError"}, "transient_upstream",
            "上游模型服务暂时不可用，系统可稍后重试。",
            "retry_after_confirmation", "retry_later",
        ),
    ],
    ids=["no-status-401", "no-status-403", "string-status", "bool-status", "status-200",
         "no-status-503"],
)
def test_text_decides_status_class_verdict_without_a_valid_typed_status(
    error, metadata, category, message, next_action, fixable_by
):
    problem = _problem(error, task={"error": error, "metadata": metadata})
    assert problem["error_category"] == category
    assert problem["message"] == message
    assert problem["next_action"] == next_action
    assert problem["fixable_by"] == fixable_by


@pytest.mark.parametrize(
    "error,status,category,fixable_by,next_action",
    [
        (
            "HTTP 403 quota has been exhausted", 403, "quota_exhausted", "operator",
            "resolve_access_or_quota",
        ),
        ("HTTP 403 model_not_found", 403, "model_unavailable", "user", "review_failure"),
        ("HTTP 400 SensitiveContent", 400, "content_policy", "user", "review_failure"),
        ("InvalidParameter model", 400, "invalid_request", "user", "correct_parameters"),
        (MISSING_INPUT_ERROR, 400, "input_missing", "user", "fix_input_before_retry"),
    ],
)
def test_typed_upstream_status_preserves_specific_text_causes(
    error, status, category, fixable_by, next_action
):
    problem = _problem(error, task={"error": error, "metadata": {"upstream_status": status}})
    assert problem["error_category"] == category
    assert problem["fixable_by"] == fixable_by
    assert problem["next_action"] == next_action


def test_unknown_cause_says_so_and_gives_leads_instead_of_advice():
    problem = _problem("boom: widget exploded")
    assert problem["error_category"] == "execution"
    assert problem["fixable_by"] == "unknown"
    assert problem["retryable"] is False
    assert problem["next_action"] == "review_failure"
    assert problem["message"] == (
        "生成失败，原因未知。原始错误见 detail，可凭 diagnostics 中的编号排查。"
    )
    assert "检查节点输入" not in problem["message"]
    assert problem["detail"] == "boom: widget exploded"
    assert problem["diagnostics"] == {
        "run_id": "run_1", "task_key": TASK_KEY, "job_id": "job_1",
    }


def test_failure_without_any_error_text_still_gives_leads():
    problem = _problem("")
    assert problem["error_category"] == "unknown"
    assert problem["fixable_by"] == "unknown"
    assert problem["message"] == "生成任务失败，但没有返回具体错误。"
    assert "detail" not in problem
    assert problem["diagnostics"]["run_id"] == "run_1"


def test_the_three_classes_and_missing_input_are_distinguishable():
    problems = {
        "configuration": _configuration_problem(),
        "upstream": _upstream_refusal_problem(),
        "unknown": _problem("boom: widget exploded"),
        "missing_input": _problem(MISSING_INPUT_ERROR),
    }
    assert len({item["error_category"] for item in problems.values()}) == 4
    assert len({item["message"] for item in problems.values()}) == 4
    assert problems["missing_input"]["fixable_by"] == "user"
    assert problems["missing_input"]["next_action"] == "fix_input_before_retry"
    assert problems["unknown"]["fixable_by"] == "unknown"
    # The distinction is carried by data, not by the shared prohibition sentence.
    for item in problems.values():
        assert item["agent_instruction"] == FIX_CAUSE_INSTRUCTION
        without_instruction = {k: v for k, v in item.items() if k != "agent_instruction"}
        assert {"error_category", "message", "fixable_by", "next_action"} <= set(
            without_instruction
        )


@pytest.mark.parametrize(
    "status,next_action,retryable",
    [(503, "retry_after_confirmation", True), (504, "reconcile_before_retry", False)],
)
def test_typed_upstream_status_follows_the_existing_status_rules(
    status, next_action, retryable
):
    problem = _problem(
        "视频生成失败",
        task={"error": "upstream gave up", "metadata": {"upstream_status": status}},
    )
    assert problem["error_category"] == "transient_upstream"
    assert problem["message"] == "上游模型服务暂时不可用，系统可稍后重试。"
    assert problem["fixable_by"] == "retry_later"
    assert problem["next_action"] == next_action
    assert problem["retryable"] is retryable


def test_typed_signal_never_overrides_a_recognised_error_text():
    problem = _problem(
        MISSING_INPUT_ERROR,
        task={"error": MISSING_INPUT_ERROR, "metadata": {"failure_kind": "configuration"}},
    )
    assert problem["error_category"] == "input_missing"
    assert problem["fixable_by"] == "user"


def test_blocked_action_points_at_the_upstream_failure():
    summary = summarize_workflow_run({
        "run_id": "run_1", "status": "failed", "actions": [
            {"node_id": "image", "action": "generate_image", "status": "failed",
             "error": MISSING_INPUT_ERROR},
            {"node_id": "video", "action": "generate_video", "status": "blocked",
             "error": "跳过 generate_video：上游节点 image 未成功完成。"},
        ],
    })
    blocked = summary["problems"][1]
    assert blocked["error_category"] == "dependency_blocked"
    assert blocked["message"] == "上游节点未成功完成，本节点未执行；请先处理上游节点的问题。"
    assert blocked["next_action"] == "resolve_dependency"
    assert blocked["fixable_by"] == "user"
    assert blocked["detail"] == "跳过 generate_video：上游节点 image 未成功完成。"


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


# Secret-shaped samples are assembled at run time so no such literal sits in the source.
_FAKE_KEY = "-".join(["sk", "fake", "0123456789abcdef"])
_FAKE_LONG_KEY = "-".join(["sk", "fakeLIVE0123456789abcdefXYZ"])
_FAKE_JWT_PARTS = [_b64('{"alg":"HS256"}'), _b64('{"sub":"fake"}'), _b64("signaturefake")]
_FAKE_ACCESS_KEY = "AKIA" + "FAKE" * 3 + "1234"
_FAKE_PASSWORD = "hunter2" + "fake"


@pytest.mark.parametrize(
    "secret_text,leaks",
    [
        (f"auth failed api_key={_FAKE_KEY}", [_FAKE_KEY]),
        (f"call rejected for key {_FAKE_LONG_KEY}", ["sk-fakeLIVE"]),
        ("Authorization: Bearer " + ".".join(["fakebearer", "value", "123"]), ["fakebearer"]),
        (
            "GET https://bucket.oss.example.com/a/b.png?Signature=FAKESIG123&Expires=99 failed",
            ["bucket.oss.example.com", "FAKESIG123", "Expires=99"],
        ),
        ("connect to 10.20.30.40:6379 refused", ["10.20.30.40", "6379"]),
        ("cannot reach redis.prod.internal:6380", ["redis.prod.internal", "6380"]),
        ("lookup of media-relay.default.svc.cluster.local failed", ["svc.cluster.local"]),
        ("cannot read /Users/someone/.config/app/credentials.json", ["someone", ".config"]),
        ("open C:\\Users\\someone\\keys\\id_rsa failed", ["someone", "id_rsa"]),
        (
            "jwt " + ".".join(_FAKE_JWT_PARTS) + " rejected",
            [_FAKE_JWT_PARTS[0], _FAKE_JWT_PARTS[2]],
        ),
        (f"access key {_FAKE_ACCESS_KEY} denied", [_FAKE_ACCESS_KEY]),
        (f"password={_FAKE_PASSWORD} rejected", [_FAKE_PASSWORD]),
    ],
    ids=[
        "api-key", "bare-key", "bearer", "signed-url", "ip-port", "internal-host-port",
        "cluster-host", "posix-path", "windows-path", "jwt", "access-key", "password",
    ],
)
@pytest.mark.parametrize("source", ["action", "task"])
def test_failure_detail_never_carries_secrets_addresses_or_paths(
    secret_text, leaks, source
):
    problem = (
        _problem(secret_text)
        if source == "action"
        else _problem("视频生成失败", task={"error": secret_text, "metadata": {}})
    )
    rendered = json.dumps(problem, ensure_ascii=False)
    for leaked in leaks:
        assert leaked not in rendered
    assert problem["detail"]


def test_failure_detail_is_bounded():
    assert len(_problem("x" * 5000)["detail"]) <= 500


RECOGNISED = [
    (MISSING_INPUT_ERROR, "input_missing", None, False, "fix_input_before_retry", "user"),
    ("HTTP 401 invalid token", "authentication",
     "模型服务认证失败，请检查渠道地址和密钥后重试。", False, "resolve_access_or_quota",
     "operator"),
    ("HTTP 403 model_not_found", "model_unavailable",
     "当前渠道没有可用的目标模型，请更换模型或配置渠道。", False, "review_failure", "user"),
    ("HTTP 403 quota has been exhausted", "quota_exhausted",
     "当前模型渠道额度已用尽，请补充额度或切换渠道。", False, "resolve_access_or_quota",
     "operator"),
    ("HTTP 403 SensitiveContent", "content_policy",
     "内容安全审核未通过：模型拒绝了本次生成请求，请调整提示词或更换素材后重试。",
     False, "review_failure", "user"),
    ("InvalidParameter model", "invalid_request",
     "生成参数不符合当前模型要求，请调整节点参数后重试。", False, "correct_parameters",
     "user"),
    ("HTTP 503 unavailable", "transient_upstream",
     "上游模型服务暂时不可用，系统可稍后重试。", True, "retry_after_confirmation",
     "retry_later"),
    ("任务产物不存在", "artifact_missing",
     "任务已结束但没有找到有效产物，请重新生成该节点。", False, "review_failure", "user"),
]


@pytest.mark.parametrize(
    "error,category,message,retryable,next_action,fixable_by", RECOGNISED
)
def test_recognised_failures_keep_their_category_message_and_recovery(
    error, category, message, retryable, next_action, fixable_by
):
    problem = _problem(error, with_task_ref=False)
    stored = workflow_error_diagnostics(error)
    assert problem["error_category"] == stored["error_category"] == category
    assert problem["message"] == stored["user_error"]
    if message is not None:
        assert problem["message"] == message
    assert problem["retryable"] is retryable
    assert problem["next_action"] == next_action
    assert problem["fixable_by"] == fixable_by
    assert problem["automatic_retry"] is False
    assert ("agent_instruction" in problem) is (not retryable)


def test_stored_canvas_diagnostics_report_an_unknown_cause():
    assert workflow_error_diagnostics("boom: widget exploded") == {
        "error_category": "execution",
        "retryable": False,
        "error_request_id": None,
        "error_fingerprint": "execution:boom: widget exploded",
        "user_error": GENERIC_STORED_MESSAGE,
    }
    assert workflow_error_diagnostics("")["user_error"] == "生成任务失败，但没有返回具体错误。"


def test_summary_shape_only_gains_problem_fields():
    summary = summarize_workflow_run({
        "run_id": "run_1", "status": "failed", "actions": [
            {"node_id": "video", "action": "generate_video", "status": "failed",
             "error": "boom: widget exploded"},
        ],
    })
    assert summary.keys() == {
        "ok", "status", "run_id", "run_status", "terminal", "counts", "total_count",
        "progress", "problems", "observation_token", "next_action", "automatic_retry",
    }
    assert summary["problems"][0].keys() == {
        "node_id", "action", "error_category", "message", "retryable", "automatic_retry",
        "next_action", "agent_instruction", "fixable_by", "detail", "diagnostics",
    }


# --- typed signals taken where the exception is still an object ---------------------


def _http_status_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://gateway.internal.example/v1/video?sig=zz9")
    response = httpx.Response(status, request=request)
    return httpx.HTTPStatusError("refused", request=request, response=response)


def _config_errors():
    from novelvideo.freezone.agent_canvas_config import AgentCanvasConfigError
    from novelvideo.ports.model_credentials import ModelCredentialError
    from novelvideo.ports.registry import PortNotRegistered
    from novelvideo.storage.media_errors import (
        MediaRelayConfigError,
        MediaStorageUnavailable,
    )
    from novelvideo.task_backend.signing import TaskEnvelopeSigningConfigError

    return [
        MediaRelayConfigError("unsupported MEDIA_RELAY_PROVIDER: -"),
        MediaStorageUnavailable("MEDIA_STORAGE_CONFIG_INVALID", "bad"),
        AgentCanvasConfigError("bad executor"),
        ModelCredentialError("ORG_CREDENTIAL_MISSING"),
        PortNotRegistered("usage_meter"),
        TaskEnvelopeSigningConfigError(),
    ]


@pytest.mark.parametrize("exc", _config_errors(), ids=lambda exc: type(exc).__name__)
def test_configuration_exception_classes_declare_their_kind(exc):
    from novelvideo.shared.failure_signals import exception_failure_signal

    assert exception_failure_signal(exc) == {
        "failure_kind": "configuration",
        "failure_exception": type(exc).__name__,
    }


def test_signal_is_found_through_the_exception_chain():
    from novelvideo.shared.failure_signals import exception_failure_signal
    from novelvideo.storage.media_errors import MediaRelayConfigError

    try:
        try:
            raise MediaRelayConfigError("unsupported MEDIA_RELAY_PROVIDER: -")
        except MediaRelayConfigError as inner:
            raise RuntimeError("video generation failed") from inner
    except RuntimeError as exc:
        signal = exception_failure_signal(exc)
    assert signal == {"failure_kind": "configuration", "failure_exception": "RuntimeError"}


def test_upstream_http_status_is_taken_from_the_exception_not_its_text():
    from novelvideo.shared.failure_signals import exception_failure_signal

    assert exception_failure_signal(_http_status_error(403)) == {
        "upstream_status": 403,
        "failure_exception": "HTTPStatusError",
    }
    assert exception_failure_signal(ValueError("status 403 in text only")) == {
        "failure_exception": "ValueError",
    }


@pytest.mark.parametrize(
    "exc_factory,expected",
    [
        (
            lambda: __import__(
                "novelvideo.storage.media_errors", fromlist=["MediaRelayConfigError"]
            ).MediaRelayConfigError("unsupported MEDIA_RELAY_PROVIDER: -"),
            {"failure_kind": "configuration", "failure_exception": "MediaRelayConfigError"},
        ),
        (
            lambda: _http_status_error(403),
            {"upstream_status": 403, "failure_exception": "HTTPStatusError"},
        ),
        (lambda: ValueError("boom"), {"failure_exception": "ValueError"}),
    ],
)
def test_failed_task_records_the_typed_signal_and_refund_metadata_is_untouched(
    monkeypatch, exc_factory, expected
):
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner
    from test_task_timeout import _FakeTaskManager, _verified_delivery

    refunds: list[dict] = []

    def failing_runner(_envelope, _ctx):
        raise exc_factory()

    async def not_cancelled(**_kwargs):
        return False

    async def no_metrics(*_args, **_kwargs):
        return None

    async def record_refund(_reservation_id, *, metadata):
        refunds.append(metadata)

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", not_cancelled)
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", no_metrics)
    monkeypatch.setattr(
        run_core, "_set_project_task_metrics_context", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    monkeypatch.setattr(
        run_core, "_refund_undelivered_feature_credit_reservation", record_refund
    )
    register_project_task_runner("failure_signal_probe", failing_runner)

    manager = _FakeTaskManager()
    with pytest.raises(Exception):
        run_core.run_project_task_core_sync(
            _verified_delivery(task_type="failure_signal_probe"),
            SimpleNamespace(
                project_id="proj_timeout", requester_user_id="usr_1", is_home_node=True
            ),
            manager,
            run_task_id="task_1",
        )

    (failed,) = manager.failed
    recorded = {
        key: failed["metadata"].get(key)
        for key in ("failure_kind", "upstream_status", "failure_exception")
        if key in failed["metadata"]
    }
    assert recorded == expected
    assert "gateway.internal.example" not in json.dumps(failed, ensure_ascii=False, default=str)
    (refund,) = refunds
    assert set(refund) == {"source", "error"}
