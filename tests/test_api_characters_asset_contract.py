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

    def get_all_characters(self):
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


def _client(monkeypatch, tmp_path, store: _CharacterStore):
    from novelvideo.api.routes import characters

    project_dir = tmp_path / "output" / "admin" / "demo"
    project_dir.mkdir(parents=True)

    async def fake_resolve_project(project: str, user: dict, *, required_role: str = "editor"):
        return (
            SimpleNamespace(project_id="proj_demo", output_dir=project_dir, is_home_node=True),
            "admin",
            "demo",
            project_dir,
            str(project_dir),
            store,
        )

    monkeypatch.setattr(characters, "_resolve_character_project", fake_resolve_project)
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
