from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_foss_only_e2e_script_encodes_locked_cli_sequence_and_assertions() -> None:
    script_path = REPO_ROOT / "scripts/acceptance/foss_only_e2e.sh"
    assert script_path.is_file()
    script = script_path.read_text(encoding="utf-8")

    assert "novelvideo cognee-ingest" in script
    assert "--project \"$PROJECT\"" in script
    assert "--novel \"$NOVEL_FIXTURE\"" in script
    assert "--episodes 1" in script
    assert "novelvideo generate-script" in script
    assert "--episode 1" in script
    assert "--duration 10" in script
    assert "novelvideo generate" in script
    assert "--mock" in script
    assert "ST_EDITION=ce" in script
    assert "ST_CONTROL_PLANE_DSN=" in script
    assert "ST_REDIS_URL=" in script
    assert "ST_CELERY_BROKER_URL=" in script
    assert "ST_CELERY_RESULT_BACKEND=" in script
    assert "ffprobe" in script
    assert "ep001_*.mp4" in script
    assert "-s" in script
    assert "run_step" in script
    assert "timeout" in script
    assert "get_effective_newapi_gateway_config" in script
    assert "gateway_configured" in script
    assert "gateway=$gateway_source" in script
    assert "provider=$PROVIDER" not in script
    assert "Settings → Model Configuration" in script


def test_env_example_does_not_expose_legacy_direct_model_api_key() -> None:
    env_example = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")

    assert "MODEL_API_KEY=" not in env_example


def test_foss_only_fixture_is_short_txt_for_low_cost_llm_gate() -> None:
    fixture_path = REPO_ROOT / "tests/fixtures/foss_only_short_novel.txt"
    assert fixture_path.is_file()

    text = fixture_path.read_text(encoding="utf-8").strip()
    assert fixture_path.suffix == ".txt"
    assert 500 <= len(text) <= 2000
