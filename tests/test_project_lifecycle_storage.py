from dataclasses import replace
from types import SimpleNamespace

import pytest

from novelvideo import config
from novelvideo.ports.project import ProjectRecord
from novelvideo.project_context import ProjectContext


def _patch_roots(monkeypatch, tmp_path) -> None:
    """把三类数据根指向 tmp_path,让归属校验器认得测试目录。"""
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path / "runtime")


def _record(
    tmp_path, *, status: str = "active", owner: str = "alice"
) -> ProjectRecord:
    return ProjectRecord(
        id="01PROJECT",
        owner_type="user",
        owner_id="local",
        owner_username=owner,
        name="demo",
        home_node_id="local",
        output_dir=str(tmp_path / "output" / owner / "demo"),
        state_dir=str(tmp_path / "state" / owner / "demo"),
        runtime_dir=str(tmp_path / "runtime" / owner / "demo"),
        status=status,
    )


def _context(record: ProjectRecord) -> ProjectContext:
    return ProjectContext(
        project_id=record.id,
        project_name=record.name,
        owner_type=record.owner_type,
        owner_id=record.owner_id,
        owner_username=record.owner_username,
        requester_user_id="local",
        requester_username="alice",
        requester_principals=(("user", "local"),),
        effective_role="owner",
        home_node_id="local",
        output_dir=record.output_dir,
        state_dir=record.state_dir,
        runtime_dir=record.runtime_dir,
        is_home_node=True,
    )


@pytest.mark.asyncio
async def test_create_project_does_not_reuse_orphaned_same_name_data(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    _patch_roots(monkeypatch, tmp_path)
    record = _record(tmp_path)
    old_canvas = tmp_path / "state" / "alice" / "demo" / "freezone" / "canvases"
    old_canvas.mkdir(parents=True)
    (old_canvas / "default.json").write_text('{"old": true}', encoding="utf-8")
    (tmp_path / "state" / "alice" / "demo" / "data.db").write_bytes(b"old workflow db")
    (tmp_path / "output" / "alice" / "demo").mkdir(parents=True)
    (tmp_path / "runtime" / "alice" / "demo").mkdir(parents=True)

    class Registry:
        async def create_project(self, **_kwargs):
            return record

        async def delete_uncommitted_project(self, _project_id):
            raise AssertionError("successful creation must not be compensated")

    async def fake_user_id(_user):
        return "local"

    def ensure_dirs(*, output_dir, state_dir, runtime_dir):
        for path in (output_dir, state_dir, runtime_dir):
            projects.Path(path).mkdir(parents=True, exist_ok=True)

    def save_config(state_dir, *, config):
        projects.Path(state_dir, "project_config.json").write_text(
            str(config),
            encoding="utf-8",
        )

    monkeypatch.setattr(projects, "validate_project_name", lambda _name: None)
    monkeypatch.setattr(projects, "user_id_from_api_user", fake_user_id)
    monkeypatch.setattr(projects, "get_project_registry", lambda: Registry())
    monkeypatch.setattr(projects, "ensure_project_dirs_at_paths", ensure_dirs)
    monkeypatch.setattr(projects, "save_project_config_in_state_dir", save_config)
    monkeypatch.setattr(
        projects,
        "embedding_model_binding_for_new_project",
        lambda: SimpleNamespace(internal_model="embed", dimensions=1024),
    )

    result = await projects.create_project(
        projects.ProjectCreate(name="demo"),
        user={"id": "local", "username": "alice"},
    )

    assert result["ok"] is True
    assert not projects.Path(record.state_dir, "freezone").exists()
    assert not projects.Path(record.state_dir, "data.db").exists()
    assert projects.Path(record.state_dir, "project_config.json").exists()
    assert not list(projects.Path(record.state_dir).parent.glob(".demo.orphaned-*"))


@pytest.mark.asyncio
async def test_purge_detaches_files_before_releasing_project_name(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    _patch_roots(monkeypatch, tmp_path)
    record = _record(tmp_path, status="deleted")
    for raw_path in (record.output_dir, record.state_dir, record.runtime_dir):
        path = projects.Path(raw_path)
        path.mkdir(parents=True)
        (path / "retained.txt").write_text("old", encoding="utf-8")
    ctx = _context(record)
    calls: list[str] = []

    class Registry:
        async def get_project(self, _project_id):
            return record

        async def mark_project_purged(self, _project_id):
            assert all(
                not projects.Path(path).exists()
                for path in (record.output_dir, record.state_dir, record.runtime_dir)
            )
            calls.append("purged")
            return replace(record, purged_at="2026-07-31T00:00:00+00:00")

        async def delete_project_home(self, _project_id):
            calls.append("home")

    async def resolve_context(**_kwargs):
        return ctx

    async def emit_audit(**_kwargs):
        calls.append("audit")

    monkeypatch.setattr(projects, "resolve_project_context", resolve_context)
    monkeypatch.setattr(projects, "get_project_registry", lambda: Registry())
    monkeypatch.setattr(projects, "emit_project_audit", emit_audit)

    result = await projects.purge_project("01PROJECT", user={"username": "alice"})

    assert result["ok"] is True
    assert calls == ["purged", "home", "audit"]
    for raw_path in (record.output_dir, record.state_dir, record.runtime_dir):
        path = projects.Path(raw_path)
        assert not path.exists()
        assert not list(path.parent.glob(".demo.purging-*"))


@pytest.mark.asyncio
async def test_purge_restores_files_when_registry_purge_fails(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    _patch_roots(monkeypatch, tmp_path)
    record = _record(tmp_path, status="deleted")
    for raw_path in (record.output_dir, record.state_dir, record.runtime_dir):
        path = projects.Path(raw_path)
        path.mkdir(parents=True)
        (path / "retained.txt").write_text("old", encoding="utf-8")
    ctx = _context(record)

    class Registry:
        async def get_project(self, _project_id):
            return record

        async def mark_project_purged(self, _project_id):
            raise RuntimeError("registry unavailable")

    async def resolve_context(**_kwargs):
        return ctx

    monkeypatch.setattr(projects, "resolve_project_context", resolve_context)
    monkeypatch.setattr(projects, "get_project_registry", lambda: Registry())

    with pytest.raises(RuntimeError, match="registry unavailable"):
        await projects.purge_project("01PROJECT", user={"username": "alice"})

    for raw_path in (record.output_dir, record.state_dir, record.runtime_dir):
        path = projects.Path(raw_path)
        assert (path / "retained.txt").read_text(encoding="utf-8") == "old"
        assert not list(path.parent.glob(".demo.purging-*"))


# --------------------------------------------------------------------------- #
# 存储归属校验器:用户操作必须互相隔离,绝不移动/删除他人目录                     #
# --------------------------------------------------------------------------- #


def _valid_dirs(tmp_path, owner="alice"):
    return dict(
        owner_username=owner,
        output_dir=str(tmp_path / "output" / owner / "demo"),
        state_dir=str(tmp_path / "state" / owner / "demo"),
        runtime_dir=str(tmp_path / "runtime" / owner / "demo"),
    )


def test_validator_accepts_owned_dirs(monkeypatch, tmp_path):
    from novelvideo.security import assert_owned_project_storage

    _patch_roots(monkeypatch, tmp_path)
    validated = assert_owned_project_storage(**_valid_dirs(tmp_path))
    assert validated.state_dir == (tmp_path / "state" / "alice" / "demo").resolve()


def test_validator_rejects_other_users_directory(monkeypatch, tmp_path):
    from novelvideo.security import (
        ProjectStorageOwnershipError,
        assert_owned_project_storage,
    )

    _patch_roots(monkeypatch, tmp_path)
    # state_dir 指向 bob 的目录,owner 是 alice —— 必须拒绝。
    args = _valid_dirs(tmp_path)
    args["state_dir"] = str(tmp_path / "state" / "bob" / "demo")
    with pytest.raises(ProjectStorageOwnershipError):
        assert_owned_project_storage(**args)


@pytest.mark.parametrize(
    "override_key, override_value_fn",
    [
        # 指向数据根本身
        ("output_dir", lambda t: str(t / "output")),
        # 指向 owner 用户根(会连带删掉该用户全部项目)
        ("state_dir", lambda t: str(t / "state" / "alice")),
        # 路径穿越到别的用户
        ("runtime_dir", lambda t: str(t / "runtime" / "alice" / ".." / "bob" / "demo")),
    ],
)
def test_validator_rejects_dangerous_paths(
    monkeypatch, tmp_path, override_key, override_value_fn
):
    from novelvideo.security import (
        ProjectStorageOwnershipError,
        assert_owned_project_storage,
    )

    _patch_roots(monkeypatch, tmp_path)
    args = _valid_dirs(tmp_path)
    args[override_key] = override_value_fn(tmp_path)
    with pytest.raises(ProjectStorageOwnershipError):
        assert_owned_project_storage(**args)


def test_validator_rejects_symlinked_project_dir(monkeypatch, tmp_path):
    from novelvideo.security import (
        ProjectStorageOwnershipError,
        assert_owned_project_storage,
    )

    _patch_roots(monkeypatch, tmp_path)
    # alice 的 state 目录里放一个软链接指向 bob 的目录。
    (tmp_path / "state" / "bob" / "demo").mkdir(parents=True)
    alice_state = tmp_path / "state" / "alice"
    alice_state.mkdir(parents=True)
    link = alice_state / "demo"
    link.symlink_to(tmp_path / "state" / "bob" / "demo")
    args = _valid_dirs(tmp_path)
    args["state_dir"] = str(link)
    with pytest.raises(ProjectStorageOwnershipError):
        assert_owned_project_storage(**args)


def test_validator_rejects_nested_dirs(monkeypatch, tmp_path):
    from novelvideo.security import (
        ProjectStorageOwnershipError,
        assert_owned_project_storage,
    )

    _patch_roots(monkeypatch, tmp_path)
    args = _valid_dirs(tmp_path)
    # runtime 嵌在 state 下 —— 移动/删除会互相牵连,拒绝。
    args["runtime_dir"] = str(tmp_path / "state" / "alice" / "demo" / "runtime")
    with pytest.raises(ProjectStorageOwnershipError):
        assert_owned_project_storage(**args)


@pytest.mark.asyncio
async def test_purge_refuses_when_record_points_at_other_user(monkeypatch, tmp_path):
    """数据库记录被篡改指向别人目录时,purge 必须拒绝且不动任何文件。"""
    from novelvideo.api.routes import projects

    _patch_roots(monkeypatch, tmp_path)
    record = _record(tmp_path, status="deleted")
    # 篡改:把 alice 项目的 state_dir 指到 bob 的真实数据。
    bob_state = tmp_path / "state" / "bob" / "demo"
    bob_state.mkdir(parents=True)
    (bob_state / "keep.txt").write_text("bob's data", encoding="utf-8")
    record = replace(record, state_dir=str(bob_state))
    for raw_path in (record.output_dir, record.runtime_dir):
        projects.Path(raw_path).mkdir(parents=True)
    ctx = _context(record)

    class Registry:
        async def get_project(self, _project_id):
            return record

        async def mark_project_purged(self, _project_id):
            raise AssertionError("must not reach purge after validation failure")

    async def resolve_context(**_kwargs):
        return ctx

    monkeypatch.setattr(projects, "resolve_project_context", resolve_context)
    monkeypatch.setattr(projects, "get_project_registry", lambda: Registry())

    with pytest.raises(projects.HTTPException) as exc_info:
        await projects.purge_project("01PROJECT", user={"username": "alice"})

    assert exc_info.value.status_code == 500
    # bob 的数据毫发无损,alice 自己的目录也没被移动。
    assert (bob_state / "keep.txt").read_text(encoding="utf-8") == "bob's data"
    assert not list(bob_state.parent.glob(".demo.purging-*"))
    for raw_path in (record.output_dir, record.runtime_dir):
        assert projects.Path(raw_path).exists()


def test_restore_never_deletes_a_reoccupied_original(monkeypatch, tmp_path, caplog):
    """恢复隔离目录时,若原位置已被并发重建占用,绝不递归删除新数据。"""
    from novelvideo.api.routes import projects

    _patch_roots(monkeypatch, tmp_path)
    original = tmp_path / "state" / "alice" / "demo"
    quarantine = original.with_name(".demo.purging-x")
    quarantine.mkdir(parents=True)
    (quarantine / "old.txt").write_text("quarantined", encoding="utf-8")
    # 原位置在隔离之后被重新创建,写入了新数据。
    original.mkdir(parents=True)
    (original / "new.txt").write_text("fresh", encoding="utf-8")

    projects._restore_quarantined_project_dirs([(original, quarantine)])

    # 新数据保留,隔离目录也保留(留给人工处置),都没被删。
    assert (original / "new.txt").read_text(encoding="utf-8") == "fresh"
    assert (quarantine / "old.txt").read_text(encoding="utf-8") == "quarantined"
