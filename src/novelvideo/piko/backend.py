"""Select the Piko persistence/realtime backend without changing its wire protocol."""

from __future__ import annotations

import os
from typing import Final

from novelvideo.piko.world import PikoCharacterStore, PikoWorldHub

BACKEND_ENV: Final[str] = "PIKO_WORLD_BACKEND"
DEMO_BACKEND: Final[str] = "demo"
DISTRIBUTED_BACKEND: Final[str] = "distributed"


def configured_backend() -> str:
    # Literal name: the env-config ratchet only recognises literal reads.
    backend = os.environ.get("PIKO_WORLD_BACKEND", "").strip().lower()
    if not backend:
        # A deployment with shared control-plane infrastructure must not silently
        # fall back to process-local rooms: every Gunicorn worker would otherwise
        # expose a different set of online players. Selecting distributed when
        # either dependency is present also makes partial configuration fail loud
        # in build_backend() instead of degrading to split rooms.
        has_control_plane = bool(os.environ.get("ST_CONTROL_PLANE_DSN", "").strip())
        has_redis = bool(os.environ.get("ST_REDIS_URL", "").strip())
        backend = DISTRIBUTED_BACKEND if has_control_plane or has_redis else DEMO_BACKEND
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
