import pytest
from pathlib import Path
from novelvideo.chat.hermes_sdk import HermesSdkThread

@pytest.mark.parametrize('result', [{}, None])
async def test_empty_load_result_creates_new_session(monkeypatch, result):
    thread=HermesSdkThread(cli_path=Path('/unused'),cwd=Path('/tmp'),env={},model=None,username='local',session_id='missing')
    methods=[]
    async def send(method,params):
        methods.append(method)
        return len(methods)
    async def read(req_id,timeout):
        return ({'id':req_id,'result':result if req_id==1 else {'sessionId':'fresh'}}, [])
    monkeypatch.setattr(thread,'_send',send)
    monkeypatch.setattr(thread,'_read_until_id',read)
    await thread._ensure_session()
    assert methods==['session/load','session/new']
    assert thread.id=='fresh'

async def test_valid_load_keeps_existing_session(monkeypatch):
    thread=HermesSdkThread(cli_path=Path('/unused'),cwd=Path('/tmp'),env={},model=None,username='local',session_id='existing')
    methods=[]
    async def send(method,params):
        methods.append(method)
        return 1
    async def read(req_id,timeout):
        return ({'id':req_id,'result':{'modes':{'currentModeId':'default','availableModes':[]}}}, [])
    monkeypatch.setattr(thread,'_send',send)
    monkeypatch.setattr(thread,'_read_until_id',read)
    await thread._ensure_session()
    assert methods==['session/load']
    assert thread.id=='existing'
