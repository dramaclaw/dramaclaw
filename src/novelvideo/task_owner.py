"""Identify inline task owners by a lock held for the lifetime of their process."""

import os
from pathlib import Path
import re
import secrets
import socket
import threading
from typing import Any, BinaryIO

import portalocker

from novelvideo import config

_owner: dict[str, Any] | None = None
_owner_file: BinaryIO | None = None
_owner_lock = threading.Lock()
_TOKEN = re.compile(r"[0-9a-f]{32}")


def _after_fork() -> None:
    global _owner_lock, _owner_file
    # Drop only the inherited descriptor; the parent retains its own lock.
    _owner_file = None
    _owner_lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)


def current_owner() -> dict[str, Any]:
    """Return this process's identity, holding its lock until the OS releases it."""
    global _owner, _owner_file
    with _owner_lock:
        pid = os.getpid()
        if _owner is None or _owner["pid"] != pid:
            directory = Path(config.RUNTIME_DIR) / "task_owners"
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            token = secrets.token_hex(16)
            handle = (directory / f"{token}.lock").open("xb")
            try:
                portalocker.lock(handle, portalocker.LOCK_EX | portalocker.LOCK_NB)
            except BaseException:
                handle.close()
                raise
            _owner_file = handle
            _owner = {"host": socket.gethostname(), "pid": pid, "token": token}
        return dict(_owner)


def owner_alive(owner: Any) -> bool | None:
    """Probe an owner's lock, returning None when the owner is on another host."""
    if not isinstance(owner, dict):
        return False
    host, pid, token = owner.get("host"), owner.get("pid"), owner.get("token")
    if (
        not isinstance(host, str)
        or not host
        or type(pid) is not int
        or pid <= 0
        or not isinstance(token, str)
        or _TOKEN.fullmatch(token) is None
    ):
        return False
    if host != socket.gethostname():
        return None
    if _owner is not None and _owner["pid"] == os.getpid() and token == _owner["token"]:
        return True
    path = Path(config.RUNTIME_DIR) / "task_owners" / f"{token}.lock"
    try:
        handle = path.open("rb+")
    except FileNotFoundError:
        return False
    with handle:
        try:
            portalocker.lock(handle, portalocker.LOCK_EX | portalocker.LOCK_NB)
        except portalocker.exceptions.AlreadyLocked:
            return True
        portalocker.unlock(handle)
    path.unlink(missing_ok=True)
    return False
