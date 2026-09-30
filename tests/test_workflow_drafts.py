from novelvideo.freezone.workflow_drafts import (
    _plan_preview,
    bind_workflow_draft_task,
    claim_workflow_draft_confirmation,
    create_workflow_draft,
    finish_workflow_draft_confirmation,
)


def test_plan_preview_explains_ordered_recipe_pipeline():
    preview = _plan_preview(
        {
            "skill_id": "video-ad",
            "edge_count": 1,
            "plan": {
                "summary": "运动相机广告",
                "phases": ["visual"],
                "inputs": {},
                "nodes": [
                    {
                        "id": "hero",
                        "name": "商品英雄镜头",
                        "stage": "visual",
                        "node_type": "imageGenNode",
                        "data": {
                            "workflowCatalog": {
                                "recipeId": "product-hero",
                                "recipeName": "商品首图",
                                "recipeVersion": "1",
                                "recipePipeline": [
                                    {
                                        "id": "cinematic-lighting",
                                        "name": "电影灯光",
                                        "version": "2",
                                    }
                                ],
                            }
                        },
                    }
                ],
            },
        }
    )

    assert preview["recipe_pipelines"] == [
        {
            "node_id": "hero",
            "node_name": "商品英雄镜头",
            "steps": [
                {
                    "role": "primary",
                    "id": "product-hero",
                    "name": "商品首图",
                    "version": "1",
                },
                {
                    "role": "supplemental",
                    "id": "cinematic-lighting",
                    "name": "电影灯光",
                    "version": "2",
                },
            ],
        }
    ]


def test_late_timeout_result_does_not_downgrade_confirmed_draft(tmp_path):
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad"},
        compiled={
            "ok": True,
            "skill_id": "video-ad",
            "edge_count": 0,
            "plan": {"summary": "广告", "nodes": [], "edges": []},
        },
    )
    claimed, error = claim_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        revision=draft["revision"],
    )
    assert error is None
    assert claimed is not None
    bind_workflow_draft_task(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        task_id="task-1",
        root_task_id="task-1",
    )
    confirmed = finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="confirmed",
        expected_task_id="task-1",
    )
    late = finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="submitted",
        expected_task_id="task-1",
    )

    assert confirmed is not None
    assert late is not None
    assert late["status"] == "confirmed"
    assert late["confirmed_at"] == confirmed["confirmed_at"]
    assert late["updated_at"] == confirmed["updated_at"]
