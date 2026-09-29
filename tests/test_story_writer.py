from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from novelvideo.agents.story_writer import EpisodeOutput, SceneOutput, render_episode
from novelvideo.api.routes import story


@pytest.mark.parametrize(
    "doc_id",
    ["", "../secret", "folder/draft", "Uppercase", "a" * 65, "含中文"],
)
def test_story_doc_id_rejects_paths_and_noncanonical_names(doc_id: str) -> None:
    with pytest.raises(HTTPException) as exc_info:
        story._validated_doc_id(doc_id)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["code"] == "invalid_doc_id"


@pytest.mark.parametrize("doc_id", ["bible", "episode-01", "characters_v2", "a1"])
def test_story_doc_id_accepts_stable_file_names(doc_id: str) -> None:
    assert story._validated_doc_id(doc_id) == doc_id


def test_story_doc_atomic_write_round_trips_without_temp_files(tmp_path) -> None:
    path = tmp_path / "story" / "bible.json"
    payload = {"doc_id": "bible", "content": {"title": "铜雀台"}, "revision": 1}

    story._write_doc_atomic(path, payload)

    assert story._read_doc(path) == payload
    assert list(path.parent.glob("*.tmp")) == []


async def test_story_doc_revision_conflict_preserves_existing_content(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    async def resolve_context(**_kwargs):
        return SimpleNamespace(state_dir=tmp_path)

    monkeypatch.setattr(story, "resolve_project_context", resolve_context)
    first = await story.put_story_doc(
        "demo",
        "bible",
        {"content": {"title": "初稿"}, "base_revision": 0},
        user={"username": "writer"},
    )

    with pytest.raises(HTTPException) as exc_info:
        await story.put_story_doc(
            "demo",
            "bible",
            {"content": {"title": "过期覆盖"}, "base_revision": 0},
            user={"username": "writer"},
        )

    assert first["data"]["revision"] == 1
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "story_doc_conflict"
    assert story._read_doc(tmp_path / "story" / "bible.json")["content"] == {
        "title": "初稿"
    }


def test_render_episode_owns_the_import_contract_format() -> None:
    episode = EpisodeOutput(
        title="夜宴惊变",
        scenes=[
            SceneOutput(
                location="洛阳·司空府正堂",
                time_of_day="夜",
                interior=True,
                characters=["曹操", "荀彧"],
                lines=["△ 烛火忽暗。", "曹操：「门外何人？」"],
            ),
            SceneOutput(
                location="司空府门前",
                time_of_day="晨",
                interior=False,
                characters=[],
                lines=["△ 晨雾压住长街。"],
            ),
        ],
    )

    assert render_episode(3, episode) == (
        "3-1  洛阳·司空府正堂  夜  内\n"
        "人物：曹操、荀彧\n"
        "△ 烛火忽暗。\n"
        "曹操：「门外何人？」\n\n"
        "3-2  司空府门前  晨  外\n"
        "人物：—\n"
        "△ 晨雾压住长街。"
    )


async def test_story_model_failure_is_reported_as_gateway_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    async def resolve_context(**_kwargs):
        return SimpleNamespace(state_dir=tmp_path)

    class FailingAgent:
        async def run(self, _prompt: str):
            raise RuntimeError("configured model alias is unavailable")

    monkeypatch.setattr(story, "resolve_project_context", resolve_context)
    monkeypatch.setattr(story, "build_prose_agent", lambda: FailingAgent())

    with pytest.raises(HTTPException) as exc_info:
        await story.write_story_step(
            "demo",
            {"step_id": "plan", "prompt": "写一份创作方案"},
            user={"username": "writer"},
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail["code"] == "story_write_failed"
    assert "configured model alias is unavailable" in exc_info.value.detail["message"]
