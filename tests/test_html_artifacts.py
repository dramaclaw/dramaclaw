from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
import tracemalloc
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
    path = store.export_file(first['id'])
    try:
        with zipfile.ZipFile(path) as archive:
            assert 'index.html' in archive.namelist()
            assert len(archive.namelist()) == 2
            html = archive.read('index.html').decode()
            assert '/api/' not in html and 'assets/' in html
    finally:
        path.unlink(missing_ok=True)


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
        store.export_file(first['id'])


def test_export_refuses_symlink_escape(tmp_path):
    root = tmp_path / 'project'
    root.mkdir()
    (tmp_path / 'private.png').write_bytes(b'private')
    (root / 'image.png').symlink_to(tmp_path / 'private.png')
    store = ArtifactStore(root)
    first = store.create(title='Demo', html='<img src="image.png">')
    with pytest.raises(ValueError):
        store.export_file(first['id'])


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
        store.export_file(artifact['id'])


def test_export_refuses_unparsed_css_resource(tmp_path):
    store = ArtifactStore(tmp_path)
    artifact = store.create(title='Test', html='<style>body{background:url(\"unclosed.png)}</style>')
    with pytest.raises(ValueError):
        store.export_file(artifact['id'])

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
        store.export_file(item['id'])


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
    path = store.export_file(item['id'])
    try:
        with zipfile.ZipFile(path) as archive:
            assert archive.namelist() == ['index.html']
            assert f'href="{url}"' in archive.read('index.html').decode()
    finally:
        path.unlink(missing_ok=True)


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'java&#10;script:alert(1)', 'data:text/html,bad', 'file:///etc/passwd'])
def test_navigation_blocks_unsafe_schemes(tmp_path, url):
    store = ArtifactStore(tmp_path)
    item = store.create(title='Unsafe', html=f'<a href="{url}">Contact</a>')
    assert store.preview(item['id'])['warnings']
    with pytest.raises(ValueError):
        store.export_file(item['id'])


def test_revisions_are_files_without_database(tmp_path):
    item = ArtifactStore(tmp_path).create(title='page', html='<h1>hello</h1>')
    root = tmp_path / 'freezone' / '_html_artifacts'
    assert not (root / 'artifacts.sqlite3').exists()
    files = list((root / item['id']).glob('*.html'))
    assert len(files) == 1
    assert files[0].read_text() == item['html']


def test_latest_and_explicit_version_reads_do_not_scan_revision_directory(
    tmp_path, monkeypatch
):
    store = ArtifactStore(tmp_path)
    first = store.create(title='One', html='one')
    store.update(first['id'], title='Two', html='two', base_version=1)
    assert (store.root / first['id'] / 'HEAD.json').is_file()

    def unexpected_scan(_artifact_id):
        raise AssertionError('ordinary reads must not scan every revision')

    monkeypatch.setattr(store, '_rows', unexpected_scan)
    assert store.get(first['id'])['version'] == 2
    assert store.get(first['id'], 1)['html'] == 'one'


def test_legacy_artifact_without_head_is_repaired_on_read(tmp_path):
    store = ArtifactStore(tmp_path)
    first = store.create(title='One', html='one')
    head = store.root / first['id'] / 'HEAD.json'
    head.unlink()

    assert ArtifactStore(tmp_path).get(first['id'])['version'] == 1
    assert head.is_file()


def test_stale_head_advances_without_scanning_all_revisions(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    first = store.create(title='One', html='one')
    store.update(first['id'], title='Two', html='two', base_version=1)
    head = store.root / first['id'] / 'HEAD.json'
    payload = json.loads(head.read_text())
    head.write_text(json.dumps({**payload, 'version': 1}))
    monkeypatch.setattr(
        store,
        '_rows',
        lambda _artifact_id: (_ for _ in ()).throw(
            AssertionError('stale contiguous HEAD must not scan all revisions')
        ),
    )

    assert store.get(first['id'])['version'] == 2
    assert json.loads(head.read_text())['version'] == 2


def test_interrupted_revision_commit_repairs_head_and_can_retry(tmp_path, monkeypatch):
    import novelvideo.freezone.html_artifacts as module

    store = ArtifactStore(tmp_path)
    first = store.create(title='One', html='one')
    real_replace = module.os.replace

    def fail_revision(source, target):
        if Path(target).name == '2.json':
            raise OSError('revision publish failed')
        return real_replace(source, target)

    with monkeypatch.context() as patch:
        patch.setattr(module.os, 'replace', fail_revision)
        with pytest.raises(OSError, match='revision publish failed'):
            store.update(first['id'], title='Lost', html='lost', base_version=1)

    restarted = ArtifactStore(tmp_path)
    assert restarted.get(first['id'])['version'] == 1
    saved = restarted.update(first['id'], title='Two', html='two', base_version=1)
    assert saved['version'] == 2
    assert restarted.get(first['id'])['html'] == 'two'


def test_versions_scans_metadata_once_without_reading_html(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    first = store.create(title='One', html='one')
    store.update(first['id'], title='Two', html='two', base_version=1)
    scans = 0
    real_rows = store._rows

    def rows(artifact_id):
        nonlocal scans
        scans += 1
        return real_rows(artifact_id)

    monkeypatch.setattr(store, '_rows', rows)
    monkeypatch.setattr(
        store,
        '_get',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError('version listing must not read source HTML')
        ),
    )

    assert [row['version'] for row in store.versions(first['id'])] == [2, 1]
    assert scans == 1


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


def test_export_file_is_temporary_per_request(tmp_path):
    store = ArtifactStore(tmp_path)
    first = store.create(title='One', html='<h1>One</h1>')
    path = store.export_file(first['id'], 1)
    second = store.export_file(first['id'], 1)
    try:
        assert path != second
        assert not (store.root / first['id'] / 'exports').exists()
        with zipfile.ZipFile(path) as archive:
            assert archive.read('index.html') == b'<h1>One</h1>'
        with zipfile.ZipFile(second) as archive:
            assert archive.read('index.html') == b'<h1>One</h1>'
    finally:
        path.unlink(missing_ok=True)
        second.unlink(missing_ok=True)


def test_access_removes_legacy_persistent_export_cache(tmp_path):
    store = ArtifactStore(tmp_path)
    item = store.create(title='Legacy', html='<h1>Legacy</h1>')
    exports = store.root / item['id'] / 'exports'
    exports.mkdir()
    (exports / 'v1.zip').write_bytes(b'zip')
    (exports / f'.{"a" * 32}.tmp').write_bytes(b'partial')

    assert store.cleanup_legacy_exports() == 2
    assert not exports.exists()


def test_legacy_export_cleanup_validates_every_entry_before_deleting(tmp_path):
    store = ArtifactStore(tmp_path)
    item = store.create(title='Legacy', html='<h1>Legacy</h1>')
    exports = store.root / item['id'] / 'exports'
    exports.mkdir()
    valid = exports / 'v1.zip'
    valid.write_bytes(b'zip')
    (exports / 'unexpected.txt').write_text('keep')

    with pytest.raises(ValueError, match='Invalid file'):
        store.cleanup_legacy_exports()

    assert valid.read_bytes() == b'zip'


def test_legacy_export_cleanup_refuses_symlinked_directory(tmp_path):
    store = ArtifactStore(tmp_path)
    item = store.create(title='Legacy', html='<h1>Legacy</h1>')
    peer = tmp_path / 'peer-exports'
    peer.mkdir()
    secret = peer / 'v1.zip'
    secret.write_bytes(b'private')
    exports = store.root / item['id'] / 'exports'
    try:
        exports.symlink_to(peer, target_is_directory=True)
    except OSError:
        pytest.skip('symlinks are unavailable')

    with pytest.raises(ValueError, match='Invalid legacy export directory'):
        store.cleanup_legacy_exports()

    assert secret.read_bytes() == b'private'


def test_each_export_reads_a_fresh_media_snapshot(tmp_path):
    (tmp_path / 'photo.png').write_bytes(b'original')
    store = ArtifactStore(tmp_path)
    item = store.create(title='Media', html='<img src="photo.png">')
    path = store.export_file(item['id'], 1)
    (tmp_path / 'photo.png').write_bytes(b'updated!')
    second = store.export_file(item['id'], 1)
    try:
        with zipfile.ZipFile(path) as archive:
            assert archive.read(next(n for n in archive.namelist() if n.endswith('.png'))) == b'original'
        with zipfile.ZipFile(second) as archive:
            assert archive.read(next(n for n in archive.namelist() if n.endswith('.png'))) == b'updated!'
    finally:
        path.unlink(missing_ok=True)
        second.unlink(missing_ok=True)


def test_export_file_streams_large_media_without_buffering_it_in_python(tmp_path):
    media_size = 20 * 1024 * 1024
    video = tmp_path / 'clip.mp4'
    with video.open('wb') as stream:
        stream.truncate(media_size)
    store = ArtifactStore(tmp_path)
    item = store.create(title='Video', html='<video src="clip.mp4"></video>')

    tracemalloc.start()
    try:
        path = store.export_file(item['id'])
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert peak < 8 * 1024 * 1024
    try:
        with zipfile.ZipFile(path) as archive:
            video_info = next(info for info in archive.infolist() if info.filename.endswith('.mp4'))
            assert video_info.file_size == media_size
            assert video_info.compress_type == zipfile.ZIP_STORED
    finally:
        path.unlink(missing_ok=True)


def test_concurrent_exports_use_independent_temporary_files(tmp_path):
    (tmp_path / 'photo.png').write_bytes(b'image')
    store = ArtifactStore(tmp_path)
    item = store.create(title='Image', html='<img src="photo.png">')
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(store.export_file, item['id'])
        second = pool.submit(store.export_file, item['id'])
        paths = [first.result(timeout=5), second.result(timeout=5)]
    try:
        assert paths[0] != paths[1]
        assert all(zipfile.is_zipfile(path) for path in paths)
    finally:
        for path in paths:
            path.unlink(missing_ok=True)


def test_export_file_removes_partial_archive_when_media_copy_fails(
    tmp_path, monkeypatch
):
    import novelvideo.freezone.html_artifacts as module

    (tmp_path / 'clip.mp4').write_bytes(b'video')
    store = ArtifactStore(tmp_path)
    item = store.create(title='Video', html='<video src="clip.mp4"></video>')
    real_open_resource = module._PortableHTML.open_resource
    opens = 0
    monkeypatch.setattr(module.tempfile, 'tempdir', str(tmp_path))

    @contextmanager
    def fail_during_copy(parser, candidate):
        nonlocal opens
        opens += 1
        if opens == 2:
            raise OSError('disk read failed')
        with real_open_resource(parser, candidate) as opened:
            yield opened

    monkeypatch.setattr(module._PortableHTML, 'open_resource', fail_during_copy)

    with pytest.raises(OSError, match='disk read failed'):
        store.export_file(item['id'])

    assert not list(tmp_path.glob('supertale-html-*.zip'))


def test_export_file_preserves_archive_write_errors_and_removes_partial_file(
    tmp_path, monkeypatch
):
    import novelvideo.freezone.html_artifacts as module

    (tmp_path / 'clip.mp4').write_bytes(b'video')
    store = ArtifactStore(tmp_path)
    item = store.create(title='Video', html='<video src="clip.mp4"></video>')
    real_zip_file = zipfile.ZipFile
    monkeypatch.setattr(module.tempfile, 'tempdir', str(tmp_path))

    class FailingDestination:
        def __init__(self, destination):
            self.destination = destination

        def __enter__(self):
            self.destination.__enter__()
            return self

        def __exit__(self, *args):
            return self.destination.__exit__(*args)

        def write(self, _chunk):
            raise OSError('destination disk full')

    class FailingZipFile(real_zip_file):
        def open(self, name, mode='r', pwd=None, *, force_zip64=False):
            destination = super().open(
                name,
                mode=mode,
                pwd=pwd,
                force_zip64=force_zip64,
            )
            filename = name.filename if isinstance(name, zipfile.ZipInfo) else str(name)
            if mode == 'w' and filename.startswith('assets/'):
                return FailingDestination(destination)
            return destination

    monkeypatch.setattr(zipfile, 'ZipFile', FailingZipFile)

    with pytest.raises(OSError, match='destination disk full'):
        store.export_file(item['id'])

    assert not list(tmp_path.glob('supertale-html-*.zip'))


def test_export_file_rejects_media_replaced_after_validation(tmp_path, monkeypatch):
    import novelvideo.freezone.html_artifacts as module

    media = tmp_path / 'clip.mp4'
    media.write_bytes(b'video')
    store = ArtifactStore(tmp_path)
    item = store.create(title='Video', html='<video src="clip.mp4"></video>')
    real_open_resource = module._PortableHTML.open_resource
    opens = 0
    monkeypatch.setattr(module.tempfile, 'tempdir', str(tmp_path))

    @contextmanager
    def replace_before_copy(parser, candidate):
        nonlocal opens
        opens += 1
        if opens == 2:
            replacement = candidate.with_suffix('.replacement')
            replacement.write_bytes(b'other')
            os.replace(replacement, candidate)
        with real_open_resource(parser, candidate) as opened:
            yield opened

    monkeypatch.setattr(module._PortableHTML, 'open_resource', replace_before_copy)

    with pytest.raises(ValueError, match='Media changed during export'):
        store.export_file(item['id'])

    assert not list(tmp_path.glob('supertale-html-*.zip'))


def test_export_file_rejects_media_modified_during_copy(tmp_path, monkeypatch):
    import novelvideo.freezone.html_artifacts as module

    media = tmp_path / 'clip.mp4'
    media.write_bytes(b'video')
    store = ArtifactStore(tmp_path)
    item = store.create(title='Video', html='<video src="clip.mp4"></video>')
    real_open_resource = module._PortableHTML.open_resource
    opens = 0
    monkeypatch.setattr(module.tempfile, 'tempdir', str(tmp_path))

    class MutatingStream:
        def __init__(self, stream, candidate):
            self.stream = stream
            self.candidate = candidate
            self.mutated = False

        def read(self, size):
            chunk = self.stream.read(size)
            if chunk and not self.mutated:
                self.mutated = True
                before = self.candidate.stat()
                self.candidate.write_bytes(b'other')
                os.utime(
                    self.candidate,
                    ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000),
                )
            return chunk

        def fileno(self):
            return self.stream.fileno()

    @contextmanager
    def mutate_during_copy(parser, candidate):
        nonlocal opens
        opens += 1
        with real_open_resource(parser, candidate) as (stream, info):
            if opens == 2:
                yield MutatingStream(stream, candidate), info
            else:
                yield stream, info

    monkeypatch.setattr(module._PortableHTML, 'open_resource', mutate_during_copy)
    monkeypatch.setattr(module, 'EXPORT_COPY_CHUNK_BYTES', 1)

    with pytest.raises(ValueError, match='Media changed during export'):
        store.export_file(item['id'])

    assert not list(tmp_path.glob('supertale-html-*.zip'))


def test_create_idempotency_survives_restart_and_rejects_changed_payload(tmp_path):
    store = ArtifactStore(tmp_path, project_id='project')
    first = store.create(title='Page', html='<html>first</html>', idempotency_key='workflow:canvas:node')
    restarted = ArtifactStore(tmp_path, project_id='project')
    assert restarted.create(title='Page', html='<html>first</html>', idempotency_key='workflow:canvas:node') == first
    with pytest.raises(ArtifactConflict):
        restarted.create(title='Page', html='<html>changed</html>', idempotency_key='workflow:canvas:node')
    assert len(store.list()) == 1
    other = restarted.create(title='Page', html='<html>first</html>', idempotency_key='workflow:other:node')
    assert other['id'] != first['id']


def test_update_idempotency_survives_restart_without_creating_another_version(tmp_path):
    store = ArtifactStore(tmp_path)
    first = store.create(title='Page', html='<html>first</html>')
    updated = store.update(
        first['id'], title='Page 2', html='<html>second</html>', base_version=1,
        idempotency_key='html-generation:canvas:node:task-1',
    )

    restarted = ArtifactStore(tmp_path)
    repeated = restarted.update(
        first['id'], title='Page 2', html='<html>second</html>', base_version=1,
        idempotency_key='html-generation:canvas:node:task-1',
    )

    assert repeated == updated
    assert [item['version'] for item in restarted.versions(first['id'])] == [2, 1]
    with pytest.raises(ArtifactConflict):
        restarted.update(
            first['id'], title='Changed', html='<html>different</html>', base_version=1,
            idempotency_key='html-generation:canvas:node:task-1',
        )
