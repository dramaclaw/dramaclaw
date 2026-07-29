from __future__ import annotations

import pytest

from novelvideo.models import NovelEpisode
from novelvideo.sqlite_store import SQLiteStore, load_episode_planning_content

pytestmark = pytest.mark.m03


@pytest.mark.asyncio
async def test_adapted_content_overrides_raw_working_content(tmp_path) -> None:
    output_dir = tmp_path / "output" / "admin" / "demo"
    state_dir = tmp_path / "state" / "admin" / "demo"
    store = SQLiteStore("admin/demo", output_dir=str(output_dir), state_dir=str(state_dir))
    try:
        await store.initialize()
        await store.add_episodes(
            [
                NovelEpisode(
                    number=1,
                    title="第一集",
                    raw_content="原文第一行\n原文第二行",
                )
            ]
        )

        assert await store.load_working_content(1) == "原文第一行\n原文第二行"

        await store.save_adapted_content(1, "改写第一行\n改写第二行")

        assert await store.load_adapted_content(1) == "改写第一行\n改写第二行"
        assert await store.load_working_content(1) == "改写第一行\n改写第二行"
        assert (
            await load_episode_planning_content(
                store,
                NovelEpisode(number=1, title="第一集"),
            )
            == "改写第一行\n改写第二行"
        )

        assert (
            await load_episode_planning_content(
                store,
                NovelEpisode(
                    number=1,
                    title="第一集",
                    beat_source_text="最终制作稿第一行\n最终制作稿第二行",
                ),
            )
            == "最终制作稿第一行\n最终制作稿第二行"
        )

        await store.save_adapted_content(1, "")

        assert await store.load_adapted_content(1) == ""
        assert await store.load_working_content(1) == "原文第一行\n原文第二行"
        assert (
            await load_episode_planning_content(
                store,
                NovelEpisode(number=1, title="第一集"),
            )
            == "原文第一行\n原文第二行"
        )
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_save_adapted_content_requires_existing_episode(tmp_path) -> None:
    store = SQLiteStore(
        "admin/demo",
        output_dir=str(tmp_path / "output" / "admin" / "demo"),
        state_dir=str(tmp_path / "state" / "admin" / "demo"),
    )
    try:
        await store.initialize()
        with pytest.raises(ValueError, match="剧集 99 不存在"):
            await store.save_adapted_content(99, "missing")
    finally:
        await store.close()


class _RewriteRouteStore:
    def __init__(self):
        self.adapted_content = ""
        self.episode_updates: list[tuple[int, dict]] = []
        self.episode = NovelEpisode(number=1, title="第一集", raw_content="原文")

    async def load_episode_content(self, ep_num: int):
        return self.episode.raw_content if ep_num == self.episode.number else ""

    async def load_graph_state(self):
        return None

    def get_episode(self, ep_num: int):
        return self.episode if ep_num == self.episode.number else None

    def get_all_characters(self):
        return []

    async def save_adapted_content(self, ep_num: int, content: str) -> None:
        assert ep_num == self.episode.number
        self.adapted_content = content

    async def update_episode(self, episode_number: int, **updates) -> None:
        self.episode_updates.append((episode_number, updates))
        for key, value in updates.items():
            setattr(self.episode, key, value)


@pytest.mark.asyncio
async def test_generate_rewrite_applies_output_to_beat_source_text(monkeypatch) -> None:
    from novelvideo.agents import content_rewriter
    from novelvideo.api.routes import content
    from novelvideo.api.schemas import RewriteGenerateRequest

    async def fake_rewrite_episode_content(*args, **kwargs):
        return "改写第一行\n改写第二行"

    monkeypatch.setattr(
        content_rewriter,
        "rewrite_episode_content",
        fake_rewrite_episode_content,
    )

    store = _RewriteRouteStore()
    response = await content.generate_rewrite(
        project="demo",
        episode_num=1,
        body=RewriteGenerateRequest(),
        user={"username": "admin"},
        store=store,
    )

    assert response["ok"] is True
    assert store.adapted_content == "改写第一行\n改写第二行"
    assert store.episode.beat_source_text == "改写第一行\n改写第二行"
    assert store.episode_updates == [
        (1, {"beat_source_text": "改写第一行\n改写第二行"})
    ]


@pytest.mark.asyncio
async def test_content_rewriter_uses_newapi_text_model(monkeypatch) -> None:
    from novelvideo.agents import content_rewriter

    calls: dict[str, object] = {}

    class FakeAgent:
        def __init__(self, model, **kwargs):
            calls["model"] = model
            calls["kwargs"] = kwargs

        async def run(self, task: str):
            calls["task"] = task
            return type(
                "FakeResult",
                (),
                {
                    "output": content_rewriter.AdaptedContentOutput(
                        lines=["改写第一行", "改写第二行"]
                    )
                },
            )()

    def fake_newapi_model(model_env: str, default_model: str):
        calls["model_env"] = model_env
        calls["default_model"] = default_model
        return "newapi-model"

    def fake_newapi_settings(thinking_env: str, default_thinking_level: str):
        calls["thinking_env"] = thinking_env
        calls["default_thinking_level"] = default_thinking_level
        return {"openai_reasoning_effort": default_thinking_level}

    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setattr(content_rewriter, "Agent", FakeAgent)
    monkeypatch.setattr(
        content_rewriter,
        "get_newapi_text_pydantic_model",
        fake_newapi_model,
        raising=False,
    )
    monkeypatch.setattr(
        content_rewriter,
        "get_newapi_text_pydantic_model_settings",
        fake_newapi_settings,
        raising=False,
    )

    rewritten = await content_rewriter.rewrite_episode_content(
        "原文第一段",
        episode_title="第一集",
        target_beats=2,
    )

    assert rewritten == "改写第一行\n改写第二行"
    assert calls["model"] == "newapi-model"
    assert calls["model_env"] == "CONTENT_REWRITER_MODEL"
    assert calls["default_model"] == "gpt-5.4-mini"
    assert calls["thinking_env"] == "CONTENT_REWRITER_THINKING_LEVEL"
    assert calls["default_thinking_level"] == "medium"
