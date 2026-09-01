from novelvideo.freezone.workflow_drafts import _plan_preview


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
