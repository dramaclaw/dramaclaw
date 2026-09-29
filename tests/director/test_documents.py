"""Exercise canonical storage through legacy adapters and v2 commands, not mocks."""

from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from novelvideo.director.documents import (
    content_hash,
    parse_markdown,
    plain_projection,
    render_markdown,
    semantic_hash,
    validate_selection,
)
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.repository import DocumentRepository
from novelvideo.director.schemas.common import DirectorContractError
from novelvideo.director.schemas.documents import (
    DocumentAST,
    DocumentCommand,
    SelectionAnchor,
    VersionReference,
)
from novelvideo.director.schemas.execution import ExecutionFault
from novelvideo.director.store import DirectorConflict, DirectorStore


@pytest.fixture
def documents(tmp_path):
    store = DirectorStore(tmp_path)
    work = store.create_work(
        CreateWork(
            title="Synthetic",
            brief="A key opens a box.",
            preset=DirectorPreset(mode="original", episode_count=2),
        )
    )
    return store, work, DocumentRepository(store)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "\n\n",
        "# 标题\n\n甲拿走钥匙。\n",
        "中文😀 e\u0301 👨‍👩‍👧‍👦\n末尾",
        "| 道具 | 持有人 |\n| --- | --- |\n| 画 | 甲 |\n",
        "- 清单\n  - 子项\n1. 列表\n> 引文\n",
        "```python\n# 非标题\nprint('hi')\n```\n",
        "<tag x='1'>\n未识别扩展\n",
        "# 标题\r\n正文\r下一行",
        "**粗体** 与 [链接](https://example.com)\n",
    ],
)
def test_markdown_roundtrip_is_lossless(text):
    ast = parse_markdown(text)
    expected = text.replace("\r\n", "\n").replace("\r", "\n")
    assert render_markdown(ast) == expected
    assert DocumentAST.from_wire(ast.model_dump(by_alias=True)) == ast
    assert render_markdown(parse_markdown(render_markdown(ast), ast)) == expected


def test_stable_blocks_survive_insert_and_replacement_tracks_lineage():
    before = parse_markdown("first\nsecond\nthird\n")
    after = parse_markdown("new\nfirst\nchanged\nthird\n", before)
    assert after.blocks[1].id == before.blocks[0].id
    assert after.blocks[3].id == before.blocks[2].id
    assert after.blocks[2].lineage == [before.blocks[1].id]
    assert after.blocks[2].id != before.blocks[1].id


def test_semantic_hash_excludes_visual_marks_but_not_strike_or_fact_change():
    raw = {
        "schemaVersion": 2,
        "blocks": [{"id": "b", "type": "paragraph", "text": "key"}],
    }
    plain = DocumentAST.from_wire(raw)
    bold = copy.deepcopy(raw)
    bold["blocks"][0]["marks"] = [{"type": "bold", "start": 0, "end": 3}]
    assert semantic_hash(plain) == semantic_hash(DocumentAST.from_wire(bold))
    bold["blocks"][0]["marks"][0]["type"] = "strike"
    assert semantic_hash(plain) != semantic_hash(DocumentAST.from_wire(bold))
    raw["blocks"][0]["text"] = "painting"
    assert semantic_hash(plain) != semantic_hash(DocumentAST.from_wire(raw))


def test_utf16_selection_binds_exact_blocks_version_and_surrogate_boundaries():
    ast = parse_markdown("# A😀\n甲e\u0301乙\n")
    assert plain_projection(ast) == "A😀\n甲e\u0301乙\n"
    anchor = SelectionAnchor.from_wire(
        {
            "documentId": "doc",
            "version": 2,
            "blockIds": [ast.blocks[0].id],
            "startOffset": 1,
            "endOffset": 3,
            "encoding": "utf16",
            "selectedTextHash": content_hash("😀"),
        }
    )
    assert validate_selection(ast, anchor, "doc", 2) == "😀"
    with pytest.raises(DirectorContractError, match="SPLIT_SURROGATE"):
        validate_selection(ast, anchor.model_copy(update={"end_offset": 2}), "doc", 2)
    with pytest.raises(DirectorContractError, match="STALE_SELECTION"):
        validate_selection(ast, anchor, "doc", 3)
    with pytest.raises(DirectorContractError, match="SELECTION_HASH_MISMATCH"):
        validate_selection(
            ast, anchor.model_copy(update={"block_ids": [ast.blocks[1].id]}), "doc", 2
        )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda raw: raw["blocks"].append(copy.deepcopy(raw["blocks"][0])),
        lambda raw: raw["blocks"][0].update({"type": "heading"}),
        lambda raw: raw["blocks"][0].update({"type": "dialogue"}),
        lambda raw: raw["blocks"][0].update({"text": "a\nb"}),
        lambda raw: raw["blocks"][0].update(
            {
                "marks": [
                    {"type": "link", "start": 0, "end": 1, "href": "javascript:evil()"}
                ]
            }
        ),
        lambda raw: raw.update({"modelMayApprove": True}),
    ],
)
def test_ast_rejects_ambiguous_and_unsafe_structure(mutate):
    raw = {
        "schemaVersion": 2,
        "blocks": [{"id": "b", "type": "paragraph", "text": "key"}],
    }
    mutate(raw)
    with pytest.raises(ValidationError):
        DocumentAST.from_wire(raw)


def test_new_work_has_stable_ids_and_legacy_reader_uses_ast_not_cache(documents):
    store, work, repo = documents
    initial = repo.projection(work["id"])
    assert initial["schemaVersion"] == 2
    assert len(initial["episodes"]) == 2
    store.put_document(work["id"], "outline", "# Story\nA keeps the key.", 0)
    formal = next(
        d for d in repo.projection(work["id"])["documents"] if d["docKey"] == "outline"
    )
    assert formal["version"] == 1 and formal["status"] == "draft"
    with store._write() as db:
        db.execute(
            "UPDATE document_versions SET content='poisoned cache' WHERE work_id=?",
            (work["id"],),
        )
    assert (
        store.get_document(work["id"], "outline")["content"]
        == "# Story\nA keeps the key."
    )
    assert repo.projection(work["id"])["episodes"] == initial["episodes"]
    store.put_document(work["id"], "outline", "# Story\nA gives B the key.", 1)
    newer = next(
        d for d in repo.projection(work["id"])["documents"] if d["docKey"] == "outline"
    )
    assert newer["documentId"] == formal["documentId"] and newer["version"] == 2


def test_transitive_artifacts_stale_after_actual_editor_write(documents):
    store, work, repo = documents
    store.put_document(work["id"], "outline", "A keeps key.", 0)
    doc = next(
        d for d in repo.projection(work["id"])["documents"] if d["docKey"] == "outline"
    )
    ref = VersionReference(
        kind="document", id=doc["documentId"], version=1, hash=doc["contentHash"]
    )
    first = repo.put_artifact(
        work["id"], "events", [ref], {"keyOwner": "A"}, "a" * 64, expected_revision=2
    )
    second = repo.put_artifact(
        work["id"],
        "review",
        [
            VersionReference(
                kind="artifact", id=first["id"], version=1, hash=first["hash"]
            )
        ],
        {"dependsOnOwner": "A"},
        "b" * 64,
        expected_revision=2,
    )
    store.put_document(work["id"], "outline", "A gives B the key.", 1)
    assert {
        r["id"]
        for r in repo.projection(work["id"])["artifacts"]
        if r["status"] == "stale"
    } == {first["id"], second["id"]}
    with pytest.raises(ExecutionFault, match="STALE_ARTIFACT_INPUT"):
        repo.put_artifact(
            work["id"], "new-review", [ref], {}, "a" * 64, expected_revision=3
        )
    assert store.list_runs(work["id"]) == []


def test_concurrent_edits_do_not_split_ast_and_markdown_versions(documents):
    store, work, repo = documents

    def edit(text):
        try:
            return store.put_document(work["id"], "outline", text, 0)
        except DirectorConflict:
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(edit, ["a", "b", "c", "d"]))
    assert sum(r is not None for r in results) == 1
    formal = next(
        d for d in repo.projection(work["id"])["documents"] if d["docKey"] == "outline"
    )
    assert formal["content"] == store.get_document(work["id"], "outline")["content"]
    assert formal["version"] == 1


def test_draft_is_private_replayable_and_never_becomes_generation_input(documents):
    store, work, repo = documents
    doc = next(
        d for d in repo.projection(work["id"])["documents"] if d["docKey"] == "outline"
    )
    wire = {
        "schemaVersion": 2,
        "commandId": "save-1",
        "clientRequestId": "save-1",
        "sessionId": "s",
        "workId": work["id"],
        "expected": {"workRevision": 1, "documentVersions": {doc["documentId"]: 0}},
        "payload": {
            "type": "document.saveDraft",
            "documentId": doc["documentId"],
            "clientDraftId": "tab-1",
            "draftRevision": 0,
            "baseVersion": 0,
            "text": "unfinished **",
        },
    }
    command = DocumentCommand.from_wire(wire)
    first = repo.execute("writer", command)
    assert repo.execute("writer", command) == first
    assert repo.drafts(work["id"], "other") == []
    assert repo.drafts(work["id"], "writer")[0]["text"] == "unfinished **"
    assert store.get_document(work["id"], "outline")["version"] == 0
    wire["payload"]["text"] = "changed under old intent"
    with pytest.raises(ExecutionFault, match="IDEMPOTENCY_CONFLICT"):
        repo.execute("writer", DocumentCommand.from_wire(wire))


async def test_document_api_checks_project_permission_and_strict_intent(
    documents, monkeypatch
):
    import httpx
    from fastapi import FastAPI, HTTPException
    from novelvideo.api.routes import director

    store, work, repo = documents
    roles = []

    async def scoped(project, user, role):
        roles.append(role)
        if project != "allowed" or user != {"id": "writer"}:
            raise HTTPException(403)
        return store

    monkeypatch.setattr(director, "_store", scoped)
    app = FastAPI()
    app.include_router(director.router)
    app.dependency_overrides[director.get_api_user] = lambda: {"id": "writer"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test"
    ) as client:
        read = await client.get(
            f"/projects/allowed/director/v2/works/{work['id']}/documents"
        )
        assert read.status_code == 200 and roles[-1] == "viewer"
        assert (
            await client.get(
                f"/projects/denied/director/v2/works/{work['id']}/documents"
            )
        ).status_code == 403
        doc = next(
            d for d in read.json()["data"]["documents"] if d["docKey"] == "outline"
        )
        payload = {
            "schemaVersion": 2,
            "commandId": "edit",
            "clientRequestId": "edit",
            "sessionId": "s",
            "workId": work["id"],
            "expected": {"workRevision": 1, "documentVersions": {doc["documentId"]: 0}},
            "payload": {
                "type": "document.commitManual",
                "documentId": doc["documentId"],
                "text": "A opens box.",
            },
        }
        written = await client.post(
            "/projects/allowed/director/v2/documents/commands", json=payload
        )
        assert written.status_code == 200 and roles[-1] == "editor"
        assert written.json()["data"]["result"]["version"] == 1
        assert written.json()["data"]["workRevision"] == 2
        replay = await client.post(
            "/projects/allowed/director/v2/documents/commands", json=payload
        )
        assert replay.json() == written.json()
        payload["actor"] = "admin"
        assert (
            await client.post(
                "/projects/allowed/director/v2/documents/commands", json=payload
            )
        ).status_code == 422
        assert store.get_document(work["id"], "outline")["version"] == 1


def test_semantic_hash_preserves_hierarchy_and_inline_parse_preserves_marks():
    from novelvideo.director.schemas.documents import Block

    ast = DocumentAST(
        blocks=[
            Block(
                id="scene",
                type="scene",
                text="At home",
                children=[Block(id="action", type="action", text="Take key")],
            )
        ]
    )
    flattened = DocumentAST(
        blocks=[
            ast.blocks[0].model_copy(update={"children": []}),
            ast.blocks[0].children[0],
        ]
    )
    assert semantic_hash(ast) != semantic_hash(flattened)
    assert render_markdown(
        parse_markdown(render_markdown(ast), ast)
    ) == render_markdown(ast)
    with pytest.raises(DirectorContractError, match="STRUCTURED_EDIT_REQUIRED"):
        parse_markdown("Changed scene\n", ast)
    formatted = parse_markdown("**key** and *box*\n")
    assert formatted.blocks[0].text == "key and box"
    assert semantic_hash(parse_markdown(render_markdown(formatted))) == semantic_hash(
        formatted
    )
    assert render_markdown(parse_markdown("a\u2028b\u0085c")) == "a\u2028b\u0085c"
