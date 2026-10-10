"""Select the Piko persistence/realtime backend without changing its wire protocol."""

from __future__ import annotations

import os
from typing import Final

from novelvideo.piko.world import PikoCharacterStore, PikoWorldHub

BACKEND_ENV: Final[str] = "PIKO_WORLD_BACKEND"
DEMO_BACKEND: Final[str] = "demo"
DISTRIBUTED_BACKEND: Final[str] = "distributed"


def configured_backend() -> str:
    backend = os.environ.get(BACKEND_ENV, DEMO_BACKEND).strip().lower()
    if backend not in {DEMO_BACKEND, DISTRIBUTED_BACKEND}:
        raise RuntimeError(
            f"{BACKEND_ENV} must be either {DEMO_BACKEND!r} or {DISTRIBUTED_BACKEND!r}"
        )
    return backend


def build_backend():
    if configured_backend() == DEMO_BACKEND:
        store = PikoCharacterStore()
        return store, PikoWorldHub(store)

    from novelvideo.piko.distributed import DistributedCharacterStore, DistributedPikoWorldHub

    dsn = os.environ.get("ST_CONTROL_PLANE_DSN", "").strip()
    redis_url = os.environ.get("ST_REDIS_URL", "").strip()
    missing = [
        name
        for name, value in (
            ("ST_CONTROL_PLANE_DSN", dsn),
            ("ST_REDIS_URL", redis_url),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "PIKO_WORLD_BACKEND='distributed' requires " + ", ".join(missing)
        )
    store = DistributedCharacterStore(dsn)
    return store, DistributedPikoWorldHub(store, redis_url=redis_url)


character_store, world_hub = build_backend()
