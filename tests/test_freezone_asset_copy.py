"""跨项目粘贴：后端把源项目文件拷进目标项目，前端不再「下载一遍再上传一遍」。

之前的链路是浏览器 fetch 源项目 `/static/projects/<src>/…` 再 POST 到目标项目的
`freezone/upload`：字节走两遍、大视频窗口期很长，且后端完全不知道这是一次跨项目
复制，也就没有任何归属校验。现在前端只报「把这些 URL 拷到当前项目」，后端：

- 解析 URL 得到源项目 id 与项目内相对路径（只认同源的 canonical 形式）；
- 对源项目校验 viewer、对目标项目校验 editor；
- 优先让 OSS 在服务端 CopyObject（字节不经过 pod），OSS 不可用 / 对象未就绪 /
  拷完在挂载点上看不见时回退成文件系统拷贝；
- 返回旧 URL → 新 URL 的映射，单条失败只记进 `failed`，不拖累整批。
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path
from types import SimpleNamespace

from oss2.utils import Crc64

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from novelvideo import config
from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import FreezoneAssetCopyRequest
from novelvideo.freezone import asset_copy
from novelvideo.ports.project import require_role_value
from novelvideo.project_context import ProjectContext
from novelvideo.utils import oss_client

# ---------------------------------------------------------------------------
# URL 解析
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "/static/projects/proj_a/freezone/_uploads/a.png?v=123",
            ("proj_a", "freezone/_uploads/a.png"),
        ),
        ("/static/projects/proj%20a/dir/b%20c.mp4", ("proj a", "dir/b c.mp4")),
        ("/static/projects/proj_a/dir/c.png#frag", ("proj_a", "dir/c.png")),
        ("/api/v1/projects/proj_a/media/dir/c.png", ("proj_a", "dir/c.png")),
    ],
)
def test_parse_project_asset_url_accepts_canonical_same_origin_forms(url, expected):
    assert asset_copy.parse_project_asset_url(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/static/projects/proj_a/x.png",
        "//evil.example/static/projects/proj_a/x.png",
        "http://[",
        "http://[::1/static/projects/proj_a/x.png",
        "/static/alice/demo/legacy.png",
        "/static/projects/proj_a",
        "/static/projects/proj_a/",
        "/static/projects/proj_a/dir\\x.png",
        "/static/projects/proj_a/freezone/_uploads/bad%00.png",
        "/static/projects/proj%00a/freezone/_uploads/x.png",
        "/static/projects/proj_a/freezone/_uploads/x%0a.png",
        "/api/v1/projects/proj_a/files/x.png",
        "data:image/png;base64,AAAA",
        "blob:https://app.example/abc",
        "",
        "   ",
    ],
)
def test_parse_project_asset_url_rejects_everything_else(url):
    assert asset_copy.parse_project_asset_url(url) is None


# ---------------------------------------------------------------------------
# 源文件定位（防目录穿越）
# ---------------------------------------------------------------------------


def test_resolve_source_file_rejects_paths_escaping_the_project(tmp_path: Path):
    project_dir = tmp_path / "output" / "alice" / "demo"
    (project_dir / "freezone").mkdir(parents=True)
    (tmp_path / "output" / "secret.txt").write_bytes(b"nope")

    with pytest.raises(asset_copy.AssetCopyError) as excinfo:
        asset_copy.resolve_source_file(project_dir, "../secret.txt")
    assert excinfo.value.reason == "invalid_source"


def test_resolve_source_file_rejects_missing_or_non_regular_files(tmp_path: Path):
    project_dir = tmp_path / "output" / "alice" / "demo"
    (project_dir / "freezone").mkdir(parents=True)

    with pytest.raises(asset_copy.AssetCopyError) as missing:
        asset_copy.resolve_source_file(project_dir, "freezone/nope.png")
    assert missing.value.reason == "not_found"

    with pytest.raises(asset_copy.AssetCopyError) as directory:
        asset_copy.resolve_source_file(project_dir, "freezone")
    assert directory.value.reason == "not_found"


def test_resolve_source_file_turns_path_errors_into_per_source_failures(tmp_path: Path):
    """空字节、超长文件名这类 Path 层面的异常也只算这一条失败，不能往上炸。"""
    project_dir = tmp_path / "output" / "alice" / "demo"
    (project_dir / "freezone").mkdir(parents=True)

    with pytest.raises(asset_copy.AssetCopyError) as null_byte:
        asset_copy.resolve_source_file(project_dir, "freezone/bad\x00.png")
    assert null_byte.value.reason == "invalid_source"

    with pytest.raises(asset_copy.AssetCopyError) as too_long:
        asset_copy.resolve_source_file(project_dir, "freezone/" + "x" * 300 + ".png")
    assert too_long.value.reason in {"invalid_source", "not_found"}


# ---------------------------------------------------------------------------
# 目标命名
# ---------------------------------------------------------------------------


def test_allocate_target_path_bounds_the_filename_length(tmp_path: Path):
    """234 字节的源文件名本身合法，加上时间戳前缀就超 255 了；截短而不是让 exists() 炸。"""
    long_name = "x" * 230 + ".png"
    target = asset_copy.allocate_target_path(tmp_path, long_name)

    assert target.parent == tmp_path
    assert not target.exists()
    assert target.name.endswith(".png")
    assert len(target.name.encode()) <= 255
    # 时间戳前缀之后紧跟被截短的原名。
    assert target.name.split("_", 3)[3].startswith("xxxxxxxx")


def test_allocate_target_path_keeps_short_names_intact(tmp_path: Path):
    target = asset_copy.allocate_target_path(tmp_path, "clip.mp4")
    assert target.name.endswith("_clip.mp4")


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("a.png", "a.png"),
        ("x" * 124 + ".png", "x" * 116 + ".png"),
        ("x" * 200, "x" * 120),
        ("x" * 200 + "." + "y" * 40, "x" * 120),
        ("", "upload"),
    ],
)
def test_bounded_upload_basename(name, expected):
    assert asset_copy.bounded_upload_basename(name) == expected


# ---------------------------------------------------------------------------
# 拷贝：OSS 直拷优先，文件系统回退
# ---------------------------------------------------------------------------


class _FakeBucket:
    """够用的 oss2.Bucket 替身：CopyObject 后（可选）在挂载点上「显形」目标文件。

    `remote` 指定 OSS 上真正存着的字节（默认与挂载点上的源文件一致），`remote_mtime`
    指定对象的 Last-Modified（默认「现在」，即已写回）。`crc` / `etag` 控制 head 里带哪些
    校验和：默认两者都按远端字节算；`etag="multipart"` 模拟分片上传的 `<md5>-<n>` 形式。
    """

    bucket_name = "bkt"

    def __init__(
        self,
        *,
        materialize: bool = True,
        exists: bool = True,
        remote: bytes | None = None,
        remote_mtime: float | None = None,
        crc: bool = True,
        etag: bool | str = True,
    ):
        self.copies: list[tuple[str, str, str]] = []
        self.heads: list[str] = []
        self.materialize = materialize
        self.exists = exists
        self.remote = remote
        self.remote_mtime = remote_mtime
        self.crc = crc
        self.etag = etag

    @staticmethod
    def _local(key: str) -> Path:
        prefix = str(config.OSS_OBJECT_PREFIX).strip("/") + "/"
        return Path(config.OUTPUT_DIR) / key[len(prefix) :]

    def _remote_bytes(self, key: str) -> bytes:
        return self.remote if self.remote is not None else self._local(key).read_bytes()

    def head_object(self, key: str):
        self.heads.append(key)
        if not self.exists:
            raise RuntimeError("NoSuchKey")
        data = self._remote_bytes(key)
        crc = Crc64()
        crc.update(data)
        md5 = hashlib.md5(data, usedforsecurity=False).hexdigest().upper()
        if self.etag == "multipart":
            etag = f'"{md5}-3"'
        elif self.etag:
            etag = f'"{md5}"'
        else:
            etag = None
        return SimpleNamespace(
            content_length=len(data),
            last_modified=self.remote_mtime if self.remote_mtime is not None else time.time(),
            etag=etag,
            _server_crc=int(crc.crc) if self.crc else None,
            headers={},
        )

    def copy_object(self, source_bucket_name, source_key, target_key, headers=None, params=None):
        self.copies.append((source_bucket_name, source_key, target_key))
        if not self.materialize:
            return
        target = self._local(target_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self._remote_bytes(source_key))


def _two_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    output_root = tmp_path / "output"
    monkeypatch.setattr(config, "OUTPUT_DIR", str(output_root))
    monkeypatch.setattr(config, "OSS_OBJECT_PREFIX", "output")
    source = output_root / "alice" / "demo" / "freezone" / "_uploads" / "a.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"png-bytes")
    target = output_root / "bob" / "vlog" / "freezone" / "_uploads" / "copied_a.png"
    return source, target


def test_copy_project_file_uses_filesystem_when_oss_is_unavailable(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_prefers_a_server_side_oss_copy(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket()
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "oss"
    assert bucket.copies == [
        (
            "bkt",
            "output/alice/demo/freezone/_uploads/a.png",
            "output/bob/vlog/freezone/_uploads/copied_a.png",
        )
    ]
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_source_is_not_in_oss_yet(tmp_path, monkeypatch):
    """ossfs 写回有延迟：刚上传的源文件可能还没到 OSS，此时不能 CopyObject。"""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(exists=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


@pytest.mark.parametrize("mtime_offset", [-600, -1, 0, +5])
def test_copy_project_file_falls_back_when_the_oss_object_is_a_stale_same_size_version(
    tmp_path, monkeypatch, mtime_offset
):
    """源文件被原地覆盖、ossfs 还没写回：OSS 上是旧版本且大小相同。只看「对象存在 +
    目标大小对得上」会把旧内容当成功结果永久留在目标项目里；Last-Modified 差一两秒
    甚至比本地更新（时钟偏差）也判不准。判定按内容校验和来，与时间戳无关。"""
    source, target = _two_files(tmp_path, monkeypatch)
    source.write_bytes(b"NEW!")
    bucket = _FakeBucket(remote=b"OLD!", remote_mtime=source.stat().st_mtime + mtime_offset)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"NEW!"


def test_copy_project_file_accepts_a_matching_single_part_etag_without_crc(tmp_path, monkeypatch):
    """没有 CRC 头时退而比 ETag：单次上传的对象 ETag 就是内容 MD5。"""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(crc=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "oss"
    assert len(bucket.copies) == 1
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_only_a_multipart_etag_is_available(
    tmp_path, monkeypatch
):
    """分片上传的 ETag 不是内容 MD5，又没有 CRC → 无法确认版本，回退。"""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(crc=False, etag="multipart")
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_head_carries_no_checksum(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(crc=False, etag=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []


def test_copy_project_file_falls_back_when_the_oss_object_size_differs(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(remote=b"png-bytes-but-longer")
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_bucket_cannot_confirm_the_version(
    tmp_path, monkeypatch
):
    """拿不到 head（老 SDK / 替身没实现）就当不确定：宁可多走一次文件系统拷贝。"""
    source, target = _two_files(tmp_path, monkeypatch)

    class _NoHead:
        bucket_name = "bkt"
        copies: list = []

        def copy_object(self, *args, **kwargs):
            self.copies.append(args)

    bucket = _NoHead()
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert bucket.copies == []
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_the_copy_is_invisible_on_the_mount(
    tmp_path, monkeypatch
):
    """CopyObject 成功但挂载点上看不到目标文件（负缓存等）→ 走文件系统兜底，别返回一个 404 的 URL。"""
    source, target = _two_files(tmp_path, monkeypatch)
    bucket = _FakeBucket(materialize=False)
    monkeypatch.setattr(oss_client, "get_bucket", lambda: bucket)

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert len(bucket.copies) == 1
    assert target.read_bytes() == b"png-bytes"


def test_copy_project_file_falls_back_when_oss_copy_raises(tmp_path, monkeypatch):
    source, target = _two_files(tmp_path, monkeypatch)

    class _Exploding(_FakeBucket):
        def copy_object(self, *args, **kwargs):
            raise RuntimeError("oss down")

    monkeypatch.setattr(oss_client, "get_bucket", lambda: _Exploding())

    assert asset_copy.copy_project_file(source, target) == "filesystem"
    assert target.read_bytes() == b"png-bytes"


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

USER = {"id": "user_bob", "username": "bob"}


def _ctx(tmp_path: Path, project_id: str, *, owner: str, name: str, role: str) -> ProjectContext:
    return ProjectContext(
        project_id=project_id,
        project_name=name,
        owner_type="user",
        owner_id=f"user_{owner}",
        owner_username=owner,
        requester_user_id="user_bob",
        requester_username="bob",
        requester_principals=(("user", "user_bob"),),
        effective_role=role,
        home_node_id="node_a",
        output_dir=tmp_path / "output" / owner / name,
        state_dir=tmp_path / "state" / owner / name,
        runtime_dir=tmp_path / "runtime" / owner / name,
        is_home_node=True,
    )


def _patch_projects(monkeypatch: pytest.MonkeyPatch, ctxs: dict[str, ProjectContext]) -> None:
    """只打桩控制面：角色校验照真函数来，守卫与落盘原样留在链路里。"""

    async def fake_resolve_project_context(
        *, user, project_id=None, project_name=None, required_role="viewer"
    ) -> ProjectContext:
        ctx = ctxs.get(project_id or "")
        if ctx is None:
            raise HTTPException(status_code=404, detail="Project not found")
        require_role_value(ctx.effective_role, required_role)
        return ctx

    monkeypatch.setattr(freezone_routes, "resolve_project_context", fake_resolve_project_context)


def _source_asset(ctx: ProjectContext, rel: str, payload: bytes) -> str:
    path = ctx.output_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return f"/static/projects/{ctx.project_id}/{rel}"


async def test_copy_route_copies_source_assets_into_the_target_uploads_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="viewer")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="editor")
    target_ctx.output_dir.mkdir(parents=True)
    _patch_projects(monkeypatch, {"proj_src": source_ctx, "proj_dst": target_ctx})
    image = _source_asset(source_ctx, "freezone/_uploads/20260101_a.png", b"png-bytes")
    video = _source_asset(source_ctx, "freezone/_outputs/video/clip.mp4", b"mp4-bytes")

    result = await freezone_routes.freezone_copy_assets_from_project(
        project="proj_dst",
        body=FreezoneAssetCopyRequest(sources=[f"{image}?v=1", image, video]),
        user=USER,
    )

    assert result["ok"] is True
    data = result["data"]
    assert data["failed"] == []
    mapping = data["mapping"]
    # 带不带 cache-bust 查询串都要映射到，且同一个源文件只拷一次。
    assert set(mapping) == {f"{image}?v=1", image, video}
    assert mapping[f"{image}?v=1"] == mapping[image]
    for new_url in mapping.values():
        assert new_url.startswith("/static/projects/proj_dst/freezone/_uploads/")

    uploads = sorted((target_ctx.output_dir / "freezone" / "_uploads").iterdir())
    assert [p.read_bytes() for p in uploads] == [b"png-bytes", b"mp4-bytes"]
    assert uploads[0].name.endswith("_20260101_a.png")
    assert uploads[1].name.endswith("_clip.mp4")


async def test_copy_route_reports_per_source_failures_without_failing_the_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="viewer")
    # 请求者不是这个项目的成员：控制面给的角色是空。
    foreign_ctx = _ctx(tmp_path, "proj_foreign", owner="carol", name="private", role="")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="editor")
    target_ctx.output_dir.mkdir(parents=True)
    _patch_projects(
        monkeypatch,
        {"proj_src": source_ctx, "proj_foreign": foreign_ctx, "proj_dst": target_ctx},
    )
    good = _source_asset(source_ctx, "freezone/_uploads/good.png", b"ok")
    forbidden = _source_asset(foreign_ctx, "freezone/_uploads/secret.png", b"secret")
    missing = f"/static/projects/{source_ctx.project_id}/freezone/_uploads/missing.png"
    traversal = f"/static/projects/{source_ctx.project_id}/../../secret.txt"
    unknown_project = "/static/projects/proj_nope/freezone/_uploads/x.png"
    external = "https://cdn.example/x.png"
    already_here = "/static/projects/proj_dst/freezone/_uploads/mine.png"

    result = await freezone_routes.freezone_copy_assets_from_project(
        project="proj_dst",
        body=FreezoneAssetCopyRequest(
            sources=[good, forbidden, missing, traversal, unknown_project, external, already_here]
        ),
        user=USER,
    )

    data = result["data"]
    assert set(data["mapping"]) == {good}
    failed = {item["source"]: item["reason"] for item in data["failed"]}
    assert failed == {
        forbidden: "forbidden",
        missing: "not_found",
        traversal: "invalid_source",
        unknown_project: "not_found",
        external: "invalid_source",
    }
    # 本来就属于目标项目的 URL：既不用拷，也不算失败。
    assert already_here not in data["mapping"]
    assert already_here not in failed
    # 失败的源不能在目标项目留下半成品：目录里只有那一个成功拷过来的文件。
    uploads = list((target_ctx.output_dir / "freezone" / "_uploads").iterdir())
    assert [p.read_bytes() for p in uploads] == [b"ok"]


async def test_copy_route_isolates_preparation_failures_to_the_single_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """准备阶段（解析 URL、定位源文件、给目标起名）炸了也只算那一条失败。

    之前 `http://[` 在 urlsplit 就抛 ValueError、`bad%00.png` 在 resolve 时抛 ValueError、234 字节的合法文件名加上时间戳前缀后
    `exists()` 抛 OSError，都会在任何拷贝开始前终止整批，同批 good.png 也迁不过去。
    """
    monkeypatch.setattr(oss_client, "get_bucket", lambda: None)
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="viewer")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="editor")
    target_ctx.output_dir.mkdir(parents=True)
    _patch_projects(monkeypatch, {"proj_src": source_ctx, "proj_dst": target_ctx})
    good = _source_asset(source_ctx, "freezone/_uploads/good.png", b"ok")
    long_name = "x" * 230 + ".png"
    assert len(long_name) == 234
    long_asset = _source_asset(source_ctx, f"freezone/_uploads/{long_name}", b"long")
    null_byte = f"/static/projects/{source_ctx.project_id}/freezone/_uploads/bad%00.png"
    malformed = "http://["  # urlsplit 自己会抛 ValueError: Invalid IPv6 URL

    result = await freezone_routes.freezone_copy_assets_from_project(
        project="proj_dst",
        body=FreezoneAssetCopyRequest(sources=[malformed, null_byte, long_asset, good]),
        user=USER,
    )

    data = result["data"]
    assert set(data["mapping"]) == {good, long_asset}
    assert data["failed"] == [
        {"source": malformed, "reason": "invalid_source"},
        {"source": null_byte, "reason": "invalid_source"},
    ]
    uploads = {p.read_bytes(): p.name for p in (target_ctx.output_dir / "freezone" / "_uploads").iterdir()}
    assert set(uploads) == {b"ok", b"long"}
    assert len(uploads[b"long"].encode()) <= 255
    assert uploads[b"long"].endswith(".png")
    assert uploads[b"long"] in data["mapping"][long_asset]


async def test_copy_route_requires_editor_on_the_target_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_ctx = _ctx(tmp_path, "proj_src", owner="alice", name="rigeng", role="editor")
    target_ctx = _ctx(tmp_path, "proj_dst", owner="bob", name="vlog", role="viewer")
    _patch_projects(monkeypatch, {"proj_src": source_ctx, "proj_dst": target_ctx})
    asset = _source_asset(source_ctx, "freezone/_uploads/a.png", b"png")

    with pytest.raises(HTTPException) as excinfo:
        await freezone_routes.freezone_copy_assets_from_project(
            project="proj_dst",
            body=FreezoneAssetCopyRequest(sources=[asset]),
            user=USER,
        )
    assert excinfo.value.status_code == 403


def test_copy_request_caps_the_batch_size():
    FreezoneAssetCopyRequest(sources=["/static/projects/p/a.png"] * asset_copy.MAX_SOURCES_PER_REQUEST)
    with pytest.raises(ValidationError):
        FreezoneAssetCopyRequest(
            sources=["/static/projects/p/a.png"] * (asset_copy.MAX_SOURCES_PER_REQUEST + 1)
        )
    with pytest.raises(ValidationError):
        FreezoneAssetCopyRequest(sources=[])
