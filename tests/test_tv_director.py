from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import director
from novelvideo.director.models import (
    CreateWork,
    DirectorPreset,
    GenerateDraft,
    UpdateWork,
    document_key,
)
from novelvideo.director.store import (
    DirectorConflict,
    DirectorInvalidState,
    DirectorStore,
)
from novelvideo.director.writing import METHOD_VERSION, compile_generation
from novelvideo.director import writing


@pytest.fixture(autouse=True)
def isolated_gateway_contract(monkeypatch):
    # Unit compilation must not consult the developer's live catalog/credentials.
    monkeypatch.setattr(writing, "get_effective_newapi_gateway_config", lambda: SimpleNamespace(base_url="https://example.invalid/v1"))


def _original(episodes: int = 2) -> CreateWork:
    return CreateWork(
        title="被删的邮件",
        brief="办公室内，两集各三十秒；U盘和日志编号在第二集兑现。",
        preset=DirectorPreset(
            mode="original",
            primary_genre="现实职场成长",
            visual_style="都市写实",
            structure="three_act",
            episode_count=episodes,
            duration_seconds=30,
        ),
    )


def _adaptation() -> CreateWork:
    return CreateWork(
        title="非妖哉第二集改编",
        brief="只改原稿第二集，不补第一集。",
        source_text="第2集\n最后一线日光退尽，昼童化为绫娘。\n小画落入湖中，大郎捞回。",
        preset=DirectorPreset(
            mode="adaptation",
            adapt_direction="condense",
            episode_count=1,
            duration_seconds=415,
            source_episode_label="EP02",
            delivery_episode_label="EP02",
        ),
    )


def test_source_episode_identity_survives_internal_ordinal(tmp_path: Path) -> None:
    store = DirectorStore(tmp_path)
    work = store.create_work(_adaptation())
    command = GenerateDraft(kind="episode", episode_ordinal=1, expected_version=0)
    compiled = compile_generation(store, work["id"], command)

    assert compiled["parameters"]["source_episode_label"] == "EP02"
    assert compiled["parameters"]["delivery_episode_label"] == "EP02"
    assert compiled["parameters"]["workflow_episode_ordinal"] == 1
    assert compiled["doc_key"] == "episode-001"
    assert "第2集" in compiled["prompt"]
    assert METHOD_VERSION in compiled["prompt"]
    assert work["source_sha256"]


@pytest.mark.parametrize(
    "structure",
    ["three_act", "five_act", "hero", "parallel", "cross", "nonlinear", "loop", "unit"],
)
def test_every_visible_parameter_survives_save_reload_and_compilation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, structure: str
) -> None:
    monkeypatch.setattr(
        writing,
        "director_model_contract",
        lambda: {"model_name": "test-model", "locked": False},
    )
    preset = DirectorPreset(
        mode="adaptation",
        primary_genre="mystery",
        fusion_genre="comedy",
        audience="adult",
        characters="two friends",
        era="present",
        highlights="visible clues",
        visual_style="ink",
        narrative_tone="dry comedy",
        ending_type="reversal",
        output_language="en",
        market="global",
        fidelity="approved_changes",
        locked_facts="Keep the red key",
        allowed_additions="Only weather",
        model_name="test-model",
        structure=structure,
        episode_count=1,
        duration_seconds=45,
        adapt_direction="condense",
        source_episode_label="EP02",
        delivery_episode_label="Pilot",
    )
    store = DirectorStore(tmp_path)
    work = store.create_work(
        CreateWork(
            title="Parameter fixture",
            source_text="Two friends find a red key.",
            preset=preset,
        )
    )
    reopened = DirectorStore(tmp_path)
    assert reopened.get_work(work["id"])["preset"] == preset.model_dump()
    compiled = compile_generation(
        reopened,
        work["id"],
        GenerateDraft(kind="episode", episode_ordinal=1, expected_version=0),
    )
    for field, value in preset.model_dump().items():
        assert compiled["parameters"][field] == value, field
    assert "locked-facts" in compiled["prompt"]
    assert "G08" not in compiled["parameters"]["selected_rule_ids"].split(",")


def test_settings_are_persisted_before_writing_and_frozen_after(tmp_path: Path) -> None:
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_original())["id"]
    updated = store.update_work(
        work_id,
        UpdateWork(
            title="新版标题",
            brief="新版要求",
            source_text="",
            preset=DirectorPreset(
                mode="original", primary_genre="规则怪谈悬疑", episode_count=3
            ),
            expected_revision=1,
        ),
    )
    assert updated["revision"] == 2
    assert updated["preset"]["episode_count"] == 3
    assert store.get_work(work_id, include_source=True)["source_text"] == ""
    with pytest.raises(DirectorConflict, match="settings changed"):
        store.update_work(
            work_id, UpdateWork(**{**_original().model_dump(), "expected_revision": 1})
        )
    store.put_document(work_id, "outline", "已经开始写作", 0)
    with pytest.raises(DirectorInvalidState, match="settings are frozen"):
        store.update_work(
            work_id, UpdateWork(**{**_original().model_dump(), "expected_revision": 3})
        )


def test_failed_model_run_allows_settings_recovery_without_losing_audit(
    tmp_path: Path,
) -> None:
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_original())["id"]
    run_id = store.start_run(work_id, "outline", "test-input-hash")
    store.finish_run(work_id, run_id, error="upstream 502")
    updated = store.update_work(
        work_id,
        UpdateWork(
            **{**_original().model_dump(), "expected_revision": 1},
        ),
    )
    assert updated["revision"] == 2
    assert store.list_runs(work_id)[0]["status"] == "failed"


def test_document_version_conflict_and_pending_review_survive_restart(
    tmp_path: Path,
) -> None:
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_original())["id"]
    document = store.put_document(work_id, "outline", "原始大纲", 0)
    change = store.propose_change(work_id, "outline", "改过的大纲", 1, "加入伏笔")

    reopened = DirectorStore(tmp_path)
    assert reopened.get_document(work_id, "outline") == document
    assert reopened.list_changes(work_id)[0]["status"] == "pending"
    with pytest.raises(DirectorConflict):
        reopened.put_document(work_id, "outline", "过期覆盖", 0)
    with pytest.raises(DirectorInvalidState, match="pending proposal"):
        reopened.put_document(work_id, "outline", "绕过审阅的覆盖", 1)

    accepted = reopened.decide_change(work_id, change["id"], True)
    assert accepted["document"]["version"] == 2
    assert reopened.get_document(work_id, "outline")["content"] == "改过的大纲"
    with pytest.raises(DirectorConflict):
        reopened.decide_change(work_id, change["id"], True)


def test_reject_keeps_formal_version_and_cross_work_change_is_inaccessible(
    tmp_path: Path,
) -> None:
    store = DirectorStore(tmp_path)
    first = store.create_work(_original())["id"]
    second = store.create_work(_original())["id"]
    change = store.propose_change(first, "outline", "建议稿", 0, "test")
    with pytest.raises(Exception, match="change not found"):
        store.decide_change(second, change["id"], True)
    rejected = store.decide_change(first, change["id"], False)
    assert rejected["change"]["status"] == "rejected"
    assert store.get_document(first, "outline")["version"] == 0


def test_two_episode_confirmation_is_separate_from_change_acceptance(
    tmp_path: Path,
) -> None:
    from tests.director.test_quality import reviewed_command
    from novelvideo.director.quality import QualityService

    store = DirectorStore(tmp_path)
    work_id = store.create_work(_original())["id"]
    first = store.put_document(work_id, "episode-001", "第一集正文", 0)
    assert store.quality_report(work_id, 1)["ready_for_human_review"]
    with pytest.raises(DirectorInvalidState):
        store.finalize_episode(work_id, 1, first["version"], False)
    change = store.propose_change(work_id, "episode-001", "第一集修改稿", 1, "修正台词")
    assert "PENDING_CHANGES" in store.quality_report(work_id, 1)["blockers"]
    with pytest.raises(DirectorInvalidState):
        store.finalize_episode(work_id, 1, 1, True)
    store.decide_change(work_id, change["id"], True)
    after_first = QualityService(store).finalize(
        "test-user", reviewed_command(store, work_id)
    )["work"]
    assert after_first["current_episode"] == 2
    assert after_first["status"] == "awaiting_next_episode"
    with pytest.raises(DirectorInvalidState, match="current checkpoint"):
        store.put_document(work_id, "episode-001", "定稿后覆盖", 2)
    assert store.put_document(work_id, "episode-002", "第二集正文", 0)["version"] == 1
    after_second = QualityService(store).finalize(
        "test-user", reviewed_command(store, work_id, 2)
    )["work"]
    assert after_second["status"] == "completed"
    with pytest.raises(DirectorInvalidState, match="completed work"):
        store.put_document(work_id, "outline", "定稿后覆盖大纲", 0)
    assert [
        event["kind"]
        for event in store.list_events(work_id)
        if event["kind"] == "episode.confirmed"
    ] == ["episode.confirmed", "episode.confirmed"]


def test_episode_scope_and_empty_confirmation_are_blocked(tmp_path: Path) -> None:
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_original())["id"]
    with pytest.raises(DirectorInvalidState, match="current checkpoint"):
        store.put_document(work_id, "episode-002", "越过第一集", 0)
    empty = store.put_document(work_id, "episode-001", "  ", 0)
    with pytest.raises(DirectorInvalidState, match="EMPTY_EPISODE"):
        store.finalize_episode(work_id, 1, empty["version"], True)


def test_quality_report_blocks_wrong_source_episode_label(tmp_path: Path) -> None:
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_adaptation())["id"]
    document = store.put_document(work_id, "episode-001", "# 第1集\n错误集号", 0)
    report = store.quality_report(work_id, 1)
    assert report["version"] == document["version"]
    assert "EPISODE_LABEL_MISMATCH" in report["blockers"]
    assert "SOURCE_EVENTS_UNVERIFIED" in report["warnings"]
    with pytest.raises(DirectorInvalidState, match="EPISODE_LABEL_MISMATCH"):
        store.finalize_episode(work_id, 1, document["version"], True)


def test_quality_report_understands_chinese_episode_numbers(tmp_path: Path) -> None:
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_adaptation())["id"]
    wrong = store.put_document(work_id, "episode-001", "# 第一集\n错误集号", 0)
    assert "EPISODE_LABEL_MISMATCH" in store.quality_report(work_id, 1)["blockers"]
    matching = store.put_document(
        work_id, "episode-001", "# 第二集\n正确集号", wrong["version"]
    )
    report = store.quality_report(work_id, 1)
    assert report["version"] == matching["version"]
    assert "EPISODE_LABEL_MISMATCH" not in report["blockers"]
    assert DirectorStore._episode_number("第九十九集") == 99
    assert DirectorStore._episode_number("第一百集") == 100


def test_generation_hash_changes_with_displayed_parameters(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        writing,
        "director_model_contract",
        lambda: {
            "model_name": "configured-default",
            "locked": False,
        },
    )
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_original())["id"]
    base = GenerateDraft(kind="outline", expected_version=0)
    first = compile_generation(store, work_id, base)
    second = compile_generation(
        store,
        work_id,
        GenerateDraft(kind="outline", expected_version=0, instruction="保留日志编号"),
    )
    assert first["input_sha256"] != second["input_sha256"]
    assert first["parameters"]["episode_count"] == 2
    assert first["parameters"]["duration_seconds"] == 30
    assert first["parameters"]["visual_style"] == "都市写实"
    assert first["parameters"]["model_name"]
    model_override = store.update_work(
        work_id,
        UpdateWork(
            title="被删的邮件",
            brief=_original().brief,
            source_text="",
            preset=DirectorPreset(
                mode="original", model_name="approved-text-model", episode_count=2
            ),
            expected_revision=1,
        ),
    )
    assert model_override["preset"]["model_name"] == "approved-text-model"
    with_override = compile_generation(store, work_id, base)
    assert with_override["parameters"]["model_name"] == "approved-text-model"
    assert with_override["input_sha256"] != first["input_sha256"]


def test_local_gateway_model_contract_uses_catalog_and_rejects_unknown(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from novelvideo.local_model_catalog import LocalModelCatalog, secret_path

    catalog = LocalModelCatalog(tmp_path / "router")
    key_path = secret_path(catalog.root, "ark")
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.touch()
    catalog.update([], {"text": "ark::doubao-seed-evolving"})
    monkeypatch.setattr(
        writing,
        "get_effective_newapi_gateway_config",
        lambda: SimpleNamespace(
            base_url="http://127.0.0.1:3001/v1",
        ),
    )
    monkeypatch.setattr(
        "novelvideo.local_gateway.router_config",
        lambda: SimpleNamespace(
            port=3001,
            root=catalog.root,
        ),
    )
    contract = writing.director_model_contract()
    assert contract["model_name"] == "ark::doubao-seed-evolving"
    assert contract["locked"] is False
    assert {option["id"] for option in contract["options"]} == {
        "ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash"
    }
    assert writing.resolve_director_model("") == contract["model_name"]
    store = DirectorStore(tmp_path)
    work_id = store.create_work(
        CreateWork(
            title="错配检查",
            brief="短剧",
            preset=DirectorPreset(mode="original", model_name="other-model"),
        )
    )["id"]
    with pytest.raises(ValueError, match="not in the local catalog"):
        compile_generation(
            store, work_id, GenerateDraft(kind="outline", expected_version=0)
        )


@pytest.mark.parametrize(
    "key", ["../secret", "episode-000", "episode-999", "Episode-001"]
)
def test_document_key_rejects_noncanonical_paths(key: str) -> None:
    with pytest.raises(ValueError):
        director._validate_doc_key(key)


async def test_generation_requires_unchanged_preview_and_explicit_cost_acknowledgement(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    store = DirectorStore(tmp_path)
    work_id = store.create_work(_original())["id"]

    async def fake_store(*_args, **_kwargs):
        return store

    monkeypatch.setattr(director, "_store", fake_store)
    user = {"username": "writer"}
    preview = await director.preview_director_generation(
        "demo",
        work_id,
        GenerateDraft(kind="outline", expected_version=0),
        user=user,
    )
    digest = preview["data"]["input_sha256"]

    with pytest.raises(HTTPException) as stale:
        await director.generate_director_draft(
            "demo",
            work_id,
            GenerateDraft(
                kind="outline",
                expected_version=0,
                expected_input_sha256="0" * 64,
                acknowledge_model_cost=True,
            ),
            user=user,
        )
    assert stale.value.status_code == 409

    with pytest.raises(HTTPException) as no_ack:
        await director.generate_director_draft(
            "demo",
            work_id,
            GenerateDraft(
                kind="outline", expected_version=0, expected_input_sha256=digest
            ),
            user=user,
        )
    assert no_ack.value.status_code == 409
    with pytest.raises(HTTPException) as upgrade:
        await director.generate_director_draft(
            "demo",
            work_id,
            GenerateDraft(
                kind="outline",
                expected_version=0,
                expected_input_sha256=digest,
                acknowledge_model_cost=True,
            ),
            user=user,
        )
    assert upgrade.value.status_code == 409
    assert upgrade.value.detail["code"] == "EXECUTION_V2_REQUIRED"
    assert store.get_document(work_id, "outline")["version"] == 0
    assert store.list_changes(work_id) == []
    assert DirectorStore(tmp_path).list_runs(work_id) == []


def test_document_key_needs_ordinal_only_for_episode() -> None:
    assert document_key("episode", 2) == "episode-002"
    with pytest.raises(ValueError):
        document_key("episode")
    with pytest.raises(ValueError):
        document_key("outline", 2)
