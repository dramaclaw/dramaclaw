from __future__ import annotations

from pathlib import Path
import json

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import FreezoneStoryScriptGenerateData, FreezoneStoryScriptRow
from novelvideo.freezone.text_node import (
    FREEZONE_TEXT_WRITER_MODEL,
    FREEZONE_TRANSLATION_MODEL,
    FREEZONE_TRANSLATION_PROVIDER,
    FreezoneTranslationResult,
    bind_story_script_assets,
    build_freezone_character_story_script_task,
    build_freezone_story_script_task,
    build_freezone_translation_task,
    build_freezone_video_story_script_task,
    generate_freezone_text,
    generate_freezone_story_script_with_vision,
    translate_freezone_text,
)


def _patch_project_resolution(
    monkeypatch: pytest.MonkeyPatch,
    project_dir: Path,
    *,
    username: str = "admin",
):
    async def _fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return None, username, project, project_dir, str(project_dir)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)


def test_build_freezone_translation_task_mentions_languages_and_node_type() -> None:
    task = build_freezone_translation_task(
        text="手持镜头，雨夜街头，人物缓慢向前走。",
        node_type="video",
    )

    assert "视频节点提示词" in task
    assert "Simplified Chinese" in task
    assert "English" in task
    assert "You must decide whether the dominant natural language" in task
    assert "手持镜头" in task


@pytest.mark.asyncio
async def test_translate_freezone_text_trusts_model_detected_direction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, str] = {}

    class FakeAgent:
        async def run(self, task: str):
            captured["task"] = task

            class Response:
                output = FreezoneTranslationResult(
                    translated_text="生成一个 NovelVideo 节拍的故事板草图面板。",
                    source_language="en",
                    target_language="zh",
                )

            return Response()

    monkeypatch.setattr("novelvideo.freezone.text_node.get_freezone_translation_agent", FakeAgent)

    translated, source_language, target_language = await translate_freezone_text(
        text="Generate ONE storyboard sketch panel for this NovelVideo beat. 颜色法则：保留 [CM_6932]",
        node_type="image",
    )

    assert "You must decide whether the dominant natural language" in captured["task"]
    assert "[CM_6932]" in captured["task"]
    assert translated == "生成一个 NovelVideo 节拍的故事板草图面板。"
    assert source_language == "en"
    assert target_language == "zh"


@pytest.mark.asyncio
async def test_translate_freezone_text_flips_invalid_same_language_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeAgent:
        async def run(self, _task: str):
            class Response:
                output = FreezoneTranslationResult(
                    translated_text="雨夜街头",
                    source_language="zh",
                    target_language="zh",
                )

            return Response()

    monkeypatch.setattr("novelvideo.freezone.text_node.get_freezone_translation_agent", FakeAgent)

    translated, source_language, target_language = await translate_freezone_text(
        text="雨夜街头",
        node_type="image",
    )

    assert translated == "雨夜街头"
    assert source_language == "zh"
    assert target_language == "en"


def test_translation_defaults_use_newapi_gemini_flash() -> None:
    assert FREEZONE_TRANSLATION_PROVIDER == "newapi"
    assert FREEZONE_TRANSLATION_MODEL == "DC-freezone-translator-LLM"


@pytest.mark.asyncio
async def test_generate_freezone_text_returns_configured_model_and_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeAgent:
        async def run(self, prompt: str):
            assert prompt == "写一段雨夜重逢的短故事"

            class Response:
                output = "雨落在旧车站的铁轨上，她终于等到了那班迟来的列车。"

            return Response()

    monkeypatch.setattr("novelvideo.freezone.text_node.get_freezone_text_writer_agent", FakeAgent)

    model, text = await generate_freezone_text(prompt="  写一段雨夜重逢的短故事  ")

    assert model == FREEZONE_TEXT_WRITER_MODEL == "DC-freezone-text-writer-LLM"
    assert text.startswith("雨落在旧车站")


def test_build_freezone_story_script_task_mentions_required_columns() -> None:
    task = build_freezone_story_script_task(
        source_text="沈昭昭在深夜办公室醒来。",
        prompt="节奏要快，压迫感强",
    )

    assert "镜号" in task
    assert "画面描述" in task
    assert "视频运动提示词" in task
    assert "角色图1" in task
    assert "沈昭昭" in task
    assert "节奏要快" in task
    assert "括号分段" in task
    assert "分镜提示词必须像高质量图像生成提示词" in task
    assert "最好严格按 8 段写" in task
    assert "最好严格按 6 段写" in task
    assert "第二段尽量直接使用或轻改角色描述1" in task
    assert "技术参数段尽量保留" in task


@pytest.mark.asyncio
async def test_freezone_text_translate_route_returns_task_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_text_translate_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes, "_start_freezone_text_translate_task", _fake_start_text_translate_task
    )

    result = await freezone_routes.freezone_text_translate(
        project="58",
        body=freezone_routes.FreezoneTextTranslateRequest(
            text="电影感特写，雨夜街头",
            node_type="image",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_text_translate"
    assert captured["text"] == "电影感特写，雨夜街头"
    assert captured["node_type"] == "image"


@pytest.mark.asyncio
async def test_freezone_text_generate_route_returns_task_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_text_generate_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes, "_start_freezone_text_generate_task", _fake_start_text_generate_task
    )

    result = await freezone_routes.freezone_text_generate(
        project="58",
        body=freezone_routes.FreezoneTextGenerateRequest(
            prompt="写一段雨夜重逢的短故事",
            canvas_id="canvas_a",
            node_id="node_text",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_text_generate"
    assert captured["prompt"] == "写一段雨夜重逢的短故事"
    assert captured["canvas_id"] == "canvas_a"
    assert captured["node_id"] == "node_text"


@pytest.mark.asyncio
async def test_freezone_image_reverse_prompt_route_returns_task_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    source = project_dir / "freezone" / "_uploads" / "sample.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"fake")

    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_image_reverse_prompt_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes,
        "_start_freezone_image_reverse_prompt_task",
        _fake_start_image_reverse_prompt_task,
    )

    result = await freezone_routes.freezone_image_reverse_prompt(
        project="58",
        body=freezone_routes.FreezoneImageReversePromptRequest(
            source_url="/static/admin/58/freezone/_uploads/sample.png"
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_image_reverse_prompt"
    assert captured["source_path"] == source


@pytest.mark.asyncio
async def test_freezone_story_script_route_uses_source_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_story_script_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes, "_start_freezone_story_script_task", _fake_start_story_script_task
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            source_text="沈昭昭在深夜办公室醒来。"
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_story_script"
    assert captured["source_text"] == "沈昭昭在深夜办公室醒来。"
    assert captured["prompt"] == "根据我上传的剧本生成一个完整的故事脚本"
    assert captured["model"] == "newapi_gemini_flash"


@pytest.mark.asyncio
async def test_freezone_story_script_route_reads_source_url_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    source = project_dir / "freezone" / "_uploads" / "script.txt"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("沈昭昭在深夜办公室醒来。", encoding="utf-8")

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda *_args, **_kwargs: source,
    )
    captured: dict[str, object] = {}

    def _fake_start_story_script_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes, "_start_freezone_story_script_task", _fake_start_story_script_task
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            source_url="/static/admin/58/freezone/_uploads/script.txt"
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["task_type"] == "freezone_story_script"
    assert captured["source_text"] == "沈昭昭在深夜办公室醒来。"


def test_story_script_request_keeps_video_and_character_fields() -> None:
    """issue #207 回归：前端发的视频 / 角色参考字段不能再被 Pydantic 静默丢掉。

    这些字段以前没在模型里声明，``extra="ignore"`` 会把它们连同 duration_sec 一起
    吃掉，于是「视频参考生成分镜脚本」从头到尾都没把视频交给模型。
    """
    body = freezone_routes.FreezoneStoryScriptGenerateRequest.model_validate(
        {
            "video_url": "/static/admin/58/freezone/_uploads/clip.mp4",
            "duration_sec": 15.0,
            "character_refs": [
                {
                    "name": "沈昭昭",
                    "image_url": "/static/admin/58/freezone/_uploads/shen.png",
                    "role": "女主",
                }
            ],
            "prompt": "生成视频脚本",
        }
    )

    assert body.video_url == "/static/admin/58/freezone/_uploads/clip.mp4"
    assert body.duration_sec == 15.0
    assert body.character_refs[0].name == "沈昭昭"
    assert body.character_refs[0].image_url.endswith("shen.png")


@pytest.mark.asyncio
async def test_freezone_story_script_route_enqueues_video_reference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    video = project_dir / "freezone" / "_uploads" / "clip.mp4"
    video.parent.mkdir(parents=True, exist_ok=True)
    video.write_bytes(b"fake-mp4")

    async def _fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return object(), "admin", project, project_dir, str(project_dir)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)
    captured: dict[str, object] = {}

    async def _fake_enqueue(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "data": {"task_type": kwargs["task_type"]}}

    monkeypatch.setattr(
        freezone_routes, "_enqueue_freezone_background_job", _fake_enqueue
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            video_url="/static/admin/58/freezone/_uploads/clip.mp4",
            duration_sec=15.0,
            prompt="生成视频脚本",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    payload = captured["payload"]
    assert payload["video_path"] == video.as_posix()
    assert payload["duration_sec"] == 15.0
    assert payload["max_frames"] == 20
    assert payload["prompt"] == "生成视频脚本"
    # 视频是主输入，不再要求前端把提示词伪装成剧本正文。
    assert payload["source_text"] == ""


@pytest.mark.asyncio
async def test_freezone_story_script_route_forwards_character_refs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    portrait = project_dir / "freezone" / "_uploads" / "shen.png"
    portrait.parent.mkdir(parents=True, exist_ok=True)
    portrait.write_bytes(b"png")

    _patch_project_resolution(monkeypatch, project_dir)
    captured: dict[str, object] = {}

    def _fake_start_story_script_task(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        freezone_routes, "_start_freezone_story_script_task", _fake_start_story_script_task
    )

    result = await freezone_routes.freezone_story_script_generate(
        project="58",
        body=freezone_routes.FreezoneStoryScriptGenerateRequest(
            character_refs=[
                freezone_routes.FreezoneStoryScriptCharacterRef(
                    name="沈昭昭",
                    image_url="/static/admin/58/freezone/_uploads/shen.png",
                    role="女主",
                )
            ],
            prompt="生成一段职场逆袭脚本",
        ),
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert captured["character_refs"][0]["name"] == "沈昭昭"
    assert captured["character_image_paths"] == [portrait.as_posix()]


@pytest.mark.asyncio
async def test_freezone_story_script_route_rejects_empty_input(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import HTTPException

    _patch_project_resolution(monkeypatch, tmp_path / "project")

    with pytest.raises(HTTPException) as excinfo:
        await freezone_routes.freezone_story_script_generate(
            project="58",
            body=freezone_routes.FreezoneStoryScriptGenerateRequest(),
            user={"username": "admin"},
        )

    assert excinfo.value.status_code == 400


def test_build_freezone_video_story_script_task_describes_the_real_video() -> None:
    task = build_freezone_video_story_script_task(
        frame_count=6,
        prompt="生成视频脚本",
        duration_sec=15.0,
    )

    assert "6" in task
    assert "15" in task
    assert "keyframe_index" in task
    assert "生成视频脚本" in task


@pytest.mark.asyncio
async def test_generate_story_script_with_vision_attaches_frames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frames = []
    for index in range(3):
        frame = tmp_path / f"frame_{index}.png"
        frame.write_bytes(b"png-bytes")
        frames.append(frame)
    captured: dict[str, object] = {}

    class FakeAgent:
        async def run(self, messages):
            captured["messages"] = messages

            class Response:
                output = FreezoneStoryScriptGenerateData(title="", rows=[])

            return Response()

    monkeypatch.setattr(
        "novelvideo.freezone.text_node.get_freezone_video_story_script_agent",
        FakeAgent,
    )

    await generate_freezone_story_script_with_vision(
        frame_paths=frames,
        prompt="生成视频脚本",
        duration_sec=15.0,
    )

    messages = captured["messages"]
    assert isinstance(messages[0], str)
    # 三张关键帧必须真的作为附件送进模型，而不是只在提示词里被提一句。
    assert len(messages) == 1 + len(frames)
    assert all(getattr(item, "data", None) == b"png-bytes" for item in messages[1:])


def test_build_freezone_character_story_script_task_uses_prompt_as_story() -> None:
    task = build_freezone_character_story_script_task(
        image_count=2,
        prompt="以这两个角色生成一段雪山对决",
        character_refs=[{"name": "宁姚"}, {"name": "青衣剑客"}],
    )

    assert "2 张角色参考图" in task
    assert "以这两个角色生成一段雪山对决" in task
    # 角色图模式没有关键帧，必须明确要求 keyframe_index 填 0，别乱指帧。
    assert "keyframe_index 一律填 0" in task
    assert "宁姚" in task
    assert "青衣剑客" in task
    assert "关键帧" not in task.replace("没有关键帧可以回填", "")


@pytest.mark.asyncio
async def test_generate_story_script_with_vision_accepts_character_images_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 前端一旦挂了素材就只发提示词、把 source_text 留空；
    # 「仅角色图」这一路以前会在这里抛 ValueError，任务必挂。
    portrait = tmp_path / "ningyao.png"
    portrait.write_bytes(b"png-bytes")
    captured: dict[str, object] = {}

    class FakeAgent:
        async def run(self, messages):
            captured["messages"] = messages

            class Response:
                output = FreezoneStoryScriptGenerateData(title="", rows=[])

            return Response()

    monkeypatch.setattr(
        "novelvideo.freezone.text_node.get_freezone_video_story_script_agent",
        FakeAgent,
    )

    await generate_freezone_story_script_with_vision(
        character_image_paths=[portrait],
        source_text="",
        prompt="以这个角色生成一段雪山对决",
        character_refs=[{"name": "宁姚", "image_url": "/static/ningyao.png"}],
    )

    messages = captured["messages"]
    task = messages[0]
    assert isinstance(task, str)
    assert "角色参考图" in task
    assert "以这个角色生成一段雪山对决" in task
    assert len(messages) == 2
    assert getattr(messages[1], "data", None) == b"png-bytes"


def test_bind_story_script_assets_fills_frames_and_character_images() -> None:
    data = FreezoneStoryScriptGenerateData(
        title="猫猫散步",
        rows=[
            FreezoneStoryScriptRow(
                shot_no=1,
                duration=4,
                visual_description="猫从画面左侧走入",
                character_1="香蕉猫",
                keyframe_index=2,
            ),
            FreezoneStoryScriptRow(
                shot_no=2,
                duration=4,
                visual_description="猫停下回头",
                character_1="香蕉猫_特写",
                character_2="路人",
                keyframe_index=1,
            ),
        ],
    )

    bind_story_script_assets(
        data,
        frame_urls=["/static/f1.png", "/static/f2.png"],
        character_refs=[
            {"name": "香蕉猫", "image_url": "/static/cat.png"},
            {"name": "路人", "image_url": "/static/passerby.png"},
        ],
    )

    assert data.rows[0].reference == "/static/f2.png"
    assert data.rows[1].reference == "/static/f1.png"
    assert data.rows[0].character_image_1 == "/static/cat.png"
    # 模型把角色名写成带后缀的稳定 ID 时仍要匹配上。
    assert data.rows[1].character_image_1 == "/static/cat.png"
    assert data.rows[1].character_image_2 == "/static/passerby.png"


def test_bind_story_script_assets_falls_back_to_row_order_on_bad_index() -> None:
    data = FreezoneStoryScriptGenerateData(
        title="",
        rows=[
            FreezoneStoryScriptRow(
                shot_no=1, duration=3, visual_description="第一镜", keyframe_index=99
            ),
            FreezoneStoryScriptRow(
                shot_no=2, duration=3, visual_description="第二镜", keyframe_index=0
            ),
            FreezoneStoryScriptRow(
                shot_no=3, duration=3, visual_description="第三镜", keyframe_index=0
            ),
        ],
    )

    bind_story_script_assets(data, frame_urls=["/static/f1.png", "/static/f2.png"])

    assert data.rows[0].reference == "/static/f1.png"
    assert data.rows[1].reference == "/static/f2.png"
    # 帧数不够时多出来的镜头留空，而不是循环复用一张图。
    assert data.rows[2].reference == ""


def test_bind_story_script_assets_binds_sole_character_image() -> None:
    data = FreezoneStoryScriptGenerateData(
        title="",
        rows=[
            FreezoneStoryScriptRow(
                shot_no=1, duration=3, visual_description="第一镜", character_1="女主角"
            )
        ],
    )

    bind_story_script_assets(
        data, character_refs=[{"name": "沈昭昭", "image_url": "/static/shen.png"}]
    )

    assert data.rows[0].character_image_1 == "/static/shen.png"


@pytest.mark.asyncio
async def test_freezone_story_script_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "storyjob1"
    out = project_dir / "freezone" / "_outputs" / "freezone_story_script" / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "title": "我在盛唐写天下",
        "rows": [
            {
                "shot_no": 1,
                "duration": 4,
                "visual_description": "现代深夜，沈昭昭在办公室过度劳累加班。",
                "character_1": "",
                "character_description_1": "",
                "character_image_1": "",
                "reference": "",
                "shot": "",
                "character_action": "",
                "emotion": "",
                "scene_tags": "",
                "lighting_mood": "",
                "sound": "",
                "dialogue": "",
                "shot_prompt": "近景特写",
                "video_motion_prompt": "缓慢推进",
            }
        ],
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_story_script",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["title"] == "我在盛唐写天下"
    assert result["data"]["rows"][0]["shot_no"] == 1


@pytest.mark.asyncio
async def test_freezone_text_translate_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "translatejob1"
    out = project_dir / "freezone" / "_outputs" / "freezone_text_translate" / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "translated_text": "Today is Monday",
        "source_language": "zh",
        "target_language": "en",
        "node_type": "generic",
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_text_translate",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["translated_text"] == "Today is Monday"
    assert result["data"]["target_language"] == "en"


@pytest.mark.asyncio
async def test_freezone_text_generate_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "textgenerate1"
    out = project_dir / "freezone" / "_outputs" / "freezone_text_generate" / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_text": "雨夜旧车站里，一封迟到的信改变了所有人的选择。",
        "model": "DC-freezone-text-writer-LLM",
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_text_generate",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"] == payload


@pytest.mark.asyncio
async def test_freezone_image_reverse_prompt_job_result_returns_json_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    job_id = "reverseprompt1"
    out = project_dir / "freezone" / "_outputs" / "freezone_image_reverse_prompt" / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "prompt": "雨夜街头，电影感近景特写，人物侧脸被霓虹照亮",
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    class FakeManager:
        def get_task(self, *args, **kwargs):
            return None

    _patch_project_resolution(monkeypatch, project_dir)
    monkeypatch.setattr(freezone_routes, "get_task_manager", lambda: FakeManager())

    result = await freezone_routes.freezone_job_result(
        project="58",
        task_type="freezone_image_reverse_prompt",
        job_id=job_id,
        user={"username": "admin"},
    )

    assert result["ok"] is True
    assert result["data"]["prompt"].startswith("雨夜街头")
