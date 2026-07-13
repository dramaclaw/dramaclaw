import pytest
from pydantic import ValidationError
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.messages import ModelResponse, RetryPromptPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from novelvideo.agents.identity_planner import (
    AppearanceDescription,
    EpisodeIdentityRequirements,
    IdentityPlanner,
    IdentityRequirement,
)
from novelvideo.models import CharacterIdentity, NovelCharacter


VALID_APPEARANCE = "月白色棉麻长衫配深色腰带，衣襟绣有细密云纹，长发用木簪整齐束起"
VALID_FACE = "六七岁幼童，圆润小脸带有婴儿肥，杏眼明亮，鼻梁小巧，五官比例稚嫩"
VALID_BODY = "矮小圆润的幼童体型，身高仅及成人腰部"

OBSERVED_CORRUPTION = [
    "�body_type",
    "/* empty */",
    "proportbody_typeemonia",
    "焐body_typeملاحظة",
    " بقدرbody_type_",
    "proptobody_type\u200b",
    "♇body_type\u200c",
    (
        "𝔭body_type判定ing: empty for same age. Yes. Count: Let's check length of "
        "appearance_details.\n\n正常服装描述\n\nThat's about 50-60 characters. Perfect."
    ),
    "@returnsbody_type letztlich",
    "pensãobody_type}\r\n\r\n",
]


@pytest.mark.parametrize("corrupted", OBSERVED_CORRUPTION)
@pytest.mark.parametrize("field_name", ["appearance_details", "face_description", "body_type"])
def test_appearance_description_rejects_observed_corruption(field_name, corrupted):
    payload = {
        "appearance_details": VALID_APPEARANCE,
        "face_description": VALID_FACE,
        "age_group": "child",
        "body_type": VALID_BODY,
    }
    payload[field_name] = corrupted

    with pytest.raises(ValidationError):
        AppearanceDescription(**payload)


@pytest.mark.parametrize("appearance", ["", "   ", "过短描述", "长" * 201])
def test_appearance_description_requires_bounded_nonblank_appearance(appearance):
    with pytest.raises(ValidationError):
        AppearanceDescription(appearance_details=appearance)


@pytest.mark.parametrize(
    "appearance",
    [123456789012, ["月白色长衫", "深色腰带"], {"clothes": "月白色长衫配深色腰带"}],
)
def test_appearance_description_rejects_non_string_appearance(appearance):
    with pytest.raises(ValidationError):
        AppearanceDescription(appearance_details=appearance)


def test_appearance_description_rejects_single_line_reasoning_leak():
    with pytest.raises(ValidationError):
        AppearanceDescription(
            appearance_details="Let us reason step by step before returning the final clothing description"
        )


@pytest.mark.parametrize(
    ("face_description", "age_group", "body_type"),
    [
        (VALID_FACE, "", VALID_BODY),
        (VALID_FACE, "child", ""),
        ("", "child", VALID_BODY),
        ("", "child", ""),
    ],
)
def test_appearance_description_rejects_incomplete_age_variant_fields(
    face_description,
    age_group,
    body_type,
):
    with pytest.raises(ValidationError):
        AppearanceDescription(
            appearance_details=VALID_APPEARANCE,
            face_description=face_description,
            age_group=age_group,
            body_type=body_type,
        )


def test_appearance_description_strips_valid_ordinary_payload():
    result = AppearanceDescription(appearance_details=f"  {VALID_APPEARANCE}  ")

    assert result.appearance_details == VALID_APPEARANCE
    assert result.face_description == ""
    assert result.age_group == ""
    assert result.body_type == ""


def test_appearance_description_accepts_complete_age_variant_payload():
    result = AppearanceDescription(
        appearance_details=VALID_APPEARANCE,
        face_description=VALID_FACE,
        age_group="child",
        body_type=VALID_BODY,
    )

    assert result.face_description == VALID_FACE
    assert result.age_group == "child"
    assert result.body_type == VALID_BODY


class EmptyIdentityStore:
    def get_character(self, _name):
        return None


def _sequenced_appearance_model(payloads, captured_messages):
    call_index = 0

    def model_function(messages, agent_info):
        nonlocal call_index
        captured_messages.append(messages)
        payload = payloads[min(call_index, len(payloads) - 1)]
        call_index += 1
        output_tool = agent_info.output_tools[0]
        return ModelResponse(parts=[ToolCallPart(output_tool.name, payload)])

    return FunctionModel(model_function)


def _retry_parts(messages):
    return [
        part
        for message in messages
        for part in getattr(message, "parts", [])
        if isinstance(part, RetryPromptPart)
    ]


@pytest.mark.asyncio
async def test_generate_appearance_retries_twice_then_accepts_valid_output(monkeypatch):
    invalid = {
        "appearance_details": "�body_type",
        "face_description": "",
        "age_group": "",
        "body_type": "",
    }
    valid = {
        "appearance_details": VALID_APPEARANCE,
        "face_description": "",
        "age_group": "",
        "body_type": "",
    }
    captured_messages = []
    model = _sequenced_appearance_model([invalid, invalid, valid], captured_messages)
    monkeypatch.setattr(IdentityPlanner, "_identity_model", staticmethod(lambda _env: model))
    planner = IdentityPlanner(EmptyIdentityStore())

    result = await planner._generate_appearance("林知微", "少女时期", "", "回忆场景")

    assert result.appearance_details == VALID_APPEARANCE
    assert len(captured_messages) == 3
    assert not _retry_parts(captured_messages[0])
    assert _retry_parts(captured_messages[1])
    assert _retry_parts(captured_messages[2])


@pytest.mark.asyncio
async def test_generate_appearance_raises_after_three_invalid_outputs(monkeypatch):
    invalid = {
        "appearance_details": "/* empty */",
        "face_description": "",
        "age_group": "",
        "body_type": "",
    }
    captured_messages = []
    model = _sequenced_appearance_model([invalid], captured_messages)
    monkeypatch.setattr(IdentityPlanner, "_identity_model", staticmethod(lambda _env: model))
    planner = IdentityPlanner(EmptyIdentityStore())

    with pytest.raises(UnexpectedModelBehavior, match="maximum.*retries"):
        await planner._generate_appearance("林知微", "少女时期", "", "回忆场景")

    assert len(captured_messages) == 3
    assert _retry_parts(captured_messages[1])
    assert _retry_parts(captured_messages[2])


@pytest.mark.asyncio
async def test_generate_appearance_retries_non_string_tool_output(monkeypatch):
    invalid = {
        "appearance_details": 123456789012,
        "face_description": "",
        "age_group": "",
        "body_type": "",
    }
    valid = {
        "appearance_details": VALID_APPEARANCE,
        "face_description": "",
        "age_group": "",
        "body_type": "",
    }
    captured_messages = []
    model = _sequenced_appearance_model([invalid, valid], captured_messages)
    monkeypatch.setattr(IdentityPlanner, "_identity_model", staticmethod(lambda _env: model))
    planner = IdentityPlanner(EmptyIdentityStore())

    result = await planner._generate_appearance("林知微", "战斗装", "", "动作场景")

    assert result.appearance_details == VALID_APPEARANCE
    assert len(captured_messages) == 2
    assert _retry_parts(captured_messages[1])


@pytest.mark.asyncio
async def test_generate_appearance_retries_fields_missing_for_planned_age(monkeypatch):
    ordinary = {
        "appearance_details": VALID_APPEARANCE,
        "face_description": "",
        "age_group": "",
        "body_type": "",
    }
    age_variant = {
        "appearance_details": VALID_APPEARANCE,
        "face_description": VALID_FACE,
        "age_group": "child",
        "body_type": VALID_BODY,
    }
    captured_messages = []
    model = _sequenced_appearance_model([ordinary, ordinary, age_variant], captured_messages)
    monkeypatch.setattr(IdentityPlanner, "_identity_model", staticmethod(lambda _env: model))
    planner = IdentityPlanner(EmptyIdentityStore())

    result = await planner._generate_appearance(
        "林知微",
        "幼年时期",
        "child",
        "童年回忆",
    )

    assert result.age_group == "child"
    assert len(captured_messages) == 3
    assert _retry_parts(captured_messages[1])
    assert _retry_parts(captured_messages[2])


class RecordingIdentityStore:
    def __init__(self, character):
        self.character = character
        self.update_calls = []

    def resolve_name(self, name):
        return name

    def get_character(self, name):
        return self.character if name == self.character.name else None

    async def update_character_identity(self, character_name, identity_id, **updates):
        self.update_calls.append((character_name, identity_id, updates))


class ControlledAppearancePlanner(IdentityPlanner):
    def __init__(self, store, result=None, error=None):
        super().__init__(store)
        self.appearance_result = result
        self.appearance_error = error
        self.appearance_calls = []

    async def _generate_appearance(
        self,
        character_name,
        visual_state,
        planned_age_group,
        reason,
        on_log=None,
    ):
        self.appearance_calls.append(
            (character_name, visual_state, planned_age_group, reason)
        )
        if self.appearance_error:
            raise self.appearance_error
        return self.appearance_result


def _identity_character(identity):
    character = NovelCharacter(name="林知微", gender="女", age_group="youth")
    character.identities = [identity]
    return character


def _requirement(visual_state="战斗装", age_group=""):
    return EpisodeIdentityRequirements(
        requirements=[
            IdentityRequirement(
                character_name="林知微",
                visual_state=visual_state,
                age_group=age_group,
                reason="本集需要该造型",
            )
        ]
    )


@pytest.mark.asyncio
async def test_resolve_refills_only_narrowly_pending_planner_identity():
    identity = CharacterIdentity(
        identity_id="林知微_战斗装",
        character_name="林知微",
        identity_name="战斗装",
        source="identity_planner",
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(
        store,
        result=AppearanceDescription(appearance_details=VALID_APPEARANCE),
    )

    await planner._resolve_requirements(1, _requirement())

    assert len(planner.appearance_calls) == 1
    assert len(store.update_calls) == 1
    assert store.update_calls[0][2]["appearance_details"] == VALID_APPEARANCE


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["api", "freezone"])
async def test_resolve_does_not_refill_non_planner_empty_identity(source):
    identity = CharacterIdentity(
        identity_id="林知微_战斗装",
        character_name="林知微",
        identity_name="战斗装",
        source=source,
        costume_image="assets/user-costume.png" if source == "freezone" else "",
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(
        store,
        result=AppearanceDescription(appearance_details=VALID_APPEARANCE),
    )

    await planner._resolve_requirements(1, _requirement())

    assert planner.appearance_calls == []
    assert store.update_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("polluted_face", OBSERVED_CORRUPTION)
async def test_resolve_repairs_polluted_face_without_replacing_valid_appearance(
    polluted_face,
):
    identity = CharacterIdentity(
        identity_id="林知微_战斗装",
        character_name="林知微",
        identity_name="战斗装",
        source="identity_planner",
        appearance_details=VALID_APPEARANCE,
        face_prompt=polluted_face,
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(
        store,
        result=AppearanceDescription(appearance_details="深青色窄袖劲装配皮质护腕，腰束革带悬挂短刃，长发高束便于行动"),
    )

    await planner._resolve_requirements(1, _requirement())

    assert len(planner.appearance_calls) == 1
    assert len(store.update_calls) == 1
    updates = store.update_calls[0][2]
    assert updates["face_prompt"] == ""
    assert "appearance_details" not in updates


@pytest.mark.asyncio
async def test_resolve_repairs_polluted_body_without_overwriting_valid_user_face():
    identity = CharacterIdentity(
        identity_id="林知微_幼年时期",
        character_name="林知微",
        identity_name="幼年时期",
        source="identity_planner",
        appearance_details=VALID_APPEARANCE,
        face_prompt=VALID_FACE,
        age_group="child",
        body_type="pensãobody_type}",
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(
        store,
        result=AppearanceDescription(
            appearance_details="浅粉色棉布短袄配百褶裙，腰系红绳，双丫髻点缀小巧绢花",
            face_description="八岁幼童，鹅蛋脸轮廓柔和，杏眼清亮，鼻唇小巧，双颊带婴儿肥",
            age_group="child",
            body_type=VALID_BODY,
        ),
    )

    await planner._resolve_requirements(1, _requirement("幼年时期", "child"))

    assert len(store.update_calls) == 1
    updates = store.update_calls[0][2]
    assert updates["body_type"] == VALID_BODY
    assert "face_prompt" not in updates
    assert "age_group" not in updates


@pytest.mark.asyncio
async def test_repair_prefers_persisted_age_group_when_requirement_has_none():
    identity = CharacterIdentity(
        identity_id="林知微_回忆装",
        character_name="林知微",
        identity_name="回忆装",
        source="identity_planner",
        appearance_details=VALID_APPEARANCE,
        face_prompt=VALID_FACE,
        age_group="child",
        body_type="�body_type",
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(
        store,
        result=AppearanceDescription(
            appearance_details="浅粉色棉布短袄配百褶裙，腰系红绳，双丫髻点缀小巧绢花",
            face_description=VALID_FACE,
            age_group="child",
            body_type=VALID_BODY,
        ),
    )

    await planner._resolve_requirements(1, _requirement("回忆装", ""))

    assert planner.appearance_calls[0][2] == "child"
    assert store.update_calls[0][2]["body_type"] == VALID_BODY


@pytest.mark.asyncio
async def test_resolve_pending_generation_failure_performs_no_write():
    identity = CharacterIdentity(
        identity_id="林知微_战斗装",
        character_name="林知微",
        identity_name="战斗装",
        source="identity_planner",
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(store, error=RuntimeError("model unavailable"))

    await planner._resolve_requirements(1, _requirement())

    assert len(planner.appearance_calls) == 1
    assert store.update_calls == []


@pytest.mark.asyncio
async def test_resolve_corrupt_generation_failure_clears_only_polluted_field():
    identity = CharacterIdentity(
        identity_id="林知微_战斗装",
        character_name="林知微",
        identity_name="战斗装",
        source="identity_planner",
        appearance_details=VALID_APPEARANCE,
        face_prompt="/* empty */",
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(store, error=RuntimeError("model unavailable"))

    await planner._resolve_requirements(1, _requirement())

    assert len(store.update_calls) == 1
    assert store.update_calls[0][2] == {"face_prompt": ""}


@pytest.mark.asyncio
async def test_resolve_inconsistent_merge_clears_only_polluted_field():
    identity = CharacterIdentity(
        identity_id="林知微_幼年时期",
        character_name="林知微",
        identity_name="幼年时期",
        source="identity_planner",
        appearance_details=VALID_APPEARANCE,
        face_prompt="�body_type",
        age_group="child",
        body_type="",
    )
    store = RecordingIdentityStore(_identity_character(identity))
    planner = ControlledAppearancePlanner(
        store,
        result=AppearanceDescription(
            appearance_details="浅粉色棉布短袄配百褶裙，腰系红绳，双丫髻点缀小巧绢花",
            face_description=VALID_FACE,
            age_group="child",
            body_type=VALID_BODY,
        ),
    )
    logs = []

    await planner._resolve_requirements(
        1,
        _requirement("幼年时期", "child"),
        on_log=logs.append,
    )

    assert store.update_calls[0][2] == {"face_prompt": ""}
    assert any("无法在保留有效字段" in message for message in logs)
