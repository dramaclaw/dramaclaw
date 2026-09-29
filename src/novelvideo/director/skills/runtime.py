"""Only pinned, shipped method files can influence an approved model request.

The registry is host code, not an import permission system. A manifest cannot
add tools, import Python or point at a developer's home directory. The current
M11 adapter returns Markdown, not a claim that the full planning chain ran.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, model_validator

from ..documents import content_hash, object_hash
from ..schemas.common import ContractModel, Sha256
from ..schemas.execution import ExecutionFault
from ..schemas.quality import ModelReview
from ..schemas.outline_delivery import AdaptationOutlineDraft, DELIVERY_CONTRACT
from ..schemas.outline_source import (
    SOURCE_CONTRACT, AUDIT_CONTRACT, REVIEW_CONTRACT,
    SourceExtraction, SourceAudit, CandidateAudit, OutlinePipelineContext,
)
from ..schemas.outline_changes import PATCH_CONTRACT, OutlinePatchDraft, OutlinePatchContext
from ..schemas.planning import (
    DirectionMethodContext,
    PLANNING_OUTPUTS,
    PlanningMethodContext,
    OutlineMethodContext,
    CharacterMethodContext,
)

BUNDLE_ROOT = Path(__file__).parent / "builtin"
CONTRACT_OUTPUTS = {
    SOURCE_CONTRACT: ("M04", SourceExtraction),
    AUDIT_CONTRACT: ("M05", SourceAudit),
    DELIVERY_CONTRACT: ("M07", AdaptationOutlineDraft),
    REVIEW_CONTRACT: ("M12", CandidateAudit),
    PATCH_CONTRACT: ("M14", OutlinePatchDraft),
}


class MethodContext(ContractModel):
    schema_version: Literal[2]
    stage: Literal["M11", "M12"]
    mode: Literal["original", "adaptation"]
    episode_ordinal: int = Field(ge=1, le=100)
    total_episodes: int = Field(ge=1, le=100)
    ending_type: Literal["closed", "open", "reversal", "tragic"]
    parameters_hash: Sha256

    @model_validator(mode="after")
    def ordinal_within_delivery(self) -> MethodContext:
        if self.episode_ordinal > self.total_episodes:
            raise ValueError("METHOD_EPISODE_OUT_OF_RANGE")
        return self


class Reference(ContractModel):
    path: str
    source_id: Literal["user-short-drama"]
    original_path: str
    sha256: Sha256
    when: Literal[
        "always", "first_episode", "next_hook", "characters", "scenes", "props", "adaptation"
    ]


class Manifest(ContractModel):
    schema_version: Literal[2]
    key: str
    stage: Literal["M03", "M04", "M05", "M07", "M08", "M09", "M11", "M12", "M14"]
    version: Literal["2.1.0", "2.2.0", "2.3.0", "2.3.1", "2.3.2", "2.4.0", "2.4.1", "2.4.2", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4"]
    purpose: str
    applicable: list[Literal["original", "adaptation"]]
    excluded: list[Literal["omni", "directing"]]
    method: str
    input_schema: str
    output_schema: str
    template: str
    fixtures: str
    provenance: str
    required_references: list[Reference]
    rule_ids: list[str]
    allowed_tools: list[str]
    validators: list[str]
    cost_classes: list[str]
    checkpoint_kinds: list[str]
    max_schema_repair_attempts: Literal[0]
    max_automatic_revision_attempts: Literal[0]
    files: dict[str, Sha256]
    compatibility: str


MARKDOWN = TypeAdapter(Annotated[str, Field(min_length=1, max_length=1024 * 1024)])


def output_schema(stage: str, *, contract: str | None = None) -> dict:
    if contract is not None:
        expected, model = CONTRACT_OUTPUTS[contract]
        if expected != stage:
            raise ValueError("METHOD_CONTRACT_MISMATCH")
        return model.model_json_schema(by_alias=True)
    if stage in PLANNING_OUTPUTS:
        return PLANNING_OUTPUTS[stage].model_json_schema(by_alias=True)
    return (
        MARKDOWN.json_schema()
        if stage == "M11"
        else ModelReview.model_json_schema(by_alias=True)
    )


def validate_output(stage: str, value: object, *, contract: str | None = None) -> None:
    if contract is not None:
        expected, model = CONTRACT_OUTPUTS[contract]
        if expected != stage:
            raise ValueError("METHOD_CONTRACT_MISMATCH")
        model.from_wire(value)
    elif stage in PLANNING_OUTPUTS:
        PLANNING_OUTPUTS[stage].model_validate(value, strict=True)
    elif stage == "M11":
        if not MARKDOWN.validate_python(value, strict=True).strip():
            raise ValueError("EMPTY_METHOD_OUTPUT")
    elif stage == "M12":
        ModelReview.model_validate(value, strict=True)
    else:
        raise ValueError("UNREGISTERED_METHOD")


def _read(root: Path, relative: str) -> str:
    path = PurePosixPath(relative)
    if (
        not relative
        or "\\" in relative
        or path.is_absolute()
        or any(part in {".", ".."} for part in relative.split("/"))
        or ":" in relative
    ):
        raise ValueError("UNSAFE_METHOD_PATH")
    target = root
    if root.is_symlink():
        raise ValueError("METHOD_SYMLINK")
    for part in path.parts:
        target = target / part
        if target.is_symlink():
            raise ValueError("METHOD_SYMLINK")
    if not target.is_file() or target.stat().st_size > 1024 * 1024:
        raise ValueError("METHOD_FILE_INVALID")
    return target.read_text(encoding="utf-8")


def load_package(stage: str, *, contract: str | None = None) -> dict:
    from .pinned import PACKAGES, CONTRACT_PACKAGES

    try:
        if contract is not None and CONTRACT_OUTPUTS[contract][0] != stage:
            raise ValueError("METHOD_CONTRACT_MISMATCH")
        directory, manifest_hash = CONTRACT_PACKAGES[contract] if contract else PACKAGES[stage]
        root = BUNDLE_ROOT / directory
        raw = _read(root, "manifest.json")
        if content_hash(raw) != manifest_hash:
            raise ValueError("MANIFEST_HASH_MISMATCH")
        manifest = Manifest.model_validate_json(raw)
        validator = contract or (
            "planning." + stage
            if stage in PLANNING_OUTPUTS
            else "markdown.nonempty"
            if stage == "M11"
            else "review.six_checks"
        )
        if (
            manifest.stage != stage
            or manifest.allowed_tools
            or manifest.validators != [validator]
            or manifest.cost_classes != ["text.generate"]
        ):
            raise ValueError("METHOD_PERMISSION_MISMATCH")
        files = {path: _read(root, path) for path in manifest.files}
        if any(
            content_hash(files[path]) != digest
            for path, digest in manifest.files.items()
        ):
            raise ValueError("METHOD_CONTENT_MISMATCH")
        required = {
            manifest.method,
            manifest.input_schema,
            manifest.output_schema,
            manifest.template,
            manifest.fixtures,
            manifest.provenance,
            "LICENSE",
            *(ref.path for ref in manifest.required_references),
        }
        if not required.issubset(files):
            raise ValueError("METHOD_FILES_MISSING")
        # Schemas are pinned snapshots of host validators, not arbitrary schemas
        # that may fetch remote $refs or weaken permissions after import.
        context_type = (
            OutlinePatchContext if contract == PATCH_CONTRACT else OutlinePipelineContext
            if contract else DirectionMethodContext
            if stage == "M03"
            else OutlineMethodContext
            if stage == "M07"
            else CharacterMethodContext
            if stage == "M08"
            else PlanningMethodContext
            if stage in PLANNING_OUTPUTS
            else MethodContext
        )
        if json.loads(files[manifest.input_schema]) != context_type.model_json_schema(
            by_alias=True
        ):
            raise ValueError("METHOD_INPUT_SCHEMA_DRIFT")
        if json.loads(files[manifest.output_schema]) != output_schema(stage, contract=contract):
            raise ValueError("METHOD_OUTPUT_SCHEMA_DRIFT")
        for ref in manifest.required_references:
            if manifest.files[ref.path] != ref.sha256:
                raise ValueError("METHOD_REFERENCE_MISMATCH")
        provenance = json.loads(files[manifest.provenance])
        if (
            provenance["stage"] != stage
            or provenance["privateLibTVSourceObtained"] is not False
        ):
            raise ValueError("METHOD_PROVENANCE_INVALID")
        fixtures = json.loads(files[manifest.fixtures])
        if {item["valid"] for item in fixtures} != {True, False}:
            raise ValueError("METHOD_FIXTURES_INCOMPLETE")
        for fixture in fixtures:
            try:
                validate_output(stage, fixture["value"], contract=contract)
                valid = True
            except (ValueError, TypeError):
                valid = False
            if valid != fixture["valid"]:
                raise ValueError("METHOD_FIXTURE_FAILED")
        return {"manifest": manifest, "files": files, "hash": manifest_hash}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ExecutionFault("METHOD_PACKAGE_INVALID", status=503) from exc


def package_registry_hash() -> str:
    from .pinned import PACKAGES, CONTRACT_PACKAGES

    return object_hash({
        **{stage: load_package(stage)["hash"] for stage in PACKAGES},
        **{key: load_package(CONTRACT_OUTPUTS[key][0], contract=key)["hash"] for key in CONTRACT_PACKAGES},
    })


def compile_method(
    context: MethodContext | PlanningMethodContext | OutlinePipelineContext,
    *, contract: str | None = None,
) -> dict:
    package = load_package(context.stage, contract=contract)
    manifest, files = package["manifest"], package["files"]
    if context.mode not in manifest.applicable or context.mode in manifest.excluded:
        raise ExecutionFault("METHOD_NOT_APPLICABLE", status=422)
    selected, disabled = [], []
    for ref in manifest.required_references:
        enabled = (
            ref.when == "always"
            or ref.when == "adaptation" and context.mode == "adaptation"
            or ref.when in {"characters", "scenes", "props"}
            and context.stage == "M08"
            and getattr(context, "document_kind", "preparation")
            in {"preparation", ref.when}
            or ref.when == "first_episode"
            and context.episode_ordinal == 1
            or ref.when == "next_hook"
            and (
                context.episode_ordinal < context.total_episodes
                or context.ending_type == "open"
            )
        )
        receipt = {
            "path": ref.original_path,
            "sourceId": ref.source_id,
            "sha256": ref.sha256,
        }
        if enabled:
            selected.append({**receipt, "text": files[ref.path]})
        else:
            disabled.append({**receipt, "reason": ref.when + "_not_applicable"})
    binding = {
        "skillId": manifest.key,
        "stage": context.stage,
        "version": manifest.version,
        "revisionId": package["hash"],
        "methodHash": manifest.files[manifest.method],
        "templateHash": manifest.files[manifest.template],
        "inputSchemaHash": manifest.files[manifest.input_schema],
        "outputSchemaHash": manifest.files[manifest.output_schema],
        "contextHash": object_hash(context.model_dump(by_alias=True)),
        "selectedReferences": [
            {k: v for k, v in ref.items() if k != "text"} for ref in selected
        ],
        "disabledReferences": disabled,
        "origin": "host-adapted-short-drama-not-private-libtv",
        "compatibility": manifest.compatibility,
    }
    return {
        "binding": binding,
        "text": files[manifest.method]
        + "\n"
        + files[manifest.template]
        + "\n"
        + json.dumps(
            {
                "methodContext": context.model_dump(by_alias=True),
                "references": selected,
            },
            ensure_ascii=False,
        ),
    }
