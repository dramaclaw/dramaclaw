# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Server confirmations refuse missing source media before any durable change."""

import pytest

from novelvideo.api.routes import freezone as routes
from novelvideo.freezone import canvas_store
from novelvideo.ports import registry
from novelvideo.ports.local.usage import NoOpUsageMeter
from test_canvas_confirmation_price import (
    KEYFRAME_ERROR,
    VIDEO,
    generation_core as generation_core,
    set_frame,
    set_plan,
)
from test_canvas_confirmation_routes import (
    BASE,
    EXTERNAL,
    PAID,
    create,
    directory,
    external_post,
    record,
    setup as setup,
    stored_records,
)


@pytest.fixture(autouse=True)
def unmetered(monkeypatch):
    monkeypatch.setitem(registry._PORTS, "usage_meter", NoOpUsageMeter())


@pytest.mark.parametrize(
    "uploading,split", [(True, False), (False, False), (True, True)],
    ids=["uploading", "empty", "split-uploading"],
)
def test_missing_source_refuses_without_writing(
    setup, monkeypatch, generation_core, uploading, split,
):
    set_frame(setup, uploading=uploading)
    node_id = "c-video" if split else "n2"
    commands = set_plan(setup, {**VIDEO, "node_id": node_id})
    if split:
        setup.user[0] = EXTERNAL
        commands = [
            {"type": "create_node", "client_id": node_id, "node_type": "videoNode",
             "data": {"displayName": "片头", "genMode": "firstFrame"}},
            {"type": "create_edge", "source": "n1", "target": node_id},
            *commands,
        ]
    before = canvas_store.read_canvas(setup.root, "default")
    metrics = []
    monkeypatch.setattr(routes, "count_canvas_metric", metrics.append)
    response = (
        external_post(setup, commands) if split else
        setup.client.post(BASE + "/confirmations", json={"commands": commands, "turn_id": "t1"})
    )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "generation_input_not_ready"
    assert "片头" in detail["message"]
    assert "keyframe" in detail["message"].lower()
    assert detail["not_ready"] == [{
        "node_id": node_id, "title": "片头", "node_type": "videoNode",
        "action": "generate_video", "code": "missing_media", "message": KEYFRAME_ERROR,
        "inputs": [{"node_id": "n1", "title": "首帧", "node_type": "uploadNode",
                    "state": "uploading" if uploading else "empty"}],
    }]
    assert stored_records(setup) == []
    assert list(directory(setup).glob("split_*.json")) == []
    assert "canvas_confirmation.created" not in metrics
    assert canvas_store.read_canvas(setup.root, "default") == before


def test_earlier_action_can_produce_missing_source(setup, generation_core):
    set_frame(setup, source_type="imageGenNode")
    data = create(setup, commands=set_plan(setup, PAID[0], VIDEO))
    assert record(setup, data)["status"] == "pending"


def test_browser_confirmation_still_accepts_missing_source(setup, monkeypatch, generation_core):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    set_frame(setup, uploading=True)
    data = create(setup, commands=set_plan(setup, VIDEO))
    assert record(setup, data)["status"] == "pending"
