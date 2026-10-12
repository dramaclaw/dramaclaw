import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from novelvideo.prompt_preview.registry import PreviewScope, all_steps, get_step


class _FakeStore:
    def __init__(self, characters=None, beats=None):
        self._characters = characters or []
        self._beats = beats or []

    async def list_characters(self):
        return self._characters

    async def get_beats_as_dicts(self, episode):
        return self._beats


def _scope(tmp_path: Path, store, episode=None) -> PreviewScope:
    return PreviewScope(
        project_dir=tmp_path,
        state_dir=str(tmp_path / "state"),
        store=store,
        config={"ethnicity": "Vietnamese"},
        episode=episode,
    )


def _run(coro):
    return asyncio.run(coro)


def test_steps_follow_pipeline_order_and_flag_unsupported():
    steps = {s.step: s for s in all_steps()}
    order = [s.step for s in all_steps()]
    assert order.index("portraits") < order.index("script") < order.index("video")
    assert steps["portraits"].supported and steps["video"].supported
    assert not steps["script"].supported


def test_portrait_preview_contains_full_prompt_frame_and_last_sent(tmp_path):
    char = SimpleNamespace(name="Tesla", face_prompt="sharp cheekbones", identities=[])
    audit = tmp_path / "prompts" / "characters" / "Tesla_portrait.prompt.txt"
    audit.parent.mkdir(parents=True)
    audit.write_text("OLD PROMPT", encoding="utf-8")

    spec = get_step("portraits")
    scope = _scope(tmp_path, _FakeStore([char]))
    targets = _run(spec.targets_fn(scope))
    assert [t.id for t in targets] == ["Tesla"]

    preview = _run(spec.build_fn(scope, "Tesla"))
    text = preview.parts[0].text
    for marker in ("STRICT REQUIREMENTS", "MUST AVOID", "VISUAL STYLE", "sharp cheekbones"):
        assert marker in text
    assert "Vietnamese" in text
    assert preview.last_sent.text == "OLD PROMPT"


def test_portrait_preview_without_face_prompt_returns_note(tmp_path):
    char = SimpleNamespace(name="Tesla", face_prompt="", identities=[])
    preview = _run(get_step("portraits").build_fn(_scope(tmp_path, _FakeStore([char])), "Tesla"))
    assert preview.parts == [] and "face_prompt" in preview.note


def test_video_preview_shows_stored_prompts(tmp_path):
    beats = [
        {
            "beat_number": 3,
            "video_prompt": "slow dolly in",
            "seedance2_config_json": json.dumps({"final_prompt": "FINAL"}),
        }
    ]
    scope = _scope(tmp_path, _FakeStore(beats=beats), episode=1)
    spec = get_step("video")
    assert [t.id for t in _run(spec.targets_fn(scope))] == ["3"]
    labels = [p.label for p in _run(spec.build_fn(scope, "3")).parts]
    assert labels == ["seedance2.final_prompt", "video_prompt"]


def test_grid_preview_rejects_path_traversal(tmp_path):
    grids = tmp_path / "grids" / "ep001" / "sketch" / "prompts"
    grids.mkdir(parents=True)
    (grids / "g1.prompt.txt").write_text("GRID", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("nope", encoding="utf-8")
    spec = get_step("sketches")
    scope = _scope(tmp_path, _FakeStore(), episode=1)

    ids = [t.id for t in _run(spec.targets_fn(scope))]
    assert ids == ["sketch/prompts/g1.prompt.txt"]
    assert _run(spec.build_fn(scope, ids[0])).last_sent.text == "GRID"
    bad = _run(spec.build_fn(scope, "../../../secret.txt"))
    assert bad.last_sent is None and "not found" in bad.note
