"""Adversarial source excerpts must not silently authorize model inventions."""
import json

import pytest

from novelvideo.director.fact_guard import boundary, inspect


def check(kind, entities, source, proofs=None):
    data = {"characters" if kind == "characters" else "locations": entities, "sourceProofs": proofs or []}
    return inspect(json.dumps(data), boundary(kind, {"source": source}))[1]


def proof(entity, field, value, quote):
    return {"entityId": entity, "field": field, "value": value, "inputId": "source", "quote": quote}


def test_age_and_unconfirmed_honorific_do_not_become_facts():
    char = {"id": "lin", "names": ["林夏"], "setting": "林夏25岁", "addressRules": "称陈伯为爷爷", "memorableDetail": "敲桌子", "pressureResponse": "摔杯子"}
    audit = check("characters", [char], "林夏接钥匙。陈伯不是亲属。年龄未知。")
    assert not audit["passed"]
    assert {item["field"] for item in audit["issues"]} == {"age", "addressRules", "memorableDetail", "pressureResponse"}


def test_only_grounded_subject_and_literal_values_pass():
    source = "林夏25岁。林夏接过钥匙。林夏称陈伯为陈先生。"
    char = {"id": "lin", "names": ["林夏"], "setting": "林夏25岁", "addressRules": "称陈伯为陈先生", "memorableDetail": "接过钥匙", "pressureResponse": None}
    audit = check("characters", [char], source, [proof("lin", "age", "25岁", "林夏25岁"), proof("lin", "addressRules", "称陈伯为陈先生", "林夏称陈伯为陈先生"), proof("lin", "memorableDetail", "接过钥匙", "林夏接过钥匙")])
    assert audit["passed"]


@pytest.mark.parametrize("source,quote", [("林夏年龄未知", "林夏25岁"), ("林夏不得25岁", "林夏不得25岁"), ("林夏看着60岁的陈伯", "林夏看着60岁的陈伯")])
def test_forged_or_forbidden_age_quote_fails(source, quote):
    age = "60岁" if "60" in quote else "25岁"
    assert not check("characters", [{"id": "lin", "names": ["林夏"], "setting": age}], source, [proof("lin", "age", age, quote)])["passed"]


def test_another_character_age_cannot_be_borrowed():
    source = "林夏看着陈伯60岁生日的照片"
    chars = [{"id": "lin", "names": ["林夏"], "setting": "60岁"}, {"id": "chen", "names": ["陈伯"]}]
    assert not check("characters", chars, source, [proof("lin", "age", "60岁", source)])["passed"]


@pytest.mark.parametrize("name,claim,source,valid", [("院子", "interior", "院子是室外露天", False), ("院子", "exterior", "院子是室外露天", True), ("会议室", "interior", "会议室有一张桌子", False), ("会议室", "interior", "会议室是室内", True), ("会议室", "interior", "会议室不是室内", False)])
def test_interior_exterior_must_be_explicit(name, claim, source, valid):
    assert check("scenes", [{"id": "one", "name": name, "type": claim}], source, [proof("one", "type", claim, source)])["passed"] is valid


def test_spatial_affordance_is_not_performed_action():
    scene = {"id": "room", "name": "修画室", "type": "unknown", "spatialConstraints": "只有一扇门", "reusablePositions": "把手机放桌上"}
    assert not check("scenes", [scene], "修画室有门，林夏手持手机")["passed"]


def test_explicit_unknowns_are_valid_without_manufactured_evidence():
    assert check("characters", [{"id": "one", "names": ["林夏"], "addressRules": None, "memorableDetail": "未确认", "pressureResponse": "未确认"}], "林夏来到这里")["passed"]
    assert check("scenes", [{"id": "one", "name": "门口", "type": "unknown", "spatialConstraints": "未知", "reusablePositions": "待确认"}], "门口")["passed"]


def test_duplicate_keys_and_missing_proofs_are_rejected():
    with pytest.raises(ValueError, match="DUPLICATE"):
        inspect('{"sourceProofs":[],"sourceProofs":[]}', boundary("characters", {}))
    assert not inspect('{"characters":[]}', boundary("characters", {}))[1]["passed"]


def test_room_alias_is_not_a_new_space_but_screen_qualifier_is_preserved():
    source = "室内走廊；走廊拐角有纸箱"
    scene = {"id": "one", "name": "室内走廊", "type": "unknown", "spatialConstraints": "走廊拐角有纸箱"}
    assert check("scenes", [scene], source, [proof("one", "spatialConstraints", "走廊拐角有纸箱", "走廊拐角有纸箱")])["passed"]
    duplicate = [{"id": "one", "name": "会议室", "type": "unknown"}, {"id": "two", "name": "会议室（同一间）", "type": "unknown"}]
    assert check("scenes", duplicate, "同一会议室")["issues"][0]["code"] == "FACT_DUPLICATE_SPACE"
    duplicate[1]["name"] = "电视中的会议室"
    assert check("scenes", duplicate, "会议室与电视中的会议室")["passed"]
    duplicate[0]["name"], duplicate[1]["name"] = "室内花园", "室外花园"
    assert check("scenes", duplicate, "室内花园与室外花园")["passed"]
