"""CE 默认 compose 缺 Linux sandbox binary 时仍能起 Hermes worker;EE/production 仍拒绝。

回应 #333 review:本 PR 把"无沙箱"从 fallback 改为 fail-close。默认 CE 镜像既未把
``deploy/sandbox`` 下的 codex-linux-sandbox 装到 PATH,四份 compose 也无 opt-in,导致
默认 ``docker compose up`` 首次创建 Hermes worker 即崩。四份 CE compose 现显式设
``SUPERTALE_ALLOW_UNSANDBOXED=1``。本测试把 compose 配置与运行时行为钉在一起:
CE(单租户、DSN 空)放行,worker 可创建;而一旦连上控制面(EE/多租户)仍严格拒绝。

完整的 Linux binary 安装 / bubblewrap / 受控出口留在 #346。
"""

from pathlib import Path

import pytest
import yaml

from novelvideo.security.sandbox_wrap import _fallback_or_raise

REPO_ROOT = Path(__file__).resolve().parents[1]
CE_COMPOSE_FILES = [
    "docker-compose.yml",
    "docker-compose.release.yml",
    "docker-compose.selfhosted.yml",
    "docker-compose.selfhosted.release.yml",
]


def _api_env(compose_name: str) -> dict:
    data = yaml.safe_load((REPO_ROOT / compose_name).read_text(encoding="utf-8"))
    env = data["services"]["api"]["environment"]
    assert isinstance(env, dict), f"{compose_name}: api.environment 必须是 map 形式"
    return env


@pytest.mark.parametrize("compose_name", CE_COMPOSE_FILES)
def test_ce_compose_opts_into_unsandboxed_and_stays_single_tenant(compose_name: str) -> None:
    env = _api_env(compose_name)
    # CE 显式声明沿用无沙箱运行(Linux 镜像暂无 PATH 上的 binary,见 #346)。
    assert str(env.get("SUPERTALE_ALLOW_UNSANDBOXED")) == "1", (
        f"{compose_name}: 缺 SUPERTALE_ALLOW_UNSANDBOXED=1,默认 compose 会 fail-close 崩"
    )
    # 且必须是单租户 CE:DSN 显式为空,否则控制面兜底会覆盖该 opt-in(见下)。
    assert env.get("ST_CONTROL_PLANE_DSN", "") == "", f"{compose_name}: CE 的 DSN 必须为空"
    assert env.get("ST_EDITION") == "ce", f"{compose_name}: 必须是 CE"


def test_ce_compose_env_lets_worker_start_without_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    # 用默认 compose 的真实 env 值驱动 fallback:缺 binary 时 CE 放行,worker 可创建。
    env = _api_env("docker-compose.yml")
    monkeypatch.delenv("SUPERTALE_ENV", raising=False)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", env.get("ST_CONTROL_PLANE_DSN", ""))
    monkeypatch.setenv(
        "SUPERTALE_ALLOW_UNSANDBOXED", str(env["SUPERTALE_ALLOW_UNSANDBOXED"])
    )
    with pytest.warns(RuntimeWarning, match="UNSANDBOXED"):
        result = _fallback_or_raise(["hermes", "run"], "no linux sandbox binary on PATH")
    assert result == ["hermes", "run"]


def test_same_optin_still_fails_closed_under_control_plane(monkeypatch: pytest.MonkeyPatch) -> None:
    # 同样的 opt-in,一旦连上控制面(EE/多租户)仍必须拒绝——兜底不扩散到多租户。
    monkeypatch.delenv("SUPERTALE_ENV", raising=False)
    monkeypatch.setenv("SUPERTALE_ALLOW_UNSANDBOXED", "1")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgres://cp/db")
    with pytest.raises(RuntimeError, match="sandbox required"):
        _fallback_or_raise(["hermes"], "no linux sandbox binary on PATH")
