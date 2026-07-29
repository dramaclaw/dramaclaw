from __future__ import annotations

from types import SimpleNamespace

import pytest


class _FakePipelineStatus:
    value = "ERRORED"


class _FakeCompletedPipelineStatus:
    value = "COMPLETED"


def test_cognee_pipeline_error_result_raises_runtime_error():
    from novelvideo.cognee.store import CogneeStore

    result = SimpleNamespace(
        status=_FakePipelineStatus(),
        payload="LLM provider rejected the request",
    )

    with pytest.raises(RuntimeError, match="知识图谱构建失败"):
        CogneeStore._ensure_pipeline_run_succeeded(result, "知识图谱构建")


def test_cognee_pipeline_error_includes_nested_data_item_error():
    from novelvideo.cognee.store import CogneeStore

    result = SimpleNamespace(
        status=_FakePipelineStatus(),
        payload="Pipeline run failed. Data item could not be processed.",
        data_ingestion_info=[
            {
                "run_info": SimpleNamespace(
                    status=_FakePipelineStatus(),
                    payload="Provider rejected chunk 7: context length exceeded",
                )
            }
        ],
    )

    with pytest.raises(RuntimeError) as exc_info:
        CogneeStore._ensure_pipeline_run_succeeded(result, "知识图谱构建")

    message = str(exc_info.value)
    assert "知识图谱构建失败" in message
    assert "Provider rejected chunk 7" in message


def test_cognee_pipeline_completed_parent_still_rejects_nested_error():
    from novelvideo.cognee.store import CogneeStore

    result = {
        "run": {
            "status": _FakeCompletedPipelineStatus(),
            "data_ingestion_info": [
                {
                    "run_info": {
                        "status": _FakePipelineStatus(),
                        "payload": "Embedding provider returned 429",
                    }
                }
            ],
        }
    }

    with pytest.raises(RuntimeError, match="Embedding provider returned 429"):
        CogneeStore._ensure_pipeline_run_succeeded(result, "知识图谱构建")


def test_cognee_pipeline_completed_parent_rejects_nested_non_terminal_run():
    from novelvideo.cognee.store import CogneeStore

    result = {
        "run": {
            "status": "PipelineRunCompleted",
            "data_ingestion_info": [
                {
                    "run_info": {
                        "status": "PipelineRunStarted",
                        "payload": None,
                    }
                }
            ],
        }
    }

    with pytest.raises(RuntimeError, match="PipelineRunStarted"):
        CogneeStore._ensure_pipeline_run_succeeded(result, "知识图谱构建")


@pytest.mark.parametrize(
    "status",
    [
        "COMPLETED",
        "PipelineRunCompleted",
        "PipelineRunAlreadyCompleted",
        "DATASET_PROCESSING_COMPLETED",
    ],
)
def test_cognee_pipeline_accepts_known_completed_statuses(status):
    from novelvideo.cognee.store import CogneeStore

    CogneeStore._ensure_pipeline_run_succeeded(
        SimpleNamespace(status=status, payload=None),
        "知识图谱构建",
    )


@pytest.mark.parametrize(
    "result",
    [
        {},
        [],
        SimpleNamespace(status="STARTED", payload=None),
        {"run": {"status": None, "payload": None}},
    ],
)
def test_cognee_pipeline_rejects_empty_or_non_terminal_result(result):
    from novelvideo.cognee.store import CogneeStore

    with pytest.raises(RuntimeError, match="知识图谱构建失败"):
        CogneeStore._ensure_pipeline_run_succeeded(result, "知识图谱构建")


@pytest.mark.asyncio
async def test_failed_graph_build_leaves_project_unimported(tmp_path, monkeypatch):
    """A failed ingest must not persist novel content.

    Regression: novel content was saved at Step 1 (before the graph build that
    can fail), so a failed cognify still left ``load_novel_content()`` returning
    text — and the UI inferred "导入完成" from that. A failure must leave the
    project un-imported so the user can retry.
    """
    from novelvideo.cognee.store import CogneeStore
    novel = tmp_path / "novel.txt"
    novel.write_text("第一章\n春深不见旧门红，内容内容内容。\n", encoding="utf-8")

    store = object.__new__(CogneeStore)
    store.dataset_name = "test_ds"
    saved: dict[str, str] = {}
    monkeypatch.setattr(
        store, "save_novel_content", lambda content: saved.__setitem__("content", content)
    )
    monkeypatch.setattr(store, "load_novel_content", lambda: saved.get("content"))
    monkeypatch.setattr(store, "_set_cognee_context", lambda *a, **k: None)
    monkeypatch.setattr("novelvideo.cognee.config.init_cognee", lambda *a, **k: None)
    monkeypatch.setenv("LLM_API_KEY", "test-key")

    async def fail_graph(*, stage_name, **kwargs):
        if stage_name == "知识图谱构建":
            raise RuntimeError("知识图谱构建失败(PipelineRunErrored)")
        return SimpleNamespace(status=_FakeCompletedPipelineStatus())

    monkeypatch.setattr(store, "_run_cognee_pipeline_with_retry", fail_graph)

    with pytest.raises(RuntimeError, match="知识图谱构建失败"):
        await store.ingest_novel_fast(str(novel), rebuild=False)

    assert store.load_novel_content() is None


@pytest.mark.asyncio
async def test_successful_ingest_persists_novel_content(tmp_path, monkeypatch):
    """A successful ingest must persist novel content (导入完成)."""
    from novelvideo.cognee.store import CogneeStore
    text = "第一章\n春深不见旧门红，内容内容内容。\n"
    novel = tmp_path / "novel.txt"
    novel.write_text(text, encoding="utf-8")

    store = object.__new__(CogneeStore)
    store.dataset_name = "test_ds"
    saved: dict[str, str] = {}
    monkeypatch.setattr(
        store, "save_novel_content", lambda content: saved.__setitem__("content", content)
    )
    monkeypatch.setattr(store, "load_novel_content", lambda: saved.get("content"))
    monkeypatch.setattr(store, "_set_cognee_context", lambda *a, **k: None)
    monkeypatch.setattr("novelvideo.cognee.config.init_cognee", lambda *a, **k: None)
    monkeypatch.setenv("LLM_API_KEY", "test-key")

    async def ok_graph(*a, **k):
        return SimpleNamespace(status=_FakeCompletedPipelineStatus())

    monkeypatch.setattr(store, "_run_cognee_pipeline_with_retry", ok_graph)
    monkeypatch.setattr(store, "_dataset_graph_has_nodes", lambda: _async_result(True))
    monkeypatch.setattr(
        store,
        "materialize_graph_preview",
        lambda: _async_result({"nodes": [{"id": "node-1"}], "edges": []}),
    )

    result = await store.ingest_novel_fast(str(novel), rebuild=False)

    assert store.load_novel_content() == text
    assert result["status"] == "graph_ready"


async def _async_result(value):
    return value


@pytest.mark.asyncio
async def test_preview_failure_does_not_mark_ingest_successful(tmp_path, monkeypatch):
    """The persisted preview is part of the public import-success contract."""
    from novelvideo.cognee.store import CogneeStore

    novel = tmp_path / "novel.txt"
    novel.write_text("第一章\n内容内容内容。\n", encoding="utf-8")
    store = object.__new__(CogneeStore)
    store.dataset_name = "test_ds"
    saved: dict[str, str] = {}
    monkeypatch.setattr(
        store, "save_novel_content", lambda content: saved.__setitem__("content", content)
    )
    monkeypatch.setattr(store, "_set_cognee_context", lambda *a, **k: None)
    monkeypatch.setattr("novelvideo.cognee.config.init_cognee", lambda *a, **k: None)
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setattr(
        store,
        "_run_cognee_pipeline_with_retry",
        lambda *a, **k: _async_result(
            SimpleNamespace(status=_FakeCompletedPipelineStatus())
        ),
    )
    monkeypatch.setattr(store, "_dataset_graph_has_nodes", lambda: _async_result(True))

    async def fail_preview():
        raise RuntimeError("Ladybug preview failed")

    monkeypatch.setattr(store, "materialize_graph_preview", fail_preview)

    with pytest.raises(RuntimeError, match="Ladybug preview failed"):
        await store.ingest_novel_fast(str(novel), rebuild=False)

    assert "content" not in saved


@pytest.mark.asyncio
async def test_empty_preview_does_not_mark_ingest_successful(tmp_path, monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    store = object.__new__(CogneeStore)
    store.state_dir = str(tmp_path)
    monkeypatch.setattr(
        store,
        "get_graph_snapshot",
        lambda **_kwargs: _async_result(
            {
                "nodes": [],
                "edges": [],
                "total_nodes": 0,
                "total_edges": 0,
                "truncated": False,
            }
        ),
    )

    with pytest.raises(RuntimeError, match="未读取到任何图谱节点"):
        await store.materialize_graph_preview()


@pytest.mark.asyncio
async def test_empty_graph_is_not_reported_as_success(tmp_path, monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    novel = tmp_path / "source.txt"
    novel.write_text("第一章\n内容内容内容。\n", encoding="utf-8")

    store = object.__new__(CogneeStore)
    store.dataset_name = "test_ds"
    saved: dict[str, str] = {}
    monkeypatch.setattr(
        store, "save_novel_content", lambda content: saved.__setitem__("content", content)
    )
    monkeypatch.setattr(store, "_set_cognee_context", lambda *a, **k: None)
    monkeypatch.setattr("novelvideo.cognee.config.init_cognee", lambda *a, **k: None)
    monkeypatch.setenv("LLM_API_KEY", "test-key")

    async def ok_stage(*a, **k):
        return SimpleNamespace(status=_FakeCompletedPipelineStatus())

    async def empty_graph():
        return False

    monkeypatch.setattr(store, "_run_cognee_pipeline_with_retry", ok_stage)
    monkeypatch.setattr(store, "_dataset_graph_has_nodes", empty_graph)

    with pytest.raises(RuntimeError, match="未生成任何图谱节点"):
        await store.ingest_novel_fast(str(novel), rebuild=False)

    assert "content" not in saved


@pytest.mark.asyncio
async def test_failed_rebuild_invalidates_old_import_but_keeps_upload(
    tmp_path, monkeypatch
):
    from novelvideo.cognee.store import CogneeStore

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    imported_marker = project_dir / "novel.txt"
    imported_marker.write_text("旧小说", encoding="utf-8")
    upload = tmp_path / "uploads" / "new.txt"
    upload.parent.mkdir()
    upload.write_text("第一章\n新小说内容。\n", encoding="utf-8")

    store = object.__new__(CogneeStore)
    store.dataset_name = "test_ds"
    store.project_dir = str(project_dir)
    store.state_dir = str(tmp_path / "state")
    monkeypatch.setattr(store, "_set_cognee_context", lambda *a, **k: None)
    monkeypatch.setattr("novelvideo.cognee.config.init_cognee", lambda *a, **k: None)
    monkeypatch.setenv("LLM_API_KEY", "test-key")

    async def prune():
        assert not imported_marker.exists()
        return None

    async def fail_add(*, stage_name, **kwargs):
        raise RuntimeError(f"{stage_name}失败")

    monkeypatch.setattr(store, "_prune_cognee_only", prune)
    monkeypatch.setattr(store, "_run_cognee_pipeline_with_retry", fail_add)

    with pytest.raises(RuntimeError, match="原文导入失败"):
        await store.ingest_novel_fast(str(upload), rebuild=True)

    assert not imported_marker.exists()
    assert upload.exists()


@pytest.mark.asyncio
async def test_cognee_pipeline_retry_succeeds_after_one_pipeline_error(monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    store = object.__new__(CogneeStore)
    context_calls = 0

    def count_context():
        nonlocal context_calls
        context_calls += 1

    monkeypatch.setattr(store, "_set_cognee_context", count_context)
    results = [
        SimpleNamespace(status=_FakePipelineStatus(), payload="temporary provider error"),
        SimpleNamespace(status=_FakeCompletedPipelineStatus(), payload=None),
    ]
    attempts = 0
    logs: list[str] = []

    async def operation():
        nonlocal attempts
        result = results[attempts]
        attempts += 1
        return result

    await store._run_cognee_pipeline_with_retry(
        stage_name="知识图谱构建",
        operation=operation,
        log=logs.append,
    )

    assert attempts == 2
    assert context_calls == 2
    assert any("知识图谱构建失败，准备重试" in item for item in logs)


@pytest.mark.asyncio
async def test_cognee_pipeline_retry_raises_after_second_pipeline_error(monkeypatch):
    from novelvideo.cognee.store import CogneeStore

    store = object.__new__(CogneeStore)
    context_calls = 0

    def count_context():
        nonlocal context_calls
        context_calls += 1

    monkeypatch.setattr(store, "_set_cognee_context", count_context)
    attempts = 0
    logs: list[str] = []

    async def operation():
        nonlocal attempts
        attempts += 1
        return SimpleNamespace(status=_FakePipelineStatus(), payload=f"provider error {attempts}")

    with pytest.raises(RuntimeError) as exc_info:
        await store._run_cognee_pipeline_with_retry(
            stage_name="知识图谱构建",
            operation=operation,
            log=logs.append,
        )

    assert attempts == 2
    assert context_calls == 2
    assert "provider error 2" in str(exc_info.value)
    assert any("知识图谱构建失败，准备重试" in item for item in logs)
