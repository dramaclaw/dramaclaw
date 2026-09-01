"""统一的项目存储目录归属校验。

所有对项目 output/state/runtime **整树**的移动或删除,必须先经过本模块。
目的:即使数据库记录被篡改、旧迁移写坏路径、或程序缺陷导致路径异常,也绝不
能移动或删除属于其他用户(或数据根、用户根等宽泛目录)的文件。

规范布局: ``<root>/<owner_username>/<project>`` ,其中三类 root 分别是
``config.OUTPUT_DIR`` / ``config.STATE_DIR`` / ``config.RUNTIME_DIR`` 。

校验规则(任一不满足即拒绝,调用方必须放弃移动/删除任何目录):

1. 路径规范化( ``resolve()`` )后必须恰好位于 ``<root>/<owner>/`` 下一层;
2. 三类目录各自只能落在对应的数据根内;
3. owner 目录本身不能是符号链接,目标目录本身不能是符号链接
   (防止用可写目录里的软链接把删除引到别处);
4. 路径不得等于数据根或 owner 用户根;
5. 三个目录必须互不相同,且互不为对方的祖先。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from novelvideo import config


class ProjectStorageOwnershipError(Exception):
    """项目存储目录未通过归属校验;禁止移动或删除。"""


@dataclass(frozen=True, slots=True)
class ValidatedProjectStorage:
    """通过校验后的三类目录(均为 resolve 后的真实路径)。"""

    output_dir: Path
    state_dir: Path
    runtime_dir: Path

    def as_tuple(self) -> tuple[Path, Path, Path]:
        return (self.output_dir, self.state_dir, self.runtime_dir)


def _roots() -> dict[str, Path]:
    # 动态读取,而非 import 时绑定:根目录可被配置或测试改写。
    return {
        "output": Path(config.OUTPUT_DIR),
        "state": Path(config.STATE_DIR),
        "runtime": Path(config.RUNTIME_DIR),
    }


def _validate_one(kind: str, root: Path, owner_username: str, raw: Path) -> Path:
    root_real = root.resolve(strict=False)
    owner_dir = root / owner_username
    # owner 目录本身若是软链接,resolve 会把它指到别处 —— 直接拒,不给软链接机会。
    if owner_dir.is_symlink():
        raise ProjectStorageOwnershipError(
            f"{kind}: owner directory {owner_dir} is a symlink; refusing"
        )
    owner_real = owner_dir.resolve(strict=False)
    if owner_real.parent != root_real:
        raise ProjectStorageOwnershipError(
            f"{kind}: owner directory {owner_real} is not directly under root {root_real}"
        )

    # 叶子目录本身若是软链接,即便解析后落在 owner 内也拒绝:软链接可在两次操作
    # 之间被换指向(TOCTOU),不作为可信边界。
    if raw.is_symlink():
        raise ProjectStorageOwnershipError(
            f"{kind}: project directory {raw} is a symlink; refusing"
        )
    real = raw.resolve(strict=False)
    if real == root_real:
        raise ProjectStorageOwnershipError(f"{kind}: path equals data root {root_real}")
    if real == owner_real:
        raise ProjectStorageOwnershipError(
            f"{kind}: path equals owner root {owner_real}"
        )
    if real.parent != owner_real:
        raise ProjectStorageOwnershipError(
            f"{kind}: path {real} is not directly under owner directory {owner_real}"
        )
    return real


def _assert_disjoint(paths: dict[str, Path]) -> None:
    items = list(paths.items())
    for i, (kind_a, a) in enumerate(items):
        for kind_b, b in items[i + 1 :]:
            if a == b:
                raise ProjectStorageOwnershipError(
                    f"{kind_a} and {kind_b} resolve to the same directory {a}"
                )
            if a in b.parents or b in a.parents:
                raise ProjectStorageOwnershipError(
                    f"{kind_a} ({a}) and {kind_b} ({b}) are nested"
                )


def assert_owned_project_storage(
    *,
    owner_username: str,
    output_dir: str | Path,
    state_dir: str | Path,
    runtime_dir: str | Path,
) -> ValidatedProjectStorage:
    """校验三类项目目录归属;通过则返回 resolve 后的真实路径,否则抛出。

    调用方必须只在本函数成功返回后才移动/删除返回的路径,任一校验失败都不得
    对任何目录执行破坏性操作。
    """
    owner = (owner_username or "").strip()
    if not owner or "/" in owner or "\\" in owner or owner in (".", ".."):
        raise ProjectStorageOwnershipError(
            f"invalid owner username for storage validation: {owner_username!r}"
        )
    roots = _roots()
    validated = {
        "output": _validate_one("output", roots["output"], owner, Path(output_dir)),
        "state": _validate_one("state", roots["state"], owner, Path(state_dir)),
        "runtime": _validate_one("runtime", roots["runtime"], owner, Path(runtime_dir)),
    }
    _assert_disjoint(validated)
    return ValidatedProjectStorage(
        output_dir=validated["output"],
        state_dir=validated["state"],
        runtime_dir=validated["runtime"],
    )


__all__ = [
    "ProjectStorageOwnershipError",
    "ValidatedProjectStorage",
    "assert_owned_project_storage",
]
