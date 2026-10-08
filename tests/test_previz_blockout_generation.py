from __future__ import annotations

import io
import json
import textwrap
from pathlib import Path

import pytest
from PIL import Image

from novelvideo.director_world import blockout
from novelvideo.director_world.blockout.artifacts import (
    BlockoutGenerationError,
    write_blockout_artifacts,
    write_blockout_failure_artifacts,
)
from novelvideo.director_world.blockout.generation_agent import (
    BLOCKOUT_MAX_ATTEMPTS,
    BLOCKOUT_REVIEW_ROUNDS,
    extract_program,
    generate_blockout_from_image,
    resolve_blockout_model,
    resolve_blockout_model_settings,
    resolve_blockout_timeout_seconds,
)
from novelvideo.freezone import presets, vision_gateway

FIXTURES = Path(__file__).parent / "fixtures" / "previz_blockout"
GOLDEN_PROGRAM = (FIXTURES / "golden.blockout.dsl").read_text(encoding="utf-8")
GOLDEN = json.loads((FIXTURES / "golden.json").read_text(encoding="utf-8"))

BROKEN = "scene.box(id='a', position=(0, 0, 0), size=(1, 1, 1))\n"
# The golden scene as a review would hand it back: one number moved, still clean.
REVIEWED_PROGRAM = GOLDEN_PROGRAM.replace("radius=0.2,", "radius=0.25,")
REVIEWED_AGAIN = GOLDEN_PROGRAM.replace("radius=0.2,", "radius=0.3,")
assert GOLDEN_PROGRAM != REVIEWED_PROGRAM != REVIEWED_AGAIN
LOOKS_AWAY = (
    "scene.floor(id='f', center=(0, 0), size=(8, 8))\n"
    "scene.box(id='a', position=(0, 0, 0), size=(1, 1, 1), semantic_type='prop')\n"
    "scene.camera(id='cam', position=(0, 1.6, 3), target=(0, 1, -1))\n"
)
# LOOKS_AWAY plus a box hanging in the air: one error, one warning.
LOOKS_AWAY_FLOATING = (
    LOOKS_AWAY
    + "scene.box(id='b', position=(2, 1, 0), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
)
# LOOKS_AWAY plus a box under the floor: two errors.
LOOKS_AWAY_SUNKEN = (
    LOOKS_AWAY
    + "scene.box(id='b', position=(2, -1, 0), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
)


class FakeModel:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls: list[dict] = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return kwargs.get("model_override") or "fake-model", reply


@pytest.fixture(autouse=True)
def default_model_names(monkeypatch):
    monkeypatch.delenv("PREVIZ_BLOCKOUT_MODEL", raising=False)
    monkeypatch.delenv("FREEZONE_VISION_MODEL", raising=False)
    monkeypatch.delenv("PREVIZ_BLOCKOUT_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("PREVIZ_BLOCKOUT_TIMEOUT_SECONDS", raising=False)


@pytest.fixture
def image_path(tmp_path: Path) -> Path:
    path = tmp_path / "reference.png"
    Image.new("RGB", (3200, 1800), (120, 130, 140)).save(path)
    return path


@pytest.fixture
def model(monkeypatch):
    def install(*replies):
        fake = FakeModel(replies)
        monkeypatch.setattr(vision_gateway, "call_freezone_vision_model", fake)
        return fake

    return install


async def test_a_valid_program_becomes_previz_objects_on_the_first_try(
    image_path, model
):
    fake = model(GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(
        image_path=image_path, description="门宽 1 米"
    )

    assert generation.compiled == GOLDEN["compiled"]
    assert generation.warnings == ()
    assert [attempt.errors for attempt in generation.attempts] == [()]
    assert len(fake.calls) == 1
    assert "门宽 1 米" in fake.calls[0]["prompt"]
    assert "图片 1280 × 720 像素" in fake.calls[0]["prompt"]


async def test_the_image_is_compacted_before_it_is_sent(image_path, model):
    fake = model(GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(image_path=image_path)

    (sent,) = fake.calls[0]["images"]
    assert sent.media_type == "image/jpeg"
    with Image.open(io.BytesIO(sent.data)) as image:
        assert image.size == (1280, 720)
    assert generation.image_size == (1280, 720)
    assert len(generation.image_sha256) == 64


async def test_the_timeout_is_five_minutes(image_path, model):
    fake = model(GOLDEN_PROGRAM)

    await generate_blockout_from_image(image_path=image_path)

    assert fake.calls[0]["timeout_seconds"] == 300.0


@pytest.mark.parametrize(
    "reply",
    [
        "```python\n" + GOLDEN_PROGRAM + "```",
        "```\n" + GOLDEN_PROGRAM + "```\n",
        "好的，程序如下：\n\n```python\n" + GOLDEN_PROGRAM + "```\n\n希望有帮助。",
        "\n\n" + GOLDEN_PROGRAM + "\n\n",
        # 回复被截断、或者模型只写了开头的围栏。
        "```python\n" + GOLDEN_PROGRAM,
        # 整段缩进：模型把程序当成列表项或引用块里的内容来写。
        textwrap.indent(GOLDEN_PROGRAM, "    "),
        textwrap.indent("```python\n" + GOLDEN_PROGRAM + "```", "  "),
        GOLDEN_PROGRAM.replace("\n", "\r\n"),
        "\ufeff" + GOLDEN_PROGRAM,
    ],
    ids=[
        "python-fence",
        "bare-fence",
        "prose-around-fence",
        "blank-lines",
        "unclosed-fence",
        "indented",
        "indented-fence",
        "crlf",
        "bom",
    ],
)
def test_extract_program_returns_only_the_program(reply):
    assert extract_program(reply) == GOLDEN_PROGRAM.strip()


def test_extract_program_caps_a_runaway_reply():
    assert len(extract_program("x" * 100_000)) == 40_000


async def test_a_phone_photo_is_measured_the_way_it_is_seen(tmp_path, model):
    """手机竖拍的照片靠 EXIF 标记方向，像素本身是横着存的。"""
    fake = model(GOLDEN_PROGRAM)
    path = tmp_path / "phone.jpg"
    image = Image.new("RGB", (1600, 900), (120, 130, 140))
    exif = image.getexif()
    exif[0x0112] = 6
    image.save(path, exif=exif)

    generation = await generate_blockout_from_image(image_path=path)

    assert generation.image_size == (720, 1280)
    assert "图片 720 × 1280 像素" in fake.calls[0]["prompt"]


async def test_a_file_that_is_not_a_picture_fails_before_the_model_is_called(
    tmp_path, model
):
    """改了后缀的 HEIC、传坏了的文件：扩展名对，内容读不出来。"""
    fake = model(GOLDEN_PROGRAM)
    path = tmp_path / "renamed.jpg"
    path.write_bytes(b"\x00\x00\x00\x18ftypheic" + b"\x00" * 200)

    with pytest.raises(BlockoutGenerationError) as caught:
        await generate_blockout_from_image(image_path=path)

    assert str(caught.value) == "参考图读不出来：文件不是有效的图片"
    assert caught.value.attempts == ()
    assert len(caught.value.image_sha256) == 64
    assert caught.value.image_size == (0, 0)
    assert fake.calls == []


async def test_a_picture_that_is_gone_fails_without_naming_the_server_path(
    tmp_path, model
):
    fake = model(GOLDEN_PROGRAM)

    with pytest.raises(BlockoutGenerationError) as caught:
        await generate_blockout_from_image(image_path=tmp_path / "gone.png")

    assert str(caught.value) == "参考图读不出来：文件不存在或无法读取"
    assert caught.value.image_sha256 == ""
    assert fake.calls == []


async def test_an_unreadable_picture_leaves_a_record_but_no_program(tmp_path, model):
    model(GOLDEN_PROGRAM)
    path = tmp_path / "renamed.jpg"
    path.write_bytes(b"not a picture")
    out_dir = tmp_path / "job"

    with pytest.raises(BlockoutGenerationError) as caught:
        await generate_blockout_from_image(image_path=path)
    write_blockout_failure_artifacts(out_dir, caught.value)

    assert [item.name for item in out_dir.iterdir()] == ["generation.json"]
    record = json.loads((out_dir / "generation.json").read_text(encoding="utf-8"))
    assert record["error"] == "参考图读不出来：文件不是有效的图片"
    assert record["attempts"] == []
    assert record["retries"] == 0


async def test_an_invalid_program_is_sent_back_with_its_error(image_path, model):
    fake = model(BROKEN, GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert generation.compiled == GOLDEN["compiled"]
    assert len(fake.calls) == 2
    assert [len(attempt.errors) for attempt in generation.attempts] == [1, 0]
    error = generation.attempts[0].errors[0]
    assert error.startswith("line 1: ")
    retry_prompt = fake.calls[1]["prompt"]
    assert f"- {error}" in retry_prompt
    assert BROKEN.strip() in retry_prompt
    assert fake.calls[1]["images"] == fake.calls[0]["images"]


async def test_three_invalid_programs_fail_the_job(image_path, model):
    fake = model(BROKEN, "import os\n", "scene.fly(id='a')\n")

    with pytest.raises(BlockoutGenerationError) as caught:
        await generate_blockout_from_image(image_path=image_path)

    assert len(fake.calls) == BLOCKOUT_MAX_ATTEMPTS == 3
    assert [attempt.program for attempt in caught.value.attempts] == [
        BROKEN.strip(),
        "import os",
        "scene.fly(id='a')",
    ]
    assert "unknown instruction" in str(caught.value) or "fly" in str(caught.value)


async def test_the_second_retry_reports_only_the_latest_program(image_path, model):
    fake = model(BROKEN, "import os\n", GOLDEN_PROGRAM)

    await generate_blockout_from_image(image_path=image_path)

    third_prompt = fake.calls[2]["prompt"]
    assert "import os" in third_prompt
    assert BROKEN.strip() not in third_prompt


async def test_a_scene_over_the_object_cap_is_not_retried(image_path, model):
    positions = ", ".join("(0, 0, 0)" for _ in range(151))
    ids = ", ".join(f"'b{index}'" for index in range(151))
    fake = model(
        f"scene.repeat(primitive='box', ids=[{ids}], positions=[{positions}], "
        "size=(1, 1, 1), semantic_type='prop')\n"
        "scene.camera(id='cam', position=(0, 1.6, -5), target=(0, 1, 1))\n"
    )

    with pytest.raises(BlockoutGenerationError, match="场景过于复杂") as caught:
        await generate_blockout_from_image(image_path=image_path)

    assert len(fake.calls) == 1
    assert len(caught.value.attempts) == 1


async def test_a_model_failure_is_not_retried(image_path, model):
    fake = model(TimeoutError("gateway timed out"), GOLDEN_PROGRAM)

    with pytest.raises(TimeoutError, match="gateway timed out"):
        await generate_blockout_from_image(image_path=image_path)

    assert len(fake.calls) == 1


async def test_an_implausible_scene_is_retried(image_path, model):
    fake = model(LOOKS_AWAY, GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert generation.compiled == GOLDEN["compiled"]
    assert "looks toward -z" in fake.calls[1]["prompt"]


async def test_a_scene_that_stays_implausible_is_delivered_with_warnings(
    image_path, model
):
    fake = model(LOOKS_AWAY, LOOKS_AWAY, LOOKS_AWAY)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert len(fake.calls) == 3
    assert generation.compiled["counts"] == {"prop": 2, "camera": 1}
    assert len(generation.warnings) == 1
    assert "looks toward -z" in generation.warnings[0]
    assert len(generation.attempts) == 3


async def test_a_parseable_attempt_wins_over_a_later_broken_one(image_path, model):
    model(LOOKS_AWAY, BROKEN, BROKEN)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert generation.program == LOOKS_AWAY.strip()


async def test_the_fallback_is_the_attempt_with_the_fewest_errors(image_path, model):
    # Errors against errors: the first attempt's warning must not make it look
    # worse than a second attempt that has more errors and no warnings.
    model(LOOKS_AWAY_FLOATING, LOOKS_AWAY_SUNKEN, BROKEN)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert [len(attempt.errors) for attempt in generation.attempts] == [1, 2, 1]
    assert generation.program == LOOKS_AWAY_FLOATING.strip()


async def test_a_transport_failure_after_a_usable_attempt_delivers_that_attempt(
    image_path, model
):
    # The first call bought a scene that only failed the plausibility check; a
    # gateway failure on the retry must not throw that away.
    fake = model(LOOKS_AWAY, TimeoutError("gateway timed out"))

    generation = await generate_blockout_from_image(image_path=image_path)

    assert len(fake.calls) == 2
    assert generation.program == LOOKS_AWAY.strip()
    assert "looks toward -z" in generation.warnings[0]
    assert len(generation.attempts) == 1


async def test_a_hostile_program_is_never_run(image_path, model, tmp_path, monkeypatch):
    marker = tmp_path / "pwned"
    monkeypatch.chdir(tmp_path)
    hostile = (
        f"import os\nos.system('touch {marker}')\n",
        f"scene.box(id=__import__('os').system('touch {marker}'))\n",
        f"open('{marker}', 'w').write('x')\n",
    )
    model(*hostile)

    with pytest.raises(BlockoutGenerationError):
        await generate_blockout_from_image(image_path=image_path)

    assert not marker.exists()
    assert list(tmp_path.iterdir()) == [image_path]


def test_reasoning_effort_comes_from_the_environment_as_the_openai_wire_setting(
    monkeypatch,
):
    assert resolve_blockout_model_settings() is None

    monkeypatch.setenv("PREVIZ_BLOCKOUT_REASONING_EFFORT", "  ")
    assert resolve_blockout_model_settings() is None

    monkeypatch.setenv("PREVIZ_BLOCKOUT_REASONING_EFFORT", " Low ")
    assert resolve_blockout_model_settings() == {"openai_reasoning_effort": "low"}


async def test_every_model_call_carries_the_reasoning_effort(
    image_path, model, monkeypatch
):
    fake = model(GOLDEN_PROGRAM, REVIEWED_PROGRAM, REVIEWED_AGAIN)
    await generate_blockout_from_image(image_path=image_path, render_check=True)
    assert [call["model_settings"] for call in fake.calls] == [None] * 3

    monkeypatch.setenv("PREVIZ_BLOCKOUT_REASONING_EFFORT", "low")
    fake = model(GOLDEN_PROGRAM, REVIEWED_PROGRAM, REVIEWED_AGAIN)
    await generate_blockout_from_image(image_path=image_path, render_check=True)
    assert [call["model_settings"] for call in fake.calls] == [
        {"openai_reasoning_effort": "low"}
    ] * 3


def test_the_request_timeout_comes_from_the_environment(monkeypatch):
    assert resolve_blockout_timeout_seconds() == 300.0

    monkeypatch.setenv("PREVIZ_BLOCKOUT_TIMEOUT_SECONDS", " ")
    assert resolve_blockout_timeout_seconds() == 300.0

    monkeypatch.setenv("PREVIZ_BLOCKOUT_TIMEOUT_SECONDS", " 900 ")
    assert resolve_blockout_timeout_seconds() == 900.0

    for bad in ("abc", "0", "-5"):
        monkeypatch.setenv("PREVIZ_BLOCKOUT_TIMEOUT_SECONDS", bad)
        with pytest.raises(ValueError, match="PREVIZ_BLOCKOUT_TIMEOUT_SECONDS"):
            resolve_blockout_timeout_seconds()


async def test_every_model_call_uses_the_configured_timeout(
    image_path, model, monkeypatch
):
    monkeypatch.setenv("PREVIZ_BLOCKOUT_TIMEOUT_SECONDS", "900")
    fake = model(GOLDEN_PROGRAM, REVIEWED_PROGRAM, REVIEWED_AGAIN)
    await generate_blockout_from_image(image_path=image_path, render_check=True)
    assert [call["timeout_seconds"] for call in fake.calls] == [900.0] * 3


def test_the_model_has_its_own_settings_row(monkeypatch):
    """白模在设置页「业务模型映射」里是独立一行，不再借用看图那行。"""
    monkeypatch.delenv("PREVIZ_BLOCKOUT_MODEL", raising=False)
    monkeypatch.setenv("FREEZONE_VISION_MODEL", "self-hosted-vision-model")
    assert resolve_blockout_model() == "DC-previz-blockout-LLM"

    monkeypatch.setenv("PREVIZ_BLOCKOUT_MODEL", "  ")
    assert resolve_blockout_model() == "DC-previz-blockout-LLM"

    monkeypatch.setenv("PREVIZ_BLOCKOUT_MODEL", "candidate-b")
    assert resolve_blockout_model() == "candidate-b"


def test_a_requested_model_wins_over_the_configured_one(monkeypatch):
    monkeypatch.setenv("PREVIZ_BLOCKOUT_MODEL", "candidate-b")
    assert resolve_blockout_model("candidate-c") == "candidate-c"
    assert resolve_blockout_model("  ") == "candidate-b"
    assert resolve_blockout_model(None) == "candidate-b"


async def test_the_requested_model_is_the_one_called(image_path, model, monkeypatch):
    monkeypatch.setenv("PREVIZ_BLOCKOUT_MODEL", "candidate-b")
    fake = model(GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(image_path=image_path, model="candidate-c")

    assert fake.calls[0]["model_override"] == "candidate-c"
    assert generation.model == "candidate-c"


async def test_the_configured_model_is_the_one_called(image_path, model, monkeypatch):
    monkeypatch.setenv("PREVIZ_BLOCKOUT_MODEL", "candidate-b")
    fake = model(GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert fake.calls[0]["model_override"] == "candidate-b"
    assert generation.model == "candidate-b"


class FakeEgress:
    def __init__(self, monkeypatch):
        self.events: list[tuple] = []
        self.state = presets.FreezoneVisionEgress(
            image_egress=object(), transport_context="transport"
        )
        monkeypatch.setattr(presets, "prepare_freezone_vision_egress", self.prepare)
        monkeypatch.setattr(presets, "complete_freezone_vision_egress", self.complete)
        monkeypatch.setattr(presets, "abandon_freezone_vision_egress", self.abandon)

    async def prepare(self, **kwargs):
        self.events.append(("prepare", kwargs["model_name"], kwargs["egress_context"]))
        return self.state

    async def complete(self, state, *, result):
        assert state is self.state
        self.events.append(("complete", result))

    async def abandon(self, state, *, submitted):
        assert state is self.state
        self.events.append(("abandon", submitted))


async def test_every_attempt_claims_and_settles_its_own_egress(
    image_path, model, monkeypatch
):
    egress = FakeEgress(monkeypatch)
    fake = model(BROKEN, GOLDEN_PROGRAM)

    await generate_blockout_from_image(image_path=image_path, egress_context="org")

    assert egress.events == [
        ("prepare", "DC-previz-blockout-LLM", "org"),
        ("complete", BROKEN),
        ("prepare", "DC-previz-blockout-LLM", "org"),
        ("complete", GOLDEN_PROGRAM),
    ]
    assert [call["transport_context"] for call in fake.calls] == ["transport"] * 2


async def test_a_failed_call_abandons_its_egress_as_submitted(
    image_path, model, monkeypatch
):
    egress = FakeEgress(monkeypatch)
    model(RuntimeError("视觉模型返回空内容"))

    with pytest.raises(RuntimeError, match="视觉模型返回空内容"):
        await generate_blockout_from_image(image_path=image_path, egress_context="org")

    assert [event[0] for event in egress.events] == ["prepare", "abandon"]
    assert egress.events[-1] == ("abandon", True)


async def test_artifacts_of_a_finished_job(image_path, model, tmp_path):
    model(BROKEN, GOLDEN_PROGRAM)
    generation = await generate_blockout_from_image(image_path=image_path)
    out_dir = tmp_path / "job"

    result = write_blockout_artifacts(out_dir, generation)

    assert sorted(path.name for path in out_dir.iterdir()) == [
        "generation.json",
        "result.json",
        "scene.blockout.dsl",
        "scene_ir.json",
    ]
    assert result == json.loads((out_dir / "result.json").read_text(encoding="utf-8"))
    assert result["objects"] == GOLDEN["compiled"]["objects"]
    assert result["reference_camera_id"] == "blockout-cam"
    assert result["counts"] == {"prop": 15, "camera": 1}
    assert result["warnings"] == []
    assert (out_dir / "scene.blockout.dsl").read_text(
        encoding="utf-8"
    ) == GOLDEN_PROGRAM
    scene_ir = json.loads((out_dir / "scene_ir.json").read_text(encoding="utf-8"))
    assert scene_ir["compiler_version"] == 1
    record = json.loads((out_dir / "generation.json").read_text(encoding="utf-8"))
    assert record["model"] == "DC-previz-blockout-LLM"
    assert record["retries"] == 1
    assert record["error"] is None
    assert record["image"] == {
        "sha256": generation.image_sha256,
        "sent_width": 1280,
        "sent_height": 720,
    }
    assert [len(attempt["errors"]) for attempt in record["attempts"]] == [1, 0]


async def test_artifacts_of_a_failed_job_keep_the_program_and_the_errors(
    image_path, model, tmp_path
):
    model(BROKEN, BROKEN, "import os\n")
    out_dir = tmp_path / "job"

    with pytest.raises(BlockoutGenerationError) as caught:
        await generate_blockout_from_image(image_path=image_path)
    write_blockout_failure_artifacts(out_dir, caught.value)

    assert sorted(path.name for path in out_dir.iterdir()) == [
        "generation.json",
        "scene.blockout.dsl",
    ]
    assert (out_dir / "scene.blockout.dsl").read_text(encoding="utf-8") == "import os\n"
    record = json.loads((out_dir / "generation.json").read_text(encoding="utf-8"))
    assert record["retries"] == 2
    assert record["error"] == str(caught.value)
    assert len(record["attempts"]) == 3


def test_no_module_of_the_package_can_run_a_program():
    import ast

    banned_calls = {"exec", "eval", "compile", "__import__"}
    banned_modules = {"importlib", "runpy", "subprocess", "code", "codeop"}
    modules = sorted(Path(blockout.__file__).parent.glob("*.py"))
    assert len(modules) >= 7

    for module in modules:
        tree = ast.parse(module.read_text(encoding="utf-8"))
        calls = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        imports = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        } | {
            (node.module or "").split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
        }
        assert calls.isdisjoint(banned_calls), module.name
        assert imports.isdisjoint(banned_modules), module.name


# Three pieces and no sighting: clean without the picture check, one error with it.
UNSIGHTED = (
    "scene.room(id='room', width=8, depth=6, height=3)\n"
    "scene.camera(id='cam', position=(0, 1.6, -5), target=(0, 1.2, 1), fov=65)\n"
    "scene.box(id='a', position=(-2, 0, 1), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
    "scene.box(id='b', position=(0, 0, 1), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
    "scene.box(id='c', position=(2, 0, 1), size=(0.5, 0.5, 0.5), semantic_type='prop')\n"
)


async def test_the_picture_check_is_off_unless_asked_for(image_path, model):
    fake = model(UNSIGHTED)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert len(fake.calls) == 1
    assert "scene.seen" not in fake.calls[0]["prompt"]
    assert generation.warnings == ()
    assert generation.picture_check is False


async def test_the_picture_check_asks_for_sightings_and_checks_them(image_path, model):
    fake = model(UNSIGHTED, GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(
        image_path=image_path, picture_check=True
    )

    assert "scene.seen" in fake.calls[0]["prompt"]
    assert (
        "scene.seen" in fake.calls[1]["prompt"]
        and "at least 3" in fake.calls[1]["prompt"]
    )
    assert generation.compiled == GOLDEN["compiled"]
    assert generation.picture_check is True


async def test_the_render_check_is_off_unless_asked_for(image_path, model):
    fake = model(GOLDEN_PROGRAM)

    generation = await generate_blockout_from_image(image_path=image_path)

    assert len(fake.calls) == 1
    assert generation.render_check is False
    assert generation.renders == ()


async def test_the_render_check_shows_the_model_its_own_scene_and_takes_the_rewrite(
    image_path, model
):
    fake = model(GOLDEN_PROGRAM, REVIEWED_PROGRAM, REVIEWED_AGAIN)

    generation = await generate_blockout_from_image(
        image_path=image_path, render_check=True
    )

    assert BLOCKOUT_REVIEW_ROUNDS == 2
    assert len(fake.calls) == 1 + BLOCKOUT_REVIEW_ROUNDS
    first, second, third = fake.calls
    assert len(first["images"]) == 1
    # Each review sees the reference picture and a render of the scene under review.
    assert second["images"][0].data == first["images"][0].data
    render = Image.open(io.BytesIO(second["images"][1].data))
    assert render.format == "PNG" and render.size == (1024, 576)
    assert "## 渲染核对" in second["prompt"]
    assert GOLDEN_PROGRAM.strip() in second["prompt"]
    assert REVIEWED_PROGRAM.strip() in third["prompt"]
    assert generation.program == REVIEWED_AGAIN.strip()
    assert generation.render_check is True
    assert len(generation.renders) == BLOCKOUT_REVIEW_ROUNDS
    assert generation.renders[0] == second["images"][1].data
    assert [attempt.review for attempt in generation.attempts] == [False, True, True]


async def test_a_review_that_breaks_the_scene_is_sent_back_once_with_its_errors(
    image_path, model
):
    fake = model(GOLDEN_PROGRAM, BROKEN, REVIEWED_PROGRAM, REVIEWED_AGAIN)

    generation = await generate_blockout_from_image(
        image_path=image_path, render_check=True
    )

    assert len(fake.calls) == 1 + BLOCKOUT_REVIEW_ROUNDS + 1
    repair = fake.calls[2]
    # The repair is the same retry as for a draft: the broken program, the
    # checker's complaints, and the picture alone (the render is of the old scene).
    assert "没有通过校验" in repair["prompt"]
    assert BROKEN.strip() in repair["prompt"]
    assert "scene.floor" in repair["prompt"]
    assert len(repair["images"]) == 1
    # The repaired program is the one the second review builds on.
    assert REVIEWED_PROGRAM.strip() in fake.calls[3]["prompt"]
    assert generation.program == REVIEWED_AGAIN.strip()
    assert [attempt.review for attempt in generation.attempts] == [
        False,
        True,
        True,
        True,
    ]
    assert [len(attempt.errors) for attempt in generation.attempts] == [0, 1, 0, 0]
    assert len(generation.renders) == BLOCKOUT_REVIEW_ROUNDS


async def test_a_review_whose_repair_fails_too_is_dropped_and_the_last_good_one_kept(
    image_path, model
):
    fake = model(GOLDEN_PROGRAM, BROKEN, BROKEN, REVIEWED_PROGRAM)

    generation = await generate_blockout_from_image(
        image_path=image_path, render_check=True
    )

    # One repair per review round, never a second one.
    assert len(fake.calls) == 4
    # The second review still looks at the golden scene, not at the broken rewrite.
    assert GOLDEN_PROGRAM.strip() in fake.calls[3]["prompt"]
    assert fake.calls[3]["images"][1].data == fake.calls[1]["images"][1].data
    assert generation.program == REVIEWED_PROGRAM.strip()
    assert [len(attempt.errors) for attempt in generation.attempts] == [0, 1, 1, 0]


async def test_a_review_that_only_adds_plausibility_errors_is_dropped_too(
    image_path, model
):
    fake = model(GOLDEN_PROGRAM, LOOKS_AWAY, LOOKS_AWAY, LOOKS_AWAY, LOOKS_AWAY)

    generation = await generate_blockout_from_image(
        image_path=image_path, render_check=True
    )

    # Plausibility errors are sent back the same way as a program that does not compile.
    assert len(fake.calls) == 5
    assert "没有通过校验" in fake.calls[2]["prompt"]
    assert generation.program == GOLDEN_PROGRAM.strip()
    assert generation.warnings == ()
    assert [len(attempt.errors) for attempt in generation.attempts] == [0, 1, 1, 1, 1]


async def test_the_render_check_starts_from_the_fallback_when_no_draft_was_clean(
    image_path, model
):
    fake = model(LOOKS_AWAY, LOOKS_AWAY, LOOKS_AWAY, GOLDEN_PROGRAM, REVIEWED_PROGRAM)

    generation = await generate_blockout_from_image(
        image_path=image_path, render_check=True
    )

    assert len(fake.calls) == BLOCKOUT_MAX_ATTEMPTS + BLOCKOUT_REVIEW_ROUNDS
    assert LOOKS_AWAY.strip() in fake.calls[3]["prompt"]
    assert generation.program == REVIEWED_PROGRAM.strip()
    assert generation.warnings == ()


async def test_every_review_round_settles_its_own_egress(
    image_path, model, monkeypatch
):
    egress = FakeEgress(monkeypatch)
    fake = model(GOLDEN_PROGRAM, REVIEWED_PROGRAM, REVIEWED_AGAIN)

    await generate_blockout_from_image(
        image_path=image_path, render_check=True, egress_context="org"
    )

    assert [event[0] for event in egress.events] == ["prepare", "complete"] * 3
    assert [call["transport_context"] for call in fake.calls] == ["transport"] * 3


async def test_artifacts_of_a_render_checked_job_keep_the_renders(
    image_path, model, tmp_path
):
    model(GOLDEN_PROGRAM, REVIEWED_PROGRAM, BROKEN, BROKEN)
    generation = await generate_blockout_from_image(
        image_path=image_path, render_check=True
    )
    out_dir = tmp_path / "job"

    write_blockout_artifacts(out_dir, generation)

    assert sorted(path.name for path in out_dir.iterdir()) == [
        "generation.json",
        "render_1.png",
        "render_2.png",
        "result.json",
        "scene.blockout.dsl",
        "scene_ir.json",
    ]
    assert (out_dir / "render_1.png").read_bytes() == generation.renders[0]
    record = json.loads((out_dir / "generation.json").read_text(encoding="utf-8"))
    assert record["render_check"] is True
    assert record["retries"] == 0
    # Draft, first review, broken second review, its failed repair.
    assert [attempt["review"] for attempt in record["attempts"]] == [
        False,
        True,
        True,
        True,
    ]
    assert [len(attempt["errors"]) for attempt in record["attempts"]] == [0, 0, 1, 1]
