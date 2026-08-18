"""资产名里的斜杠必须挡在写入口，存量的要能自愈。

背景：角色 / 场景 / 道具的 ``name`` 同时是 SQLite 主键、REST 路径段和磁盘目录名。
名字里带 ``/`` 时 uvicorn 会在路由匹配前把 ``%2F`` 还原成真斜杠，``{name}`` 匹配不上，
删除 / 改名 / 生成源图那一整排接口全返回 FastAPI 的 404 —— 表现就是「点了删除页面还在，
点生成源图显示 NOT FOUND」。
"""

import json
import sqlite3

import pytest

from novelvideo.models import NovelCharacter, NovelProp, NovelScene
from novelvideo.sqlite_store import SQLiteStore
from novelvideo.utils.asset_names import (
    coerce_path_safe_asset_name,
    is_path_safe_asset_name,
    path_safe_asset_name,
    unique_path_safe_asset_name,
)


# ── 纯函数 ────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("家中客厅/哥哥卧室", "家中客厅_哥哥卧室"),
        ("家中客厅//哥哥卧室", "家中客厅_哥哥卧室"),
        ("家中客厅\\哥哥卧室", "家中客厅_哥哥卧室"),
        ("家中客厅", "家中客厅"),
        ("", ""),
        (None, ""),
    ],
)
def test_path_safe_asset_name(raw, expected):
    assert path_safe_asset_name(raw) == expected


def test_only_slashes_are_replaced():
    """空格、``#``、``%``、``:`` 等 percent-encode 之后能安全穿过路由，不该动。"""
    weird = "客厅 #1 (50%) : 夜"
    assert path_safe_asset_name(weird) == weird
    assert is_path_safe_asset_name(weird)


def test_coerce_keeps_original_as_alias():
    safe, aliases = coerce_path_safe_asset_name("家中客厅/哥哥卧室", ["卧室"])
    assert safe == "家中客厅_哥哥卧室"
    assert aliases == ["卧室", "家中客厅/哥哥卧室"]


def test_coerce_leaves_clean_names_untouched():
    safe, aliases = coerce_path_safe_asset_name("家中客厅", ["客厅"])
    assert safe == "家中客厅"
    assert aliases == ["客厅"]


def test_sanitizing_never_trims_whitespace():
    """消毒跑在模型的读路径上，而 ``name`` 是主键——顺手 strip 会造出删不掉的行。

    库里存着 ``"客厅 "``，读出来若变成 ``"客厅"``，``DELETE ... WHERE name = ?`` 就又
    一行都删不掉了，和斜杠那个 bug 一模一样。要修剪请在写入口显式 strip。
    """
    assert path_safe_asset_name(" 客厅 ") == " 客厅 "
    assert coerce_path_safe_asset_name(" 客厅 ") == (" 客厅 ", [])
    assert NovelScene(name=" 客厅 ").name == " 客厅 "
    assert NovelProp(name=" 木剑 ").name == " 木剑 "
    assert NovelCharacter(name=" 林小满 ").name == " 林小满 "


def test_character_kind_matches_the_character_model_charset():
    """角色口径必须和 ``NovelCharacter.sanitize_name`` 完全一致。

    两边字符集一旦分叉，路由按窄口径查重放过 ``王:小明``，模型层按宽口径把它改写成
    ``王_小明``，``INSERT … ON CONFLICT(name)`` 随即静默盖掉真正的 ``王_小明``。
    """
    for raw in ('王:小明', '王*小明', '王?小明', '王"小明', "王<小明", "王>小明", "王|小明"):
        assert path_safe_asset_name(raw, kind="character") == NovelCharacter(name=raw).name
        assert not is_path_safe_asset_name(raw, kind="character")
        # 资产口径故意更窄：这些字符 percent-encode 后能安全穿过路由和文件系统。
        assert is_path_safe_asset_name(raw)
        assert path_safe_asset_name(raw) == raw


def test_unique_name_avoids_collision():
    assert unique_path_safe_asset_name("a/b", {"a_b"}) == "a_b_2"
    assert unique_path_safe_asset_name("a/b", {"a_b", "a_b_2"}) == "a_b_3"
    assert unique_path_safe_asset_name("a/b", set()) == "a_b"


# ── 模型层的闸 ────────────────────────────────────────────


def test_scene_model_sanitizes_name_and_keeps_alias():
    scene = NovelScene(name="家中客厅/哥哥卧室", aliases=["卧室"])
    assert scene.name == "家中客厅_哥哥卧室"
    assert scene.aliases == ["卧室", "家中客厅/哥哥卧室"]


def test_prop_model_sanitizes_name_and_keeps_alias():
    prop = NovelProp(name="道具/木剑")
    assert prop.name == "道具_木剑"
    assert prop.aliases == ["道具/木剑"]


def test_character_model_already_sanitized_name():
    """角色早就有这道闸（``sanitize_name``），场景 / 道具是这次补齐的。"""
    assert NovelCharacter(name="林/小满").name == "林_小满"


# ── store 写入口 ──────────────────────────────────────────


@pytest.fixture
async def store(tmp_path):
    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)
    store = SQLiteStore(
        "user/project", output_dir=str(project_dir), state_dir=str(project_dir)
    )
    await store._ensure_db()
    try:
        yield store
    finally:
        await store.close()


def _db_names(project_dir, table):
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        return sorted(row[0] for row in conn.execute(f"SELECT name FROM {table}"))
    finally:
        conn.close()


def _insert_dirty(project_dir, table, name, **columns):
    """绕开模型直接写脏数据，模拟这道闸加上之前落库的存量。"""
    columns.setdefault("aliases_json", json.dumps([], ensure_ascii=False))
    keys = ["name", *columns]
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            f"INSERT INTO {table} ({', '.join(keys)}) "
            f"VALUES ({', '.join('?' * len(keys))})",
            (name, *columns.values()),
        )
        conn.commit()
    finally:
        conn.close()


@pytest.mark.asyncio
async def test_add_scene_writes_sanitized_name(store, tmp_path):
    scene = NovelScene(name="家中客厅/哥哥卧室")
    await store.add_scene(scene)

    assert _db_names(tmp_path / "user" / "project", "scenes") == ["家中客厅_哥哥卧室"]
    # 原名转成别名，beats / 分镜里已有的引用不会断。
    assert (await store.get_scene("家中客厅/哥哥卧室")).name == "家中客厅_哥哥卧室"


@pytest.mark.asyncio
async def test_add_prop_writes_sanitized_name(store, tmp_path):
    await store.add_prop(NovelProp(name="道具/木剑"))

    assert _db_names(tmp_path / "user" / "project", "props") == ["道具_木剑"]
    assert (await store.get_prop("道具/木剑")).name == "道具_木剑"


@pytest.mark.asyncio
async def test_rename_scene_sanitizes_target(store):
    await store.add_scene(NovelScene(name="客厅"))
    assert await store.rename_scene("客厅", "家中/客厅") is True
    assert await store.get_scene("家中_客厅") is not None


@pytest.mark.asyncio
async def test_rename_prop_sanitizes_target(store):
    await store.add_prop(NovelProp(name="木剑"))
    assert await store.rename_prop("木剑", "道具/木剑") is True
    assert (await store.get_prop("道具_木剑")) is not None


# ── 存量自愈 ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_repair_is_noop_when_all_names_are_clean(store):
    await store.add_scene(NovelScene(name="客厅"))

    def move_assets(old_name, new_name):  # pragma: no cover - 不该被调用
        raise AssertionError("干净数据不该触发目录迁移")

    assert await store.repair_path_unsafe_asset_names("scene", move_assets) == {}


@pytest.mark.asyncio
async def test_repair_renames_scene_and_keeps_alias(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "家中客厅/哥哥卧室")

    renamed = await store.repair_path_unsafe_asset_names("scene")

    assert renamed == {"家中客厅/哥哥卧室": "家中客厅_哥哥卧室"}
    assert _db_names(project_dir, "scenes") == ["家中客厅_哥哥卧室"]
    # 原名留作别名 —— beats 里按旧名引用的场景仍然找得到。
    assert (await store.get_scene("家中客厅/哥哥卧室")).name == "家中客厅_哥哥卧室"


@pytest.mark.asyncio
async def test_repair_remaps_derived_scene_pointers(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "家中客厅/哥哥卧室")
    _insert_dirty(
        project_dir,
        "scenes",
        "家中客厅/哥哥卧室_夜晚",
        base_scene_id="家中客厅/哥哥卧室",
    )

    await store.repair_path_unsafe_asset_names("scene")

    derived = await store.get_scene("家中客厅_哥哥卧室_夜晚")
    assert derived.base_scene_id == "家中客厅_哥哥卧室"


@pytest.mark.asyncio
async def test_repair_avoids_colliding_with_existing_name(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "a_b")
    _insert_dirty(project_dir, "scenes", "a/b")

    assert await store.repair_path_unsafe_asset_names("scene") == {"a/b": "a_b_2"}
    assert _db_names(project_dir, "scenes") == ["a_b", "a_b_2"]


@pytest.mark.asyncio
async def test_repair_skips_record_when_assets_cannot_move(store, tmp_path):
    """目录挪不动就别改名：记录指向别人的图，比留着坏名字更糟。"""
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "a/b")

    def move_assets(old_name, new_name):
        raise ValueError("target exists")

    assert await store.repair_path_unsafe_asset_names("scene", move_assets) == {}
    assert _db_names(project_dir, "scenes") == ["a/b"]


@pytest.mark.asyncio
async def test_repair_moves_asset_dirs_via_scene_route_helper(store, tmp_path):
    from novelvideo.api.routes.scenes import _heal_path_unsafe_scene_names

    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "家中客厅/哥哥卧室")
    legacy_dir = project_dir / "assets" / "scenes" / "家中客厅" / "哥哥卧室"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "master.png").write_bytes(b"png")

    await _heal_path_unsafe_scene_names(store, project_dir)

    assert _db_names(project_dir, "scenes") == ["家中客厅_哥哥卧室"]
    # 资源目录跟着搬家，源图不会因为改名而丢。
    assert (project_dir / "assets" / "scenes" / "家中客厅_哥哥卧室" / "master.png").exists()


@pytest.mark.asyncio
async def test_repair_prop_via_route_helper(store, tmp_path):
    from novelvideo.api.routes.props import _heal_path_unsafe_prop_names

    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "props", "道具/木剑")
    legacy_dir = project_dir / "assets" / "props" / "道具" / "木剑"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "reference_3view.png").write_bytes(b"png")

    await _heal_path_unsafe_prop_names(store, project_dir)

    assert _db_names(project_dir, "props") == ["道具_木剑"]
    assert (
        project_dir / "assets" / "props" / "道具_木剑" / "reference_3view.png"
    ).exists()


@pytest.mark.asyncio
async def test_repair_character_via_route_helper(store, tmp_path):
    from novelvideo.api.routes.characters import _heal_path_unsafe_character_names

    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "characters", "林/小满")

    await _heal_path_unsafe_character_names(store, project_dir)

    # 修之前主键里还带着斜杠，DELETE ... WHERE name = '林_小满' 一行都删不到。
    assert _db_names(project_dir, "characters") == ["林_小满"]
    assert store.get_character("林_小满") is not None
    assert store.get_character("林/小满") is not None


@pytest.mark.asyncio
async def test_repair_character_remaps_identities(store, tmp_path):
    """身份记录把角色名嵌在 character_name / identity_id 里，改名要跟着走。

    不跟着走的话，身份图会去 ``assets/characters/林_小满/`` 下找一个按旧名拼出来的
    文件名，结果是一张都读不到。``rename_character`` 一直在做这件事，自愈也得做。
    """
    from novelvideo.api.routes.characters import _heal_path_unsafe_character_names

    project_dir = tmp_path / "user" / "project"
    identities = [
        {
            "character_name": "林/小满",
            "identity_name": "casual",
            "identity_id": "林/小满_casual",
        }
    ]
    _insert_dirty(
        project_dir,
        "characters",
        "林/小满",
        identities_json=json.dumps(identities, ensure_ascii=False),
    )

    await _heal_path_unsafe_character_names(store, project_dir)

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        raw = conn.execute(
            "SELECT identities_json FROM characters WHERE name = ?", ("林_小满",)
        ).fetchone()[0]
    finally:
        conn.close()
    stored = json.loads(raw)
    assert stored[0]["character_name"] == "林_小满"
    assert stored[0]["identity_id"] == "林_小满_casual"


@pytest.mark.asyncio
async def test_repair_runs_once_per_store(store, tmp_path):
    """列表接口是并发入口，自愈每种资产只跑一次——两个请求同时搬目录会互相踩。"""
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "家中客厅/哥哥卧室")

    first = await store.repair_path_unsafe_asset_names("scene")
    assert first == {"家中客厅/哥哥卧室": "家中客厅_哥哥卧室"}

    _insert_dirty(project_dir, "scenes", "厨房/储物间")
    moved: list[tuple[str, str]] = []
    second = await store.repair_path_unsafe_asset_names(
        "scene", lambda old, new: moved.append((old, new))
    )
    assert second == {}
    assert moved == []


@pytest.mark.asyncio
async def test_repair_commits_each_row_before_moving_the_next(store, tmp_path):
    """一行「搬目录 + 改名 + 重挂派生场景」是一个事务，不能攒到最后一起提交。

    目录是先搬的，库是后写的。要是所有行攒到最后一次性提交，中途任何一行炸掉都会让
    前面那些「盘上已是新名、库里还是旧名」的行整批留在磁盘上——正是自愈想避免的错位。
    """
    project_dir = tmp_path / "user" / "project"
    _insert_dirty(project_dir, "scenes", "家中客厅/哥哥卧室")
    _insert_dirty(project_dir, "scenes", "派生", base_scene_id="家中客厅/哥哥卧室")
    _insert_dirty(project_dir, "scenes", "厨房/储物间")

    def move(old: str, new: str) -> None:
        if old == "厨房/储物间":
            raise RuntimeError("盘满了")

    with pytest.raises(RuntimeError):
        await store.repair_path_unsafe_asset_names("scene", move)

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        rows = dict(
            conn.execute("SELECT name, base_scene_id FROM scenes").fetchall()
        )
    finally:
        conn.close()
    # 炸之前那一行已经落库了，盘上和库里对得上。
    assert "家中客厅_哥哥卧室" in rows
    assert rows["派生"] == "家中客厅_哥哥卧室"
    # 炸掉的那一行原样留着，下次自愈会重来。
    assert "厨房/储物间" in rows


# ── dot-segment：`.` / `..` 也会改变路径结构 ────────────────


@pytest.mark.parametrize("raw", [".", "..", "..."])
def test_dot_only_names_are_not_path_safe(raw):
    """``assets/scenes/..`` 就是 assets 根目录本身，和斜杠一样能逃出资产目录。"""
    assert not is_path_safe_asset_name(raw)
    assert not is_path_safe_asset_name(raw, kind="character")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(".", "_"), ("..", "__"), ("../..", ".._.."), ("..\\..", ".._..")],
)
def test_dot_only_names_are_sanitized(raw, expected):
    assert path_safe_asset_name(raw) == expected


def test_dots_inside_a_real_name_are_kept():
    """只有整名是点才危险；``第1.5集客厅`` 是正经名字，不能动。"""
    assert path_safe_asset_name("第1.5集客厅") == "第1.5集客厅"
    assert is_path_safe_asset_name("第1.5集客厅")


# ── 目录迁移必须留在资产根目录内 ────────────────────────────


def test_asset_dir_within_rejects_traversal(tmp_path):
    from novelvideo.utils.asset_names import asset_dir_within

    root = tmp_path / "assets" / "scenes"
    root.mkdir(parents=True)
    assert asset_dir_within(root, "客厅") == root / "客厅"
    assert asset_dir_within(root, "../../config.json") is None
    assert asset_dir_within(root, "..") is None
    assert asset_dir_within(root, "") is None


@pytest.mark.asyncio
async def test_repair_never_touches_files_outside_the_asset_root(store, tmp_path):
    """存量脏值是直接拼进源路径的：``../../config.json`` 不能让迁移碰到资产根之外。"""
    from novelvideo.api.routes.scenes import _heal_path_unsafe_scene_names

    project_dir = tmp_path / "user" / "project"
    outsider = project_dir / "config.json"
    outsider.write_text("{}", encoding="utf-8")
    (project_dir / "assets" / "scenes").mkdir(parents=True)
    _insert_dirty(project_dir, "scenes", "../../config.json")

    await _heal_path_unsafe_scene_names(store, project_dir)

    # 资产根之外的文件原封不动。
    assert outsider.exists()
    # 记录本身还是要治好，否则它的 {name} 接口永远 404。
    assert _db_names(project_dir, "scenes") == [".._.._config.json"]


# ── 并发：store 是按请求新建的 ──────────────────────────────


@pytest.mark.asyncio
async def test_repair_guard_survives_a_new_store_instance(tmp_path):
    """自愈的「只跑一次」必须记在进程上，记在 store 实例上等于没记。

    ``api/deps.py`` 的 ``make_sqlite_store`` 每个请求新建一个 store 实例，所以实例级的
    锁和 done 集合谁也拦不住谁：两个并发的列表请求各拿各的锁双双进到迁移里，一个搬走
    目录、另一个的 ``shutil.move`` 抛异常被 ``except (OSError, ValueError)`` 吞掉，那一行
    就停在「盘上已改名、库里还是旧名」的错位状态。顺带，实例级还意味着每个请求都要做
    一次全表扫描。

    这里用两个独立 store 串行地测同一个不变量——竞态本身是时序相关的，测不稳。
    """
    from novelvideo.sqlite_store import reset_path_repair_state

    reset_path_repair_state()
    project_dir = tmp_path / "user" / "project"
    project_dir.mkdir(parents=True)

    def open_store() -> SQLiteStore:
        return SQLiteStore(
            "user/project", output_dir=str(project_dir), state_dir=str(project_dir)
        )

    first = open_store()
    await first._ensure_db()
    try:
        _insert_dirty(project_dir, "scenes", "家中客厅/哥哥卧室")
        assert await first.repair_path_unsafe_asset_names("scene") == {
            "家中客厅/哥哥卧室": "家中客厅_哥哥卧室"
        }
    finally:
        await first.close()

    _insert_dirty(project_dir, "scenes", "厨房/储物间")
    moved: list[tuple[str, str]] = []
    second = open_store()
    await second._ensure_db()
    try:
        assert (
            await second.repair_path_unsafe_asset_names(
                "scene", lambda old, new: moved.append((old, new))
            )
            == {}
        )
    finally:
        await second.close()

    assert moved == []
    reset_path_repair_state()


@pytest.mark.asyncio
async def test_repair_guard_is_scoped_per_project(tmp_path):
    """一个进程同时服务很多项目，A 项目跑过不能把 B 项目也记成已完成。"""
    from novelvideo.sqlite_store import reset_path_repair_state

    reset_path_repair_state()
    stores = []
    try:
        for name in ("alpha", "beta"):
            project_dir = tmp_path / "user" / name
            project_dir.mkdir(parents=True)
            store = SQLiteStore(
                f"user/{name}", output_dir=str(project_dir), state_dir=str(project_dir)
            )
            await store._ensure_db()
            stores.append((project_dir, store))
            _insert_dirty(project_dir, "scenes", "家中客厅/哥哥卧室")

        for project_dir, store in stores:
            assert await store.repair_path_unsafe_asset_names("scene") == {
                "家中客厅/哥哥卧室": "家中客厅_哥哥卧室"
            }
            assert _db_names(project_dir, "scenes") == ["家中客厅_哥哥卧室"]
    finally:
        for _project_dir, store in stores:
            await store.close()
        reset_path_repair_state()


# ── 只读协作者不该触发迁移 ──────────────────────────────────


@pytest.mark.parametrize(
    ("role", "expected"),
    [("viewer", False), ("editor", True), ("admin", True), ("owner", True)],
)
def test_only_write_roles_may_run_asset_repair(role, expected):
    """自愈是写操作（搬目录 + 改主键 + 刷 updated_at），不能挂在只读身份上。

    三个列表接口都是 ``required_role="viewer"``，只读协作者打开一次资产页就会替整个
    项目做迁移。收到 editor 及以上：只读的人看到的还是原样（他们本来也删不掉、生不出
    图），第一个有写权限的人打开资产页时统一治好。
    """
    from types import SimpleNamespace

    from novelvideo.api.deps import may_run_asset_repair

    assert may_run_asset_repair(SimpleNamespace(effective_role=role)) is expected


def test_asset_repair_allowed_without_project_context():
    """单机 / CE 路径没有 ctx，也就没有协作者概念，按有写权限处理。"""
    from novelvideo.api.deps import may_run_asset_repair

    assert may_run_asset_repair(None) is True
