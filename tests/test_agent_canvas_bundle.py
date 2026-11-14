"""Exercise the built canvas core through the Python dispatcher and store."""

from copy import deepcopy
from functools import partial
from types import SimpleNamespace

import pytest

from canvas_core_requirements import CANVAS_CORE_BUNDLE as BUNDLE
from canvas_core_requirements import requires_canvas_core_bundle
from novelvideo.api.routes import freezone as routes
from novelvideo.freezone import agent_canvas, canvas_store
from novelvideo.freezone.canvas_core_pool import CanvasCorePool

pytestmark = requires_canvas_core_bundle


class RecordingPool(CanvasCorePool):
    def __init__(self):
        super().__init__(BUNDLE, size=1)
        self.calls = []

    def call(self, op, payload):
        self.calls.append((op, deepcopy(payload)))
        return super().call(op, payload)


@pytest.fixture
def executor(monkeypatch, tmp_path):
    pool = RecordingPool()
    monkeypatch.setattr(agent_canvas, "get_canvas_core_pool", lambda: pool)
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    canvas_store.ensure_default_canvas(tmp_path, project_id="project")
    saved_bodies = []

    async def after_save(body, saved):
        saved_bodies.append(body)
        assert saved.payload["save_source"] == "agent_patch"

    async def apply(commands, *, envelope_fields=None):
        return await agent_canvas.dispatch_agent_canvas(
            project="project", canvas_id="default", project_dir=tmp_path,
            envelopes=[{"schema_version": "canvas_chat_commands.v1", "commands": commands,
                        **(envelope_fields or {})}],
            env={"locale": "en", "catalogs": {}},
            build_payload=partial(
                routes._canvas_payload_builder, project="project", canvas_id="default",
                user={"id": "owner", "username": "owner"}, ctx=SimpleNamespace(project_id="project"),
            ),
            after_save=after_save,
        )

    yield pool, apply, saved_bodies, tmp_path
    pool.close()


async def test_real_bundle_rejects_inline_media_without_saving(executor):
    _, apply, saved_bodies, root = executor
    before = canvas_store.read_canvas(root, "default")
    with pytest.raises(agent_canvas.CanvasInlineMediaError) as exc:
        await apply([
            {"type": "create_node", "node_type": "imageGenNode",
             "data": {"imageUrl": "data:image/png;base64,AAAA"}},
        ])
    assert len(exc.value.fields) == 1
    assert exc.value.fields[0]["field"] == "imageUrl"
    assert saved_bodies == []
    assert canvas_store.read_canvas(root, "default")["revision"] == before["revision"]


async def test_real_bundle_saves_structural_batch_and_reads_host_context(executor):
    pool, apply, saved_bodies, root = executor
    result = await apply([
        {"type": "create_node", "client_id": "first", "node_type": "textAnnotationNode",
         "data": {"title": "Start", "content": "A ship"}},
        {"type": "create_node", "client_id": "second", "node_type": "audioNode",
         "data": {"text": "Set sail"}},
        {"type": "create_edge", "source": "first", "target": "second", "link_type": "prompt_for"},
        {"type": "layout_nodes", "node_ids": ["first", "second"], "mode": "horizontal"},
    ])
    assert result["status"] == "applied", result
    assert result["receipt"]["canvas_apply_status"] == "applied"
    assert result["receipt"]["message"] == (
        "Canvas command finished; see canvas_apply_status for the outcome."
    )
    assert result["receipt"]["applied_count"] == 5
    assert result["revision"] == 2
    assert len(saved_bodies) == 1 and saved_bodies[0].save_source == "agent_patch"
    saved = canvas_store.read_canvas(root, "default")
    assert saved["save_source"] == "agent_patch"
    assert len([node for node in saved["nodes"] if node["type"] != "groupNode"]) == 2
    assert len(saved["edges"]) == 1
    first = next(node["id"] for node in saved["nodes"] if node["type"] == "textAnnotationNode")
    second = next(node["id"] for node in saved["nodes"] if node["type"] == "audioNode")
    assert set(result["changes"]["created_node_ids"]) == {node["id"] for node in saved["nodes"]}
    assert saved["edges"][0]["source"] == first and saved["edges"][0]["target"] == second
    assert saved["nodes"][0]["position"] != saved["nodes"][1]["position"]
    requests = [
        {"type": "canvas_summary"},
        {"type": "node_detail", "node_id": first},
        {"type": "node_detail", "node_id": "missing"},
        {"type": "audio_voice_options", "node_id": second},
    ]
    fetched = []

    async def audio(need):
        fetched.append(need)
        return {"items": [{"scope": "project_narrator", "label": "Narrator", "language": "en",
                           "preview_url": "/voice.wav"}]}

    answer = await agent_canvas.answer_agent_canvas_context(
        project="project", canvas_id="default", canvas=saved,
        envelopes=[{"schema_version": "canvas_context_request.v1", "canvas_id": "default",
                    "requests": requests}],
        env={"locale": "en", "project": "project", "canvasId": "default"},
        fetchers={"audio_references": audio},
    )
    assert len(answer["responses"]) == len(requests), answer
    assert [response["type"] for response in answer["responses"]] == [r["type"] for r in requests]
    assert fetched == [{"kind": "audio_references"}]
    reads = [payload for op, payload in pool.calls if op == "answer_context"]
    assert len(reads) == 2 and "hostData" not in reads[0]["env"]
    assert "audio_references" in reads[1]["env"]["hostData"]
    assert answer["responses"][1]["data"]["nodes"][0]["node_id"] == first
    # Same as the browser: a missing node answers with empty data.
    assert answer["responses"][2]["data"] is None
    assert answer["responses"][3]["data"]["options"]


@pytest.mark.parametrize("envelope_fields,spacing", [
    ({"external_mcp_command": True}, 520),
    ({}, 368),
], ids=["external-mcp", "unmarked"])
async def test_real_bundle_horizontal_layout_preserves_external_mcp_geometry(
    executor, envelope_fields, spacing,
):
    _, apply, _, root = executor
    created = await apply([
        {"type": "create_node", "node_type": "textAnnotationNode",
         "data": {"title": f"Text {index}", "content": f"Text {index}"}}
        for index in range(3)
    ])
    assert created["status"] == "applied", created
    before = canvas_store.read_canvas(root, "default")
    node_ids = [node["id"] for node in before["nodes"] if node["type"] == "textAnnotationNode"]
    assert len(node_ids) == 3
    result = await apply([
        {"type": "layout_nodes", "node_ids": node_ids, "mode": "horizontal"},
    ], envelope_fields=envelope_fields)
    assert result["status"] == "applied", result
    saved = canvas_store.read_canvas(root, "default")
    positions = [node["position"] for node in saved["nodes"] if node["id"] in node_ids]
    xs = sorted(position["x"] for position in positions)
    assert xs == [xs[0] + index * spacing for index in range(3)]
    assert len({position["y"] for position in positions}) == 1


async def test_real_bundle_defers_host_batch_without_saving(executor):
    _, apply, saved_bodies, root = executor
    before = canvas_store.read_canvas(root, "default")
    result = await apply([
        {"type": "create_node", "node_type": "textAnnotationNode", "data": {"content": "Hello"}},
        {"type": "run_node_action", "node_id": "missing", "action": "generate_audio"},
    ])
    assert result["status"] == "host_required"
    assert result["host_command_types"] == ["run_node_action"]
    assert not saved_bodies
    assert canvas_store.read_canvas(root, "default") == before


async def test_real_bundle_resolves_add_next_alias_in_later_commands(executor):
    _, apply, _, root = executor
    result = await apply([
        {"type": "create_node", "client_id": "source", "node_type": "textAnnotationNode",
         "data": {"title": "Start", "content": "A ship"}},
        {"type": "add_next_node", "client_id": "result", "source_node_id": "source",
         "node_type": "imageGenNode", "data": {"prompt": "Watercolor"}, "connect": True},
        {"type": "update_node_data", "node_id": "result", "data": {"displayName": "Watercolor result"}},
    ])
    assert result["status"] == "applied"
    saved = canvas_store.read_canvas(root, "default")
    created = next(node for node in saved["nodes"] if node["type"] == "imageGenNode")
    assert created["data"]["prompt"] == "Watercolor"
    assert created["data"]["displayName"] == "Watercolor result"
    assert created["id"] in result["receipt"]["created_node_ids"]
    assert saved["edges"][0]["target"] == created["id"]
