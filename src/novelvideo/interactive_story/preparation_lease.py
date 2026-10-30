"""Hold preparation ownership from acceptance through background execution.

OS file locks survive request boundaries and are released if the process exits.
A second API worker can distinguish a queued/running job from an abandoned one.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import portalocker

_owners: dict[str, portalocker.Lock] = {}


def claim(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    lock = portalocker.Lock(
        directory / '.owner-lock', mode='a', timeout=0,
        flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
    )
    lock.acquire()
    _owners[str(directory.resolve())] = lock


def release(directory: Path) -> None:
    lock = _owners.pop(str(directory.resolve()), None)
    if lock is not None:
        lock.release()


@contextmanager
def abandoned(directory: Path) -> Iterator[bool]:
    """Reserve an abandoned job while its failed state is persisted."""
    lock = portalocker.Lock(
        directory / '.owner-lock', mode='a', timeout=0,
        flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
    )
    try:
        lock.acquire()
    except portalocker.exceptions.LockException:
        yield False
        return
    try:
        yield True
    finally:
        lock.release()
