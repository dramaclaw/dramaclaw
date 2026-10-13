from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import freezone
from novelvideo.api.routes.model_credits import freezone_image_generate_billing_params
from novelvideo.generators import nanobanana_grid


pytestmark = pytest.mark.m04


def test_midjourney_operation_is_the_exact_catalog_pricing_dimension() -> None:
    billing = freezone_image_generate_billing_params(
        {
            "catalog_id": "midjourney-catalog",
            "pricing_model": "mj_imagine",
            "size": "1K",
            "operation": "imagine",
        }
    )

    assert billing["pricing_params"] == {"operation": "imagine"}


@pytest.mark.asyncio
async def test_midjourney_submit_poll_and_download(monkeypatch) -> None:
    calls: list[tuple[str, str, object]] = []

    class Response:
        def __init__(self, payload=None, content: bytes = b"") -> None:
            self._payload = payload
            self.content = content
            self.status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self):
            return self._payload

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            calls.append(("client", "", kwargs))

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            calls.append(("post", url, json))
            return Response({"code": 1, "description": "success", "result": "mj-task-1"})

        async def get(self, url, *, headers):
            calls.append(("get", url, None))
            if url.endswith("/fetch"):
                return Response({"id": "mj-task-1", "status": "SUCCESS"})
            return Response(content=b"midjourney-image")

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    trace: dict[str, str] = {}

    image, text, error = await nanobanana_grid._call_midjourney_image_api(
        api_key="token",
        model="mj_imagine",
        prompt="cinematic crab",
        image_config={"aspect_ratio": "16:9", "image_size": "1K"},
        base_url="https://relay.example/v1",
        trace=trace,
    )

    assert image == b"midjourney-image"
    assert text == ""
    assert error == ""
    assert calls[1] == (
        "post",
        "https://relay.example/mj/submit/imagine",
        {"prompt": "cinematic crab --ar 16:9"},
    )
    assert calls[2][1] == "https://relay.example/mj/task/mj-task-1/fetch"
    assert calls[3][1] == "https://relay.example/mj/image/mj-task-1"
    assert trace == {
        "request_id": "mj-task-1",
        "response_id": "mj-task-1",
        "midjourney": {
            "task_id": "mj-task-1",
            "parent_task_id": "",
            "operation": "imagine",
            "status": "SUCCESS",
            "buttons": [],
            "seed": "",
        },
    }


def test_midjourney_prompt_preserves_explicit_aspect_ratio() -> None:
    assert (
        nanobanana_grid._midjourney_prompt("portrait --ar 3:4 --stylize 200", "16:9")
        == "portrait --ar 3:4 --stylize 200"
    )
    assert nanobanana_grid._midjourney_prompt("portrait", "auto") == "portrait"


def test_midjourney_prompt_compiles_typed_imagine_parameters() -> None:
    prompt = nanobanana_grid._midjourney_prompt(
        "cinematic crab",
        "16:9",
        {
            "version": "7",
            "stylize": 250,
            "chaos": 12,
            "weird": 50,
            "quality": 0.5,
            "seed": 42,
            "stop": 90,
            "raw": True,
            "draft": True,
            "tile": True,
            "no": "text, watermark",
        },
    )

    assert prompt == (
        "cinematic crab --ar 16:9 --s 250 --c 12 --weird 50 --q 0.5 "
        "--seed 42 --stop 90 --v 7 --raw --draft --tile --no text, watermark"
    )


def test_midjourney_prompt_keeps_explicit_flags_authoritative() -> None:
    prompt = nanobanana_grid._midjourney_prompt(
        "portrait --ar 3:4 --stylize 900 --raw --tile",
        "16:9",
        {"stylize": 100, "raw": True, "tile": True},
    )

    assert prompt == "portrait --ar 3:4 --stylize 900 --raw --tile"


def test_midjourney_prompt_compiles_niji_version_without_v_flag() -> None:
    assert nanobanana_grid._midjourney_prompt(
        "anime portrait",
        "1:1",
        {"version": "niji 7"},
    ) == "anime portrait --ar 1:1 --niji 7"


def test_midjourney_prompt_rejects_parameter_injection_in_exclude_text() -> None:
    with pytest.raises(ValueError, match="parameter: no"):
        nanobanana_grid._midjourney_prompt(
            "portrait",
            "1:1",
            {"no": "watermark --seed 1"},
        )


def test_midjourney_catalog_allows_text_only_mode() -> None:
    capabilities = {"supportedModes": ["text_to_image"]}

    freezone._require_catalog_image_mode(capabilities, "text_to_image")
    with pytest.raises(HTTPException, match="does not support image_to_image"):
        freezone._require_catalog_image_mode(capabilities, "image_to_image")


def test_midjourney_edit_and_blend_are_checked_against_catalog_operations() -> None:
    schema = {
        "adapter": "relayclaw_midjourney",
        "supportedOperations": ["imagine", "edit", "blend"],
    }

    assert freezone._validate_midjourney_image_operation(
        request_schema=schema,
        model_params={},
        requested_reference_mode="edit",
        reference_count=1,
        prompt="change the sky",
    ) == {"reference_mode": "edit"}
    assert freezone._validate_midjourney_image_operation(
        request_schema=schema,
        model_params={},
        requested_reference_mode="blend",
        reference_count=2,
        prompt="",
    ) == {"reference_mode": "blend"}

    with pytest.raises(HTTPException, match="at least two"):
        freezone._validate_midjourney_image_operation(
            request_schema=schema,
            model_params={},
            requested_reference_mode="blend",
            reference_count=1,
            prompt="",
        )
    with pytest.raises(HTTPException, match="at most five"):
        freezone._validate_midjourney_image_operation(
            request_schema=schema,
            model_params={},
            requested_reference_mode="blend",
            reference_count=6,
            prompt="",
        )
    with pytest.raises(HTTPException, match="not enabled"):
        freezone._validate_midjourney_image_operation(
            request_schema={
                "adapter": "relayclaw_midjourney",
                "supportedOperations": ["imagine"],
            },
            model_params={},
            requested_reference_mode="edit",
            reference_count=1,
            prompt="change the sky",
        )


@pytest.mark.parametrize(
    ("custom_id", "operation"),
    [
        ("MJ::JOB::upsample::1::task", "upscale"),
        ("MJ::JOB::variation::4::task", "variation"),
        ("MJ::JOB::low_variation::1::task", "low_variation"),
        ("MJ::JOB::reroll::0::task", "reroll"),
        ("MJ::JOB::pan_left::1::task", "pan"),
        ("MJ::Outpaint::2x::task", "zoom"),
    ],
)
def test_midjourney_button_operation_is_server_derived(
    custom_id: str,
    operation: str,
) -> None:
    assert freezone._midjourney_button_operation(custom_id) == operation


@pytest.mark.asyncio
async def test_generate_text_to_image_dispatches_midjourney(monkeypatch, tmp_path: Path) -> None:
    captured = {}

    async def midjourney(**kwargs):
        captured.update(kwargs)
        kwargs["trace"]["request_id"] = "mj-task-2"
        kwargs["trace"]["response_id"] = "mj-task-2"
        return b"mj", "", ""

    async def generic(**_kwargs):
        raise AssertionError("OpenAI-compatible image endpoint must not be used")

    monkeypatch.setattr(nanobanana_grid, "_call_midjourney_image_api", midjourney)
    monkeypatch.setattr(nanobanana_grid, "_call_newapi_image_api", generic)
    output = tmp_path / "midjourney.png"

    result = await nanobanana_grid.generate_text_to_image(
        "a moonlit city",
        str(output),
        aspect_ratio="9:16",
        image_size="1K",
        config={
            "provider": "newapi",
            "model": "mj_imagine",
            "api_key": "token",
            "base_url": "https://relay.example/v1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        },
    )

    assert result == output
    assert output.read_bytes() == b"mj"
    assert captured["prompt"] == "a moonlit city"
    assert captured["model"] == "mj_imagine"
    assert captured["image_config"] == {
        "aspect_ratio": "9:16",
        "image_size": "1K",
        "model_params": {},
        "request_schema": {},
    }


@pytest.mark.asyncio
async def test_generate_dispatches_explicit_midjourney_adapter(monkeypatch, tmp_path: Path) -> None:
    captured = {}

    async def midjourney(**kwargs):
        captured.update(kwargs)
        return b"mj", "", ""

    async def generic(**_kwargs):
        raise AssertionError("explicit Midjourney adapter must use the native task API")

    monkeypatch.setattr(nanobanana_grid, "_call_midjourney_image_api", midjourney)
    monkeypatch.setattr(nanobanana_grid, "_call_newapi_image_api", generic)
    output = tmp_path / "midjourney-adapter.png"

    await nanobanana_grid.generate_text_to_image(
        "a moonlit city",
        str(output),
        config={
            "provider": "newapi",
            "model": "vendor-specific-midjourney-name",
            "api_key": "token",
            "base_url": "https://relay.example/v1",
            "newapi_request_schema": {"adapter": "relayclaw_midjourney"},
            "newapi_model_params": {"stylize": 300},
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        },
    )

    assert output.read_bytes() == b"mj"
    assert captured["model"] == "vendor-specific-midjourney-name"
    assert captured["image_config"]["model_params"] == {"stylize": 300}


@pytest.mark.asyncio
async def test_midjourney_dispatches_reference_images_as_base64_array(
    monkeypatch, tmp_path: Path
) -> None:
    captured = {}

    async def midjourney(**kwargs):
        captured.update(kwargs)
        return b"mj-reference", "", ""

    monkeypatch.setattr(nanobanana_grid, "_call_midjourney_image_api", midjourney)
    reference = tmp_path / "reference.png"
    reference.write_bytes(b"reference")

    output = tmp_path / "output.png"
    await nanobanana_grid.generate_reference_edit_image(
        "edit this",
        [str(reference)],
        str(output),
        config={
            "provider": "newapi",
            "model": "mj_imagine",
            "api_key": "token",
            "base_url": "https://relay.example/v1",
            "newapi_model_params": {"reference_mode": "image_prompt"},
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        },
    )

    assert output.read_bytes() == b"mj-reference"
    assert captured["reference_images"] == [(b"reference", str(reference))]


@pytest.mark.asyncio
async def test_midjourney_followup_submits_action_and_keeps_next_buttons(monkeypatch) -> None:
    calls: list[tuple[str, object]] = []

    class Response:
        def __init__(self, payload=None, content: bytes = b"") -> None:
            self._payload = payload
            self.content = content
            self.status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self):
            return self._payload

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            calls.append((url, json))
            return Response({"code": 1, "result": "child-task"})

        async def get(self, url, *, headers):
            if url.endswith("/fetch"):
                return Response(
                    {
                        "id": "child-task",
                        "status": "SUCCESS",
                        "buttons": [
                            {
                                "customId": "MJ::JOB::low_variation::1::child-task",
                                "label": "Vary (Subtle)",
                            }
                        ],
                    }
                )
            return Response(content=b"child-image")

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    trace: dict[str, object] = {}
    image, _, error = await nanobanana_grid._call_midjourney_image_api(
        api_key="token",
        model="mj_imagine",
        prompt="",
        base_url="https://relay.example/v1",
        trace=trace,
        followup={
            "task_id": "parent-task",
            "custom_id": "MJ::JOB::upsample::2::parent-task",
            "operation": "upscale",
        },
    )

    assert error == ""
    assert image == b"child-image"
    assert calls == [
        (
            "https://relay.example/mj/submit/action",
            {
                "customId": "MJ::JOB::upsample::2::parent-task",
                "taskId": "parent-task",
            },
        )
    ]
    assert trace["midjourney"] == {
        "task_id": "child-task",
        "parent_task_id": "parent-task",
        "operation": "upscale",
        "status": "SUCCESS",
        "buttons": [
            {
                "custom_id": "MJ::JOB::low_variation::1::child-task",
                "label": "Vary (Subtle)",
            }
        ],
        "seed": "",
    }


@pytest.mark.asyncio
async def test_midjourney_image_prompt_sends_reference_bytes(monkeypatch) -> None:
    submitted: list[tuple[str, dict]] = []

    class Response:
        def __init__(self, payload=None, content: bytes = b"") -> None:
            self._payload = payload
            self.content = content
            self.status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self):
            return self._payload

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            submitted.append((url, json))
            if url.endswith("/upload-discord-images"):
                return Response(
                    {"code": 1, "result": ["https://cdn.example/reference.png"]}
                )
            return Response({"code": 1, "result": "reference-task"})

        async def get(self, url, *, headers):
            if url.endswith("/fetch"):
                return Response({"status": "SUCCESS"})
            return Response(content=b"reference-result")

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    image, _, error = await nanobanana_grid._call_midjourney_image_api(
        api_key="token",
        model="mj_imagine",
        prompt="use this composition",
        image_config={
            "aspect_ratio": "3:2",
            "image_size": "1K",
            "model_params": {
                "reference_mode": "image_prompt",
                "image_weight": 1.5,
            },
        },
        base_url="https://relay.example/v1",
        reference_images=[(b"png-bytes", "reference.png")],
    )

    assert error == ""
    assert image == b"reference-result"
    assert submitted == [
        (
            "https://relay.example/mj/submit/upload-discord-images",
            {"base64Array": ["data:image/png;base64,cG5nLWJ5dGVz"]},
        ),
        (
            "https://relay.example/mj/submit/imagine",
            {
                "prompt": (
                    "https://cdn.example/reference.png "
                    "use this composition --ar 3:2 --iw 1.5"
                )
            },
        ),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reference_mode", "prompt", "expected_endpoint", "expected_payload", "operation"),
    [
        (
            "edit",
            "replace the sky",
            "edits",
            {
                "prompt": "replace the sky --ar 1:1",
                "base64Array": ["data:image/png;base64,aW1hZ2UtMQ=="],
            },
            "edit",
        ),
        (
            "blend",
            "",
            "blend",
            {
                "base64Array": [
                    "data:image/png;base64,aW1hZ2UtMQ==",
                    "data:image/png;base64,aW1hZ2UtMg==",
                ],
            },
            "blend",
        ),
    ],
)
@pytest.mark.parametrize(
    ("ratio", "options"),
    [
        ("1:1", {}),
        ("2:3", {}),
        ("16:9", {"mode": "", "botType": "", "dimensions": ""}),
        ("3:2", {"mode": "fast", "botType": "NIJI_JOURNEY", "dimensions": "PORTRAIT"}),
    ],
)
@pytest.mark.parametrize("reference_count", [2, 5])
async def test_midjourney_edit_and_blend_use_native_endpoints(
    monkeypatch,
    reference_mode: str,
    prompt: str,
    expected_endpoint: str,
    expected_payload: dict,
    operation: str,
    ratio: str,
    options: dict,
    reference_count: int,
) -> None:
    submitted: list[tuple[str, dict]] = []

    class Response:
        def __init__(self, payload=None, content: bytes = b"") -> None:
            self._payload = payload
            self.content = content
            self.status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self):
            return self._payload

    class Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            assert headers["Authorization"] == "Bearer token"
            assert headers["Content-Type"] == "application/json"
            submitted.append((url, json))
            return Response({"code": 1, "result": "native-task"})

        async def get(self, url, *, headers):
            if url.endswith("/fetch"):
                return Response({"status": "SUCCESS"})
            return Response(content=b"native-result")

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    references = [(b"image-1", "one.png")]
    if reference_mode == "blend":
        references.append((b"image-2", "two.png"))
        references.extend([(b"image-2", "two.png")] * (reference_count - 2))
    image_config = {"model_params": {"reference_mode": reference_mode}}
    if reference_mode == "blend":
        image_config["aspect_ratio"] = ratio
        image_config["model_params"].update(options)
        expected_payload = {
            **expected_payload,
            "base64Array": expected_payload["base64Array"]
            + ["data:image/png;base64,aW1hZ2UtMg=="] * (reference_count - 2),
            **{key: value.upper() for key, value in options.items() if value},
        }
    trace: dict[str, object] = {}

    image, _, error = await nanobanana_grid._call_midjourney_image_api(
        api_key="token",
        model="mj_imagine",
        prompt=prompt,
        image_config=image_config,
        base_url="https://relay.example/v1",
        reference_images=references,
        trace=trace,
    )

    assert error == ""
    assert image == b"native-result"
    assert submitted == [
        (f"https://relay.example/mj/submit/{expected_endpoint}", expected_payload)
    ]
    assert trace["midjourney"]["operation"] == operation


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("count", "params", "message"),
    [
        (0, {}, "two to five"),
        (1, {}, "two to five"),
        (6, {}, "two to five"),
        (2, {"mode": "INVALID"}, "mode must"),
        (2, {"botType": "INVALID"}, "botType must"),
        (2, {"dimensions": "16:9"}, "dimensions must"),
    ],
)
async def test_midjourney_blend_rejects_invalid_input_before_http(
    monkeypatch, count: int, params: dict, message: str,
) -> None:
    import httpx

    def unexpected_client(*args, **kwargs):
        pytest.fail("invalid Blend input must not reach the gateway")

    monkeypatch.setattr(httpx, "AsyncClient", unexpected_client)
    image, _, error = await nanobanana_grid._call_midjourney_image_api(
        api_key="token",
        model="mj_imagine",
        prompt="",
        image_config={"model_params": {"reference_mode": "blend", **params}},
        base_url="https://relay.example/v1",
        reference_images=[(b"image", "one.png")] * count,
    )
    assert image is None
    assert message in error
