"""Import for structured_v1 projects: no graph, no embedding, no vector index.

The legacy import spends most of its wall clock inside ``cognee.add`` /
``cognify`` / ``memify``, and every one of those calls goes through the shared
embedding model.  Structured projects need none of it: extraction reads the
source text directly, so import reduces to validating the upload, persisting it,
and recording a deterministic chunk plan for later analysis.

The validation order matches the legacy path deliberately, including the rule
that ``novel.txt`` is written last.  That file is the public "import succeeded"
marker: several routes treat its presence as proof the project is importable,
so it must not appear while the import can still fail.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from novelvideo.i18n_message import MessageLike, lmsg
from novelvideo.story_analysis import chunk_source_text, source_sha256
from novelvideo.utils.document_parsers import load_novel_text

# Bump when the chunking contract changes in a way that invalidates stored chunk
# results — different chunk ids, boundaries or offsets. A run is reused only
# when source text, schema version, this version and the spine template all
# match, so a bump simply starts a fresh plan rather than corrupting an old one.
STRUCTURED_PIPELINE_VERSION = "structured_v1"
STRUCTURED_ANALYSIS_VERSION = "structured_analysis_v2"
STRUCTURED_SCHEMA_VERSION = 1

_PROGRESS = {
    "read": 0.05,
    "validated": 0.25,
    "chunked": 0.60,
    "planned": 0.85,
    "save": 0.95,
    "complete": 1.0,
}


async def ingest_source_text_structured(
    store: Any,
    novel_path: str,
    *,
    spine_template: str | None = None,
    on_progress: Optional[Callable[[float, str], None]] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> dict:
    """Validate, chunk and persist an import without building any graph.

    ``store`` is a SQLiteStore (or anything exposing the same content and
    analysis-run methods).
    """

    def report(progress: float, task: MessageLike) -> None:
        if on_progress:
            on_progress(progress, task)

    def log(message: MessageLike) -> None:
        if on_log:
            on_log(message)

    if not Path(novel_path).exists():
        raise FileNotFoundError(f"文件不存在: {novel_path}")

    report(_PROGRESS["read"], lmsg("tasks.progress.ingest.reading", "读取并校验原文..."))
    log(lmsg("tasks.log.ingest.readingFile", f"读取文件: {novel_path}", path=str(novel_path)))
    content = load_novel_text(novel_path)
    if not content.strip():
        raise ValueError("小说内容为空，无法导入")
    log(
        lmsg(
            "tasks.log.ingest.readComplete",
            f"文件读取完成: {len(content)} 字符",
            charCount=len(content),
        )
    )

    template = str(spine_template or "").strip()
    if template == "drama":
        from novelvideo.utils.screenplay_quality import assess_screenplay_scene_headers

        if assess_screenplay_scene_headers(content).status == "missing":
            raise ValueError("精品剧必须包含场景头，请补充后重新导入")
    report(
        _PROGRESS["validated"],
        lmsg("tasks.progress.ingest.validated", "原文校验完成"),
    )

    report(
        _PROGRESS["chunked"],
        lmsg("tasks.progress.ingest.chunking", "切分原文..."),
    )
    chunks = chunk_source_text(content, template)
    if not chunks:
        raise ValueError("原文切分结果为空，无法分析")
    section_type = chunks[0].section_type
    log(
        lmsg(
            "tasks.log.ingest.chunked",
            f"确定性切分完成: {len(chunks)} 个片段（{section_type}）",
            chunkCount=len(chunks),
            sectionType=section_type,
        )
    )

    report(
        _PROGRESS["planned"],
        lmsg("tasks.progress.ingest.planning", "记录分析计划..."),
    )
    digest = source_sha256(content)
    reused = await store.get_reusable_analysis_run(
        source_sha256=digest,
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_ANALYSIS_VERSION,
        spine_template=template,
    )
    if reused:
        # Identical text analysed by identical code: keep the existing run so a
        # re-import resumes its completed chunks instead of discarding them.
        run_id = str(reused["run_id"])
        log(
            lmsg(
                "tasks.log.ingest.planReused",
                f"复用已有分析计划: {run_id}",
                runId=run_id,
            )
        )
    else:
        run_id = uuid.uuid4().hex
        await store.start_analysis_run(
            run_id=run_id,
            pipeline_version=STRUCTURED_ANALYSIS_VERSION,
            schema_version=STRUCTURED_SCHEMA_VERSION,
            spine_template=template,
            source_sha256=digest,
            source_length=len(content),
            chunks=chunks,
        )
        log(
            lmsg(
                "tasks.log.ingest.planRecorded",
                f"分析计划已记录: {run_id}",
                runId=run_id,
            )
        )

    # novel.txt is the public success marker and therefore lands last.
    report(
        _PROGRESS["save"],
        lmsg("tasks.progress.ingest.saving", "保存导入结果..."),
    )
    store.save_novel_content(content)
    log(lmsg("tasks.log.ingest.sourceSaved", "原文已保存"))

    report(
        _PROGRESS["complete"],
        lmsg("tasks.progress.ingest.complete", "导入完成"),
    )
    return {
        "char_count": len(content),
        "status": "source_ready",
        "pipeline": "structured_v1",
        "run_id": run_id,
        "chunks": len(chunks),
        "section_type": section_type,
    }
