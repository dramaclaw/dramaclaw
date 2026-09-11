"""统一的项目存储目录归属校验。

所有对项目 output/state/runtime **整树**的移动或删除,必须先经过本模块。
目的:即使数据库记录被篡改、旧迁移写坏路径、或程序缺陷导致路径异常,也绝不
能移动或删除属于其他用户(或数据根、用户根等宽泛目录)的文件。

规范布局为 ``<root>/<owner_username>/<project>`` 或
``<root>/_orgs/<organization>/<owner_username>/<project>`` ,其中三类 root
分别是 ``config.OUTPUT_DIR`` / ``config.STATE_DIR`` / ``config.RUNTIME_DIR`` 。

校验规则(任一不满足即拒绝,调用方必须放弃移动/删除任何目录):

1. 路径必须精确匹配项目记录中冻结的 owner、project 和 organization 范围;
2. 三类目录各自只能落在对应的数据根内;
3. root 之下的每一层存储边界都不能是符号链接
   (防止用可写目录里的软链接把删除引到别处);
4. 路径不得等于数据根或 owner 用户根;
5. 三个目录必须互不相同,且互不为对方的祖先。
"""

from __future__ import annotations

from dataclasses import dataclass
import os
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


def _safe_segment(value: str | None, *, label: str) -> str:
    segment = (value or "").strip()
    if (
        not segment
        or segment != value
        or segment in {".", ".."}
        or "/" in segment
        or "\\" in segment
    ):
        raise ProjectStorageOwnershipError(f"invalid {label}: {value!r}")
    return segment


def _expected_suffix(
    *,
    owner_username: str,
    project_name: str,
    storage_org_id: str | None,
    storage_org_name: str | None,
) -> tuple[str, ...]:
    owner = _safe_segment(owner_username, label="owner username")
    project = _safe_segment(project_name, label="project name")
    if storage_org_id is None and storage_org_name is None:
        if owner == "_orgs":
            raise ProjectStorageOwnershipError(
                "personal project owner collides with reserved organization namespace"
            )
        return (owner, project)
    if storage_org_id is None or storage_org_name is None:
        raise ProjectStorageOwnershipError(
            "organization storage id and name must either both be set or both be absent"
        )
    _safe_segment(storage_org_id, label="organization storage id")
    org_name = _safe_segment(storage_org_name, label="organization storage name")
    if owner == "_system":
        raise ProjectStorageOwnershipError(
            "organization project owner collides with reserved system namespace"
        )
    return ("_orgs", org_name, owner, project)


def _absolute_without_symlink_resolution(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _validate_one(kind: str, root: Path, suffix: tuple[str, ...], raw: Path) -> Path:
    root_absolute = _absolute_without_symlink_resolution(root)
    expected = root_absolute.joinpath(*suffix)
    raw_absolute = _absolute_without_symlink_resolution(raw)
    if raw_absolute != expected:
        raise ProjectStorageOwnershipError(
            f"{kind}: path {raw_absolute} does not match expected project path {expected}"
        )

    current = root_absolute
    for segment in suffix:
        current = current / segment
        if current.is_symlink():
            raise ProjectStorageOwnershipError(
                f"{kind}: storage boundary {current} is a symlink; refusing"
            )

    root_real = root_absolute.resolve(strict=False)
    real = raw_absolute.resolve(strict=False)
    expected_real = root_real.joinpath(*suffix)
    if real != expected_real:
        raise ProjectStorageOwnershipError(
            f"{kind}: resolved path {real} escaped expected project path {expected_real}"
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
    project_name: str,
    storage_org_id: str | None = None,
    storage_org_name: str | None = None,
    output_dir: str | Path,
    state_dir: str | Path,
    runtime_dir: str | Path,
) -> ValidatedProjectStorage:
    """校验三类项目目录归属;通过则返回 resolve 后的真实路径,否则抛出。

    调用方必须只在本函数成功返回后才移动/删除返回的路径,任一校验失败都不得
    对任何目录执行破坏性操作。
    """
    suffix = _expected_suffix(
        owner_username=owner_username,
        project_name=project_name,
        storage_org_id=storage_org_id,
        storage_org_name=storage_org_name,
    )
    roots = _roots()
    validated = {
        "output": _validate_one("output", roots["output"], suffix, Path(output_dir)),
        "state": _validate_one("state", roots["state"], suffix, Path(state_dir)),
        "runtime": _validate_one(
            "runtime", roots["runtime"], suffix, Path(runtime_dir)
        ),
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
