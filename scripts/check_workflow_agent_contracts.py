#!/usr/bin/env python3
"""Read-only end-to-end diagnostics for Workflow MCP, Skills, and Recipes."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pydantic import AnyUrl

from novelvideo.freezone.agent_catalog_schema import validate_agent_config_item
from novelvideo.freezone.agent_config_store import (
    builtin_agent_catalog_dir,
    list_user_agent_config_items,
    project_agent_catalog_dir,
    user_agent_config_dir,
)
from novelvideo.freezone.workflow_schema import (
    workflow_intent_json_schema,
    workflow_plan_json_schema,
)

EXPECTED_TOOLS = {
    "workflow_catalog_search",
    "workflow_skill_get",
    "workflow_recipe_get",
    "workflow_skill_reference_get",
    "workflow_intent_compile",
    "workflow_graph_compile",
}
EXPECTED_RESOURCE_TEMPLATES = {
    "dramaclaw-workflow://skills/{skill_id}",
    "dramaclaw-workflow://recipes/{recipe_id}",
    "dramaclaw-workflow://skills/{skill_id}/references/{reference}",
}
MEDIA_OUTPUT_KINDS = {"image", "video", "audio"}


@dataclass
class DiagnosticReport:
    checks: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def check(self, condition: bool, message: str) -> None:
        self.checks += 1
        if not condition:
            self.errors.append(message)

    def warn(self, condition: bool, message: str) -> None:
        self.checks += 1
        if not condition:
            self.warnings.append(message)

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": not self.errors,
            "checks": self.checks,
            "error_count": len(self.errors),
            "warning_count": len(self.warnings),
            "errors": self.errors,
            "warnings": self.warnings,
            "details": self.details,
        }


def _json_payload_from_tool(result: Any) -> dict[str, Any]:
    structured = getattr(result, "structuredContent", None)
    for content in result.content:
        text = getattr(content, "text", None)
        if isinstance(text, str):
            payload = json.loads(text)
            if isinstance(payload, dict):
                if structured != payload:
                    raise ValueError(
                        "MCP tool structuredContent differs from its JSON text content"
                    )
                return payload
    raise ValueError("MCP tool result has no JSON object text content")


def _json_payload_from_resource(result: Any) -> dict[str, Any]:
    for content in result.contents:
        text = getattr(content, "text", None)
        if isinstance(text, str):
            payload = json.loads(text)
            if isinstance(payload, dict):
                return payload
    raise ValueError("MCP resource result has no JSON object text content")


def _catalog_items(username: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    skills = [
        item
        for item in list_user_agent_config_items(username, "skills")
        if item.get("enabled") is not False
    ]
    recipes = [
        item
        for item in list_user_agent_config_items(username, "recipes")
        if item.get("enabled") is not False
    ]
    return skills, recipes


def _validate_raw_catalog_files(username: str, report: DiagnosticReport) -> None:
    roots = {
        "skills": (
            builtin_agent_catalog_dir("skills"),
            project_agent_catalog_dir("skills"),
            user_agent_config_dir(username, "skills"),
        ),
        "recipes": (
            builtin_agent_catalog_dir("recipes"),
            project_agent_catalog_dir("recipes"),
            user_agent_config_dir(username, "recipes"),
        ),
    }
    checked_files = 0
    for kind, directories in roots.items():
        for directory in directories:
            if not directory.is_dir():
                continue
            seen_ids: set[str] = set()
            for path in sorted(directory.glob("*.json")):
                checked_files += 1
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    report.check(
                        isinstance(payload, dict),
                        f"{path}: catalog payload must be an object",
                    )
                    if not isinstance(payload, dict):
                        continue
                    validate_agent_config_item(kind, payload)
                    item_id = str(payload.get("id") or "")
                    report.check(bool(item_id), f"{path}: catalog id is empty")
                    report.check(
                        item_id not in seen_ids,
                        f"{directory}: duplicate {kind} id {item_id}",
                    )
                    seen_ids.add(item_id)
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    message = f"{path}: invalid {kind} catalog item: {exc}"
                    if directory == user_agent_config_dir(username, kind):
                        report.warn(False, message)
                    else:
                        report.check(False, message)
    report.details["raw_catalog_files"] = checked_files


def _validate_catalog_relationships(
    skills: list[dict[str, Any]],
    recipes: list[dict[str, Any]],
    report: DiagnosticReport,
) -> None:
    skill_ids = [str(item.get("id") or "") for item in skills]
    recipe_ids = [str(item.get("id") or "") for item in recipes]
    recipe_by_id = {str(item.get("id") or ""): item for item in recipes}
    report.check(len(skill_ids) == len(set(skill_ids)), "merged Skill catalog has duplicate ids")
    report.check(
        len(recipe_ids) == len(set(recipe_ids)),
        "merged Recipe catalog has duplicate ids",
    )

    referenced: set[str] = set()
    for skill in skills:
        skill_id = str(skill.get("id") or "")
        allowed = {
            str(item)
            for item in skill.get("allowed_recipe_ids") or []
            if str(item).strip()
        }
        referenced.update(allowed)
        missing = sorted(allowed - set(recipe_by_id))
        report.check(
            not missing,
            f"Skill {skill_id} references missing Recipes: {', '.join(missing)}",
        )
        report.check(bool(allowed), f"Skill {skill_id} has no allowed Recipes")

    for recipe in recipes:
        recipe_id = str(recipe.get("id") or "")
        for conflict_id in recipe.get("conflicts_with") or []:
            report.check(
                str(conflict_id) in recipe_by_id,
                f"Recipe {recipe_id} conflicts with missing Recipe {conflict_id}",
            )

    orphaned = sorted(set(recipe_by_id) - referenced)
    report.warn(
        not orphaned,
        "Recipes not reachable from any Skill: " + ", ".join(orphaned),
    )
    report.details.update(
        {
            "skill_count": len(skills),
            "recipe_count": len(recipes),
            "orphan_recipe_count": len(orphaned),
        }
    )


def _validate_published_skill(report: DiagnosticReport, root: Path) -> None:
    canonical = root / "src" / "novelvideo" / "agent_skills" / "dramaclaw-workflows"
    published = root / "agent-kit" / "skills" / "dramaclaw-workflows"
    canonical_files = {
        path.relative_to(canonical): path.read_bytes()
        for path in canonical.rglob("*")
        if path.is_file()
    }
    published_files = {
        path.relative_to(published): path.read_bytes()
        for path in published.rglob("*")
        if path.is_file()
    }
    report.check(bool(canonical_files), "canonical dramaclaw-workflows Skill is missing")
    report.check(
        canonical_files == published_files,
        "published dramaclaw-workflows Skill differs from its canonical source",
    )
    skill_text = "\n".join(
        content.decode("utf-8", errors="replace")
        for path, content in canonical_files.items()
        if path.suffix == ".md"
    )
    report.check(
        "workflow_graph_compile" in skill_text,
        "published Skill does not describe workflow_graph_compile",
    )
    report.check(
        "run_after_create" in skill_text,
        "published Skill does not describe run_after_create behavior",
    )
    report.check(
        "expected_node_count" in skill_text,
        "published Skill does not preserve explicit workflow node totals",
    )
    report.check(
        "Never write placeholder or diagnostic nodes" in skill_text,
        "published Skill does not forbid diagnostic canvas writes",
    )


def _anchor_for_recipe(
    target: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    target_id = str(target.get("id") or "")
    target_conflicts = {str(item) for item in target.get("conflicts_with") or []}
    compatible = []
    for candidate in candidates:
        candidate_id = str(candidate.get("id") or "")
        candidate_conflicts = {
            str(item) for item in candidate.get("conflicts_with") or []
        }
        if (
            candidate_id != target_id
            and not candidate.get("requires_source_media")
            and str(candidate.get("output_kind") or "") in MEDIA_OUTPUT_KINDS
            and candidate_id not in target_conflicts
            and target_id not in candidate_conflicts
        ):
            compatible.append(candidate)
    compatible.sort(
        key=lambda item: (
            str(item.get("output_kind") or "") != "image",
            str(item.get("id") or ""),
        )
    )
    return compatible[0] if compatible else None


def _required_diagnostic_inputs(skill: dict[str, Any]) -> dict[str, str]:
    """Fill required Skill inputs so Recipe compile checks reach the planner."""
    inputs: dict[str, str] = {}
    for param in skill.get("input_parameters") or []:
        if not isinstance(param, dict) or not param.get("required"):
            continue
        options = param.get("options") or []
        inputs[str(param.get("id") or "")] = str(options[0]) if options else "未指定"
    return inputs


def _intent_for_recipe(
    skill_id: str,
    target: dict[str, Any],
    available_recipes: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, str | None]:
    target_id = str(target.get("id") or "")
    target_kind = str(target.get("output_kind") or "")
    items: list[dict[str, Any]] = []
    if target.get("requires_source_media"):
        anchor = _anchor_for_recipe(target, available_recipes)
        if anchor is None:
            return None, f"Recipe {target_id} requires media but Skill {skill_id} has no anchor"
        items.append(
            {
                "id": "source_anchor",
                "title": "诊断源素材",
                "prompt": "用于验证工作流连接的稳定源素材",
                "recipe_id": str(anchor.get("id") or ""),
            }
        )
    target_item: dict[str, Any] = {
        "id": "target",
        "title": f"诊断 {target_id}",
        "prompt": "用于验证 Skill、Recipe、Plan 和 MCP 编译链路",
        "recipe_id": target_id,
    }
    if items:
        target_item["reference_inputs"] = ["source_anchor"]
    includes_speech = False
    if target_kind == "audio":
        searchable = " ".join(
            [
                target_id,
                str(target.get("name") or ""),
                *[str(item) for item in target.get("action_keys") or []],
            ]
        ).lower()
        if any(token in searchable for token in ("music", "bgm", "音乐", "配乐")):
            target_item["audio_kind"] = "music"
            target_item["music_length_ms"] = 3000
        else:
            target_item["audio_kind"] = "speech"
            target_item["narration"] = "这是用于验证配音工作流的朗读正文。"
            includes_speech = True
    items.append(target_item)
    if skill_id == "short-drama-quick" and target_kind == "audio" and not includes_speech:
        speech_recipe = next(
            (
                recipe
                for recipe in available_recipes
                if str(recipe.get("output_kind") or "") == "audio"
                and not any(
                    token
                    in " ".join(
                        [
                            str(recipe.get("id") or ""),
                            str(recipe.get("name") or ""),
                            *[str(item) for item in recipe.get("action_keys") or []],
                        ]
                    ).lower()
                    for token in ("music", "bgm", "音乐", "配乐")
                )
            ),
            None,
        )
        if speech_recipe is not None:
            items.append(
                {
                    "id": "speech_companion",
                    "title": "诊断短剧配音",
                    "prompt": "用于验证短剧配音节点",
                    "recipe_id": str(speech_recipe.get("id") or ""),
                    "audio_kind": "speech",
                    "narration": "这是用于验证配音工作流的朗读正文。",
                }
            )
    return (
        {
            "schema_version": "freezone_workflow_intent.v1",
            "skill_id": skill_id,
            "user_goal": f"诊断 Recipe {target_id}",
            "items": items,
            "include_audio": target_kind == "audio",
            "include_compose": False,
        },
        None,
    )


async def _exercise_mcp(
    root: Path,
    username: str,
    skills: list[dict[str, Any]],
    recipes: list[dict[str, Any]],
    report: DiagnosticReport,
) -> None:
    env = {
        **os.environ,
        "DRAMACLAW_USERNAME": username,
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "novelvideo.chat.workflow_mcp"],
        env=env,
        cwd=str(root),
    )
    recipe_by_id = {str(item.get("id") or ""): item for item in recipes}
    compiled_pairs = 0
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            initialized = await session.initialize()
            report.check(
                initialized.serverInfo.name == "dramaclaw-workflows",
                f"unexpected MCP server name: {initialized.serverInfo.name}",
            )
            tools = await session.list_tools()
            tool_by_name = {tool.name: tool for tool in tools.tools}
            report.check(
                set(tool_by_name) == EXPECTED_TOOLS,
                "MCP tool set differs from the public workflow contract",
            )
            templates = await session.list_resource_templates()
            template_uris = {item.uriTemplate for item in templates.resourceTemplates}
            report.check(
                template_uris == EXPECTED_RESOURCE_TEMPLATES,
                "MCP resource templates differ from the public workflow contract",
            )

            for tool in tools.tools:
                try:
                    Draft202012Validator.check_schema(tool.inputSchema)
                except Exception as exc:
                    report.check(False, f"MCP tool {tool.name} has invalid JSON Schema: {exc}")
                try:
                    Draft202012Validator.check_schema(tool.outputSchema)
                except Exception as exc:
                    report.check(
                        False,
                        f"MCP tool {tool.name} has invalid output JSON Schema: {exc}",
                    )
            report.check(
                tool_by_name["workflow_graph_compile"].inputSchema["properties"]["plan"]
                == workflow_plan_json_schema(),
                "workflow_graph_compile does not advertise the shared WorkflowPlan Schema",
            )
            report.check(
                tool_by_name["workflow_intent_compile"].inputSchema["properties"]["intent"]
                == workflow_intent_json_schema(),
                "workflow_intent_compile does not advertise the shared WorkflowIntent Schema",
            )

            search = _json_payload_from_tool(
                await session.call_tool(
                    "workflow_catalog_search",
                    {"kind": "skills", "limit": 50},
                )
            )
            report.check(search.get("ok") is True, "MCP Skill catalog search failed")
            discovered_skill_ids = {
                str(item.get("id") or "") for item in search.get("items") or []
            }
            expected_skill_ids = {str(item.get("id") or "") for item in skills}
            report.check(
                discovered_skill_ids == expected_skill_ids,
                "MCP Skill search does not expose every enabled Skill",
            )

            for skill in skills:
                skill_id = str(skill.get("id") or "")
                resource = _json_payload_from_resource(
                    await session.read_resource(
                        AnyUrl(f"dramaclaw-workflow://skills/{skill_id}")
                    )
                )
                report.check(
                    resource.get("ok") is True and resource.get("skill_id") == skill_id,
                    f"Skill resource failed for {skill_id}",
                )
                package = _json_payload_from_tool(
                    await session.call_tool(
                        "workflow_skill_get",
                        {"skill_id": skill_id, "user_goal": "诊断工作流"},
                    )
                )
                report.check(package.get("ok") is True, f"Skill tool failed for {skill_id}")
                available = package.get("available_recipes") or []
                available_by_id = {
                    str(item.get("id") or ""): item
                    for item in available
                    if isinstance(item, dict)
                }
                expected_allowed = {
                    str(item) for item in skill.get("allowed_recipe_ids") or []
                }
                report.check(
                    set(available_by_id) == expected_allowed,
                    f"Skill {skill_id} package Recipe set differs from allowed_recipe_ids",
                )

                full_available = [recipe_by_id[item_id] for item_id in available_by_id]
                for recipe_id in sorted(expected_allowed):
                    target = recipe_by_id.get(recipe_id)
                    if target is None:
                        continue
                    intent, error = _intent_for_recipe(skill_id, target, full_available)
                    report.check(error is None, error or "")
                    if intent is None:
                        continue
                    intent["inputs"] = _required_diagnostic_inputs(skill)
                    compiled = _json_payload_from_tool(
                        await session.call_tool("workflow_intent_compile", {"intent": intent})
                    )
                    report.check(
                        compiled.get("ok") is True,
                        f"Intent compile failed for {skill_id}/{recipe_id}: "
                        f"{compiled.get('error')}",
                    )
                    plan = compiled.get("plan")
                    if not compiled.get("ok") or not isinstance(plan, dict):
                        continue
                    graph = _json_payload_from_tool(
                        await session.call_tool(
                            "workflow_graph_compile",
                            {"plan": plan, "run_after_create": False},
                        )
                    )
                    report.check(
                        graph.get("ok") is True,
                        f"Graph compile failed for {skill_id}/{recipe_id}: {graph.get('error')}",
                    )
                    command_types = [
                        command.get("type")
                        for command in graph.get("commands") or []
                        if isinstance(command, dict)
                    ]
                    report.check(
                        "create_node" in command_types,
                        f"Graph for {skill_id}/{recipe_id} creates no nodes",
                    )
                    report.check(
                        "run_workflow" not in command_types,
                        f"Graph for {skill_id}/{recipe_id} runs despite run_after_create=false",
                    )
                    compiled_pairs += 1

            for recipe in recipes:
                recipe_id = str(recipe.get("id") or "")
                resource = _json_payload_from_resource(
                    await session.read_resource(
                        AnyUrl(f"dramaclaw-workflow://recipes/{recipe_id}")
                    )
                )
                returned = resource.get("recipe")
                report.check(
                    resource.get("ok") is True
                    and isinstance(returned, dict)
                    and returned.get("id") == recipe_id,
                    f"Recipe resource failed for {recipe_id}",
                )

    report.details["compiled_skill_recipe_pairs"] = compiled_pairs


async def _run(args: argparse.Namespace) -> DiagnosticReport:
    root = Path(__file__).resolve().parents[1]
    report = DiagnosticReport()
    generated_contract = subprocess.run(
        [
            sys.executable,
            str(root / "scripts/generate_workflow_contract.py"),
            "--check",
        ],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    report.check(
        generated_contract.returncode == 0,
        "Generated Workflow stable contract is stale: "
        + (generated_contract.stdout or generated_contract.stderr).strip(),
    )
    Draft202012Validator.check_schema(workflow_plan_json_schema())
    Draft202012Validator.check_schema(workflow_intent_json_schema())
    report.check(True, "shared workflow JSON Schemas are invalid")
    _validate_raw_catalog_files(args.username, report)
    skills, recipes = _catalog_items(args.username)
    _validate_catalog_relationships(skills, recipes, report)
    _validate_published_skill(report, root)
    await _exercise_mcp(root, args.username, skills, recipes, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check Workflow MCP, Skill, Recipe, Plan, and graph contracts end to end."
    )
    parser.add_argument("--username", default="local")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = parser.parse_args()
    report = asyncio.run(_run(args))
    payload = report.as_dict()
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        status = "PASS" if payload["ok"] else "FAIL"
        print(
            f"[{status}] {payload['checks']} checks, {payload['error_count']} errors, "
            f"{payload['warning_count']} warnings"
        )
        for warning in report.warnings:
            print(f"WARN: {warning}")
        for error in report.errors:
            print(f"ERROR: {error}")
        print(json.dumps(report.details, ensure_ascii=False, indent=2))
    raise SystemExit(0 if payload["ok"] else 1)


if __name__ == "__main__":
    main()
