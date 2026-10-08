"""Whole-input coverage, grounded failures and prior-episode invalidation."""
import copy
import json
from uuid import uuid4

import pytest

from novelvideo.director.episode_facts import FACT_VERSION, fact_units, validate_episode_facts
from novelvideo.director.quality import QualityService, compile_review, review_inputs, save_review
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.store import DirectorStore
from tests.director.test_quality import response


def frozen():
    inputs = {"document": "# Episode 2\n\nAda places the phone on the table.\n\nTAIL: She opens it again.",
              "brief": "The phone stays in Ada's hand. No new prop.",
              "episode-001": "Ada is holding the phone.", "locked": "No family name or age is confirmed."}
    return {"contentHash": "a" * 64, "factAuditVersion": FACT_VERSION, "inputs": inputs, "factUnits": fact_units(inputs)}


def audit(f):
    return response(f)["episodeFacts"]


def contradiction(f):
    data = audit(f)
    row = data["units"][1]
    row.update(disposition="FACTS", facts=[{
        "subject": "Ada's phone", "relation": "position", "value": "table",
        "before": "Ada's hand", "after": "table", "layer": "real", "status": "CONTRADICTED",
        "explanation": "The draft relocates an object expressly locked to her hand.",
        "evidence": [{"inputId": "document", "quote": "Ada places the phone on the table."},
                     {"inputId": "brief", "quote": "The phone stays in Ada's hand."}]}])
    return data


def test_every_non_whitespace_character_including_tail_and_all_prior_inputs_is_covered():
    f = frozen()
    for key, text in f["inputs"].items():
        ranges = [(u["start"], u["end"]) for u in f["factUnits"] if u["inputId"] == key]
        assert all(c.isspace() or any(a <= i < b for a, b in ranges) for i, c in enumerate(text))
    assert any("TAIL" in u["text"] for u in f["factUnits"])
    result = validate_episode_facts(audit(f), f)
    assert result["status"] == "REVIEWED"
    assert result["coverage"]["valid"] == len(f["factUnits"])
    assert not result["coverage"]["semanticCompletenessVerified"]
    assert all(u["requiresHumanCheck"] for u in result["units"] if not u["structural"])


def test_scene_headers_cannot_escape_factual_review_and_prior_events_can_contain_facts():
    units = fact_units({"document": "# 第2集\n\n## 办公室 日 内\n\n## Office DAY INT.\n\n## Ada dies\n\n# 第2集 手机已经归还\n\n# Episode 2: Ada dies"})
    assert [u["structural"] for u in units] == [True, False, False, False, False, False]
    f = frozen()
    data = contradiction(f)
    fact = copy.deepcopy(data["units"][1]["facts"][0])
    prior = next(u for u in f["factUnits"] if u["inputId"] == "episode-001")
    fact.update(status="SUPPORTED", evidence=[{"inputId": "episode-001", "quote": "Ada is holding the phone."}, {"inputId": "brief", "quote": "The phone stays in Ada's hand."}])
    row = next(u for u in data["units"] if u["unitId"] == prior["id"])
    row.update(disposition="OTHER_EPISODE", facts=[fact])
    result = validate_episode_facts(data, f)
    assert next(u for u in result["units"] if u["id"] == prior["id"])["valid"]


@pytest.mark.parametrize("change", ["missing", "duplicate", "unknown", "metadata", "future", "empty_facts"])
def test_missing_or_skipped_coverage_cannot_finalize(change):
    f = frozen()
    data = audit(f)
    if change == "missing":
        data["units"].pop()
    elif change == "duplicate":
        data["units"].append(copy.deepcopy(data["units"][0]))
    elif change == "unknown":
        data["units"][0]["unitId"] = "invented"
    elif change == "metadata":
        data["units"][1]["disposition"] = "METADATA"
    elif change == "future":
        data["units"][1]["disposition"] = "OTHER_EPISODE"
    else:
        data["units"][1]["disposition"] = "FACTS"
    assert validate_episode_facts(data, f)["status"] == "UNAVAILABLE"


def test_grounded_contradiction_survives_unrelated_missing_paragraph():
    f = frozen()
    data = contradiction(f)
    data["units"].pop()
    result = validate_episode_facts(data, f)
    assert result["status"] == "FAIL"
    assert result["issues"]
    assert result["units"][1]["facts"][0]["evidence"][0]["start"] == f["inputs"]["document"].index("Ada places")


def test_disjoint_same_paragraph_contradiction_is_not_discarded():
    f = frozen()
    f["inputs"]["document"] = "# Episode 2\n\nThe phone stays on the table. It never leaves her hand."
    f["factUnits"] = fact_units(f["inputs"])
    data = contradiction(f)
    data["units"][1]["facts"][0]["evidence"] = [
        {"inputId": "document", "quote": "The phone stays on the table."},
        {"inputId": "document", "quote": "It never leaves her hand."}]
    assert validate_episode_facts(data, f)["status"] == "FAIL"
    data["units"][1]["facts"][0]["evidence"][1] = data["units"][1]["facts"][0]["evidence"][0]
    assert validate_episode_facts(data, f)["status"] == "UNAVAILABLE"


@pytest.mark.parametrize("bad", ["self_quote", "fabricated", "wrong_occurrence"])
def test_model_cannot_prove_a_claim_using_only_itself_or_fake_evidence(bad):
    f = frozen()
    data = contradiction(f)
    refs = data["units"][1]["facts"][0]["evidence"]
    if bad == "self_quote":
        refs.pop()
    elif bad == "fabricated":
        refs[1]["quote"] = "Ada is 38."
    else:
        refs[1]["occurrence"] = 2
    result = validate_episode_facts(data, f)
    assert result["status"] == "UNAVAILABLE"
    assert result["units"][1]["facts"][0]["status"] == "UNKNOWN"


def test_all_earlier_episodes_and_locked_facts_are_frozen_and_stale_reports_rejected(tmp_path, monkeypatch):
    from novelvideo.director import writing
    monkeypatch.setattr(writing, "resolve_director_model", lambda name: "test-model")
    store = DirectorStore(tmp_path)
    work = store.create_work(CreateWork(title="Synthetic", brief="A phone", preset=DirectorPreset(mode="original", episode_count=3, locked_facts="No new props")))
    for n in range(1, 4):
        with store._write() as db:
            db.execute("UPDATE works SET current_episode=? WHERE id=?", (n, work["id"]))
        store.put_document(work["id"], f"episode-{n:03d}", f"# Episode {n}\n\nAda holds the phone.", 0)
    compiled = compile_review(store, work["id"], 3)
    f = compiled["review_inputs"]
    assert {"episode-001", "episode-002", "document", "locked"}.issubset(f["inputs"])
    assert json.loads(compiled["prompt"])["outputSchema"]["required"][-1] == "episodeFacts"
    with store._write() as db:
        save_review(db, work["id"], str(uuid4()), {"reviewInputs": f}, json.dumps(response(f)), None)
    assert QualityService(store).report(work["id"], 3)["review"] is not None
    with store._write() as db:
        db.execute("UPDATE works SET current_episode=1 WHERE id=?", (work["id"],))
    store.put_document(work["id"], "episode-001", "The phone broke.", 1)
    assert QualityService(store).report(work["id"], 3)["review"] is None
    with store._connect() as db:
        assert review_inputs(store, db, work["id"], 3)["inputHash"] != f["inputHash"]
