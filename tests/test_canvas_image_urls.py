# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Signed image URLs in the canvas context HTTP response."""

import logging
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from canvas_core_requirements import CANVAS_CORE_BUNDLE, requires_canvas_core_bundle
from novelvideo.api import deps
from novelvideo.api.routes import files, freezone as routes
from novelvideo.freezone import agent_canvas, canvas_store
from novelvideo.freezone.canvas_core_pool import CanvasCorePool
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


def reference(url, media_type="image"):
    return {
        "mention": "@image1",
        "node_id": "upload",
        "label": "Reference",
        "media_type": media_type,
        "source_url": url,
        "preview_url": url,
        "link_type": "reference_for",
    }


@pytest.fixture
def media(setup, monkeypatch):
    root, _ = setup
    project_dir = root / "proj"
    (project_dir / "images").mkdir(parents=True)
    for filename in ("source.png", "reference.png", "forged.png", "clip.mp4", "audio.mp3"):
        (project_dir / "images" / filename).touch()
    (root / "other").mkdir()
    (root / "other" / "x.png").touch()

    scope = AsyncMock(return_value=SimpleNamespace(project_dir=project_dir))
    monkeypatch.setattr(deps, "resolve_project_scope", scope)
    monkeypatch.setattr(files, "resolve_project_scope", scope)
    signer = Mock(side_effect=lambda path, version: f"{SIGNED_ORIGIN}/{path.name}?sig=fake")
    monkeypatch.setattr(oss_client, "maybe_presign_static", signer)
    return SimpleNamespace(project_dir=project_dir, scope=scope, signer=signer)


@pytest.fixture
def request_detail():
    with client_for() as client:
        def request(flag=None, *, extra=None):
            extra = extra or {}
            body = {**extra, "requests": [{"type": "node_detail", "node_id": "n", **extra}]}
            if flag is not None:
                body["include_image_urls"] = flag
            response = client.post("/projects/proj/freezone/canvases/default/agent-context", json=body)
            assert response.status_code == 200, response.text
            return response

        yield request


@pytest.fixture
def context(media, request_detail, monkeypatch):
    nodes = [node(SOURCE, title="Sketch", reference_media=[reference(REFERENCE)])]
    result = {
        "ok": True, "errors": [],
        "responses": [{"type": "node_detail", "data": {"nodes": nodes}}],
    }
    monkeypatch.setattr(
        routes, "answer_agent_canvas_context", AsyncMock(side_effect=lambda **_: deepcopy(result)),
    )
    return SimpleNamespace(**vars(media), nodes=nodes, result=result, request=request_detail)


@requires_canvas_core_bundle
def test_opt_in_signs_reference_from_real_node_detail(setup, media, request_detail, monkeypatch):
    root, _ = setup
    canvas_store.save_canvas(
        root,
        "default",
        base_revision=1,
        build_payload=lambda _: {
            "nodes": [
                {"id": "upload", "type": "uploadNode", "position": {"x": 0, "y": 0},
                 "data": {"imageUrl": REFERENCE}},
                {"id": "n", "type": "imageGenNode", "position": {"x": 300, "y": 0}, "data": {}},
            ],
            "edges": [{"id": "edge", "source": "upload", "target": "n"}],
            "revision": 2,
        },
    )
    pool = CanvasCorePool(CANVAS_CORE_BUNDLE, size=1)
    monkeypatch.setattr(agent_canvas, "get_canvas_core_pool", lambda: pool)
    try:
        baseline = request_detail(False).json()
        result = request_detail(True).json()
    finally:
        pool.close()

    [item] = result["data"]["responses"][0]["data"]["nodes"][0]["reference_media"]
    assert "url" not in item
    assert item.keys() - {"image_url"} == {
        "mention", "node_id", "label", "media_type", "source_url", "preview_url", "link_type",
    }
    assert item["source_url"] == REFERENCE
    signed_url = item.pop("image_url", None)
    assert result == baseline
    assert signed_url == SIGNED_REFERENCE


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
        reference(item["source_url"], item["media_type"]) for item in invalid_nodes
    ]), *invalid_nodes]
    context.result["responses"].append({
        "type": "canvas_summary", "data": {"nodes": [node(REFERENCE)]},
    })
    expected = deepcopy(context.result)
    expected["responses"][0]["data"]["nodes"][0]["image_url"] = SIGNED_SOURCE

    assert context.request(True).json() == {"ok": True, "data": expected}
    source = (context.project_dir / "images/source.png").resolve()
    context.signer.assert_called_once_with(source, source.stat().st_mtime_ns)


def test_image_media_type_requires_an_image_file_suffix(context):
    images = ("sample.png", "sample.jpg", "sample.jpeg", "sample.webp", "uppercase.PNG")
    non_images = ("notes.jsonl", "data.bin", "no_suffix")
    urls = {}
    for filename in (*images, *non_images):
        (context.project_dir / "images" / filename).touch()
        urls[filename] = f"/static/projects/proj/images/{filename}"

    context.nodes[:] = [
        *[node(urls[name]) for name in images],
        *[node(urls[name]) for name in non_images],
        node(None, reference_media=[reference(urls[name]) for name in non_images]),
    ]
    expected = context.request(False).json()
    for item, filename in zip(expected["data"]["responses"][0]["data"]["nodes"], images):
        item["image_url"] = f"{SIGNED_ORIGIN}/{filename}?sig=fake"

    actual = context.request(True).json()
    assert sorted(call.args[0].name for call in context.signer.call_args_list) == sorted(images)
    assert actual == expected


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
