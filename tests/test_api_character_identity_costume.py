from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import UploadFile

from novelvideo.api.schemas import IdentityCreate
from novelvideo.models import CharacterIdentity, NovelCharacter


class _CharacterStore:
    def __init__(self, character: NovelCharacter):
        self.character = character
        self.identity_updates: list[tuple[str, str, dict]] = []
        self.added_identities: list[CharacterIdentity] = []
        self.touched_character_assets: list[str] = []

    def get_character(self, name: str):
        if name == self.character.name:
            return self.character
        return None

    async def update_character_identity(self, name: str, identity_id: str, **updates):
        self.identity_updates.append((name, identity_id, updates))
        for identity in self.character.identities:
            if identity.identity_id == identity_id:
                for key, value in updates.items():
                    setattr(identity, key, value)
        return True

    async def add_character_identity(self, name: str, identity: CharacterIdentity):
        self.added_identities.append(identity)
        identities = self.character.identities
        identities.append(identity)
        self.character.identities = identities
        return True

    async def touch_character_asset(self, name: str):
        self.touched_character_assets.append(name)
        return True


def _patch_character_project(
    monkeypatch: pytest.MonkeyPatch,
    module,
    project_dir: Path,
    store: _CharacterStore,
) -> None:
    async def fake_resolve_character_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(project_dir), "admin", "demo", project_dir, str(project_dir), store

    monkeypatch.setattr(module, "_resolve_character_project", fake_resolve_character_project)


def _ctx(project_dir: Path):
    return SimpleNamespace(
        project_id="proj_demo",
        owner_username="admin",
        project_name="demo",
        output_dir=project_dir,
        state_dir=project_dir / "_state",
        runtime_dir=project_dir / "_runtime",
        is_home_node=True,
    )


def _png_upload(filename: str = "upload.png") -> UploadFile:
    from PIL import Image

    payload = io.BytesIO()
    Image.new("RGB", (4, 4), color=(120, 80, 40)).save(payload, format="PNG")
    payload.seek(0)
    return UploadFile(filename=filename, file=payload)


def _write_png(path: Path, color: tuple[int, int, int]) -> bytes:
    from PIL import Image

    payload = io.BytesIO()
    Image.new("RGB", (4, 4), color=color).save(payload, format="PNG")
    data = payload.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


@pytest.mark.asyncio
async def test_delete_identity_costume_removes_file_and_clears_store(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    costume_path = tmp_path / "assets" / "characters" / "秦" / "identities" / "少年_costume.png"
    costume_path.parent.mkdir(parents=True)
    costume_path.write_bytes(b"costume")
    identity = CharacterIdentity(
        identity_id="秦_少年",
        character_name="秦",
        identity_name="少年",
        costume_image=str(costume_path),
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore(character)
    _patch_character_project(monkeypatch, characters, tmp_path, store)

    response = await characters.delete_identity_costume(
        project="demo",
        name="秦",
        identity_id="秦_少年",
        user={"username": "admin"},
    )

    assert response == {"ok": True, "data": {"deleted": True}}
    assert not costume_path.exists()
    assert store.identity_updates == [("秦", "秦_少年", {"costume_image": ""})]


@pytest.mark.asyncio
async def test_delete_identity_costume_is_idempotent_when_file_missing(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    identity = CharacterIdentity(
        identity_id="秦_少年",
        character_name="秦",
        identity_name="少年",
        costume_image="",
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore(character)
    _patch_character_project(monkeypatch, characters, tmp_path, store)

    response = await characters.delete_identity_costume(
        project="demo",
        name="秦",
        identity_id="秦_少年",
        user={"username": "admin"},
    )

    assert response == {"ok": True, "data": {"deleted": False}}
    assert store.identity_updates == [("秦", "秦_少年", {"costume_image": ""})]


@pytest.mark.asyncio
async def test_add_identity_persists_age_group(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore(character)
    _patch_character_project(monkeypatch, characters, tmp_path, store)

    response = await characters.add_identity(
        project="demo",
        name="秦",
        body=IdentityCreate(
            identity_name="幼年",
            age_group="child",
            appearance_details="粗布短衫",
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["age_group"] == "child"
    assert store.added_identities[0].age_group == "child"


@pytest.mark.asyncio
async def test_upload_identity_costume_returns_project_context_url(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    identity = CharacterIdentity(
        identity_id="秦_少年",
        character_name="秦",
        identity_name="少年",
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore(character)

    async def fake_resolve_character_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(characters, "_resolve_character_project", fake_resolve_character_project)
    monkeypatch.setattr(
        characters,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    response = await characters.upload_identity_costume(
        project="demo",
        name="秦",
        identity_id="秦_少年",
        file=_png_upload(),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["costume_image_url"] == (
        "/static/projects/proj_demo/assets/characters/秦/identities/少年_costume.png"
    )
    assert store.identity_updates == [
        (
            "秦",
            "秦_少年",
            {"costume_image": str(tmp_path / "assets/characters/秦/identities/少年_costume.png")},
        )
    ]


@pytest.mark.asyncio
async def test_upload_identity_portrait_returns_project_context_url(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    identity = CharacterIdentity(
        identity_id="秦_少年",
        character_name="秦",
        identity_name="少年",
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore(character)

    async def fake_resolve_character_project(
        project: str, user: dict, *, required_role: str = "editor"
    ):
        return _ctx(tmp_path), "admin", "demo", tmp_path, str(tmp_path), store

    monkeypatch.setattr(characters, "_resolve_character_project", fake_resolve_character_project)
    monkeypatch.setattr(
        characters,
        "make_static_url_for_context",
        lambda ctx, rel, local_path=None: f"/static/projects/{ctx.project_id}/{rel}",
    )

    response = await characters.upload_identity_portrait(
        project="demo",
        name="秦",
        identity_id="秦_少年",
        file=_png_upload(),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["portrait_image_url"] == (
        "/static/projects/proj_demo/assets/characters/秦/identities/秦_少年_portrait.png"
    )
    assert store.identity_updates == [
        (
            "秦",
            "秦_少年",
            {
                "portrait_image": str(
                    tmp_path / "assets/characters/秦/identities/秦_少年_portrait.png"
                )
            },
        )
    ]


@pytest.mark.asyncio
async def test_upload_identity_image_backs_up_existing_file(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    identity = CharacterIdentity(
        identity_id="秦_少年",
        character_name="秦",
        identity_name="少年",
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore(character)
    _patch_character_project(monkeypatch, characters, tmp_path, store)

    target = tmp_path / "assets" / "characters" / "秦" / "identities" / "少年.png"
    old_bytes = _write_png(target, (10, 20, 30))

    response = await characters.upload_identity_image(
        project="demo",
        name="秦",
        identity_name="少年",
        file=_png_upload(),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    backups = list(target.parent.glob("少年_*.png"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == old_bytes
    assert target.read_bytes() != old_bytes


@pytest.mark.asyncio
async def test_character_asset_history_lists_backups(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    identity = CharacterIdentity(
        identity_id="秦_少年",
        character_name="秦",
        identity_name="少年",
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore(character)
    _patch_character_project(monkeypatch, characters, tmp_path, store)

    target = tmp_path / "assets" / "characters" / "秦" / "identities" / "少年.png"
    _write_png(target, (10, 20, 30))
    backup = target.parent / "少年_20260603112233.png"
    backup.write_bytes(target.read_bytes())

    response = await characters.list_character_asset_history(
        project="demo",
        name="秦",
        kind="identity",
        identity_id="秦_少年",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["current_url"]
    assert response["data"]["entries"][0]["history_id"] == backup.name
    assert response["data"]["entries"][0]["url"]


@pytest.mark.asyncio
async def test_restore_character_asset_history_backs_up_current_and_restores_backup(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import characters

    identity = CharacterIdentity(
        identity_id="秦_少年",
        character_name="秦",
        identity_name="少年",
    )
    character = NovelCharacter(name="秦")
    character.identities = [identity]
    store = _CharacterStore(character)
    _patch_character_project(monkeypatch, characters, tmp_path, store)

    target = tmp_path / "assets" / "characters" / "秦" / "identities" / "少年.png"
    current_bytes = _write_png(target, (200, 20, 30))
    backup = target.parent / "少年_20260603112233.png"
    old_bytes = _write_png(backup, (10, 20, 30))

    response = await characters.restore_character_asset_history(
        project="demo",
        name="秦",
        body=SimpleNamespace(
            kind="identity",
            identity_id="秦_少年",
            history_id=backup.name,
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert target.read_bytes() == old_bytes
    new_backups = [
        path for path in target.parent.glob("少年_*.png") if path.name != "少年_20260603112233.png"
    ]
    assert len(new_backups) == 1
    assert new_backups[0].read_bytes() == current_bytes


@pytest.mark.asyncio
async def test_restore_character_portrait_advances_summary_revision(tmp_path, monkeypatch):
    from novelvideo.api.routes import characters

    character = NovelCharacter(name="秦")
    store = _CharacterStore(character)
    _patch_character_project(monkeypatch, characters, tmp_path, store)

    target = tmp_path / "assets" / "characters" / "秦" / "portrait.png"
    _write_png(target, (200, 20, 30))
    backup = target.parent / "portrait_20260603112233.png"
    restored_bytes = _write_png(backup, (10, 20, 30))

    response = await characters.restore_character_asset_history(
        project="demo",
        name="秦",
        body=SimpleNamespace(
            kind="portrait",
            identity_id="",
            history_id=backup.name,
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert target.read_bytes() == restored_bytes
    assert store.touched_character_assets == ["秦"]
