"""Loopback browser fixture using real Director routes/SQLite and a synthetic model.

Run directly with the repository virtualenv. It never imports machine credentials
or runs a real model. A fresh temporary project is created on every launch.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException

from novelvideo.api.routes import director
from novelvideo.director import execution, writing
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.store import DirectorStore
from novelvideo.director.workflow import dispatch_planning


def app() -> FastAPI:
    store = DirectorStore(Path(tempfile.mkdtemp(prefix="director-browser-")))
    store.create_work(
        CreateWork(
            title="Synthetic browser validation",
            brief="A key opens a door. One episode, thirty seconds.",
            preset=DirectorPreset(
                mode="original", episode_count=1, duration_seconds=30
            ),
        )
    )
    # A separate synthetic completed work exercises explicit revision without
    # spending on providers or touching any user's project state.
    from novelvideo.director.quality import QualityService
    from tests.director.test_quality import reviewed_command

    completed = store.create_work(
        CreateWork(
            title="Synthetic completed revision validation",
            brief="A red key opens a box.",
            preset=DirectorPreset(
                mode="original", episode_count=2, duration_seconds=30
            ),
        )
    )
    store.put_document(
        completed["id"],
        "outline",
        "# The Last Key\n\n## Story overview\n\n"
        "- **Premise:** Two friends find a red key in an empty workshop.\n"
        "- **Conflict:** The locked box belongs to a friend who has left town.\n"
        "- **Format:** Two episodes, thirty seconds each.\n\n"
        "## Episode directory\n\n1. A key is found.\n2. A promise is kept.\n",
        0,
    )
    for ordinal in (1, 2):
        store.put_document(
            completed["id"],
            f"episode-{ordinal:03d}",
            f"# Scene {ordinal}\nAda uses a red key to open the box.",
            0,
        )
        QualityService(store).finalize(
            "synthetic-browser", reviewed_command(store, completed["id"], ordinal)
        )

    def contract():
        return {"model_name": "synthetic-no-provider", "locked": True}

    execution.director_model_contract = contract
    writing.director_model_contract = contract
    director.director_model_contract = contract

    episode_text = """# 第1集：明天的日期

- **目标时长**：120秒（估算，未试读）
- **题材 / 口味**：职场轻喜剧
- **节拍**：催签 → 发现日期 → 拒签核对
- **核心氛围**：克制的办公室试探
- **本集承接**：开局入局
- **本集钩子**：日期为何是明天
- **关联资产**：人物［许澈、周宁］；场景［办公室］；道具［确认单、手机］

---

## 剧情梗概

许澈请周宁签单，周宁发现页脚日期是明天，拒签并要求核对原件。

---

## 正文

### 1-1｜办公室 日 / 内

出场人物：许澈、周宁

△ 许澈递出确认单，周宁停在页脚。

**周宁：**
*（不抬头）*
“明天的日期，今天就签？”

**许澈：**
“客户催着要。”

### 1-2｜办公室 日 / 内

出场人物：许澈、周宁

△ 周宁把确认单留在手里，没有签。

**周宁：**
“先核对原件。”

△ 许澈拿出自己的手机。
"""
    episode_work = store.create_work(CreateWork(
        title="Synthetic episode streaming validation", brief="Synthetic browser fixture; no provider calls.",
        preset=DirectorPreset(mode="original", episode_count=2, duration_seconds=120),
    ))
    store.put_document(episode_work["id"], "outline", "# Confirmed outline\n\nTwo colleagues check a date.", 0)
    store.put_document(episode_work["id"], "episode-001", episode_text, 0)

    from tests.director.test_outline_review import STORY

    outline_work = store.create_work(
        CreateWork(
            title="Synthetic outline evidence review",
            brief="Ada must lose the next project.",
            preset=DirectorPreset(mode="original", episode_count=1),
        )
    )
    store.put_document(outline_work["id"], "outline", STORY, 0)

    from tests.director.test_characters import sample as character_sample
    from novelvideo.director.characters import render_characters

    character_work = store.create_work(
        CreateWork(
            title="合成人物小传验收",
            brief="林夏接过钥匙，开盒取眼镜读纸条。陈伯不是亲属。",
            preset=DirectorPreset(
                mode="original", episode_count=1, duration_seconds=60
            ),
        )
    )
    store.put_document(
        character_work["id"],
        "outline",
        "# 已确认大纲\n\n林夏接钥匙开盒取眼镜；陈伯递钥匙。",
        0,
    )
    roster, character_root = character_sample()
    # The generic unit fixture deliberately uses EP02; this preview is EP01.
    character_root["episodes"][0]["deliveryLabel"] = "EP01"
    first = roster["characters"][0]
    first.update(
        names=["林夏"],
        setting="修画室里的来客，与陈伯没有亲属关系；年龄与过往经历未设定。想读清生日纸条，先接受陈伯递来的钥匙。",
        dramaticFunction="接钥匙、开盒、取出并戴上修好的眼镜，再读懂纸条；一连串行动构成短片的情绪落点。",
        tags=["克制", "细心"],
        voice="默剧角色，不开口说话；以伸手、戴眼镜和微笑回应。",
        memorableDetail="读不清纸条时眯眼，戴上旧眼镜后舒展眉头。",
        arc="看不清纸条 → 接受帮助并完成开盒动作 → 读懂祝福，以微笑致谢。",
        pressureResponse="以动作寻求帮助；未设定更极端情境的反应。",
        addressRules="无对白，无已确认口头称呼。",
    )
    roster["characters"].append(
        {
            **first,
            "id": "char-2",
            "names": ["陈伯"],
            "role": "main",
            "setting": "修画室里递出钥匙的人，与林夏无亲属关系；年龄及过去经历未设定。",
            "dramaticFunction": "递钥匙后等待林夏自己开盒和读懂纸条，不代替她完成行动。",
            "tags": ["耐心", "尊重"],
            "voice": "不说话，以递出钥匙表达支持。",
            "memorableDetail": "递钥匙后收回手，等待林夏自己打开盒子。",
            "arc": "保持耐心支持，没有新增心理转折。",
            "pressureResponse": "故事未呈现受压情境，不另作虚构。",
        }
    )
    store.put_document(
        character_work["id"], "characters", render_characters(roster, character_root), 0
    )

    from tests.director.test_scenes import sample as scene_sample
    from novelvideo.director.scenes import render_scenes

    scene_work = store.create_work(
        CreateWork(
            title="合成场景设计验收",
            brief="确认单从会议室带到露天院子。",
            preset=DirectorPreset(
                mode="original", episode_count=2, duration_seconds=180
            ),
        )
    )
    store.put_document(
        scene_work["id"],
        "outline",
        "# 已确认大纲\n\n会议室开门进入走廊；第二集回会议室签字后到露天院子。",
        0,
    )
    locations, scene_root = scene_sample()
    scene_root["episodes"] = [
        {"id": "ep-1", "deliveryLabel": "EP01"},
        {"id": "ep-2", "deliveryLabel": "EP02"},
    ]
    locations["locations"] = [
        {
            "id": "meeting",
            "name": "会议室",
            "type": "interior",
            "dramaticFunction": "两次核对确认单的主要空间，第二集签字使责任落实。",
            "spatialConstraints": "长桌放确认单；门关闭，周宁起身开门后才进入走廊。没有未交代的通道。",
            "reusablePositions": "第一、二集同一长桌前核对记录；门口承担离场动作。",
            "keyEpisodeIds": ["ep-1", "ep-2"],
        },
        {
            "id": "hall",
            "name": "走廊",
            "type": "interior",
            "dramaticFunction": "许澈绕过纸箱递交导出记录，使核对行动获得凭据。",
            "spatialConstraints": "拐角纸箱遮挡双方视线，需要绕开才能当面递交。",
            "reusablePositions": "第1集一次出现：拐角纸箱旁。",
            "keyEpisodeIds": ["ep-1"],
        },
        {
            "id": "yard",
            "name": "露天院子",
            "type": "exterior",
            "dramaticFunction": "签认之后的收束空间，周宁握紧确认单。",
            "spatialConstraints": "白天、室外露天；布局未设定，不增设出口或遮挡。",
            "reusablePositions": "第2集仅一次出现；站位未设定。",
            "keyEpisodeIds": ["ep-2"],
        },
    ]
    store.put_document(
        scene_work["id"], "scenes", render_scenes(locations, scene_root), 0
    )

    from tests.director.test_props import sample as prop_sample
    from novelvideo.director.props import render_props

    prop_work = store.create_work(
        CreateWork(
            title="合成道具设计验收",
            brief="两部手机分别接消息和录制，第二集展示而未发送视频。",
            preset=DirectorPreset(
                mode="original", episode_count=2, duration_seconds=180
            ),
        )
    )
    prop_value, prop_root = prop_sample()
    prop_root["episodes"] = [
        {"id": "ep-1", "deliveryLabel": "第 1 集"},
        {"id": "ep-2", "deliveryLabel": "第 2 集"},
    ]
    prop_value["props"] = [
        {
            "id": "phone-zhou",
            "name": "周宁的手机",
            "type": "科技",
            "dramaticFunction": "收到客户‘请核对页脚’的消息，使核对行动有明确起点。",
            "usageBoundary": "第1集始终由周宁持有，只展示接收消息；第2集不出场。没有型号、颜色或额外功能设定。",
            "firstEpisodeId": "ep-1",
            "keyEpisodeIds": ["ep-1"],
        },
        {
            "id": "phone-xu",
            "name": "许澈的手机",
            "type": "证据",
            "dramaticFunction": "第1集录制静止页脚，第2集由许澈回放给周宁核对。",
            "usageBoundary": "两集均由许澈持有，没有交出手机或发送文件；只拍到页脚，不能证明谁修改过文字。",
            "firstEpisodeId": "ep-1",
            "keyEpisodeIds": ["ep-1", "ep-2"],
        },
        {
            "id": "confirmation",
            "name": "纸质确认单",
            "type": "证据",
            "dramaticFunction": "第2集周宁拿出确认单，与视频核对后本人签字，完成核对结果的记录。",
            "usageBoundary": "首次在第2集出现，签字后仍由周宁保留；没有交给许澈、销毁或提前出现在第1集。",
            "firstEpisodeId": "ep-2",
            "keyEpisodeIds": ["ep-2"],
        },
    ]
    store.put_document(
        prop_work["id"], "outline", "# 已确认故事大纲\n\n" + prop_work["brief"], 0
    )
    store.put_document(prop_work["id"], "props", render_props(prop_value, prop_root), 0)

    async def scoped(project, user, role):
        if project != "synthetic" or user != {"username": "synthetic-browser"}:
            raise HTTPException(403)
        return store

    async def model(prompt: str, _name: str, _tokens: int) -> str:
        await asyncio.sleep(3)
        if "TEST_UNKNOWN" in prompt:
            raise TimeoutError("synthetic response loss")
        if '"task": "Independent M12 review"' in prompt:
            from tests.director.test_quality import response

            return json.dumps(response(json.loads(prompt)["frozenInputs"]))
        if '"task": "Independent outline obligations and literary review"' in prompt:
            from tests.director.test_outline_review import response

            data = json.loads(prompt)
            value = response(
                {
                    "contentHash": data["subjectHash"],
                    "obligations": data["obligations"],
                    "passages": data["storyPassages"],
                }
            )
            value["checks"][-1].update(
                status="VIOLATED",
                explanation="Synthetic failure for browser verification, not a literary judgment.",
                suggestion="Inspect the grounded passage before revising.",
            )
            return json.dumps(value)
        parameters = json.loads(
            prompt.split("\nHOST_VERIFIED_METHOD_JSON:")[0].split("\n", 1)[1]
        )["parameters"]
        if parameters.get("output_contract") == "prop-design/1.0.0":
            import copy

            value = copy.deepcopy(prop_value)
            episode_ids = [ep["id"] for ep in parameters["propRoot"]["episodes"]]
            mapping = {"ep-1": episode_ids[0], "ep-2": episode_ids[-1]}
            for prop in value["props"]:
                prop["firstEpisodeId"] = mapping[prop["firstEpisodeId"]]
                prop["keyEpisodeIds"] = list(
                    dict.fromkeys(mapping[key] for key in prop["keyEpisodeIds"])
                )
            return json.dumps(value)
        if parameters.get("output_contract") == "scene-design/1.0.0":
            value, _ = scene_sample()
            value["locations"][0]["keyEpisodeIds"] = [
                parameters["sceneRoot"]["episodes"][0]["id"]
            ]
            return json.dumps(value)
        if parameters.get("output_contract") == "character-biographies/2.2.0":
            value, _ = character_sample()
            first_id = parameters["characterRoot"]["episodes"][0]["id"]
            value["characters"][0].update(
                firstEpisodeId=first_id, keyEpisodeIds=[first_id]
            )
            return json.dumps(value)
        if parameters.get("output_contract") == "story-outline/2.2.0":
            from novelvideo.director.skills.runtime import load_package

            package = load_package("M07")
            value = json.loads(package["files"][package["manifest"].fixtures])[0][
                "value"
            ]
            root = parameters["outlineRoot"]
            episodes = root["episodes"]
            value["structureId"] = root["preset"]["structure"]
            value["totalDurationSeconds"] = (
                len(episodes) * root["preset"]["duration_seconds"]
            )
            value["segments"][0]["episodeIds"] = [ep["id"] for ep in episodes]
            value["whyWatch"] = [
                {"episodeId": ep["id"], "reason": "Synthetic action and payoff."}
                for ep in episodes
            ]
            value["hooks"][0]["episodeId"] = episodes[0]["id"]
            value["setups"][0].update(
                plantEpisodeId=episodes[0]["id"], payoffEpisodeId=episodes[-1]["id"]
            )
            return json.dumps(value)
        return "# Synthetic outline\n\nA key is found. The locked door is opened.\n\nBrowser fixture only; no provider call."

    async def streamed_model(prompt, _name, _tokens, *, on_delta):
        for offset in range(0, len(episode_text), 18):
            await asyncio.sleep(0.2)
            await on_delta(episode_text[offset:offset + 18])
            if offset > 100 and "TEST_UNKNOWN" in prompt:
                raise TimeoutError("synthetic mid-stream interruption")
        return writing.WritingResult(episode_text, 100, 200, 1, "stop", "synthetic-no-provider")

    from novelvideo.director import dispatch as dispatch_module

    dispatch_module.run_bounded_writing_model = streamed_model

    async def dispatch(repository, work_id, run_id):
        with repository.store._connect() as db:
            snapshot = repository.snapshot(db, run_id)
        return await dispatch_writing(repository, work_id, run_id, None if snapshot["parameters"].get("stream") else model)

    async def plan(repository, work_id):
        from tests.director.test_workflow import output_for

        async def planning_model(prompt, _name, _tokens):
            await asyncio.sleep(1)
            parameters = json.loads(
                prompt.split("\nHOST_VERIFIED_METHOD_JSON:")[0].split("\n", 1)[1]
            )["parameters"]
            return json.dumps(output_for((store, work_id), parameters["stage"]))

        return await dispatch_planning(repository, work_id, planning_model)

    director._store = scoped
    director.dispatch_writing = dispatch
    director.dispatch_planning = plan
    application = FastAPI()
    # The browser media path uses real Director intents but a fake shared queue.
    # This fixture never reaches any configured image provider.
    from novelvideo.api.routes import freezone
    from fastapi.responses import Response
    from tests.director.test_media import CATALOG
    media_jobs = []

    async def media_models(project="synthetic", user=None):
        return {"ok": True, "data": CATALOG}

    async def media_generate(project, body, user):
        job_id = body.node_id
        media_jobs.append({"task_key": f"synthetic:{job_id}", "task_type": "freezone_gen", "status": "completed",
                           "project": "synthetic", "username": "synthetic-browser", "episode": 0,
                           "metadata": {"actualRequest": body.model_dump()}})
        return {"ok": True, "data": {"task_key": f"synthetic:{job_id}", "task_type": "freezone_gen", "job_id": job_id}}

    freezone.freezone_image_models = media_models
    freezone.freezone_gen = media_generate
    application.get("/api/v1/projects/synthetic/freezone/image/models")(media_models)

    @application.get("/api/v1/projects/synthetic/tasks")
    async def media_tasks():
        return {"ok": True, "data": media_jobs}

    @application.get("/api/v1/projects/synthetic/freezone/jobs/freezone_gen/{job_id}/result")
    async def media_result(job_id: str):
        if not any(task["task_key"] == f"synthetic:{job_id}" for task in media_jobs):
            raise HTTPException(404)
        return {"ok": True, "data": {"url": "/api/v1/synthetic-media.svg"}}

    @application.get("/api/v1/synthetic-media.svg")
    async def media_image():
        return Response('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#292929"/><text x="40" y="140" fill="#ddd" font-size="24">Synthetic image - no provider</text></svg>', media_type="image/svg+xml")
    application.include_router(director.router, prefix="/api/v1")
    application.dependency_overrides[director.get_api_user] = lambda: {
        "username": "synthetic-browser"
    }
    return application


if __name__ == "__main__":
    uvicorn.run(app(), host="127.0.0.1", port=18780, log_level="warning")
