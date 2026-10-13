# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""准备浏览器端推理（抠图、深度动作捕捉）的自托管资源目录。

transformers.js 默认从 Hugging Face Hub 拉模型权重、从 jsDelivr 拉 onnxruntime wasm,
国内网络基本不可达。本脚本把这两类文件整理成一个目录,整个传到 OSS / CDN 后,后端配
`BROWSER_MODEL_ASSET_BASE` 指向它即可,前端不需要重新构建。

用法:

    python3 scripts/fetch_browser_models.py --out /tmp/browser-models
    # 本机连不上 huggingface.co 时换镜像:
    python3 scripts/fetch_browser_models.py --out /tmp/browser-models \\
        --hf-endpoint https://hf-mirror.com

产物布局(与 frontend/src/features/canvas/application/browserModelSource.ts 对应):

    <out>/models/<org>/<model>/{config.json,preprocessor_config.json,onnx/*.onnx}
    <out>/onnxruntime-web/<version>/ort-wasm-simd-threaded[.asyncify].{mjs,wasm}

wasm 从 frontend/node_modules 里拷,目录带 onnxruntime-web 版本号:wasm 必须与打进前端
包里的 JS 胶水同版本,所以要先 `pnpm install`,且升级 @huggingface/transformers 后要重跑
本脚本并把新版本目录补传上去(旧目录留着,给还没刷新页面的旧前端用)。

存储侧要求:对前端站点的 Origin 开 CORS(GET/HEAD);`.wasm` 的 Content-Type 应为
`application/wasm`,`.mjs` 为 `text/javascript`。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.request
from collections.abc import Callable
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# 与前端 worker 里的模型一一对应:depthCaptureWorker.ts 的 DEPTH_MODEL、
# matteWorker.ts 的 MATTE_MODEL。tests/test_fetch_browser_models.py 会核对两边没有漂移。
MODELS: tuple[str, ...] = (
    "onnx-community/depth-anything-v2-small",
    "Xenova/modnet",
)

# WebGPU 走 fp16,回落 wasm 时走 q8(文件名是 model_quantized)。
MODEL_FILES: tuple[str, ...] = (
    "config.json",
    "preprocessor_config.json",
    "onnx/model_fp16.onnx",
    "onnx/model_quantized.onnx",
)

# Safari 用普通版,其余浏览器用 asyncify 版,两套都要传。
ORT_WASM_FILES: tuple[str, ...] = (
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
)

DEFAULT_HF_ENDPOINT = "https://huggingface.co"

Downloader = Callable[[str, Path], None]


def model_file_url(endpoint: str, model: str, filename: str, revision: str = "main") -> str:
    return f"{endpoint.rstrip('/')}/{model}/resolve/{revision}/{filename}"


def download(url: str, dest: Path) -> None:
    """流式下载到 dest;先写 .part 再改名,中断不会留下半个文件冒充成品。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "fetch-browser-models"})
    with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as out:
        shutil.copyfileobj(response, out, length=1 << 20)
    partial.replace(dest)


def fetch_models(
    out_dir: Path,
    *,
    endpoint: str,
    revision: str = "main",
    force: bool = False,
    downloader: Downloader = download,
) -> list[Path]:
    written: list[Path] = []
    for model in MODELS:
        for filename in MODEL_FILES:
            dest = out_dir / "models" / model / filename
            if dest.exists() and not force:
                print(f"  已存在,跳过  {dest.relative_to(out_dir)}")
            else:
                print(f"  下载         {dest.relative_to(out_dir)}")
                downloader(model_file_url(endpoint, model, filename, revision), dest)
            written.append(dest)
    return written


def find_ort_web_package(frontend_dir: Path) -> Path:
    """定位 transformers.js 实际依赖的那份 onnxruntime-web(不是随便哪个版本)。"""
    pnpm_dir = frontend_dir / "node_modules" / ".pnpm"
    candidates = sorted(pnpm_dir.glob("@huggingface+transformers@*/node_modules/onnxruntime-web"))
    if not candidates:
        raise FileNotFoundError(
            f"在 {pnpm_dir} 下找不到 @huggingface/transformers 依赖的 onnxruntime-web,"
            "请先在 frontend/ 下执行 pnpm install。"
        )
    if len(candidates) > 1:
        raise RuntimeError(
            "node_modules 里有多个 @huggingface/transformers 版本,无法确定用哪份 "
            f"onnxruntime-web: {[str(path) for path in candidates]}"
        )
    return candidates[0]


def copy_ort_wasm(out_dir: Path, frontend_dir: Path) -> tuple[str, list[Path]]:
    package_dir = find_ort_web_package(frontend_dir)
    version = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))["version"]
    target_dir = out_dir / "onnxruntime-web" / version
    target_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for filename in ORT_WASM_FILES:
        source = package_dir / "dist" / filename
        if not source.is_file():
            raise FileNotFoundError(f"onnxruntime-web {version} 里缺少 {filename}: {source}")
        shutil.copyfile(source, target_dir / filename)
        print(f"  拷贝         {(target_dir / filename).relative_to(out_dir)}")
        written.append(target_dir / filename)
    return version, written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="产物目录,整个上传到 OSS / CDN")
    parser.add_argument(
        "--hf-endpoint",
        default=DEFAULT_HF_ENDPOINT,
        help="Hugging Face 源,默认 %(default)s;连不上时换镜像",
    )
    parser.add_argument("--revision", default="main", help="模型仓库的 revision,默认 main")
    parser.add_argument(
        "--frontend",
        type=Path,
        default=REPO_ROOT / "frontend",
        help="前端目录(需已 pnpm install),默认仓库内的 frontend/",
    )
    parser.add_argument("--force", action="store_true", help="模型文件已存在时也重新下载")
    args = parser.parse_args(argv)

    out_dir: Path = args.out.expanduser().resolve()
    print(f"模型权重 <- {args.hf_endpoint}")
    try:
        files = fetch_models(
            out_dir, endpoint=args.hf_endpoint, revision=args.revision, force=args.force
        )
        print("onnxruntime wasm <- frontend/node_modules")
        version, wasm_files = copy_ort_wasm(out_dir, args.frontend.expanduser().resolve())
    except (OSError, RuntimeError) as exc:
        print(f"失败: {exc}", file=sys.stderr)
        return 1

    total_mb = sum(path.stat().st_size for path in [*files, *wasm_files]) / 1e6
    print(
        f"\n完成: {len(files)} 个模型文件 + onnxruntime-web {version} 的 "
        f"{len(wasm_files)} 个 wasm 文件,共 {total_mb:.1f} MB\n"
        f"把 {out_dir} 的内容整个传到 OSS / CDN,然后后端配置:\n"
        "  BROWSER_MODEL_ASSET_BASE=<该目录对应的 URL 前缀>"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
