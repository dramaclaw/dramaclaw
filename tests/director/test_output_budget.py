"""Creative length survives automatic budgeting; previews never spend money."""

import copy

import pytest

from novelvideo.director.output_budget import output_budget
from novelvideo.director.schemas.execution import QuoteWriting
from novelvideo.director.schemas.execution import ExecutionFault
from novelvideo.director.schemas.planning import PlanningQuote
from tests.director.test_execution import command, runtime as runtime


@pytest.mark.parametrize("stage,expected", [("M03", 8192), ("M07", 12288), ("M12", 32768), ("episode", 8192)])
def test_task_specific_budget_does_not_rewrite_user_settings(stage, expected):
    spec = {"episode_count": 1, "duration_seconds": 600}
    before = copy.deepcopy(spec)
    budget = output_budget(stage, spec, source_chars=2500)
    assert budget["maxOutputTokens"] == expected
    assert budget["mode"] == "automatic"
    assert spec == before


def test_longer_episode_requires_a_section_plan_not_shorter_duration():
    spec = {"episode_count": 1, "duration_seconds": 3600}
    budget = output_budget("episode", spec)
    assert budget["requiresSectionPlan"] is True
    assert budget["basis"]["durationSeconds"] == 3600
    assert budget["capacitySource"] == "conservative_runtime_policy"


def test_original_series_count_does_not_turn_one_episode_into_all_episodes():
    assert output_budget("episode", {"episode_count": 100, "duration_seconds": 600})["maxOutputTokens"] == 8192
    assert output_budget("M07", {"episode_count": 100, "duration_seconds": 600})["requiresSectionPlan"] is True


def test_api_omission_selects_automatic_and_legacy_explicit_remains_explicit():
    assert QuoteWriting.from_wire({"type": "cost.quote", "kind": "outline"}).max_output_tokens is None
    assert PlanningQuote.from_wire({"type": "planning.quote"}).max_output_tokens is None
    budget = output_budget("M07", {"episode_count": 1, "duration_seconds": 600}, explicit=1024)
    assert budget["mode"] == "explicit" and budget["maxOutputTokens"] == 1024


def test_automatic_quote_freezes_request_but_does_not_call_provider(runtime):
    store, work, _, repo, service = runtime
    intent = command(work, {"type": "cost.quote", "kind": "outline"})
    quote = service.execute("writer", intent)["result"]
    assert quote["limits"]["maxOutputTokens"] == 12288
    assert quote["parameters"]["outputBudget"]["maxOutputTokens"] == 12288
    assert quote["parameters"]["duration_seconds"] == work["preset"]["duration_seconds"]
    assert not repo.list_operations(work["id"])
    assert store.get_document(work["id"], "outline")["version"] == 0


def test_known_oversize_is_stopped_before_quote_or_charge_without_touching_text(runtime):
    store, work, _, repo, service = runtime
    content = "Preserve this complete long source paragraph. " * 800
    store.put_document(work["id"], "outline", content, 0)
    intent = command(work, {"type": "cost.quote", "kind": "outline"},
                     revision=store.get_work(work["id"])["revision"], version=1)
    with pytest.raises(ExecutionFault, match="SECTION_PLAN_REQUIRED"):
        service.execute("writer", intent)
    assert store.get_document(work["id"], "outline")["content"] == content
    assert not repo.list_operations(work["id"])
    with store._connect() as db:
        assert db.execute("SELECT count(*) FROM director_quotes").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM director_cost_entries").fetchone()[0] == 0
