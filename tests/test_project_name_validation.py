import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from novelvideo.api.deps import validate_project_name
from novelvideo.api.schemas import ProjectCreate


@pytest.mark.parametrize(
    "name", ["a", "a" * 64, "project_01", "万事屋", "中文项目_2026", "Drama中文", "中" * 64,
             "胡来万事屋- 副本", "《弥寿计划》Ⅱ- 副本", "has space", "has-dash", "项目😀"]
)
def test_schema_accepts_valid_project_name_lengths(name):
    assert ProjectCreate(name=name).name == name
    validate_project_name(name)


def test_schema_rejects_65_character_project_name():
    with pytest.raises(ValidationError, match="64"):
        ProjectCreate(name="a" * 65)


def test_shared_validator_rejects_65_character_project_name():
    with pytest.raises(HTTPException) as exc:
        validate_project_name("a" * 65)
    assert exc.value.status_code == 400
    assert exc.value.detail == "Project name must be at most 64 characters long"


@pytest.mark.parametrize(
    "name",
    ["", "   ", "has/slash", "_hidden", "_中文", "中文/项目", "../项目", ".", "..", "项目\n", "a|b"],
)
def test_shared_validator_keeps_existing_format_rules(name):
    with pytest.raises(HTTPException):
        validate_project_name(name)


def test_chinese_length_limit_matches_schema_and_validator():
    with pytest.raises(ValidationError):
        ProjectCreate(name="中" * 65)
    with pytest.raises(HTTPException):
        validate_project_name("中" * 65)
