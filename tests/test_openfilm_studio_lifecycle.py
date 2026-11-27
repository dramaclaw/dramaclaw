"""One Studio survives its worker and is recovered before a replacement starts."""

from __future__ import annotations

import asyncio
import json
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.freezone import studio


@pytest.fixture()
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(studio, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(studio, "RUNTIME_DIR", tmp_path / "runtime")
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    monkeypatch.delenv("SUPERTALE_OPENFILM_STUDIO_ORIGIN", raising=False)
    return tmp_path


def recorded(*, status="ready"):
    return {
        "pid": 987654,
        "port": 4747,
        "key": "key",
        "ready": "unused",
        "started_at": "2026-11-11T00:00:00+00:00",
        "status": status,
        **(
            {"origin": "http://127.0.0.1:4747", "film_origin": "http://localhost:4748"}
            if status == "ready"
            else {}
        ),
    }


def group(monkeypatch, *, alive=True, leader=True, stubborn=False):
    calls = []

    def getpgid(pid):
        assert pid == 987654
        if not alive:
            raise ProcessLookupError
        return pid if leader else pid - 1

    def killpg(pid, sig):
        nonlocal alive
        assert pid == 987654
        calls.append(sig)
        if not alive:
            raise ProcessLookupError
        if sig == signal.SIGKILL or (sig == signal.SIGTERM and not stubborn):
            alive = False

    monkeypatch.setattr(studio.os, "getpgid", getpgid)
    monkeypatch.setattr(studio.os, "killpg", killpg)
    return calls


def test_spawn_records_starting_before_ready_and_detaches(isolated, monkeypatch):
    seen = {}
    monkeypatch.setattr(studio, "_runtime_installed", lambda: True)
    monkeypatch.setattr(studio.shutil, "which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(studio, "_pick_ports", lambda: 4747)

    def popen(args, **kwargs):
        seen.update(kwargs)
        assert not studio._state_file().exists()

        def poll():
            state = studio._read_state()
            assert state == {
                "pid": 987654,
                "port": 4747,
                "key": kwargs["env"]["OPENFILM_STUDIO_KEY"],
                "ready": kwargs["env"]["OPENFILM_STUDIO_READY_FILE"],
                "started_at": state["started_at"],
                "status": "starting",
            }
            Path(state["ready"]).write_text(
                json.dumps(
                    {
                        "origin": "http://127.0.0.1:4747",
                        "filmOrigin": "http://localhost:4748",
                        "port": 4747,
                    }
                )
            )
            return None

        return SimpleNamespace(pid=987654, poll=poll)

    monkeypatch.setattr(studio.subprocess, "Popen", popen)
    state = studio._spawn_studio()
    assert seen["start_new_session"] is True
    assert state["status"] == "ready"
    assert state["origin"] == "http://127.0.0.1:4747"
    assert state["film_origin"] == "http://localhost:4748"
    assert studio._read_state() == state
    assert not Path(state["ready"]).exists()


@pytest.mark.parametrize("status", ["ready", "starting"])
async def test_busy_group_recovers_without_spawn(isolated, monkeypatch, status):
    state = recorded(status=status)
    ready = isolated / "ready.json"
    state["ready"] = str(ready)
    studio._write_state(state)
    group(monkeypatch)
    attempts = 0

    async def health(origin):
        nonlocal attempts
        attempts += 1
        return None if attempts < 3 else {"filmOrigin": "http://localhost:4748"}

    if status == "starting":
        ready.write_text(
            json.dumps(
                {
                    "origin": "http://127.0.0.1:4747",
                    "filmOrigin": "http://localhost:4748",
                    "port": 4747,
                }
            )
        )
    monkeypatch.setattr(studio, "_health", health)
    monkeypatch.setattr(studio, "_spawn_studio", lambda: pytest.fail("duplicate Studio"))
    result = await studio._ensure_studio()
    assert result["pid"] == 987654 and result["status"] == "ready"
    assert attempts == 3
    assert studio._read_state()["status"] == "ready"
    assert not ready.exists()


@pytest.mark.parametrize("status", ["ready", "starting"])
async def test_busy_group_is_stopped_before_one_replacement(isolated, monkeypatch, status):
    studio._write_state(recorded(status=status))
    signals = group(monkeypatch)
    monkeypatch.setattr(studio, "_STUDIO_BUSY_WAIT_SECONDS", 0.01, raising=False)
    calls = []

    async def health(origin):
        return None

    def spawn():
        assert signal.SIGTERM in signals
        calls.append("spawn")
        return {"pid": 987655, "status": "ready"}

    monkeypatch.setattr(studio, "_health", health)
    monkeypatch.setattr(studio, "_spawn_studio", spawn)
    assert await studio._ensure_studio() == {"pid": 987655, "status": "ready"}
    assert calls == ["spawn"]
    assert [sig for sig in signals if sig] == [signal.SIGTERM]


@pytest.mark.parametrize("alive,leader", [(False, True), (True, False)])
async def test_dead_or_reused_pid_gets_one_spawn(isolated, monkeypatch, alive, leader):
    studio._write_state(recorded())
    signals = group(monkeypatch, alive=alive, leader=leader)
    calls = []

    async def health(origin):
        pytest.fail("do not trust a dead or reused pid's origin")

    def spawn():
        calls.append("spawn")
        return {"pid": 987655}

    monkeypatch.setattr(studio, "_health", health)
    monkeypatch.setattr(studio, "_spawn_studio", spawn)
    assert await studio._ensure_studio() == {"pid": 987655}
    assert calls == ["spawn"]
    assert not [sig for sig in signals if sig]


async def test_group_permission_error_counts_as_alive(isolated, monkeypatch):
    studio._write_state(recorded())
    monkeypatch.setattr(studio.os, "getpgid", lambda pid: pid)

    def killpg(pid, sig):
        assert sig == 0
        raise PermissionError

    async def health(origin):
        return {"filmOrigin": "http://localhost:4748"}

    monkeypatch.setattr(studio.os, "killpg", killpg)
    monkeypatch.setattr(studio, "_health", health)
    monkeypatch.setattr(studio, "_spawn_studio", lambda: pytest.fail("duplicate Studio"))
    assert (await studio._ensure_studio())["pid"] == 987654


async def test_concurrent_workers_spawn_once(isolated, monkeypatch):
    calls = []
    group(monkeypatch)

    def spawn():
        calls.append("spawn")
        time.sleep(0.05)
        studio._write_state(recorded())
        return recorded()

    async def health(origin):
        return {"filmOrigin": "http://localhost:4748"}

    monkeypatch.setattr(studio, "_spawn_studio", spawn)
    monkeypatch.setattr(studio, "_health", health)
    first, second = await asyncio.gather(studio._ensure_studio(), studio._ensure_studio())
    assert first["pid"] == second["pid"] == 987654
    assert calls == ["spawn"]


def test_real_child_has_its_own_session_and_group(isolated):
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        **studio._studio_popen_kwargs(env=dict(os.environ), log=subprocess.DEVNULL),
    )
    try:
        assert os.getpgid(child.pid) == child.pid
        assert child.pid != os.getpgid(0)
        assert os.getsid(child.pid) == child.pid
    finally:
        child.terminate()
        child.wait(timeout=5)


def _ports():
    with socket.socket() as sock, socket.socket() as preview:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        try:
            preview.bind(("127.0.0.1", port + 1))
        except OSError:
            return _ports()
        return port


def test_real_launcher_excludes_second_studio_and_cleans_pid(isolated):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    if not studio._runtime_installed():
        pytest.skip("vendored runtime not installed: playwright-core/package.json missing")
    home = isolated / "home"
    home.mkdir()
    # A stale pid file must not prevent startup.
    (home / "studio.pid").write_text("2147483647\n")
    ready = isolated / "ready.json"
    env = studio._studio_env(_ports(), "test-key", ready)
    env["OPENFILM_HOME"] = str(home)
    launcher = studio._repo_root() / "scripts/openfilm_studio/run.mjs"
    first = second = None
    with (isolated / "first.log").open("wb") as log:
        try:
            first = subprocess.Popen(
                [node, str(launcher)], env=env, stdout=log, stderr=log, start_new_session=True
            )
            deadline = time.monotonic() + 15
            while not ready.exists() and first.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert ready.is_file(), (isolated / "first.log").read_text()
            assert (home / "studio.pid").read_text().strip() == str(first.pid)
            other_env = {
                **env,
                "OPENFILM_STUDIO_PORT": str(_ports()),
                "OPENFILM_STUDIO_READY_FILE": str(isolated / "second-ready.json"),
            }
            second = subprocess.Popen(
                [node, str(launcher)], env=other_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            _, err = second.communicate(timeout=10)
            assert second.returncode == 3
            assert b"another Studio is running on this home" in err
            first.send_signal(signal.SIGTERM)
            first.wait(timeout=10)
            assert not (home / "studio.pid").exists()
        finally:
            for proc in (second, first):
                if proc is not None:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait(timeout=5)


def test_real_launcher_replaces_pid_reused_by_unrelated_process(isolated):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    if not studio._runtime_installed():
        pytest.skip("vendored runtime not installed: playwright-core/package.json missing")
    home = isolated / "home"
    home.mkdir()
    unrelated = subprocess.Popen(["sleep", "60"])
    launcher = None
    try:
        assert os.getpgid(unrelated.pid) != unrelated.pid
        (home / "studio.pid").write_text(f"{unrelated.pid}\n")
        env = studio._studio_env(_ports(), "test-key", isolated / "ready.json")
        env["OPENFILM_HOME"] = str(home)
        with (isolated / "launcher.log").open("wb") as log:
            launcher = subprocess.Popen(
                [node, str(studio._repo_root() / "scripts/openfilm_studio/run.mjs")],
                env=env,
                stdout=subprocess.PIPE,
                stderr=log,
                start_new_session=True,
            )
            assert select.select([launcher.stdout], [], [], 15)[0], "Studio did not announce ready"
            line = launcher.stdout.readline()
            assert line, (isolated / "launcher.log").read_text()
            assert json.loads(line)["origin"].startswith("http://")
            assert (home / "studio.pid").read_text().strip() == str(launcher.pid)
            assert unrelated.poll() is None
    finally:
        for proc in (launcher, unrelated):
            if proc is not None:
                if proc.poll() is None:
                    proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        if launcher is not None:
            launcher.stdout.close()


def test_stop_waits_for_whole_group_even_when_leader_exits(isolated, monkeypatch):
    leader_alive = True
    group_alive = True
    signals = []
    monkeypatch.setattr(studio, "_STUDIO_STOP_WAIT_SECONDS", 0.01)

    def getpgid(pid):
        if not leader_alive:
            raise ProcessLookupError
        return pid

    def killpg(pid, sig):
        nonlocal leader_alive, group_alive
        if not group_alive:
            raise ProcessLookupError
        signals.append(sig)
        if sig == signal.SIGTERM:
            leader_alive = False
        if sig == signal.SIGKILL:
            group_alive = False

    monkeypatch.setattr(studio.os, "getpgid", getpgid)
    monkeypatch.setattr(studio.os, "killpg", killpg)
    studio._stop_group(987654)
    assert [sig for sig in signals if sig] == [signal.SIGTERM, signal.SIGKILL]
    assert group_alive is False
