import json

from novelvideo.models import CharacterIdentity, NovelCharacter


def test_character_identity_age_group_assignment_normalizes_none():
    identity = CharacterIdentity(
        identity_id="江砚_书店时期",
        character_name="江砚",
        identity_name="书店时期",
    )

    identity.age_group = None

    assert identity.age_group == ""


def test_novel_character_identities_tolerate_historical_null_age_group():
    char = NovelCharacter(name="江砚")
    char.identities_json = json.dumps(
        [
            {
                "identity_id": "江砚_书店时期",
                "character_name": "江砚",
                "identity_name": "书店时期",
                "age_group": None,
            }
        ],
        ensure_ascii=False,
    )

    identities = char.identities

    assert len(identities) == 1
    assert identities[0].age_group == ""


def test_novel_character_identities_setter_does_not_serialize_null_age_group():
    char = NovelCharacter(name="孟桥生")
    identity = CharacterIdentity(
        identity_id="孟桥生_古玩店时期",
        character_name="孟桥生",
        identity_name="古玩店时期",
    )

    identity.age_group = None
    char.identities = [identity]

    payload = json.loads(char.identities_json)
    assert payload[0]["age_group"] == ""


def test_guoman_character_assets_override_preset_content_bias():
    from novelvideo.config import get_style_preset
    from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

    builder = NanoBananaCharacterGenerator.__new__(NanoBananaCharacterGenerator)
    style_keywords = get_style_preset("guoman_fantasy")["style_instructions"]
    portrait_prompt = builder._build_character_prompt(
        character_name="当铺老板",
        character_prompt="方脸，眉眼沉稳，眼角有细纹",
        character_tag="[DPLB]",
        style_name="guoman_fantasy",
        project_dir="",
        style_keywords=style_keywords,
        negative_keywords="no text",
        ethnicity="Chinese",
        identity_name="中年时期",
        gender="男",
        age_group="middle",
    )
    identity_prompt = builder._build_identity_locked_prompt(
        character_name="当铺老板",
        character_prompt="靛青棉麻长衫，黑发以木簪固定",
        character_tag="[DPLB]",
        target_view="front",
        style_name="guoman_fantasy",
        project_dir="",
        style_keywords=style_keywords,
        negative_keywords="no text",
        ethnicity="Chinese",
        identity_name="中年时期",
        gender="男",
        age_group="middle",
    )

    for prompt in (portrait_prompt, identity_prompt):
        assert "GUOMAN CHARACTER-ASSET OVERRIDE" in prompt
        assert "Target identity/state: 中年时期" in prompt
        assert "Target gender: male" in prompt
        assert "Target age group: middle-aged adult" in prompt
        assert "default high-status robes" in prompt
    assert "canonical identity anchor" in identity_prompt
    assert "natural age progression or regression of that same face" in identity_prompt
    assert "change age cues, not facial geometry or identity" in identity_prompt
    assert "Target gender confirms presentation only" in identity_prompt
    assert "conflicting hairstyle, clothing, crown" in identity_prompt
    assert "skin tone and age impression" not in identity_prompt
    assert "must not redesign the underlying face" in identity_prompt


def test_non_guoman_character_prompt_is_unchanged_by_guoman_override():
    from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

    builder = NanoBananaCharacterGenerator.__new__(NanoBananaCharacterGenerator)
    kwargs = dict(
        character_name="当铺老板",
        character_prompt="方脸，眉眼沉稳",
        character_tag="[DPLB]",
        style_name="realistic",
        project_dir="",
        style_keywords="cinematic realistic rendering",
        negative_keywords="no text",
    )
    original_prompt = builder._build_character_prompt(**kwargs)
    prompt_with_identity = builder._build_character_prompt(
        **kwargs,
        identity_name="中年时期",
        gender="男",
        age_group="middle",
    )

    assert prompt_with_identity == original_prompt
    assert "GUOMAN CHARACTER-ASSET OVERRIDE" not in prompt_with_identity
