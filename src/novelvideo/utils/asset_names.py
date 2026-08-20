"""资产名的路径安全约束。

角色 / 场景 / 道具的 ``name`` 同时兼三份差事：SQLite 主键、REST 路径段、磁盘目录名。
名字里只要混进一个 ``/``，三份差事一起塌：

* **路径段**——前端把名字 percent-encode 成 ``%2F``（``frontend/src/lib/api-path.ts``），
  但 uvicorn 在把请求交给 Starlette 路由**之前**就 unquote 了整条 path，``%2F`` 又变回
  真斜杠。``/projects/{project}/scenes/{name}/delete`` 里的 ``{name}`` 不匹配 ``/``，
  于是删除 / 改名 / 生成源图 / 上传 …… 那一整排接口全部 404，返回的是 FastAPI 的
  ``{"detail": "Not Found"}``，而不是业务层的「场景不存在」。前端只看见一个光秃秃的
  ``Not Found``，删了跟没删一样。
* **目录名**——``assets/scenes/<name>`` 会摊成嵌套目录，一个资产的文件散进两层。
* **主键**——``a/b`` 和 ``a`` 看着像父子，实际毫无关系；派生场景的正经写法是 ``a_b``
  （见 :mod:`novelvideo.utils.derived_scenes`）。

这些名字是 LLM 规划出来的自由文本，挡不住，所以在写入口一律消毒。

只处理 ``/``、``\\`` 和纯点名（``.`` / ``..``）：它们是仅有的会改变路径结构的写法。
``assets/scenes/..`` 解析出来就是 ``assets/`` 本身，和斜杠一样能爬出资产目录。其余观感
上「奇怪」的字符（空格、``#``、``?``、``%``、``:``）percent-encode 之后都能安全穿过路由
和文件系统，换掉它们只会平白破坏用户起的名字——``第1.5集客厅`` 里的点必须留着。
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

_PATH_HOSTILE_RUN = re.compile(r"[/\\]+")
# 整个名字都是点才危险：``.`` 和 ``..`` 是路径里的当前目录 / 上级目录。名字中间的点
# （``第1.5集客厅``）是普通字符，动它只会破坏用户起的名字。
_DOT_ONLY = re.compile(r"\A\.+\Z")
# 角色名历来还挡掉一批 Windows 保留字符（``NovelCharacter.sanitize_name`` 一直是这个
# 口径）。这不是路径安全的诉求，但两边字符集只要不一致就会出事：路由按窄口径查重放过
# ``王:小明``，模型层按宽口径把它改写成 ``王_小明``，``INSERT … ON CONFLICT(name)``
# 就静默盖掉了真正的 ``王_小明``。所以两边共用这里的定义，别各写各的正则。
_CHARACTER_HOSTILE_RUN = re.compile(r'[/\\:*?"<>|]+')
_REPLACEMENT = "_"


def _hostile_run(kind: str) -> re.Pattern[str]:
    return _CHARACTER_HOSTILE_RUN if kind == "character" else _PATH_HOSTILE_RUN


def is_path_safe_asset_name(name: str | None, *, kind: str = "asset") -> bool:
    """名字能不能安全地当路径段和目录名用。"""

    value = str(name or "")
    if _DOT_ONLY.match(value):
        return False
    return _hostile_run(kind).search(value) is None


def path_safe_asset_name(name: str | None, *, kind: str = "asset") -> str:
    """把路径敌意字符换成 ``_``。

    连续的斜杠折叠成一个 ``_``，免得 ``家中客厅//餐厅`` 变成 ``家中客厅__餐厅``。

    **不做 strip**：这个函数也跑在模型校验器的读路径上，而 ``name`` 是 SQLite 主键。
    读的时候顺手把 ``"客厅 "`` 修剪成 ``"客厅"``，模型层就再也对不上主键里那个带空格的
    行了，``DELETE ... WHERE name = ?`` 一行都删不掉——正是斜杠那个 bug 的翻版。要修剪
    请在写入口显式 ``.strip()``。
    """

    value = str(name or "")
    # 先折叠斜杠：``../..`` 折完是 ``.._..``，那是个正经文件名，不该再被当成纯点名。
    value = _hostile_run(kind).sub(_REPLACEMENT, value)
    if _DOT_ONLY.match(value):
        return _REPLACEMENT * len(value)
    return value


def coerce_path_safe_asset_name(
    name: str | None,
    aliases: list[str] | None = None,
) -> tuple[str, list[str]]:
    """返回消毒后的名字，并把原名保留成别名。

    原名必须留下来：beats、分镜、画布里已经按原名引用了这个资产，而 store 的
    ``get_scene`` / ``get_character`` / ``get_prop`` 都有别名回退，留着原名这些引用就
    不会断——否则一次消毒会把「16 次使用」全变成悬空引用。
    """

    # 同样不 strip：见 path_safe_asset_name 的说明，这条路径由模型校验器在读取时调用。
    original = str(name or "")
    merged = [str(alias or "") for alias in (aliases or [])]
    safe = path_safe_asset_name(original)
    if safe == original:
        return safe, merged
    if original and original not in merged:
        merged.append(original)
    return safe, merged


def unique_path_safe_asset_name(
    name: str | None,
    taken: set[str] | frozenset[str],
    *,
    kind: str = "asset",
) -> str:
    """消毒后如果撞上已有名字，就往后加 ``_2`` / ``_3`` …… 直到不撞。

    修存量数据时才用得上：``a/b`` 消毒成 ``a_b``，而 ``a_b`` 可能真的已经存在。
    """

    safe = path_safe_asset_name(name, kind=kind)
    if not safe:
        return safe
    if safe not in taken:
        return safe
    for suffix in range(2, 1000):
        candidate = f"{safe}_{suffix}"
        if candidate not in taken:
            return candidate
    return safe


def asset_dir_within(root: Path, name: str | None) -> Path | None:
    """``root/<name>`` 落在 ``root`` 里面就返回它，爬出去了返回 ``None``。

    存量自愈拿**库里的旧名字**去拼源路径，而旧名字正是没经过消毒的那批：
    ``../../config.json`` 拼出来的源路径在资产根之外，``shutil.move`` 会真的把项目
    配置搬走。消毒只管新名字，救不了已经落库的旧值，所以搬之前必须再验一次。

    用 ``resolve()`` 而不是 ``Path.is_relative_to`` 直接判：名字里可能混着 symlink 和
    ``..``，只有解析到真实路径之后的比较才作数。``root`` 不存在时也能比——``resolve()``
    在 Python 3.6+ 对不存在的路径同样做纯词法归一。
    """

    value = str(name or "")
    if not value:
        return None
    try:
        root_resolved = Path(root).resolve()
        candidate = (root_resolved / value).resolve()
    except OSError:
        return None
    if candidate == root_resolved:
        return None
    if not candidate.is_relative_to(root_resolved):
        return None
    return candidate


def move_asset_dir(root: Path, old_name: str, new_name: str) -> bool:
    """把 ``root/<old_name>`` 搬成 ``root/<new_name>``，搬成功返回 ``True``。

    源路径来自库里的旧名字，可能是 ``../../config.json`` 这种爬得出资产根的脏值；
    目标路径来自消毒后的新名字，正常爬不出去，但一并验掉更省心。任一端落在 ``root``
    之外就当作「没有可搬的目录」——只记一条 warning，不碰磁盘，也不阻止调用方把库里
    那行改名。脏值对应的资产目录本来就不存在，拦下来的是一次误伤，不是一次迁移。

    目标已存在时抛 ``ValueError``：这一行宁可留着坏名字，也不能让记录指向别人的图。
    """

    old_dir = asset_dir_within(root, old_name)
    new_dir = asset_dir_within(root, new_name)
    if old_dir is None or new_dir is None:
        logger.warning(
            "资产名越出资产根目录，跳过目录迁移: %s → %s (root=%s)", old_name, new_name, root
        )
        return False
    if not old_dir.exists():
        return False
    if new_dir.exists():
        raise ValueError(f"Target asset directory already exists: {new_dir}")
    new_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old_dir), str(new_dir))
    return True
