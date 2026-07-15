from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.routes.freezone import (
    FREEZONE_DEFAULT_IMAGE_MODEL,
    _build_erase_prompt,
    _build_scene_360_prompt,
    _build_template_edit_prompt,
    _infer_scene_id_from_master_path,
    _merge_restored_preset_canvas,
    _resolve_freezone_image_provider,
    _resolve_outpaint_aspect_ratio,
    _split_provider_and_model,
    _template_edit_aspect_ratio,
)
from novelvideo.api.schemas import CanvasPayload, PresetCanvasRequest, PushRequest
from novelvideo.config import NEWAPI_IMAGE_MODEL, OPENAI_IMAGE_MODEL
from novelvideo.freezone.presets import (
    build_canvas_payload_from_context,
    canvas_id_for_preset,
    preset_key_for_request,
)
from novelvideo.freezone.route_helpers import build_camera_prompt as _build_camera_prompt
from novelvideo.freezone.skill_registry import (
    SKILL_SCHEMA_VERSION,
    CanvasGraphPatch,
    SkillRunOutput,
    SkillRunRequest,
    get_skill,
    list_skills,
)
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.limits import ProjectUserTaskLimitExceeded
from novelvideo.task_state import get_task_manager


def _project_ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_freezone",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=True,
    )


def _write_image(path: Path, size: tuple[int, int] = (120, 80), mode: str = "RGBA") -> None:
    image = Image.new(mode, size, (255, 0, 0, 255))
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


class _FakeBeatStore:
    def __init__(self) -> None:
        self.updated_scene_refs: list[dict] = []

    async def get_beats_as_dicts(self, episode: int) -> list[dict]:
        assert episode == 1
        return [
            {
                "episode_number": 1,
                "beat_number": 2,
                "scene_ref": {"scene_id": "兰州拉面馆", "render_anchor_id": "master"},
            }
        ]

    async def update_beat_asset(
        self,
        *,
        episode_number: int,
        beat_number: int,
        scene_ref: dict | None = None,
        **_kwargs,
    ) -> None:
        self.updated_scene_refs.append(
            {
                "episode_number": episode_number,
                "beat_number": beat_number,
                "scene_ref": scene_ref,
            }
        )

    async def close(self) -> None:
        pass


class _FakeContextBeatStore:
    async def get_beats_as_dicts(self, episode: int) -> list[dict]:
        assert episode == 1
        return [
            {
                "episode_number": 1,
                "beat_number": 8,
                "scene_ref": {"name": "兰州拉面馆"},
                "narration_segment": "男青年盯着桌上的账单。",
                "visual_description": "男青年坐在拉面馆木桌前，右手停在碗边。",
                "detected_identities": ["面馆男青年"],
                "detected_props": ["账单"],
            }
        ]


def _patch_freezone_project(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    username: str = "admin",
    project: str = "58",
) -> tuple[Path, Path]:
    project_dir = tmp_path / "project"
    output_dir = tmp_path / "output"
    ctx = _project_ctx(tmp_path)

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, username, project, project_dir, str(output_dir)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    return project_dir, output_dir


def _canvas_state_dir(tmp_path: Path) -> Path:
    return _project_ctx(tmp_path).state_dir


def _write_canvas_with_node(tmp_path: Path, canvas_id: str, node: dict) -> None:
    path = _canvas_state_dir(tmp_path) / "freezone" / "canvases" / f"{canvas_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"canvas_id": canvas_id, "nodes": [node], "edges": []}, ensure_ascii=False),
        encoding="utf-8",
    )


def _patch_celery_edit_enqueue(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict[str, object],
    *,
    task_id: str = "task_edit",
) -> None:
    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs.get("payload") or {})
        captured["task_type"] = kwargs.get("task_type")
        captured["queue_kind"] = kwargs.get("queue_kind")
        captured["episode"] = kwargs.get("episode")
        captured["scope"] = kwargs.get("scope")
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id=task_id),
            backend="celery",
            queue="node.node_a.default",
        )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))


def _patch_limit_exceeded_enqueue(
    monkeypatch: pytest.MonkeyPatch,
    *,
    queue_kind: str,
) -> None:
    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        raise ProjectUserTaskLimitExceeded(
            project_id=_ctx.project_id,
            requester_user_id=_ctx.requester_user_id,
            queue_kind=str(kwargs.get("queue_kind") or queue_kind),
            limit=1,
            active=1,
        )

    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))


def _override_api_user(app: FastAPI, dependency) -> None:
    for route in app.routes:
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        for dep in dependant.dependencies:
            if getattr(dep.call, "__name__", "") == "get_api_user":
                app.dependency_overrides[dep.call] = dependency


def _patch_freezone_endpoint_globals(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    for route in app.routes:
        endpoint = getattr(route, "endpoint", None)
        if getattr(endpoint, "__name__", "") != "freezone_video_omni_gen":
            continue
        monkeypatch.setitem(
            endpoint.__globals__,
            "_resolve_freezone_project",
            freezone_routes._resolve_freezone_project,
        )
        monkeypatch.setitem(
            endpoint.__globals__,
            "get_task_backend",
            freezone_routes.get_task_backend,
        )


def _patch_runtime_error_enqueue(
    monkeypatch: pytest.MonkeyPatch,
    message: str = "broker unavailable",
) -> None:
    async def fake_enqueue_project_task(_ctx: ProjectContext, **_kwargs):
        raise RuntimeError(message)

    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))


@pytest.mark.asyncio
async def test_freezone_omni_video_limit_exception_bubbles_to_global_handler(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)
    _patch_limit_exceeded_enqueue(monkeypatch, queue_kind="video")

    with pytest.raises(ProjectUserTaskLimitExceeded) as exc:
        await freezone_routes.freezone_video_omni_gen(
            project="58",
            body=freezone_routes.FreezoneVideoOmniGenRequest(prompt="雨夜街头，人物缓慢回头。"),
            user={"username": "admin"},
        )

    assert exc.value.queue_kind == "video"


@pytest.mark.asyncio
async def test_freezone_image_edit_limit_exception_bubbles_to_global_handler(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    source = project_dir / "freezone" / "_uploads" / "source.png"
    _write_image(source)
    _patch_limit_exceeded_enqueue(monkeypatch, queue_kind="default")

    with pytest.raises(ProjectUserTaskLimitExceeded) as exc:
        await freezone_routes.freezone_outpaint(
            project="58",
            body=freezone_routes.FreezoneOutpaintRequest(
                source_url="/static/admin/58/freezone/_uploads/source.png",
            ),
            user={"username": "admin"},
        )

    assert exc.value.queue_kind == "default"


@pytest.mark.asyncio
async def test_freezone_reverse_prompt_limit_exception_bubbles_to_global_handler(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    source = project_dir / "freezone" / "_uploads" / "source.png"
    _write_image(source)
    _patch_limit_exceeded_enqueue(monkeypatch, queue_kind="default")

    with pytest.raises(ProjectUserTaskLimitExceeded) as exc:
        await freezone_routes.freezone_image_reverse_prompt(
            project="58",
            body=freezone_routes.FreezoneImageReversePromptRequest(
                source_url="/static/admin/58/freezone/_uploads/source.png",
            ),
            user={"username": "admin"},
        )

    assert exc.value.queue_kind == "default"


@pytest.mark.asyncio
async def test_freezone_video_omni_gen_rejects_happyhorse_model(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as exc:
        await freezone_routes.freezone_video_omni_gen(
            project="58",
            body=freezone_routes.FreezoneVideoOmniGenRequest(
                prompt="雨夜街头，人物缓慢回头。",
                model="newapi_happyhorse-1.0",
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 400
    assert "HappyHorse video does not support omni reference mode" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_freezone_video_start_runtime_error_is_logged(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)
    _patch_runtime_error_enqueue(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        await freezone_routes.freezone_video_omni_gen(
            project="58",
            body=freezone_routes.FreezoneVideoOmniGenRequest(prompt="雨夜街头，人物缓慢回头。"),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 503
    assert "failed to start freezone omni video gen task" in caplog.text
    assert "broker unavailable" in caplog.text


def test_infer_scene_id_from_master_path_uses_scene_folder(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    source = project_dir / "assets" / "scenes" / "小区" / "master.png"
    _write_image(source)

    assert _infer_scene_id_from_master_path(source, project_dir) == "小区"


def test_build_scene_360_prompt_contains_scene_and_projection_rules() -> None:
    prompt = _build_scene_360_prompt("小区")

    assert "scene `小区`" in prompt
    assert "2:1 panorama" in prompt
    assert "Left and right edges must connect seamlessly" in prompt


def test_freezone_ai_staging_prop_endpoint_returns_ai_prop(monkeypatch, tmp_path: Path) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict[str, object] = {}

    async def fake_run_ai_staging_prop(request: dict) -> dict:
        captured.update(request)
        return {
            "ok": True,
            "prop": {
                "prop_id": "horse_mount",
                "name": "可骑的马",
                "marker_color": "#7c3aed",
                "shape_hint": "quadruped_mount",
                "scale": [1.4, 1.25, 2.2],
                "position": [1, 0, 2],
            },
        }

    monkeypatch.setattr(freezone_routes, "_run_ai_staging_prop", fake_run_ai_staging_prop)
    app = FastAPI()
    app.include_router(freezone_routes.router, prefix="/api/v1")
    app.dependency_overrides[freezone_routes.get_api_user] = lambda: {"username": "admin"}
    client = TestClient(app)

    response = client.post(
        "/api/v1/projects/58/freezone/ai-staging-prop",
        json={
            "scene_id": "面馆",
            "user_hint": "让男青年骑一匹马",
            "crosshair_target": {"position": [1, 0, 2]},
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["prop"]["shape_hint"] == "quadruped_mount"
    assert captured["user_hint"] == "让男青年骑一匹马"


def test_episode_preset_key_uses_episode_scope() -> None:
    assert preset_key_for_request(scope="episode", episode=1) == "episode:ep001"


def test_canvas_id_for_preset_is_stable_without_timestamp() -> None:
    first = canvas_id_for_preset("asset:character:林昭::")
    second = canvas_id_for_preset("asset:character:林昭::")

    assert first == second
    assert "20" not in first[-16:]


def test_restore_preset_canvas_preserves_side_candidates() -> None:
    restored = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {
                    "preset_managed": True,
                    "mainline_role": "context",
                    "mainline_context": [{"kind": "beat", "projectId": "p"}],
                },
            },
            {
                "id": "workflow_beat_to_sketch",
                "data": {"preset_managed": True, "workflow_kind": "mainline"},
            },
        ],
        "edges": [
            {
                "id": "preset_edge",
                "source": "context_beat",
                "target": "workflow_beat_to_sketch",
            }
        ],
        "viewport": None,
    }
    existing = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {
                    "preset_managed": True,
                    "mainline_role": "context",
                    "mainline_context": [{"kind": "beat", "projectId": "p", "stale": True}],
                },
            },
            {
                "id": "old_workflow",
                "data": {"preset_managed": True, "workflow_kind": "mainline"},
            },
            {
                "id": "candidate_1",
                "data": {
                    "displayName": "草图候选",
                    "mainline_context": [
                        {
                            "kind": "sketch",
                            "projectId": "p",
                            "role": "sketch_candidate",
                        }
                    ],
                },
            },
            {
                "id": "free_upload",
                "data": {"displayName": "自由上传"},
            },
        ],
        "edges": [
            {"id": "old_preset_edge", "source": "context_beat", "target": "old_workflow"},
            {
                "id": "candidate_binding",
                "source": "candidate_1",
                "target": "context_beat",
                "data": {"edgeKind": "candidate_binding", "role": "sketch_candidate"},
            },
            {"id": "free_edge", "source": "free_upload", "target": "candidate_1"},
        ],
        "viewport": {"x": 12, "y": 34, "zoom": 0.8},
    }

    merged = _merge_restored_preset_canvas(restored, existing)

    assert {node["id"] for node in merged["nodes"]} == {
        "context_beat",
        "workflow_beat_to_sketch",
        "candidate_1",
        "free_upload",
    }
    assert {edge["id"] for edge in merged["edges"]} == {
        "preset_edge",
        "candidate_binding",
        "free_edge",
    }
    assert merged["viewport"] == {"x": 12, "y": 34, "zoom": 0.8}


def test_restore_preset_canvas_drops_stale_edge_between_two_preset_managed_nodes() -> None:
    """preset-managed 节点之间的 edge 归 preset 管。如果 preset 改了方向 / 删了边
    (例如 Phase 1c 把 scene_360 workflow → viewer 反向),旧 edge 不能被
    merge 残留下来,否则画布上新旧 edge 共存,出现 X 形交叉。
    """
    restored = {
        "nodes": [
            {
                "id": "workflow_a",
                "data": {"preset_managed": True, "workflow_kind": "mainline_slot"},
            },
            {
                "id": "viewer_b",
                "data": {"preset_managed": True, "workflow_kind": "mainline_slot"},
            },
        ],
        "edges": [
            # 新方向: workflow_a → viewer_b
            {"id": "edge_workflow_a_to_viewer_b", "source": "workflow_a", "target": "viewer_b"},
        ],
        "viewport": None,
    }
    existing = {
        "nodes": [
            {
                "id": "workflow_a",
                "data": {"preset_managed": True, "workflow_kind": "mainline_slot"},
            },
            {
                "id": "viewer_b",
                "data": {"preset_managed": True, "workflow_kind": "mainline_slot"},
            },
        ],
        "edges": [
            # 旧方向: viewer_b → workflow_a (Phase 1c 之前的方向)
            {"id": "edge_viewer_b_to_workflow_a", "source": "viewer_b", "target": "workflow_a"},
        ],
        "viewport": None,
    }
    merged = _merge_restored_preset_canvas(restored, existing)
    edges_by_pair = {(e["source"], e["target"]) for e in merged["edges"]}
    assert ("workflow_a", "viewer_b") in edges_by_pair, "新方向 edge 必须保留"
    assert ("viewer_b", "workflow_a") not in edges_by_pair, (
        "旧方向 edge (两端都 preset-managed) 必须被 preset 重建过程丢掉,"
        "否则画布上出现 X 形重复连线 (用户实际遇到的 bug)"
    )


def test_restore_preset_canvas_drops_stale_prompt_to_viewer_edge() -> None:
    """preset-emitted prompt 节点 (有 __freezone_source.kind=scene_prompt 等)
    也算 preset-managed。Phase 1d 把 scene 360 prompt 从连 pano viewer 改成连
    workflow trigger,旧的 prompt → viewer 边必须被 merge 清掉。

    覆盖用户报的实际 bug: \"提示词还连着 360 viewer\"。
    """
    restored = {
        "nodes": [
            {
                "id": "prompt_scene_foo",
                "type": "textAnnotationNode",
                "data": {
                    "preset_managed": True,
                    "__freezone_source": {
                        "kind": "scene_prompt",
                        "role": "scene_generation_prompt",
                    },
                },
            },
            {
                "id": "workflow_scene_foo_360",
                "data": {"preset_managed": True, "workflow_kind": "mainline_slot"},
            },
            {
                "id": "ref_scene_director_pano_360_1",
                "data": {
                    "preset_managed": True,
                    "workflow_kind": "mainline_slot",  # viewer 节点也算 mainline_slot
                },
            },
        ],
        "edges": [
            # 新方向: prompt → workflow trigger
            {
                "id": "edge_prompt_to_workflow",
                "source": "prompt_scene_foo",
                "target": "workflow_scene_foo_360",
            },
        ],
        "viewport": None,
    }
    existing = {
        "nodes": [
            {
                "id": "prompt_scene_foo",
                "type": "textAnnotationNode",
                "data": {
                    "preset_managed": True,
                    "__freezone_source": {
                        "kind": "scene_prompt",
                        "role": "scene_generation_prompt",
                    },
                },
            },
            {
                "id": "ref_scene_director_pano_360_1",
                "data": {"preset_managed": True, "workflow_kind": "mainline_slot"},
            },
        ],
        "edges": [
            # 旧方向 (Phase 1d 之前): prompt → pano viewer
            {
                "id": "edge_prompt_to_viewer",
                "source": "prompt_scene_foo",
                "target": "ref_scene_director_pano_360_1",
            },
        ],
        "viewport": None,
    }
    merged = _merge_restored_preset_canvas(restored, existing)
    edges_by_pair = {(e["source"], e["target"]) for e in merged["edges"]}
    assert ("prompt_scene_foo", "workflow_scene_foo_360") in edges_by_pair, "新方向必须保留"
    assert ("prompt_scene_foo", "ref_scene_director_pano_360_1") not in edges_by_pair, (
        "旧 prompt → viewer 边必须被丢 (两端都 preset-managed:prompt 通过 __freezone_source.kind, "
        "viewer 通过 workflow_kind:mainline_slot)"
    )


def test_restore_preset_canvas_drops_stale_workflow_triggers_with_output_role() -> None:
    """Stale mainline workflow trigger nodes must be filtered, even though they
    carry output_candidate_role (which declares what kind of candidate they
    spawn). Regression: pre-2026-05-26 the candidate-context check ran before
    the workflow_kind check in `_is_preset_managed_canvas_node`, so a stale
    `workflow_beat_to_sketch` (output_candidate_role=sketch_candidate) was
    mis-classified as a generated candidate result and survived the restore,
    polluting the beat canvas with workflows no longer in the preset.
    """
    restored = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {
                    "preset_managed": True,
                    "mainline_role": "context",
                    "mainline_context": [{"kind": "beat", "projectId": "p"}],
                },
            },
            {
                "id": "workflow_selected_background_to_sketch",
                "data": {
                    "preset_managed": True,
                    "workflow_kind": "mainline",
                    "output_candidate_role": "sketch_candidate",
                },
            },
        ],
        "edges": [],
        "viewport": None,
    }
    existing = {
        "nodes": [
            {
                "id": "workflow_beat_to_sketch",  # old preset, removed in 2026-05 swap
                "data": {
                    "preset_managed": True,
                    "workflow_kind": "mainline",
                    "output_candidate_role": "sketch_candidate",
                },
            },
            {
                "id": "workflow_sketch_to_frame",  # old preset, removed in 2026-05 swap
                "data": {
                    "preset_managed": True,
                    "workflow_kind": "mainline",
                    "output_candidate_role": "frame_candidate",
                },
            },
        ],
        "edges": [],
        "viewport": None,
    }

    merged = _merge_restored_preset_canvas(restored, existing)
    assert {node["id"] for node in merged["nodes"]} == {
        "context_beat",
        "workflow_selected_background_to_sketch",
    }


@pytest.mark.asyncio
async def test_create_episode_preset_canvas_writes_v2_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)

    result = await freezone_routes.create_canvas_from_preset(
        project="proj_freezone",
        body=PresetCanvasRequest(scope="episode", episode=1),
        user={"username": "admin", "id": "owner_1"},
    )

    canvas_id = result["data"]["canvas_id"]
    state_dir = _canvas_state_dir(tmp_path)
    saved = json.loads(
        (state_dir / "freezone" / "canvases" / f"{canvas_id}.json").read_text(encoding="utf-8")
    )
    assert result["data"]["reused"] is False
    assert saved["schema_version"] == 2
    assert saved["project_id"] == "proj_freezone"
    assert saved["canvas_scope"] == "episode"
    assert saved["episode"] == 1
    assert saved["beat"] is None
    assert saved["metadata"]["preset"]["preset_key"] == "episode:ep001"
    assert saved["metadata"]["preset"]["scope"] == "episode"
    assert isinstance(saved["metadata"]["preset"]["facts_signature"], str)
    assert saved["metadata"]["default_push_target"] == {"kind": "manual", "episode": 1}


@pytest.mark.asyncio
async def test_create_preset_canvas_noops_same_facts_before_revision_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)

    first = await freezone_routes.create_canvas_from_preset(
        project="proj_freezone",
        body=PresetCanvasRequest(scope="episode", episode=1),
        user={"username": "admin", "id": "owner_1"},
    )
    canvas_id = first["data"]["canvas_id"]
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / f"{canvas_id}.json"
    before = json.loads(canvas_file.read_text(encoding="utf-8"))

    second = await freezone_routes.create_canvas_from_preset(
        project="proj_freezone",
        body=PresetCanvasRequest(
            scope="episode",
            episode=1,
            canvas_id=canvas_id,
            overwrite_existing=True,
            base_revision=0,
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    after = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert second["data"]["canvas_id"] == canvas_id
    assert after["revision"] == before["revision"]
    assert after == before
    assert not list((canvas_file.parent / "_history").glob(f"{canvas_id}.rev*.json"))


@pytest.mark.asyncio
async def test_create_preset_canvas_refreshes_when_facts_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)

    first = await freezone_routes.create_canvas_from_preset(
        project="proj_freezone",
        body=PresetCanvasRequest(scope="episode", episode=1),
        user={"username": "admin", "id": "owner_1"},
    )
    canvas_id = first["data"]["canvas_id"]
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / f"{canvas_id}.json"
    before = json.loads(canvas_file.read_text(encoding="utf-8"))
    original_builder = freezone_routes.build_canvas_payload_from_context

    def changed_builder(*args, **kwargs):
        payload = original_builder(*args, **kwargs)
        payload.setdefault("nodes", []).append(
            {
                "id": "preset_fact_changed",
                "type": "textNode",
                "data": {
                    "displayName": "changed preset fact",
                    "preset_managed": True,
                },
            }
        )
        return payload

    monkeypatch.setattr(freezone_routes, "build_canvas_payload_from_context", changed_builder)

    second = await freezone_routes.create_canvas_from_preset(
        project="proj_freezone",
        body=PresetCanvasRequest(
            scope="episode",
            episode=1,
            canvas_id=canvas_id,
            overwrite_existing=True,
            base_revision=before["revision"],
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    after = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert second["data"]["canvas_id"] == canvas_id
    assert after["revision"] == before["revision"] + 1
    assert (
        after["metadata"]["preset"]["facts_signature"]
        != before["metadata"]["preset"]["facts_signature"]
    )
    assert any(node.get("id") == "preset_fact_changed" for node in after["nodes"])
    assert list(
        (canvas_file.parent / "_history").glob(f"{canvas_id}.rev{before['revision']}.*.json")
    )


@pytest.mark.asyncio
async def test_create_preset_canvas_overwrite_backs_up_existing_canvas(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "episode_canvas.json"
    canvas_file.parent.mkdir(parents=True)
    original = {
        "schema_version": 2,
        "canvas_id": "episode_canvas",
        "project_id": "proj_freezone",
        "canvas_scope": "episode",
        "revision": 7,
        "nodes": [{"id": "side_experiment", "type": "imageGenNode"}],
        "edges": [],
        "metadata": {"preset": {"scope": "episode", "episode": 1}},
    }
    canvas_file.write_text(json.dumps(original), encoding="utf-8")

    result = await freezone_routes.create_canvas_from_preset(
        project="proj_freezone",
        body=PresetCanvasRequest(
            scope="episode",
            episode=1,
            canvas_id="episode_canvas",
            overwrite_existing=True,
            base_revision=7,
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    assert result["data"]["canvas_id"] == "episode_canvas"
    history_files = list((canvas_file.parent / "_history").glob("episode_canvas.rev7.*.json"))
    assert len(history_files) == 1
    assert json.loads(history_files[0].read_text(encoding="utf-8")) == original
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 8
    events = _read_canvas_events(state_dir, "episode_canvas")
    assert events[-1]["event_type"] == "canvas.preset_emitted"
    assert events[-1]["payload"]["backup_path"].endswith(history_files[0].name)


@pytest.mark.asyncio
async def test_create_preset_canvas_overwrite_rejects_stale_base_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "episode_canvas.json"
    canvas_file.parent.mkdir(parents=True)
    original = {
        "schema_version": 2,
        "canvas_id": "episode_canvas",
        "project_id": "proj_freezone",
        "canvas_scope": "episode",
        "revision": 7,
        "nodes": [{"id": "side_experiment", "type": "imageGenNode"}],
        "edges": [],
        "metadata": {"preset": {"scope": "episode", "episode": 1}},
    }
    canvas_file.write_text(json.dumps(original), encoding="utf-8")

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.create_canvas_from_preset(
            project="proj_freezone",
            body=PresetCanvasRequest(
                scope="episode",
                episode=1,
                canvas_id="episode_canvas",
                overwrite_existing=True,
                base_revision=6,
            ),
            user={"username": "admin", "id": "owner_1"},
        )

    assert exc.value.status_code == 409
    assert json.loads(canvas_file.read_text(encoding="utf-8")) == original
    events = _read_canvas_events(state_dir, "episode_canvas")
    assert events[-1]["event_type"] == "canvas.preset_refresh.conflict"
    assert events[-1]["payload"]["base_revision"] == 6


@pytest.mark.asyncio
async def test_create_preset_canvas_overwrite_rejects_mismatched_preset_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "episode_canvas.json"
    canvas_file.parent.mkdir(parents=True)
    original = {
        "schema_version": 2,
        "canvas_id": "episode_canvas",
        "project_id": "proj_freezone",
        "canvas_scope": "episode",
        "revision": 7,
        "nodes": [{"id": "other_preset_node", "type": "imageGenNode"}],
        "edges": [],
        "metadata": {
            "preset": {
                "scope": "episode",
                "episode": 2,
                "preset_key": "episode:ep002",
            }
        },
    }
    canvas_file.write_text(json.dumps(original), encoding="utf-8")

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.create_canvas_from_preset(
            project="proj_freezone",
            body=PresetCanvasRequest(
                scope="episode",
                episode=1,
                canvas_id="episode_canvas",
                overwrite_existing=True,
                base_revision=7,
            ),
            user={"username": "admin", "id": "owner_1"},
        )

    assert exc.value.status_code == 400
    assert json.loads(canvas_file.read_text(encoding="utf-8")) == original


@pytest.mark.asyncio
async def test_freezone_push_can_commit_selected_background_to_beat(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    source = project_dir / "freezone" / "_outputs" / "edit" / "bg.png"
    _write_image(source, size=(320, 180))
    store = _FakeBeatStore()

    async def fake_make_store(_ctx):
        return store

    monkeypatch.setattr(
        freezone_routes,
        "make_sqlite_store_for_context",
        fake_make_store,
    )

    result = await freezone_routes.freezone_push(
        project="proj_freezone",
        body=PushRequest(
            source_url="freezone/_outputs/edit/bg.png",
            target={"kind": "selected_background", "episode": 1, "beat": 2},
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    target = (
        project_dir / "director_control_frames" / "ep001" / "beat_02" / "selected_background.png"
    )
    assert target.exists()
    assert result["data"]["target_path"] == str(target)
    assert store.updated_scene_refs == [
        {
            "episode_number": 1,
            "beat_number": 2,
            "scene_ref": {
                "scene_id": "兰州拉面馆",
                "render_anchor_id": "selected_background",
                "render_anchor_source_id": "freezone_commit",
            },
        }
    ]


@pytest.mark.asyncio
async def test_freezone_push_can_commit_beat_audio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    source = project_dir / "freezone" / "_outputs" / "audio_speech" / "candidate.mp3"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"candidate-audio")

    result = await freezone_routes.freezone_push(
        project="proj_freezone",
        body=PushRequest(
            source_url="freezone/_outputs/audio_speech/candidate.mp3",
            target={"kind": "beat_audio", "episode": 1, "beat": 2},
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    target = project_dir / "audio" / "ep001" / "beat_02.mp3"
    assert target.read_bytes() == b"candidate-audio"
    assert result["data"]["target_path"] == str(target)


def test_resolve_outpaint_aspect_ratio_supports_original(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    _write_image(source, size=(320, 180))

    assert _resolve_outpaint_aspect_ratio(source, "original") == "16:9"
    assert _resolve_outpaint_aspect_ratio(source, "16:9") == "16:9"


def test_resolve_outpaint_aspect_ratio_reduces_to_supported_ratio(tmp_path: Path) -> None:
    source = tmp_path / "portrait.png"
    _write_image(source, size=(1080, 1920))

    assert _resolve_outpaint_aspect_ratio(source, "original") == "9:16"


def test_template_edit_aspect_ratio_maps_modes() -> None:
    assert _template_edit_aspect_ratio("multi_camera_nine_grid") == "original"
    assert _template_edit_aspect_ratio("story_pitch_four_grid") == "original"
    assert _template_edit_aspect_ratio("character_face_three_view") == "3:2"
    assert _template_edit_aspect_ratio("storyboard_25_grid") == "original"
    assert _template_edit_aspect_ratio("cinematic_light_correction") == "original"


@pytest.mark.asyncio
async def test_put_canvas_soft_upgrades_legacy_canvas_with_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "nodes": [{"id": "old"}],
                "edges": [],
                "viewport": None,
                "metadata": {"preset": {"scope": "beat", "episode": 1, "beat": 2}},
            }
        ),
        encoding="utf-8",
    )

    result = await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(nodes=[{"id": "new"}], edges=[], metadata={"shotMetadata": {}}),
        user={"username": "admin", "id": "owner_1"},
    )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert result["data"]["revision"] == 1
    assert saved["schema_version"] == 2
    assert saved["canvas_id"] == "default"
    assert saved["project_id"] == "proj_freezone"
    assert saved["canvas_scope"] == "beat"
    assert saved["revision"] == 1
    assert saved["metadata"]["preset"]["scope"] == "beat"
    assert saved["metadata"]["shotMetadata"] == {}
    assert saved["nodes"] == [{"id": "new"}]
    events = _read_canvas_events(state_dir, "default")
    assert events[-1]["schema_version"] == "canvas_event.v1"
    assert events[-1]["event_type"] == "canvas.saved"
    assert events[-1]["actor"] == {"kind": "user", "id": "owner_1", "username": "admin"}
    assert events[-1]["payload"]["revision"] == 1
    assert events[-1]["payload"]["node_count"] == 1
    assert events[-1]["payload"]["edge_count"] == 0
    assert events[-1]["payload"]["backup_path"].startswith("freezone/canvases/_history/")


@pytest.mark.asyncio
async def test_put_canvas_backs_up_previous_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    original = {
        "schema_version": 2,
        "canvas_id": "default",
        "project_id": "proj_freezone",
        "canvas_scope": "default",
        "revision": 3,
        "nodes": [{"id": "old"}],
        "edges": [{"id": "old_edge"}],
        "metadata": {"kept": True},
    }
    canvas_file.write_text(json.dumps(original), encoding="utf-8")

    result = await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(
            nodes=[{"id": "new"}],
            edges=[],
            metadata={},
            base_revision=3,
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    assert result["data"]["revision"] == 4
    history_files = list((canvas_file.parent / "_history").glob("default.rev3.*.json"))
    assert len(history_files) == 1
    assert json.loads(history_files[0].read_text(encoding="utf-8")) == original
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 4
    assert saved["nodes"] == [{"id": "new"}]
    events = _read_canvas_events(state_dir, "default")
    assert events[-1]["payload"]["backup_path"].endswith(history_files[0].name)


@pytest.mark.asyncio
async def test_put_canvas_prunes_stale_frame_identity_edges_from_beat_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "beat_canvas.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "beat_canvas",
                "project_id": "proj_freezone",
                "canvas_scope": "beat",
                "revision": 3,
                "nodes": [],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )
    nodes = [
        {
            "id": "context_beat",
            "type": "beatContextNode",
            "data": {
                "beat_edit_fields": {
                    "detected_identities": ["女鬼_白衣时期", "秋菊_中年时期"],
                    "detected_props": ["小衣服"],
                },
            },
        },
        {
            "id": "skill_frame_from_context",
            "type": "skillNode",
            "data": {"skill_id": "freezone.frame_from_context"},
        },
        {
            "id": "ref_kept_identity_1",
            "type": "imageGenNode",
            "data": {
                "__freezone_source": {
                    "kind": "identity",
                    "role": "character_identity",
                    "meta": {"identity_id": "女鬼_白衣时期"},
                }
            },
        },
        {
            "id": "ref_kept_identity_2",
            "type": "imageGenNode",
            "data": {
                "__freezone_source": {
                    "kind": "identity",
                    "role": "character_identity",
                    "meta": {"identity_id": "秋菊_中年时期"},
                }
            },
        },
        {"id": "ref_removed_identity_1", "type": "imageGenNode", "data": {}},
        {"id": "ref_removed_identity_2", "type": "imageGenNode", "data": {}},
        {"id": "ref_kept_prop", "type": "imageGenNode", "data": {}},
        {"id": "ref_removed_prop", "type": "imageGenNode", "data": {}},
    ]
    edges = [
        {
            "id": "edge_context",
            "source": "context_beat",
            "target": "skill_frame_from_context",
            "data": {"edgeKind": "role_binding", "role": "beat_context"},
        },
        {
            "id": "edge_identity_keep_1",
            "source": "ref_kept_identity_1",
            "target": "skill_frame_from_context",
            "targetHandle": "identity:女鬼_白衣时期",
            "data": {
                "edgeKind": "role_binding",
                "role": "identity",
                "reference_target": {"kind": "identity", "identity_id": "女鬼_白衣时期"},
            },
        },
        {
            "id": "edge_identity_remove_1",
            "source": "ref_removed_identity_1",
            "target": "skill_frame_from_context",
            "targetHandle": "identity:明珠_青年时期",
            "data": {
                "edgeKind": "role_binding",
                "role": "identity",
                "reference_target": {"kind": "identity", "identity_id": "明珠_青年时期"},
            },
        },
        {
            "id": "edge_identity_remove_2",
            "source": "ref_removed_identity_2",
            "target": "skill_frame_from_context",
            "targetHandle": "identity:春柳_青年时期",
            "data": {
                "edgeKind": "role_binding",
                "role": "identity",
                "reference_target": {"kind": "identity", "identity_id": "春柳_青年时期"},
            },
        },
        {
            "id": "edge_prop_keep",
            "source": "ref_kept_prop",
            "target": "skill_frame_from_context",
            "targetHandle": "prop:小衣服",
            "data": {
                "edgeKind": "role_binding",
                "role": "prop",
                "reference_target": {"kind": "prop", "prop_id": "小衣服"},
            },
        },
        {
            "id": "edge_prop_remove",
            "source": "ref_removed_prop",
            "target": "skill_frame_from_context",
            "targetHandle": "prop:账本",
            "data": {
                "edgeKind": "role_binding",
                "role": "prop",
                "reference_target": {"kind": "prop", "prop_id": "账本"},
            },
        },
    ]

    await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="beat_canvas",
        body=CanvasPayload(nodes=nodes, edges=edges, metadata={}, base_revision=3),
        user={"username": "admin", "id": "owner_1"},
    )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    edge_ids = {edge["id"] for edge in saved["edges"]}
    assert "edge_identity_keep_1" in edge_ids
    assert "edge_prop_keep" in edge_ids
    assert "edge_identity_remove_1" not in edge_ids
    assert "edge_identity_remove_2" not in edge_ids
    assert "edge_prop_remove" not in edge_ids
    identity_handles = {
        edge.get("targetHandle")
        for edge in saved["edges"]
        if (edge.get("data") or {}).get("role") == "identity"
    }
    assert identity_handles == {"identity:女鬼_白衣时期", "identity:秋菊_中年时期"}


@pytest.mark.asyncio
async def test_get_canvas_refreshes_beat_preset_from_mainline_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "beat_canvas.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "beat_canvas",
                "project_id": "proj_freezone",
                "canvas_scope": "beat",
                "revision": 7,
                "nodes": [
                    {"id": "context_beat", "data": {"preset_managed": True}},
                    {
                        "id": "skill_frame_from_context",
                        "data": {
                            "preset_managed": True,
                            "skill_id": "freezone.frame_from_context",
                        },
                    },
                    {"id": "user_note", "data": {"user_spawned": True}},
                ],
                "edges": [
                    {
                        "id": "edge_identity_old_only",
                        "source": "ref_character_identity_1",
                        "target": "skill_frame_from_context",
                        "targetHandle": "identity:沈月白_青年时期",
                        "data": {
                            "edgeKind": "role_binding",
                            "role": "identity",
                            "reference_target": {
                                "kind": "identity",
                                "identity_id": "沈月白_青年时期",
                            },
                        },
                    }
                ],
                "metadata": {
                    "preset": {
                        "scope": "beat",
                        "episode": 1,
                        "beat": 27,
                        "primary_slot": "frame",
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    async def fake_make_sqlite_store_for_context(_ctx):
        return SimpleNamespace(close=lambda: None)

    async def fake_build_beat_preset_context(**kwargs):
        assert kwargs["episode"] == 1
        assert kwargs["beat"] == 27
        assert kwargs["primary_slot"] == "frame"
        return {"scope": "beat", "episode": 1, "beat": 27}

    def fake_build_canvas_payload_from_context(**_kwargs):
        return {
            "nodes": [
                {"id": "context_beat", "data": {"preset_managed": True}},
                {
                    "id": "skill_frame_from_context",
                    "data": {
                        "preset_managed": True,
                        "skill_id": "freezone.frame_from_context",
                    },
                },
                {
                    "id": "ref_character_identity_1",
                    "data": {"preset_managed": True},
                },
                {
                    "id": "ref_character_identity_2",
                    "data": {"preset_managed": True},
                },
            ],
            "edges": [
                {
                    "id": "edge_identity_1",
                    "source": "ref_character_identity_1",
                    "target": "skill_frame_from_context",
                    "targetHandle": "identity:沈月白_青年时期",
                    "data": {
                        "edgeKind": "role_binding",
                        "role": "identity",
                        "reference_target": {
                            "kind": "identity",
                            "identity_id": "沈月白_青年时期",
                        },
                    },
                },
                {
                    "id": "edge_identity_2",
                    "source": "ref_character_identity_2",
                    "target": "skill_frame_from_context",
                    "targetHandle": "identity:陆辰_青年时期",
                    "data": {
                        "edgeKind": "role_binding",
                        "role": "identity",
                        "reference_target": {
                            "kind": "identity",
                            "identity_id": "陆辰_青年时期",
                        },
                    },
                },
            ],
            "viewport": None,
            "metadata": {"preset": {"scope": "beat"}},
        }

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(
        freezone_routes, "build_beat_preset_context", fake_build_beat_preset_context
    )
    monkeypatch.setattr(
        freezone_routes, "build_canvas_payload_from_context", fake_build_canvas_payload_from_context
    )

    result = await freezone_routes.get_canvas(
        project="proj_freezone",
        canvas_id="beat_canvas",
        user={"username": "admin", "id": "owner_1"},
    )

    data = result["data"]
    assert data["revision"] == 7
    assert {node["id"] for node in data["nodes"]} == {
        "context_beat",
        "skill_frame_from_context",
        "ref_character_identity_1",
        "ref_character_identity_2",
        "user_note",
    }
    identity_handles = {
        edge.get("targetHandle")
        for edge in data["edges"]
        if (edge.get("data") or {}).get("role") == "identity"
    }
    assert identity_handles == {"identity:沈月白_青年时期", "identity:陆辰_青年时期"}


@pytest.mark.asyncio
async def test_put_canvas_idempotent_retry_does_not_write_again(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 3,
                "nodes": [{"id": "old_1"}, {"id": "old_2"}],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )

    first = await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(
            nodes=[{"id": "new"}],
            edges=[],
            metadata={},
            base_revision=3,
            client_save_id="save-1",
        ),
        user={"username": "admin", "id": "owner_1"},
    )
    second = await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(
            nodes=[{"id": "new"}],
            edges=[],
            metadata={},
            base_revision=3,
            client_save_id="save-1",
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    assert first["data"] == second["data"]
    assert first["data"]["revision"] == 4
    assert first["data"]["client_save_id"] == "save-1"
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["nodes"] == [{"id": "new"}]
    assert len(list((canvas_file.parent / "_history").glob("default.rev3.*.json"))) == 1
    events = _read_canvas_events(state_dir, "default")
    assert [event["event_type"] for event in events].count("canvas.saved") == 1


@pytest.mark.asyncio
async def test_put_canvas_rejects_reused_idempotency_key_with_different_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 3,
                "nodes": [{"id": "old"}],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )

    await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(
            nodes=[{"id": "new"}],
            edges=[],
            metadata={},
            base_revision=3,
            client_save_id="save-1",
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="default",
            body=CanvasPayload(
                nodes=[{"id": "different"}],
                edges=[],
                metadata={},
                base_revision=3,
                client_save_id="save-1",
            ),
            user={"username": "admin", "id": "owner_1"},
        )

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "canvas_idempotency_conflict"
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["nodes"] == [{"id": "new"}]


@pytest.mark.asyncio
async def test_put_canvas_rejects_dangerous_empty_autosave(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 3,
                "nodes": [{"id": "old_1"}, {"id": "old_2"}],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="default",
            body=CanvasPayload(nodes=[], edges=[], metadata={}, base_revision=3),
            user={"username": "admin", "id": "owner_1"},
        )

    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "dangerous_empty_canvas_overwrite"
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["nodes"] == [{"id": "old_1"}, {"id": "old_2"}]
    assert not list((canvas_file.parent / "_history").glob("default.rev3.*.json"))


@pytest.mark.asyncio
async def test_put_canvas_saves_oversized_payload_with_warning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    monkeypatch.setattr(freezone_routes.canvas_store, "CANVAS_PAYLOAD_SIZE_LIMIT_BYTES", 512)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "revision": 3,
                "nodes": [{"id": "old"}],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )

    result = await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(
            nodes=[
                {
                    "id": "big",
                    "type": "exportImageNode",
                    "data": {
                        "imageUrl": "data:image/png;base64," + ("a" * 1024),
                        "previewImageUrl": "data:image/png;base64," + ("b" * 256),
                    },
                }
            ],
            edges=[],
            base_revision=3,
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    assert result["data"]["saved"] is True
    assert result["data"]["revision"] == 4
    warning = result["data"]["warning"]
    assert warning["code"] == "canvas_payload_large"
    assert warning["limit_kb"] == 1
    assert warning["actual_kb"] >= 1
    assert any(row["path"] == "nodes[0].data.imageUrl" for row in warning["top_fields"])
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 4
    assert saved["nodes"][0]["id"] == "big"
    assert len(list((canvas_file.parent / "_history").glob("default.rev3.*.json"))) == 1


@pytest.mark.asyncio
async def test_put_canvas_rejects_autosave_deleting_last_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "revision": 3,
                "nodes": [{"id": "last"}],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="default",
            body=CanvasPayload(nodes=[], edges=[], base_revision=3),
            user={"username": "admin", "id": "owner_1"},
        )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "dangerous_empty_canvas_overwrite"
    assert saved["revision"] == 3
    assert saved["nodes"] == [{"id": "last"}]
    assert not list((canvas_file.parent / "_history").glob("default.rev*.json"))


@pytest.mark.asyncio
async def test_put_canvas_allows_manual_clear_with_flag(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "revision": 3,
                "nodes": [{"id": "old"}],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )

    result = await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(
            nodes=[],
            edges=[],
            base_revision=3,
            save_source="manual_clear",
            allow_empty_overwrite=True,
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert result["data"]["revision"] == 4
    assert saved["nodes"] == []
    assert saved["save_source"] == "manual_clear"


@pytest.mark.asyncio
async def test_canvas_history_list_and_restore(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 1,
                "nodes": [{"id": "old"}],
                "edges": [],
                "metadata": {"preset": {"scope": "default"}},
            }
        ),
        encoding="utf-8",
    )
    await freezone_routes.put_canvas(
        project="proj_freezone",
        canvas_id="default",
        body=CanvasPayload(
            nodes=[{"id": "new"}],
            edges=[],
            metadata={},
            base_revision=1,
        ),
        user={"username": "admin", "id": "owner_1"},
    )

    history = await freezone_routes.list_canvas_history(
        project="proj_freezone",
        canvas_id="default",
        user={"username": "admin", "id": "owner_1"},
    )
    assert len(history["data"]) == 1
    assert history["data"][0]["revision"] == 1
    assert history["data"][0]["node_count"] == 1

    restored = await freezone_routes.restore_canvas_history(
        project="proj_freezone",
        canvas_id="default",
        body={"history_id": history["data"][0]["history_id"], "base_revision": 2},
        user={"username": "admin", "id": "owner_1"},
    )

    assert restored["data"]["revision"] == 3
    assert restored["data"]["restored_from_revision"] == 1
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 3
    assert saved["nodes"] == [{"id": "old"}]
    assert len(list((canvas_file.parent / "_history").glob("default.rev2.*.json"))) == 1
    events = _read_canvas_events(state_dir, "default")
    assert events[-1]["event_type"] == "canvas.restored"


@pytest.mark.asyncio
async def test_delete_canvas_soft_deletes_and_hides_tombstone_from_list(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "experiment.json"
    canvas_file.parent.mkdir(parents=True)
    original = {
        "schema_version": 2,
        "canvas_id": "experiment",
        "project_id": "proj_freezone",
        "canvas_scope": "asset",
        "revision": 4,
        "nodes": [{"id": "to_delete"}],
        "edges": [],
        "metadata": {},
    }
    canvas_file.write_text(json.dumps(original), encoding="utf-8")

    deleted = await freezone_routes.delete_canvas(
        project="proj_freezone",
        canvas_id="experiment",
        user={"username": "admin", "id": "owner_1"},
    )

    assert deleted["data"]["deleted"] is True
    assert not canvas_file.exists()
    tombstone = canvas_file.with_name("experiment.deleted.json")
    assert tombstone.exists()
    tombstone_payload = json.loads(tombstone.read_text(encoding="utf-8"))
    assert tombstone_payload["schema_version"] == "canvas_tombstone.v1"
    assert tombstone_payload["canvas_id"] == "experiment"
    assert tombstone_payload["revision"] == 4
    deleted_files = list((canvas_file.parent / "_deleted" / "experiment").glob("*_rev4.json"))
    assert len(deleted_files) == 1
    assert json.loads(deleted_files[0].read_text(encoding="utf-8")) == original

    listed = await freezone_routes.list_canvases(
        project="proj_freezone",
        user={"username": "admin", "id": "owner_1"},
    )
    assert [item["id"] for item in listed["data"]] == ["default"]
    events = _read_canvas_events(state_dir, "experiment")
    assert events[-1]["event_type"] == "canvas.deleted"
    assert events[-1]["payload"]["deleted_path"].endswith(deleted_files[0].name)


@pytest.mark.asyncio
async def test_delete_default_canvas_soft_deletes_without_recreating(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 2,
                "nodes": [{"id": "legacy"}],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )

    deleted = await freezone_routes.delete_canvas(
        project="proj_freezone",
        canvas_id="default",
        user={"username": "admin", "id": "owner_1"},
    )

    assert deleted["data"]["deleted"] is True
    assert not canvas_file.exists()
    assert canvas_file.with_name("default.deleted.json").exists()

    listed = await freezone_routes.list_canvases(
        project="proj_freezone",
        user={"username": "admin", "id": "owner_1"},
    )
    assert [item["id"] for item in listed["data"]] == []


@pytest.mark.asyncio
async def test_put_canvas_lock_busy_returns_503(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    def fake_save_canvas(*_args, **_kwargs):
        raise freezone_routes.CanvasLockBusy("default")

    monkeypatch.setattr(freezone_routes.canvas_store, "save_canvas", fake_save_canvas)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="default",
            body=CanvasPayload(nodes=[], edges=[]),
            user={"username": "admin", "id": "owner_1"},
        )

    assert exc.value.status_code == 503
    assert exc.value.headers == {"Retry-After": "1"}
    assert exc.value.detail == {"code": "canvas_lock_busy", "canvas_id": "default"}


@pytest.mark.asyncio
async def test_get_canvas_does_not_fallback_to_output_canvas(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    legacy_canvas = output_project_dir / "freezone" / "canvases" / "default.json"
    legacy_canvas.parent.mkdir(parents=True)
    legacy_canvas.write_text(
        json.dumps({"nodes": [{"id": "legacy_output"}], "edges": []}),
        encoding="utf-8",
    )

    result = await freezone_routes.get_canvas(
        project="proj_freezone",
        canvas_id="default",
        user={"username": "admin", "id": "owner_1"},
    )

    data = result["data"]
    assert data["schema_version"] == 2
    assert data["canvas_id"] == "default"
    assert data["project_id"] == "proj_freezone"
    assert data["canvas_scope"] == "default"
    assert data["revision"] == 1
    assert data["nodes"] == []
    assert data["edges"] == []
    assert data["viewport"] is None
    assert data["metadata"] is None
    assert (_canvas_state_dir(tmp_path) / "freezone" / "canvases" / "default.json").exists()


@pytest.mark.asyncio
async def test_init_freezone_creates_default_canvas(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)

    first = await freezone_routes.init_freezone(
        project="proj_freezone",
        user={"username": "admin", "id": "owner_1"},
    )
    second = await freezone_routes.init_freezone(
        project="proj_freezone",
        user={"username": "admin", "id": "owner_1"},
    )

    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert first["data"]["default_canvas"]["created"] is True
    assert second["data"]["default_canvas"]["created"] is False
    assert saved["canvas_id"] == "default"
    assert saved["canvas_scope"] == "default"
    assert saved["revision"] == 1
    assert saved["nodes"] == []
    assert saved["edges"] == []
    assert not list((canvas_file.parent / "_history").glob("default.rev*.json"))


@pytest.mark.asyncio
async def test_put_canvas_rejects_stale_base_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    state_dir = _canvas_state_dir(tmp_path)
    canvas_file = state_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 3,
                "nodes": [],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="default",
            body=CanvasPayload(
                nodes=[{"id": "stale"}],
                edges=[],
                metadata={},
                base_revision=2,
            ),
            user={"username": "admin", "id": "owner_1"},
        )

    assert exc.value.status_code == 409
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 3
    assert saved["nodes"] == []
    assert _template_edit_aspect_ratio("image_projection_after_3s") == "original"


def test_multi_camera_prompt_uses_libtv_director_coverage_labels() -> None:
    prompt = _build_template_edit_prompt(
        freezone_routes.FreezoneTemplateEditRequest(
            source_url="/static/admin/59/freezone/_uploads/source.png",
            mode="multi_camera_nine_grid",
        )
    )

    assert "libtv-style 3x3 director multi-camera contact sheet" in prompt
    assert "Do not add new characters" in prompt
    assert "Each cell must preserve the source image aspect ratio" in prompt
    assert "[KF1 | 3s | ELS]" in prompt
    assert "[KF7 | 1s | ECU]" in prompt
    assert "[KF8 | 2s | High-Angle]" in prompt
    assert "[KF9 | 2s | Low-Angle]" in prompt


def test_story_pitch_four_grid_prompt_preserves_cell_aspect_ratio() -> None:
    prompt = _build_template_edit_prompt(
        freezone_routes.FreezoneTemplateEditRequest(
            source_url="/static/admin/59/freezone/_uploads/source.png",
            mode="story_pitch_four_grid",
        )
    )

    assert "Each cell must preserve the source image aspect ratio" in prompt
    assert "Do not crop each story frame into a different ratio" in prompt
    assert "2x2 grid with thin dividers" in prompt


def test_storyboard_25_grid_prompt_preserves_cell_aspect_ratio() -> None:
    prompt = _build_template_edit_prompt(
        freezone_routes.FreezoneTemplateEditRequest(
            source_url="/static/admin/59/freezone/_uploads/source.png",
            mode="storyboard_25_grid",
        )
    )

    assert "Each cell must preserve the source image aspect ratio" in prompt
    assert "libtv-style 5x5 cinematic storyboard shot sequence" in prompt
    assert "Do not create random variants" in prompt
    assert "Adapt the sequence to the actual source content" in prompt
    assert "Do not invent dialogue, extra characters" in prompt
    assert "visible key action" in prompt
    assert "inserts and extreme close-ups of visible key details" in prompt
    assert "Use OTS only when the source contains" in prompt
    assert "Do not crop each storyboard frame into a different ratio" in prompt
    assert "5x5 grid with thin dividers" in prompt


def test_template_edit_projection_prompt_requires_visible_time_change() -> None:
    prompt = _build_template_edit_prompt(
        freezone_routes.FreezoneTemplateEditRequest(
            source_url="/static/admin/59/freezone/_uploads/source.png",
            mode="image_projection_after_3s",
        )
    )

    assert "libtv-style frame projection 3 seconds later" in prompt
    assert "Preserve the source image aspect ratio" in prompt
    assert "near-duplicate" in prompt
    assert "Within the same frame size" in prompt


def test_split_provider_and_model_accepts_sketch_selection_key() -> None:
    provider, model = _split_provider_and_model(None, "openai_gpt_image2")

    assert provider == "openai"
    assert model == OPENAI_IMAGE_MODEL


def test_split_provider_and_model_accepts_newapi_selection_key() -> None:
    provider, model = _split_provider_and_model(None, "newapi_gpt_image2")

    assert provider == "newapi"
    assert model == NEWAPI_IMAGE_MODEL


def test_freezone_defaults_to_newapi_gpt_image2() -> None:
    assert FREEZONE_DEFAULT_IMAGE_MODEL == "newapi_gpt_image2"
    assert _resolve_freezone_image_provider(None) == "newapi"
    assert _resolve_freezone_image_provider("newapi") == "newapi"


def test_erase_prompt_mentions_masked_region_and_cleanup() -> None:
    prompt = _build_erase_prompt()

    assert "masked region" in prompt
    assert "Remove the content" in prompt
    assert "artifacts" in prompt


@pytest.mark.asyncio
async def test_masked_redraw_uses_default_newapi_model(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "525"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    source = project_dir / "assets" / "characters" / "陈默" / "portrait.png"
    mask = project_dir / "freezone" / "_uploads" / "mask.png"
    _write_image(source, size=(1024, 1024))
    _write_image(mask, size=(1024, 1024))

    captured: dict[str, object] = {}
    _patch_celery_edit_enqueue(monkeypatch, captured)

    body = freezone_routes.FreezoneRedrawRequest(
        source_url="/static/admin/525/assets/characters/陈默/portrait.png",
        mask_url="/static/admin/525/freezone/_uploads/mask.png",
        prompt="",
        aspect_ratio="16:9",
        num_images=1,
        image_size="2K",
        quality="low",
    )

    result = await freezone_routes.freezone_redraw(
        project="01KSEKPTTX43HEF7720SEVMW8Z",
        body=body,
        user={"username": username},
    )

    assert result["ok"] is True
    assert captured["task_type"] == "freezone_mask_edit"
    assert captured["provider"] == "newapi"
    assert captured["model"] == NEWAPI_IMAGE_MODEL
    assert captured["quality"] == "low"


@pytest.mark.asyncio
async def test_mask_edit_job_uses_reference_edit_provider_routing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.freezone.jobs import run_freezone_mask_edit

    project_dir = tmp_path / "project"
    base = project_dir / "base.png"
    mask = project_dir / "mask.png"
    _write_image(base, size=(1024, 1024))
    _write_image(mask, size=(1024, 1024))
    captured: dict[str, object] = {}

    async def fake_generate_reference_edit_image(**kwargs):
        captured.update(kwargs)
        Path(str(kwargs["output_path"])).parent.mkdir(parents=True, exist_ok=True)
        Path(str(kwargs["output_path"])).write_bytes(b"png")

    monkeypatch.setattr(
        "novelvideo.generators.nanobanana_grid.generate_reference_edit_image",
        fake_generate_reference_edit_image,
    )

    out = await run_freezone_mask_edit(
        project_dir=project_dir,
        job_id="job_mask",
        base_path=str(base),
        mask_path=str(mask),
        prompt="erase",
        aspect_ratio="16:9",
        image_size="2K",
        quality="medium",
        provider="newapi",
        model=NEWAPI_IMAGE_MODEL,
    )

    assert out.exists()
    assert captured["reference_images"] == [str(base), str(mask)]
    assert captured["config"]["provider"] == "newapi"
    assert captured["config"]["model"] == NEWAPI_IMAGE_MODEL
    assert "Use Image 2 as the edit mask reference" in captured["prompt"]


def test_camera_prompt_contains_camera_body_lens_focal_and_aperture() -> None:
    camera = freezone_routes.FreezoneImageCameraConfig(
        camera_body="Panavision DXL2",
        lens="Arri Signature Prime",
        focal_length_mm=35,
        aperture="f/4",
    )

    prompt = _build_camera_prompt(camera)

    assert "Panavision DXL2" in prompt
    assert "Arri Signature Prime" in prompt
    assert "35mm" in prompt
    assert "f/4" in prompt


def test_image_style_templates_builtin_count_is_30() -> None:
    data = freezone_routes._get_freezone_image_style_templates()

    assert len(data) == 30
    assert any(item["id"] == "three_oclock_2300" for item in data)


@pytest.mark.asyncio
async def test_freezone_gen_route_passes_output_dir_and_quality(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "58"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    captured: dict[str, object] = {}

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_gen"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_gen")

    result = await freezone_routes.freezone_gen(
        project="proj_freezone",
        body=freezone_routes.FreezoneGenRequest(
            prompt="衣服好看点",
            aspect_ratio="16:9",
            image_size="1K",
            model="newapi_gpt_image2",
            quality="low",
            canvas_id="default",
            node_id="node_gen",
        ),
        user={"username": username},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_gen"
    assert captured["payload"]["project_dir"] == str(project_dir)
    assert captured["payload"]["quality"] == "low"


@pytest.mark.asyncio
async def test_freezone_celery_runner_records_node_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.freezone.history import read_generation_history
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _project_ctx(tmp_path)
    project_dir = ctx.output_dir
    output = project_dir / "freezone" / "_outputs" / "freezone_gen" / "job_123.png"
    _write_image(output)

    async def fake_run_freezone_gen(**_kwargs):
        return output

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr("novelvideo.freezone.jobs.run_freezone_gen", fake_run_freezone_gen)
    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())

    result = await freezone_runner._run_freezone_gen_async(
        {
            "payload": {
                "job_id": "job_123",
                "project_dir": str(project_dir),
                "prompt": "generate",
                "canvas_id": "canvas_a",
                "node_id": "node_gen",
            }
        },
        ctx,
    )

    history = read_generation_history(
        project_dir=project_dir,
        canvas_id="canvas_a",
        node_id="node_gen",
    )
    assert result["generation_history_record"]["node_id"] == "node_gen"
    assert history[-1]["task_type"] == "freezone_gen"
    assert history[-1]["task_key"] == "task:freezone_gen:project:proj_freezone:0:job_123"
    output_url = history[-1]["result"]["output_url"]
    assert output_url.startswith("/static/projects/proj_freezone/")
    assert output_url.split("?", 1)[0].endswith("/freezone/_outputs/freezone_gen/job_123.png")
    json.dumps(result)
    assert result["generation_history_record"]["result"] is not result


@pytest.mark.asyncio
async def test_freezone_celery_text_runner_records_project_node_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.freezone.history import read_generation_history
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _project_ctx(tmp_path)
    project_dir = ctx.output_dir

    async def fake_translate_freezone_text(*, text: str, node_type: str):
        assert text == "你好"
        assert node_type == "text"
        return "hello", "zh", "en"

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(
        "novelvideo.freezone.text_node.translate_freezone_text",
        fake_translate_freezone_text,
    )
    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())

    result = await freezone_runner._run_freezone_text_translate_async(
        {
            "payload": {
                "job_id": "job_text",
                "project_dir": str(project_dir),
                "text": "你好",
                "node_type": "text",
                "canvas_id": "canvas_a",
                "node_id": "node_text",
            }
        },
        ctx,
    )

    history = read_generation_history(
        project_dir=project_dir,
        canvas_id="canvas_a",
        node_id="node_text",
    )
    assert result["generation_history_record"]["node_id"] == "node_text"
    assert history[-1]["task_type"] == "freezone_text_translate"
    assert history[-1]["task_key"] == (
        "task:freezone_text_translate:project:proj_freezone:0:job_text"
    )
    assert history[-1]["result"]["translated_text"] == "hello"


def test_freezone_image_to_3gs_runner_records_project_node_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.freezone.history import read_generation_history
    from novelvideo.task_backend.runners import stage_asset as stage_asset_runner

    ctx = _project_ctx(tmp_path)
    project_dir = ctx.output_dir
    source = project_dir / "freezone" / "_uploads" / "plate.png"
    sog = project_dir / "freezone" / "_outputs" / "freezone_image_to_3gs" / "job_3gs" / "scene.sog"
    _write_image(source)
    sog.parent.mkdir(parents=True, exist_ok=True)
    sog.write_bytes(b"PK\x03\x04sog")

    def fake_run_single_face_sharp(*_args, **_kwargs):
        return {"ply_path": str(sog), "sog_path": str(sog)}

    progress_updates: list[dict] = []

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **kwargs):
            progress_updates.append(kwargs)
            return None

    monkeypatch.setattr(
        "novelvideo.stage_asset_tasks.run_single_face_sharp",
        fake_run_single_face_sharp,
    )
    monkeypatch.setattr(stage_asset_runner, "get_task_manager", lambda: FakeTaskManager())

    result = stage_asset_runner.run_freezone_image_to_3gs(
        {
            "scope": "job_3gs",
            "payload": {
                "job_id": "job_3gs",
                "project_dir": str(project_dir),
                "scene_id": "scene_a",
                "source_path": str(source),
                "source_kind": "master",
                "canvas_id": "canvas_a",
                "node_id": "node_3gs",
            },
        },
        ctx,
    )

    history = read_generation_history(
        project_dir=project_dir,
        canvas_id="canvas_a",
        node_id="node_3gs",
    )
    assert result["generation_history_record"]["node_id"] == "node_3gs"
    assert "result" not in result["generation_history_record"]
    json.dumps(result)
    assert "/scene.sog" in result["output_url"]
    assert "/scene.sog" in result["ply_url"]
    assert "/scene.sog" in result["splat_url"]
    assert "/scene.sog" in result["ply_path"]
    assert result["splat_format"] == "sog"
    assert not result["ply_url"].startswith(str(project_dir))
    assert not result["ply_path"].startswith(str(project_dir))
    assert "local_ply_path" not in result
    assert "artifact_dir" not in result
    assert history[-1]["task_type"] == "freezone_image_to_3gs"
    assert history[-1]["task_key"] == ("task:freezone_image_to_3gs:project:proj_freezone:0:job_3gs")
    assert "/scene.sog" in history[-1]["result"]["output_url"]
    assert "/scene.sog" in history[-1]["result"]["splat_url"]
    assert "/scene.sog" in history[-1]["result"]["ply_path"]
    assert history[-1]["result"]["splat_format"] == "sog"
    assert not history[-1]["result"]["splat_url"].startswith(str(project_dir))
    assert not history[-1]["result"]["ply_path"].startswith(str(project_dir))
    assert all(update.get("progress") < 1.0 for update in progress_updates)


@pytest.mark.asyncio
async def test_freezone_celery_image_jobs_preserve_canvas_node_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = _project_ctx(tmp_path)
    project_dir = ctx.output_dir
    base = project_dir / "freezone" / "_uploads" / "base.png"
    _write_image(base)
    calls: list[dict] = []

    async def fake_enqueue_project_task(ctx_arg, **kwargs):
        calls.append({"ctx": ctx_arg, **kwargs})
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_123"),
            backend="celery",
            queue="node.node_a.default",
        )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_123")

    gen = await freezone_routes._start_or_enqueue_freezone_gen_job(
        ctx=ctx,
        username="admin",
        project="demo",
        project_dir=project_dir,
        output_dir=str(project_dir),
        prompt="generate",
        aspect_ratio="1:1",
        image_size="2K",
        reference_urls=[],
        camera=None,
        style=None,
        provider="newapi",
        model="newapi_gpt_image2",
        quality=None,
        canvas_id="canvas_a",
        node_id="node_gen",
    )
    edit = await freezone_routes._start_or_enqueue_freezone_edit_job(
        ctx=ctx,
        username="admin",
        project="demo",
        project_dir=project_dir,
        output_dir=str(project_dir),
        prompt="edit",
        base_url=f"/static/admin/demo/{base.relative_to(project_dir).as_posix()}",
        extra_reference_urls=[],
        aspect_ratio="original",
        image_size="2K",
        camera=None,
        style=None,
        provider="newapi",
        model="newapi_gpt_image2",
        quality=None,
        canvas_id="canvas_a",
        node_id="node_edit",
    )

    assert gen["data"]["backend"] == "celery"
    assert edit["data"]["backend"] == "celery"
    assert calls[0]["payload"]["canvas_id"] == "canvas_a"
    assert calls[0]["payload"]["node_id"] == "node_gen"
    assert calls[1]["payload"]["canvas_id"] == "canvas_a"
    assert calls[1]["payload"]["node_id"] == "node_edit"


@pytest.mark.asyncio
async def test_freezone_text_job_preserves_canvas_node_context_in_celery_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", ctx.output_dir, str(ctx.output_dir)

    async def fake_enqueue_freezone_background_job(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "data": {"task_key": "task_key"}}
    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_freezone_background_job",
        fake_enqueue_freezone_background_job,
    )
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_text")

    await freezone_routes.freezone_text_translate(
        project="proj_freezone",
        body=freezone_routes.FreezoneTextTranslateRequest(
            text="你好",
            node_type="text",
            canvas_id="canvas_a",
            node_id="node_text",
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "freezone_text_translate"
    assert captured["payload"]["canvas_id"] == "canvas_a"
    assert captured["payload"]["node_id"] == "node_text"


@pytest.mark.asyncio
async def test_sketch_from_context_uses_beat_db_and_routes_to_gen_without_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", ctx.output_dir, str(ctx.output_dir)

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_sketch"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))

    result = await freezone_routes.freezone_sketch_from_context(
        project="proj_freezone",
        body=freezone_routes.FreezoneSketchFromContextRequest(
            episode=1,
            beat=8,
            source_kind="beat",
            canvas_id="canvas_a",
            node_id="node_ctx",
        ),
        user={"username": "admin"},
    )

    assert result["data"]["task_type"] == "sketch_generation"
    assert captured["episode"] == 1
    assert captured["payload"]["config"]["direct_sketch_beats"] is True
    assert captured["payload"]["config"]["beat_numbers"] == [8]
    assert captured["payload"]["canvas_id"] == "canvas_a"
    assert captured["payload"]["node_id"] == "node_ctx"


@pytest.mark.asyncio
async def test_frame_from_context_uses_sketch_as_base_and_optional_background_ref(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", ctx.output_dir, str(ctx.output_dir)

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_frame"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(ctx.output_dir / "freezone" / "sketch.png")
    _write_image(ctx.output_dir / "freezone" / "bg.png")

    result = await freezone_routes.freezone_frame_from_context(
        project="proj_freezone",
        body=freezone_routes.FreezoneFrameFromContextRequest(
            episode=1,
            beat=8,
            sketch_url="/api/v1/projects/proj_freezone/media/freezone/sketch.png",
            background_url="/api/v1/projects/proj_freezone/media/freezone/bg.png",
            canvas_id="canvas_a",
            node_id="node_frame",
        ),
        user={"username": "admin"},
    )

    assert result["data"]["task_type"] == "mainline_frame_from_context"
    assert captured["episode"] == 1
    assert captured["beat_num"] == 8
    assert captured["payload"]["config"]["canvas_sketch_paths"]["8"].endswith(
        "/freezone/sketch.png"
    )
    assert captured["payload"]["config"]["canvas_scene_refs"][0]["image_path"].endswith(
        "/freezone/bg.png"
    )
    assert captured["payload"]["canvas_id"] == "canvas_a"
    assert captured["payload"]["node_id"] == "node_frame"


@pytest.mark.asyncio
async def test_frame_from_context_infers_landscape_from_sketch_and_medium_quality_default(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", ctx.output_dir, str(ctx.output_dir)

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_frame_16_9"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(ctx.output_dir / "freezone" / "sketch.png", size=(1600, 900))

    await freezone_routes.freezone_frame_from_context(
        project="proj_freezone",
        body=freezone_routes.FreezoneFrameFromContextRequest(
            episode=1,
            beat=8,
            aspect_ratio="2:3",
            sketch_url="/api/v1/projects/proj_freezone/media/freezone/sketch.png",
        ),
        user={"username": "admin"},
    )

    assert captured["payload"]["mode_key"] == "1x1_16-9"
    assert captured["payload"]["config"]["mode_key"] == "1x1_16-9"
    assert captured["payload"]["config"]["aspect_ratio"] == "16:9"
    assert captured["payload"]["config"]["image_quality"] == "medium"


@pytest.mark.asyncio
async def test_scene_360_endpoint_caps_mainline_image_size_to_2k(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", ctx.output_dir, str(ctx.output_dir)

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_scene_360"),
            backend="celery",
            queue="node.node_a.world",
        )

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(ctx.output_dir / "assets" / "scenes" / "小区" / "master.png")

    result = await freezone_routes.freezone_scene_360(
        project="proj_freezone",
        body=freezone_routes.FreezoneScene360Request(
            reference_url="/api/v1/projects/proj_freezone/media/assets/scenes/小区/master.png",
            image_size="4K",
            canvas_id="canvas_a",
            node_id="node_scene_360",
            quality="low",
        ),
        user={"username": "admin"},
    )

    assert result["data"]["task_type"] == "stage_asset"
    assert captured["payload"]["scene_name"] == "小区"
    assert captured["payload"]["params"]["image_size"] == "2K"
    assert captured["payload"]["params"]["quality"] == "low"
    assert captured["payload"]["params"]["update_manifest"] is False
    assert captured["payload"]["params"]["artifact_dir"]


def _skill_beat_input() -> dict:
    return {
        "role": "beat_context",
        "node_id": "beat_1_8",
        "node_type": "beatContextNode",
        "beat_context": {"episode": 1, "beat": 8, "scene_id": "兰州拉面馆"},
    }


def _standalone_skill_beat_input() -> dict:
    return {
        "role": "beat_context",
        "node_id": "standalone_beat_context",
        "node_type": "beatContextNode",
        "beat_context": {
            "schema": "beat_context.v1",
            "source": "standalone",
            "title": "自定义 Beat 上下文",
            "visual_description": "雨夜里，{{Kris}}站在便利店门口回头，手里握着[[雨伞]]。",
            "narration_segment": "她终于意识到自己被跟踪了。",
            "scene_id": "便利店门口",
            "detected_identities": ["Kris"],
            "detected_props": ["雨伞"],
            "sketch_colors": {"Kris": "#FF00FF"},
            "prop_marker_colors": {"雨伞": "#B71C1C"},
        },
    }


def test_standalone_beat_context_normalizes_plain_identity_to_mainline_prompt_shape() -> None:
    beat_context = {
        "source": "standalone",
        "visual_description": "{{Kris}}拿着[[雨伞]]。",
        "detected_identities": ["Kris"],
        "sketch_colors": {"Kris": "#FF00FF"},
    }

    prompt_beat = freezone_routes._skill_beat_context_as_prompt_beat(
        SkillRunRequest(
            resolved_inputs=[
                {
                    "role": "beat_context",
                    "node_id": "standalone",
                    "node_type": "beatContextNode",
                    "beat_context": beat_context,
                }
            ]
        ).resolved_inputs[0]
    )
    character_map = freezone_routes._standalone_beat_context_character_map(
        beat_context
    )

    assert prompt_beat["visual_description"] == "{{Kris_Kris}}拿着[[雨伞]]。"
    assert prompt_beat["detected_identities"] == ["Kris_Kris"]
    assert character_map == {
        "Kris": {
            "base_prompt": "Kris",
            "reference_mode": "prompt_only",
            "sketch_color": "#FF00FF",
            "identity_appearances": {"Kris": "Kris"},
            "identity_sketch_colors": {"Kris": "#FF00FF"},
        }
    }


def test_standalone_beat_context_character_map_uses_mainline_identity_suffix_shape() -> None:
    character_map = freezone_routes._standalone_beat_context_character_map(
        {
            "detected_identities": ["陆辰_青年时期"],
            "sketch_colors": {"陆辰_青年时期": "#00FFFF"},
        }
    )

    assert character_map == {
        "陆辰": {
            "base_prompt": "陆辰",
            "reference_mode": "prompt_only",
            "sketch_color": "#00FFFF",
            "identity_appearances": {"青年时期": "陆辰_青年时期"},
            "identity_sketch_colors": {"青年时期": "#00FFFF"},
        }
    }


def _skill_image_input(
    role: str,
    *,
    node_id: str | None = None,
    node_type: str = "imageGenNode",
    image_url: str = "/api/v1/projects/proj_freezone/media/freezone/sketch.png",
    slot_kind: str | None = None,
    origin_skill_id: str | None = None,
) -> dict:
    data = {
        "role": role,
        "node_id": node_id or f"{role}_node",
        "node_type": node_type,
        "image_url": image_url,
    }
    if slot_kind:
        data["slot_target"] = {"kind": slot_kind, "episode": 1, "beat": 8}
    if origin_skill_id:
        data["candidate_origin"] = {
            "skill_id": origin_skill_id,
            "skill_node_id": f"{role}_skill_node",
        }
    return data


def _required_contract_input_for_spec(role: str) -> dict:
    if role == "beat_context":
        return _standalone_skill_beat_input()
    if role == "background":
        return _skill_image_input(
            "background",
            image_url="/api/v1/projects/proj_freezone/media/freezone/background.png",
            slot_kind="selected_background",
        )
    if role == "director_combined":
        return _skill_image_input(
            "director_combined",
            node_type="exportImageNode",
            image_url="/api/v1/projects/proj_freezone/media/freezone/director.png",
            slot_kind="director_combined",
        )
    if role == "sketch":
        return _skill_image_input(
            "sketch",
            image_url="/api/v1/projects/proj_freezone/media/freezone/sketch.png",
            slot_kind="sketch",
        )
    if role == "source_image":
        return _skill_image_input(
            "source_image",
            image_url="/api/v1/projects/proj_freezone/media/freezone/source.png",
            slot_kind="selected_background",
        )
    if role == "frame":
        return _skill_image_input(
            "frame",
            image_url="/api/v1/projects/proj_freezone/media/freezone/frame.png",
            slot_kind="frame",
        )
    raise AssertionError(f"unhandled required skill input role: {role}")


def test_skill_contract_accepts_standalone_beat_context_for_every_beat_context_skill(
    tmp_path: Path,
) -> None:
    ctx = _project_ctx(tmp_path)
    beat_context_skills = [
        skill
        for skill in list_skills()
        if skill.provider in {"freezone_mainline", "agent"}
        and any(spec.role == "beat_context" for spec in skill.inputs)
    ]

    assert {skill.id for skill in beat_context_skills} == {
        "freezone.sketch_from_context",
        "freezone.sketch_from_director_combined",
        "freezone.frame_from_context",
        "freezone.set_selected_background",
        "freezone.set_director_combined",
        "agent.review_frame",
    }

    for skill in beat_context_skills:
        resolved_inputs = [
            _required_contract_input_for_spec(spec.role)
            for spec in skill.inputs
            if spec.required
        ]

        grouped = freezone_routes._group_and_validate_skill_inputs(
            skill,
            SkillRunRequest(resolved_inputs=resolved_inputs).resolved_inputs,
            project="proj_freezone",
            ctx=ctx,
            username="admin",
            project_name="demo",
        )
        output = freezone_routes._skill_output_metadata(
            skill,
            grouped,
            auto_commit=False,
        )

        assert grouped["beat_context"][0].beat_context["source"] == "standalone"
        assert output["slot_target"] is None
        assert output["auto_commit"] is False


def _read_canvas_events(project_dir: Path, canvas_id: str) -> list[dict]:
    path = project_dir / "freezone" / "_canvas_events" / f"{canvas_id}.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_standalone_unified_sketch_prompt_keeps_missing_beat_number_null(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    class FakePromptBuilder:
        def __init__(self, ctx):
            self.ctx = ctx

        def build(self) -> str:
            return "unified prompt"

    def fake_create_prompt_context(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace()

    import novelvideo.generators.prompt_builder as prompt_builder

    monkeypatch.setattr(prompt_builder, "UnifiedPromptBuilder", FakePromptBuilder)
    monkeypatch.setattr(prompt_builder, "create_prompt_context", fake_create_prompt_context)

    result = freezone_routes._standalone_beat_context_unified_sketch_prompt(
        input_item=SkillRunRequest(resolved_inputs=[_standalone_skill_beat_input()]).resolved_inputs[
            0
        ],
        project_dir=tmp_path,
        reference_path=str(tmp_path / "combined.png"),
        reference_role="director_combined",
        aspect_ratio="16:9",
    )

    assert result == "unified prompt"
    assert captured["beats"][0]["episode_number"] is None
    assert captured["beats"][0]["beat_number"] is None


def test_skill_run_output_accepts_graph_patch_contract_stub() -> None:
    output = SkillRunOutput(
        role="planned_canvas_patch",
        media_type="graph_patch",
        node_type="graphPatchNode",
        pushable=False,
        graph_patch={
            "schema_version": "graph_patch.v1",
            "operations": [
                {
                    "op": "add_node",
                    "node": {"id": "skill_generated", "type": "skillNode"},
                },
                {
                    "op": "add_edge",
                    "edge": {"id": "edge_1", "source": "a", "target": "b"},
                },
            ],
            "requires_apply": True,
        },
    )

    assert isinstance(output.graph_patch, CanvasGraphPatch)
    assert output.graph_patch.schema_version == "graph_patch.v1"
    assert output.graph_patch.requires_apply is True
    assert [op.op for op in output.graph_patch.operations] == ["add_node", "add_edge"]


def test_skill_registry_returns_skills_with_providers_and_typed_contracts() -> None:
    skills = list_skills()
    by_id = {skill.id: skill for skill in skills}

    assert set(by_id) == {
        "freezone.sketch_from_context",
        "freezone.sketch_from_director_combined",
        "freezone.frame_from_context",
        "freezone.set_selected_background",
        "freezone.set_director_combined",
        "freezone.scene_360",
        "agent.review_frame",
        "workflow.plan_beat_graph",
    }
    assert by_id["freezone.sketch_from_context"].provider == "freezone_mainline"
    assert by_id["freezone.sketch_from_director_combined"].provider == "freezone_mainline"
    assert by_id["freezone.frame_from_context"].provider == "freezone_mainline"
    assert by_id["freezone.set_selected_background"].provider == "freezone_mainline"
    assert by_id["freezone.set_director_combined"].provider == "freezone_mainline"
    assert by_id["freezone.scene_360"].provider == "freezone_mainline"
    assert by_id["agent.review_frame"].provider == "agent"
    assert by_id["workflow.plan_beat_graph"].provider == "workflow"
    assert all(skill.schema_version == SKILL_SCHEMA_VERSION for skill in skills)
    assert all(
        input_spec.schema_version == SKILL_SCHEMA_VERSION
        for skill in skills
        for input_spec in skill.inputs
    )
    assert all(
        output.schema_version == SKILL_SCHEMA_VERSION
        for skill in skills
        for output in skill.outputs
    )
    assert all(
        "uploadNode" in input_spec.accepts.node_types
        for skill in skills
        for input_spec in skill.inputs
        if "image_url" in input_spec.accepts.has_field
    )
    assert by_id["freezone.sketch_from_context"].capabilities.can_read_project_state is True
    assert by_id["freezone.sketch_from_context"].capabilities.can_propose_canvas_patch is False
    assert by_id["agent.review_frame"].capabilities.can_propose_canvas_patch is False
    assert by_id["agent.review_frame"].capabilities.can_apply_canvas_patch is False
    assert by_id["workflow.plan_beat_graph"].capabilities.can_propose_canvas_patch is True
    assert by_id["workflow.plan_beat_graph"].capabilities.can_apply_canvas_patch is False

    sketch = get_skill("freezone.sketch_from_context")
    assert sketch.parameters["aspect_ratio"]["default"] == "2:3"
    assert sketch.parameters["aspect_ratio"]["options"] == ["2:3", "16:9"]
    sketch_inputs = {item.role: item for item in sketch.inputs}
    assert list(sketch_inputs) == ["beat_context", "background"]
    assert sketch_inputs["beat_context"].required is True
    assert sketch_inputs["beat_context"].cardinality == "single"
    assert sketch_inputs["beat_context"].accepts.node_types == ["beatContextNode"]
    assert sketch_inputs["background"].required is True
    assert sketch_inputs["background"].cardinality == "single"
    assert set(sketch_inputs["background"].accepts.canonical_slot_kinds) >= {
        "selected_background",
        "background_candidate",
    }

    director_sketch = get_skill("freezone.sketch_from_director_combined")
    assert director_sketch.parameters["aspect_ratio"]["default"] == "2:3"
    assert director_sketch.parameters["aspect_ratio"]["options"] == ["2:3", "16:9"]
    director_inputs = {item.role: item for item in director_sketch.inputs}
    assert list(director_inputs) == ["beat_context", "director_combined"]
    assert director_inputs["beat_context"].required is True
    assert director_inputs["director_combined"].required is True
    assert director_inputs["director_combined"].cardinality == "single"
    assert "exportImageNode" in director_inputs["director_combined"].accepts.node_types
    assert director_inputs["director_combined"].accepts.canonical_slot_kinds == [
        "director_combined"
    ]
    assert "freezone.director_combined" in (
        director_inputs["director_combined"].accepts.candidate_origin_skill_ids
    )
    assert sketch.outputs[0].role == "current_sketch_candidate"
    assert sketch.outputs[0].media_type == "image"
    assert sketch.outputs[0].node_type == "imageGenNode"
    assert sketch.outputs[0].pushable is True

    frame = get_skill("freezone.frame_from_context")
    assert "aspect_ratio" not in frame.parameters
    assert frame.parameters["quality"]["default"] == "medium"
    assert frame.parameters["background_reference_mode"]["type"] == "enum"
    assert frame.parameters["background_reference_mode"]["default"] == "material_only"
    assert frame.parameters["background_reference_mode"]["options"] == [
        "material_only",
        "scene_anchor",
    ]
    frame_inputs = {item.role: item for item in frame.inputs}
    assert list(frame_inputs) == ["beat_context", "sketch", "background", "identity", "prop"]
    assert frame_inputs["beat_context"].required is True
    assert frame_inputs["beat_context"].cardinality == "single"
    assert frame_inputs["sketch"].required is True
    assert frame_inputs["sketch"].cardinality == "single"
    assert frame_inputs["background"].required is False
    assert frame_inputs["background"].cardinality == "single"
    assert frame_inputs["identity"].required is False
    assert frame_inputs["identity"].cardinality == "multi"
    assert frame_inputs["prop"].required is False
    assert frame_inputs["prop"].cardinality == "multi"
    assert frame.outputs[0].role == "current_frame_candidate"
    assert frame.outputs[0].media_type == "image"
    assert frame.outputs[0].node_type == "imageGenNode"
    assert frame.outputs[0].pushable is True

    set_background = get_skill("freezone.set_selected_background")
    set_background_inputs = {item.role: item for item in set_background.inputs}
    assert list(set_background_inputs) == ["beat_context", "source_image"]
    assert set_background.display_name == "设为当前背景"
    assert set_background_inputs["beat_context"].required is True
    assert set_background_inputs["source_image"].required is True
    assert set_background_inputs["source_image"].cardinality == "single"
    assert set(set_background_inputs["source_image"].accepts.canonical_slot_kinds) >= {
        "scene_master",
        "scene_reverse_master",
        "director_env_only",
        "selected_background",
    }
    assert set_background.outputs[0].role == "selected_background"
    assert set_background.outputs[0].media_type == "image"
    assert set_background.outputs[0].node_type == "imageGenNode"
    assert set_background.outputs[0].pushable is False

    set_director = get_skill("freezone.set_director_combined")
    set_director_inputs = {item.role: item for item in set_director.inputs}
    assert list(set_director_inputs) == ["beat_context", "source_image"]
    assert set_director.display_name == "设为导演合成图"
    assert set_director_inputs["beat_context"].required is True
    assert set_director_inputs["source_image"].required is True
    assert set_director_inputs["source_image"].cardinality == "single"
    assert set(set_director_inputs["source_image"].accepts.canonical_slot_kinds) >= {
        "director_render",
        "director_combined",
    }
    assert set_director.outputs[0].role == "director_combined"
    assert set_director.outputs[0].media_type == "image"
    assert set_director.outputs[0].node_type == "imageGenNode"
    assert set_director.outputs[0].pushable is True

    scene = get_skill("freezone.scene_360")
    scene_inputs = {item.role: item for item in scene.inputs}
    assert list(scene_inputs) == ["scene", "scene_master", "scene_reverse_master"]
    assert scene_inputs["scene"].required is False
    assert scene_inputs["scene"].cardinality == "single"
    assert scene_inputs["scene"].accepts.media_kinds == ["text"]
    assert scene_inputs["scene_master"].required is True
    assert scene_inputs["scene_master"].cardinality == "single"
    assert scene_inputs["scene_master"].accepts.canonical_slot_kinds == ["scene_master"]
    assert scene_inputs["scene_master"].accepts.media_kinds == ["image"]
    assert scene_inputs["scene_reverse_master"].required is False
    assert scene_inputs["scene_reverse_master"].cardinality == "single"
    assert scene_inputs["scene_reverse_master"].accepts.canonical_slot_kinds == [
        "scene_reverse_master"
    ]
    assert scene_inputs["scene_reverse_master"].accepts.media_kinds == ["image"]
    assert scene.outputs[0].role == "scene_360_candidate"
    assert scene.outputs[0].media_type == "image"
    assert scene.outputs[0].node_type == "imageGenNode"
    assert scene.outputs[0].pushable is True

    review = get_skill("agent.review_frame")
    review_inputs = {item.role: item for item in review.inputs}
    assert list(review_inputs) == ["beat_context", "frame"]
    assert review_inputs["beat_context"].required is True
    assert review_inputs["beat_context"].cardinality == "single"
    assert review_inputs["frame"].required is True
    assert review_inputs["frame"].cardinality == "single"
    assert review.outputs[0].role == "review_report"
    assert review.outputs[0].media_type == "text"
    assert review.outputs[0].node_type == "textAnnotationNode"
    assert review.outputs[0].pushable is False

    workflow = get_skill("workflow.plan_beat_graph")
    workflow_inputs = {item.role: item for item in workflow.inputs}
    assert list(workflow_inputs) == ["beat_context"]
    assert workflow_inputs["beat_context"].required is True
    assert workflow.outputs[0].role == "planned_canvas_patch"
    assert workflow.outputs[0].media_type == "graph_patch"
    assert workflow.outputs[0].node_type == "graphPatchNode"
    assert workflow.outputs[0].pushable is False
    assert workflow.outputs[0].requires_apply is True


@pytest.mark.asyncio
async def test_skill_run_missing_required_role_returns_422(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.frame_from_context",
            body=SkillRunRequest(
                skill_node_id="skill_frame",
                canvas_id="canvas_a",
                resolved_inputs=[_skill_beat_input()],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert "sketch" in str(exc.value.detail)
    assert exc.value.detail["code"] == "skill_input_missing_required"
    assert exc.value.detail["category"] == "validation"
    assert exc.value.detail["retryable"] is False
    assert "Connect the missing input" in exc.value.detail["user_action_hint"]


@pytest.mark.asyncio
async def test_skill_run_frame_accepts_plain_canvas_image_as_sketch_input(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_frame_plain_sketch"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(project_dir / "freezone" / "plain_sketch.png", size=(800, 1200))

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.frame_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_frame",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "sketch",
                    node_id="plain_sketch_node",
                    node_type="imageNode",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/plain_sketch.png",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_frame_from_context"
    assert captured["payload"]["config"]["canvas_sketch_paths"]["8"].endswith(
        "/freezone/plain_sketch.png"
    )


@pytest.mark.asyncio
async def test_skill_run_accept_mismatch_returns_422(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.frame_from_context",
            body=SkillRunRequest(
                skill_node_id="skill_frame",
                canvas_id="canvas_a",
                resolved_inputs=[
                    _skill_beat_input(),
                    {
                        "role": "sketch",
                        "node_id": "not_a_sketch",
                        "node_type": "textAnnotationNode",
                        "text": "not an image",
                    },
                ],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert "sketch" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_skill_run_rejects_external_image_url(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.sketch_from_context",
            body=SkillRunRequest(
                skill_node_id="skill_sketch",
                canvas_id="canvas_a",
                resolved_inputs=[
                    _skill_beat_input(),
                    _skill_image_input(
                        "background",
                        image_url="https://evil.example/not-project.png",
                        slot_kind="selected_background",
                    ),
                ],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert "external" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_skill_run_rejects_wrong_project_api_media_url(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.sketch_from_context",
            body=SkillRunRequest(
                skill_node_id="skill_sketch",
                canvas_id="canvas_a",
                resolved_inputs=[
                    _skill_beat_input(),
                    _skill_image_input(
                        "background",
                        image_url="/api/v1/projects/other/media/freezone/bg.png",
                        slot_kind="selected_background",
                    ),
                ],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert "project" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_skill_run_normalizes_project_media_url_before_dispatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_media_url"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_media_url")
    _write_image(project_dir / "freezone" / "bg.png")

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "background",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/bg.png?v=1",
                    slot_kind="selected_background",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_sketch_from_context"
    assert captured["episode"] == 1
    assert captured["beat_num"] == 8
    assert captured["payload"]["config"]["canvas_scene_refs"][0]["image_path"].endswith(
        "/freezone/bg.png"
    )


@pytest.mark.asyncio
async def test_skill_run_background_sketch_accepts_landscape_aspect(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_sketch_landscape"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(project_dir / "freezone" / "bg.png")

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            parameters={"aspect_ratio": "16:9"},
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "background",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/bg.png",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_sketch_from_context"
    assert captured["payload"]["config"]["mode_key"] == "1x1_16-9_sketch"


@pytest.mark.asyncio
async def test_skill_run_accepts_project_static_url_for_dispatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_static_url"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(project_dir / "freezone" / "bg.png")

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "background",
                    image_url="/static/admin/demo/freezone/bg.png?v=1",
                    slot_kind="selected_background",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_sketch_from_context"
    assert captured["payload"]["config"]["canvas_scene_refs"][0]["image_path"].endswith(
        "/freezone/bg.png"
    )


@pytest.mark.asyncio
async def test_skill_run_accepts_canonical_project_static_url_for_dispatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_project_static_url"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(project_dir / "freezone" / "bg.png")

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "background",
                    image_url="/static/projects/proj_freezone/freezone/bg.png?v=1",
                    slot_kind="selected_background",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_sketch_from_context"
    assert captured["payload"]["config"]["canvas_scene_refs"][0]["image_path"].endswith(
        "/freezone/bg.png"
    )


@pytest.mark.asyncio
async def test_skill_run_invalid_beat_context_returns_422(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.sketch_from_context",
            body=SkillRunRequest(
                skill_node_id="skill_sketch",
                canvas_id="canvas_a",
                resolved_inputs=[
                    {
                        "role": "beat_context",
                        "node_id": "bad_beat",
                        "node_type": "beatContextNode",
                        "beat_context": {"episode": "one", "beat": "eight"},
                    }
                ],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert "beat_context" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_skill_run_standalone_sketch_from_context_queues_candidate_without_db_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("standalone beat context must not read or write beat DB")

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_standalone_sketch"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_standalone_sketch")
    _write_image(project_dir / "freezone" / "bg.png")

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            resolved_inputs=[
                _standalone_skill_beat_input(),
                _skill_image_input(
                    "background",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/bg.png",
                    slot_kind="selected_background",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.run_id == "freezone_gen:job_standalone_sketch"
    assert response.task_type == "freezone_gen"
    assert captured["task_type"] == "freezone_gen"
    assert captured["episode"] == 0
    assert captured["payload"]["canvas_id"] == "canvas_a"
    assert captured["payload"]["node_id"] == "skill_sketch"
    assert captured["payload"]["reference_paths"][0].endswith("/freezone/bg.png")
    assert "雨夜里" in captured["payload"]["prompt"]
    assert "便利店门口回头" in captured["payload"]["prompt"]
    assert "#FF00FF" in captured["payload"]["prompt"]
    assert "便利店门口" in captured["payload"]["prompt"]
    metadata = json.loads(
        (project_dir / "freezone" / "_skill_runs" / f"{response.run_id}.json").read_text(
            encoding="utf-8"
        )
    )
    assert metadata["output"]["slot_target"] is None
    assert metadata["output"]["auto_commit"] is False


@pytest.mark.asyncio
async def test_skill_run_standalone_returns_run_id_and_result_outputs_without_db_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("standalone beat context must not read or write beat DB")

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_standalone_skill"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_standalone_skill")
    _write_image(project_dir / "freezone" / "bg.png")

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            resolved_inputs=[
                _standalone_skill_beat_input(),
                _skill_image_input(
                    "background",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/bg.png",
                    slot_kind="selected_background",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.run_id == "freezone_gen:job_standalone_skill"
    assert response.status == "queued"
    assert response.task_type == "freezone_gen"
    assert response.task_key == "task:freezone_gen:project:proj_freezone:0:job_standalone_skill"
    assert captured["episode"] == 0
    assert "beat_num" not in captured
    assert captured["payload"]["canvas_id"] == "canvas_a"
    assert captured["payload"]["node_id"] == "skill_sketch"
    assert captured["payload"]["reference_paths"][0].endswith("/freezone/bg.png")
    assert captured["payload"]["aspect_ratio"] == "2:3"
    assert "雨夜里" in captured["payload"]["prompt"]
    assert "便利店门口回头" in captured["payload"]["prompt"]
    assert "#FF00FF" in captured["payload"]["prompt"]
    assert "#B71C1C" in captured["payload"]["prompt"]

    output_path = (
        project_dir / "freezone" / "_outputs" / "freezone_gen" / "job_standalone_skill.png"
    )
    _write_image(output_path)
    get_task_manager().create_task_for_project(
        ctx,
        "freezone_gen",
        0,
        scope="job_standalone_skill",
        status="running",
    )
    pending = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )
    assert pending.status == "running"
    assert pending.outputs == []

    get_task_manager().complete_task_for_project(
        ctx,
        "freezone_gen",
        0,
        scope="job_standalone_skill",
        result={"output_path": str(output_path)},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.run_id == response.run_id
    assert result.status == "done"
    assert result.outputs[0].role == "current_sketch_candidate"
    assert result.outputs[0].media_type == "image"
    assert result.outputs[0].node_type == "imageGenNode"
    assert result.outputs[0].pushable is True
    assert result.outputs[0].slot_target is None
    assert getattr(result.outputs[0], "auto_commit", None) is False
    assert getattr(result.outputs[0], "committed", None) is None
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_outputs/freezone_gen/job_standalone_skill.png"
    )
    assert not (project_dir / "sketches" / "ep001" / "beat_08.png").exists()


@pytest.mark.asyncio
async def test_skill_run_standalone_director_sketch_queues_candidate_without_db_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("standalone beat context must not read or write beat DB")

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_standalone_director_sketch"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_standalone_director_sketch")
    _write_image(project_dir / "freezone" / "_uploads" / "combined.png")

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_director_combined",
        body=SkillRunRequest(
            skill_node_id="skill_sketch_director",
            canvas_id="canvas_a",
            parameters={"aspect_ratio": "16:9", "quality": "high"},
            resolved_inputs=[
                _standalone_skill_beat_input(),
                _skill_image_input(
                    "director_combined",
                    node_type="exportImageNode",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/_uploads/combined.png",
                    slot_kind="director_combined",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.run_id == "freezone_gen:job_standalone_director_sketch"
    assert response.task_type == "freezone_gen"
    assert captured["task_type"] == "freezone_gen"
    assert captured["episode"] == 0
    assert captured["payload"]["canvas_id"] == "canvas_a"
    assert captured["payload"]["node_id"] == "skill_sketch_director"
    assert captured["payload"]["reference_paths"][0].endswith("/freezone/_uploads/combined.png")
    assert captured["payload"]["aspect_ratio"] == "16:9"
    assert captured["payload"]["quality"] == "high"
    assert "雨夜里" in captured["payload"]["prompt"]
    assert "便利店门口回头" in captured["payload"]["prompt"]
    assert "#FF00FF" in captured["payload"]["prompt"]
    assert "#B71C1C" in captured["payload"]["prompt"]
    assert "Convert the attached 3GS director control frame" in captured["payload"]["prompt"]
    assert "CONTROL LOCK" in captured["payload"]["prompt"]
    assert "SCENE DESCRIPTIONS" in captured["payload"]["prompt"]
    assert "根据用户自定义 Beat Context 生成一张草图候选图" not in captured["payload"]["prompt"]
    assert "导演合成图" in captured["payload"]["source_label"]
    metadata = json.loads(
        (project_dir / "freezone" / "_skill_runs" / f"{response.run_id}.json").read_text(
            encoding="utf-8"
        )
    )
    assert metadata["output"]["slot_target"] is None
    assert metadata["output"]["auto_commit"] is False


@pytest.mark.asyncio
async def test_skill_run_standalone_frame_from_context_queues_candidate_without_db_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    _write_canvas_with_node(
        tmp_path,
        "canvas_a",
        {"id": "skill_frame", "type": "skillNode", "data": {"preset_managed": True}},
    )
    captured: dict = {}

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("standalone frame skill must not read or write beat DB")

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_standalone_frame"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_standalone_frame")
    _write_image(project_dir / "freezone" / "sketch.png", size=(800, 1200))
    _write_image(project_dir / "freezone" / "background.png", size=(800, 1200))
    _write_image(project_dir / "assets" / "identity_kris.png")
    _write_image(project_dir / "assets" / "prop_umbrella.png")

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.frame_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_frame",
            canvas_id="canvas_a",
            parameters={"quality": "high"},
            resolved_inputs=[
                _standalone_skill_beat_input(),
                _skill_image_input(
                    "sketch",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/sketch.png",
                    slot_kind="sketch",
                ),
                _skill_image_input(
                    "background",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/background.png",
                    slot_kind="selected_background",
                ),
                _skill_image_input(
                    "identity",
                    node_id="identity_kris",
                    image_url="/api/v1/projects/proj_freezone/media/assets/identity_kris.png",
                    slot_kind="identity",
                )
                | {"reference_target": {"kind": "identity", "identity_id": "Kris"}},
                _skill_image_input(
                    "prop",
                    node_id="prop_umbrella",
                    image_url="/api/v1/projects/proj_freezone/media/assets/prop_umbrella.png",
                    slot_kind="prop",
                )
                | {"reference_target": {"kind": "prop", "prop_id": "雨伞"}},
            ],
        ),
        user={"username": "admin"},
    )

    assert response.run_id == "mainline_frame_from_context:job_standalone_frame"
    assert response.task_type == "mainline_frame_from_context"
    assert captured["task_type"] == "mainline_frame_from_context"
    assert captured["episode"] == 0
    assert "beat_num" not in captured
    config = captured["payload"]["config"]
    assert config["standalone_beat_context"] is True
    assert config["selected_panel_indices"] == [0]
    assert "selected_beat_numbers" not in config
    assert config["beats"][0]["episode_number"] == 0
    assert config["beats"][0]["beat_number"] == 0
    assert config["beats"][0]["panel_index"] == 0
    assert config["beats"][0]["visual_description"].startswith("雨夜里")
    assert config["beats"][0]["detected_identities"] == ["Kris_Kris"]
    assert config["canvas_sketch_paths"]["0"].endswith("/freezone/sketch.png")
    assert config["canvas_scene_refs"][0]["panel_index"] == 0
    assert config["canvas_scene_refs"][0]["image_path"].endswith("/freezone/background.png")
    assert config["canvas_scene_refs"][0]["reference_mode"] == "material_only"
    assert config["canvas_identity_refs"][0]["panel_index"] == 0
    assert config["canvas_identity_refs"][0]["identity_id"] == "Kris"
    assert config["canvas_prop_refs"][0]["panel_index"] == 0
    assert config["canvas_prop_refs"][0]["prop_id"] == "雨伞"
    assert config["image_quality"] == "high"
    metadata = json.loads(
        (project_dir / "freezone" / "_skill_runs" / f"{response.run_id}.json").read_text(
            encoding="utf-8"
        )
    )
    assert metadata["output"]["slot_target"] is None
    assert metadata["output"]["auto_commit"] is False

    output_path = (
        project_dir
        / "freezone"
        / "_outputs"
        / "mainline_frame_from_context"
        / "job_standalone_frame.png"
    )
    _write_image(output_path)
    get_task_manager().create_task_for_project(
        _project_ctx(tmp_path),
        "mainline_frame_from_context",
        0,
        scope="job_standalone_frame",
        status="running",
    )
    pending = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )
    assert pending.status == "running"
    assert pending.outputs == []

    get_task_manager().complete_task_for_project(
        _project_ctx(tmp_path),
        "mainline_frame_from_context",
        0,
        scope="job_standalone_frame",
        result={"output_path": str(output_path)},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs[0].role == "current_frame_candidate"
    assert result.outputs[0].media_type == "image"
    assert result.outputs[0].node_type == "imageGenNode"
    assert result.outputs[0].pushable is True
    assert result.outputs[0].slot_target is None
    assert getattr(result.outputs[0], "auto_commit", None) is False
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_outputs/mainline_frame_from_context/job_standalone_frame.png"
    )


@pytest.mark.asyncio
async def test_skill_run_standalone_set_selected_background_returns_candidate_without_db_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    source = project_dir / "freezone" / "_uploads" / "background.png"
    _write_image(source, size=(320, 180))

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("standalone set background must not read or write beat DB")

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.set_selected_background",
        body=SkillRunRequest(
            skill_node_id="skill_set_background",
            canvas_id="canvas_a",
            resolved_inputs=[
                _standalone_skill_beat_input(),
                _skill_image_input(
                    "source_image",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/_uploads/background.png",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.status == "completed"
    assert not (project_dir / "director_control_frames" / "ep001" / "beat_08").exists()
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs[0].role == "selected_background"
    assert result.outputs[0].pushable is True
    assert result.outputs[0].slot_target is None
    assert getattr(result.outputs[0], "auto_commit", None) is False
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_uploads/background.png"
    )


@pytest.mark.asyncio
async def test_skill_run_standalone_set_director_combined_returns_candidate_without_db_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    bundle_dir = project_dir / "freezone" / "_uploads" / "director_bundle"
    _write_image(bundle_dir / "combined.png", size=(320, 180))
    _write_image(bundle_dir / "env_only.png", size=(320, 180))
    (bundle_dir / "frame_meta.json").write_text(
        json.dumps(
            {
                "schema_version": "director_frame_meta_v1",
                "camera": {"mode": "pano", "frame_aspect": "16:9"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("standalone set director combined must not read or write beat DB")

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )
    source_input = _skill_image_input(
        "source_image",
        image_url="/api/v1/projects/proj_freezone/media/freezone/_uploads/director_bundle/combined.png",
    )
    source_input["director_control_bundle"] = {
        "schema_version": "director_control_bundle_v1",
        "rel_paths": {
            "combined": "freezone/_uploads/director_bundle/combined.png",
            "env_only": "freezone/_uploads/director_bundle/env_only.png",
            "frame_meta": "freezone/_uploads/director_bundle/frame_meta.json",
        },
    }

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.set_director_combined",
        body=SkillRunRequest(
            skill_node_id="skill_set_director_combined",
            canvas_id="canvas_a",
            resolved_inputs=[
                _standalone_skill_beat_input(),
                source_input,
            ],
        ),
        user={"username": "admin"},
    )

    assert response.status == "completed"
    assert not (project_dir / "director_control_frames" / "ep001" / "beat_08").exists()
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs[0].role == "director_combined"
    assert result.outputs[0].pushable is True
    assert result.outputs[0].slot_target is None
    assert getattr(result.outputs[0], "auto_commit", None) is False
    assert getattr(result.outputs[0], "committed", None) is None
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_uploads/director_bundle/combined.png"
    )
    bundle = getattr(result.outputs[0], "director_control_bundle")
    assert bundle["rel_paths"]["combined"] == "freezone/_uploads/director_bundle/combined.png"


@pytest.mark.asyncio
async def test_skill_run_standalone_review_frame_uses_canvas_context_without_db_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)
    prompts: list[str] = []

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("standalone review frame must not read or write beat DB")

    def fake_reviewer(prompt: str) -> str:
        prompts.append(prompt)
        return "standalone review"

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "_agent_review_frame_reviewer", fake_reviewer)

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=SkillRunRequest(
            skill_node_id="skill_review",
            canvas_id="canvas_a",
            resolved_inputs=[
                _standalone_skill_beat_input(),
                _skill_image_input(
                    "frame",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/frame.png",
                    slot_kind="frame",
                ),
            ],
        ),
        user={"username": "admin"},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert response.status == "completed"
    assert result.status == "done"
    assert result.outputs[0].role == "review_report"
    assert result.outputs[0].slot_target is None
    assert result.outputs[0].text == "standalone review"
    assert "Episode: null" in prompts[0]
    assert "Beat: null" in prompts[0]
    assert "雨夜里" in prompts[0]


@pytest.mark.asyncio
async def test_skill_run_scene_360_rejects_beat_context_role(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    master = project_dir / "assets" / "scenes" / "小区" / "master.png"
    _write_image(master)

    async def fake_start_edit_job(**_kwargs):
        raise AssertionError("beat_context must fail before dispatch")

    monkeypatch.setattr(freezone_routes, "_start_or_enqueue_freezone_edit_job", fake_start_edit_job)

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.scene_360",
            body=SkillRunRequest(
                skill_node_id="skill_scene",
                canvas_id="canvas_a",
                resolved_inputs=[
                    {
                        "role": "beat_context",
                        "node_id": "bad_beat",
                        "node_type": "beatContextNode",
                        "beat_context": {"episode": "one", "beat": "eight"},
                    },
                    _skill_image_input(
                        "scene_master",
                        image_url="/assets/scenes/小区/master.png",
                        slot_kind="scene_master",
                    ),
                ],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert "beat_context" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_skill_run_mainline_returns_run_id_and_result_outputs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_skill"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_skill")
    _write_image(project_dir / "freezone" / "bg.png")

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "background",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/bg.png",
                    slot_kind="selected_background",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.run_id == "mainline_sketch_from_context:job_skill"
    assert response.status == "queued"
    assert response.task_type == "mainline_sketch_from_context"
    assert (
        response.task_key == "task:mainline_sketch_from_context:project:proj_freezone:1:8:job_skill"
    )
    assert captured["episode"] == 1
    assert captured["beat_num"] == 8
    assert captured["payload"]["canvas_id"] == "canvas_a"
    assert captured["payload"]["node_id"] == "skill_sketch"
    config = captured["payload"]["config"]
    assert config["promote_direct_sketch"] is False
    assert config["direct_sketch_beats"] is True
    assert config["mode_key"] == "1x1_2-3_sketch"
    assert config["beats"][0]["beat_number"] == 8
    assert config["beats"][0]["scene_ref"]["scene_id"] == "兰州拉面馆"
    assert config["canvas_scene_refs"][0]["image_path"].endswith("/bg.png")
    assert config["canvas_scene_refs"][0]["source_level"] == "selected_background_image"

    output_path = (
        project_dir / "freezone" / "_outputs" / "mainline_sketch_from_context" / "job_skill.png"
    )
    _write_image(output_path)
    get_task_manager().create_task_for_project(
        ctx,
        "mainline_sketch_from_context",
        1,
        beat_num=8,
        scope="job_skill",
        status="running",
    )
    pending = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )
    assert pending.status == "running"
    assert pending.outputs == []

    get_task_manager().complete_task_for_project(
        ctx,
        "mainline_sketch_from_context",
        1,
        beat_num=8,
        scope="job_skill",
        result={"output_path": str(output_path)},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.run_id == response.run_id
    assert result.status == "done"
    assert result.outputs[0].role == "current_sketch_candidate"
    assert result.outputs[0].media_type == "image"
    assert result.outputs[0].node_type == "imageGenNode"
    assert result.outputs[0].pushable is True
    assert result.outputs[0].slot_target == {"kind": "sketch", "episode": 1, "beat": 8}
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_outputs/mainline_sketch_from_context/job_skill.png"
    )
    assert not (project_dir / "sketches" / "ep001" / "beat_08.png").exists()


@pytest.mark.asyncio
async def test_skill_run_set_selected_background_writes_beat_slot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    _write_canvas_with_node(
        tmp_path,
        "canvas_a",
        {"id": "skill_set_background", "type": "skillNode", "data": {"preset_managed": True}},
    )
    source = project_dir / "freezone" / "_uploads" / "background.png"
    _write_image(source, size=(320, 180))
    updates: list[dict] = []

    class Store:
        async def get_beats_as_dicts(self, episode: int) -> list[dict]:
            assert episode == 1
            return [
                {
                    "episode_number": 1,
                    "beat_number": 8,
                    "scene_ref": {"scene_id": "兰州拉面馆", "render_anchor_id": "master"},
                }
            ]

        async def update_beat_asset(
            self,
            *,
            episode_number: int,
            beat_number: int,
            scene_ref: dict | None = None,
            **_kwargs,
        ) -> None:
            updates.append(
                {
                    "episode_number": episode_number,
                    "beat_number": beat_number,
                    "scene_ref": scene_ref,
                }
            )

        async def close(self) -> None:
            pass

    async def fake_make_sqlite_store_for_context(_ctx):
        return Store()

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.set_selected_background",
        body=SkillRunRequest(
            skill_node_id="skill_set_background",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "source_image",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/_uploads/background.png",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.status == "completed"
    assert response.run_id.startswith("freezone.set_selected_background:")
    selected = (
        project_dir / "director_control_frames" / "ep001" / "beat_08" / "selected_background.png"
    )
    assert selected.exists()
    assert updates == [
        {
            "episode_number": 1,
            "beat_number": 8,
            "scene_ref": {
                "scene_id": "兰州拉面馆",
                "render_anchor_id": "selected_background",
                "render_anchor_source_id": "skill_source_image",
            },
        }
    ]

    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs[0].role == "selected_background"
    assert result.outputs[0].pushable is False
    assert result.outputs[0].slot_target == {
        "kind": "selected_background",
        "episode": 1,
        "beat": 8,
    }
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/director_control_frames/ep001/beat_08/selected_background.png"
    )


@pytest.mark.asyncio
async def test_user_created_set_selected_background_returns_pushable_candidate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    _write_canvas_with_node(
        tmp_path,
        "canvas_a",
        {"id": "skill_set_background", "type": "skillNode", "data": {}},
    )
    source = project_dir / "freezone" / "_uploads" / "background.png"
    _write_image(source, size=(320, 180))

    async def fail_make_sqlite_store_for_context(_ctx):
        raise AssertionError("user-created set background must not write beat DB")

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fail_make_sqlite_store_for_context
    )

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.set_selected_background",
        body=SkillRunRequest(
            skill_node_id="skill_set_background",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "source_image",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/_uploads/background.png",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    selected = (
        project_dir / "director_control_frames" / "ep001" / "beat_08" / "selected_background.png"
    )
    assert not selected.exists()

    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs[0].role == "selected_background"
    assert result.outputs[0].pushable is True
    assert getattr(result.outputs[0], "auto_commit", None) is False
    assert result.outputs[0].slot_target == {
        "kind": "selected_background",
        "episode": 1,
        "beat": 8,
    }
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_uploads/background.png"
    )


@pytest.mark.asyncio
async def test_skill_run_set_director_combined_preserves_control_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    _write_canvas_with_node(
        tmp_path,
        "canvas_a",
        {
            "id": "skill_set_director_combined",
            "type": "skillNode",
            "data": {"preset_managed": True},
        },
    )
    bundle_dir = project_dir / "freezone" / "_uploads" / "director_bundle"
    _write_image(bundle_dir / "combined.png", size=(320, 180))
    _write_image(bundle_dir / "env_only.png", size=(320, 180))
    (bundle_dir / "frame_meta.json").write_text(
        json.dumps(
            {
                "schema_version": "director_frame_meta_v1",
                "source": {"source_type": "pano360", "source_kind": "pano"},
                "camera": {"mode": "pano", "frame_aspect": "16:9", "state": {"yaw": 12}},
                "layer": {"source_id": "pano", "actors": [], "props": [], "stagings": []},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    source_input = _skill_image_input(
        "source_image",
        image_url="/api/v1/projects/proj_freezone/media/freezone/_uploads/director_bundle/combined.png",
    )
    source_input["director_control_bundle"] = {
        "schema_version": "director_control_bundle_v1",
        "rel_paths": {
            "combined": "freezone/_uploads/director_bundle/combined.png",
            "env_only": "freezone/_uploads/director_bundle/env_only.png",
            "frame_meta": "freezone/_uploads/director_bundle/frame_meta.json",
        },
        "urls": {
            "combined": (
                "/api/v1/projects/proj_freezone/media/freezone/"
                "_uploads/director_bundle/combined.png"
            ),
            "env_only": (
                "/api/v1/projects/proj_freezone/media/freezone/"
                "_uploads/director_bundle/env_only.png"
            ),
            "frame_meta": (
                "/api/v1/projects/proj_freezone/media/freezone/"
                "_uploads/director_bundle/frame_meta.json"
            ),
        },
    }

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.set_director_combined",
        body=SkillRunRequest(
            skill_node_id="skill_set_director_combined",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                source_input,
            ],
        ),
        user={"username": "admin"},
    )

    assert response.status == "completed"
    target_dir = project_dir / "director_control_frames" / "ep001" / "beat_08"
    assert (target_dir / "combined.png").exists()
    assert (target_dir / "env_only.png").exists()
    assert (target_dir / "frame_meta.json").exists()
    assert json.loads((target_dir / "frame_meta.json").read_text())["camera"]["mode"] == "pano"

    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    bundle = getattr(result.outputs[0], "director_control_bundle")
    assert bundle["rel_paths"] == {
        "combined": "director_control_frames/ep001/beat_08/combined.png",
        "env_only": "director_control_frames/ep001/beat_08/env_only.png",
        "frame_meta": "director_control_frames/ep001/beat_08/frame_meta.json",
    }
    assert result.outputs[0].committed is True
    assert result.outputs[0].committed_slot_url == result.outputs[0].image_url


@pytest.mark.asyncio
async def test_skill_run_sketch_accepts_director_combined_background(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_director"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_director")
    _write_image(project_dir / "freezone" / "_uploads" / "combined.png")

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_director_combined",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            parameters={"aspect_ratio": "16:9"},
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "director_combined",
                    image_url=(
                        "/api/v1/projects/proj_freezone/media/freezone/_uploads/combined.png"
                    ),
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.run_id == "mainline_director_control_sketch:job_director"
    assert captured["task_type"] == "mainline_director_control_sketch"
    assert captured["episode"] == 1
    assert captured["beat_num"] == 8
    assert captured["payload"]["control_frame_path"].endswith("/freezone/_uploads/combined.png")
    assert captured["payload"]["mode_key"] == "1x1_16-9_sketch"
    assert captured["payload"]["aspect_ratio"] == "16:9"
    assert captured["payload"]["source_label"] == "导演合成图"


@pytest.mark.asyncio
async def test_skill_run_sketch_prefers_director_combined_over_background(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_director_preferred"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_director_preferred")
    _write_image(project_dir / "freezone" / "_uploads" / "combined.png")

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.sketch_from_context",
            body=SkillRunRequest(
                skill_node_id="skill_sketch",
                canvas_id="canvas_a",
                resolved_inputs=[
                    _skill_beat_input(),
                    _skill_image_input(
                        "background",
                        image_url="/api/v1/projects/proj_freezone/media/freezone/selected.png",
                        slot_kind="selected_background",
                    ),
                    _skill_image_input(
                        "director_combined",
                        image_url=(
                            "/api/v1/projects/proj_freezone/media/freezone/_uploads/combined.png"
                        ),
                        slot_kind="director_combined",
                    ),
                ],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert "director_combined" in str(exc.value.detail)

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.sketch_from_director_combined",
        body=SkillRunRequest(
            skill_node_id="skill_sketch",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "director_combined",
                    image_url=(
                        "/api/v1/projects/proj_freezone/media/freezone/_uploads/combined.png"
                    ),
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_director_control_sketch"
    assert captured["episode"] == 1
    assert captured["beat_num"] == 8
    assert captured["payload"]["control_frame_path"].endswith("/freezone/_uploads/combined.png")
    assert captured["payload"]["source_label"] == "导演合成图"


@pytest.mark.asyncio
async def test_skill_run_frame_uses_resolved_identity_and_prop_references(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_frame_refs"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    import novelvideo.project_config as project_config

    monkeypatch.setattr(
        project_config,
        "load_project_config",
        lambda _username, _project: {"visual_style": "realistic", "ethnicity": "Mixed"},
    )
    _write_image(project_dir / "freezone" / "sketch.png", size=(800, 1200))
    _write_image(project_dir / "assets" / "identity_a.png")
    _write_image(project_dir / "assets" / "prop_b.png")

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.frame_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_frame",
            canvas_id="canvas_a",
            resolved_inputs=[
                {
                    **_skill_beat_input(),
                    "beat_context": {
                        "episode": 1,
                        "beat": 8,
                        "scene_id": "画布场景",
                        "visual_description": "画布里的分镜描述",
                        "detected_identities": ["画布身份"],
                        "detected_props": ["画布道具"],
                    },
                },
                _skill_image_input(
                    "sketch",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/sketch.png",
                    slot_kind="sketch",
                ),
                _skill_image_input(
                    "identity",
                    node_id="identity_a",
                    image_url="/api/v1/projects/proj_freezone/media/assets/identity_a.png",
                    slot_kind="identity",
                )
                | {"reference_target": {"kind": "identity", "identity_id": "画布身份"}},
                _skill_image_input(
                    "prop",
                    node_id="prop_b",
                    image_url="/api/v1/projects/proj_freezone/media/assets/prop_b.png",
                    slot_kind="prop",
                )
                | {"reference_target": {"kind": "prop", "prop_id": "画布道具"}},
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_frame_from_context"
    assert captured["episode"] == 1
    assert captured["beat_num"] == 8
    config = captured["payload"]["config"]
    assert config["mode_key"] == "1x1_2-3"
    assert config["aspect_ratio"] == "2:3"
    assert config["canvas_sketch_paths"]["8"].endswith("/freezone/sketch.png")
    assert config["canvas_identity_refs"][0]["image_path"].endswith("/assets/identity_a.png")
    assert config["canvas_prop_refs"][0]["image_path"].endswith("/assets/prop_b.png")
    assert config["style"] == "realistic"
    assert config["ethnicity"] == "Mixed"
    assert config["beats"][0]["visual_description"] == "画布里的分镜描述"
    assert config["beats"][0]["detected_identities"] == ["画布身份"]
    assert config["beats"][0]["detected_props"] == ["画布道具"]
    assert captured["payload"]["task_label"] == "渲染分镜"


@pytest.mark.asyncio
async def test_skill_run_frame_filters_stale_canvas_identity_refs_by_beat_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_frame"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(project_dir / "freezone" / "sketch.png", size=(800, 1200))
    _write_image(project_dir / "assets" / "identity_keep.png")
    _write_image(project_dir / "assets" / "identity_stale.png")

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.frame_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_frame",
            canvas_id="canvas_a",
            resolved_inputs=[
                {
                    **_skill_beat_input(),
                    "beat_context": {
                        "episode": 1,
                        "beat": 8,
                        "scene_id": "画布场景",
                        "visual_description": "画布里的分镜描述",
                        "detected_identities": ["保留身份"],
                    },
                },
                _skill_image_input(
                    "sketch",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/sketch.png",
                    slot_kind="sketch",
                ),
                _skill_image_input(
                    "identity",
                    node_id="identity_keep",
                    image_url="/api/v1/projects/proj_freezone/media/assets/identity_keep.png",
                    slot_kind="identity",
                )
                | {"reference_target": {"kind": "identity", "identity_id": "保留身份"}},
                _skill_image_input(
                    "identity",
                    node_id="identity_stale",
                    image_url="/api/v1/projects/proj_freezone/media/assets/identity_stale.png",
                    slot_kind="identity",
                )
                | {"reference_target": {"kind": "identity", "identity_id": "过期身份"}},
            ],
        ),
        user={"username": "admin"},
    )

    config = captured["payload"]["config"]
    assert [item["identity_id"] for item in config["canvas_identity_refs"]] == ["保留身份"]
    assert config["canvas_identity_refs"][0]["image_path"].endswith("/assets/identity_keep.png")


@pytest.mark.asyncio
async def test_skill_run_frame_uses_sketch_aspect_ratio_and_quality(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_make_sqlite_store_for_context(_ctx):
        return _FakeContextBeatStore()

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_frame_landscape"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(
        freezone_routes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context
    )
    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_image(project_dir / "freezone" / "sketch.png", size=(1600, 900))

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.frame_from_context",
        body=SkillRunRequest(
            skill_node_id="skill_frame",
            canvas_id="canvas_a",
            parameters={"aspect_ratio": "2:3", "quality": "high"},
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "sketch",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/sketch.png",
                    slot_kind="sketch",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "mainline_frame_from_context"
    assert captured["payload"]["mode_key"] == "1x1_16-9"
    assert captured["payload"]["config"]["mode_key"] == "1x1_16-9"
    assert captured["payload"]["config"]["aspect_ratio"] == "16:9"
    assert captured["payload"]["config"]["image_quality"] == "high"


@pytest.mark.asyncio
async def test_skill_run_scene_360_uses_reverse_master_and_scene_slot_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_scene_360"),
            backend="celery",
            queue="node.node_a.world",
        )

    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_scene_360")
    master = project_dir / "assets" / "scenes" / "小区" / "master.png"
    reverse = project_dir / "assets" / "scenes" / "小区" / "reverse.png"
    _write_image(master)
    _write_image(reverse)

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.scene_360",
        body=SkillRunRequest(
            skill_node_id="skill_scene",
            canvas_id="canvas_a",
            resolved_inputs=[
                {
                    "role": "scene",
                    "node_id": "scene_prompt",
                    "node_type": "textAnnotationNode",
                    "text": "画布输入的 360 场景提示词",
                    "media_kind": "text",
                },
                {
                    "role": "scene_master",
                    "node_id": "scene_master_node",
                    "node_type": "imageGenNode",
                    "image_url": "/assets/scenes/小区/master.png",
                    "slot_target": {"kind": "scene_master", "scene_id": "小区"},
                },
                _skill_image_input(
                    "scene_reverse_master",
                    image_url=(
                        "/api/v1/projects/proj_freezone/media/assets/scenes/小区/reverse.png"
                    ),
                    slot_kind="scene_reverse_master",
                ),
            ],
        ),
        user={"username": "admin"},
    )

    assert response.run_id.startswith("stage_asset:")
    assert captured["task_type"] == "stage_asset"
    assert captured["payload"]["scene_name"] == "小区"
    assert captured["payload"]["step"] == "pano_from_master"
    assert captured["payload"]["params"]["provider"] == "newapi"
    assert captured["payload"]["params"]["model"] == NEWAPI_IMAGE_MODEL
    assert captured["payload"]["params"]["image_size"] == "2K"
    assert captured["payload"]["params"]["update_manifest"] is False
    assert captured["payload"]["params"]["master_path"].endswith("/assets/scenes/小区/master.png")
    assert captured["payload"]["params"]["reverse_master_path"].endswith(
        "/assets/scenes/小区/reverse.png"
    )
    assert "画布输入的 360 场景提示词" in captured["payload"]["params"]["description"]

    pano = (
        project_dir
        / "freezone"
        / "_outputs"
        / "mainline_scene_360"
        / "job_scene_360"
        / "pano_360.png"
    )
    _write_image(pano)
    get_task_manager().complete_task_for_project(
        ctx,
        "stage_asset",
        0,
        scope=response.job_id,
        result={"output_path": str(pano)},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.outputs[0].role == "scene_360_candidate"
    assert result.outputs[0].slot_target == {
        "kind": "scene_director_pano_360",
        "scene_id": "小区",
    }
    assert result.outputs[0].pushable is True
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_outputs/mainline_scene_360/job_scene_360/pano_360.png"
    )
    assert pano.exists()


@pytest.mark.asyncio
async def test_skill_run_scene_360_requires_scene_master_scene_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    master = project_dir / "assets" / "scenes" / "小区" / "master.png"
    _write_image(master)

    async def fake_enqueue_project_task(_ctx: ProjectContext, **_kwargs):
        raise AssertionError("scene_360 must fail before dispatch without explicit scene_id")

    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))

    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="freezone.scene_360",
            body=SkillRunRequest(
                skill_node_id="skill_scene",
                canvas_id="canvas_a",
                resolved_inputs=[
                    _skill_image_input(
                        "scene_master",
                        image_url="/assets/scenes/小区/master.png",
                        slot_kind="scene_master",
                    ),
                ],
            ),
            user={"username": "admin"},
        )

    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "skill_scene_master_missing_scene_id"


@pytest.mark.asyncio
async def test_skill_run_scene_360_infers_scene_id_from_mainline_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    captured: dict = {}

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_scene_360"),
            backend="celery",
            queue="node.node_a.world",
        )

    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "job_scene_360")
    master = project_dir / "assets" / "scenes" / "小区" / "master.png"
    _write_image(master)

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.scene_360",
        body=SkillRunRequest(
            skill_node_id="skill_scene",
            canvas_id="canvas_a",
            resolved_inputs=[
                {
                    "role": "scene_master",
                    "node_id": "scene_master_node",
                    "node_type": "imageGenNode",
                    "image_url": "/assets/scenes/小区/master.png",
                    "mainline_context": [
                        {
                            "kind": "scene",
                            "sceneId": "小区",
                            "role": "scene_master",
                            "projectId": "proj_freezone",
                        }
                    ],
                },
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "stage_asset"
    assert captured["payload"]["scene_name"] == "小区"
    assert captured["payload"]["params"]["master_path"].endswith("/assets/scenes/小区/master.png")


@pytest.mark.asyncio
async def test_preset_managed_scene_360_auto_commits_to_canonical_slot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    ctx = _project_ctx(tmp_path)
    captured: dict = {}

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.update(kwargs)
        captured["payload"] = kwargs.get("payload") or {}
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_scene_360"),
            backend="celery",
            queue="node.node_a.world",
        )

    monkeypatch.setattr(freezone_routes, "get_task_backend", lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task))
    _write_canvas_with_node(
        tmp_path,
        "canvas_a",
        {"id": "skill_scene", "type": "skillNode", "data": {"preset_managed": True}},
    )
    master = project_dir / "assets" / "scenes" / "小区" / "master.png"
    reverse = project_dir / "assets" / "scenes" / "小区" / "reverse.png"
    _write_image(master)
    _write_image(reverse)

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="freezone.scene_360",
        body=SkillRunRequest(
            skill_node_id="skill_scene",
            canvas_id="canvas_a",
            resolved_inputs=[
                {
                    "role": "scene_master",
                    "node_id": "scene_master_node",
                    "node_type": "imageGenNode",
                    "image_url": "/assets/scenes/小区/master.png",
                    "slot_target": {"kind": "scene_master", "scene_id": "小区"},
                },
                {
                    "role": "scene_reverse_master",
                    "node_id": "scene_reverse_node",
                    "node_type": "imageGenNode",
                    "image_url": "/assets/scenes/小区/reverse.png",
                    "slot_target": {"kind": "scene_reverse_master", "scene_id": "小区"},
                },
            ],
        ),
        user={"username": "admin"},
    )

    assert captured["task_type"] == "stage_asset"
    assert captured["payload"]["params"]["update_manifest"] is True
    assert captured["payload"]["params"]["artifact_dir"] == ""

    pano = project_dir / "director_worlds" / "小区" / "v1" / "pano_360.png"
    _write_image(pano)
    get_task_manager().complete_task_for_project(
        ctx,
        "stage_asset",
        0,
        scope=response.job_id,
        result={"pano_path": str(pano)},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.outputs[0].pushable is False
    assert result.outputs[0].committed is True
    assert unquote(urlsplit(result.outputs[0].image_url or "").path).endswith(
        "/director_worlds/小区/v1/pano_360.png"
    )


@pytest.mark.asyncio
async def test_skill_result_uses_task_result_dict_output_url(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_state import TaskState

    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    run_id = "freezone_gen:job_result_dict"
    freezone_routes._write_skill_run_metadata(
        project_dir,
        run_id,
        {
            "run_id": run_id,
            "skill_id": "freezone.sketch_from_context",
            "status": "queued",
            "task_type": "freezone_gen",
            "job_id": "job_result_dict",
            "task_key": "task:freezone_gen:project:proj_freezone:0:job_result_dict",
            "output": {
                "role": "current_sketch_candidate",
                "media_type": "image",
                "node_type": "imageGenNode",
                "pushable": True,
            },
        },
    )

    class FakeTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return TaskState(
                task_id="task_1",
                task_type="freezone_gen",
                status="completed",
                result={"output_url": "/static/admin/demo/freezone/_outputs/custom.webp"},
            )

    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeTaskManager())

    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs[0].image_url == "/static/admin/demo/freezone/_outputs/custom.webp"


@pytest.mark.asyncio
async def test_skill_result_falls_back_to_known_output_suffixes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    ctx = _project_ctx(tmp_path)
    run_id = "freezone_edit:job_result_webp"
    freezone_routes._write_skill_run_metadata(
        project_dir,
        run_id,
        {
            "run_id": run_id,
            "skill_id": "freezone.frame_from_context",
            "status": "queued",
            "task_type": "freezone_edit",
            "job_id": "job_result_webp",
            "task_key": "task:freezone_edit:project:proj_freezone:0:job_result_webp",
            "output": {
                "role": "current_frame_candidate",
                "media_type": "image",
                "node_type": "imageGenNode",
                "pushable": True,
            },
        },
    )
    _write_image(project_dir / "freezone" / "_outputs" / "freezone_edit" / "job_result_webp.webp")

    get_task_manager().create_task_for_project(
        ctx,
        "freezone_edit",
        0,
        scope="job_result_webp",
        status="running",
    )
    pending = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=run_id,
        user={"username": "admin"},
    )

    assert pending.status == "running"
    assert pending.outputs == []

    get_task_manager().complete_task_for_project(
        ctx,
        "freezone_edit",
        0,
        scope="job_result_webp",
        result={},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_outputs/freezone_edit/job_result_webp.webp"
    )


@pytest.mark.asyncio
async def test_skill_result_normalizes_nested_outputs_from_task_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_state import TaskState

    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    run_id = "freezone_edit:job_nested_outputs"
    freezone_routes._write_skill_run_metadata(
        project_dir,
        run_id,
        {
            "run_id": run_id,
            "skill_id": "freezone.frame_from_context",
            "status": "queued",
            "task_type": "freezone_edit",
            "job_id": "job_nested_outputs",
            "task_key": "task:freezone_edit:project:proj_freezone:0:job_nested_outputs",
            "output": {
                "role": "current_frame_candidate",
                "media_type": "image",
                "node_type": "imageGenNode",
                "pushable": True,
            },
        },
    )

    class FakeTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return TaskState(
                task_id="task_nested",
                task_type="freezone_edit",
                status="completed",
                result={
                    "outputs": [
                        {
                            "role": "current_frame_candidate",
                            "media_type": "image",
                            "node_type": "imageGenNode",
                            "pushable": True,
                            "image_url": "/static/admin/demo/freezone/_outputs/nested.png",
                        },
                        {
                            "role": "review_report",
                            "media_type": "text",
                            "node_type": "textAnnotationNode",
                            "pushable": False,
                            "text": "looks consistent",
                        },
                    ]
                },
            )

    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeTaskManager())

    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert [output.role for output in result.outputs] == [
        "current_frame_candidate",
        "review_report",
    ]
    assert result.outputs[0].image_url == "/static/admin/demo/freezone/_outputs/nested.png"
    assert result.outputs[1].text == "looks consistent"


@pytest.mark.asyncio
async def test_skill_result_normalizes_output_path_from_task_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_state import TaskState

    project_dir, _output_dir = _patch_freezone_project(monkeypatch, tmp_path)
    output_path = project_dir / "freezone" / "_outputs" / "custom" / "path_only.webp"
    _write_image(output_path)
    run_id = "freezone_edit:job_output_path"
    freezone_routes._write_skill_run_metadata(
        project_dir,
        run_id,
        {
            "run_id": run_id,
            "skill_id": "freezone.frame_from_context",
            "status": "queued",
            "task_type": "freezone_edit",
            "job_id": "job_output_path",
            "task_key": "task:freezone_edit:project:proj_freezone:0:job_output_path",
            "output": {
                "role": "current_frame_candidate",
                "media_type": "image",
                "node_type": "imageGenNode",
                "pushable": True,
            },
        },
    )

    class FakeTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return TaskState(
                task_id="task_path",
                task_type="freezone_edit",
                status="completed",
                result={"output_path": str(output_path)},
            )

    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeTaskManager())

    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert urlsplit(result.outputs[0].image_url or "").path.endswith(
        "/freezone/_outputs/custom/path_only.webp"
    )


@pytest.mark.asyncio
async def test_agent_review_frame_returns_text_output_in_skill_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=SkillRunRequest(
            skill_node_id="skill_review",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "frame",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/frame.png",
                    slot_kind="frame",
                ),
            ],
        ),
        user={"username": "admin"},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert response.status == "completed"
    assert result.status == "done"
    assert result.outputs[0].role == "review_report"
    assert result.outputs[0].media_type == "text"
    assert result.outputs[0].node_type == "textAnnotationNode"
    assert result.outputs[0].pushable is False
    assert "Episode 1, Beat 8" in (result.outputs[0].text or "")


@pytest.mark.asyncio
async def test_agent_review_frame_uses_injected_reviewer_text_in_skill_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)
    prompts: list[str] = []

    def fake_reviewer(prompt: str) -> str:
        prompts.append(prompt)
        return "patched agent frame review"

    monkeypatch.setattr(freezone_routes, "_agent_review_frame_reviewer", fake_reviewer)

    response = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=SkillRunRequest(
            skill_node_id="skill_review",
            canvas_id="canvas_a",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "frame",
                    node_id="frame_node",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/frame.png",
                    slot_kind="frame",
                ),
            ],
        ),
        user={"username": "admin"},
    )
    result = await freezone_routes.freezone_skill_run_result(
        project="proj_freezone",
        run_id=response.run_id,
        user={"username": "admin"},
    )

    assert result.status == "done"
    assert result.outputs[0].role == "review_report"
    assert result.outputs[0].media_type == "text"
    assert result.outputs[0].node_type == "textAnnotationNode"
    assert result.outputs[0].pushable is False
    assert result.outputs[0].text == "patched agent frame review"
    assert prompts


@pytest.mark.asyncio
async def test_skill_run_reuses_response_for_same_idempotency_key_and_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)
    prompts: list[str] = []

    def fake_reviewer(prompt: str) -> str:
        prompts.append(prompt)
        return f"review #{len(prompts)}"

    monkeypatch.setattr(freezone_routes, "_agent_review_frame_reviewer", fake_reviewer)

    def request() -> SkillRunRequest:
        return SkillRunRequest(
            skill_node_id="skill_review",
            canvas_id="canvas_a",
            idempotency_key="client-submit-1",
            resolved_inputs=[
                _skill_beat_input(),
                _skill_image_input(
                    "frame",
                    node_id="frame_node",
                    image_url="/api/v1/projects/proj_freezone/media/freezone/frame.png",
                    slot_kind="frame",
                ),
            ],
        )

    first = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=request(),
        user={"username": "admin"},
    )
    second = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=request(),
        user={"username": "admin"},
    )

    assert second.run_id == first.run_id
    assert len(prompts) == 1
    events = _read_canvas_events(tmp_path / "project", "canvas_a")
    skill_events = [event for event in events if event["event_type"] == "skill.run_completed"]
    assert len(skill_events) == 1
    assert skill_events[0]["payload"]["skill_id"] == "agent.review_frame"
    assert skill_events[0]["payload"]["run_id"] == first.run_id


@pytest.mark.asyncio
async def test_skill_run_rejects_same_idempotency_key_with_different_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)

    base = SkillRunRequest(
        skill_node_id="skill_review",
        canvas_id="canvas_a",
        idempotency_key="client-submit-conflict",
        resolved_inputs=[
            _skill_beat_input(),
            _skill_image_input(
                "frame",
                node_id="frame_node_a",
                image_url="/api/v1/projects/proj_freezone/media/freezone/frame-a.png",
                slot_kind="frame",
            ),
        ],
    )
    conflict = SkillRunRequest(
        skill_node_id="skill_review",
        canvas_id="canvas_a",
        idempotency_key="client-submit-conflict",
        resolved_inputs=[
            _skill_beat_input(),
            _skill_image_input(
                "frame",
                node_id="frame_node_b",
                image_url="/api/v1/projects/proj_freezone/media/freezone/frame-b.png",
                slot_kind="frame",
            ),
        ],
    )

    await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=base,
        user={"username": "admin"},
    )
    with pytest.raises(freezone_routes.HTTPException) as exc:
        await freezone_routes.freezone_skill_run(
            project="proj_freezone",
            skill_id="agent.review_frame",
            body=conflict,
            user={"username": "admin"},
        )

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "skill_run_idempotency_conflict"
    assert exc.value.detail["category"] == "conflict"
    assert exc.value.detail["retryable"] is False


@pytest.mark.asyncio
async def test_skill_run_without_idempotency_key_runs_each_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path)
    prompts: list[str] = []

    def fake_reviewer(prompt: str) -> str:
        prompts.append(prompt)
        return f"review #{len(prompts)}"

    monkeypatch.setattr(freezone_routes, "_agent_review_frame_reviewer", fake_reviewer)
    request = SkillRunRequest(
        skill_node_id="skill_review",
        canvas_id="canvas_a",
        resolved_inputs=[
            _skill_beat_input(),
            _skill_image_input(
                "frame",
                image_url="/api/v1/projects/proj_freezone/media/freezone/frame.png",
                slot_kind="frame",
            ),
        ],
    )

    first = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=request,
        user={"username": "admin"},
    )
    second = await freezone_routes.freezone_skill_run(
        project="proj_freezone",
        skill_id="agent.review_frame",
        body=request,
        user={"username": "admin"},
    )

    assert second.run_id != first.run_id
    assert len(prompts) == 2
    assert "Episode: 1" in prompts[0]
    assert "Beat: 8" in prompts[0]
    assert "frame_node" in prompts[0]


@pytest.mark.asyncio
async def test_get_node_generation_history_uses_project_context_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.freezone.history import append_generation_history

    ctx = _project_ctx(tmp_path)
    project_dir = ctx.output_dir

    append_generation_history(
        project_dir=project_dir,
        canvas_id="canvas_a",
        node_id="node_a",
        record={
            "id": "freezone_gen:job_1",
            "task_type": "freezone_gen",
            "task_key": "task:freezone_gen:project:proj_freezone:0:job_1",
            "job_id": "job_1",
            "status": "completed",
            "media_type": "image",
        },
    )

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", project_dir, str(project_dir)

    def fail_get_project_dir(*_args, **_kwargs):
        raise AssertionError("legacy project path should not be used")

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    monkeypatch.setattr(freezone_routes, "get_project_dir", fail_get_project_dir, raising=False)

    result = await freezone_routes.get_node_generation_history(
        project="proj_freezone",
        canvas_id="canvas_a",
        node_id="node_a",
        limit=100,
        user={"username": "admin"},
    )

    assert result["data"]["records"][-1]["task_key"] == (
        "task:freezone_gen:project:proj_freezone:0:job_1"
    )
    recorded_at = result["data"]["records"][-1]["recorded_at"]
    assert recorded_at.endswith("Z")
    assert "+08:00" not in recorded_at


@pytest.mark.asyncio
async def test_freezone_image_models_returns_selection_keys(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_freezone_project(monkeypatch, tmp_path, project="58")

    result = await freezone_routes.freezone_image_models(
        project="58",
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"] == [
        {
            "id": "newapi_gpt_image2",
            "providerId": "newapi",
            "provider": "newapi",
            "apiModel": "newapi_gpt_image2",
            "api_model": "newapi_gpt_image2",
            "label": "LingShan-G2",
        },
        {
            "id": "newapi_nanobanana2",
            "providerId": "newapi",
            "provider": "newapi",
            "apiModel": "newapi_nanobanana2",
            "api_model": "newapi_nanobanana2",
            "label": "LingShan-NB-2",
        },
    ]


@pytest.mark.asyncio
async def test_freezone_job_result_returns_task_error_when_failed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "58"
    job_id = "job_failed"

    _patch_freezone_project(monkeypatch, tmp_path, username=username, project=project)

    class FakeTask:
        status = "failed"
        error = "boom"
        logs = ["l1", "l2"]
        current_task = "doing"

    class FakeManager:
        def get_task_for_project(self, ctx, task_type, episode, beat_num=None, scope=None):
            assert ctx.project_id == "proj_freezone"
            assert task_type == "freezone_edit"
            assert episode == 0
            assert scope == job_id
            return FakeTask()

        def get_task(self, task_type, username_, project_, episode, scope=None):
            assert task_type == "freezone_edit"
            assert username_ == username
            assert project_ == project
            assert episode == 0
            assert scope == job_id
            return FakeTask()

    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project=project,
        task_type="freezone_edit",
        job_id=job_id,
        user={"username": username},
    )

    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["error"] == "boom"
    assert result["logs"] == ["l1", "l2"]


@pytest.mark.asyncio
async def test_freezone_job_result_uses_info_while_running(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "58"
    job_id = "job_running"

    _patch_freezone_project(monkeypatch, tmp_path, username=username, project=project)

    class FakeTask:
        status = "running"
        error = None
        logs = []
        current_task = "drawing"

    class FakeManager:
        def get_task_for_project(self, ctx, task_type, episode, beat_num=None, scope=None):
            assert ctx.project_id == "proj_freezone"
            assert task_type == "freezone_edit"
            assert episode == 0
            assert scope == job_id
            return FakeTask()

        def get_task(self, task_type, username_, project_, episode, scope=None):
            assert task_type == "freezone_edit"
            assert username_ == username
            assert project_ == project
            assert episode == 0
            assert scope == job_id
            return FakeTask()

    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project=project,
        task_type="freezone_edit",
        job_id=job_id,
        user={"username": username},
    )

    assert result["ok"] is False
    assert result["status"] == "running"
    assert result["info"] == "job result not yet on disk"
    assert result["current_task"] == "drawing"
    assert "error" not in result


@pytest.mark.asyncio
async def test_freezone_upscale_resolves_original_ratio_before_model_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "58"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    source = project_dir / "freezone" / "_uploads" / "sample.png"
    _write_image(source, size=(320, 180))

    captured: dict[str, object] = {}

    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda url, _project_dir: source,
    )
    _patch_celery_edit_enqueue(monkeypatch, captured)

    body = freezone_routes.FreezoneUpscaleRequest(
        source_url="/static/admin/58/freezone/_uploads/sample.png",
        scale_factor=2,
        image_size="2K",
        quality="low",
        model="HuiMeng GPT Image 2",
        style=freezone_routes.FreezoneImageStyleConfig(template_id="three_oclock_2300"),
        camera=freezone_routes.FreezoneImageCameraConfig(
            camera_body="Panavision DXL2",
            lens="Arri Signature Prime",
            focal_length_mm=35,
            aperture="f/4",
        ),
    )

    result = await freezone_routes.freezone_upscale(
        project=project,
        body=body,
        user={"username": username},
    )

    assert result["ok"] is True
    assert captured["aspect_ratio"] == "16:9"
    assert captured["quality"] == "low"
    assert "新古典插画" in captured["prompt"]
    assert "Panavision DXL2" in captured["prompt"]
    assert "Arri Signature Prime" in captured["prompt"]


@pytest.mark.asyncio
async def test_template_edit_projection_preserves_source_aspect_ratio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "59"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    source = project_dir / "freezone" / "_uploads" / "portrait.png"
    _write_image(source, size=(1080, 1920))

    captured: dict[str, object] = {}
    _patch_celery_edit_enqueue(monkeypatch, captured)

    body = freezone_routes.FreezoneTemplateEditRequest(
        source_url="/static/admin/59/freezone/_uploads/portrait.png",
        mode="image_projection_after_3s",
        image_size="2K",
        model=FREEZONE_DEFAULT_IMAGE_MODEL,
        quality="high",
    )

    result = await freezone_routes.freezone_template_edit(
        project=project,
        body=body,
        user={"username": username},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_edit"
    assert captured["aspect_ratio"] == "9:16"
    assert captured["quality"] == "high"
    assert "Preserve the source image aspect ratio" in captured["prompt"]
    assert "Within the same frame size" in captured["prompt"]
    assert "different action phase" in captured["prompt"]
    assert "black bars" in captured["prompt"]


@pytest.mark.asyncio
async def test_template_edit_light_correction_preserves_source_aspect_ratio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "59"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    source = project_dir / "freezone" / "_uploads" / "portrait.png"
    _write_image(source, size=(1080, 1920))

    captured: dict[str, object] = {}
    _patch_celery_edit_enqueue(monkeypatch, captured)

    body = freezone_routes.FreezoneTemplateEditRequest(
        source_url="/static/admin/59/freezone/_uploads/portrait.png",
        mode="cinematic_light_correction",
        image_size="2K",
        model=FREEZONE_DEFAULT_IMAGE_MODEL,
    )

    result = await freezone_routes.freezone_template_edit(
        project=project,
        body=body,
        user={"username": username},
    )

    assert result["ok"] is True
    assert captured["aspect_ratio"] == "9:16"
    assert "Preserve the source image aspect ratio" in captured["prompt"]
    assert "black bars" in captured["prompt"]


@pytest.mark.asyncio
async def test_template_edit_story_pitch_four_grid_preserves_source_aspect_ratio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "59"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    source = project_dir / "freezone" / "_uploads" / "portrait.png"
    _write_image(source, size=(1080, 1920))

    captured: dict[str, object] = {}
    _patch_celery_edit_enqueue(monkeypatch, captured)

    body = freezone_routes.FreezoneTemplateEditRequest(
        source_url="/static/admin/59/freezone/_uploads/portrait.png",
        mode="story_pitch_four_grid",
        image_size="2K",
        model=FREEZONE_DEFAULT_IMAGE_MODEL,
    )

    result = await freezone_routes.freezone_template_edit(
        project=project,
        body=body,
        user={"username": username},
    )

    assert result["ok"] is True
    assert captured["aspect_ratio"] == "9:16"
    assert "Each cell must preserve the source image aspect ratio" in captured["prompt"]


@pytest.mark.asyncio
async def test_template_edit_multi_camera_grid_preserves_source_aspect_ratio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "59"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    source = project_dir / "freezone" / "_uploads" / "portrait.png"
    _write_image(source, size=(1080, 1920))

    captured: dict[str, object] = {}
    _patch_celery_edit_enqueue(monkeypatch, captured)

    body = freezone_routes.FreezoneTemplateEditRequest(
        source_url="/static/admin/59/freezone/_uploads/portrait.png",
        mode="multi_camera_nine_grid",
        image_size="2K",
        model=FREEZONE_DEFAULT_IMAGE_MODEL,
    )

    result = await freezone_routes.freezone_template_edit(
        project=project,
        body=body,
        user={"username": username},
    )

    assert result["ok"] is True
    assert captured["aspect_ratio"] == "9:16"
    assert "Each cell must preserve the source image aspect ratio" in captured["prompt"]


@pytest.mark.asyncio
async def test_template_edit_storyboard_25_grid_preserves_source_aspect_ratio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    username = "admin"
    project = "59"
    project_dir, _output_dir = _patch_freezone_project(
        monkeypatch, tmp_path, username=username, project=project
    )
    source = project_dir / "freezone" / "_uploads" / "portrait.png"
    _write_image(source, size=(1080, 1920))

    captured: dict[str, object] = {}
    _patch_celery_edit_enqueue(monkeypatch, captured)

    body = freezone_routes.FreezoneTemplateEditRequest(
        source_url="/static/admin/59/freezone/_uploads/portrait.png",
        mode="storyboard_25_grid",
        image_size="2K",
        model=FREEZONE_DEFAULT_IMAGE_MODEL,
    )

    result = await freezone_routes.freezone_template_edit(
        project=project,
        body=body,
        user={"username": username},
    )

    assert result["ok"] is True
    assert captured["aspect_ratio"] == "9:16"
    assert "Each cell must preserve the source image aspect ratio" in captured["prompt"]


# ---------------------------------------------------------------------------
# C2: preset_managed explicit field + _is_preset_managed_canvas_node
# ---------------------------------------------------------------------------


def test_all_preset_node_factories_emit_preset_managed_true() -> None:
    """Every `_*_node` factory in `freezone/presets.py` must stamp
    `data.preset_managed = True` so `_is_preset_managed_canvas_node` can rely
    on explicit ownership only.
    """
    from novelvideo.freezone.presets import (
        _asset_image_node,
        _beat_context_node,
        _image_gen_node,
        _pano_360_viewer_node,
        _prompt_text_node,
        _skill_node,
        _text_node,
        _three_d_world_node,
        _upload_node,
    )

    beat_ctx = [{"kind": "beat", "projectId": "p", "episode": 1, "beat": 3}]
    nodes = [
        _text_node("t1", 0, 0, "L", "C"),
        _beat_context_node("b1", 0, 0, "L", "C", mainline_context=beat_ctx),
        _upload_node("u1", 0, 0, {"url": "/x.png", "role": "ref"}),
        _pano_360_viewer_node("p1", 0, 0, {"url": "/p.jpg"}),
        _three_d_world_node("d1", 0, 0, {"url": "/x.ply", "rel_path": "x.ply"}),
        _image_gen_node("g1", 0, 0, "L", "p"),
        _asset_image_node("a1", 0, 0, {"url": "/a.png", "role": "scene_master"}),
        _prompt_text_node("pt1", 0, 0, "L", "p"),
        _skill_node("s1", 0, 0, skill_id="freezone.sketch_from_context", display_name="Skill"),
    ]
    for node in nodes:
        assert (
            node["data"].get("preset_managed") is True
        ), f"factory output {node['id']} (type={node.get('type')}) missing preset_managed"


def test_is_preset_managed_canvas_node_prefers_explicit_field() -> None:
    """Explicit `preset_managed === True` is the ownership source of truth."""
    from novelvideo.api.routes.freezone import _is_preset_managed_canvas_node

    explicit = {"data": {"preset_managed": True, "user_spawned": True}}
    assert _is_preset_managed_canvas_node(explicit) is True


def test_is_preset_managed_canvas_node_requires_explicit_preset_flag() -> None:
    """Only the explicit current protocol grants preset ownership."""
    from novelvideo.api.routes.freezone import _is_preset_managed_canvas_node

    assert _is_preset_managed_canvas_node({"data": {"workflow_kind": "mainline"}}) is False
    assert _is_preset_managed_canvas_node({"data": {"workflow_kind": "mainline_slot"}}) is False
    assert (
        _is_preset_managed_canvas_node({"data": {"__freezone_source": {"kind": "beat_context"}}})
        is False
    )
    assert (
        _is_preset_managed_canvas_node(
            {
                "data": {
                    "__freezone_source": {
                        "kind": "scene",
                        "role": "scene_director_pano_360",
                    }
                }
            }
        )
        is False
    )
    assert (
        _is_preset_managed_canvas_node(
            {
                "data": {
                    "__freezone_source": {
                        "kind": "director",
                        "role": "scene_3gs_pano_ply",
                    }
                }
            }
        )
        is False
    )
    assert (
        _is_preset_managed_canvas_node(
            {"data": {"mainline_role": "context", "mainline_context": [{"kind": "beat"}]}}
        )
        is False
    )

    assert _is_preset_managed_canvas_node({"data": {"user_spawned": True}}) is False
    assert _is_preset_managed_canvas_node({"data": {}}) is False
    assert _is_preset_managed_canvas_node({"data": "not-a-dict"}) is False


def test_is_preset_managed_canvas_node_does_not_guess_from_mainline_context_only() -> None:
    """A legacy user node may carry mainline_context as provenance.

    That context alone is not enough to prove preset ownership; otherwise a
    restore refresh can delete user-created nodes that predate user_spawned.
    """
    from novelvideo.api.routes.freezone import _is_preset_managed_canvas_node

    assert (
        _is_preset_managed_canvas_node(
            {"data": {"imageUrl": "/dragged.png", "mainline_context": [{"kind": "beat"}]}}
        )
        is False
    )


def test_is_preset_managed_canvas_node_explicit_false_falls_through() -> None:
    """`preset_managed: False` is not preset ownership."""
    from novelvideo.api.routes.freezone import _is_preset_managed_canvas_node

    assert (
        _is_preset_managed_canvas_node(
            {"data": {"preset_managed": False, "workflow_kind": "mainline"}}
        )
        is False
    )


def _beat_skill_emit_payload(
    *,
    detected_identities: list[str] | None = None,
    detected_props: list[str] | None = None,
) -> dict:
    identity_ids = (
        detected_identities if detected_identities is not None else ["男青年_default", "男青年"]
    )
    prop_ids = detected_props if detected_props is not None else ["账单"]
    prop_id = prop_ids[0] if prop_ids else "账单"
    context = {
        "scope": "beat",
        "username": "admin",
        "project": "demo",
        "project_dir": "/tmp/project",
        "episode": 1,
        "beat": 8,
        "primary_slot": "render",
        "sketch_aspect_ratio": "2:3",
        "beat_data": {
            "beat_number": 8,
            "narration_segment": "男青年盯着桌上的账单。",
            "visual_description": "男青年坐在拉面馆木桌前。",
            "scene_ref": {"scene_id": "兰州拉面馆"},
            "detected_identities": identity_ids,
            "detected_props": prop_ids,
        },
        "refs": [
            {
                "kind": "sketch",
                "role": "current_sketch",
                "label": "当前草图",
                "rel_path": "sketches/ep001/beat_08.png",
                "url": "/static/admin/demo/sketches/ep001/beat_08.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 8},
            },
            {
                "kind": "frame",
                "role": "current_frame",
                "label": "当前分镜",
                "rel_path": "frames/ep001/beat_08.png",
                "url": "/static/admin/demo/frames/ep001/beat_08.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "2:3",
                "meta": {"episode": 1, "beat": 8},
            },
            {
                "kind": "director",
                "role": "selected_background",
                "label": "当前背景 · Beat 8",
                "rel_path": "director_control_frames/ep001/beat_08/selected_background.png",
                "url": (
                    "/static/admin/demo/"
                    "director_control_frames/ep001/beat_08/selected_background.png"
                ),
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 8},
            },
            {
                "kind": "director",
                "role": "director_combined",
                "label": "导演合成图",
                "rel_path": "director_control_frames/ep001/beat_08/combined.png",
                "url": "/static/admin/demo/director_control_frames/ep001/beat_08/combined.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "16:9",
                "meta": {"episode": 1, "beat": 8},
            },
            {
                "kind": "identity",
                "role": "character_identity",
                "label": "男青年 identity",
                "rel_path": "assets/characters/男青年/identities/default.png",
                "url": "/static/admin/demo/assets/characters/男青年/identities/default.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "1:1",
                "meta": {"character": "男青年", "identity_id": "男青年_default"},
            },
            {
                "kind": "identity",
                "role": "character_portrait",
                "label": "男青年 portrait",
                "rel_path": "assets/characters/男青年/portrait.png",
                "url": "/static/admin/demo/assets/characters/男青年/portrait.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "1:1",
                "meta": {"character": "男青年"},
            },
            {
                "kind": "prop",
                "role": "prop_reference",
                "label": prop_id,
                "rel_path": f"assets/props/{prop_id}/reference.png",
                "url": f"/static/admin/demo/assets/props/{prop_id}/reference.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "1:1",
                "meta": {"prop_id": prop_id},
            },
            {
                "kind": "scene",
                "role": "scene_master",
                "label": "兰州拉面馆 master",
                "rel_path": "assets/scenes/兰州拉面馆/master.png",
                "url": "/static/admin/demo/assets/scenes/兰州拉面馆/master.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "兰州拉面馆"},
            },
            {
                "kind": "scene",
                "role": "scene_reverse_master",
                "label": "兰州拉面馆 reverse master",
                "rel_path": "assets/scenes/兰州拉面馆/reverse_master.png",
                "url": "/static/admin/demo/assets/scenes/兰州拉面馆/reverse_master.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "16:9",
                "meta": {"scene_id": "兰州拉面馆"},
            },
            {
                "kind": "scene",
                "role": "scene_director_pano_360",
                "label": "兰州拉面馆 360",
                "rel_path": "director_worlds/兰州拉面馆/v1/pano_360.png",
                "url": "/static/admin/demo/director_worlds/兰州拉面馆/v1/pano_360.png",
                "exists": True,
                "media_type": "image",
                "aspect_ratio": "2:1",
                "meta": {"scene_id": "兰州拉面馆"},
            },
        ],
    }
    return build_canvas_payload_from_context(
        context=context,
        preset_key="beat:ep001:beat008:render",
        default_push_target={"kind": "frame", "episode": 1, "beat": 8},
        created_at="2026-05-27T00:00:00",
    )


def test_beat_preset_skill_node_emit_expected_skill_ids() -> None:
    payload = _beat_skill_emit_payload()

    skill_nodes = {node["id"]: node for node in payload["nodes"] if node.get("type") == "skillNode"}

    assert {node_id: node["data"].get("skill_id") for node_id, node in skill_nodes.items()} == {
        "skill_set_selected_background": "freezone.set_selected_background",
        "skill_set_director_combined": "freezone.set_director_combined",
        "skill_sketch_from_background": "freezone.sketch_from_context",
        "skill_sketch_from_director_combined": "freezone.sketch_from_director_combined",
        "skill_frame_from_context": "freezone.frame_from_context",
    }
    assert skill_nodes["skill_sketch_from_background"]["data"]["parameters"] == {
        "aspect_ratio": "2:3"
    }
    assert skill_nodes["skill_sketch_from_director_combined"]["data"]["parameters"] == {
        "aspect_ratio": "2:3"
    }
    assert skill_nodes["skill_frame_from_context"]["data"]["parameters"] == {
        "quality": "medium",
    }


def test_beat_preset_set_background_skill_embeds_scene_source_urls() -> None:
    payload = _beat_skill_emit_payload()
    skill_node = next(
        node for node in payload["nodes"] if node["id"] == "skill_set_selected_background"
    )

    assert skill_node["data"]["scene_source_urls"] == {
        "scene_id": "兰州拉面馆",
        "master_url": "/static/admin/demo/assets/scenes/兰州拉面馆/master.png",
        "reverse_url": "/static/admin/demo/assets/scenes/兰州拉面馆/reverse_master.png",
        "pano_360_url": "/static/admin/demo/director_worlds/兰州拉面馆/v1/pano_360.png",
        "director_env_only_url": None,
        "has_3gs": False,
    }


def test_beat_preset_does_not_project_scene_source_nodes() -> None:
    payload = _beat_skill_emit_payload()
    node_ids = {node["id"] for node in payload["nodes"]}

    assert not any(node_id.startswith("ref_scene_") for node_id in node_ids)


def test_beat_preset_skill_nodes_are_preset_managed() -> None:
    payload = _beat_skill_emit_payload()

    skill_nodes = [node for node in payload["nodes"] if node.get("type") == "skillNode"]

    assert skill_nodes
    assert all(node["data"].get("preset_managed") is True for node in skill_nodes)
    assert all(node.get("measured") == {"width": 380, "height": 520} for node in skill_nodes)
    assert all(
        node["data"].get("skill_schema_version") == SKILL_SCHEMA_VERSION for node in skill_nodes
    )


def test_beat_preset_skill_role_edges_target_handle_equals_role() -> None:
    payload = _beat_skill_emit_payload()

    role_edges = [
        edge
        for edge in payload["edges"]
        if (edge.get("data") or {}).get("edgeKind") == "role_binding"
        and str(edge.get("target") or "").startswith("skill_")
    ]

    actual = {
        (edge["source"], edge["target"], edge["data"]["role"], edge.get("targetHandle"))
        for edge in role_edges
    }
    assert actual == {
        ("context_beat", "skill_set_selected_background", "beat_context", "beat_context"),
        ("context_beat", "skill_set_director_combined", "beat_context", "beat_context"),
        ("context_beat", "skill_sketch_from_background", "beat_context", "beat_context"),
        ("context_beat", "skill_sketch_from_director_combined", "beat_context", "beat_context"),
        ("context_beat", "skill_frame_from_context", "beat_context", "beat_context"),
        ("ref_selected_background_1", "skill_sketch_from_background", "background", "background"),
        ("ref_selected_background_1", "skill_frame_from_context", "background", "background"),
        (
            "ref_director_combined_1",
            "skill_sketch_from_director_combined",
            "director_combined",
            "director_combined",
        ),
        ("ref_current_sketch_1", "skill_frame_from_context", "sketch", "sketch"),
        (
            "ref_character_identity_1",
            "skill_frame_from_context",
            "identity",
            "identity:男青年_default",
        ),
        ("ref_character_portrait_1", "skill_frame_from_context", "identity", "identity:男青年"),
        ("ref_prop_reference_1", "skill_frame_from_context", "prop", "prop:账单"),
    }
    edges_by_pair = {(edge["source"], edge["target"]): edge for edge in role_edges}
    assert edges_by_pair[("ref_character_identity_1", "skill_frame_from_context")]["data"][
        "reference_target"
    ] == {"kind": "identity", "identity_id": "男青年_default"}
    assert edges_by_pair[("ref_character_portrait_1", "skill_frame_from_context")]["data"][
        "reference_target"
    ] == {"kind": "identity", "identity_id": "男青年"}
    assert edges_by_pair[("ref_prop_reference_1", "skill_frame_from_context")]["data"][
        "reference_target"
    ] == {"kind": "prop", "prop_id": "账单"}


def test_beat_preset_does_not_duplicate_reference_skill_input_edges() -> None:
    payload = _beat_skill_emit_payload()

    reference_edges = [
        edge
        for edge in payload["edges"]
        if edge.get("target") == "skill_frame_from_context"
        and (edge.get("data") or {}).get("role") in {"identity", "prop"}
    ]
    binding_keys = [
        (
            edge.get("source"),
            edge.get("target"),
            edge.get("targetHandle"),
            json.dumps((edge.get("data") or {}).get("reference_target"), sort_keys=True),
        )
        for edge in reference_edges
    ]

    assert len(binding_keys) == len(set(binding_keys))


def test_beat_preset_prefers_identity_reference_over_portrait_for_same_identity() -> None:
    payload = _beat_skill_emit_payload(detected_identities=["男青年_default"])

    identity_edges = [
        edge
        for edge in payload["edges"]
        if edge.get("target") == "skill_frame_from_context"
        and (edge.get("data") or {}).get("role") == "identity"
        and edge.get("targetHandle") == "identity:男青年_default"
    ]

    assert len(identity_edges) == 1
    assert identity_edges[0]["source"] == "ref_character_identity_1"


def test_beat_preset_does_not_connect_no_prop_marker_as_skill_prop_input() -> None:
    payload = _beat_skill_emit_payload(detected_props=["__NO_PROP__"])

    prop_edges = [
        edge
        for edge in payload["edges"]
        if (edge.get("data") or {}).get("role") == "prop"
        and edge.get("target") == "skill_frame_from_context"
    ]

    assert prop_edges == []


def test_beat_preset_skill_role_edges_match_skill_registry_inputs() -> None:
    from novelvideo.freezone.skill_registry import get_skill

    payload = _beat_skill_emit_payload()
    skill_ids_by_node_id = {
        node["id"]: node["data"].get("skill_id")
        for node in payload["nodes"]
        if node.get("type") == "skillNode"
    }
    inputs_by_skill_id = {
        skill_id: {input_spec.role for input_spec in get_skill(skill_id).inputs}
        for skill_id in skill_ids_by_node_id.values()
    }

    role_edges = [
        edge
        for edge in payload["edges"]
        if (edge.get("data") or {}).get("edgeKind") == "role_binding"
        and edge.get("target") in skill_ids_by_node_id
    ]

    assert role_edges
    for edge in role_edges:
        skill_id = skill_ids_by_node_id[edge["target"]]
        role = edge["data"]["role"]
        target_handle_role = str(edge.get("targetHandle") or "").split(":", 1)[0]
        assert role in inputs_by_skill_id[skill_id]
        assert target_handle_role == role


def test_beat_preset_skill_outputs_feed_canonical_slots() -> None:
    payload = _beat_skill_emit_payload()
    edges_by_pair = {(edge["source"], edge["target"]): edge for edge in payload["edges"]}

    assert ("skill_sketch_from_background", "ref_current_sketch_1") in edges_by_pair
    assert ("skill_sketch_from_director_combined", "ref_current_sketch_1") in edges_by_pair
    assert ("skill_set_selected_background", "ref_selected_background_1") in edges_by_pair
    assert ("skill_set_director_combined", "ref_director_combined_1") in edges_by_pair
    assert ("skill_frame_from_context", "ref_current_frame_1") in edges_by_pair
    assert (
        edges_by_pair[("skill_set_selected_background", "ref_selected_background_1")][
            "sourceHandle"
        ]
        == "selected_background"
    )
    assert (
        edges_by_pair[("skill_set_director_combined", "ref_director_combined_1")]["sourceHandle"]
        == "director_combined"
    )
    assert (
        edges_by_pair[("skill_sketch_from_background", "ref_current_sketch_1")]["sourceHandle"]
        == "current_sketch_candidate"
    )
    assert (
        edges_by_pair[("skill_sketch_from_director_combined", "ref_current_sketch_1")][
            "sourceHandle"
        ]
        == "current_sketch_candidate"
    )
    assert (
        edges_by_pair[("skill_frame_from_context", "ref_current_frame_1")]["sourceHandle"]
        == "current_frame_candidate"
    )

    assert ("ref_current_sketch_1", "ref_current_frame_1") not in edges_by_pair
    assert ("ref_character_identity_1", "ref_current_frame_1") not in edges_by_pair
    assert ("ref_prop_reference_1", "ref_current_frame_1") not in edges_by_pair


def test_beat_preset_edges_are_preset_managed() -> None:
    payload = _beat_skill_emit_payload()

    assert payload["edges"]
    assert all((edge.get("data") or {}).get("preset_managed") is True for edge in payload["edges"])


def test_beat_preset_canonical_source_nodes_have_no_typed_action_fields() -> None:
    payload = _beat_skill_emit_payload()
    canonical_node_ids = {
        "ref_current_sketch_1",
        "ref_current_frame_1",
        "ref_selected_background_1",
        "ref_director_combined_1",
    }
    typed_action_fields = {
        "workflow_kind",
        "typed_backend_action",
        "typed_action_options",
        "typed_action_input_refs",
        "output_candidate_role",
        "source_ids",
    }

    nodes = {node["id"]: node for node in payload["nodes"]}

    assert canonical_node_ids <= set(nodes)
    for node_id in canonical_node_ids:
        assert typed_action_fields.isdisjoint((nodes[node_id].get("data") or {}).keys())


# ---------------------------------------------------------------------------
# C3: _merge_restored_preset_canvas — three contract scenarios
# ---------------------------------------------------------------------------


def test_merge_replaces_preset_managed_nodes_when_new_emit_supersedes() -> None:
    """Refresh contract: when preset re-emit produces a new node with the
    same id, the existing node with `preset_managed: true` is **replaced**
    (not merged). This is the canonical behavior — preset owns the node's
    position/data fully.
    """
    new_payload = {
        "nodes": [
            {
                "id": "scene_master_1",
                "position": {"x": 100, "y": 100},
                "data": {
                    "preset_managed": True,
                    "imageUrl": "/new/master.png",
                    "displayName": "scene master (refreshed)",
                },
            },
        ],
        "edges": [],
        "viewport": None,
    }
    existing_payload = {
        "nodes": [
            {
                "id": "scene_master_1",
                "position": {"x": 50, "y": 50},  # old position
                "data": {
                    "preset_managed": True,
                    "imageUrl": "/old/master.png",  # old url
                    "displayName": "scene master (stale)",
                },
            },
        ],
        "edges": [],
        "viewport": {"x": 0, "y": 0, "zoom": 1.0},
    }

    merged = _merge_restored_preset_canvas(new_payload, existing_payload)

    scene_master_nodes = [n for n in merged["nodes"] if n["id"] == "scene_master_1"]
    assert len(scene_master_nodes) == 1, "no duplicate after merge"
    node = scene_master_nodes[0]
    # New emit's content wins entirely.
    assert node["data"]["imageUrl"] == "/new/master.png"
    assert node["position"] == {"x": 100, "y": 100}


def test_merge_preserves_user_spawned_nodes_across_refresh() -> None:
    """User-spawned nodes must survive refresh.

    They represent work the user did on top of the preset layer (relight
    children, drag-ins, ad-hoc uploads etc.).
    """
    new_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "Beat ctx"},
            },
        ],
        "edges": [],
        "viewport": None,
    }
    existing_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "Beat ctx (old)"},
            },
            {
                "id": "user_relit_child",
                "data": {
                    "user_spawned": True,
                    "displayName": "relit candidate",
                    "imageUrl": "/relit.png",
                    "slot_target": {"kind": "frame", "episode": 1, "beat": 3},
                    "committed_slot_url": "/canonical/frame.png",
                },
            },
            {
                "id": "drag_in_sketch",
                "data": {
                    "user_spawned": True,
                    "imageUrl": "/dragged.png",
                    "mainline_context": [
                        {"kind": "sketch", "projectId": "p", "episode": 1, "beat": 3}
                    ],
                },
            },
        ],
        "edges": [
            {
                "id": "free_edge",
                "source": "user_relit_child",
                "target": "drag_in_sketch",
            },
        ],
        "viewport": None,
    }

    merged = _merge_restored_preset_canvas(new_payload, existing_payload)
    node_ids = {n["id"] for n in merged["nodes"]}
    assert "user_relit_child" in node_ids, "relit child preserved"
    assert "drag_in_sketch" in node_ids, "drag-in sketch preserved"
    assert "context_beat" in node_ids, "preset re-emit present"
    # Free edge between two user_spawned nodes survives.
    edge_ids = {e["id"] for e in merged["edges"]}
    assert "free_edge" in edge_ids


def test_merge_preserves_existing_nodes_without_id_across_refresh() -> None:
    new_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "Beat ctx"},
            },
        ],
        "edges": [],
        "viewport": None,
    }
    orphan_user_note = {
        "type": "textNode",
        "data": {
            "displayName": "manual note without id",
            "user_spawned": True,
        },
    }
    existing_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "Beat ctx (old)"},
            },
            orphan_user_note,
        ],
        "edges": [],
        "viewport": None,
    }

    merged = _merge_restored_preset_canvas(new_payload, existing_payload)

    assert orphan_user_note in merged["nodes"]


def test_merge_preserves_user_edge_between_preset_nodes_across_refresh() -> None:
    new_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "Beat ctx"},
            },
            {
                "id": "skill_frame",
                "data": {"preset_managed": True, "displayName": "Frame skill"},
            },
        ],
        "edges": [
            {
                "id": "preset_context_to_skill",
                "source": "context_beat",
                "target": "skill_frame",
                "data": {"preset_managed": True, "role": "beat_context"},
            },
        ],
        "viewport": None,
    }
    existing_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "Beat ctx (old)"},
            },
            {
                "id": "skill_frame",
                "data": {"preset_managed": True, "displayName": "Frame skill (old)"},
            },
        ],
        "edges": [
            {
                "id": "preset_context_to_skill",
                "source": "context_beat",
                "target": "skill_frame",
                "data": {"preset_managed": True, "role": "beat_context"},
            },
            {
                "id": "user_debug_link",
                "source": "context_beat",
                "target": "skill_frame",
                "data": {"edgeKind": "role_binding", "role": "sketch"},
            },
        ],
        "viewport": None,
    }

    merged = _merge_restored_preset_canvas(new_payload, existing_payload)

    edge_ids = {edge["id"] for edge in merged["edges"]}
    assert "preset_context_to_skill" in edge_ids
    assert "user_debug_link" in edge_ids


def test_merge_legacy_canvas_without_explicit_field_does_not_guess_removed_nodes() -> None:
    """Pre-release nodes without explicit ownership are preserved.

    Same-id nodes are still replaced by the new preset payload, but nodes that
    only look preset-like via old fields are no longer deleted.
    """
    new_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "fresh beat ctx"},
            },
            {
                "id": "workflow_beat_to_sketch",
                "data": {"preset_managed": True, "workflow_kind": "mainline_slot"},
            },
        ],
        "edges": [],
        "viewport": None,
    }
    # Existing canvas: NO explicit preset_managed anywhere (pre-release save).
    existing_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {
                    "mainline_role": "context",
                    "mainline_context": [{"kind": "beat", "projectId": "p"}],
                    "displayName": "stale beat ctx",
                },
            },
            {
                "id": "workflow_beat_to_sketch",
                "data": {"workflow_kind": "mainline"},
            },
            {
                "id": "removed_legacy_workflow",
                "data": {"workflow_kind": "mainline"},
            },
            {
                "id": "legit_user_node",
                "data": {"imageUrl": "/user.png"},  # no flags at all → user_spawned
            },
        ],
        "edges": [],
        "viewport": None,
    }

    merged = _merge_restored_preset_canvas(new_payload, existing_payload)
    node_ids = {n["id"] for n in merged["nodes"]}
    # Same-id nodes are replaced with the new emit (one copy each).
    assert sum(1 for n in merged["nodes"] if n["id"] == "context_beat") == 1
    assert sum(1 for n in merged["nodes"] if n["id"] == "workflow_beat_to_sketch") == 1
    assert "legit_user_node" in node_ids
    assert "removed_legacy_workflow" in node_ids
    # Verify it's the *new* preset content, not the stale one.
    fresh_beat = next(n for n in merged["nodes"] if n["id"] == "context_beat")
    assert fresh_beat["data"].get("displayName") == "fresh beat ctx"


def test_merge_preserves_legacy_user_node_with_mainline_context_only() -> None:
    new_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "fresh beat ctx"},
            }
        ],
        "edges": [],
        "viewport": None,
    }
    existing_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {
                    "mainline_role": "context",
                    "mainline_context": [{"kind": "beat", "projectId": "p"}],
                    "displayName": "stale beat ctx",
                },
            },
            {
                "id": "legacy_dragged_candidate",
                "data": {
                    "imageUrl": "/dragged.png",
                    "mainline_context": [{"kind": "beat", "projectId": "p"}],
                },
            },
        ],
        "edges": [],
        "viewport": None,
    }

    merged = _merge_restored_preset_canvas(new_payload, existing_payload)

    node_ids = {n["id"] for n in merged["nodes"]}
    assert "legacy_dragged_candidate" in node_ids


def test_merge_preserves_pre_release_scene_source_nodes_without_explicit_flag() -> None:
    """Beat preset no longer projects scene source nodes directly.

    Old saved canvases can contain pano/3GS nodes without explicit
    `preset_managed`. Those pre-release nodes are preserved rather than guessed
    as preset-owned and deleted.
    """
    new_payload = {
        "nodes": [
            {
                "id": "context_beat",
                "data": {"preset_managed": True, "displayName": "fresh beat ctx"},
            }
        ],
        "edges": [],
        "viewport": None,
    }
    existing_payload = {
        "nodes": [
            {
                "id": "ref_scene_director_pano_360_1",
                "data": {
                    "__freezone_source": {
                        "kind": "scene",
                        "role": "scene_director_pano_360",
                    },
                    "displayName": "兰州拉面馆 director pano 360",
                },
            },
            {
                "id": "ref_scene_3gs_pano_ply_1",
                "data": {
                    "__freezone_source": {
                        "kind": "director",
                        "role": "scene_3gs_pano_ply",
                    },
                    "displayName": "兰州拉面馆 3D 世界（360）",
                },
            },
            {
                "id": "user_upload",
                "data": {"imageUrl": "/user.png"},
            },
        ],
        "edges": [
            {
                "id": "edge_old_scene_to_user",
                "source": "ref_scene_director_pano_360_1",
                "target": "user_upload",
            }
        ],
        "viewport": None,
    }

    merged = _merge_restored_preset_canvas(new_payload, existing_payload)
    node_ids = {n["id"] for n in merged["nodes"]}
    edge_ids = {e["id"] for e in merged["edges"]}

    assert "context_beat" in node_ids
    assert "user_upload" in node_ids
    assert "ref_scene_director_pano_360_1" in node_ids
    assert "ref_scene_3gs_pano_ply_1" in node_ids
    assert "edge_old_scene_to_user" in edge_ids
