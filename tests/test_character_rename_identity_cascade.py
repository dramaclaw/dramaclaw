"""角色改名后，散在库里各处的角色名 / identity_id 引用必须跟着改。

``identity_id`` 的格式是 ``<角色名>_<身份名>``，所以角色一改名，所有存下来的
identity_id 就同时失效。引用的完整清单在
``novelvideo.utils.identity_refs`` 的模块 docstring 里（那是把建表 SQL 逐列过了一遍数
出来的），这里逐个覆盖：

* ``episodes.character_names``         —— 角色名
* ``episodes.identity_ids``            —— 本集出场的身份
* ``episodes.identity_default_map_json`` —— ``{角色名: identity_id}``，键和值都带角色名
* ``episodes.sketch_colors_json``      —— ``{identity_id: 颜色}``
* ``episodes.prop_menu_json``          —— 每项的 ``owner_identity_id``
* ``beats.detected_identities_json``   —— 本 beat 检出的身份
* ``beats.visual_description``         —— ``{{角色名_身份名}}`` 文本 marker
* ``beats.speaker``                    —— 角色名
* ``props.owner``                      —— 角色名**或** identity_id，两种格式都在用
* ``seedance2_voice_audio_records.speaker`` —— 角色名，且是主键的一部分

漏掉任何一处，身份图和颜色分配就断链：``rename_character`` 是手动触发的低频操作，
存量名字自愈却是用户一打开角色列表就自动跑的，断链会一次性铺开。
"""

import json
import sqlite3

import pytest

from novelvideo.models import NovelCharacter
from novelvideo.sqlite_store import SQLiteStore


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


def _seed_episode_and_beat(project_dir, char_name: str) -> None:
    """直接写库，绕开模型层的消毒，模拟旧角色名下的存量引用。"""
    identity_id = f"{char_name}_casual"
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO episodes (number, title, character_names, identity_ids, "
            "identity_default_map_json, sketch_colors_json, prop_menu_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                1,
                "第一集",
                json.dumps([char_name], ensure_ascii=False),
                json.dumps([identity_id], ensure_ascii=False),
                json.dumps({char_name: identity_id}, ensure_ascii=False),
                json.dumps({identity_id: "#ff0000"}, ensure_ascii=False),
                json.dumps(
                    [
                        {
                            "prop_id": "怀表",
                            "prop_type": "object",
                            "owner_identity_id": identity_id,
                        },
                        # 没主人的道具项：不该被动，也不该让整份菜单被判成「有变化」。
                        {"prop_id": "路灯", "prop_type": "object", "owner_identity_id": ""},
                    ],
                    ensure_ascii=False,
                ),
            ),
        )
        # props.owner 两种格式都得覆盖：``怀表`` 走 prop_promotion_service 提升，owner 里
        # 存的是 identity_id；``钥匙`` 走 API 手填，存的是角色名。
        conn.execute(
            "INSERT INTO props (name, owner) VALUES (?, ?)", ("怀表", identity_id)
        )
        conn.execute("INSERT INTO props (name, owner) VALUES (?, ?)", ("钥匙", char_name))
        conn.execute("INSERT INTO props (name, owner) VALUES (?, ?)", ("路灯", ""))
        # speaker 存的是 identity_id，不是角色名——``BeatUpdate.speaker`` 标的是「说话人
        # 身份ID」，配音解析按 ``identity.identity_id == speaker`` 精确配。voice record
        # 的 speaker 又是从 beat 传下来的，同一个契约。
        conn.execute(
            "INSERT INTO seedance2_voice_audio_records (episode_number, beat_number, "
            "speaker, audio_path, voice_sha256, mode, provider, model, generated_at, "
            "status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (1, 1, identity_id, "a.wav", "sha", "clone", "indextts2", "m", "now", "ok"),
        )
        conn.execute(
            "INSERT INTO beats (episode_number, beat_number, visual_description, "
            "detected_identities_json, speaker) VALUES (?, ?, ?, ?, ?)",
            (
                1,
                1,
                f"{{{{{identity_id}}}}} 走进客厅",
                json.dumps([identity_id], ensure_ascii=False),
                identity_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _read_refs(project_dir) -> dict:
    conn = sqlite3.connect(project_dir / "data.db")
    conn.row_factory = sqlite3.Row
    try:
        ep = conn.execute("SELECT * FROM episodes WHERE number = 1").fetchone()
        beat = conn.execute(
            "SELECT * FROM beats WHERE episode_number = 1 AND beat_number = 1"
        ).fetchone()
        props = conn.execute("SELECT name, owner FROM props").fetchall()
        voice = conn.execute(
            "SELECT speaker FROM seedance2_voice_audio_records"
        ).fetchall()
    finally:
        conn.close()
    refs = {
        "character_names": json.loads(ep["character_names"] or "[]"),
        "identity_ids": json.loads(ep["identity_ids"] or "[]"),
        "identity_default_map": json.loads(ep["identity_default_map_json"] or "{}"),
        "sketch_colors": json.loads(ep["sketch_colors_json"] or "{}"),
        "prop_menu": json.loads(ep["prop_menu_json"] or "[]"),
        "prop_owners": {row["name"]: row["owner"] for row in props},
        "voice_speakers": sorted(row["speaker"] for row in voice),
    }
    if beat is not None:
        refs.update(
            {
                "detected_identities": json.loads(
                    beat["detected_identities_json"] or "[]"
                ),
                "visual_description": beat["visual_description"],
                "speaker": beat["speaker"],
            }
        )
    return refs


def _assert_remapped_to(refs: dict, new_name: str) -> None:
    identity_id = f"{new_name}_casual"
    assert refs["character_names"] == [new_name]
    assert refs["identity_ids"] == [identity_id]
    assert refs["identity_default_map"] == {new_name: identity_id}
    assert refs["sketch_colors"] == {identity_id: "#ff0000"}
    assert refs["detected_identities"] == [identity_id]
    assert refs["visual_description"] == f"{{{{{identity_id}}}}} 走进客厅"
    assert refs["speaker"] == identity_id
    assert refs["prop_menu"] == [
        {"prop_id": "怀表", "prop_type": "object", "owner_identity_id": identity_id},
        {"prop_id": "路灯", "prop_type": "object", "owner_identity_id": ""},
    ]
    assert refs["prop_owners"] == {"怀表": identity_id, "钥匙": new_name, "路灯": ""}
    assert refs["voice_speakers"] == [identity_id]


@pytest.mark.asyncio
async def test_rename_character_cascades_identity_refs(store, tmp_path):
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="林小满"))
    _seed_episode_and_beat(project_dir, "林小满")
    await store.load_graph_state()

    await store.rename_character("林小满", "林满")

    _assert_remapped_to(_read_refs(project_dir), "林满")


@pytest.mark.asyncio
async def test_path_repair_cascades_identity_refs(store, tmp_path):
    """自愈走的是裸 SQL，级联不能只挂在 rename_character 上。"""
    from novelvideo.api.routes.characters import _heal_path_unsafe_character_names

    project_dir = tmp_path / "user" / "project"
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO characters (name, identities_json) VALUES (?, ?)",
            (
                "林/小满",
                json.dumps(
                    [
                        {
                            "character_name": "林/小满",
                            "identity_name": "casual",
                            "identity_id": "林/小满_casual",
                        }
                    ],
                    ensure_ascii=False,
                ),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    _seed_episode_and_beat(project_dir, "林/小满")

    await _heal_path_unsafe_character_names(store, project_dir)

    _assert_remapped_to(_read_refs(project_dir), "林_小满")


@pytest.mark.asyncio
async def test_cascade_leaves_other_characters_alone(store, tmp_path):
    """``林小满_casual`` 改名时不能顺手改掉 ``林小满月_casual``。"""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="林小满"))
    await store.add_character(NovelCharacter(name="林小满月"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO episodes (number, identity_ids, identity_default_map_json) "
            "VALUES (?, ?, ?)",
            (
                1,
                json.dumps(["林小满_casual", "林小满月_casual"], ensure_ascii=False),
                json.dumps(
                    {"林小满": "林小满_casual", "林小满月": "林小满月_casual"},
                    ensure_ascii=False,
                ),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("林小满", "林满")

    refs = _read_refs(project_dir)
    assert refs["identity_ids"] == ["林满_casual", "林小满月_casual"]
    assert refs["identity_default_map"] == {
        "林满": "林满_casual",
        "林小满月": "林小满月_casual",
    }


@pytest.mark.asyncio
async def test_cascade_survives_reload(store, tmp_path):
    """改完要能从库里读回来，别只改了内存。"""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="林小满"))
    _seed_episode_and_beat(project_dir, "林小满")
    await store.load_graph_state()

    await store.rename_character("林小满", "林满")
    await store.load_graph_state()

    episode = store.get_episode(1)
    assert episode is not None
    assert episode.identity_ids == ["林满_casual"]


@pytest.mark.asyncio
async def test_bare_character_name_speaker_still_remaps(store, tmp_path):
    """speaker 的契约是 identity_id，但存量数据里有裸角色名，两种都得迁。"""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="林小满"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO beats (episode_number, beat_number, speaker) VALUES (?, ?, ?)",
            (1, 1, "林小满"),
        )
        conn.execute(
            "INSERT INTO seedance2_voice_audio_records (episode_number, beat_number, "
            "speaker, audio_path, voice_sha256, mode, provider, model, generated_at, "
            "status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (1, 1, "林小满", "a.wav", "sha", "clone", "indextts2", "m", "now", "ok"),
        )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("林小满", "林满")

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        speaker = conn.execute("SELECT speaker FROM beats").fetchone()[0]
        voice = conn.execute(
            "SELECT speaker FROM seedance2_voice_audio_records"
        ).fetchone()[0]
    finally:
        conn.close()
    assert speaker == "林满"
    assert voice == "林满"


@pytest.mark.asyncio
async def test_non_character_speaker_is_left_alone(store, tmp_path):
    """广播 / 画外音的 speaker 不是角色，别顺手改了。"""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="林小满"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        conn.execute(
            "INSERT INTO beats (episode_number, beat_number, speaker, speaker_kind) "
            "VALUES (?, ?, ?, ?)",
            (1, 1, "林小满_广播", "non_character"),
        )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("林小满", "林满")

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        speaker = conn.execute("SELECT speaker FROM beats").fetchone()[0]
    finally:
        conn.close()
    assert speaker == "林小满_广播"


@pytest.mark.asyncio
async def test_voice_record_conflict_drops_the_stale_row(store, tmp_path):
    """speaker 在主键里，撞上了不能炸，也不能反过来盖掉新名字下已有的那条。"""
    project_dir = tmp_path / "user" / "project"
    await store.add_character(NovelCharacter(name="林小满"))
    conn = sqlite3.connect(project_dir / "data.db")
    try:
        for speaker, audio in (("林小满_casual", "old.wav"), ("林满_casual", "new.wav")):
            conn.execute(
                "INSERT INTO seedance2_voice_audio_records (episode_number, "
                "beat_number, speaker, audio_path, voice_sha256, mode, provider, "
                "model, generated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (1, 1, speaker, audio, "sha", "clone", "indextts2", "m", "now", "ok"),
            )
        conn.commit()
    finally:
        conn.close()
    await store.load_graph_state()

    await store.rename_character("林小满", "林满")

    conn = sqlite3.connect(project_dir / "data.db")
    try:
        rows = conn.execute(
            "SELECT speaker, audio_path FROM seedance2_voice_audio_records"
        ).fetchall()
    finally:
        conn.close()
    # 新名字下已有的那条留着，旧的丢掉——不是反过来。
    assert rows == [("林满_casual", "new.wav")]
