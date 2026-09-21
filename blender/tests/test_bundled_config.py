"""随包配置：下载插件时后端塞进去的 config.json。"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

from dramaclaw_blender.core import bundled_config
from dramaclaw_blender.core.bundled_config import load_bundled_config, seeded_values

DEFAULT_SERVER = "http://127.0.0.1:19081"


def test_missing_config_is_an_empty_dict(tmp_path):
    # 本地 `python3 blender/build.py` 打的包里没有 config.json。缺文件是正常情况，
    # 所以原因必须是空的——非空原因会被面板画成红字，吓唬一个什么都没做错的用户。
    assert load_bundled_config(tmp_path) == ({}, "")


def test_broken_json_is_an_empty_dict_with_a_reason(tmp_path):
    (tmp_path / "config.json").write_text("{ not json", encoding="utf-8")
    config, reason = load_bundled_config(tmp_path)
    # 读配置炸掉绝不能让插件装不上，那比少填一个地址严重得多。
    assert config == {}
    # 但也不能一声不吭：文件在却用不了 = 后端写坏了或包损坏，得有话能说给用户听。
    assert reason


def test_a_json_list_is_an_empty_dict_with_a_reason(tmp_path):
    (tmp_path / "config.json").write_text("[1, 2]", encoding="utf-8")
    config, reason = load_bundled_config(tmp_path)
    assert config == {}
    assert reason


def test_a_non_utf8_config_is_an_empty_dict_with_a_reason(tmp_path):
    # 后端用 ensure_ascii=False 写 UTF-8。真读到别的编码就是包坏了，不是正常情况。
    (tmp_path / "config.json").write_bytes(b'{"server_url": "\xff\xfe"}')
    config, reason = load_bundled_config(tmp_path)
    assert config == {}
    assert reason


def test_a_bad_package_dir_does_not_raise():
    # 真实调用方传的一定是 Path，但「绝不抛异常」这条承诺不该留例外：
    # 这里炸掉 = register() 炸掉 = 插件装不上。
    config, reason = load_bundled_config(None)
    assert config == {}
    assert reason


def test_a_deeply_nested_config_does_not_raise(tmp_path):
    """十万层嵌套会让 `json.loads` 抛 `RecursionError`，那不是 `ValueError`。

    `except ValueError` 看着够用，但 RecursionError 是 RuntimeError 的子类，会一路
    冲出 `register()` 把插件打成装不上——正是这个函数承诺绝不发生的事。zip 装完就在
    用户的 addons 目录里，是可编辑的文件，不能假设内容一定是后端写的那两个字符串键。
    """
    (tmp_path / "config.json").write_text("[" * 100_000 + "]" * 100_000, encoding="utf-8")
    config, reason = load_bundled_config(tmp_path)
    assert config == {}
    assert reason


def test_the_three_failure_reasons_are_distinct(tmp_path):
    """三种失败要给出三句不同的话。

    只断言 `assert reason` 是钉不住这件事的：把三条原因塌缩成同一句「出错了」，
    上面那几条测试照样全绿（复审实测过）。而这三句话存在的全部理由就是让用户分得清
    「包坏了 / JSON 不合法 / 格式不对」——分不清就等于没写。
    这里只比较「互不相同」，不比对具体文案：把中文句子写进断言，以后改个措辞就得
    改测试，又脆又没价值。
    """
    reasons = []
    for name, payload in (
        ("broken", b"{ not json"),
        ("not_utf8", b'{"server_url": "\xff\xfe"}'),
        ("not_an_object", b"[1, 2]"),
    ):
        case_dir = tmp_path / name
        case_dir.mkdir()
        (case_dir / "config.json").write_bytes(payload)
        reasons.append(load_bundled_config(case_dir)[1])

    assert len(set(reasons)) == 3, reasons


def test_reads_the_two_addresses(tmp_path):
    (tmp_path / "config.json").write_text(
        json.dumps({"server_url": "https://a.example.com", "web_url": "https://b.example.com"}),
        encoding="utf-8",
    )
    assert load_bundled_config(tmp_path) == (
        {
            "server_url": "https://a.example.com",
            "web_url": "https://b.example.com",
        },
        "",
    )


def _prefs_default_server() -> str:
    """用 ast 把 `prefs.DEFAULT_SERVER` 抠出来。

    `prefs.py` 顶层 `import bpy`，在没有 Blender 的 CI 里 import 不进来；但这个常量
    是模块级一句大白话的赋值，`ast.parse` 三行就能拿到，全程不碰 sys.modules。
    """
    prefs_path = Path(bundled_config.__file__).resolve().parent.parent / "prefs.py"
    module = ast.parse(prefs_path.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "DEFAULT_SERVER"
            for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("prefs.py 里找不到模块级的 DEFAULT_SERVER")


def test_the_factory_default_matches_prefs():
    """出厂地址在三个地方各写了一份，这里一次钉住。

    `bundled_config.FACTORY_SERVER_URL` 必须等于 `prefs.DEFAULT_SERVER`，否则
    「当前值还是出厂默认才允许覆盖」这条判断永远不成立：出厂新装从此悄悄不再被写入
    地址，这个模块存在的唯一理由就失效了，而所有测试照样全绿。只改任意一边都该红。
    """
    assert "bpy" not in sys.modules
    assert bundled_config.FACTORY_SERVER_URL == _prefs_default_server()
    assert DEFAULT_SERVER == _prefs_default_server()
    assert "bpy" not in sys.modules


def test_seeds_both_addresses_onto_a_factory_fresh_install():
    values = seeded_values(
        {"server_url": "https://a.example.com", "web_url": "https://b.example.com"},
        current_server_url=DEFAULT_SERVER,
        current_web_url="",
    )
    assert values == {
        "server_url": "https://a.example.com",
        "web_url": "https://b.example.com",
    }


def test_never_overwrites_a_server_url_the_user_typed():
    # 用户在这台机器上连的是别的服务器。覆盖安装不能把他的地址改掉。
    values = seeded_values(
        {"server_url": "https://a.example.com", "web_url": "https://b.example.com"},
        current_server_url="https://mine.example.com",
        current_web_url="",
    )
    assert "server_url" not in values
    assert values["web_url"] == "https://b.example.com"


def test_the_factory_exemption_is_exact():
    # 出厂豁免只放行 FACTORY_SERVER_URL 这一个地址。哪怕只是同一台本机换了个端口，
    # 那也是用户自己敲进去的，不能覆盖。
    values = seeded_values(
        {"server_url": "https://a.example.com"},
        current_server_url="http://127.0.0.1:8080",
        current_web_url="",
    )
    assert "server_url" not in values


def test_never_overwrites_a_web_url_the_user_typed():
    values = seeded_values(
        {"server_url": "https://a.example.com", "web_url": "https://b.example.com"},
        current_server_url=DEFAULT_SERVER,
        current_web_url="http://localhost:5174",
    )
    assert "web_url" not in values
    assert values["server_url"] == "https://a.example.com"


def test_an_empty_server_url_counts_as_unset():
    values = seeded_values(
        {"server_url": "https://a.example.com"},
        current_server_url="   ",
        current_web_url="",
    )
    assert values["server_url"] == "https://a.example.com"


def test_missing_or_blank_config_values_are_not_written():
    values = seeded_values(
        {"server_url": "", "web_url": "   "},
        current_server_url=DEFAULT_SERVER,
        current_web_url="",
    )
    assert values == {}


def test_a_nested_object_is_not_written_as_its_repr():
    # 后端写错成对象时，绝不能把 "{'nested': 'object'}" 这种字面量塞进用户的地址栏：
    # 留空还能看出「没配」，一串 repr 只会让人怀疑自己。
    values = seeded_values(
        {"server_url": {"nested": "object"}, "web_url": "https://b.example.com"},
        current_server_url=DEFAULT_SERVER,
        current_web_url="",
    )
    assert values == {"web_url": "https://b.example.com"}


def test_a_number_is_not_coerced_into_an_address():
    values = seeded_values(
        {"server_url": 123},
        current_server_url=DEFAULT_SERVER,
        current_web_url="",
    )
    assert values == {}


def test_a_null_value_counts_as_unset():
    # JSON 里的 null。不是字符串，所以跳过——理由是类型不对，不是「它为假」。
    values = seeded_values(
        {"server_url": None, "web_url": None},
        current_server_url=DEFAULT_SERVER,
        current_web_url="",
    )
    assert values == {}


def test_a_false_value_counts_as_unset():
    values = seeded_values(
        {"server_url": False, "web_url": False},
        current_server_url=DEFAULT_SERVER,
        current_web_url="",
    )
    assert values == {}


def test_unknown_keys_in_the_config_are_ignored():
    # 后端以后多塞字段，旧插件必须视而不见，不能把它写进偏好设置。
    values = seeded_values(
        {"server_url": "https://a.example.com", "token": "secret", "future": 1},
        current_server_url=DEFAULT_SERVER,
        current_web_url="",
    )
    assert values == {"server_url": "https://a.example.com"}
