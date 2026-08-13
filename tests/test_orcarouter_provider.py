"""Named OrcaRouter provider integration.

OrcaRouter is an OpenAI-compatible meta-router (https://api.orcarouter.ai/v1).
Mirroring the existing OpenRouter preset, it is exposed as a named provider
channel for NewAPI provisioning and as a legacy PydanticAI model preset.
"""

from __future__ import annotations

import json

from novelvideo import config
from novelvideo import newapi_provisioner


def test_newapi_provisioner_preset_for_orcarouter():
    preset = newapi_provisioner.PROVIDER_PRESETS["orcarouter"]
    assert preset["label"] == "OrcaRouter"
    # OpenAI-compatible channel (type 1) so base_url is passed through.
    assert preset["type"] == 1
    assert preset["base_url"] == "https://api.orcarouter.ai/v1"


def test_build_channel_payload_for_orcarouter():
    payload = newapi_provisioner.build_channel_payload(
        provider="orcarouter",
        upstream_key="sk-orca-test",
        model_mapping={"gpt-5.5": "openai/gpt-5.5"},
    )
    channel = payload["channel"]
    assert channel["name"] == "DC-orcarouter"
    assert channel["type"] == 1
    assert channel["base_url"] == "https://api.orcarouter.ai/v1"
    assert channel["key"] == "sk-orca-test"
    assert channel["models"] == "gpt-5.5"
    assert json.loads(channel["model_mapping"]) == {"gpt-5.5": "openai/gpt-5.5"}


def test_config_preset_for_orcarouter():
    preset = config.PROVIDER_PRESETS["orcarouter"]
    assert preset["base_url"] == "https://api.orcarouter.ai/v1"
    assert preset["default_model"] == "openai/gpt-5.5"
    assert preset["api_key_env"] == "ORCAROUTER_API_KEY"
    assert preset["timeout"] == 300


def test_config_alias_for_orcarouter():
    assert config.PROVIDER_ALIASES["orca"] == "orcarouter"
