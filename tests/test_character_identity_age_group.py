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
