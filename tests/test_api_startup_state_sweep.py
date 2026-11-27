"""API startup must not walk the state tree, even with Litestream enabled.

A whole-tree sweep at startup scales with every file under STATE_DIR (canvas
revision history included) and is repeated by each gunicorn worker; on a large
state tree it outlasts the startup probe and the API never becomes ready.
Replicated databases are switched to WAL by Litestream itself, and data.db by
ensure_sqlite_schema, so startup has nothing to convert.
"""

import sqlite3
from importlib import import_module
from types import SimpleNamespace

import pytest


class _StopAfterSweepPoint(RuntimeError):
    pass


async def test_api_startup_leaves_state_tree_untouched_with_litestream(
    monkeypatch, tmp_path
):
    from novelvideo import config
    from novelvideo.freezone import canvas_core_pool
    from novelvideo.ports import registry
    from novelvideo.shared import runtime_env

    db_path = tmp_path / "u1" / "p1" / "chat.db"
    db_path.parent.mkdir(parents=True)
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE t(x)")
    conn.commit()
    conn.close()

    async def on_startup(**_kwargs):
        return None

    def stop_after_sweep_point():
        raise _StopAfterSweepPoint

    monkeypatch.setenv("ST_LITESTREAM_ENABLED", "1")
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setattr(canvas_core_pool, "canvas_core_unavailable_reason", lambda: None)
    monkeypatch.setattr(registry, "ensure_bootstrap", lambda: None)
    monkeypatch.setattr(
        registry, "get_port", lambda name: SimpleNamespace(on_startup=on_startup)
    )
    app = import_module("novelvideo.api.app").create_app()
    monkeypatch.setattr(runtime_env, "is_ce_effective", stop_after_sweep_point)

    with pytest.raises(_StopAfterSweepPoint):
        async with app.router.lifespan_context(app):
            pytest.fail("Startup did not reach the stop point")

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "delete"
    finally:
        conn.close()
