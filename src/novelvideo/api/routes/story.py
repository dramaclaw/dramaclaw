"""创作阶段（虾本）的通用文档存储。

为什么是「通用文档」而不是给每种产物开一张表/一组路由：创作阶段的产物形态还在变——
故事圣经、创作方案、角色体系、分集目录、分集草稿，往后大概率还要加。给每种都开一套
路由和 schema，等于把还没定型的东西焊死在后端。这里只约定「一个 doc_id 对应一份 JSON」，
**新增一种产物不需要改任何后端代码**，前端换个 doc_id 就行。

存储落在 `state_dir/story/<doc_id>.json`，和项目其它状态同寿命；不进 SQLite 是因为
这些是自由形态的草稿而不是结构化实体，进表反而要跟着形态反复迁移。
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from novelvideo.agents.story_writer import (
    build_episode_agent,
    build_prose_agent,
    render_episode,
)
from novelvideo.api.auth import get_api_user
from novelvideo.i18n_message import lmsg
from novelvideo.project_context import ProjectContext, resolve_project_context

logger = logging.getLogger("novelvideo.api.story")

router = APIRouter()

# doc_id 直接参与文件名,必须挡住路径穿越。只允许小写字母/数字/下划线/连字符。
DOC_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# 单份文档上限。创作稿是文本,1MB 足够放下一集几千字还有富余;放开则等于给了
# 一个不限量的任意 JSON 存储。
MAX_DOC_BYTES = 1024 * 1024


def _error_detail(
    error_code: str,
    message_code: str,
    fallback: str,
    **params: Any,
) -> dict[str, Any]:
    """Keep old string consumers working while giving new clients an i18n key."""
    message = lmsg(message_code, fallback, **params)
    detail: dict[str, Any] = {
        "code": error_code,
        "message": message.text,
        "message_code": message.code,
    }
    if message.params:
        detail["message_params"] = dict(message.params)
    return detail


def _story_dir(ctx: ProjectContext) -> Path:
    return ctx.state_dir / "story"


def _doc_path(ctx: ProjectContext, doc_id: str) -> Path:
    return _story_dir(ctx) / f"{doc_id}.json"


def _validated_doc_id(doc_id: str) -> str:
    if not DOC_ID_RE.match(doc_id):
        raise HTTPException(
            400,
            _error_detail(
                "invalid_doc_id",
                "story.errors.invalidDocId",
                "文档标识不合法",
            ),
        )
    return doc_id


def _read_doc(path: Path) -> dict[str, Any] | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        logger.warning("story doc unreadable: %s", path, exc_info=True)
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        # 坏文件当不存在处理,而不是 500:创作稿丢一份也不该让整个页面打不开。
        logger.warning("story doc is not valid json: %s", path)
        return None
    return payload if isinstance(payload, dict) else None


def _write_doc_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@router.get("/projects/{project}/story/docs", tags=["story"])
async def list_story_docs(project: str, user: dict = Depends(get_api_user)):
    """列出本项目已有的创作文档(不含正文,只有元信息)。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    directory = _story_dir(ctx)
    items: list[dict[str, Any]] = []
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            payload = _read_doc(path)
            if payload is None:
                continue
            items.append(
                {
                    "doc_id": payload.get("doc_id") or path.stem,
                    "revision": payload.get("revision") or 0,
                    "updated_at": payload.get("updated_at") or 0,
                }
            )
    return {"ok": True, "data": items}


@router.get("/projects/{project}/story/docs/{doc_id}", tags=["story"])
async def get_story_doc(project: str, doc_id: str, user: dict = Depends(get_api_user)):
    """读一份创作文档。不存在返回 content=None 而不是 404——
    「还没写」是这个页面的正常初始状态,不该让前端每个面板都去处理一次错误分支。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    payload = _read_doc(_doc_path(ctx, _validated_doc_id(doc_id)))
    if payload is None:
        return {"ok": True, "data": {"doc_id": doc_id, "content": None, "revision": 0, "updated_at": 0}}
    return {"ok": True, "data": payload}


@router.put("/projects/{project}/story/docs/{doc_id}", tags=["story"])
async def put_story_doc(
    project: str,
    doc_id: str,
    body: dict = Body(...),
    user: dict = Depends(get_api_user),
):
    """写一份创作文档。

    `base_revision` 可选:带上就做乐观并发校验(冲突返回 409),不带就直接覆盖。
    做成可选是因为两种写入方式都真实存在——界面上的手工编辑值得防冲突,
    而 AI 生成的整份替换通常就是要覆盖。
    """
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    doc_id = _validated_doc_id(doc_id)
    if "content" not in body:
        raise HTTPException(
            400,
            _error_detail(
                "missing_content",
                "story.errors.missingContent",
                "缺少文档内容",
            ),
        )
    content = body.get("content")
    encoded = json.dumps(content, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_DOC_BYTES:
        raise HTTPException(
            413,
            _error_detail(
                "doc_too_large",
                "story.errors.docTooLarge",
                "文档超出大小上限",
            ),
        )

    path = _doc_path(ctx, doc_id)
    existing = _read_doc(path)
    current_revision = int(existing.get("revision") or 0) if existing else 0
    base_revision = body.get("base_revision")
    if base_revision is not None and int(base_revision) != current_revision:
        raise HTTPException(
            409,
            _error_detail(
                "story_doc_conflict",
                "story.errors.docConflict",
                "文档已被其它地方修改，请刷新后重试",
            )
            | {"revision": current_revision},
        )

    payload = {
        "doc_id": doc_id,
        "content": content,
        "revision": current_revision + 1,
        "updated_at": int(time.time() * 1000),
    }
    _write_doc_atomic(path, payload)
    return {"ok": True, "data": payload}


@router.delete("/projects/{project}/story/docs/{doc_id}", tags=["story"])
async def delete_story_doc(project: str, doc_id: str, user: dict = Depends(get_api_user)):
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    path = _doc_path(ctx, _validated_doc_id(doc_id))
    existed = path.is_file()
    path.unlink(missing_ok=True)
    return {"ok": True, "data": {"deleted": existed}}


# 单次生成的提示词上限。提示词是「约束 + 现有内容」，正常一集也就几千字；
# 超过这个量多半是把整部剧的内容误塞进来了,截断不如直接拒绝,免得烧掉一大笔 token。
MAX_PROMPT_CHARS = 20000


@router.post("/projects/{project}/story/write", tags=["story"])
async def write_story_step(
    project: str,
    body: dict = Body(...),
    user: dict = Depends(get_api_user),
):
    """用配置好的文本模型写某一步的产物。

    提示词由前端组装(`askAssistant.ts` 的 buildStoryPrompt),**约束层只有一处实现**,
    不在后端再写一份——两份迟早会漂。后端负责的是选 agent、调模型、
    以及把单集结果渲染成导入契约格式。

    单集这一路用结构化输出:模型只描述「这一场在哪、什么时辰、内景外景、有谁、说了什么」,
    场次头由 `render_episode()` 拼,所以格式不可能写错。
    """
    await resolve_project_context(user=user, project_id=project, required_role="editor")

    step_id = str(body.get("step_id") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(
            400,
            _error_detail(
                "missing_prompt",
                "story.errors.missingPrompt",
                "缺少提示词",
            ),
        )
    if len(prompt) > MAX_PROMPT_CHARS:
        raise HTTPException(
            413,
            _error_detail(
                "prompt_too_long",
                "story.errors.promptTooLong",
                "提示词超出上限",
            ),
        )

    try:
        if step_id == "episodes":
            episode_number = int(body.get("episode_number") or 1)
            result = await build_episode_agent().run(prompt)
            episode = result.output
            return {
                "ok": True,
                "data": {
                    "title": episode.title,
                    "text": render_episode(episode_number, episode),
                    "scene_count": len(episode.scenes),
                },
            }
        result = await build_prose_agent().run(prompt)
        return {"ok": True, "data": {"title": None, "text": str(result.output or "").strip()}}
    except HTTPException:
        raise
    except Exception as exc:  # 模型侧的失败不该以 500 呈现给用户
        logger.warning("story write failed: %s", exc, exc_info=True)
        raise HTTPException(
            502,
            _error_detail(
                "story_write_failed",
                "story.errors.writeFailedDetail",
                f"模型生成失败：{exc}",
                detail=str(exc),
            ),
        ) from exc
