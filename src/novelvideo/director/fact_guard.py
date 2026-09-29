"""Check source excerpts for high-risk design fields, not all literary semantics.

A model's inferred facts never become confirmed evidence. Rejected raw outputs
remain inspectable; this gate does not silently rewrite or repurchase them.
"""
from __future__ import annotations

import json
import re

VERSION = "design-source-evidence/1.0.1"
AGE = re.compile(r"(?:\d{1,3}|[一二三四五六七八九十百零两]{1,5})(?:\s*[-—–至]\s*\d{1,3})?\s*(?:岁|years?[- ]old|year[- ]old|tuổi)", re.I)
UNKNOWN = {"未确认", "未知", "未设定", "原稿未呈现", "待确认", "not established", "unknown", "unconfirmed", "chưa xác nhận", "chưa xác định"}
FIELDS = {"characters": ["age", "addressRules", "memorableDetail", "pressureResponse", "voice"],
          "scenes": ["type", "spatialConstraints", "reusablePositions"]}


def unknown(value: object) -> bool:
    return value is None or str(value).strip().rstrip("。.!！").lower() in UNKNOWN


def exact_value(value: str) -> str:
    return value.strip().rstrip("。.!！；;")


def scene_name(value: str) -> str:
    # Only physical-type prefixes and explicit same-room suffixes are aliases.
    # Screen-in-screen qualifiers and A/B/numbered rooms stay distinct.
    value = re.sub(r"^(?:室内|室外)(?:露天)?", "", value)
    return re.sub(r"[（(]同一(?:间|处)?[）)]$", "", value).strip()


def constrain_schema(response_schema: dict, contract: dict, language: str) -> None:
    """Bound critical prose to supplied excerpts, not another generated summary."""
    unknown_value = {"en": "Not established", "vi": "Chưa xác nhận"}.get(language, "未确认")
    excerpts = list(dict.fromkeys(part.strip() for key, text in contract["inputs"].items() if key != "user-instruction"
                                 for part in re.split(r"[。；;\n]", text) if part.strip() and len(part) <= 400))
    definition = response_schema["$defs"]["Character" if contract["kind"] == "characters" else "Scene"]["properties"]
    for field in contract["fields"]:
        if field not in {"type", "age"}:
            definition[field] = {"enum": [*excerpts, unknown_value, *([None] if field == "addressRules" else [])],
                                 "description": "Select an exact source excerpt, or the unknown value. Include a matching sourceProofs entry for any excerpt. Do not paraphrase this field."}


def schema() -> dict:
    keys = ["entityId", "field", "value", "inputId", "quote"]
    return {"type": "array", "items": {"type": "object", "additionalProperties": False,
        "required": keys, "properties": {key: {"type": "string", "minLength": 1} for key in keys}}}


def boundary(kind: str, inputs: dict[str, str]) -> dict:
    return {"version": VERSION, "kind": kind, "inputs": {key: value for key, value in inputs.items() if value},
            "fields": FIELDS[kind], "unknownValues": sorted(UNKNOWN),
            "rules": "sourceProofs is mandatory. Quote an exact source passage containing the entity name and claimed value. "
            "A quotation must support that subject, not another person. Exact numeric ages need an age proof. "
            "addressRules, memorableDetail, pressureResponse, spatialConstraints and reusablePositions must be exact source excerpts when established; "
            "otherwise use null where allowed, or an output-language unknownValues entry. Other prose can interpret established facts but cannot invent actions. "
            "All non-unknown critical fields require one proof EACH, with value equal to the ENTIRE field, not a fragment or summary. "
            "Only use critical field names in sourceProofs. Scene type needs explicit interior/exterior evidence, not inference from a place name. Mixed needs both explicit. "
            "Do not treat a prohibition or hypothetical fact as an event. Source checking does not replace literary review."}


def inspect(raw: str, contract: dict) -> tuple[str, dict]:
    def no_duplicates(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("FACT_DUPLICATE_KEY")
            value[key] = item
        return value

    value = json.loads(raw, object_pairs_hook=no_duplicates)
    proofs = value.pop("sourceProofs", None)
    issues: list[dict] = []
    if not isinstance(proofs, list):
        return json.dumps(value, ensure_ascii=False), {"version": VERSION, "passed": False, "issues": [{"code": "FACT_PROOFS_MISSING"}]}
    inputs, kind = contract["inputs"], contract["kind"]
    entities = value.get("characters" if kind == "characters" else "locations", [])
    names = {item["id"]: item["names"][0] if kind == "characters" else item["name"] for item in entities}
    if kind == "scenes":
        canonical = [re.sub(r"[（(]同一(?:间|处)?[）)]$", "", name).strip() for name in names.values()]
        if len(canonical) != len(set(canonical)):
            issues.append({"code": "FACT_DUPLICATE_SPACE", "field": "name", "value": " / ".join(name for name in dict.fromkeys(canonical) if canonical.count(name) > 1)})

    def supported(entity: dict, field: str, claim: str) -> bool:
        for proof in proofs:
            if not isinstance(proof, dict) or not isinstance(proof.get("value"), str) or (proof.get("entityId"), proof.get("field"), exact_value(proof["value"])) != (entity["id"], field, exact_value(claim)):
                continue
            claim = exact_value(claim)
            quote = proof.get("quote")
            source = inputs.get(proof.get("inputId"), "")
            aliases = [names[entity["id"]]]
            if kind == "scenes":
                aliases.append(scene_name(names[entity["id"]]))
            if not isinstance(quote, str) or not quote or quote not in source or not any(name and name in quote for name in aliases):
                continue
            if field == "type":
                inside = bool(re.search(r"室内|内景|\bINT\b|\binterior\b|nội cảnh", quote, re.I))
                outside = bool(re.search(r"室外|外景|露天|\bEXT\b|\bexterior\b|ngoại cảnh", quote, re.I))
                if (claim == "interior" and inside and not outside) or (claim == "exterior" and outside and not inside) or (claim == "mixed" and inside and outside):
                    if not re.search(r"(?:并非|不是|非|不在|未进入)室(?:内|外)|not (?:an? )?(?:interior|exterior)", quote, re.I):
                        return True
            elif claim in quote:
                start = quote.index(claim)
                if re.search(r"不补|不得|禁止|不要|未确认|未设定|not established|do not", quote[max(0, start - 12):start], re.I):
                    continue
                if field == "age":
                    name = re.escape(names[entity["id"]])
                    before = re.search(name + r"[\s（(，,:：]*(?:今年|现年|年龄|年纪|is|aged|age)?[\s:：]*$", quote[:start], re.I)
                    after = re.match(r"^(?:的|[ \-()]){0,6}" + name, quote[start + len(claim):], re.I)
                    if not before and not after:
                        continue
                return True
        return False

    for entity in entities:
        checks: list[tuple[str, str]] = []
        if kind == "characters":
            for item in entity.values():
                if isinstance(item, str):
                    checks.extend(("age", match.group()) for match in AGE.finditer(item))
            checks.extend((field, entity[field]) for field in FIELDS[kind][1:] if field in entity and not unknown(entity[field]))
        else:
            checks.extend((field, entity[field]) for field in FIELDS[kind] if field in entity and not unknown(entity[field]))
        for field, claim in dict.fromkeys(checks):
            if not supported(entity, field, claim):
                issues.append({"code": "FACT_SOURCE_NOT_SUPPORTED", "entityId": entity["id"], "field": field, "value": claim})
    return json.dumps(value, ensure_ascii=False), {"version": VERSION, "passed": not issues, "issues": issues}
