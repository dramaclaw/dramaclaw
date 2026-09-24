from __future__ import annotations

import shutil
from pathlib import Path

from fastapi.responses import Response
from fastapi.testclient import TestClient

from novelvideo import local_gateway


def _config(tmp_path: Path) -> local_gateway.RouterConfig:
    root = tmp_path / "local-config"
    config = local_gateway.RouterConfig(
        root=root,
        host="127.0.0.1",
        port=3001,
        comfy_url="http://127.0.0.1:8188",
        siliconflow_base_url="https://api.siliconflow.cn/v1",
        text_model="text-forced",
        embedding_model="embedding-forced",
        tts_model="tts-forced",
    )
    config.secrets_dir.mkdir(parents=True)
    config.workflows_dir.mkdir(parents=True)
    config.router_token_file.write_text("test-router-token", encoding="utf-8")
    config.siliconflow_key_file.write_text("sk-test", encoding="utf-8")
    return config


def _authorization() -> dict[str, str]:
    return {"Authorization": "Bearer test-router-token"}


def test_chat_and_embedding_force_local_models(tmp_path: Path, monkeypatch) -> None:
    config = _config(tmp_path)
    seen: list[tuple[str, str | None]] = []

    async def fake_forward(request, received_config, path, forced_model=None):
        assert received_config is config
        seen.append((path, forced_model))
        return Response(content='{"ok":true}', media_type="application/json")

    monkeypatch.setattr(local_gateway, "_forward_to_siliconflow", fake_forward)
    client = TestClient(local_gateway.create_app(config))

    assert (
        client.post(
            "/v1/chat/completions", headers=_authorization(), json={"model": "ignored"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/v1/embeddings", headers=_authorization(), json={"model": "ignored"}
        ).status_code
        == 200
    )
    assert seen == [
        ("chat/completions", "text-forced"),
        ("embeddings", "embedding-forced"),
    ]


def test_image_generation_uses_local_qwen_workflow(tmp_path: Path, monkeypatch) -> None:
    config = _config(tmp_path)
    template = Path("config/local/qwen_image_t2i_api.json")
    shutil.copyfile(template, config.qwen_t2i_workflow)
    received: dict[str, object] = {}

    async def fake_submit(workflow, received_config):
        assert received_config is config
        received.update(workflow)
        return [{"filename": "result.png", "subfolder": "DramaClaw", "type": "output"}]

    monkeypatch.setattr(local_gateway, "_submit_comfy_workflow", fake_submit)
    client = TestClient(local_gateway.create_app(config))

    assert client.post("/v1/images/generations", json={}).status_code == 401

    response = client.post(
        "/v1/images/generations",
        headers=_authorization(),
        json={
            "model": "ignored",
            "prompt": "orange cat",
            "size": "510x513",
            "seed": 42,
            "qwen_steps": 4,
        },
    )

    assert response.status_code == 200
    assert received["1"]["inputs"]["unet_name"] == "qwen-image-2512-Q4_K_M.gguf"
    assert received["5"]["inputs"]["text"] == "orange cat"
    assert received["7"]["inputs"] == {"width": 496, "height": 512, "batch_size": 1}
    assert received["8"]["inputs"]["seed"] == 42
    assert received["8"]["inputs"]["steps"] == 4

    # Freezone sends its chosen canvas dimensions as separate fields rather
    # than OpenAI's ``size`` string.  Keep the requested landscape ratio.
    response = client.post(
        "/v1/images/generations",
        headers=_authorization(),
        json={"prompt": "wide scene", "width": 1088, "height": 608},
    )

    assert response.status_code == 200
    assert received["7"]["inputs"] == {"width": 1088, "height": 608, "batch_size": 1}
    assert received["8"]["inputs"]["steps"] == 4


def test_image_generation_selects_local_krea_workflow(tmp_path: Path, monkeypatch) -> None:
    config = _config(tmp_path)
    template = Path("config/local/krea2_turbo_t2i_api.json")
    shutil.copyfile(template, config.krea_t2i_workflow)
    received: dict[str, object] = {}

    async def fake_submit(workflow, received_config):
        assert received_config is config
        received.update(workflow)
        return [{"filename": "krea.png", "subfolder": "DramaClaw", "type": "output"}]

    monkeypatch.setattr(local_gateway, "_submit_comfy_workflow", fake_submit)
    client = TestClient(local_gateway.create_app(config))

    response = client.post(
        "/v1/images/generations",
        headers=_authorization(),
        json={
            "model": local_gateway.KREA_IMAGE_MODEL,
            "prompt": "a cinematic woman walking through rain",
            "width": 1088,
            "height": 608,
            "seed": 7,
        },
    )

    assert response.status_code == 200
    assert received["1"]["inputs"]["unet_name"] == "krea2_turbo_int8_convrot.safetensors"
    assert received["2"]["inputs"]["clip_name"] == "qwen3vl_4b_fp8_scaled.safetensors"
    assert received["4"]["inputs"]["text"] == "a cinematic woman walking through rain"
    assert received["6"]["inputs"] == {"width": 1088, "height": 608, "batch_size": 1}
    assert received["7"]["inputs"]["seed"] == 7
    assert received["7"]["inputs"]["steps"] == 8
    assert response.json()["data"][0]["url"].startswith(
        "http://127.0.0.1:3001/v1/local-media?"
    )

def test_image_edit_preserves_up_to_three_references(tmp_path: Path, monkeypatch) -> None:
    config = _config(tmp_path)
    workflow = {
        str(node_id): {"inputs": {}}
        for node_id in (4, 5, 6, 8, 9, 16)
    }
    uploaded = iter(("one.png", "two.png", "three.png"))
    received: dict[str, object] = {}

    monkeypatch.setattr(local_gateway, "_load_workflow", lambda _: workflow.copy())

    async def fake_upload(upload, received_config):
        assert received_config is config
        return next(uploaded)

    async def fake_submit(submitted, received_config):
        assert received_config is config
        received.update(submitted)
        return [{"filename": "result.png", "subfolder": "", "type": "output"}]

    monkeypatch.setattr(local_gateway, "_upload_to_comfy", fake_upload)
    monkeypatch.setattr(local_gateway, "_submit_comfy_workflow", fake_submit)
    client = TestClient(local_gateway.create_app(config))

    response = client.post(
        "/v1/images/edits",
        headers=_authorization(),
        data={"prompt": "edit", "seed": "5"},
        files=[
            ("image", ("one.png", b"one", "image/png")),
            ("image", ("two.png", b"two", "image/png")),
            ("image", ("three.png", b"three", "image/png")),
        ],
    )

    assert response.status_code == 200
    assert received["4"]["inputs"]["image"] == "one.png"
    assert received["5"]["inputs"]["image"] == "two.png"
    assert received["6"]["inputs"]["image"] == "three.png"
    assert received["9"]["inputs"]["image2"] == ["5", 0]
    assert received["9"]["inputs"]["image3"] == ["6", 0]


def test_krea_image_edit_uses_local_reference_workflow(tmp_path: Path, monkeypatch) -> None:
    config = _config(tmp_path)
    workflow = {
        str(node_id): {"inputs": {}}
        for node_id in (4, 5, 6, 7, 8, 14, 15, 19, 21, 23)
    }
    received: dict[str, object] = {}

    def fake_load(path: Path) -> dict[str, object]:
        assert path == config.krea_edit_workflow
        return workflow.copy()

    uploaded = iter(("one.png", "two.png"))
    monkeypatch.setattr(local_gateway, "_load_workflow", fake_load)

    async def fake_upload(upload, received_config):
        assert received_config is config
        return next(uploaded)

    async def fake_submit(submitted, received_config):
        assert received_config is config
        received.update(submitted)
        return [{"filename": "result.png", "subfolder": "", "type": "output"}]

    monkeypatch.setattr(local_gateway, "_upload_to_comfy", fake_upload)
    monkeypatch.setattr(local_gateway, "_submit_comfy_workflow", fake_submit)
    client = TestClient(local_gateway.create_app(config))

    response = client.post(
        "/v1/images/edits",
        headers=_authorization(),
        data={
            "model": local_gateway.KREA_IMAGE_MODEL,
            "prompt": "keep the character identity and change the background",
            "width": "1088",
            "height": "608",
            "seed": "9",
        },
        files=[
            ("image", ("one.png", b"one", "image/png")),
            ("image", ("two.png", b"two", "image/png")),
        ],
    )

    assert response.status_code == 200
    assert received["4"]["inputs"]["image"] == "one.png"
    assert received["5"]["inputs"]["image"] == "two.png"
    assert received["7"]["inputs"]["prompt"] == (
        "Use image 1 as the character identity reference and image 2 as the "
        "pose and composition reference. keep the character identity and change the background"
    )
    assert received["7"]["inputs"]["image2"] == ["5", 0]
    assert received["8"]["inputs"]["image2"] == ["5", 0]
    assert received["14"]["inputs"] == {"width": 1088, "height": 608}
    assert received["21"]["inputs"] == {"width": 1088, "height": 608}
    assert received["15"]["inputs"]["seed"] == 9
    assert received["23"]["inputs"]["seed"] == 9


def test_bootstrap_copies_all_reviewed_workflows_and_keeps_secrets_local(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    config.qwen_t2i_workflow.unlink(missing_ok=True)
    config.qwen_edit_workflow.unlink(missing_ok=True)
    config.krea_t2i_workflow.unlink(missing_ok=True)
    config.krea_edit_workflow.unlink(missing_ok=True)

    local_gateway.bootstrap_local_config(config)

    assert config.qwen_t2i_workflow.is_file()
    assert config.qwen_edit_workflow.is_file()
    assert config.krea_t2i_workflow.is_file()
    assert config.krea_edit_workflow.is_file()
    assert config.router_token_file.read_text(encoding="utf-8") == "test-router-token"
    assert config.siliconflow_key_file.read_text(encoding="utf-8") == "sk-test"


def test_local_launcher_uses_an_ignored_machine_config_instead_of_author_paths() -> None:
    launcher = Path("scripts/start-local-stack.sh").read_text(encoding="utf-8")
    guide = Path("启动说明.md").read_text(encoding="utf-8")

    assert "/Users/" not in launcher
    assert "/Users/" not in guide
    assert ".dramaclaw-local/local.env" in guide
    assert "COMFYUI_DIR" in launcher


def test_local_launcher_reuses_comfy_before_requiring_its_install_path() -> None:
    launcher = Path("scripts/start-local-stack.sh").read_text(encoding="utf-8")

    reuse_probe = launcher.index(
        'if curl -fsS --max-time 1 "${comfyui_base_url}/system_stats"'
    )
    missing_path_error = launcher.index(
        'if [[ -z "$comfyui_dir" ]]',
        reuse_probe,
    )

    assert reuse_probe < missing_path_error
    assert 'echo "Reusing existing ComfyUI at $comfyui_base_url"' in launcher


def test_local_launcher_resolves_default_port_conflicts_before_starting() -> None:
    launcher = Path("scripts/start-local-stack.sh").read_text(encoding="utf-8")

    assert (
        'select_available_port NOVELVIDEO_API_PORT 8780 0.0.0.0 "API"'
        in launcher
    )
    assert (
        "select_available_port DRAMACLAW_LOCAL_GATEWAY_PORT 3001 "
        '127.0.0.1 "Local gateway"'
    ) in launcher
    assert (
        'select_available_port SUPERTALE_FE_PORT 5173 0.0.0.0 "Frontend"'
        in launcher
    )
    assert (
        'export VITE_API_URL="${VITE_API_URL:-http://127.0.0.1:'
        '${NOVELVIDEO_API_PORT}}"'
    ) in launcher
    assert "was explicitly configured" in launcher
