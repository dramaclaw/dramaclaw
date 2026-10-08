"""UI-disabled old cards cannot substitute for a server-side version guard.

The result is a proposed transition, not a committed approval. The repository
must apply its revision and persist the receipt in the same CAS transaction.
"""

from __future__ import annotations

from typing import Literal

from .schemas.common import ContractModel, DirectorContractError
from .schemas.foundation import QuestionCheckpoint, QuestionDecision


class QuestionTransition(ContractModel):
    checkpoint_id: str
    expected_revision: int
    new_revision: int
    status: Literal["answered", "skipped"]
    next_action: Literal["resume_checkpoint", "WAIT_INPUT"]
    resume_token: str


def decide_question(
    checkpoint: QuestionCheckpoint, decision: QuestionDecision
) -> QuestionTransition:
    if (
        checkpoint.id != decision.checkpoint_id
        or checkpoint.revision != decision.expected_revision
        or checkpoint.question_version != decision.question_version
        or checkpoint.tool_call_id != decision.tool_call_id
        or checkpoint.status != "open"
    ):
        raise DirectorContractError("STALE_CHECKPOINT", affected_ids=[checkpoint.id])
    if decision.decision == "answer":
        questions = {question.id: question for question in checkpoint.questions}
        answers = {answer.question_id: answer for answer in decision.answers}
        if set(answers) - set(questions):
            raise DirectorContractError(
                "UNKNOWN_QUESTION", affected_ids=sorted(set(answers) - set(questions))
            )
        for question in questions.values():
            answer = answers.get(question.id)
            if answer is None:
                if question.required:
                    raise DirectorContractError(
                        "REQUIRED_ANSWER_MISSING", affected_ids=[question.id]
                    )
                continue
            if set(answer.option_ids) - set(question.option_ids):
                raise DirectorContractError(
                    "UNKNOWN_OPTION", affected_ids=[question.id]
                )
            if question.kind == "text":
                if answer.option_ids:
                    raise DirectorContractError(
                        "ANSWER_TYPE_MISMATCH", affected_ids=[question.id]
                    )
                present = bool(answer.free_text.strip())
            else:
                if question.kind == "single" and len(answer.option_ids) > 1:
                    raise DirectorContractError(
                        "SINGLE_CHOICE_REQUIRED", affected_ids=[question.id]
                    )
                # Free text is a legitimate alternative, including in choice cards.
                present = bool(answer.option_ids or answer.free_text.strip())
            if question.required and not present:
                raise DirectorContractError(
                    "REQUIRED_ANSWER_MISSING", affected_ids=[question.id]
                )
    return QuestionTransition(
        checkpoint_id=checkpoint.id,
        expected_revision=checkpoint.revision,
        new_revision=checkpoint.revision + 1,
        status="skipped" if decision.decision == "skip" else "answered",
        next_action="WAIT_INPUT"
        if decision.decision == "skip"
        else "resume_checkpoint",
        resume_token=checkpoint.resume_token,
    )
