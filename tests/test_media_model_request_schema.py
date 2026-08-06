import pytest

from novelvideo.media_model_request_schema import (
    MediaModelSchemaError,
    apply_media_request_schema,
    media_request_schema_for_mode,
    validate_media_model_catalog_config,
    validate_media_model_params,
    validate_media_request_schema,
)


SCHEMA = {
    "endpoint": "video/generations",
    "parameters": [
        {
            "key": "camera_fixed",
            "label": "固定镜头",
            "control": "switch",
            "requestPath": "metadata.camera_fixed",
            "default": False,
        },
        {
            "key": "steps",
            "label": "采样步数",
            "control": "number",
            "requestPath": "extra_fields.steps",
            "min": 1,
            "max": 50,
        },
    ],
    "omitPaths": ["metadata.legacy"],
}


def test_applies_validated_parameters_without_mutating_original_payload():
    payload = {"model": "video-v1", "metadata": {"legacy": True}}

    result = apply_media_request_schema(
        payload, SCHEMA, {"camera_fixed": True, "steps": 24}
    )

    assert result == {
        "model": "video-v1",
        "metadata": {"camera_fixed": True},
        "extra_fields": {"steps": 24},
    }
    assert payload == {"model": "video-v1", "metadata": {"legacy": True}}


@pytest.mark.parametrize("path", ["model", "headers.Authorization", "base_url"])
def test_rejects_sensitive_request_paths(path):
    schema = {
        "endpoint": "images/generations",
        "parameters": [
            {"key": "unsafe", "label": "Unsafe", "control": "text", "requestPath": path}
        ],
    }

    with pytest.raises(MediaModelSchemaError, match="unsafe request path"):
        validate_media_request_schema(schema)


def test_rejects_unknown_or_out_of_range_values():
    with pytest.raises(MediaModelSchemaError, match="unknown model parameters"):
        validate_media_model_params(SCHEMA, {"unknown": "value"})
    with pytest.raises(MediaModelSchemaError, match="exceeds maximum"):
        validate_media_model_params(SCHEMA, {"steps": 51})


def test_rejects_empty_required_multiselect():
    schema = {
        "endpoint": "video/generations",
        "parameters": [
            {
                "key": "styles",
                "control": "multiselect",
                "requestPath": "styles",
                "options": ["cinematic", "anime"],
                "required": True,
            }
        ],
    }

    with pytest.raises(MediaModelSchemaError, match="parameter is required: styles"):
        validate_media_model_params(schema, {"styles": []})


def test_filters_mode_specific_parameters_and_defaults():
    schema = {
        "endpoint": "video/generations",
        "parameters": [
            {
                "key": "camera_fixed",
                "control": "switch",
                "requestPath": "camera_fixed",
                "default": False,
                "modes": ["first_frame"],
            },
            {
                "key": "seed",
                "control": "number",
                "requestPath": "seed",
                "default": 1,
            },
        ],
    }

    filtered = media_request_schema_for_mode(schema, "textToVideo")

    assert [item["key"] for item in filtered["parameters"]] == ["seed"]
    assert validate_media_model_params(filtered, {}) == {"seed": 1}
    with pytest.raises(MediaModelSchemaError, match="unknown model parameters"):
        validate_media_model_params(filtered, {"camera_fixed": True})


@pytest.mark.parametrize(
    ("parameter", "message"),
    [
        (
            {
                "key": "steps",
                "control": "number",
                "requestPath": "steps",
                "min": 10,
                "max": 5,
            },
            "min exceeds max",
        ),
        (
            {
                "key": "steps",
                "control": "number",
                "requestPath": "steps",
                "step": 0,
            },
            "step must be positive",
        ),
        (
            {
                "key": "quality",
                "control": "select",
                "requestPath": "quality",
                "options": ["low", "high"],
                "default": "ultra",
            },
            "unsupported value",
        ),
        (
            {
                "key": "quality",
                "control": "select",
                "requestPath": "quality",
                "options": [],
            },
            "options are required",
        ),
        (
            {
                "key": "quality",
                "control": "select",
                "requestPath": "quality",
                "options": ["low", "high"],
                "modes": ["text_to_vdeo"],
            },
            "invalid or duplicate modes",
        ),
        (
            {
                "key": "quality",
                "control": "select",
                "requestPath": "quality",
                "options": ["low", "high"],
                "modes": ["text_to_video", "text_to_video"],
            },
            "invalid or duplicate modes",
        ),
    ],
)
def test_rejects_invalid_parameter_definitions(parameter, message):
    with pytest.raises(MediaModelSchemaError, match=message):
        validate_media_request_schema(
            {"endpoint": "video/generations", "parameters": [parameter]}
        )


def test_validates_media_catalog_capabilities():
    valid = {
        "resolutionOptions": ["720p", "1080p"],
        "supportedModes": ["text_to_video", "all_reference"],
        "minDuration": 4,
        "maxDuration": 12,
        "referenceImageMax": 4,
        "referenceVideoMax": 1,
        "referenceAudioMax": 0,
        "humanReview": True,
        "request": {"endpoint": "video/generations", "parameters": []},
    }

    assert validate_media_model_catalog_config(valid, "video") is valid
    with pytest.raises(MediaModelSchemaError, match="minDuration cannot exceed"):
        validate_media_model_catalog_config(
            {**valid, "minDuration": 13, "maxDuration": 12},
            "video",
        )
    with pytest.raises(MediaModelSchemaError, match="referenceImageMax"):
        validate_media_model_catalog_config(
            {**valid, "referenceImageMax": -1},
            "video",
        )
    with pytest.raises(MediaModelSchemaError, match="supportedModes"):
        validate_media_model_catalog_config(
            {**valid, "supportedModes": ["unknown_mode"]},
            "video",
        )
    with pytest.raises(MediaModelSchemaError, match="referenceVideoMax requires"):
        validate_media_model_catalog_config(
            {**valid, "supportedModes": ["text_to_video"]},
            "video",
        )


def test_validates_reference_audio_total_max_seconds():
    """参考音频**总时长**上限：收小数（厂商口径 15.2 本身就不是整数），只拒非正数。"""
    base = {
        "supportedModes": ["all_reference"],
        "request": {"endpoint": "video/generations", "parameters": []},
    }
    for value in (15.2, 15, 0.5):
        config = {**base, "referenceAudioTotalMaxSeconds": value}
        assert validate_media_model_catalog_config(config, "video") is config
    # 没配 = 走后端 15.2s 兜底，不是错误。
    assert validate_media_model_catalog_config({**base}, "video") is not None

    # True 也要拒：`type(True) is bool`，不能让布尔当成 1 秒混进来。
    # inf / nan 也要拒：`inf > 0` 是 True、`nan <= 0` 是 False，只写「正数」两个都会漏进来，
    # 配成 inf 就等于把这个上限静默关掉。
    for bad in (0, -1, "15.2", True, [], float("inf"), float("nan"), float("-inf")):
        with pytest.raises(
            MediaModelSchemaError, match="referenceAudioTotalMaxSeconds"
        ):
            validate_media_model_catalog_config(
                {**base, "referenceAudioTotalMaxSeconds": bad},
                "video",
            )

    # 图片模型没有参考音频这回事，配了要报「不兼容」而不是默默收下。
    with pytest.raises(MediaModelSchemaError, match="incompatible fields"):
        validate_media_model_catalog_config(
            {
                "referenceAudioTotalMaxSeconds": 15.2,
                "request": {"endpoint": "images/generations", "parameters": []},
            },
            "image",
        )


def test_catalog_config_rejects_endpoint_for_other_media_type():
    with pytest.raises(MediaModelSchemaError, match="image model request endpoint"):
        validate_media_model_catalog_config(
            {
                "request": {
                    "endpoint": "video/generations",
                    "parameters": [],
                }
            },
            "image",
        )


def test_catalog_config_rejects_reserved_identity_fields():
    with pytest.raises(MediaModelSchemaError, match="reserved fields"):
        validate_media_model_catalog_config(
            {
                "id": "spoofed-id",
                "apiModel": "spoofed-model",
                "request": {
                    "endpoint": "images/generations",
                    "parameters": [],
                },
            },
            "image",
        )


def test_parameter_options_preserve_distinct_types_and_reject_duplicates():
    typed_options = {
        "endpoint": "images/generations",
        "parameters": [
            {
                "key": "value",
                "control": "select",
                "requestPath": "value",
                "options": [1, "1", True, "true"],
                "default": 1,
            }
        ],
    }
    assert validate_media_request_schema(typed_options) is typed_options

    duplicate_options = {
        **typed_options,
        "parameters": [
            {
                **typed_options["parameters"][0],
                "options": [1, 1.0],
            }
        ],
    }
    with pytest.raises(MediaModelSchemaError, match="duplicate options"):
        validate_media_request_schema(duplicate_options)


def test_parameter_options_preserve_javascript_distinct_floats():
    schema = {
        "endpoint": "images/generations",
        "parameters": [
            {
                "key": "value",
                "control": "select",
                "requestPath": "value",
                "options": [1, 1.0000000000000002],
                "default": 1.0000000000000002,
            }
        ],
    }

    assert validate_media_request_schema(schema) is schema


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("options", [2**53]),
        ("default", 2**53),
        ("min", -(2**53)),
        ("max", 2**53),
        ("step", float("inf")),
    ],
)
def test_parameter_schema_rejects_unsafe_javascript_numbers(field, value):
    parameter = {
        "key": "value",
        "control": "number",
        "requestPath": "value",
    }
    parameter[field] = value
    schema = {
        "endpoint": "images/generations",
        "parameters": [parameter],
    }

    with pytest.raises(MediaModelSchemaError, match="safe numeric range|finite"):
        validate_media_request_schema(schema)


@pytest.mark.parametrize(
    ("media_type", "field", "value"),
    [
        ("image", "minDuration", 5),
        ("image", "referenceVideoMax", 1),
        ("image", "humanReview", True),
        ("video", "qualityOptions", ["high"]),
        ("video", "minPixels", 3_686_400),
    ],
)
def test_catalog_config_rejects_incompatible_media_fields(
    media_type,
    field,
    value,
):
    endpoint = "images/generations" if media_type == "image" else "video/generations"
    with pytest.raises(MediaModelSchemaError, match="incompatible fields"):
        validate_media_model_catalog_config(
            {
                field: value,
                "request": {"endpoint": endpoint, "parameters": []},
            },
            media_type,
        )


def test_image_catalog_accepts_reference_image_limit_and_pixel_floor():
    config = {
        "referenceImageMax": 3,
        "minPixels": 3_686_400,
        "request": {"endpoint": "images/generations", "parameters": []},
    }

    assert validate_media_model_catalog_config(config, "image") is config


@pytest.mark.parametrize("value", [0, -1, 1.5, True, 16_777_217, 2**53])
def test_image_catalog_rejects_invalid_min_pixels(value):
    with pytest.raises(MediaModelSchemaError, match="minPixels"):
        validate_media_model_catalog_config(
            {
                "minPixels": value,
                "request": {"endpoint": "images/generations", "parameters": []},
            },
            "image",
        )
