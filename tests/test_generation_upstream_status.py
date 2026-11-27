"""An upstream HTTP refusal keeps its status code all the way to the failed task.

The generation paths turn the provider's HTTP error into text before the task fails. These tests
drive each path with a fake upstream and check that the exception the task runner would see still
carries the status as data, so the run summary can tell "upstream refused" from "cause unknown".
"""

from pathlib import Path

import httpx
import pytest
import respx

from novelvideo.freezone.workflow_observation import summarize_workflow_run
from novelvideo.shared.failure_signals import exception_failure_signal

TASK_KEY = "task:freezone_gen:project:proj_demo:0:node"
STATUSES = [403, 429, 503]
# status -> (error_category, fixable_by, retryable)
EXPECTED = {
    403: ("upstream_rejected", "operator", False),
    429: ("transient_upstream", "retry_later", True),
    503: ("transient_upstream", "retry_later", True),
}


def _problem_for(exc: BaseException, *, stored_error: str = "生成失败") -> dict:
    """What the agent receives when a task fails with ``exc``."""
    summary = summarize_workflow_run(
        {
            "run_id": "run_1",
            "status": "failed",
            "actions": [
                {
                    "node_id": "node",
                    "action": "generate",
                    "status": "failed",
                    "error": stored_error,
                    "task_key": TASK_KEY,
                    "job_id": "job_1",
                }
            ],
        },
        tasks_by_key={TASK_KEY: {"error": str(exc), "metadata": exception_failure_signal(exc)}},
    )
    return summary["problems"][0]


def _assert_upstream_problem(exc: BaseException, status: int) -> None:
    assert exception_failure_signal(exc).get("upstream_status") == status
    problem = _problem_for(exc)
    category, fixable_by, retryable = EXPECTED[status]
    assert problem["error_category"] == category
    assert problem["fixable_by"] == fixable_by
    assert problem["retryable"] is retryable
    assert problem["diagnostics"]["upstream_status"] == status
    assert problem["diagnostics"]["exception"] == type(exc).__name__


# --- the signal itself ---------------------------------------------------------------


def test_a_status_attached_to_any_exception_is_reported():
    from novelvideo.shared.failure_signals import with_upstream_status

    exc = RuntimeError("generation failed")
    assert with_upstream_status(exc, 403) is exc
    assert exception_failure_signal(exc) == {
        "failure_exception": "RuntimeError",
        "upstream_status": 403,
    }


def test_an_attached_status_is_found_through_the_exception_chain():
    from novelvideo.shared.failure_signals import with_upstream_status

    try:
        try:
            raise with_upstream_status(ValueError("provider said no"), 503)
        except ValueError as inner:
            raise RuntimeError("video generation failed") from inner
    except RuntimeError as exc:
        signal = exception_failure_signal(exc)
    assert signal == {"failure_exception": "RuntimeError", "upstream_status": 503}


def test_a_status_can_be_taken_from_another_exception():
    from novelvideo.shared.failure_signals import with_upstream_status

    request = httpx.Request("POST", "https://gateway.invalid/v1/audio/speech")
    source = httpx.HTTPStatusError(
        "refused", request=request, response=httpx.Response(429, request=request)
    )
    exc = with_upstream_status(RuntimeError("audio generation failed"), source)
    assert exception_failure_signal(exc)["upstream_status"] == 429


@pytest.mark.parametrize("status", [None, "403", True, 0, 200, 302, 399, 600, 4030])
def test_only_an_http_error_status_is_attached(status):
    from novelvideo.shared.failure_signals import with_upstream_status

    exc = with_upstream_status(RuntimeError("boom"), status)
    assert exception_failure_signal(exc) == {"failure_exception": "RuntimeError"}


def test_an_unrelated_status_code_attribute_is_not_an_upstream_status():
    from fastapi import HTTPException

    assert exception_failure_signal(HTTPException(status_code=403, detail="no")) == {
        "failure_exception": "HTTPException",
    }

    class _Odd(RuntimeError):
        status_code = 502

    assert exception_failure_signal(_Odd("x")) == {"failure_exception": "_Odd"}


def test_no_status_is_ever_read_from_the_message_text():
    assert exception_failure_signal(
        RuntimeError("freezone video generation failed: submit failed: HTTP 403 - no")
    ) == {"failure_exception": "RuntimeError"}


@pytest.mark.parametrize("status", STATUSES)
def test_model_client_http_errors_report_their_status(status):
    """Text nodes fail with the model client's own typed HTTP error."""
    from openai import APIStatusError
    from pydantic_ai.exceptions import ModelHTTPError

    _assert_upstream_problem(ModelHTTPError(status, "some-model", body=None), status)
    request = httpx.Request("POST", "https://gateway.invalid/v1/chat/completions")
    _assert_upstream_problem(
        APIStatusError(
            "refused", response=httpx.Response(status, request=request), body=None
        ),
        status,
    )


# --- video ---------------------------------------------------------------------------


def _failing_newapi_video_generator(monkeypatch, status: int):
    import novelvideo.generators.video_generator as video_generator

    async def reserve(*_args, **_kwargs):
        return "reservation-1"

    async def refund(*_args, **_kwargs):
        return None

    monkeypatch.setattr(video_generator, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(video_generator, "_refund_video_model_call", refund)
    generator = video_generator.NewApiVideoGenerator(
        api_key="fake-key",
        endpoint="https://gateway.invalid/v1",
        model="seedance-1.0-pro-fast",
    )

    async def fail_submit(*_args, **_kwargs):
        raise video_generator.NewApiVideoError(
            f"DramaClawAPI submit failed: HTTP {status} - refused",
            request_id="req-1",
            status_code=status,
        )

    monkeypatch.setattr(generator, "_post_json", fail_submit)
    monkeypatch.setattr(
        video_generator, "create_video_generator", lambda **_kwargs: generator
    )
    return generator


@pytest.mark.parametrize("status", STATUSES)
async def test_video_generator_result_carries_the_upstream_status(
    monkeypatch, tmp_path, status
):
    from novelvideo.generators.video_generator import VideoGenStatus

    generator = _failing_newapi_video_generator(monkeypatch, status)
    result = await generator.generate(
        image_path="", prompt="probe", output_path=str(tmp_path / "out.mp4")
    )
    assert result.status is VideoGenStatus.FAILED
    assert result.upstream_status == status
    assert f"HTTP {status}" in result.error  # the text is unchanged


@pytest.mark.parametrize("status", STATUSES)
async def test_freezone_video_job_reports_the_upstream_status(monkeypatch, tmp_path, status):
    from novelvideo.freezone.jobs import run_freezone_video_gen

    _failing_newapi_video_generator(monkeypatch, status)
    with pytest.raises(RuntimeError, match="freezone video generation failed") as raised:
        await run_freezone_video_gen(
            project_dir=tmp_path,
            job_id="job_1",
            prompt="probe",
            backend="newapi_seedance-2.0-fast",
        )
    assert type(raised.value) is RuntimeError
    _assert_upstream_problem(raised.value, status)


@pytest.mark.parametrize("status", STATUSES)
async def test_trusted_freezone_video_job_reports_the_upstream_status(
    monkeypatch, tmp_path, status
):
    from novelvideo.freezone.video_node import run_trusted_freezone_video_gen

    _failing_newapi_video_generator(monkeypatch, status)
    with pytest.raises(RuntimeError, match="freezone video generation failed") as raised:
        await run_trusted_freezone_video_gen(
            project_dir=tmp_path,
            job_id="job_1",
            prompt="probe",
            egress_context=None,
            task_type="freezone_video_gen",
            episode=0,
            beat_num=0,
            scope="node",
        )
    assert type(raised.value) is RuntimeError
    _assert_upstream_problem(raised.value, status)


async def test_video_failure_without_an_upstream_status_stays_unknown(monkeypatch, tmp_path):
    import novelvideo.generators.video_generator as video_generator
    from novelvideo.freezone.jobs import run_freezone_video_gen

    class _Generator:
        async def generate(self, **_kwargs):
            return video_generator.VideoGenResult(
                status=video_generator.VideoGenStatus.FAILED, error="widget exploded"
            )

    monkeypatch.setattr(
        video_generator, "create_video_generator", lambda **_kwargs: _Generator()
    )
    with pytest.raises(RuntimeError) as raised:
        await run_freezone_video_gen(
            project_dir=tmp_path,
            job_id="job_1",
            prompt="probe",
            backend="newapi_seedance-2.0-fast",
        )
    assert str(raised.value) == "freezone video generation failed: widget exploded"
    assert exception_failure_signal(raised.value) == {"failure_exception": "RuntimeError"}
    problem = _problem_for(raised.value)
    assert problem["error_category"] == "execution"
    assert problem["fixable_by"] == "unknown"
    assert "upstream_status" not in problem["diagnostics"]


@pytest.mark.parametrize("status", STATUSES)
async def test_huimeng_task_client_reports_the_upstream_status(status):
    from novelvideo.generators.huimengi import HuimengiTaskClient

    client = HuimengiTaskClient(api_key="fake-key", base_url="https://huimeng.invalid")
    with respx.mock() as router:
        router.post("https://huimeng.invalid/api/v1/tasks").mock(
            return_value=httpx.Response(status, text="refused")
        )
        with pytest.raises(RuntimeError, match="HuiMeng submit failed") as raised:
            await client.submit_task(model="some-model", params={})
    assert type(raised.value) is RuntimeError
    _assert_upstream_problem(raised.value, status)


# --- image ---------------------------------------------------------------------------


def _refusing_image_gateway(monkeypatch, status: int) -> None:
    import novelvideo.config as config
    from novelvideo.generators import nanobanana_grid

    class _Response:
        status_code = status
        text = '{"error":{"message":"refused"}}'
        headers = {"x-newapi-request-id": "req-1"}

        def raise_for_status(self):
            raise httpx.HTTPStatusError(
                "refused",
                request=httpx.Request("POST", "http://newapi.test/v1/images/generations"),
                response=self,
            )

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, **_kwargs):
            return _Response()

    class _UsageMeter:
        async def reserve_current_model_call_credit(self, **_kwargs):
            return "reservation-1"

        async def refund_model_call_credit_reservation(self, reservation_id, *, metadata=None):
            return None

        async def mark_current_paid_execution_attempt(self, **_kwargs):
            return None

    async def no_sleep(_delay):
        return None

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    monkeypatch.setattr(nanobanana_grid, "get_usage_meter", lambda: _UsageMeter())
    monkeypatch.setattr(nanobanana_grid.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(
        nanobanana_grid, "upload_image_bytes", lambda *_a, **_k: "https://relay.test/ref"
    )
    monkeypatch.setattr(
        config,
        "get_grid_generation_config",
        lambda **_kwargs: {
            "provider": "newapi",
            "api_key": "fake-key",
            "base_url": "http://newapi.test/v1",
            "model": "LingShan-G2",
            "mode": "1x1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        },
    )


@pytest.mark.parametrize("status", STATUSES)
async def test_freezone_text_to_image_job_reports_the_upstream_status(
    monkeypatch, tmp_path, status
):
    from novelvideo.freezone.jobs import run_freezone_gen

    _refusing_image_gateway(monkeypatch, status)
    with pytest.raises(ValueError, match="image generation failed") as raised:
        await run_freezone_gen(project_dir=tmp_path, job_id="job_1", prompt="probe")
    assert type(raised.value) is ValueError
    _assert_upstream_problem(raised.value, status)


@pytest.mark.parametrize("status", STATUSES)
async def test_freezone_reference_image_job_reports_the_upstream_status(
    monkeypatch, tmp_path, status
):
    from PIL import Image

    from novelvideo.freezone.jobs import run_freezone_gen

    reference = tmp_path / "ref.png"
    Image.new("RGB", (8, 8), "white").save(reference)
    _refusing_image_gateway(monkeypatch, status)
    with pytest.raises(ValueError, match="image generation failed") as raised:
        await run_freezone_gen(
            project_dir=tmp_path,
            job_id="job_1",
            prompt="probe",
            reference_paths=[str(reference)],
        )
    assert type(raised.value) is ValueError
    _assert_upstream_problem(raised.value, status)


async def test_image_leaf_error_text_is_unchanged_and_still_a_string(monkeypatch):
    from novelvideo.generators import nanobanana_grid

    _refusing_image_gateway(monkeypatch, 403)
    image_bytes, _text, error = await nanobanana_grid._call_newapi_image_api(
        api_key="fake-key",
        model="LingShan-G2",
        prompt="probe",
        base_url="http://newapi.test/v1",
    )
    assert image_bytes is None
    assert isinstance(error, str)
    assert error.startswith("HTTP 403: ")
    assert f"x{error}" == "x" + str(error)


# --- audio ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", STATUSES)
async def test_gateway_audio_reports_the_upstream_status_without_its_text(
    monkeypatch, tmp_path: Path, status
):
    from novelvideo.freezone import audio_node

    async def no_sleep(_delay):
        return None

    monkeypatch.setattr(audio_node.asyncio, "sleep", no_sleep)
    with respx.mock() as router:
        router.post("https://audio.invalid/v1/audio/speech").mock(
            return_value=httpx.Response(status, text="refused: internal detail")
        )
        with pytest.raises(RuntimeError) as raised:
            await audio_node._write_newapi_audio_speech(
                output_path=tmp_path / "audio.mp3",
                model="some-audio-model",
                input_text="quiet piano",
                api_key="fake-key",
                base_url="https://audio.invalid/v1",
            )
    exc = raised.value
    # The provider's text stays hidden, as before; only the number travels.
    assert str(exc) == "NewAPI audio generation failed"
    assert exc.__cause__ is None and exc.__suppress_context__ is True
    assert type(exc) is RuntimeError
    _assert_upstream_problem(exc, status)


# --- results that must not move ------------------------------------------------------


def test_configuration_missing_input_and_unknown_are_unchanged():
    from novelvideo.storage.media_errors import MediaRelayConfigError
    from test_freezone_workflow_runs import MISSING_INPUT_ERROR

    configuration = _problem_for(MediaRelayConfigError("unsupported MEDIA_RELAY_PROVIDER: -"))
    assert (
        configuration["error_category"],
        configuration["fixable_by"],
        configuration["next_action"],
        configuration["diagnostics"].get("upstream_status"),
    ) == ("configuration", "operator", "contact_operator", None)

    missing = _problem_for(RuntimeError("x"), stored_error=MISSING_INPUT_ERROR)
    assert (
        missing["error_category"],
        missing["fixable_by"],
        missing["next_action"],
    ) == ("input_missing", "user", "fix_input_before_retry")

    unknown = _problem_for(RuntimeError("boom: widget exploded"))
    assert (
        unknown["error_category"],
        unknown["fixable_by"],
        unknown["next_action"],
        unknown["message"],
        unknown["diagnostics"].get("upstream_status"),
        unknown["diagnostics"]["exception"],
    ) == (
        "execution",
        "unknown",
        "review_failure",
        "生成失败，原因未知。原始错误见 detail，可凭 diagnostics 中的编号排查。",
        None,
        "RuntimeError",
    )


def test_a_carried_status_never_overrides_a_recognised_error_text():
    from novelvideo.shared.failure_signals import with_upstream_status
    from test_freezone_workflow_runs import MISSING_INPUT_ERROR

    exc = with_upstream_status(RuntimeError("x"), 403)
    problem = _problem_for(exc, stored_error=MISSING_INPUT_ERROR)
    assert problem["error_category"] == "input_missing"
    assert problem["fixable_by"] == "user"


def test_a_carried_status_adds_no_text_to_the_failure_detail():
    from novelvideo.shared.failure_signals import with_upstream_status

    plain = _problem_for(RuntimeError("generation failed"))
    carried = _problem_for(with_upstream_status(RuntimeError("generation failed"), 403))
    assert carried["detail"] == plain["detail"]
    assert set(exception_failure_signal(with_upstream_status(RuntimeError("x"), 403))) == {
        "failure_exception",
        "upstream_status",
    }
