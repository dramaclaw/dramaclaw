"""B2 §4 第 3 条：存量画布节点里的项目级音色引用一次性改写成账号级。

依据：
- B2 §4 第 3 条「已保存的画布里引用了项目级音色的节点，需要一次性重写成账号级引用。
  这是 B2 里**唯一的存量数据改写**」。
- B2 §9 已判：**独立脚本，不进迁移**（量级百级）。
- 任务书 C1：「转换脚本：**可重入** —— 同一批存量节点跑两遍，第二遍是 no-op，断言之。」

节点里的 `voiceRef` 是前端形状（camelCase，见
`frontend/src/features/canvas/domain/canvasNodes.ts:444-456`），
账号级引用即 `{"scope": "user_custom", "voiceId": ...}`
（`freezone/audio_node.py:42` `USER_VOICE_SCOPE`）。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from novelvideo.freezone.paths import canvas_path

SCRIPT_PATH = (
    Path(__file__).resolve().parents[1] / "scripts/convert_canvas_voice_refs.py"
)
SPEC = importlib.util.spec_from_file_location("convert_canvas_voice_refs", SCRIPT_PATH)
assert SPEC is not None
converter = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = converter
SPEC.loader.exec_module(converter)


def _canvas_payload(nodes: list[dict]) -> dict:
    return {
        "schema_version": 2,
        "canvas_id": "default",
        "project_id": "proj_1",
        "revision": 7,
        "nodes": nodes,
        "edges": [],
    }


def _audio_node(node_id: str, voice_ref: dict | None) -> dict:
    return {
        "id": node_id,
        "type": "audioOperations",
        "position": {"x": 0, "y": 0},
        "data": {"label": "配音", "voiceRef": voice_ref},
    }


def _stub_resolver(counter: list[str]):
    def _resolve(voice_ref: dict) -> str:
        counter.append(str(voice_ref.get("scope") or ""))
        return f"fv_stub_{len(counter)}"

    return _resolve


# --------------------------------------------------------------------------
# 纯 payload 改写
# --------------------------------------------------------------------------


def test_converts_every_project_level_scope() -> None:
    payload = _canvas_payload(
        [
            _audio_node("n1", {"scope": "character_default", "characterName": "小明"}),
            _audio_node(
                "n2", {"scope": "character_age_group", "characterName": "小明", "slot": "young"}
            ),
            _audio_node("n3", {"scope": "identity", "identityId": "id_1"}),
            _audio_node("n4", {"scope": "identity_resolved", "identityId": "id_1"}),
            _audio_node("n5", {"scope": "project_narrator"}),
        ]
    )
    seen: list[str] = []

    converted = converter.convert_canvas_payload(
        payload, resolve_account_voice_id=_stub_resolver(seen)
    )

    assert converted == 5
    assert seen == [
        "character_default",
        "character_age_group",
        "identity",
        "identity_resolved",
        "project_narrator",
    ]
    for node in payload["nodes"]:
        assert node["data"]["voiceRef"]["scope"] == "user_custom"
        assert node["data"]["voiceRef"]["voiceId"].startswith("fv_stub_")
        # 项目级键必须清掉，否则改写完还留着钉项目的字段。
        assert "characterName" not in node["data"]["voiceRef"]
        assert "identityId" not in node["data"]["voiceRef"]
        assert "slot" not in node["data"]["voiceRef"]


def test_leaves_account_level_and_voiceless_nodes_alone() -> None:
    payload = _canvas_payload(
        [
            _audio_node("n1", {"scope": "user_custom", "voiceId": "fv_existing"}),
            _audio_node("n2", None),
            {"id": "n3", "type": "imageOperations", "data": {"label": "出图"}},
        ]
    )
    seen: list[str] = []

    converted = converter.convert_canvas_payload(
        payload, resolve_account_voice_id=_stub_resolver(seen)
    )

    assert converted == 0
    assert seen == []
    assert payload["nodes"][0]["data"]["voiceRef"] == {
        "scope": "user_custom",
        "voiceId": "fv_existing",
    }


def test_payload_conversion_is_reentrant() -> None:
    payload = _canvas_payload(
        [_audio_node("n1", {"scope": "character_default", "characterName": "小明"})]
    )
    seen: list[str] = []
    resolver = _stub_resolver(seen)

    assert converter.convert_canvas_payload(payload, resolve_account_voice_id=resolver) == 1
    snapshot = json.dumps(payload, ensure_ascii=False, sort_keys=True)

    assert converter.convert_canvas_payload(payload, resolve_account_voice_id=resolver) == 0
    assert json.dumps(payload, ensure_ascii=False, sort_keys=True) == snapshot
    assert len(seen) == 1


# --------------------------------------------------------------------------
# 落盘：跑两遍，第二遍是 no-op
# --------------------------------------------------------------------------


def _write_canvas(project_dir: Path, canvas_id: str, payload: dict) -> Path:
    path = canvas_path(project_dir, canvas_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def test_convert_project_canvases_second_run_is_a_noop(tmp_path: Path) -> None:
    project_dir = tmp_path / "output" / "alice" / "demo"
    _write_canvas(
        project_dir,
        "default",
        _canvas_payload(
            [_audio_node("n1", {"scope": "character_default", "characterName": "小明"})]
        ),
    )
    _write_canvas(
        project_dir,
        "second",
        _canvas_payload([_audio_node("n2", {"scope": "user_custom", "voiceId": "fv_x"})]),
    )
    seen: list[str] = []
    resolver = _stub_resolver(seen)

    first = converter.convert_project_canvases(
        project_dir, resolve_account_voice_id=resolver, apply=True
    )
    assert first.canvases_scanned == 2
    assert first.canvases_written == 1
    assert first.nodes_converted == 1

    after_first = {
        path.name: path.read_bytes()
        for path in sorted(canvas_path(project_dir, "default").parent.glob("*.json"))
    }

    second = converter.convert_project_canvases(
        project_dir, resolve_account_voice_id=resolver, apply=True
    )
    assert second.canvases_scanned == 2
    assert second.canvases_written == 0
    assert second.nodes_converted == 0
    assert len(seen) == 1

    after_second = {
        path.name: path.read_bytes()
        for path in sorted(canvas_path(project_dir, "default").parent.glob("*.json"))
    }
    assert after_second == after_first


def test_dry_run_reports_without_writing(tmp_path: Path) -> None:
    project_dir = tmp_path / "output" / "alice" / "demo"
    path = _write_canvas(
        project_dir,
        "default",
        _canvas_payload(
            [_audio_node("n1", {"scope": "character_default", "characterName": "小明"})]
        ),
    )
    before = path.read_bytes()

    result = converter.convert_project_canvases(
        project_dir, resolve_account_voice_id=_stub_resolver([]), apply=False
    )

    assert result.nodes_converted == 1
    assert result.canvases_written == 0
    assert path.read_bytes() == before


def test_applied_conversion_bumps_revision_and_publishes_change(tmp_path, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    path = _write_canvas(
        tmp_path,
        "default",
        _canvas_payload([_audio_node("n1", {"scope": "project_narrator"})]),
    )

    result = converter.convert_project_canvases(
        tmp_path, resolve_account_voice_id=_stub_resolver([]), apply=True
    )

    assert result.canvases_written == 1
    assert result.nodes_converted == 1
    assert result.errors == ()
    assert json.loads(path.read_text())["revision"] == 8
    log_dir = tmp_path / "freezone" / "canvas_changes" / "default"
    assert [entry.name for entry in log_dir.glob("*.json")] == ["000000000008.json"]
    entry = json.loads((log_dir / "000000000008.json").read_text())
    assert entry["base_revision"] == 7
    assert entry["revision"] == 8
    assert entry["save_source"] == "voice_ref_conversion"
    assert entry["nodes"][0]["data"]["voiceRef"] == {
        "scope": "user_custom", "voiceId": "fv_stub_1"
    }


def test_applied_conversion_uses_fresh_canvas_and_preserves_history(tmp_path, monkeypatch):
    from novelvideo.freezone import canvas_store

    path = _write_canvas(
        tmp_path,
        "default",
        _canvas_payload([_audio_node("n1", {"scope": "project_narrator"})]),
    )
    original_save = canvas_store.save_canvas

    def save_after_concurrent_edit(*args, **kwargs):
        fresh = json.loads(path.read_text())
        fresh["revision"] = 9
        fresh["nodes"].append({"id": "concurrent-node", "data": {"label": "Fresh"}})
        path.write_text(json.dumps(fresh))
        return original_save(*args, **kwargs)

    monkeypatch.setattr(canvas_store, "save_canvas", save_after_concurrent_edit)
    result = converter.convert_project_canvases(
        tmp_path, resolve_account_voice_id=_stub_resolver([]), apply=True
    )

    assert result.canvases_written == 1
    assert result.nodes_converted == 1
    saved = json.loads(path.read_text())
    assert saved["revision"] == 10
    assert saved["nodes"][1] == {"id": "concurrent-node", "data": {"label": "Fresh"}}
    [history] = (path.parent / "_history").glob("*.json")
    old = json.loads(history.read_text())
    assert old["revision"] == 9
    assert old["nodes"][0]["data"]["voiceRef"] == {"scope": "project_narrator"}


@pytest.mark.parametrize("fresh_state", ["converted", "missing", "corrupt"])
def test_conversion_handles_canvas_changed_after_scan(tmp_path, monkeypatch, fresh_state):
    from novelvideo.freezone import canvas_store

    path = _write_canvas(
        tmp_path,
        "default",
        _canvas_payload([_audio_node("n1", {"scope": "project_narrator"})]),
    )
    original_save = canvas_store.save_canvas

    def save_after_concurrent_edit(*args, **kwargs):
        if fresh_state == "missing":
            path.unlink()
        elif fresh_state == "corrupt":
            path.write_text("not json")
        else:
            payload = _canvas_payload([
                _audio_node("n1", {"scope": "user_custom", "voiceId": "existing"})
            ])
            path.write_text(json.dumps(payload))
        return original_save(*args, **kwargs)

    monkeypatch.setattr(canvas_store, "save_canvas", save_after_concurrent_edit)
    seen = []
    result = converter.convert_project_canvases(
        tmp_path, resolve_account_voice_id=_stub_resolver(seen), apply=True
    )
    assert result.canvases_written == 0
    assert result.nodes_converted == 0
    assert seen == []
    assert len(result.errors) == (0 if fresh_state == "converted" else 1)


def test_conversion_reports_unreadable_canvas(tmp_path):
    path = _write_canvas(tmp_path, "default", {})
    path.write_text("not json")
    result = converter.convert_project_canvases(
        tmp_path, resolve_account_voice_id=_stub_resolver([]), apply=True
    )
    assert result.canvases_scanned == 1
    assert result.canvases_written == 0
    assert result.nodes_converted == 0
    assert result.errors == (f"{path}: unreadable canvas JSON",)


async def test_project_entry_point_dry_run_scans_without_writing(tmp_path, monkeypatch):
    monkeypatch.setattr(converter, "OUTPUT_DIR", str(tmp_path))
    path = _write_canvas(
        tmp_path / "alice" / "demo",
        "default",
        _canvas_payload([_audio_node("n1", {"scope": "project_narrator"})]),
    )
    before = path.read_bytes()
    result = await converter.convert_project("alice", "demo", apply=False)
    assert result.canvases_scanned == 1
    assert result.nodes_converted == 1
    assert result.canvases_written == 0
    assert path.read_bytes() == before


def test_scan_skips_deleted_tombstones_and_history(tmp_path: Path) -> None:
    project_dir = tmp_path / "output" / "alice" / "demo"
    canvases = canvas_path(project_dir, "default").parent
    canvases.mkdir(parents=True, exist_ok=True)
    live = _write_canvas(project_dir, "default", _canvas_payload([]))
    (canvases / "default.deleted.json").write_text("{}", encoding="utf-8")
    history = canvases / "_history"
    history.mkdir(parents=True, exist_ok=True)
    (history / "default.20260101_000000_000000.json").write_text("{}", encoding="utf-8")

    assert converter.iter_canvas_files(project_dir) == [live]


# --------------------------------------------------------------------------
# 账号级音色登记：同一个源文件不重复登记
# --------------------------------------------------------------------------


def test_account_voice_is_reused_by_sha256(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from novelvideo.freezone import audio_node

    monkeypatch.setattr(audio_node, "OUTPUT_DIR", str(tmp_path / "output"))
    source = tmp_path / "xiaoming.wav"
    source.write_bytes(b"character-reference-audio")
    resolution = audio_node.FreezoneVoiceRefResolution(
        source, audio_node.file_sha256(source), "character_default"
    )

    first = converter.account_voice_id_for(
        "alice", resolution=resolution, label="小明 · 默认声线"
    )
    second = converter.account_voice_id_for(
        "alice", resolution=resolution, label="小明 · 默认声线"
    )

    assert first.startswith("fv_")
    assert second == first
    assert len(audio_node.list_user_audio_voices("alice")) == 1
