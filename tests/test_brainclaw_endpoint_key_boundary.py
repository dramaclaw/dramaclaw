"""The official RelayClaw key may only travel to the official endpoint.

The fallback that produced this was unconditional: an empty dedicated BrainClaw
key resolved to the official one whatever host the operator had typed. So a CE
operator who changed only the BrainClaw base URL — leaving the key field blank,
which the save path accepted — sent a RelayClaw credential to that host on
every subsequent request.

Nothing looked wrong. The request succeeded, and billing, audit and tenant
attribution all followed a key the operator never meant to expose there.

Two separate defects, and both had to be fixed. `get_effective_llm_config`
chose the key; the save path decided whether the configuration was allowed at
all, and it read `apiKeyPreview` as proof that a BrainClaw key existed — but
the preview showed the official key falling through, so it was non-empty even
when no dedicated key had ever been saved.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

import novelvideo.model_gateway_settings as gateway

OFFICIAL_KEY = "sk-official-relayclaw-secret"
DEDICATED_KEY = "sk-dedicated-brainclaw"
CUSTOM_URL = "http://127.0.0.1:8317"


def _settings(*, base_url: str, dedicated: str) -> dict[str, str]:
    return {
        "model_gateway_mode": "custom",
        "custom_llm_mode": gateway.CUSTOM_LLM_MODE_RELAYCLAW_BRAINCLAW,
        "brainclaw_newapi_base_url": base_url,
        "brainclaw_newapi_api_key": dedicated,
        "official_newapi_api_key": OFFICIAL_KEY,
    }


def _resolve(settings: dict[str, str]):
    with patch.object(gateway, "_uses_ce_gateway_settings", return_value=True), \
         patch.object(gateway, "get_model_gateway_settings", return_value=settings):
        return gateway.get_effective_llm_config()


def test_a_custom_endpoint_never_receives_the_official_key():
    """The disclosure this exists to prevent."""
    config = _resolve(_settings(base_url=CUSTOM_URL, dedicated=""))
    assert "8317" in config.base_url
    assert config.api_key != OFFICIAL_KEY, (
        "the official RelayClaw key was resolved for a custom endpoint; every "
        "request would have carried it to that host")
    assert not config.api_key


def test_the_official_endpoint_may_reuse_the_official_key():
    """The case the fallback existed for, which stays working."""
    config = _resolve(_settings(base_url=gateway.OFFICIAL_NEWAPI_BASE_URL, dedicated=""))
    assert config.api_key == OFFICIAL_KEY


def test_a_custom_endpoint_uses_its_own_key_when_one_is_saved():
    config = _resolve(_settings(base_url=CUSTOM_URL, dedicated=DEDICATED_KEY))
    assert config.api_key == DEDICATED_KEY


def test_a_dedicated_key_is_preferred_even_on_the_official_endpoint():
    config = _resolve(_settings(base_url=gateway.OFFICIAL_NEWAPI_BASE_URL,
                                dedicated=DEDICATED_KEY))
    assert config.api_key == DEDICATED_KEY


@pytest.mark.parametrize("variant", [
    "https://relayclaw.cdnfg.com/v1",
    "https://relayclaw.cdnfg.com/v1/",
    "https://relayclaw.cdnfg.com",
])
def test_the_official_endpoint_is_recognised_after_normalisation(variant):
    """A trailing slash must not decide whether a credential may travel."""
    assert gateway._is_official_relay_url(variant)


@pytest.mark.parametrize("url", [
    CUSTOM_URL,
    "https://relayclaw.cdnfg.com.evil.example/v1",
    "https://not-relayclaw.example/v1",
    "",
])
def test_anything_else_is_not_the_official_endpoint(url):
    """Including a hostname that merely starts with the official one."""
    assert not gateway._is_official_relay_url(url)


def test_the_status_reports_a_dedicated_key_apart_from_a_fallback_preview():
    """`apiKeyPreview` answers a different question than "is one configured?".

    It is non-empty when the official key is showing through, which is exactly
    what let the save path accept a custom endpoint with no dedicated key.
    """
    with patch.object(gateway, "_uses_ce_gateway_settings", return_value=True), \
         patch.object(gateway, "get_model_gateway_settings",
                      return_value=_settings(base_url=CUSTOM_URL, dedicated="")):
        status = gateway.build_model_gateway_status(
            official_base_url=gateway.OFFICIAL_NEWAPI_BASE_URL,
            official_api_key=OFFICIAL_KEY)

    assert status["brainclaw"]["dedicatedKeyConfigured"] is False
    assert OFFICIAL_KEY not in str(status["brainclaw"]["apiKeyPreview"])
