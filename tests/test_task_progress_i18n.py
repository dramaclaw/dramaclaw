# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""后端进度/日志文案的 i18n 载荷。

后端仍然写中文（当兜底），同时把 i18n code/params 带出来，前端按
`t(code, {defaultValue: text})` 渲染。这里钉住载荷形状和那条最容易踩的
「纯字符串必须清掉上一条 code」的规则。
"""

import json

from novelvideo.i18n_message import (
    has_localizable_log,
    lmsg,
    log_entry_payload,
    log_entry_text,
    log_lines_text,
    message_payload,
    message_text,
)
from novelvideo.task_state import TaskState, TaskStateManager


def _manager() -> TaskStateManager:
    # _apply_progress_message 只碰传进来的 state，不需要真的建库。
    return TaskStateManager.__new__(TaskStateManager)


def _state() -> TaskState:
    return TaskState(task_id="t1", task_type="ingest_fast")


def test_localizable_message_carries_code_and_params():
    msg = lmsg("tasks.log.ingest.readingFile", "读取文件: /a.docx", path="/a.docx")
    assert message_text(msg) == "读取文件: /a.docx"
    assert message_payload(msg) == {
        "code": "tasks.log.ingest.readingFile",
        "params": {"path": "/a.docx"},
    }
    # 直接当字符串用（f-string、日志拼接）也还是那句中文。
    assert f"{msg}" == "读取文件: /a.docx"


def test_plain_string_has_no_payload():
    assert message_text("任务已开始") == "任务已开始"
    assert message_payload("任务已开始") is None
    assert log_entry_payload("任务已开始") == "任务已开始"


def test_progress_update_persists_text_and_code():
    state = _state()
    msg = lmsg("tasks.progress.ingest.reading", "读取并校验原文...")
    _manager()._apply_progress_message(state, msg, [msg])

    # 中文照旧落在原列里，老客户端不受影响。
    assert state.current_task == "读取并校验原文..."
    assert state.metadata["current_task_message"] == {
        "code": "tasks.progress.ingest.reading"
    }
    assert state.logs == [
        {"text": "读取并校验原文...", "code": "tasks.progress.ingest.reading"}
    ]


def test_plain_string_update_clears_the_previous_code():
    """这是最容易错的一条：不清就会拿旧 code 去翻新中文。"""
    state = _state()
    _manager()._apply_progress_message(
        state, lmsg("tasks.progress.ingest.reading", "读取并校验原文..."), None
    )
    # 下一次更新来自还没迁移的调用点，只有中文。
    _manager()._apply_progress_message(state, "任务已开始", None)

    assert state.current_task == "任务已开始"
    assert state.metadata["current_task_message"] is None


def test_merge_logs_dedupes_overlapping_tails_across_mixed_shapes():
    state = _state()
    msg = lmsg("tasks.log.ingest.sourceSaved", "原文已保存")
    _manager()._apply_progress_message(state, None, [msg, "任务已开始"])
    # worker 重发了尾部那一段，加一条新的。
    _manager()._apply_progress_message(state, None, ["任务已开始", "任务已完成"])

    assert state.logs == [
        {"text": "原文已保存", "code": "tasks.log.ingest.sourceSaved"},
        "任务已开始",
        "任务已完成",
    ]


def test_state_stays_json_serializable_after_a_localizable_update():
    """LocalizableMessage 绝不能原样活到存储层。

    EE 的 _pg_state_params 和 CE 的 SQLite 写入都会 json.dumps(state.logs) 和
    json.dumps(state.metadata)。只要有一处忘了转换，任务会在写库时炸
    TypeError: Object of type LocalizableMessage is not JSON serializable，
    而且是任务跑到一半才炸，前端只看到一条没头没尾的红字。
    """
    state = _state()
    _manager()._apply_progress_message(
        state,
        lmsg("tasks.progress.ingest.chunking", "正在切分章节...", chunkCount=3),
        [lmsg("tasks.log.ingest.chunked", "已切分 3 段", chunkCount=3)],
    )

    json.dumps(state.logs)
    json.dumps(state.metadata)
    assert isinstance(state.current_task, str)


def test_stored_logs_flatten_back_to_plain_strings():
    """`logs` 的公开契约是 `string[]`，结构化条目不能从这个字段出去。"""
    entries = [
        "任务已开始",
        {"text": "已切分 3 段", "code": "tasks.log.ingest.chunked", "params": {"chunkCount": 3}},
    ]

    assert log_lines_text(entries) == ["任务已开始", "已切分 3 段"]
    assert log_entry_text("任务已开始") == "任务已开始"
    assert has_localizable_log(entries) is True
    assert has_localizable_log(["任务已开始"]) is False
    # 没有 logs（老行、刚建的任务）时不能炸。
    assert log_lines_text(None) == []
    assert has_localizable_log(None) is False


def test_serialized_task_keeps_logs_as_strings_and_adds_the_i18n_field():
    """滚动发布：新后端 + 老前端不能把日志渲染成 `[object Object]`。

    老前端对 `logs` 只会 `join("\\n")` / 下载成 .log，拿到对象就直接退化。
    结构化那份另走 `logs_i18n`，只有认识它的前端才读。
    """
    from novelvideo.api.routes.tasks import _serialize_task

    task = TaskState(
        task_id="t1",
        task_type="ingest_fast",
        project_id="proj_123",
        episode=0,
        status="running",
        logs=[
            "任务已开始",
            {"text": "已切分 3 段", "code": "tasks.log.ingest.chunked", "params": {"chunkCount": 3}},
        ],
    )

    payload = _serialize_task(task)

    assert payload["logs"] == ["任务已开始", "已切分 3 段"]
    assert all(isinstance(line, str) for line in payload["logs"])
    assert payload["logs_i18n"][1]["code"] == "tasks.log.ingest.chunked"


def test_serialized_task_omits_the_i18n_field_when_nothing_is_localizable():
    """一条 code 都没有时不下发，省得每个任务白挂一份重复日志。"""
    from novelvideo.api.routes.tasks import _serialize_task

    payload = _serialize_task(
        TaskState(
            task_id="t2",
            task_type="ingest_fast",
            project_id="proj_123",
            episode=0,
            status="running",
            logs=["任务已开始"],
        )
    )

    assert payload["logs"] == ["任务已开始"]
    assert "logs_i18n" not in payload
