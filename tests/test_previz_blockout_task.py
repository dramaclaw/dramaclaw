"""参考图转白模：任务执行层（runner、登记）。路由和结果接口在 test_previz_blockout_route.py。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from novelvideo.director_world.blockout.artifacts import (
    BlockoutAttempt,
    BlockoutGeneration,
    BlockoutGenerationError,
)
from novelvideo.director_world.blockout.compiler import compile_scene
from novelvideo.director_world.blockout.dsl_parser import parse_blockout_program
from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.runners import freezone as freezone_runners

FIXTURES = Path(__file__).parent / "fixtures" / "previz_blockout"
GOLDEN_PROGRAM = (FIXTURES / "golden.blockout.dsl").read_text(encoding="utf-8")
GOLDEN = json.loads((FIXTURES / "golden.json").read_text(encoding="utf-8"))
TASK_TYPE = "freezone_image_to_blockout"


def _project_ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_blockout",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "project",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def _organization_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="proj_blockout",
        task_type=TASK_TYPE,
        requester_user_id="owner_1",
        root_task_id="task-1",
        admission_id="admission-1",
        admitted_at="2026-09-29T04:05:00Z",
        membership_id="membership-1",
        authz_version=11,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=7,
            org_id="org-1",
        ),
    )


def _generation(warnings: tuple[str, ...] = ()) -> BlockoutGeneration:
    scene = parse_blockout_program(GOLDEN_PROGRAM)
    return BlockoutGeneration(
        model="fake-model",
        program=GOLDEN_PROGRAM.strip(),
        scene=scene,
        compiled=compile_scene(scene),
        warnings=warnings,
        attempts=(
            BlockoutAttempt("scene.box(id='a')", ("第 1 行：box 缺少参数 position",), 1.5),
            BlockoutAttempt(GOLDEN_PROGRAM.strip(), (), 2.5),
        ),
        image_sha256="0" * 64,
        image_size=(1280, 720),
    )


class _TaskManager:
    def __init__(self) -> None:
        self.progress: list[tuple[float, str]] = []

    def update_progress_for_project(self, _ctx, _task_type, _episode, **kwargs) -> None:
        self.progress.append((kwargs["progress"], kwargs["current_task"]))


@pytest.fixture
def runner_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    manager = _TaskManager()
    monkeypatch.setattr(freezone_runners, "get_task_manager", lambda: manager)
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, rel, **_k: f"/static/{rel}",
    )
    project_dir = tmp_path / "project"
    source = project_dir / "freezone" / "_uploads" / "reference.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 36), (120, 130, 140)).save(source)
    calls: list[dict] = []

    def install(outcome):
        async def leaf(
            *, image_path, description="", picture_check=None, egress_context=None
        ):
            calls.append(
                {
                    "image_path": image_path,
                    "description": description,
                    "picture_check": picture_check,
                    "egress_context": egress_context,
                }
            )
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        monkeypatch.setattr(
            "novelvideo.director_world.blockout.generation_agent."
            "generate_blockout_from_image",
            leaf,
        )

    payload = {
        "job_id": "job1",
        "project_dir": str(project_dir),
        "source_path": source.as_posix(),
        "description": "层高 3 米",
    }
    return SimpleNamespace(
        install=install,
        calls=calls,
        manager=manager,
        project_dir=project_dir,
        source=source,
        payload=payload,
        ctx=_project_ctx(tmp_path),
        out_dir=project_dir / "freezone" / "_outputs" / TASK_TYPE / "job1",
    )


async def test_runner_writes_the_artifacts_and_returns_a_summary(runner_env):
    runner_env.install(_generation(warnings=("物件 stool 离地 0.3 米",)))

    result = await freezone_runners._run_freezone_image_to_blockout_async(
        {"task_type": TASK_TYPE, "payload": runner_env.payload}, runner_env.ctx
    )

    assert runner_env.calls == [
        {
            "image_path": runner_env.source,
            "description": "层高 3 米",
            "picture_check": None,
            "egress_context": None,
        }
    ]
    assert sorted(path.name for path in runner_env.out_dir.iterdir()) == [
        "generation.json",
        "result.json",
        "scene.blockout.dsl",
        "scene_ir.json",
    ]
    assert result == {
        "job_id": "job1",
        "output_format": "json",
        "output_path": str(runner_env.out_dir / "result.json"),
        "output_url": f"/static/freezone/_outputs/{TASK_TYPE}/job1/result.json",
        "reference_camera_id": "blockout-cam",
        "counts": {"prop": 15, "camera": 1},
        "warnings": ["物件 stool 离地 0.3 米"],
        "compiler_version": 1,
        "model": "fake-model",
        "retries": 1,
    }
    written = json.loads((runner_env.out_dir / "result.json").read_text("utf-8"))
    assert written["objects"] == GOLDEN["compiled"]["objects"]
    assert [step[0] for step in runner_env.manager.progress] == [0.1, 0.9]


async def test_runner_summary_does_not_carry_the_object_list(runner_env):
    runner_env.install(_generation())

    result = await freezone_runners._run_freezone_image_to_blockout_async(
        {"task_type": TASK_TYPE, "payload": runner_env.payload}, runner_env.ctx
    )

    assert "objects" not in result
    assert len(json.dumps(result, ensure_ascii=False)) < 1000


async def test_runner_hands_the_organization_identity_to_the_leaf(runner_env):
    runner_env.install(_generation())
    context = _organization_context()
    envelope = TrustedRunnerEnvelope(
        {
            "task_type": TASK_TYPE,
            "payload": runner_env.payload,
            TRUSTED_EGRESS_CONTEXT_KEY: context,
        }
    )

    await freezone_runners._run_freezone_image_to_blockout_async(
        envelope, runner_env.ctx
    )

    assert runner_env.calls[0]["egress_context"] is context


async def test_runner_keeps_the_failed_programs_and_reraises(runner_env):
    error = BlockoutGenerationError(
        "模型连续 3 次没有写出合法的场景程序：第 1 行：不允许 import",
        model="fake-model",
        attempts=(BlockoutAttempt("import os", ("第 1 行：不允许 import",), 1.0),),
        image_sha256="0" * 64,
        image_size=(1280, 720),
    )
    runner_env.install(error)

    with pytest.raises(BlockoutGenerationError, match="没有写出合法的场景程序"):
        await freezone_runners._run_freezone_image_to_blockout_async(
            {"task_type": TASK_TYPE, "payload": runner_env.payload}, runner_env.ctx
        )

    assert sorted(path.name for path in runner_env.out_dir.iterdir()) == [
        "generation.json",
        "scene.blockout.dsl",
    ]
    record = json.loads((runner_env.out_dir / "generation.json").read_text("utf-8"))
    assert record["error"] == str(error)


async def test_runner_leaves_no_result_when_the_model_call_fails(runner_env):
    runner_env.install(RuntimeError("视觉模型返回空内容"))

    with pytest.raises(RuntimeError, match="视觉模型返回空内容"):
        await freezone_runners._run_freezone_image_to_blockout_async(
            {"task_type": TASK_TYPE, "payload": runner_env.payload}, runner_env.ctx
        )

    assert not (runner_env.out_dir / "result.json").exists()


def test_the_task_type_is_registered_with_its_label_and_resource_kind():
    import novelvideo.task_backend.runners  # noqa: F401
    from novelvideo.api.routes import tasks as tasks_routes
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import (
        get_project_task_runner,
        project_task_requires_home_node,
    )

    assert (
        get_project_task_runner(TASK_TYPE)
        is freezone_runners.run_freezone_image_to_blockout
    )
    assert project_task_requires_home_node(TASK_TYPE) is False
    assert run_core._PROJECT_TASK_RESOURCE_KINDS[TASK_TYPE] == "script"
    labels = [
        value
        for value in vars(tasks_routes).values()
        if isinstance(value, dict) and value.get("freezone_image_reverse_prompt")
    ]
    assert labels and all(table[TASK_TYPE] == "参考图转白模" for table in labels)


async def test_runner_passes_the_picture_check_option_to_the_leaf(runner_env):
    runner_env.install(_generation())

    await freezone_runners._run_freezone_image_to_blockout_async(
        {"task_type": TASK_TYPE, "payload": {**runner_env.payload, "picture_check": True}},
        runner_env.ctx,
    )

    assert runner_env.calls[0]["picture_check"] is True
