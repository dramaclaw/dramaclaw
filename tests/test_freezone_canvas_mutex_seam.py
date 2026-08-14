"""TCP-EU-C4 · 画布互斥的版本接缝 ＋ 落盘围栏（CE 半边）。

设计真源 `docs/org-billing-ai-development/task-control-plane/B2-canvas-placement-free.md`
§3.3.3（落盘围栏）、§3.7（换 context manager，不重写 `save_canvas`）、§3.8（版本接缝）。

本模块只证 **CE 侧**的三件事，一条 Postgres 都不碰：

1. 接缝存在且**默认退化成今天的文件锁** —— 回滚动作是「不注入 EE 实现」（§6.4 步 5），
   所以「没注入」必须是合法状态，且行为与今天逐字相同（B2-8/B2-9）。
2. `atomic_write_json` 的 `fence=` 落在「临时文件已 fsync、`os.replace` 还没发生」之间
   （§3.3.3）。挪一行就等于没有围栏，所以这里用**观察落点**而不是观察调用次数。
3. 围栏覆盖面的**静态断言**：`atomic_write_json` 的每一条写路径要么带 `fence=`，
   要么在 §3.3.3 那张表里被显式豁免；外加 `soft_delete_canvas` 的
   `path.replace(target)`（不走 `atomic_write_json` 的那个不可逆落盘）之前必须显式再挂一道。

EE 的租约实现、自旋契约与跨进程判据在 EE 仓 `tests/b2b/test_canvas_write_lease_client.py`。
"""

from __future__ import annotations

import ast
import inspect
import json
from contextlib import contextmanager
from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_lock import CanvasLockBusy, canvas_write_lock
from novelvideo.ports import get_canvas_write_mutex
from novelvideo.ports import registry as ports_registry
from novelvideo.ports.canvas_mutex import CanvasLeaseLost
from novelvideo.ports.local.canvas_mutex import FileLockCanvasWriteMutex


# ---------------------------------------------------------------------------
# 测试替身：一个记账用的互斥端口。它不做任何互斥 —— 本模块要证的是「接缝把该调
# 的都调了」，真正的互斥语义归 EE 仓那份用例。
# ---------------------------------------------------------------------------


class _RecordingGuard:
    def __init__(self, mutex: "_RecordingMutex", canvas_id: str) -> None:
        self._mutex = mutex
        self._canvas_id = canvas_id

    def reassert(self) -> None:
        self._mutex.fence_calls.append(self._canvas_id)
        if self._mutex.fence_error is not None:
            raise self._mutex.fence_error


class _RecordingMutex:
    def __init__(self, *, fence_error: Exception | None = None) -> None:
        self.entered: list[tuple[Path, str]] = []
        self.exited: list[tuple[Path, str]] = []
        self.fence_calls: list[str] = []
        self.fence_error = fence_error

    @contextmanager
    def write_mutex(self, project_dir: Path, canvas_id: str, **_kwargs):
        self.entered.append((Path(project_dir), canvas_id))
        try:
            yield _RecordingGuard(self, canvas_id)
        finally:
            self.exited.append((Path(project_dir), canvas_id))


@pytest.fixture()
def injected_mutex():
    """注入一个记账端口，测试结束后把注册表恢复原状。"""

    previous = ports_registry._PORTS.get("canvas_write_mutex")

    def _install(mutex: _RecordingMutex) -> _RecordingMutex:
        ports_registry.register_port("canvas_write_mutex", mutex)
        return mutex

    try:
        yield _install
    finally:
        if previous is None:
            ports_registry._PORTS.pop("canvas_write_mutex", None)
        else:
            ports_registry.register_port("canvas_write_mutex", previous)


def _seed_canvas(
    project_dir: Path, canvas_id: str = "default", revision: int = 1
) -> Path:
    path = project_dir / "freezone" / "canvases" / f"{canvas_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"revision": revision, "nodes": [{"id": "seed"}], "edges": []}),
        encoding="utf-8",
    )
    return path


# ---------------------------------------------------------------------------
# 错误面：`CanvasLeaseLost` 继承 `CanvasLockBusy`，于是路由零改动（§3.3.3）
# ---------------------------------------------------------------------------


def test_canvas_lease_lost_is_a_canvas_lock_busy() -> None:
    assert issubclass(CanvasLeaseLost, CanvasLockBusy)

    exc = CanvasLeaseLost("default")

    assert exc.canvas_id == "default"
    # 类型上仍可区分：日志与用例要能把「等不到租约」和「写到一半丢了租约」分开统计。
    assert str(exc) != str(CanvasLockBusy("default"))


# ---------------------------------------------------------------------------
# 接缝：默认退化成今天的文件锁（回滚 ＝ 不注入）
# ---------------------------------------------------------------------------


def test_canvas_write_mutex_defaults_to_the_file_lock() -> None:
    assert isinstance(get_canvas_write_mutex(), FileLockCanvasWriteMutex)


def test_ce_canvas_mutex_signature_has_no_catch_all_kwargs() -> None:
    parameters = inspect.signature(
        FileLockCanvasWriteMutex.write_mutex
    ).parameters.values()

    assert all(
        parameter.kind is not inspect.Parameter.VAR_KEYWORD for parameter in parameters
    )


def test_canvas_write_mutex_is_not_an_ee_required_port() -> None:
    # 进了 `_EE_REQUIRED_PORTS` 就等于「没装 EE 适配器的构建拒绝启动」，
    # 与 §6.4 步 5 的回滚口径（不注入 EE 实现）直接冲突。
    assert "canvas_write_mutex" not in ports_registry._EE_REQUIRED_PORTS


def test_ce_fence_is_a_no_op(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    mutex = FileLockCanvasWriteMutex()

    with mutex.write_mutex(project_dir, "default") as guard:
        # flock 不会中途丢，所以 CE 的围栏什么都不做（§3.7）。
        assert guard.reassert() is None
        assert guard.reassert() is None


def test_ce_still_excludes_with_the_file_lock(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    mutex = FileLockCanvasWriteMutex()

    with mutex.write_mutex(project_dir, "default", timeout_seconds=0.01):
        with pytest.raises(CanvasLockBusy):
            with canvas_write_lock(
                project_dir,
                "default",
                timeout_seconds=0.01,
                retry_interval_seconds=0.001,
            ):
                pass


def test_save_canvas_behaviour_is_byte_identical_without_injection(
    tmp_path: Path,
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)

    result = canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        build_payload=lambda _existing: {
            "revision": 2,
            "nodes": [{"id": "n"}],
            "edges": [],
        },
    )

    assert result.payload["revision"] == 2
    assert json.loads(canvas_file.read_text(encoding="utf-8"))["revision"] == 2
    # 未注入时锁文件仍然是 CE 的那把（B2-9）。
    assert (project_dir / "freezone" / "canvases" / "_locks" / "default.lock").exists()


# ---------------------------------------------------------------------------
# 接缝：四个取锁点全部改走端口
# ---------------------------------------------------------------------------


def test_save_canvas_takes_the_injected_mutex(tmp_path: Path, injected_mutex) -> None:
    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        build_payload=lambda _existing: {
            "revision": 2,
            "nodes": [{"id": "n"}],
            "edges": [],
        },
    )

    assert mutex.entered == [(project_dir, "default")]
    assert mutex.exited == [(project_dir, "default")]
    # 注入之后 CE 的锁文件不再被创建 —— 端口换掉的是整个互斥机制，不是叠一层。
    assert not (project_dir / "freezone" / "canvases" / "_locks").exists()


def test_ensure_default_canvas_takes_the_injected_mutex(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.ensure_default_canvas(
        project_dir, project_id="proj", actor_id="owner_1"
    )

    assert mutex.entered == [(project_dir, "default")]


def test_restore_canvas_version_takes_the_injected_mutex(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)
    history = (
        canvas_file.parent / "_history" / "default.rev1.20260813_101010_000001.json"
    )
    history.parent.mkdir(parents=True, exist_ok=True)
    history.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "old"}], "edges": []}),
        encoding="utf-8",
    )
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.restore_canvas_version(
        project_dir,
        "default",
        history_id=history.stem,
        base_revision=1,
        build_payload=lambda _existing, snapshot: {**snapshot, "revision": 2},
    )

    assert mutex.entered == [(project_dir, "default")]


def test_soft_delete_canvas_takes_the_injected_mutex(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    mutex = injected_mutex(_RecordingMutex())

    canvas_store.soft_delete_canvas(project_dir, "default", deleted_by="alice")

    assert mutex.entered == [(project_dir, "default")]


# ---------------------------------------------------------------------------
# 围栏：落点、命中、丢租约
# ---------------------------------------------------------------------------


def test_fence_runs_after_fsync_and_before_replace(tmp_path: Path) -> None:
    path = tmp_path / "canvas.json"
    path.write_text(json.dumps({"revision": 1}), encoding="utf-8")
    observed: dict[str, object] = {}

    def fence() -> None:
        observed["target"] = json.loads(path.read_text(encoding="utf-8"))
        observed["tmp_files"] = sorted(
            p.name for p in tmp_path.glob(".canvas.json.*.tmp")
        )

    canvas_store.atomic_write_json(path, {"revision": 2}, fence=fence)

    # 围栏跑的时候：临时文件已经在盘上（已 fsync），正式文件一个字节都没被碰过。
    assert observed["target"] == {"revision": 1}
    assert len(observed["tmp_files"]) == 1
    assert json.loads(path.read_text(encoding="utf-8")) == {"revision": 2}


def test_fence_that_raises_leaves_no_write_and_no_residue(tmp_path: Path) -> None:
    path = tmp_path / "canvas.json"
    path.write_text(json.dumps({"revision": 1}), encoding="utf-8")

    def fence() -> None:
        raise CanvasLeaseLost("default")

    with pytest.raises(CanvasLeaseLost):
        canvas_store.atomic_write_json(path, {"revision": 2}, fence=fence)

    assert json.loads(path.read_text(encoding="utf-8")) == {"revision": 1}
    assert sorted(p.name for p in tmp_path.glob(".canvas.json.*.tmp")) == []


def test_save_canvas_fences_and_a_lost_lease_does_not_land(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)
    mutex = injected_mutex(_RecordingMutex(fence_error=CanvasLeaseLost("default")))

    with pytest.raises(CanvasLeaseLost):
        canvas_store.save_canvas(
            project_dir,
            "default",
            base_revision=1,
            build_payload=lambda _existing: {
                "revision": 2,
                "nodes": [{"id": "n"}],
                "edges": [],
            },
        )

    assert mutex.fence_calls == ["default"]
    assert json.loads(canvas_file.read_text(encoding="utf-8"))["revision"] == 1
    # 租约丢了也要把租约放掉（`finally`）。
    assert mutex.exited == [(project_dir, "default")]


def test_soft_delete_fences_before_the_irreversible_replace(
    tmp_path: Path, injected_mutex
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = _seed_canvas(project_dir)
    injected_mutex(_RecordingMutex(fence_error=CanvasLeaseLost("default")))

    with pytest.raises(CanvasLeaseLost):
        canvas_store.soft_delete_canvas(project_dir, "default", deleted_by="alice")

    # `path.replace(target)` 是不可逆的：围栏必须挂在它**之前**（§3.3.3）。
    assert canvas_file.exists()
    assert not canvas_file.with_name("default.deleted.json").exists()


# ---------------------------------------------------------------------------
# 围栏覆盖面：静态断言（判据是「这一步会不会让别人的写永久消失」，B2-11）
# ---------------------------------------------------------------------------


# §3.3.3 的表：只有这两处**故意**不挂围栏，各带一条理由。
_UNFENCED_BY_DESIGN = {
    # 台账写在画布 rename 之后：此刻已经赢了竞态，围栏只会把「赢了但没记台账」
    # 变成「赢了且抛异常」。丢一条台账 ＝ 下次重放退化成一次真实保存。
    "append_idempotency_entry",
    # 墓碑跟在 `path.replace(target)` 之后，同一个关键区内已经过了不可逆点。
    "soft_delete_canvas",
}
_MUST_BE_FENCED = {"ensure_default_canvas", "save_canvas", "restore_canvas_version"}


def _canvas_store_functions() -> dict[str, ast.FunctionDef]:
    tree = ast.parse(
        Path(canvas_store.__file__).read_text(encoding="utf-8"),
        filename=canvas_store.__file__,
    )
    return {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _atomic_write_calls() -> list[tuple[str, ast.Call]]:
    calls: list[tuple[str, ast.Call]] = []
    for name, func in _canvas_store_functions().items():
        for node in ast.walk(func):
            if not isinstance(node, ast.Call):
                continue
            target = node.func
            called = (
                target.attr
                if isinstance(target, ast.Attribute)
                else getattr(target, "id", "")
            )
            if called == "atomic_write_json":
                calls.append((name, node))
    return calls


def test_every_atomic_write_json_call_site_is_fenced_or_exempt() -> None:
    unfenced = {
        name
        for name, call in _atomic_write_calls()
        if not any(kw.arg == "fence" for kw in call.keywords)
    }

    assert unfenced == _UNFENCED_BY_DESIGN, (
        "每一条 `atomic_write_json` 写路径要么带 `fence=`，要么在 §3.3.3 的豁免表里"
    )


def test_the_three_fenced_write_paths_are_all_present() -> None:
    fenced = {
        name
        for name, call in _atomic_write_calls()
        if any(kw.arg == "fence" for kw in call.keywords)
    }

    assert _MUST_BE_FENCED <= fenced


def test_soft_delete_reasserts_before_path_replace() -> None:
    func = _canvas_store_functions()["soft_delete_canvas"]

    replace_lines = [
        node.lineno
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "replace"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "path"
    ]
    reassert_lines = [
        node.lineno
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "reassert"
    ]

    assert len(replace_lines) == 1, "本用例假设 `path.replace(target)` 只有一处"
    assert reassert_lines, "`soft_delete_canvas` 必须在不可逆落盘前显式挂一道围栏"
    assert min(reassert_lines) < replace_lines[0]
