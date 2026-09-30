"""参考图转白模：HTTP 接入层（路由 → 入队、结果接口、计费询价）。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import FreezoneImageToBlockoutRequest
from novelvideo.project_context import ProjectContext

FIXTURES = Path(__file__).parent / "fixtures" / "previz_blockout"
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


# --------------------------------------------------------------------------
# 路由
# --------------------------------------------------------------------------


@pytest.fixture
def route_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    project_dir = tmp_path / "project"
    ctx = _project_ctx(tmp_path)

    async def fake_resolve(*_args, **_kwargs):
        return ctx, "admin", "58", project_dir, str(tmp_path / "output")

    captured: list[dict] = []

    async def fake_enqueue_project_task(_ctx: ProjectContext, **kwargs):
        captured.append(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_blockout"),
            backend="celery",
            queue="node.node_a.default",
        )

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )
    monkeypatch.delenv("PREVIZ_BLOCKOUT_MODEL", raising=False)

    def write(name: str) -> str:
        path = project_dir / "freezone" / "_uploads" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (64, 36), (120, 130, 140)).save(path, format="PNG")
        return f"/static/admin/58/freezone/_uploads/{name}"

    return SimpleNamespace(
        project_dir=project_dir, captured=captured, write=write, ctx=ctx
    )


async def test_route_enqueues_the_job_with_feature_billing(route_env, monkeypatch):
    monkeypatch.setenv("PREVIZ_BLOCKOUT_MODEL", "blockout-model")
    source_url = route_env.write("reference.png")

    result = await freezone_routes.freezone_image_to_blockout(
        project="58",
        body=FreezoneImageToBlockoutRequest(
            source_url=source_url,
            description="  层高 3 米  ",
            picture_check=True,
            canvas_id="canvas_1",
            node_id="node_1",
        ),
        user={"username": "admin"},
    )

    assert result["data"]["task_type"] == TASK_TYPE
    (call,) = route_env.captured
    assert call["task_type"] == TASK_TYPE
    assert call["product_surface"] == "freezone"
    assert call["queue_kind"] == "default"
    assert call["scope"] == call["payload"]["job_id"] == result["data"]["job_id"]
    assert call["payload"] == {
        "job_id": call["payload"]["job_id"],
        "project_dir": str(route_env.project_dir),
        "source_path": (
            route_env.project_dir / "freezone" / "_uploads" / "reference.png"
        ).as_posix(),
        "description": "层高 3 米",
        "picture_check": True,
        "canvas_id": "canvas_1",
        "node_id": "node_1",
        "billing": {
            "feature_key": "freezone.image_to_blockout",
            "operation": "image_to_blockout",
            "pricing_kind": "text",
            "pricing_model": "blockout-model",
            "pricing_params": {},
            "pricing_quantity": 1,
            "pricing_metrics": {"call_count": 1, "item_count": 1},
        },
    }


@pytest.mark.parametrize(
    ("source_url", "status"),
    [
        ("/static/admin/58/freezone/_uploads/missing.png", 404),
        ("/static/admin/58/freezone/_uploads/notes.txt", 400),
        ("/static/admin/58/../../etc/passwd", 400),
        ("https://example.com/a.png", 400),
        ("", 400),
    ],
)
async def test_route_refuses_sources_it_cannot_read(route_env, source_url, status):
    route_env.write("notes.txt")

    with pytest.raises(HTTPException) as caught:
        await freezone_routes.freezone_image_to_blockout(
            project="58",
            body=FreezoneImageToBlockoutRequest(source_url=source_url),
            user={"username": "admin"},
        )

    assert caught.value.status_code == status
    assert route_env.captured == []


async def test_route_accepts_an_upper_case_extension(route_env):
    """相机和 Windows 导出的文件常是大写后缀。"""
    path = route_env.project_dir / "freezone" / "_uploads" / "ROOM.JPG"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 36), (10, 10, 10)).save(path, format="JPEG")

    result = await freezone_routes.freezone_image_to_blockout(
        project="58",
        body=FreezoneImageToBlockoutRequest(
            source_url="/static/admin/58/freezone/_uploads/ROOM.JPG"
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert route_env.captured[0]["payload"]["source_path"].endswith("ROOM.JPG")


async def test_route_accepts_an_image_of_any_size_and_shape(route_env):
    """只提示不拒绝：尺寸、比例、内容都不是拒收理由。"""
    path = route_env.project_dir / "freezone" / "_uploads" / "tiny.webp"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (40, 400), (10, 10, 10)).save(path, format="WEBP")

    result = await freezone_routes.freezone_image_to_blockout(
        project="58",
        body=FreezoneImageToBlockoutRequest(
            source_url="/static/admin/58/freezone/_uploads/tiny.webp"
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert len(route_env.captured) == 1


def test_request_refuses_an_oversized_description():
    from pydantic import ValidationError

    FreezoneImageToBlockoutRequest(source_url="/static/a.png", description="长" * 2000)
    with pytest.raises(ValidationError):
        FreezoneImageToBlockoutRequest(
            source_url="/static/a.png", description="长" * 2001
        )


# --------------------------------------------------------------------------
# 结果接口
# --------------------------------------------------------------------------


def _patch_task(monkeypatch, task):
    class FakeManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return task

        def get_task(self, *_args, **_kwargs):
            return task

    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())


async def test_job_result_returns_the_objects_from_disk(route_env, monkeypatch):
    out = route_env.project_dir / "freezone" / "_outputs" / TASK_TYPE / "job1"
    out.mkdir(parents=True)
    payload = {
        "objects": GOLDEN["compiled"]["objects"],
        "reference_camera_id": "blockout-cam",
        "counts": {"prop": 15, "camera": 1},
        "warnings": [],
        "compiler_version": 1,
    }
    (out / "result.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )
    _patch_task(monkeypatch, None)

    result = await freezone_routes.freezone_job_result(
        project="58", task_type=TASK_TYPE, job_id="job1", user={"username": "admin"}
    )

    assert result == {"ok": True, "data": payload}


async def test_job_result_of_a_failed_job_carries_the_reason(route_env, monkeypatch):
    _patch_task(
        monkeypatch,
        SimpleNamespace(
            status="failed",
            error="场景过于复杂：编译后 212 件，超过上限 150 件",
            logs=[],
            current_task="",
            result=None,
        ),
    )

    result = await freezone_routes.freezone_job_result(
        project="58", task_type=TASK_TYPE, job_id="job1", user={"username": "admin"}
    )

    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["error"].startswith("场景过于复杂")


async def test_job_result_of_a_running_job_says_so(route_env, monkeypatch):
    _patch_task(
        monkeypatch,
        SimpleNamespace(
            status="running",
            error=None,
            logs=[],
            current_task="正在根据参考图搭建白模...",
            result=None,
        ),
    )

    result = await freezone_routes.freezone_job_result(
        project="58", task_type=TASK_TYPE, job_id="job1", user={"username": "admin"}
    )

    assert result["ok"] is False
    assert result["status"] == "running"


# --------------------------------------------------------------------------
# 计费询价
# --------------------------------------------------------------------------


def test_billing_is_one_unit_per_job_whatever_the_caller_sends(monkeypatch):
    from novelvideo.api.routes import model_credits

    monkeypatch.setenv("PREVIZ_BLOCKOUT_MODEL", "blockout-model")

    assert model_credits._feature_billing_params(
        "freezone.image_to_blockout",
        {"operation": "image_to_blockout", "pricing_quantity": 99},
    ) == {
        "operation": "image_to_blockout",
        "pricing_kind": "text",
        "pricing_model": "blockout-model",
        "pricing_params": {},
        "pricing_quantity": 1,
        "pricing_metrics": {"call_count": 1, "item_count": 1},
    }
