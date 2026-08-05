import os
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace


class _FakeCogneeConfig:
    def __init__(self) -> None:
        self.system_root = ""
        self.data_root = ""

    def system_root_directory(self, value: str) -> None:
        self.system_root = value

    def data_root_directory(self, value: str) -> None:
        self.data_root = value


def test_cognee_import_preserves_host_logging_and_disables_private_log(tmp_path):
    logs_dir = tmp_path / "cognee-logs"
    script = textwrap.dedent(
        """
        import io
        import logging
        import os
        import sys
        from contextlib import redirect_stderr

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(levelname)s:%(message)s"))
        marker_filter = logging.Filter("application")
        root = logging.getLogger()
        root.handlers[:] = [handler]
        root.filters[:] = [marker_filter]
        root.setLevel(logging.WARNING)
        original_excepthook = sys.excepthook

        import novelvideo.cognee.config  # noqa: F401
        from cognee.shared.logging_utils import setup_logging

        late_setup_stderr = io.StringIO()
        with redirect_stderr(late_setup_stderr):
            setup_logging()

        assert root.handlers == [handler]
        assert root.filters == [marker_filter]
        assert root.level == logging.WARNING
        assert sys.excepthook is original_excepthook
        assert "COGNEE_LOG_FILE" not in os.environ
        assert late_setup_stderr.getvalue() == ""

        try:
            large_pipeline_local = [{"text": "x" * 1000} for _ in range(1000)]
            raise RuntimeError("bounded traceback probe")
        except RuntimeError:
            from cognee.shared.logging_utils import get_logger

            get_logger("application.probe").exception("pipeline failed")

        output = stream.getvalue()
        assert "bounded traceback probe" in output
        assert "large_pipeline_local" not in output
        assert len(output) < 20_000
        """
    )
    env = os.environ.copy()
    env.pop("COGNEE_LOG_FILE", None)
    env.pop("LOG_FILE_NAME", None)
    env["COGNEE_LOGS_DIR"] = str(logs_dir)
    env["ST_EDITION"] = "ce"

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not list(Path(logs_dir).glob("*.log"))


def test_cognee_preimport_is_observable_and_later_setup_is_guarded(tmp_path):
    logs_dir = tmp_path / "cognee-logs"
    script = textwrap.dedent(
        """
        import io
        import logging
        import os
        from pathlib import Path

        # Simulate an integration importing the dependency before DramaClaw.
        import cognee  # noqa: F401
        from cognee.shared.logging_utils import PlainFileHandler

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(levelname)s:%(message)s"))
        root = logging.getLogger()
        root.addHandler(handler)
        root.setLevel(logging.WARNING)

        import novelvideo.cognee.config  # noqa: F401
        from cognee.shared.logging_utils import setup_logging

        assert "Cognee was imported before DramaClaw installed its logging guard" in (
            stream.getvalue()
        )
        assert not any(isinstance(item, PlainFileHandler) for item in root.handlers)
        assert getattr(setup_logging, "_novelvideo_logging_guard", False)

        setup_logging()
        logging.getLogger("application.probe").warning(
            "post-guard-private-file-probe"
        )
        for item in root.handlers:
            item.flush()

        private_logs = list(Path(os.environ["COGNEE_LOGS_DIR"]).glob("*.log"))
        assert private_logs
        assert all(
            "post-guard-private-file-probe" not in path.read_text(encoding="utf-8")
            for path in private_logs
        )
        """
    )
    env = os.environ.copy()
    env["COGNEE_LOG_FILE"] = "true"
    env["COGNEE_LOGS_DIR"] = str(logs_dir)
    env.pop("LOG_FILE_NAME", None)
    env["ST_EDITION"] = "ce"

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, result.stderr


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


def test_cognee_gateway_structured_output_disables_reasoning(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from cognee.infrastructure.llm.LLMGateway import LLMGateway

    from novelvideo.cognee.pipeline import extract_episodes_from_text

    calls: list[dict] = []

    async def fake_structured_output(*args, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(episodes=[])

    monkeypatch.setattr(LLMGateway, "acreate_structured_output", fake_structured_output)

    assert asyncio.run(extract_episodes_from_text("text", target_episodes=1)) == []
    assert calls == [
        {
            "reasoning_effort": "none",
            "allowed_openai_params": ["reasoning_effort"],
        }
    ]


def test_cognee_litellm_structured_output_disables_reasoning(monkeypatch, tmp_path):
    import asyncio
    from types import SimpleNamespace

    import litellm

    from novelvideo.cognee.store import CogneeStore

    calls: list[dict] = []

    async def fake_completion(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"assignments":{}}'))]
        )

    monkeypatch.setattr(litellm, "acompletion", fake_completion)
    store = CogneeStore(
        "structured-output-test",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
    )

    result = asyncio.run(store._assign_events_to_episodes([], 1))

    assert result == {}
    assert len(calls) == 1
    assert calls[0]["reasoning_effort"] == "none"
    assert calls[0]["allowed_openai_params"] == ["reasoning_effort"]
