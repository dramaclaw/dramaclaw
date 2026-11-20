# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
import json

import pytest


def test_default(monkeypatch):
    from novelvideo.freezone.agent_canvas_config import agent_canvas_executor

    monkeypatch.delenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", raising=False)
    assert agent_canvas_executor() == "browser"


@pytest.mark.parametrize("value", ["1", "true", "yes", "on", "TRUE"])
def test_push_values(monkeypatch, value):
    from novelvideo.freezone.agent_canvas_config import canvas_patch_push_enabled

    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", value)
    assert canvas_patch_push_enabled()


@pytest.mark.parametrize("executor,push", [("server", "0"), ("invalid", "1")])
def test_bad_configuration_refuses_app(monkeypatch, executor, push):
    from novelvideo.api.app import create_app
    from novelvideo.freezone.agent_canvas_config import AgentCanvasConfigError

    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", executor)
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", push)
    with pytest.raises(AgentCanvasConfigError, match="DRAMACLAW"):
        create_app()


async def test_server_app_and_public_config(monkeypatch):
    from novelvideo.api.app import create_app
    from novelvideo.api.routes.config import get_runtime_config

    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    app = create_app()
    assert app is not None
    response = await get_runtime_config()
    assert json.loads(response.body)["data"]["agent_canvas_executor"] == "server"


@pytest.mark.parametrize("executor", ["SERVER", "", "other"])
def test_executor_values_are_exact(monkeypatch, executor):
    from novelvideo.freezone.agent_canvas_config import (
        AgentCanvasConfigError,
        agent_canvas_executor,
    )

    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", executor)
    with pytest.raises(AgentCanvasConfigError):
        agent_canvas_executor()


@pytest.mark.parametrize("executor", ["browser", "server"])
async def test_lifecycle_warms_in_background_and_closes(monkeypatch, executor):
    import asyncio
    from importlib import import_module
    import threading
    from types import SimpleNamespace

    from novelvideo.freezone import canvas_core_pool
    from novelvideo.ports import registry
    from novelvideo.shared import runtime_env
    from novelvideo import sqlite_pragmas

    app_module = import_module("novelvideo.api.app")
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    event_loop_thread = threading.get_ident()

    class Pool:
        def warm(self):
            assert threading.get_ident() != event_loop_thread
            entered.set()
            assert release.wait(3)

        def close(self):
            assert threading.get_ident() != event_loop_thread
            closed.set()
            release.set()

    async def noop(*args, **kwargs):
        pass

    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", executor)
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    monkeypatch.setattr(canvas_core_pool, "get_canvas_core_pool", lambda: Pool())
    monkeypatch.setattr(registry, "ensure_bootstrap", lambda: None)
    original_get = registry.get_port
    monkeypatch.setattr(
        registry,
        "get_port",
        lambda name: (
            SimpleNamespace(on_startup=noop, on_shutdown=noop)
            if name == "lifecycle"
            else original_get(name)
        ),
    )
    monkeypatch.setattr(sqlite_pragmas, "litestream_enabled", lambda: False)
    monkeypatch.setattr(runtime_env, "is_ce_effective", lambda: False)
    monkeypatch.setattr(app_module, "_resume_director_auto_best_effort", noop)
    monkeypatch.setattr(
        import_module("novelvideo.chat.director_auto").coordinator, "shutdown", noop
    )
    monkeypatch.setattr(import_module("novelvideo.piko.backend").world_hub, "close", noop)
    monkeypatch.setattr(
        import_module("novelvideo.api.workflow_reads"), "shutdown_workflow_reads", noop
    )
    app = app_module.create_app()
    try:
        async with asyncio.timeout(2), app.router.lifespan_context(app):
            if executor == "server":
                assert await asyncio.to_thread(entered.wait, 1)
                assert not release.is_set()
                assert not app.state.canvas_core_warm_task.done()
            else:
                assert not entered.is_set()
    finally:
        release.set()
    assert closed.is_set() == (executor == "server")


def test_config_http(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from novelvideo.api.routes.config import router

    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    assert (
        TestClient(app).get("/api/v1/config").json()["data"]["agent_canvas_executor"] == "browser"
    )
