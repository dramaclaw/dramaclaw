"""Audit the displayed candidate, not only claims volunteered by its author."""

from .documents import object_hash
from .outline_source import locate_quotes
from .schemas.outline_source import CandidateAudit

AUDIT_VALIDATOR_VERSION = "candidate-audit/1.2.0"


def audit_aliases(source: dict, candidate: dict) -> dict[str, str]:
    return {**{u["path"]: f"u{i}" for i, u in enumerate(candidate_units(candidate), 1)},
            **{u["id"]: f"s{i}" for i, u in enumerate(source["units"], 1)}}


def map_audit_ids(value, mapping: dict[str, str], field: str | None = None):
    if isinstance(value, str):
        return mapping.get(value, value) if field in {"id", "path", "unitId", "const", "enum"} else value
    if isinstance(value, list):
        return [map_audit_ids(item, mapping, field) for item in value]
    if isinstance(value, dict):
        return {key: map_audit_ids(item, mapping, key) for key, item in value.items()}
    return value


def evidence_role(path: str) -> str:
    # The host knows which fields tell events. A writer's nature=interpretation
    # cannot turn an unsupported sensory action into harmless craft commentary.
    narrative = (path.startswith(("overview.logline", "overview.synopsis", "hooks.highlights"))
                 or path.startswith("chapters.") and ".story." in path
                 or path.startswith("hooks.openings.") and path.endswith(".image")
                 or path.startswith("hooks.setups.") and path.endswith((".plant", ".payoff")))
    return "narrative" if narrative else "commentary"


def audit_wire_schema(source: dict, candidate: dict | None = None, *, compact: bool = False) -> dict:
    """The model selects immutable evidence, rather than retyping quotations."""
    schema = CandidateAudit.model_json_schema(by_alias=True)
    schema["properties"]["contract"]["const"] = "outline-candidate-audit/1.1.0"
    quote = schema["$defs"]["SourceQuote"]
    quote["properties"].pop("quote")
    quote["required"] = ["unitId"]
    quote["properties"]["unitId"]["enum"] = [u["id"] for u in source["units"]]
    if candidate is not None:
        units = candidate_units(candidate)
        schema["properties"]["units"].update(minItems=len(units), maxItems=len(units))
        schema["$defs"]["CandidateUnitReview"]["properties"]["path"]["enum"] = [u["path"] for u in units]
        narrative = [u["path"] for u in units if u["evidenceRole"] == "narrative"]
        if narrative:
            schema["$defs"]["CandidateUnitReview"]["allOf"] = [{
                "if": {"properties": {"path": {"enum": narrative}}, "required": ["path"]},
                "then": {"properties": {"findings": {"items": {"properties": {
                    "verdict": {"enum": ["supported", "violated", "uncertain"]}}}}}},
            }]
    if compact:
        if candidate is None:
            raise ValueError("OUTLINE_AUDIT_CANDIDATE_REQUIRED")
        schema = map_audit_ids(schema, audit_aliases(source, candidate))
        schema["properties"]["contract"]["const"] = "outline-candidate-audit/1.2.0"
    return schema


def candidate_units(candidate: dict) -> list[dict]:
    blocks = candidate["ast"]["blocks"]
    slots = {block["id"]: i for i, block in enumerate(blocks)}
    units = []
    indexed = {key for section in candidate["bindings"]["sections"] for key in section["blockIds"]}
    for block in blocks:
        if block["id"] not in indexed and block["text"].strip():
            units.append({"path": "preamble." + block["id"], "text": block["text"],
                          "evidenceRole": "commentary",
                          "blockIds": [block["id"]]})
    for section in candidate["bindings"]["sections"]:
        for paragraph in section["paragraphs"]:
            if paragraph["protected"]:
                continue
            start, end = (slots[paragraph[key]] for key in ("startBlockId", "endBlockId"))
            text = "\n".join(b["text"] for b in blocks[start:end + 1])
            if not text.strip():
                continue
            units.append({"path": paragraph["path"],
                          "evidenceRole": paragraph.get("evidenceRole") or evidence_role(paragraph["path"]),
                          "text": text,
                          "blockIds": [b["id"] for b in blocks[start:end + 1]]})
    return units


def validate_candidate_audit(value: dict, candidate: dict, source: dict) -> dict:
    if value.get("contract") == "outline-candidate-audit/1.2.0":
        from jsonschema import Draft202012Validator, ValidationError
        from .output_validation import OutputContractError

        try:
            Draft202012Validator(audit_wire_schema(source, candidate, compact=True)).validate(value)
        except ValidationError as exc:
            raise OutputContractError("OUTLINE_AUDIT_WIRE_INVALID", ".".join(map(str, exc.path))) from exc
        value = map_audit_ids(value, {short: full for full, short in audit_aliases(source, candidate).items()})
        value["contract"] = "outline-candidate-audit/1.1.0"
    if value.get("contract") == "outline-candidate-audit/1.1.0":
        import json
        from jsonschema import Draft202012Validator, ValidationError

        try:
            Draft202012Validator(audit_wire_schema(source)).validate(value)
        except ValidationError as exc:
            from .output_validation import OutputContractError

            raise OutputContractError("OUTLINE_AUDIT_WIRE_INVALID", ".".join(map(str, exc.path))) from exc
        value = json.loads(json.dumps(value))
        value["contract"] = "outline-candidate-audit/1.0.0"
        texts = {u["id"]: u["text"] for u in source["units"]}
        for unit in value["units"]:
            for finding in unit["findings"]:
                for ref in finding["sourceEvidence"]:
                    ref["quote"] = texts[ref["unitId"]]
    data = CandidateAudit.from_wire(value).model_dump(by_alias=True)
    expected = {unit["path"]: unit for unit in candidate_units(candidate)}
    actual = [unit["path"] for unit in data["units"]]
    if len(actual) != len(set(actual)) or set(actual) != set(expected):
        raise ValueError("OUTLINE_AUDIT_COVERAGE_INCOMPLETE")
    violations, uncertain = [], []
    for unit in data["units"]:
        text = expected[unit["path"]]["text"]
        for finding in unit["findings"]:
            if finding["candidateQuote"] not in text:
                raise ValueError("OUTLINE_AUDIT_QUOTE_MISSING")
            finding["sourceEvidence"] = locate_quotes(finding["sourceEvidence"], source)
            if finding["verdict"] == "supported" and not finding["sourceEvidence"]:
                raise ValueError("OUTLINE_AUDIT_SOURCE_REQUIRED")
            if finding["verdict"] == "violated":
                violations.append(unit["path"])
            elif (finding["verdict"] == "uncertain" or finding["verdict"] == "interpretation"
                  and expected[unit["path"]]["evidenceRole"] == "narrative"):
                uncertain.append(unit["path"])
    return {**data, "validatorVersion": AUDIT_VALIDATOR_VERSION, "candidateHash": object_hash(candidate),
            "sourceHash": source["hash"], "violatedPaths": sorted(set(violations)),
            "uncertainPaths": sorted(set(uncertain)),
            "status": "blocked" if violations or uncertain else "reviewed"}
