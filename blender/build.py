#!/usr/bin/env python3
"""打一个能直接装进 Blender 的 zip。

跑：`python3 blender/build.py`，产出 `blender/dist/dramaclaw_blender-<版本>.zip`。

不打包任何第三方依赖——插件只用标准库。LibTV 的插件里塞了两个 FFmpeg 二进制
（合计 125 MB），我们不需要：Blender 自带 FFmpeg。
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE / "dramaclaw_blender"
DIST = HERE / "dist"

EXCLUDE_DIRS = {"__pycache__", "tests"}


def read_version() -> str:
    source = (PACKAGE / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'"version":\s*\((\d+),\s*(\d+),\s*(\d+)\)', source)
    if not match:
        raise SystemExit("在 __init__.py 里找不到 bl_info 的 version")
    return ".".join(match.groups())


def main() -> None:
    version = read_version()
    DIST.mkdir(exist_ok=True)
    target = DIST / f"dramaclaw_blender-{version}.zip"
    if target.exists():
        target.unlink()

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(PACKAGE.rglob("*.py")):
            if any(part in EXCLUDE_DIRS for part in path.parts):
                continue
            archive.write(path, path.relative_to(HERE))

    print(f"打好了：{target} （{target.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
