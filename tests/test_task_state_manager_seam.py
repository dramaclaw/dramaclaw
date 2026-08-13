"""TaskStateManager 单例的注入接缝。

EE 用一个继承式 store 覆写 *_for_project 一族,legacy 半边原样继承;
58 个 _for_project 调用点全都是在 get_task_manager() 返回的对象上调方法,
所以 CE 侧只需要在单例旁开一个注入点,不需要端口/Protocol。
"""

import pytest

from novelvideo import task_state as task_state_module
from novelvideo.task_state import (
    TaskStateManager,
    get_task_manager,
    set_task_manager,
)

pytestmark = pytest.mark.m07


@pytest.fixture(autouse=True)
def _restore_singleton():
    """接缝改的是模块级单例,用例之间必须复原,否则污染同进程后续测试。"""
    original = task_state_module._task_manager
    yield
    task_state_module._task_manager = original


class _StubManager(TaskStateManager):
    pass


def test_injected_manager_is_returned_by_get_task_manager() -> None:
    stub = _StubManager()

    set_task_manager(stub)

    assert get_task_manager() is stub


def test_reset_falls_back_to_the_default_singleton() -> None:
    stub = _StubManager()
    set_task_manager(stub)

    set_task_manager(None)

    restored = get_task_manager()
    assert restored is not stub
    assert type(restored) is TaskStateManager
    # 复位后仍是单例,不是每次调用新建一个。
    assert get_task_manager() is restored
