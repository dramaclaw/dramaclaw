import pytest

from novelvideo.media_model_request_schema import (
    MediaModelSchemaError,
    apply_media_request_schema,
    enforce_newapi_media_geometry_contract,
    enforce_newapi_video_duration_contract,
    media_request_schema_for_mode,
    normalize_media_model_catalog_config,
    normalize_media_model_mode,
    normalize_media_resolution_value,
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


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("4K", "4k"),
        ("0.5K", "0.5k"),
        ("1080P", "1080p"),
        ("2048x1376", "2048x1376"),
    ],
)
def test_normalizes_named_media_resolution_tiers(raw, expected):
    assert normalize_media_resolution_value(raw) == expected


def test_normalizes_catalog_resolutions_without_case_duplicates():
    config = {
        "resolutionOptions": ["1K", "2k", "4K", "4k", "2048x1376"],
        "ratioOptions": ["Auto", "adaptive", "16:9"],
        "defaultGenerateAudio": False,
    }

    normalized = normalize_media_model_catalog_config(config)

    assert normalized["resolutionOptions"] == ["1k", "2k", "4k", "2048x1376"]
    assert normalized["ratioOptions"] == ["auto", "16:9"]
    assert "defaultGenerateAudio" not in normalized
    assert config["resolutionOptions"] == ["1K", "2k", "4K", "4k", "2048x1376"]


@pytest.mark.parametrize(
    ("media_type", "raw_ratio", "expected_ratio"),
    [("image", "adaptive", "auto"), ("video", "adaptive", "auto")],
)
def test_auto_geometry_removes_conflicting_dimensions(
    media_type, raw_ratio, expected_ratio
):
    result = enforce_newapi_media_geometry_contract(
        {
            "width": 1920,
            "height": 1080,
            "size": "1920x1080",
            "aspect_ratio": raw_ratio,
            "resolution": "1080P",
            "metadata": {
                "reference_images": ["https://example.com/reference.png"],
            },
        },
        media_type=media_type,
    )

    assert "width" not in result
    assert "height" not in result
    assert "size" not in result
    assert result["metadata"] == {
        "ratio": expected_ratio,
        "reference_images": ["https://example.com/reference.png"],
        "resolution": "1080p",
    }


def test_fixed_geometry_keeps_ratio_and_removes_legacy_size():
    result = enforce_newapi_media_geometry_contract(
        {
            "width": 1920,
            "height": 1080,
            "size": "1920x1080",
            "metadata": {"ratio": "16:9", "resolution": "4K"},
        },
        media_type="video",
    )

    assert result == {
        "width": 1920,
        "height": 1080,
        "metadata": {"ratio": "16:9", "resolution": "4k"},
    }


@pytest.mark.parametrize(
    ("raw_duration", "expected"),
    [("auto", "auto"), ("AUTO", "auto"), ("5", 5), (5.5, 5.5)],
)
def test_normalizes_generic_newapi_video_duration(raw_duration, expected):
    result = enforce_newapi_video_duration_contract(
        {"seconds": raw_duration, "model": "video-model"}
    )

    assert result == {"duration": expected, "model": "video-model"}


def test_model_schema_can_override_numeric_video_duration_with_auto():
    schema = {
        "endpoint": "video/generations",
        "parameters": [
            {
                "key": "duration_mode",
                "label": "输出时长",
                "control": "select",
                "requestPath": "duration",
                "options": ["auto"],
                "default": "auto",
            }
        ],
    }

    configured = apply_media_request_schema(
        {"model": "video-model", "duration": 5}, schema, {}
    )
    result = enforce_newapi_video_duration_contract(configured)

    assert result == {"model": "video-model", "duration": "auto"}


def test_video_edit_forces_auto_geometry_and_duration_after_model_parameters():
    from novelvideo.media_model_request_schema import (
        enforce_newapi_video_mode_contract,
    )

    result = enforce_newapi_video_mode_contract(
        {
            "model": "video-model",
            "duration": 5,
            "width": 1280,
            "height": 720,
            "metadata": {"ratio": "16:9", "resolution": "720p"},
        },
        mode="videoEdit",
    )

    assert result == {
        "model": "video-model",
        "duration": "auto",
        "metadata": {"ratio": "auto", "resolution": "720p"},
    }


def test_non_edit_mode_rejects_model_parameter_auto_duration():
    from novelvideo.media_model_request_schema import (
        enforce_newapi_video_mode_contract,
    )

    result = enforce_newapi_video_mode_contract(
        {"model": "video-model", "duration": "auto"},
        mode="allReference",
        fixed_duration=8,
    )

    assert result == {"model": "video-model", "duration": 8}


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
    ("business_mode", "catalog_mode"),
    [
        ("textToVideo", "text_to_video"),
        ("firstFrame", "first_frame"),
        ("firstLastFrame", "first_last_frame"),
        ("imageToVideo", "image_to_video"),
        ("imageReference", "image_reference"),
        ("allReference", "all_reference"),
        ("videoEdit", "video_edit"),
    ],
)
def test_normalizes_all_canvas_video_modes(business_mode, catalog_mode):
    assert normalize_media_model_mode(business_mode) == catalog_mode


def test_first_frame_alias_keeps_and_validates_mode_specific_parameters():
    schema = {
        "endpoint": "video/generations",
        "parameters": [
            {
                "key": "camera_fixed",
                "control": "switch",
                "requestPath": "camera_fixed",
                "required": True,
                "modes": ["first_frame"],
            },
            {
                "key": "reference_strength",
                "control": "number",
                "requestPath": "reference_strength",
                "modes": ["image_reference"],
            },
        ],
    }

    filtered = media_request_schema_for_mode(schema, "firstFrame")

    assert [item["key"] for item in filtered["parameters"]] == ["camera_fixed"]
    assert validate_media_model_params(filtered, {"camera_fixed": True}) == {
        "camera_fixed": True
    }
    with pytest.raises(MediaModelSchemaError, match="parameter is required: camera_fixed"):
        validate_media_model_params(filtered, {})


def test_image_to_video_and_image_reference_parameters_are_independent():
    schema = {
        "endpoint": "video/generations",
        "parameters": [
            {
                "key": "i2v_only",
                "control": "switch",
                "requestPath": "i2v_only",
                "modes": ["image_to_video"],
            },
            {
                "key": "reference_only",
                "control": "switch",
                "requestPath": "reference_only",
                "modes": ["image_reference"],
            },
        ],
    }

    image_to_video = media_request_schema_for_mode(schema, "imageToVideo")
    image_reference = media_request_schema_for_mode(schema, "imageReference")

    assert [item["key"] for item in image_to_video["parameters"]] == ["i2v_only"]
    assert [item["key"] for item in image_reference["parameters"]] == [
        "reference_only"
    ]


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
        "supportedModes": [
            "text_to_video",
            "image_to_video",
            "image_reference",
            "all_reference",
        ],
        "minDuration": 4,
        "maxDuration": 12,
        "referenceImageMax": 4,
        "referenceVideoMax": 1,
        "referenceAudioMax": 0,
        "humanReview": True,
        "supportsGenerateAudio": True,
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


def test_validates_video_native_audio_capabilities():
    base = {
        "request": {"endpoint": "video/generations", "parameters": []},
    }
    assert validate_media_model_catalog_config(
        {
            **base,
            "supportsGenerateAudio": True,
        },
        "video",
    )
    assert validate_media_model_catalog_config(
        {
            **base,
            "supportsGenerateAudio": False,
        },
        "video",
    )
    with pytest.raises(MediaModelSchemaError, match="supportsGenerateAudio"):
        validate_media_model_catalog_config(
            {**base, "supportsGenerateAudio": "yes"},
            "video",
        )
    with pytest.raises(MediaModelSchemaError, match="incompatible fields"):
        validate_media_model_catalog_config(
            {
                "supportsGenerateAudio": True,
                "request": {"endpoint": "images/generations", "parameters": []},
            },
            "image",
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


@pytest.mark.parametrize(
    "field",
    [
        "referenceAudioMinSeconds",
        "referenceAudioMaxSeconds",
        "referenceAudioTotalMinSeconds",
        "referenceAudioTotalMaxSeconds",
        "referenceVideoMinSeconds",
        "referenceVideoMaxSeconds",
        "referenceVideoTotalMinSeconds",
        "referenceVideoTotalMaxSeconds",
    ],
)
def test_video_catalog_validates_reference_duration_fields(field):
    config = {
        field: 1.5,
        "request": {"endpoint": "video/generations", "parameters": []},
    }
    assert validate_media_model_catalog_config(config, "video") is config

    config[field] = 0
    with pytest.raises(MediaModelSchemaError, match=field):
        validate_media_model_catalog_config(config, "video")


def test_video_catalog_rejects_inverted_reference_duration_range():
    with pytest.raises(MediaModelSchemaError, match="cannot exceed"):
        validate_media_model_catalog_config(
            {
                "referenceAudioTotalMinSeconds": 20,
                "referenceAudioTotalMaxSeconds": 10,
                "request": {"endpoint": "video/generations", "parameters": []},
            },
            "video",
        )
