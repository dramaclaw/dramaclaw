// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneAgentConfigKind, FreezoneAgentConfigPayload } from "@/lib/queries/freezone-agent-config";

type ValidationResult = { ok: true } | { ok: false; message: string };

const SAFE_AGENT_CONFIG_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const NODE_SCOPES = new Set(["textGeneration", "imageGeneration", "videoGeneration", "audioGeneration"]);
const INPUT_PARAMETER_TYPES = new Set(["single_select", "multi_select", "text", "number", "boolean"]);
const RECIPE_OUTPUT_KINDS = new Set(["text", "image", "video", "audio"]);

export function validateFreezoneAgentConfigPayload(
  kind: FreezoneAgentConfigKind,
  payload: FreezoneAgentConfigPayload,
): ValidationResult {
  return kind === "skills"
    ? validateFreezoneSkillPayload(payload)
    : validateFreezoneRecipePayload(payload);
}

export function isValidFreezoneSkillPayload(payload: FreezoneAgentConfigPayload): boolean {
  return validateFreezoneSkillPayload(payload).ok;
}

function validateFreezoneSkillPayload(payload: FreezoneAgentConfigPayload): ValidationResult {
  const idResult = validateId(payload.id, "id");
  if (!idResult.ok) return idResult;
  for (const field of ["name", "description", "category"] as const) {
    const result = requireNonEmptyString(payload[field], field);
    if (!result.ok) return result;
  }

  const triggers = getRecord(payload.triggers);
  const keywords = readKeywordList(triggers.keywords);
  if (keywords.length === 0) {
    return invalid("triggers.keywords 至少需要 1 项");
  }
  const nodeScopes = readStringArray(triggers.node_scopes);
  if (nodeScopes.some((scope) => !NODE_SCOPES.has(scope))) {
    return invalid("triggers.node_scopes 包含不支持的节点类型");
  }

  const allowedRecipeIds = readStringArray(payload.allowed_recipe_ids);
  for (const recipeId of allowedRecipeIds) {
    const result = validateId(recipeId, "allowed_recipe_ids");
    if (!result.ok) return result;
  }
  if (allowedRecipeIds.length === 0) {
    return invalid("动态 Skill 的 allowed_recipe_ids 至少需要一个");
  }
  if (Array.isArray(payload.workflow_templates) && payload.workflow_templates.length > 0) {
    return invalid("不支持固定 workflow_templates");
  }

  const inputParameters = Array.isArray(payload.input_parameters)
    ? payload.input_parameters
    : [];
  for (const item of inputParameters) {
    const result = validateInputParameter(item);
    if (!result.ok) return result;
  }

  const planning = getRecord(payload.planning);
  const planningNotes = requireNonEmptyString(planning.planning_notes, "planning.planning_notes");
  if (!planningNotes.ok) return planningNotes;
  const conductRules = readStringArray(planning.conduct_rules);
  if (conductRules.length === 0) {
    return invalid("planning.conduct_rules 至少需要 1 项");
  }

  const evaluation = getRecord(payload.evaluation);
  const ratingBands = Array.isArray(evaluation.rating_bands) ? evaluation.rating_bands : [];
  if (ratingBands.length === 0) {
    return invalid("evaluation.rating_bands 至少需要 1 项");
  }
  for (const item of ratingBands) {
    const record = getRecord(item);
    const result = requireNonEmptyString(record.description, "evaluation.rating_bands.description");
    if (!result.ok) return result;
    if (!isFiniteNumber(record.score)) {
      return invalid("evaluation.rating_bands.score 必须是数字");
    }
  }
  if (!isFiniteNumber(evaluation.quality_threshold)) {
    return invalid("evaluation.quality_threshold 必须是数字");
  }
  if (readStringArray(evaluation.domain_constraints).length === 0) {
    return invalid("evaluation.domain_constraints 至少需要 1 项");
  }
  return { ok: true };
}

function validateFreezoneRecipePayload(payload: FreezoneAgentConfigPayload): ValidationResult {
  const idResult = validateId(payload.id, "id");
  if (!idResult.ok) return idResult;
  const nameResult = requireNonEmptyString(payload.name, "name");
  if (!nameResult.ok) return nameResult;
  if (!RECIPE_OUTPUT_KINDS.has(readString(payload.output_kind))) {
    return invalid("output_kind 必须是 text / image / video / audio");
  }
  const actionKeys = readStringArray(payload.action_keys);
  if (actionKeys.length === 0) {
    return invalid("action_keys 至少需要 1 项");
  }
  for (const actionKey of actionKeys) {
    const result = validateId(actionKey, "action_keys");
    if (!result.ok) return result;
  }
  for (const field of ["system_prompt", "planning_prompt", "result_summary"] as const) {
    const result = requireNonEmptyString(payload[field], field);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function validateInputParameter(value: unknown): ValidationResult {
  const item = getRecord(value);
  const idResult = validateId(item.id, "input_parameters.id");
  if (!idResult.ok) return idResult;
  const labelResult = requireNonEmptyString(item.label, "input_parameters.label");
  if (!labelResult.ok) return labelResult;
  const type = readString(item.type);
  if (!INPUT_PARAMETER_TYPES.has(type)) {
    return invalid("input_parameters.type 不支持");
  }
  if (typeof item.required !== "boolean") {
    return invalid("input_parameters.required 必须是布尔值");
  }
  const options = readStringArray(item.options);
  if ((type === "single_select" || type === "multi_select") && options.length === 0) {
    return invalid("input_parameters.options 至少需要 1 项");
  }
  if (type === "single_select" && item.default !== undefined) {
    const defaultValue = readString(item.default);
    if (!options.includes(defaultValue)) {
      return invalid("input_parameters.default 必须在 options 中");
    }
  }
  return { ok: true };
}

function validateId(value: unknown, field: string): ValidationResult {
  const id = readString(value);
  if (!SAFE_AGENT_CONFIG_ID.test(id)) {
    return invalid(`${field} 只能包含小写字母、数字、-、_，并且必须以字母或数字开头`);
  }
  return { ok: true };
}

function requireNonEmptyString(value: unknown, field: string): ValidationResult {
  if (!readString(value)) {
    return invalid(`${field} 不能为空`);
  }
  return { ok: true };
}

function invalid(message: string): ValidationResult {
  return { ok: false, message };
}

function getRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter(Boolean)
    : [];
}

function readKeywordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      const keyword = item.trim();
      return keyword ? [keyword] : [];
    }
    const record = getRecord(item);
    const keyword = readString(record.keyword) || readString(record.text) || readString(record.value);
    return keyword ? [keyword] : [];
  });
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
