from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.models import CharacterIdentity, NovelCharacter

pytestmark = pytest.mark.m04


class _CharacterStore:
    def __init__(self, characters: list[NovelCharacter] | None = None):
        self.characters = {character.name: character for character in characters or []}
        # 真 SQLiteStore 背后是一条 aiosqlite 连接加一个后台线程，路由漏关就是漏一条。
        # 这里记账，下面的用例据此断言"路由确实收口了"，而不是只断言返回码。
        self.close_calls = 0
        self.load_graph_state_flags: list[bool] = []

    def get_all_characters(self):
        return list(self.characters.values())

    async def list_characters(self):
        return list(self.characters.values())

    def get_character(self, name: str):
        return self.characters.get(name)

    async def add_character(self, character: NovelCharacter):
        self.characters[character.name] = character

    async def update_character(self, name: str, **updates):
        character = self.characters[name]
        for key, value in updates.items():
            setattr(character, key, value)

    async def rename_character(self, old_name: str, new_name: str):
        character = self.characters.pop(old_name)
        character.name = new_name
        for identity in character.identities:
            identity.character_name = new_name
            identity.identity_id = f"{new_name}_{identity.identity_name}"
        self.characters[new_name] = character

    async def delete_character(self, name: str):
        self.characters.pop(name, None)

    async def repair_path_unsafe_asset_names(self, kind: str, move_assets=None):
        # 这里的名字都是干净的，list 接口上那道存量自愈是空跑。
        return {}

    async def close(self):
        self.close_calls += 1


def _client(monkeypatch, tmp_path, store: _CharacterStore):
    from novelvideo.api import deps
    from novelvideo.api.routes import characters

    project_dir = tmp_path / "output" / "admin" / "demo"
    project_dir.mkdir(parents=True)
    ctx = SimpleNamespace(project_id="proj_demo", output_dir=project_dir, is_home_node=True)

    # 打在解析层而不是 ``_resolve_character_project`` 上：后者只是裸版本，读取路径
    # 走的是 ``_character_project_scope``。把假货塞在这一层，两条路上的
    # ``async with`` / ``try/finally`` 都是真代码在跑，``store.close()`` 才是被生产
    # 代码调用的，用例里那些 ``close_calls`` 断言才有意义。
    async def fake_resolve_project_scope(project: str, user: dict, *, required_role: str = "viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="demo",
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir),
            runtime_dir=str(project_dir),
        )

    async def fake_make_store_for_context(_ctx, *, load_graph_state: bool = True):
        store.load_graph_state_flags.append(load_graph_state)
        return store

    monkeypatch.setattr(characters, "resolve_project_scope", fake_resolve_project_scope)
    # 两处都要打。裸 ``_resolve_character_project`` 用的是 ``characters`` 上 import
    # 进来的名字；scope 里的 ``sqlite_store_for_context_scope`` 是在 ``deps`` 上按
    # 模块全局解析工厂的，只打 route 模块会打空——本轮修的正是这个坑。
    monkeypatch.setattr(characters, "make_sqlite_store_for_context", fake_make_store_for_context)
    monkeypatch.setattr(deps, "make_sqlite_store_for_context", fake_make_store_for_context)
    monkeypatch.setattr(
        characters,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    app = FastAPI()
    app.include_router(characters.router)
    app.dependency_overrides[characters.get_api_user] = lambda: {"username": "admin"}
    return TestClient(app)


def test_create_character_accepts_react_extra_payload(monkeypatch, tmp_path):
    store = _CharacterStore()
    client = _client(monkeypatch, tmp_path, store)

    response = client.post(
        "/projects/demo/characters",
        json={
            "name": "秦昭",
            "role": "主角",
            "is_main": True,
            "gender": "男",
            "age_group": "middle",
            "description": "冷静的捕快",
            "face_prompt": "sharp eyes, stern face",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "name": "秦昭",
            "role": "主角",
            "is_main": True,
            "gender": "男",
            "age_group": "middle",
            "description": "冷静的捕快",
            "face_prompt": "sharp eyes, stern face",
        },
    }
    saved = store.get_character("秦昭")
    assert saved is not None
    assert saved.is_main is True
    assert saved.gender == "男"
    assert saved.age_group == "middle"
    assert saved.description == "冷静的捕快"
    assert saved.face_prompt == "sharp eyes, stern face"


def test_create_main_character_unsets_previous_main(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(name="旧主角", role="主角", is_main=True),
            NovelCharacter(name="配角", role="配角", is_main=False),
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.post(
        "/projects/demo/characters",
        json={"name": "新主角", "role": "主角", "is_main": True},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert store.get_character("旧主角").is_main is False
    assert store.get_character("新主角").is_main is True


def test_update_main_character_unsets_previous_main(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(name="秦昭", role="主角", is_main=True),
            NovelCharacter(name="沈青", role="配角", is_main=False),
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.patch("/projects/demo/characters/沈青", json={"is_main": True})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {"name": "沈青", "updated_fields": ["is_main"]},
    }
    assert store.get_character("秦昭").is_main is False
    assert store.get_character("沈青").is_main is True


def test_list_characters_repairs_duplicate_narrator_main(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(name="陆辰", role="主角", is_main=True),
            NovelCharacter(name="沈月白", role="女主", is_main=True),
            NovelCharacter(name="赵广年", role="配角", is_main=False),
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters")

    assert response.status_code == 200
    mains = [item["name"] for item in response.json()["data"] if item["is_main"]]
    assert mains == ["陆辰"]
    assert store.get_character("陆辰").is_main is True
    assert store.get_character("沈月白").is_main is False


def test_list_characters_carries_identity_ids_for_deep_link_resolution(
    monkeypatch, tmp_path
):
    """角色列表带出每个角色名下的身份 id，且只带 id。

    资产页要把 ``?type=identity&id=`` 深链解析到拥有它的角色。前端此前是逐个角色
    调 ``/characters/{name}/identities`` 建 id→角色名 的表——角色有多少个就发多少
    个请求，无条件、每次进页面都发。身份对象已经随角色一起在内存里，这里带出来不
    多一次查询；带的是一串 id，载荷不随身份的图片/描述增长。
    """
    lin = NovelCharacter(name="林昭", role="主角")
    lin.identities = [
        CharacterIdentity(
            identity_id="林昭_青年", character_name="林昭", identity_name="青年"
        ),
        CharacterIdentity(
            identity_id="林昭_少年", character_name="林昭", identity_name="少年"
        ),
    ]
    su = NovelCharacter(name="苏清晏", role="女主")
    su.identities = [
        CharacterIdentity(
            identity_id="苏清晏_少女", character_name="苏清晏", identity_name="少女"
        )
    ]
    bare = NovelCharacter(name="路人", role="配角")

    store = _CharacterStore([lin, su, bare])
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters")

    assert response.status_code == 200
    by_name = {item["name"]: item for item in response.json()["data"]}

    assert by_name["林昭"]["identity_ids"] == ["林昭_青年", "林昭_少年"]
    assert by_name["苏清晏"]["identity_ids"] == ["苏清晏_少女"]
    # 没有身份的角色出空列表而不是缺字段，前端不必区分「没有」和「没带」。
    assert by_name["路人"]["identity_ids"] == []
    # 只有 id。身份详情仍走按需的 identities 接口，别让列表载荷跟着长。
    identity_detail_keys = {"identity_name", "image_url", "appearance_details"}
    for item in by_name.values():
        assert identity_detail_keys.isdisjoint(item.keys())


def test_list_characters_defaults_to_convention_urls_without_filesystem_probes(
    monkeypatch, tmp_path
):
    from novelvideo.api.routes import characters

    store = _CharacterStore([NovelCharacter(name="林昭", role="主角")])
    client = _client(monkeypatch, tmp_path, store)

    def fail_probe(*_args, **_kwargs):
        raise AssertionError("the character summary must not probe asset files")

    monkeypatch.setattr(characters, "compute_portrait_path", fail_probe)
    monkeypatch.setattr(characters, "tree_updated_at", fail_probe)
    monkeypatch.setattr(characters, "_asset_url", fail_probe)

    response = client.get("/projects/demo/characters")

    assert response.status_code == 200
    asset = response.json()["data"][0]
    assert asset["portrait_url"].endswith(
        "/assets/characters/%E6%9E%97%E6%98%AD/portrait.png"
    ) or asset["portrait_url"].endswith("/assets/characters/林昭/portrait.png")
    assert store.load_graph_state_flags == [False]


def test_character_details_probe_only_the_requested_character(monkeypatch, tmp_path):
    store = _CharacterStore(
        [NovelCharacter(name="林昭"), NovelCharacter(name="苏清晏")]
    )
    client = _client(monkeypatch, tmp_path, store)
    project_dir = tmp_path / "output" / "admin" / "demo"
    portrait = project_dir / "assets" / "characters" / "苏清晏" / "portrait.png"
    portrait.parent.mkdir(parents=True)
    portrait.write_bytes(b"portrait")

    response = client.get(
        "/projects/demo/characters",
        params={"summary": "false", "names": "苏清晏"},
    )

    assert response.status_code == 200
    assert [item["name"] for item in response.json()["data"]] == ["苏清晏"]
    assert response.json()["data"][0]["portrait_url"]
    assert store.load_graph_state_flags == [False]


def test_character_and_identity_lists_expose_asset_history_links(monkeypatch, tmp_path):
    character = NovelCharacter(name="林昭", role="主角")
    character.identities = [
        CharacterIdentity(
            identity_id="林昭_青年",
            character_name="林昭",
            identity_name="青年",
        )
    ]
    store = _CharacterStore([character])
    client = _client(monkeypatch, tmp_path, store)

    characters_response = client.get("/projects/demo/characters")
    identities_response = client.get("/projects/demo/characters/林昭/identities")

    assert characters_response.status_code == 200
    char_item = characters_response.json()["data"][0]
    assert char_item["history_url"] == (
        "/api/v1/projects/proj_demo/characters/%E6%9E%97%E6%98%AD/asset-history?kind=portrait"
    )
    assert char_item["restore_url"] == (
        "/api/v1/projects/proj_demo/characters/%E6%9E%97%E6%98%AD/asset-history/restore"
    )

    assert identities_response.status_code == 200
    identity_item = identities_response.json()["data"][0]
    assert identity_item["history_url"] == (
        "/api/v1/projects/proj_demo/characters/%E6%9E%97%E6%98%AD/"
        "asset-history?kind=identity&identity_id=%E6%9E%97%E6%98%AD_%E9%9D%92%E5%B9%B4"
    )
    assert identity_item["restore_url"] == (
        "/api/v1/projects/proj_demo/characters/%E6%9E%97%E6%98%AD/asset-history/restore"
    )


def test_update_character_can_rename_like_nicegui(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="秦昭", role="主角")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.patch(
        "/projects/demo/characters/秦昭",
        json={"name": "秦照", "face_prompt": "calm eyes"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "name": "秦照",
            "updated_fields": ["name", "face_prompt"],
            "renamed_from": "秦昭",
        },
    }
    assert store.get_character("秦昭") is None
    renamed = store.get_character("秦照")
    assert renamed is not None
    assert renamed.face_prompt == "calm eyes"


def test_delete_character_route_removes_character(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="秦昭", role="主角")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.post("/projects/demo/characters/秦昭/delete")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {"name": "秦昭", "deleted": True},
    }
    assert store.get_character("秦昭") is None


# 角色页的两条实际读取路径：进页面打角色列表，选中角色打 identities。它们此前拿到的是
# ``_resolve_character_project()`` 返回的裸 store，正常返回、"角色不存在" 的提前返回、
# 中途抛错三条路都没人调 ``close()``——每个请求留下一条 aiosqlite 连接加一个后台线程，
# 指望 GC 收既不及时也不保证。下面按这三条路各钉一条。
def test_list_characters_closes_the_store_on_the_normal_path(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="秦昭", role="主角")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters")

    assert response.status_code == 200
    assert store.close_calls == 1


def test_identities_closes_the_store_on_the_normal_path(monkeypatch, tmp_path):
    store = _CharacterStore(
        [
            NovelCharacter(
                name="秦昭",
                role="主角",
                identities=[
                    CharacterIdentity(
                        character_name="秦昭",
                        identity_name="青年",
                        identity_id="秦昭_青年",
                    )
                ],
            )
        ]
    )
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters/秦昭/identities")

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert store.close_calls == 1


def test_identities_closes_the_store_before_the_character_not_found_return(
    monkeypatch, tmp_path
):
    """提前返回那条路最容易漏：函数在中途 ``return``，收口代码在下面永远够不着。"""
    store = _CharacterStore([NovelCharacter(name="秦昭", role="主角")])
    client = _client(monkeypatch, tmp_path, store)

    response = client.get("/projects/demo/characters/查无此人/identities")

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert store.close_calls == 1


def test_list_characters_closes_the_store_when_the_handler_raises(monkeypatch, tmp_path):
    """异常路径：读库炸了，连接更得关——这正是重试风暴把连接数堆上去的那条路。"""
    store = _CharacterStore([NovelCharacter(name="秦昭", role="主角")])

    async def boom():
        raise RuntimeError("store read blew up")

    monkeypatch.setattr(store, "list_characters", boom)
    client = _client(monkeypatch, tmp_path, store)

    with pytest.raises(RuntimeError, match="store read blew up"):
        client.get("/projects/demo/characters")

    assert store.close_calls == 1


def test_identities_closes_the_store_when_the_handler_raises(monkeypatch, tmp_path):
    store = _CharacterStore([NovelCharacter(name="秦昭", role="主角")])

    async def boom():
        raise RuntimeError("store read blew up")

    monkeypatch.setattr(store, "list_characters", boom)
    client = _client(monkeypatch, tmp_path, store)

    with pytest.raises(RuntimeError, match="store read blew up"):
        client.get("/projects/demo/characters/秦昭/identities")

    assert store.close_calls == 1
