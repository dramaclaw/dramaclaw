import pytest

from novelvideo.agents.identity_planner import (
    DefaultIdentityRequirement,
    EpisodeDefaultIdentities,
    EpisodeIdentityRequirements,
    IdentityPlanner,
)
from novelvideo.models import NovelCharacter, NovelEpisode


class FakeIdentityStore:
    def __init__(self, content, working_content=""):
        self.content = content
        self.working_content = working_content
        self.sqlite_store = self
        self._characters = {}
        self.updated_episode = None

    def get_all_characters(self):
        return list(self._characters.values())

    async def load_working_content(self, episode_number):
        return self.working_content

    async def load_episode_content(self, episode_number):
        return self.content

    def resolve_name(self, name):
        return name

    def get_character(self, name):
        return self._characters.get(name)

    async def add_character(self, character):
        self._characters[character.name] = character

    async def update_episode(self, episode_number, **updates):
        self.updated_episode = (episode_number, updates)


class ExistingCharacterIdentityPlanner(IdentityPlanner):
    async def _filter_cast(self, all_names, content_text, episode, on_log=None):
        assert "陆辰" in all_names
        self.filtered_content_text = content_text
        return ["陆辰"], ""

    async def _analyze_default_identities(
        self,
        episode,
        on_log=None,
        cast_names=None,
        content_text=None,
        graph_context="",
    ):
        return EpisodeDefaultIdentities(
            defaults=[
                DefaultIdentityRequirement(
                    character_name="陆辰",
                    visual_state="默认",
                    reason="图谱已有角色，场次头明确标注出场人物",
                )
            ]
        )

    async def _resolve_requirements(self, episode_number, requirements, on_log=None):
        return 0, ["陆辰_默认"], {("陆辰", "默认"): "陆辰_默认"}

    async def _analyze_special_identities(
        self,
        episode,
        on_log=None,
        cast_names=None,
        content_text=None,
        graph_context="",
        already_resolved=None,
    ):
        return EpisodeIdentityRequirements()


class MissingCharacterIdentityPlanner(IdentityPlanner):
    async def _filter_cast(self, all_names, content_text, episode, on_log=None):
        assert all_names == []
        assert self.cognee_store.get_character("陆辰") is None
        return [], ""


@pytest.mark.asyncio
async def test_identity_planner_uses_existing_characters_without_auto_creation():
    store = FakeIdentityStore(
        """
场次（1） 地点：地下室，夜，内；出场人物：陆辰
陆辰推开一个腐朽的空书架。
"""
    )
    await store.add_character(
        NovelCharacter(
            name="陆辰",
            aliases=["陆先生"],
            gender="男",
            description="手动确认过的全局角色",
        )
    )
    planner = ExistingCharacterIdentityPlanner(store)

    new_count, resolved_count = await planner.plan_single_episode(
        NovelEpisode(number=1, title="命运之书")
    )

    assert new_count == 0
    assert resolved_count == 1
    assert sorted(store._characters) == ["陆辰"]
    assert planner.auto_promoted_characters == []
    assert store.updated_episode == (
        1,
        {
            "identity_ids": ["陆辰_默认"],
            "character_names": ["陆辰"],
            "identity_default_map": {"陆辰": "陆辰_默认"},
        },
    )


@pytest.mark.asyncio
async def test_identity_planner_prefers_current_production_text():
    store = FakeIdentityStore(
        "原始剧本中的陆辰。",
        working_content="改写工作稿中的陆辰。",
    )
    await store.add_character(NovelCharacter(name="陆辰"))
    planner = ExistingCharacterIdentityPlanner(store)

    await planner.plan_single_episode(
        NovelEpisode(
            number=1,
            title="命运之书",
            beat_source_text="最终制作稿中的陆辰。",
        )
    )

    assert planner.filtered_content_text == "最终制作稿中的陆辰。"


@pytest.mark.asyncio
async def test_identity_planner_does_not_auto_create_missing_characters():
    store = FakeIdentityStore(
        """
场次（1） 地点：地下室，夜，内；出场人物：陆辰
陆辰推开一个腐朽的空书架。
"""
    )
    planner = MissingCharacterIdentityPlanner(store)

    with pytest.raises(ValueError, match="Pass 0"):
        await planner.plan_single_episode(NovelEpisode(number=1, title="命运之书"))

    assert store.get_character("陆辰") is None
    assert planner.auto_promoted_characters == []
    assert store.updated_episode is None
