from types import SimpleNamespace

import pytest

import novelvideo.agents.identity_planner as identity_planner_module
from novelvideo.agents.identity_planner import (
    AppearanceDescription,
    DefaultIdentityRequirement,
    EpisodeDefaultIdentities,
    EpisodeIdentityRequirements,
    IdentityPlanner,
    IdentityRequirement,
)


class _Store:
    state_dir = None

    def __init__(self):
        self.character = SimpleNamespace(
            name="Han Ji-won",
            gender="female",
            age_group="youth",
            face_prompt="",
            body_type="",
            identities=[],
        )

    def resolve_name(self, name):
        return name

    def get_character(self, name):
        return self.character if name == self.character.name else None

    def get_all_characters(self):
        return [self.character]

    async def add_character_identity(self, _name, identity):
        self.character.identities.append(identity)


@pytest.mark.asyncio
@pytest.mark.parametrize("analysis", ["default", "special"])
async def test_english_identity_analysis_explicitly_requires_english(
    monkeypatch, analysis
):
    captured = []

    class FakeAgent:
        def __init__(self, *args, system_prompt="", output_type=None, **kwargs):
            captured.append((system_prompt, output_type))
            self.output_type = output_type

        async def run(self, task):
            captured.append((task, None))
            if self.output_type is EpisodeDefaultIdentities:
                output = EpisodeDefaultIdentities(
                    defaults=[
                        DefaultIdentityRequirement(
                            character_name="Han Ji-won",
                            visual_state="Young adulthood",
                            age_group="youth",
                            reason="The present-day timeline",
                        )
                    ]
                )
            else:
                output = EpisodeIdentityRequirements(
                    requirements=[
                        IdentityRequirement(
                            character_name="Han Ji-won",
                            visual_state="At age six",
                            age_group="child",
                            reason="A childhood flashback",
                        )
                    ]
                )
            return SimpleNamespace(output=output)

    monkeypatch.setattr(identity_planner_module, "Agent", FakeAgent)
    monkeypatch.setattr(
        IdentityPlanner,
        "_identity_model",
        staticmethod(lambda _env, **_kwargs: None),
    )
    planner = IdentityPlanner(_Store())
    episode = SimpleNamespace(number=1, title="The Last Letter")
    source = "INT. STATION - NIGHT\nHan Ji-won waits alone on the platform."

    if analysis == "default":
        await planner._analyze_default_identities(
            episode, cast_names=["Han Ji-won"], content_text=source
        )
    else:
        await planner._analyze_special_identities(
            episode, cast_names=["Han Ji-won"], content_text=source
        )

    prompt_text = "\n".join(value for value, _ in captured if isinstance(value, str))
    assert "Write every user-visible prose field in English" in prompt_text


@pytest.mark.asyncio
async def test_english_identity_appearance_explicitly_requires_english(monkeypatch):
    captured = []

    class FakeAgent:
        def __init__(self, *args, system_prompt="", **kwargs):
            captured.append(system_prompt)

        async def run(self, task):
            captured.append(task)
            return SimpleNamespace(
                output=AppearanceDescription(
                    appearance_details=(
                        "A charcoal wool coat over a pale cotton blouse, with a narrow "
                        "leather belt and neatly tied dark hair."
                    )
                )
            )

    monkeypatch.setattr(identity_planner_module, "Agent", FakeAgent)
    monkeypatch.setattr(IdentityPlanner, "_identity_model", staticmethod(lambda _env: None))
    planner = IdentityPlanner(_Store())

    await planner._generate_appearance(
        "Han Ji-won", "青年时期", "", "当前时间线", output_language="en"
    )

    prompt_text = "\n".join(captured)
    assert "Write every user-visible prose field in English" in prompt_text
    assert "使用中文" not in prompt_text


@pytest.mark.asyncio
async def test_resolve_threads_screenplay_language_into_appearance_recovery(monkeypatch):
    planner = IdentityPlanner(_Store())
    seen = {}

    async def fake_recover(**kwargs):
        seen.update(kwargs)
        return True

    monkeypatch.setattr(planner, "_recover_identity_appearance", fake_recover)

    await planner._resolve_requirements(
        1,
        EpisodeIdentityRequirements(
            requirements=[
                IdentityRequirement(
                    character_name="Han Ji-won",
                    visual_state="青年时期",
                    reason="修复前生成的中文身份标签",
                )
            ]
        ),
        output_language="en",
    )

    assert seen["output_language"] == "en"
