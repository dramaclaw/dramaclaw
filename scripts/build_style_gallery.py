# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""把飞书导出的短剧风格素材转成 style-gallery 静态资源 + 风格清单。

用法:

    .venv/bin/python scripts/build_style_gallery.py \\
        --source ~/Downloads/飞书20260806-171116/黄金时代 \\
        --source ~/Downloads/飞书20260806-174825/原子朋克 \\
        --out frontend/public/style-gallery \\
        --emit-manifest src/novelvideo/freezone/style_templates.json

--source 可重复传入,每个都必须直接包含若干风格子目录,子目录内有 提示词.txt。
飞书导出目录顶层的文件夹互为完整重复拷贝,每批任取其一即可。
STYLE_META 里的每个风格会在所有 --source 里按名字查找,找不到即报错退出。

产物是「图片目录 + 一份 JSON 清单」这一对:图片可以整个目录传 OSS(后端配
`STYLE_GALLERY_ASSET_BASE`),清单换代时覆盖内置那份、或另存一处再用
`STYLE_GALLERY_MANIFEST` 指过去,两边都不需要改代码。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from PIL import Image

# 悬空标点:出现在提示词结尾时无意义,清洗掉。句号不在其列,它是正常句末。
TRAILING_PUNCTUATION = "，,；;、 \t　"

COVER_MAX_EDGE = 720
COVER_QUALITY = 78
# 风格数从 11 涨到 24 后示例图翻倍,规格比第一版设计略降;详情视图里单张实际显示
# 约 350px,1120 长边在 2 倍屏下仍有富余。
SAMPLE_MAX_EDGE = 1120
SAMPLE_QUALITY = 74

# 顺序即图墙卡片顺序,按题材分组排列。
STYLE_META: list[dict[str, str]] = [
    {"src": "古装偶像", "id": "period_idol", "category": "古装"},
    {"src": "宫廷权谋", "id": "palace_intrigue", "category": "古装"},
    {"src": "武侠江湖", "id": "wuxia", "category": "古装"},
    {"src": "国产都市", "id": "cn_urban", "category": "都市"},
    {"src": "都市情感", "id": "urban_romance", "category": "都市"},
    {"src": "现实悬疑", "id": "crime_suspense", "category": "都市"},
    {"src": "韩国冷淡", "id": "korean_muted", "category": "都市"},
    {"src": "90年代", "id": "nineties", "category": "年代"},
    {"src": "黄金时代", "id": "golden_age", "category": "年代"},
    {"src": "纪实写实", "id": "documentary_realism", "category": "年代"},
    {"src": "复古叙事", "id": "retro_narrative", "category": "年代"},
    {"src": "美式90", "id": "american_nineties", "category": "年代"},
    {"src": "昭和黑白", "id": "showa_monochrome", "category": "年代"},
    {"src": "老式工业", "id": "vintage_industrial", "category": "年代"},
    {"src": "生活治愈", "id": "healing_life", "category": "生活"},
    {"src": "青春胶片", "id": "youth_film", "category": "生活"},
    {"src": "原子朋克", "id": "atompunk", "category": "科幻"},
    {"src": "霓虹朋克", "id": "neon_punk", "category": "科幻"},
    {"src": "心理恐怖", "id": "psychological_horror", "category": "类型"},
    {"src": "邪典cult", "id": "cult_film", "category": "类型"},
    {"src": "现代战争", "id": "modern_warfare", "category": "类型"},
    {"src": "荒野公路", "id": "wasteland_road", "category": "类型"},
    {"src": "新兴中式", "id": "neo_chinese", "category": "写意"},
    {"src": "高调荒诞", "id": "high_key_absurd", "category": "写意"},
]

# 素材文件名 -> 输出文件名
SAMPLE_FILES: list[tuple[str, str]] = [
    ("女.png", "female.webp"),
    ("少.png", "youth.webp"),
    ("男.png", "male.webp"),
    ("老.png", "elder.webp"),
]


def clean_style_prompt(raw: str) -> str:
    """提示词只做两件事:去首尾空白、去结尾悬空标点。其余一字不动。"""
    lines = [line.strip() for line in raw.strip().splitlines()]
    text = "\n".join(line for line in lines if line)
    return text.rstrip(TRAILING_PUNCTUATION)


def convert_image(src: Path, dst: Path, *, max_edge: int, quality: int) -> None:
    with Image.open(src) as image:
        rgb = image.convert("RGB")
        width, height = rgb.size
        scale = max_edge / max(width, height)
        if scale < 1:
            rgb = rgb.resize(
                (round(width * scale), round(height * scale)), Image.LANCZOS
            )
        dst.parent.mkdir(parents=True, exist_ok=True)
        rgb.save(dst, "WEBP", quality=quality, method=6)


def locate_style_dir(sources: list[Path], name: str) -> Path:
    """在所有 --source 目录里按风格名找素材目录。"""
    for source in sources:
        candidate = source / name
        if candidate.is_dir():
            return candidate
    raise SystemExit(f"素材目录缺失: {name}(已查找 {[str(s) for s in sources]})")


def locate_cover(style_dir: Path, name: str) -> Path:
    """找封面图。

    正常叫 `<风格名>.png`。但飞书导出里 `纪实写实` 的封面被误命名成了
    `复古叙事.png`(内容确实是纪实写实的封面,与另一批真正的 复古叙事 封面
    md5 不同),所以退一步取目录里唯一一张非人物示例的 PNG。有多张候选时
    宁可报错也不猜。
    """
    expected = style_dir / f"{name}.png"
    if expected.is_file():
        return expected

    sample_names = {src_name for src_name, _ in SAMPLE_FILES}
    candidates = sorted(
        path for path in style_dir.glob("*.png") if path.name not in sample_names
    )
    if len(candidates) == 1:
        return candidates[0]
    raise SystemExit(
        f"封面无法确定: {style_dir}(候选 {[path.name for path in candidates]})"
    )


def build(sources: list[Path], out: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for meta in STYLE_META:
        style_dir = locate_style_dir(sources, meta["src"])

        prompt_file = style_dir / "提示词.txt"
        if not prompt_file.is_file():
            raise SystemExit(f"提示词缺失: {prompt_file}")

        cover_src = locate_cover(style_dir, meta["src"])

        convert_image(
            cover_src,
            out / meta["id"] / "cover.webp",
            max_edge=COVER_MAX_EDGE,
            quality=COVER_QUALITY,
        )

        samples: list[str] = []
        for src_name, dst_name in SAMPLE_FILES:
            sample_src = style_dir / src_name
            if not sample_src.is_file():
                raise SystemExit(f"示例图缺失: {sample_src}")
            convert_image(
                sample_src,
                out / meta["id"] / dst_name,
                max_edge=SAMPLE_MAX_EDGE,
                quality=SAMPLE_QUALITY,
            )
            samples.append(f"{meta['id']}/{dst_name}")

        entries.append(
            {
                "id": meta["id"],
                "label": meta["src"],
                "category": meta["category"],
                "cover": f"{meta['id']}/cover.webp",
                "samples": samples,
                "style_prompt": clean_style_prompt(
                    prompt_file.read_text(encoding="utf-8")
                ),
            }
        )
    return entries


def render_manifest(entries: list[dict[str, object]], version: str) -> str:
    """清单格式与 `novelvideo.freezone.style_templates` 的加载器一一对应。"""
    manifest = {"version": version, "templates": entries}
    return json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        required=True,
        action="append",
        type=Path,
        help="素材目录,可重复传入(两批素材各给一次)",
    )
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--emit-manifest",
        type=Path,
        help="把风格清单 JSON 写到该文件;不给则打印到 stdout",
    )
    parser.add_argument(
        "--manifest-version",
        default=date.today().isoformat(),
        help="写进清单的版本号,默认取当天日期",
    )
    args = parser.parse_args()

    entries = build(
        [source.expanduser() for source in args.source], args.out.expanduser()
    )
    manifest = render_manifest(entries, args.manifest_version)
    if args.emit_manifest:
        args.emit_manifest.write_text(manifest, encoding="utf-8")
        print(f"清单已写入 {args.emit_manifest}", file=sys.stderr)
    else:
        print(manifest)
    print(f"共处理 {len(entries)} 套风格", file=sys.stderr)


if __name__ == "__main__":
    main()
