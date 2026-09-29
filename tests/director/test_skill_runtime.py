"""Shipped craft references must reach the paid prompt, not just a provenance label."""

from __future__ import annotations

import json
import shutil

import pytest
from pydantic import ValidationError

from novelvideo.director.documents import content_hash, object_hash
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.models import GenerateDraft
from novelvideo.director.quality import compile_review
from novelvideo.director.schemas.execution import ExecutionCommand, ExecutionFault
from novelvideo.director.skills import pinned, runtime as methods
from novelvideo.director.writing import compile_generation
from tests.director.test_execution import command, grant, quote
from tests.director.test_execution import runtime as runtime


def context(**kwargs):
    return methods.MethodContext(
        **{
            "schema_version": 2,
            "stage": "M11",
            "mode": "original",
            "episode_ordinal": 1,
            "total_episodes": 1,
            "ending_type": "closed",
            "parameters_hash": "a" * 64,
            **kwargs,
        }
    )


@pytest.mark.parametrize("mode", ["original", "adaptation"])
def test_outline_source_grounding_is_loaded_only_for_adaptation(mode):
    from novelvideo.director.schemas.planning import OutlineMethodContext

    result = methods.compile_method(OutlineMethodContext(
        schema_version=2, stage="M07", mode=mode, episode_ordinal=1,
        total_episodes=1, ending_type="closed", parameters_hash="a" * 64,
    ))
    assert result["binding"]["version"] == "2.3.2"
    selected = result["binding"]["selectedReferences"]
    assert len(selected) == (4 if mode == "adaptation" else 3)
    assert ("Separate three kinds of evidence" in result["text"]) == (mode == "adaptation")
    assert "hook-01, setup-01, reversal-01" in result["text"]


def local_bundle(tmp_path, monkeypatch):
    destination = tmp_path / "builtin"
    shutil.copytree(methods.BUNDLE_ROOT, destination)
    monkeypatch.setattr(methods, "BUNDLE_ROOT", destination)
    return destination


def test_direction_package_preserves_craft_references_in_adaptation():
    from novelvideo.director.schemas.planning import DirectionMethodContext

    compiled = methods.compile_method(DirectionMethodContext(
        schema_version=2, stage="M03", mode="adaptation", episode_ordinal=1,
        total_episodes=1, ending_type="closed", parameters_hash="a" * 64,
    ))
    assert compiled["binding"]["version"] == "2.3.2"
    assert {ref["path"] for ref in compiled["binding"]["selectedReferences"]} == {
        "references/genre-guide.md", "references/opening-rules.md",
        "references/adaptation-core.md + references/event-coverage.md",
    }


def repin(monkeypatch, stage, manifest_path):
    """Simulate a reviewed package release; still cannot exceed host permissions."""
    monkeypatch.setitem(
        pinned.PACKAGES,
        stage,
        (
            pinned.PACKAGES[stage][0],
            content_hash(manifest_path.read_text()),
        ),
    )


def rewrite_json(path, mutate):
    data = json.loads(path.read_text())
    mutate(data)
    path.write_text(json.dumps(data, ensure_ascii=False) + "\n")


@pytest.mark.parametrize("stage", ["M11", "M12"])
def test_packages_have_verified_license_schemas_provenance_and_real_negative_cases(
    stage,
):
    package = methods.load_package(stage)
    manifest = package["manifest"]
    assert "Copyright (c) 2025 0xsline" in package["files"]["LICENSE"]
    assert not manifest.allowed_tools
    assert {
        case["valid"] for case in json.loads(package["files"][manifest.fixtures])
    } == {True, False}
    assert (
        json.loads(package["files"][manifest.provenance])["privateLibTVSourceObtained"]
        is False
    )
    assert manifest.compatibility
    for ref in manifest.required_references:
        assert content_hash(package["files"][ref.path]) == ref.sha256


@pytest.mark.parametrize(
    "ordinal,total,ending,opening,hook",
    [
        (1, 1, "closed", True, False),
        (1, 2, "closed", True, True),
        (2, 2, "closed", False, False),
        (2, 2, "open", False, True),
        (2, 2, "tragic", False, False),
    ],
)
def test_actual_reference_text_is_conditionally_selected(
    ordinal, total, ending, opening, hook
):
    value = methods.compile_method(
        context(episode_ordinal=ordinal, total_episodes=total, ending_type=ending)
    )
    selected = {r["path"] for r in value["binding"]["selectedReferences"]}
    assert ("references/opening-rules.md" in selected) == opening
    assert ("references/hook-design.md" in selected) == hook
    assert "references/episode-writing.md" in selected
    assert "对白盲测" in value["text"]
    assert "Closed final episodes" in value["text"]
    assert len(selected) + len(value["binding"]["disabledReferences"]) == 6


@pytest.mark.parametrize(
    "payload",
    [
        {"episode_ordinal": 2},
        {"total_episodes": "1"},
        {"episode_ordinal": True},
        {"stage": "M01"},
        {"mode": "omni"},
        {"approved": True},
    ],
)
def test_context_cannot_expand_scope_or_coerce(payload):
    with pytest.raises(ValidationError):
        context(**payload)


@pytest.mark.parametrize(
    "target",
    [
        "method.md",
        "templates/request.md",
        "schemas/input.json",
        "schemas/output.json",
        "references/episode-writing.md",
        "fixtures/contracts.json",
        "provenance.json",
        "LICENSE",
        "manifest.json",
    ],
)
def test_tampering_any_packaged_file_fails_before_model(tmp_path, monkeypatch, target):
    root = local_bundle(tmp_path, monkeypatch)
    file = root / "episode-writing" / target
    file.write_text(file.read_text() + "\nnot approved\n")
    with pytest.raises(ExecutionFault, match="METHOD_PACKAGE_INVALID"):
        methods.compile_method(context())


@pytest.mark.parametrize(
    "path",
    [
        "../outside",
        "/tmp/outside",
        "C:\\outside",
        "./method.md",
        "references/../method.md",
    ],
)
def test_reviewed_manifest_still_cannot_escape_root(tmp_path, monkeypatch, path):
    root = local_bundle(tmp_path, monkeypatch)
    manifest = root / "episode-writing/manifest.json"
    rewrite_json(manifest, lambda m: m["files"].update({path: "a" * 64}))
    repin(monkeypatch, "M11", manifest)
    with pytest.raises(ExecutionFault, match="METHOD_PACKAGE_INVALID"):
        methods.load_package("M11")


def test_symlink_cannot_stand_in_for_reference(tmp_path, monkeypatch):
    root = local_bundle(tmp_path, monkeypatch)
    target = root / "episode-review/references/episode-writing.md"
    outside = tmp_path / "outside.md"
    target.rename(outside)
    target.symlink_to(outside)
    with pytest.raises(ExecutionFault, match="METHOD_PACKAGE_INVALID"):
        methods.load_package("M12")


@pytest.mark.parametrize(
    "field,value",
    [
        ("allowedTools", ["shell.execute"]),
        ("validators", ["python.eval"]),
        ("maxAutomaticRevisionAttempts", 999),
        ("costClasses", ["video.generate"]),
    ],
)
def test_manifest_release_cannot_grant_itself_tools_or_extra_paid_attempts(
    tmp_path, monkeypatch, field, value
):
    root = local_bundle(tmp_path, monkeypatch)
    manifest = root / "episode-writing/manifest.json"
    rewrite_json(manifest, lambda m: m.update({field: value}))
    repin(monkeypatch, "M11", manifest)
    with pytest.raises(ExecutionFault, match="METHOD_PACKAGE_INVALID"):
        methods.load_package("M11")


def test_remote_schema_ref_rejected_even_with_updated_hashes(tmp_path, monkeypatch):
    root = local_bundle(tmp_path, monkeypatch)
    schema = root / "episode-review/schemas/output.json"
    schema.write_text(json.dumps({"$ref": "https://invalid.example/schema"}))
    manifest = root / "episode-review/manifest.json"
    rewrite_json(
        manifest,
        lambda m: m["files"].update(
            {"schemas/output.json": content_hash(schema.read_text())}
        ),
    )
    repin(monkeypatch, "M12", manifest)
    with pytest.raises(ExecutionFault, match="METHOD_PACKAGE_INVALID"):
        methods.load_package("M12")


def test_m11_real_compiler_contains_method_and_receipt_with_untrusted_source_separate(
    runtime,
):
    store, work, *_ = runtime
    compiled = compile_generation(
        store,
        work["id"],
        GenerateDraft(
            kind="episode",
            episode_ordinal=1,
            expected_version=0,
            instruction="Keep duration 30 seconds.",
        ),
    )
    binding = compiled["context_manifest"]["methodBinding"]
    package = methods.load_package("M11")
    assert (
        binding["revisionId"]
        == package["hash"]
        == compiled["parameters"]["skill_revision"]
    )
    assert "HOST_VERIFIED_METHOD_JSON" in compiled["prompt"]
    assert "对白盲测" in compiled["prompt"]
    assert content_hash(compiled["prompt"]) == compiled["input_sha256"]
    assert compiled["context_manifest"]["tokenEstimate"] == len(
        compiled["prompt"].encode()
    )
    assert (
        object_hash(compiled["context_manifest"])
        == compiled["parameters"]["context_manifest_hash"]
    )


def test_m12_real_compiler_includes_method_without_writer_permission(runtime):
    store, work, *_ = runtime
    store.put_document(work["id"], "episode-001", "# Scene 1\nAda opens a box.", 0)
    compiled = compile_review(store, work["id"], 1)
    prompt = json.loads(compiled["prompt"])
    assert prompt["hostVerifiedMethod"]["binding"]["stage"] == "M12"
    assert "对白盲测" in prompt["hostVerifiedMethod"]["text"]
    assert "Never rewrite" in prompt["hostVerifiedMethod"]["text"]
    allowed_ids = prompt["outputSchema"]["$defs"]["ReviewEvidence"]["properties"][
        "inputId"
    ]["enum"]
    assert allowed_ids == list(prompt["frozenInputs"]["inputs"])
    assert "document" in allowed_ids and "inputs.document" not in allowed_ids
    assert (
        object_hash(prompt["outputSchema"])
        == compiled["parameters"]["response_schema_hash"]
    )
    assert (
        compiled["parameters"]["skill_revision"] == methods.load_package("M12")["hash"]
    )
    assert not store.list_changes(work["id"])


async def test_package_corruption_after_approval_prevents_send_and_releases_reservation(
    runtime, tmp_path, monkeypatch
):
    _, work, _, repo, _ = runtime
    _, operation = grant(runtime)
    root = local_bundle(tmp_path, monkeypatch)
    (root / "episode-writing/method.md").write_text("broken")
    calls = []

    async def model(*args):
        calls.append(args)
        return "must not run"

    result = await dispatch_writing(repo, work["id"], operation["id"], model)
    assert not calls
    assert result["errorCode"] == "INPUT_CHANGED_BEFORE_SEND"
    assert result["cost"]["actualMinor"] == 0


def test_new_reviewed_release_invalidates_unconsumed_quote(
    runtime, tmp_path, monkeypatch
):
    _, work, _, repo, service = runtime
    _, quoted = quote(runtime)
    approve = command(
        work,
        {
            "type": "approval.grant",
            "quoteId": quoted["quoteId"],
            "requestHash": quoted["requestHash"],
            "unknownCostConsent": True,
        },
    )
    root = local_bundle(tmp_path, monkeypatch)
    manifest = root / "episode-writing/manifest.json"
    rewrite_json(manifest, lambda m: m.update({"purpose": "Reviewed wording release"}))
    repin(monkeypatch, "M11", manifest)
    with pytest.raises(ExecutionFault, match="CAPABILITY_CHANGED"):
        service.execute("writer", approve)
    assert not repo.list_operations(work["id"])


async def test_paid_episode_snapshot_and_retained_output_bind_the_exact_package(
    runtime,
):
    store, work, _, repo, service = runtime
    request = command(
        work, {"type": "cost.quote", "kind": "outline", "maxOutputTokens": 1024}
    )
    wire = request.model_dump(by_alias=True)
    wire["expected"]["documentVersions"] = {"episode-001": 0}
    wire["payload"].update(kind="episode", episodeOrdinal=1)
    quoted = service.execute("writer", ExecutionCommand.from_wire(wire))["result"]
    grant_wire = command(
        work,
        {
            "type": "approval.grant",
            "quoteId": quoted["quoteId"],
            "requestHash": quoted["requestHash"],
            "unknownCostConsent": True,
        },
    ).model_dump(by_alias=True)
    grant_wire["expected"]["documentVersions"] = {"episode-001": 0}
    operation = service.execute("writer", ExecutionCommand.from_wire(grant_wire))[
        "result"
    ]
    calls = []

    async def model(prompt, name, limit):
        calls.append((prompt, name, limit))
        assert "episode-writing" in prompt and "对白盲测" in prompt
        return "# Scene 1\nAda opens the box with the red key."

    result = await dispatch_writing(repo, work["id"], operation["id"], model)
    assert result["status"] == "succeeded" and len(calls) == 1
    assert store.get_document(work["id"], "episode-001")["version"] == 0
    with store._connect() as db:
        snapshot = repo.snapshot(db, operation["id"])
    assert (
        snapshot["contextManifest"]["methodBinding"]["revisionId"]
        == quoted["parameters"]["skill_revision"]
    )
