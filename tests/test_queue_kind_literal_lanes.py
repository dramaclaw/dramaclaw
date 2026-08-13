"""Every ``queue_kind`` literal in the tree must name a lane that exists.

TCP-P55: ``verification/routes.py`` asked for a lane called ``"sketch"``, which
``QUEUE_KINDS`` has never contained. While ``normalize_queue_kind`` silently
fell back to ``default`` that was invisible; once D1 made it throw
(``task_backend/queues.py:19-20``) the endpoint became a live 500 on the
integration line. The whole suite stayed green because
``tests/test_sketch_edit_execute_celery.py`` mocks the task backend away, so
the delivery path is never walked.

Two tests, two jobs: the first walks the real delivery path for that one
endpoint; the second is the ratchet that stops any lane typo from being
written again.
"""

from __future__ import annotations

import ast
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.ports import registry as ports_registry
from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.local.tasks import InlineTaskBackend, InMemoryCancellationStore
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
from novelvideo.task_backend.envelope import SignedTaskEnvelope
from novelvideo.task_backend.queues import QUEUE_KINDS

SIGNING_KEY = b"d" * 32
NOW = datetime(2026, 8, 14, 4, 5, 7, tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# the live failure: real delivery path, no task-backend mock
# --------------------------------------------------------------------------


def _admission(*, user_id: str, root_task_id: str) -> AdmissionContext:
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(kind="local", id=user_id),
        credential=CredentialReference("local", "local-newapi", 1),
        admission_id="admission-1",
        root_task_id=root_task_id,
        admitted_at="2026-08-14T04:05:00Z",
        authz_version=1,
    )


class _Producer:
    """Real signing, stub authz — the shape of tests/ports/test_tasks.py:43-67."""

    async def sign_top_level(self, **kwargs):
        admission = _admission(
            user_id=kwargs["user_id"], root_task_id=kwargs["root_task_id"]
        )
        return SignedTaskEnvelope.sign(
            admission=admission,
            envelope_id="envelope-1",
            task_type=kwargs["task_type"],
            project_id=kwargs["project_id"],
            payload=kwargs["payload"],
            issued_at="2026-08-14T04:05:06Z",
            expires_at="2026-08-15T04:05:06Z",
            signing_key_id="test-v1",
            signing_key=SIGNING_KEY,
        )


class _Authz:
    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        return _admission(user_id=user_id, root_task_id=root_task_id)


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_sketch_edit",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="alice",
        requester_user_id="usr_1",
        requester_username="alice",
        requester_principals=(("user", "usr_1"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def _write_valid_labels(project_dir: Path, episode_num: int = 1) -> None:
    """Same fixture data as tests/test_sketch_edit_execute_celery.py:9-32."""
    reports_dir = project_dir / "verify_reports" / f"ep{episode_num:03d}"
    reports_dir.mkdir(parents=True)
    row = {
        "project_dir": str(project_dir),
        "episode_num": episode_num,
        "beat_number": 1,
        "execution_mode": "polish",
        "sketch_path": str(project_dir / "sketches" / "ep001" / "beat_01.png"),
        "beat": {"beat_number": 1},
        "sketch_colors": [],
        "result": {
            "decision": "revise",
            "main_problem": "composition_weak",
            "reasoning": "构图需要更清楚。",
            "edit_instruction": "调整构图，让主体动作更清楚。",
            "confidence": 0.9,
        },
        "raw_text": "",
    }
    (reports_dir / "labels.jsonl").write_text(
        json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8"
    )


@pytest.mark.asyncio
async def test_start_sketch_edit_execute_reaches_a_real_lane(tmp_path, monkeypatch):
    """The endpoint's own ``queue_kind`` literal, walked on the real backend.

    Only project resolution is stubbed (it needs a user store); the task
    backend is a real ``InlineTaskBackend`` with real envelope signing, so
    ``normalize_queue_kind`` at ports/local/tasks.py:95 is genuinely executed.
    """
    from novelvideo.verification import routes
    from novelvideo.verification.schemas import SketchEditExecuteRequest

    _write_valid_labels(tmp_path)
    ctx = _ctx(tmp_path)

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return SimpleNamespace(
            ctx=ctx,
            username="alice",
            project_name="demo",
            project_dir=tmp_path,
            output_dir=str(tmp_path),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(
        routes, "resolve_project_scope", fake_resolve_project_scope, raising=False
    )

    backend = InlineTaskBackend(
        producer=_Producer(),
        consumer=TaskEnvelopeConsumer(
            keyring={"test-v1": SIGNING_KEY}, authz=_Authz(), clock=lambda: NOW
        ),
    )
    submitted: list[object] = []
    monkeypatch.setattr(backend, "_submit_lane_job", submitted.append)
    ports_registry.register_port("task_backend", backend)
    ports_registry.register_port("cancellation_store", InMemoryCancellationStore())

    result = await routes.start_sketch_edit_execute(
        "proj_sketch_edit",
        1,
        SketchEditExecuteRequest(),
        {"username": "alice"},
    )

    assert result["ok"] is True
    assert result["task_type"] == "sketch_edit_execute"
    assert len(submitted) == 1


# --------------------------------------------------------------------------
# the ratchet
# --------------------------------------------------------------------------


def _value_literals(node: ast.AST) -> list[ast.Constant]:
    """String constants that can actually *become* the value of ``node``.

    Deliberately not ``ast.walk``: in
    ``queue_kind="ffmpeg" if task_type != "freezone_analyze" else "default"``
    (freezone.py:2446) the comparison operand is not a lane and walking the
    whole subtree would report it as one. Only the branches of a conditional
    and the arms of an ``or`` can end up in the argument, so only those are
    followed; anything else (a name, a call) carries no literal to check.
    """
    if isinstance(node, ast.Constant):
        return [node] if isinstance(node.value, str) else []
    if isinstance(node, ast.IfExp):
        return _value_literals(node.body) + _value_literals(node.orelse)
    if isinstance(node, ast.BoolOp):
        return [lit for value in node.values for lit in _value_literals(value)]
    return []


def _queue_kind_literals(tree: ast.AST) -> list[tuple[str, int]]:
    """Collect ``queue_kind=<str literal>`` call keywords and parameter defaults."""
    found: list[tuple[str, int]] = []

    def collect(node: ast.AST) -> None:
        found.extend((lit.value, lit.lineno) for lit in _value_literals(node))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for keyword in node.keywords:
                if keyword.arg == "queue_kind":
                    collect(keyword.value)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            positional = args.posonlyargs + args.args
            defaulted = positional[len(positional) - len(args.defaults) :]
            for arg, default in zip(defaulted, args.defaults):
                if arg.arg == "queue_kind":
                    collect(default)
            for arg, default in zip(args.kwonlyargs, args.kw_defaults):
                if default is not None and arg.arg == "queue_kind":
                    collect(default)

    return found


def test_every_queue_kind_literal_in_src_names_a_known_lane():
    """Ratchet against TCP-P55 coming back.

    Shape reused from tests/test_task_backend_registry.py:37-70
    (``test_every_literal_enqueued_project_task_has_registered_runner``),
    widened from ``api/routes`` to the whole package — the offender lived in
    ``verification/routes.py``, outside that directory.
    """
    src_root = Path("src/novelvideo")
    assert src_root.is_dir()

    offenders: list[str] = []
    scanned = 0
    for path in sorted(src_root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for value, lineno in _queue_kind_literals(tree):
            scanned += 1
            if value not in QUEUE_KINDS:
                offenders.append(f"{path}:{lineno} queue_kind={value!r}")

    assert scanned > 40, "scanner stopped seeing call sites — it has gone blind"
    assert offenders == []
