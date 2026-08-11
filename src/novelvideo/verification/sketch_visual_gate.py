"""VLM-driven visual gate for sketch edit candidate cells.

After `sketch_edit_execute` finishes, the summary JSON lists candidate
cell paths keyed by beat number. This module asks a lightweight Gemini
model whether each cell exhibits any of the registry's high-confidence
(`gate_enabled=1`) failure modes, then returns pass/fail per beat.

`unsure` is treated as pass: the gate is intentionally conservative while
its real-world error rate is still unknown — better to let a suspect
cell through than to drop a good one onto the floor.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import aiosqlite

from novelvideo.verification import failure_registry
from novelvideo.egress_context import TrustedEgressContext, ambient_egress_context

DEFAULT_GATE_MODEL_GOOGLE = "gemini-3.5-flash"
DEFAULT_GATE_MODEL_OPENROUTER = "gemini-3.5-flash"
DEFAULT_GATE_MODEL = DEFAULT_GATE_MODEL_GOOGLE  # legacy alias (google-direct)


@dataclass
class CellVerdict:
    beat_number: int
    cell_path: str
    review_image_path: str = ""
    reference_paths: list[str] = field(default_factory=list)
    hits: list[str] = field(default_factory=list)  # codes voted "yes"
    unsure: list[str] = field(default_factory=list)  # codes voted "unsure"
    raw_response: str = ""
    error: str = ""

    @property
    def passed(self) -> bool:
        return not self.hits and not self.error


@dataclass
class GateResult:
    summary_path: Path
    audit_path: Path
    cells: list[CellVerdict] = field(default_factory=list)

    @property
    def passed_beats(self) -> list[int]:
        return [c.beat_number for c in self.cells if c.passed]

    @property
    def failed_beats(self) -> list[int]:
        return [c.beat_number for c in self.cells if not c.passed]

    def cell_hits_map(self) -> dict[int, list[str]]:
        return {c.beat_number: c.hits for c in self.cells if c.hits}


def _read_cell_bytes(cell_path: Path) -> bytes:
    return cell_path.read_bytes()


def _build_reference_sheet(
    *,
    cell_path: Path,
    reference_paths: list[Path],
    output_path: Path,
) -> Path:
    """Build a single image for VLM review: candidate first, references after."""
    if not reference_paths:
        return cell_path
    from PIL import Image, ImageDraw

    panel_paths = [cell_path, *reference_paths]
    labels = [
        "CANDIDATE",
        *[f"REFERENCE {idx}" for idx in range(1, len(reference_paths) + 1)],
    ]
    cell_w, cell_h, label_h = 420, 260, 28
    sheet_w = cell_w * len(panel_paths)
    sheet_h = cell_h + label_h
    sheet = Image.new("RGB", (sheet_w, sheet_h), "white")
    draw = ImageDraw.Draw(sheet)
    for index, (path, label) in enumerate(zip(panel_paths, labels)):
        x = index * cell_w
        draw.rectangle([x, 0, x + cell_w - 1, label_h], fill=(245, 245, 245))
        draw.text((x + 8, 7), label, fill=(0, 0, 0))
        with Image.open(path) as image:
            panel = image.convert("RGB")
            panel.thumbnail((cell_w, cell_h), Image.Resampling.LANCZOS)
            px = x + (cell_w - panel.width) // 2
            py = label_h + (cell_h - panel.height) // 2
            sheet.paste(panel, (px, py))
        draw.rectangle(
            [x, label_h, x + cell_w - 1, sheet_h - 1], outline=(0, 0, 0), width=2
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, quality=92)
    return output_path


def _build_gate_prompt(
    active_modes: list[dict[str, Any]],
    spatial_contract: dict[str, Any] | None = None,
) -> str:
    lines = [
        "You are a strict quality-control reviewer for minimal stick-figure storyboard sketches.",
        "For each failure mode below, answer 'yes', 'no', or 'unsure' for whether the image exhibits it.",
        "Be conservative: only answer 'yes' when the failure is clearly visible. Use 'unsure' when ambiguous.",
        "If the image is a comparison sheet, evaluate only the CANDIDATE panel. Use REFERENCE panels only as advisory continuity context.",
        "Do not fail the candidate merely because reference panels are diagrams or contain labels.",
        "",
        "Failure modes to evaluate:",
    ]
    for mode in active_modes:
        lines.append(f"- {mode['code']}: {mode['detection']}")
    if spatial_contract:
        lines.extend(
            [
                "",
                "Director spatial contract for this beat:",
                json.dumps(spatial_contract, ensure_ascii=False, indent=2),
                "When evaluating director failure modes, compare the visible sketch against this contract.",
                "A legal character movement is allowed only when the contract says the movement path/source is preserved.",
            ]
        )
    lines.extend(
        [
            "",
            "Respond with a single JSON object mapping each failure code to 'yes', 'no', or 'unsure'.",
            "Do not include any other text, explanation, or code fences. Just the JSON object.",
            'Example: {"code_a": "no", "code_b": "yes"}',
        ]
    )
    return "\n".join(lines)


def _filter_contract_dependent_modes(
    active_modes: list[dict[str, Any]],
    spatial_contract: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Avoid evaluating anchor-contract gates when no contract exists."""
    if spatial_contract:
        return active_modes
    contract_codes = {"cross_beat_blocking_drift", "scene_anchor_drift"}
    return [mode for mode in active_modes if mode.get("code") not in contract_codes]


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort parse of a JSON object out of a possibly noisy VLM reply."""
    if not text:
        return None
    text = text.strip()
    # Strip common code-fence decorations.
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```\s*$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fallback: find first { ... } block.
    match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def _resolve_gate_backend() -> tuple[str, str, str]:
    """Pick the gate backend (provider, api_key, model) from env.

    Priority mirrors what nanobanana uses so gating works wherever
    generation already works:
    1. `SKETCH_GATE_PROVIDER` / `SKETCH_GATE_API_KEY` / `SKETCH_GATE_MODEL`
       explicit overrides
    2. If `NANOBANANA_PROVIDER=openrouter` and `OPENROUTER_API_KEY` set,
       route the gate through OpenRouter (gemini via OpenAI-compatible API)
    3. Otherwise use Google direct with `GOOGLE_AI_API_KEY`/`GOOGLE_API_KEY`
    """
    explicit_provider = (os.environ.get("SKETCH_GATE_PROVIDER") or "").strip().lower()
    explicit_key = (os.environ.get("SKETCH_GATE_API_KEY") or "").strip()
    explicit_model = (os.environ.get("SKETCH_GATE_MODEL") or "").strip()
    if explicit_provider and explicit_key:
        model = explicit_model or (
            DEFAULT_GATE_MODEL_OPENROUTER
            if explicit_provider == "openrouter"
            else DEFAULT_GATE_MODEL_GOOGLE
        )
        return explicit_provider, explicit_key, model

    nb_provider = (os.environ.get("NANOBANANA_PROVIDER") or "").strip().lower()
    openrouter_key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
    if nb_provider == "openrouter" and openrouter_key:
        return (
            "openrouter",
            openrouter_key,
            explicit_model or DEFAULT_GATE_MODEL_OPENROUTER,
        )

    for var in ("GOOGLE_AI_API_KEY", "GOOGLE_API_KEY"):
        value = (os.environ.get(var) or "").strip()
        if value:
            return "google", value, explicit_model or DEFAULT_GATE_MODEL_GOOGLE

    if openrouter_key:
        return (
            "openrouter",
            openrouter_key,
            explicit_model or DEFAULT_GATE_MODEL_OPENROUTER,
        )
    return "", "", ""


def resolve_gate_backend_for_context(
    egress_context: TrustedEgressContext | None,
) -> tuple[str, str, str]:
    """Keep platform behavior while denying organization direct vision."""

    if egress_context is not None and type(egress_context) is not TrustedEgressContext:
        raise TypeError("egress_context must be a TrustedEgressContext or None")
    if egress_context is None:
        egress_context = ambient_egress_context()
    if egress_context is not None and egress_context.is_organization:
        from novelvideo.model_gateway_runtime import ModelGatewayEgressError

        raise ModelGatewayEgressError("ORG_EGRESS_DENIED")
    return _resolve_gate_backend()


async def _ask_vlm_google(
    *,
    image_bytes: bytes,
    prompt: str,
    api_key: str,
    model: str,
) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    parts = [
        prompt,
        types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
    ]
    response = await asyncio.to_thread(
        client.models.generate_content,
        model=model,
        contents=parts,
        config=types.GenerateContentConfig(
            response_modalities=["TEXT"],
            temperature=0.0,
        ),
    )
    if not response.candidates:
        return ""
    candidate = response.candidates[0]
    text_parts: list[str] = []
    if candidate.content and candidate.content.parts:
        for part in candidate.content.parts:
            value = getattr(part, "text", None)
            if value:
                text_parts.append(value)
    return "".join(text_parts).strip()


async def _ask_vlm_openrouter(
    *,
    image_bytes: bytes,
    prompt: str,
    api_key: str,
    model: str,
    max_tokens: int = 512,
) -> str:
    import httpx

    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:image/png;base64,{b64}"
    payload = {
        "model": model,
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://novelvideo.ai",
        "X-Title": "NovelVideo Studio",
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for entry in content:
            text = entry.get("text") if isinstance(entry, dict) else None
            if text:
                parts.append(text)
        return "".join(parts).strip()
    return ""


async def _ask_vlm_once(
    *,
    image_bytes: bytes,
    prompt: str,
    provider: str,
    api_key: str,
    model: str,
    max_tokens: int = 512,
) -> str:
    if provider == "openrouter":
        return await _ask_vlm_openrouter(
            image_bytes=image_bytes,
            prompt=prompt,
            api_key=api_key,
            model=model,
            max_tokens=max_tokens,
        )
    return await _ask_vlm_google(
        image_bytes=image_bytes, prompt=prompt, api_key=api_key, model=model
    )


async def gate_single_cell(
    *,
    cell_path: Path,
    beat_number: int,
    active_modes: list[dict[str, Any]],
    provider: str,
    api_key: str,
    model: str,
    spatial_contract: dict[str, Any] | None = None,
    reference_paths: list[Path] | None = None,
    review_image_path: Path | None = None,
) -> CellVerdict:
    verdict = CellVerdict(beat_number=beat_number, cell_path=str(cell_path))
    if not cell_path.exists():
        verdict.error = f"cell missing: {cell_path}"
        return verdict
    active_modes = _filter_contract_dependent_modes(active_modes, spatial_contract)
    if not active_modes:
        return verdict
    refs = [path for path in (reference_paths or []) if path.exists()]
    verdict.reference_paths = [str(path) for path in refs]
    image_path = cell_path
    if refs and review_image_path is not None:
        image_path = _build_reference_sheet(
            cell_path=cell_path,
            reference_paths=refs,
            output_path=review_image_path,
        )
        verdict.review_image_path = str(image_path)
    prompt = _build_gate_prompt(active_modes, spatial_contract=spatial_contract)
    try:
        raw = await _ask_vlm_once(
            image_bytes=_read_cell_bytes(image_path),
            prompt=prompt,
            provider=provider,
            api_key=api_key,
            model=model,
        )
    except Exception as exc:  # noqa: BLE001
        verdict.error = f"vlm call failed: {exc}"
        return verdict
    verdict.raw_response = raw
    parsed = _extract_json_object(raw)
    if parsed is None:
        verdict.error = "vlm response not JSON"
        return verdict
    for code in [m["code"] for m in active_modes]:
        answer = str(parsed.get(code, "")).strip().lower()
        if answer == "yes":
            verdict.hits.append(code)
        elif answer == "unsure":
            verdict.unsure.append(code)
    return verdict


async def gate_candidate_cells(
    *,
    project_dir: Path,
    summary_path: Path,
    defs_db: aiosqlite.Connection,
    project_hits_db: aiosqlite.Connection | None = None,
    model: str | None = None,
    egress_context: TrustedEgressContext | None = None,
) -> GateResult:
    """Run the visual gate against every candidate cell in `summary_path`.

    `defs_db` is the user-shared verification.db (the only source of
    truth for gate-enabled modes). `project_hits_db` is the optional
    project-local data.db — when provided, hit counts are bumped into
    `sketch_failure_mode_hits` so repeat offenders surface per project.
    """
    provider, api_key, default_model = resolve_gate_backend_for_context(egress_context)
    if not summary_path.exists():
        raise FileNotFoundError(f"execute summary missing: {summary_path}")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    grid_results = summary.get("grid_results") or []
    spatial_contracts: dict[int, dict[str, Any]] = {}

    active_modes = await failure_registry.list_active(defs_db, gate_only=True)
    if not active_modes:
        raise RuntimeError(
            "No gate_enabled failure modes registered; seed the registry first"
        )

    if not provider or not api_key:
        raise RuntimeError(
            "Gate requires a VLM key. Set SKETCH_GATE_API_KEY, or "
            "OPENROUTER_API_KEY, or GOOGLE_AI_API_KEY in the environment."
        )
    resolved_model = model or default_model

    from novelvideo.verification.sketch_edit_execute import derive_audit_dir_name

    audit_dir = summary_path.parent / derive_audit_dir_name(summary_path.name)
    audit_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    audit_path = audit_dir / f"gate_{ts}.json"

    result = GateResult(summary_path=summary_path, audit_path=audit_path)

    tasks: list[tuple[int, Path, list[Path]]] = []
    for grid in grid_results:
        beat_nums = grid.get("beat_nums") or []
        cell_paths = grid.get("candidate_cell_paths") or []
        reference_paths = [
            (project_dir / rel).resolve()
            for rel in (grid.get("submitted_reference_images") or [])[1:]
            if rel
        ]
        for bn, rel in zip(beat_nums, cell_paths):
            cell_path = (project_dir / rel).resolve()
            tasks.append((int(bn), cell_path, reference_paths))

    # Run cell gating concurrently but bound parallelism for quota safety.
    semaphore = asyncio.Semaphore(4)

    async def _one(
        beat_number: int, cell_path: Path, reference_paths: list[Path]
    ) -> CellVerdict:
        async with semaphore:
            return await gate_single_cell(
                cell_path=cell_path,
                beat_number=beat_number,
                active_modes=active_modes,
                provider=provider,
                api_key=api_key,
                model=resolved_model,
                spatial_contract=spatial_contracts.get(beat_number),
                reference_paths=reference_paths,
                review_image_path=audit_dir / f"gate_sheet_beat_{beat_number}_{ts}.jpg",
            )

    verdicts = await asyncio.gather(*(_one(bn, cp, refs) for bn, cp, refs in tasks))
    result.cells = list(verdicts)

    # Bump hit_count so repeated offenders surface per-project.
    if project_hits_db is not None:
        for verdict in verdicts:
            for code in verdict.hits:
                try:
                    await failure_registry.bump_hit(
                        project_hits_db,
                        code=code,
                        episode=int(summary.get("episode_num") or 0),
                    )
                except Exception:
                    pass

    audit_payload: dict[str, Any] = {
        "summary_path": str(summary_path),
        "provider": provider,
        "model": resolved_model,
        "started_at": ts,
        "active_modes": [mode["code"] for mode in active_modes],
        "cells": [
            {
                "beat_number": v.beat_number,
                "cell_path": v.cell_path,
                "review_image_path": v.review_image_path,
                "reference_paths": v.reference_paths,
                "passed": v.passed,
                "hits": v.hits,
                "unsure": v.unsure,
                "error": v.error,
                "raw_response": v.raw_response,
                "spatial_contract": spatial_contracts.get(v.beat_number),
            }
            for v in verdicts
        ],
        "passed_beats": result.passed_beats,
        "failed_beats": result.failed_beats,
    }
    audit_path.write_text(
        json.dumps(audit_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return result
