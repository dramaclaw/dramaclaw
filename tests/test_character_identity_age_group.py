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


def test_guoman_identity_sheet_uses_rendering_only_style_instructions():
    from novelvideo.config import get_style_preset
    from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

    builder = NanoBananaCharacterGenerator.__new__(NanoBananaCharacterGenerator)
    style_keywords = get_style_preset("guoman_fantasy")["style_instructions"]
    identity_prompt = builder._build_identity_locked_prompt(
        character_name="当铺老板",
        character_prompt="靛青色棉麻长衫，立领盘扣，黑发以木簪固定",
        character_tag="[DPLB]",
        target_view="front",
        style_name="guoman_fantasy",
        project_dir="",
        style_keywords=style_keywords,
        negative_keywords="no text",
        ethnicity="Chinese",
    )

    assert "Apply this style only to the rendering medium" in identity_prompt
    assert "The identity reference, when provided, defines the face and identity" in identity_prompt
    assert "The costume reference, when provided, takes priority for clothing" in identity_prompt
    assert "CHARACTER DETAILS define any remaining explicit face" in identity_prompt
    assert "靛青色棉麻长衫，立领盘扣，黑发以木簪固定" in identity_prompt
    assert "Preserve the same character identity EXACTLY" in identity_prompt
    assert "skin tone and age impression" in identity_prompt
    assert "Dunhuang flying-apsera" not in identity_prompt
    assert "high-status fantasy robes" not in identity_prompt
    assert "Keep the image transparent" not in identity_prompt


def test_guoman_identity_sheet_preserves_costume_reference_priority():
    from novelvideo.config import get_style_preset
    from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

    builder = NanoBananaCharacterGenerator.__new__(NanoBananaCharacterGenerator)
    style_keywords = get_style_preset("guoman_fantasy")["style_instructions"]
    prompt = builder._build_identity_locked_prompt(
        character_name="当铺老板",
        character_prompt="靛青色棉麻长衫",
        character_tag="[DPLB]",
        target_view="front",
        style_name="guoman_fantasy",
        project_dir="",
        style_keywords=style_keywords,
        negative_keywords="no text",
        ethnicity="Chinese",
        has_costume_reference=True,
    )

    assert "The costume reference, when provided, takes priority for clothing" in prompt
    assert "The costume reference takes PRIORITY over the text description" in prompt


def test_identity_sheet_keeps_non_guoman_style_instructions_unchanged():
    from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

    builder = NanoBananaCharacterGenerator.__new__(NanoBananaCharacterGenerator)
    prompt = builder._build_identity_locked_prompt(
        character_name="当铺老板",
        character_prompt="靛青色棉麻长衫",
        character_tag="[DPLB]",
        target_view="front",
        style_name="realistic",
        project_dir="",
        style_keywords="UNIQUE CUSTOM REALISTIC STYLE",
        negative_keywords="no text",
        ethnicity="Chinese",
    )

    assert "UNIQUE CUSTOM REALISTIC STYLE" in prompt
    assert "Apply this style only to the rendering medium" not in prompt
