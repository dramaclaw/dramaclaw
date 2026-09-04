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

from pathlib import Path

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
        "/static/alice/demo/legacy.png",
        "/static/projects/proj_a",
        "/static/projects/proj_a/",
        "/static/projects/proj_a/dir\\x.png",
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


# ---------------------------------------------------------------------------
# 拷贝：OSS 直拷优先，文件系统回退
# ---------------------------------------------------------------------------


class _FakeBucket:
    """够用的 oss2.Bucket 替身：CopyObject 后（可选）在挂载点上「显形」目标文件。"""

    bucket_name = "bkt"

    def __init__(self, *, materialize: bool = True, exists: bool = True):
        self.copies: list[tuple[str, str, str]] = []
        self.materialize = materialize
        self.exists = exists

    def object_exists(self, key: str) -> bool:
        return self.exists

    def copy_object(self, source_bucket_name, source_key, target_key, headers=None, params=None):
        self.copies.append((source_bucket_name, source_key, target_key))
        if not self.materialize:
            return
        prefix = str(config.OSS_OBJECT_PREFIX).strip("/") + "/"
        root = Path(config.OUTPUT_DIR)
        source = root / source_key[len(prefix) :]
        target = root / target_key[len(prefix) :]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())


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
