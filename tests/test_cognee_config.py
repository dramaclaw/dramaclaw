import os
from types import SimpleNamespace


class _FakeCogneeConfig:
    def __init__(self) -> None:
        self.system_root = ""
        self.data_root = ""

    def system_root_directory(self, value: str) -> None:
        self.system_root = value

    def data_root_directory(self, value: str) -> None:
        self.data_root = value


def test_project_storage_context_forces_kuzu_over_legacy_neo4j_env(tmp_path, monkeypatch):
    from novelvideo.cognee.config import apply_cognee_project_storage_context

    monkeypatch.setenv("GRAPH_DATABASE_PROVIDER", "neo4j")

    fake_cognee = SimpleNamespace(config=_FakeCogneeConfig())
    apply_cognee_project_storage_context(tmp_path, fake_cognee)

    assert fake_cognee.config.system_root == str(tmp_path / "cognee_system")
    assert fake_cognee.config.data_root == str(tmp_path / "cognee_data")
    assert os.environ["GRAPH_DATABASE_PROVIDER"] == "kuzu"


def test_newapi_cognee_env_maps_to_openai_compatible_gateway(monkeypatch):
    from novelvideo.cognee import config as cognee_config

    monkeypatch.setenv("NEWAPI_BASE_URL", "http://127.0.0.1:3000/v1")
    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.delenv("COGNEE_LLM_ENDPOINT", raising=False)
    monkeypatch.delenv("COGNEE_EMBEDDING_ENDPOINT", raising=False)
    monkeypatch.delenv("LLM_ENDPOINT", raising=False)
    monkeypatch.delenv("EMBEDDING_ENDPOINT", raising=False)
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    model = cognee_config._normalize_llm_model("newapi", "gemini-3.5-flash")
    assert model == "openai/gemini-3.5-flash"

    cognee_config._apply_llm_env("newapi", model, "newapi-token")
    assert os.environ["LLM_PROVIDER"] == "custom"
    assert os.environ["LLM_MODEL"] == "openai/gemini-3.5-flash"
    assert os.environ["LLM_ENDPOINT"] == "http://127.0.0.1:3000/v1"
    assert os.environ["LLM_API_KEY"] == "newapi-token"

    monkeypatch.setenv("COGNEE_EMBEDDING_PROVIDER", "newapi")
    monkeypatch.setenv("COGNEE_EMBEDDING_MODEL", "gemini-embedding-001")
    monkeypatch.setenv("COGNEE_EMBEDDING_DIM", "3072")
    provider, model, dimensions, api_key = cognee_config._apply_embedding_env(
        "newapi", "newapi-token"
    )

    assert provider == "custom"
    assert model == "openai/gemini-embedding-001"
    assert dimensions == "3072"
    assert api_key == "newapi-token"
    assert os.environ["EMBEDDING_ENDPOINT"] == "http://127.0.0.1:3000/v1"
    assert os.environ["EMBEDDING_PROVIDER"] == "custom"
    assert os.environ["EMBEDDING_MODEL"] == "openai/gemini-embedding-001"


def test_gemini_direct_does_not_inherit_newapi_endpoint(monkeypatch):
    from novelvideo.cognee import config as cognee_config

    monkeypatch.setenv("NEWAPI_BASE_URL", "http://127.0.0.1:3000/v1")
    monkeypatch.delenv("COGNEE_LLM_ENDPOINT", raising=False)
    monkeypatch.delenv("LLM_ENDPOINT", raising=False)

    model = cognee_config._normalize_llm_model("gemini", "gemini-3.5-flash")
    cognee_config._apply_llm_env("gemini", model, "gemini-token")

    assert os.environ["LLM_PROVIDER"] == "gemini"
    assert os.environ["LLM_MODEL"] == "gemini/gemini-3.5-flash"
    assert "LLM_ENDPOINT" not in os.environ


def test_newapi_reasoning_kwargs_uses_cognee_thinking_env(monkeypatch):
    from novelvideo.config import get_newapi_reasoning_kwargs

    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("COGNEE_LLM_THINKING_LEVEL", "high")

    assert get_newapi_reasoning_kwargs(
        thinking_env="COGNEE_LLM_THINKING_LEVEL",
        default_thinking_level="medium",
    ) == {
        "reasoning_effort": "high",
        "allowed_openai_params": ["reasoning_effort"],
    }


def test_newapi_reasoning_kwargs_empty_env_disables(monkeypatch):
    from novelvideo.config import get_newapi_reasoning_kwargs

    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("COGNEE_LLM_THINKING_LEVEL", "")

    assert (
        get_newapi_reasoning_kwargs(
            thinking_env="COGNEE_LLM_THINKING_LEVEL",
            default_thinking_level="high",
        )
        == {}
    )


def test_newapi_reasoning_kwargs_skips_direct_gemini(monkeypatch):
    from novelvideo.config import get_newapi_reasoning_kwargs

    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("COGNEE_LLM_THINKING_LEVEL", "high")

    assert (
        get_newapi_reasoning_kwargs(
            thinking_env="COGNEE_LLM_THINKING_LEVEL",
            default_thinking_level="high",
        )
        == {}
    )


def test_newapi_reasoning_kwargs_skips_direct_openai(monkeypatch):
    from novelvideo.config import get_newapi_reasoning_kwargs

    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("COGNEE_LLM_THINKING_LEVEL", "high")

    assert (
        get_newapi_reasoning_kwargs(
            thinking_env="COGNEE_LLM_THINKING_LEVEL",
            default_thinking_level="high",
        )
        == {}
    )
