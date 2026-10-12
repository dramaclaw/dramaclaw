"""Worker stderr is consumed for the worker's lifetime, and summarised only.

It was piped and never read. A pipe that fills blocks the worker on its next
write, and until this existed the worker's own account of a failure was
invisible — a refused egress reached us as an unexplained connection error
minutes later, with nothing to point at.

What must NOT happen is the opposite mistake: worker stderr carries prompts,
tool output and provider bodies, so forwarding it verbatim would route user
content into DramaClaw's logs through a path no telemetry allowlist governs.
"""
from __future__ import annotations

import asyncio
import logging

from novelvideo.chat import hermes_sdk


class _Stream:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)

    async def readline(self) -> bytes:
        if not self._lines:
            return b""
        return self._lines.pop(0)


class _Proc:
    def __init__(self, lines: list[bytes]) -> None:
        self.stderr = _Stream(lines)
        self.pid = 4321


def _drain(lines: list[bytes], caplog) -> list[str]:
    client = hermes_sdk.HermesSdkThread.__new__(hermes_sdk.HermesSdkThread)
    client._proc = _Proc(lines)
    with caplog.at_level(logging.WARNING, logger=hermes_sdk._log.name):
        asyncio.run(client._drain_stderr())
    return [record.getMessage() for record in caplog.records]


def test_an_error_line_is_summarised_by_type_and_pid(caplog):
    messages = _drain(
        [b"2026-08-19 [ERROR] agent: boom\n",
         b"openai.APIConnectionError: Connection error.\n"], caplog)
    assert any("4321" in message for message in messages)
    assert any("APIConnectionError" in message for message in messages)


def test_ordinary_worker_output_is_not_forwarded(caplog):
    messages = _drain(
        [b"[INFO] agent: conversation turn: msg='the user asked about episode 3'\n",
         b"[INFO] agent: tool output: {'path': '/secret/file'}\n"], caplog)
    assert messages == []


def test_a_prompt_on_an_error_line_is_not_forwarded(caplog):
    """The trigger is an error; the payload still must not travel with it."""
    messages = _drain(
        [b"[ERROR] agent: ValueError while handling '\xe7\x94\xa8\xe6\x88\xb7\xe5\x86\x85\xe5\xae\xb9 secret-prompt'\n"],
        caplog)
    assert messages, "an error line should still be reported"
    joined = " ".join(messages)
    assert "secret-prompt" not in joined
    assert "ValueError" in joined


def test_an_authorization_header_never_reaches_the_log(caplog):
    messages = _drain(
        [b"[ERROR] agent: RuntimeError: Authorization: Bearer sk-real-key-value\n"],
        caplog)
    joined = " ".join(messages)
    assert "sk-real-key-value" not in joined and "Bearer" not in joined


def test_the_drain_ends_at_end_of_stream_rather_than_spinning(caplog):
    """EOF must terminate it; a worker that exits should not leave a live task."""
    asyncio.run(asyncio.wait_for(_as_task([]), timeout=5))


async def _as_task(lines: list[bytes]) -> None:
    client = hermes_sdk.HermesSdkThread.__new__(hermes_sdk.HermesSdkThread)
    client._proc = _Proc(lines)
    await client._drain_stderr()


def test_a_broken_stream_does_not_kill_the_turn(caplog):
    class _Broken:
        async def readline(self):
            raise OSError("pipe went away")

    client = hermes_sdk.HermesSdkThread.__new__(hermes_sdk.HermesSdkThread)
    client._proc = type("P", (), {"stderr": _Broken(), "pid": 1})()
    asyncio.run(client._drain_stderr())        # must not raise
