import pytest

from novelvideo.task_backend.run_core import (
    _completion_metadata_with_provider_task_id,
    _metrics_user_id_for_project_context,
    _resource_refs_for_task_success,
    _set_project_task_metrics_context,
)

pytestmark = pytest.mark.m07


def test_completion_metadata_carries_provider_task_id():
    metadata = _completion_metadata_with_provider_task_id(
        {"celery_task_id": "celery-1"},
        {"provider_task_id": "194f3bde-d486-49c5-8785-a454d3e2fc13"},
    )

    assert metadata == {
        "celery_task_id": "celery-1",
        "provider_task_id": "194f3bde-d486-49c5-8785-a454d3e2fc13",
    }


def test_script_writer_resource_ref_is_episode_slot():
    refs = _resource_refs_for_task_success(
        task_type="script_writer",
        episode=3,
        result={"beats": 18},
    )

    assert refs == ["ep003"]


def test_generation_resource_refs_use_beat_slots_from_result():
    refs = _resource_refs_for_task_success(
        task_type="sketch_regen",
        episode=2,
        result={"updated_beats": [4, "5", 0, "bad", 4]},
    )

    assert refs == ["ep002:beat004", "ep002:beat005"]


def test_generation_resource_refs_keep_scope_for_dynamic_slots():
    refs = _resource_refs_for_task_success(
        task_type="grid_regenerate",
        episode=1,
        beat_num=7,
        scope="character-grid",
        result={"updated_beats": [7]},
    )

    assert refs == ["ep001:beat007:character-grid"]


class _MetricsContext:
    def __init__(
        self,
        *,
        owner_id: str = "",
        requester_user_id: str = "",
        project_id: str = "project_1",
    ):
        self.owner_type = "user"
        self.owner_id = owner_id
        self.requester_user_id = requester_user_id
        self.project_id = project_id


def test_shared_project_model_credits_are_attributed_to_requester():
    ctx = _MetricsContext(owner_id="owner_user", requester_user_id="requester_user")

    assert _metrics_user_id_for_project_context(ctx) == "requester_user"


def test_model_credit_attribution_falls_back_to_owner_without_requester():
    ctx = _MetricsContext(owner_id="owner_user", requester_user_id="")

    assert _metrics_user_id_for_project_context(ctx) == "owner_user"


def test_project_task_metrics_context_carries_shared_project_billing_metadata(monkeypatch):
    calls = []

    class FakeUsageMeter:
        def set_llm_usage_context(self, *args, **kwargs):
            calls.append((args, kwargs))

    monkeypatch.setitem(
        _set_project_task_metrics_context.__globals__,
        "get_usage_meter",
        lambda: FakeUsageMeter(),
    )
    ctx = _MetricsContext(
        project_id="project_1",
        owner_id="owner_user",
        requester_user_id="requester_user",
    )

    _set_project_task_metrics_context(ctx, "freezone_video_gen")

    assert calls == [
        (
            ("requester_user",),
            {
                "project_id": "project_1",
                "resource_kind": "video",
                "billing_metadata": {
                    "billing_user_id": "requester_user",
                    "requester_user_id": "requester_user",
                    "project_owner_id": "owner_user",
                    "billing_task_type": "freezone_video_gen",
                },
            },
        )
    ]


@pytest.mark.parametrize(
    ("task_type", "resource_kind"),
    [
        ("freezone_analyze", "video"),
        ("freezone_video_story", "video"),
        ("freezone_image_reverse_prompt", "script"),
        ("freezone_story_script", "script"),
    ],
)
def test_freezone_ai_project_tasks_set_usage_resource_kind(monkeypatch, task_type, resource_kind):
    calls = []

    class FakeUsageMeter:
        def set_llm_usage_context(self, *args, **kwargs):
            calls.append((args, kwargs))

    monkeypatch.setitem(
        _set_project_task_metrics_context.__globals__,
        "get_usage_meter",
        lambda: FakeUsageMeter(),
    )
    ctx = _MetricsContext(
        project_id="project_1",
        owner_id="owner_user",
        requester_user_id="requester_user",
    )

    _set_project_task_metrics_context(ctx, task_type)

    assert calls[0][1]["resource_kind"] == resource_kind
