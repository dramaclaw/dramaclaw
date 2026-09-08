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


def test_metadata_publish_failure_keeps_previous_revision(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    def failing_publish(*args, **kwargs):
        raise OSError('simulated write failure')

    monkeypatch.setattr('novelvideo.freezone.html_artifacts.os.replace', failing_publish)
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

@pytest.mark.parametrize('component', ['directory', 'artifact'])
def test_storage_refuses_symlinked_peer_files(tmp_path, component):
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
        (target / secret['id']).symlink_to(peer / 'freezone' / '_html_artifacts' / secret['id'])
    with pytest.raises(ValueError):
        ArtifactStore(own).get(secret['id'])


def test_storage_scope_binding_refuses_copied_peer_files(tmp_path):
    import shutil
    own, peer = tmp_path / 'own', tmp_path / 'peer'
    own.mkdir()
    peer.mkdir()
    secret = ArtifactStore(peer).create(title='secret', html='private')
    target = own / 'freezone' / '_html_artifacts'
    target.mkdir(parents=True)
    shutil.copytree(peer / 'freezone' / '_html_artifacts' / secret['id'], target / secret['id'])
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


def test_revisions_are_files_without_database(tmp_path):
    item = ArtifactStore(tmp_path).create(title='page', html='<h1>hello</h1>')
    root = tmp_path / 'freezone' / '_html_artifacts'
    assert not (root / 'artifacts.sqlite3').exists()
    files = list((root / item['id']).glob('*.html'))
    assert len(files) == 1
    assert files[0].read_text() == item['html']


def test_failed_commit_can_retry_without_publishing_orphan(tmp_path, monkeypatch):
    import novelvideo.freezone.html_artifacts as module
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    original = module.os.replace
    with monkeypatch.context() as patch:
        patch.setattr(module.os, 'replace', lambda *_: (_ for _ in ()).throw(OSError('failure')))
        with pytest.raises(OSError):
            store.update(first['id'], title='bad', html='orphan', base_version=1)
    second = store.update(first['id'], title='Good', html='valid', base_version=1)
    assert second['version'] == 2
    assert store.get(first['id'])['html'] == 'valid'
    assert len(store.versions(first['id'])) == 2
    assert module.os.replace is original


def test_metadata_cannot_reference_outside_artifact(tmp_path):
    import json
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    metadata = store.root / first['id'] / '1.json'
    row = json.loads(metadata.read_text())
    row['file'] = '../private.html'
    metadata.write_text(json.dumps(row))
    with pytest.raises(ValueError):
        store.get(first['id'])


def test_revision_refuses_symlinked_html(tmp_path):
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    file = next((store.root / first['id']).glob('*.html'))
    private = tmp_path / 'private.html'
    private.write_text('private')
    file.unlink()
    file.symlink_to(private)
    with pytest.raises(ValueError):
        store.get(first['id'])


def test_lost_writer_lease_does_not_publish(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from novelvideo.ports.canvas_mutex import CanvasLeaseLost
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')

    class Guard:
        def reassert(self):
            raise CanvasLeaseLost('html_artifacts')

    class Mutex:
        @contextmanager
        def write_mutex(self, project_dir, canvas_id):
            assert project_dir == store.project_dir
            assert canvas_id == 'html_artifacts'
            yield Guard()

    with monkeypatch.context() as patch:
        patch.setattr('novelvideo.ports.get_canvas_write_mutex', lambda: Mutex())
        with pytest.raises(CanvasLeaseLost):
            store.update(first['id'], title='lost', html='lost', base_version=1)
    assert store.get(first['id']) == first


@pytest.mark.parametrize('payload', ['[]', '{"version": 1}', '{"file": null}', '{'])
def test_corrupt_revision_metadata_is_value_error(tmp_path, payload):
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    (store.root / first['id'] / '1.json').write_text(payload)
    with pytest.raises(ValueError):
        store.get(first['id'])


def test_read_refuses_symlink_swap_after_metadata_check(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    first = store.create(title='First', html='first')
    target = next((store.root / first['id']).glob('*.html'))
    peer = tmp_path / 'private.html'
    peer.write_text('first')
    original = store._regular

    def swap(path):
        original(path)
        if path == target and not path.is_symlink():
            path.unlink()
            path.symlink_to(peer)

    monkeypatch.setattr(store, '_regular', swap)
    with pytest.raises(ValueError):
        store.get(first['id'])


def test_export_file_is_cached_per_version(tmp_path):
    store = ArtifactStore(tmp_path)
    first = store.create(title='One', html='<h1>One</h1>')
    path = store.export_file(first['id'], 1)
    assert path.is_relative_to(tmp_path)
    assert path.name == 'v1.zip'
    original = path.read_bytes()
    store.update(first['id'], title='Two', html='<h1>Two</h1>', base_version=1)
    second = store.export_file(first['id'], 2)
    assert second != path and path.read_bytes() == original
    with zipfile.ZipFile(second) as archive:
        assert archive.read('index.html') == b'<h1>Two</h1>'
    assert store.export_file(first['id'], 1) == path


def test_cached_export_preserves_media_snapshot(tmp_path):
    (tmp_path / 'photo.png').write_bytes(b'original')
    store = ArtifactStore(tmp_path)
    item = store.create(title='Media', html='<img src="photo.png">')
    path = store.export_file(item['id'], 1)
    (tmp_path / 'photo.png').unlink()
    assert store.export_file(item['id'], 1) == path
    with zipfile.ZipFile(path) as archive:
        assert archive.read(next(n for n in archive.namelist() if n.endswith('.png'))) == b'original'
