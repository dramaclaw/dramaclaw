# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
from pathlib import Path
import shutil
import threading
import time

import pytest

from novelvideo.freezone.canvas_core_pool import CanvasCoreError, CanvasCorePool
from novelvideo.task_backend.subprocesses import RestrictedSubprocessPolicy, _has_network_argument

WORKER = Path(__file__).parent / "fixtures/canvas_core_fake_worker.mjs"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node unavailable")


@pytest.fixture
def pool():
    instance = CanvasCorePool(WORKER, size=1, call_timeout_seconds=0.3)
    yield instance
    instance.close()


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
def test_failed_child_replaced(pool, op, code):
    before = pool.call("ping", {})["pid"]
    started = time.monotonic()
    with pytest.raises(CanvasCoreError) as error:
        pool.call(op, {})
    assert error.value.code == code
    if op == "sleep":
        assert 0.2 <= time.monotonic() - started < 1.5
    assert pool.call("ping", {})["pid"] != before


def test_worker_error_keeps_child(pool):
    before = pool.call("ping", {})["pid"]
    with pytest.raises(CanvasCoreError) as error:
        pool.call("fail", {})
    assert error.value.code == "bad_input"
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


def test_missing_bundle(tmp_path):
    pool = CanvasCorePool(tmp_path / "missing.mjs")
    with pytest.raises(CanvasCoreError) as error:
        pool.call("ping", {})
    assert error.value.code == "canvas_core_unavailable"
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


def test_busy_and_close(pool):
    errors = []
    started = threading.Event()
    exchange = pool._exchange

    def observed_exchange(child, op, payload):
        if op == "sleep":
            started.set()
        return exchange(child, op, payload)

    pool._exchange = observed_exchange

    def work():
        try:
            pool.call("sleep", {})
        except CanvasCoreError as error:
            errors.append(error.code)

    # Occupy the sole child before testing acquisition with a shorter deadline.
    pool.call("ping", {})
    thread = threading.Thread(target=work)
    thread.start()
    assert started.wait(1)
    pool.call_timeout_seconds = 0.05
    with pytest.raises(CanvasCoreError) as error:
        pool.call("ping", {})
    assert error.value.code == "canvas_core_busy"
    pool.close()
    thread.join(2)
    assert not thread.is_alive()
    assert errors


def test_warm_and_parallel_calls():
    from concurrent.futures import ThreadPoolExecutor

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


def test_apply_commands(pool):
    result = pool.call("apply_commands", {"canvas": {"nodes": [{"id": "before"}], "edges": []}})
    assert result["status"] == "applied"
    assert result["canvas"]["nodes"] == [{"id": "before"}, {"id": "n-1"}]
