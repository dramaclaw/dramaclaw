"""Process owner identity validation, threading and fork behavior."""

import json
import os
import socket
import subprocess
import sys

import pytest

from novelvideo import config


@pytest.mark.parametrize(
    "owner",
    [
        None,
        [],
        "bad",
        {},
        {"host": "host", "token": "a" * 32},
        {"host": "host", "pid": "1", "token": "a" * 32},
        {"host": "host", "pid": 0, "token": "a" * 32},
        {"host": "host", "pid": True, "token": "a" * 32},
        {"host": None, "pid": 1, "token": "a" * 32},
        {"host": "host", "pid": 1, "token": "../outside"},
        {"host": "host", "pid": 1, "token": "A" * 32},
        {"host": "host", "pid": 1, "token": "a" * 32 + "\n"},
        {"host": "host", "pid": 1, "token": 1},
    ],
)
def test_invalid_owner_is_dead(owner):
    from novelvideo.task_owner import owner_alive

    assert owner_alive(owner) is False


def test_missing_lock_file_is_dead_without_creating_file(tmp_path, monkeypatch):
    from novelvideo.task_owner import owner_alive

    monkeypatch.setattr(config, "RUNTIME_DIR", str(tmp_path))
    owner = {"host": socket.gethostname(), "pid": 1, "token": "a" * 32}

    assert owner_alive(owner) is False
    assert list(tmp_path.iterdir()) == []


def _run_owner_script(tmp_path, script):
    result = subprocess.run(
        [sys.executable, "-c", script],
        env={**os.environ, "NOVELVIDEO_RUNTIME_DIR": str(tmp_path)},
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_current_owner_is_thread_safe_and_returns_a_copy(tmp_path):
    owners = _run_owner_script(
        tmp_path,
        """
import json
from concurrent.futures import ThreadPoolExecutor
from novelvideo.task_owner import current_owner, owner_alive
with ThreadPoolExecutor(max_workers=16) as pool:
    owners = list(pool.map(lambda _: current_owner(), range(64)))
assert all(owner_alive(owner) is True for owner in owners)
current_owner()['token'] = 'changed'
assert current_owner() == owners[0]
print(json.dumps(owners))
""",
    )

    assert len({owner["token"] for owner in owners}) == 1
    assert len(list((tmp_path / "task_owners").glob("*.lock"))) == 1
    assert len(owners[0]["token"]) == 32
    assert (tmp_path / "task_owners").stat().st_mode & 0o777 == 0o700


@pytest.mark.skipif(not hasattr(os, "fork"), reason="requires fork")
def test_fork_gets_its_own_identity_and_lock(tmp_path):
    owners = _run_owner_script(
        tmp_path,
        """
import json, os, signal, time
from novelvideo.task_owner import current_owner, owner_alive
parent = current_owner()
read_fd, write_fd = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(read_fd)
    child = current_owner()
    os.write(write_fd, json.dumps(child).encode() + b'\\n')
    time.sleep(60)
    os._exit(0)
os.close(write_fd)
try:
    with os.fdopen(read_fd) as stream:
        child = json.loads(stream.readline())
    assert owner_alive(parent) is True
    assert owner_alive(child) is True
finally:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
assert owner_alive(child) is False
assert owner_alive(parent) is True
print(json.dumps([parent, child]))
""",
    )

    assert owners[0]["pid"] != owners[1]["pid"]
    assert owners[0]["token"] != owners[1]["token"]
    assert owners[0]["host"] == owners[1]["host"]
    assert len(list((tmp_path / "task_owners").glob("*.lock"))) == 1
