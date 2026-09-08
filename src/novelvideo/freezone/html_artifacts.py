"""Project-local HTML revisions and portable, strictly local media exports.

SQLite transactions are the cross-process writer lock and atomic commit boundary:
there is no mutable head file that can disagree with immutable revision rows.
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
import io
from pathlib import Path
import re
import sqlite3
from urllib.parse import unquote, urlsplit
import uuid
import zipfile

MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_PREVIEW_BYTES = 16 * 1024 * 1024
MAX_EXPORT_BYTES = 100 * 1024 * 1024
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
        self.path = self.project_dir / 'freezone' / '_html_artifacts' / 'artifacts.sqlite3'

    @contextmanager
    def _db(self, *, write: bool = False):
        # Refuse symlinked storage, including SQLite journal sidecars.
        for directory in (self.project_dir / 'freezone', self.path.parent):
            if directory.is_symlink():
                raise ValueError('Artifact storage contains a symlink')
            directory.mkdir(exist_ok=True)
        for suffix in ('', '-journal', '-wal', '-shm'):
            entry = Path(str(self.path) + suffix)
            if entry.is_symlink() or (entry.exists() and not entry.is_file()):
                raise ValueError('Artifact storage must use regular files')
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            scope = hashlib.sha256((self.project_id or str(self.project_dir)).encode()).hexdigest()
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if tables:
                if 'artifact_scope' not in tables:
                    raise ValueError('Artifact storage scope missing')
                bound = db.execute('SELECT scope FROM artifact_scope').fetchone()
                if bound is None or bound[0] != scope:
                    raise ValueError('Artifact storage scope mismatch')
            else:
                db.execute('CREATE TABLE artifact_scope (scope TEXT NOT NULL)')
                db.execute('INSERT INTO artifact_scope VALUES (?)', (scope,))
            db.execute('CREATE TABLE IF NOT EXISTS revisions (id TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(id, version))')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

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

    def _get(self, db, artifact_id: str, version: int | None = None) -> dict:
        self._validate_id(artifact_id)
        if version is not None and version < 1:
            raise ValueError('Version must be positive')
        row = db.execute('SELECT * FROM revisions WHERE id=?' + (' AND version=?' if version is not None else '') + ' ORDER BY version DESC LIMIT 1', (artifact_id, version) if version is not None else (artifact_id,)).fetchone()
        if row is None:
            raise FileNotFoundError('Artifact or revision not found')
        return dict(row)

    def _insert(self, db, artifact_id: str, title: str, html: str, version: int, created_at: str) -> dict:
        self._validate(title, html)
        now = datetime.now(timezone.utc).isoformat()
        db.execute('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?)', (artifact_id, title.strip(), version, html, created_at, now))
        return self._get(db, artifact_id, version)

    def create(self, *, title: str, html: str) -> dict:
        with self._db(write=True) as db:
            return self._insert(db, uuid.uuid4().hex, title, html, 1, datetime.now(timezone.utc).isoformat())

    def get(self, artifact_id: str, version: int | None = None) -> dict:
        self._validate_id(artifact_id)
        with self._db() as db:
            return self._get(db, artifact_id, version)

    def list(self) -> list[dict]:
        with self._db() as db:
            return [dict(row) for row in db.execute('SELECT id,title,version,created_at,updated_at FROM revisions r WHERE version=(SELECT MAX(version) FROM revisions WHERE id=r.id) ORDER BY updated_at DESC')]

    def versions(self, artifact_id: str) -> list[dict]:
        with self._db() as db:
            self._get(db, artifact_id)
            return [dict(row) for row in db.execute('SELECT version,title,updated_at AS created_at FROM revisions WHERE id=? ORDER BY version DESC', (artifact_id,))]

    def update(self, artifact_id: str, *, title: str, html: str, base_version: int) -> dict:
        with self._db(write=True) as db:
            current = self._get(db, artifact_id)
            if current['version'] != base_version:
                raise ArtifactConflict('Artifact changed; reload the latest revision before saving')
            return self._insert(db, artifact_id, title, html, base_version + 1, current['created_at'])

    def restore(self, artifact_id: str, *, version: int, base_version: int) -> dict:
        with self._db(write=True) as db:
            current = self._get(db, artifact_id)
            if current['version'] != base_version:
                raise ArtifactConflict('Artifact changed; reload the latest revision before restoring')
            old = self._get(db, artifact_id, version)
            return self._insert(db, artifact_id, old['title'], old['html'], base_version + 1, current['created_at'])

    def preview(self, artifact_id: str, version: int | None = None) -> dict:
        artifact = self.get(artifact_id, version)
        parser = _PreviewHTML(self)
        parser.feed(artifact['html'])
        parser.close()
        return {'html': ''.join(parser.output), 'warnings': parser.warnings}

    def export(self, artifact_id: str, version: int | None = None) -> bytes:
        artifact = self.get(artifact_id, version)
        parser = _PortableHTML(self)
        parser.feed(artifact['html'])
        parser.close()
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('index.html', ''.join(parser.output))
            for name, content in parser.resources.values():
                archive.writestr(name, content)
        return out.getvalue()


class _PortableHTML(HTMLParser):
    """Rewrite declarative media; unsupported dependencies fail explicitly."""
    def __init__(self, store: ArtifactStore):
        super().__init__(convert_charrefs=False)
        self.store = store
        self.output: list[str] = []
        self.resources: dict[str, tuple[str, bytes]] = {}
        self.in_style = False
        self.total_bytes = 0

    def resource(self, value: str) -> str:
        value = value.strip()
        if value.startswith('#') or value.startswith(('data:image/png;', 'data:image/jpeg;', 'data:image/webp;', 'data:image/gif;')):
            return value
        parts = urlsplit(value)
        if not value or parts.scheme or parts.netloc or '\\' in value:
            raise ValueError('Export supports only project-local media and embedded raster images')
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
        key = str(candidate.resolve())
        if key not in self.resources:
            # Resolve each component through directory descriptors. O_NOFOLLOW
            # closes symlink-swap races between validation and reading a file.
            descriptors = []
            try:
                fd = os.open(self.store.project_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                descriptors.append(fd)
                components = candidate.relative_to(self.store.project_dir).parts
                for component in components[:-1]:
                    fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    descriptors.append(fd)
                media_fd = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                descriptors.append(media_fd)
                info = os.fstat(media_fd)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('Media must be a regular file')
                if info.st_size + self.total_bytes > MAX_EXPORT_BYTES:
                    raise ValueError('Export resources exceed 100 MiB')
                with os.fdopen(os.dup(media_fd), 'rb') as stream:
                    content = stream.read(MAX_EXPORT_BYTES - self.total_bytes + 1)
            except OSError as exc:
                raise ValueError('Media path is missing, unreadable, or contains a symlink') from exc
            finally:
                for descriptor in reversed(descriptors):
                    os.close(descriptor)
            self.total_bytes += len(content)
            if self.total_bytes > MAX_EXPORT_BYTES:
                raise ValueError('Export resources exceed 100 MiB')
            name = 'assets/' + hashlib.sha256(key.encode()).hexdigest()[:24] + candidate.suffix.lower()
            self.resources[key] = (name, content)
        return self.resources[key][0] + ('#' + parts.fragment if parts.fragment else '')

    def css(self, value: str) -> str:
        value = re.sub(r'/\*.*?\*/', '', value, flags=re.S)
        if '\\' in value or re.search(r'@import|image-set\s*\(', value, re.I):
            raise ValueError('Unsupported CSS resource syntax; inline CSS and use url()')
        pattern = r'url\(\s*([\'"]?)(.*?)\1\s*\)'
        if re.search(r'url\s*\(', re.sub(pattern, '', value, flags=re.I | re.S), re.I):
            raise ValueError('Unsupported unterminated CSS URL')
        return re.sub(r'url\(\s*([\'"]?)(.*?)\1\s*\)', lambda m: 'url("' + self.resource(m[2]) + '")', value, flags=re.I | re.S)

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
                value = self.resource(value)
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

    def resource(self, value: str) -> str:
        try:
            rewritten = super().resource(value)
            if rewritten.startswith(('#', 'data:')):
                return rewritten
            name = rewritten.split('#', 1)[0]
            content = next(content for resource_name, content in self.resources.values() if resource_name == name)
            mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
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
