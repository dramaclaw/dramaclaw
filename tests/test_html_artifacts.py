import io
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import zipfile

import pytest

from novelvideo.freezone.html_artifacts import ArtifactStore, ArtifactConflict


def _write(args):
    root, artifact_id = args
    try:
        return ArtifactStore(Path(root)).update(artifact_id, title='Next', html='next', base_version=1)['version']
    except ArtifactConflict:
        return 'conflict'


def test_durable_immutable_versions_restore_and_isolation(tmp_path):
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='<h1>Hello</h1>')
    second = store.update(first['id'], title='Second', html='changed', base_version=1)
    assert second['version'] == 2
    assert ArtifactStore(tmp_path).get(first['id'], 1) == first
    with pytest.raises(ArtifactConflict):
        store.update(first['id'], title='stale', html='bad', base_version=1)
    restored = store.restore(first['id'], version=1, base_version=2)
    assert restored['version'] == 3 and restored['html'] == first['html']
    assert len(store.versions(first['id'])) == 3
    assert 'html' not in store.list()[0]
    with pytest.raises(FileNotFoundError):
        ArtifactStore(tmp_path / 'peer').get(first['id'])


def test_cross_process_conflict(tmp_path):
    first = ArtifactStore(tmp_path).create(title='First', html='first')
    with ProcessPoolExecutor(2) as pool:
        results = list(pool.map(_write, [(str(tmp_path), first['id'])] * 2))
    assert sorted(map(str, results)) == ['2', 'conflict']


@pytest.mark.parametrize('artifact_id', ['../bad', 'x/y', '', 'a' * 100])
def test_invalid_ids(tmp_path, artifact_id):
    with pytest.raises(ValueError):
        ArtifactStore(tmp_path).get(artifact_id)


def test_failed_write_keeps_previous_version(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    with pytest.raises(ValueError):
        store.update(first['id'], title='', html='bad', base_version=1)
    assert store.get(first['id']) == first


def test_portable_export(tmp_path):
    (tmp_path / 'photo.png').write_bytes(b'png')
    store = ArtifactStore(tmp_path, project_id='project')
    first = store.create(title='Demo', html='<style>body{background:url(photo.png)}</style><img src="/api/v1/projects/project/media/photo.png">')
    with zipfile.ZipFile(io.BytesIO(store.export(first['id']))) as archive:
        assert 'index.html' in archive.namelist()
        assert len(archive.namelist()) == 2
        html = archive.read('index.html').decode()
        assert '/api/' not in html and 'assets/' in html


@pytest.mark.parametrize('html', [
    '<img src="../secret.png">', '<img src="https://example.com/p.png">',
    '<img src="/api/v1/projects/peer/media/photo.png">',
    '<script src="local.js"></script>', '<style>@import "theme.css";</style>',
    '<img srcset="photo.png 1x, photo.png 2x">', '<img src="secret.json">',
    '<iframe src="child.html"></iframe>', '<base href="https://evil.example">',
])
def test_export_refuses_unsafe_or_unsupported_resources(tmp_path, html):
    (tmp_path / 'photo.png').write_bytes(b'png')
    (tmp_path / 'secret.json').write_text('secret')
    store = ArtifactStore(tmp_path, project_id='project')
    first = store.create(title='Demo', html=html)
    with pytest.raises(ValueError):
        store.export(first['id'])


def test_export_refuses_symlink_escape(tmp_path):
    root = tmp_path / 'project'
    root.mkdir()
    (tmp_path / 'private.png').write_bytes(b'private')
    (root / 'image.png').symlink_to(tmp_path / 'private.png')
    store = ArtifactStore(root)
    first = store.create(title='Demo', html='<img src="image.png">')
    with pytest.raises(ValueError):
        store.export(first['id'])


def test_preview_embeds_local_media_and_blocks_external(tmp_path):
    (tmp_path / 'photo.png').write_bytes(b'png')
    store = ArtifactStore(tmp_path)
    first = store.create(title='Preview', html='<img src="photo.png"><img src="https://evil.example/a.png"><script>console.log(1)</script>')
    preview = store.preview(first['id'])
    assert 'data:image/png;base64,cG5n' in preview['html']
    assert 'https://evil.example' not in preview['html']
    assert '<script>console.log(1)</script>' in preview['html']
    assert preview['warnings']


def test_transaction_failure_rolls_back_insert(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    insert = store._insert

    def failing_insert(*args, **kwargs):
        insert(*args, **kwargs)
        raise OSError('simulated write failure')

    monkeypatch.setattr(store, '_insert', failing_insert)
    with pytest.raises(OSError):
        store.update(first['id'], title='Next', html='next', base_version=1)
    assert ArtifactStore(tmp_path).get(first['id']) == first
    assert len(store.versions(first['id'])) == 1


def test_export_refuses_symlink_directory_even_if_inside_project(tmp_path):
    (tmp_path / 'media').mkdir()
    (tmp_path / 'media' / 'a.png').write_bytes(b'png')
    (tmp_path / 'linked').symlink_to(tmp_path / 'media')
    store = ArtifactStore(tmp_path)
    artifact = store.create(title='Test', html='<img src="linked/a.png">')
    with pytest.raises(ValueError):
        store.export(artifact['id'])


def test_export_refuses_unparsed_css_resource(tmp_path):
    store = ArtifactStore(tmp_path)
    artifact = store.create(title='Test', html='<style>body{background:url(\"unclosed.png)}</style>')
    with pytest.raises(ValueError):
        store.export(artifact['id'])

@pytest.mark.parametrize('component', ['directory', 'database'])
def test_storage_refuses_symlinked_peer_database(tmp_path, component):
    own, peer = tmp_path / 'own', tmp_path / 'peer'
    own.mkdir()
    peer.mkdir()
    secret = ArtifactStore(peer).create(title='secret', html='private')
    target = own / 'freezone' / '_html_artifacts'
    target.parent.mkdir(parents=True)
    if component == 'directory':
        target.symlink_to(peer / 'freezone' / '_html_artifacts')
    else:
        target.mkdir()
        (target / 'artifacts.sqlite3').symlink_to(peer / 'freezone' / '_html_artifacts' / 'artifacts.sqlite3')
    with pytest.raises(ValueError):
        ArtifactStore(own).get(secret['id'])


def test_storage_scope_binding_refuses_copied_peer_database(tmp_path):
    import shutil
    own, peer = tmp_path / 'own', tmp_path / 'peer'
    own.mkdir()
    peer.mkdir()
    secret = ArtifactStore(peer).create(title='secret', html='private')
    target = own / 'freezone' / '_html_artifacts'
    target.mkdir(parents=True)
    shutil.copyfile(peer / 'freezone' / '_html_artifacts' / 'artifacts.sqlite3', target / 'artifacts.sqlite3')
    with pytest.raises(ValueError, match='scope'):
        ArtifactStore(own).get(secret['id'])


def test_preview_bounds_repeated_media_expansion(tmp_path, monkeypatch):
    import novelvideo.freezone.html_artifacts as module
    monkeypatch.setattr(module, 'MAX_PREVIEW_BYTES', 4096, raising=False)
    (tmp_path / 'a.png').write_bytes(b'x' * 1024)
    store = ArtifactStore(tmp_path)
    item = store.create(title='repeat', html='<img src="a.png">' * 30)
    with pytest.raises(ValueError, match='Preview'):
        store.preview(item['id'])


def test_export_refuses_unclosed_css_url(tmp_path):
    store=ArtifactStore(tmp_path)
    item=store.create(title='css',html='<style>body {background: url(https://example.com/a.png</style>')
    with pytest.raises(ValueError):
        store.export(item['id'])


def test_preview_budget_reserves_media_inside_single_style(tmp_path, monkeypatch):
    import novelvideo.freezone.html_artifacts as module
    monkeypatch.setattr(module, 'MAX_PREVIEW_BYTES', 4096)
    (tmp_path / 'a.png').write_bytes(b'x' * 1024)
    calls=[]
    encode=module.base64.b64encode
    monkeypatch.setattr(module.base64,'b64encode',lambda value: (calls.append(1),encode(value))[1])
    store=ArtifactStore(tmp_path)
    item=store.create(title='css',html='<style>'+'a{background:url(a.png)}'*30+'</style>')
    with pytest.raises(ValueError,match='Preview'):
        store.preview(item['id'])
    assert len(calls)<4


@pytest.mark.parametrize('url', ['mailto:hello@shiguang.coffee', 'tel:+8612345', 'https://example.com/contact', 'http://example.com', '#contact'])
def test_navigation_links_are_not_packaged_as_media(tmp_path, url):
    store = ArtifactStore(tmp_path)
    item = store.create(title='Coffee', html=f'<a href="{url}">Contact</a>')
    preview = store.preview(item['id'])
    assert preview['warnings'] == []
    assert f'href="{url}"' in preview['html']
    with zipfile.ZipFile(io.BytesIO(store.export(item['id']))) as archive:
        assert archive.namelist() == ['index.html']
        assert f'href="{url}"' in archive.read('index.html').decode()


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'java&#10;script:alert(1)', 'data:text/html,bad', 'file:///etc/passwd'])
def test_navigation_blocks_unsafe_schemes(tmp_path, url):
    store = ArtifactStore(tmp_path)
    item = store.create(title='Unsafe', html=f'<a href="{url}">Contact</a>')
    assert store.preview(item['id'])['warnings']
    with pytest.raises(ValueError):
        store.export(item['id'])
