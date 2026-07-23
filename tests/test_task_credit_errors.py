import importlib
import sys

import pytest

from novelvideo.novel_source import (
    NOVEL_IMPORT_REQUIRED_CODE,
    NOVEL_IMPORT_REQUIRED_MESSAGE,
    NovelImportRequiredError,
)
from novelvideo.shared.billing_errors import (
    INSUFFICIENT_CREDITS_CODE,
    INSUFFICIENT_CREDITS_MESSAGE,
    InsufficientCreditsStop,
)
from novelvideo.shared.provider_errors import (
    CONTENT_MODERATION_FAILED_CODE,
    CONTENT_MODERATION_FAILED_MESSAGE,
    INPUT_IMAGE_POLICY_FAILED_MESSAGE,
    OUTPUT_VIDEO_POLICY_FAILED_MESSAGE,
)

pytestmark = pytest.mark.m07


def _import_celery_tasks(monkeypatch):
    monkeypatch.delenv("ST_PROJECT_TASK_TIMEOUT_S", raising=False)
    sys.modules.pop("novelvideo.task_backend.run_core", None)
    return importlib.import_module("novelvideo.task_backend.run_core")


def test_task_serialization_exposes_error_code() -> None:
    from novelvideo.api.routes.tasks import _serialize_task
    from novelvideo.task_state import TaskState

    task = TaskState(
        task_id="task_1",
        task_type="build_characters",
        username="a5",
        project="kk",
        episode=0,
        status="failed",
        metadata={"error_code": INSUFFICIENT_CREDITS_CODE},
    )

    assert _serialize_task(task)["error_code"] == INSUFFICIENT_CREDITS_CODE


def test_celery_task_failure_maps_insufficient_credits_stop(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)

    stop = InsufficientCreditsStop(user_id="usr_1", cost=2, balance=1)

    error, metadata, handled = celery_tasks._project_task_failure_for_exception(stop)

    assert handled is True
    assert error == INSUFFICIENT_CREDITS_MESSAGE
    assert metadata["error_code"] == INSUFFICIENT_CREDITS_CODE
    assert metadata["required"] == 2
    assert metadata["balance"] == 1


def test_task_failure_maps_novel_import_prerequisite(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)

    error, metadata, handled = celery_tasks._project_task_failure_for_exception(
        NovelImportRequiredError()
    )

    assert handled is True
    assert error == NOVEL_IMPORT_REQUIRED_MESSAGE
    assert metadata == {"error_code": NOVEL_IMPORT_REQUIRED_CODE}


def test_celery_task_failure_maps_output_moderation(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)

    exc = RuntimeError(
        'HTTP 400: body={"error":{"message":"output_moderation",'
        '"code":"output_moderation"}}'
    )

    error, metadata, handled = celery_tasks._project_task_failure_for_exception(exc)

    assert handled is True
    assert error == CONTENT_MODERATION_FAILED_MESSAGE
    assert metadata["error_code"] == CONTENT_MODERATION_FAILED_CODE
    assert "output_moderation" in metadata["provider_error"]


def test_celery_task_failure_maps_output_video_policy_violation(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)

    for request_id in ("request-id-a", "request-id-b"):
        exc = RuntimeError(
            "[OutputVideoSensitiveContentDetected.PolicyViolation] The request failed because "
            "the output video may be related to copyright restrictions. "
            f"Request id: {request_id}"
        )

        error, metadata, handled = celery_tasks._project_task_failure_for_exception(exc)

        assert handled is True
        assert error == OUTPUT_VIDEO_POLICY_FAILED_MESSAGE
        assert metadata["message"] == OUTPUT_VIDEO_POLICY_FAILED_MESSAGE
        assert metadata["error_code"] == CONTENT_MODERATION_FAILED_CODE
        assert "OutputVideoSensitiveContentDetected.PolicyViolation" in metadata["provider_error"]
        assert request_id in metadata["provider_error"]


def test_celery_task_failure_maps_input_image_policy_violation(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)

    exc = RuntimeError(
        "[InputImageSensitiveContentDetected.PolicyViolation] The request failed because "
        "the input image may be related to copyright restrictions. "
        "Request id: dynamic-request-id"
    )

    error, metadata, handled = celery_tasks._project_task_failure_for_exception(exc)

    assert handled is True
    assert error == INPUT_IMAGE_POLICY_FAILED_MESSAGE
    assert metadata["message"] == INPUT_IMAGE_POLICY_FAILED_MESSAGE
    assert metadata["error_code"] == CONTENT_MODERATION_FAILED_CODE
    assert "InputImageSensitiveContentDetected.PolicyViolation" in metadata["provider_error"]
    assert "dynamic-request-id" in metadata["provider_error"]


def test_celery_task_failure_maps_soft_time_limit(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)
    from celery.exceptions import SoftTimeLimitExceeded

    error, metadata, handled = celery_tasks._project_task_failure_for_exception(
        SoftTimeLimitExceeded()
    )

    assert handled is True
    assert error == "任务超过 30 分钟未完成，已自动放弃"
    assert metadata == {"error_code": "TASK_TIMEOUT", "timeout_seconds": 30 * 60}


def test_project_task_timeout_is_independent_from_celery_hard_limit(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)

    assert celery_tasks._project_task_timeout_seconds() == 30 * 60


def test_celery_task_failure_maps_cooperative_task_timeout(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)
    from novelvideo.task_backend.cancel import TaskTimedOut

    error, metadata, handled = celery_tasks._project_task_failure_for_exception(
        TaskTimedOut(timeout_seconds=30 * 60)
    )

    assert handled is True
    assert error == "任务超过 30 分钟未完成，已自动放弃"
    assert metadata == {"error_code": "TASK_TIMEOUT", "timeout_seconds": 30 * 60}


def test_celery_task_failure_reraises_non_business_base_exception(monkeypatch) -> None:
    celery_tasks = _import_celery_tasks(monkeypatch)

    with pytest.raises(KeyboardInterrupt):
        celery_tasks._project_task_failure_for_exception(KeyboardInterrupt())
