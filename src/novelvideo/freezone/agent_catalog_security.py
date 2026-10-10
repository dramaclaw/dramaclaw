"""Safety checks shared by Freezone agent catalog import paths."""

from __future__ import annotations

from typing import Any

DANGEROUS_FIELD_NAMES = {
    "script",
    "scripts",
    "command",
    "commands",
    "code",
    "executable",
    "entrypoint",
    "env",
    "secrets",
    "secret",
    "api_key",
    "token",
    "password",
    "private_key",
}
SECRET_MARKERS = (
    "sk-",
    "ghp_",
    "github_pat_",
    "AKIA",
    "BEGIN PRIVATE KEY",
    "OPENAI_API_KEY",
    "NEWAPI_API_KEY",
)
SUPPLIER_MODEL_MARKERS = (
    "gpt-image-",
    "seedance-",
)


def scan_agent_catalog_payload_for_unsafe_content(
    value: Any,
    *,
    label: str = "agent catalog",
    path: str = "$",
) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            if key_text.lower() in DANGEROUS_FIELD_NAMES:
                raise ValueError(f"dangerous {label} field at {path}.{key_text}")
            scan_agent_catalog_payload_for_unsafe_content(
                child,
                label=label,
                path=f"{path}.{key_text}",
            )
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            scan_agent_catalog_payload_for_unsafe_content(
                child,
                label=label,
                path=f"{path}[{index}]",
            )
        return
    if isinstance(value, str):
        for marker in SECRET_MARKERS:
            if marker in value:
                raise ValueError(f"possible secret in {label} at {path}")
        lowered = value.lower()
        for marker in SUPPLIER_MODEL_MARKERS:
            if marker in lowered:
                raise ValueError(f"supplier model name is not allowed in {label} at {path}")
