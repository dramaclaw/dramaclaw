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
        return SimpleNamespace(output_dir=str(tmp_path), state_dir=str(tmp_path / 'state'), project_id='demo', owner_username='alice', project_name='demo', is_home_node=role['home'], home_node_id='other', current_node_id='local')

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
    download = api.get(url + '/export').json()['data']['download_url']
    assert download.startswith('/api/v1/projects/demo/files/freezone/_html_artifacts/')
    assert download.endswith('/exports/v3.zip')
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


def test_preview_project_media_uses_manifest_instead_of_base64(client):
    api, _ = client
    from novelvideo.api.routes import html_artifacts as routes
    import asyncio
    store = asyncio.run(routes._store('demo', {'username': 'alice'}, 'editor'))
    (store.project_dir / 'clip.mp4').write_bytes(b'video')
    artifact = api.post(BASE, json={'title': 'Video', 'html': '<video src="clip.mp4"></video>'}).json()['data']
    preview = api.get(BASE + '/' + artifact['id'] + '/preview').json()['data']
    assert preview['warnings'] == []
    assert preview['resources'][0]['path'] == '/api/v1/projects/demo/media/clip.mp4'
    assert 'base64' not in preview['html']


def test_node_history_tracks_saved_versions(client, tmp_path):
    import json
    api, role = client
    scope = {'canvas_id': 'canvas-1', 'node_id': 'node-1'}
    first = api.post(BASE, json={'title': 'One', 'html': 'one', **scope}).json()['data']
    url = BASE + '/' + first['id']
    assert api.put(url, json={'title': 'Two', 'html': 'two', 'base_version': 1, **scope}).status_code == 200
    rows = [json.loads(line) for line in (tmp_path / 'freezone/_generation_history/canvas-1/node-1.jsonl').read_text().splitlines()]
    assert [row['result']['version'] for row in rows] == [1, 2]
    assert all(row['media_type'] == 'html' for row in rows)
    assert rows[0]['result']['artifact_id'] == first['id']
    role['value'] = 'viewer'
    assert api.post(url + '/node-history', json={'version': 1, **scope}).status_code == 403


def test_history_scope_rejects_partial_and_traversal(client):
    api, _ = client
    for scope in [{'node_id': 'node'}, {'canvas_id': '../peer', 'node_id': 'node'}, {'canvas_id': 'canvas', 'node_id': '../node'}]:
        assert api.post(BASE, json={'title': 'One', 'html': 'one', **scope}).status_code == 422


def test_history_failure_does_not_lose_saved_source(client, monkeypatch):
    from novelvideo.api.routes import html_artifacts as routes
    api, _ = client
    def fail(**kwargs):
        raise OSError('disk error')
    monkeypatch.setattr(routes, 'append_generation_history', fail)
    response = api.post(BASE, json={'title': 'Saved', 'html': 'source', 'canvas_id': 'canvas', 'node_id': 'node'})
    assert response.status_code == 200
    artifact = response.json()['data']
    assert artifact['warnings']
    assert api.get(BASE + '/' + artifact['id']).json()['data']['html'] == 'source'


def test_create_idempotency_and_authorized_recovery(client):
    api, _ = client
    params = {'idempotency_key': 'workflow:canvas:node'}
    assert api.get(BASE + '/creation-lookup', params=params).json()['data']['artifact'] is None
    body = {'title': 'Page', 'html': '<html>one</html>', **params}
    first = api.post(BASE, json=body).json()['data']
    assert api.post(BASE, json=body).json()['data']['id'] == first['id']
    assert api.post(BASE, json={**body, 'html': 'different'}).status_code == 409
    assert api.get(BASE + '/creation-lookup', params=params).json()['data']['artifact']['id'] == first['id']
    assert api.get(BASE.replace('/demo/', '/peer/') + '/creation-lookup', params=params).status_code == 403


def test_update_idempotency_returns_the_original_saved_revision(client, tmp_path):
    api, _ = client
    first = api.post(BASE, json={'title': 'One', 'html': 'one'}).json()['data']
    url = BASE + '/' + first['id']
    body = {
        'title': 'Two',
        'html': 'two',
        'base_version': 1,
        'idempotency_key': 'html-generation:canvas:node:task-1',
        'canvas_id': 'canvas-1',
        'node_id': 'node-1',
    }
    saved = api.put(url, json=body)
    repeated = api.put(url, json=body)

    assert saved.status_code == repeated.status_code == 200
    assert saved.json()['data']['version'] == repeated.json()['data']['version'] == 2
    assert len(api.get(url + '/versions').json()['data']['versions']) == 2
    history = tmp_path / 'freezone/_generation_history/canvas-1/node-1.jsonl'
    assert len(history.read_text().splitlines()) == 1
    assert api.put(url, json={**body, 'html': 'changed'}).status_code == 409


def test_preview_media_range_and_grant_rejection(client, monkeypatch):
    import asyncio
    from novelvideo.api.routes import html_artifacts as routes
    api, _ = client
    store = asyncio.run(routes._store('demo', {'username': 'alice'}, 'editor'))
    (store.project_dir / 'clip.mp4').write_bytes(b'0123456789')
    async def get_project(project):
        if project != 'demo':
            return None
        return SimpleNamespace(output_dir=store.project_dir, state_dir=store.project_dir / 'state', home_node_id='local')
    monkeypatch.setattr(routes, 'get_project_registry', lambda: SimpleNamespace(get_project=get_project))
    artifact = api.post(BASE, json={'title': 'Video', 'html': '<video src="clip.mp4"></video>'}).json()['data']
    data = api.get(BASE + '/' + artifact['id'] + '/preview').json()['data']
    url = data['resources'][0]['url']
    result = api.get(url, headers={'Range': 'bytes=2-4'})
    assert result.status_code == 206
    assert result.content == b'234'
    assert result.headers['content-range'] == 'bytes 2-4/10'
    assert api.get(url.replace('clip.mp4', 'other.mp4')).status_code == 403
    assert api.get(url.replace('/demo/', '/peer/')).status_code == 404
    monkeypatch.setattr(routes.preview_media.time, 'time', lambda: 9999999999)
    assert api.get(url).status_code == 403


def test_preview_reuses_oss_delivery(client, monkeypatch):
    import asyncio
    from fastapi.responses import RedirectResponse
    from novelvideo.api.routes import html_artifacts as routes
    api, _ = client
    store = asyncio.run(routes._store('demo', {'username': 'alice'}, 'editor'))
    (store.project_dir / 'clip.mp4').write_bytes(b'video')
    monkeypatch.setattr(routes, '_serve_or_redirect_to_oss', lambda *args, **kwargs: RedirectResponse('https://media.example/clip.mp4?signature=test', status_code=302))
    artifact = api.post(BASE, json={'title': 'Video', 'html': '<video src="clip.mp4"></video>'}).json()['data']
    data = api.get(BASE + '/' + artifact['id'] + '/preview').json()['data']
    assert data['resources'][0]['url'] == 'https://media.example/clip.mp4?signature=test'


def test_preview_thumbnail_uses_existing_variant(client, monkeypatch):
    import asyncio
    from novelvideo.api.routes import html_artifacts as routes
    api, _ = client
    store = asyncio.run(routes._store('demo', {'username': 'alice'}, 'editor'))
    (store.project_dir / 'image.png').write_bytes(b'image')
    thumb = store.project_dir / 'thumb.webp'
    thumb.write_bytes(b'thumb')
    monkeypatch.setattr(routes, 'fresh_thumbnail', lambda *args: thumb)
    artifact = api.post(BASE, json={'title': 'Image', 'html': '<img src="image.png">'}).json()['data']
    data = api.get(BASE + '/' + artifact['id'] + '/preview?st_thumb=thumb').json()['data']
    assert data['resources'][0]['url'].endswith('/image.png?st_thumb=thumb')
