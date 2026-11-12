# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Exercise canvas confirmation policy and durable decisions with an injected clock."""

from concurrent.futures import ThreadPoolExecutor
import re
from threading import Barrier

import pytest

from novelvideo.freezone.canvas_confirmations import (
    CONFIRMATIONS_DIRNAME,
    CONFIRMATION_TTL_SECONDS,
    CanvasConfirmationError,
    changed_targets,
    claim,
    command_hash,
    confirmation_kinds,
    confirmation_targets,
    create_confirmation,
    expire_due,
    finish_confirmation,
    list_pending,
    read_confirmation,
    verify_confirmed,
    void_confirmation,
)


@pytest.fixture
def canvas():
    return {"nodes": [
        {"id": "n1", "type": "imageGenNode", "data": {"label": "海报"}},
        {"id": "n2", "type": "videoNode", "data": {"displayName": "片头"}},
        {"id": "n3", "type": "textNode", "data": {}},
    ]}


@pytest.fixture
def create(tmp_path, canvas):
    def make(**overrides):
        values = {
            "project_id": "p1", "canvas_id": "c1", "agent_id": "a1",
            "username": "user1", "turn_id": "t1",
            "commands": [{"type": "delete_nodes", "node_ids": ["n1"]}],
            "now": 1000.0,
        }
        values.update(overrides)
        values["targets"] = confirmation_targets(canvas, values["commands"])
        return create_confirmation(tmp_path / CONFIRMATIONS_DIRNAME, **values)

    return make


def decide(directory, record, **overrides):
    values = {
        "decision": "confirmed", "via": "card", "username": "user1",
        "agent_id": "a1", "turn_id": "t1", "command_hash": record["command_hash"],
        "now": 1100.0,
    }
    values.update(overrides)
    return claim(directory, record["id"], **values)


@pytest.mark.parametrize("kind", [
    "create_node", "add_next_node", "create_edge", "delete_edges", "update_node_data",
    "move_nodes", "layout_nodes", "group_nodes", "select_nodes", "html_artifact",
    "open_mainline_projection",
])
def test_free_command_types(kind):
    assert confirmation_kinds([{"type": kind}]) == []


@pytest.mark.parametrize(("kind", "expected"), [
    ("delete_nodes", ["delete_nodes"]), ("clear_canvas", ["clear_canvas"]),
    ("run_workflow", ["paid_generation"]),
])
def test_confirmation_command_types(kind, expected):
    assert confirmation_kinds([{"type": kind}]) == expected


@pytest.mark.parametrize("action", [
    "update_source", "select_version", "restore", "open", "export", "upload",
    "download_image", "download_video", "download_audio", "run_matting_tool",
    "run_audio_separate", "run_video_depth_capture", "capture_video_first_frame",
    "capture_video_last_frame", "capture_pano_current_view", "capture_pano_2x2_views",
    "capture_pano_4x3_views", "set_pano_current_view_as_background", "reset_pano_view",
    "open_crop_tool", "run_video_breakdown",
])
def test_free_node_actions(action):
    assert confirmation_kinds([{"type": "run_node_action", "action": action}]) == []


@pytest.mark.parametrize("action", [
    "generate_image", "run_grid_plot_four", "open_video_compose_modal", "brand_new_action",
])
def test_paid_node_actions(action):
    assert confirmation_kinds([{"type": "run_node_action", "action": action}]) == [
        "paid_generation"
    ]


@pytest.mark.parametrize(("auto_start", "expected"), [
    (True, ["paid_generation"]), (False, []), (1, []), ("true", []), (None, []),
])
def test_breakdown_only_literal_true_is_paid(auto_start, expected):
    assert confirmation_kinds([{
        "type": "run_node_action", "action": "run_video_breakdown",
        "parameters": {"auto_start": auto_start},
    }]) == expected


def test_kinds_order_deduplication_and_unknown_type():
    commands = [
        {"type": "run_node_action", "action": "generate_video"},
        {"type": "delete_edges"}, {"type": "clear_canvas"}, {"type": "delete_nodes"},
    ]
    assert confirmation_kinds(commands + commands) == [
        "delete_nodes", "clear_canvas", "paid_generation"
    ]
    assert confirmation_kinds([]) == []
    with pytest.raises(ValueError):
        confirmation_kinds([{"type": "brand_new_command"}])


def test_command_hash():
    commands = [{"type": "delete_nodes", "node_ids": ["n1"]}]
    digest = command_hash("p1", "c1", commands)
    assert digest == "cb094cbc88bb277891f4c9725113a6ee505c98e355074acb4e5befd5fea6c03c"
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert digest == command_hash("p1", "c1", [{"node_ids": ["n1"], "type": "delete_nodes"}])
    assert digest != command_hash("p1", "c1", [{"type": "delete_nodes", "node_ids": ["n2"]}])
    assert digest != command_hash("p2", "c1", commands)
    assert digest != command_hash("p1", "c2", commands)


def test_delete_and_mixed_targets(canvas):
    assert confirmation_targets(canvas, [{"type": "delete_nodes", "node_ids": ["n1", "n2"]}]) == [
        {"node_id": "n1", "title": "海报", "node_type": "imageGenNode", "action": "delete_nodes"},
        {"node_id": "n2", "title": "片头", "node_type": "videoNode", "action": "delete_nodes"},
    ]
    assert confirmation_targets(canvas, [
        {"type": "create_node", "node_id": "new"},
        {"type": "run_node_action", "node_id": "n2", "action": "generate_video"},
        {"type": "run_node_action", "node_id": "n9", "action": "download_video"},
    ]) == [{
        "node_id": "n2", "title": "片头", "node_type": "videoNode", "action": "generate_video"
    }]


@pytest.mark.parametrize("command", [
    {"type": "clear_canvas"}, {"type": "run_workflow", "scope": "canvas"},
    {"type": "run_workflow", "scope": "canvas", "node_ids": []},
])
def test_whole_canvas_targets(canvas, command):
    assert confirmation_targets(canvas, [command]) == [
        {"node_id": "n1", "title": "海报", "node_type": "imageGenNode", "action": command["type"]},
        {"node_id": "n2", "title": "片头", "node_type": "videoNode", "action": command["type"]},
        {"node_id": "n3", "title": "", "node_type": "textNode", "action": command["type"]},
    ]


def test_target_order_deduplication_and_title_fallbacks():
    canvas = {"nodes": [
        {"id": "n1", "data": {"label": " ", "displayName": 1, "title": " Title ", "name": "N"}},
        {"id": "n2", "type": "textNode", "data": {"name": " Name "}},
    ]}
    assert confirmation_targets(canvas, [
        {"type": "delete_nodes", "node_ids": ["n2", "n1", "n2"]},
        {"type": "delete_nodes", "node_ids": ["n1"]},
        {"type": "run_workflow", "scope": "canvas", "node_ids": ["n1"]},
    ]) == [
        {"node_id": "n2", "title": "Name", "node_type": "textNode", "action": "delete_nodes"},
        {"node_id": "n1", "title": "Title", "node_type": "", "action": "delete_nodes"},
        {"node_id": "n1", "title": "Title", "node_type": "", "action": "run_workflow"},
    ]


@pytest.mark.parametrize("command", [
    {"type": "delete_nodes", "node_ids": ["n9", "n8"]},
    {"type": "run_node_action", "node_id": "n9", "action": "generate_video"},
    {"type": "run_workflow", "scope": "canvas", "node_ids": ["n9"]},
])
def test_missing_targets(canvas, command):
    with pytest.raises(CanvasConfirmationError, match="n9") as error:
        confirmation_targets(canvas, [command])
    assert error.value.code == "targets_missing"
    if "n8" in command.get("node_ids", []):
        assert "n8" in str(error.value)


def test_create_read_and_list(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create()
    assert CONFIRMATIONS_DIRNAME == "mcp_canvas_approvals"
    assert CONFIRMATION_TTL_SECONDS == 1800
    assert re.fullmatch(r"cc_[0-9a-f]{32}", record["id"])
    assert record == {
        "id": record["id"], "project_id": "p1", "canvas_id": "c1", "agent_id": "a1",
        "username": "user1", "turn_id": "t1",
        "commands": [{"type": "delete_nodes", "node_ids": ["n1"]}],
        "command_hash": record["command_hash"], "kinds": ["delete_nodes"],
        "targets": [{
            "node_id": "n1", "title": "海报", "node_type": "imageGenNode", "action": "delete_nodes"
        }],
        "created_at": 1000.0, "expires_at": 2800.0, "updated_at": 1000.0,
        "status": "pending", "decided_via": None, "outcome": None,
    }
    assert (directory / (record["id"] + ".json")).is_file()
    assert read_confirmation(directory, record["id"]) == record
    create(turn_id=None)
    create(canvas_id="c2")
    create(project_id="p2")
    earlier = create(now=900.0)
    assert list_pending(directory, project_id="p1", canvas_id="c1", now=2699.0) == [
        earlier, record
    ]
    assert list_pending(directory, project_id="p1", canvas_id="c1", now=2799.0) == [record]
    assert list_pending(directory, project_id="p1", canvas_id="c1", now=2800.0) == []


def test_card_claim_and_refusal(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    for decision in ("confirmed", "refused"):
        record = create()
        decided = decide(directory, record, decision=decision)
        assert decided == {
            **record, "status": decision, "decided_via": "card", "updated_at": 1100.0
        }
        assert read_confirmation(directory, record["id"]) == decided
        assert list_pending(directory, project_id="p1", canvas_id="c1", now=1100.0) == []
        with pytest.raises(CanvasConfirmationError) as error:
            decide(directory, record)
        assert error.value.code == "already_handled"


@pytest.mark.parametrize(("overrides", "code"), [
    ({"command_hash": "wrong"}, "command_mismatch"),
    ({"command_hash": None}, "command_mismatch"),
    ({"turn_id": "t2"}, "turn_mismatch"),
    ({"username": "other"}, "agent_mismatch"),
    ({"agent_id": "other"}, "agent_mismatch"),
])
def test_rejected_card_claim_is_unchanged(tmp_path, create, overrides, code):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create()
    with pytest.raises(CanvasConfirmationError) as error:
        decide(directory, record, **overrides)
    assert error.value.code == code
    assert read_confirmation(directory, record["id"]) == record
    assert decide(directory, record)["status"] == "confirmed"


def test_turnless_card_requires_turn(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create(turn_id=None)
    with pytest.raises(CanvasConfirmationError) as error:
        decide(directory, record, turn_id=None)
    assert error.value.code == "turn_required"
    assert read_confirmation(directory, record["id"]) == record


@pytest.mark.parametrize("via", ["card", "conversation"])
def test_claim_expiry_and_check_order(tmp_path, create, via):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create()
    with pytest.raises(CanvasConfirmationError) as error:
        decide(directory, record, username="other", now=2800.0, via=via)
    assert error.value.code == "agent_mismatch"
    assert read_confirmation(directory, record["id"]) == record
    with pytest.raises(CanvasConfirmationError) as error:
        decide(directory, record, now=2800.0, via=via)
    assert error.value.code == "expired"
    expired = {**record, "status": "expired", "updated_at": 2800.0}
    assert error.value.record == expired
    assert read_confirmation(directory, record["id"]) == expired
    with pytest.raises(CanvasConfirmationError) as error:
        decide(directory, record, now=2900.0, via=via)
    assert error.value.code == "expired"
    assert read_confirmation(directory, record["id"]) == expired


@pytest.mark.parametrize("turn_id", ["t1", None])
def test_conversation_requires_user_reply(tmp_path, create, turn_id):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create()
    with pytest.raises(CanvasConfirmationError) as error:
        decide(directory, record, via="conversation", turn_id=turn_id)
    assert error.value.code == "user_reply_required"
    assert read_confirmation(directory, record["id"]) == record
    confirmed = decide(directory, record, via="conversation", turn_id="t2", command_hash=None)
    assert confirmed == {
        **record, "status": "confirmed", "decided_via": "conversation", "updated_at": 1100.0
    }


def test_turnless_conversation(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create(turn_id=None)
    with pytest.raises(CanvasConfirmationError) as error:
        decide(directory, record, via="conversation", turn_id="t9")
    assert error.value.code == "turn_mismatch"
    assert read_confirmation(directory, record["id"]) == record
    confirmed = decide(directory, record, via="conversation", turn_id=None)
    assert confirmed["status"] == "confirmed"
    assert confirmed["decided_via"] == "conversation"


def test_verify_and_finish(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create()
    arguments = {"command_hash": record["command_hash"], "turn_id": "t1"}
    with pytest.raises(CanvasConfirmationError) as error:
        verify_confirmed(directory, record["id"], **arguments)
    assert error.value.code == "not_confirmed"
    confirmed = decide(directory, record, via="conversation", turn_id="t2")
    for _ in range(2):
        assert verify_confirmed(directory, record["id"], **arguments) == confirmed
    for overrides, code in [
        ({"command_hash": "wrong", "turn_id": "wrong"}, "command_mismatch"),
        ({"turn_id": "t2"}, "turn_mismatch"),
    ]:
        with pytest.raises(CanvasConfirmationError) as error:
            verify_confirmed(directory, record["id"], **(arguments | overrides))
        assert error.value.code == code
    executed = finish_confirmation(directory, record["id"], outcome={"ok": True}, now=1200.0)
    assert executed == {
        **confirmed, "status": "executed", "outcome": {"ok": True}, "updated_at": 1200.0
    }
    assert read_confirmation(directory, record["id"]) == executed
    with pytest.raises(CanvasConfirmationError) as error:
        verify_confirmed(directory, record["id"], **arguments)
    assert error.value.code == "not_confirmed"


def test_changed_targets(canvas, create):
    record = create()
    assert changed_targets(canvas, record) == []
    assert changed_targets({"nodes": canvas["nodes"][1:]}, record) == ["n1"]
    added = {"nodes": canvas["nodes"] + [{"id": "n4", "type": "textNode", "data": {}}]}
    for command in [{"type": "clear_canvas"}, {"type": "run_workflow", "scope": "canvas"}]:
        whole = create(commands=[command])
        assert changed_targets(canvas, whole) == []
        assert changed_targets(added, whole) == ["n4"]
        assert changed_targets({"nodes": added["nodes"][1:]}, whole) == ["n1", "n4"]
    partial = create(commands=[{"type": "run_workflow", "scope": "canvas", "node_ids": ["n1"]}])
    assert changed_targets(added, partial) == []


def test_void_and_pending_finish(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create()
    with pytest.raises(CanvasConfirmationError) as error:
        finish_confirmation(directory, record["id"], outcome={"ok": True}, now=1100.0)
    assert error.value.code == "not_confirmed"
    assert read_confirmation(directory, record["id"]) == record
    voided = void_confirmation(directory, record["id"], reason="targets_missing", now=1200.0)
    assert voided == {
        **record, "status": "voided", "outcome": {"reason": "targets_missing"}, "updated_at": 1200.0
    }
    assert read_confirmation(directory, record["id"]) == voided


def test_expire_due_and_terminal_cleanup(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    pending = create()
    refused = decide(directory, create(), decision="refused")
    assert expire_due(directory, now=2799.0) == []
    expired = {**pending, "status": "expired", "updated_at": 2800.0}
    assert expire_due(directory, now=2800.0) == [expired]
    assert expire_due(directory, now=2800.0) == []
    assert read_confirmation(directory, refused["id"]) == refused
    assert expire_due(directory, now=87500.0) == []
    assert read_confirmation(directory, refused["id"]) == refused
    assert expire_due(directory, now=87501.0) == []
    assert read_confirmation(directory, refused["id"]) is None
    assert not (directory / (refused["id"] + ".json")).exists()
    assert read_confirmation(directory, pending["id"]) == expired
    live_pending = create(now=90000.0)
    assert expire_due(directory, now=90001.0) == []
    assert read_confirmation(directory, pending["id"]) is None
    assert read_confirmation(directory, live_pending["id"]) == live_pending


def test_missing_directory(tmp_path):
    directory = tmp_path / "absent"
    assert expire_due(directory, now=1000.0) == []
    assert list_pending(directory, project_id="p1", canvas_id="c1", now=1000.0) == []
    assert read_confirmation(directory, "cc_" + "0" * 32) is None
    assert not directory.exists()


@pytest.mark.parametrize("confirmation_id", ["../x", "cc_XYZ", "cc_" + "0" * 32])
def test_missing_and_invalid_ids(tmp_path, confirmation_id):
    directory = tmp_path / "absent"
    assert read_confirmation(directory, confirmation_id) is None
    operations = [
        lambda: claim(directory, confirmation_id, decision="confirmed", via="card",
                      username="user1", agent_id="a1", turn_id="t1", now=1000.0),
        lambda: verify_confirmed(directory, confirmation_id, command_hash="wrong", turn_id="t1"),
        lambda: void_confirmation(directory, confirmation_id, reason="missing", now=1000.0),
        lambda: finish_confirmation(directory, confirmation_id, outcome={}, now=1000.0),
    ]
    for operation in operations:
        with pytest.raises(CanvasConfirmationError) as error:
            operation()
        assert error.value.code == "not_found"
        assert error.value.record is None
    assert not directory.exists()


def test_concurrent_claims_only_one_succeeds(tmp_path, create):
    directory = tmp_path / CONFIRMATIONS_DIRNAME
    record = create()
    barrier = Barrier(2)

    def compete(decision):
        barrier.wait(timeout=5)
        try:
            return decide(directory, record, decision=decision)["status"]
        except CanvasConfirmationError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(compete, ["confirmed", "refused"]))
    assert sorted(results) in [["already_handled", "confirmed"], ["already_handled", "refused"]]
    assert read_confirmation(directory, record["id"])["status"] in ("confirmed", "refused")


def test_targets_include_nodes_created_in_the_same_batch(canvas):
    commands = [
        {"type": "create_node", "client_id": "c1", "node_type": "imageGenNode",
         "data": {"label": "新海报"}},
        {"type": "add_next_node", "client_id": "c2", "source_node_id": "n1",
         "data": {"title": " 续图 "}},
        {"type": "html_artifact", "action": "prepare", "client_id": "c3",
         "workflow_data": {"label": "页面"}},
        {"type": "run_workflow", "scope": "selection", "node_ids": ["c1", "c2", "c3", "n1"]},
    ]
    assert confirmation_targets(canvas, commands) == [
        {"node_id": "c1", "title": "新海报", "node_type": "imageGenNode",
         "action": "run_workflow"},
        {"node_id": "c2", "title": "续图", "node_type": "", "action": "run_workflow"},
        {"node_id": "c3", "title": "页面", "node_type": "htmlArtifactNode",
         "action": "run_workflow"},
        {"node_id": "n1", "title": "海报", "node_type": "imageGenNode",
         "action": "run_workflow"},
    ]
    assert confirmation_targets(canvas, [commands[0], {
        "type": "run_node_action", "node_id": "c1", "action": "generate_image",
    }]) == [{"node_id": "c1", "title": "新海报", "node_type": "imageGenNode",
             "action": "generate_image"}]
    with pytest.raises(CanvasConfirmationError) as error:
        confirmation_targets(canvas, [commands[0], {
            "type": "run_workflow", "node_ids": ["c1", "n9"],
        }])
    assert error.value.code == "targets_missing"
    assert "n9" in str(error.value)
    assert "c1" not in str(error.value)


def test_changed_targets_ignores_nodes_created_in_the_same_batch(canvas, create):
    record = create(commands=[
        {"type": "create_node", "client_id": "c1", "node_type": "imageGenNode",
         "data": {"label": "新海报"}},
        {"type": "run_workflow", "scope": "selection", "node_ids": ["c1", "n1"]},
    ])
    assert changed_targets(canvas, record) == []
    canvas["nodes"] = [node for node in canvas["nodes"] if node["id"] != "n1"]
    assert changed_targets(canvas, record) == ["n1"]
