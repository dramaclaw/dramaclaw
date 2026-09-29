"""Evidence and dependency gates are code, not additional promises in a prompt.

These functions validate supplied evidence. They do not extract events, infer
truth, persist a ChangeSet or replace the transaction-time CAS check.
"""

from __future__ import annotations

from hashlib import sha256

from .schemas.common import ContractModel, DirectorContractError
from .schemas.foundation import (
    ChangeSelection,
    EpisodeIdentity,
    SkillInvocation,
    SkillRunReceipt,
    SourceAuditInput,
)


class SourceGateResult(ContractModel):
    read_coverage: float
    audit_complete: bool
    missing_critical_ids: list[str]
    unresolved_critical_ids: list[str]
    ready_for_planning: bool


def validate_source_audit(evidence: SourceAuditInput) -> SourceGateResult:
    text = evidence.normalized_text
    chunks = sorted(evidence.chunks, key=lambda chunk: chunk.start)
    cursor = 0
    read_chars = 0
    for chunk in chunks:
        if chunk.start != cursor or chunk.end > len(text):
            raise DirectorContractError(
                "SOURCE_OWNERSHIP_GAP_OR_OVERLAP", affected_ids=[chunk.id]
            )
        expected = sha256(text[chunk.start : chunk.end].encode("utf-8")).hexdigest()
        if expected != chunk.text_hash:
            raise DirectorContractError(
                "SOURCE_SPAN_HASH_MISMATCH", affected_ids=[chunk.id]
            )
        if chunk.status == "succeeded":
            read_chars += chunk.end - chunk.start
        cursor = chunk.end
    if cursor != len(text):
        raise DirectorContractError("SOURCE_TAIL_MISSING")
    if evidence.audit_run_id == evidence.extraction_run_id:
        raise DirectorContractError("AUDIT_MUST_BE_INDEPENDENT")
    audit_complete = evidence.audit_completed and evidence.audit_run_id is not None
    missing = sorted(
        set(evidence.audited_critical_ids) - set(evidence.extracted_event_ids)
    )
    return SourceGateResult(
        read_coverage=read_chars / len(text),
        audit_complete=audit_complete,
        missing_critical_ids=missing,
        unresolved_critical_ids=list(evidence.unresolved_critical_ids),
        ready_for_planning=(
            read_chars == len(text)
            and audit_complete
            and not missing
            and not evidence.unresolved_critical_ids
        ),
    )


def validate_episode_binding(
    original: EpisodeIdentity, candidate: EpisodeIdentity
) -> None:
    # Display ordinal can change. Source/work/document identities cannot silently do so.
    for field in ("id", "work_id", "document_id", "source_episode_label"):
        if getattr(original, field) != getattr(candidate, field):
            raise DirectorContractError(
                "EPISODE_IDENTITY_MISMATCH", affected_ids=[original.id]
            )


def topological_order(dependencies: dict[str, list[str]]) -> tuple[str, ...]:
    remaining = {key: set(values) for key, values in dependencies.items()}
    unknown = set().union(*remaining.values()) - set(remaining) if remaining else set()
    if unknown:
        raise DirectorContractError("DANGLING_DEPENDENCY", affected_ids=sorted(unknown))
    result: list[str] = []
    while remaining:
        ready = [key for key, needs in remaining.items() if not needs]
        if not ready:
            raise DirectorContractError(
                "DEPENDENCY_CYCLE", affected_ids=list(remaining)
            )
        result.extend(ready)
        for key in ready:
            del remaining[key]
        for needs in remaining.values():
            needs.difference_update(ready)
    return tuple(result)


def prepare_change_selection(change: ChangeSelection) -> tuple[str, ...]:
    targets = {doc for group in change.groups for doc in group.target_document_ids}
    if targets != set(change.base_versions):
        raise DirectorContractError(
            "INCOMPLETE_BASE_VERSIONS", affected_ids=sorted(targets)
        )
    stale = [
        doc
        for doc, version in change.base_versions.items()
        if change.latest_versions.get(doc) != version
    ]
    if stale:
        raise DirectorContractError("VERSION_CONFLICT", affected_ids=stale)
    topological_order({group.id: group.requires_group_ids for group in change.groups})
    known_hunks = {hunk for group in change.groups for hunk in group.hunk_ids}
    selected = set(change.accepted_hunk_ids)
    if selected - known_hunks:
        raise DirectorContractError(
            "UNKNOWN_HUNK", affected_ids=sorted(selected - known_hunks)
        )
    accepted_groups: set[str] = set()
    for group in change.groups:
        members = set(group.hunk_ids)
        if selected & members:
            if not members <= selected:
                raise DirectorContractError(
                    "PARTIAL_ATOMIC_GROUP", affected_ids=[group.id]
                )
            accepted_groups.add(group.id)
    for group in change.groups:
        if (
            group.id in accepted_groups
            and not set(group.requires_group_ids) <= accepted_groups
        ):
            raise DirectorContractError(
                "DEPENDENCY_GROUP_INCOMPLETE", affected_ids=[group.id]
            )
    # Preserve visible hunk order, never the order of model responses or click timing.
    return tuple(
        hunk for group in change.groups for hunk in group.hunk_ids if hunk in selected
    )


def verify_skill_receipt(invocation: SkillInvocation, receipt: SkillRunReceipt) -> None:
    if (
        invocation.run_id != receipt.run_id
        or invocation.input_snapshot_hash != receipt.input_snapshot_hash
        or invocation.binding != receipt.binding
    ):
        raise DirectorContractError(
            "SKILL_RECEIPT_MISMATCH", affected_ids=[invocation.run_id]
        )
    if receipt.status != "succeeded":
        raise DirectorContractError(
            "SKILL_RUN_NOT_SUCCEEDED", affected_ids=[invocation.run_id]
        )
