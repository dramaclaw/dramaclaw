from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "fetch_browser_models", REPO_ROOT / "scripts" / "fetch_browser_models.py"
)
assert _SPEC and _SPEC.loader
fetch_browser_models = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(fetch_browser_models)

ORT_VERSION = "1.26.0-dev.test"


def _fake_frontend(root: Path, *, transformers_versions: tuple[str, ...] = ("4.2.0",)) -> Path:
    frontend = root / "frontend"
    for version in transformers_versions:
        package = (
            frontend
            / "node_modules"
            / ".pnpm"
            / f"@huggingface+transformers@{version}"
            / "node_modules"
            / "onnxruntime-web"
        )
        (package / "dist").mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"version": ORT_VERSION}))
        for filename in fetch_browser_models.ORT_WASM_FILES:
            (package / "dist" / filename).write_bytes(filename.encode())
    return frontend


def test_models_match_the_frontend_workers() -> None:
    canvas = REPO_ROOT / "frontend" / "src" / "features" / "canvas" / "application"
    worker_sources = (canvas / "matteWorker.ts").read_text(encoding="utf-8") + (
        canvas / "depthCapture" / "depthCaptureWorker.ts"
    ).read_text(encoding="utf-8")

    for model in fetch_browser_models.MODELS:
        assert f'"{model}"' in worker_sources


def test_model_file_url_follows_the_hub_resolve_layout() -> None:
    assert (
        fetch_browser_models.model_file_url(
            "https://hf-mirror.com/", "Xenova/modnet", "onnx/model_fp16.onnx"
        )
        == "https://hf-mirror.com/Xenova/modnet/resolve/main/onnx/model_fp16.onnx"
    )


def test_fetch_models_writes_the_layout_the_frontend_requests(tmp_path: Path) -> None:
    requested: list[str] = []

    def fake_download(url: str, dest: Path) -> None:
        requested.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"x")

    fetch_browser_models.fetch_models(
        tmp_path, endpoint="https://huggingface.co", downloader=fake_download
    )

    for model in fetch_browser_models.MODELS:
        for filename in fetch_browser_models.MODEL_FILES:
            assert (tmp_path / "models" / model / filename).is_file()
    assert len(requested) == len(fetch_browser_models.MODELS) * len(
        fetch_browser_models.MODEL_FILES
    )


def test_fetch_models_skips_existing_files_unless_forced(tmp_path: Path) -> None:
    calls: list[Path] = []

    def fake_download(url: str, dest: Path) -> None:
        calls.append(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"x")

    kwargs = {"endpoint": "https://huggingface.co", "downloader": fake_download}
    fetch_browser_models.fetch_models(tmp_path, **kwargs)
    first_run = len(calls)

    fetch_browser_models.fetch_models(tmp_path, **kwargs)
    assert len(calls) == first_run

    fetch_browser_models.fetch_models(tmp_path, force=True, **kwargs)
    assert len(calls) == first_run * 2


def test_copy_ort_wasm_uses_a_versioned_directory(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"

    version, written = fetch_browser_models.copy_ort_wasm(out_dir, _fake_frontend(tmp_path))

    assert version == ORT_VERSION
    assert sorted(path.relative_to(out_dir).as_posix() for path in written) == sorted(
        f"onnxruntime-web/{ORT_VERSION}/{filename}"
        for filename in fetch_browser_models.ORT_WASM_FILES
    )


def test_copy_ort_wasm_requires_installed_frontend_dependencies(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="pnpm install"):
        fetch_browser_models.copy_ort_wasm(tmp_path / "out", tmp_path / "frontend")


def test_copy_ort_wasm_refuses_to_guess_between_transformers_versions(tmp_path: Path) -> None:
    frontend = _fake_frontend(tmp_path, transformers_versions=("4.2.0", "4.3.0"))

    with pytest.raises(RuntimeError, match="多个"):
        fetch_browser_models.copy_ort_wasm(tmp_path / "out", frontend)
