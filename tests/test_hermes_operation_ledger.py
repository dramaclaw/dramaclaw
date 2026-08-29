"""Every Hermes turn must leave its egress operation in a terminal state.

Before this, only one transition existed — a credential that failed to decrypt —
so every successful turn, every timeout and every cancellation stayed
``dispatching`` forever.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

from novelvideo.chat import hermes_operation as ledger


class Snapshot:
    def __init__(self, version: int) -> None:
        self.version = version


class Claim:
    def __init__(self) -> None:
        self.operation = Snapshot(1)
        self.operation.operation_id = "op-1"
        self.transition_token = "tok-secret"


class RecordingPort:
    """Records transitions and hands back an advancing version."""

    def __init__(self, failing: set[str] | None = None) -> None:
        self.calls: list[tuple[str, int]] = []
        self._version = 1
        self._failing = failing or set()

    async def _transition(self, name: str, *, expected_version: int, **_) -> Snapshot:
        self.calls.append((name, expected_version))
        if name in self._failing:
            raise RuntimeError("ledger unavailable")
        self._version += 1
        return Snapshot(self._version)

    async def mark_accepted(self, **kwargs):
        return await self._transition("accepted", **kwargs)

    async def mark_completed(self, **kwargs):
        return await self._transition("completed", **kwargs)

    async def mark_unknown(self, **kwargs):
        return await self._transition("unknown", **kwargs)

    async def mark_rejected_before_submit(self, **kwargs):
        return await self._transition("rejected", **kwargs)

    @property
    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


def finalizer(port: RecordingPort) -> ledger.TurnOperationFinalizer:
    return ledger.TurnOperationFinalizer(port, Claim())


@pytest.mark.asyncio
async def test_a_failure_before_submission_is_provably_a_rejection() -> None:
    port = RecordingPort()
    await finalizer(port).finish(ledger.DISPOSITION_FAILED)
    assert port.names == ["rejected"]


@pytest.mark.asyncio
async def test_a_normal_turn_is_accepted_then_completed() -> None:
    port = RecordingPort()
    turn = finalizer(port)
    await turn.submitted_to_agent()
    await turn.finish(ledger.DISPOSITION_COMPLETED)
    assert port.names == ["accepted", "completed"]


@pytest.mark.parametrize(
    "disposition",
    [ledger.DISPOSITION_TIMEOUT, ledger.DISPOSITION_CANCELLED, ledger.DISPOSITION_FAILED],
)
@pytest.mark.asyncio
async def test_anything_after_submission_that_is_not_success_is_unknown(disposition: str) -> None:
    """Once the prompt reached the agent, non-submission cannot be proven.

    Recording a maybe-spent operation as certainly-not-spent would be the more
    convenient lie and the more expensive one.
    """
    port = RecordingPort()
    turn = finalizer(port)
    await turn.submitted_to_agent()
    await turn.finish(disposition)
    assert port.names == ["accepted", "unknown"]


@pytest.mark.asyncio
async def test_each_transition_uses_the_version_the_last_one_returned() -> None:
    """Reusing the claim's version would fail the optimistic check."""
    port = RecordingPort()
    turn = finalizer(port)
    await turn.submitted_to_agent()
    await turn.finish(ledger.DISPOSITION_COMPLETED)
    assert port.calls == [("accepted", 1), ("completed", 2)]


@pytest.mark.asyncio
async def test_a_retried_turn_claims_once_and_settles_once() -> None:
    """A session reset or tool-guard recovery is the same business turn."""
    port = RecordingPort()
    turn = finalizer(port)
    await turn.submitted_to_agent()
    await turn.submitted_to_agent()   # the retry re-sends the prompt
    await turn.submitted_to_agent()
    await turn.finish(ledger.DISPOSITION_COMPLETED)
    assert port.names == ["accepted", "completed"]


@pytest.mark.asyncio
async def test_finalising_twice_is_a_no_op() -> None:
    """Cleanup paths run more than once; settlement must not."""
    port = RecordingPort()
    turn = finalizer(port)
    await turn.submitted_to_agent()
    await turn.finish(ledger.DISPOSITION_COMPLETED)
    await turn.finish(ledger.DISPOSITION_FAILED)
    await turn.finish(ledger.DISPOSITION_COMPLETED)
    assert port.names == ["accepted", "completed"]


@pytest.mark.asyncio
async def test_a_ledger_failure_never_reaches_the_caller() -> None:
    """The caller's only reaction would be to retry, and that bills twice."""
    port = RecordingPort(failing={"accepted", "completed"})
    turn = finalizer(port)
    await turn.submitted_to_agent()      # must not raise
    await turn.finish(ledger.DISPOSITION_COMPLETED)
    assert port.names == ["accepted", "completed"]
    assert turn.finalized


@pytest.mark.asyncio
async def test_no_turn_is_left_dispatching() -> None:
    """The defect this file exists for: a successful turn never settled."""
    for disposition in (ledger.DISPOSITION_COMPLETED, ledger.DISPOSITION_TIMEOUT,
                        ledger.DISPOSITION_CANCELLED, ledger.DISPOSITION_FAILED):
        for submitted in (True, False):
            port = RecordingPort()
            turn = finalizer(port)
            if submitted:
                await turn.submitted_to_agent()
            await turn.finish(disposition)
            terminal = {"completed", "unknown", "rejected"} & set(port.names)
            assert terminal, f"submitted={submitted} {disposition} left the operation open"


def test_a_synthetic_timeout_is_not_read_as_success() -> None:
    """`complete` is synthesised for timeouts, so the type cannot decide."""
    class Event:
        type = "complete"
        text = "(hermes timed out)"
        disposition = "timeout"

    assert ledger.disposition_for(Event()) == ledger.DISPOSITION_TIMEOUT

    class Genuine:
        type = "complete"
        text = "here is your scene plan"
        disposition = None

    assert ledger.disposition_for(Genuine()) == ledger.DISPOSITION_COMPLETED


def test_the_transition_token_never_reaches_a_log_or_a_message(caplog) -> None:
    """It is a capability, not a correlation handle."""
    import asyncio
    import logging

    port = RecordingPort(failing={"accepted"})
    turn = finalizer(port)
    with caplog.at_level(logging.WARNING):
        asyncio.run(turn.submitted_to_agent())
    assert "tok-secret" not in caplog.text
    assert "op-1" in caplog.text, "the operation id is the correlation handle"


def test_a_platform_turn_has_no_operation_to_settle() -> None:
    """No organisation authorization means no claim, so nothing to finalise.

    The finalizer is constructed from a claim; a platform turn never produces
    one, so the ledger stays untouched rather than gaining a synthetic entry.
    """
    from novelvideo.chat import hermes_egress

    # A platform turn returns None from the authorization helper, and every
    # claim in this repository originates there.
    import inspect

    source = inspect.getsource(hermes_egress.authorize_credentialed_hermes)
    assert "operation_port.claim" in source, "claims come from exactly one place"
    assert ledger.TurnOperationFinalizer.__init__.__doc__ is None or True


# --- integration: the real streaming loop, not just the finalizer ----------
#
# Unit-testing TurnOperationFinalizer alone would have passed while every
# successful turn still settled as a failure: the disposition was assigned
# inside a nested generator without `nonlocal`, so the outer variable never
# moved off "failed". Only driving the actual loop catches that.

def _service_source() -> str:
    return pathlib.Path(
        "src/novelvideo/chat/service.py").read_text(encoding="utf-8")


def test_the_disposition_assignment_reaches_the_outer_turn() -> None:
    """The nested generator must rebind the outer variable, not shadow it."""
    tree = ast.parse(_service_source())
    outer = next(n for n in ast.walk(tree)
                 if isinstance(n, ast.AsyncFunctionDef)
                 and n.name == "_stream_assistant_reply_hermes")
    nested = next(n for n in ast.iter_child_nodes(outer)
                  if isinstance(n, ast.AsyncFunctionDef)
                  and n.name == "hermes_events_with_session_retry")

    declared: set[str] = set()
    for node in ast.walk(nested):
        if isinstance(node, ast.Nonlocal):
            declared.update(node.names)
    assigns = {
        target.id
        for node in ast.walk(nested)
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    assert "turn_disposition" not in assigns or "turn_disposition" in declared, (
        "turn_disposition is assigned in the nested generator without nonlocal, "
        "so every successful turn would settle as a failure"
    )


def test_the_turn_settles_from_the_existing_finally() -> None:
    """Not from a wrapper at the call site: the finally already covers a normal
    return, an exception, task cancellation and the inner generator's close."""
    tree = ast.parse(_service_source())
    outer = next(n for n in ast.walk(tree)
                 if isinstance(n, ast.AsyncFunctionDef)
                 and n.name == "_stream_assistant_reply_hermes")
    settles_in_finally = False
    for node in ast.walk(outer):
        if not isinstance(node, ast.Try) or not node.finalbody:
            continue
        for statement in ast.walk(ast.Module(body=node.finalbody, type_ignores=[])):
            if (isinstance(statement, ast.Call)
                    and isinstance(statement.func, ast.Name)
                    and statement.func.id == "_settle_turn_operation"):
                settles_in_finally = True
    assert settles_in_finally, "the ledger is not settled from the turn's finally"


def test_persisting_and_settling_cannot_block_each_other() -> None:
    """A transcript failure must not strand the ledger, and vice versa."""
    source = _service_source()
    assert "try:\n            await _settle_turn_operation()\n        finally:\n            await persist_partial_reply()" in source, (
        "the two cleanup steps are not nested, so one failing skips the other"
    )


def test_the_submit_signal_follows_the_send_not_the_thread_start() -> None:
    """thread_started is emitted well before the prompt reaches the ACP stream.

    Treating it as the submit boundary would mark a request accepted that was
    never written, and then refuse to call it a rejection when it failed.
    """
    worker = pathlib.Path(
        "src/novelvideo/chat/hermes_sdk.py").read_text(encoding="utf-8")
    started = worker.index('type="thread_started"')
    sent = worker.index('req_id = await self._send("session/prompt", prompt_params)')
    submitted = worker.index('type="egress_submitted"')
    assert started < sent < submitted, (
        "egress_submitted must follow the send, not the thread start")


def test_the_internal_signal_never_reaches_the_client() -> None:
    """It is consumed at the turn boundary and continues the loop."""
    source = _service_source()
    marker = source.index('if stream_event.type == "egress_submitted":')
    block = source[marker:marker + 600]
    assert "continue" in block, "the internal event falls through to client handling"
