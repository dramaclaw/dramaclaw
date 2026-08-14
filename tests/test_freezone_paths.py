from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone.paths import resolve_static_url_to_path


def test_resolve_project_static_url_decodes_quoted_relpath(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    source = project_dir / "assets" / "characters" / "陈默" / "portrait.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"png")

    resolved = resolve_static_url_to_path(
        "/static/projects/01KSEFAPS6DM42P0HPASKYR4GM/"
        "assets/characters/%E9%99%88%E9%BB%98/portrait.png?v=123",
        project_dir,
    )

    assert resolved == source.resolve()
    assert resolved.exists()


def test_resolve_project_relative_url_decodes_quoted_relpath(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    mask = project_dir / "freezone" / "_uploads" / "遮罩.png"
    mask.parent.mkdir(parents=True)
    mask.write_bytes(b"png")

    resolved = resolve_static_url_to_path(
        "/freezone/_uploads/%E9%81%AE%E7%BD%A9.png#mask",
        project_dir,
    )

    assert resolved == mask.resolve()


def test_resolve_static_url_still_rejects_escaped_encoded_paths(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()

    with pytest.raises(ValueError, match="outside project"):
        resolve_static_url_to_path(
            "/static/projects/proj_123/%2E%2E/secret.png",
            project_dir,
        )


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/freezone/_uploads/foo.png",
        "http://evil.example/static/projects/proj_123/a.png",
        "//evil.example/freezone/_uploads/foo.png",
        "javascript:alert(1)",
        "data:image/svg+xml;base64,PHN2Zy8+",
        # 浏览器把 `/\` 当成 `//` 处理，等价于协议相对外链。
        "/\\evil.example/freezone/_uploads/foo.png",
    ],
)
def test_resolve_static_url_rejects_cross_origin_urls(tmp_path: Path, url: str) -> None:
    """外链不能靠「path 部分恰好落在项目内」蒙混过关。

    调用方拿校验结果放行、却把原始字符串存下来（文件夹封面就是这样），
    所以这里必须校验整个字符串，不能只看削出来的 path。
    """
    project_dir = tmp_path / "project"
    decoy = project_dir / "freezone" / "_uploads" / "foo.png"
    decoy.parent.mkdir(parents=True)
    decoy.write_bytes(b"png")

    with pytest.raises(ValueError, match="same-origin"):
        resolve_static_url_to_path(url, project_dir)
