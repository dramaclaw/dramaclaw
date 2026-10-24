"""Recover reference production from persisted evidence, without model polling.

Only current canvas branches participate. This observer never edits the canvas,
accepts a candidate, or fabricates an output review. The existing coordinator
owns leases, busy-chat deferral and durable consumption of each event hash.
Native completions register and schedule checks through durable settlement checkpoints.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any
from pathlib import Path
from contextvars import ContextVar

from novelvideo.freezone.remix.reference_commission import advance_reference_commission, read_reference_commission
from novelvideo.freezone.remix.store import RemixArtifactStore
from novelvideo.freezone.workflow_runs import list_workflow_runs
from novelvideo.llm_instrumentation import log_production_plan_diagnostic
from novelvideo.freezone.remix.production_plan_failures import (
    format_plan_failure_notice, read_plan_failure_summary,
)
from novelvideo.chat.reference_runtime_diagnostics import (
    log_reference_runtime_failure, log_reference_runtime_recovered,
)

logger = logging.getLogger(__name__)
_observation_batch = ContextVar("reference_observation_batch", default=None)
_observation_failures = ContextVar("reference_observation_failures", default=None)
POLL_SECONDS = 5.0
WAITING_PHASES = ('drafting_plan', 'awaiting_plan_review', 'awaiting_plan_confirmation',
                  'preparing_materials', 'aligning_speech', 'composing', 'reviewing_output')


def _ref(artifact):
    return {'artifact_id': artifact['id'], 'revision': artifact['revision'], 'project_id': artifact['project_id']}


def _observation(event, evidence):
    digest = hashlib.sha256(json.dumps({'event':event,'evidence':evidence}, sort_keys=True, separators=(',',':')).encode()).hexdigest()
    return {'event':event,'event_key':'production:' + digest}


def _record_advancement_failure(run: dict, exc: Exception) -> None:
    failed_runs = _observation_failures.get()
    if failed_runs is not None:
        failed_runs.add(id(run))
    log_reference_runtime_failure(component='reference_production_observer',
        scope=run, stage='automatic_advancement', error=exc,
        refs={'commission_ref': run.get('commission_ref')})


def _transient_advancement_error(exc: Exception) -> bool:
    """Lock contention and timeouts clear on their own; deterministic errors do not."""
    from novelvideo.freezone.canvas_lock import CanvasLockBusy
    if isinstance(exc, (CanvasLockBusy, TimeoutError)):
        return True
    return type(exc).__name__ in {'OperationalError', 'DatabaseBusy'}


def _advancement_failure_observation(run: dict, exc: Exception,
                                     previous: dict | None = None) -> dict:
    """Stable wake receipt for a failed automatic action.

    A previously delivered stage-ready notice must not hide a later
    acceptance/binding failure, and a failure without any stage event must
    still wake the Agent: silently retrying the same action leaves production
    stalled with no one to correct it. Identity is the error plus the saved
    stage, so one failure wakes once instead of every poll.
    """
    previous = previous or {}
    cause = ' '.join(str(exc).split())[:240]
    evidence = {
        'observation': previous.get('event_key') or 'automatic_advancement',
        'stage_event': (previous.get('event') or {}).get('type'),
        'phase': run.get('commission_phase'),
        'automatic_advancement_failure': type(exc).__name__,
        'cause': cause,
    }
    observed = _observation(None, {'commission': run.get('commission_ref'), **evidence})
    observed['evidence'] = evidence
    observed['notice'] = (previous.get('notice', '')
        + ' 自动推进未完成，当前素材与确认记录已保留；请检查工作包后继续。'
        + (f' 原因：{cause}。' if cause else ''))
    return observed


def _plan_presentation_retry_event(run: dict, decision_ref: dict,
                                   *, presented: bool) -> dict | None:
    if presented or run.get('status') not in {*WAITING_PHASES, 'resume_failed'}:
        return None
    prefix = 'plan-presentation:' + decision_ref['artifact_id'] + ':'
    attempts = sum(str(key).startswith(prefix)
                   for key in run.get('commission_event_receipts', []))
    if attempts >= 3:
        return None
    return {'event': None, 'event_key': prefix + str(attempts + 1)}


def _bound_plan_node(node: dict, commission: dict, workflow_state_dir: Path) -> bool:
    """Accept only a plan node delivered by this commission's approved draft."""
    if not commission.get('direction_fingerprint'):
        return True  # Legacy commissions predate native direction binding.
    from novelvideo.freezone.workflow_drafts import read_workflow_draft

    data = node.get('data') or {}
    draft_id = str(data.get('workflowInstanceId') or '')
    plan_node_id = str(data.get('workflowPlanNodeId') or '')
    if not draft_id or not plan_node_id:
        return False
    try:
        draft, _ = read_workflow_draft(
            project_dir=workflow_state_dir, canvas_id=commission['canvas_id'],
            draft_id=draft_id,
        )
    except ValueError:
        return False
    if not draft or draft.get('status') != 'confirmed':
        return False
    binding = (draft.get('compiled') or {}).get('reference_binding') or {}
    expected = {
        'commission_id': commission['commission_ref']['artifact_id'],
        'canvas_id': commission['canvas_id'],
        'analysis_node_id': commission['analysis_node_id'],
        'direction_revision': commission['direction_revision'],
        'direction_fingerprint': commission['direction_fingerprint'],
    }
    if any(binding.get(key) != value for key, value in expected.items()):
        return False
    if commission.get('requester_user_id') and binding.get('requester_user_id') != commission['requester_user_id']:
        return False
    nodes = ((draft.get('compiled') or {}).get('plan') or {}).get('nodes') or []
    return any(
        item.get('id') == plan_node_id
        and item.get('node_type') == 'scriptNode'
        and (item.get('data') or {}).get('processingAction') == 'generate_production_plan_draft'
        for item in nodes if isinstance(item, dict)
    )


def _canvas_refs(store, canvas, commission, workflow_state_dir: Path | None = None):
    """Read only graph descendants of this source's analysis in this canvas."""
    workflow_state_dir = workflow_state_dir or store.project_dir
    reachable = {commission['analysis_node_id']}
    for _ in range(len(canvas.get('nodes', []))):
        children = {e.get('target') for e in canvas.get('edges',[]) if e.get('source') in reachable}
        if children <= reachable:
            break
        reachable.update(children)
    found = {}
    for node in canvas.get('nodes', []):
        if node.get('id') not in reachable:
            continue
        data = node.get('data') or {}
        if data.get('workflowResultStale') is True:
            continue
        direct_bound = (not data.get('workflowInstanceId') and not data.get('workflowPlanNodeId')
                        and (data.get('productionPlanV2Ref') or {}).get('artifactId')
                        == (commission.get('plan_ref') or {}).get('artifact_id'))
        if ((data.get('remixRole') == 'production_plan' or data.get('productionPlanV2Ref'))
                and not direct_bound and not _bound_plan_node(node, commission, workflow_state_dir)):
            continue
        for field in ('productionPlanV2Ref', 'remixManifestRef'):
            ref = data.get(field)
            if not isinstance(ref, dict):
                continue
            try:
                saved = store.read(ref['artifactId'], ref['revision'])
                latest = store.read_latest(saved['id'])
                # The persisted canvas is the branch authority. An artifact
                # saved ahead of its canvas reference is still pending sync.
                if (latest['revision'] == saved['revision']
                        or (saved['schema'] == 'production_plan.v2'
                            and saved['id'] == (commission.get('plan_ref') or {}).get('artifact_id')
                            and saved.get('created_by') == commission.get('requester_user_id'))):
                    found[saved['id']] = saved
            except (ValueError, KeyError, FileNotFoundError):
                continue
    return list(found.values())


def _latest_plan_generation(canvas: dict, commission: dict, workflow_state_dir: Path) -> tuple[dict, list[dict]] | None:
    """Find the latest native plan submission on this commission's canvas branch."""
    from novelvideo.freezone.workflow_runs import list_workflow_runs

    analysis_node_id = commission.get('analysis_node_id')
    if not analysis_node_id:
        return None
    reachable = {analysis_node_id}
    for _ in range(len(canvas.get('nodes', []))):
        reachable.update(edge.get('target') for edge in canvas.get('edges', [])
                         if edge.get('source') in reachable)
    plan_nodes = {node.get('id') for node in canvas.get('nodes', [])
                  if node.get('id') in reachable and (node.get('data') or {}).get('remixRole') == 'production_plan'
                  and _bound_plan_node(node, commission, workflow_state_dir)}
    if not plan_nodes:
        return None
    for run in list_workflow_runs(project_dir=workflow_state_dir, canvas_id=commission['canvas_id'], limit=100):
        if (run.get('actor_id') != commission.get('requester_user_id')
                or canvas.get('project_id') and run.get('project_id') != canvas['project_id']):
            continue
        actions = [action for action in run.get('actions', [])
                   if action.get('node_id') in plan_nodes and action.get('action') in {'generate_production_plan_draft', 'generate_production_plan_arrangement'}]
        if actions:
            return run, actions
    return None


def _plan_generation_awaiting_canvas_result(canvas: dict, commission: dict, workflow_state_dir: Path) -> bool:
    # A confirmed draft may be awaiting its canvas receipt before any plan
    # node or workflow run is visible. Keep the current admission identity and
    # let the host reconcile it instead of starting another Agent plan turn.
    from types import SimpleNamespace
    from novelvideo.freezone.remix.native_plan_stage import read_native_plan_stage

    if all(commission.get(key) for key in (
        'canvas_id', 'requester_user_id', 'analysis_node_id',
        'direction_revision', 'direction_fingerprint', 'commission_ref',
    )):
        ctx = SimpleNamespace(
            state_dir=workflow_state_dir,
            project_id=canvas.get('project_id') or commission.get('project_id'),
            requester_user_id=commission['requester_user_id'],
        )
        stage = read_native_plan_stage(ctx=ctx, canvas=canvas, commission=commission)
        if any(slot.get('state') in {'awaiting_canvas_receipt', 'running', 'ready_for_review'}
               for slot in stage.get('slots', [])):
            return True
    latest = _latest_plan_generation(canvas, commission, workflow_state_dir)
    return bool(latest and latest[0].get('status') in {'running', 'completed'}
                and any(action.get('status') in {'pending', 'running', 'completed'} for action in latest[1]))


def _failed_plan_generation(canvas: dict, commission: dict, workflow_state_dir: Path,
                            *, tasks_by_key: dict | None = None) -> dict | None:
    """Wake the Agent once for a failed native plan task; never invent a plan."""
    latest = _latest_plan_generation(canvas, commission, workflow_state_dir)
    if latest and latest[0].get('status') == 'failed' and any(action.get('status') == 'failed' for action in latest[1]):
        observation = _observation(None, {'failed_plan_run': latest[0]['run_id'],
                                           'commission': commission['commission_ref']})
        observation['native_failure'] = True
        failed = next((action for action in latest[1] if action.get('status') == 'failed'), {})
        observation.update(action=failed.get('action'), task_id=failed.get('task_key'))
        observation['notice'] = ('画面与声音安排失败，已保留结构、台词及人工修改；请检查失败任务，明确重试时只重试画面与声音安排。'
            if failed.get('action') == 'generate_production_plan_arrangement'
            else '作品方案生成失败，已保留确认的方向；请检查画布任务后重试。')
        task_key = failed.get('task_key')
        task = tasks_by_key.get(task_key) if tasks_by_key and task_key else None
        failure = read_plan_failure_summary(task) if task is not None else None
        if failure is not None:
            task_project = getattr(task, 'project_id', None) if not isinstance(task, dict) else task.get('project_id')
            task_scope = getattr(task, 'scope', None) if not isinstance(task, dict) else task.get('scope')
            task_type = getattr(task, 'task_type', None) if not isinstance(task, dict) else task.get('task_type')
            operation_id = failed.get('processing_operation_id')
            if ((latest[0].get('project_id') and task_project != latest[0]['project_id'])
                    or (failed.get('job_id') and task_scope != failed['job_id'])
                    or (failed.get('task_type') and task_type != failed['task_type'])
                    or (operation_id and failure.get('operation_id') != operation_id)):
                failure = None
        if failure is not None:
            observation['validation_failure'] = failure
            observation['notice'] = (
                format_plan_failure_notice(failure)
                + ' 保留用户确认的方向及现有节点；本次失败通知仅用于解释，不构成新的生成授权。'
                '不得自动调用起草、补齐或备用模型重试；后续执行仍沿用原有用户授权与动作确认。'
            )
        return observation
    return None


def _native_plan_conflict_observation(ctx, canvas_id: str, commission: dict) -> dict | None:
    """Wake only the commission that owned an unpublished native plan result."""
    from novelvideo.freezone.remix.production_processing_settlement import read_processing_settlement_conflicts

    commission_id = (commission.get('commission_ref') or {}).get('artifact_id')
    if not commission_id or commission.get('phase') != 'drafting_plan':
        return None
    matched = []
    for workflow in list_workflow_runs(project_dir=ctx.state_dir, canvas_id=canvas_id, limit=100):
        if workflow.get('project_id') != ctx.project_id or workflow.get('actor_id') != ctx.requester_user_id:
            continue
        for record in read_processing_settlement_conflicts(ctx, canvas_id=canvas_id, run_id=workflow['run_id']):
            if (record.get('action') != 'generate_production_plan_draft'
                    or record.get('commission_id') != commission_id
                    or record.get('direction_revision') != commission.get('direction_revision')
                    or record.get('direction_fingerprint') != commission.get('direction_fingerprint')):
                continue
            matched.append({key: record.get(key) for key in (
                'workflow_run_id', 'node_id', 'operation_id', 'result_ref', 'reason')})
    if not matched:
        return None
    observation = _observation(None, {'plan_settlement_conflicts': sorted(matched,
        key=lambda row: (str(row['workflow_run_id']), str(row['node_id']), str(row['operation_id']))),
        'commission_id': commission_id, 'direction_revision': commission.get('direction_revision')})
    observation['native_failure'] = True
    observation['notice'] = '作品方案结果与当前画布或方向不一致，产物已保留；请核对当前方案后继续。'
    return observation


def _native_delivery_failure_observation(ctx, canvas: dict, commission: dict) -> dict | None:
    """Surface a terminal confirmation task without authorizing another graph."""
    if commission.get('phase') != 'drafting_plan' or not all(commission.get(key) for key in (
        'canvas_id', 'requester_user_id', 'analysis_node_id',
        'direction_revision', 'direction_fingerprint', 'commission_ref',
    )):
        return None
    from novelvideo.freezone.remix.native_plan_stage import read_native_plan_stage

    stage = read_native_plan_stage(ctx=ctx, canvas=canvas, commission=commission)
    failed = [slot for slot in stage.get('slots', [])
              if slot.get('state') == 'delivery_unverified']
    if not failed:
        return None
    observation = _observation(None, {
        'commission': commission['commission_ref'],
        'draft_id': stage.get('draft_id'),
        'task_ids': sorted({slot['next_action']['task_id'] for slot in failed}),
    })
    observation['native_failure'] = True
    observation['notice'] = '工作流确认任务已结束，但画布交付尚未核对；当前提交已保留，请检查任务回执和画布后继续。'
    return observation


def _reconcile_native_workflow_delivery(ctx, commission: dict) -> bool:
    """Recover a late canvas save after the original confirmation task ended."""
    if commission.get('phase') != 'drafting_plan' or not all(commission.get(key) for key in (
        'canvas_id', 'requester_user_id', 'analysis_node_id',
        'direction_revision', 'direction_fingerprint', 'commission_ref',
    )):
        return False
    from novelvideo.freezone.workflow_drafts import read_native_plan_claim
    from novelvideo.freezone.workflow_delivery import reconcile_workflow_draft_delivery

    claim = read_native_plan_claim(
        project_dir=ctx.state_dir, project_id=ctx.project_id,
        canvas_id=commission['canvas_id'], requester_user_id=ctx.requester_user_id,
        commission_id=commission['commission_ref']['artifact_id'],
        direction_revision=commission['direction_revision'],
    )
    if not claim or claim.get('status') not in {'confirming', 'submitted'}:
        return False
    binding = (claim.get('compiled') or {}).get('reference_binding') or {}
    if any(binding.get(key) != value for key, value in (
        ('project_id', ctx.project_id), ('canvas_id', commission['canvas_id']),
        ('requester_user_id', ctx.requester_user_id),
        ('commission_id', commission['commission_ref']['artifact_id']),
        ('analysis_node_id', commission['analysis_node_id']),
        ('direction_revision', commission['direction_revision']),
        ('direction_fingerprint', commission['direction_fingerprint']),
    )):
        return False
    task_id, attempt = claim.get('task_id'), claim.get('confirmation_started_at')
    if not isinstance(task_id, str) or not task_id or not isinstance(attempt, (int, float)):
        return False
    return reconcile_workflow_draft_delivery(
        project_dir=ctx.state_dir, canvas_id=commission['canvas_id'],
        draft_id=claim['draft_id'], task_id=task_id, attempt=attempt,
    )


def _saved_work(store, canvas, commission, plan):
    """Observe only explicitly associated work, matching the progress reader."""
    explicit = commission.get('work_ref')
    if not explicit:
        return None
    candidates = []
    paths = [store.root / explicit['artifact_id']]
    node_ids = {node.get('id') for node in canvas.get('nodes', [])}
    for path in paths[:1000]:
        if path.is_symlink() or not path.is_dir():
            continue
        try:
            artifact = store.read_latest(path.name)
        except (ValueError, FileNotFoundError):
            continue
        if artifact['schema'] != 'material_work_package.v1':
            continue
        if artifact['revision'] < explicit['revision'] or artifact['created_by'] != commission['requester_user_id']:
            continue
        work = artifact['payload']
        if work['plan_ref']['artifact_id'] != plan['id']:
            continue
        # Reject an execution explicitly assigned to another private canvas.
        if any((s.get('execution') or {}).get('canvas_id', commission['canvas_id']) != commission['canvas_id'] for s in work['steps']):
            continue
        if any(s.get('node_id') and s['node_id'] not in node_ids for s in work['steps']):
            continue
        candidates.append(artifact)
    return candidates[0] if len(candidates) == 1 else None


def _discover_material_executions(store, canvas, commission, work, workflow_state_dir):
    """Bind only a unique actual canvas node and persisted native task action.

    Draft attachment precedes native execution, so it cannot carry node/run/task
    identities. Discover those from authenticated saved records after submission.
    Never select an arbitrary recent run if multiple attempts match.
    """
    from novelvideo.freezone.workflow_runs import list_workflow_runs
    from novelvideo.freezone.remix.material_execution import register_material_execution, validate_material_native_execution
    runs = None
    for step_id in [step['id'] for step in work['payload']['steps']]:
        step = next(step for step in work['payload']['steps'] if step['id'] == step_id)
        execution = step.get('execution') or {}
        if step['source'] != 'generate' or step['status'] != 'submitted' or not execution.get('workflow_instance_id') or not execution.get('plan_node_id'):
            continue
        if step.get('node_id') and execution.get('run_id') and execution.get('task_id'):
            continue
        nodes = [node for node in canvas.get('nodes',[]) if (node.get('data') or {}).get('workflowInstanceId') == execution['workflow_instance_id']
                 and (node.get('data') or {}).get('workflowPlanNodeId') == execution['plan_node_id']]
        if len(nodes) != 1:
            continue
        node = nodes[0]
        try:
            validate_material_native_execution(store,canvas,step,node['id'],workflow_state_dir=workflow_state_dir)
        except (ValueError,KeyError,FileNotFoundError):
            continue
        if runs is None:
            runs = list_workflow_runs(project_dir=workflow_state_dir,canvas_id=commission['canvas_id'],limit=200)
        data = node.get('data') or {}
        task_key = data.get('taskKey') or data.get('task_key')
        matches = [(run,action) for run in runs
                   if run.get('project_id') == store.project_id
                   # A superseded browser submission can still contain the
                   # same completed task. It is historical evidence, not a
                   # second candidate for the current material step.
                   and not (run.get('metadata') or {}).get('superseded_by_run_id')
                   for action in run.get('actions',[]) if action.get('node_id') == node['id'] and action.get('recipe_id') == step['recipe_id']
                   and action.get('task_key') and (not task_key or task_key == action['task_key'])]
        if len(matches) != 1:
            continue
        native,action = matches[0]
        discovered = {**execution,'run_id':native['run_id'],'task_id':action['task_key']}
        register_material_execution(store,{'artifact_id':work['id'],'revision':work['revision']},step_id,node['id'],discovered)
        work = store.read_latest(work['id'])
    return work


def _saved_plan_observation(store, plan, commission, latest=None):
    """One event identity for observation and verified same-turn consumption."""
    from novelvideo.freezone.remix.production_review import is_unarranged_outline
    completed = next((action for action in (latest[1] if latest else [])
                      if action.get('status') == 'completed'), {})
    if is_unarranged_outline(plan['payload']):
        observation = _observation(None, {'outline_ref': _ref(plan),
                                         'commission': commission['commission_ref']})
        observation.update(action=completed.get('action'), task_id=completed.get('task_key'),
            authoring_stage='outline', plan_ref=_ref(plan),
            notice='结构与台词已保存，可读取并局部修改。此任务已结束，画面与声音尚未安排；需要继续时，根据用户授权明确调用安排画面与声音动作，遵守原有执行确认流程。不得自动续跑、重新起草或开始素材制作。')
        return observation
    event = {'type': 'plan_ready', 'plan_ref': _ref(plan)}
    if plan['payload'].get('authoring_stage'):
        event.update(authoring_stage=plan['payload']['authoring_stage'],
                     action=completed.get('action'), task_id=completed.get('task_key'))
    observation = _observation(event, {
        'project_id': store.project_id, 'canvas_id': commission['canvas_id'],
        'commission_id': commission['commission_ref']['artifact_id'],
        'direction_fingerprint': commission.get('direction_fingerprint'),
        'direction_revision': commission.get('direction_revision'),
    })
    observation['notice'] = f"作品方案已保存（{plan['id']} rev{plan['revision']}），请核对当前版本并继续审核或制作。"
    return observation


def production_event(store: RemixArtifactStore, canvas: dict, commission: dict, tasks_by_key: dict | None = None, *, workflow_state_dir: Path | None = None, check_scheduler=None, consumed_event_keys=()) -> dict | None:
    """Return one trusted stage event, reading and validating saved artifacts."""
    workflow_state_dir = workflow_state_dir or store.project_dir
    artifacts = _canvas_refs(store, canvas, commission, workflow_state_dir)
    plans = [a for a in artifacts if a['schema'] == 'production_plan.v2']
    selected = commission.get('plan_ref')
    if selected:
        plans = [p for p in plans if p['id'] == selected['artifact_id']]
    latest = None
    if commission['phase'] == 'drafting_plan':
        latest = _latest_plan_generation(canvas, commission, workflow_state_dir)
        if latest:
            actions = latest[1]
            if any(action.get('status') == 'failed' for action in actions):
                return _failed_plan_generation(canvas, commission, workflow_state_dir,
                                               tasks_by_key=tasks_by_key)
            if any(action.get('status') in {'pending', 'running'} for action in actions):
                return None
            completed_refs = {(
                (action.get('result_ref') or {}).get('artifact_id'),
                (action.get('result_ref') or {}).get('revision'),
            ) for action in actions if action.get('status') == 'completed'}
            plans = [plan for plan in plans if (plan['id'], plan['revision']) in completed_refs]
    if len(plans) > 1:
        observation = _observation(None, {'branch_selection_required': [_ref(p) for p in sorted(plans,key=lambda a:a['id'])], 'commission':commission['commission_ref']})
        observation['notice'] = '原片存在多个已保存作品方案，请选择本次制作分支；所有方案均已保留。'
        return observation
    if not plans:
        if commission['phase'] == 'drafting_plan':
            return _failed_plan_generation(canvas, commission, workflow_state_dir,
                                           tasks_by_key=tasks_by_key)
        return None
    plan = plans[0]
    phase = commission['phase']
    from novelvideo.freezone.remix.production_review import is_unarranged_outline
    if (is_unarranged_outline(plan['payload']) or phase == 'drafting_plan'
            or (selected and selected['revision'] != plan['revision'])):
        observation = _saved_plan_observation(store, plan, commission, latest)
        if observation['event_key'] not in consumed_event_keys:
            return observation
        if is_unarranged_outline(plan['payload']):
            return None
    if phase == 'preparing_materials':
        work = _saved_work(store,canvas,commission,plan)
        if work:
            work = _discover_material_executions(store,canvas,commission,work,workflow_state_dir)
            steps = {s['id']:s for s in work['payload']['steps']}
            finals = [steps[r['final_step_id']] for r in work['payload']['requirements']]
            from novelvideo.freezone.remix.material_execution import canvas_material_resource, validate_material_native_execution
            if all(s['status'] == 'accepted' for s in finals):
                for final in finals:
                    try:
                        current = canvas_material_resource(store,canvas,final['accepted_resource']['node_id'],final['media_kind'])
                        if current != final['accepted_resource']:
                            return None
                    except (ValueError, KeyError, FileNotFoundError):
                        return None
                # The commission transition also verifies exact resource bindings.
                return _observation({'type':'materials_ready','work_ref':_ref(work)},[work['content_hash'],plan['content_hash']])
            observations = []
            failures = []
            settlement_ids = []
            for step in work['payload']['steps']:
                if step['status'] in {'accepted','rejected'} or not step.get('node_id'):
                    continue
                try:
                    if step['source'] == 'generate':
                        execution = validate_material_native_execution(store,canvas,step,step['node_id'],workflow_state_dir=workflow_state_dir,work_ref={'artifact_id':work['id'],'revision':work['revision']})
                        from novelvideo.freezone.workflow_runs import read_workflow_run
                        native = read_workflow_run(project_dir=workflow_state_dir,canvas_id=commission['canvas_id'],run_id=execution.get('run_id',''))
                        if native and native.get('project_id') != store.project_id:
                            continue
                        action = next((a for a in (native or {}).get('actions',[]) if a.get('node_id') == step['node_id'] and a.get('task_key') == execution.get('task_id') and a.get('recipe_id') == step['recipe_id']),None)
                        task = (tasks_by_key or {}).get((action or {}).get('task_key'))
                        status = (action or {}).get('status') or getattr(task,'status',None)
                        if status in {'failed','cancelled','blocked'}:
                            failures.append({'step_id':step['id'],'task_key':action['task_key'],'status':status,'error':str(getattr(task,'error',None) or action.get('error') or '')[:1000]})
                            continue
                        if status != 'completed' and action:
                            continue
                        from novelvideo.freezone.remix.material_settlement import settle_material_result
                        settled = settle_material_result(store=store, canvas=canvas,
                            work_ref={'artifact_id':work['id'],'revision':work['revision']}, step_id=step['id'],
                            native_result={'run_id':execution.get('run_id'),'node_id':step['node_id'],'task_key':execution.get('task_id')},
                            workflow_state_dir=workflow_state_dir, check_scheduler=check_scheduler,
                            allow_cancelled_completed=bool(
                                native and native.get('status') == 'cancelled'
                                and action and action.get('status') == 'completed'
                            ))
                        work = store.read_latest(work['id'])
                        if settled.get('status') in {'stale', 'failed'} or not settled.get('resource') or not (settled.get('review_ref') or settled.get('check_ref')):
                            continue
                        settlement_ids.append(settled['settlement_id'])
                    resource = canvas_material_resource(store,canvas,step['node_id'],step['media_kind'])
                    observations.append({'step_id':step['id'],'resource':resource})
                except (ValueError, KeyError, FileNotFoundError):
                    continue
            from novelvideo.freezone.remix.material_work import material_stage_groups, ready_material_steps
            # Settlement remains per candidate, but an Agent turn belongs to a
            # complete dependency-depth stage, not each native completion.
            steps = {step['id']: step for step in work['payload']['steps']}
            groups = material_stage_groups(work['payload'])
            stage = next((group for group in groups
                          if any(steps[step_id]['status'] != 'accepted' for step_id in group)), [])
            candidates = {row['step_id']: row['resource'] for row in observations}
            stage_resources = [
                {'step_id': step_id, 'resource': steps[step_id].get('accepted_resource')
                 if steps[step_id]['status'] == 'accepted' else candidates.get(step_id)}
                for step_id in stage
            ]
            ready = ready_material_steps(work['payload'])
            stage_complete = bool(stage_resources) and all(row['resource'] for row in stage_resources)
            next_stage_ready = bool(stage and groups.index(stage) > 0 and set(ready) == set(stage))
            if failures or stage_complete or next_stage_ready:
                # Failure identity excludes partial candidates. Acceptance of
                # one candidate likewise cannot change a stage-ready identity.
                evidence = {'work_id': work['id'], 'stage_step_ids': stage}
                if failures:
                    evidence['failures'] = failures
                elif stage_complete:
                    evidence['candidates'] = stage_resources
                else:
                    evidence['ready_step_ids'] = stage
                observation = _observation(None, evidence)
                if settlement_ids:
                    observation['settlement_ids'] = settlement_ids
                if stage_complete:
                    observation['notice'] = '本阶段素材已全部就绪，检查记录已保存；请统一审看并确认本阶段素材。'
                elif next_stage_ready:
                    observation['notice'] = '上一阶段素材已全部确认，下一阶段已就绪；请按原有授权与动作确认流程继续。'
                if failures:
                    observation['notice'] = '素材制作任务失败或已取消，已保留原片分析和当前候选，请检查当前工作包后重试失败步骤。'
                return observation
        # Empty plans have no material requirements; dialogue still needs evidence.
        if not work and not plan['payload'].get('resources') and not plan['payload'].get('placements') and not any(b.get('turns') for b in plan['payload']['beats']):
            return _observation({'type':'speech_aligned','plan_ref':_ref(plan)},plan['content_hash'])
    if phase == 'aligning_speech':
        turns = [t for b in plan['payload']['beats'] for t in b.get('turns',[]) if t.get('text')]
        cues = plan['payload'].get('speech_cues',[])
        if all(any(c.get('turn_id') == t['id'] and c.get('timing_status') == 'ready' for c in cues) for t in turns):
            return _observation({'type':'speech_aligned','plan_ref':_ref(plan)},plan['content_hash'])
    if phase == 'composing':
        manifests = [a for a in artifacts if a['schema'] == 'composition_manifest.v2' and a['payload']['source_versions'] == [{'artifact_id':plan['id'],'revision':plan['revision']}]]
        if len(manifests) == 1:
            return _observation({'type':'composition_ready','manifest_ref':_ref(manifests[0])},manifests[0]['content_hash'])
    if phase == 'reviewing_output' and commission.get('manifest_ref'):
        from urllib.parse import quote
        from novelvideo.freezone.remix.operations import RemixOperationStore
        from novelvideo.freezone.remix.material_execution import canvas_material_resource
        manifest_ref = commission['manifest_ref']
        expected = {'artifactId':manifest_ref['artifact_id'],'revision':manifest_ref['revision']}
        rendered = []
        for node in canvas.get('nodes',[]):
            data = node.get('data') or {}
            if (data.get('remixRenderManifestRef') != expected or data.get('remixManifestRef') != expected
                    or data.get('productionPlanRenderedRef') != {'artifactId':plan['id'],'revision':plan['revision']}
                    or data.get('remixInputsCurrent') is not True or data.get('workflowResultStale') is True):
                continue
            try:
                operation = RemixOperationStore(store.project_dir,store.project_id).get(data.get('remixRenderOperationId',''))
                refs = operation.get('output_refs') or []
                if (operation['status'] != 'completed' or operation.get('canvas_id') != commission['canvas_id']
                        or operation.get('node_id') != node['id'] or len(refs) != 1
                        or operation.get('input_refs') != [{'artifact_id':manifest_ref['artifact_id'],'revision':manifest_ref['revision']}]
                        or operation.get('node_revision') != data.get('remixNodeRevision')):
                    continue
                path = refs[0]['project_path']
                url = f"/api/v1/projects/{quote(store.project_id,safe='')}/media/{quote(path,safe='/')}"
                if data.get('resultVideoUrl') != url:
                    continue
                # Probe actual output bytes in a temporary view; preserve saved edits.
                view = {'nodes':[{'id':node['id'],'data':{**data,'videoUrl':url}}]}
                resource = canvas_material_resource(store,view,node['id'],'video')
                rendered.append({'operation_id':operation['operation_id'],'resource':resource})
            except (ValueError, KeyError, FileNotFoundError):
                continue
        if rendered:
            return _observation(None,{'manifest':manifest_ref,'rendered_outputs':rendered})
    return None


def _completed_branch_current(store, canvas, child):
    """A stored completed label cannot approve a subsequently edited artifact."""
    try:
        plan_ref = child['plan_ref']
        plan = store.read_latest(plan_ref['artifact_id'])
        if plan['revision'] != plan_ref['revision']:
            return False
        review_ref = child['review_ref']
        review = store.read(review_ref['artifact_id'],review_ref['revision'])['payload']
        from novelvideo.freezone.remix.production_review import production_decision_fingerprint
        if review['status'] != 'passed' or review['decision_fingerprint'] != production_decision_fingerprint(plan['payload']) or review['direction_fingerprint'] != child['direction_fingerprint']:
            return False
        if child['production_scope'] == '仅作品方案':
            return any(row.get('type') == 'plan_confirmed' and row.get('plan_ref') == plan_ref and row.get('message_id') for row in child['decisions'])
        manifest_ref = child['manifest_ref']
        manifest = store.read(manifest_ref['artifact_id'],manifest_ref['revision'])
        if manifest['payload']['source_versions'] != [{'artifact_id':plan['id'],'revision':plan['revision']}]:
            return False
        from novelvideo.freezone.remix.production_plan_v2 import project_production_plan_v2
        if not project_production_plan_v2(plan['payload'],project_dir=store.project_dir)['ready']:
            return False
        if child['production_scope'] == '可编辑合成':
            return any(row.get('type') == 'editable_composition_confirmed' and row.get('manifest_ref') == manifest_ref and row.get('message_id') for row in child['decisions'])
        output_ref = child['output_review_ref']
        output = store.read(output_ref['artifact_id'],output_ref['revision'])['payload']
        def exact(ref):
            return {'artifact_id':ref['artifact_id'],'revision':ref['revision']}
        if output['status'] != 'passed' or output['manifest_ref'] != exact(manifest_ref) or output['plan_ref'] != exact(plan_ref):
            return False
        from novelvideo.api.routes.remix_media import _inspect_existing_media
        if _inspect_existing_media(store.project_dir,output['media']['media_path']) != output['media']:
            return False
        from novelvideo.api.routes.remix import _validate_v2_canvas_bindings
        _validate_v2_canvas_bindings(canvas,manifest['payload'],manifest_ref,plan['payload'],output['compose_node_id'],store.project_id)
        return True
    except (ValueError,KeyError,FileNotFoundError):
        return False


def _branch_commissions(store, parent):
    """Resolve only registered children whose original parent scope is current."""
    from novelvideo.freezone.remix.reference_branches import validate_reference_branch_lineage
    children = []
    seen = set()
    for row in parent.get('plan_branches',[]):
        ref = row['commission_ref']
        if ref['artifact_id'] in seen:
            raise ValueError('duplicate production branch')
        seen.add(ref['artifact_id'])
        artifact = store.read_latest(ref['artifact_id'])
        child = read_reference_commission(store,ref,latest=True)
        parent_ref = child.get('parent_commission_ref') or {}
        if (parent_ref.get('artifact_id') != parent['commission_ref']['artifact_id']
                or parent_ref.get('revision') != row['parent_revision']
                or (child.get('plan_ref') or {}).get('artifact_id') != row['plan_ref']['artifact_id']):
            raise PermissionError('production branch identity differs from parent')
        validate_reference_branch_lineage(store,artifact['payload'],artifact['upstream_refs'])
        inherited = read_reference_commission(store,parent_ref)
        for field in ('project_id','canvas_id','requester_user_id','analysis_node_id','analysis_evidence','goal','production_scope','direction_revision','direction_fingerprint'):
            if parent.get(field) != inherited.get(field):
                raise PermissionError('production parent changed after branching')
        for field in ('project_id','canvas_id','requester_user_id','analysis_node_id','analysis_evidence','goal','production_scope'):
            if child.get(field) != parent.get(field):
                raise PermissionError('production branch scope differs from parent')
        children.append(child)
    return children


class ReferenceProductionObserver:
    def __init__(self, coordinator=None, *, check_scheduler=None):
        if coordinator is None:
            from novelvideo.chat.reference_remix_continuation import coordinator
        self.coordinator = coordinator
        self.check_scheduler = check_scheduler
        self._worker = None
        self._wake = asyncio.Event()

    async def _publish_cards(self, ctx, run):
        if not getattr(ctx, 'requester_username', None):
            return
        from novelvideo.freezone.remix.conversation_cards import publish_conversation_cards
        from novelvideo.freezone.remix.director_notifications import broadcast_director_update
        await publish_conversation_cards(ctx, canvas_id=run['canvas_id'], runs=[run])
        # An automatic acceptance changes the work package without a new card.
        # Direct readers of /production-state only refresh on this event.
        await broadcast_director_update(ctx, canvas_id=run['canvas_id'],
            agent_ids=[run.get('agent_id')])

    async def observe_run(self, run: dict[str, Any], *, batch=None) -> bool:
        batch = batch if batch is not None else _observation_batch.get()
        ctx = await self.coordinator._resolve_context(run)
        canvas = await asyncio.to_thread(self.coordinator._assert_current,ctx,run,completed=True)
        from novelvideo.api.routes.freezone import resume_host_owned_native_workflows
        await resume_host_owned_native_workflows(ctx, canvas_id=run['canvas_id'])
        store = RemixArtifactStore(ctx.output_dir,ctx.project_id, created_by=ctx.requester_user_id)
        from novelvideo.project_context import ProjectContext
        from novelvideo.freezone.remix.production_automation import read_production_control
        control = (await asyncio.to_thread(read_production_control, ctx, canvas_id=run['canvas_id'],
            commission_id=run['commission_ref']['artifact_id'], agent_id=run.get('agent_id', 'main'))
            if isinstance(ctx, ProjectContext) else None)
        if control and not control['active']:
            return False
        check_scheduler = self.check_scheduler
        if check_scheduler is None and control and control['active']:
            from novelvideo.freezone.remix.source_speech import make_material_speech_scheduler
            native_scheduler = make_material_speech_scheduler(ctx, canvas_id=run['canvas_id'])
            from novelvideo.freezone.remix.production_automation import assert_production_automation_current, _canvas_lock
            def check_scheduler(**kwargs):
                # Stop and ASR admission use the same canvas lease. A callback
                # captured before stop cannot submit into a later generation.
                with _canvas_lock(ctx, run['canvas_id']) as guard:
                    assert_production_automation_current(ctx, canvas_id=run['canvas_id'],
                        commission_id=run['commission_ref']['artifact_id'], agent_id=run.get('agent_id', 'main'),
                        generation=control['generation'])
                    guard.reassert()
                    return native_scheduler(**kwargs)
        commission = await asyncio.to_thread(read_reference_commission,store,run['commission_ref'],latest=True)
        if (commission['canvas_id'],commission['requester_user_id']) != (run['canvas_id'],ctx.requester_user_id):
            raise PermissionError('production commission scope changed')
        from novelvideo.freezone.remix.plan_revision_settlement import recover_same_turn_plan_revisions
        recovered = await asyncio.to_thread(recover_same_turn_plan_revisions, ctx, store, run)
        if run.get('status') == 'resume_failed' and commission['phase'] != 'drafting_plan' and not recovered:
            return False  # Receipt recovery never restarts an interrupted model turn.
        for receipt in recovered:
            current = receipt['commission']
            saved = await asyncio.to_thread(store.read, receipt['plan_ref']['artifact_id'], receipt['plan_ref']['revision'])
            identity = _saved_plan_observation(store, saved, current)['event_key']
            updated = await asyncio.to_thread(self.coordinator.store.receive_same_turn_plan_revision,
                ctx, run['run_id'], commission=current, turn_id=receipt['turn_id'], event_key=identity)
            if updated:
                run = updated
                commission = current
        if run.get('status') == 'resume_failed' and recovered:
            return False  # Restore saved facts while retaining the interrupted turn.
        received_plan = None
        if commission['phase'] in {'awaiting_plan_confirmation', 'awaiting_plan_review'} and commission.get('plan_ref'):
            candidate = await asyncio.to_thread(production_event, store, canvas, commission,
                                                workflow_state_dir=ctx.state_dir,
                                                consumed_event_keys=run.get('commission_event_receipts', []))
            if candidate and (candidate.get('event') or {}).get('type') == 'plan_ready':
                if candidate['event_key'] not in run.get('commission_event_receipts', []):
                    await asyncio.to_thread(self._advance_observed, ctx, run, store, commission, candidate['event'], control)
                    commission = await asyncio.to_thread(read_reference_commission, store, commission['commission_ref'], latest=True)
                received_plan = candidate
            elif run.get('commission_ref') != commission['commission_ref']:
                # A prior observer can crash after the commission CAS but before
                # its notice and run receipt. Recover that exact saved revision;
                # the run still points at the previous commission snapshot.
                previous = await asyncio.to_thread(read_reference_commission, store, run['commission_ref'], latest=False)
                old_ref, new_ref = previous.get('plan_ref'), commission['plan_ref']
                if (old_ref and new_ref and old_ref.get('artifact_id') == new_ref.get('artifact_id')
                        and old_ref != new_ref
                        and previous.get('direction_fingerprint') == commission.get('direction_fingerprint')
                        and previous.get('direction_revision') == commission.get('direction_revision')):
                    bound = await asyncio.to_thread(_canvas_refs, store, canvas, commission, ctx.state_dir)
                    if any(_ref(plan) == new_ref for plan in bound):
                        received_plan = _observation({'type': 'plan_ready', 'plan_ref': new_ref}, {
                            'project_id': store.project_id, 'canvas_id': commission['canvas_id'],
                            'commission_id': commission['commission_ref']['artifact_id'],
                            'direction_fingerprint': commission.get('direction_fingerprint'),
                            'direction_revision': commission.get('direction_revision'),
                        })
                        received_plan['notice'] = (
                            f"作品方案已保存（{new_ref['artifact_id']} rev{new_ref['revision']}），"
                            '请核对当前版本并继续审核或制作。'
                        )
        if received_plan is None and commission.get('plan_ref'):
            selected = commission['plan_ref']
            latest_plan = await asyncio.to_thread(store.read_latest, selected['artifact_id'])
            if latest_plan['revision'] != selected['revision']:
                persisted_plans = await asyncio.to_thread(_canvas_refs, store, canvas, commission, ctx.state_dir)
                if any(_ref(plan) == selected for plan in persisted_plans):
                    return False  # Exact artifact save is ahead of its canvas save.
        if commission['phase'] == 'awaiting_plan_confirmation' and received_plan is None:
            from novelvideo.freezone.remix.plan_review_settlement import ensure_reviewed_plan_confirmation
            from novelvideo.chat.plan_confirmation_delivery import find_plan_presentation
            from novelvideo.chat.store import ChatStore
            settled = await asyncio.to_thread(ensure_reviewed_plan_confirmation, store,
                                               commission_ref=commission['commission_ref'])
            shown = await asyncio.to_thread(find_plan_presentation,
                ChatStore(), run['username'], self.coordinator.scope(run),
                decision_ref=settled['decision_ref'], plan_ref=commission['plan_ref'],
                review_ref=commission['review_ref'], requester_user_id=ctx.requester_user_id)
            if shown and commission['phase'] == run.get('commission_phase'):
                return False
            if not shown:
                retry = _plan_presentation_retry_event(run, settled['decision_ref'], presented=False)
                if retry:
                    await self.coordinator.continue_commission(
                        ctx=ctx, run_id=run['run_id'], event_key=retry['event_key'])
                    return True
                if commission['phase'] == run.get('commission_phase'):
                    return False
        if commission['phase'] == 'awaiting_direction' and commission['phase'] == run.get('commission_phase'):
            # Direction recovery observes a persisted human transition only.
            return False
        if commission['phase'] == 'drafting_plan':
            if await asyncio.to_thread(_reconcile_native_workflow_delivery, ctx, commission):
                canvas = await asyncio.to_thread(
                    self.coordinator._assert_current, ctx, run, completed=True,
                )
        children = await asyncio.to_thread(_branch_commissions,store,commission) if commission.get('plan_branches') else []
        if children and control and control['active']:
            from novelvideo.freezone.remix.production_automation import enroll_registered_branch_controls
            await asyncio.to_thread(enroll_registered_branch_controls, ctx, canvas_id=run['canvas_id'],
                parent_ref=commission['commission_ref'], agent_id=run.get('agent_id', 'main'))
        tasks = {}
        processing_phases = {'preparing_materials', 'aligning_speech', 'composing'}
        plan_generation = (_latest_plan_generation(canvas, commission, ctx.state_dir)
                           if commission['phase'] == 'drafting_plan' else None)
        submitted_plan = bool(plan_generation and any(
            action.get('task_key') or action.get('processing_operation_id')
            for action in plan_generation[1]))
        if commission['phase'] == 'drafting_plan' and not submitted_plan:
            # The bound node may have been deleted while its task was running.
            # Reconcile that task once from its durable workflow identity so
            # settlement can retain a scoped conflict instead of hanging.
            submitted_plan = any(
                workflow.get('project_id') == ctx.project_id
                and workflow.get('actor_id') == ctx.requester_user_id
                and any(action.get('action') in {'generate_production_plan_draft', 'generate_production_plan_arrangement'}
                        and action.get('processing_operation_id') and action.get('task_key')
                        for action in workflow.get('actions', []))
                for workflow in await asyncio.to_thread(
                    list_workflow_runs, project_dir=ctx.state_dir,
                    canvas_id=run['canvas_id'], limit=100))
        if submitted_plan or commission['phase'] in processing_phases or any(child['phase'] in processing_phases for child in children):
            # The cache lives only for this page and includes the requester.
            # Each run has already resolved access and validated its own canvas.
            key = (ctx.project_id, ctx.requester_user_id, str(ctx.state_dir), run['canvas_id'])
            if batch is None:
                tasks = await self._material_snapshot(ctx, run)
            else:
                if key not in batch:
                    batch[key] = asyncio.create_task(self._material_snapshot(ctx, run))
                tasks = await batch[key]
            # Settlement may have published a verified plan to this same
            # canvas. Observe the new snapshot, not the pre-task read.
            canvas = await asyncio.to_thread(self.coordinator._assert_current, ctx, run, completed=True)
        if children:
            return await self._observe_branches(ctx,run,store,canvas,commission,children,tasks,check_scheduler,control)
        observed = received_plan or await asyncio.to_thread(production_event,store,canvas,commission,tasks,workflow_state_dir=ctx.state_dir, check_scheduler=check_scheduler, consumed_event_keys=run.get('commission_event_receipts', []))
        if not observed and commission['phase'] == 'drafting_plan':
            observed = await asyncio.to_thread(_native_plan_conflict_observation,
                ctx, run['canvas_id'], commission)
        if not observed and commission['phase'] == 'drafting_plan':
            observed = await asyncio.to_thread(_native_delivery_failure_observation,
                ctx, canvas, commission)
        if control and control['active']:
            advanced, failure = await self._advance_automation(ctx, run, observed)
            if advanced:
                await self._publish_cards(ctx, run)
                return True
            if failure is not None:
                observed = failure
                if observed['event_key'] in run.get('commission_event_receipts', []):
                    return False
        from novelvideo.chat.reference_remix_continuation import native_submission_blocks
        native_active = any((task.get('status') if isinstance(task, dict) else getattr(task, 'status', None))
                            in {'submitting', 'queued', 'running'}
                            for task in tasks.values())
        if (not observed and not run.get('pending_interaction')
                and run.get('status') != 'resuming' and not native_active
                and (commission['phase'] != run.get('commission_phase')
                     or run.get('pending_stage_observation'))
                and (commission['phase'] != 'drafting_plan' or not commission.get('direction_revision')
                     or not await asyncio.to_thread(
                    native_submission_blocks,
                    ctx, (getattr(self.coordinator, 'store', None).get(run['run_id'])
                          if getattr(self.coordinator, 'store', None) is not None else None) or run,
                    canvas, commission))
                and commission['phase'] in WAITING_PHASES):
            # Crash between artifact CAS and wake: recover the saved transition.
            # A confirmed direction can change the phase while its canvas plan
            # task is still running. That is not a missed completion callback.
            if commission['phase'] != 'drafting_plan' or not await asyncio.to_thread(
                _plan_generation_awaiting_canvas_result, canvas, commission, ctx.state_dir
            ):
                observed = _observation(None,{'commission':commission['commission_ref'],'phase':commission['phase']})
        if run.get('status') == 'resume_failed' and commission['phase'] == 'drafting_plan' and (
            not observed or ((observed.get('event') or {}).get('type') != 'plan_ready'
                             and not observed.get('native_failure'))
        ):
            # Recover this narrow old failure only after a real plan is saved.
            return False
        if not observed:
            return False
        await self._publish_cards(ctx, run)
        if observed['event_key'] in run.get('commission_event_receipts',[]):
            await self._acknowledge_settlements(ctx, run, store, observed)
            return False
        if observed['event'] and received_plan is None:
            # Recheck the source immediately before saving a stage transition.
            await asyncio.to_thread(self.coordinator._assert_current,ctx,run,completed=True)
            await asyncio.to_thread(self._advance_observed, ctx, run, store, commission, observed['event'], control)
        plan_delivery = commission['phase'] == 'drafting_plan' and (
            (observed.get('event') or {}).get('type') == 'plan_ready' or observed.get('native_failure')
        )
        plan_diagnostic = {'project_id': ctx.project_id, 'canvas_id': run['canvas_id']}
        if plan_delivery:
            latest = _latest_plan_generation(canvas, commission, ctx.state_dir)
            if latest and latest[1]:
                plan_diagnostic.update(workflow_run_id=latest[0]['run_id'],
                                       operation_id=latest[1][0].get('processing_operation_id') or '',
                                       node_id=latest[1][0].get('node_id') or '')
            log_production_plan_diagnostic('production_plan.notification_started', stage='notifying', **plan_diagnostic)
        try:
            if observed.get('notice') and callable(getattr(self.coordinator, '_notify', None)):
                await self.coordinator._notify(run,observed['notice'],observed['event_key'])
            await self.coordinator.continue_commission(ctx=ctx,run_id=run['run_id'],event_key=observed['event_key'],wake_event=observed)
        except Exception as exc:
            if plan_delivery:
                log_production_plan_diagnostic('production_plan.notification_failed', stage='notifying', error=exc, **plan_diagnostic)
            raise
        if plan_delivery:
            log_production_plan_diagnostic('production_plan.notification_finished', stage='notifying', **plan_diagnostic)
        await self._acknowledge_settlements(ctx, run, store, observed)
        return True

    async def _advance_automation(self, ctx, run, observed):
        """Run at most one native action; return (advanced, failure receipt).

        Transient locking keeps retrying silently. A deterministic failure with
        no stage event becomes a wake receipt, because the same action would
        otherwise be retried unchanged forever and no Agent would correct it.
        """
        from novelvideo.freezone.remix.production_automation import advance_enrolled_production
        try:
            runs = await asyncio.to_thread(self.coordinator.store.list_for_actor,
                ctx, run['canvas_id'], run.get('agent_id', 'main'))
            return bool(await advance_enrolled_production(ctx, run, runs=runs)), None
        except Exception as exc:
            if not observed and _transient_advancement_error(exc):
                _record_advancement_failure(run, exc)
                raise
            _record_advancement_failure(run, exc)
            return False, _advancement_failure_observation(run, exc, observed)

    def _advance_observed(self, ctx, run, store, commission, event, control):
        from novelvideo.freezone import canvas_store
        from novelvideo.freezone.remix.production_automation import assert_production_automation_current
        with canvas_store.get_canvas_write_mutex().write_mutex(ctx.state_dir, run['canvas_id']) as guard:
            if control is not None:
                assert_production_automation_current(ctx, canvas_id=run['canvas_id'],
                    commission_id=run['commission_ref']['artifact_id'], agent_id=run.get('agent_id', 'main'),
                    generation=control['generation'])
            canvas = self.coordinator._assert_current(ctx, run, completed=True)
            guard.reassert()
            from novelvideo.freezone.remix.production_advancement import _MutationStore
            from novelvideo.freezone.remix.reference_director import _MaterialPublicationGuard
            with store._locked() as artifact_guard:
                locked = _MutationStore(store, _MaterialPublicationGuard(artifact_guard, guard))
                if event.get('type') == 'plan_ready' and commission.get('plan_ref'):
                    from novelvideo.freezone.remix.plan_revision_settlement import reconcile_plan_revision
                    # Recheck commission scope and direction as well as the
                    # exact bound saved artifact under both leases.
                    current = read_reference_commission(locked, commission['commission_ref'], latest=True)
                    if any(current.get(key) != commission.get(key) for key in (
                        'project_id', 'canvas_id', 'requester_user_id', 'analysis_node_id',
                        'direction_fingerprint', 'direction_revision',
                    )):
                        raise ValueError('plan revision scope or direction changed during observation')
                    commission = current
                    if not any(_ref(plan) == event['plan_ref'] for plan in
                               _canvas_refs(locked, canvas, commission, ctx.state_dir)):
                        raise ValueError('saved plan is no longer on the current bound branch')
                    identity = _observation(event, {
                        'project_id': store.project_id, 'canvas_id': commission['canvas_id'],
                        'commission_id': commission['commission_ref']['artifact_id'],
                        'direction_fingerprint': commission.get('direction_fingerprint'),
                        'direction_revision': commission.get('direction_revision'),
                    })['event_key']
                    receipt_dir = store.root / '_plan_revision_observations'
                    if receipt_dir.is_symlink():
                        raise ValueError('invalid plan revision observation storage')
                    receipt_dir.mkdir(exist_ok=True)
                    receipt_path = receipt_dir / (identity.split(':', 1)[1] + '.json')
                    if receipt_path.exists():
                        receipt = locked._read_json(receipt_path)
                        try:
                            committed = locked.read(commission['commission_ref']['artifact_id'], receipt['revision'])
                        except FileNotFoundError:
                            committed = None
                        if committed is not None and committed['content_hash'] == receipt['content_hash']:
                            return current
                        # Another legitimate writer may occupy the pending
                        # revision after a pre-CAS crash. It is not reception
                        # evidence: reconcile from the revalidated current CAS
                        # and rewrite this pending receipt before that commit.
                    class RevisionReceiptStore(_MutationStore):
                        def revise(self, artifact_id, expected_revision, payload, upstream_refs):
                            from novelvideo.freezone.remix.contracts import validate_payload
                            payload = validate_payload('reference_commission.v1', payload)
                            self._atomic_json(receipt_path, {
                                'revision': expected_revision + 1,
                                'content_hash': 'sha256:' + hashlib.sha256(self._canonical(payload)).hexdigest(),
                            }, self._guard)
                            return super().revise(artifact_id, expected_revision, payload, upstream_refs)
                    receiving = RevisionReceiptStore(store, locked._guard)
                    return reconcile_plan_revision(receiving, commission_ref=commission['commission_ref'],
                                                   plan_ref=event['plan_ref'])['commission']
                return advance_reference_commission(locked, commission['commission_ref'], event, commission['commission_ref']['revision'])

    async def _acknowledge_settlements(self, ctx, run, store, observed):
        ids = observed.get('settlement_ids', [])
        if not ids:
            return
        # Lightweight coordinator implementations may have no durable store.
        # The production coordinator owns the consumed-event and actor checks.
        acknowledge = getattr(self.coordinator, 'acknowledge_material_settlements', None)
        if callable(acknowledge):
            await acknowledge(ctx=ctx, run_id=run['run_id'], event_key=observed['event_key'], settlement_ids=ids)

    def _branch_plan_consumption(self, store, run, parent, *, event_key=None, child_events=None):
        """Map an immutable aggregate receipt to its scoped child plan events.

        The map is saved before notification/continuation; only a durable run
        receipt for that aggregate makes its child event keys consumed.
        """
        scope = {'project_id': store.project_id, 'canvas_id': parent['canvas_id'],
                 'requester_user_id': parent['requester_user_id'],
                 'commission_id': parent['commission_ref']['artifact_id']}
        directory = store.root / '_plan_revision_observations'
        consumed = set()
        with store._locked() as guard:
            if directory.is_symlink():
                raise ValueError('invalid plan revision observation storage')
            if event_key is not None:
                directory.mkdir(exist_ok=True)
                path = directory / ('group-' + event_key.split(':', 1)[1] + '.json')
                registered = {row['commission_ref']['artifact_id'] for row in parent.get('plan_branches', [])}
                for row in child_events:
                    child = store._read(row['commission_id'], store._latest_revision(row['commission_id']))
                    data = child['payload']
                    plan = store._read(row['plan_ref']['artifact_id'], store._latest_revision(row['plan_ref']['artifact_id']))
                    if (row['commission_id'] not in registered
                            or child['schema'] != 'reference_commission.v1'
                            or any(data.get(name) != scope[name] for name in
                                   ('project_id', 'canvas_id', 'requester_user_id'))
                            or data.get('direction_revision') != row['direction_revision']
                            or data.get('direction_fingerprint') != row['direction_fingerprint']
                            or (data.get('plan_ref') or {}).get('artifact_id') != row['plan_ref']['artifact_id']
                            or _ref(plan) != row['plan_ref']
                            or plan['created_by'] != scope['requester_user_id']):
                        raise ValueError('aggregate child plan changed before mapping save')
                mapping = {**scope, 'event_key': event_key, 'child_plan_events': child_events}
                if path.exists():
                    existing = store._read_json(path)
                    if existing != mapping:
                        raise ValueError('aggregate plan observation mapping changed')
                else:
                    store._atomic_json(path, mapping, guard)
                return consumed
            for key in run.get('commission_event_receipts', []):
                if not str(key).startswith('production:'):
                    continue
                digest = key.split(':', 1)[1]
                if len(digest) != 64 or any(char not in '0123456789abcdef' for char in digest):
                    continue
                path = directory / ('group-' + digest + '.json')
                if not path.exists():
                    continue
                mapping = store._read_json(path)
                if mapping.get('event_key') != key or any(mapping.get(name) != value for name, value in scope.items()):
                    raise ValueError('aggregate plan observation mapping scope differs')
                registered = {row['commission_ref']['artifact_id'] for row in parent.get('plan_branches', [])}
                for row in mapping['child_plan_events']:
                    event = {'type': 'plan_ready', 'plan_ref': row['plan_ref']}
                    identity = _observation(event, {
                        'project_id': store.project_id, 'canvas_id': parent['canvas_id'],
                        'commission_id': row['commission_id'],
                        'direction_fingerprint': row['direction_fingerprint'],
                        'direction_revision': row['direction_revision'],
                    })['event_key']
                    if (row['commission_id'] not in registered
                            or row['plan_ref'].get('project_id') != store.project_id
                            or row['event_key'] != identity):
                        raise ValueError('aggregate child plan observation scope differs')
                    consumed.add(identity)
        return consumed

    async def _observe_branches(self, ctx, run, store, canvas, parent, children, tasks, check_scheduler=None, control=None):
        evidence = []
        notices = []
        latest_children = []
        settlement_ids = []
        advanced = False
        child_plan_events = []
        consumed_plan_events = await asyncio.to_thread(self._branch_plan_consumption, store, run, parent)
        for child in children:
            try:
                from novelvideo.project_context import ProjectContext
                from novelvideo.freezone.remix.production_automation import read_production_control
                child_run = {**run, 'commission_ref': child['commission_ref']}
                child_control = (await asyncio.to_thread(read_production_control, ctx, canvas_id=run['canvas_id'],
                    commission_id=child['commission_ref']['artifact_id'], agent_id=run.get('agent_id', 'main'))
                    if isinstance(ctx, ProjectContext) else None)
                if child_control and not child_control['active']:
                    latest_children.append(child)
                    evidence.append({'commission_ref':child['commission_ref'], 'stopped':True})
                    continue
                observed = await asyncio.to_thread(production_event,store,canvas,child,tasks,workflow_state_dir=ctx.state_dir, check_scheduler=check_scheduler, consumed_event_keys=consumed_plan_events)
                if child_control and child_control['active']:
                    child_advanced, child_failure = await self._advance_automation(ctx, child_run, observed)
                    if child_advanced:
                        advanced = True
                        observed = None  # The preceding observation is now superseded.
                    elif child_failure is not None:
                        observed = child_failure
                if observed and observed['event']:
                    await asyncio.to_thread(self.coordinator._assert_current,ctx,run,completed=True)
                    child = await asyncio.to_thread(self._advance_observed, ctx, child_run if child_control else run,
                        store, child, observed['event'], child_control or control)
                if observed:
                    if (observed.get('event') or {}).get('type') == 'plan_ready':
                        child_plan_events.append({
                            'event_key': observed['event_key'], 'commission_id': child['commission_ref']['artifact_id'],
                            'plan_ref': observed['event']['plan_ref'],
                            'direction_revision': child.get('direction_revision'),
                            'direction_fingerprint': child.get('direction_fingerprint'),
                        })
                    settlement_ids.extend(observed.get('settlement_ids', []))
                    if observed['event'] is None:
                        evidence.append(observed['event_key'])
                    if observed.get('notice'):
                        notices.append(observed['notice'])
            except (ValueError,FileNotFoundError) as exc:
                # One branch awaiting correction must not stall its siblings.
                evidence.append({'branch':child['commission_ref']['artifact_id'],'blocked':type(exc).__name__})
                failed_runs = _observation_failures.get()
                if failed_runs is not None:
                    failed_runs.add(id(run))
                log_reference_runtime_failure(component='reference_production_observer',
                    scope=run, stage=child.get('phase') or 'branch_observation', error=exc,
                    refs={'commission_ref': child.get('commission_ref'),
                          'bound_plan_ref': child.get('plan_ref')})
            child = await asyncio.to_thread(read_reference_commission,store,child['commission_ref'],latest=True)
            latest_children.append(child)
            # Candidate review can revise a material commission without ending
            # its stage. Only production_event's stage identity may wake it.
            child_identity = ({'artifact_id': child['commission_ref']['artifact_id']}
                              if child['phase'] == 'preparing_materials' else child['commission_ref'])
            evidence.append({'commission_ref':child_identity,'phase':child['phase']})
        if advanced:
            await self._publish_cards(ctx, run)
            return True
        ready_completion = all(child['phase'] == 'completed' and _completed_branch_current(store,canvas,child) for child in latest_children)
        if ready_completion and parent['phase'] != 'completed':
            event = {'type':'branches_completed','commission_refs':[child['commission_ref'] for child in latest_children]}
            await asyncio.to_thread(self.coordinator._assert_current,ctx,run,completed=True)
            parent = await asyncio.to_thread(self._advance_observed, ctx, run, store, parent, event, control)
        if parent['phase'] == 'completed':
            evidence.append({'parent':parent['commission_ref'],'phase':parent['phase']})
        observed = _observation(None,{'parent_id':parent['commission_ref']['artifact_id'],'branches':evidence})
        observed['settlement_ids'] = settlement_ids
        await self._publish_cards(ctx, run)
        if child_plan_events:
            await asyncio.to_thread(self._branch_plan_consumption, store, run, parent,
                                    event_key=observed['event_key'], child_events=child_plan_events)
        if observed['event_key'] in run.get('commission_event_receipts',[]):
            await self._acknowledge_settlements(ctx, run, store, observed)
            return False
        if notices:
            await self.coordinator._notify(run,'\n'.join(dict.fromkeys(notices)),observed['event_key'])
        await self.coordinator.continue_commission(ctx=ctx,run_id=run['run_id'],event_key=observed['event_key'],wake_event=observed)
        await self._acknowledge_settlements(ctx, run, store, observed)
        return True

    async def _material_snapshot(self, ctx, run):
        from novelvideo.task_state import get_task_manager
        from novelvideo.freezone.workflow_runs import reconcile_workflow_runs_with_tasks
        from novelvideo.freezone.history import read_canvas_generation_history
        manager = get_task_manager()
        tasks = {manager._task_key_for_state(task): task for task in await asyncio.to_thread(manager.list_tasks_for_project, ctx)}
        history = await asyncio.to_thread(read_canvas_generation_history, project_dir=ctx.output_dir, canvas_id=run['canvas_id'], limit=1000)
        await asyncio.to_thread(reconcile_workflow_runs_with_tasks, project_dir=ctx.state_dir, canvas_id=run['canvas_id'],
            tasks_by_key={key: {'task_id':getattr(task,'task_id',''), 'status':task.status, 'result':task.result, 'error':task.error} for key,task in tasks.items()},
            generation_history=history, artifact_project_dir=ctx.output_dir)
        from novelvideo.freezone.workflow_runs import list_workflow_runs
        from novelvideo.freezone.remix.production_processing_settlement import (
            has_settleable_native_action, settle_production_processing,
        )
        for workflow in await asyncio.to_thread(list_workflow_runs, project_dir=ctx.state_dir, canvas_id=run['canvas_id'], limit=100):
            if workflow.get('project_id') != ctx.project_id or workflow.get('actor_id') != ctx.requester_user_id:
                continue
            if has_settleable_native_action(workflow):
                await asyncio.to_thread(settle_production_processing, ctx, canvas_id=run['canvas_id'], run_id=workflow['run_id'])
        return tasks

    async def _diagnostic_context(self, run: dict) -> tuple[str, dict]:
        """Best effort artifact refs for a failed observation; never change state."""
        stage = run.get('commission_phase') or run.get('status') or 'observe'
        refs = {'commission_ref': run.get('commission_ref')}
        try:
            ctx = await self.coordinator._resolve_context(run)
            store = RemixArtifactStore(ctx.output_dir, ctx.project_id)
            commission = await asyncio.to_thread(
                read_reference_commission, store, run['commission_ref'], latest=True)
            stage = commission.get('phase') or stage
            refs['commission_ref'] = commission.get('commission_ref')
            bound = commission.get('plan_ref')
            if bound:
                refs['bound_plan_ref'] = bound
                try:
                    current = await asyncio.to_thread(store.read_latest, bound['artifact_id'])
                    refs['current_plan_ref'] = {
                        'artifact_id': current['id'], 'revision': current['revision'],
                        'project_id': current.get('project_id'),
                    }
                except Exception:
                    pass
        except Exception:
            pass
        return stage, refs

    async def scan_once(self):
        from novelvideo.chat.reference_remix_continuation import automatic_reference_continuation_enabled
        if not automatic_reference_continuation_enabled():
            return 0
        runs = await asyncio.to_thread(self.coordinator.store.waiting_for_production)
        batch = {}
        batch_token = _observation_batch.set(batch)
        failed_runs = set()
        failures_token = _observation_failures.set(failed_runs)
        gate = asyncio.Semaphore(8)  # Bounded IO only; model slots are durable.
        async def observe(run):
            async with gate:
                started = time.monotonic()
                error_code = ""
                try:
                    observed = bool(await asyncio.wait_for(self.observe_run(run), timeout=5))
                    if id(run) not in failed_runs:
                        log_reference_runtime_recovered(
                            component='reference_production_observer', scope=run,
                            stage=run.get('commission_phase') or run.get('status') or 'observe')
                    return observed
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    error_code = type(exc).__name__
                    try:
                        stage, refs = await asyncio.wait_for(
                            self._diagnostic_context(run), timeout=1)
                    except Exception:
                        stage = run.get('commission_phase') or run.get('status') or 'observe'
                        refs = {'commission_ref': run.get('commission_ref')}
                    log_reference_runtime_failure(
                        component='reference_production_observer', scope=run,
                        stage=stage, error=exc, refs=refs)
                    return False
                finally:
                    logger.debug("Reference observation run=%s turn=%s source=production revision=%s attempts=%s elapsed_ms=%.1f error_code=%s",
                        run['run_id'], run.get('resume_turn_id'), (run.get('commission_ref') or {}).get('revision'), run.get('resume_attempt', 0),
                        (time.monotonic()-started)*1000, error_code)
        try:
            return sum(await asyncio.gather(*(observe(run) for run in runs)))
        finally:
            _observation_batch.reset(batch_token)
            _observation_failures.reset(failures_token)
            for task in batch.values():
                if not task.done():
                    task.cancel()
            await asyncio.gather(*batch.values(), return_exceptions=True)

    def wake(self):
        """Hint only: the next scan still validates actual saved receipts."""
        self._wake.set()

    async def _loop(self):
        from novelvideo.chat.reference_remix_continuation import IdleCadence, StorageScanRecovery
        cadence = IdleCadence(POLL_SECONDS)
        recovery = StorageScanRecovery(component='reference_production_observer', stage='scan')
        while True:
            self._wake.clear()
            succeeded, changed = await recovery.scan(self.scan_once, self._wait_for_wake)
            if succeeded:
                await self._wait_for_wake(cadence.delay(bool(changed)))

    async def _wait_for_wake(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    async def resume(self):
        from novelvideo.chat.reference_remix_continuation import automatic_reference_continuation_enabled
        if not automatic_reference_continuation_enabled():
            return
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._loop())

    async def shutdown(self):
        if self._worker:
            self._worker.cancel()
            await asyncio.gather(self._worker,return_exceptions=True)
            self._worker = None


observer = ReferenceProductionObserver()


def wake_local_observers() -> None:
    """Post-persist hint; no model call, proof or cross-worker bus is introduced."""
    from novelvideo.chat.reference_remix_continuation import coordinator
    for task, event in ((observer._worker, observer._wake), (coordinator._scheduler, coordinator._schedule_wake)):
        if task is not None and not task.done():
            loop = task.get_loop()
            if not loop.is_closed():
                try:
                    loop.call_soon_threadsafe(event.set)
                except RuntimeError:
                    pass  # Loop shutdown raced this best-effort hint.
