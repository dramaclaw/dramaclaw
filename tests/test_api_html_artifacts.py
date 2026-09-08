from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

BASE = '/api/v1/projects/demo/freezone/html-artifacts'


@pytest.fixture
def client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import html_artifacts as routes
    role = {'value': 'editor', 'home': True}

    async def resolve(*, user, project_id, required_role):
        if project_id != 'demo' or (required_role == 'editor' and role['value'] != 'editor'):
            raise HTTPException(403, 'Access denied')
        return SimpleNamespace(output_dir=str(tmp_path), project_id='demo', owner_username='alice', project_name='demo', is_home_node=role['home'], home_node_id='other', current_node_id='local')

    def home(ctx, **kwargs):
        if not ctx.is_home_node:
            raise HTTPException(409, 'Wrong home node')

    monkeypatch.setattr(routes, 'resolve_project_context', resolve)
    monkeypatch.setattr(routes, 'require_project_home_node', home)
    app = FastAPI()
    app.include_router(routes.router, prefix='/api/v1')
    app.dependency_overrides[get_api_user] = lambda: {'username': 'alice'}
    return TestClient(app), role


def test_api_lifecycle(client):
    api, _ = client
    first = api.post(BASE, json={'title': 'One', 'html': '<h1>One</h1>'})
    assert first.status_code == 200
    artifact = first.json()['data']
    url = BASE + '/' + artifact['id']
    assert api.get(BASE).json()['data']['artifacts'][0]['id'] == artifact['id']
    second = api.put(url, json={'title': 'Two', 'html': 'two', 'base_version': 1})
    assert second.json()['data']['version'] == 2
    assert api.put(url, json={'title': 'Bad', 'html': 'bad', 'base_version': 1}).status_code == 409
    assert api.get(url + '?version=1').json()['data'] == artifact
    assert len(api.get(url + '/versions').json()['data']['versions']) == 2
    assert api.post(url + '/restore', json={'version': 1, 'base_version': 2}).json()['data']['version'] == 3
    assert api.get(url + '/preview').json()['data']['html'] == '<h1>One</h1>'
    assert api.get(url + '/export').headers['content-type'] == 'application/zip'
    assert api.get(url + '?version=999').status_code == 404
    assert api.put(url, json={'title': 'Bad', 'html': 'bad'}).status_code == 422


def test_acl_and_home_node_on_reads_and_writes(client):
    api, role = client
    artifact = api.post(BASE, json={'title': 'One', 'html': 'one'}).json()['data']
    url = BASE + '/' + artifact['id']
    role['value'] = 'viewer'
    assert api.get(url).status_code == 200
    assert api.post(BASE, json={'title': 'No', 'html': 'no'}).status_code == 403
    assert api.put(url, json={'title': 'No', 'html': 'no', 'base_version': 1}).status_code == 403
    assert api.post(url + '/restore', json={'version': 1, 'base_version': 1}).status_code == 403
    assert api.get(url.replace('/demo/', '/peer/')).status_code == 403
    role['home'] = False
    for suffix in ['', '/versions', '/preview', '/export']:
        assert api.get(url + suffix).status_code == 409
    assert api.get(BASE).status_code == 409
