# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Record workflow draft delivery from server execution or browser receipts."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def workflow_draft_identity(commands: object) -> dict[str, Any] | None:
    """Extract a single draft, revision, and task binding from create commands."""
    if not isinstance(commands, list):
        return None
    identities = set()
    for command in commands:
        if not isinstance(command, dict) or command.get("type") != "create_node":
            continue
        data = command.get("data")
        if not isinstance(data, dict):
            return None
        draft_id = data.get("workflowInstanceId")
        revision = data.get("workflowDraftRevision")
        task_id = data.get("workflowConfirmationTaskId")
        if (
            not isinstance(draft_id, str)
            or not draft_id.startswith("workflow_draft_")
            or isinstance(revision, bool)
            or not isinstance(revision, int)
            or revision <= 0
            or not isinstance(task_id, str)
            or not task_id.strip()
        ):
            return None
        identities.add((draft_id, revision, task_id))
    if len(identities) != 1:
        return None
    draft_id, revision, task_id = identities.pop()
    return {"draft_id": draft_id, "revision": revision, "task_id": task_id}


def canvas_receipt_delivered(receipt: object) -> bool:
    """Return whether a receipt reports complete, successful canvas delivery."""
    return (
        isinstance(receipt, dict)
        and receipt.get("tool_call_status") == "completed"
        and receipt.get("canvas_apply_status") == "applied"
        and bool(receipt.get("applied"))
        and not receipt.get("cancelled")
        and not receipt.get("errors")
    )


async def release_unapplied_workflow_draft(
    *, project_dir, canvas_id: str, identity: dict[str, Any] | None,
) -> None:
    """Release a matching draft when its paid confirmation applied nothing."""
    if identity is None:
        return
    # The draft stayed submitted while paid confirmation was pending. Nothing
    # was applied, so no receipt will settle it.
    try:
        from novelvideo.freezone.workflow_drafts import release_workflow_draft_confirmation

        await asyncio.to_thread(
            release_workflow_draft_confirmation,
            project_dir=Path(project_dir),
            canvas_id=canvas_id,
            draft_id=identity["draft_id"],
            expected_task_id=identity["task_id"],
            expected_revision=identity["revision"],
        )
    except Exception:
        logger.exception(
            "failed to release workflow draft after unapplied confirmation draft_id=%s",
            identity.get("draft_id"),
        )


async def record_workflow_draft_delivery(
    *, project_ctx, canvas_id: str, identity: dict[str, Any], delivered: bool,
) -> None:
    """Settle delivery only for the matching active confirmation attempt."""
    draft_id = identity["draft_id"]
    try:
        from novelvideo.freezone.workflow_drafts import (
            finish_workflow_draft_confirmation,
            read_workflow_draft,
        )
        from novelvideo.task_state import ACTIVE_PROJECT_TASK_STATUSES, get_task_manager

        draft, _error = await asyncio.to_thread(
            read_workflow_draft,
            project_dir=project_ctx.state_dir,
            canvas_id=canvas_id,
            draft_id=draft_id,
        )
        if draft is None:
            return
        task_id = str(draft.get("task_id") or "")
        revision = int(draft.get("revision") or 0)
        attempt_started_at = draft.get("confirmation_started_at")
        if task_id != identity["task_id"] or revision != identity["revision"]:
            return
        if attempt_started_at is None:
            return
        task_manager = get_task_manager()
        task_state = None
        for task_scope in (
            f"{canvas_id}:{draft_id}:{revision}:{attempt_started_at}",
            f"{canvas_id}:{draft_id}:{revision}",
        ):
            task_state = await asyncio.to_thread(
                task_manager.get_task_for_project,
                project_ctx,
                "freezone_workflow_confirm",
                0,
                beat_num=None,
                scope=task_scope,
            )
            if task_state is not None:
                break
        if (
            task_state is None
            or str(task_state.task_id) != task_id
            or task_state.status not in ACTIVE_PROJECT_TASK_STATUSES
        ):
            logger.info(
                "ignored late workflow canvas result without active task draft_id=%s",
                draft_id,
            )
            return
        await asyncio.to_thread(
            finish_workflow_draft_confirmation,
            project_dir=project_ctx.state_dir,
            canvas_id=canvas_id,
            draft_id=draft_id,
            outcome="confirmed" if delivered else "ready",
            expected_task_id=task_id,
            expected_revision=revision,
            expected_confirmation_started_at=attempt_started_at,
        )
    except Exception:
        logger.exception(
            "failed to record durable workflow canvas outcome draft_id=%s",
            draft_id,
        )
