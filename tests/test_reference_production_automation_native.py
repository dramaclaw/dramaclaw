"""Automation control is applied by real native services, not task payloads."""
from dataclasses import replace
from types import SimpleNamespace
import pytest
from test_production_advancement import production as production, current, passed
from test_reference_remix_continuation import context
from novelvideo.freezone.remix import production_automation as control
from novelvideo.freezone.remix.operations import RemixOperationStore


@pytest.mark.asyncio
async def test_actual_native_advance_rejects_old_generation_before_material_acceptance(production):
    from novelvideo.freezone.remix.production_advancement import advance_production
    ctx,store,commission,work,_=production
    passed(production)
    state=current(production)
    control.enroll_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'],command_id='first')
    control.enroll_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'],command_id='second')
    with pytest.raises(ValueError,match='generation'):
        await advance_production(ctx,canvas_id='c',commission_ref=state['commission_ref'],expected_projection_revision=state['projection_revision'],
            command_id='old-worker',automation_generation=1)
    assert store.read_latest(work['artifact_id'])['revision']==1


def adoption_fixture(tmp_path,monkeypatch, *, mismatch=False):
    from test_source_speech_adoption import setup
    from novelvideo.freezone.remix.source_speech_adoption import prepare_source_observation_adoption
    from novelvideo.freezone.remix.reference_commission import create_reference_commission
    from novelvideo.freezone import canvas_store
    store,pref,wref,obs,calls=setup(tmp_path,mismatch=mismatch)
    ctx=replace(context(tmp_path,actor='alice'),output_dir=tmp_path,state_dir=tmp_path/'state')
    canvas={'canvas_id':'canvas','project_id':'project','access_model':'shared','nodes':[{'id':'plan','type':'scriptNode',
        'data':{'productionPlanV2Ref':{'artifactId':pref['artifact_id'],'revision':1}}}], 'edges':[]}
    monkeypatch.setattr(canvas_store,'read_canvas',lambda *a:canvas)
    monkeypatch.setattr('novelvideo.freezone.remix.material_execution.canvas_material_resource',
        lambda *a:store.read(pref['artifact_id'],1)['payload']['resources'][0])
    commission=create_reference_commission(store,canvas_id='canvas',requester_user_id='alice',analysis_node_id='analysis',goal='g',
        analysis_evidence={'task_id':'native','result_fingerprint':'hash'})
    enrollment=control.enroll_production_automation(ctx,canvas_id='canvas',commission_ref=commission['commission_ref'],command_id='human')
    prepared=({'task_payload':dict(canvas_id='canvas',plan_ref=pref,take_id='take',observation_ref=obs,work_ref=wref,
        scope=store.read(obs['artifact_id'],1)['payload']['authorization_scope'])} if mismatch else
        prepare_source_observation_adoption(store,ctx,canvas,canvas_id='canvas',plan_ref=pref,take_id='take',observation_ref=obs,work_ref=wref))
    return ctx,store,canvas,commission,enrollment,prepared,calls


@pytest.mark.asyncio
async def test_real_source_enqueue_binds_control_before_task_backend_admission(tmp_path,monkeypatch):
    from novelvideo.freezone.remix.production_advancement import enqueue_source_observation_adoption
    ctx,store,canvas,commission,enrollment,prepared,calls=adoption_fixture(tmp_path,monkeypatch)
    admitted=[]
    class Backend:
        async def enqueue_project_task(self,actual,**kwargs):
            assert actual is ctx
            operation_id=kwargs['payload']['operation_id']
            assert control.assert_operation_automation_current(ctx,operation_id)['generation']==1
            operation=RemixOperationStore(ctx.output_dir,ctx.project_id).get(operation_id)
            assert operation['normalized_parameters']==prepared['normalized_parameters']
            admitted.append(kwargs)
            return SimpleNamespace(task_state=SimpleNamespace(task_id='native-task'))
    monkeypatch.setattr('novelvideo.ports.get_task_backend',lambda:Backend())
    result=await enqueue_source_observation_adoption(ctx,store,prepared,command_id='adopt',node_revision=1,automation_control=enrollment)
    assert result['task_id']=='native-task' and len(admitted)==1
    assert admitted[0]['queue_kind']=='default'
    assert len(calls)==1


def test_real_c3_worker_cannot_save_plan_after_stop(tmp_path,monkeypatch):
    from novelvideo.task_backend.runners.remix import run_remix_adopt_source_speech
    ctx,store,canvas,commission,enrollment,prepared,calls=adoption_fixture(tmp_path,monkeypatch)
    operations=RemixOperationStore(ctx.output_dir,ctx.project_id)
    operation=operations.start(idempotency_key='adopt',input_refs=prepared['input_refs'],producer_version=prepared['producer_version'],
        normalized_parameters=prepared['normalized_parameters'],node_revision=1,canvas_id='canvas',node_id='plan')
    control.bind_automation_operation(ctx,canvas_id='canvas',commission_id=commission['commission_ref']['artifact_id'],generation=1,operation_id=operation['operation_id'])
    fence=operations.claim_submission(operation['operation_id'],owner='submitter')
    operations.bind_task(operation['operation_id'],task_id='actual-task',owner='submitter',fencing_token=fence)
    control.stop_production_automation(ctx,canvas_id='canvas',commission_ref=commission['commission_ref'])
    with pytest.raises(ValueError,match='stopped'):
        run_remix_adopt_source_speech({'__run_task_id':'actual-task','payload':{**prepared['task_payload'],'operation_id':operation['operation_id']}},ctx)
    assert store.read_latest(prepared['task_payload']['plan_ref']['artifact_id'])['revision']==1
    assert operations.get(operation['operation_id'])['status']=='pending'
    assert len(calls)==1


@pytest.mark.asyncio
async def test_human_native_advance_enrolls_but_agent_cannot_resume_stop(production,monkeypatch):
    from novelvideo.api.routes import reference_director as route
    from fastapi import HTTPException
    ctx,store,commission,work,canvas=production
    passed(production)
    async def scope(*a,**kw):return ctx,canvas,store
    async def emit(*a,**kw):pass
    monkeypatch.setattr(route,'_context',scope)
    monkeypatch.setattr(route,'_emit_director_update',emit)
    state=current(production)
    body=route.AdvanceProductionRequest(commission_ref=state['commission_ref'],expected_projection_revision=state['projection_revision'],command_id='human')
    await route.advance_current_production('p','c',body,{'credential_kind':'browser_session'})
    enrolled=control.read_production_control(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id'])
    assert enrolled and enrolled['active']
    control.stop_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'])
    state=current(production)
    body=route.AdvanceProductionRequest(commission_ref=state['commission_ref'],expected_projection_revision=state['projection_revision'],command_id='model-resume')
    with pytest.raises(HTTPException):
        await route.advance_current_production('p','c',body,{'credential_kind':'agent_session'})
    assert not control.read_production_control(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id'])['active']


@pytest.mark.asyncio
async def test_stale_native_human_request_cannot_enroll(production,monkeypatch):
    from novelvideo.api.routes import reference_director as route
    from fastapi import HTTPException
    ctx,store,commission,work,canvas=production
    async def scope(*a,**kw):return ctx,canvas,store
    monkeypatch.setattr(route,'_context',scope)
    body=route.AdvanceProductionRequest(commission_ref=commission['commission_ref'],expected_projection_revision='0'*64,command_id='stale')
    with pytest.raises(HTTPException) as error:
        await route.advance_current_production('p','c',body,{'credential_kind':'browser_session'})
    assert error.value.status_code==409
    assert control.read_production_control(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id']) is None


@pytest.mark.asyncio
async def test_whole_production_enrollment_uses_persisted_host_flag_not_run_claim(tmp_path):
    from test_reference_remix_continuation import write_canvas
    from novelvideo.chat.reference_remix_continuation import ReferenceRemixStore, ReferenceRemixCoordinator
    from novelvideo.freezone.remix.reference_commission import create_reference_commission
    from novelvideo.freezone.remix.store import RemixArtifactStore
    ctx=context(tmp_path)
    write_canvas(ctx)
    store=ReferenceRemixStore(tmp_path/'runs.db')
    coordinator=ReferenceRemixCoordinator(store)
    artifacts=RemixArtifactStore(ctx.output_dir,ctx.project_id,created_by=ctx.requester_user_id)
    commission=create_reference_commission(artifacts,canvas_id='canvas',requester_user_id='actor',analysis_node_id='analysis',goal='g',analysis_evidence={'task_id':'t','result_fingerprint':'h'})
    for identity,authorized in [('legacy',False),('new',True)]:
        record=dict(run_id=identity,project_id=ctx.project_id,requester_user_id=ctx.requester_user_id,canvas_id='canvas',agent_id='main',
            idempotency_key=identity,request_fingerprint=identity,status='analysis_ready',commission_ref=commission['commission_ref'],automation_authorized=authorized)
        store.create(record)
        if not authorized:
            assert await coordinator._enroll_authorized_production(ctx,{**record,'automation_authorized':True}) is None
            assert control.read_production_control(ctx,canvas_id='canvas',commission_id=commission['commission_ref']['artifact_id']) is None
        else:
            assert (await coordinator._enroll_authorized_production(ctx,record))['active']
            control.stop_production_automation(ctx,canvas_id='canvas',commission_ref=commission['commission_ref'])
            assert not (await coordinator._enroll_authorized_production(ctx,record))['active']


def test_automatic_adoption_uses_current_confirmed_c2_correction_without_changing_raw(tmp_path,monkeypatch):
    from novelvideo.freezone.remix import source_speech
    from novelvideo.freezone.remix.candidate_speech_correction import read_candidate_speech_review, save_candidate_speech_correction
    ctx,store,canvas,commission,enrollment,prepared,calls=adoption_fixture(tmp_path,monkeypatch,mismatch=True)
    packet=prepared['task_payload']
    raw=store.read(packet['observation_ref']['artifact_id'],1)['payload']
    media=store.read(packet['plan_ref']['artifact_id'],1)['payload']['resources'][0]
    class Engine:
        def transcribe(self,*a):return {'status':'completed','transcript':raw['transcript'],'words':[
            {'text':w['text'],'start':w['start_us']/1_000_000,'end':w['end_us']/1_000_000} for w in raw['recognized_words']]}
    observation=source_speech.observe_source_speech(store,scope=packet['scope'],resource=media,language='auto',provider_signature='test',aligner=Engine())
    monkeypatch.setattr(source_speech,'configured_provider_signature',lambda:'test')
    args=dict(canvas_id='canvas',work_ref=packet['work_ref'],step_id='voice',node_id='voice-node',observation_ref=observation)
    review=read_candidate_speech_review(store,ctx,canvas,**args)
    saved=save_candidate_speech_correction(store,ctx,canvas,**args,target_signature=review['summary']['target_signature'],
        corrections=[{'word_id':review['summary']['recognized_words'][0]['id'],'text':'one','reason':'confirmed audio'}],
        confirmed=True,command_id='correct',actor_kind='user')
    result=control._prepare_next_adoption(ctx,{'canvas_id':'canvas'},{'phase':'aligning_speech','plan_ref':packet['plan_ref'],'work_ref':packet['work_ref']})
    assert result and result['task_payload']['correction_ref']==saved['correction_ref']
    assert result['task_payload']['observation_ref']==observation
    assert store.read(observation['artifact_id'],1)['payload']['recognized_words'][0]['text']=='won'


def test_registered_branches_inherit_explicit_parent_enrollment_and_stop_together(tmp_path,monkeypatch):
    from test_reference_branches import setup
    from novelvideo.freezone.remix.reference_branches import prepare_reference_branches
    from novelvideo.freezone import canvas_store
    store,parent,refs=setup(tmp_path)
    result=prepare_reference_branches(store,parent['commission_ref'],refs,'branches')
    parent=result['commission']
    ctx=replace(context(tmp_path,actor='u',project='p'),output_dir=tmp_path,state_dir=tmp_path/'state')
    monkeypatch.setattr(canvas_store,'read_canvas',lambda *a:{'project_id':'p','canvas_id':'c','access_model':'shared','nodes':[]})
    assert control.enroll_registered_branch_controls(ctx,canvas_id='c',parent_ref=parent['commission_ref'])==[]
    control.enroll_production_automation(ctx,canvas_id='c',commission_ref=parent['commission_ref'],command_id='human')
    children=control.enroll_registered_branch_controls(ctx,canvas_id='c',parent_ref=parent['commission_ref'])
    assert len(children)==2 and all(c['active'] for c in children)
    control.stop_production_automation(ctx,canvas_id='c',commission_ref=parent['commission_ref'])
    for branch in result['branches']:
        assert not control.read_production_control(ctx,canvas_id='c',commission_id=branch['commission_ref']['artifact_id'])['active']
    assert control.enroll_registered_branch_controls(ctx,canvas_id='c',parent_ref=parent['commission_ref'])==[]


def test_stopped_c3_retry_registers_already_saved_output_as_history_without_authoring(tmp_path,monkeypatch):
    from novelvideo.task_backend.runners.remix import run_remix_adopt_source_speech
    ctx,store,canvas,commission,enrollment,prepared,calls=adoption_fixture(tmp_path,monkeypatch)
    operations=RemixOperationStore(ctx.output_dir,ctx.project_id)
    operation=operations.start(idempotency_key='adopt',input_refs=prepared['input_refs'],producer_version=prepared['producer_version'],
        normalized_parameters=prepared['normalized_parameters'],node_revision=1,canvas_id='canvas',node_id='plan')
    control.bind_automation_operation(ctx,canvas_id='canvas',commission_id=commission['commission_ref']['artifact_id'],generation=1,operation_id=operation['operation_id'])
    fence=operations.claim_submission(operation['operation_id'],owner='submitter')
    operations.bind_task(operation['operation_id'],task_id='actual-task',owner='submitter',fencing_token=fence)
    envelope={'__run_task_id':'actual-task','payload':{**prepared['task_payload'],'operation_id':operation['operation_id']}}
    publish=RemixOperationStore.publish_result_unverified
    monkeypatch.setattr(RemixOperationStore,'publish_result_unverified',lambda *a,**kw:(_ for _ in ()).throw(OSError('lost notification')))
    with pytest.raises(OSError):run_remix_adopt_source_speech(envelope,ctx)
    plan_id=prepared['task_payload']['plan_ref']['artifact_id']
    assert store.read_latest(plan_id)['revision']==2
    control.stop_production_automation(ctx,canvas_id='canvas',commission_ref=commission['commission_ref'])
    monkeypatch.setattr(RemixOperationStore,'publish_result_unverified',publish)
    result=run_remix_adopt_source_speech(envelope,ctx)
    assert result['plan_ref']['revision']==2
    assert store.read_latest(plan_id)['revision']==2
    assert operations.get(operation['operation_id'])['status']=='needs_confirmation'
    assert canvas['nodes'][0]['data']['productionPlanV2Ref']['revision']==1
    assert not control.read_production_control(ctx,canvas_id='canvas',commission_id=commission['commission_ref']['artifact_id'])['active']
    assert len(calls)==1
    import asyncio
    from novelvideo.freezone.remix.production_advancement import settle_source_adoption
    with pytest.raises(ValueError, match='stopped'):
        asyncio.run(settle_source_adoption(ctx, canvas_id='canvas', commission_ref=commission['commission_ref'],
            operation_id=operation['operation_id'], automation_generation=1))
    assert canvas['nodes'][0]['data']['productionPlanV2Ref']['revision']==1


@pytest.mark.asyncio
async def test_expired_observer_claim_cannot_commit_real_native_action(production,monkeypatch):
    from novelvideo.freezone.remix.production_advancement import advance_production
    ctx,store,commission,work,_=production
    passed(production)
    state=current(production)
    control.enroll_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'],command_id='human')
    clock=[1000.0]
    monkeypatch.setattr(control.time,'time',lambda:clock[0])
    claim=control.claim_automation_event(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id'],generation=1,event_key='real',owner='old')
    clock[0]+=control.LEASE_SECONDS+1
    assert control.claim_automation_event(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id'],generation=1,event_key='real',owner='new')
    with pytest.raises(ValueError,match='lease'):
        await advance_production(ctx,canvas_id='c',commission_ref=state['commission_ref'],expected_projection_revision=state['projection_revision'],
            command_id='old',automation_generation=1,automation_event=claim)
    assert store.read_latest(work['artifact_id'])['revision']==1


@pytest.mark.asyncio
async def test_native_acceptance_prepares_lineage_outside_canvas_and_artifact_locks(production,monkeypatch):
    import threading
    from contextlib import contextmanager
    from novelvideo.freezone.remix import material_work
    from novelvideo.freezone.remix.store import RemixArtifactStore
    from novelvideo.freezone import canvas_store
    from novelvideo.freezone.remix.production_advancement import advance_production
    ctx,store,commission,work,_=production
    passed(production)
    state=current(production)
    local=threading.local()
    artifact_lock=RemixArtifactStore._locked
    canvas_mutex=canvas_store.get_canvas_write_mutex()
    @contextmanager
    def artifact(self):
        with artifact_lock(self) as guard:
            local.artifacts=getattr(local,'artifacts',0)+1
            try:yield guard
            finally:local.artifacts-=1
    class Mutex:
        @contextmanager
        def write_mutex(self,*a,**kw):
            with canvas_mutex.write_mutex(*a,**kw) as guard:
                local.canvas=getattr(local,'canvas',0)+1
                try:yield guard
                finally:local.canvas-=1
    prepared=[]
    prepare=material_work.prepare_material_acceptance
    def preparation(*a,**kw):
        assert not getattr(local,'canvas',0), 'native acceptance prepared under canvas lock'
        assert not getattr(local,'artifacts',0), 'native acceptance prepared under artifact lock'
        result=prepare(*a,**kw)
        prepared.append(result)
        return result
    monkeypatch.setattr(RemixArtifactStore,'_locked',artifact)
    monkeypatch.setattr(canvas_store,'get_canvas_write_mutex',lambda:Mutex())
    monkeypatch.setattr(material_work,'prepare_material_acceptance',preparation)
    result=await advance_production(ctx,canvas_id='c',commission_ref=state['commission_ref'],expected_projection_revision=state['projection_revision'],command_id='accept')
    assert len(prepared)==1 and result['advancement']['action']['kind']=='accept_materials'


@pytest.mark.asyncio
async def test_explicit_native_resume_accepts_current_material_without_reanalysis(production,monkeypatch,tmp_path):
    from novelvideo.chat import reference_remix_continuation as continuation
    from novelvideo.freezone.remix.production_advancement import advance_production
    ctx,store,commission,work,_=production
    passed(production)
    db=continuation.ReferenceRemixStore(tmp_path/'resume.db')
    coordinator=continuation.ReferenceRemixCoordinator(db)
    monkeypatch.setattr(continuation,'coordinator',coordinator)
    db.create(dict(run_id='origin',project_id='p',requester_user_id='u',canvas_id='c',agent_id='main',idempotency_key='start',
        request_fingerprint='original',commission_ref=commission['commission_ref'],commission_phase=commission['phase'],status='stopped',task_id='original-analysis'))
    control.stop_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'])
    from test_reference_production_recovery import add_newer_history, app_for
    from httpx import ASGITransport, AsyncClient
    add_newer_history(coordinator,ctx,db.get('origin'))
    app,_=app_for(ctx,coordinator,monkeypatch)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        base='/api/v1/projects/p/freezone/canvases/c/director'
        response=await client.get(base+'/production-state',params={'commission_id':commission['commission_ref']['artifact_id']})
        assert response.status_code==200,response.text
        state=response.json()['data']
        assert state['execution_status']=='stopped'
        response=await client.post(base+'/advance-production',json={'commission_ref':state['commission_ref'],
            'expected_projection_revision':state['projection_revision'],'command_id':'resume','agent_id':'main'})
        assert response.status_code==200,response.text
        result=response.json()['data']
        fresh=await client.get(base+'/production-state',params={'commission_id':commission['commission_ref']['artifact_id']})
        assert fresh.status_code==200,fresh.text
        assert fresh.json()['data']['execution_status']!='stopped'
    assert result['advancement']['action']['kind']=='accept_materials'
    assert db.get('origin')['task_id']=='original-analysis'
    assert db.get('origin')['status']==commission['phase']
    assert control.read_production_control(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id'])['active']


@pytest.mark.asyncio
async def test_explicit_resume_reuses_saved_native_source_result_current_inputs(production,monkeypatch):
    from test_production_advancement import completed_native_source_adoption
    from novelvideo.freezone.remix.production_advancement import settle_source_adoption
    from novelvideo.freezone import canvas_store
    def owned(ctx,store,commission,plan_ref,operation):
        enrolled=control.enroll_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'],command_id='first')
        control.bind_automation_operation(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id'],generation=enrolled['generation'],operation_id=operation['operation_id'])
    ctx,store,commission,plan_ref,operation,result,_=await completed_native_source_adoption(production,monkeypatch,before_worker=owned)
    before=canvas_store.read_canvas(ctx.state_dir,'c')
    control.stop_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'])
    resumed=control.enroll_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'],command_id='resume')
    assert resumed['generation']==2
    assert await control.advance_enrolled_production(ctx,{'run_id':'owned-run','canvas_id':'c','agent_id':'main','commission_ref':commission['commission_ref']},runs=[])
    settled=current(production)
    assert settled['plan_ref']['revision']==result['plan_ref']['revision']==plan_ref['revision']+1
    assert store.read_latest(plan_ref['artifact_id'])['revision']==result['plan_ref']['revision']
    assert canvas_store.read_canvas(ctx.state_dir,'c')['revision']==before['revision']+1


def test_pending_candidate_check_does_not_hold_independent_source(tmp_path,monkeypatch):
    import hashlib,json
    from test_reference_remix_continuation import write_canvas
    from novelvideo.freezone.remix.store import RemixArtifactStore
    from novelvideo.freezone.remix.reference_commission import create_reference_commission
    from novelvideo.freezone.remix import source_speech
    from novelvideo.freezone import canvas_store
    ctx=context(tmp_path)
    write_canvas(ctx)
    artifacts=RemixArtifactStore(ctx.output_dir,ctx.project_id,created_by=ctx.requester_user_id)
    commission=create_reference_commission(artifacts,canvas_id='canvas',requester_user_id='actor',analysis_node_id='analysis',goal='g',analysis_evidence={'task_id':'t','result_fingerprint':'h'})
    control.enroll_production_automation(ctx,canvas_id='canvas',commission_ref=commission['commission_ref'],command_id='human')
    canvas=canvas_store.read_canvas(ctx.state_dir,'canvas')
    scope=source_speech.candidate_scope(ctx,canvas,'canvas')
    packets={}
    for identity in ['first','second']:
        media=ctx.output_dir/(identity+'.wav');media.write_bytes(identity.encode())
        resource=dict(media_path=media.name,media_hash=hashlib.sha256(media.read_bytes()).hexdigest(),duration_us=1000,node_id=identity,media_kind='audio')
        payload=dict(scope=scope,resource=resource,language='auto',provider_signature='test',step_id=identity,work_ref={'artifact_id':'work','revision':1})
        packets[identity]={'task_payload':payload,'normalized_parameters':{'action':'analyze_material_speech','payload':payload}}
    work={'id':'work','revision':1,'payload':{'steps':[dict(id=x,node_id=x,media_kind='audio',status='candidate') for x in packets],
        'requirements':[{'final_step_id':x,'turn_ids':[x+'-turn']} for x in packets]}}
    monkeypatch.setattr(RemixArtifactStore,'read_latest',lambda *a:work)
    monkeypatch.setattr(source_speech,'prepare_material_speech',lambda *a,**kw:packets[kw['step_id']])
    event=hashlib.sha256(json.dumps([1,None,['candidate-check',packets['first']['normalized_parameters']]],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    claim=control.claim_automation_event(ctx,canvas_id='canvas',commission_id=commission['commission_ref']['artifact_id'],generation=1,event_key=event,owner='worker')
    assert control.finish_automation_event(ctx,claim,owner='worker')
    result=control._prepare_next_candidate_check(ctx,{'canvas_id':'canvas','agent_id':'main','commission_ref':commission['commission_ref']},
        {'phase':'preparing_materials','plan_ref':{'artifact_id':'plan','revision':1},'work_ref':{'artifact_id':'work','revision':1},'blockers':[]})
    assert result is packets['second']


def test_unresolved_provider_claim_is_not_dispatched_again(tmp_path,monkeypatch):
    import hashlib
    from test_reference_remix_continuation import write_canvas
    from novelvideo.freezone.remix.store import RemixArtifactStore
    from novelvideo.freezone.remix.reference_commission import create_reference_commission
    from novelvideo.freezone.remix import source_speech
    from novelvideo.freezone import canvas_store
    ctx=context(tmp_path)
    write_canvas(ctx)
    artifacts=RemixArtifactStore(ctx.output_dir,ctx.project_id,created_by=ctx.requester_user_id)
    commission=create_reference_commission(artifacts,canvas_id='canvas',requester_user_id='actor',analysis_node_id='analysis',goal='g',analysis_evidence={'task_id':'t','result_fingerprint':'h'})
    control.enroll_production_automation(ctx,canvas_id='canvas',commission_ref=commission['commission_ref'],command_id='human')
    canvas=canvas_store.read_canvas(ctx.state_dir,'canvas')
    scope=source_speech.candidate_scope(ctx,canvas,'canvas')
    packets={}
    for identity in ['stuck','fresh']:
        media=ctx.output_dir/(identity+'.wav');media.write_bytes(identity.encode())
        resource=dict(media_path=media.name,media_hash=hashlib.sha256(media.read_bytes()).hexdigest(),duration_us=1000,has_audio=True,node_id=identity,media_kind='audio')
        payload=dict(scope=scope,resource=resource,language='auto',provider_signature='test',step_id=identity,work_ref={'artifact_id':'work','revision':1})
        packets[identity]={'task_payload':payload,'normalized_parameters':{'action':'analyze_material_speech','payload':payload}}
    stuck=packets['stuck']['task_payload']
    key=source_speech.source_speech_key(scope=stuck['scope'],media_hash=stuck['resource']['media_hash'],
        stream_index=0,language=stuck['language'],provider_signature=stuck['provider_signature'])
    speech_store=RemixArtifactStore(ctx.output_dir,ctx.project_id)
    with pytest.raises(TimeoutError):
        source_speech.observe_source_speech(speech_store,scope=stuck['scope'],resource=stuck['resource'],
            language=stuck['language'],provider_signature=stuck['provider_signature'],
            aligner=type('Engine',(),{'transcribe':lambda *_: (_ for _ in ()).throw(TimeoutError('unknown'))})())
    assert source_speech.unresolved_source_speech_claim(speech_store,key)=='unknown'
    work={'id':'work','revision':1,'payload':{'steps':[dict(id=x,node_id=x,media_kind='audio',status='candidate') for x in packets],
        'requirements':[{'final_step_id':x,'turn_ids':[x+'-turn']} for x in packets]}}
    monkeypatch.setattr(RemixArtifactStore,'read_latest',lambda *a:work)
    monkeypatch.setattr(source_speech,'prepare_material_speech',lambda *a,**kw:packets[kw['step_id']])
    result=control._prepare_next_candidate_check(ctx,{'canvas_id':'canvas','agent_id':'main','commission_ref':commission['commission_ref']},
        {'phase':'preparing_materials','plan_ref':{'artifact_id':'plan','revision':1},'work_ref':{'artifact_id':'work','revision':1},'blockers':[]})
    assert result is packets['fresh']


def test_background_music_without_declared_dialogue_never_prepares_asr(tmp_path,monkeypatch):
    from test_reference_remix_continuation import write_canvas
    from novelvideo.freezone.remix.store import RemixArtifactStore
    from novelvideo.freezone.remix import source_speech
    ctx=context(tmp_path)
    write_canvas(ctx)
    work={'id':'bgm','revision':1,'payload':{'steps':[{'id':'music','node_id':'music','media_kind':'audio','status':'candidate'}],
        'requirements':[{'final_step_id':'music','placement_ids':['background-music']} ]}}
    monkeypatch.setattr(RemixArtifactStore,'read_latest',lambda *a:work)
    calls=[]
    def prepare(*a,**kw):
        calls.append(True)
        raise AssertionError('background music was treated as dialogue')
    monkeypatch.setattr(source_speech,'prepare_material_speech',prepare)
    state={'phase':'preparing_materials','plan_ref':{'artifact_id':'plan','revision':1},'work_ref':{'artifact_id':'bgm','revision':1},'blockers':[]}
    assert control._prepare_next_candidate_check(ctx,{'canvas_id':'canvas'},state) is None
    assert calls==[]


@pytest.mark.asyncio
async def test_completed_operation_recovers_commission_publication_crash_on_next_real_tick(production,monkeypatch):
    from test_production_advancement import completed_native_source_adoption
    def owned(ctx,store,commission,plan_ref,operation):
        control.enroll_production_automation(ctx,canvas_id='c',commission_ref=commission['commission_ref'],command_id='first')
        control.bind_automation_operation(ctx,canvas_id='c',commission_id=commission['commission_ref']['artifact_id'],generation=1,operation_id=operation['operation_id'])
    ctx,store,commission,plan_ref,operation,result,_=await completed_native_source_adoption(production,monkeypatch,before_worker=owned)
    confirm=RemixOperationStore.confirm
    failed=[]
    def crash(self,*a,**kw):
        answer=confirm(self,*a,**kw)
        if not failed:failed.append(True);raise RuntimeError('after actual confirmation')
        return answer
    monkeypatch.setattr(RemixOperationStore,'confirm',crash)
    run={'run_id':'r','canvas_id':'c','agent_id':'main','commission_ref':commission['commission_ref']}
    with pytest.raises(RuntimeError,match='actual confirmation'):
        await control.advance_enrolled_production(ctx,run,runs=[])
    assert RemixOperationStore(ctx.output_dir,ctx.project_id).get(operation['operation_id'])['status']=='completed'
    assert await control.advance_enrolled_production(ctx,run,runs=[])
    assert current(production)['plan_ref']['revision']==result['plan_ref']['revision']


@pytest.mark.asyncio
async def test_asr_actual_backend_admission_fences_expiry_after_operation_reservation(tmp_path,monkeypatch):
    from novelvideo.freezone.remix import source_speech
    ctx,store,canvas,commission,enrollment,prepared,_=adoption_fixture(tmp_path,monkeypatch)
    packet=prepared['task_payload']
    monkeypatch.setattr(source_speech,'configured_provider_signature',lambda:'test')
    check=source_speech.prepare_material_speech(store,ctx,canvas,canvas_id='canvas',work_ref=packet['work_ref'],step_id='voice',node_id='voice-node',language='auto')
    state={'phase':'preparing_materials','execution_status':'waiting_user','commission_ref':commission['commission_ref'],
        'projection_revision':'x','plan_ref':packet['plan_ref'],'work_ref':packet['work_ref'],'blockers':[],'ready_system_actions':[]}
    monkeypatch.setattr(control,'_read_automation_state',lambda *a:state)
    monkeypatch.setattr(control,'_prepare_next_candidate_check',lambda *a:check)
    clock=[1000.0]
    monkeypatch.setattr(control.time,'time',lambda:clock[0])
    start=RemixOperationStore.start
    def delayed(self,**kw):
        result=start(self,**kw)
        clock[0]+=31
        return result
    monkeypatch.setattr(RemixOperationStore,'start',delayed)
    admitted=[]
    class Backend:
        async def enqueue_project_task(self,*a,**kw):
            admitted.append(kw)
            return SimpleNamespace(task_state=SimpleNamespace(task_id='invalid-expired-admission'))
    monkeypatch.setattr('novelvideo.ports.get_task_backend',lambda:Backend())
    with pytest.raises(ValueError,match='lease'):
        await control.advance_enrolled_production(ctx,{'run_id':'r','canvas_id':'canvas','agent_id':'main','commission_ref':commission['commission_ref']},runs=[])
    assert admitted==[]
def test_missing_analysis_binding_requests_current_state_not_reanalysis():
    from novelvideo.freezone.agent_workflows.reference_production import compile_reference_production_plan

    result = compile_reference_production_plan(
        {'external_inputs': []}, {'id': 'reference-video-remix', 'version': '2'},
        {'plan_count': 1}, 'synthetic production goal')
    assert result['status'] == 'reference_analysis_binding_required'
    assert result['next_action'] == 'read_current_production_state'
