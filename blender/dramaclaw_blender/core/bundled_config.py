"""随包配置：下载插件时后端塞进去的 `config.json`。

用户是登录着从项目管理中心下载这个 zip 的，后端在打包那一刻就知道服务器地址和
网页地址。写进包里，用户装完一个字都不用填。

**包里只有地址，没有凭证。** 令牌仍然走配对码——往包里写令牌能做到「装完即已连接」，
但那样这个 zip 本身就是一张通行证，转发给同事就等于把令牌给出去了。

跟 `core/` 下别的模块一样不 import bpy：这段逻辑要在没有 Blender 的 CI 里被测到。
"""

from __future__ import annotations

import json
from pathlib import Path

CONFIG_FILENAME = "config.json"

# 出厂默认。当前值还是它，说明用户没动过，可以被随包配置填掉。
# 跟 `prefs.DEFAULT_SERVER` 是同一个值，但这里不能 import prefs——那会拉进 bpy。
# 两处必须一致，靠 `tests/test_bundled_config.py` 里的 ast 测试盯住：只改其中一边，
# 出厂新装就会悄悄不再被写入地址，而所有测试照样是绿的。
FACTORY_SERVER_URL = "http://127.0.0.1:19081"

# 只认这两个键。后端以后多塞什么，旧插件一律视而不见。
_ALLOWED_KEYS = ("server_url", "web_url")


def load_bundled_config(package_dir: str | Path) -> tuple[dict, str]:
    """读包里的 `config.json`，返回 `(配置, 失败原因)`。

    两种「读不出来」必须分开，因为它们对用户的意义完全相反：

    - 文件根本不存在 —— 本地 `build.py` 打的包就没有，完全正常，返回 `({}, "")`
      保持安静。
    - 文件在、但用不了（读不动、不是 UTF-8、不是合法 JSON、不是对象）—— 后端写坏了
      或者 zip 损坏，返回 `({}, "<原因>")`。

    以前两种都返回 `{}`，原因在源头就被抹掉了，调用方就算想告诉用户也无从说起。

    **为什么把原因回传，而不是就地 log 或 print**：这个插件从不用 `print()`，
    出错一律走 `operator.report()` 或 `prefs.last_error`（配对那条链路就是这么做的，
    见 `prefs.last_error` 的注释）。而调用点在 `register()` 里，那里没有 operator
    可以 report，只能由调用方落到 `prefs.last_error` 上让面板画出来。更要紧的是
    Blender 用户大头在 Windows，那边系统控制台默认是隐藏的，`print` 出去没有任何人
    看得见——等于什么都没说。

    **绝不抛异常**：调用点在 `register()` 里，这里炸掉会让整个插件装不上，比少填
    一个地址严重得多。连 `Path(package_dir)` 都放进 try，虽然真实调用方传的一定是
    Path，但这条承诺不留例外更省心——下面两处 `except Exception` 也是这个意思，
    不是偷懒，见那里的注释。

    返回的 dict 是后端原样给的，**没有过滤**：白名单 `_ALLOWED_KEYS` 在
    `seeded_values` 里才生效。以后若多出第二个调用方，不要假设这里返回的键已经筛过。
    """
    try:
        path = Path(package_dir) / CONFIG_FILENAME
        # `encoding="utf-8"` 是必须显式写的，而且这条在本机 CI 上测不出来：
        # macOS/Linux 默认就是 UTF-8，把它删掉测试照样全绿。但 Blender 用户大头在
        # Windows，3.15 以前的 Python 在那里会用 ANSI 代码页，而后端是用
        # `ensure_ascii=False` 写的 UTF-8——中文项目名当场 UnicodeDecodeError。
        # 这是一处注释确实替代不了测试、只能由注释顶上的地方。
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, ""
    except Exception:  # noqa: BLE001
        # 读不动（权限、坏 zip 解出来的坏文件）或者不是 UTF-8。
        #
        # 这里宽捕获是故意的：函数的契约就是「任何情况都不抛」，列举具体异常类型等于
        # 给契约留后门——谁也保证不了 `Path()` 和 `read_text()` 将来不会多抛一种。
        # try 里只有两行，宽捕获盖住的范围小到一眼能看完。
        return {}, "随包配置读不出来，请重新下载插件"

    try:
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        # 同样宽捕获。`except ValueError` 看着够用，但十万层嵌套的 config.json 会让
        # `json.loads` 抛 `RecursionError`——那是 RuntimeError 的子类，不是 ValueError，
        # 会一路冲出 register() 把插件打成装不上。zip 在用户手里是可编辑的。
        return {}, "随包配置不是合法的 JSON，请重新下载插件"
    if not isinstance(data, dict):
        return {}, "随包配置的格式不对，请重新下载插件"
    return data, ""


def seeded_values(
    config: dict,
    *,
    current_server_url: str,
    current_web_url: str,
) -> dict:
    """算出哪些字段该写回偏好设置。

    规则只有一条：**只填空的**。
    - `server_url`：当前为空、或仍是出厂默认时才填。用户手动改过就永远不动。
    - `web_url`：当前为空时才填。

    为什么这么严：用户可能把插件装在一台连别的服务器的机器上，之后又下载了一个新包
    覆盖安装。随包配置没有资格推翻他手填的地址。
    """
    values: dict[str, str] = {}
    for key in _ALLOWED_KEYS:
        value = config.get(key)
        # 只认字符串。以前是 `str(config.get(key) or "")`：那个 `str()` 是保命的
        # （去掉它，dict 值会在 `.strip()` 上抛 AttributeError 一路冲出 register()，
        # 插件直接装不上），但转出来的东西比没有更糟——后端真写错成
        # `{"server_url": {"nested": ...}}` 时，用户的地址栏里会出现字面量
        # `"{'nested': ...}"`，比留空难查得多。不是字符串就当没给，走跟留空同一条路。
        # 顺带把原来靠 `or ""` 撞出来的语义写明白：None/0/False 是因为不是 str 被跳过，
        # 不是因为它们为假。
        if not isinstance(value, str):
            continue
        incoming = value.strip()
        if not incoming:
            continue
        current = (current_server_url if key == "server_url" else current_web_url).strip()
        # 这里必须是精确相等：出厂豁免只放行一个地址。写成
        # `current.startswith("http://127.0.0.1")` 之类的宽松判断，用户自己敲的
        # `http://127.0.0.1:8080` 就会被悄悄覆盖——正是这个模块要防的事。
        if current and not (key == "server_url" and current == FACTORY_SERVER_URL):
            continue
        values[key] = incoming
    return values
