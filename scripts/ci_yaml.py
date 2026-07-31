"""Strict YAML loading helpers for security-sensitive CI policy files."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from yaml.nodes import MappingNode


class CIYamlError(ValueError):
    """Raised when a CI YAML file cannot be interpreted safely."""


class StrictSafeLoader(yaml.SafeLoader):
    """SafeLoader with YAML 1.2 booleans and duplicate-key rejection."""


# PyYAML defaults to YAML 1.1 and therefore parses keys such as ``on`` as
# booleans. Copy the resolver table before narrowing booleans to true/false.
StrictSafeLoader.yaml_implicit_resolvers = {
    first: list(resolvers)
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
for first, resolvers in StrictSafeLoader.yaml_implicit_resolvers.items():
    StrictSafeLoader.yaml_implicit_resolvers[first] = [
        resolver
        for resolver in resolvers
        if resolver[0] != "tag:yaml.org,2002:bool"
    ]
StrictSafeLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|false)$", re.IGNORECASE),
    list("tTfF"),
)


def _construct_unique_mapping(
    loader: StrictSafeLoader,
    node: MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    if not isinstance(node, MappingNode):
        raise CIYamlError(f"expected a mapping at line {node.start_mark.line + 1}")

    loader.flatten_mapping(node)
    mapping: dict[Any, Any] = {}
    key_lines: dict[Any, int] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise CIYamlError(
                f"unhashable mapping key at line {key_node.start_mark.line + 1}"
            ) from exc
        if duplicate:
            first_line = key_lines[key]
            raise CIYamlError(
                f"duplicate key {key!r} at line {key_node.start_mark.line + 1} "
                f"(first declared at line {first_line})"
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
        key_lines[key] = key_node.start_mark.line + 1
    return mapping


StrictSafeLoader.add_constructor(
    "tag:yaml.org,2002:map",
    _construct_unique_mapping,
)


def load_yaml(path: Path) -> Any:
    """Load a YAML file without YAML 1.1 booleans or duplicate keys."""

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CIYamlError(f"{path}: cannot read file: {exc}") from exc

    try:
        return yaml.load(text, Loader=StrictSafeLoader)
    except (yaml.YAMLError, CIYamlError) as exc:
        raise CIYamlError(f"{path}: {exc}") from exc


def require_mapping(value: Any, label: str) -> dict[Any, Any]:
    """Return *value* as a mapping or raise a policy-friendly error."""

    if not isinstance(value, dict):
        raise CIYamlError(f"{label} must be a mapping")
    return value
