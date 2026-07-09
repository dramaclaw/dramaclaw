"""换网关 key 后 Cognee LLM 配置必须热生效。

Cognee 的 ``get_llm_config`` 带 ``lru_cache``:首次导入小说后它锁死当时的
key,用户在设置页更换 DC key 再导入仍用旧凭据(Invalid token)。
``_apply_llm_env`` 每次应用新环境后必须清掉该缓存(与既有的
``_clear_cognee_embedding_config_cache`` 同一先例)。
"""

import pytest

pytestmark = pytest.mark.m02


def test_apply_llm_env_refreshes_cognee_llm_config(monkeypatch):
    from cognee.infrastructure.llm import config as cognee_llm_config

    from novelvideo.cognee import config as nv_config

    nv_config._apply_llm_env("newapi", "DC-cognee-LLM", "sk-first-key")
    first = cognee_llm_config.get_llm_config()
    assert first.llm_api_key == "sk-first-key"

    nv_config._apply_llm_env("newapi", "DC-cognee-LLM", "sk-second-key")
    second = cognee_llm_config.get_llm_config()
    assert second.llm_api_key == "sk-second-key"
