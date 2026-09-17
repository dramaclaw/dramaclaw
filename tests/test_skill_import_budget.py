import asyncio

import httpx
import openai
import pytest
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from novelvideo.freezone import skill_import_budget

from novelvideo.freezone.skill_import_budget import (
    MAX_MATCHING_CALLS,
    MAX_MODEL_CALLS,
    RUN_TIMEOUT_SECONDS,
    ImportBudget,
    ImportBudgetExceeded,
)


def test_default_limits():
    assert MAX_MODEL_CALLS == 12
    assert MAX_MATCHING_CALLS == 4
    assert RUN_TIMEOUT_SECONDS == 1800


def _caused_by(exc: BaseException, cause: BaseException) -> BaseException:
    exc.__cause__ = cause
    return exc


def _raised_while_handling(exc: BaseException, context: BaseException) -> BaseException:
    try:
        raise context
    except BaseException:
        try:
            raise exc
        except BaseException as raised:
            return raised


@pytest.mark.parametrize(
    'exc',
    [
        TimeoutError('provider timed out'),
        _caused_by(
            ModelAPIError('test-model', 'provider request failed'),
            openai.APIConnectionError(request=httpx.Request('POST', 'https://example.test/v1/responses')),
        ),
        _caused_by(
            ModelAPIError('test-model', 'provider request failed'),
            openai.APITimeoutError(request=httpx.Request('POST', 'https://example.test/v1/responses')),
        ),
        ModelHTTPError(429, 'test-model'),
        ModelHTTPError(500, 'test-model'),
        ModelHTTPError(503, 'test-model'),
    ],
)
def test_transient_model_error_recognizes_retryable_transport_failures(exc):
    assert skill_import_budget.is_transient_model_error(exc)


@pytest.mark.parametrize(
    'exc',
    [
        ModelHTTPError(400, 'test-model'),
        ModelHTTPError(401, 'test-model'),
        ModelHTTPError(403, 'test-model'),
        ValueError('invalid response schema'),
        RuntimeError('request timed out'),
        asyncio.CancelledError(),
        _caused_by(ImportBudgetExceeded('run timeout exhausted'), TimeoutError('deadline expired')),
    ],
)
def test_transient_model_error_rejects_contract_cancellation_and_budget_failures(exc):
    assert not skill_import_budget.is_transient_model_error(exc)


@pytest.mark.parametrize(
    'exc',
    [
        _raised_while_handling(ModelHTTPError(400, 'test-model'), TimeoutError('earlier timeout')),
        _raised_while_handling(
            ValueError('invalid response schema'),
            openai.APIConnectionError(request=httpx.Request('POST', 'https://example.test/v1/responses')),
        ),
    ],
)
def test_non_transient_root_ignores_transient_implicit_context(exc):
    assert exc.__cause__ is None
    assert exc.__context__ is not None
    assert not skill_import_budget.is_transient_model_error(exc)


def test_consume_counts_model_and_inspection_calls_independently():
    budget = ImportBudget(max_model_calls=2, max_matching_calls=1)
    budget.consume('analyzing')
    budget.consume('inspecting:task-a:0')

    assert budget.snapshot()['model_calls'] == 2
    assert budget.snapshot()['matching_calls'] == 1
    with pytest.raises(ImportBudgetExceeded, match='model-call budget'):
        budget.consume('generating:0')


def test_consume_rejects_matching_limit_without_counting_the_rejected_call():
    budget = ImportBudget(max_model_calls=3, max_matching_calls=1)
    budget.consume('inspecting:task-a:0')

    with pytest.raises(ImportBudgetExceeded, match='matching-call budget'):
        budget.consume('inspecting:task-b:0')
    assert budget.snapshot()['model_calls'] == 1
    assert budget.snapshot()['matching_calls'] == 1


def test_matching_usage_and_remaining_are_read_only():
    budget = ImportBudget(max_matching_calls=4)

    assert budget.matching_calls_used == 0
    assert budget.matching_calls_remaining == 4

    budget.consume('inspecting:task-a:0')

    assert budget.matching_calls_used == 1
    assert budget.matching_calls_remaining == 3
    with pytest.raises(AttributeError):
        budget.matching_calls_used = 0


@pytest.mark.asyncio
async def test_generate_consumes_only_when_the_real_generator_is_called_and_records_io():
    budget = ImportBudget()
    calls = []

    async def generate(prompt):
        calls.append(prompt)
        return 'output'

    assert await budget.generate('generating:0', 'input', generate) == 'output'
    assert calls == ['input']
    assert budget.snapshot()['model_calls'] == 1
    assert budget.snapshot()['input_chars'] == len('input')
    assert budget.snapshot()['output_chars'] == len('output')


@pytest.mark.asyncio
async def test_generate_stops_an_in_flight_call_when_run_time_expires():
    budget = ImportBudget(timeout_seconds=0.01)

    async def generate(_prompt):
        await asyncio.sleep(1)

    with pytest.raises(ImportBudgetExceeded, match='run timeout'):
        await budget.generate('reviewing:0', 'input', generate)
    assert budget.snapshot()['model_calls'] == 1


@pytest.mark.asyncio
async def test_generate_propagates_cancellation_and_other_generator_errors():
    budget = ImportBudget()

    async def cancelled(_prompt):
        raise asyncio.CancelledError()

    async def failed(_prompt):
        raise RuntimeError('gateway failed')

    with pytest.raises(asyncio.CancelledError):
        await budget.generate('analyzing', 'input', cancelled)
    with pytest.raises(RuntimeError, match='gateway failed'):
        await budget.generate('generating:0', 'input', failed)


@pytest.mark.asyncio
async def test_generate_propagates_a_generator_timeout_before_the_run_deadline():
    budget = ImportBudget(timeout_seconds=10)

    async def timed_out(_prompt):
        raise TimeoutError('provider timed out')

    with pytest.raises(TimeoutError, match='provider timed out'):
        await budget.generate('generating:0', 'input', timed_out)


def test_each_budget_has_its_own_monotonic_start_time():
    clock_values = iter((10.0, 10.0, 25.0, 25.0))

    def clock():
        return next(clock_values)

    first = ImportBudget(timeout_seconds=10, clock=clock)
    second = ImportBudget(timeout_seconds=10, clock=clock)

    assert first.snapshot()['elapsed_seconds'] == 15.0
    assert second.snapshot()['elapsed_seconds'] == 15.0
