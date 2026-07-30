import pytest


@pytest.mark.parametrize(
    ("extractor_name", "error_pattern"),
    [
        ("extract_characters_from_graph", "Cognee 图谱角色搜索失败"),
        ("extract_scenes_from_graph", "Cognee 图谱场景搜索失败"),
        ("extract_props_from_graph", "Cognee 图谱道具搜索失败"),
    ],
)
@pytest.mark.asyncio
async def test_graph_asset_extraction_raises_when_search_fails(
    monkeypatch,
    extractor_name,
    error_pattern,
):
    from novelvideo.cognee import pipeline

    async def fake_search(**_kwargs):
        raise ConnectionError("gateway unavailable")

    monkeypatch.setattr("cognee.search", fake_search)

    with pytest.raises(RuntimeError, match=error_pattern):
        await getattr(pipeline, extractor_name)()


@pytest.mark.parametrize(
    ("extractor_name", "error_pattern"),
    [
        ("extract_characters_from_graph", "LLM 图谱角色提取失败"),
        ("extract_scenes_from_graph", "LLM 图谱场景提取失败"),
        ("extract_props_from_graph", "LLM 图谱道具提取失败"),
    ],
)
@pytest.mark.asyncio
async def test_graph_asset_extraction_raises_when_structured_llm_fails(
    monkeypatch,
    extractor_name,
    error_pattern,
):
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    from novelvideo.cognee import pipeline

    async def fake_search(**_kwargs):
        return [{"search_result": "图谱中存在有效上下文。"}]

    async def fake_structured_output(*_args, **_kwargs):
        raise TimeoutError("model timed out")

    monkeypatch.setattr("cognee.search", fake_search)
    monkeypatch.setattr(LLMGateway, "acreate_structured_output", fake_structured_output)

    with pytest.raises(RuntimeError, match=error_pattern):
        await getattr(pipeline, extractor_name)()


@pytest.mark.parametrize(
    "extractor_name",
    [
        "extract_characters_from_graph",
        "extract_scenes_from_graph",
        "extract_props_from_graph",
    ],
)
@pytest.mark.asyncio
async def test_graph_asset_extraction_keeps_successful_empty_search_as_empty_result(
    monkeypatch,
    extractor_name,
):
    from novelvideo.cognee import pipeline

    async def fake_search(**_kwargs):
        return []

    monkeypatch.setattr("cognee.search", fake_search)

    assert await getattr(pipeline, extractor_name)() == []


@pytest.mark.asyncio
async def test_character_extraction_keeps_single_narrator_main(monkeypatch):
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelCharacter

    class _Result:
        characters = [
            pipeline.CharacterEnrichment(name="桑落", role="主角", is_main=True, gender="女"),
            pipeline.CharacterEnrichment(name="楚寒", role="师尊", is_main=True, gender="男"),
            pipeline.CharacterEnrichment(name="林清清", role="师妹", is_main=False, gender="女"),
        ]

    async def fake_search(**kwargs):
        return [{"search_result": "桑落第一人称叙述，楚寒和林清清是关键角色。"}]

    async def fake_structured_output(*args, **kwargs):
        return _Result()

    monkeypatch.setattr("cognee.search", fake_search)
    monkeypatch.setattr(LLMGateway, "acreate_structured_output", fake_structured_output)

    characters = await pipeline.extract_characters_from_graph()

    assert [c.name for c in characters if c.is_main] == ["桑落"]
    assert all(isinstance(c, NovelCharacter) for c in characters)


@pytest.mark.asyncio
async def test_scene_extraction_uses_graph_context_without_raw_novel(monkeypatch):
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    from novelvideo.cognee import pipeline
    from novelvideo.models import NovelScene

    search_calls = []
    structured_inputs = []

    async def fake_search(**kwargs):
        search_calls.append(kwargs)
        return [{"search_result": "菩提寝房是菩提祖师居住和授课的重要室内地点。"}]

    async def fake_structured_output(context_text, _prompt, _output_type, **_kwargs):
        structured_inputs.append(context_text)
        return pipeline.GraphSceneCandidateList(
            scenes=[
                pipeline.GraphSceneCandidate(
                    name="菩提寝房",
                    aliases=["祖师寝房"],
                    scene_type="interior",
                    evidence_lines=["菩提寝房是菩提祖师居住和授课的重要室内地点。"],
                )
            ]
        )

    async def fake_enrich(**kwargs):
        assert kwargs["scene_name"] == "菩提寝房"
        assert kwargs["context_lines"] == ["菩提寝房是菩提祖师居住和授课的重要室内地点。"]
        return NovelScene(
            name="菩提寝房",
            aliases=kwargs["aliases"],
            scene_type="interior",
            environment_prompt="正面：床榻\n左侧：书架\n右侧：窗户\n背面：房门",
        )

    monkeypatch.setattr("cognee.search", fake_search)
    monkeypatch.setattr(LLMGateway, "acreate_structured_output", fake_structured_output)
    monkeypatch.setattr(pipeline, "enrich_scene_environment_from_context", fake_enrich)
    monkeypatch.setattr(pipeline, "_create_scene_build_agent", lambda *_args: object())

    scenes = await pipeline.extract_scenes_from_graph(
        dataset_name="novel-demo",
        project_name="admin/demo",
    )

    assert search_calls[0]["datasets"] == ["novel-demo"]
    assert search_calls[0]["only_context"] is True
    assert structured_inputs == ["菩提寝房是菩提祖师居住和授课的重要室内地点。"]
    assert [scene.name for scene in scenes] == ["菩提寝房"]
    assert scenes[0].aliases == ["祖师寝房"]
    assert "Cognee 图谱" in scenes[0].notes


def test_first_person_narrator_copy_uses_narrator_main_terms(tmp_path):
    from novelvideo.models import CharacterIdentity, NovelCharacter
    from novelvideo.seedance2_i2v.voice_clone import NARRATION_STYLES, resolve_narrator_source

    project_dir = tmp_path / "proj"
    voice_path = project_dir / "assets" / "characters" / "桑落" / "voices" / "voice_default.mp3"
    voice_path.parent.mkdir(parents=True)
    voice_path.write_bytes(b"voice")

    character = NovelCharacter(
        name="桑落",
        gender="女",
        is_main=True,
        reference_audio_path="assets/characters/桑落/voices/voice_default.mp3",
    )
    character.identities = [
        CharacterIdentity(
            identity_id="桑落_重生后",
            character_name="桑落",
            identity_name="重生后",
        )
    ]

    class _Store:
        def get_all_characters(self):
            return [character]

    store = _Store()
    store.project_dir = str(project_dir)
    resolution = resolve_narrator_source(
        store=store,
        narration_style="first_person",
        project_narrator_stored_path="",
    )

    assert resolution.source == "protagonist_identity"
    assert NARRATION_STYLES["first_person"]["label"] == "第一人称（解说主角视角）"
    assert "解说主角" in NARRATION_STYLES["first_person"]["prompt"]
