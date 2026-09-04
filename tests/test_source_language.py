import pytest

from novelvideo.utils.source_language import (
    asset_language_instruction,
    detect_asset_language,
)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("第一场 客厅 日 内\n林默推开门。", "zh"),
        ("INT. LIVING ROOM - DAY\nMAYA opens the door.", "en"),
        ("ABC门打开", "zh"),
        ("第一話\n図書館で美咲が本を開く。", "zh"),
        ("제1화\n도서관에서 민지가 책을 펼친다.", "zh"),
        ("INT. LIBRARY - DAY\n美咲は歩く。", "zh"),
        ("SCENE 1 - ROOM\n민지가 문을 연다.", "zh"),
        ("ESCENA 1 - SALÓN - DÍA\nMaría abre la puerta.", "zh"),
        ("SCENE 1 - ROOM\n女孩走进房间。", "zh"),
        ("INT. LIVING ROOM - DAY\n林默进门。", "zh"),
        ("SCENE 1 - CENTRAL LIBRARY - MORNING\n女孩走进房间。", "zh"),
        ("INT. CAFÉ - DAY\nChloë enters the room.", "en"),
        ("INT. CAFÉ - DAY\nChloë smiles.", "en"),
        ("INT. ROOM - DAY\nChloë nods.", "en"),
        ("MAYA laughs.", "en"),
        ("MAYA cries.", "en"),
        ("John pauses.", "en"),
        ("INT. ROOM - DAY\n민지 opens the door.", "en"),
        ("INT. SUBWAY STATION - NIGHT\nJi-won raises her phone.", "en"),
        ("SCENE 1 - ROOM\nLocation: Room\nMAYA: Go now.", "en"),
        ("MAYA: Go!", "en"),
        ("INT. ROOM - DAY\nMAYA: Open the door.", "en"),
        ("INT. ROOM - DAY\nMAYA\nI love you.", "en"),
        ("ESCENA 1 - SALON - DIA\nMaria abre la puerta.", "zh"),
        ("Er geht in das Zimmer.", "zh"),
        ("On entre dans la pièce.", "zh"),
        ("Lei entra in camera.", "zh"),
        ("Tú corres.", "zh"),
        ("JUAN: Tú corres.", "zh"),
        ("Tú comes.", "zh"),
        ("JUAN: Tú comes.", "zh"),
        ("Tu marches.", "zh"),
        ("Dia sering tersenyum.", "zh"),
        ("Christopher Montgomery：你好。", "zh"),
        ("", "zh"),
    ],
)
def test_detect_asset_language_uses_the_dominant_script(source, expected):
    assert detect_asset_language(source) == expected


def test_english_instruction_keeps_prose_english_and_names_verbatim():
    instruction = asset_language_instruction("en")

    assert "English" in instruction
    assert "verbatim" in instruction


def test_chinese_instruction_keeps_prose_chinese_and_names_unchanged():
    instruction = asset_language_instruction("zh")

    assert "中文" in instruction
    assert "原样" in instruction
