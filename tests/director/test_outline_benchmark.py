"""The paid benchmark must fail safely before spending on bad setup or retries."""

import copy
import json

import pytest

from novelvideo.director import dispatch, writing
from novelvideo.director.models import CreateWork
from tests.director.live_outline import validate
from tests.director.outline_benchmark import CASES, DIMENSIONS, grounded_review
from tests.director.test_execution import runtime as runtime


@pytest.mark.parametrize("name", list(CASES))
def test_distinct_benchmark_specs_are_valid_and_not_thirty_second_defaults(name):
    sample = CASES[name]
    work = CreateWork.model_validate(sample["work"])
    assert work.preset.duration_seconds > 30
    assert sample["review_checks"]
    assert "review_checks" not in sample["work"]


def review_fixture():
    evidence = [{"inputId": "candidate", "quote": "She gave up the bonus."}]
    return {
        "dimensions": [
            {
                "id": k,
                "score": 4,
                "reason": "A costly choice.",
                "evidence": copy.deepcopy(evidence),
            }
            for k in DIMENSIONS
        ],
        "issues": [],
        "hardConstraints": "pass",
        "rewrite": "local",
        "verdict": "pass",
    }, {"candidate": "She gave up the bonus.", "brief": "Fair credit.", "source": ""}


def test_evidence_must_be_real_and_bound_to_the_right_input():
    report, inputs = review_fixture()
    assert grounded_review(json.dumps(report), inputs)["effectiveVerdict"] == "pass"
    report["dimensions"][0]["evidence"][0]["quote"] = "She stole the money."
    with pytest.raises(ValueError, match="ungrounded"):
        grounded_review(json.dumps(report), inputs)


def test_high_average_cannot_hide_major_issue_or_hard_failure():
    for patch in [{"hardConstraints": "fail"}, {"rewrite": "structural"}]:
        report, inputs = review_fixture()
        report.update(patch)
        assert (
            grounded_review(json.dumps(report), inputs)["effectiveVerdict"] == "revise"
        )
    report, inputs = review_fixture()
    report["dimensions"][0]["score"] = 3
    assert grounded_review(json.dumps(report), inputs)["effectiveVerdict"] == "revise"


def test_duplicate_keys_and_incomplete_dimensions_are_not_accepted():
    report, inputs = review_fixture()
    raw = json.dumps(report)
    with pytest.raises(ValueError, match="duplicate"):
        grounded_review(raw[:-1] + ',"verdict":"pass"}', inputs)
    report["dimensions"].pop()
    with pytest.raises(ValueError, match="incomplete"):
        grounded_review(json.dumps(report), inputs)


async def test_single_paid_intent_preserves_bad_output_and_cannot_reuse_directory(
    runtime, tmp_path, monkeypatch
):
    calls = []

    async def model(*args, response_format=None):
        assert response_format == {"type": "json_object"}
        calls.append(args)
        return writing.WritingResult(
            '{"bad":"incomplete"}', 10, 5, 1, "stop", "test-model"
        )

    monkeypatch.setattr(dispatch, "run_bounded_outline_model", model)
    root = tmp_path / "experiment"
    result = await validate(root, case=CASES["workplace"], max_output_tokens=12288)
    assert result["status"] == "failed" and len(calls) == 1
    saved = json.loads((root / "request.json").read_text())
    assert saved["snapshot"]["parameters"]["duration_seconds"] == 180
    assert saved["maxOutputTokens"] == 12288
    for oracle in CASES["workplace"]["review_checks"]:
        assert oracle not in saved["snapshot"]["prompt"]
    response = (root / "response.json").read_text()
    assert "incomplete" in response
    with pytest.raises(FileExistsError):
        await validate(root, case=CASES["workplace"])
    assert len(calls) == 1


def test_spine_probe_retains_craft_but_withholds_schema_and_review_oracles():
    from tests.director.outline_benchmark import probe_request

    root = {"preset": CASES["workplace"]["work"]["preset"], "episodes": []}
    request = probe_request("spine", "workplace", root)
    data = json.loads(request["prompt"])
    assert data["brief"] == CASES["workplace"]["work"]["brief"]
    assert len(data["references"]) == 3
    assert "responseSchema" not in data and "spine" not in data
    assert request["response_format"] is None and request["maxCalls"] == 1
    for oracle in CASES["workplace"]["review_checks"]:
        assert oracle not in request["prompt"]
    projection = probe_request("project", "workplace", root, "Frozen story.")
    assert json.loads(projection["prompt"])["spine"] == "Frozen story."
    assert projection["response_format"] == {"type": "json_object"}
    with pytest.raises(ValueError, match="retained spine"):
        probe_request("project", "workplace", root)


async def test_probe_is_one_call_keeps_invalid_projection_and_refuses_overwrite(
    tmp_path, monkeypatch
):
    from tests.director import outline_benchmark as bench

    source = tmp_path / "spine"
    source.mkdir()
    (source / "request.json").write_text(
        json.dumps(
            {"action": "spine", "case": "workplace", "outlineRoot": {"episodes": []}}
        )
    )
    (source / "spine.md").write_text("Synthetic story.")
    calls = []

    async def model(*args, **kwargs):
        calls.append((args, kwargs))
        return writing.WritingResult('{"incomplete":true}', 10, 5, 1, "stop", "test")

    monkeypatch.setattr(bench, "run_bounded_writing_model", model)
    target = tmp_path / "project"
    result = await bench.probe("project", "workplace", source, target)
    assert result["status"] == "failed" and len(calls) == 1
    assert "incomplete" in (target / "response.json").read_text()
    assert not (target / "outline.md").exists()
    with pytest.raises(FileExistsError):
        await bench.probe("project", "workplace", source, target)
    assert len(calls) == 1
