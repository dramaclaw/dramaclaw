"""Project-local HTML revisions and portable, strictly local media exports.

Immutable HTML files are published by revision metadata committed last.
The canvas mutex port provides deployment-specific writer serialization.
"""
from __future__ import annotations

import base64
import mimetypes
import os
import stat
from contextlib import contextmanager
from datetime import datetime, timezone
from html import escape
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
from time import monotonic
from urllib.parse import quote, unquote, urlsplit
import uuid
import zipfile

MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_PREVIEW_BYTES = 16 * 1024 * 1024
MAX_EXPORT_BYTES = 100 * 1024 * 1024
EXPORT_COPY_CHUNK_BYTES = 1024 * 1024
# The EE mutex lease lasts 60 seconds; refresh well inside that window while a
# large archive is copied. The CE file-lock guard implements this as a no-op.
EXPORT_LEASE_REFRESH_SECONDS = 20
# A waiter shares the first builder's cached result. Allow enough time for the
# full 100 MiB budget on a slow project mount before returning CanvasLockBusy.
EXPORT_LOCK_WAIT_SECONDS = 300
_ID = re.compile(r'[a-zA-Z0-9_-]{1,64}\Z')
_MEDIA = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.woff', '.woff2', '.ttf'}


class ArtifactConflict(ValueError):
    """The supplied base revision is no longer current."""


class ArtifactStore:
    def __init__(self, project_dir: Path, *, project_id: str = '', owner_username: str = '', project_name: str = ''):
        self.project_dir = Path(project_dir).resolve()
        self.project_id = project_id
        self.owner_username = owner_username
        self.project_name = project_name
        self.root = self.project_dir / 'freezone' / '_html_artifacts'

    @property
    def _scope(self) -> str:
        return hashlib.sha256((self.project_id or str(self.project_dir)).encode()).hexdigest()

    def _regular(self, path: Path) -> None:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError('Artifact storage must use regular files')

    @contextmanager
    def _directory_fd(self, directory: Path):
        descriptors = []
        try:
            fd = os.open(self.project_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.append(fd)
            for part in directory.relative_to(self.project_dir).parts:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                descriptors.append(fd)
            yield fd
        except OSError as exc:
            raise ValueError('Artifact storage is missing, unreadable, or contains a symlink') from exc
        finally:
            for fd in reversed(descriptors):
                os.close(fd)

    def _read_text(self, path: Path, limit: int) -> str:
        self._regular(path)
        with self._directory_fd(path.parent) as directory:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                    raise ValueError('Invalid artifact file type or size')
                content = stream.read(limit + 1)
                if len(content) > limit:
                    raise ValueError('Artifact file exceeds size limit')
                return content.decode('utf-8')

    @contextmanager
    def _locked(self):
        from novelvideo.ports import get_canvas_write_mutex
        self.project_dir.mkdir(parents=True, exist_ok=True)
        for directory in (self.project_dir / 'freezone', self.root):
            if directory.is_symlink():
                raise ValueError('Artifact storage contains a symlink')
            directory.mkdir(exist_ok=True)
        with get_canvas_write_mutex().write_mutex(self.project_dir, 'html_artifacts') as guard:
            yield guard

    @staticmethod
    def _validate_id(artifact_id: str):
        if not _ID.fullmatch(artifact_id):
            raise ValueError('Invalid artifact ID')

    @staticmethod
    def _validate(title: str, html: str):
        if not title.strip() or len(title) > 200:
            raise ValueError('Title must contain 1–200 characters')
        if len(html.encode('utf-8')) > MAX_HTML_BYTES:
            raise ValueError('HTML exceeds 2 MiB')

    def _directory(self, artifact_id: str) -> Path:
        self._validate_id(artifact_id)
        directory = self.root / artifact_id
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError('Artifact storage contains a symlink or invalid directory')
        return directory

    def _rows(self, artifact_id: str) -> list[dict]:
        directory = self._directory(artifact_id)
        rows = []
        for entry in directory.glob('*.json'):
            self._regular(entry)
            row = json.loads(self._read_text(entry, 16384))
            required = ('id', 'title', 'created_at', 'updated_at', 'file', 'sha256', 'scope')
            if not isinstance(row, dict) or any(not isinstance(row.get(key), str) for key in required):
                raise ValueError('Invalid artifact revision metadata')
            if row.get('scope') != self._scope:
                raise ValueError('Artifact storage scope mismatch')
            if row.get('id') != artifact_id or not isinstance(row.get('version'), int) or row['version'] < 1 or entry.name != str(row['version']) + '.json':
                raise ValueError('Invalid artifact revision metadata')
            self._validate_id(row.get('file', '').removesuffix('.html'))
            if not row['file'].endswith('.html'):
                raise ValueError('Invalid artifact revision file')
            rows.append(row)
        return sorted(rows, key=lambda row: row['version'], reverse=True)

    def _get(self, artifact_id: str, version: int | None = None) -> dict:
        if version is not None and version < 1:
            raise ValueError('Version must be positive')
        rows = [row for row in self._rows(artifact_id) if version is None or row['version'] == version]
        if not rows:
            raise FileNotFoundError('Artifact or revision not found')
        row = dict(rows[0])
        file = self._directory(artifact_id) / row.pop('file')
        self._regular(file)
        html = self._read_text(file, MAX_HTML_BYTES)
        if hashlib.sha256(html.encode()).hexdigest() != row.pop('sha256'):
            raise ValueError('Artifact revision content mismatch')
        row.pop('scope')
        row.pop('update_idempotency_hash', None)
        row.pop('update_request_hash', None)
        return dict(row, html=html)

    def _publish(self, row: dict, guard) -> dict:
        self._validate(row['title'], row['html'])
        directory = self._directory(row['id'])
        directory.mkdir(exist_ok=True)
        file = directory / (uuid.uuid4().hex + '.html')
        metadata = directory / (str(row['version']) + '.json')
        self._regular(metadata)
        if metadata.exists():
            raise ArtifactConflict('Artifact revision already exists')
        temporary = directory / ('.' + uuid.uuid4().hex + '.tmp')
        try:
            with file.open('x', encoding='utf-8') as stream:
                stream.write(row['html'])
                stream.flush()
                os.fsync(stream.fileno())
            payload = {key: value for key, value in row.items() if key != 'html'}
            payload.update(scope=self._scope, file=file.name, sha256=hashlib.sha256(row['html'].encode()).hexdigest())
            with temporary.open('x', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            guard.reassert()
            os.replace(temporary, metadata)
        finally:
            temporary.unlink(missing_ok=True)
        return dict(row)

    def create(self, *, title: str, html: str, idempotency_key: str | None = None) -> dict:
        self._validate(title, html)
        if idempotency_key is not None and (not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 256):
            raise ValueError('Invalid idempotency key')
        artifact_id = hashlib.sha256(f'{self._scope}:{idempotency_key}'.encode()).hexdigest() if idempotency_key else uuid.uuid4().hex
        with self._locked() as guard:
            if idempotency_key and self._rows(artifact_id):
                original = self._get(artifact_id, 1)
                if original['title'] != title.strip() or original['html'] != html:
                    raise ArtifactConflict(f'Create request already saved as artifact {artifact_id}; recover it before retrying with different content')
                return self._get(artifact_id)
            now = datetime.now(timezone.utc).isoformat()
            return self._publish(dict(id=artifact_id, title=title.strip(), html=html, version=1, created_at=now, updated_at=now), guard)

    def find_creation(self, idempotency_key: str) -> dict | None:
        if not 1 <= len(idempotency_key) <= 256:
            raise ValueError('Invalid idempotency key')
        artifact_id = hashlib.sha256(f'{self._scope}:{idempotency_key}'.encode()).hexdigest()
        with self._locked():
            return self._get(artifact_id) if self._rows(artifact_id) else None

    def get(self, artifact_id: str, version: int | None = None) -> dict:
        self._validate_id(artifact_id)
        with self._locked():
            return self._get(artifact_id, version)

    def list(self) -> list[dict]:
        with self._locked():
            rows = []
            for directory in self.root.iterdir():
                if directory.is_dir():
                    revisions = self._rows(directory.name)
                    if revisions:
                        rows.append({key: revisions[0][key] for key in ('id', 'title', 'version', 'created_at', 'updated_at')})
            return sorted(rows, key=lambda row: row['updated_at'], reverse=True)

    def versions(self, artifact_id: str) -> list[dict]:
        with self._locked():
            self._get(artifact_id)
            return [dict(version=row['version'], title=row['title'], created_at=row['updated_at']) for row in self._rows(artifact_id)]

    def update(
        self,
        artifact_id: str,
        *,
        title: str,
        html: str,
        base_version: int,
        idempotency_key: str | None = None,
    ) -> dict:
        self._validate(title, html)
        if idempotency_key is not None and (
            not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 256
        ):
            raise ValueError('Invalid idempotency key')
        key_hash = (
            hashlib.sha256(
                f'{self._scope}:{artifact_id}:update:{idempotency_key}'.encode()
            ).hexdigest()
            if idempotency_key
            else None
        )
        request_hash = hashlib.sha256(
            json.dumps(
                {
                    'title': title.strip(),
                    'html': html,
                    'base_version': base_version,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(',', ':'),
            ).encode()
        ).hexdigest()
        with self._locked() as guard:
            if key_hash:
                previous = next(
                    (
                        row for row in self._rows(artifact_id)
                        if row.get('update_idempotency_hash') == key_hash
                    ),
                    None,
                )
                if previous:
                    if previous.get('update_request_hash') != request_hash:
                        raise ArtifactConflict(
                            'Update request was already saved with different content'
                        )
                    return self._get(artifact_id, previous['version'])
            current = self._get(artifact_id)
            if current['version'] != base_version:
                raise ArtifactConflict('Artifact changed; reload the latest revision before saving')
            saved = self._publish(
                dict(
                    current,
                    title=title.strip(),
                    html=html,
                    version=base_version + 1,
                    updated_at=datetime.now(timezone.utc).isoformat(),
                    **(
                        {
                            'update_idempotency_hash': key_hash,
                            'update_request_hash': request_hash,
                        }
                        if key_hash
                        else {}
                    ),
                ),
                guard,
            )
            return self._get(artifact_id, saved['version'])

    def restore(self, artifact_id: str, *, version: int, base_version: int) -> dict:
        with self._locked() as guard:
            current = self._get(artifact_id)
            if current['version'] != base_version:
                raise ArtifactConflict('Artifact changed; reload the latest revision before restoring')
            old = self._get(artifact_id, version)
            return self._publish(dict(current, title=old['title'], html=old['html'], version=base_version + 1, updated_at=datetime.now(timezone.utc).isoformat()), guard)

    def preview(self, artifact_id: str, version: int | None = None) -> dict:
        artifact = self.get(artifact_id, version)
        parser = _PreviewHTML(self)
        parser.feed(artifact['html'])
        parser.close()
        return {'html': ''.join(parser.output), 'warnings': parser.warnings, 'resources': parser.manifest}

    def export_file(self, artifact_id: str, version: int | None = None) -> Path:
        artifact = self.get(artifact_id, version)
        directory = self._directory(artifact_id) / 'exports'

        def cached():
            if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
                raise ValueError('Invalid export directory')
            target = directory / f"v{artifact['version']}.zip"
            self._regular(target)
            return target

        from novelvideo.ports import get_canvas_write_mutex
        lock_id = 'html_export_' + hashlib.sha256(
            f"{artifact_id}:{artifact['version']}".encode()
        ).hexdigest()[:40]
        with get_canvas_write_mutex().write_mutex(
            self.project_dir,
            lock_id,
            timeout_seconds=EXPORT_LOCK_WAIT_SECONDS,
        ) as guard:
            target = cached()
            if target.exists():
                return target
            directory.mkdir(exist_ok=True)
            temporary = directory / ('.' + uuid.uuid4().hex + '.tmp')
            try:
                with temporary.open('xb') as stream:
                    self._write_export(stream, artifact, guard.reassert)
                    stream.flush()
                    os.fsync(stream.fileno())
                guard.reassert()
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            return target

    def _write_export(self, stream, artifact: dict, reassert) -> None:
        parser = _PortableHTML(self)
        parser.feed(artifact['html'])
        parser.close()
        copied = 0
        next_reassert = monotonic() + EXPORT_LEASE_REFRESH_SECONDS
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr(
                'index.html',
                ''.join(parser.output),
                compress_type=zipfile.ZIP_DEFLATED,
            )
            for name, candidate, expected in parser.resources.values():
                with parser.open_resource(candidate) as (source, info):
                    if parser.file_identity(info) != expected:
                        raise ValueError('Media changed during export; retry')
                    info = zipfile.ZipInfo(name)
                    info.compress_type = zipfile.ZIP_STORED
                    with archive.open(info, 'w') as destination:
                        while True:
                            chunk = source.read(EXPORT_COPY_CHUNK_BYTES)
                            if not chunk:
                                break
                            copied += len(chunk)
                            if copied > MAX_EXPORT_BYTES:
                                raise ValueError('Export resources exceed 100 MiB')
                            destination.write(chunk)
                            if monotonic() >= next_reassert:
                                reassert()
                                next_reassert = monotonic() + EXPORT_LEASE_REFRESH_SECONDS
                    if parser.file_identity(os.fstat(source.fileno())) != expected:
                        raise ValueError('Media changed during export; retry')


class _PortableHTML(HTMLParser):
    """Rewrite declarative media; unsupported dependencies fail explicitly."""
    def __init__(self, store: ArtifactStore):
        super().__init__(convert_charrefs=False)
        self.store = store
        self.output: list[str] = []
        self.resources: dict[str, tuple[str, Path, tuple[int, int, int, int]]] = {}
        self.in_style = False
        self.total_bytes = 0

    def resource(self, value: str) -> str:
        value = value.strip()
        if value.startswith('#') or value.startswith(('data:image/png;', 'data:image/jpeg;', 'data:image/webp;', 'data:image/gif;')):
            return value
        candidate, parts = self.media_path(value)
        key = str(candidate.resolve())
        if key not in self.resources:
            with self.open_resource(candidate) as (_, info):
                self.total_bytes += info.st_size
            if self.total_bytes > MAX_EXPORT_BYTES:
                raise ValueError('Export resources exceed 100 MiB')
            name = 'assets/' + hashlib.sha256(key.encode()).hexdigest()[:24] + candidate.suffix.lower()
            self.resources[key] = (name, candidate, self.file_identity(info))
        return self.resources[key][0] + ('#' + parts.fragment if parts.fragment else '')

    @staticmethod
    def file_identity(info: os.stat_result) -> tuple[int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    @contextmanager
    def open_resource(self, candidate: Path):
        """Open one project resource without following a swapped symlink."""
        descriptors = []
        try:
            try:
                fd = os.open(
                    self.store.project_dir,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                )
                descriptors.append(fd)
                components = candidate.relative_to(self.store.project_dir).parts
                for component in components[:-1]:
                    fd = os.open(
                        component,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=fd,
                    )
                    descriptors.append(fd)
                media_fd = os.open(
                    components[-1],
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=fd,
                )
                descriptors.append(media_fd)
                info = os.fstat(media_fd)
            except OSError as exc:
                raise ValueError(
                    'Media path is missing, unreadable, or contains a symlink'
                ) from exc
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Media must be a regular file')
            with os.fdopen(os.dup(media_fd), 'rb') as stream:
                yield stream, info
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def media_path(self, value: str):
        parts = urlsplit(value)
        if not value or parts.scheme or parts.netloc or '\\' in value:
            raise ValueError('不支持的媒体资源（仅支持当前项目媒体或内嵌图片）：' + value)
        path = unquote(parts.path)
        if path.startswith('/api/v1/projects/'):
            prefix = f'/api/v1/projects/{self.store.project_id}/media/'
            if not self.store.project_id or not path.startswith(prefix):
                raise ValueError('Media belongs to a different project')
            path = path[len(prefix):]
        elif path.startswith('/static/'):
            prefixes = [f'/static/projects/{self.store.project_id}/'] if self.store.project_id else []
            if self.store.owner_username and self.store.project_name:
                prefixes.append(f'/static/{self.store.owner_username}/{self.store.project_name}/')
            prefix = next((p for p in prefixes if path.startswith(p)), None)
            if prefix is None:
                raise ValueError('Media belongs to a different project')
            path = path[len(prefix):]
        candidate = self.store.project_dir / path.lstrip('/')
        if '..' in Path(path).parts or '\\' in path or not candidate.resolve().is_relative_to(self.store.project_dir):
            raise ValueError('Unsafe media path')
        if candidate.suffix.lower() not in _MEDIA or not candidate.is_file():
            raise ValueError('Missing or unsupported media resource')
        return candidate, parts

    def css(self, value: str) -> str:
        value = re.sub(r'/\*.*?\*/', '', value, flags=re.S)
        if '\\' in value or re.search(r'@import|image-set\s*\(', value, re.I):
            raise ValueError('Unsupported CSS resource syntax; inline CSS and use url()')
        pattern = r'url\(\s*([\'"]?)(.*?)\1\s*\)'
        if re.search(r'url\s*\(', re.sub(pattern, '', value, flags=re.I | re.S), re.I):
            raise ValueError('Unsupported unterminated CSS URL')
        return re.sub(r'url\(\s*([\'"]?)(.*?)\1\s*\)', lambda m: 'url("' + self.resource(m[2]) + '")', value, flags=re.I | re.S)

    def navigation(self, value: str) -> str:
        value = value.strip()
        if any(ord(char) < 32 or ord(char) == 127 for char in value) or '\\' in value:
            raise ValueError('链接包含不支持的控制字符')
        if value.startswith('#') or urlsplit(value).scheme.lower() in {'http', 'https', 'mailto', 'tel'}:
            return value
        raise ValueError('不支持的跳转链接：' + value)

    def handle_starttag(self, tag, attrs):
        if tag in {'base', 'iframe', 'object', 'embed', 'link'}:
            raise ValueError(f'Unsupported export element: {tag}')
        result = []
        for key, value in attrs:
            if key in {'srcset', 'imagesrcset', 'background', 'manifest', 'ping'}:
                raise ValueError(f'Unsupported resource attribute: {key}')
            if value is not None and key in {'src', 'poster', 'href', 'xlink:href', 'action', 'formaction'}:
                if tag == 'script' or key in {'action', 'formaction'}:
                    raise ValueError('Export requires inline scripts and no form endpoints')
                value = self.navigation(value) if tag in {'a', 'area'} and key == 'href' else self.resource(value)
            elif key == 'style' and value is not None:
                value = self.css(value)
            result.append(key if value is None else f'{key}="{escape(value, quote=True)}"')
        self.output.append('<' + tag + (' ' + ' '.join(result) if result else '') + '>')
        if tag == 'style':
            self.in_style = True

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.output[-1] = self.output[-1][:-1] + '/>'

    def handle_endtag(self, tag):
        self.output.append(f'</{tag}>')
        if tag == 'style':
            self.in_style = False

    def handle_data(self, data):
        self.output.append(self.css(data) if self.in_style else data)

    def handle_decl(self, decl):
        self.output.append(f'<!{decl}>')

    def handle_entityref(self, name):
        self.output.append(f'&{name};')

    def handle_charref(self, name):
        self.output.append(f'&#{name};')

    def handle_comment(self, data):
        self.output.append(f'<!--{data}-->')


class PreviewTooLarge(ValueError):
    pass


class _PreviewOutput(list):
    def __init__(self):
        super().__init__()
        self.bytes = 0

    def append(self, value):
        size = len(value.encode('utf-8'))
        if self.bytes + size > MAX_PREVIEW_BYTES:
            raise PreviewTooLarge('Preview exceeds 16 MiB; reduce embedded media')
        self.bytes += size
        super().append(value)


class _PreviewHTML(_PortableHTML):
    """Embed allowed resources; the caller must still apply an isolated iframe CSP."""
    def __init__(self, store: ArtifactStore):
        super().__init__(store)
        self.warnings: list[str] = []
        self.output = _PreviewOutput()
        self.embedded_bytes = 0
        self.manifest: list[dict[str, str]] = []

    def resource(self, value: str) -> str:
        try:
            if self.store.project_id and not value.strip().startswith(('#', 'data:')):
                candidate, parts = self.media_path(value.strip())
                relative = candidate.relative_to(self.store.project_dir)
                if any(part.is_symlink() for part in [candidate, *candidate.parents] if part != self.store.project_dir.parent):
                    raise ValueError('Media path contains a symlink')
                path = '/api/v1/projects/' + quote(self.store.project_id, safe='') + '/media/' + quote(relative.as_posix(), safe='/')
                placeholder = 'html-media-' + hashlib.sha256(path.encode()).hexdigest()
                entry = {'placeholder': placeholder, 'path': path}
                if entry not in self.manifest:
                    if len(self.manifest) >= 128:
                        raise PreviewTooLarge('Preview exceeds 128 media resources')
                    self.manifest.append(entry)
                return placeholder + ('#' + parts.fragment if parts.fragment else '')
            rewritten = super().resource(value)
            if rewritten.startswith(('#', 'data:')):
                return rewritten
            name = rewritten.split('#', 1)[0]
            candidate = next(
                candidate
                for resource_name, candidate, _ in self.resources.values()
                if resource_name == name
            )
            mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
            with self.open_resource(candidate) as (stream, info):
                size = ((info.st_size + 2) // 3) * 4 + 128
                if self.embedded_bytes + size > MAX_PREVIEW_BYTES:
                    raise PreviewTooLarge('Preview exceeds 16 MiB; reduce embedded media')
                content = stream.read(info.st_size + 1)
            size = ((len(content) + 2) // 3) * 4 + 128
            if self.embedded_bytes + size > MAX_PREVIEW_BYTES:
                raise PreviewTooLarge('Preview exceeds 16 MiB; reduce embedded media')
            self.embedded_bytes += size
            return f'data:{mime};base64,' + base64.b64encode(content).decode('ascii')
        except ValueError as exc:
            if isinstance(exc, PreviewTooLarge):
                raise
            self.warnings.append(str(exc))
            return 'about:blank'

    def css(self, value: str) -> str:
        try:
            return super().css(value)
        except ValueError as exc:
            if isinstance(exc, PreviewTooLarge):
                raise
            self.warnings.append(str(exc))
            return ''

    def handle_starttag(self, tag, attrs):
        try:
            super().handle_starttag(tag, attrs)
        except ValueError as exc:
            if isinstance(exc, PreviewTooLarge):
                raise
            self.warnings.append(str(exc))
            self.output.append('<!-- unsupported dependency omitted -->')
