"""Every DC-*-LLM alias the backend calls must be mappable in Custom mode.

Custom mode writes NewAPI channel model mappings only for the rows listed in
``frontend/src/lib/feature-models.ts``. An alias the backend uses but the
frontend never lists can never be mapped, so NewAPI answers
``No available channel for model DC-...`` (issue #490, DC-character-builder-LLM).
"""

from __future__ import annotations

import re
from pathlib import Path

from novelvideo import official_defaults

REPOSITORY_ROOT = Path(__file__).parents[1]
FEATURE_MODELS_TS = REPOSITORY_ROOT / "frontend" / "src" / "lib" / "feature-models.ts"


def _frontend_default_models() -> set[str]:
    text = FEATURE_MODELS_TS.read_text(encoding="utf-8")
    return set(re.findall(r'defaultModel:\s*"([^"]+)"', text))


def _backend_llm_aliases() -> set[str]:
    aliases: set[str] = set()
    for name in dir(official_defaults):
        value = getattr(official_defaults, name)
        if isinstance(value, dict):
            for key, model in value.items():
                if str(key).endswith("_MODEL") and str(model).startswith("DC-") and str(model).endswith("-LLM"):
                    aliases.add(str(model))
    return aliases


def test_every_backend_llm_alias_has_a_custom_mode_feature_row() -> None:
    missing = sorted(_backend_llm_aliases() - _frontend_default_models())
    assert not missing, (
        "backend calls these DC aliases but Custom mode cannot map them "
        f"(add rows to frontend/src/lib/feature-models.ts): {missing}"
    )
