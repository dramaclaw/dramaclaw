# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Signed image URLs in the canvas context HTTP response."""

import logging
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from novelvideo.api import deps
from novelvideo.api.routes import files, freezone as routes
from novelvideo.utils import oss_client
from test_agent_canvas_context_route import USER, client_for
from test_agent_canvas_context_route import setup as setup

SOURCE = "/static/projects/proj/images/source.png"
REFERENCE = "/static/projects/proj/images/reference.png"
SIGNED_ORIGIN = "https://objects.example.test"
SIGNED_SOURCE = f"{SIGNED_ORIGIN}/source.png?sig=fake"
SIGNED_REFERENCE = f"{SIGNED_ORIGIN}/reference.png?sig=fake"


def node(url, media_type="image", **fields):
    return {"node_id": "n", "media_type": media_type, "source_url": url, **fields}


@pytest.fixture
def context(setup, monkeypatch):
    root, _ = setup
    project_dir = root / "proj"
    (project_dir / "images").mkdir(parents=True)
    for filename in ("source.png", "reference.png", "forged.png", "clip.mp4", "audio.mp3"):
        (project_dir / "images" / filename).touch()
    (root / "other").mkdir()
    (root / "other" / "x.png").touch()

    nodes = [node(SOURCE, title="Sketch", reference_media=[
        {"url": REFERENCE, "media_type": "image", "label": "Reference"},
    ])]
    result = {
        "ok": True, "errors": [],
        "responses": [{"type": "node_detail", "data": {"nodes": nodes}}],
    }
    monkeypatch.setattr(
        routes, "answer_agent_canvas_context", AsyncMock(side_effect=lambda **_: deepcopy(result)),
    )
    resolved = SimpleNamespace(project_dir=project_dir)
    scope = AsyncMock(return_value=resolved)
    monkeypatch.setattr(deps, "resolve_project_scope", scope)
    monkeypatch.setattr(files, "resolve_project_scope", scope)

    def sign(path, version):
        return f"{SIGNED_ORIGIN}/{path.name}?sig=fake"

    signer = Mock(side_effect=sign)
    monkeypatch.setattr(oss_client, "maybe_presign_static", signer)

    with client_for() as client:
        def request(flag=None, *, extra=None):
            extra = extra or {}
            body = {**extra, "requests": [{"type": "node_detail", "node_id": "n", **extra}]}
            if flag is not None:
                body["include_image_urls"] = flag
            response = client.post("/projects/proj/freezone/canvases/default/agent-context", json=body)
            assert response.status_code == 200, response.text
            return response

        yield SimpleNamespace(
            project_dir=project_dir, nodes=nodes, result=result, scope=scope,
            signer=signer, request=request,
        )


def test_opt_in_signs_stored_node_and_reference_without_changing_other_fields(context):
    expected = deepcopy(context.result)
    item = expected["responses"][0]["data"]["nodes"][0]
    item["image_url"] = SIGNED_SOURCE
    item["reference_media"][0]["image_url"] = SIGNED_REFERENCE

    assert context.request(True).json() == {"ok": True, "data": expected}
    context.scope.assert_awaited_once_with("proj", USER, required_role="viewer", media_read=True)
    paths = [(context.project_dir / "images" / name).resolve()
             for name in ("source.png", "reference.png")]
    assert sorted(call.args for call in context.signer.call_args_list) == sorted(
        (path, path.stat().st_mtime_ns) for path in paths
    )


@pytest.mark.parametrize("error", [None, RuntimeError("signing failed")], ids=["unavailable", "error"])
def test_signer_failure_preserves_response(context, error):
    context.signer.side_effect = error
    context.signer.return_value = None
    baseline = context.request(False)

    assert context.request(True).content == baseline.content
    assert context.signer.call_count == 2


def test_flag_absent_or_false_preserves_legacy_response_without_resolving_media(context):
    baseline = context.request()
    assert baseline.json() == {"ok": True, "data": context.result}
    assert context.request(False).content == baseline.content
    context.scope.assert_not_awaited()
    context.signer.assert_not_called()


def test_media_scope_denial_leaves_canvas_context_readable(context):
    context.scope.side_effect = HTTPException(403, "Access denied")
    assert context.request(True).content == context.request(False).content
    context.scope.assert_awaited_once_with("proj", USER, required_role="viewer", media_read=True)
    context.signer.assert_not_called()


def test_only_existing_same_project_images_are_signed(context):
    invalid_nodes = [
        node("/static/projects/other/x.png"),
        node("/static/projects/proj/../other/x.png"),
        node("/static/projects/proj/%2e%2e/other/x.png"),
        node("https://absolute.example/source.png"),
        node("data:image/png;base64,AAAA"),
        node("not-a-project-asset"),
        node(None),
        node("/static/projects/proj/images/missing.png"),
        node("/static/projects/proj/images/clip.mp4", "video"),
        node("/static/projects/proj/images/audio.mp3", "audio"),
    ]
    context.nodes[:] = [node(SOURCE, reference_media=[
        {"url": item["source_url"], "media_type": item["media_type"]} for item in invalid_nodes
    ]), *invalid_nodes]
    context.result["responses"].append({
        "type": "canvas_summary", "data": {"nodes": [node(REFERENCE)]},
    })
    expected = deepcopy(context.result)
    expected["responses"][0]["data"]["nodes"][0]["image_url"] = SIGNED_SOURCE

    assert context.request(True).json() == {"ok": True, "data": expected}
    source = (context.project_dir / "images/source.png").resolve()
    context.signer.assert_called_once_with(source, source.stat().st_mtime_ns)


def test_body_and_request_items_cannot_select_image_files(context):
    forged = "/static/projects/proj/images/forged.png"
    extra = dict.fromkeys(("image_url", "source_url", "file_path", "path"), forged)
    expected = deepcopy(context.result)
    item = expected["responses"][0]["data"]["nodes"][0]
    item["image_url"] = SIGNED_SOURCE
    item["reference_media"][0]["image_url"] = SIGNED_REFERENCE

    assert context.request(True, extra=extra).json() == {"ok": True, "data": expected}
    assert {call.args[0].name for call in context.signer.call_args_list} == {
        "source.png", "reference.png",
    }


def test_signed_image_addresses_are_never_logged(context, caplog):
    with caplog.at_level(logging.DEBUG):
        result = context.request(True).json()
    item = result["data"]["responses"][0]["data"]["nodes"][0]
    assert item["image_url"] == SIGNED_SOURCE
    assert item["reference_media"][0]["image_url"] == SIGNED_REFERENCE
    assert all(SIGNED_ORIGIN not in record.getMessage() for record in caplog.records)
