# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
import logging
from pathlib import Path
import shutil
import threading
import time

import pytest

from novelvideo.freezone.canvas_core_pool import CanvasCoreError, CanvasCorePool
from novelvideo.task_backend.subprocesses import RestrictedSubprocessPolicy, _has_network_argument

WORKER = Path(__file__).parent / "fixtures/canvas_core_fake_worker.mjs"
LOGGER = "novelvideo.freezone.canvas_core_pool"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node unavailable")


@pytest.fixture
def pool():
    instance = CanvasCorePool(WORKER, size=1, call_timeout_seconds=0.3)
    yield instance
    instance.close()


def assert_failure_log(caplog, op, error, level=logging.ERROR):
    records = [
        record
        for record in caplog.records
        if record.name == LOGGER and not record.getMessage().startswith("canvas_core stderr:")
    ]
    assert len(records) == 1
    assert records[0].levelno == level
    message = records[0].getMessage()
    assert op in message
    assert error.code in message
    assert str(error) in message


def test_worker_stderr_is_visible(pool, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    assert pool.call("stderr_line", {}) == {}
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        records = [
            record
            for record in caplog.records
            if record.name == LOGGER
            and record.getMessage() == "canvas_core stderr: worker diagnostic"
        ]
        if records:
            break
        time.sleep(0.01)
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING


def test_spawn_spec(pool, monkeypatch):
    command, cwd, env = pool.spawn_spec()
    assert command == [
        shutil.which("node"),
        "--permission",
        f"--allow-fs-read={WORKER.resolve()}",
        "--no-experimental-fetch",
        "--no-experimental-websocket",
        "--max-old-space-size=512",
        str(WORKER.resolve()),
    ]
    assert cwd == WORKER.resolve().parent
    assert env == {}
    assert not _has_network_argument(command)
    monkeypatch.setenv("MODEL_API_KEY", "must-not-inherit")
    monkeypatch.setenv("CANVAS_TEST_SENTINEL", "must-not-inherit")
    # macOS may synthesize this CoreFoundation variable after exec.
    assert set(pool.call("env", {})["keys"]) <= {"__CF_USER_TEXT_ENCODING"}
    assert pool.call("argv", {})["argv"] == command[1:-1]


@pytest.mark.parametrize(
    "op,code",
    [
        ("sleep", "canvas_core_timeout"),
        ("crash", "canvas_core_crashed"),
        ("garbage", "canvas_core_protocol"),
        ("wrong_id", "canvas_core_protocol"),
    ],
)
def test_failed_child_replaced(pool, op, code, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    before = pool.call("ping", {})["pid"]
    started = time.monotonic()
    with pytest.raises(CanvasCoreError) as error:
        pool.call(op, {})
    assert error.value.code == code
    assert_failure_log(caplog, op, error.value)
    if op == "sleep":
        assert 0.2 <= time.monotonic() - started < 1.5
    assert pool.call("ping", {})["pid"] != before


@pytest.mark.parametrize(
    "op,code,message,level",
    [
        ("fail", "bad_input", "bad input", logging.ERROR),
        ("invalid_request", "invalid_request", "invalid request", logging.WARNING),
    ],
)
def test_worker_error_keeps_child(pool, caplog, op, code, message, level):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    before = pool.call("ping", {})["pid"]
    marker = "private-canvas-payload-marker"
    with pytest.raises(CanvasCoreError) as error:
        pool.call(op, {"canvas": marker})
    assert error.value.code == code
    assert str(error.value) == message
    assert_failure_log(caplog, op, error.value, level)
    assert all(marker not in record.getMessage() for record in caplog.records)
    assert pool.call("ping", {})["pid"] == before


def test_retirement():
    pool = CanvasCorePool(WORKER, size=1, max_calls_per_child=2)
    try:
        first = pool.call("ping", {})["pid"]
        assert pool.call("ping", {})["pid"] == first
        assert pool.call("ping", {})["pid"] != first
    finally:
        pool.close()


def test_policy_refuses_secrets():
    with pytest.raises(ValueError, match="secrets"):
        RestrictedSubprocessPolicy(("node",), WORKER.resolve().parent, {"MODEL_API_KEY": "x"})


@pytest.mark.parametrize("method", ["call", "warm"])
def test_missing_bundle(tmp_path, caplog, method):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    pool = CanvasCorePool(tmp_path / "missing.mjs")
    with pytest.raises(CanvasCoreError) as error:
        if method == "call":
            pool.call("ping", {})
        else:
            pool.warm()
    assert error.value.code == "canvas_core_unavailable"
    assert_failure_log(caplog, "ping", error.value)
    pool.close()


def test_missing_node(pool, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda _: None)
    with pytest.raises(CanvasCoreError) as error:
        pool.spawn_spec()
    assert error.value.code == "canvas_core_unavailable"


def test_file_permission(pool, tmp_path):
    secret = tmp_path / "private.txt"
    secret.write_text("private")
    assert pool.call("readfile", {"path": str(secret)})["code"] == "ERR_ACCESS_DENIED"


def test_busy_and_close(pool, caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    errors = []
    started = threading.Event()
    exchange = pool._exchange

    def observed_exchange(child, op, payload, timeout_seconds):
        if op == "sleep":
            started.set()
        return exchange(child, op, payload, timeout_seconds)

    pool._exchange = observed_exchange

    def work():
        try:
            pool.call("sleep", {})
        except CanvasCoreError as error:
            errors.append(error.code)

    # Occupy the sole child before testing acquisition with a shorter deadline.
    pool.call_timeout_seconds = 3
    pool.call("ping", {})
    thread = threading.Thread(target=work)
    thread.start()
    assert started.wait(1)
    pool.call_timeout_seconds = 0.05
    with pytest.raises(CanvasCoreError) as error:
        pool.call("ping", {})
    assert error.value.code == "canvas_core_busy"
    assert_failure_log(caplog, "ping", error.value)
    pool.close()
    thread.join(2)
    assert not thread.is_alive()
    assert errors


def test_warm_and_parallel_calls(caplog):
    from concurrent.futures import ThreadPoolExecutor

    caplog.set_level(logging.DEBUG, logger=LOGGER)
    pool = CanvasCorePool(WORKER, size=2, call_timeout_seconds=2)
    try:
        pool.warm()
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: pool.call("slow_ping", {}), range(12)))
        assert len({result["pid"] for result in results}) == 2
        assert len({(result["pid"], result["count"]) for result in results}) == 12
    finally:
        pool.close()
    with pytest.raises(CanvasCoreError) as error:
        pool.call("ping", {})
    assert error.value.code == "canvas_core_unavailable"
    assert_failure_log(caplog, "ping", error.value)


@pytest.mark.parametrize(
    "op,code,level",
    [
        ("crash", "canvas_core_crashed", logging.ERROR),
        ("sleep", "canvas_core_timeout", logging.ERROR),
        ("garbage", "canvas_core_protocol", logging.ERROR),
        ("fail", "bad_input", logging.ERROR),
        ("invalid_request", "invalid_request", logging.WARNING),
    ],
)
def test_warm_failure_is_logged(pool, caplog, monkeypatch, op, code, level):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    exchange = pool._exchange
    monkeypatch.setattr(
        pool, "_exchange",
        lambda child, _op, payload, timeout_seconds: exchange(child, op, payload, timeout_seconds),
    )
    with pytest.raises(CanvasCoreError) as error:
        pool.warm()
    assert error.value.code == code
    assert_failure_log(caplog, "ping", error.value, level)
    monkeypatch.undo()
    assert pool.call("ping", {})["pid"]


def test_apply_commands(pool):
    result = pool.call("apply_commands", {"canvas": {"nodes": [{"id": "before"}], "edges": []}})
    assert result["status"] == "applied"
    assert result["canvas"]["nodes"] == [{"id": "before"}, {"id": "n-1"}]
