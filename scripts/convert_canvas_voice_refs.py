#!/usr/bin/env python3
"""把存量画布节点里的**项目级**音色引用一次性改写成**账号级**引用。

B2 §4 第 3 条：块二（音频节点解耦）把音色解析上移到账号级之后，已保存的画布里
仍留着 `character_default` / `identity` / `project_narrator` 这类**钉项目**的
`voiceRef`。它们是 B2 里唯一的存量数据改写。B2 §9 已判：**独立脚本，不进迁移**
（量级百级）。

它做的事，逐条：

1. 扫 `<project_dir>/freezone/canvases/*.json` 里的活画布（跳墓碑与 `_history/`）。
2. 每个项目级 `voiceRef`，用**现成的**解析路径 `audio_node.resolve_speech_voice`
   落到一个具体音频文件（这一步要项目 SQLite，所以本脚本跑在家节点上）。
3. 把那个文件登记进该用户的账号级音色库（`audio_node.create_user_audio_voice`，
   即 `_account/freezone/audio/voices/`），**按 sha256 去重**。
4. 把节点的 `voiceRef` 改写成 `{"scope": "user_custom", "voiceId": ...}`。

**可重入**：改写后的节点 scope 已是 `user_custom`，第二遍不再命中，既不解析、
也不登记、也不落盘 —— 第二遍是 no-op（`tests/test_convert_canvas_voice_refs_script.py`
断言之）。

**默认 dry-run**，`--apply` 才写。写入走 `canvas_write_lock` ——
B2 §4 第 3 条要求本转换在块一之后做，靠互斥保证它与用户并发保存不打架。

用法::

    python scripts/convert_canvas_voice_refs.py                    # 全量 dry-run
    python scripts/convert_canvas_voice_refs.py --apply
    python scripts/convert_canvas_voice_refs.py --username alice --project demo --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable

from novelvideo.config import OUTPUT_DIR
from novelvideo.freezone.audio_node import (
    USER_VOICE_SCOPE,
    FreezoneVoiceRefResolution,
    create_user_audio_voice,
    list_user_audio_voices,
    resolve_speech_voice,
)
from novelvideo.freezone.canvas_lock import canvas_write_lock
from novelvideo.freezone.canvas_store import atomic_write_json, load_canvas_json
from novelvideo.freezone.paths import canvases_dir

# 前端 `AudioVoiceRef` 的 scope 全集见
# `frontend/src/features/canvas/domain/canvasNodes.ts:445-451`；除去账号级的
# `user_custom`，其余全部钉项目。
PROJECT_SCOPES = frozenset(
    {
        "project_narrator",
        "character_default",
        "character_age_group",
        "identity",
        "identity_resolved",
    }
)

# 项目级独有的键，改写成账号级引用时必须一并清掉。
PROJECT_ONLY_KEYS = ("characterName", "identityId", "slot")


@dataclass(frozen=True)
class ConversionResult:
    canvases_scanned: int = 0
    canvases_written: int = 0
    nodes_converted: int = 0
    errors: tuple[str, ...] = ()

    def merged(self, other: "ConversionResult") -> "ConversionResult":
        return ConversionResult(
            canvases_scanned=self.canvases_scanned + other.canvases_scanned,
            canvases_written=self.canvases_written + other.canvases_written,
            nodes_converted=self.nodes_converted + other.nodes_converted,
            errors=self.errors + other.errors,
        )


# ---------------------------------------------------------------------------
# 画布 payload 侧（纯函数，不碰磁盘）
# ---------------------------------------------------------------------------


def iter_voice_refs(payload: dict) -> Iterable[dict]:
    """产出画布里所有**待改写**的 `voiceRef`（就地可改的那个 dict 本身）。"""
    for node in payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        data = node.get("data")
        if not isinstance(data, dict):
            continue
        voice_ref = data.get("voiceRef")
        if not isinstance(voice_ref, dict):
            continue
        if str(voice_ref.get("scope") or "").strip() in PROJECT_SCOPES:
            yield voice_ref


def voice_ref_key(voice_ref: dict) -> str:
    """同一个项目级引用只解析一次的去重键。"""
    return json.dumps(
        {
            "scope": str(voice_ref.get("scope") or ""),
            "characterName": str(voice_ref.get("characterName") or ""),
            "identityId": str(voice_ref.get("identityId") or ""),
            "slot": str(voice_ref.get("slot") or ""),
        },
        sort_keys=True,
        ensure_ascii=False,
    )


def backend_voice_ref(voice_ref: dict) -> dict:
    """camelCase 画布形状 → 后端 `_resolve_voice_ref` 吃的 snake_case 形状。

    映射逐字对齐前端投递时做的那一次（`frontend/src/api/ops.ts:2074-2090`）。
    """
    return {
        "scope": str(voice_ref.get("scope") or ""),
        "character_name": str(voice_ref.get("characterName") or ""),
        "identity_id": str(voice_ref.get("identityId") or ""),
        "slot": str(voice_ref.get("slot") or ""),
        "voice_id": str(voice_ref.get("voiceId") or ""),
    }


def voice_ref_label(voice_ref: dict) -> str:
    scope = str(voice_ref.get("scope") or "")
    character = str(voice_ref.get("characterName") or "").strip()
    if scope == "project_narrator":
        return "项目解说声线"
    if scope == "character_default":
        return f"{character or '角色'} · 默认声线"
    if scope == "character_age_group":
        slot = str(voice_ref.get("slot") or "").strip()
        return f"{character or '角色'} · {slot or '年龄段'}"
    identity = str(voice_ref.get("identityId") or "").strip()
    return f"{character or '角色'} · 身份 {identity or '未知'}"


def convert_canvas_payload(
    payload: dict,
    *,
    resolve_account_voice_id: Callable[[dict], str],
) -> int:
    """就地改写一张画布，返回改写的节点数。已是账号级的节点原样不动。"""
    converted = 0
    for voice_ref in list(iter_voice_refs(payload)):
        voice_id = resolve_account_voice_id(dict(voice_ref))
        voice_ref.clear()
        voice_ref["scope"] = USER_VOICE_SCOPE
        voice_ref["voiceId"] = str(voice_id)
        converted += 1
    return converted


# ---------------------------------------------------------------------------
# 磁盘侧
# ---------------------------------------------------------------------------


def iter_canvas_files(project_dir: Path) -> list[Path]:
    """项目里的活画布文件。跳墓碑（`*.deleted.json`）、`_history/` 与写入临时文件。"""
    root = canvases_dir(project_dir)
    if not root.is_dir():
        return []
    return sorted(
        path
        for path in root.glob("*.json")
        if not path.name.startswith(".") and not path.name.endswith(".deleted.json")
    )


def convert_project_canvases(
    project_dir: Path,
    *,
    resolve_account_voice_id: Callable[[dict], str],
    apply: bool,
) -> ConversionResult:
    result = ConversionResult()
    for path in iter_canvas_files(project_dir):
        result = replace(result, canvases_scanned=result.canvases_scanned + 1)
        canvas_id = path.stem
        payload = load_canvas_json(path)
        if not isinstance(payload, dict):
            result = replace(
                result, errors=result.errors + (f"{path}: 不是可读的画布 JSON",)
            )
            continue
        if not any(True for _ in iter_voice_refs(payload)):
            continue
        if not apply:
            pending = sum(1 for _ in iter_voice_refs(payload))
            result = replace(result, nodes_converted=result.nodes_converted + pending)
            continue
        # 拿锁之后重读一遍，避免在扫描与写入之间被用户的保存覆盖。
        with canvas_write_lock(project_dir, canvas_id):
            fresh = load_canvas_json(path)
            if not isinstance(fresh, dict):
                result = replace(
                    result, errors=result.errors + (f"{path}: 取锁后读不到画布",)
                )
                continue
            converted = convert_canvas_payload(
                fresh, resolve_account_voice_id=resolve_account_voice_id
            )
            if not converted:
                continue
            atomic_write_json(path, fresh)
        result = replace(
            result,
            canvases_written=result.canvases_written + 1,
            nodes_converted=result.nodes_converted + converted,
        )
    return result


def account_voice_id_for(
    username: str,
    *,
    resolution: FreezoneVoiceRefResolution,
    label: str,
) -> str:
    """把解析出的音频文件登记成账号级音色，按 sha256 复用已登记的那一条。

    去重是可重入的第二道保险：同一个源文件被多个节点引用，或转换被中断后重跑，
    都不会在 `_account/freezone/audio/voices/` 里堆出重复条目。
    """
    sha = str(resolution.sha256 or "")
    if sha:
        for record in list_user_audio_voices(username):
            if str(record.get("sha256") or "") == sha:
                return str(record.get("voice_id") or "")
    created = create_user_audio_voice(
        username=username,
        name=label,
        filename=resolution.audio_path.name,
        content=Path(resolution.audio_path).read_bytes(),
    )
    return str(created.get("voice_id") or "")


async def build_account_voice_map(
    *,
    username: str,
    project: str,
    project_dir: Path,
    voice_refs: dict[str, dict],
) -> dict[str, str]:
    """把每个待改写的项目级引用解析并登记一次，返回 `voice_ref_key -> voice_id`。"""
    from novelvideo.api.deps import make_sqlite_store

    mapping: dict[str, str] = {}
    store = await make_sqlite_store(username, project)
    try:
        for key, voice_ref in voice_refs.items():
            _, resolution = await resolve_speech_voice(
                store=store,
                username=username,
                project=project,
                project_dir=project_dir,
                voice_ref=backend_voice_ref(voice_ref),
            )
            mapping[key] = account_voice_id_for(
                username, resolution=resolution, label=voice_ref_label(voice_ref)
            )
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()
    return mapping


async def convert_project(username: str, project: str, *, apply: bool) -> ConversionResult:
    project_dir = Path(OUTPUT_DIR) / username / project
    files = iter_canvas_files(project_dir)
    pending: dict[str, dict] = {}
    for path in files:
        payload = load_canvas_json(path)
        if not isinstance(payload, dict):
            continue
        for voice_ref in iter_voice_refs(payload):
            pending.setdefault(voice_ref_key(voice_ref), dict(voice_ref))
    if not pending:
        # 完全 no-op：连项目 store 都不开。第二遍就走这条路。
        return ConversionResult(canvases_scanned=len(files))

    if not apply:
        return convert_project_canvases(
            project_dir,
            resolve_account_voice_id=lambda _ref: "",
            apply=False,
        )

    try:
        mapping = await build_account_voice_map(
            username=username,
            project=project,
            project_dir=project_dir,
            voice_refs=pending,
        )
    except Exception as exc:  # noqa: BLE001 - 一个项目失败不该中断整批
        return ConversionResult(
            canvases_scanned=len(files),
            errors=(f"{username}/{project}: 音色解析失败: {exc}",),
        )
    return convert_project_canvases(
        project_dir,
        resolve_account_voice_id=lambda ref: mapping[voice_ref_key(ref)],
        apply=True,
    )


def discover_projects(
    username: str | None = None, project: str | None = None
) -> list[tuple[str, str]]:
    root = Path(OUTPUT_DIR)
    if not root.is_dir():
        return []
    found: list[tuple[str, str]] = []
    for user_dir in sorted(root.iterdir()):
        if not user_dir.is_dir() or user_dir.name.startswith("_"):
            continue
        if username and user_dir.name != username:
            continue
        for project_dir in sorted(user_dir.iterdir()):
            if not project_dir.is_dir() or project_dir.name.startswith("_"):
                continue
            if project and project_dir.name != project:
                continue
            if canvases_dir(project_dir).is_dir():
                found.append((user_dir.name, project_dir.name))
    return found


async def run(
    *, username: str | None, project: str | None, apply: bool
) -> ConversionResult:
    total = ConversionResult()
    for owner, name in discover_projects(username, project):
        result = await convert_project(owner, name, apply=apply)
        total = total.merged(result)
        if result.nodes_converted or result.errors:
            print(
                f"{owner}/{name}: 扫描 {result.canvases_scanned} 张 · "
                f"改写 {result.nodes_converted} 个节点 · 落盘 {result.canvases_written} 张"
            )
    return total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", default=None, help="只处理该用户")
    parser.add_argument("--project", default=None, help="只处理该项目")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="真正写盘；不带则只报告（默认 dry-run）",
    )
    args = parser.parse_args(argv)

    total = asyncio.run(
        run(username=args.username, project=args.project, apply=args.apply)
    )
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"[{mode}] 画布 {total.canvases_scanned} 张 · 待改写/已改写节点 "
        f"{total.nodes_converted} 个 · 落盘 {total.canvases_written} 张"
    )
    for error in total.errors:
        print(f"  ! {error}")
    return 1 if total.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
