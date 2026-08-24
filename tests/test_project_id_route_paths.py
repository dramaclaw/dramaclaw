from __future__ import annotations

from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_asset_references_resolves_project_id_before_opening_store(monkeypatch, tmp_path):
    from novelvideo.api.routes import assets
    from novelvideo.models import NovelVisualBeat

    class Store:
        async def list_visual_beats(self):
            return [
                NovelVisualBeat(
                    episode_number=1,
                    beat_number=2,
                    narration="n",
                    visual_description="v",
                    scene_ref_json='{"scene_id": "客厅"}',
                    detected_identities_json="[]",
                    detected_props_json="[]",
                )
            ]

        async def close(self):
            return None

    ctx = SimpleNamespace(
        project_id="01PROJECTID",
        owner_username="admin",
        project_name="xuanchuanpian",
        output_dir=tmp_path / "output" / "admin" / "xuanchuanpian",
        state_dir=tmp_path / "state" / "admin" / "xuanchuanpian",
        runtime_dir=tmp_path / "runtime" / "admin" / "xuanchuanpian",
    )
    calls: list[tuple[str, str]] = []

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert project == "01PROJECTID"
        assert required_role == "viewer"
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="xuanchuanpian",
            project_dir=ctx.output_dir,
            output_dir=str(ctx.output_dir),
            state_dir=str(ctx.state_dir),
            runtime_dir=str(ctx.runtime_dir),
        )

    async def fake_make_sqlite_store_for_context(ctx_arg, **_kwargs):
        assert ctx_arg is ctx
        calls.append((ctx_arg.owner_username, ctx_arg.project_name))
        return Store()

    def legacy_get_project_dir(*_args, **_kwargs):
        raise AssertionError("route must not treat project_id as a filesystem project name")

    monkeypatch.setattr(assets, "resolve_project_scope", fake_resolve_project_scope, raising=False)
    monkeypatch.setattr(
        assets,
        "make_sqlite_store_for_context",
        fake_make_sqlite_store_for_context,
        raising=False,
    )
    monkeypatch.setattr(assets, "get_project_dir", legacy_get_project_dir, raising=False)

    result = await assets.get_asset_references(
        project="01PROJECTID",
        asset_type="scene",
        asset_id="客厅",
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["beats"] == [{"episode": 1, "beat_number": 2}]
    assert calls == [("admin", "xuanchuanpian")]


@pytest.mark.asyncio
async def test_verification_routes_resolve_project_id_before_opening_project_dir(
    monkeypatch,
    tmp_path,
):
    from novelvideo.verification import routes

    ctx = SimpleNamespace(
        project_id="01PROJECTID",
        owner_username="admin",
        project_name="xuanchuanpian",
        output_dir=tmp_path / "output" / "admin" / "xuanchuanpian",
        state_dir=tmp_path / "state" / "admin" / "xuanchuanpian",
        runtime_dir=tmp_path / "runtime" / "admin" / "xuanchuanpian",
    )
    ctx.output_dir.mkdir(parents=True)

    class Store:
        async def close(self):
            return None

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        assert project == "01PROJECTID"
        assert required_role == "viewer"
        return SimpleNamespace(
            ctx=ctx,
            username="admin",
            project_name="xuanchuanpian",
            project_dir=ctx.output_dir,
            output_dir=str(ctx.output_dir),
            state_dir=str(ctx.state_dir),
            runtime_dir=str(ctx.runtime_dir),
        )

    async def fake_make_sqlite_store_for_context(ctx_arg, **_kwargs):
        assert ctx_arg is ctx
        return Store()

    def legacy_get_project_dir(*_args, **_kwargs):
        raise AssertionError("route must not treat project_id as a filesystem project name")

    async def fake_detect_similarity(project_dir, episode_num, *, sqlite_store):
        assert project_dir == ctx.output_dir
        assert episode_num == 1
        assert isinstance(sqlite_store, Store)
        return SimpleNamespace(model_dump=lambda: {"duplicates": []})

    def fake_save_verify_report(project_dir, episode_num, beat_num, report_type, data):
        assert project_dir == ctx.output_dir
        assert episode_num == 1
        assert beat_num is None
        assert report_type == "similarity"
        report_path = ctx.output_dir / "verify_reports" / "ep001" / "similarity.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text("{}", encoding="utf-8")
        return report_path

    monkeypatch.setattr(routes, "resolve_project_scope", fake_resolve_project_scope)
    monkeypatch.setattr(
        routes,
        "make_sqlite_store_for_context",
        fake_make_sqlite_store_for_context,
        raising=False,
    )
    monkeypatch.setattr(routes, "get_project_dir", legacy_get_project_dir, raising=False)
    monkeypatch.setattr(routes, "detect_similarity", fake_detect_similarity)
    monkeypatch.setattr(routes, "save_verify_report", fake_save_verify_report)

    result = await routes.verify_similarity(
        project="01PROJECTID",
        episode_num=1,
        user={"username": "admin"},
    )

    assert result == {
        "ok": True,
        "data": {
            "duplicates": [],
            "report_path": "verify_reports/ep001/similarity.json",
        },
    }
