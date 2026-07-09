"""验证 API 路由。"""

import json
import logging
from pathlib import Path
import re
import shutil

from fastapi import APIRouter, Depends

logger = logging.getLogger(__name__)

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import make_sqlite_store_for_context, resolve_project_scope
from novelvideo.ports import get_task_backend
from novelvideo.task_identity import project_task_state_key, task_config_scope

from .consistency_verifier import ConsistencyVerifier
from .continuity_verifier import ContinuityVerifier
from .episode_reviewer import EpisodeReviewer
from .frame_verifier import FrameVerifier
from .image_verifier import ImageVerifier, resolve_verification_scene_context
from .report_formatter import (
    format_color_verify_report,
    format_consistency_report,
    format_episode_overview_report,
    format_verification_report,
    save_verify_report,
)
from .schemas import (
    ColorVerifyRequest,
    CompareRequest,
    ConsistencyVerifyRequest,
    ContinuityRequest,
    SketchEditExecuteRequest,
    ScoreBatchRequest,
    SketchScoreRequest,
    SketchSelectRequest,
    VerifyRequest,
)
from .sketch_color_verifier import verify_episode_sketch_colors
from .sketch_comparer import SketchComparer
from .sketch_edit_execute import resolve_labels_jsonl
from .sketch_edit_label_validation import LabelsValidationError, validate_labels_jsonl
from .sketch_scorer import SketchScorer
from .similarity_detector import detect_similarity
from .utils import find_frame_for_beat, find_sketch_for_beat, load_all_beats

router = APIRouter()


def _safe_output_name(name: str) -> str:
    trimmed = str(name or "").strip()
    if not trimmed:
        return "labels.jsonl"
    candidate = Path(trimmed).name
    if candidate != trimmed:
        raise ValueError("labels_name must be a file name under verify_reports/epXXX")
    if not candidate.endswith(".jsonl"):
        candidate += ".jsonl"
    return candidate


async def _resolve_verification_project(
    project: str,
    user: dict,
    *,
    required_role: str = "viewer",
):
    return await resolve_project_scope(project, user, required_role=required_role)


async def _load_beat_data(store, episode_num: int, beat_num: int) -> dict:
    beats = await store.get_beats_as_dicts(episode_num)
    for beat in beats:
        if int(beat.get("beat_number") or 0) == beat_num:
            return beat
    raise IndexError(f"Beat {beat_num} not found in episode {episode_num}")


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/verify")
async def verify_beat(
    project: str,
    episode_num: int,
    beat_num: int,
    body: VerifyRequest,
    user: dict = Depends(get_api_user),
):
    """验证单个 beat 的草图/首帧是否匹配描述。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("verify_beat: project=%s ep=%d beat=%d type=%s", project, episode_num, beat_num, body.type)
    store = await make_sqlite_store_for_context(resolved.ctx)

    # 1. 读取 beat 数据
    try:
        beat = await _load_beat_data(store, episode_num, beat_num)
    except (FileNotFoundError, IndexError) as e:
        return {"ok": False, "error": str(e)}

    # 2. 找到对应图片
    if body.type == "sketch":
        image_path = find_sketch_for_beat(project_dir, episode_num, beat_num)
    elif body.type == "frame":
        image_path = find_frame_for_beat(project_dir, episode_num, beat_num)
    else:
        return {"ok": False, "error": f"Unsupported verify type: {body.type}"}

    if not image_path:
        return {"ok": False, "error": f"No {body.type} image found for beat {beat_num}"}

    # 路径安全检查
    if not image_path.resolve().is_relative_to(project_dir.resolve()):
        return {"ok": False, "error": "Image path outside project directory"}

    # 3. 加载颜色映射（用于角色动作归属验证）
    color_mapping: dict[str, str] = {}
    scenes = []
    try:
        color_mapping = store.get_sketch_colors(episode_num) or {}
        scenes = await store.list_scenes()
    except Exception:
        pass  # 无颜色映射/场景列表时退化为原有行为

    # 4. 调用验证
    visual_desc = beat.get("visual_description", "")
    named_characters = re.findall(r"\{\{([^}]+)\}\}", visual_desc)
    camera_context = beat.get("keyframe_prompt") or beat.get("video_prompt", "")
    scene_context = resolve_verification_scene_context(
        project_dir,
        beat,
        episode_number=episode_num,
        scenes=scenes,
    )

    verifier = ImageVerifier()
    try:
        result = await verifier.verify_sketch(
            str(image_path),
            visual_desc,
            named_characters,
            scene_context["scene_id"],
            beat.get("time_of_day", ""),
            camera_context,
            color_mapping=color_mapping,
            resolved_scene_name=scene_context["resolved_scene_name"],
            time_baked=scene_context["time_baked"],
            prompt_time_of_day=scene_context["prompt_time_of_day"],
        )
    except Exception as e:
        logger.error("verify_beat failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    # 5. 构建响应数据
    data = {
        **result.model_dump(),
        "beat_number": beat_num,
        "verify_type": body.type,
        "image_path": image_path.relative_to(project_dir).as_posix(),
        "description_used": beat.get("visual_description", ""),
    }

    # 6. 格式化可读报告 + 持久化
    data["report_text"] = format_verification_report(result.model_dump(), beat_num, body.type)
    report_path = save_verify_report(project_dir, episode_num, beat_num, body.type, data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


@router.post("/projects/{project}/episodes/{episode_num}/verify/sketch-edit-execute/start")
async def start_sketch_edit_execute(
    project: str,
    episode_num: int,
    body: SketchEditExecuteRequest = SketchEditExecuteRequest(),
    user: dict = Depends(get_api_user),
):
    """启动 episode 级 sketch edit execute 后台任务。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    project_dir = resolved.project_dir

    try:
        labels_name = _safe_output_name(body.labels_name)
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    try:
        labels_path = resolve_labels_jsonl(project_dir, episode_num, labels_name=labels_name)
        validation = validate_labels_jsonl(labels_path)
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}
    except LabelsValidationError as e:
        return {
            "ok": False,
            "error": str(e),
            "details": e.payload,
        }

    config = {
        "labels_name": labels_path.name,
    }
    scope = task_config_scope("edit_execute", config)

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="sketch_edit_execute",
            queue_kind="sketch",
            episode=episode_num,
            scope=scope,
            payload={
                "episode": episode_num,
                "project_dir": str(project_dir),
                "labels_name": labels_path.name,
            },
        )
        return {
            "ok": True,
            "task_type": "sketch_edit_execute",
            "scope": scope,
            "labels_jsonl": labels_path.relative_to(project_dir).as_posix(),
            "labels_validation": validation,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "sketch_edit_execute",
                ctx.project_id,
                episode_num,
                scope=scope,
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"第 {episode_num} 集 sketch edit execute 任务已进入队列",
        }

    return {
        "ok": False,
        "error": "sketch edit execute 需要 project context",
        "task_type": "sketch_edit_execute",
        "scope": scope,
        "labels_jsonl": labels_path.relative_to(project_dir).as_posix(),
        "labels_validation": validation,
    }


@router.post("/projects/{project}/episodes/{episode_num}/verify/consistency")
async def verify_consistency(
    project: str,
    episode_num: int,
    body: ConsistencyVerifyRequest = ConsistencyVerifyRequest(),
    user: dict = Depends(get_api_user),
):
    """检查整集跨 beat 的角色/服装一致性。支持 verify_type="sketch"(默认) 或 "frame"。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("verify_consistency: project=%s ep=%d type=%s", project, episode_num, body.verify_type)

    store = await make_sqlite_store_for_context(resolved.ctx)
    verifier = ConsistencyVerifier()
    try:
        data = await verifier.verify_consistency(project_dir, episode_num, verify_type=body.verify_type, sqlite_store=store)
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        logger.error("verify_consistency failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    # 报告类型区分
    report_type = "frame_consistency" if body.verify_type == "frame" else "consistency"
    data["report_text"] = format_consistency_report(data, episode_num)
    report_path = save_verify_report(project_dir, episode_num, None, report_type, data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/verify-frame")
async def verify_frame(
    project: str,
    episode_num: int,
    beat_num: int,
    user: dict = Depends(get_api_user),
):
    """验证单个 beat 的首帧渲染质量（对比草图）。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("verify_frame: project=%s ep=%d beat=%d", project, episode_num, beat_num)
    store = await make_sqlite_store_for_context(resolved.ctx)

    # 1. 读取 beat 数据
    try:
        beat = await _load_beat_data(store, episode_num, beat_num)
    except (FileNotFoundError, IndexError) as e:
        return {"ok": False, "error": str(e)}

    # 2. 找到首帧和草图
    frame_path = find_frame_for_beat(project_dir, episode_num, beat_num)
    if not frame_path:
        return {"ok": False, "error": f"No frame image found for beat {beat_num}"}

    sketch_path = find_sketch_for_beat(project_dir, episode_num, beat_num)
    if not sketch_path:
        return {"ok": False, "error": f"No sketch image found for beat {beat_num} (needed for comparison)"}

    # 路径安全检查
    resolved_project = project_dir.resolve()
    if not frame_path.resolve().is_relative_to(resolved_project):
        return {"ok": False, "error": "Frame path outside project directory"}
    if not sketch_path.resolve().is_relative_to(resolved_project):
        return {"ok": False, "error": "Sketch path outside project directory"}

    # 3. 读取项目视觉风格
    project_style = ""
    project_config_path = project_dir / "config.json"
    if project_config_path.exists():
        try:
            config_data = json.loads(project_config_path.read_text(encoding="utf-8"))
            project_style = config_data.get("visual_style", "")
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning("Failed to load config.json for project style: %s", e)

    # 4. 调用验证
    visual_desc = beat.get("visual_description", "")
    verifier = FrameVerifier()
    try:
        result = await verifier.verify_frame(
            str(frame_path),
            str(sketch_path),
            visual_desc,
            project_style,
        )
    except Exception as e:
        logger.error("verify_frame failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    # 5. 构建响应数据
    data = {
        **result.model_dump(),
        "beat_number": beat_num,
        "verify_type": "frame",
        "frame_path": frame_path.relative_to(project_dir).as_posix(),
        "sketch_path": sketch_path.relative_to(project_dir).as_posix(),
        "description_used": visual_desc,
    }

    # 6. 格式化可读报告 + 持久化
    data["report_text"] = format_verification_report(result.model_dump(), beat_num, "frame")
    report_path = save_verify_report(project_dir, episode_num, beat_num, "frame", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


# ══════════════════════════════════════════════════════════════════════════════
# T3: 内容匹配评分
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/score")
async def score_beat(
    project: str,
    episode_num: int,
    beat_num: int,
    body: SketchScoreRequest = SketchScoreRequest(),
    user: dict = Depends(get_api_user),
):
    """T3: 对单个 beat 的草图进行内容匹配评分。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("score_beat: project=%s ep=%d beat=%d", project, episode_num, beat_num)
    store = await make_sqlite_store_for_context(resolved.ctx)

    try:
        beat = await _load_beat_data(store, episode_num, beat_num)
    except (FileNotFoundError, IndexError) as e:
        return {"ok": False, "error": str(e)}

    # 找到草图（支持指定 pool_id）
    if body.pool_id:
        from novelvideo.generators.pool_indexer import load_pool_index

        grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
        pool = load_pool_index(grids_dir)
        if not pool:
            return {"ok": False, "error": "No pool index found"}
        cell_path = pool.get_cell_path(body.pool_id)
        if not cell_path:
            return {"ok": False, "error": f"pool_id {body.pool_id} not found"}
        image_path = grids_dir / cell_path
        if not image_path.exists():
            return {"ok": False, "error": f"Image file not found: {cell_path}"}
    else:
        image_path = find_sketch_for_beat(project_dir, episode_num, beat_num)
        if not image_path:
            return {"ok": False, "error": f"No sketch found for beat {beat_num}"}

    # 路径安全检查
    if not image_path.resolve().is_relative_to(project_dir.resolve()):
        return {"ok": False, "error": "Image path outside project directory"}

    # 加载颜色映射
    color_mapping: dict[str, str] = {}
    try:
        color_mapping = store.get_sketch_colors(episode_num) or {}
    except Exception:
        pass

    scorer = SketchScorer()
    try:
        result = await scorer.score_sketch(
            str(image_path),
            beat.get("visual_description", ""),
            color_mapping=color_mapping,
        )
    except Exception as e:
        logger.error("score_beat failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    data = {
        "beat_number": beat_num,
        "pool_id": body.pool_id or "latest",
        **result.model_dump(),
    }

    report_path = save_verify_report(project_dir, episode_num, beat_num, "score", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


@router.post("/projects/{project}/episodes/{episode_num}/beats/score-batch")
async def score_batch(
    project: str,
    episode_num: int,
    body: ScoreBatchRequest = ScoreBatchRequest(),
    user: dict = Depends(get_api_user),
):
    """T3 批量: 对指定 beat 的所有候选草图打分。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("score_batch: project=%s ep=%d beats=%s", project, episode_num, body.beat_numbers)

    try:
        store = await make_sqlite_store_for_context(resolved.ctx)
        beats = await load_all_beats(project_dir, episode_num, sqlite_store=store)
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}

    color_mapping: dict[str, str] = {}
    try:
        color_mapping = store.get_sketch_colors(episode_num) or {}
    except Exception:
        pass

    from novelvideo.generators.pool_indexer import load_pool_index

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    pool = load_pool_index(grids_dir)
    if not pool:
        return {"ok": False, "error": "No pool index found"}

    target_beats = body.beat_numbers if body.beat_numbers else list(range(1, len(beats) + 1))
    scorer = SketchScorer()
    beat_results = []

    for beat_num in target_beats:
        if beat_num < 1 or beat_num > len(beats):
            continue
        beat = beats[beat_num - 1]
        visual_desc = beat.get("visual_description", "")

        # 获取候选
        if body.score_all_candidates:
            candidates = pool.filter_by_beat_and_type(beat_num, "sketch")
        else:
            candidates = []
            sketch_path = find_sketch_for_beat(project_dir, episode_num, beat_num)
            if sketch_path:
                candidates = [type("Img", (), {"id": "latest", "cell_path": sketch_path.relative_to(grids_dir).as_posix()})()]

        scored = []
        for img in candidates:
            cell_path = grids_dir / img.cell_path if img.cell_path else None
            if not cell_path or not cell_path.exists():
                continue
            try:
                result = await scorer.score_sketch(
                    str(cell_path), visual_desc, color_mapping=color_mapping
                )
                scored.append({
                    "pool_id": img.id,
                    **result.model_dump(),
                })
            except Exception as e:
                logger.warning("Score failed for pool %s beat %d: %s", img.id, beat_num, e)

        beat_results.append({
            "beat_number": beat_num,
            "candidates": scored,
        })

    return {"ok": True, "data": {"beat_results": beat_results}}


# ══════════════════════════════════════════════════════════════════════════════
# T4: 对比选择
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/projects/{project}/episodes/{episode_num}/beats/{beat_num}/compare")
async def compare_beat(
    project: str,
    episode_num: int,
    beat_num: int,
    body: CompareRequest,
    user: dict = Depends(get_api_user),
):
    """T4: 对比多张候选草图，选择最佳。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("compare_beat: project=%s ep=%d beat=%d pools=%s", project, episode_num, beat_num, body.pool_ids)

    if len(body.pool_ids) < 2:
        return {"ok": False, "error": "At least 2 pool_ids required for comparison"}

    store = await make_sqlite_store_for_context(resolved.ctx)
    try:
        beat = await _load_beat_data(store, episode_num, beat_num)
    except (FileNotFoundError, IndexError) as e:
        return {"ok": False, "error": str(e)}

    from novelvideo.generators.pool_indexer import load_pool_index

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    pool = load_pool_index(grids_dir)
    if not pool:
        return {"ok": False, "error": "No pool index found"}

    # 解析候选路径
    candidate_paths: list[tuple[str, str]] = []
    for pool_id in body.pool_ids:
        cell_path = pool.get_cell_path(pool_id)
        if not cell_path:
            return {"ok": False, "error": f"pool_id {pool_id} not found"}
        full_path = grids_dir / cell_path
        if not full_path.exists():
            return {"ok": False, "error": f"Image file not found: {cell_path}"}
        candidate_paths.append((pool_id, str(full_path)))

    # 解析参考图路径
    reference_paths: list[str] = []
    for ref_id in body.reference_pool_ids:
        cell_path = pool.get_cell_path(ref_id)
        if cell_path:
            full_path = grids_dir / cell_path
            if full_path.exists():
                reference_paths.append(str(full_path))

    comparer = SketchComparer()
    try:
        result = await comparer.compare_sketches(
            candidate_paths,
            beat.get("visual_description", ""),
            reference_paths=reference_paths if reference_paths else None,
        )
    except Exception as e:
        logger.error("compare_beat failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    # 映射 selected_index → selected_pool_id
    selected_pool_id = ""
    if 1 <= result.selected_index <= len(body.pool_ids):
        selected_pool_id = body.pool_ids[result.selected_index - 1]

    data = {
        "beat_number": beat_num,
        "selected_pool_id": selected_pool_id,
        "ranking": [r.model_dump() for r in result.ranking],
        "comparison_summary": result.comparison_summary,
    }

    return {"ok": True, "data": data}


# ══════════════════════════════════════════════════════════════════════════════
# T6: 连贯性评估
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/projects/{project}/episodes/{episode_num}/verify/continuity")
async def verify_continuity(
    project: str,
    episode_num: int,
    body: ContinuityRequest = ContinuityRequest(),
    user: dict = Depends(get_api_user),
):
    """T6: 检查相邻 beat 之间的叙事连贯性。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("verify_continuity: project=%s ep=%d range=%s window=%d", project, episode_num, body.beat_range, body.window_size)

    store = await make_sqlite_store_for_context(resolved.ctx)
    verifier = ContinuityVerifier()
    try:
        data = await verifier.verify_continuity(
            project_dir,
            episode_num,
            beat_range=body.beat_range if body.beat_range else None,
            window_size=body.window_size,
            sqlite_store=store,
        )
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        logger.error("verify_continuity failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    report_path = save_verify_report(project_dir, episode_num, None, "continuity", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


# ══════════════════════════════════════════════════════════════════════════════
# T7: 相似度检测
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/projects/{project}/episodes/{episode_num}/verify/similarity")
async def verify_similarity(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """T7: 像素级草图相似度检测（零 LLM 成本）。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("verify_similarity: project=%s ep=%d", project, episode_num)

    store = await make_sqlite_store_for_context(resolved.ctx)
    try:
        result = await detect_similarity(project_dir, episode_num, sqlite_store=store)
    except Exception as e:
        logger.error("verify_similarity failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    data = result.model_dump()
    report_path = save_verify_report(project_dir, episode_num, None, "similarity", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


# ══════════════════════════════════════════════════════════════════════════════
# 编排端点: 一站式草图择优
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/projects/{project}/episodes/{episode_num}/verify/sketch-select")
async def sketch_select(
    project: str,
    episode_num: int,
    body: SketchSelectRequest = SketchSelectRequest(),
    user: dict = Depends(get_api_user),
):
    """编排端点: 一站式草图择优 — 加载候选 → T1/T2 淘汰 → T3 评分 → T4 对比 → 输出选择。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("sketch_select: project=%s ep=%d", project, episode_num)

    # 加载 beats
    try:
        store = await make_sqlite_store_for_context(resolved.ctx)
        beats = await load_all_beats(project_dir, episode_num, sqlite_store=store)
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}

    # 加载 pool index
    from novelvideo.generators.pool_indexer import load_pool_index

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    pool = load_pool_index(grids_dir)
    if not pool:
        return {"ok": False, "error": "No pool index found. Generate sketches first."}

    # 加载颜色映射
    sketch_colors: dict[str, str] = {}
    try:
        sketch_colors = store.get_sketch_colors(episode_num) or {}
    except Exception:
        logger.exception("failed to load sketch_colors from SQLite")

    # 执行编排
    from .sketch_selector import run_sketch_select

    try:
        data = await run_sketch_select(
            project_dir=project_dir,
            episode_num=episode_num,
            beats=beats,
            pool_index=pool,
            sketch_colors=sketch_colors,
            quality_threshold=body.quality_threshold,
            score_gap_for_auto_select=body.score_gap_for_auto_select,
            color_prefilter=body.color_prefilter,
            fact_check=body.fact_check,
        )
    except Exception as e:
        logger.error("sketch_select failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    promoted = 0
    if body.promote_selected:
        sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"
        sketches_dir.mkdir(parents=True, exist_ok=True)
        for br in data.get("beat_results", []):
            if br.get("recommended_action") != "accept":
                continue
            pool_id = br.get("selected_pool_id")
            if not pool_id:
                continue
            cell_path = pool.get_cell_path(pool_id)
            if not cell_path:
                continue
            src = grids_dir / cell_path
            if src.exists():
                dst = sketches_dir / f"beat_{br['beat_number']:02d}.png"
                shutil.copy2(str(src), str(dst))
                promoted += 1
        if promoted:
            logger.info("sketch_select: promoted %d accepted sketches to %s", promoted, sketches_dir)
    data["promoted_count"] = promoted

    report_path = save_verify_report(project_dir, episode_num, None, "sketch_select", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


# ══════════════════════════════════════════════════════════════════════════════
# T8: 全局分镜审片
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/projects/{project}/episodes/{episode_num}/verify/episode-overview")
async def verify_episode_overview(
    project: str,
    episode_num: int,
    user: dict = Depends(get_api_user),
):
    """T8: 导演视角全局分镜审片 — 整集草图拼网格图，一次 LLM 调用评估整体表现。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("verify_episode_overview: project=%s ep=%d", project, episode_num)

    store = await make_sqlite_store_for_context(resolved.ctx)
    reviewer = EpisodeReviewer()
    try:
        data = await reviewer.review_episode(project_dir, episode_num, sqlite_store=store)
    except (FileNotFoundError, ValueError) as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        logger.error("verify_episode_overview failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    data["report_text"] = format_episode_overview_report(data, episode_num)
    report_path = save_verify_report(project_dir, episode_num, None, "episode_overview", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}


@router.post("/projects/{project}/episodes/{episode_num}/verify/sketch-colors")
async def verify_sketch_colors(
    project: str,
    episode_num: int,
    body: ColorVerifyRequest = ColorVerifyRequest(),
    user: dict = Depends(get_api_user),
):
    """Step 12.4: 草图颜色交叉验证 — 检测草图中角色颜色是否与剧本预期一致。"""
    resolved = await _resolve_verification_project(project, user, required_role="viewer")
    project_dir = resolved.project_dir
    logger.info("verify_sketch_colors: project=%s ep=%d", project, episode_num)

    # 1. 加载 beats
    try:
        store = await make_sqlite_store_for_context(resolved.ctx)
        beats = await load_all_beats(project_dir, episode_num, sqlite_store=store)
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        logger.error("verify_sketch_colors: failed to load beats: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    # 2. 加载 sketch_colors
    sketch_colors: dict[str, str] = {}
    try:
        sketch_colors = store.get_sketch_colors(episode_num) or {}
    except Exception:
        logger.exception("failed to load sketch_colors from SQLite")

    if not sketch_colors:
        return {"ok": False, "error": "No sketch_colors found. Run Step 12.3 (assign-colors) first."}

    # 3. 执行验证
    try:
        result = verify_episode_sketch_colors(
            project_dir,
            episode_num,
            beats,
            sketch_colors,
            missing_threshold=body.missing_threshold,
            extra_threshold=body.extra_threshold,
        )
    except Exception as e:
        logger.error("verify_sketch_colors failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}

    # 4. 格式化报告 + 持久化
    data = result.model_dump()
    data["report_text"] = format_color_verify_report(data, episode_num)
    report_path = save_verify_report(project_dir, episode_num, None, "sketch_colors", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()

    return {"ok": True, "data": data}
